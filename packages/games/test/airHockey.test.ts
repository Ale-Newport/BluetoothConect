import { describe, expect, it } from 'vitest';
import { encodeCbor, decodeCbor, toHex, type CborValue } from '@airlink/core';
import {
  AIR_HOCKEY,
  airHockey,
  airHockeyView,
  lerpAirHockey,
  type AirHockeyState,
  type MalletState,
  type PuckState,
} from '../src/games/airHockey.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };
const STEP_MS = 1000 / 60;

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: airHockey, setup, localPlayer: local, isHost });
}

/** A context at a chosen point on the simulated clock. */
function ctx(elapsedMs = 0) {
  return createContext(setup.players, setup.seed, elapsedMs, STEP_MS);
}

const initial = (): AirHockeyState => airHockey.createInitialState(setup);

function withPuck(state: AirHockeyState, puck: Partial<PuckState>): AirHockeyState {
  return { ...state, puck: { ...state.puck, ...puck } };
}

function withMallet(state: AirHockeyState, index: 0 | 1, mallet: Partial<MalletState>): AirHockeyState {
  const next: [MalletState, MalletState] = [state.mallets[0], state.mallets[1]];
  next[index] = { ...next[index], ...mallet };
  return { ...state, mallets: next };
}

/** A state with the face-off already over, so tick() actually simulates. */
function live(state: AirHockeyState): AirHockeyState {
  return { ...state, serveAt: 0 };
}

const hash = (state: AirHockeyState): string => toHex(encodeCbor(airHockey.encodeState(state)));

// ---------------------------------------------------------------------------

describe('air hockey setup', () => {
  it('starts with a centred puck, mallets at home and no score', () => {
    const s = initial();
    expect(s.puck.x).toBe(AIR_HOCKEY.WIDTH / 2);
    expect(s.puck.y).toBe(AIR_HOCKEY.CENTER_Y);
    expect(s.mallets[0]).toEqual({ x: 300, y: 850, tx: 300, ty: 850 });
    expect(s.mallets[1]).toEqual({ x: 300, y: 150, tx: 300, ty: 150 });
    expect(s.scores).toEqual([0, 0]);
    expect(s.winnerIndex).toBe(-1);
    expect(s.serveAt).toBe(AIR_HOCKEY.FACE_OFF_MS);
    expect(airHockey.status(s).kind).toBe(GameStatusKind.IN_PROGRESS);
    expect(airHockey.currentTurn).toBeUndefined(); // realtime: anyone may act
  });

  it('draws the opening serve direction from the shared seed', () => {
    const even = airHockey.createInitialState({ players: ['a', 'b'], seed: 8, options: {} });
    const odd = airHockey.createInitialState({ players: ['a', 'b'], seed: 9, options: {} });
    expect(even.puck.vy).toBe(AIR_HOCKEY.SERVE_STEP);
    expect(odd.puck.vy).toBe(-AIR_HOCKEY.SERVE_STEP);
    // Same seed, two devices: identical.
    expect(hash(airHockey.createInitialState({ players: ['a', 'b'], seed: 9, options: {} }))).toBe(hash(odd));
  });

  it('refuses to build a table that is not for two', () => {
    expect(() => airHockey.createInitialState({ players: ['a'], seed: 1, options: {} })).toThrow();
  });

  it('holds everything still until the face-off clock runs out', () => {
    const s = session('a', true);
    const before = hash(s.currentState);
    s.tick(STEP_MS * 100); // 1666ms, still inside the 3s face-off
    expect(hash(s.currentState)).toBe(before);
    s.tick(STEP_MS * 100); // now past it
    expect(hash(s.currentState)).not.toBe(before);
    expect(s.currentState.puck.y).not.toBe(AIR_HOCKEY.CENTER_Y);
  });
});

