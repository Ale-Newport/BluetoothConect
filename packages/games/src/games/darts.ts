/**
 * Darts - standard 501, double out, two to four players.
 *
 * Rules implemented here:
 *   - everyone starts on 501 and subtracts what they score
 *   - three darts to a turn
 *   - you must finish EXACTLY on zero, and the finishing dart must be a double
 *     (the inner bull, 50, counts as double 25)
 *   - busting - going below zero, leaving exactly 1, or reaching zero on a
 *     non-double - restores the score you held at the START of the turn and ends
 *     the turn immediately
 *
 * A throw is AIMED, not chosen. The player sends a target point on the board
 * plus a timing accuracy in [0, 1]; the reducer draws the scatter from
 * `context.random`, so both devices compute the same landing point and neither
 * can claim a treble it did not throw. The wire carries intent, never outcome.
 *
 * ---------------------------------------------------------------------------
 * Determinism notes (this is the part that matters)
 * ---------------------------------------------------------------------------
 * 1. The stored state contains INTEGERS ONLY: scores, dart counts, and the
 *    landing point rounded to whole board units. No irrational quantity is ever
 *    persisted, so nothing can drift and accumulate between devices.
 *
 * 2. The scatter offset uses only +, - and * on doubles drawn from the shared
 *    PRNG, then `Math.round`. All four operations are exactly specified by
 *    IEEE-754 and `Math.round` is exactly specified by ECMA-262, so the landing
 *    coordinates are bit-identical on every engine.
 *
 * 3. RING classification compares the SQUARED radius `x*x + y*y` - an exact
 *    integer, since x and y are integers bounded by 240 - against constant
 *    thresholds. That is strictly more deterministic than `Math.hypot`, whose
 *    last bit is implementation-defined, and it removes any question of a dart
 *    landing on one side of a ring here and the other side there.
 *
 * 4. SECTOR classification is the one place an implementation-defined function
 *    is unavoidable, and `Math.atan2` is used only there - to bucket the point
 *    into one of 20 arcs, never to produce a stored value. It is safe because
 *    the sector boundaries lie at 9 + 18k degrees, whose tangents are
 *    irrational: no lattice point except the origin can sit exactly on a
 *    boundary, and the origin is deep inside the bull, which never reaches the
 *    sector code. The nearest an integer point within the board can come to a
 *    boundary is many millions of ULPs away, so a one-ULP difference in atan2
 *    can never change the bucket.
 *
 * `aimPoint` below does use cos/sin, but it is a UI/AI convenience that runs
 * OUTSIDE the reducer: its result becomes an integer action payload that is
 * transmitted, so only the throwing device ever evaluates it.
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

// ---------------------------------------------------------------------------
// Board geometry
// ---------------------------------------------------------------------------

/**
 * The 20 numbers in board order, starting at 20 (straight up, +y) and running
 * CLOCKWISE, which is how a real board is laid out.
 *
 * Coordinates are in millimetres from the centre of a regulation board, with +y
 * pointing UP. A renderer working in screen coordinates must flip y itself; the
 * rules never see pixels.
 */
export const SECTOR_ORDER: readonly number[] = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
];

/** Squared ring radii. Squared so the comparison against x*x + y*y is exact. */
const R2_INNER_BULL = 40.3225; //   6.35 mm - the 50
const R2_OUTER_BULL = 252.81; //   15.9  mm - the 25
const R2_TREBLE_INNER = 9801; //   99    mm
const R2_TREBLE_OUTER = 11449; //  107   mm
const R2_DOUBLE_INNER = 26244; //  162   mm
const R2_DOUBLE_OUTER = 28900; //  170   mm - anything beyond this is off the board

/** The furthest a target may be from the centre, and so the action's bound. */
export const BOARD_RADIUS = 170;
/** Landing points are clamped here: 170 of target plus 60 of worst-case scatter. */
const COORD_LIMIT = 240;

export const DartRing = {
  /** No dart thrown yet. */
  NONE: -1,
  /** Outside the double ring. */
  MISS: 0,
  SINGLE: 1,
  DOUBLE: 2,
  TREBLE: 3,
  /** The 25. Not a double, so it cannot check you out. */
  OUTER_BULL: 4,
  /** The 50. Counts as double 25 for the finish. */
  INNER_BULL: 5,
} as const;
export type DartRing = (typeof DartRing)[keyof typeof DartRing];

export interface DartHit {
  readonly points: number;
  readonly ring: DartRing;
  /** 1-20 for a numbered bed, 25 for either bull, 0 for a miss. */
  readonly sector: number;
}

/**
 * Which of the 20 arcs a point falls in. Only ever called with a point outside
 * the bull, so `x` and `y` are never both zero and atan2 is well defined.
 */
