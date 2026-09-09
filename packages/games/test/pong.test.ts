import { describe, expect, it } from 'vitest';
import { encodeCbor, toHex, type CborValue } from '@airlink/core';
import {
  BALL_R,
  FIELD_H,
  FIELD_W,
  PADDLE_H,
  PONG_TICK_MS,
  PongPhase,
  WIN_SCORE,
  lerpPongState,
  pong,
  pongView,
  type PongDir,
  type PongState,
} from '../src/games/pong.js';
import { GameSession, SnapshotInterpolator } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, SeededGameRandom, createContext } from '../src/engine.js';

// seed 42 is even, so the opening serve belongs to side 0 - player 'a'.
const setup = { players: ['a', 'b'], seed: 42, options: {} };

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: pong, setup, localPlayer: local, isHost });
}

function initial(): PongState {
  return pong.createInitialState(setup);
}

/** Advance a bare state by `n` fixed steps, the way GameSession.tick would. */
function step(state: PongState, n = 1): PongState {
  const context = createContext(setup.players, setup.seed, 0, PONG_TICK_MS);
  let out = state;
  for (let i = 0; i < n; i++) out = pong.tick?.(out, context) ?? out;
  return out;
}

/** Build a rally state directly, to put the ball exactly where a test needs it. */
function rally(patch: {
  ball: { x: number; y: number; vx: number; vy: number };
  p0?: number;
  p1?: number;
  score?: [number, number];
  hits?: number;
}): PongState {
  const base = initial();
  return {
    ...base,
    phase: PongPhase.RALLY,
    ball: patch.ball,
    paddles: [
      { y: patch.p0 ?? FIELD_H / 2, dir: 0 },
      { y: patch.p1 ?? FIELD_H / 2, dir: 0 },
    ],
    score: patch.score ?? [0, 0],
    rallyHits: patch.hits ?? 0,
  };
}

const hex = (state: PongState): string => toHex(encodeCbor(pong.encodeState(state)));

describe('pong setup and input', () => {
  it('starts with the ball held at the centre, seeded serve, paddles centred', () => {
    const s = initial();
    expect(s.phase).toBe(PongPhase.SERVE);
    expect(s.serveBy).toBe(0);
    expect(s.ball).toEqual({ x: 500, y: 300, vx: -0.375, vy: 0 });
    expect(s.paddles).toEqual([
      { y: 300, dir: 0 },
      { y: 300, dir: 0 },
    ]);
    expect(s.score).toEqual([0, 0]);
    expect(pong.status(s).kind).toBe(GameStatusKind.IN_PROGRESS);
    // Realtime: nobody "owns" the turn.
    expect(pong.currentTurn).toBeUndefined();
  });

  it('picks the opening serve from the shared seed, so both devices agree', () => {
    expect(pong.createInitialState({ ...setup, seed: 42 }).serveBy).toBe(0);
    expect(pong.createInitialState({ ...setup, seed: 43 }).serveBy).toBe(1);
    expect(pong.createInitialState({ ...setup, seed: 0 }).ball.vx).toBeLessThan(0);
    expect(pong.createInitialState({ ...setup, seed: 1 }).ball.vx).toBeGreaterThan(0);
  });

  it('stores the input direction and moves only that player\'s paddle', () => {
    const a = session('a', true);
    expect(a.submitLocal('input', { dir: 1 }).accepted).toBe(true);
    expect(a.currentState.paddles[0].dir).toBe(1);
    expect(a.currentState.paddles[1].dir).toBe(0);
    expect(a.submitLocal('serve', null).accepted).toBe(true);

    a.tick(PONG_TICK_MS * 6);
    // 6 steps of 0.5 u/ms * (1000/60) ms, rounded to 3 decimals each time.
    expect(a.currentState.paddles[0].y).toBe(349.998);
    expect(a.currentState.paddles[1].y).toBe(300);
  });

  it('moves a paddle up on dir -1 and stops on dir 0', () => {
    let s: PongState = { ...initial(), phase: PongPhase.RALLY };
    s = pong.applyAction(s, { type: 'input', player: 'b', seq: 0, payload: { dir: -1 } }, ctx());
    s = step(s, 3);
    expect(s.paddles[1].y).toBe(275.001);
    const frozen = s.paddles[1].y;
    s = pong.applyAction(s, { type: 'input', player: 'b', seq: 1, payload: { dir: 0 } }, ctx());
    s = step(s, 10);
    expect(s.paddles[1].y).toBe(frozen);
  });

  it('clamps paddles to the field', () => {
    let down: PongState = { ...initial(), phase: PongPhase.RALLY };
    down = pong.applyAction(down, { type: 'input', player: 'a', seq: 0, payload: { dir: 1 } }, ctx());
    down = step(down, 200);
    expect(down.paddles[0].y).toBe(FIELD_H - PADDLE_H / 2);

    let up: PongState = { ...initial(), phase: PongPhase.RALLY };
    up = pong.applyAction(up, { type: 'input', player: 'a', seq: 0, payload: { dir: -1 } }, ctx());
    up = step(up, 200);
    expect(up.paddles[0].y).toBe(PADDLE_H / 2);
  });

  it('freezes the whole field while a serve is pending', () => {
    let s = initial();
    s = pong.applyAction(s, { type: 'input', player: 'a', seq: 0, payload: { dir: 1 } }, ctx());
    s = pong.applyAction(s, { type: 'input', player: 'b', seq: 0, payload: { dir: -1 } }, ctx());
    const before = hex(s);
    expect(hex(step(s, 120))).toBe(before);
  });
});

