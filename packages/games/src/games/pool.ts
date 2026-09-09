/**
 * 8-Ball pool - the physics-driven member of the AirLink game set.
 *
 * A 1000 x 500 table, six pockets, a cue ball and fifteen object balls. Players
 * alternate shots; a shot is a single action carrying an angle and a power, and
 * the simulation runs until every ball has stopped before the turn resolves.
 *
 * This is by far the most numerically delicate game we ship, so the five design
 * decisions that make it safe over a link with no server are spelled out here.
 *
 * 1. FIXED TIMESTEP. Every integration step is exactly `DT` seconds, split into
 *    `SUBSTEPS` sub-steps. We deliberately do NOT scale by `context.tickMs`: the
 *    runtime already drives realtime games with a fixed timestep of
 *    1000 / tickRate ms (which divides to exactly DT), and a variable step would
 *    make two devices integrate different trajectories from the same shot.
 *
 * 2. ROUNDING. At the end of every tick each stored position and velocity is
 *    rounded to 3 decimals (`r3`). Floating point on two different phones can
 *    disagree in the last bit or two of a long expression; snapping the stored
 *    state to a millimetre grid every tick means such a disagreement is thrown
 *    away instead of being amplified by the next collision. Rounding also makes
 *    the wire form exact: the state travels as integer thousandths.
 *
 * 3. FIXED COLLISION ORDER. Ball-ball collisions are resolved in ascending index
 *    order (pair (i, j) with i < j, i outermost). Collision response is order
 *    dependent inside a cluster - resolving (3,7) before (2,3) gives a different
 *    outcome - so a fixed, index-based order is what guarantees two devices
 *    process the same rack identically. Never sort by distance or by "time of
 *    impact"; those orders depend on floating-point comparisons.
 *
 * 4. NO ENGINE-DEPENDENT MATH IN THE STATE. `Math.sin`, `Math.cos` and friends
 *    are only approximated to implementation-defined precision by the ECMAScript
 *    spec, so two JavaScript engines may legally disagree in the last bit. The
 *    collision response is therefore written in terms of d^2 (no square root at
 *    all - see `stepOnce`), and the shot direction comes from `poolSin`/`poolCos`,
 *    small polynomials built from +, -, * and / only. Every operation that feeds
 *    the state is exactly specified by IEEE-754.
 *
 * 5. A SHOT RESOLVES INSIDE `applyAction`. The action log is the authoritative
 *    history: a peer that rejoins and replays the log must land on exactly the
 *    state a peer that watched every frame is holding. So `applyAction` runs the
 *    shot to rest with the very same step function `tick` uses, and stores the
 *    settled table. `tick` is still the real simulator - a UI animates a shot by
 *    calling `poolBeginShot` and then ticking, and because it is the identical
 *    code path it lands exactly on the authoritative result. Normal play
 *    therefore puts about twenty bytes on the wire per shot (angle and power);
 *    the full snapshot is only needed when somebody rejoins.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  SeededGameRandom,
  VALID,
  asArray,
  asBool,
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
// Table geometry and physics constants
// ---------------------------------------------------------------------------

export const TABLE_WIDTH = 1000;
export const TABLE_HEIGHT = 500;
export const BALL_RADIUS = 10;
export const POCKET_RADIUS = 22;

/** Four corners plus the two middles of the long rails. */
export const POCKETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [500, 0],
  [1000, 0],
  [0, 500],
  [500, 500],
  [1000, 500],
];

export const CUE_BALL = 0;
export const EIGHT_BALL = 8;
export const BALL_COUNT = 16;

/** Where the cue ball is spotted at the break and after a foul. */
export const HEAD_SPOT_X = 250;
export const HEAD_SPOT_Y = 250;

const TICK_RATE = 60;
/** Seconds per tick. Equal to (1000 / TICK_RATE) / 1000 exactly. */
const DT = 1 / TICK_RATE;
/** Sub-steps per tick. Caps travel at MAX_SHOT_SPEED / (TICK_RATE * SUBSTEPS) = 6.67px, well under a ball diameter, so nothing tunnels. */
const SUBSTEPS = 4;
const SUB_DT = DT / SUBSTEPS;

/**
 * Rolling friction as an exponential decay per sub-step. Real rolling friction
 * is a constant deceleration, which needs |v| - and therefore a square root - on
 * every ball on every step. Exponential decay is a multiply, it is exactly
 * reproducible, and with the stop threshold below it looks the same on screen.
 */