describe('air hockey mallets', () => {
  it('clamps an aim into the aiming player half', () => {
    const s = initial();
    const a = airHockey.applyAction(s, { type: 'aim', player: 'a', seq: 0, payload: { x: 700, y: 10 } }, ctx());
    // Bottom half: x in [34, 566], y in [534, 966].
    expect(a.mallets[0].tx).toBe(566);
    expect(a.mallets[0].ty).toBe(534);

    const b = airHockey.applyAction(s, { type: 'aim', player: 'b', seq: 0, payload: { x: -80, y: 990 } }, ctx());
    // Top half: y in [34, 466].
    expect(b.mallets[1].tx).toBe(34);
    expect(b.mallets[1].ty).toBe(466);
  });

  it('only ever moves the aiming player own mallet', () => {
    const s = initial();
    const after = airHockey.applyAction(s, { type: 'aim', player: 'b', seq: 0, payload: { x: 100, y: 100 } }, ctx());
    expect(after.mallets[0]).toEqual(s.mallets[0]);
    expect(after.mallets[1].tx).toBe(100);
    // An aim sets a target only - the mallet has not teleported.
    expect(after.mallets[1].x).toBe(s.mallets[1].x);
    expect(after.mallets[1].y).toBe(s.mallets[1].y);
  });

  it('caps how far a mallet travels in one tick', () => {
    const s = live(withMallet(initial(), 0, { tx: 34, ty: 534 }));
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    const dx = after.mallets[0].x - s.mallets[0].x;
    const dy = after.mallets[0].y - s.mallets[0].y;
    expect(Math.sqrt(dx * dx + dy * dy)).toBeCloseTo(AIR_HOCKEY.MALLET_STEP, 2);
  });

  it('settles exactly on a target that is within one step', () => {
    const s = live(withMallet(initial(), 0, { tx: 306, ty: 854 }));
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(after.mallets[0].x).toBe(306);
    expect(after.mallets[0].y).toBe(854);
  });

  it('never lets a mallet cross the half-way line, however hard it is pushed', () => {
    let s = live(initial());
    // Both players aim deep into the opponent half, every tick, forever.
    for (let i = 0; i < 400; i++) {
      s = airHockey.applyAction(s, { type: 'aim', player: 'a', seq: i, payload: { x: 300, y: -500 } }, ctx());
      s = airHockey.applyAction(s, { type: 'aim', player: 'b', seq: i, payload: { x: 300, y: 1500 } }, ctx());
      s = airHockey.tick?.(s, ctx(5000 + i * STEP_MS)) as AirHockeyState;
      expect(s.mallets[0].y).toBeGreaterThanOrEqual(AIR_HOCKEY.CENTER_Y + AIR_HOCKEY.MALLET_RADIUS);
      expect(s.mallets[0].y).toBeLessThanOrEqual(AIR_HOCKEY.HEIGHT - AIR_HOCKEY.MALLET_RADIUS);
      expect(s.mallets[1].y).toBeLessThanOrEqual(AIR_HOCKEY.CENTER_Y - AIR_HOCKEY.MALLET_RADIUS);
      expect(s.mallets[1].y).toBeGreaterThanOrEqual(AIR_HOCKEY.MALLET_RADIUS);
      expect(s.mallets[0].x).toBeGreaterThanOrEqual(AIR_HOCKEY.MALLET_RADIUS);
      expect(s.mallets[0].x).toBeLessThanOrEqual(AIR_HOCKEY.WIDTH - AIR_HOCKEY.MALLET_RADIUS);
    }
  });

  it('re-clamps a mallet target that arrived inside a hostile snapshot', () => {
    // A lying host puts player 1's target in player 0's half.
    const s = live(withMallet(initial(), 1, { ty: 900 }));
    let next = s;
    for (let i = 0; i < 60; i++) next = airHockey.tick?.(next, ctx(5000 + i * STEP_MS)) as AirHockeyState;
    expect(next.mallets[1].y).toBeLessThanOrEqual(AIR_HOCKEY.CENTER_Y - AIR_HOCKEY.MALLET_RADIUS);
  });
});

