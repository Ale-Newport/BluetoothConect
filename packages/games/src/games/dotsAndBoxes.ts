/**
 * Dots and Boxes. Six rows of six dots, twenty-five boxes between them.
 *
 * Shaped exactly like the reference game (src/games/ticTacToe.ts): an immutable
 * state, one discriminated action, a validator that assumes the peer is hostile,
 * a pure reducer, and compact codecs on both sides.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT DEFINES THE GAME
 * ---------------------------------------------------------------------------
 * Drawing the fourth side of a box claims it AND the same player draws again.
 * A chain of five boxes is therefore five points and a sixth move, which is the
 * whole of the strategy: the player forced to open a chain hands it over.
 * Anything that advances the turn unconditionally after a move has not
 * implemented Dots and Boxes, it has implemented a scoring race, so the turn is
 * advanced in exactly one place below and only when nothing was claimed.
 *
 * ---------------------------------------------------------------------------
 * THE INDEXING SCHEME - a renderer has to get this exactly right
 * ---------------------------------------------------------------------------
 * Dots sit at (row, col) with row and col in 0-5. Edges live in two flat
 * boolean arrays, and the split is by ORIENTATION, because the two families
 * have different shapes and interleaving them into one array of 60 would make
 * every neighbour calculation a special case.
 *
 *   HORIZONTAL, 30 entries. h[r * 5 + c] joins dot (r, c) to dot (r, c + 1).
 *     r is 0-5 (six rows of dots), c is 0-4 (five gaps per row).
 *
 *   VERTICAL, 30 entries. v[r * 6 + c] joins dot (r, c) to dot (r + 1, c).
 *     r is 0-4 (five gaps down), c is 0-5 (six columns of dots).
 *
 *   BOX (r, c) with r and c in 0-4 is boxes[r * 5 + c], and its four sides are
 *     top    h[r * 5 + c]          bottom h[(r + 1) * 5 + c]
 *     left   v[r * 6 + c]          right  v[r * 6 + c + 1]
 *
 * Note the different strides: horizontal rows step by 5, vertical rows step by
 * 6. Using the box stride for both is the mistake this comment exists to stop.
 *
 * ---------------------------------------------------------------------------
 * TERMINATION AND DRAWS
 * ---------------------------------------------------------------------------
 * Every accepted action draws exactly one previously undrawn edge, so `drawn`
 * rises by one per ply and the game ends after exactly 60 plies however badly
 * both sides play. No round limit is needed, and none is imposed: the edge
 * count is already a hard bound.
 *
 * Twenty-five boxes is an ODD number, and when the last edge goes down every
 * box has all four sides and therefore an owner, so the scores sum to 25 and
 * cannot be level. The draw branch in status() is consequently unreachable on
 * this board. It is kept because it costs one line and because a 4x4 or 6x6
 * variant - an even box count - would need it, and a rule that only exists in
 * the author's head is a rule the next person deletes.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM AND WIRE SIZE
 * ---------------------------------------------------------------------------
 * Nothing here is a real number. Edges are booleans, owners are 0/1/2, indices
 * are 0-29 and scores 0-25, so there is no rounding for two devices to disagree
 * about.
 *
 * The two edge arrays are transmitted as two 30-BIT INTEGERS rather than as 60
 * CBOR booleans, which saves about 55 bytes on a 185-byte link and matters
 * because a rejoining peer is sent the whole state in one go. Thirty bits is
 * comfortably inside the range where `1 << bit` and `>>>` are exact on every JS
 * engine, and far inside 2^53, so the packing is lossless. The boxes stay as a
 * flat array of 25 small integers: packing those too would save another twenty
 * bytes and cost the renderer a bit-twiddling loop for no real gain.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  VALID,
  asArray,
  asInt,
  asMap,
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

/** 0 = unclaimed, 1 = first player, 2 = second player. */
export type BoxOwner = 0 | 1 | 2;

/** Dots per side. Everything else is derived from this one number. */
export const DOTS = 6;
/** Boxes per side: five, between six dots. */
export const BOXES = DOTS - 1;
export const BOX_COUNT = BOXES * BOXES; // 25
/** h[r * BOXES + c], r in 0-5, c in 0-4. */
export const H_COUNT = DOTS * BOXES; // 30
/** v[r * DOTS + c], r in 0-4, c in 0-5. */
export const V_COUNT = BOXES * DOTS; // 30
export const EDGE_COUNT = H_COUNT + V_COUNT; // 60