const DRAG_PER_SEC = 1.6;
const DAMPING = 1 - DRAG_PER_SEC * SUB_DT;
/** Below this speed (px/s) a ball is simply stopped, so shots terminate. */
const STOP_SPEED_SQ = 36;
/** Cushions give a little energy back to the table. */
const CUSHION_RESTITUTION = 0.92;
/** Speed of a full-power shot, px/s. */
const MAX_SHOT_SPEED = 1600;
const MIN_POWER = 0.05;

const CONTACT_DIST_SQ = (2 * BALL_RADIUS) * (2 * BALL_RADIUS);
const POCKET_DIST_SQ = POCKET_RADIUS * POCKET_RADIUS;
/** Hard cap on a single shot (30 simulated seconds). Drag alone stops a shot in about 3.5s. */
const MAX_SHOT_STEPS = 1800;

const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
/** Largest angle the wire form can carry: milliradians, 0..6283. */
const MAX_ANGLE_MILLI = 6283;

export const PoolGroup = {
  /** Table still open - nobody owns solids or stripes yet. */
  NONE: 0,
  SOLIDS: 1,
  STRIPES: 2,
} as const;
export type PoolGroup = (typeof PoolGroup)[keyof typeof PoolGroup];

export const PoolEnding = {
  NONE: 0,
  /** Potted the 8-ball with the group cleared and no foul. */
  EIGHT_LEGAL: 1,
  /** Potted the 8-ball before clearing the group. */
  EIGHT_EARLY: 2,
  /** Potted the 8-ball on a foul (scratch or wrong first contact). */
  EIGHT_FOUL: 3,
} as const;
export type PoolEnding = (typeof PoolEnding)[keyof typeof PoolEnding];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface PoolBall {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly potted: boolean;
}

export interface PoolState {
  /** 16 balls: 0 cue, 1-7 solids, 8 the eight, 9-15 stripes. Index === ball number. */
  readonly balls: readonly PoolBall[];
  readonly players: readonly PlayerId[];
  /** Index into `players` of whoever is at the table. */
  readonly turnIndex: number;
  /** Group per player; PoolGroup.NONE on both until the table is assigned. */
  readonly groups: readonly number[];
  /** True while a shot is in flight. */
  readonly shooting: boolean;
  /** First object ball the cue ball touched this shot, or -1 for no contact. */
  readonly firstHit: number;
  /** Ball indices potted during the shot in flight, in the order they dropped. */
  readonly pottedThisShot: readonly number[];
  /** The incoming player was given ball in hand (the cue ball was re-spotted). */
  readonly ballInHand: boolean;
  /** The break has been taken. */
  readonly broken: boolean;
  /** Index into `players` of the winner, or -1. */
  readonly winner: number;
  readonly ending: number;
  readonly shots: number;
}

export interface PoolAction extends GameAction {
  readonly type: 'shoot';
  readonly payload: {
    /** Radians, 0..2pi, measured from +x with +y pointing down the screen. */
    readonly angle: number;
    /** 0..1 of MAX_SHOT_SPEED. */
    readonly power: number;
  };
}

// ---------------------------------------------------------------------------
// Deterministic scalar helpers
// ---------------------------------------------------------------------------

/**
 * Round to 3 decimals. `Math.round` is exactly specified by the language (unlike
 * the transcendental functions), so this is the same value on every engine. The
 * `|| 0` folds -0 into 0 so the encoded form never depends on a sign bit.
 */
function r3(v: number): number {
  return Math.round(v * 1000) / 1000 || 0;
}

/** Milliunits, the integer wire form of a rounded coordinate. */
function toMilli(v: number): number {
  return Math.round(v * 1000);
}

/**
 * sin/cos for |x| <= pi/4 by Taylor series. Accurate to ~1e-11 over that
 * interval, which is nine orders of magnitude finer than the millimetre grid the
 * state is rounded to, and - unlike Math.sin - built only from operations IEEE-754
 * specifies exactly, so two devices cannot disagree about where a shot went.
 */
function sinKernel(x: number): number {
  const x2 = x * x;
  return (
    x *
    (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 - x2 / 39916800)))))
  );
}

function cosKernel(x: number): number {
  const x2 = x * x;
  return 1 + x2 * (-0.5 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 - x2 / 3628800))));
}

/** Reduce to a quadrant index and a remainder in [-pi/4, pi/4]. */
function reduce(angle: number): { q: number; r: number } {
  const k = Math.round(angle / HALF_PI);
  return { q: ((k % 4) + 4) % 4, r: angle - k * HALF_PI };
}

/** Deterministic sine. Exported so the physics can be checked against Math.sin in tests. */
export function poolSin(angle: number): number {
  const { q, r } = reduce(angle);
  if (q === 0) return sinKernel(r);
  if (q === 1) return cosKernel(r);
  if (q === 2) return -sinKernel(r);
  return -cosKernel(r);
}