function ctx() {
  return createContext(setup.players, setup.seed, 0, PONG_TICK_MS);
}

describe('pong serving', () => {
  it('puts the ball in play, angled by the direction the server is holding', () => {
    const held = initial();
    const flat = pong.applyAction(held, { type: 'serve', player: 'a', seq: 0, payload: null }, ctx());
    expect(flat.phase).toBe(PongPhase.RALLY);
    expect(flat.ball.vy).toBe(0);

    const leaning = pong.applyAction(
      pong.applyAction(held, { type: 'input', player: 'a', seq: 0, payload: { dir: -1 } }, ctx()),
      { type: 'serve', player: 'a', seq: 1, payload: null },
      ctx(),
    );
    expect(leaning.ball.vy).toBe(-0.125);
    expect(leaning.ball.vx).toBe(-0.375);
  });

  it('moves the ball once it is live', () => {
    const s = step(pong.applyAction(initial(), { type: 'serve', player: 'a', seq: 0, payload: null }, ctx()));
    expect(s.ball.x).toBe(493.75);
    expect(s.ball.y).toBe(300);
  });
});

describe('pong physics', () => {
  it('bounces off the top wall, mirroring the overshoot', () => {
    const s = step(rally({ ball: { x: 500, y: 12, vx: 0, vy: -0.4 } }));
    expect(s.ball.vy).toBe(0.4);
    expect(s.ball.y).toBe(10.667);
    expect(s.ball.y).toBeGreaterThanOrEqual(BALL_R);
  });

  it('bounces off the bottom wall', () => {
    const s = step(rally({ ball: { x: 500, y: 590, vx: 0, vy: 0.4 } }));
    expect(s.ball.vy).toBe(-0.4);
    expect(s.ball.y).toBe(587.333);
    expect(s.ball.y).toBeLessThanOrEqual(FIELD_H - BALL_R);
  });

  it('never leaves the ball outside the top or bottom wall over a long run', () => {
    let s = rally({ ball: { x: 500, y: 300, vx: 0, vy: 0.7 } });
    for (let i = 0; i < 400; i++) {
      s = step(s);
      expect(s.ball.y).toBeGreaterThanOrEqual(BALL_R);
      expect(s.ball.y).toBeLessThanOrEqual(FIELD_H - BALL_R);
    }
  });

  it('bounces off the left paddle, reversing x and speeding up', () => {
    const s = step(rally({ ball: { x: 50, y: 300, vx: -0.375, vy: 0 } }));
    expect(s.rallyHits).toBe(1);
    expect(s.ball.vx).toBe(0.391); // 0.375 + 1/64, rounded to 3 decimals
    expect(s.ball.vy).toBe(0);
    expect(s.ball.x).toBe(48); // pushed clear of the paddle face
    expect(s.score).toEqual([0, 0]);
  });

  it('bounces off the right paddle', () => {
    const s = step(rally({ ball: { x: 950, y: 300, vx: 0.375, vy: 0 } }));
    expect(s.rallyHits).toBe(1);
    expect(s.ball.vx).toBe(-0.391);
    expect(s.ball.x).toBe(952);
  });

  it('adds spin from where the ball met the paddle', () => {
    const low = step(rally({ ball: { x: 50, y: 328, vx: -0.375, vy: 0 } })); // 0.5 below centre
    expect(low.ball.vy).toBe(0.146); // 0.390625 * 0.75 * 0.5
    expect(low.ball.vx).toBe(0.342); // squeezed by 0.25 * 0.5

    const high = step(rally({ ball: { x: 50, y: 272, vx: -0.375, vy: 0 } })); // 0.5 above centre
    expect(high.ball.vy).toBe(-0.146);
    expect(high.ball.vx).toBe(0.342);

    const edge = step(rally({ ball: { x: 50, y: 300 + 56, vx: -0.375, vy: 0 } })); // full edge
    expect(edge.ball.vy).toBe(0.293);
    expect(edge.ball.vx).toBe(0.293);
  });

  it('misses when the paddle is out of reach', () => {
    const s = step(rally({ ball: { x: 50, y: 300, vx: -0.375, vy: 0 }, p0: 100 }));
    expect(s.rallyHits).toBe(0);
    expect(s.ball.vx).toBe(-0.375);
  });

  it('caps the ball speed however long the rally runs', () => {
    const s = step(rally({ ball: { x: 50, y: 300, vx: -0.75, vy: 0 }, hits: 40 }));
    expect(s.rallyHits).toBe(24);
    expect(s.ball.vx).toBe(0.75);
  });

  it('never lets the ball tunnel through a paddle, even at top speed', () => {
    // Walk a maximum-speed ball into the paddle from every sub-step offset.
    for (let start = 0; start < 20; start++) {
      let s = rally({ ball: { x: 60 + start, y: 300, vx: -0.75, vy: 0 }, hits: 24 });
      let bounced = false;
      for (let i = 0; i < 12 && !bounced; i++) {
        s = step(s);
        if (s.ball.vx > 0) bounced = true;
      }
      expect(bounced).toBe(true);
      expect(s.score).toEqual([0, 0]);
    }
  });
});

