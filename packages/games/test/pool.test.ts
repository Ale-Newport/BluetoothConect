import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS,
  CUE_BALL,
  EIGHT_BALL,
  HEAD_SPOT_X,
  HEAD_SPOT_Y,
  PoolEnding,
  PoolGroup,
  TABLE_HEIGHT,
  TABLE_WIDTH,
  anyBallMoving,
  ballGroup,
  pool,
  poolBeginShot,
  poolCos,
  poolLerp,
  poolSin,
  poolView,
  type PoolAction,
  type PoolBall,
  type PoolState,
} from '../src/games/pool.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };
const ctx = createContext(setup.players, setup.seed);

/** Straight up the screen (-y). Both are exercised heavily below. */
const UP = 4.712;
const RIGHT = 0;

function fresh(): PoolState {
  return pool.createInitialState(setup);
}

/**
 * A table holding only the listed balls; everything else counts as already
 * potted. Lets a rule be set up in three lines instead of a whole rack.
 */
function tableWith(placed: readonly (readonly [number, number, number])[], opts: Partial<PoolState> = {}): PoolState {
  const base = fresh();
  const balls: PoolBall[] = base.balls.map(() => ({ x: 0, y: 0, vx: 0, vy: 0, potted: true }));
  for (const [index, x, y] of placed) balls[index] = { x, y, vx: 0, vy: 0, potted: false };
  return { ...base, balls, broken: true, ...opts };
}

/** Take a shot the way the runtime does: through the wire codec, then the rules. */
function shoot(state: PoolState, player: string, angle: number, power: number): PoolState {
  const draft: PoolAction = { type: 'shoot', player, seq: 0, payload: { angle, power } };
  const action = pool.decodeAction(pool.encodeAction(draft), player);
  const check = pool.validateAction(state, action, ctx);
  expect(check.ok).toBe(true);
  return pool.applyAction(state, action, ctx);
}

function ball(state: PoolState, index: number): PoolBall {
  return state.balls[index] as PoolBall;
}

function hash(state: PoolState): string {
  return JSON.stringify(pool.encodeState(state));
}

describe('pool geometry and deterministic maths', () => {
  it('racks 16 balls inside the cushions with nothing overlapping', () => {
    const s = fresh();
    expect(s.balls).toHaveLength(16);
    expect(ball(s, CUE_BALL).x).toBe(HEAD_SPOT_X);
    expect(ball(s, CUE_BALL).y).toBe(HEAD_SPOT_Y);
    for (const b of s.balls) {
      expect(b.potted).toBe(false);
      expect(b.x).toBeGreaterThanOrEqual(BALL_RADIUS);
      expect(b.x).toBeLessThanOrEqual(TABLE_WIDTH - BALL_RADIUS);
      expect(b.y).toBeGreaterThanOrEqual(BALL_RADIUS);
      expect(b.y).toBeLessThanOrEqual(TABLE_HEIGHT - BALL_RADIUS);
    }
    for (let i = 0; i < 16; i++) {
      for (let j = i + 1; j < 16; j++) {
        const a = ball(s, i);
        const b = ball(s, j);
        const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        expect(d2).toBeGreaterThanOrEqual((2 * BALL_RADIUS) ** 2);
      }
    }
  });

  it('racks a legal triangle: 8-ball in the middle of the third row, mixed back corners', () => {
    const s = fresh();
    // Third row is the one two column-steps behind the apex.
    const apexX = ball(s, 1).x; // any ball; find the real apex by minimum x
    void apexX;
    const minX = Math.min(...s.balls.slice(1).map((b) => b.x));
    const thirdRow = s.balls
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => i !== CUE_BALL && Math.abs(b.x - (minX + 2 * 17.4)) < 0.001);
    expect(thirdRow).toHaveLength(3);
    const middle = thirdRow.sort((p, q) => p.b.y - q.b.y)[1];
    expect(middle?.i).toBe(EIGHT_BALL);

    const backRow = s.balls
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => i !== CUE_BALL && Math.abs(b.x - (minX + 4 * 17.4)) < 0.001)
      .sort((p, q) => p.b.y - q.b.y);
    expect(backRow).toHaveLength(5);
    const corners = [backRow[0]?.i as number, backRow[4]?.i as number].map(ballGroup).sort();
    expect(corners).toEqual([PoolGroup.SOLIDS, PoolGroup.STRIPES]);
  });

  it('racks identically from the same seed and differently from another', () => {
    expect(hash(pool.createInitialState({ ...setup, seed: 7 }))).toBe(
      hash(pool.createInitialState({ ...setup, seed: 7 })),
    );
    expect(hash(pool.createInitialState({ ...setup, seed: 7 }))).not.toBe(
      hash(pool.createInitialState({ ...setup, seed: 8 })),
    );
  });

  it('has a sine and cosine that agree with the platform ones', () => {
    for (let milli = 0; milli <= 6283; milli += 7) {
      const a = milli / 1000;
      expect(poolSin(a)).toBeCloseTo(Math.sin(a), 9);
      expect(poolCos(a)).toBeCloseTo(Math.cos(a), 9);
    }
  });

  it('keeps every stored number on the millimetre grid', () => {
    let s = shoot(fresh(), 'a', 0.35, 1);
    for (const b of s.balls) {
      expect(Math.round(b.x * 1000)).toBeCloseTo(b.x * 1000, 6);
      expect(Math.round(b.y * 1000)).toBeCloseTo(b.y * 1000, 6);
    }
    s = poolBeginShot(s, 1, 1);
    for (let i = 0; i < 30; i++) s = pool.tick?.(s, ctx) ?? s;
    for (const b of s.balls) {
      expect(b.vx).toBe(Math.round(b.vx * 1000) / 1000);
      expect(b.vy).toBe(Math.round(b.vy * 1000) / 1000);
    }
  });
});