describe('air hockey puck physics', () => {
  it('bounces off the left rail and loses a little speed', () => {
    const s = live(withPuck(initial(), { x: 22, y: 500, vx: -10, vy: 0 }));
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(after.puck.x).toBe(AIR_HOCKEY.PUCK_RADIUS);
    expect(after.puck.vx).toBeGreaterThan(0);
    expect(after.puck.vx).toBeLessThan(10);
  });

  it('bounces off the right rail', () => {
    const s = live(withPuck(initial(), { x: AIR_HOCKEY.WIDTH - 22, y: 500, vx: 10, vy: 0 }));
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(after.puck.x).toBe(AIR_HOCKEY.WIDTH - AIR_HOCKEY.PUCK_RADIUS);
    expect(after.puck.vx).toBeLessThan(0);
  });

  it('bounces off the short wall away from the goal mouth', () => {
    const s = live(withPuck(initial(), { x: 100, y: 25, vx: 0, vy: -10 }));
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(after.puck.y).toBe(AIR_HOCKEY.PUCK_RADIUS);
    expect(after.puck.vy).toBeGreaterThan(0);
    expect(after.scores).toEqual([0, 0]);
  });

  it('rebounds off a goal post instead of scoring a half-in goal', () => {
    // x = 205 is inside the mouth span but the puck body would clip the post.
    const s = live(withPuck(initial(), { x: 205, y: 20, vx: 0, vy: -25 }));
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(after.scores).toEqual([0, 0]);
    expect(after.puck.y).toBe(AIR_HOCKEY.PUCK_RADIUS);
    expect(after.puck.vy).toBeGreaterThan(0);
  });

  it('slows the puck down and eventually parks it', () => {
    let s = live(withPuck(initial(), { x: 300, y: 700, vx: 3, vy: 0 }));
    const first = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(first.puck.vx).toBeLessThan(3);
    expect(first.puck.vx).toBeGreaterThan(0);
    for (let i = 0; i < 3000; i++) s = airHockey.tick?.(s, ctx(5000 + i * STEP_MS)) as AirHockeyState;
    // Not merely slow: exactly stopped. Rounding the stored velocity to three
    // decimals makes friction a no-op below 0.1 units/tick, which is why the
    // rest threshold has to sit above that fixed point.
    expect(s.puck.vx).toBe(0);
    expect(s.puck.vy).toBe(0);
    const resting = hash(s);
    expect(hash(airHockey.tick?.(s, ctx(9000)) as AirHockeyState)).toBe(resting);
  });

  it('parks a puck creeping diagonally, not just one on an axis', () => {
    let s = live(withPuck(initial(), { x: 300, y: 700, vx: 0.14, vy: -0.14 }));
    for (let i = 0; i < 50; i++) s = airHockey.tick?.(s, ctx(5000 + i * STEP_MS)) as AirHockeyState;
    expect(s.puck.vx).toBe(0);
    expect(s.puck.vy).toBe(0);
  });

  it('keeps the puck on the table over a long rally', () => {
    let s = live(withPuck(initial(), { x: 120, y: 240, vx: 17.5, vy: -23.25 }));
    for (let i = 0; i < 600; i++) {
      s = airHockey.tick?.(s, ctx(5000 + i * STEP_MS)) as AirHockeyState;
      expect(s.puck.x).toBeGreaterThanOrEqual(AIR_HOCKEY.PUCK_RADIUS);
      expect(s.puck.x).toBeLessThanOrEqual(AIR_HOCKEY.WIDTH - AIR_HOCKEY.PUCK_RADIUS);
      expect(s.puck.y).toBeGreaterThanOrEqual(0);
      expect(s.puck.y).toBeLessThanOrEqual(AIR_HOCKEY.HEIGHT);
    }
  });

  it('lets a swung mallet knock a resting puck away, imparting its own speed', () => {
    // Puck asleep just above the bottom mallet's reach; the mallet drives up into it.
    const s = live(
      withMallet(withPuck(initial(), { x: 300, y: 600, vx: 0, vy: 0 }), 0, { x: 300, y: 700, tx: 300, ty: 534 }),
    );
    let next = s;
    for (let i = 0; i < 20; i++) next = airHockey.tick?.(next, ctx(5000 + i * STEP_MS)) as AirHockeyState;
    // Struck upward, and faster than the mallet itself could travel.
    expect(next.puck.vy).toBeLessThan(-AIR_HOCKEY.MALLET_STEP);
    expect(next.puck.y).toBeLessThan(600);
  });

  it('never lets a collision push the puck past its speed cap', () => {
    const s = live(
      withMallet(withPuck(initial(), { x: 300, y: 620, vx: 0, vy: 29 }), 0, { x: 300, y: 700, tx: 300, ty: 534 }),
    );
    let next = s;
    for (let i = 0; i < 40; i++) {
      next = airHockey.tick?.(next, ctx(5000 + i * STEP_MS)) as AirHockeyState;
      const speed = Math.sqrt(next.puck.vx * next.puck.vx + next.puck.vy * next.puck.vy);
      expect(speed).toBeLessThanOrEqual(AIR_HOCKEY.PUCK_MAX_STEP + 0.002);
    }
  });
});