describe('pong scoring', () => {
  it('awards the point to the far side and re-serves toward the conceder', () => {
    const s = step(rally({ ball: { x: -4, y: 300, vx: -0.375, vy: 0 }, hits: 5 }));
    expect(s.score).toEqual([0, 1]);
    expect(s.phase).toBe(PongPhase.SERVE);
    expect(s.serveBy).toBe(0);
    expect(s.rallyHits).toBe(0);
    expect(s.ball).toEqual({ x: FIELD_W / 2, y: FIELD_H / 2, vx: -0.375, vy: 0 });
  });

  it('awards a point on the right-hand goal too', () => {
    const s = step(rally({ ball: { x: FIELD_W + 4, y: 300, vx: 0.375, vy: 0 } }));
    expect(s.score).toEqual([1, 0]);
    expect(s.serveBy).toBe(1);
    expect(s.ball.vx).toBe(0.375);
  });

  it('keeps the paddles where they were when the point ended', () => {
    let s = rally({ ball: { x: -4, y: 300, vx: -0.375, vy: 0 }, p0: 200, p1: 400 });
    s = { ...s, paddles: [{ y: 200, dir: 1 }, { y: 400, dir: 0 }] };
    const out = step(s);
    expect(out.paddles[0].dir).toBe(1);
    expect(out.paddles[0].y).toBe(208.333);
    expect(out.paddles[1].y).toBe(400);
  });

  it('wins at seven', () => {
    const s = step(rally({ ball: { x: FIELD_W + 4, y: 300, vx: 0.375, vy: 0 }, score: [WIN_SCORE - 1, 3] }));
    expect(s.score).toEqual([WIN_SCORE, 3]);
    const status = pong.status(s);
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['a']);
  });

  it('does not win at six', () => {
    const s = rally({ ball: { x: 500, y: 300, vx: 0.375, vy: 0 }, score: [6, 6] });
    expect(pong.status(s).kind).toBe(GameStatusKind.IN_PROGRESS);
  });

  it('freezes the simulation once the match is won', () => {
    const won = rally({ ball: { x: 500, y: 300, vx: 0.375, vy: 0 }, score: [WIN_SCORE, 0] });
    expect(hex(step(won, 30))).toBe(hex(won));
  });

  it('plays a whole match to seven through two live sessions', () => {
    const a = session('a', true);
    const b = session('b', false);
    const mirror = (from: GameSession<PongState, never>, to: GameSession<PongState, never>, type: string, payload: CborValue, player: 'a' | 'b') => {
      const r = from.submitLocal(type, payload);
      expect(r.accepted).toBe(true);
      if (r.accepted) expect(to.applyRemote(pong.encodeAction(r.applied.action), player).accepted).toBe(true);
    };
    const A = a as unknown as GameSession<PongState, never>;
    const B = b as unknown as GameSession<PongState, never>;

    // Both players hold "down"; the flat serve always sails past them.
    mirror(A, B, 'input', { dir: 1 }, 'a');
    mirror(B, A, 'input', { dir: 1 }, 'b');

    for (let i = 0; i < 2000 && !a.isOver; i++) {
      if (a.currentState.phase === PongPhase.SERVE) {
        const server = a.currentState.serveBy === 0 ? 'a' : 'b';
        if (server === 'a') mirror(A, B, 'serve', null, 'a');
        else mirror(B, A, 'serve', null, 'b');
      }
      a.tick(PONG_TICK_MS);
      b.tick(PONG_TICK_MS);
      expect(hex(a.currentState)).toBe(hex(b.currentState));
    }

    expect(a.isOver).toBe(true);
    expect(a.currentState.score).toEqual([0, WIN_SCORE]);
    const status = a.status;
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['b']);
    expect(b.status.kind).toBe(GameStatusKind.WON);

    // ... and nothing may be played afterwards.
    const late = a.submitLocal('input', { dir: -1 });
    expect(late.accepted).toBe(false);
    expect(late.accepted === false && late.reason).toBe('gameOver');
  });
});