describe('pool shots', () => {
  it('scatters the rack on the break', () => {
    const before = fresh();
    const after = shoot(before, 'a', RIGHT, 1);
    expect(after.broken).toBe(true);
    expect(after.shooting).toBe(false);
    expect(anyBallMoving(after)).toBe(false);
    let moved = 0;
    for (let i = 1; i < 16; i++) {
      const b0 = ball(before, i);
      const b1 = ball(after, i);
      if (b1.potted || Math.abs(b0.x - b1.x) > 1 || Math.abs(b0.y - b1.y) > 1) moved++;
    }
    expect(moved).toBeGreaterThanOrEqual(10);
    // The cue ball must have contacted the rack.
    expect(after.shots).toBe(1);
  });

  it('pots a straight shot into the side pocket', () => {
    const s = tableWith([
      [CUE_BALL, 500, 400],
      [1, 500, 200],
      [EIGHT_BALL, 100, 400],
      [2, 800, 450],
    ]);
    const after = shoot(s, 'a', UP, 0.6);
    expect(ball(after, 1).potted).toBe(true);
    expect(ball(after, CUE_BALL).potted).toBe(false);
    expect(after.winner).toBe(-1);
  });

  it('bounces off a cushion instead of leaving the table', () => {
    const s = tableWith([
      [CUE_BALL, 300, 250],
      [1, 700, 250],
      [EIGHT_BALL, 100, 100],
    ]);
    const after = shoot(s, 'a', RIGHT, 1);
    for (const b of after.balls) {
      if (b.potted) continue;
      expect(b.x).toBeGreaterThanOrEqual(BALL_RADIUS);
      expect(b.x).toBeLessThanOrEqual(TABLE_WIDTH - BALL_RADIUS);
      expect(b.y).toBeGreaterThanOrEqual(BALL_RADIUS);
      expect(b.y).toBeLessThanOrEqual(TABLE_HEIGHT - BALL_RADIUS);
    }
    // Ball 1 was driven into the far cushion and came back towards the middle.
    expect(ball(after, 1).x).toBeLessThan(TABLE_WIDTH - BALL_RADIUS);
  });

  it('always comes to rest', () => {
    for (let milli = 0; milli < 6283; milli += 211) {
      const after = shoot(fresh(), 'a', milli / 1000, 1);
      expect(anyBallMoving(after)).toBe(false);
      expect(after.shooting).toBe(false);
    }
  });
});