function sectorIndex(x: number, y: number): number {
  const degrees = Math.atan2(y, x) * (180 / Math.PI); // (-180, 180], anticlockwise from +x
  // Sector 20 is centred on +y (90 degrees) and spans 81..99. Measuring
  // clockwise from its leading edge puts 20 in bucket 0 and walks the numbers
  // round the board in SECTOR_ORDER.
  const shifted = (99 - degrees) % 360;
  const normalised = shifted < 0 ? shifted + 360 : shifted;
  const index = Math.floor(normalised / 18);
  if (index < 0) return 0;
  return index > 19 ? 19 : index;
}

/**
 * Score a landing point. Boundaries are inclusive on the inside of each ring:
 * a dart exactly on the 99 mm line is a treble, one exactly on 170 is a double.
 */
export function scoreDart(x: number, y: number): DartHit {
  const r2 = x * x + y * y; // exact: x and y are integers within +/-240
  if (r2 <= R2_INNER_BULL) return { points: 50, ring: DartRing.INNER_BULL, sector: 25 };
  if (r2 <= R2_OUTER_BULL) return { points: 25, ring: DartRing.OUTER_BULL, sector: 25 };
  if (r2 > R2_DOUBLE_OUTER) return { points: 0, ring: DartRing.MISS, sector: 0 };

  const sector = SECTOR_ORDER[sectorIndex(x, y)] as number;
  if (r2 >= R2_DOUBLE_INNER) return { points: sector * 2, ring: DartRing.DOUBLE, sector };
  if (r2 >= R2_TREBLE_INNER && r2 <= R2_TREBLE_OUTER) {
    return { points: sector * 3, ring: DartRing.TREBLE, sector };
  }
  return { points: sector, ring: DartRing.SINGLE, sector };
}

/** Radius a player aims at for each numbered ring, in board units. */
const AIM_RADIUS: Record<number, number> = {
  [DartRing.SINGLE]: 134, // the outer single band, 107..162
  [DartRing.DOUBLE]: 166, // the double band, 162..170
  [DartRing.TREBLE]: 103, // the treble band, 99..107
};

/**
 * The centre of a scoring bed, for a UI's aiming assist or a bot.
 *
 * Runs outside the reducer - see the determinism note at the top of the file -
 * and returns integers within the legal target range, so its output is a legal
 * action payload as it stands. At accuracy 1 the scatter is small enough that
 * the named bed is certain; at lower accuracy this is a centre to aim at and
 * nothing more.
 */
