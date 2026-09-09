import { describe, expect, it } from 'vitest';
import type { CborValue } from '@airlink/core';
import {
  BASE_POINTS,
  MAX_ANSWER_MS,
  UNANSWERED,
  currentQuestion,
  hasAnswered,
  leaderboard,
  revealedCorrect,
  trivia,
  type TriviaAction,
  type TriviaState,
} from '../src/games/trivia.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext, type GameSetup } from '../src/engine.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A table of independent sessions, one per player, kept in sync by hand. */
function table(players: readonly string[], seed: number, questions?: number) {
  const setup: GameSetup = {
    players: [...players],
    seed,
    options: questions === undefined ? {} : { questions },
  };
  const sessions = new Map<string, GameSession<TriviaState, TriviaAction>>();
  players.forEach((p, i) => {
    sessions.set(p, new GameSession({ definition: trivia, setup, localPlayer: p, isHost: i === 0 }));
  });

  /** Submit locally, then deliver the encoded action to every other device. */
  const submit = (player: string, type: string, payload: CborValue) => {
    const from = sessions.get(player) as GameSession<TriviaState, TriviaAction>;
    const outcome = from.submitLocal(type, payload);
    if (outcome.accepted) {
      const wire = trivia.encodeAction(outcome.applied.action);
      for (const [id, other] of sessions) if (id !== player) other.applyRemote(wire, player);
    }
    return outcome;
  };

  const host = players[0] as string;
  const of = (player: string) => sessions.get(player) as GameSession<TriviaState, TriviaAction>;
  return { setup, sessions, submit, host, of, state: () => of(host).currentState };
}

/**
 * The ground truth for the current question.
 *
 * Note what this has to do: there is no way to read the key out of an open
 * question, so the test force-closes a THROWAWAY COPY of the state (the host
 * calling time on it) and reads the answer from the copy. The live game is
 * untouched. If the key ever became readable early, this helper would be
 * unnecessary - which is exactly what the leak tests below assert.
 */
function peekCorrect(state: TriviaState): number {
  const context = createContext(state.players, state.seed);
  const closed = trivia.applyAction(
    state,
    { type: 'next', player: state.players[0] as string, seq: 0, payload: {} },
    context,
  );
  const key = revealedCorrect(closed);
  expect(key).not.toBeNull();
  return key as number;
}

const wrongSlot = (key: number): number => (key + 1) % 4;

const initial = (players: readonly string[], seed: number, questions?: number): TriviaState =>
  trivia.createInitialState({
    players: [...players],
    seed,
    options: questions === undefined ? {} : { questions },
  });

// ---------------------------------------------------------------------------
// Questions and determinism
// ---------------------------------------------------------------------------

