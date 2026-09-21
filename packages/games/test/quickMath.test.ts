import { describe, expect, it } from 'vitest';
import {
  CORRECT_POINTS,
  MAX_ANSWER_MS,
  ROUNDS,
  SPEED_BONUS,
  currentProblem,
  problemAt,
  problemText,
  problems,
  quickMath,
  type QuickMathState,
} from '../src/games/quickMath.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };

type Who = 'a' | 'b';

function pair() {
  return {
    a: new GameSession({ definition: quickMath, setup, localPlayer: 'a', isHost: true }),
    b: new GameSession({ definition: quickMath, setup, localPlayer: 'b', isHost: false }),
  };
}

/** Submit an answer and mirror it onto the peer, as the transport would. */
function answer(
  table: ReturnType<typeof pair>,
  who: Who,
  payload: { round: number; value: number; ms: number },
) {
  const from = who === 'a' ? table.a : table.b;
  const to = who === 'a' ? table.b : table.a;
  const result = from.submitLocal('answer', payload);
  if (result.accepted) to.applyRemote(quickMath.encodeAction(result.applied.action), who);
  return result;
}

function right(round: number): number {
  return problemAt(setup.seed, round).answer;
}

describe('quick math problems', () => {
  it('gives both devices the same ten problems from the same seed', () => {
    const mine = problems(setup.seed);
    const theirs = problems(setup.seed);
    expect(mine).toHaveLength(ROUNDS);
    expect(mine).toEqual(theirs);
  });

  it('gives a different match a different set', () => {
    expect(problems(1)).not.toEqual(problems(2));
  });

  it('only ever poses problems that can be done in the head', () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const problem of problems(seed)) {
        expect(Number.isInteger(problem.answer)).toBe(true);
        expect(problem.answer).toBeGreaterThanOrEqual(0);
        expect(problem.answer).toBeLessThanOrEqual(200);
        if (problem.op === '+') expect(problem.left + problem.right).toBe(problem.answer);
        if (problem.op === '-') {
          expect(problem.left - problem.right).toBe(problem.answer);
          // Never asks for a negative result. A player who has to answer -14 is
          // being asked a different, harder question than the one intended.
          expect(problem.left).toBeGreaterThanOrEqual(problem.right);
        }
        if (problem.op === '*') {
          expect(problem.left * problem.right).toBe(problem.answer);
          expect(problem.left).toBeLessThanOrEqual(12);
          expect(problem.right).toBeLessThanOrEqual(12);
        }
      }
    }
  });

  it('mixes all three operations across a match', () => {
    const many = new Set(Array.from({ length: 100 }, (_, s) => problems(s).map((p) => p.op)).flat());
    expect(many).toEqual(new Set(['+', '-', '*']));
    // A single seed need not use all three, but ten problems drawn one operation
    // in three should never come out all the same: a generator that had got
    // stuck - on the multiplication branch, say - would still satisfy the check
    // above and would be caught here.
    for (let seed = 0; seed < 300; seed++) {
      expect(new Set(problems(seed).map((p) => p.op)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it('renders multiplication with a proper times sign', () => {
    expect(problemText({ left: 7, right: 8, op: '*', answer: 56 })).toBe('7 × 8');
    expect(problemText({ left: 7, right: 8, op: '+', answer: 15 })).toBe('7 + 8');
  });
});

describe('quick math rules', () => {
  it('starts on the first problem with nobody having answered', () => {
    const { a } = pair();
    expect(a.currentState.round).toBe(0);
    expect(a.currentState.answers).toEqual([null, null]);
    expect(a.currentState.scores).toEqual([0, 0]);
    expect(currentProblem(a.currentState)?.answer).toBe(right(0));
  });

  it('lets either player answer first', () => {
    const table = pair();
    expect(answer(table, 'b', { round: 0, value: right(0), ms: 900 }).accepted).toBe(true);
    expect(table.a.currentState.answers[1]).toEqual({ value: right(0), ms: 900 });
  });

  it('holds the round open until both have answered', () => {
    const table = pair();
    answer(table, 'a', { round: 0, value: right(0), ms: 500 });
    expect(table.a.currentState.round).toBe(0);
    expect(table.a.currentState.scores).toEqual([0, 0]);
    answer(table, 'b', { round: 0, value: right(0) + 1, ms: 400 });
    expect(table.a.currentState.round).toBe(1);
    expect(table.a.currentState.answers).toEqual([null, null]);
    // And the points land in the same instant the round closes, not before.
    expect(table.a.currentState.scores).toEqual([CORRECT_POINTS, 0]);
    expect(table.a.currentState.correct).toEqual([1, 0]);
  });

  it('gives nothing at all to a round both players get wrong', () => {
    const table = pair();
    answer(table, 'a', { round: 0, value: right(0) + 1, ms: 100 });
    answer(table, 'b', { round: 0, value: right(0) - 1, ms: 8000 });
    // Being fastest is worth nothing on its own: the bonus rides on a correct
    // answer, so the quicker of two wrong answers gains no point over the slower.
    expect(table.a.currentState.scores).toEqual([0, 0]);
    expect(table.a.currentState.correct).toEqual([0, 0]);
    expect(table.a.currentState.round).toBe(1);
  });

  it('scores correctness ahead of speed', () => {
    const table = pair();
    // b answers first and fastest, and gets it wrong.
    answer(table, 'b', { round: 0, value: right(0) + 3, ms: 200 });
    answer(table, 'a', { round: 0, value: right(0), ms: 9000 });
    expect(table.a.currentState.scores).toEqual([CORRECT_POINTS, 0]);
    expect(table.a.currentState.correct).toEqual([1, 0]);
    expect(table.b.currentState.scores).toEqual([CORRECT_POINTS, 0]);
  });

  it('breaks a tie between two correct answers on the reported time', () => {
    const table = pair();
    answer(table, 'a', { round: 0, value: right(0), ms: 3000 });
    answer(table, 'b', { round: 0, value: right(0), ms: 1200 });
    expect(table.a.currentState.scores).toEqual([CORRECT_POINTS, CORRECT_POINTS + SPEED_BONUS]);
    expect(table.a.currentState.correct).toEqual([1, 1]);
  });

  it('gives the speed bonus to nobody on a dead heat', () => {
    const table = pair();
    answer(table, 'a', { round: 0, value: right(0), ms: 1500 });
    answer(table, 'b', { round: 0, value: right(0), ms: 1500 });
    expect(table.a.currentState.scores).toEqual([CORRECT_POINTS, CORRECT_POINTS]);
  });

  it('refuses a second answer from the same player in one round', () => {
    const table = pair();
    expect(answer(table, 'a', { round: 0, value: right(0), ms: 100 }).accepted).toBe(true);
    const again = answer(table, 'a', { round: 0, value: right(0), ms: 120 });
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already answered/);
  });

  it('refuses an answer aimed at a round that is not live', () => {
    const table = pair();
    const stale = answer(table, 'a', { round: 3, value: right(3), ms: 100 });
    expect(stale.accepted).toBe(false);
    expect(stale.accepted === false && stale.detail).toMatch(/live one/);
  });

  it('refuses an implausible reported time', () => {
    const table = pair();
    expect(answer(table, 'a', { round: 0, value: right(0), ms: MAX_ANSWER_MS + 1 }).accepted).toBe(false);
    expect(answer(table, 'a', { round: 0, value: right(0), ms: -1 }).accepted).toBe(false);
    expect(answer(table, 'a', { round: 0, value: right(0), ms: 1.5 }).accepted).toBe(false);
    expect(table.a.currentState.answers).toEqual([null, null]);
  });

  it('refuses an answer outside the value bounds', () => {
    const table = pair();
    expect(answer(table, 'a', { round: 0, value: 100000, ms: 10 }).accepted).toBe(false);
  });

  it('ends after ten problems and declares the higher score', () => {
    const table = pair();
    for (let round = 0; round < ROUNDS; round++) {
      answer(table, 'a', { round, value: right(round), ms: 2000 });
      answer(table, 'b', { round, value: right(round) + 7, ms: 500 });
    }
    expect(table.a.currentState.round).toBe(ROUNDS);
    expect(table.a.currentState.correct).toEqual([ROUNDS, 0]);
    expect(table.a.status.kind).toBe(GameStatusKind.WON);
    expect(table.a.status.kind === GameStatusKind.WON && table.a.status.winners).toEqual(['a']);
    expect(table.b.status.kind).toBe(GameStatusKind.WON);
    expect(table.a.turn).toBeNull();
    expect(currentProblem(table.a.currentState)).toBeNull();
  });

  it('draws when both players finish level', () => {
    const table = pair();
    for (let round = 0; round < ROUNDS; round++) {
      answer(table, 'a', { round, value: right(round), ms: 1000 });
      answer(table, 'b', { round, value: right(round), ms: 1000 });
    }
    expect(table.a.status.kind).toBe(GameStatusKind.DRAW);
    expect(table.a.currentState.scores).toEqual([ROUNDS * CORRECT_POINTS, ROUNDS * CORRECT_POINTS]);
  });

  it('refuses an answer once the match is over', () => {
    const table = pair();
    for (let round = 0; round < ROUNDS; round++) {
      answer(table, 'a', { round, value: right(round), ms: 1000 });
      answer(table, 'b', { round, value: right(round), ms: 1000 });
    }
    expect(table.a.isOver).toBe(true);
    expect(answer(table, 'a', { round: 0, value: 1, ms: 1 }).accepted).toBe(false);
  });

  it('names the player still owing an answer', () => {
    const table = pair();
    expect(table.a.turn).toBe('a');
    answer(table, 'a', { round: 0, value: right(0), ms: 300 });
    expect(table.a.turn).toBe('b');
  });

  it('will not let one player answer as another', () => {
    const { b } = pair();
    const forged = quickMath.encodeAction({
      type: 'answer',
      player: 'a',
      seq: 0,
      payload: { round: 0, value: right(0), ms: 100 },
    });
    // The session authenticated us as 'b', so the answer is credited to b - the
    // payload cannot claim otherwise.
    const result = b.applyRemote(forged, 'b');
    expect(result.accepted).toBe(true);
    expect(b.currentState.answers[0]).toBeNull();
    expect(b.currentState.answers[1]).toEqual({ value: right(0), ms: 100 });
  });
});

describe('quick math codecs', () => {
  it('round-trips a state that is mid-round', () => {
    const table = pair();
    answer(table, 'a', { round: 0, value: right(0), ms: 777 });
    answer(table, 'b', { round: 0, value: right(0), ms: 100 });
    answer(table, 'a', { round: 1, value: right(1) + 2, ms: 4200 });
    const encoded = quickMath.encodeState(table.a.currentState);
    const restored = quickMath.decodeState(encoded);
    expect(restored).toEqual(table.a.currentState);
    expect(quickMath.encodeState(restored)).toEqual(encoded);
  });

  it('round-trips an action', () => {
    const action = {
      type: 'answer' as const,
      player: 'a',
      seq: 4,
      payload: { round: 2, value: -12, ms: 31_000 },
    };
    expect(quickMath.decodeAction(quickMath.encodeAction(action), 'a')).toEqual(action);
  });

  it('throws on hostile action input', () => {
    const hostile = [
      null,
      7,
      'answer',
      [],
      {},
      { t: 'answer' },
      { t: 'skip', s: 0, p: { r: 0, v: 1, m: 1 } },
      { t: 'answer', s: 0, p: null },
      { t: 'answer', s: 0, p: { r: ROUNDS, v: 1, m: 1 } },
      { t: 'answer', s: 0, p: { r: -1, v: 1, m: 1 } },
      { t: 'answer', s: 0, p: { r: 0, v: 1e12, m: 1 } },
      { t: 'answer', s: 0, p: { r: 0, v: 1, m: MAX_ANSWER_MS + 1 } },
      { t: 'answer', s: 0, p: { r: 0, v: 1, m: -1 } },
      { t: 'answer', s: 0, p: { r: 0, v: '5', m: 1 } },
      { t: 'answer', s: 0, p: { r: 0.5, v: 1, m: 1 } },
    ];
    for (const junk of hostile) {
      expect(() => quickMath.decodeAction(junk as never, 'a')).toThrow();
    }
  });

  it('throws on a state that could not have happened', () => {
    const legal = quickMath.encodeState(quickMath.createInitialState(setup)) as Record<string, unknown>;
    // Two correct answers claimed before a single round has resolved.
    expect(() => quickMath.decodeState({ ...legal, c: [2, 0] } as never)).toThrow(/exceeds the rounds/);
    expect(() => quickMath.decodeState({ ...legal, p: ['only-one'] } as never)).toThrow();
    expect(() => quickMath.decodeState({ ...legal, s: [99, 0] } as never)).toThrow();
    expect(() => quickMath.decodeState({ ...legal, a: [[1], null] } as never)).toThrow();
    expect(() => quickMath.decodeState({ ...legal, r: ROUNDS + 1 } as never)).toThrow();
    expect(() => quickMath.decodeState(null as never)).toThrow();
  });

  it('refuses a score its own tally could not have bought', () => {
    const legal = quickMath.encodeState(quickMath.createInitialState(setup)) as Record<string, unknown>;
    // A won match asserted rather than played: full marks, nothing right.
    expect(() => quickMath.decodeState({ ...legal, r: ROUNDS, s: [30, 0], c: [0, 0] } as never)).toThrow(
      /cannot come from 0 correct/,
    );
    // Ten right answers cannot be worth a point each, nor more than three.
    expect(() => quickMath.decodeState({ ...legal, r: ROUNDS, s: [10, 0], c: [10, 0] } as never)).toThrow();
    expect(() => quickMath.decodeState({ ...legal, r: ROUNDS, s: [31, 0], c: [10, 0] } as never)).toThrow();
    // The whole legal band, two to three points a correct answer, is admitted.
    for (const score of [20, 25, 30]) {
      expect(() => quickMath.decodeState({ ...legal, r: ROUNDS, s: [score, 0], c: [10, 0] } as never)).not.toThrow();
    }
  });

  it('refuses an open round that already holds both answers', () => {
    const legal = quickMath.encodeState(quickMath.createInitialState(setup)) as Record<string, unknown>;
    // The second answer resolves the round, so this position cannot be reached
    // by play - and adopting it hangs the match: both players have answered, so
    // both are refused, and nothing can ever advance the round again.
    const deadlock = { ...legal, r: 5, a: [[10, 100], [20, 200]], s: [10, 10], c: [5, 5] };
    expect(() => quickMath.decodeState(deadlock as never)).toThrow(/both answers/);

    const guest = new GameSession({ definition: quickMath, setup, localPlayer: 'b', isHost: false });
    expect(guest.applySnapshotEnvelope({ state: deadlock as never, seq: { a: 5, b: 5 }, version: 10, elapsedMs: 0 })).toBe(
      false,
    );
    expect(guest.currentState.round).toBe(0);
  });

  it('refuses a finished match still holding a live answer', () => {
    const legal = quickMath.encodeState(quickMath.createInitialState(setup)) as Record<string, unknown>;
    const finished = { ...legal, r: ROUNDS, a: [[1, 1], null], s: [20, 20], c: [10, 10] };
    expect(() => quickMath.decodeState(finished as never)).toThrow(/live answer/);
  });

  it('lets a device that joins from a snapshot pose the same problem as the peer', () => {
    // The reason the problems are seeded per round rather than by walking one
    // generator: a device holding only the seed and the round must land on the
    // question the peer has been looking at.
    const table = pair();
    for (let round = 0; round < 6; round++) {
      answer(table, 'a', { round, value: right(round), ms: 400 });
      answer(table, 'b', { round, value: right(round) + 2, ms: 900 });
    }
    const joiner = new GameSession({ definition: quickMath, setup, localPlayer: 'b', isHost: false });
    expect(joiner.applySnapshotEnvelope(table.a.snapshotEnvelope())).toBe(true);
    expect(joiner.currentState).toEqual(table.a.currentState);
    expect(currentProblem(joiner.currentState)).toEqual(currentProblem(table.a.currentState));
    expect(currentProblem(joiner.currentState)?.answer).toBe(right(6));

    // And it can carry on playing from there, in step with the peer.
    const resumed = joiner.submitLocal('answer', { round: 6, value: right(6), ms: 300 });
    expect(resumed.accepted).toBe(true);
    if (resumed.accepted) table.a.applyRemote(quickMath.encodeAction(resumed.applied.action), 'b');
    expect(quickMath.encodeState(joiner.currentState)).toEqual(quickMath.encodeState(table.a.currentState));
  });
});

describe('quick math conformance', () => {
  const hooks = {
    legalAction: (state: QuickMathState, player: string, random: { nextInt(n: number): number }) => {
      const problem = currentProblem(state);
      if (!problem) return null;
      const index = state.players.indexOf(player);
      if (index < 0 || state.answers[index] !== null) return null;
      // Right about half the time, so both branches of the scoring are played.
      const value = random.nextInt(2) === 0 ? problem.answer : problem.answer + 1 + random.nextInt(9);
      return { type: 'answer', payload: { round: state.round, value, ms: random.nextInt(MAX_ANSWER_MS) } };
    },
    maxPlies: 30,
  };

  it('passes the shared game conformance suite', () => {
    const report = runConformance(quickMath, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    expect(report.playedPlies).toBe(ROUNDS * 2);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(quickMath, hooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