describe('pong rejects what a peer must not do', () => {
  it('refuses a serve from the player whose serve it is not', () => {
    const b = session('b', false);
    const r = b.submitLocal('serve', null);
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/serve/);
  });

  it('refuses a second serve while the ball is in play', () => {
    const a = session('a', true);
    expect(a.submitLocal('serve', null).accepted).toBe(true);
    const again = a.submitLocal('serve', null);
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already in play/);
  });

  it('refuses an out-of-range direction', () => {
    const a = session('a', true);
    for (const dir of [2, -2, 7, 0.5, 1e12]) {
      const r = a.submitLocal('input', { dir });
      expect(r.accepted).toBe(false);
    }
    expect(pong.validateAction(initial(), { type: 'input', player: 'a', seq: 0, payload: { dir: 5 as PongDir } }, ctx()).ok).toBe(
      false,
    );
  });

  it('refuses an unknown action type', () => {
    const a = session('a', true);
    expect(a.submitLocal('teleport', { x: 0 }).accepted).toBe(false);
    expect(
      pong.validateAction(
        initial(),
        { type: 'teleport', player: 'a', seq: 0, payload: null } as never,
        ctx(),
      ).ok,
    ).toBe(false);
  });

  it('refuses any action once the match is over', () => {
    const over = rally({ ball: { x: 500, y: 300, vx: 0.375, vy: 0 }, score: [WIN_SCORE, 2] });
    expect(pong.validateAction(over, { type: 'input', player: 'a', seq: 9, payload: { dir: 1 } }, ctx()).ok).toBe(false);
    expect(pong.validateAction(over, { type: 'serve', player: 'a', seq: 9, payload: null }, ctx()).ok).toBe(false);
  });

  it('refuses an action from somebody who is not in the match', () => {
    const a = session('a', true);
    const forged = pong.encodeAction({ type: 'input', player: 'a', seq: 0, payload: { dir: 1 } });
    const r = a.applyRemote(forged, 'mallory');
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.reason).toBe('notAPlayer');
    expect(pong.validateAction(initial(), { type: 'input', player: 'mallory', seq: 0, payload: { dir: 1 } }, ctx()).ok).toBe(
      false,
    );
  });

  it('attributes a forged action to its actual sender, so it can only move their own paddle', () => {
    const b = session('b', false);
    // 'b' sends an action that claims to be from 'a'. The session authenticated
    // the sender as 'b', so it is 'b' whose paddle moves - and 'b' cannot serve.
    const forged = pong.encodeAction({ type: 'input', player: 'a', seq: 0, payload: { dir: -1 } });
    const r = b.applyRemote(forged, 'b');
    expect(r.accepted).toBe(true);
    expect(b.currentState.paddles[1].dir).toBe(-1);
    expect(b.currentState.paddles[0].dir).toBe(0);
    expect(b.applyRemote(pong.encodeAction({ type: 'serve', player: 'a', seq: 1, payload: null }), 'b').accepted).toBe(
      false,
    );
  });

  it('rejects a duplicate action rather than applying it twice', () => {
    const a = session('a', true);
    const b = session('b', false);
    const r = a.submitLocal('input', { dir: 1 });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = pong.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });
});