describe('pool rules', () => {
  it('assigns solids to whoever pots a solid first', () => {
    const s = tableWith([
      [CUE_BALL, 500, 400],
      [1, 500, 200],
      [9, 800, 100],
      [EIGHT_BALL, 100, 400],
    ]);
    expect(s.groups).toEqual([PoolGroup.NONE, PoolGroup.NONE]);
    const after = shoot(s, 'a', UP, 0.6);
    expect(after.groups).toEqual([PoolGroup.SOLIDS, PoolGroup.STRIPES]);
    // Potting your own group keeps you at the table.
    expect(after.turnIndex).toBe(0);
    expect(after.ballInHand).toBe(false);
  });

  it('assigns stripes to whoever pots a stripe first', () => {
    const s = tableWith([
      [CUE_BALL, 500, 400],
      [9, 500, 200],
      [1, 800, 100],
      [EIGHT_BALL, 100, 400],
    ]);
    const after = shoot(s, 'a', UP, 0.6);
    expect(after.groups).toEqual([PoolGroup.STRIPES, PoolGroup.SOLIDS]);
    expect(after.turnIndex).toBe(0);
  });

  it('does not assign a group on the break', () => {
    const s = { ...tableWith([[CUE_BALL, 500, 400], [1, 500, 200], [EIGHT_BALL, 100, 400]]), broken: false };
    const after = shoot(s, 'a', UP, 0.6);
    expect(ball(after, 1).potted).toBe(true);
    expect(after.groups).toEqual([PoolGroup.NONE, PoolGroup.NONE]);
    expect(after.broken).toBe(true);
    expect(after.turnIndex).toBe(0); // a pot on the break still keeps you at the table
  });

  it('gives the opponent ball in hand when the cue ball is scratched', () => {
    const s = tableWith([
      [CUE_BALL, 500, 100],
      [1, 800, 400],
      [EIGHT_BALL, 100, 400],
    ]);
    const after = shoot(s, 'a', UP, 0.3);
    expect(after.turnIndex).toBe(1);
    expect(after.ballInHand).toBe(true);
    expect(ball(after, CUE_BALL).potted).toBe(false);
    expect(ball(after, CUE_BALL).x).toBe(HEAD_SPOT_X);
    expect(ball(after, CUE_BALL).y).toBe(HEAD_SPOT_Y);
    expect(after.winner).toBe(-1);
  });

  it('re-spots the cue ball clear of a ball sitting on the head spot', () => {
    const s = tableWith([
      [CUE_BALL, 500, 100],
      [1, HEAD_SPOT_X, HEAD_SPOT_Y],
      [EIGHT_BALL, 100, 400],
    ]);
    const after = shoot(s, 'a', UP, 0.3);
    const cue = ball(after, CUE_BALL);
    expect(cue.potted).toBe(false);
    const d2 = (cue.x - HEAD_SPOT_X) ** 2 + (cue.y - HEAD_SPOT_Y) ** 2;
    expect(d2).toBeGreaterThan((2 * BALL_RADIUS) ** 2);
  });

  it('fouls when the cue ball touches nothing', () => {
    const s = tableWith([
      [CUE_BALL, 300, 250],
      [1, 300, 100],
      [EIGHT_BALL, 100, 400],
    ]);
    const after = shoot(s, 'a', RIGHT, 0.1); // rolls to a stop without reaching anything
    expect(after.turnIndex).toBe(1);
    expect(after.ballInHand).toBe(true);
  });

  it('fouls when a legal contact pots nothing', () => {
    const s = tableWith([
      [CUE_BALL, 100, 250],
      [1, 300, 250],
      [EIGHT_BALL, 100, 400],
    ]);
    const after = shoot(s, 'a', RIGHT, 0.5);
    expect(ball(after, 1).potted).toBe(false);
    expect(after.turnIndex).toBe(1);
    expect(after.ballInHand).toBe(true);
  });

  it('fouls when the wrong group is struck first', () => {
    const s = tableWith(
      [
        [CUE_BALL, 500, 400],
        [9, 500, 200],
        [1, 800, 100],
        [EIGHT_BALL, 100, 400],
      ],
      { groups: [PoolGroup.SOLIDS, PoolGroup.STRIPES] },
    );
    const after = shoot(s, 'a', UP, 0.6);
    expect(ball(after, 9).potted).toBe(true); // the stripe still drops
    expect(after.turnIndex).toBe(1); // but it is a foul
    expect(after.ballInHand).toBe(true);
  });

  it('passes the turn without ball in hand after a legal shot that pots only the opponent', () => {
    const s = tableWith(
      [
        [CUE_BALL, 500, 400],
        [1, 500, 300],
        [9, 500, 100],
        [EIGHT_BALL, 100, 450],
      ],
      { groups: [PoolGroup.SOLIDS, PoolGroup.STRIPES] },
    );
    const after = shoot(s, 'a', UP, 0.6);
    expect(ball(after, 9).potted).toBe(true);
    expect(ball(after, 1).potted).toBe(false);
    expect(after.turnIndex).toBe(1);
    expect(after.ballInHand).toBe(false);
  });

  it('wins when the 8-ball drops with the group cleared', () => {
    const s = tableWith(
      [
        [CUE_BALL, 500, 400],
        [EIGHT_BALL, 500, 200],
        [9, 800, 450],
      ],
      { groups: [PoolGroup.SOLIDS, PoolGroup.STRIPES] },
    );
    const after = shoot(s, 'a', UP, 0.6);
    expect(ball(after, EIGHT_BALL).potted).toBe(true);
    expect(after.winner).toBe(0);
    expect(after.ending).toBe(PoolEnding.EIGHT_LEGAL);
    const status = pool.status(after);
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['a']);
  });

  it('loses when the 8-ball drops too early', () => {
    const s = tableWith(
      [
        [CUE_BALL, 500, 400],
        [EIGHT_BALL, 500, 200],
        [1, 800, 450],
      ],
      { groups: [PoolGroup.SOLIDS, PoolGroup.STRIPES] },
    );
    const after = shoot(s, 'a', UP, 0.6);
    expect(ball(after, EIGHT_BALL).potted).toBe(true);
    expect(after.winner).toBe(1);
    expect(after.ending).toBe(PoolEnding.EIGHT_EARLY);
    const status = pool.status(after);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['b']);
  });

  it('loses when the 8-ball drops together with the last ball of the group', () => {
    const s = tableWith(
      [
        [CUE_BALL, 500, 460],
        [1, 500, 300],
        [EIGHT_BALL, 480, 100],
      ],
      { groups: [PoolGroup.SOLIDS, PoolGroup.STRIPES] },
    );
    const after = shoot(s, 'a', UP, 0.8);
    if (ball(after, EIGHT_BALL).potted && ball(after, 1).potted) {
      expect(after.winner).toBe(1);
      expect(after.ending).toBe(PoolEnding.EIGHT_EARLY);
    }
  });

  it('loses when the 8-ball drops on a scratch', () => {
    // 'a' is on solids and has none left, so the 8-ball IS the legal target -
    // this is not an early 8. The cut sends the 8 into the top-middle pocket
    // and carries the cue ball on into a pocket of its own, which is the
    // classic scratch-on-the-8 and loses the game outright.
    const s = tableWith(
      [
        [CUE_BALL, 380, 100],
        [EIGHT_BALL, 470, 40],
        [9, 850, 450],
      ],
      { groups: [PoolGroup.SOLIDS, PoolGroup.STRIPES] },
    );
    const after = shoot(s, 'a', -0.8508, 0.85);
    expect(ball(after, EIGHT_BALL).potted).toBe(true);
    expect(ball(after, CUE_BALL).potted).toBe(true);
    expect(after.winner).toBe(1);
    expect(after.ending).toBe(PoolEnding.EIGHT_FOUL);
    const status = pool.status(after);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['b']);
  });
});