/** 0 = horizontal, 1 = vertical. Matches the two arrays in the state. */
export const Orientation = {
  HORIZONTAL: 0,
  VERTICAL: 1,
} as const;
export type Orientation = (typeof Orientation)[keyof typeof Orientation];

export interface DotsAndBoxesState {
  /** 30 horizontal edges. See the indexing scheme at the top of this file. */
  readonly h: readonly boolean[];
  /** 30 vertical edges. Note the stride is 6, not 5. */
  readonly v: readonly boolean[];
  /** 25 boxes, row-major, 0 until somebody closes the fourth side. */
  readonly boxes: readonly BoxOwner[];
  /** scores[0] belongs to players[0]. Redundant with `boxes`, kept because the
   *  UI wants it every frame and recounting 25 cells to draw a scoreboard is
   *  silly. decodeState re-derives it and refuses a snapshot that disagrees. */
  readonly scores: readonly [number, number];
  readonly players: readonly PlayerId[];
  readonly turnIndex: number;
  /** Edges drawn so far. The game ends at EDGE_COUNT. */
  readonly drawn: number;
  /** Boxes closed by the move just played, for the UI to animate. */
  readonly lastClaimed: readonly number[];
}

export interface DotsAndBoxesAction extends GameAction {
  readonly type: 'draw';
  readonly payload: { readonly orientation: Orientation; readonly index: number };
}

/**
 * The four edges of box (r, c), as [horizontal indices, vertical indices].
 * Kept as a function rather than a precomputed table because it is called at
 * most twice per move and the table would be one more thing to keep in step
 * with the comment above.
 */
function sidesOf(box: number): { readonly h: readonly [number, number]; readonly v: readonly [number, number] } {
  const r = Math.floor(box / BOXES);
  const c = box - r * BOXES;
  return {
    h: [r * BOXES + c, (r + 1) * BOXES + c],
    v: [r * DOTS + c, r * DOTS + c + 1],
  };
}

/** True when all four sides of `box` are down. */
function isClosed(h: readonly boolean[], v: readonly boolean[], box: number): boolean {
  const s = sidesOf(box);
  return (
    h[s.h[0]] === true && h[s.h[1]] === true && v[s.v[0]] === true && v[s.v[1]] === true
  );
}

/**
 * The boxes an edge borders: at most two, exactly one along the outer rim.
 *
 * Only these can have been closed by drawing it, so this is the whole of the
 * work a move has to do - there is never a reason to sweep all 25.
 */
function boxesTouching(orientation: Orientation, index: number): number[] {
  const out: number[] = [];
  if (orientation === Orientation.HORIZONTAL) {
    const r = Math.floor(index / BOXES);
    const c = index - r * BOXES;
    if (r > 0) out.push((r - 1) * BOXES + c); // the box above
    if (r < BOXES) out.push(r * BOXES + c); // the box below
  } else {
    const r = Math.floor(index / DOTS);
    const c = index - r * DOTS;
    if (c > 0) out.push(r * BOXES + (c - 1)); // the box to the left
    if (c < BOXES) out.push(r * BOXES + c); // the box to the right
  }
  return out;
}

/** Pack a run of booleans into one integer, bit i holding element i. */
function packBits(bits: readonly boolean[]): number {
  let out = 0;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out |= 1 << i;
  }
  return out >>> 0;
}

function unpackBits(mask: number, count: number): boolean[] {
  const out = new Array<boolean>(count);
  for (let i = 0; i < count; i++) out[i] = ((mask >>> i) & 1) === 1;
  return out;
}