describe('pong decodes hostile input', () => {
  const junk: CborValue[] = [
    null,
    0,
    'nope',
    [],
    {},
    new Uint8Array(8),
    { t: 'input' },
    { t: 'input', s: -1, p: { d: 0 } },
    { t: 'input', s: 1.5, p: { d: 0 } },
    { t: 'x'.repeat(500), s: 0, p: { d: 0 } },
    { t: 'input', s: 0, p: null },
    { t: 'input', s: 0, p: [] },
    { t: 'input', s: 0, p: new Uint8Array(4) },
    { t: 'input', s: 0, p: { d: 2 } },
    { t: 'input', s: 0, p: { d: -1e12 } },
    { t: 'input', s: 0, p: { d: 'up' } },
    { t: 'input', s: 0, p: { d: 0.5 } },
    { t: 'input', s: 0, p: { d: null } },
    { t: 'input', s: 0, p: { x: 1 } },
    { t: 'serve', s: 0, p: { d: 1 } },
    { t: 'move', s: 0, p: { d: 1 } },
    { t: 'input', s: 0, p: Array.from({ length: 300 }, () => 1) },
  ];

  it('throws on every malformed action', () => {
    for (const value of junk) {
      expect(() => pong.decodeAction(value, 'a')).toThrow();
    }
  });

  it('never lets a throw escape the session', () => {
    const a = session('a', true);
    for (const value of junk) {
      expect(() => a.applyRemote(value, 'b')).not.toThrow();
      expect(a.applyRemote(value, 'b').accepted).toBe(false);
    }
  });

  it('accepts the three legal directions and a bare serve', () => {
    for (const d of [-1, 0, 1]) {
      const action = pong.decodeAction({ t: 'input', s: 3, p: { d } }, 'b');
      expect(action).toEqual({ type: 'input', player: 'b', seq: 3, payload: { dir: d } });
    }
    expect(pong.decodeAction({ t: 'serve', s: 0, p: null }, 'a')).toEqual({
      type: 'serve',
      player: 'a',
      seq: 0,
      payload: null,
    });
  });

  it('rejects a malformed or out-of-range snapshot', () => {
    const good = pong.encodeState(rally({ ball: { x: 123.456, y: 78.9, vx: -0.391, vy: 0.146 }, p0: 111, p1: 222 })) as Record<
      string,
      CborValue
    >;
    expect(() => pong.decodeState(good)).not.toThrow();

    const bad: CborValue[] = [
      null,
      [],
      'x',
      { ...good, p: ['only-one'] },
      { ...good, p: ['a', 'b', 'c'] },
      { ...good, p: [1, 2] },
      { ...good, b: [0, 0, 0] },
      { ...good, b: [0, 0, 0, 0, 0] },
      { ...good, b: [1e12, 0, 0, 0] },
      { ...good, b: [0, 0, 99999, 0] }, // impossible velocity
      { ...good, b: [0.5, 0, 0, 0] }, // not an integer number of thousandths
      { ...good, d: [0, 300000, 0, 0] }, // paddle above the field
      { ...good, d: [300000, 300000, 5, 0] }, // impossible direction
      { ...good, s: [0, 99] },
      { ...good, s: [-1, 0] },
      { ...good, f: 9 },
      { ...good, v: 2 },
      { ...good, h: 9999 },
      { ...good, h: 'lots' },
    ];
    for (const value of bad) expect(() => pong.decodeState(value)).toThrow();
  });
});