describe('pool rejects illegal actions', () => {
  function session(local: 'a' | 'b', isHost: boolean) {
    return new GameSession({ definition: pool, setup, localPlayer: local, isHost });
  }

  it('refuses a shot out of turn', () => {
    const b = session('b', false);
    const r = b.submitLocal('shoot', { angle: 1, power: 0.5 });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/turn/);
  });

  it('refuses a shot while the balls are still moving', () => {
    const moving = poolBeginShot(fresh(), RIGHT, 1);
    const action = pool.decodeAction(
      pool.encodeAction({ type: 'shoot', player: 'a', seq: 0, payload: { angle: 1, power: 0.5 } }),
      'a',
    );
    const check = pool.validateAction(moving, action, ctx);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/stop/);
  });

  it('refuses a shot once the game is over', () => {
    const done = tableWith(
      [
        [CUE_BALL, 500, 400],
        [EIGHT_BALL, 500, 200],
        [9, 800, 450],
      ],
      { groups: [PoolGroup.SOLIDS, PoolGroup.STRIPES] },
    );
    const after = shoot(done, 'a', UP, 0.6);
    expect(after.winner).toBe(0);
    const action = pool.decodeAction(
      pool.encodeAction({ type: 'shoot', player: 'b', seq: 0, payload: { angle: 1, power: 0.5 } }),
      'b',
    );
    const check = pool.validateAction(after, action, ctx);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/finished/);
  });

  it('refuses a power outside the legal range', () => {
    const a = session('a', true);
    expect(a.submitLocal('shoot', { angle: 1, power: 0 }).accepted).toBe(false);
    expect(a.submitLocal('shoot', { angle: 1, power: 0.01 }).accepted).toBe(false);
    expect(a.submitLocal('shoot', { angle: 1, power: 2 }).accepted).toBe(false);
    expect(a.submitLocal('shoot', { angle: 1, power: Number.NaN }).accepted).toBe(false);
    expect(a.submitLocal('shoot', { angle: Number.NaN, power: 0.5 }).accepted).toBe(false);
    expect(a.submitLocal('shoot', { angle: 1, power: 0.5 }).accepted).toBe(true);
  });

  it('will not let one player shoot as another', () => {
    const b = session('b', false);
    // Authenticated as b, so the forged "player: a" in the payload is ignored and
    // b is simply not to move.
    const forged = pool.encodeAction({ type: 'shoot', player: 'a', seq: 0, payload: { angle: 1, power: 0.5 } });
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
    const impostor = session('a', true);
    expect(impostor.applyRemote(forged, 'nobody').accepted).toBe(false);
  });

  it('throws on malformed wire actions instead of trusting them', () => {
    const junk = [
      null,
      0,
      'shoot',
      [],
      {},
      { t: 'shoot' },
      { t: 'shoot', s: 0 },
      { t: 'shove', s: 0, p: { a: 1, p: 1 } },
      { t: 'shoot', s: 0, p: null },
      { t: 'shoot', s: 0, p: [] },
      { t: 'shoot', s: 0, p: new Uint8Array(8) },
      { t: 'shoot', s: 0, p: { a: -1, p: 500 } },
      { t: 'shoot', s: 0, p: { a: 99999, p: 500 } },
      { t: 'shoot', s: 0, p: { a: 1.5, p: 500 } },
      { t: 'shoot', s: 0, p: { a: 100, p: 1e12 } },
      { t: 'shoot', s: 0, p: { a: '1', p: '1' } },
      { t: 'shoot', s: -1, p: { a: 100, p: 500 } },
    ];
    for (const value of junk) {
      expect(() => pool.decodeAction(value as never, 'a')).toThrow();
    }
    // ...and the session absorbs all of it without throwing.
    const a = new GameSession({ definition: pool, setup, localPlayer: 'a', isHost: true });
    for (const value of junk) {
      expect(() => a.applyRemote(value as never, 'a')).not.toThrow();
    }
  });

  it('rejects malformed states rather than importing them', () => {
    const good = pool.encodeState(fresh()) as Record<string, unknown>;
    const broken: unknown[] = [
      null,
      42,
      [],
      { ...good, b: [] },
      { ...good, b: (good.b as number[]).slice(0, 30) },
      { ...good, k: -1 },
      { ...good, k: 1e12 },
      { ...good, q: ['a'] },
      { ...good, q: [1, 2] },
      { ...good, g: [5, 5] },
      { ...good, t: 9 },
      { ...good, w: 7 },
      { ...good, h: 1 },
      { ...good, d: 'yes' },
      { ...good, b: (good.b as number[]).map(() => 9_000_000) },
      { ...good, v: [1, 2, 3] },
    ];
    for (const value of broken) {
      expect(() => pool.decodeState(value as never)).toThrow();
    }
  });
});

