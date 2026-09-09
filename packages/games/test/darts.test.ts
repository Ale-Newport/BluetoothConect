import { describe, expect, it } from 'vitest';
import { decodeCbor, encodeCbor, type CborValue } from '@airlink/core';
import {
  BOARD_RADIUS,
  DARTS_PER_TURN,
  DartRing,
  SECTOR_ORDER,
  START_SCORE,
  aimPoint,
  darts,
  scoreDart,
  type DartsAction,
  type DartsState,
} from '../src/games/darts.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** An action payload aiming at the centre of a bed. Accuracy 1 always lands there. */
function aim(sector: number, ring: DartRing, accuracy = 1): { targetX: number; targetY: number; accuracy: number } {
  const point = aimPoint(sector, ring);
  return { targetX: point.x, targetY: point.y, accuracy };
}

type Table = {
  readonly setup: { players: string[]; seed: number; options: Record<string, CborValue> };
  readonly sessions: readonly GameSession<DartsState, DartsAction>[];
  /** Throw a dart and mirror it to every other device, exactly as the link would. */
  readonly throwDart: (player: string, payload: CborValue) => ReturnType<GameSession<DartsState, DartsAction>['submitLocal']>;
  readonly host: GameSession<DartsState, DartsAction>;
  readonly stateOf: (player: string) => DartsState;
};

function table(options: Record<string, CborValue> = {}, players = ['a', 'b'], seed = 42): Table {
  const setup = { players, seed, options };
  const sessions = players.map(
    (p, i) => new GameSession<DartsState, DartsAction>({ definition: darts, setup, localPlayer: p, isHost: i === 0 }),
  );
  const throwDart = (player: string, payload: CborValue) => {
    const index = players.indexOf(player);
    const from = sessions[index] as GameSession<DartsState, DartsAction>;
    const outcome = from.submitLocal('throw', payload);
    if (outcome.accepted) {
      const wire = decodeCbor(encodeCbor(darts.encodeAction(outcome.applied.action)));
      for (let j = 0; j < sessions.length; j++) {
        if (j === index) continue;
        const peer = sessions[j] as GameSession<DartsState, DartsAction>;
        expect(peer.applyRemote(wire, player).accepted).toBe(true);
      }
    }
    return outcome;
  };
  return {
    setup,
    sessions,
    throwDart,
    host: sessions[0] as GameSession<DartsState, DartsAction>,
    stateOf: (player: string) => (sessions[players.indexOf(player)] as GameSession<DartsState, DartsAction>).currentState,
  };
}

function scoreOf(state: DartsState, player: string): number {
  return state.scores[state.players.indexOf(player)] as number;
}

// ---------------------------------------------------------------------------
// the board
// ---------------------------------------------------------------------------