/** Deterministic cosine. */
export function poolCos(angle: number): number {
  const { q, r } = reduce(angle);
  if (q === 0) return cosKernel(r);
  if (q === 1) return -sinKernel(r);
  if (q === 2) return -cosKernel(r);
  return sinKernel(r);
}

// ---------------------------------------------------------------------------
// Ball classification
// ---------------------------------------------------------------------------

export function isSolid(index: number): boolean {
  return index >= 1 && index <= 7;
}

export function isStripe(index: number): boolean {
  return index >= 9 && index <= 15;
}

/** The group a ball belongs to; the cue ball and the 8-ball belong to neither. */
export function ballGroup(index: number): number {
  if (isSolid(index)) return PoolGroup.SOLIDS;
  if (isStripe(index)) return PoolGroup.STRIPES;
  return PoolGroup.NONE;
}

function groupBalls(group: number): readonly number[] {
  if (group === PoolGroup.SOLIDS) return [1, 2, 3, 4, 5, 6, 7];
  if (group === PoolGroup.STRIPES) return [9, 10, 11, 12, 13, 14, 15];
  return [];
}

function otherGroup(group: number): number {
  return group === PoolGroup.SOLIDS ? PoolGroup.STRIPES : PoolGroup.SOLIDS;
}

function ballAt(state: PoolState, index: number): PoolBall {
  return state.balls[index] as PoolBall;
}

export function anyBallMoving(state: PoolState): boolean {
  for (const b of state.balls) {
    if (!b.potted && (b.vx !== 0 || b.vy !== 0)) return true;
  }
  return false;
}

/** How many of a group are still on the table. */
export function remainingInGroup(state: PoolState, group: number): number {
  let n = 0;
  for (const i of groupBalls(group)) if (!ballAt(state, i).potted) n++;
  return n;
}

// ---------------------------------------------------------------------------
// The rack
// ---------------------------------------------------------------------------

/** Column spacing and in-row spacing of the triangle; a hair over a diameter so nothing starts overlapping. */
const RACK_DX = 17.4;
const RACK_DY = 20.4;
const RACK_APEX_X = 750;
const RACK_APEX_Y = 250;

/**
 * Group layout of the rack, row by row from the apex: the 8-ball sits in the
 * middle of the third row and the back corners are one solid and one stripe,
 * exactly as a real rack must be. Which numbered ball fills each slot is
 * shuffled from the shared seed, so both devices rack identically.
 */
const RACK_TEMPLATE: readonly (readonly number[])[] = [
  [PoolGroup.SOLIDS],
  [PoolGroup.STRIPES, PoolGroup.SOLIDS],
  [PoolGroup.SOLIDS, -1, PoolGroup.STRIPES],
  [PoolGroup.STRIPES, PoolGroup.SOLIDS, PoolGroup.STRIPES, PoolGroup.SOLIDS],
  [PoolGroup.SOLIDS, PoolGroup.STRIPES, PoolGroup.SOLIDS, PoolGroup.STRIPES, PoolGroup.STRIPES],
];

function rack(seed: number): PoolBall[] {
  const random = new SeededGameRandom(seed);
  const solids = random.shuffle([1, 2, 3, 4, 5, 6, 7]);
  const stripes = random.shuffle([9, 10, 11, 12, 13, 14, 15]);
  const balls: PoolBall[] = new Array<PoolBall>(BALL_COUNT);
  balls[CUE_BALL] = { x: HEAD_SPOT_X, y: HEAD_SPOT_Y, vx: 0, vy: 0, potted: false };
  let s = 0;
  let t = 0;
  for (let row = 0; row < RACK_TEMPLATE.length; row++) {
    const slots = RACK_TEMPLATE[row] as readonly number[];
    const x = r3(RACK_APEX_X + row * RACK_DX);
    for (let m = 0; m < slots.length; m++) {
      const slot = slots[m] as number;
      const index =
        slot === -1 ? EIGHT_BALL : slot === PoolGroup.SOLIDS ? (solids[s++] as number) : (stripes[t++] as number);
      const y = r3(RACK_APEX_Y - row * (RACK_DY / 2) + m * RACK_DY);
      balls[index] = { x, y, vx: 0, vy: 0, potted: false };
    }
  }
  return balls;
}

/**
 * Ball in hand. The wire action carries only an angle and a power, so rather
 * than adding a placement action we express ball in hand as an automatic re-spot
 * of the cue ball: the head spot when it is clear, otherwise the nearest free
 * point on a fixed, deterministic search pattern around it.
 */