describe('air hockey goals', () => {
  it('scores for the bottom player through the top mouth and resets the table', () => {
    const s = live(withMallet(withPuck(initial(), { x: 300, y: 20, vx: 0, vy: -25 }), 0, { x: 100, y: 600 }));
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(after.scores).toEqual([1, 0]);
    expect(after.puck.x).toBe(AIR_HOCKEY.WIDTH / 2);
    expect(after.puck.y).toBe(AIR_HOCKEY.CENTER_Y);
    // Served toward whoever conceded - the top player.
    expect(after.puck.vy).toBe(-AIR_HOCKEY.SERVE_STEP);
    expect(after.mallets[0]).toEqual({ x: 300, y: 850, tx: 300, ty: 850 });
    expect(after.mallets[1]).toEqual({ x: 300, y: 150, tx: 300, ty: 150 });
    expect(after.serveAt).toBe(5000 + AIR_HOCKEY.GOAL_PAUSE_MS);
    expect(airHockey.status(after).kind).toBe(GameStatusKind.IN_PROGRESS);
  });

  it('scores for the top player through the bottom mouth', () => {
    const s = live(withPuck(initial(), { x: 300, y: AIR_HOCKEY.HEIGHT - 20, vx: 0, vy: 25 }));
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(after.scores).toEqual([0, 1]);
    expect(after.puck.vy).toBe(AIR_HOCKEY.SERVE_STEP);
  });

  it('freezes the table for the goal pause and then plays on', () => {
    const scored = airHockey.tick?.(
      live(withPuck(initial(), { x: 300, y: 20, vx: 0, vy: -25 })),
      ctx(5000),
    ) as AirHockeyState;
    const during = airHockey.tick?.(scored, ctx(6000)) as AirHockeyState;
    expect(hash(during)).toBe(hash(scored)); // nothing moved, nothing to send
    const resumed = airHockey.tick?.(scored, ctx(7100)) as AirHockeyState;
    expect(resumed.puck.y).toBeLessThan(AIR_HOCKEY.CENTER_Y);
  });

  it('wins at 7 and then refuses to simulate or accept anything', () => {
    const s: AirHockeyState = {
      ...live(withPuck(initial(), { x: 300, y: 20, vx: 0, vy: -25 })),
      scores: [AIR_HOCKEY.WIN_SCORE - 1, 3],
    };
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(after.scores).toEqual([AIR_HOCKEY.WIN_SCORE, 3]);
    expect(after.winnerIndex).toBe(0);
    const status = airHockey.status(after);
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['a']);

    // The simulation stops dead.
    expect(hash(airHockey.tick?.(after, ctx(99_000)) as AirHockeyState)).toBe(hash(after));
    // And no further aim is legal.
    const rejected = airHockey.validateAction(after, { type: 'aim', player: 'a', seq: 9, payload: { x: 1, y: 1 } }, ctx());
    expect(rejected.ok).toBe(false);
  });

  it('takes 7 goals, not 6, to win', () => {
    const s: AirHockeyState = {
      ...live(withPuck(initial(), { x: 300, y: 20, vx: 0, vy: -25 })),
      scores: [AIR_HOCKEY.WIN_SCORE - 2, 0],
    };
    const after = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(after.scores).toEqual([AIR_HOCKEY.WIN_SCORE - 1, 0]);
    expect(after.winnerIndex).toBe(-1);
    expect(airHockey.status(after).kind).toBe(GameStatusKind.IN_PROGRESS);
  });
});

