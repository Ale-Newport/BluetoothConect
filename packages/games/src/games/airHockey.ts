/**
 * Air Hockey. A realtime, two-player AirLink game.
 *
 * A 600 x 1000 vertical table. Player index 0 (the host) defends the BOTTOM
 * goal and attacks upward; player index 1 defends the TOP goal. Each player
 * drags a circular mallet that is confined to their own half; the puck slides
 * with friction, bounces off the rails and scores through the gap in the middle
 * of each short wall. First to 7 wins.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM NOTES - the whole reason this file is written the way it is
 * ---------------------------------------------------------------------------
 *
 * 1. All physics arithmetic is +, -, * and / on doubles, which IEEE-754
 *    guarantees to be bit-identical on every JavaScript engine. The only
 *    transcendental used is Math.sqrt, which IEEE-754 also requires to be
 *    correctly rounded, and it is needed in exactly three places: normalising
 *    the mallet's step vector, the puck/mallet collision normal, and the puck
 *    speed cap. Everywhere else distances are compared SQUARED so no root is
 *    taken at all.
 *
 * 2. Every number stored in the state is rounded to 3 decimals at the end of
 *    each tick (`r3`). Even if a future engine were to differ by an ulp inside
 *    a sqrt, the quantisation grid absorbs it instead of letting the error
 *    compound over thousands of ticks. It also makes the wire form exact: the
 *    encoder ships milli-units as plain integers, so encodeState -> decodeState
 *    reproduces the live doubles bit for bit rather than approximately.
 *
 * 3. The face-off pause is derived from `context.elapsedMs` against a stored
 *    `serveAt` deadline rather than from a counter that ticks down. Nothing in
 *    the state changes while play is paused, which means (a) a paused table
 *    costs zero snapshot churn, and (b) replaying the action log from scratch
 *    reproduces the live state exactly, since ticks over a paused table are
 *    genuinely no-ops. The mallets are frozen during the face-off too, which is
 *    what makes that true - and it matches how a real table starts: nobody
 *    moves until the puck is dropped.
 *
 *    The one cost of timing the pause from the clock is that a guest whose
 *    simulated clock is a tick or two ahead of the host's will start the puck a
 *    tick or two early; the host's next snapshot corrects it, exactly as it
 *    corrects any other prediction error in a realtime game.
 *
 * 4. `tick` is the only thing that moves a mallet. An `aim` action merely
 *    records a TARGET, so a peer that floods the link with aims still cannot
 *    move its mallet faster than MALLET_STEP units per tick. Nothing in the
 *    payload names a mallet either: the mallet is looked up from the
 *    authenticated player id, so one player physically cannot move the other's.
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
  asString,
  decodeActionEnvelope,
  encodeActionEnvelope,
  invalid,
  type GameAction,
  type GameContext,
  type GameDefinition,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';

// ---------------------------------------------------------------------------
// Table geometry and physics constants (units are table units, time is ticks)
// ---------------------------------------------------------------------------

/** Everything a renderer needs to draw the table to scale. */
export const AIR_HOCKEY = {
  /** Table width (x axis). */
  WIDTH: 600,
  /** Table height (y axis); y = 0 is player 1's goal line, y = 1000 is player 0's. */
  HEIGHT: 1000,
  /** The half-way line. Player 0 owns y > CENTER_Y, player 1 owns y < CENTER_Y. */
  CENTER_Y: 500,
  PUCK_RADIUS: 18,
  MALLET_RADIUS: 34,
  /** The goal mouth spans x in [GOAL_MIN_X, GOAL_MAX_X] on both short walls. */
  GOAL_MIN_X: 200,
  GOAL_MAX_X: 400,
  /** Hard cap on how far a mallet may travel in one tick: no teleporting. */
  MALLET_STEP: 12,
  /** Hard cap on puck displacement per tick. Well under the 52-unit contact
   *  radius, so the puck can never tunnel through a mallet. */
  PUCK_MAX_STEP: 30,
  /** Velocity multiplier per tick (0.995^60 ~ 0.74 per second). */
  FRICTION: 0.995,
  WALL_RESTITUTION: 0.9,
  MALLET_RESTITUTION: 0.95,
  /**
   * Below this speed the puck is parked.
   *
   * It has to sit above 0.1416: rounding the stored velocity to 3 decimals
   * turns friction into a no-op once one tick of decay is smaller than half a
   * milli-unit (v * 0.005 < 0.0005, i.e. v < 0.1), so a slower puck would creep
   * across the table for ever. Any pair of stuck components is at most
   * sqrt(0.1^2 + 0.1^2) = 0.1415 fast, so 0.15 always catches it.
   */
  REST_STEP: 0.15,
  /** Speed the puck is served with, toward whoever just conceded. */
  SERVE_STEP: 4,
  /** Opening face-off pause. */
  FACE_OFF_MS: 3000,
  /** Pause after a goal, before the next serve. */
  GOAL_PAUSE_MS: 2000,
  WIN_SCORE: 7,
} as const;