describe('trivia questions', () => {
  it('deals the same question, with the same option order, on both devices', () => {
    const t = table(['a', 'b'], 42, 3);
    for (let q = 0; q < 3; q++) {
      const seen = currentQuestion(t.of('a').currentState);
      expect(currentQuestion(t.of('b').currentState)).toEqual(seen);
      expect(seen.prompt.length).toBeGreaterThan(0);
      expect(seen.options).toHaveLength(4);
      expect(new Set(seen.options).size).toBe(4);
      expect(seen.position).toBe(q);
      expect(seen.total).toBe(3);

      const key = peekCorrect(t.of('a').currentState);
      t.submit('a', 'answer', { choice: key, elapsedMs: 1000 });
      t.submit('b', 'answer', { choice: wrongSlot(key), elapsedMs: 2000 });
      if (q < 2) t.submit('a', 'next', {});
    }
  });

  it('never repeats a question within one game', () => {
    const state = initial(['a', 'b'], 7);
    const prompts = new Set<string>();
    for (let i = 0; i < state.total; i++) prompts.add(currentQuestion({ ...state, position: i }).prompt);
    expect(state.total).toBe(10);
    expect(prompts.size).toBe(10);
  });

  it('deals a different deck for different seeds', () => {
    const firsts = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) firsts.add(currentQuestion(initial(['a', 'b'], seed)).prompt);
    expect(firsts.size).toBeGreaterThan(1);
  });

  it('deals well-formed questions from every corner of the bank', () => {
    // 50-question games over many seeds reach every entry in the bank; each
    // one must offer four distinct options and a key that lands on the same
    // option text whatever seed shuffled it.
    const keyByPrompt = new Map<string, string>();
    for (let seed = 1; seed <= 12; seed++) {
      const state = initial(['a', 'b'], seed, 50);
      for (let i = 0; i < 50; i++) {
        const at: TriviaState = { ...state, position: i };
        const view = currentQuestion(at);
        expect(view.options).toHaveLength(4);
        expect(new Set(view.options).size).toBe(4);
        expect(view.category.length).toBeGreaterThan(0);
        const key = peekCorrect(at);
        expect(key).toBeGreaterThanOrEqual(0);
        expect(key).toBeLessThanOrEqual(3);
        const text = view.options[key] as string;
        const known = keyByPrompt.get(view.prompt);
        if (known !== undefined) expect(text).toBe(known);
        keyByPrompt.set(view.prompt, text);
      }
    }
    expect(keyByPrompt.size).toBeGreaterThanOrEqual(80);
  });

  it('clamps a hostile or absurd question count', () => {
    expect(initial(['a', 'b'], 1, 0).total).toBe(1);
    expect(initial(['a', 'b'], 1, 9999).total).toBe(50);
    expect(initial(['a', 'b'], 1, 4).total).toBe(4);
    expect(
      trivia.createInitialState({ players: ['a', 'b'], seed: 1, options: { questions: 'lots' } }).total,
    ).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Answering and scoring
// ---------------------------------------------------------------------------

describe('trivia answering', () => {
  it('lets each player answer exactly once per question', () => {
    const t = table(['a', 'b'], 99, 3);
    const key = peekCorrect(t.state());
    expect(t.submit('a', 'answer', { choice: key, elapsedMs: 500 }).accepted).toBe(true);
    const again = t.submit('a', 'answer', { choice: wrongSlot(key), elapsedMs: 600 });
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already answered/);
    expect(hasAnswered(t.state(), 'a')).toBe(true);
    expect(hasAnswered(t.state(), 'b')).toBe(false);
    expect(t.state().choices).toEqual([key, UNANSWERED]);
  });

  it('closes the question by itself once everyone has answered', () => {
    const t = table(['a', 'b'], 5, 3);
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: key, elapsedMs: 1000 });
    expect(t.state().revealed).toBe(false);
    expect(revealedCorrect(t.state())).toBeNull();

    t.submit('b', 'answer', { choice: key, elapsedMs: 1000 });
    expect(t.state().revealed).toBe(true);
    expect(revealedCorrect(t.state())).toBe(key);
    // Still on the same question until the host moves on.
    expect(t.state().position).toBe(0);
    // Every device agrees.
    expect(trivia.encodeState(t.of('b').currentState)).toEqual(trivia.encodeState(t.state()));

    expect(t.submit('a', 'next', {}).accepted).toBe(true);
    expect(t.state().position).toBe(1);
    expect(t.state().revealed).toBe(false);
    expect(t.state().choices).toEqual([UNANSWERED, UNANSWERED]);
    expect(t.state().times).toEqual([0, 0]);
  });

  it('scores 100 for a correct answer and nothing for a wrong one', () => {
    const t = table(['a', 'b'], 21, 2);
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: key, elapsedMs: MAX_ANSWER_MS });
    t.submit('b', 'answer', { choice: wrongSlot(key), elapsedMs: 0 });
    expect(t.state().scores).toEqual([BASE_POINTS, 0]);
    expect(t.state().correct).toEqual([1, 0]);
  });

  it('adds a speed bonus of up to 50, scaled by the time taken', () => {
    const cases: readonly (readonly [number, number])[] = [
      [0, 150],
      [6_000, 140],
      [15_000, 125],
      [29_999, 100],
      [MAX_ANSWER_MS, 100],
    ];
    for (const [elapsedMs, expected] of cases) {
      const t = table(['a', 'b'], 1234, 1);
      const key = peekCorrect(t.state());
      t.submit('a', 'answer', { choice: key, elapsedMs });
      t.submit('b', 'answer', { choice: wrongSlot(key), elapsedMs: 0 });
      expect(t.state().scores[0]).toBe(expected);
      expect(t.state().scores[1]).toBe(0);
    }
  });

  it('clamps an untrusted elapsedMs instead of trusting it', () => {
    const slow = table(['a', 'b'], 8, 1);
    const slowKey = peekCorrect(slow.state());
    // 999,999 ms "elapsed" is clamped to the 30 s cut-off: no bonus, but the
    // answer still counts.
    expect(slow.submit('a', 'answer', { choice: slowKey, elapsedMs: 999_999 }).accepted).toBe(true);
    expect(slow.state().times[0]).toBe(MAX_ANSWER_MS);
    slow.submit('b', 'answer', { choice: wrongSlot(slowKey), elapsedMs: 10 });
    expect(slow.state().scores[0]).toBe(BASE_POINTS);

    // A negative claim is clamped to 0, which is the best case anyway - there
    // is nothing to gain by lying downwards.
    const fast = table(['a', 'b'], 8, 1);
    const fastKey = peekCorrect(fast.state());
    expect(fast.submit('a', 'answer', { choice: fastKey, elapsedMs: -50_000 }).accepted).toBe(true);
    expect(fast.state().times[0]).toBe(0);

    // A fractional claim is rounded, so the stored state stays integral.
    const odd = table(['a', 'b'], 8, 1);
    const oddKey = peekCorrect(odd.state());
    expect(odd.submit('a', 'answer', { choice: oddKey, elapsedMs: 1234.6 }).accepted).toBe(true);
    expect(odd.state().times[0]).toBe(1235);
  });

  it('applies no score at all until the question closes', () => {
    const t = table(['a', 'b'], 77, 3);
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: key, elapsedMs: 0 });
    expect(t.state().scores).toEqual([0, 0]);
    expect(t.state().correct).toEqual([0, 0]);
    t.submit('b', 'answer', { choice: wrongSlot(key), elapsedMs: 0 });
    expect(t.state().scores).toEqual([150, 0]);
  });

  it('lets the host call time, scoring only the players who answered', () => {
    const t = table(['a', 'b', 'c', 'd'], 31, 2);
    const key = peekCorrect(t.state());
    t.submit('b', 'answer', { choice: key, elapsedMs: 0 });
    t.submit('c', 'answer', { choice: wrongSlot(key), elapsedMs: 0 });
    // a and d never answer; the host closes the question.
    expect(t.submit('a', 'next', {}).accepted).toBe(true);
    expect(t.state().revealed).toBe(true);
    expect(t.state().scores).toEqual([0, 150, 0, 0]);
    expect(t.state().correct).toEqual([0, 1, 0, 0]);
    for (const p of ['a', 'b', 'c', 'd']) {
      expect(trivia.encodeState(t.of(p).currentState)).toEqual(trivia.encodeState(t.state()));
    }
  });

  it('ranks the leaderboard highest first', () => {
    const t = table(['a', 'b'], 64, 1);
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: wrongSlot(key), elapsedMs: 0 });
    t.submit('b', 'answer', { choice: key, elapsedMs: 0 });
    expect(leaderboard(t.state())).toEqual([
      { player: 'b', score: 150, correct: 1 },
      { player: 'a', score: 0, correct: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

describe('trivia endings', () => {
  it('declares the highest scorer the winner', () => {
    const t = table(['a', 'b'], 300, 2);
    for (let q = 0; q < 2; q++) {
      const key = peekCorrect(t.state());
      t.submit('a', 'answer', { choice: key, elapsedMs: 0 });
      t.submit('b', 'answer', { choice: wrongSlot(key), elapsedMs: 0 });
      if (q === 0) t.submit('a', 'next', {});
    }
    const status = t.of('a').status;
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['a']);
    expect(t.of('b').status.kind).toBe(GameStatusKind.WON);
    expect(t.state().scores).toEqual([300, 0]);
    expect(t.of('a').isOver).toBe(true);
  });

  it('calls a shared top score a draw', () => {
    const t = table(['a', 'b'], 301, 2);
    for (let q = 0; q < 2; q++) {
      const key = peekCorrect(t.state());
      t.submit('a', 'answer', { choice: key, elapsedMs: 4_000 });
      t.submit('b', 'answer', { choice: key, elapsedMs: 4_000 });
      if (q === 0) t.submit('a', 'next', {});
    }
    expect(t.state().scores[0]).toBe(t.state().scores[1]);
    expect(t.of('a').status.kind).toBe(GameStatusKind.DRAW);
    expect(t.of('b').status.kind).toBe(GameStatusKind.DRAW);
  });

  it('calls a game nobody scored in a draw too', () => {
    const t = table(['a', 'b'], 302, 1);
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: wrongSlot(key), elapsedMs: 0 });
    t.submit('b', 'answer', { choice: wrongSlot(key), elapsedMs: 0 });
    expect(t.state().scores).toEqual([0, 0]);
    expect(t.of('a').status.kind).toBe(GameStatusKind.DRAW);
  });

  it('finishes as soon as the last question closes, with no turn left', () => {
    const t = table(['a', 'b'], 303, 1);
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: key, elapsedMs: 0 });
    expect(t.of('a').turn).toBe('b');
    t.submit('b', 'answer', { choice: key, elapsedMs: 0 });
    expect(t.state().finished).toBe(true);
    expect(t.of('a').turn).toBeNull();
    expect(revealedCorrect(t.state())).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// Hostile peers
// ---------------------------------------------------------------------------

describe('trivia rejects', () => {
  it('an answer once the question has closed', () => {
    const t = table(['a', 'b', 'c'], 11, 3);
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: key, elapsedMs: 0 });
    t.submit('b', 'answer', { choice: key, elapsedMs: 0 });
    expect(t.submit('a', 'next', {}).accepted).toBe(true); // host closes it early
    const late = t.submit('c', 'answer', { choice: key, elapsedMs: 10 });
    expect(late.accepted).toBe(false);
    expect(late.accepted === false && late.detail).toMatch(/closed/);
  });

  it('a guest trying to advance the game', () => {
    const t = table(['a', 'b'], 12, 3);
    const r = t.submit('b', 'next', {});
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/host/);
  });

  it('a guest forging the host s advance action', () => {
    const t = table(['a', 'b'], 12, 3);
    // b encodes an action claiming to be from a. The session attributes it to
    // the authenticated sender, b, who is not the host - so it is refused.
    const forged = trivia.encodeAction({ type: 'next', player: 'a', seq: 0, payload: {} });
    const r = t.of('a').applyRemote(forged, 'b');
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/host/);
  });

  it('an action from somebody who is not in the game', () => {
    const t = table(['a', 'b'], 13, 3);
    const wire = trivia.encodeAction({ type: 'answer', player: 'a', seq: 0, payload: { choice: 0, elapsedMs: 0 } });
    const r = t.of('a').applyRemote(wire, 'mallory');
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.reason).toBe('notAPlayer');

    // validateAction refuses an unknown player on its own, without the runtime.
    const check = trivia.validateAction(
      t.state(),
      { type: 'answer', player: 'mallory', seq: 0, payload: { choice: 0, elapsedMs: 0 } },
      createContext(['a', 'b'], 13),
    );
    expect(check.ok).toBe(false);
  });

  it('a choice outside 0-3, in any shape', () => {
    const t = table(['a', 'b'], 14, 3);
    for (const choice of [4, -1, 1.5, 99, 1e12] as const) {
      expect(t.submit('a', 'answer', { choice, elapsedMs: 0 }).accepted).toBe(false);
    }
    for (const payload of [null, 'x', [], {}, { choice: 'two', elapsedMs: 0 }, { choice: 1 }] as CborValue[]) {
      expect(t.submit('a', 'answer', payload).accepted).toBe(false);
    }
    // An absurd elapsedMs is rejected outright rather than silently clamped.
    expect(t.submit('a', 'answer', { choice: 1, elapsedMs: 1e12 }).accepted).toBe(false);
    expect(t.state().choices).toEqual([UNANSWERED, UNANSWERED]);
  });

  it('an unknown action type', () => {
    const t = table(['a', 'b'], 15, 3);
    const r = t.of('a').applyRemote({ t: 'skip', s: 0, p: {} }, 'b');
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/unknown action/);
    expect(t.submit('a', 'skip', {}).accepted).toBe(false);
  });

  it('anything at all once the game is over', () => {
    const t = table(['a', 'b'], 16, 1);
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: key, elapsedMs: 0 });
    t.submit('b', 'answer', { choice: key, elapsedMs: 0 });
    expect(t.of('a').isOver).toBe(true);
    const late = t.submit('a', 'next', {});
    expect(late.accepted).toBe(false);
    expect(late.accepted === false && late.reason).toBe('gameOver');
    expect(t.submit('b', 'answer', { choice: key, elapsedMs: 0 }).accepted).toBe(false);
    // And directly, bypassing the runtime's own game-over guard.
    const check = trivia.validateAction(
      t.state(),
      { type: 'next', player: 'a', seq: 9, payload: {} },
      createContext(['a', 'b'], 16),
    );
    expect(check.ok).toBe(false);
  });

  it('a garbage state, without crashing', () => {
    const junk: CborValue[] = [
      null,
      0,
      'state',
      [],
      {},
      { p: ['a'], g: 1, n: 1, i: 0, r: false, f: false, c: [-1], m: [0], x: [0], k: [0] },
      { p: ['a', 'b'], g: 1, n: 1, i: 4, r: false, f: false, c: [-1, -1], m: [0, 0], x: [0, 0], k: [0, 0] },
      { p: ['a', 'b'], g: 1, n: 2, i: 0, r: false, f: false, c: [9, -1], m: [0, 0], x: [0, 0], k: [0, 0] },
      { p: ['a', 'b'], g: 1, n: 2, i: 0, r: false, f: false, c: [-1], m: [0, 0], x: [0, 0], k: [0, 0] },
      { p: ['a', 'b'], g: 1, n: 2, i: 0, r: 1, f: false, c: [-1, -1], m: [0, 0], x: [0, 0], k: [0, 0] },
      { p: ['a', 'b'], g: -5, n: 2, i: 0, r: false, f: false, c: [-1, -1], m: [0, 0], x: [0, 0], k: [0, 0] },
      { p: ['a', 'b'], g: 1, n: 2, i: 0, r: false, f: false, c: [-1, -1], m: [1e9, 0], x: [0, 0], k: [0, 0] },
    ];
    for (const value of junk) {
      expect(() => trivia.decodeState(value)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The answer key must not be readable early
// ---------------------------------------------------------------------------

describe('trivia keeps the answer key hidden', () => {
  it('will not reveal the correct option while the question is open', () => {
    const t = table(['a', 'b'], 404, 3);
    expect(revealedCorrect(t.state())).toBeNull();
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: key, elapsedMs: 100 });
    expect(revealedCorrect(t.state())).toBeNull();
    t.submit('b', 'answer', { choice: key, elapsedMs: 100 });
    expect(revealedCorrect(t.state())).toBe(key);
  });

  it('encodes no field that carries the key', () => {
    const t = table(['a', 'b'], 405, 3);
    t.submit('a', 'answer', { choice: 0, elapsedMs: 100 });
    const encoded = trivia.encodeState(t.state()) as Record<string, CborValue>;
    expect(Object.keys(encoded).sort()).toEqual(['c', 'f', 'g', 'i', 'k', 'm', 'n', 'p', 'r', 'x']);
    // Nothing derived from the answer has moved: no score, no tally, no reveal.
    expect(encoded.x).toEqual([0, 0]);
    expect(encoded.k).toEqual([0, 0]);
    expect(encoded.r).toBe(false);
  });

  it('produces an identical open-question state whatever the answer happens to be', () => {
    // Find two seeds whose first question has a DIFFERENT correct slot, drive
    // them identically, and show the encoded states differ only in the seed.
    // The seed is the one carrier of the key, and both peers already share it;
    // no other field varies with the answer, so a snapshot on the wire leaks
    // nothing that a player did not already have.
    let seedA = -1;
    let seedB = -1;
    let keyA = -1;
    for (let seed = 1; seed <= 200 && seedB < 0; seed++) {
      const key = peekCorrect(initial(['a', 'b'], seed, 3));
      if (seedA < 0) {
        seedA = seed;
        keyA = key;
      } else if (key !== keyA) {
        seedB = seed;
      }
    }
    expect(seedB).toBeGreaterThan(0);

    const drive = (seed: number): Record<string, CborValue> => {
      const t = table(['a', 'b'], seed, 3);
      t.submit('a', 'answer', { choice: 2, elapsedMs: 4_321 });
      const encoded = { ...(trivia.encodeState(t.state()) as Record<string, CborValue>) };
      delete encoded.g;
      return encoded;
    };
    expect(drive(seedA)).toEqual(drive(seedB));
  });
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe('trivia encoding', () => {
  it('round-trips actions exactly', () => {
    const answer: TriviaAction = { type: 'answer', player: 'a', seq: 3, payload: { choice: 2, elapsedMs: 4_500 } };
    expect(trivia.decodeAction(trivia.encodeAction(answer), 'a')).toEqual(answer);
    const next: TriviaAction = { type: 'next', player: 'a', seq: 4, payload: {} };
    expect(trivia.decodeAction(trivia.encodeAction(next), 'a')).toEqual(next);
    expect(trivia.encodeAction(answer)).toEqual({ t: 'answer', s: 3, p: { c: 2, m: 4_500 } });
  });

  it('round-trips a mid-game state exactly', () => {
    const t = table(['a', 'b', 'c'], 606, 4);
    const key = peekCorrect(t.state());
    t.submit('a', 'answer', { choice: key, elapsedMs: 900 });
    t.submit('b', 'answer', { choice: wrongSlot(key), elapsedMs: 12_345 });
    t.submit('c', 'answer', { choice: key, elapsedMs: 30_000 });
    t.submit('a', 'next', {});
    t.submit('b', 'answer', { choice: 1, elapsedMs: 7 });

    const encoded = trivia.encodeState(t.state());
    const restored = trivia.decodeState(encoded);
    expect(restored).toEqual(t.state());
    expect(trivia.encodeState(restored)).toEqual(encoded);
  });
});

// ---------------------------------------------------------------------------
// Purity and player counts
// ---------------------------------------------------------------------------

describe('trivia is a pure reducer', () => {
  it('never mutates the state handed to it', () => {
    // The shared conformance suite computes a "before" hash for this check but
    // never compares it, so this test does the comparison itself.
    const before = initial(['a', 'b', 'c'], 808, 2);
    const snapshot = JSON.parse(JSON.stringify(trivia.encodeState(before))) as unknown;
    const context = createContext(before.players, before.seed);
    const key = peekCorrect(before);

    const after = trivia.applyAction(
      before,
      { type: 'answer', player: 'b', seq: 0, payload: { choice: key, elapsedMs: 250 } },
      context,
    );
    expect(after).not.toBe(before);
    expect(after.choices).not.toBe(before.choices);
    expect(JSON.parse(JSON.stringify(trivia.encodeState(before)))).toEqual(snapshot);
    expect(before.choices).toEqual([UNANSWERED, UNANSWERED, UNANSWERED]);

    // ... including on the paths that close and advance a question.
    const closed = trivia.applyAction(after, { type: 'next', player: 'a', seq: 0, payload: {} }, context);
    const moved = trivia.applyAction(closed, { type: 'next', player: 'a', seq: 1, payload: {} }, context);
    expect(closed.revealed).toBe(true);
    expect(after.revealed).toBe(false);
    expect(moved.position).toBe(1);
    expect(closed.position).toBe(0);
    // 100 + floor(50 * (30000 - 250) / 30000) = 100 + 49. The bonus is floored,
    // never rounded, so both devices land on the same integer.
    expect(closed.scores).toEqual([0, 149, 0]);
    expect(after.scores).toEqual([0, 0, 0]);
  });

  it('runs a full eight-player game', () => {
    const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    const t = table(players, 909, 2);
    for (let q = 0; q < 2; q++) {
      const key = peekCorrect(t.state());
      players.forEach((p, i) => {
        expect(t.submit(p, 'answer', { choice: i === 0 ? key : wrongSlot(key), elapsedMs: i * 1_000 }).accepted).toBe(
          true,
        );
      });
      expect(t.state().revealed).toBe(true);
      if (q === 0) expect(t.submit('p1', 'next', {}).accepted).toBe(true);
    }
    expect(t.state().scores).toEqual([300, 0, 0, 0, 0, 0, 0, 0]);
    const status = t.of('p5').status;
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['p1']);
    for (const p of players) expect(trivia.encodeState(t.of(p).currentState)).toEqual(trivia.encodeState(t.state()));
  });

  it('refuses to seat too few or too many players', () => {
    const build = (players: string[]) =>
      new GameSession({
        definition: trivia,
        setup: { players, seed: 1, options: {} },
        localPlayer: players[0] as string,
        isHost: true,
      });
    expect(() => build(['solo'])).toThrow();
    expect(() => build(['1', '2', '3', '4', '5', '6', '7', '8', '9'])).toThrow();
    expect(() => build(['1', '2', '3', '4', '5', '6', '7', '8'])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Conformance
// ---------------------------------------------------------------------------

const hooks = {
  legalAction: (state: TriviaState, player: string, random: { nextInt(n: number): number }) => {
    if (trivia.currentTurn?.(state) !== player) return null;
    if (state.revealed) return { type: 'next', payload: {} as CborValue };
    return {
      type: 'answer',
      payload: { choice: random.nextInt(4), elapsedMs: random.nextInt(MAX_ANSWER_MS + 1) } as CborValue,
    };
  },
  maxPlies: 200,
};

describe('trivia conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(trivia, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(trivia, hooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