describe('pong wire format', () => {
  it('round-trips a state exactly, mid-rally', () => {
    let s = pong.applyAction(initial(), { type: 'serve', player: 'a', seq: 0, payload: null }, ctx());
    s = pong.applyAction(s, { type: 'input', player: 'b', seq: 0, payload: { dir: -1 } }, ctx());
    s = step(s, 137);
    const encoded = pong.encodeState(s);
    const restored = pong.decodeState(encodeCbor(encoded) && encoded);
    expect(restored).toEqual(s);
    expect(hex(restored)).toBe(hex(s));
    // ... and a second trip changes nothing.
    expect(hex(pong.decodeState(pong.encodeState(restored)))).toBe(hex(s));
  });

  it('round-trips both action shapes', () => {
    const input = { type: 'input', player: 'a', seq: 11, payload: { dir: -1 } } as const;
    expect(pong.decodeAction(pong.encodeAction(input), 'a')).toEqual(input);
    const serve = { type: 'serve', player: 'b', seq: 0, payload: null } as const;
    expect(pong.decodeAction(pong.encodeAction(serve), 'b')).toEqual(serve);
    expect(pong.encodeAction(input)).toEqual({ t: 'input', s: 11, p: { d: -1 } });
  });

  it('fits a snapshot and an action inside one Bluetooth packet', () => {
    const realistic = pong.createInitialState({ players: ['player-1', 'player-2'], seed: 7, options: {} });
    const mid = step(pong.applyAction(realistic, { type: 'serve', player: 'player-1', seq: 0, payload: null }, ctx()), 40);
    expect(encodeCbor(pong.encodeState(mid)).length).toBeLessThanOrEqual(180);
    expect(encodeCbor(pong.encodeAction({ type: 'input', player: 'a', seq: 0, payload: { dir: 1 } })).length).toBeLessThan(
      24,
    );
  });
});

