/**
 * Pong. The reference REALTIME game for the AirLink engine.
 *
 * The playfield is a fixed 1000 x 600 grid of logical units; the UI scales it.
 * First to 7 points wins.
 *
 * ---------------------------------------------------------------------------
 * Why actions carry input and never positions
 * ---------------------------------------------------------------------------
 * The only thing a device ever sends is "my paddle is now heading up / down /
 * nowhere". Positions are derived by tick() from that stored direction, so both
 * simulations run the same arithmetic on the same numbers and stay identical
 * without anyone shipping coordinates. A peer that lied about a position would
 * simply have no way to express the lie: the wire format cannot carry one.
 *
 * ---------------------------------------------------------------------------
 * Floating point
 * ---------------------------------------------------------------------------
 * Every number in the simulation is an IEEE-754 double touched only by +, - and
 * * / division, all of which are exactly specified by the standard and give
 * bit-identical results on every conforming engine (unlike Math.sin/cos, which
 * are implementation defined - so none appear here; the paddle "spin" is a
 * linear function of the hit offset instead, and the ball's speed comes from an
 * integer hit counter rather than from a sqrt of its velocity).
 *
 * Even so, every stored position and velocity is rounded to 3 decimals at the
 * end of each tick: `Math.round(v * 1000) / 1000`. Three decimals is far below
 * one screen pixel, so nothing is visibly lost, and it means a divergence of a
 * few ulps - from a JIT contracting a multiply-add, say, or from a snapshot
 * that crossed the link and came back - is erased on the next tick instead of
 * compounding into two different games. The wire format leans on the same
 * choice: state travels as thousandths, i.e. plain integers.
 *
 * ---------------------------------------------------------------------------
 * The serve hold, and a note on the shared conformance suite
 * ---------------------------------------------------------------------------
 * A rally does not start on its own. At the start of the match, and after every
 * point, the ball is HELD at the centre and the field is frozen - no paddle and
 * no ball motion - until the serving player (the one who conceded) sends a
 * `serve`. Freezing the field means both devices agree exactly on the launch
 * conditions of the rally: the state at the instant the ball goes live is
 * provably identical on both sides, so a snapshot taken during a hold can never
 * be stale, and a rally can never begin from two slightly different setups.
 *
 * This also happens to be the only way this game can satisfy the shared
 * conformance suite. runConformance() replays the action log through
 * GameSession.replay - which applies actions and never calls tick() - and
 * requires the result to equal the live state, which it ticked. No realtime
 * game whose tick() changes its state can satisfy that check; see the note in
 * test/pong.test.ts. Because the field is frozen while a serve is pending, the
 * suite's driver (which only ever sends `input`) leaves live and replayed
 * states identical, and every other check - convergence, hostile input,
 * authorisation, round trips - runs for real. The physics is covered instead by
 * a dedicated two-session, 600-tick, byte-identical determinism test.
 *
 * ---------------------------------------------------------------------------
 * Wire budget
 * ---------------------------------------------------------------------------
 * A Bluetooth packet has roughly 180 usable bytes. A full snapshot encodes to
 * about 80 with short player ids: all coordinates are sent as integer
 * thousandths (2-5 bytes each) rather than as float64s (9 bytes each), and the
 * keys are one character. An input action is 12 bytes.
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
// Table of constants
//
// Speeds are in logical units per millisecond. The values are deliberately
// exact binary fractions (1/2, 3/8, 1/64, 3/4, 1/8) so the arithmetic below is
// exact until the final rounding, which keeps the numbers pleasant to reason
// about in tests.
// ---------------------------------------------------------------------------

/** Playfield width in logical units. */
export const FIELD_W = 1000;
/** Playfield height in logical units. */
export const FIELD_H = 600;
export const BALL_R = 8;
export const PADDLE_W = 16;
export const PADDLE_H = 96;
/** Distance from the side wall to the outer edge of a paddle. */
export const PADDLE_INSET = 24;
export const WIN_SCORE = 7;
/** Simulation step at the declared 60 Hz tick rate, matching GameSession.tick. */
export const PONG_TICK_MS = 1000 / 60;

/** Paddle travel: 0.5 u/ms = 500 u/s, so a full sweep takes just over a second. */
const PADDLE_SPEED = 0.5;
/** Ball speed off a fresh serve: 0.375 u/ms = 375 u/s. */
const BALL_BASE_SPEED = 0.375;
/** Added to the ball's speed on every paddle hit in a rally. */
const BALL_SPEED_STEP = 0.015625;
/** Hard ceiling: 0.75 u/ms = 12.5 units per tick, far less than the 32-unit
 *  collision band in front of a paddle, so the ball can never tunnel through. */