describe('air hockey validation', () => {
  it('accepts an ordinary aim from either player', () => {
    const a = session('a', true);
    const b = session('b', false);
    expect(a.submitLocal('aim', { x: 300, y: 800 }).accepted).toBe(true);
    expect(b.submitLocal('aim', { x: 300, y: 200 }).accepted).toBe(true);
  });

  it('rejects an aim from somebody who is not at the table', () => {
    const s = initial();
    const r = airHockey.validateAction(s, { type: 'aim', player: 'mallory', seq: 0, payload: { x: 1, y: 1 } }, ctx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/not at this table/);
  });

  it('rejects an unknown action type', () => {
    const s = initial();
    const forged = { type: 'shove', player: 'a', seq: 0, payload: { x: 1, y: 1 } } as unknown as Parameters<
      typeof airHockey.validateAction
    >[1];
    expect(airHockey.validateAction(s, forged, ctx()).ok).toBe(false);
  });

  it('rejects a non-finite aim', () => {
    const s = initial();
    const r = airHockey.validateAction(
      s,
      { type: 'aim', player: 'a', seq: 0, payload: { x: Number.NaN, y: 0 } },
      ctx(),
    );
    expect(r.ok).toBe(false);
  });

  it('will not let a session apply an action attributed to a stranger', () => {
    const a = session('a', true);
    const wire = airHockey.encodeAction({ type: 'aim', player: 'a', seq: 0, payload: { x: 300, y: 800 } });
    const r = a.applyRemote(wire, 'mallory');
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.reason).toBe('notAPlayer');
  });

  it('attributes a forged action to whoever actually sent it', () => {
    // 'b' sends a packet claiming to be 'a'. The session credits it to 'b', so
    // it moves b's mallet - never a's.
    const a = session('a', true);
    const wire = airHockey.encodeAction({ type: 'aim', player: 'a', seq: 0, payload: { x: 400, y: 100 } });
    const r = a.applyRemote(wire, 'b');
    expect(r.accepted).toBe(true);
    expect(a.currentState.mallets[0].tx).toBe(300); // a's mallet untouched
    expect(a.currentState.mallets[1].tx).toBe(400);
  });

  it('rejects every aim once the game is over', () => {
    const won: AirHockeyState = { ...initial(), scores: [AIR_HOCKEY.WIN_SCORE, 2], winnerIndex: 0 };
    expect(airHockey.validateAction(won, { type: 'aim', player: 'a', seq: 1, payload: { x: 1, y: 1 } }, ctx()).ok).toBe(
      false,
    );
    expect(airHockey.validateAction(won, { type: 'aim', player: 'b', seq: 1, payload: { x: 1, y: 1 } }, ctx()).ok).toBe(
      false,
    );
  });

  it('rejects a duplicate action instead of applying it twice', () => {
    const a = session('a', true);
    const b = session('b', false);
    const r = a.submitLocal('aim', { x: 200, y: 700 });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = airHockey.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });
});