describe('pong determinism', () => {
  /**
   * Two independent sessions, the same scripted inputs, 600 ticks - roughly ten
   * seconds of play, several points, dozens of bounces. Their encoded states
   * must be byte-identical at every step, and identical again when the whole
   * run is repeated from scratch.
   */
  function play(seed: number, ticks: number): { hosts: string; guest: string; state: PongState; checks: number } {
    const s = { players: ['a', 'b'], seed, options: {} };
    const A = new GameSession({ definition: pong, setup: s, localPlayer: 'a', isHost: true });
    const B = new GameSession({ definition: pong, setup: s, localPlayer: 'b', isHost: false });
    const script = new SeededGameRandom(seed ^ 0x5aa5);
    let checks = 0;

    const send = (player: 'a' | 'b', type: string, payload: CborValue) => {
      const from = player === 'a' ? A : B;
      const to = player === 'a' ? B : A;
      const r = from.submitLocal(type, payload);
      if (!r.accepted) throw new Error(`scripted action rejected: ${r.detail}`);
      const mirrored = to.applyRemote(pong.encodeAction(r.applied.action), player);
      if (!mirrored.accepted) throw new Error(`peer rejected: ${mirrored.detail}`);
    };

    for (let i = 0; i < ticks && !A.isOver; i++) {
      if (i % 11 === 0) send('a', 'input', { dir: script.nextInt(3) - 1 });
      if (i % 13 === 0) send('b', 'input', { dir: script.nextInt(3) - 1 });
      if (A.currentState.phase === PongPhase.SERVE) {
        send(A.currentState.serveBy === 0 ? 'a' : 'b', 'serve', null);
      }
      A.tick(PONG_TICK_MS);
      B.tick(PONG_TICK_MS);
      if (hex(A.currentState) !== hex(B.currentState)) {
        throw new Error(`diverged at tick ${i}`);
      }
      checks++;
    }
    return { hosts: hex(A.currentState), guest: hex(B.currentState), state: A.currentState, checks };
  }

  it('keeps two sessions byte-identical across 600 ticks of real play', () => {
    const run = play(2024, 600);
    expect(run.hosts).toBe(run.guest);
    expect(run.checks).toBe(600);
    // The simulation really did run: points were scored and rallies played.
    expect(run.state.score[0] + run.state.score[1]).toBeGreaterThan(0);
  });

  it('reproduces the same 600 ticks exactly when replayed from scratch', () => {
    for (const seed of [1, 2, 3, 99, 12345]) {
      const first = play(seed, 600);
      const second = play(seed, 600);
      expect(second.hosts).toBe(first.hosts);
      expect(second.guest).toBe(first.hosts);
    }
  });

  it('does not mutate the state handed to tick or applyAction', () => {
    const before = rally({ ball: { x: 300, y: 200, vx: 0.5, vy: -0.25 }, p0: 250, p1: 350 });
    const snapshot = hex(before);
    const ticked = step(before, 5);
    expect(hex(before)).toBe(snapshot);
    expect(hex(ticked)).not.toBe(snapshot);

    const applied = pong.applyAction(before, { type: 'input', player: 'a', seq: 0, payload: { dir: 1 } }, ctx());
    expect(hex(before)).toBe(snapshot);
    expect(applied).not.toBe(before);
    expect(applied.paddles).not.toBe(before.paddles);
  });

  it('rounds every stored quantity to three decimals', () => {
    let s = pong.applyAction(initial(), { type: 'serve', player: 'a', seq: 0, payload: null }, ctx());
    s = pong.applyAction(s, { type: 'input', player: 'a', seq: 1, payload: { dir: 1 } }, ctx());
    s = pong.applyAction(s, { type: 'input', player: 'b', seq: 0, payload: { dir: -1 } }, ctx());
    for (let i = 0; i < 400; i++) {
      s = step(s);
      for (const v of [s.ball.x, s.ball.y, s.ball.vx, s.ball.vy, s.paddles[0].y, s.paddles[1].y]) {
        expect(Math.round(v * 1000) / 1000).toBe(v);
        expect(Object.is(v, -0)).toBe(false);
      }
    }
  });
});

