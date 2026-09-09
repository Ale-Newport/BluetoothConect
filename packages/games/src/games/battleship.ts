/**
 * Battleship: hidden information on a link with no referee.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * Both devices run the same reducer over the same state, so anything the state
 * holds, BOTH players hold. Putting the fleets in the state would hand each
 * player their opponent's board. There is no server to keep the secret for us,
 * and a peer we cannot see is free to lie about anything it is asked.
 *
 * ---------------------------------------------------------------------------
 * THE SOLUTION: COMMIT - PLAY - REVEAL
 * ---------------------------------------------------------------------------
 * The shared state never contains a live fleet. It contains a COMMITMENT to one
 * and a transcript of what its owner CLAIMED about every shot. The claims are
 * audited at the end, when lying is no longer useful.
 *
 *   Phase 1 - placement.
 *     Each player picks a layout, picks a secret 8-byte salt, and publishes
 *     `commitment = H(layout || salt)`. The layout never leaves the device.
 *     A commitment binds the player to one fleet: they cannot move a ship later
 *     without changing the hash, and they cannot work out the opponent's fleet
 *     from the hash without the opponent's salt.
 *
 *   Phase 2 - firing.
 *     Players alternate one shot per turn. The reducer cannot resolve a shot -
 *     it does not know where the ships are - so the OWNER of the targeted grid
 *     answers with a `report` (hit / miss / which ship sank). The reducer just
 *     records the claim. Structural lies are refused immediately (answering a
 *     shot that was not fired, sinking the same ship twice, sinking on a miss);
 *     lies about the sea itself are left for phase 3.
 *
 *   Phase 3 - reveal.
 *     When a fleet is reported sunk, both players publish layout + salt. Now the
 *     reducer can finally audit, and it checks three things per player:
 *       a. `H(layout || salt)` equals the commitment from phase 1 - so this is
 *          the fleet they started with;
 *       b. the layout is legal - five ships of length 5/4/3/3/2, on the board,
 *          axis aligned, no overlaps;
 *       c. REPLAYING every shot fired at that layout reproduces, exactly, the
 *          hit/miss/sunk sequence they reported - including WHICH ship sank and
 *          on WHICH shot.
 *     Any mismatch is a cheat, and the honest player wins with reason
 *     "opponent cheated". If both cheated, nobody wins: it is a draw.
 *
 * Two consequences worth stating plainly:
 *   - Refusing to reveal is not a way out. A stonewalling defender who answers
 *     "miss" forever runs their own grid out of squares: after all 100 cells of
 *     a grid have been fired at, the firing phase ends regardless, and the audit
 *     catches them, because 17 of those 100 cells provably held a ship. A peer
 *     that simply stops sending is a disconnect, handled above this layer.
 *   - The hash here is FNV-1a, hand-rolled below, chosen because it needs no
 *     dependency and is bit-identical on every JS engine (Math.imul is exact
 *     32-bit multiplication). It is NOT cryptographic: the commitment stops a
 *     casual cheat and a post-hoc rewrite of history, but a determined attacker
 *     could forge a preimage. Shipping this for real means swapping
 *     `fleetCommitment` for a keyed BLAKE2s/SHA-256 from @airlink/core's crypto
 *     primitives - the protocol around it does not change.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Every quantity here is a small integer: cells 0-99, ship indices 0-4, byte
 * values 0-255. The reducer performs no floating-point arithmetic at all, so
 * the per-tick rounding discipline realtime games need does not apply. The hash
 * uses Math.imul, which is exact 32-bit integer multiplication everywhere.
 *
 * ---------------------------------------------------------------------------
 * WIRE SIZE (~180 usable bytes per Bluetooth packet)
 * ---------------------------------------------------------------------------
 *   fire   ~18 bytes   report ~26 bytes   place ~28 bytes   reveal ~60 bytes
 * Every action fits in a single packet. A shot in the state transcript is
 * packed into ONE integer (cell * 8 + outcome), so a whole finished game
 * encodes in roughly 600 bytes - only ever needed for persistence or for
 * catching up a peer that rejoined, never per move.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  VALID,
  asArray,
  asBool,
  asInt,
  asMap,
  asString,
  decodeActionEnvelope,
  encodeActionEnvelope,
  invalid,
  type GameAction,
  type GameDefinition,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';

// ---------------------------------------------------------------------------
// Board and fleet
// ---------------------------------------------------------------------------

export const BOARD_SIZE = 10;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE; // 100
export const SALT_BYTES = 8;
export const COMMITMENT_BYTES = 8;

export type FleetEntry = { readonly name: string; readonly length: number };

/** Ship order is fixed and shared; the wire format identifies a ship by index. */
export const FLEET: readonly FleetEntry[] = [
  { name: 'carrier', length: 5 },
  { name: 'battleship', length: 4 },
  { name: 'cruiser', length: 3 },
  { name: 'submarine', length: 3 },
  { name: 'destroyer', length: 2 },
];