describe('pool encoding', () => {
  it('round-trips a resting state exactly', () => {
    const s = shoot(fresh(), 'a', 0.9, 1);
    const restored = pool.decodeState(pool.encodeState(s));
    expect(hash(restored)).toBe(hash(s));
    expect(restored.balls).toEqual(s.balls);
    expect(restored.groups).toEqual(s.groups);
  });

  it('round-trips a state with a shot in flight exactly', () => {
    let s = poolBeginShot(fresh(), 0.4, 1);
    for (let i = 0; i < 25; i++) s = pool.tick?.(s, ctx) ?? s;
    expect(s.shooting).toBe(true);
    const restored = pool.decodeState(pool.encodeState(s));
    expect(hash(restored)).toBe(hash(s));
    expect(restored.shooting).toBe(true);
    expect(restored.firstHit).toBe(s.firstHit);
    expect(restored.balls).toEqual(s.balls);
  });

  it('round-trips an action through the compact wire shape', () => {
    const action: PoolAction = { type: 'shoot', player: 'a', seq: 3, payload: { angle: 1.234, power: 0.75 } };
    const wire = pool.encodeAction(action) as { t: string; s: number; p: { a: number; p: number } };
    expect(wire.p).toEqual({ a: 1234, p: 750 });
    const restored = pool.decodeAction(wire, 'a');
    expect(restored.payload).toEqual({ angle: 1.234, power: 0.75 });
    expect(JSON.stringify(pool.encodeAction(restored))).toBe(JSON.stringify(wire));
  });

  it('normalises an out-of-range angle before it reaches the wire', () => {
    const wire = pool.encodeAction({
      type: 'shoot',
      player: 'a',
      seq: 0,
      payload: { angle: -1, power: 0.5 },
    }) as { p: { a: number } };
    expect(wire.p.a).toBeGreaterThanOrEqual(0);
    expect(wire.p.a).toBeLessThanOrEqual(6283);
  });
});