describe('air hockey encoding', () => {
  it('round-trips an action exactly', () => {
    const action = { type: 'aim', player: 'a', seq: 7, payload: { x: 412.4, y: 903.6 } } as const;
    const wire = decodeCbor(encodeCbor(airHockey.encodeAction(action)));
    const back = airHockey.decodeAction(wire, 'a');
    expect(back).toEqual({ type: 'aim', player: 'a', seq: 7, payload: { x: 412, y: 904 } });
    expect(toHex(encodeCbor(airHockey.encodeAction(back)))).toBe(toHex(encodeCbor(airHockey.encodeAction(back))));
  });

  it('round-trips a state bit for bit, and stays inside a Bluetooth packet', () => {
    let s = live(withPuck(initial(), { x: 137.5, y: 902.25, vx: -7.125, vy: 13.5 }));
    s = airHockey.applyAction(s, { type: 'aim', player: 'a', seq: 0, payload: { x: 511, y: 611 } }, ctx());
    s = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;

    const bytes = encodeCbor(airHockey.encodeState(s));
    expect(bytes.length).toBeLessThanOrEqual(180);
    const restored = airHockey.decodeState(decodeCbor(bytes));
    expect(restored).toEqual(s);
    expect(hash(restored)).toBe(hash(s));
  });

  it('rejects malformed actions from a hostile peer', () => {
    const junk: CborValue[] = [
      null,
      0,
      'not an action',
      [],
      {},
      { t: 'aim' },
      { t: 'aim', s: 0 },
      { t: 'shove', s: 0, p: { x: 1, y: 1 } },
      { t: 'aim', s: -1, p: { x: 1, y: 1 } },
      { t: 'aim', s: 1.5, p: { x: 1, y: 1 } },
      { t: 'aim', s: 0, p: { x: 1 } },
      { t: 'aim', s: 0, p: { x: 'left', y: 1 } },
      { t: 'aim', s: 0, p: { x: 1.5, y: 1 } },
      { t: 'aim', s: 0, p: { x: 1e12, y: -1e12 } },
      { t: 'aim', s: 0, p: [1, 2] },
      { t: 'aim', s: 0, p: new Uint8Array(8) },
      { t: 'x'.repeat(500), s: 0, p: { x: 1, y: 1 } },
    ];
    for (const value of junk) {
      expect(() => airHockey.decodeAction(value, 'a')).toThrow();
    }
  });

  it('never lets hostile bytes escape as an exception from a session', () => {
    const a = session('a', true);
    const junk: CborValue[] = [null, 0, [], {}, { t: 'aim', s: 0, p: { x: 1e12, y: 0 } }, { t: 'aim', s: 0, p: null }];
    for (const value of junk) {
      expect(() => a.applyRemote(value, 'b')).not.toThrow();
      expect(a.applyRemote(value, 'b').accepted).toBe(false);
    }
  });

  it('rejects malformed states from a hostile peer', () => {
    const good = airHockey.encodeState(initial()) as Record<string, CborValue>;
    const junk: CborValue[] = [
      null,
      'state',
      [],
      {},
      { ...good, n: ['a'] },
      { ...good, n: ['a', 5] },
      { ...good, m: [0, 0, 0, 0] },
      { ...good, m: [0, 0, 0, 0, 0, 0, 0, 9_999_999_999] },
      { ...good, m: [0, 0, 0, 0, 0, 0, 0, 'x'] },
      { ...good, k: [0, 0, 0] },
      { ...good, k: [0, 0, 0, 900_000] },
      { ...good, s: [0] },
      { ...good, s: [0, 99] },
      { ...good, w: 5 },
      { ...good, v: -1 },
      // A peer claiming a win it has not earned.
      { ...good, w: 1 },
    ];
    for (const value of junk) {
      expect(() => airHockey.decodeState(value)).toThrow();
    }
    // The honest one still decodes.
    expect(() => airHockey.decodeState(good)).not.toThrow();
  });

  it('lets a guest adopt a host snapshot', () => {
    const guest = session('b', false);
    const host = session('a', true);
    host.tick(STEP_MS * 300);
    expect(guest.applySnapshot(host.snapshot())).toBe(true);
    expect(hash(guest.currentState)).toBe(hash(host.currentState));
  });
});