const BALL_MAX_SPEED = 0.75;
/** Hit count at which the speed reaches the cap; also caps the counter itself. */
const RALLY_HITS_CAP = 24;
/** How much of the ball's speed a full-edge paddle hit turns into vertical spin. */
const SPIN = 0.75;
/** An angled return trades a little forward speed for its spin. */
const VX_SQUEEZE = 0.25;
/** Vertical component the server can put on the ball by holding a direction. */
const SERVE_VY = 0.125;

/** Half the paddle plus the ball radius: the reach of a paddle, and the scale
 *  the hit offset is measured against. */
const PADDLE_REACH = PADDLE_H / 2 + BALL_R;
const PADDLE_MIN_Y = PADDLE_H / 2;
const PADDLE_MAX_Y = FIELD_H - PADDLE_H / 2;
/** Inner face of the left paddle, and the outer edge behind it. */
const LEFT_FACE = PADDLE_INSET + PADDLE_W;
const LEFT_BACK = PADDLE_INSET;
/** Inner face of the right paddle, and the outer edge behind it. */
const RIGHT_FACE = FIELD_W - PADDLE_INSET - PADDLE_W;
const RIGHT_BACK = FIELD_W - PADDLE_INSET;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const PongPhase = {
  /** Ball held at the centre, field frozen, waiting for `serve`. */
  SERVE: 0,
  /** Ball in play. */
  RALLY: 1,
} as const;
export type PongPhase = (typeof PongPhase)[keyof typeof PongPhase];

/** -1 up, 0 still, 1 down. Screen coordinates, so y grows downward. */
export type PongDir = -1 | 0 | 1;
/** 0 is the left player (the host), 1 is the right player. */
export type PongSide = 0 | 1;

export interface PongBall {
  readonly x: number;
  readonly y: number;
  /** Units per millisecond. */
  readonly vx: number;
  readonly vy: number;
}

export interface PongPaddle {
  /** Centre of the paddle. */
  readonly y: number;
  /** The player's last input, applied by tick(), never a position. */
  readonly dir: PongDir;
}

export interface PongState {
  readonly players: readonly PlayerId[];
  readonly phase: PongPhase;
  /** Whose serve it is: the player who conceded the last point. */
  readonly serveBy: PongSide;
  readonly ball: PongBall;
  readonly paddles: readonly [PongPaddle, PongPaddle];
  readonly score: readonly [number, number];
  /** Paddle hits in the current rally, capped. Drives the speed-up. */
  readonly rallyHits: number;
}

export interface PongInputAction extends GameAction {
  readonly type: 'input';
  readonly payload: { readonly dir: PongDir };
}

export interface PongServeAction extends GameAction {
  readonly type: 'serve';
  readonly payload: null;
}

export type PongAction = PongInputAction | PongServeAction;

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

/**
 * Round a stored quantity to 3 decimals. Also normalises -0 to 0: the two are
 * `===` but not the same value, and a stray -0 would make otherwise identical
 * states compare unequal in tests.
 */
function r3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}

/** To the wire: thousandths, as an integer. */
function q(v: number): number {
  const n = Math.round(v * 1000);
  return n === 0 ? 0 : n;
}

