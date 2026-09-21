import { describe, expect, it } from 'vitest';
import { encodeCbor, type CborValue } from '@airlink/core';
import {
  MAX_TAPS,
  NOBODY,
  NOT_REPORTED,
  ROUNDS,
  ROUND_MS,
  ROUND_PENDING,
  currentRound,
  isMatchOver,
  roundWinner,
  tapRace,
  winCounts,
  type TapRaceAction,
  type TapRaceState,
} from '../src/games/tapRace.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext, type PlayerId } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };

/**
 * The two devices, kept in step by hand - the path a real match takes: submit
 * locally, ship the encoded action, apply it on the peer. Nothing here reaches
 * into a session's state to fix it up.
 */
class Pair {
  readonly sessions = new Map<PlayerId, GameSession<TapRaceState, TapRaceAction>>();

  constructor(seed = 42) {
    const s = { ...setup, seed };
    for (const [i, p] of s.players.entries()) {
      this.sessions.set(p, new GameSession({ definition: tapRace, setup: s, localPlayer: p, isHost: i === 0 }));
    }
  }

  session(player: PlayerId): GameSession<TapRaceState, TapRaceAction> {
    const s = this.sessions.get(player);
    if (!s) throw new Error(`no session for ${player}`);
    return s;
  }

  get host(): GameSession<TapRaceState, TapRaceAction> {
    return this.session('a');
  }

  get state(): TapRaceState {
    return this.host.currentState;
  }

  /** Report for `player` and mirror the accepted action onto the peer. */
  report(player: PlayerId, round: number, count: number) {
    const outcome = this.session(player).submitLocal('report', { round, count });
    if (outcome.accepted) {
      const wire = tapRace.encodeAction(outcome.applied.action);
      for (const [id, peer] of this.sessions) {
        if (id === player) continue;
        expect(peer.applyRemote(wire, player).accepted).toBe(true);
      }
    }
    return outcome;
  }

  /** Play a whole round, a first. */
  playRound(round: number, forA: number, forB: number) {
    expect(this.report('a', round, forA).accepted).toBe(true);
    expect(this.report('b', round, forB).accepted).toBe(true);
  }

  /** Both devices must hold a byte-identical position. */
  expectConverged(): void {
    const first = this.sessions.values().next().value as GameSession<TapRaceState, TapRaceAction>;
    const reference = JSON.stringify(tapRace.encodeState(first.currentState));
    for (const s of this.sessions.values()) {
      expect(JSON.stringify(tapRace.encodeState(s.currentState))).toBe(reference);
    }
  }
}