const W = AIR_HOCKEY.WIDTH;
const H = AIR_HOCKEY.HEIGHT;
const CY = AIR_HOCKEY.CENTER_Y;
const PR = AIR_HOCKEY.PUCK_RADIUS;
const MR = AIR_HOCKEY.MALLET_RADIUS;
/** Distance between centres at which puck and mallet touch. */
const CONTACT_R = PR + MR; // 52
const CONTACT_R_SQ = CONTACT_R * CONTACT_R;
const MALLET_STEP_SQ = AIR_HOCKEY.MALLET_STEP * AIR_HOCKEY.MALLET_STEP;
const PUCK_MAX_STEP_SQ = AIR_HOCKEY.PUCK_MAX_STEP * AIR_HOCKEY.PUCK_MAX_STEP;
const REST_STEP_SQ = AIR_HOCKEY.REST_STEP * AIR_HOCKEY.REST_STEP;
/**
 * The puck passes the goal line only when its whole body clears the posts.
 * Modelling the posts as circles would be more faithful; requiring the centre
 * to be inside the shrunken mouth costs one comparison and never leaves the
 * puck wedged half-in, which matters far more on a phone screen.
 */
const MOUTH_MIN_X = AIR_HOCKEY.GOAL_MIN_X + PR; // 218
const MOUTH_MAX_X = AIR_HOCKEY.GOAL_MAX_X - PR; // 382

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface MalletState {
  /** Current centre. */
  readonly x: number;
  readonly y: number;
  /** Where the player last asked the mallet to be. Already clamped to the half. */
  readonly tx: number;
  readonly ty: number;
}

export interface PuckState {
  readonly x: number;
  readonly y: number;
  /** Velocity in table units per tick. */
  readonly vx: number;
  readonly vy: number;
}

export interface AirHockeyState {
  readonly players: readonly [PlayerId, PlayerId];
  /** Index 0 defends the bottom goal, index 1 the top. */
  readonly mallets: readonly [MalletState, MalletState];
  readonly puck: PuckState;
  readonly scores: readonly [number, number];
  /** -1 while the game is live, otherwise the winning player's index. */
  readonly winnerIndex: number;
  /** Simulated-milliseconds deadline before which nothing moves. */
  readonly serveAt: number;
}

export interface AirHockeyAction extends GameAction {
  readonly type: 'aim';
  /** Desired mallet centre. Clamped by the reducer; never trusted as given. */
  readonly payload: { readonly x: number; readonly y: number };
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Round to 3 decimals. `+ 0` normalises -0 to 0 so two devices that reach the
 * same value by different signs still encode identically.
 */
function r3(v: number): number {
  return Math.round(v * 1000) / 1000 + 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The box a mallet centre may occupy. Index 0 is the bottom half. */
function malletBounds(index: number): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: MR,
    maxX: W - MR,
    minY: index === 0 ? CY + MR : MR,
    maxY: index === 0 ? H - MR : CY - MR,
  };
}

function homeMallet(index: number): MalletState {
  const y = index === 0 ? 850 : 150;
  return { x: W / 2, y, tx: W / 2, ty: y };
}