describe('air hockey purity', () => {
  it('does not mutate the state handed to applyAction', () => {
    const s = initial();
    const before = hash(s);
    const next = airHockey.applyAction(s, { type: 'aim', player: 'a', seq: 0, payload: { x: 90, y: 900 } }, ctx());
    expect(hash(s)).toBe(before);
    expect(next).not.toBe(s);
    expect(next.mallets).not.toBe(s.mallets);
  });

  it('does not mutate the state handed to tick, and is a pure function of it', () => {
    const s = live(withPuck(initial(), { x: 200, y: 300, vx: 6.5, vy: -4.25 }));
    const before = hash(s);
    const one = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    const two = airHockey.tick?.(s, ctx(5000)) as AirHockeyState;
    expect(hash(s)).toBe(before);
    expect(hash(one)).toBe(hash(two));
    expect(one).toEqual(two);
  });

  it('keeps every stored number on the 3-decimal grid', () => {
    let s = live(withPuck(initial(), { x: 111.5, y: 764.25, vx: 9.125, vy: -13.375 }));
    for (let i = 0; i < 200; i++) {
      s = airHockey.applyAction(s, { type: 'aim', player: 'a', seq: i, payload: { x: 90 + i, y: 600 } }, ctx());
      s = airHockey.tick?.(s, ctx(5000 + i * STEP_MS)) as AirHockeyState;
      for (const v of [
        s.puck.x,
        s.puck.y,
        s.puck.vx,
        s.puck.vy,
        s.mallets[0].x,
        s.mallets[0].y,
        s.mallets[1].x,
        s.mallets[1].y,
      ]) {
        // Every stored number must be exactly n/1000 for some integer n, which
        // is what makes the integer wire form lossless.
        expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-6);
        expect(Object.is(v, -0)).toBe(false);
      }
    }
  });
});

describe('air hockey two-device determinism', () => {
  it('keeps two sessions byte-identical across 600 ticks of real play', () => {
    const host = session('a', true);
    const guest = session('b', false);
    let goals = 0;
    let contacts = 0;

    for (let i = 0; i < 600; i++) {
      if (i % 4 === 0 && !host.isOver) {
        // Both players chase the puck, which guarantees mallet collisions,
        // rail bounces and goals rather than an empty table.
        const puck = host.currentState.puck;
        const aimA = { x: Math.round(puck.x), y: Math.round(puck.y) + 30 };
        const ra = host.submitLocal('aim', aimA);
        expect(ra.accepted).toBe(true);
        if (ra.accepted) {
          expect(guest.applyRemote(airHockey.encodeAction(ra.applied.action), 'a').accepted).toBe(true);
        }
        const aimB = { x: Math.round(puck.x), y: Math.round(puck.y) - 30 };
        const rb = guest.submitLocal('aim', aimB);
        expect(rb.accepted).toBe(true);
        if (rb.accepted) {
          expect(host.applyRemote(airHockey.encodeAction(rb.applied.action), 'b').accepted).toBe(true);
        }
      }

      const scoresBefore = host.currentState.scores;
      host.tick(STEP_MS);
      guest.tick(STEP_MS);
      if (host.currentState.scores !== scoresBefore) goals++;
      const puck = host.currentState.puck;
      const m = host.currentState.mallets[0];
      const dx = puck.x - m.x;
      const dy = puck.y - m.y;
      if (dx * dx + dy * dy < 53 * 53) contacts++;

      expect(hash(host.currentState)).toBe(hash(guest.currentState));
    }

    // The test would be worthless if nothing had actually happened: assert the
    // rally really did involve mallet contact and at least one goal.
    expect(host.simulatedMs).toBeGreaterThan(9_000);
    expect(contacts).toBeGreaterThan(0);
    expect(goals).toBeGreaterThan(0);
    expect(host.currentState.scores[0] + host.currentState.scores[1]).toBe(goals);
    expect(hash(host.currentState)).toBe(hash(guest.currentState));
    expect(host.currentState).toEqual(guest.currentState);
  });

  it('stays in step over 40 seeds of randomised play', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const seeded = { players: ['a', 'b'], seed, options: {} };
      const host = new GameSession({ definition: airHockey, setup: seeded, localPlayer: 'a', isHost: true });
      const guest = new GameSession({ definition: airHockey, setup: seeded, localPlayer: 'b', isHost: false });
      // A cheap deterministic driver: no Math.random anywhere in this file.
      let n = seed * 2654435761;
      const next = (max: number): number => {
        n = (n * 1103515245 + 12345) % 2147483648;
        return Math.abs(n) % max;
      };
      for (let i = 0; i < 300; i++) {
        if (i % 3 === 0 && !host.isOver) {
          const ra = host.submitLocal('aim', { x: next(700) - 50, y: next(1100) - 50 });
          if (ra.accepted) guest.applyRemote(airHockey.encodeAction(ra.applied.action), 'a');
          const rb = guest.submitLocal('aim', { x: next(700) - 50, y: next(1100) - 50 });
          if (rb.accepted) host.applyRemote(airHockey.encodeAction(rb.applied.action), 'b');
        }
        host.tick(STEP_MS);
        guest.tick(STEP_MS);
      }
      expect(hash(host.currentState)).toBe(hash(guest.currentState));
      // A snapshot taken now must reproduce the host exactly on the guest.
      expect(airHockey.decodeState(decodeCbor(encodeCbor(host.snapshot())))).toEqual(host.currentState);
    }
  });
});