describe('tap race rules', () => {
  it('starts with three unreported rounds and a twenty-second window', () => {
    const table = new Pair();
    expect(ROUND_MS).toBe(20_000);
    expect(table.state.counts).toEqual([
      [NOT_REPORTED, NOT_REPORTED],
      [NOT_REPORTED, NOT_REPORTED],
      [NOT_REPORTED, NOT_REPORTED],
    ]);
    expect(currentRound(table.state)).toBe(0);
    expect(isMatchOver(table.state)).toBe(false);
    expect(table.host.status.kind).toBe(GameStatusKind.IN_PROGRESS);
    expect(table.host.turn).toBe('a');
  });

  it('lets either player report first - the race is simultaneous', () => {
    const table = new Pair();
    expect(table.report('b', 0, 61).accepted).toBe(true);
    expect(table.host.turn).toBe('a');
    expect(roundWinner(table.state, 0)).toBe(ROUND_PENDING);
    expect(table.report('a', 0, 80).accepted).toBe(true);
    expect(roundWinner(table.state, 0)).toBe(0);
    table.expectConverged();
  });

  it('gives the round to the higher count and keeps both tallies', () => {
    const table = new Pair();
    table.playRound(0, 74, 91);
    expect(roundWinner(table.state, 0)).toBe(1);
    expect(table.state.counts[0]).toEqual([74, 91]);
    expect(winCounts(table.state)).toEqual([0, 1]);
    expect(currentRound(table.state)).toBe(1);
  });

  it('gives a tied round to nobody', () => {
    const table = new Pair();
    table.playRound(0, 88, 88);
    expect(roundWinner(table.state, 0)).toBe(NOBODY);
    expect(winCounts(table.state)).toEqual([0, 0]);
  });

  it('refuses a report for a round that is not in progress', () => {
    const table = new Pair();
    const ahead = table.report('a', 1, 50);
    expect(ahead.accepted).toBe(false);
    expect(ahead.accepted === false && ahead.detail).toMatch(/not the round in progress/);
    table.playRound(0, 40, 30);
    const behind = table.report('b', 0, 99);
    expect(behind.accepted).toBe(false);
  });

  it('refuses a second report in the same round', () => {
    const table = new Pair();
    expect(table.report('a', 0, 55).accepted).toBe(true);
    const again = table.report('a', 0, 1999);
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already reported/);
    expect(table.state.counts[0]?.[0]).toBe(55);
  });

  it('refuses a count outside 0-2000, wherever it comes from', () => {
    const table = new Pair();
    expect(table.report('a', 0, MAX_TAPS + 1).accepted).toBe(false);
    expect(table.report('a', 0, -1).accepted).toBe(false);
    expect(table.report('a', 0, 12.5).accepted).toBe(false);
    // The bound is a wire bound, so a claim of a million never reaches the rules.
    expect(() => tapRace.decodeAction({ t: 'report', s: 0, p: { r: 0, n: 1_000_000 } }, 'a')).toThrow();
    expect(table.report('a', 0, MAX_TAPS).accepted).toBe(true);
  });

  it('rejects a duplicate action on the wire rather than applying it twice', () => {
    const table = new Pair();
    const outcome = table.session('a').submitLocal('report', { round: 0, count: 120 });
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;
    const wire = tapRace.encodeAction(outcome.applied.action);
    const peer = table.session('b');
    expect(peer.applyRemote(wire, 'a').accepted).toBe(true);
    const replayed = peer.applyRemote(wire, 'a');
    expect(replayed.accepted).toBe(false);
    expect(replayed.accepted === false && replayed.reason).toBe('duplicate');
  });

  it('will not let one player report as the other', () => {
    const table = new Pair();
    const forged = tapRace.encodeAction({ type: 'report', player: 'a', seq: 0, payload: { round: 0, count: 300 } });
    // The session authenticated us as 'b', so the report is attributed to b -
    // and it lands in b's column, never in a's.
    expect(table.session('b').applyRemote(forged, 'b').accepted).toBe(true);
    expect(table.session('b').currentState.counts[0]).toEqual([NOT_REPORTED, 300]);
  });

  it('ends the match at two round wins and never plays the third', () => {
    const table = new Pair();
    table.playRound(0, 90, 61);
    table.playRound(1, 77, 70);
    expect(table.host.isOver).toBe(true);
    expect(table.host.status.kind).toBe(GameStatusKind.WON);
    expect(table.host.status.kind === GameStatusKind.WON && table.host.status.winners).toEqual(['a']);
    expect(table.host.turn).toBeNull();
    expect(table.report('b', 2, 200).accepted).toBe(false);
    expect(roundWinner(table.state, 2)).toBe(ROUND_PENDING);
    table.expectConverged();
  });

  it('goes to three rounds when the first two are split', () => {
    const table = new Pair();
    table.playRound(0, 90, 61);
    table.playRound(1, 40, 70);
    expect(table.host.isOver).toBe(false);
    expect(currentRound(table.state)).toBe(2);
    table.playRound(2, 101, 100);
    expect(table.host.status.kind).toBe(GameStatusKind.WON);
    expect(winCounts(table.state)).toEqual([2, 1]);
  });

  it('draws a match that is level after three rounds', () => {
    const table = new Pair();
    table.playRound(0, 90, 61);
    table.playRound(1, 40, 70);
    table.playRound(2, 55, 55);
    expect(table.host.status.kind).toBe(GameStatusKind.DRAW);
    expect(table.host.status.kind === GameStatusKind.DRAW && table.host.status.reason).toMatch(/tied on 1/);
    expect(table.host.turn).toBeNull();
  });

  it('draws a match in which every round was tied', () => {
    const table = new Pair();
    table.playRound(0, 10, 10);
    table.playRound(1, 20, 20);
    table.playRound(2, 30, 30);
    expect(table.host.status.kind).toBe(GameStatusKind.DRAW);
    expect(table.host.status.kind === GameStatusKind.DRAW && table.host.status.reason).toMatch(/every round/);
  });

  it('gives the same match to the same counts whichever report lands first', () => {
    // The claim the whole design rests on: the radio decides nothing. Play one
    // match a-first and the mirror image b-first, from identical counts, and
    // both the board and the result must come out the same.
    const rounds: readonly (readonly [number, number])[] = [
      [140, 139],
      [98, 121],
      [200, 199],
    ];
    const aFirst = new Pair();
    const bFirst = new Pair();
    for (const [round, [forA, forB]] of rounds.entries()) {
      expect(aFirst.report('a', round, forA).accepted).toBe(true);
      expect(aFirst.report('b', round, forB).accepted).toBe(true);
      expect(bFirst.report('b', round, forB).accepted).toBe(true);
      expect(bFirst.report('a', round, forA).accepted).toBe(true);
    }
    expect(JSON.stringify(tapRace.encodeState(bFirst.state))).toBe(JSON.stringify(tapRace.encodeState(aFirst.state)));
    expect(bFirst.host.status).toEqual(aFirst.host.status);
    expect(aFirst.host.status.kind === GameStatusKind.WON && aFirst.host.status.winners).toEqual(['a']);
  });

  it('gives the match to the only round won when the other two are tied', () => {
    const table = new Pair();
    table.playRound(0, 44, 44);
    table.playRound(1, 44, 44);
    table.playRound(2, 51, 50);
    expect(winCounts(table.state)).toEqual([1, 0]);
    expect(table.host.status.kind).toBe(GameStatusKind.WON);
    expect(table.host.status.kind === GameStatusKind.WON && table.host.status.winners).toEqual(['a']);
    expect(table.host.status.kind === GameStatusKind.WON && table.host.status.reason).toMatch(/most rounds won \(1\)/);
  });

  it('reads no clock: the same report reduces the same under any context', () => {
    // ROUND_MS is the renderer's countdown, not an input to the rules. Two
    // devices whose windows never overlapped must still reduce identically.
    const table = new Pair();
    const action: TapRaceAction = { type: 'report', player: 'b', seq: 0, payload: { round: 0, count: 310 } };
    const fresh = tapRace.applyAction(table.state, action, createContext(setup.players, 42, 0, 0));
    const hours = tapRace.applyAction(table.state, action, createContext(setup.players, 7, 3_600_000, ROUND_MS));
    expect(JSON.stringify(tapRace.encodeState(hours))).toBe(JSON.stringify(tapRace.encodeState(fresh)));
  });

  it('does not mutate the state it is given', () => {
    const table = new Pair();
    const before = table.state;
    const frozen = JSON.stringify(tapRace.encodeState(before));
    const context = createContext(setup.players, 42);
    const next = tapRace.applyAction(before, { type: 'report', player: 'a', seq: 0, payload: { round: 0, count: 7 } }, context);
    expect(JSON.stringify(tapRace.encodeState(before))).toBe(frozen);
    expect(next.counts[0]).toEqual([7, NOT_REPORTED]);
  });
});