describe('pool view helpers', () => {
  it('describes the table from a viewer point of view', () => {
    const s = tableWith(
      [
        [CUE_BALL, 200, 200],
        [1, 400, 200],
        [9, 600, 200],
        [EIGHT_BALL, 800, 200],
      ],
      { groups: [PoolGroup.SOLIDS, PoolGroup.STRIPES] },
    );
    const view = poolView(s, 'a');
    expect(view.table.width).toBe(TABLE_WIDTH);
    expect(view.balls).toHaveLength(16);
    expect(view.balls[CUE_BALL]?.kind).toBe('cue');
    expect(view.balls[EIGHT_BALL]?.kind).toBe('eight');
    expect(view.balls[1]?.kind).toBe('solid');
    expect(view.balls[9]?.kind).toBe('stripe');
    expect(view.yourTurn).toBe(true);
    expect(view.yourGroup).toBe(PoolGroup.SOLIDS);
    expect(view.yourRemaining).toBe(1);
    expect(view.theirRemaining).toBe(1);
    expect(view.message).toBe('Your shot');
    expect(poolView(s, 'b').yourTurn).toBe(false);
  });

  it('lerps ball positions between two snapshots without touching the rules', () => {
    const from = tableWith([
      [CUE_BALL, 100, 100],
      [1, 300, 300],
      [EIGHT_BALL, 500, 100],
    ]);
    const to: PoolState = {
      ...from,
      turnIndex: 1,
      balls: from.balls.map((b, i) => (i === CUE_BALL ? { ...b, x: 300, y: 200 } : b)),
    };
    const mid = poolLerp(from, to, 0.5);
    expect(mid.balls[CUE_BALL]?.x).toBe(200);
    expect(mid.balls[CUE_BALL]?.y).toBe(150);
    expect(mid.turnIndex).toBe(1);
    expect(poolLerp(from, to, -5).balls[CUE_BALL]?.x).toBe(100);
    expect(poolLerp(from, to, 9).balls[CUE_BALL]?.x).toBe(300);
  });
});