describe('darts board', () => {
  it('places the twenty numbers in the real order, clockwise from 20 at the top', () => {
    expect(SECTOR_ORDER).toEqual([20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]);
    // 20 up, 6 right, 3 down, 11 left - the four landmarks on a real board.
    expect(scoreDart(0, 140).sector).toBe(20);
    expect(scoreDart(140, 0).sector).toBe(6);
    expect(scoreDart(0, -140).sector).toBe(3);
    expect(scoreDart(-140, 0).sector).toBe(11);
  });

  it('maps every known sector angle to the right number', () => {
    for (let i = 0; i < SECTOR_ORDER.length; i++) {
      const sector = SECTOR_ORDER[i] as number;
      // Centre of the bed, and a point either side of it but inside the same arc.
      for (const offsetDegrees of [-8, 0, 8]) {
        const degrees = 90 - 18 * i + offsetDegrees;
        const radians = (degrees * Math.PI) / 180;
        const x = Math.round(Math.cos(radians) * 134);
        const y = Math.round(Math.sin(radians) * 134);
        const hit = scoreDart(x, y);
        expect(hit.sector).toBe(sector);
        expect(hit.ring).toBe(DartRing.SINGLE);
        expect(hit.points).toBe(sector);
      }
    }
  });

  it('scores a double as twice the sector and a treble as three times', () => {
    for (const sector of SECTOR_ORDER) {
      const double = aimPoint(sector, DartRing.DOUBLE);
      expect(scoreDart(double.x, double.y)).toEqual({ points: sector * 2, ring: DartRing.DOUBLE, sector });
      const treble = aimPoint(sector, DartRing.TREBLE);
      expect(scoreDart(treble.x, treble.y)).toEqual({ points: sector * 3, ring: DartRing.TREBLE, sector });
    }
  });

  it('scores both bulls', () => {
    expect(scoreDart(0, 0)).toEqual({ points: 50, ring: DartRing.INNER_BULL, sector: 25 });
    expect(scoreDart(6, 0)).toEqual({ points: 50, ring: DartRing.INNER_BULL, sector: 25 });
    expect(scoreDart(0, -6)).toEqual({ points: 50, ring: DartRing.INNER_BULL, sector: 25 });
    // Just outside 6.35mm is the 25, just outside 15.9mm is an ordinary single.
    expect(scoreDart(7, 0)).toEqual({ points: 25, ring: DartRing.OUTER_BULL, sector: 25 });
    expect(scoreDart(15, 0)).toEqual({ points: 25, ring: DartRing.OUTER_BULL, sector: 25 });
    expect(scoreDart(16, 0)).toEqual({ points: 6, ring: DartRing.SINGLE, sector: 6 });
  });

  it('classifies the ring boundaries the same way every time', () => {
    expect(scoreDart(98, 0).ring).toBe(DartRing.SINGLE);
    expect(scoreDart(99, 0)).toEqual({ points: 18, ring: DartRing.TREBLE, sector: 6 }); // 3 x 6
    expect(scoreDart(107, 0).ring).toBe(DartRing.TREBLE);
    expect(scoreDart(108, 0).ring).toBe(DartRing.SINGLE);
    expect(scoreDart(161, 0).ring).toBe(DartRing.SINGLE);
    expect(scoreDart(162, 0)).toEqual({ points: 12, ring: DartRing.DOUBLE, sector: 6 });
    expect(scoreDart(170, 0)).toEqual({ points: 12, ring: DartRing.DOUBLE, sector: 6 });
  });

  it('scores nothing outside the double ring', () => {
    expect(scoreDart(171, 0)).toEqual({ points: 0, ring: DartRing.MISS, sector: 0 });
    expect(scoreDart(0, 171)).toEqual({ points: 0, ring: DartRing.MISS, sector: 0 });
    expect(scoreDart(BOARD_RADIUS, BOARD_RADIUS)).toEqual({ points: 0, ring: DartRing.MISS, sector: 0 });
    expect(scoreDart(-240, 240)).toEqual({ points: 0, ring: DartRing.MISS, sector: 0 });
  });

  it('keeps aim points inside the legal target range', () => {
    for (const sector of SECTOR_ORDER) {
      for (const ring of [DartRing.SINGLE, DartRing.DOUBLE, DartRing.TREBLE] as const) {
        const p = aimPoint(sector, ring);
        expect(Number.isInteger(p.x)).toBe(true);
        expect(Number.isInteger(p.y)).toBe(true);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(BOARD_RADIUS);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(BOARD_RADIUS);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// aiming and the scatter
// ---------------------------------------------------------------------------

describe('darts throwing', () => {
  const setup = { players: ['a', 'b'], seed: 1, options: {} };

  it('lands in the aimed bed on a perfectly timed throw, whatever the seed', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const state = darts.createInitialState(setup);
      for (const [sector, ring, points] of [
        [20, DartRing.TREBLE, 60],
        [19, DartRing.DOUBLE, 38],
        [7, DartRing.SINGLE, 7],
        [25, DartRing.INNER_BULL, 50],
        [25, DartRing.OUTER_BULL, 25],
        [0, DartRing.MISS, 0],
      ] as const) {
        const action: DartsAction = { type: 'throw', player: 'a', seq: 0, payload: aim(sector, ring) };
        const next = darts.applyAction(state, action, createContext(setup.players, seed));
        expect(next.lastPoints).toBe(points);
        expect(next.lastRing).toBe(ring);
      }
    }
  });

  it('scatters wider as accuracy falls', () => {
    const state = darts.createInitialState(setup);
    const spreadFor = (accuracy: number): number => {
      let worst = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const action: DartsAction = {
          type: 'throw',
          player: 'a',
          seq: 0,
          payload: { targetX: 0, targetY: 103, accuracy },
        };
        const next = darts.applyAction(state, action, createContext(setup.players, seed));
        worst = Math.max(worst, Math.abs(next.lastX), Math.abs(next.lastY - 103));
      }
      return worst;
    };
    expect(spreadFor(1)).toBeLessThanOrEqual(2);
    expect(spreadFor(0.5)).toBeGreaterThan(4);
    expect(spreadFor(0)).toBeGreaterThan(spreadFor(0.5));
  });

  it('is a pure function of state, action and context', () => {
    const state = darts.createInitialState(setup);
    Object.freeze(state);
    Object.freeze(state.scores);
    Object.freeze(state.players);
    const before = encodeCbor(darts.encodeState(state));
    const action: DartsAction = { type: 'throw', player: 'a', seq: 0, payload: { targetX: 0, targetY: 103, accuracy: 1 } };

    const first = darts.applyAction(state, action, createContext(setup.players, 9));
    const second = darts.applyAction(state, action, createContext(setup.players, 9));

    expect(encodeCbor(darts.encodeState(state))).toEqual(before); // input untouched
    expect(first).not.toBe(state);
    expect(first.scores).not.toBe(state.scores);
    expect(darts.encodeState(first)).toEqual(darts.encodeState(second)); // same seed, same result
  });

  it('stores only integers', () => {
    const state = darts.createInitialState(setup);
    for (let seed = 1; seed <= 20; seed++) {
      const action: DartsAction = { type: 'throw', player: 'a', seq: 0, payload: { targetX: 40, targetY: -90, accuracy: 0.13 } };
      const next = darts.applyAction(state, action, createContext(setup.players, seed));
      for (const value of [next.lastX, next.lastY, next.lastPoints, next.lastSector, next.lastRing, ...next.scores]) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 501 rules
// ---------------------------------------------------------------------------

describe('darts rules', () => {
  it('starts everyone on 501 with the host to throw', () => {
    const t = table();
    expect(t.host.currentState.scores).toEqual([START_SCORE, START_SCORE]);
    expect(t.host.turn).toBe('a');
    expect(t.host.currentState.dartsThrown).toBe(0);
    expect(t.host.status.kind).toBe(GameStatusKind.IN_PROGRESS);
  });

  it('subtracts three darts and then passes the turn', () => {
    const t = table();
    for (let i = 0; i < DARTS_PER_TURN; i++) {
      expect(t.throwDart('a', aim(20, DartRing.SINGLE)).accepted).toBe(true);
      expect(t.host.currentState.dartsThrown).toBe(i === DARTS_PER_TURN - 1 ? 0 : i + 1);
    }
    expect(scoreOf(t.host.currentState, 'a')).toBe(START_SCORE - 60);
    expect(t.host.turn).toBe('b');
    expect(t.host.currentState.turnStartScore).toBe(START_SCORE);
    expect(t.host.currentState.turnsCompleted).toBe(1);
    // both devices agree
    expect(darts.encodeState(t.stateOf('a'))).toEqual(darts.encodeState(t.stateOf('b')));
  });

  it('busts below zero and restores the score held at the start of the turn', () => {
    const t = table({ start: 60 });
    expect(t.throwDart('a', aim(20, DartRing.SINGLE)).accepted).toBe(true); // 60 -> 40
    expect(scoreOf(t.host.currentState, 'a')).toBe(40);
    expect(t.throwDart('a', aim(20, DartRing.TREBLE)).accepted).toBe(true); // 40 - 60 = -20
    const state = t.host.currentState;
    expect(state.lastWasBust).toBe(true);
    expect(scoreOf(state, 'a')).toBe(60); // not 40: the whole turn is void
    expect(state.turnIndex).toBe(1);
    expect(state.dartsThrown).toBe(0);
    expect(t.host.turn).toBe('b');
    expect(scoreOf(t.stateOf('b'), 'a')).toBe(60);
  });

  it('busts when the throw would leave exactly one', () => {
    const t = table({ start: 21 });
    expect(t.throwDart('a', aim(20, DartRing.SINGLE)).accepted).toBe(true);
    expect(t.host.currentState.lastWasBust).toBe(true);
    expect(scoreOf(t.host.currentState, 'a')).toBe(21);
    expect(t.host.turn).toBe('b');
  });

  it('busts on a non-double finish', () => {
    for (const [start, payload] of [
      [20, aim(20, DartRing.SINGLE)], // single out
      [60, aim(20, DartRing.TREBLE)], // treble out
      [25, aim(25, DartRing.OUTER_BULL)], // the 25 is not a double
    ] as const) {
      const t = table({ start });
      expect(t.throwDart('a', payload).accepted).toBe(true);
      const state = t.host.currentState;
      expect(state.lastPoints).toBe(start);
      expect(state.lastWasBust).toBe(true);
      expect(scoreOf(state, 'a')).toBe(start);
      expect(t.host.status.kind).toBe(GameStatusKind.IN_PROGRESS);
      expect(t.host.turn).toBe('b');
    }
  });

  it('wins on an exact double out', () => {
    const t = table({ start: 40 });
    expect(t.throwDart('a', aim(20, DartRing.DOUBLE)).accepted).toBe(true);
    expect(scoreOf(t.host.currentState, 'a')).toBe(0);
    expect(t.host.status.kind).toBe(GameStatusKind.WON);
    expect(t.host.status.kind === GameStatusKind.WON && t.host.status.winners).toEqual(['a']);
    expect(t.host.turn).toBeNull();
    // and the peer reached the same conclusion from the same action
    const peer = t.sessions[1] as GameSession<DartsState, DartsAction>;
    expect(peer.status.kind).toBe(GameStatusKind.WON);
  });

  it('accepts the bullseye as a double for the finish', () => {
    const t = table({ start: 50 });
    expect(t.throwDart('a', aim(25, DartRing.INNER_BULL)).accepted).toBe(true);
    expect(t.host.currentState.lastRing).toBe(DartRing.INNER_BULL);
    expect(t.host.status.kind).toBe(GameStatusKind.WON);
  });

  it('checks out mid-turn without using the remaining darts', () => {
    const t = table({ start: 60 });
    expect(t.throwDart('a', aim(20, DartRing.SINGLE)).accepted).toBe(true); // 60 -> 40
    expect(t.throwDart('a', aim(20, DartRing.DOUBLE)).accepted).toBe(true); // 40 -> 0
    expect(t.host.status.kind).toBe(GameStatusKind.WON);
    expect(t.throwDart('a', aim(20, DartRing.SINGLE)).accepted).toBe(false);
  });

  it('counts a miss as a dart but not as a bust', () => {
    const t = table({ start: 100 });
    expect(t.throwDart('a', aim(0, DartRing.MISS)).accepted).toBe(true);
    const state = t.host.currentState;
    expect(state.lastPoints).toBe(0);
    expect(state.lastRing).toBe(DartRing.MISS);
    expect(state.lastWasBust).toBe(false);
    expect(scoreOf(state, 'a')).toBe(100);
    expect(state.dartsThrown).toBe(1);
    expect(t.host.turn).toBe('a');
  });

  it('rotates through four players', () => {
    const t = table({}, ['a', 'b', 'c', 'd']);
    for (const player of ['a', 'b', 'c', 'd']) {
      expect(t.host.turn).toBe(player);
      for (let i = 0; i < DARTS_PER_TURN; i++) {
        expect(t.throwDart(player, aim(20, DartRing.SINGLE)).accepted).toBe(true);
      }
    }
    expect(t.host.turn).toBe('a');
    expect(t.host.currentState.scores).toEqual([441, 441, 441, 441]);
    for (const seat of ['a', 'b', 'c', 'd']) {
      expect(darts.encodeState(t.stateOf(seat))).toEqual(darts.encodeState(t.stateOf('a')));
    }
  });

  it('abandons a leg that runs past the stalemate cap', () => {
    const t = table();
    // Nobody can score from the far corner of the board, so the leg can only
    // end by running out of turns - which it must, or the reducer could stall.
    let thrown = 0;
    while (t.host.turn !== null && thrown < 400) {
      expect(t.throwDart(t.host.turn, aim(0, DartRing.MISS)).accepted).toBe(true);
      thrown += 1;
    }
    expect(t.host.turn).toBeNull();
    expect(t.host.currentState.turnsCompleted).toBe(80); // 40 turns each
    expect(thrown).toBe(240);
    expect(t.host.status.kind).toBe(GameStatusKind.DRAW);
    expect(t.host.currentState.scores).toEqual([START_SCORE, START_SCORE]);
    expect(t.host.submitLocal('throw', aim(20, DartRing.TREBLE)).accepted).toBe(false);
    expect(darts.encodeState(t.stateOf('a'))).toEqual(darts.encodeState(t.stateOf('b')));
  });

  it('tracks who threw the last dart even after the turn changes', () => {
    const t = table({ start: 21 });
    t.throwDart('a', aim(20, DartRing.SINGLE)); // busts, turn passes to b
    expect(t.host.currentState.lastThrower).toBe(0);
    expect(t.host.currentState.turnIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// rejecting a hostile or careless peer
// ---------------------------------------------------------------------------

describe('darts validation', () => {
  it('refuses a throw out of turn', () => {
    const t = table();
    const b = t.sessions[1] as GameSession<DartsState, DartsAction>;
    const outcome = b.submitLocal('throw', aim(20, DartRing.TREBLE));
    expect(outcome.accepted).toBe(false);
    expect(outcome.accepted === false && outcome.detail).toMatch(/turn/);
  });

  it('refuses any throw once the leg is won', () => {
    const t = table({ start: 40 });
    expect(t.throwDart('a', aim(20, DartRing.DOUBLE)).accepted).toBe(true);
    expect(t.host.isOver).toBe(true);
    const b = t.sessions[1] as GameSession<DartsState, DartsAction>;
    const outcome = b.submitLocal('throw', aim(20, DartRing.TREBLE));
    expect(outcome.accepted).toBe(false);
    expect(outcome.accepted === false && outcome.reason).toBe('gameOver');
    expect(
      darts.validateAction(t.host.currentState, { type: 'throw', player: 'b', seq: 0, payload: { targetX: 0, targetY: 0, accuracy: 1 } }, createContext(['a', 'b'], 1)),
    ).toEqual({ ok: false, reason: 'the leg has already been won' });
  });

  it('will not let a peer throw as somebody else', () => {
    const t = table();
    const b = t.sessions[1] as GameSession<DartsState, DartsAction>;
    const forged = darts.encodeAction({ type: 'throw', player: 'a', seq: 0, payload: { targetX: 0, targetY: 103, accuracy: 1 } });
    // The session authenticates us as 'b', so the action is attributed to b -
    // who is not to throw.
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
    // And an id that is not in the game at all is refused outright.
    const outsider = t.host.applyRemote(forged, 'mallory');
    expect(outsider.accepted).toBe(false);
    expect(outsider.accepted === false && outsider.reason).toBe('notAPlayer');
  });

  it('refuses a target off the board or an impossible accuracy', () => {
    const t = table();
    for (const payload of [
      { targetX: 999, targetY: 0, accuracy: 1 },
      { targetX: 0, targetY: -999, accuracy: 1 },
      { targetX: BOARD_RADIUS + 1, targetY: 0, accuracy: 1 },
      { targetX: 0, targetY: 0, accuracy: 4 },
      { targetX: 0, targetY: 0, accuracy: -1 },
      { targetX: 0, targetY: 0, accuracy: Number.NaN },
      { targetX: Number.POSITIVE_INFINITY, targetY: 0, accuracy: 1 },
    ]) {
      const outcome = t.host.submitLocal('throw', payload);
      expect(outcome.accepted).toBe(false);
    }
    expect(t.host.actionCount).toBe(0);
    expect(t.host.currentState.scores).toEqual([START_SCORE, START_SCORE]);
  });

  it('refuses an unknown action type', () => {
    const t = table();
    expect(t.host.submitLocal('nudge', aim(20, DartRing.TREBLE)).accepted).toBe(false);
    const state = t.host.currentState;
    const bogus = { type: 'nudge', player: 'a', seq: 0, payload: { targetX: 0, targetY: 0, accuracy: 1 } } as unknown as DartsAction;
    expect(darts.validateAction(state, bogus, createContext(['a', 'b'], 1)).ok).toBe(false);
  });

  it('throws, rather than crashing, on malformed wire input', () => {
    const hostile: CborValue[] = [
      null,
      0,
      'throw',
      [],
      {},
      { t: 'throw' },
      { t: 'throw', s: 0 },
      { t: 'throw', s: -1, p: { x: 0, y: 0, a: 50 } },
      { t: 'throw', s: 1.5, p: { x: 0, y: 0, a: 50 } },
      { t: 'throw', s: 0, p: null },
      { t: 'throw', s: 0, p: [] },
      { t: 'throw', s: 0, p: new Uint8Array(8) },
      { t: 'throw', s: 0, p: { x: 1e12, y: -1e12, a: 50 } },
      { t: 'throw', s: 0, p: { x: 0.5, y: 0, a: 50 } },
      { t: 'throw', s: 0, p: { x: 0, y: 0, a: 101 } },
      { t: 'throw', s: 0, p: { x: 0, y: 0, a: -1 } },
      { t: 'throw', s: 0, p: { x: '0', y: 0, a: 50 } },
      { t: 'throw', s: 0, p: { x: 0, y: 0 } },
      { t: 'x'.repeat(400), s: 0, p: { x: 0, y: 0, a: 50 } },
    ];
    for (const junk of hostile) {
      expect(() => darts.decodeAction(junk, 'a')).toThrow();
    }
    // ...and the session swallows all of it without ever throwing.
    const t = table();
    for (const junk of hostile) {
      expect(t.host.applyRemote(junk, 'a').accepted).toBe(false);
    }
    expect(t.host.currentState.scores).toEqual([START_SCORE, START_SCORE]);
  });

  it('rejects a malformed state snapshot', () => {
    const good = darts.encodeState(darts.createInitialState({ players: ['a', 'b'], seed: 1, options: {} })) as Record<string, CborValue>;
    const bad: CborValue[] = [
      null,
      'state',
      [],
      { ...good, p: ['only-one'] },
      { ...good, p: ['a', 'b', 'c', 'd', 'e'] },
      { ...good, s: [501] },
      { ...good, s: [501, 99999] },
      { ...good, t: 5 },
      { ...good, w: 7 },
      { ...good, d: 3 },
      { ...good, r: 9 },
      { ...good, x: 5000 },
      { ...good, u: 2 },
    ];
    for (const junk of bad) {
      expect(() => darts.decodeState(junk)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// wire format
// ---------------------------------------------------------------------------

describe('darts encoding', () => {
  it('round-trips state through CBOR exactly', () => {
    const t = table({ start: 121 });
    t.throwDart('a', aim(20, DartRing.TREBLE, 0.4));
    t.throwDart('a', aim(19, DartRing.SINGLE, 0.9));
    const state = t.host.currentState;
    const restored = darts.decodeState(decodeCbor(encodeCbor(darts.encodeState(state))));
    expect(restored).toEqual(state);
    expect(darts.encodeState(restored)).toEqual(darts.encodeState(state));
  });

  it('round-trips an action, and keeps it small', () => {
    const action: DartsAction = { type: 'throw', player: 'a', seq: 7, payload: { targetX: -168, targetY: 103, accuracy: 0.37 } };
    const wire = darts.encodeAction(action);
    expect(wire).toEqual({ t: 'throw', s: 7, p: { x: -168, y: 103, a: 37 } });
    const bytes = encodeCbor(wire);
    expect(bytes.length).toBeLessThan(40);
    const restored = darts.decodeAction(decodeCbor(bytes), 'a');
    expect(restored).toEqual(action);
    // Re-encoding the decoded action is stable, which is what the runtime relies on.
    expect(darts.encodeAction(restored)).toEqual(wire);
  });

  it('quantises accuracy to hundredths and stays stable afterwards', () => {
    const action: DartsAction = { type: 'throw', player: 'a', seq: 0, payload: { targetX: 0, targetY: 0, accuracy: 0.3333333 } };
    const once = darts.decodeAction(darts.encodeAction(action), 'a');
    expect(once.payload.accuracy).toBe(0.33);
    const twice = darts.decodeAction(darts.encodeAction(once), 'a');
    expect(twice).toEqual(once);
    for (let a = 0; a <= 100; a++) {
      const value = a / 100;
      const round = darts.decodeAction(
        darts.encodeAction({ type: 'throw', player: 'a', seq: 0, payload: { targetX: 0, targetY: 0, accuracy: value } }),
        'a',
      );
      expect(round.payload.accuracy).toBe(value);
    }
  });

  it('normalises a target that rounds to negative zero', () => {
    const wire = darts.encodeAction({ type: 'throw', player: 'a', seq: 0, payload: { targetX: -0.4, targetY: 0, accuracy: 1 } }) as Record<string, CborValue>;
    const payload = wire.p as Record<string, CborValue>;
    expect(Object.is(payload.x, -0)).toBe(false);
    expect(payload.x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// two devices, no server
// ---------------------------------------------------------------------------

describe('darts synchronisation', () => {
  it('keeps two devices byte-identical over a whole leg', () => {
    const t = table({ start: 170 }, ['a', 'b'], 20250909);
    const targets = [aim(20, DartRing.TREBLE, 0.8), aim(19, DartRing.SINGLE, 0.6), aim(12, DartRing.DOUBLE, 0.7)];
    for (let i = 0; i < 24; i++) {
      const player = t.host.turn;
      if (player === null) break;
      const outcome = t.throwDart(player, targets[i % targets.length] as CborValue);
      expect(outcome.accepted).toBe(true);
      expect(darts.encodeState(t.stateOf('a'))).toEqual(darts.encodeState(t.stateOf('b')));
    }
  });

  it('replaying the action log reproduces the live state', () => {
    const t = table({ start: 301 }, ['a', 'b'], 77);
    for (let i = 0; i < 15; i++) {
      const player = t.host.turn;
      if (player === null) break;
      t.throwDart(player, aim(20, DartRing.TREBLE, 0.5));
    }
    const replayed = GameSession.replay(darts, t.setup, t.host.history());
    expect(darts.encodeState(replayed)).toEqual(darts.encodeState(t.host.currentState));
  });
});

// ---------------------------------------------------------------------------
// conformance
// ---------------------------------------------------------------------------

/** A simple but competent checkout policy, enough to finish a leg reliably. */
function aimForScore(score: number): { targetX: number; targetY: number } {
  const point =
    score === 50
      ? aimPoint(25, DartRing.INNER_BULL)
      : score <= 40 && score % 2 === 0
        ? aimPoint(score / 2, DartRing.DOUBLE)
        : score <= 40 || score === 61
          ? aimPoint(1, DartRing.SINGLE) // leave an even number behind
          : score <= 60
            ? aimPoint(score - 40, DartRing.SINGLE) // set up double 20
            : aimPoint(20, DartRing.TREBLE);
  return { targetX: point.x, targetY: point.y };
}

const conformanceHooks = {
  legalAction: (state: DartsState, player: string, random: { next(): number }) => {
    if (darts.currentTurn?.(state) !== player) return null;
    const score = state.scores[state.players.indexOf(player)] ?? 0;
    const accuracy = 0.7 + random.next() * 0.3;
    return { type: 'throw', payload: { ...aimForScore(score), accuracy } as CborValue };
  },
  maxPlies: 260,
};

describe('darts conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(darts, conformanceHooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(darts, conformanceHooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });

  it('finishes legs under random-ish play rather than stalling', () => {
    let won = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const report = runConformance(darts, conformanceHooks, seed);
      if (report.finalStatus === GameStatusKind.WON) won += 1;
    }
    expect(won).toBe(20);
  });
});