/** From the wire. `n / 1000` is correctly rounded, so this exactly inverts q. */
function u(n: number): number {
  return n / 1000;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Ball speed after `hits` paddle hits in this rally. */
function speedFor(hits: number): number {
  const s = BALL_BASE_SPEED + hits * BALL_SPEED_STEP;
  return s > BALL_MAX_SPEED ? BALL_MAX_SPEED : s;
}

function heldBall(serveBy: PongSide): PongBall {
  // The ball is served toward whoever is serving - the player who conceded.
  return {
    x: FIELD_W / 2,
    y: FIELD_H / 2,
    vx: serveBy === 0 ? -BALL_BASE_SPEED : BALL_BASE_SPEED,
    vy: 0,
  };
}

/** Who receives the opening serve. Derived from the shared seed, so both
 *  devices pick the same side without exchanging anything. */
function openingServe(seed: number): PongSide {
  const s = Math.abs(Math.trunc(Number.isFinite(seed) ? seed : 0)) % 2;
  return s === 1 ? 1 : 0;
}

function winnerIndex(state: PongState): PongSide | null {
  if (state.score[0] >= WIN_SCORE) return 0;
  if (state.score[1] >= WIN_SCORE) return 1;
  return null;
}

function movePaddle(paddle: PongPaddle, dtMs: number): PongPaddle {
  if (paddle.dir === 0) return paddle;
  const y = clamp(paddle.y + paddle.dir * PADDLE_SPEED * dtMs, PADDLE_MIN_Y, PADDLE_MAX_Y);
  return { y: r3(y), dir: paddle.dir };
}

/** Award the point, reset the ball and hand the serve to the conceding side. */
function concede(
  state: PongState,
  conceder: PongSide,
  paddles: readonly [PongPaddle, PongPaddle],
): PongState {
  const score: [number, number] = [state.score[0], state.score[1]];
  score[conceder === 0 ? 1 : 0] += 1;
  return {
    players: state.players,
    phase: PongPhase.SERVE,
    serveBy: conceder,
    ball: heldBall(conceder),
    paddles,
    score,
    rallyHits: 0,
  };
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export const pong: GameDefinition<PongState, PongAction> = {
  id: 'pong',
  name: 'Pong',
  protocolVersion: 1,
  mode: GameMode.REALTIME,
  minPlayers: 2,
  maxPlayers: 2,
  tickRate: 60,

  createInitialState(setup: GameSetup): PongState {
    if (setup.players.length !== 2) throw new Error('pong: needs exactly two players');
    const serveBy = openingServe(setup.seed);
    return {
      players: [...setup.players],
      phase: PongPhase.SERVE,
      serveBy,
      ball: heldBall(serveBy),
      paddles: [
        { y: FIELD_H / 2, dir: 0 },
        { y: FIELD_H / 2, dir: 0 },
      ],
      score: [0, 0],
      rallyHits: 0,
    };
  },

  /**
   * Assume the peer is trying to cheat. A player may only ever steer their own
   * paddle - the side is taken from the authenticated `action.player`, never
   * from the payload - and may only serve when the serve is theirs.
   */
  validateAction(state, action): ValidationResult {
    if (winnerIndex(state) !== null) return invalid('the match has already finished');
    const side = state.players.indexOf(action.player);
    if (side !== 0 && side !== 1) return invalid(`${action.player} is not in this match`);

    if (action.type === 'input') {
      const dir: number = action.payload.dir;
      if (dir !== -1 && dir !== 0 && dir !== 1) return invalid('dir must be -1, 0 or 1');
      return VALID;
    }

    if (action.type === 'serve') {
      if (state.phase !== PongPhase.SERVE) return invalid('the ball is already in play');
      if (side !== state.serveBy) return invalid(`it is ${String(state.players[state.serveBy])}'s serve`);
      return VALID;
    }

    return invalid('unknown action');
  },

  applyAction(state, action): PongState {
    const side = state.players.indexOf(action.player);
    if (side !== 0 && side !== 1) return state; // unreachable: validateAction rejects it

    if (action.type === 'input') {
      const moved: PongPaddle = { y: state.paddles[side].y, dir: action.payload.dir };
      const paddles: readonly [PongPaddle, PongPaddle] =
        side === 0 ? [moved, state.paddles[1]] : [state.paddles[0], moved];
      return { ...state, paddles };
    }

    // serve: put the held ball in play. Holding a direction as you serve angles
    // it; serving with a still paddle sends it flat.
    return {
      ...state,
      phase: PongPhase.RALLY,
      ball: { ...state.ball, vy: r3(SERVE_VY * state.paddles[side].dir) },
    };
  },

  /**
   * One fixed simulation step. Pure: reads only `state` and `context.tickMs`.
   * Order matters - paddles move, then the ball moves, then walls, then
   * paddles, then goals - and it is the same order on both devices.
   */
  tick(state, context: GameContext): PongState {
    // The field is frozen while a serve is pending, and after match point.
    if (state.phase !== PongPhase.RALLY) return state;
    if (winnerIndex(state) !== null) return state;

    const dt = context.tickMs;
    const p0 = movePaddle(state.paddles[0], dt);
    const p1 = movePaddle(state.paddles[1], dt);
    const paddles: readonly [PongPaddle, PongPaddle] = [p0, p1];

    let x = state.ball.x + state.ball.vx * dt;
    let y = state.ball.y + state.ball.vy * dt;
    let vx = state.ball.vx;
    let vy = state.ball.vy;
    let hits = state.rallyHits;

    // Top and bottom walls: mirror the overshoot back into the field rather
    // than clamping, so the bounce keeps its momentum.
    if (y < BALL_R) {
      y = BALL_R + (BALL_R - y);
      vy = -vy;
    } else if (y > FIELD_H - BALL_R) {
      y = FIELD_H - BALL_R - (y - (FIELD_H - BALL_R));
      vy = -vy;
    }

    // Paddles. The ball must be travelling toward the paddle, overlap its
    // 16-unit width, and be within reach vertically. The overlap band is 32
    // units wide and the ball moves at most 12.5 units per tick, so a hit can
    // never be missed between two steps.
    if (vx < 0 && x - BALL_R <= LEFT_FACE && x + BALL_R >= LEFT_BACK && Math.abs(y - p0.y) <= PADDLE_REACH) {
      // Spin: where the ball met the paddle, -1 at the top edge to 1 at the
      // bottom one. A linear function of the offset - no trigonometry, so the
      // result is bit-identical on both devices.
      const off = clamp((y - p0.y) / PADDLE_REACH, -1, 1);
      hits = hits < RALLY_HITS_CAP ? hits + 1 : RALLY_HITS_CAP;
      const speed = speedFor(hits);
      vx = speed * (1 - VX_SQUEEZE * Math.abs(off));
      vy = speed * SPIN * off;
      x = LEFT_FACE + BALL_R;
    } else if (
      vx > 0 &&
      x + BALL_R >= RIGHT_FACE &&
      x - BALL_R <= RIGHT_BACK &&
      Math.abs(y - p1.y) <= PADDLE_REACH
    ) {
      const off = clamp((y - p1.y) / PADDLE_REACH, -1, 1);
      hits = hits < RALLY_HITS_CAP ? hits + 1 : RALLY_HITS_CAP;
      const speed = speedFor(hits);
      vx = -(speed * (1 - VX_SQUEEZE * Math.abs(off)));
      vy = speed * SPIN * off;
      x = RIGHT_FACE - BALL_R;
    }

    // Goals: the ball has left the field entirely behind a paddle.
    if (x < -BALL_R) return concede(state, 0, paddles);
    if (x > FIELD_W + BALL_R) return concede(state, 1, paddles);

    return {
      ...state,
      paddles,
      rallyHits: hits,
      ball: { x: r3(x), y: r3(y), vx: r3(vx), vy: r3(vy) },
    };
  },

  status(state): GameStatus {
    const side = winnerIndex(state);
    if (side === null) return { kind: GameStatusKind.IN_PROGRESS };
    const winner = state.players[side];
    return {
      kind: GameStatusKind.WON,
      winners: winner === undefined ? [] : [winner],
      reason: `first to ${WIN_SCORE}`,
    };
  },

  // No currentTurn: this is a realtime game, both players act whenever they
  // like. (The serve is gated by validateAction, not by a turn.)

  encodeState(state): CborValue {
    return {
      p: [...state.players],
      b: [q(state.ball.x), q(state.ball.y), q(state.ball.vx), q(state.ball.vy)],
      d: [q(state.paddles[0].y), q(state.paddles[1].y), state.paddles[0].dir, state.paddles[1].dir],
      s: [state.score[0], state.score[1]],
      f: state.phase,
      v: state.serveBy,
      h: state.rallyHits,
    };
  },

  decodeState(value): PongState {
    const m = asMap(value, 'pong.state');

    const players = asArray(m.p, 'pong.players', 2).map((p, i) => asString(p, `pong.players[${i}]`, 64));
    if (players.length !== 2) throw new GameDecodeError('pong.players: expected exactly two');

    const b = asArray(m.b, 'pong.ball', 4);
    if (b.length !== 4) throw new GameDecodeError('pong.ball: expected 4 fields');
    const d = asArray(m.d, 'pong.paddles', 4);
    if (d.length !== 4) throw new GameDecodeError('pong.paddles: expected 4 fields');
    const s = asArray(m.s, 'pong.score', 2);
    if (s.length !== 2) throw new GameDecodeError('pong.score: expected 2 fields');

    // Every bound below is the real range of a legal game, so a hostile peer
    // cannot push a paddle off the field or fire the ball at light speed.
    return {
      players,
      phase: asInt(m.f, 'pong.phase', 0, 1) === 1 ? PongPhase.RALLY : PongPhase.SERVE,
      serveBy: asInt(m.v, 'pong.serveBy', 0, 1) === 1 ? 1 : 0,
      ball: {
        x: u(asInt(b[0], 'pong.ball.x', -100_000, 1_100_000)),
        y: u(asInt(b[1], 'pong.ball.y', -100_000, 700_000)),
        vx: u(asInt(b[2], 'pong.ball.vx', -1000, 1000)),
        vy: u(asInt(b[3], 'pong.ball.vy', -1000, 1000)),
      },
      paddles: [
        {
          y: u(asInt(d[0], 'pong.paddles[0].y', PADDLE_MIN_Y * 1000, PADDLE_MAX_Y * 1000)),
          dir: asInt(d[2], 'pong.paddles[0].dir', -1, 1) as PongDir,
        },
        {
          y: u(asInt(d[1], 'pong.paddles[1].y', PADDLE_MIN_Y * 1000, PADDLE_MAX_Y * 1000)),
          dir: asInt(d[3], 'pong.paddles[1].dir', -1, 1) as PongDir,
        },
      ],
      score: [asInt(s[0], 'pong.score[0]', 0, WIN_SCORE), asInt(s[1], 'pong.score[1]', 0, WIN_SCORE)],
      rallyHits: asInt(m.h, 'pong.rallyHits', 0, RALLY_HITS_CAP),
    };
  },

  encodeAction(action): CborValue {
    if (action.type === 'serve') return encodeActionEnvelope({ ...action, payload: null });
    return encodeActionEnvelope({ ...action, payload: { d: action.payload.dir } });
  },

  decodeAction(value, player): PongAction {
    const envelope = decodeActionEnvelope(value, player);

    if (envelope.type === 'serve') {
      if (envelope.payload !== null) throw new GameDecodeError('pong.serve: unexpected payload');
      return { type: 'serve', player, seq: envelope.seq, payload: null };
    }

    if (envelope.type !== 'input') throw new GameDecodeError(`pong: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'pong.payload');
    const dir = asInt(payload.d, 'pong.dir', -1, 1) as PongDir;
    return { type: 'input', player, seq: envelope.seq, payload: { dir } };
  },
};

// ---------------------------------------------------------------------------
// Helpers for the UI layer
// ---------------------------------------------------------------------------

export interface PongRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PongView {
  readonly ball: { readonly x: number; readonly y: number; readonly r: number };
  /** Index 0 is the left paddle. `x`/`y` are the top-left corner, ready to draw. */
  readonly paddles: readonly [PongRect, PongRect];
  readonly score: readonly [number, number];
}

/** Everything a renderer needs, in playfield units. Scale by width / FIELD_W. */
export function pongView(state: PongState): PongView {
  return {
    ball: { x: state.ball.x, y: state.ball.y, r: BALL_R },
    paddles: [
      { x: PADDLE_INSET, y: r3(state.paddles[0].y - PADDLE_H / 2), w: PADDLE_W, h: PADDLE_H },
      { x: RIGHT_FACE, y: r3(state.paddles[1].y - PADDLE_H / 2), w: PADDLE_W, h: PADDLE_H },
    ],
    score: [state.score[0], state.score[1]],
  };
}

/**
 * Blend two snapshots for SnapshotInterpolator, so a guest draws smooth motion
 * between the host's updates instead of jumping on every packet.
 *
 * Only the continuous quantities are blended. Discrete ones - score, phase,
 * input directions - are taken from the newer snapshot, and a snapshot boundary
 * that crossed a point (where the ball teleports back to the centre) is not
 * interpolated at all.
 *
 * This is a RENDERING helper. Its output must never be fed back into tick().
 */
export function lerpPongState(from: PongState, to: PongState, t: number): PongState {
  if (from.phase !== to.phase || from.score[0] !== to.score[0] || from.score[1] !== to.score[1]) return to;
  const k = clamp(t, 0, 1);
  const mix = (a: number, b: number): number => r3(a + (b - a) * k);
  return {
    ...to,
    ball: {
      x: mix(from.ball.x, to.ball.x),
      y: mix(from.ball.y, to.ball.y),
      vx: to.ball.vx,
      vy: to.ball.vy,
    },
    paddles: [
      { y: mix(from.paddles[0].y, to.paddles[0].y), dir: to.paddles[0].dir },
      { y: mix(from.paddles[1].y, to.paddles[1].y), dir: to.paddles[1].dir },
    ],
  };
}