export const dotsAndBoxes: GameDefinition<DotsAndBoxesState, DotsAndBoxesAction> = {
  id: 'dots-and-boxes',
  name: 'Dots and Boxes',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): DotsAndBoxesState {
    return {
      h: new Array<boolean>(H_COUNT).fill(false),
      v: new Array<boolean>(V_COUNT).fill(false),
      boxes: new Array<BoxOwner>(BOX_COUNT).fill(0),
      scores: [0, 0],
      players: [...setup.players],
      turnIndex: 0,
      drawn: 0,
      lastClaimed: [],
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.drawn >= EDGE_COUNT) return invalid('the game has already finished');
    if (action.type !== 'draw') return invalid(`unknown action "${action.type}"`);
    const expected = state.players[state.turnIndex];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);

    const orientation = action.payload?.orientation;
    const index = action.payload?.index;
    if (orientation !== Orientation.HORIZONTAL && orientation !== Orientation.VERTICAL) {
      return invalid('orientation must be 0 (horizontal) or 1 (vertical)');
    }
    const limit = orientation === Orientation.HORIZONTAL ? H_COUNT : V_COUNT;
    if (!Number.isInteger(index) || index < 0 || index >= limit) return invalid(`index must be 0-${limit - 1}`);

    const edges = orientation === Orientation.HORIZONTAL ? state.h : state.v;
    if (edges[index]) return invalid('that line is already drawn');
    return VALID;
  },

  applyAction(state, action): DotsAndBoxesState {
    const { orientation, index } = action.payload;
    const mark: BoxOwner = state.turnIndex === 0 ? 1 : 2;

    // Only the array that changed is copied; the other is shared by reference.
    // The conformance suite's purity check permits that sharing precisely
    // because nothing is ever written through it.
    let h = state.h;
    let v = state.v;
    if (orientation === Orientation.HORIZONTAL) {
      const next = [...state.h];
      next[index] = true;
      h = next;
    } else {
      const next = [...state.v];
      next[index] = true;
      v = next;
    }

    const claimed: number[] = [];
    for (const box of boxesTouching(orientation, index)) {
      if (state.boxes[box] === 0 && isClosed(h, v, box)) claimed.push(box);
    }

    let boxes = state.boxes;
    let scores = state.scores;
    if (claimed.length > 0) {
      const next = [...state.boxes];
      for (const box of claimed) next[box] = mark;
      boxes = next;
      scores =
        mark === 1
          ? [state.scores[0] + claimed.length, state.scores[1]]
          : [state.scores[0], state.scores[1] + claimed.length];
    }

    return {
      h,
      v,
      boxes,
      scores,
      players: state.players,
      // The one line that makes this Dots and Boxes: closing a box keeps the
      // turn. Two boxes can fall to a single edge, and that still counts once
      // for the purposes of moving again.
      turnIndex: claimed.length > 0 ? state.turnIndex : (state.turnIndex + 1) % state.players.length,
      drawn: state.drawn + 1,
      lastClaimed: claimed,
    };
  },

  status(state): GameStatus {
    if (state.drawn < EDGE_COUNT) return { kind: GameStatusKind.IN_PROGRESS };
    const [first, second] = state.scores;
    if (first > second) {
      return { kind: GameStatusKind.WON, winners: [state.players[0] as PlayerId], reason: `${first}-${second}` };
    }
    if (second > first) {
      return { kind: GameStatusKind.WON, winners: [state.players[1] as PlayerId], reason: `${second}-${first}` };
    }
    return { kind: GameStatusKind.DRAW, reason: 'the boxes were shared evenly' };
  },

  currentTurn(state): PlayerId | null {
    if (state.drawn >= EDGE_COUNT) return null;
    return state.players[state.turnIndex] ?? null;
  },

  encodeState(state): CborValue {
    return {
      h: packBits(state.h),
      v: packBits(state.v),
      b: [...state.boxes],
      s: [state.scores[0], state.scores[1]],
      p: [...state.players],
      t: state.turnIndex,
      d: state.drawn,
      l: [...state.lastClaimed],
    };
  },

  decodeState(value): DotsAndBoxesState {
    const m = asMap(value, 'dotsAndBoxes.state');
    // 2^30 - 1. asInt's default ceiling of 1e9 is below this, so the bound is
    // spelled out rather than inherited.
    const maskMax = 0x3fffffff;
    const h = unpackBits(asInt(m.h, 'h', 0, maskMax), H_COUNT);
    const v = unpackBits(asInt(m.v, 'v', 0, maskMax), V_COUNT);

    const rawBoxes = asArray(m.b, 'boxes', BOX_COUNT);
    if (rawBoxes.length !== BOX_COUNT) throw new GameDecodeError('dotsAndBoxes: boxes must have 25 entries');
    const boxes = rawBoxes.map((b, i) => asInt(b, `boxes[${i}]`, 0, 2) as BoxOwner);

    const rawPlayers = asArray(m.p, 'players', 2);
    if (rawPlayers.length !== 2) throw new GameDecodeError('dotsAndBoxes: expected exactly 2 players');
    const players = rawPlayers.map((p, i) => {
      if (typeof p !== 'string') throw new GameDecodeError(`dotsAndBoxes: players[${i}] must be a string`);
      if (p.length > 256) throw new GameDecodeError(`dotsAndBoxes: players[${i}] is too long`);
      return p;
    });

    const rawScores = asArray(m.s, 'scores', 2);
    if (rawScores.length !== 2) throw new GameDecodeError('dotsAndBoxes: scores must have 2 entries');
    const scores: [number, number] = [
      asInt(rawScores[0], 'scores[0]', 0, BOX_COUNT),
      asInt(rawScores[1], 'scores[1]', 0, BOX_COUNT),
    ];
    // A peer that sends a board with two claimed boxes and a score of 25 is
    // either buggy or lying, and either way the position is not one this
    // reducer could have produced. Cross-checking here is cheap; discovering it
    // later, as a scoreboard that contradicts the grid, is not.
    let heldByFirst = 0;
    let heldBySecond = 0;
    for (const owner of boxes) {
      if (owner === 1) heldByFirst += 1;
      else if (owner === 2) heldBySecond += 1;
    }
    if (heldByFirst !== scores[0] || heldBySecond !== scores[1]) {
      throw new GameDecodeError('dotsAndBoxes: scores do not match the claimed boxes');
    }

    const edgesDown = h.filter(Boolean).length + v.filter(Boolean).length;
    const drawn = asInt(m.d, 'drawn', 0, EDGE_COUNT);
    if (drawn !== edgesDown) throw new GameDecodeError('dotsAndBoxes: drawn count does not match the edges');

    // The same argument one level down, and the check the other two are
    // useless without: a scoreboard that agrees with a fabricated grid is
    // still a fabrication. A box is claimed by whoever draws its fourth side,
    // at the moment they draw it, so in every position this reducer can
    // produce "closed" and "owned" are the SAME set of boxes. An owned box
    // with a side still missing, or a closed box nobody owns, did not come
    // from a game of Dots and Boxes, and a peer that sends one is either
    // several protocol versions away or lying.
    for (let box = 0; box < BOX_COUNT; box++) {
      if (isClosed(h, v, box) !== (boxes[box] !== 0)) {
        throw new GameDecodeError(`dotsAndBoxes: box ${box} does not agree with the lines around it`);
      }
    }

    const lastClaimed = asArray(m.l, 'lastClaimed', 2).map((n, i) =>
      asInt(n, `lastClaimed[${i}]`, 0, BOX_COUNT - 1),
    );

    return {
      h,
      v,
      boxes,
      scores,
      players,
      turnIndex: asInt(m.t, 'turnIndex', 0, 1),
      drawn,
      lastClaimed,
    };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({
      ...action,
      payload: { o: action.payload.orientation, i: action.payload.index },
    });
  },

  decodeAction(value, player): DotsAndBoxesAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'draw') throw new GameDecodeError(`dotsAndBoxes: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'dotsAndBoxes.payload');
    // Orientation is carried as the integer it is, and not as the boolean it
    // could be squeezed into. Both cost one CBOR byte, so the boolean saves
    // nothing, and it costs correctness: a boolean encoder has to ask "is this
    // vertical?", and every value that is not vertical - 7, -1, a string -
    // answers "no" and arrives at the other end as a perfectly legal
    // HORIZONTAL line. A malformed move that silently becomes a legal one is
    // the worst of the three outcomes; asInt refusing it here is the best, and
    // is what every other game in this package does with its payload fields.
    const orientation = asInt(payload.o, 'orientation', 0, 1) as Orientation;
    const limit = orientation === Orientation.VERTICAL ? V_COUNT : H_COUNT;
    return {
      type: 'draw',
      player,
      seq: envelope.seq,
      payload: { orientation, index: asInt(payload.i, 'index', 0, limit - 1) },
    };
  },
};