describe('tap race wire format', () => {
  it('round-trips a part-played state exactly', () => {
    const table = new Pair();
    table.playRound(0, 512, 511);
    table.report('a', 1, 480);
    const encoded = tapRace.encodeState(table.state);
    const restored = tapRace.decodeState(encoded);
    expect(restored).toEqual(table.state);
    expect(JSON.stringify(tapRace.encodeState(restored))).toBe(JSON.stringify(encoded));
  });

  it('fits a report into a single Bluetooth packet', () => {
    const wire = tapRace.encodeAction({ type: 'report', player: 'a', seq: 2, payload: { round: 2, count: 1999 } });
    // The point of the whole design: one packet per player per round, not one
    // per tap. If this ever grew past the MTU the design would be broken.
    expect(encodeCbor(wire).length).toBeLessThan(185);
    const restored = tapRace.decodeAction(wire, 'a');
    expect(restored).toEqual({ type: 'report', player: 'a', seq: 2, payload: { round: 2, count: 1999 } });
  });

  it('throws on hostile input rather than trusting it', () => {
    const junk: CborValue[] = [
      null,
      7,
      'report',
      [],
      {},
      { t: 'report' },
      { t: 'tap', s: 0, p: { r: 0, n: 5 } },
      { t: 'report', s: 0, p: null },
      { t: 'report', s: 0, p: { r: 3, n: 5 } },
      { t: 'report', s: 0, p: { r: -1, n: 5 } },
      { t: 'report', s: 0, p: { r: 0, n: MAX_TAPS + 1 } },
      { t: 'report', s: 0, p: { r: 0, n: 'lots' } },
      { t: 'report', s: 0, p: { r: 0.5, n: 5 } },
      { t: 'report', s: -1, p: { r: 0, n: 5 } },
    ];
    for (const value of junk) {
      expect(() => tapRace.decodeAction(value, 'a')).toThrow();
    }
  });

  it('refuses a state whose counts array is the wrong shape', () => {
    expect(() => tapRace.decodeState({ p: ['a', 'b'], c: [0, 0, 0, 0] })).toThrow();
    expect(() => tapRace.decodeState({ p: ['a'], c: [0, 0, 0, 0, 0, 0] })).toThrow();
    expect(() => tapRace.decodeState({ p: ['a', 'b'], c: [0, 0, 0, 0, 0, MAX_TAPS + 1] })).toThrow();
    expect(() => tapRace.decodeState({ p: ['a', 'b'], c: [0, 0, 0, 0, 0, -2] })).toThrow();
    expect(() => tapRace.decodeState('not a state')).toThrow();
  });

  it('refuses a board the rules could never have reached', () => {
    const N = NOT_REPORTED;
    // Round 1 decided while round 0 has not been tapped at all.
    expect(() => tapRace.decodeState({ p: ['a', 'b'], c: [N, N, 90, 10, N, N] })).toThrow();
    // A round tapped on the far side of a half-reported one.
    expect(() => tapRace.decodeState({ p: ['a', 'b'], c: [90, N, 80, 10, N, N] })).toThrow();
    // A third round played after the match was already won 2-0.
    expect(() => tapRace.decodeState({ p: ['a', 'b'], c: [90, 10, 80, 10, 70, 10] })).toThrow();
    // What an honest board looks like: rounds front to back, one half reported.
    expect(tapRace.decodeState({ p: ['a', 'b'], c: [90, 10, 80, 99, 70, N] }).counts).toEqual([
      [90, 10],
      [80, 99],
      [70, N],
    ]);
    // A tie decides nothing, so the third round is legitimately played out.
    expect(tapRace.decodeState({ p: ['a', 'b'], c: [90, 90, 80, 10, 70, 10] }).counts[2]).toEqual([70, 10]);
  });

  it('round-trips every state a match can reach', () => {
    // Walk a whole match and re-encode after each report: the wire form must
    // carry the position exactly, not just at the end.
    const table = new Pair();
    const reports: readonly (readonly [PlayerId, number, number])[] = [
      ['a', 0, 300],
      ['b', 0, 300],
      ['b', 1, 412],
      ['a', 1, 411],
      ['a', 2, 77],
      ['b', 2, 76],
    ];
    for (const [player, round, count] of reports) {
      expect(table.report(player, round, count).accepted).toBe(true);
      const encoded = tapRace.encodeState(table.state);
      expect(tapRace.decodeState(encoded)).toEqual(table.state);
    }
    // Tied, then one round each: level after three, so nobody takes it.
    expect(winCounts(table.state)).toEqual([1, 1]);
    expect(table.host.status.kind).toBe(GameStatusKind.DRAW);
  });
});

const hooks = {
  legalAction: (state: TapRaceState, player: PlayerId, random: { nextInt(max: number): number }) => {
    if (tapRace.currentTurn?.(state) !== player) return null;
    const round = currentRound(state);
    if (round >= ROUNDS) return null;
    return { type: 'report', payload: { round, count: random.nextInt(MAX_TAPS + 1) } as CborValue };
  },
  // Six reports is the whole match: three rounds, two players.
  maxPlies: ROUNDS * 2,
};

describe('tap race conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(tapRace, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    let terminated = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(tapRace, hooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      if (report.finalStatus !== GameStatusKind.IN_PROGRESS) terminated++;
    }
    expect(terminated).toBe(60);
  });
});