describe('pool determinism', () => {
  it('does not mutate the state it is given', () => {
    const before = fresh();
    const snapshot = hash(before);
    const action = pool.decodeAction(
      pool.encodeAction({ type: 'shoot', player: 'a', seq: 0, payload: { angle: 0.3, power: 1 } }),
      'a',
    );
    pool.applyAction(before, action, ctx);
    pool.tick?.(poolBeginShot(before, 0.3, 1), ctx);
    expect(hash(before)).toBe(snapshot);
    expect(before.shooting).toBe(false);
  });

  it('keeps two sessions byte-identical across 900 ticks of one shot', () => {
    const start = poolBeginShot(fresh(), 0.37, 1);
    const a = new GameSession({ definition: pool, setup, localPlayer: 'a', isHost: false });
    const b = new GameSession({ definition: pool, setup, localPlayer: 'b', isHost: false });
    expect(a.applySnapshot(pool.encodeState(start))).toBe(true);
    expect(b.applySnapshot(pool.encodeState(start))).toBe(true);

    let settledAt = -1;
    for (let i = 0; i < 900; i++) {
      a.tick(1000 / 60);
      b.tick(1000 / 60);
      expect(hash(a.currentState)).toBe(hash(b.currentState));
      if (settledAt < 0 && !a.currentState.shooting) settledAt = i;
    }
    expect(settledAt).toBeGreaterThan(30);
    expect(settledAt).toBeLessThan(600);
    expect(anyBallMoving(a.currentState)).toBe(false);

    // The tick-by-tick path and the reducer's fast-forward must agree exactly:
    // that is what lets a rejoining peer replay the action log and catch up.
    const viaAction = shoot(fresh(), 'a', 0.37, 1);
    expect(hash(a.currentState)).toBe(hash(viaAction));
  });

  it('replays an action log onto the same state a live session holds', () => {
    const live = new GameSession({ definition: pool, setup, localPlayer: 'a', isHost: true });
    const mirror = new GameSession({ definition: pool, setup, localPlayer: 'b', isHost: false });
    const angles = [0.2, 1.1, 2.4, 3.3, 4.9, 5.7];
    for (const angle of angles) {
      if (live.isOver) break;
      const player = live.turn as 'a' | 'b';
      const from = player === 'a' ? live : mirror;
      const to = player === 'a' ? mirror : live;
      const r = from.submitLocal('shoot', { angle, power: 0.7 });
      expect(r.accepted).toBe(true);
      if (r.accepted) expect(to.applyRemote(pool.encodeAction(r.applied.action), player).accepted).toBe(true);
      expect(hash(live.currentState)).toBe(hash(mirror.currentState));
      live.tick(1000 / 60);
      mirror.tick(1000 / 60);
      expect(hash(live.currentState)).toBe(hash(mirror.currentState));
    }
    const replayed = GameSession.replay(pool, setup, live.history());
    expect(hash(replayed)).toBe(hash(live.currentState));
  });
});

describe('pool conformance', () => {
  const hooks = {
    legalAction: (state: PoolState, player: string, random: { nextInt(n: number): number }) => {
      if (pool.currentTurn?.(state) !== player) return null;
      if (state.shooting || anyBallMoving(state)) return null;
      return {
        type: 'shoot',
        payload: { angle: random.nextInt(6284) / 1000, power: (200 + random.nextInt(801)) / 1000 },
      };
    },
    maxPlies: 200,
  };

  it('passes the shared game conformance suite', () => {
    const report = runConformance(pool, hooks as never);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 45; seed++) {
      const report = runConformance(pool, { ...hooks, maxPlies: 60 } as never, seed);
      expect(report.failures).toEqual([]);
    }
  });
});