function respotCue(balls: readonly PoolBall[]): PoolBall {
  const candidates: [number, number][] = [[HEAD_SPOT_X, HEAD_SPOT_Y]];
  for (let d = 24; d <= 240; d += 24) {
    candidates.push([HEAD_SPOT_X, HEAD_SPOT_Y - d]);
    candidates.push([HEAD_SPOT_X, HEAD_SPOT_Y + d]);
    candidates.push([HEAD_SPOT_X - d, HEAD_SPOT_Y]);
    candidates.push([HEAD_SPOT_X + d, HEAD_SPOT_Y]);
  }
  const clearance = (2 * BALL_RADIUS + 2) * (2 * BALL_RADIUS + 2);
  for (const [cx, cy] of candidates) {
    if (cx < BALL_RADIUS || cx > TABLE_WIDTH - BALL_RADIUS) continue;
    if (cy < BALL_RADIUS || cy > TABLE_HEIGHT - BALL_RADIUS) continue;
    let free = true;
    for (let i = 1; i < balls.length; i++) {
      const b = balls[i] as PoolBall;
      if (b.potted) continue;
      const dx = b.x - cx;
      const dy = b.y - cy;
      if (dx * dx + dy * dy < clearance) {
        free = false;
        break;
      }
    }
    if (free) return { x: cx, y: cy, vx: 0, vy: 0, potted: false };
  }
  return { x: HEAD_SPOT_X, y: HEAD_SPOT_Y, vx: 0, vy: 0, potted: false };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/**
 * Put the cue ball in motion. Exported because it is how a UI animates: begin
 * the shot, tick it frame by frame, and the last frame is byte-identical to the
 * state `applyAction` computed, because both run `stepOnce`.
 */
export function poolBeginShot(state: PoolState, angle: number, power: number): PoolState {
  const speed = power * MAX_SHOT_SPEED;
  const cue = ballAt(state, CUE_BALL);
  const balls = state.balls.map((b, i) =>
    i === CUE_BALL ? { ...cue, vx: r3(poolCos(angle) * speed), vy: r3(poolSin(angle) * speed) } : b,
  );
  return {
    ...state,
    balls,
    shooting: true,
    firstHit: -1,
    pottedThisShot: [],
    ballInHand: false,
  };
}

/**
 * One fixed simulation step. Pure: reads `state`, returns a new one.
 *
 * Order inside a sub-step is fixed and never data-dependent: integrate, damp,
 * cushions, pockets, then ball-ball collisions in ascending index order.
 */
function stepOnce(state: PoolState): PoolState {
  const n = state.balls.length;
  const x: number[] = new Array<number>(n);
  const y: number[] = new Array<number>(n);
  const vx: number[] = new Array<number>(n);
  const vy: number[] = new Array<number>(n);
  const gone: boolean[] = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const b = state.balls[i] as PoolBall;
    x[i] = b.x;
    y[i] = b.y;
    vx[i] = b.vx;
    vy[i] = b.vy;
    gone[i] = b.potted;
  }

  let firstHit = state.firstHit;
  const potted: number[] = [...state.pottedThisShot];

  for (let step = 0; step < SUBSTEPS; step++) {
    // -- integrate and damp ------------------------------------------------
    for (let i = 0; i < n; i++) {
      if (gone[i]) continue;
      const bvx = vx[i] as number;
      const bvy = vy[i] as number;
      if (bvx === 0 && bvy === 0) continue;
      x[i] = (x[i] as number) + bvx * SUB_DT;
      y[i] = (y[i] as number) + bvy * SUB_DT;
      const nvx = bvx * DAMPING;
      const nvy = bvy * DAMPING;
      if (nvx * nvx + nvy * nvy < STOP_SPEED_SQ) {
        vx[i] = 0;
        vy[i] = 0;
      } else {
        vx[i] = nvx;
        vy[i] = nvy;
      }
    }

    // -- cushions ----------------------------------------------------------
    for (let i = 0; i < n; i++) {
      if (gone[i]) continue;
      if ((x[i] as number) < BALL_RADIUS) {
        x[i] = BALL_RADIUS;
        vx[i] = -(vx[i] as number) * CUSHION_RESTITUTION;
      } else if ((x[i] as number) > TABLE_WIDTH - BALL_RADIUS) {
        x[i] = TABLE_WIDTH - BALL_RADIUS;
        vx[i] = -(vx[i] as number) * CUSHION_RESTITUTION;
      }
      if ((y[i] as number) < BALL_RADIUS) {
        y[i] = BALL_RADIUS;
        vy[i] = -(vy[i] as number) * CUSHION_RESTITUTION;
      } else if ((y[i] as number) > TABLE_HEIGHT - BALL_RADIUS) {
        y[i] = TABLE_HEIGHT - BALL_RADIUS;
        vy[i] = -(vy[i] as number) * CUSHION_RESTITUTION;
      }
    }

    // -- pockets: a ball whose centre enters a pocket drops -----------------
    for (let i = 0; i < n; i++) {
      if (gone[i]) continue;
      for (const pocket of POCKETS) {
        const dx = (x[i] as number) - (pocket[0] as number);
        const dy = (y[i] as number) - (pocket[1] as number);
        if (dx * dx + dy * dy <= POCKET_DIST_SQ) {
          gone[i] = true;
          vx[i] = 0;
          vy[i] = 0;
          // Park it on the pocket so the encoded position stays canonical.
          x[i] = pocket[0] as number;
          y[i] = pocket[1] as number;
          potted.push(i);
          break;
        }
      }
    }

    // -- ball-ball collisions, ascending index order -----------------------
    // Equal masses, perfectly elastic: swap the velocity components along the
    // collision normal. Written with d^2 rather than |d| so there is no square
    // root anywhere in the state update.
    for (let i = 0; i < n; i++) {
      if (gone[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (gone[j]) continue;
        const dx = (x[j] as number) - (x[i] as number);
        const dy = (y[j] as number) - (y[i] as number);
        const d2 = dx * dx + dy * dy;
        if (d2 >= CONTACT_DIST_SQ || d2 === 0) continue;
        const rvx = (vx[i] as number) - (vx[j] as number);
        const rvy = (vy[i] as number) - (vy[j] as number);
        const closing = rvx * dx + rvy * dy;
        // Only react when they are actually approaching, so a pair that is still
        // overlapping on the next sub-step is not bounced twice.
        if (closing <= 0) continue;
        const f = closing / d2;
        vx[i] = (vx[i] as number) - f * dx;
        vy[i] = (vy[i] as number) - f * dy;
        vx[j] = (vx[j] as number) + f * dx;
        vy[j] = (vy[j] as number) + f * dy;
        if (i === CUE_BALL && firstHit < 0) firstHit = j;
      }
    }
  }

  // -- snap the stored state onto the millimetre grid (see header note 2) ---
  const balls: PoolBall[] = new Array<PoolBall>(n);
  let moving = false;
  for (let i = 0; i < n; i++) {
    const bvx = r3(vx[i] as number);
    const bvy = r3(vy[i] as number);
    balls[i] = {
      x: r3(x[i] as number),
      y: r3(y[i] as number),
      vx: bvx,
      vy: bvy,
      potted: gone[i] === true,
    };
    if (gone[i] !== true && (bvx !== 0 || bvy !== 0)) moving = true;
  }

  const next: PoolState = { ...state, balls, firstHit, pottedThisShot: potted };
  return moving ? next : resolveShot(next);
}

/** Run an in-flight shot to rest. Bounded, so a pathological state cannot hang a device. */
function settle(state: PoolState): PoolState {
  let s = state;
  for (let i = 0; i < MAX_SHOT_STEPS && s.shooting; i++) s = stepOnce(s);
  if (!s.shooting) return s;
  // Safety net: freeze everything and resolve rather than simulate forever.
  const balls = s.balls.map((b) => ({ ...b, vx: 0, vy: 0 }));
  return resolveShot({ ...s, balls });
}

// ---------------------------------------------------------------------------
// Turn resolution - the actual rules of 8-ball
// ---------------------------------------------------------------------------

function resolveShot(state: PoolState): PoolState {
  const shooter = state.turnIndex;
  const opponent = 1 - shooter;
  const myGroup = state.groups[shooter] ?? PoolGroup.NONE;
  const dropped = state.pottedThisShot;
  const scratch = dropped.includes(CUE_BALL);
  const eightDown = dropped.includes(EIGHT_BALL);
  const objects = dropped.filter((i) => i !== CUE_BALL && i !== EIGHT_BALL);
  const isBreak = !state.broken;

  // Was the shooter already on the 8-ball when they took this shot? Balls potted
  // during this very shot do not count, so clearing your group and potting the
  // 8-ball in one shot loses.
  const onEight =
    myGroup !== PoolGroup.NONE &&
    groupBalls(myGroup).every((i) => ballAt(state, i).potted && !dropped.includes(i));

  let foul = false;
  if (scratch) foul = true;
  if (state.firstHit < 0) {
    foul = true; // the cue ball touched nothing
  } else if (onEight) {
    if (state.firstHit !== EIGHT_BALL) foul = true;
  } else if (myGroup === PoolGroup.NONE) {
    if (state.firstHit === EIGHT_BALL) foul = true; // the 8 is never a legal first contact on an open table
  } else if (ballGroup(state.firstHit) !== myGroup) {
    foul = true; // hit the wrong group first
  }
  // Potting nothing is a foul. The break is exempt: scattering the rack without
  // dropping a ball simply passes the table on.
  if (dropped.length === 0 && !isBreak) foul = true;

  const cleared: Omit<PoolState, 'turnIndex' | 'groups' | 'ballInHand' | 'winner' | 'ending' | 'balls'> = {
    players: state.players,
    shooting: false,
    firstHit: -1,
    pottedThisShot: [],
    broken: true,
    shots: state.shots + 1,
  };

  // -- the 8-ball ends the game either way ---------------------------------
  if (eightDown) {
    const won = onEight && !foul;
    const balls = state.balls.map((b) => ({ ...b, vx: 0, vy: 0 }));
    return {
      ...cleared,
      balls,
      turnIndex: state.turnIndex,
      groups: state.groups,
      // The game is over, so ball-in-hand changes nothing - but recording the
      // foul keeps the final state honest about WHY it ended.
      ballInHand: foul,
      winner: won ? shooter : opponent,
      // Two different ways to lose on the 8-ball, and the more specific one
      // wins. Potting it before your group is cleared is EIGHT_EARLY even when
      // the shot was also a foul, because "you sank the 8 too soon" is what
      // actually happened and what the player needs to be told. EIGHT_FOUL is
      // reserved for the case where the 8 WAS your legal target and you fouled
      // anyway - the classic scratch-on-the-8.
      ending: won
        ? PoolEnding.EIGHT_LEGAL
        : onEight
          ? PoolEnding.EIGHT_FOUL
          : PoolEnding.EIGHT_EARLY,
    };
  }

  // -- assign solids/stripes on the first legal pot after the break ---------
  let groups = state.groups;
  if (myGroup === PoolGroup.NONE && !foul && !isBreak && objects.length > 0) {
    // Lowest-numbered ball potted decides the group; with no "call your pocket"
    // on the wire this is the deterministic stand-in for calling the shot.
    let lowest = objects[0] as number;
    for (const i of objects) if (i < lowest) lowest = i;
    const mine = ballGroup(lowest);
    groups = shooter === 0 ? [mine, otherGroup(mine)] : [otherGroup(mine), mine];
  }

  const nowGroup = groups[shooter] ?? PoolGroup.NONE;
  const continues =
    !foul &&
    (nowGroup === PoolGroup.NONE
      ? objects.length > 0 // open table or break: any pot keeps you at the table
      : objects.some((i) => ballGroup(i) === nowGroup));

  let balls = state.balls.map((b) => ({ ...b, vx: 0, vy: 0 }));
  if (foul) {
    // Ball in hand for the incoming player: the cue ball comes back to the head spot.
    balls = balls.map((b, i) => (i === CUE_BALL ? respotCue(balls) : b));
  }

  return {
    ...cleared,
    balls,
    groups,
    turnIndex: continues ? shooter : opponent,
    ballInHand: foul,
    winner: -1,
    ending: PoolEnding.NONE,
  };
}

// ---------------------------------------------------------------------------
// View helpers - rendering only, never fed back into the simulation
// ---------------------------------------------------------------------------

export interface PoolBallView {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly potted: boolean;
  readonly kind: 'cue' | 'solid' | 'eight' | 'stripe';
}

export interface PoolView {
  readonly table: {
    readonly width: number;
    readonly height: number;
    readonly ballRadius: number;
    readonly pocketRadius: number;
    readonly pockets: readonly (readonly [number, number])[];
  };
  readonly balls: readonly PoolBallView[];
  readonly toShoot: PlayerId | null;
  readonly yourTurn: boolean;
  readonly yourGroup: number;
  readonly theirGroup: number;
  readonly yourRemaining: number;
  readonly theirRemaining: number;
  readonly onEight: boolean;
  readonly moving: boolean;
  readonly ballInHand: boolean;
  readonly message: string;
}

/** Everything a renderer needs, from one viewer's point of view. */
export function poolView(state: PoolState, viewer: PlayerId): PoolView {
  const seat = state.players.indexOf(viewer);
  const me = seat < 0 ? 0 : seat;
  const them = 1 - me;
  const yourGroup = state.groups[me] ?? PoolGroup.NONE;
  const theirGroup = state.groups[them] ?? PoolGroup.NONE;
  const yourRemaining = remainingInGroup(state, yourGroup);
  const theirRemaining = remainingInGroup(state, theirGroup);
  const toShoot = state.winner >= 0 ? null : (state.players[state.turnIndex] ?? null);
  const onEight = yourGroup !== PoolGroup.NONE && yourRemaining === 0;

  let message: string;
  if (state.winner >= 0) {
    message = state.winner === me ? 'You win' : 'You lose';
  } else if (anyBallMoving(state)) {
    message = 'Balls rolling';
  } else if (state.ballInHand && toShoot === viewer) {
    message = 'Ball in hand';
  } else if (toShoot === viewer) {
    message = onEight ? 'Shoot for the 8-ball' : 'Your shot';
  } else {
    message = 'Waiting for your opponent';
  }

  return {
    table: {
      width: TABLE_WIDTH,
      height: TABLE_HEIGHT,
      ballRadius: BALL_RADIUS,
      pocketRadius: POCKET_RADIUS,
      pockets: POCKETS,
    },
    balls: state.balls.map((b, i) => ({
      index: i,
      x: b.x,
      y: b.y,
      potted: b.potted,
      kind: i === CUE_BALL ? 'cue' : i === EIGHT_BALL ? 'eight' : isSolid(i) ? 'solid' : 'stripe',
    })),
    toShoot,
    yourTurn: toShoot === viewer,
    yourGroup,
    theirGroup,
    yourRemaining,
    theirRemaining,
    onEight,
    moving: anyBallMoving(state),
    ballInHand: state.ballInHand,
    message,
  };
}

/**
 * Interpolate ball positions between two snapshots, for SnapshotInterpolator.
 *
 * Rendering only. The result is a blend of two authoritative states and must
 * never be fed back into `tick` or `applyAction`, or the two devices would be
 * simulating different tables.
 */
export function poolLerp(from: PoolState, to: PoolState, t: number): PoolState {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const balls = to.balls.map((b, i) => {
    const a = from.balls[i];
    if (!a || a.potted || b.potted) return b;
    return { ...b, x: r3(a.x + (b.x - a.x) * k), y: r3(a.y + (b.y - a.y) * k) };
  });
  return { ...to, balls };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function encodeBalls(balls: readonly PoolBall[]): { pos: number[]; vel: number[]; mask: number } {
  const pos: number[] = [];
  const vel: number[] = [];
  let mask = 0;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i] as PoolBall;
    pos.push(toMilli(b.x), toMilli(b.y));
    vel.push(toMilli(b.vx), toMilli(b.vy));
    if (b.potted) mask |= 1 << i;
  }
  return { pos, vel, mask };
}