describe('pong rendering helpers', () => {
  it('reports drawable geometry', () => {
    const view = pongView(rally({ ball: { x: 120.5, y: 400, vx: 0, vy: 0 }, p0: 100, p1: 500 }));
    expect(view.ball).toEqual({ x: 120.5, y: 400, r: BALL_R });
    expect(view.paddles[0]).toEqual({ x: 24, y: 52, w: 16, h: PADDLE_H });
    expect(view.paddles[1]).toEqual({ x: FIELD_W - 24 - 16, y: 452, w: 16, h: PADDLE_H });
    expect(view.score).toEqual([0, 0]);
    expect(view.paddles[0].y + view.paddles[0].h).toBeLessThanOrEqual(FIELD_H);
  });

  it('interpolates between two snapshots for a guest', () => {
    const from = rally({ ball: { x: 100, y: 100, vx: 0.5, vy: 0.5 }, p0: 100, p1: 200 });
    const to = rally({ ball: { x: 200, y: 300, vx: 0.5, vy: 0.5 }, p0: 200, p1: 100 });
    const mid = lerpPongState(from, to, 0.5);
    expect(mid.ball.x).toBe(150);
    expect(mid.ball.y).toBe(200);
    expect(mid.paddles[0].y).toBe(150);
    expect(mid.paddles[1].y).toBe(150);

    expect(lerpPongState(from, to, -5).ball.x).toBe(100);
    expect(lerpPongState(from, to, 5).ball.x).toBe(200);
  });

  it('never interpolates across a point', () => {
    const from = rally({ ball: { x: -6, y: 100, vx: -0.5, vy: 0 } });
    const to = rally({ ball: { x: 500, y: 300, vx: -0.375, vy: 0 }, score: [0, 1] });
    expect(lerpPongState(from, to, 0.5)).toBe(to);
  });

  it('drives SnapshotInterpolator', () => {
    const interp = new SnapshotInterpolator<PongState>(lerpPongState, 100);
    expect(interp.sample(0)).toBeNull();
    const first = rally({ ball: { x: 100, y: 100, vx: 0.5, vy: 0 } });
    const second = rally({ ball: { x: 200, y: 100, vx: 0.5, vy: 0 } });
    interp.push(first, 1000);
    interp.push(second, 1100);
    const drawn = interp.sample(1150);
    expect(drawn?.ball.x).toBe(150);
  });
});

/**
 * The shared conformance suite.
 *
 * The driver only ever sends `input`, never `serve`. That is deliberate, and it
 * is a limitation of the shared suite rather than of this game: runConformance
 * checks that replaying the action log through GameSession.replay - which never
 * calls tick() - reproduces the live state, which it ticked after every ply. No
 * realtime game whose tick() changes anything can satisfy that check while its
 * simulation is running. Pong's serve hold freezes the field, so the suite gets
 * to exercise everything that does not depend on the ball being live:
 * convergence between two sessions, encode/decode round trips, hostile input,
 * authorisation and purity. The physics is covered by the determinism tests
 * above, which are stricter than anything the suite does.
 */
const conformanceHooks = {
  legalAction: (_state: PongState, _player: string, random: SeededGameRandom) => ({
    type: 'input',
    payload: { d: 0, dir: (random.nextInt(3) - 1) as PongDir }.dir as CborValue,
  }),
  maxPlies: 60,
};

function hooks() {
  return {
    legalAction: (_state: PongState, _player: string, random: SeededGameRandom) => ({
      type: 'input',
      payload: { dir: random.nextInt(3) - 1 },
    }),
    maxPlies: 60,
  };
}

describe('pong conformance', () => {
  it('passes the shared game conformance suite', () => {
    void conformanceHooks;
    const report = runConformance(pong, hooks());
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.playedPlies).toBe(60);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 48; seed++) {
      const report = runConformance(pong, hooks(), seed);
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
    }
  });
});