describe('air hockey rendering helpers', () => {
  it('flattens a state into table geometry', () => {
    const s = initial();
    const view = airHockeyView(s, 0);
    expect(view.width).toBe(600);
    expect(view.height).toBe(1000);
    expect(view.goal).toEqual({ minX: 200, maxX: 400 });
    expect(view.puck).toEqual({ x: 300, y: 500, radius: AIR_HOCKEY.PUCK_RADIUS });
    expect(view.mallets[0]).toMatchObject({ index: 0, player: 'a', half: 'bottom' });
    expect(view.mallets[1]).toMatchObject({ index: 1, player: 'b', half: 'top' });
    expect(view.countdownMs).toBe(AIR_HOCKEY.FACE_OFF_MS);
    expect(view.live).toBe(false);
    expect(airHockeyView(s, 4000).live).toBe(true);
    expect(airHockeyView(s, 4000).countdownMs).toBe(0);
    expect(airHockeyView({ ...s, winnerIndex: 1, scores: [0, 7] }, 4000).winner).toBe('b');
  });

  it('interpolates between snapshots for a guest, and snaps across a goal', () => {
    const from = live(withPuck(initial(), { x: 100, y: 200, vx: 4, vy: 2 }));
    const to = withMallet(withPuck(from, { x: 200, y: 400, vx: 6, vy: 4 }), 0, { x: 400, y: 900 });
    const mid = lerpAirHockey(from, to, 0.5);
    expect(mid.puck.x).toBe(150);
    expect(mid.puck.y).toBe(300);
    expect(mid.mallets[0].x).toBe(350);
    expect(lerpAirHockey(from, to, -1).puck.x).toBe(100);
    expect(lerpAirHockey(from, to, 2).puck.x).toBe(200);

    const scored: AirHockeyState = { ...to, scores: [1, 0] };
    expect(lerpAirHockey(from, scored, 0.5)).toEqual(scored);
  });
});

describe('air hockey conformance', () => {
  // NOTE: runConformance replays the action log through GameSession.replay,
  // which applies actions but never ticks, then requires the replayed state to
  // equal the live one. For a realtime game that only holds while the ticks it
  // performed were no-ops - so the suite is run inside the opening face-off
  // (maxPlies ticks at 60Hz = 1.67s, comfortably under FACE_OFF_MS = 3s).
  // Physics determinism is covered by the two-session tests above instead.
  const hooks = {
    legalAction: (state: AirHockeyState, player: string, random: { nextInt(max: number): number }) => {
      const index = state.players[0] === player ? 0 : 1;
      const y = index === 0 ? AIR_HOCKEY.CENTER_Y + random.nextInt(500) : random.nextInt(500);
      return { type: 'aim', payload: { x: random.nextInt(601), y } as CborValue };
    },
    maxPlies: 100,
  };

  it('passes the shared game conformance suite', () => {
    const report = runConformance(airHockey, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.playedPlies).toBe(100);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(airHockey, hooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
    }
  });
});