function normaliseAngle(angle: number): number {
  if (!Number.isFinite(angle)) return Number.NaN; // let the encoder produce garbage the decoder will reject
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export const pool: GameDefinition<PoolState, PoolAction> = {
  id: 'pool',
  name: '8-Ball',
  protocolVersion: 1,
  mode: GameMode.REALTIME,
  minPlayers: 2,
  maxPlayers: 2,
  tickRate: TICK_RATE,

  createInitialState(setup: GameSetup): PoolState {
    return {
      balls: rack(setup.seed),
      players: [...setup.players],
      turnIndex: 0,
      groups: [PoolGroup.NONE, PoolGroup.NONE],
      shooting: false,
      firstHit: -1,
      pottedThisShot: [],
      ballInHand: false,
      broken: false,
      winner: -1,
      ending: PoolEnding.NONE,
      shots: 0,
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.winner >= 0) return invalid('the game has already finished');
    if (action.type !== 'shoot') return invalid(`unknown action "${action.type}"`);
    const expected = state.players[state.turnIndex];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);
    if (state.shooting || anyBallMoving(state)) return invalid('wait for the balls to stop');
    const { angle, power } = action.payload;
    if (!Number.isFinite(angle) || angle < 0 || angle > TAU) return invalid('angle must be 0..2pi');
    if (!Number.isFinite(power) || power < MIN_POWER || power > 1) {
      return invalid(`power must be ${MIN_POWER}..1`);
    }
    if (ballAt(state, CUE_BALL).potted) return invalid('the cue ball is off the table');
    return VALID;
  },

  applyAction(state, action): PoolState {
    // The whole shot resolves here (see header note 5): begin it, run it to rest
    // with the same step function `tick` uses, then apply the rules of 8-ball.
    return settle(poolBeginShot(state, action.payload.angle, action.payload.power));
  },

  tick(state): PoolState {
    if (!state.shooting) return state;
    return stepOnce(state);
  },

  status(state): GameStatus {
    if (state.winner >= 0) {
      const winner = state.players[state.winner];
      const reason =
        state.ending === PoolEnding.EIGHT_LEGAL
          ? 'potted the 8-ball with the table cleared'
          : state.ending === PoolEnding.EIGHT_FOUL
            ? 'opponent fouled on the 8-ball'
            : 'opponent potted the 8-ball too early';
      return { kind: GameStatusKind.WON, winners: winner ? [winner] : [], reason };
    }
    return { kind: GameStatusKind.IN_PROGRESS };
  },

  currentTurn(state): PlayerId | null {
    if (state.winner >= 0) return null;
    return state.players[state.turnIndex] ?? null;
  },

  encodeState(state): CborValue {
    const { pos, vel, mask } = encodeBalls(state.balls);
    const value: Record<string, CborValue> = {
      b: pos,
      k: mask,
      q: [...state.players],
      t: state.turnIndex,
      g: [...state.groups],
      d: state.broken,
      h: state.ballInHand,
      w: state.winner,
      e: state.ending,
      c: state.shots,
    };
    // Velocities and the in-flight bookkeeping only exist while a shot is in
    // flight; at rest they are all zero, so leaving them out keeps a snapshot
    // small. Their presence is what tells the decoder a shot is running.
    if (state.shooting) {
      value.v = vel;
      value.f = state.firstHit;
      value.o = [...state.pottedThisShot];
    }
    return value;
  },

  decodeState(value): PoolState {
    const m = asMap(value, 'pool.state');
    const pos = asArray(m.b, 'pool.balls', BALL_COUNT * 2);
    if (pos.length !== BALL_COUNT * 2) throw new GameDecodeError('pool: expected 32 coordinates');
    const mask = asInt(m.k, 'pool.potted', 0, 0xffff);
    const shooting = m.v !== undefined;
    const vel = shooting ? asArray(m.v, 'pool.velocities', BALL_COUNT * 2) : [];
    if (shooting && vel.length !== BALL_COUNT * 2) throw new GameDecodeError('pool: expected 32 velocities');

    const balls: PoolBall[] = new Array<PoolBall>(BALL_COUNT);
    for (let i = 0; i < BALL_COUNT; i++) {
      const px = asInt(pos[i * 2], `pool.x[${i}]`, 0, TABLE_WIDTH * 1000);
      const py = asInt(pos[i * 2 + 1], `pool.y[${i}]`, 0, TABLE_HEIGHT * 1000);
      const bvx = shooting ? asInt(vel[i * 2], `pool.vx[${i}]`, -2_000_000, 2_000_000) : 0;
      const bvy = shooting ? asInt(vel[i * 2 + 1], `pool.vy[${i}]`, -2_000_000, 2_000_000) : 0;
      balls[i] = {
        x: px / 1000,
        y: py / 1000,
        vx: bvx / 1000,
        vy: bvy / 1000,
        potted: (mask & (1 << i)) !== 0,
      };
    }

    const players = asArray(m.q, 'pool.players', 2).map((p, i) => {
      if (typeof p !== 'string') throw new GameDecodeError(`pool.players[${i}]: expected a string`);
      if (p.length > 64) throw new GameDecodeError(`pool.players[${i}]: too long`);
      return p;
    });
    if (players.length !== 2) throw new GameDecodeError('pool: expected 2 players');

    const groups = asArray(m.g, 'pool.groups', 2).map((g, i) => asInt(g, `pool.groups[${i}]`, 0, 2));
    if (groups.length !== 2) throw new GameDecodeError('pool: expected 2 groups');

    return {
      balls,
      players,
      turnIndex: asInt(m.t, 'pool.turnIndex', 0, 1),
      groups,
      shooting,
      firstHit: shooting ? asInt(m.f, 'pool.firstHit', -1, BALL_COUNT - 1) : -1,
      pottedThisShot: shooting
        ? asArray(m.o, 'pool.pottedThisShot', BALL_COUNT).map((i, k) =>
            asInt(i, `pool.pottedThisShot[${k}]`, 0, BALL_COUNT - 1),
          )
        : [],
      ballInHand: asBool(m.h, 'pool.ballInHand'),
      broken: asBool(m.d, 'pool.broken'),
      winner: asInt(m.w, 'pool.winner', -1, 1),
      ending: asInt(m.e, 'pool.ending', 0, 3),
      shots: asInt(m.c, 'pool.shots', 0, 1_000_000),
    };
  },

  encodeAction(action): CborValue {
    // Milliradians and thousandths: a shot is about twenty bytes on the wire,
    // and quantising here means both devices simulate from the identical angle.
    return encodeActionEnvelope({
      ...action,
      payload: {
        a: Math.round(normaliseAngle(action.payload.angle) * 1000),
        p: Math.round(action.payload.power * 1000),
      },
    });
  },

  decodeAction(value, player): PoolAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'shoot') throw new GameDecodeError(`pool: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'pool.payload');
    const angle = asInt(payload.a, 'pool.angle', 0, MAX_ANGLE_MILLI);
    const power = asInt(payload.p, 'pool.power', 0, 1000);
    return {
      type: 'shoot',
      player,
      seq: envelope.seq,
      payload: { angle: angle / 1000, power: power / 1000 },
    };
  },
};