/** 5 + 4 + 3 + 3 + 2. */
export const FLEET_CELLS = 17;

/**
 * A ship is an anchor plus an axis. Diagonals are not expressible, which is how
 * "axis aligned" is enforced: the wire format cannot describe an illegal one.
 * `length` travels explicitly so a cheat that shrinks the carrier is something
 * the audit can catch rather than something the encoding quietly normalises.
 */
export type Ship = {
  readonly row: number;
  readonly col: number;
  readonly vertical: boolean;
  readonly length: number;
};

/** One answered shot, from the point of view of the grid that took it. */
export type Shot = {
  readonly cell: number;
  readonly hit: boolean;
  /** Index into FLEET of the ship this shot sank, or null. */
  readonly sunk: number | null;
};

export type PendingShot = { readonly shooter: number; readonly cell: number };

export type FleetReveal = { readonly ships: readonly Ship[]; readonly salt: readonly number[] };

export const BattleshipPhase = {
  /** Both players are committing to a fleet. */
  PLACEMENT: 'placement',
  /** Alternating shots, each answered by the grid's owner. */
  FIRING: 'firing',
  /** A fleet is down; both players must reveal so the transcript can be audited. */
  REVEAL: 'reveal',
  FINISHED: 'finished',
} as const;
export type BattleshipPhase = (typeof BattleshipPhase)[keyof typeof BattleshipPhase];

/** Phase <-> integer, for the compact state encoding. */
const PHASE_ORDER: readonly BattleshipPhase[] = [
  BattleshipPhase.PLACEMENT,
  BattleshipPhase.FIRING,
  BattleshipPhase.REVEAL,
  BattleshipPhase.FINISHED,
];

export const BattleshipEnding = {
  /** Still playing. */
  NONE: 0,
  /** Won honestly: the loser's five ships were sunk and the audit passed. */
  FLEET_SUNK: 1,
  /** Won because the opponent's reveal contradicted their own transcript. */
  CHEAT: 2,
  /** Nobody wins: both transcripts were fiction. */
  BOTH_CHEATED: 3,
  /** Defensive: both audits passed yet no fleet went down. Not reachable. */
  STALEMATE: 4,
} as const;
export type BattleshipEnding = (typeof BattleshipEnding)[keyof typeof BattleshipEnding];