export function aimPoint(sector: number, ring: DartRing): { x: number; y: number } {
  if (ring === DartRing.INNER_BULL || ring === DartRing.NONE) return { x: 0, y: 0 };
  if (ring === DartRing.OUTER_BULL) return { x: 0, y: 11 };
  // The far corner of the legal target square: nothing within it can score.
  if (ring === DartRing.MISS) return { x: BOARD_RADIUS, y: BOARD_RADIUS };

  const radius = AIM_RADIUS[ring] ?? AIM_RADIUS[DartRing.SINGLE] ?? 134;
  const index = SECTOR_ORDER.indexOf(sector);
  const degrees = index < 0 ? 90 : 90 - 18 * index;
  const radians = (degrees * Math.PI) / 180;
  return { x: clampCoord(Math.cos(radians) * radius), y: clampCoord(Math.sin(radians) * radius) };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const START_SCORE = 501;
export const DARTS_PER_TURN = 3;
const MIN_START_SCORE = 2;
const MAX_START_SCORE = 1001;

/** Scatter half-width at accuracy 0 and at accuracy 1, in board units. */
const MAX_SPREAD = 60;
const MIN_SPREAD = 3;

/**
 * A leg is abandoned as a draw after this many turns per player. A real 501 leg
 * is over inside twenty turns; the cap exists so that the reducer is guaranteed
 * to terminate no matter how badly the players throw, which the conformance
 * suite requires and a hostile peer cannot therefore stall.
 */
const MAX_TURNS_PER_PLAYER = 40;

export interface DartsState {
  readonly players: readonly PlayerId[];
  /** Remaining score per player, parallel to `players`. */
  readonly scores: readonly number[];
  readonly turnIndex: number;
  /** Darts already thrown in the current turn, 0-2. */
  readonly dartsThrown: number;
  /** The thrower's score at the start of this turn, restored on a bust. */
  readonly turnStartScore: number;
  readonly turnsCompleted: number;
  /** Index into `players`, or -1 while nobody has checked out. */
  readonly winnerIndex: number;
  // Last dart, for rendering. All integers.
  readonly lastX: number;
  readonly lastY: number;
  readonly lastPoints: number;
  readonly lastRing: DartRing;
  readonly lastSector: number;
  readonly lastWasBust: boolean;
  /** Index of whoever threw the last dart, or -1. Survives the turn change. */
  readonly lastThrower: number;
}

export interface DartsThrowPayload {
  readonly targetX: number;
  readonly targetY: number;
  /** Timing accuracy in [0, 1]. Quantised to 1/100 on the wire. */
  readonly accuracy: number;
}

export interface DartsAction extends GameAction {
  readonly type: 'throw';
  readonly payload: DartsThrowPayload;
}

/** Round to an integer, clamp to the stored range, and normalise -0 to 0. */
function clampCoord(value: number): number {
  const rounded = Math.round(value);
  if (rounded <= -COORD_LIMIT) return -COORD_LIMIT;
  if (rounded >= COORD_LIMIT) return COORD_LIMIT;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Round for the wire. Deliberately leaves NaN and Infinity alone so that
 * `asInt` rejects them rather than silently turning nonsense into a legal move.
 */
function wireInt(value: number): number {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

function maxTurns(playerCount: number): number {
  return MAX_TURNS_PER_PLAYER * playerCount;
}

function startScoreFrom(options: Readonly<Record<string, CborValue>>): number {
  const raw = options.start;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_START_SCORE && raw <= MAX_START_SCORE) {
    return raw;
  }
  return START_SCORE;
}

/** The bull counts as double 25, so both close a leg. */
function isDoubleRing(ring: DartRing): boolean {
  return ring === DartRing.DOUBLE || ring === DartRing.INNER_BULL;
}

export const darts: GameDefinition<DartsState, DartsAction> = {
  id: 'darts',
  name: 'Darts',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 4,

  createInitialState(setup: GameSetup): DartsState {
    const start = startScoreFrom(setup.options);
    return {
      players: [...setup.players],
      scores: setup.players.map(() => start),
      turnIndex: 0,
      dartsThrown: 0,
      turnStartScore: start,
      turnsCompleted: 0,
      winnerIndex: -1,
      lastX: 0,
      lastY: 0,
      lastPoints: 0,
      lastRing: DartRing.NONE,
      lastSector: 0,
      lastWasBust: false,
      lastThrower: -1,
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.winnerIndex >= 0) return invalid('the leg has already been won');
    if (state.turnsCompleted >= maxTurns(state.players.length)) return invalid('the leg has already finished');
    if (action.type !== 'throw') return invalid(`unknown action "${action.type}"`);

    const expected = state.players[state.turnIndex];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn to throw`);
    if (state.dartsThrown >= DARTS_PER_TURN) return invalid('no darts left in this turn');

    const payload = action.payload as DartsThrowPayload | undefined;
    if (payload === null || typeof payload !== 'object') return invalid('throw needs a target');
    const { targetX, targetY, accuracy } = payload;
    if (!Number.isInteger(targetX) || targetX < -BOARD_RADIUS || targetX > BOARD_RADIUS) {
      return invalid('targetX must be a whole number within the board');
    }
    if (!Number.isInteger(targetY) || targetY < -BOARD_RADIUS || targetY > BOARD_RADIUS) {
      return invalid('targetY must be a whole number within the board');
    }
    if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) {
      return invalid('accuracy must be between 0 and 1');
    }
    return VALID;
  },

  applyAction(state, action, context): DartsState {
    const { targetX, targetY, accuracy } = action.payload;

    // Scatter: two draws per axis give a triangular distribution centred on the
    // target, so a good throw clusters instead of spreading flat. Only +, - and
    // * on doubles, then a round to whole units - see the header note.
    const spread = MIN_SPREAD + (MAX_SPREAD - MIN_SPREAD) * (1 - accuracy);
    const offsetX = (context.random.next() + context.random.next() - 1) * spread;
    const offsetY = (context.random.next() + context.random.next() - 1) * spread;
    const x = clampCoord(targetX + offsetX);
    const y = clampCoord(targetY + offsetY);
    const hit = scoreDart(x, y);

    const index = state.turnIndex;
    const before = state.scores[index] as number;
    const after = before - hit.points;

    const won = after === 0 && isDoubleRing(hit.ring);
    // Below zero, stranded on 1, or home on a non-double: the whole turn is void.
    const bust = !won && (after < 0 || after === 1 || after === 0);

    const scores = [...state.scores];
    if (won) scores[index] = 0;
    else if (bust) scores[index] = state.turnStartScore;
    else scores[index] = after;

    const dartsThrown = state.dartsThrown + 1;
    const turnOver = won || bust || dartsThrown >= DARTS_PER_TURN;
    const nextIndex = turnOver && !won ? (index + 1) % state.players.length : index;

    return {
      players: state.players,
      scores,
      turnIndex: nextIndex,
      dartsThrown: turnOver ? 0 : dartsThrown,
      turnStartScore: turnOver && !won ? (scores[nextIndex] as number) : state.turnStartScore,
      turnsCompleted: state.turnsCompleted + (turnOver ? 1 : 0),
      winnerIndex: won ? index : -1,
      lastX: x,
      lastY: y,
      lastPoints: hit.points,
      lastRing: hit.ring,
      lastSector: hit.sector,
      lastWasBust: bust,
      lastThrower: index,
    };
  },

  status(state): GameStatus {
    const winner = state.winnerIndex >= 0 ? state.players[state.winnerIndex] : undefined;
    if (winner !== undefined) {
      return { kind: GameStatusKind.WON, winners: [winner], reason: 'checked out on a double' };
    }
    if (state.turnsCompleted >= maxTurns(state.players.length)) {
      return { kind: GameStatusKind.DRAW, reason: 'the leg ran too long' };
    }
    return { kind: GameStatusKind.IN_PROGRESS };
  },

  currentTurn(state): PlayerId | null {
    if (state.winnerIndex >= 0) return null;
    if (state.turnsCompleted >= maxTurns(state.players.length)) return null;
    return state.players[state.turnIndex] ?? null;
  },

  encodeState(state): CborValue {
    return {
      p: [...state.players],
      s: [...state.scores],
      t: state.turnIndex,
      d: state.dartsThrown,
      b: state.turnStartScore,
      n: state.turnsCompleted,
      w: state.winnerIndex,
      x: state.lastX,
      y: state.lastY,
      v: state.lastPoints,
      r: state.lastRing,
      c: state.lastSector,
      u: state.lastWasBust ? 1 : 0,
      l: state.lastThrower,
    };
  },

  decodeState(value): DartsState {
    const m = asMap(value, 'darts.state');
    const players = asArray(m.p, 'players', 4).map((p, i) => {
      if (typeof p !== 'string') throw new GameDecodeError(`players[${i}]: expected a string`);
      if (p.length > 128) throw new GameDecodeError(`players[${i}]: too long`);
      return p;
    });
    if (players.length < 2 || players.length > 4) throw new GameDecodeError('darts: 2-4 players required');

    const scores = asArray(m.s, 'scores', 4).map((s, i) => asInt(s, `scores[${i}]`, 0, MAX_START_SCORE));
    if (scores.length !== players.length) throw new GameDecodeError('darts: one score per player required');

    const turnIndex = asInt(m.t, 'turnIndex', 0, players.length - 1);
    const winnerIndex = asInt(m.w, 'winnerIndex', -1, players.length - 1);

    return {
      players,
      scores,
      turnIndex,
      dartsThrown: asInt(m.d, 'dartsThrown', 0, DARTS_PER_TURN - 1),
      turnStartScore: asInt(m.b, 'turnStartScore', 0, MAX_START_SCORE),
      turnsCompleted: asInt(m.n, 'turnsCompleted', 0, maxTurns(players.length)),
      winnerIndex,
      lastX: asInt(m.x, 'lastX', -COORD_LIMIT, COORD_LIMIT),
      lastY: asInt(m.y, 'lastY', -COORD_LIMIT, COORD_LIMIT),
      lastPoints: asInt(m.v, 'lastPoints', 0, 60),
      lastRing: asInt(m.r, 'lastRing', DartRing.NONE, DartRing.INNER_BULL) as DartRing,
      lastSector: asInt(m.c, 'lastSector', 0, 25),
      lastWasBust: asInt(m.u, 'lastWasBust', 0, 1) === 1,
      lastThrower: asInt(m.l, 'lastThrower', -1, players.length - 1),
    };
  },

  encodeAction(action): CborValue {
    // Three small integers: about a dozen bytes on the wire including the
    // envelope, which matters on a link with ~180 usable bytes per packet.
    return encodeActionEnvelope({
      ...action,
      payload: {
        x: wireInt(action.payload.targetX),
        y: wireInt(action.payload.targetY),
        a: wireInt(action.payload.accuracy * 100),
      },
    });
  },

  decodeAction(value, player): DartsAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'throw') throw new GameDecodeError(`darts: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'darts.payload');
    return {
      type: 'throw',
      player,
      seq: envelope.seq,
      payload: {
        targetX: asInt(payload.x, 'targetX', -BOARD_RADIUS, BOARD_RADIUS),
        targetY: asInt(payload.y, 'targetY', -BOARD_RADIUS, BOARD_RADIUS),
        // Accuracy travels as hundredths. decode(encode(decode(v))) === decode(v)
        // for every value on the wire, so the round trip is stable and both
        // devices reduce with the exact same double.
        accuracy: asInt(payload.a, 'accuracy', 0, 100) / 100,
      },
    };
  },
};