/** Advance one mallet toward its target, never further than MALLET_STEP. */
function stepMallet(m: MalletState, index: number): { x: number; y: number; vx: number; vy: number } {
  const b = malletBounds(index);
  // Re-clamp the target here as well as in the reducer: a snapshot from a
  // hostile host could carry a target outside the half.
  const tx = clamp(m.tx, b.minX, b.maxX);
  const ty = clamp(m.ty, b.minY, b.maxY);
  const dx = tx - m.x;
  const dy = ty - m.y;
  const distSq = dx * dx + dy * dy;
  let nx: number;
  let ny: number;
  if (distSq <= MALLET_STEP_SQ) {
    nx = tx;
    ny = ty;
  } else {
    // The one unavoidable root on this path; the result is rounded below.
    const scale = AIR_HOCKEY.MALLET_STEP / Math.sqrt(distSq);
    nx = m.x + dx * scale;
    ny = m.y + dy * scale;
  }
  nx = r3(clamp(nx, b.minX, b.maxX));
  ny = r3(clamp(ny, b.minY, b.maxY));
  // Velocity is the actual rounded displacement, so what the collision sees is
  // exactly what the mallet did.
  return { x: nx, y: ny, vx: r3(nx - m.x), vy: r3(ny - m.y) };
}

interface Moving {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Elastic puck/mallet response with the mallet treated as infinitely heavy: the
 * impulse is computed on the RELATIVE velocity, which is what makes a swung
 * mallet impart its own speed to the puck instead of merely reflecting it.
 */
function collide(puck: Moving, mallet: Moving, index: number): Moving {
  const dx = puck.x - mallet.x;
  const dy = puck.y - mallet.y;
  const distSq = dx * dx + dy * dy;
  if (distSq >= CONTACT_R_SQ) return puck;

  let nx: number;
  let ny: number;
  if (distSq > 1e-9) {
    const dist = Math.sqrt(distSq);
    nx = dx / dist;
    ny = dy / dist;
  } else {
    // Exactly concentric. Pick a fixed normal - away from the mallet's own goal
    // - so both devices resolve the degenerate case the same way.
    nx = 0;
    ny = index === 0 ? -1 : 1;
  }

  const x = mallet.x + nx * CONTACT_R;
  const y = mallet.y + ny * CONTACT_R;

  const rvn = (puck.vx - mallet.vx) * nx + (puck.vy - mallet.vy) * ny;
  if (rvn >= 0) {
    // Already separating: push apart, but do not add energy.
    return { x, y, vx: puck.vx, vy: puck.vy };
  }
  const j = -(1 + AIR_HOCKEY.MALLET_RESTITUTION) * rvn;
  return { x, y, vx: puck.vx + j * nx, vy: puck.vy + j * ny };
}

function capSpeed(vx: number, vy: number): { vx: number; vy: number } {
  const speedSq = vx * vx + vy * vy;
  if (speedSq <= PUCK_MAX_STEP_SQ) return { vx, vy };
  const scale = AIR_HOCKEY.PUCK_MAX_STEP / Math.sqrt(speedSq);
  return { vx: vx * scale, vy: vy * scale };
}

function malletIndexOf(state: AirHockeyState, player: PlayerId): number {
  if (state.players[0] === player) return 0;
  if (state.players[1] === player) return 1;
  return -1;
}

/** Milli-unit quantiser for the wire. */
function q(v: number): number {
  return Math.round(v * 1000);
}

/** Inverse of `q`. Exact for anything `r3` produced. */
function unq(v: number): number {
  return v / 1000 + 0;
}

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

export const airHockey: GameDefinition<AirHockeyState, AirHockeyAction> = {
  id: 'air-hockey',
  name: 'Air Hockey',
  protocolVersion: 1,
  mode: GameMode.REALTIME,
  minPlayers: 2,
  maxPlayers: 2,
  tickRate: 60,

  createInitialState(setup: GameSetup): AirHockeyState {
    const [p0, p1] = setup.players;
    if (p0 === undefined || p1 === undefined || setup.players.length !== 2) {
      throw new Error('airHockey: exactly two players are required');
    }
    // Which way the opening serve goes is drawn from the shared seed, so both
    // devices agree without exchanging anything.
    const dir = (setup.seed & 1) === 0 ? 1 : -1;
    return {
      players: [p0, p1],
      mallets: [homeMallet(0), homeMallet(1)],
      puck: { x: W / 2, y: CY, vx: 0, vy: AIR_HOCKEY.SERVE_STEP * dir },
      scores: [0, 0],
      winnerIndex: -1,
      serveAt: AIR_HOCKEY.FACE_OFF_MS,
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.winnerIndex >= 0) return invalid('the game has already finished');
    if (action.type !== 'aim') return invalid(`unknown action "${action.type}"`);
    if (malletIndexOf(state, action.player) < 0) return invalid(`${action.player} is not at this table`);
    const { x, y } = action.payload;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return invalid('aim must be a finite point');
    // Out-of-half and off-table aims are legal to SEND - a finger drags past the
    // edge constantly - they are simply clamped by the reducer below.
    return VALID;
  },

  applyAction(state, action): AirHockeyState {
    // validateAction has already established that this player owns a mallet.
    const index: 0 | 1 = malletIndexOf(state, action.player) === 1 ? 1 : 0;
    const b = malletBounds(index);
    const current = state.mallets[index];
    const target: MalletState = {
      // The mallet does not move here: only the target it walks toward changes,
      // which is what stops an aim flood from teleporting a mallet.
      x: current.x,
      y: current.y,
      tx: r3(clamp(action.payload.x, b.minX, b.maxX)),
      ty: r3(clamp(action.payload.y, b.minY, b.maxY)),
    };
    const mallets: [MalletState, MalletState] =
      index === 0 ? [target, state.mallets[1]] : [state.mallets[0], target];
    return {
      players: state.players,
      mallets,
      puck: state.puck,
      scores: state.scores,
      winnerIndex: state.winnerIndex,
      serveAt: state.serveAt,
    };
  },

  tick(state, context: GameContext): AirHockeyState {
    if (state.winnerIndex >= 0) return state;
    // Face-off / post-goal pause: a genuine no-op, see the header note.
    if (context.elapsedMs < state.serveAt) return state;

    const m0 = stepMallet(state.mallets[0], 0);
    const m1 = stepMallet(state.mallets[1], 1);

    // -- integrate the puck ---------------------------------------------------
    let vx = state.puck.vx * AIR_HOCKEY.FRICTION;
    let vy = state.puck.vy * AIR_HOCKEY.FRICTION;
    const glideSq = vx * vx + vy * vy;
    if (glideSq < REST_STEP_SQ) {
      vx = 0;
      vy = 0;
    } else {
      const capped = capSpeed(vx, vy);
      vx = capped.vx;
      vy = capped.vy;
    }
    let puck: Moving = { x: state.puck.x + vx, y: state.puck.y + vy, vx, vy };

    // -- mallets, in a fixed order so both devices resolve ties identically ---
    puck = collide(puck, m0, 0);
    puck = collide(puck, m1, 1);
    const afterHit = capSpeed(puck.vx, puck.vy);
    puck = { x: puck.x, y: puck.y, vx: afterHit.vx, vy: afterHit.vy };

    // -- side rails -----------------------------------------------------------
    if (puck.x < PR) {
      puck = { x: PR, y: puck.y, vx: puck.vx < 0 ? -puck.vx * AIR_HOCKEY.WALL_RESTITUTION : puck.vx, vy: puck.vy };
    } else if (puck.x > W - PR) {
      puck = { x: W - PR, y: puck.y, vx: puck.vx > 0 ? -puck.vx * AIR_HOCKEY.WALL_RESTITUTION : puck.vx, vy: puck.vy };
    }

    // -- short walls and goals ------------------------------------------------
    const throughMouth = puck.x >= MOUTH_MIN_X && puck.x <= MOUTH_MAX_X;
    let scorer: -1 | 0 | 1 = -1;
    if (puck.y < PR) {
      if (!throughMouth) {
        puck = { x: puck.x, y: PR, vx: puck.vx, vy: puck.vy < 0 ? -puck.vy * AIR_HOCKEY.WALL_RESTITUTION : puck.vy };
      } else if (puck.y <= 0) {
        scorer = 0; // the bottom player attacks the top goal
      }
    } else if (puck.y > H - PR) {
      if (!throughMouth) {
        puck = { x: puck.x, y: H - PR, vx: puck.vx, vy: puck.vy > 0 ? -puck.vy * AIR_HOCKEY.WALL_RESTITUTION : puck.vy };
      } else if (puck.y >= H) {
        scorer = 1;
      }
    }

    if (scorer !== -1) {
      const tally = state.scores[scorer] + 1;
      const scores: [number, number] = scorer === 0 ? [tally, state.scores[1]] : [state.scores[0], tally];
      const won = tally >= AIR_HOCKEY.WIN_SCORE;
      return {
        players: state.players,
        mallets: [homeMallet(0), homeMallet(1)],
        puck: {
          x: W / 2,
          y: CY,
          vx: 0,
          // Served toward whoever just conceded.
          vy: scorer === 0 ? -AIR_HOCKEY.SERVE_STEP : AIR_HOCKEY.SERVE_STEP,
        },
        scores,
        winnerIndex: won ? scorer : -1,
        serveAt: r3(context.elapsedMs + AIR_HOCKEY.GOAL_PAUSE_MS),
      };
    }

    return {
      players: state.players,
      mallets: [
        { x: m0.x, y: m0.y, tx: r3(state.mallets[0].tx), ty: r3(state.mallets[0].ty) },
        { x: m1.x, y: m1.y, tx: r3(state.mallets[1].tx), ty: r3(state.mallets[1].ty) },
      ],
      // Rounding the stored puck to 3 decimals is what stops a one-ulp
      // difference inside Math.sqrt from compounding across a long rally.
      puck: { x: r3(puck.x), y: r3(puck.y), vx: r3(puck.vx), vy: r3(puck.vy) },
      scores: state.scores,
      winnerIndex: -1,
      serveAt: state.serveAt,
    };
  },

  status(state): GameStatus {
    if (state.winnerIndex >= 0) {
      const winner = state.players[state.winnerIndex === 0 ? 0 : 1];
      return { kind: GameStatusKind.WON, winners: [winner], reason: `first to ${AIR_HOCKEY.WIN_SCORE}` };
    }
    return { kind: GameStatusKind.IN_PROGRESS };
  },

  encodeState(state): CborValue {
    const [m0, m1] = state.mallets;
    return {
      n: [state.players[0], state.players[1]],
      // Flat integer milli-units: eight numbers for the mallets, four for the
      // puck. A whole snapshot is about 80 bytes, well inside one packet.
      m: [q(m0.x), q(m0.y), q(m0.tx), q(m0.ty), q(m1.x), q(m1.y), q(m1.tx), q(m1.ty)],
      k: [q(state.puck.x), q(state.puck.y), q(state.puck.vx), q(state.puck.vy)],
      s: [state.scores[0], state.scores[1]],
      w: state.winnerIndex,
      v: q(state.serveAt),
    };
  },

  decodeState(value): AirHockeyState {
    const m = asMap(value, 'airHockey.state');

    const names = asArray(m.n, 'airHockey.players', 2);
    if (names.length !== 2) throw new GameDecodeError('airHockey.players: expected exactly two players');
    const p0 = asString(names[0], 'airHockey.players[0]', 64);
    const p1 = asString(names[1], 'airHockey.players[1]', 64);

    const rawM = asArray(m.m, 'airHockey.mallets', 8);
    if (rawM.length !== 8) throw new GameDecodeError('airHockey.mallets: expected eight numbers');
    const pos = rawM.map((n, i) => unq(asInt(n, `airHockey.mallets[${i}]`, -200_000, 1_200_000)));

    const rawK = asArray(m.k, 'airHockey.puck', 4);
    if (rawK.length !== 4) throw new GameDecodeError('airHockey.puck: expected four numbers');
    const px = unq(asInt(rawK[0], 'airHockey.puck.x', -200_000, 1_200_000));
    const py = unq(asInt(rawK[1], 'airHockey.puck.y', -200_000, 1_200_000));
    // A velocity beyond the cap could only come from a peer that is lying.
    const pvx = unq(asInt(rawK[2], 'airHockey.puck.vx', -60_000, 60_000));
    const pvy = unq(asInt(rawK[3], 'airHockey.puck.vy', -60_000, 60_000));

    const rawS = asArray(m.s, 'airHockey.scores', 2);
    if (rawS.length !== 2) throw new GameDecodeError('airHockey.scores: expected two scores');
    const s0 = asInt(rawS[0], 'airHockey.scores[0]', 0, AIR_HOCKEY.WIN_SCORE);
    const s1 = asInt(rawS[1], 'airHockey.scores[1]', 0, AIR_HOCKEY.WIN_SCORE);

    const winnerIndex = asInt(m.w, 'airHockey.winner', -1, 1);
    if (winnerIndex >= 0 && (winnerIndex === 0 ? s0 : s1) < AIR_HOCKEY.WIN_SCORE) {
      throw new GameDecodeError('airHockey.winner: claimed a win without the score to match');
    }

    return {
      players: [p0, p1],
      mallets: [
        { x: pos[0] as number, y: pos[1] as number, tx: pos[2] as number, ty: pos[3] as number },
        { x: pos[4] as number, y: pos[5] as number, tx: pos[6] as number, ty: pos[7] as number },
      ],
      puck: { x: px, y: py, vx: pvx, vy: pvy },
      scores: [s0, s1],
      winnerIndex,
      serveAt: unq(asInt(m.v, 'airHockey.serveAt', 0, 1_000_000_000)),
    };
  },

  encodeAction(action): CborValue {
    // Whole table units are plenty for a fingertip and keep the packet tiny;
    // rounding here is what makes encode -> decode -> encode stable.
    return encodeActionEnvelope({
      ...action,
      payload: { x: Math.round(action.payload.x), y: Math.round(action.payload.y) },
    });
  },

  decodeAction(value, player): AirHockeyAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'aim') throw new GameDecodeError(`airHockey: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'airHockey.payload');
    return {
      type: 'aim',
      player,
      seq: envelope.seq,
      // Generously bounded rather than table-bounded: a drag that runs off the
      // edge is normal, absurd coordinates are not. The reducer clamps either way.
      payload: {
        x: asInt(payload.x, 'aim.x', -5000, 5000),
        y: asInt(payload.y, 'aim.y', -5000, 5000),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Rendering helpers - never used by the simulation
// ---------------------------------------------------------------------------

export interface AirHockeyMalletView {
  readonly index: number;
  readonly player: PlayerId;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly half: 'top' | 'bottom';
}

export interface AirHockeyView {
  readonly width: number;
  readonly height: number;
  readonly centerY: number;
  readonly goal: { readonly minX: number; readonly maxX: number };
  readonly puck: { readonly x: number; readonly y: number; readonly radius: number };
  readonly mallets: readonly [AirHockeyMalletView, AirHockeyMalletView];
  readonly scores: readonly [number, number];
  readonly winner: PlayerId | null;
  /** Milliseconds left on the face-off clock; 0 once the puck is live. */
  readonly countdownMs: number;
  readonly live: boolean;
}

/** Flatten a state into pure geometry for the UI layer. */
export function airHockeyView(state: AirHockeyState, elapsedMs: number): AirHockeyView {
  const remaining = state.serveAt - elapsedMs;
  const countdownMs = remaining > 0 ? Math.ceil(remaining) : 0;
  const mallet = (index: 0 | 1): AirHockeyMalletView => ({
    index,
    player: state.players[index],
    x: state.mallets[index].x,
    y: state.mallets[index].y,
    radius: MR,
    half: index === 0 ? 'bottom' : 'top',
  });
  return {
    width: W,
    height: H,
    centerY: CY,
    goal: { minX: AIR_HOCKEY.GOAL_MIN_X, maxX: AIR_HOCKEY.GOAL_MAX_X },
    puck: { x: state.puck.x, y: state.puck.y, radius: PR },
    mallets: [mallet(0), mallet(1)],
    scores: state.scores,
    winner: state.winnerIndex >= 0 ? state.players[state.winnerIndex === 0 ? 0 : 1] : null,
    countdownMs,
    live: countdownMs === 0 && state.winnerIndex < 0,
  };
}

/**
 * Blend two snapshots for SnapshotInterpolator. Render-only: it is deliberately
 * NOT rounded and never feeds back into the simulation, so it cannot desync
 * anything. A goal between the two snapshots snaps rather than interpolating,
 * because sliding the puck back from the goal mouth to the centre spot would
 * look like a bug.
 */
export function lerpAirHockey(from: AirHockeyState, to: AirHockeyState, t: number): AirHockeyState {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  if (from.scores[0] !== to.scores[0] || from.scores[1] !== to.scores[1]) return to;
  const mix = (a: number, b: number): number => a + (b - a) * k;
  const mallet = (index: 0 | 1): MalletState => ({
    x: mix(from.mallets[index].x, to.mallets[index].x),
    y: mix(from.mallets[index].y, to.mallets[index].y),
    tx: to.mallets[index].tx,
    ty: to.mallets[index].ty,
  });
  return {
    players: to.players,
    mallets: [mallet(0), mallet(1)],
    puck: {
      x: mix(from.puck.x, to.puck.x),
      y: mix(from.puck.y, to.puck.y),
      vx: mix(from.puck.vx, to.puck.vx),
      vy: mix(from.puck.vy, to.puck.vy),
    },
    scores: to.scores,
    winnerIndex: to.winnerIndex,
    serveAt: to.serveAt,
  };
}