export interface BattleshipState {
  readonly players: readonly PlayerId[];
  readonly phase: BattleshipPhase;
  /** commitments[i] is player i's H(layout || salt), or null before they commit. */
  readonly commitments: readonly (readonly number[] | null)[];
  /** shots[i] is every answered shot fired AT player i's grid, in order. */
  readonly shots: readonly (readonly Shot[])[];
  /** A shot awaiting its owner's report. */
  readonly pending: PendingShot | null;
  /** Whose turn it is to fire. */
  readonly turnIndex: number;
  readonly reveals: readonly (FleetReveal | null)[];
  /** Set when player i's reveal contradicts their commitment or their reports. */
  readonly cheated: readonly boolean[];
  readonly ending: BattleshipEnding;
  /** Winning player index, or -1 for "nobody". */
  readonly winner: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface BattleshipPlaceAction extends GameAction {
  readonly type: 'place';
  readonly payload: { readonly commitment: number[] };
}

export interface BattleshipFireAction extends GameAction {
  readonly type: 'fire';
  readonly payload: { readonly cell: number };
}

export interface BattleshipReportAction extends GameAction {
  readonly type: 'report';
  readonly payload: { readonly cell: number; readonly hit: boolean; readonly sunk: number | null };
}

export interface BattleshipRevealAction extends GameAction {
  readonly type: 'reveal';
  readonly payload: { readonly ships: Ship[]; readonly salt: number[] };
}

export type BattleshipAction =
  | BattleshipPlaceAction
  | BattleshipFireAction
  | BattleshipReportAction
  | BattleshipRevealAction;

// ---------------------------------------------------------------------------
// Layout geometry
// ---------------------------------------------------------------------------

/** The cells a ship covers, or null if it does not fit on the board. */
export function shipCells(ship: Ship): number[] | null {
  const { row, col, vertical, length } = ship;
  if (!Number.isInteger(row) || !Number.isInteger(col) || !Number.isInteger(length)) return null;
  if (length < 1 || length > BOARD_SIZE) return null;
  if (row < 0 || col < 0 || row >= BOARD_SIZE || col >= BOARD_SIZE) return null;
  const endRow = vertical ? row + length - 1 : row;
  const endCol = vertical ? col : col + length - 1;
  if (endRow >= BOARD_SIZE || endCol >= BOARD_SIZE) return null;
  const cells: number[] = [];
  for (let i = 0; i < length; i++) {
    const r = row + (vertical ? i : 0);
    const c = col + (vertical ? 0 : i);
    cells.push(r * BOARD_SIZE + c);
  }
  return cells;
}

/**
 * Cell -> ship index (or -1 for open water), or null when the layout breaks a
 * placement rule: wrong ship count, wrong length for its class, off the board,
 * or two ships sharing a square.
 */
export function fleetLayout(ships: readonly Ship[]): number[] | null {
  if (ships.length !== FLEET.length) return null;
  const grid = new Array<number>(CELL_COUNT).fill(-1);
  for (let i = 0; i < FLEET.length; i++) {
    const ship = ships[i] as Ship;
    if (ship.length !== (FLEET[i] as FleetEntry).length) return null;
    const cells = shipCells(ship);
    if (cells === null) return null;
    for (const cell of cells) {
      if (grid[cell] !== -1) return null;
      grid[cell] = i;
    }
  }
  return grid;
}

/** True when `ships` is a legal fleet. */
export function isLegalLayout(ships: readonly Ship[]): boolean {
  return fleetLayout(ships) !== null;
}

// ---------------------------------------------------------------------------
// Commitment hash
// ---------------------------------------------------------------------------

const FNV_PRIME = 0x01000193;
const FNV_BASIS_A = 0x811c9dc5;
const FNV_BASIS_B = 0x9e3779b9;

/** FNV-1a over bytes. Math.imul keeps this exact 32-bit integer work. */
function fnv1a(bytes: readonly number[], basis: number): number {
  let h = basis >>> 0;
  for (const byte of bytes) {
    h = (h ^ (byte & 0xff)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

function digestBytes(h: number): number[] {
  return [(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff];
}

/** The exact byte sequence a commitment is taken over. */
export function commitmentPreimage(ships: readonly Ship[], salt: readonly number[]): number[] {
  const bytes: number[] = [];
  for (const ship of ships) {
    bytes.push(ship.row & 0xff, ship.col & 0xff, ship.vertical ? 1 : 0, ship.length & 0xff);
  }
  bytes.push(0xff); // separator: the layout/salt boundary cannot be slid around
  for (const byte of salt) bytes.push(byte & 0xff);
  return bytes;
}

/**
 * Eight commitment bytes: two FNV-1a passes with different bases and different
 * domain-separation prefixes, the second also mixing in the preimage length.
 * See the header - this is deliberately simple, not cryptographic.
 */
export function fleetCommitment(ships: readonly Ship[], salt: readonly number[]): number[] {
  const pre = commitmentPreimage(ships, salt);
  const first = fnv1a([0x01, ...pre], FNV_BASIS_A);
  const second = fnv1a([0x02, ...pre, pre.length & 0xff], FNV_BASIS_B);
  return [...digestBytes(first), ...digestBytes(second)];
}

// ---------------------------------------------------------------------------
// Reports and the audit
// ---------------------------------------------------------------------------

/**
 * The honest answer to a shot, for the device that owns `ships`. The UI calls
 * this to build its `report` action; the audit below re-derives the same thing
 * from the revealed layout and compares.
 */
export function resolveReport(
  ships: readonly Ship[],
  priorShots: readonly Shot[],
  cell: number,
): { cell: number; hit: boolean; sunk: number | null } {
  const grid = fleetLayout(ships);
  if (grid === null) throw new Error('resolveReport: the layout is not legal');
  const shipIndex = grid[cell] ?? -1;
  if (shipIndex < 0) return { cell, hit: false, sunk: null };
  let hits = 1; // this shot
  for (const shot of priorShots) {
    if ((grid[shot.cell] ?? -1) === shipIndex) hits += 1;
  }
  const spec = FLEET[shipIndex] as FleetEntry;
  return { cell, hit: true, sunk: hits >= spec.length ? shipIndex : null };
}

/** Replay every shot against the revealed layout; any disagreement is a lie. */
function reportsMatchLayout(grid: readonly number[], shots: readonly Shot[]): boolean {
  const hits = new Array<number>(FLEET.length).fill(0);
  const seen = new Set<number>();
  for (const shot of shots) {
    if (seen.has(shot.cell)) return false; // the same square answered twice
    seen.add(shot.cell);
    const shipIndex = grid[shot.cell] ?? -1;
    if (shipIndex < 0) {
      if (shot.hit || shot.sunk !== null) return false; // claimed a hit on open water
      continue;
    }
    if (!shot.hit) return false; // hid a hit
    hits[shipIndex] = (hits[shipIndex] as number) + 1;
    const sank = (hits[shipIndex] as number) === (FLEET[shipIndex] as FleetEntry).length;
    if (shot.sunk !== (sank ? shipIndex : null)) return false; // wrong ship, or wrong moment
  }
  return true;
}

/** The three-part audit from the header: commitment, layout legality, transcript. */
export function revealIsHonest(
  commitment: readonly number[] | null,
  reveal: FleetReveal,
  shots: readonly Shot[],
): boolean {
  if (commitment === null || commitment.length !== COMMITMENT_BYTES) return false;
  if (reveal.salt.length !== SALT_BYTES) return false;
  const expected = fleetCommitment(reveal.ships, reveal.salt);
  for (let i = 0; i < COMMITMENT_BYTES; i++) {
    if (expected[i] !== commitment[i]) return false;
  }
  const grid = fleetLayout(reveal.ships);
  if (grid === null) return false;
  return reportsMatchLayout(grid, shots);
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function playerIndex(state: BattleshipState, player: PlayerId): number {
  return state.players.indexOf(player);
}

function shotsAt(state: BattleshipState, index: number): readonly Shot[] {
  return state.shots[index] ?? [];
}

export function sunkCount(shots: readonly Shot[]): number {
  let n = 0;
  for (const shot of shots) if (shot.sunk !== null) n += 1;
  return n;
}

export function fleetIsSunk(shots: readonly Shot[]): boolean {
  return sunkCount(shots) >= FLEET.length;
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

/** A shot packs into one integer: cell * 8 + outcome (0 miss, 1 hit, 2+k sank ship k). */
function encodeShot(shot: Shot): number {
  const outcome = shot.hit ? (shot.sunk === null ? 1 : shot.sunk + 2) : 0;
  return shot.cell * 8 + outcome;
}

function decodeShot(value: CborValue | undefined, what: string): Shot {
  const code = asInt(value, what, 0, CELL_COUNT * 8 - 1);
  const outcome = code % 8;
  if (outcome > FLEET.length + 1) throw new GameDecodeError(`${what}: unknown outcome`);
  return {
    cell: (code - outcome) / 8,
    hit: outcome !== 0,
    sunk: outcome >= 2 ? outcome - 2 : null,
  };
}

function decodeByteArray(value: CborValue | undefined, what: string, length: number): number[] {
  const raw = asArray(value, what, length);
  if (raw.length !== length) throw new GameDecodeError(`${what}: expected ${length} bytes`);
  return raw.map((b, i) => asInt(b, `${what}[${i}]`, 0, 255));
}

function encodeShips(ships: readonly Ship[]): number[] {
  const out: number[] = [];
  for (const ship of ships) out.push(ship.row, ship.col, ship.vertical ? 1 : 0, ship.length);
  return out;
}

function decodeShips(value: CborValue | undefined, what: string): Ship[] {
  const flat = asArray(value, what, FLEET.length * 4);
  if (flat.length !== FLEET.length * 4) {
    throw new GameDecodeError(`${what}: expected ${FLEET.length * 4} numbers`);
  }
  const ships: Ship[] = [];
  for (let i = 0; i < FLEET.length; i++) {
    const base = i * 4;
    ships.push({
      row: asInt(flat[base], `${what}[${i}].row`, 0, BOARD_SIZE - 1),
      col: asInt(flat[base + 1], `${what}[${i}].col`, 0, BOARD_SIZE - 1),
      vertical: asInt(flat[base + 2], `${what}[${i}].axis`, 0, 1) === 1,
      // Deliberately permissive: a wrong length must be auditable, not undecodable.
      length: asInt(flat[base + 3], `${what}[${i}].length`, 1, BOARD_SIZE),
    });
  }
  return ships;
}

function encodeReveal(reveal: FleetReveal): number[] {
  return [...encodeShips(reveal.ships), ...reveal.salt];
}

function decodeReveal(value: CborValue | undefined, what: string): FleetReveal {
  const flat = asArray(value, what, FLEET.length * 4 + SALT_BYTES);
  if (flat.length !== FLEET.length * 4 + SALT_BYTES) {
    throw new GameDecodeError(`${what}: expected ${FLEET.length * 4 + SALT_BYTES} numbers`);
  }
  return {
    ships: decodeShips(flat.slice(0, FLEET.length * 4), `${what}.ships`),
    salt: decodeByteArray(flat.slice(FLEET.length * 4), `${what}.salt`, SALT_BYTES),
  };
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export const battleship: GameDefinition<BattleshipState, BattleshipAction> = {
  id: 'battleship',
  name: 'Battleship',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): BattleshipState {
    return {
      players: [...setup.players],
      phase: BattleshipPhase.PLACEMENT,
      commitments: [null, null],
      shots: [[], []],
      pending: null,
      turnIndex: 0,
      reveals: [null, null],
      cheated: [false, false],
      ending: BattleshipEnding.NONE,
      winner: -1,
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.phase === BattleshipPhase.FINISHED) return invalid('the game has already finished');
    const index = playerIndex(state, action.player);
    if (index < 0) return invalid(`${action.player} is not in this game`);

    switch (action.type) {
      case 'place': {
        if (state.phase !== BattleshipPhase.PLACEMENT) return invalid('both fleets are already committed');
        if (state.commitments[index]) return invalid('you have already committed your fleet');
        if (action.payload.commitment.length !== COMMITMENT_BYTES) {
          return invalid(`commitment must be ${COMMITMENT_BYTES} bytes`);
        }
        return VALID;
      }

      case 'fire': {
        if (state.phase === BattleshipPhase.PLACEMENT) return invalid('both fleets must be committed first');
        if (state.phase !== BattleshipPhase.FIRING) return invalid('the firing phase is over');
        if (state.pending) return invalid('the previous shot has not been answered');
        if (state.turnIndex !== index) {
          return invalid(`it is ${String(state.players[state.turnIndex])}'s turn to fire`);
        }
        const cell = action.payload.cell;
        if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) return invalid('cell must be 0-99');
        const target = 1 - index;
        if (shotsAt(state, target).some((shot) => shot.cell === cell)) {
          return invalid('that square has already been fired at');
        }
        return VALID;
      }

      case 'report': {
        const pending = state.pending;
        if (state.phase !== BattleshipPhase.FIRING || pending === null) return invalid('there is no shot to answer');
        // The grid's owner answers - never the shooter, who must not get to
        // decide whether their own shot landed.
        if (pending.shooter === index) return invalid('only the owner of the targeted grid may report');
        if (action.payload.cell !== pending.cell) return invalid('the report must answer the pending shot');
        const sunk = action.payload.sunk;
        if (sunk !== null) {
          if (!action.payload.hit) return invalid('a miss cannot sink a ship');
          if (!Number.isInteger(sunk) || sunk < 0 || sunk >= FLEET.length) return invalid('sunk must name a ship');
          if (shotsAt(state, index).some((shot) => shot.sunk === sunk)) {
            return invalid('that ship was already reported sunk');
          }
        }
        return VALID;
      }

      case 'reveal': {
        if (state.phase !== BattleshipPhase.REVEAL) return invalid('there is nothing to reveal yet');
        if (state.reveals[index]) return invalid('you have already revealed your fleet');
        // A DISHONEST reveal is accepted on purpose. Rejecting it would only let
        // a cheat stall forever; applyAction records the lie and hands the win
        // to the other player.
        return VALID;
      }

      default:
        return invalid(`unknown action "${String((action as GameAction).type)}"`);
    }
  },

  applyAction(state, action): BattleshipState {
    const index = playerIndex(state, action.player);

    switch (action.type) {
      case 'place': {
        const commitments = [...state.commitments];
        commitments[index] = [...action.payload.commitment];
        const ready = commitments.every((c) => c !== null);
        return {
          ...state,
          commitments,
          // Placement is genuinely simultaneous: each commitment lands in its
          // own slot, so the two devices agree whichever order they arrive in.
          phase: ready ? BattleshipPhase.FIRING : BattleshipPhase.PLACEMENT,
        };
      }

      case 'fire':
        return { ...state, pending: { shooter: index, cell: action.payload.cell } };

      case 'report': {
        const pending = state.pending;
        if (pending === null) return state; // unreachable: validateAction guarantees one
        const shots = state.shots.map((list) => [...list]);
        const mine = shots[index] as Shot[];
        mine.push({ cell: action.payload.cell, hit: action.payload.hit, sunk: action.payload.sunk });
        // Either the fleet is down, or the grid has run out of squares - the
        // stonewalling defender's dead end. Both send us to the audit.
        const done = fleetIsSunk(mine) || mine.length >= CELL_COUNT;
        return {
          ...state,
          shots,
          pending: null,
          turnIndex: 1 - pending.shooter,
          phase: done ? BattleshipPhase.REVEAL : BattleshipPhase.FIRING,
        };
      }

      case 'reveal': {
        const reveals = [...state.reveals];
        const reveal: FleetReveal = {
          ships: action.payload.ships.map((ship) => ({ ...ship })),
          salt: [...action.payload.salt],
        };
        reveals[index] = reveal;
        const cheated = [...state.cheated];
        cheated[index] = !revealIsHonest(state.commitments[index] ?? null, reveal, shotsAt(state, index));
        if (reveals.some((r) => r === null)) return { ...state, reveals, cheated };

        const cheatedFirst = cheated[0] === true;
        const cheatedSecond = cheated[1] === true;
        let ending: BattleshipEnding = BattleshipEnding.STALEMATE;
        let winner = -1;
        if (cheatedFirst && cheatedSecond) {
          ending = BattleshipEnding.BOTH_CHEATED;
        } else if (cheatedFirst || cheatedSecond) {
          ending = BattleshipEnding.CHEAT;
          winner = cheatedFirst ? 1 : 0;
        } else {
          const firstDown = fleetIsSunk(shotsAt(state, 0));
          const secondDown = fleetIsSunk(shotsAt(state, 1));
          if (firstDown !== secondDown) {
            ending = BattleshipEnding.FLEET_SUNK;
            winner = firstDown ? 1 : 0;
          }
        }
        return { ...state, reveals, cheated, phase: BattleshipPhase.FINISHED, ending, winner };
      }

      default:
        return state;
    }
  },

  status(state): GameStatus {
    const champion = state.winner >= 0 ? state.players[state.winner] : undefined;
    switch (state.ending) {
      // `champion` is always present for these two endings; the fallback only
      // exists so a corrupted snapshot cannot produce a winner-less "won".
      case BattleshipEnding.FLEET_SUNK:
        if (champion) return { kind: GameStatusKind.WON, winners: [champion], reason: 'fleet sunk' };
        return { kind: GameStatusKind.DRAW, reason: 'the result could not be attributed' };
      case BattleshipEnding.CHEAT:
        if (champion) return { kind: GameStatusKind.WON, winners: [champion], reason: 'opponent cheated' };
        return { kind: GameStatusKind.DRAW, reason: 'the result could not be attributed' };
      case BattleshipEnding.BOTH_CHEATED:
        return { kind: GameStatusKind.DRAW, reason: 'both players cheated' };
      case BattleshipEnding.STALEMATE:
        return { kind: GameStatusKind.DRAW, reason: 'no fleet was sunk' };
      default:
        return { kind: GameStatusKind.IN_PROGRESS };
    }
  },

  currentTurn(state): PlayerId | null {
    switch (state.phase) {
      case BattleshipPhase.PLACEMENT: {
        // Either player may commit at any point; this just names one for the UI.
        const waiting = state.commitments.findIndex((c) => c === null);
        return waiting < 0 ? null : (state.players[waiting] ?? null);
      }
      case BattleshipPhase.FIRING: {
        const next = state.pending ? 1 - state.pending.shooter : state.turnIndex;
        return state.players[next] ?? null;
      }
      case BattleshipPhase.REVEAL: {
        const waiting = state.reveals.findIndex((r) => r === null);
        return waiting < 0 ? null : (state.players[waiting] ?? null);
      }
      default:
        return null;
    }
  },

  encodeState(state): CborValue {
    return {
      p: [...state.players],
      f: PHASE_ORDER.indexOf(state.phase),
      k: state.commitments.map((c) => (c === null ? null : [...c])),
      s: state.shots.map((list) => list.map(encodeShot)),
      n: state.pending === null ? -1 : state.pending.shooter * CELL_COUNT + state.pending.cell,
      t: state.turnIndex,
      v: state.reveals.map((r) => (r === null ? null : encodeReveal(r))),
      c: state.cheated.map((flag) => (flag ? 1 : 0)),
      e: state.ending,
      w: state.winner,
    };
  },

  decodeState(value): BattleshipState {
    const m = asMap(value, 'battleship.state');

    const players = asArray(m.p, 'players', 2).map((p, i) => asString(p, `players[${i}]`, 64));
    if (players.length !== 2) throw new GameDecodeError('battleship: expected exactly 2 players');

    const phase = PHASE_ORDER[asInt(m.f, 'phase', 0, PHASE_ORDER.length - 1)] as BattleshipPhase;

    const rawCommitments = asArray(m.k, 'commitments', 2);
    if (rawCommitments.length !== 2) throw new GameDecodeError('battleship: expected 2 commitments');
    const commitments = rawCommitments.map((c, i) =>
      c === null ? null : decodeByteArray(c, `commitments[${i}]`, COMMITMENT_BYTES),
    );

    const rawShots = asArray(m.s, 'shots', 2);
    if (rawShots.length !== 2) throw new GameDecodeError('battleship: expected 2 shot lists');
    const shots = rawShots.map((list, i) =>
      asArray(list, `shots[${i}]`, CELL_COUNT).map((code, j) => decodeShot(code, `shots[${i}][${j}]`)),
    );

    const pendingCode = asInt(m.n, 'pending', -1, 2 * CELL_COUNT - 1);
    const pending: PendingShot | null =
      pendingCode < 0
        ? null
        : { shooter: (pendingCode - (pendingCode % CELL_COUNT)) / CELL_COUNT, cell: pendingCode % CELL_COUNT };

    const rawReveals = asArray(m.v, 'reveals', 2);
    if (rawReveals.length !== 2) throw new GameDecodeError('battleship: expected 2 reveal slots');
    const reveals = rawReveals.map((r, i) => (r === null ? null : decodeReveal(r, `reveals[${i}]`)));

    const rawCheated = asArray(m.c, 'cheated', 2);
    if (rawCheated.length !== 2) throw new GameDecodeError('battleship: expected 2 cheat flags');
    const cheated = rawCheated.map((flag, i) => asInt(flag, `cheated[${i}]`, 0, 1) === 1);

    return {
      players,
      phase,
      commitments,
      shots,
      pending,
      turnIndex: asInt(m.t, 'turnIndex', 0, 1),
      reveals,
      cheated,
      ending: asInt(m.e, 'ending', 0, BattleshipEnding.STALEMATE) as BattleshipEnding,
      winner: asInt(m.w, 'winner', -1, 1),
    };
  },

  encodeAction(action): CborValue {
    switch (action.type) {
      case 'place':
        return encodeActionEnvelope({ ...action, payload: { k: [...action.payload.commitment] } });
      case 'fire':
        return encodeActionEnvelope({ ...action, payload: { c: action.payload.cell } });
      case 'report':
        return encodeActionEnvelope({
          ...action,
          payload: {
            c: action.payload.cell,
            h: action.payload.hit,
            // 0 means "nothing sank"; otherwise ship index + 1.
            k: action.payload.sunk === null ? 0 : action.payload.sunk + 1,
          },
        });
      case 'reveal':
        return encodeActionEnvelope({
          ...action,
          payload: { f: encodeShips(action.payload.ships), z: [...action.payload.salt] },
        });
      default:
        throw new GameDecodeError(`battleship: unknown action "${String((action as GameAction).type)}"`);
    }
  },

  decodeAction(value, player): BattleshipAction {
    const envelope = decodeActionEnvelope(value, player);
    const { seq } = envelope;

    switch (envelope.type) {
      case 'place': {
        const payload = asMap(envelope.payload, 'battleship.place');
        return {
          type: 'place',
          player,
          seq,
          payload: { commitment: decodeByteArray(payload.k, 'commitment', COMMITMENT_BYTES) },
        };
      }

      case 'fire': {
        const payload = asMap(envelope.payload, 'battleship.fire');
        return { type: 'fire', player, seq, payload: { cell: asInt(payload.c, 'cell', 0, CELL_COUNT - 1) } };
      }

      case 'report': {
        const payload = asMap(envelope.payload, 'battleship.report');
        const hit = asBool(payload.h, 'hit');
        const sunkCode = asInt(payload.k, 'sunk', 0, FLEET.length);
        if (sunkCode > 0 && !hit) throw new GameDecodeError('report: a miss cannot sink a ship');
        return {
          type: 'report',
          player,
          seq,
          payload: {
            cell: asInt(payload.c, 'cell', 0, CELL_COUNT - 1),
            hit,
            sunk: sunkCode === 0 ? null : sunkCode - 1,
          },
        };
      }

      case 'reveal': {
        const payload = asMap(envelope.payload, 'battleship.reveal');
        return {
          type: 'reveal',
          player,
          seq,
          payload: {
            ships: decodeShips(payload.f, 'ships'),
            salt: decodeByteArray(payload.z, 'salt', SALT_BYTES),
          },
        };
      }

      default:
        throw new GameDecodeError(`battleship: unknown action "${envelope.type}"`);
    }
  },
};
