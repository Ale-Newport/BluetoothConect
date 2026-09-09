import { describe, expect, it } from 'vitest';
import type { CborValue } from '@airlink/core';
import {
  GUESS_FEED_LIMIT,
  GuessKind,
  MAX_GUESSES_PER_ROUND,
  MAX_GUESS_LENGTH,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_ROUND,
  WORDS,
  currentDrawer,
  currentWord,
  drawAndGuess,
  isCloseGuess,
  isFinished,
  levenshtein,
  normaliseGuess,
  type DrawAndGuessAction,
  type DrawAndGuessState,
} from '../src/games/drawAndGuess.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameDecodeError, GameStatusKind, createContext } from '../src/engine.js';

const ctx = createContext(['a', 'b', 'c', 'd'], 1234);

function initial(players: readonly string[], seed = 7, options: Record<string, CborValue> = {}): DrawAndGuessState {
  return drawAndGuess.createInitialState({ players, seed, options });
}

/** Force a known word into every round so the rules can be tested directly. */
function withWord(state: DrawAndGuessState, word: string): DrawAndGuessState {
  const index = WORDS.findIndex((w) => w.word === word);
  expect(index).toBeGreaterThanOrEqual(0);
  return { ...state, words: state.words.map(() => index) };
}

function validate(state: DrawAndGuessState, action: DrawAndGuessAction) {
  return drawAndGuess.validateAction(state, action, ctx);
}

/** Validate then apply, the way the runtime does. Throws on an illegal action. */
function apply(state: DrawAndGuessState, action: DrawAndGuessAction): DrawAndGuessState {
  const result = validate(state, action);
  if (!result.ok) throw new Error(`unexpectedly rejected: ${result.reason}`);
  return drawAndGuess.applyAction(state, action, ctx);
}

function guess(player: string, text: string, seq = 0): DrawAndGuessAction {
  return { type: 'guess', player, seq, payload: { text } };
}

function stroke(player: string, points: number[], color = 3, width = 2, seq = 0): DrawAndGuessAction {
  return { type: 'stroke', player, seq, payload: { points, color, width } };
}

function endRound(player: string, seq = 0): DrawAndGuessAction {
  return { type: 'endRound', player, seq, payload: null };
}

/** A whole table of connected sessions, so every action is really broadcast. */
function table(players: readonly string[], seed = 9, options: Record<string, CborValue> = {}) {
  const setup = { players, seed, options };
  const sessions = new Map<string, GameSession<DrawAndGuessState, DrawAndGuessAction>>();
  players.forEach((p, i) => {
    sessions.set(p, new GameSession({ definition: drawAndGuess, setup, localPlayer: p, isHost: i === 0 }));
  });
  const view = (p: string) => sessions.get(p) as GameSession<DrawAndGuessState, DrawAndGuessAction>;
  const send = (from: string, type: string, payload: CborValue) => {
    const outcome = view(from).submitLocal(type, payload);
    if (outcome.accepted) {
      const wire = drawAndGuess.encodeAction(outcome.applied.action);
      for (const [id, peer] of sessions) {
        if (id === from) continue;
        const mirrored = peer.applyRemote(wire, from);
        expect(mirrored.accepted).toBe(true);
      }
    }
    return outcome;
  };
  const converged = () => {
    const encoded = players.map((p) => drawAndGuess.encodeState(view(p).currentState));
    for (const state of encoded) expect(state).toEqual(encoded[0]);
  };
  return { setup, view, send, converged };
}

// ---------------------------------------------------------------------------

describe('draw & guess word list', () => {
  it('ships at least 120 built-in words across three tiers', () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(120);
    expect(WORDS.filter((w) => w.tier === 0).length).toBeGreaterThanOrEqual(30);
    expect(WORDS.filter((w) => w.tier === 1).length).toBeGreaterThanOrEqual(30);
    expect(WORDS.filter((w) => w.tier === 2).length).toBeGreaterThanOrEqual(30);
  });

  it('has no empty or duplicate words once normalised', () => {
    const keys = WORDS.map((w) => normaliseGuess(w.word));
    for (const key of keys) expect(key.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(WORDS.length);
  });
});

describe('draw & guess setup', () => {
  it('starts with an empty canvas, zero scores and the first player drawing', () => {
    const state = initial(['a', 'b', 'c']);
    expect(state.round).toBe(0);
    expect(state.totalRounds).toBe(3); // one round per player by default
    expect(state.strokes).toEqual([]);
    expect(state.guesses).toEqual([]);
    expect(state.scores).toEqual([0, 0, 0]);
    expect(state.solved).toEqual([false, false, false]);
    expect(currentDrawer(state)).toBe('a');
    expect(currentWord(state)).toBeTruthy();
  });

  it('picks the same words on both devices from the shared seed', () => {
    const left = initial(['a', 'b'], 4242);
    const right = initial(['a', 'b'], 4242);
    expect(left.words).toEqual(right.words);
    expect(currentWord(left)).toBe(currentWord(right));
  });

  it('picks different words for different seeds', () => {
    const first = new Set<number | undefined>();
    for (let seed = 1; seed <= 20; seed++) first.add(initial(['a', 'b'], seed).words[0]);
    expect(first.size).toBeGreaterThan(1);
  });

  it('honours a rounds option and ignores a nonsensical one', () => {
    expect(initial(['a', 'b'], 7, { rounds: 5 }).totalRounds).toBe(5);
    expect(initial(['a', 'b'], 7, { rounds: 0 }).totalRounds).toBe(2);
    expect(initial(['a', 'b'], 7, { rounds: 9999 }).totalRounds).toBe(2);
    expect(initial(['a', 'b'], 7, { rounds: 'lots' }).totalRounds).toBe(2);
  });

  it('honours a difficulty option', () => {
    const easy = initial(['a', 'b'], 11, { difficulty: 'easy', rounds: 8 });
    for (const index of easy.words) expect(WORDS[index]?.tier).toBe(0);
    const hard = initial(['a', 'b'], 11, { difficulty: 'hard', rounds: 8 });
    for (const index of hard.words) expect(WORDS[index]?.tier).toBe(2);
  });

  it('refuses an impossible player count', () => {
    expect(() => initial(['a'])).toThrow();
    expect(() => initial(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toThrow();
  });
});

describe('draw & guess drawing', () => {
  it('lets the drawer add a stroke without mutating the previous state', () => {
    const before = initial(['a', 'b']);
    const after = apply(before, stroke('a', [10, 20, 30, 40]));
    expect(before.strokes).toEqual([]);
    expect(after.strokes).toEqual([{ points: [10, 20, 30, 40], color: 3, width: 2 }]);
    expect(after).not.toBe(before);
  });

  it('rejects a stroke from anyone but the drawer', () => {
    const state = initial(['a', 'b', 'c']);
    const result = validate(state, stroke('b', [1, 1]));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/only the drawer/);
  });

  it('rejects a stroke with too many points', () => {
    const state = initial(['a', 'b']);
    const tooMany = Array.from({ length: MAX_POINTS_PER_STROKE * 2 + 2 }, () => 5);
    expect(validate(state, stroke('a', tooMany)).ok).toBe(false);
    const justRight = Array.from({ length: MAX_POINTS_PER_STROKE * 2 }, () => 5);
    expect(validate(state, stroke('a', justRight)).ok).toBe(true);
  });

  it('rejects half a point, an empty stroke and out-of-range values', () => {
    const state = initial(['a', 'b']);
    expect(validate(state, stroke('a', [1, 2, 3])).ok).toBe(false);
    expect(validate(state, stroke('a', [])).ok).toBe(false);
    expect(validate(state, stroke('a', [0, 1001])).ok).toBe(false);
    expect(validate(state, stroke('a', [0, -1])).ok).toBe(false);
    expect(validate(state, stroke('a', [0, 0.5])).ok).toBe(false);
    expect(validate(state, stroke('a', [0, 0], 16, 2)).ok).toBe(false);
    expect(validate(state, stroke('a', [0, 0], 3, 0)).ok).toBe(false);
    expect(validate(state, stroke('a', [0, 0], 3, 9)).ok).toBe(false);
  });

  it('caps the canvas at 400 strokes per round', () => {
    let state = initial(['a', 'b']);
    for (let i = 0; i < MAX_STROKES_PER_ROUND; i++) state = apply(state, stroke('a', [i % 1000, 1]));
    expect(state.strokes.length).toBe(MAX_STROKES_PER_ROUND);
    const result = validate(state, stroke('a', [1, 1]));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/canvas is full/);
  });

  it('undoes only the last stroke, and only for the drawer', () => {
    let state = initial(['a', 'b']);
    expect(validate(state, { type: 'undo', player: 'a', seq: 0, payload: null }).ok).toBe(false);
    state = apply(state, stroke('a', [1, 1]));
    state = apply(state, stroke('a', [2, 2]));
    expect(validate(state, { type: 'undo', player: 'b', seq: 0, payload: null }).ok).toBe(false);
    state = apply(state, { type: 'undo', player: 'a', seq: 0, payload: null });
    expect(state.strokes).toEqual([{ points: [1, 1], color: 3, width: 2 }]);
  });

  it('clears the canvas, and only for the drawer', () => {
    let state = initial(['a', 'b']);
    expect(validate(state, { type: 'clear', player: 'a', seq: 0, payload: null }).ok).toBe(false);
    state = apply(state, stroke('a', [1, 1]));
    expect(validate(state, { type: 'clear', player: 'b', seq: 0, payload: null }).ok).toBe(false);
    state = apply(state, { type: 'clear', player: 'a', seq: 0, payload: null });
    expect(state.strokes).toEqual([]);
  });
});

describe('draw & guess guessing', () => {
  it('scores a correct guess for the guesser and the drawer', () => {
    const state = withWord(initial(['a', 'b', 'c'], 7, { rounds: 3 }), 'castle');
    const after = apply(state, guess('b', 'castle'));
    expect(after.scores).toEqual([1, 3, 0]); // drawer +1, first solver +3
    expect(after.solved).toEqual([false, true, false]);
    expect(after.round).toBe(0); // c has not solved yet, the round continues
  });

  it('never stores a correct guess in plain text', () => {
    const state = withWord(initial(['a', 'b', 'c'], 7, { rounds: 3 }), 'castle');
    const after = apply(state, guess('b', 'castle'));
    expect(after.guesses).toEqual([{ player: 1, kind: GuessKind.CORRECT, text: '' }]);
    const wire = JSON.stringify(drawAndGuess.encodeState(after));
    expect(wire).not.toContain('castle');
  });

  it('awards 3, then 2, then 1 to later solvers', () => {
    let state = withWord(initial(['a', 'b', 'c', 'd'], 7), 'rocket');
    state = apply(state, guess('c', 'rocket'));
    state = apply(state, guess('b', 'rocket'));
    expect(state.scores).toEqual([2, 2, 3, 0]); // drawer a: +1 per solver
    state = apply(state, guess('d', 'rocket'));
    // Everyone but the drawer has it, so the round ends immediately.
    expect(state.scores).toEqual([3, 2, 3, 1]);
    expect(state.round).toBe(1);
    expect(state.solved).toEqual([false, false, false, false]);
    expect(state.guesses).toEqual([]);
  });

  it('keeps a wrong guess in the feed and scores nothing for it', () => {
    const state = withWord(initial(['a', 'b'], 7), 'castle');
    const after = apply(state, guess('b', '  Banana  '));
    expect(after.scores).toEqual([0, 0]);
    expect(after.solved).toEqual([false, false]);
    expect(after.guesses).toEqual([{ player: 1, kind: GuessKind.WRONG, text: 'Banana' }]);
    expect(after.guessCount).toBe(1);
  });

  it('flags a one-edit guess as close without revealing it', () => {
    const state = withWord(initial(['a', 'b'], 7), 'apple');
    for (const near of ['apples', 'aple', 'ample']) {
      const after = apply(state, guess('b', near));
      expect(after.guesses).toEqual([{ player: 1, kind: GuessKind.CLOSE, text: '' }]);
      expect(after.scores).toEqual([0, 0]);
      expect(JSON.stringify(drawAndGuess.encodeState(after))).not.toContain(near);
    }
    // Two edits away is just wrong, and travels in full.
    const far = apply(state, guess('b', 'apricot'));
    expect(far.guesses[0]?.kind).toBe(GuessKind.WRONG);
    expect(far.guesses[0]?.text).toBe('apricot');
  });

  it('matches case-insensitively, accent-insensitively and after trimming', () => {
    const state = withWord(initial(['a', 'b'], 7), 'déjà vu');
    for (const attempt of ['  DÉJÀ VU ', 'deja vu', 'Déjà-Vu!', 'DEJA   vu']) {
      // The lone guesser solving ends the round at once, so `solved` has
      // already been reset - the score is what proves the guess landed.
      const after = apply(state, guess('b', attempt));
      expect(after.scores).toEqual([1, 3]);
      expect(after.round).toBe(1);
    }
    expect(apply(state, guess('b', 'deja vus')).guesses[0]?.kind).toBe(GuessKind.CLOSE);
  });

  it('refuses to let the drawer guess their own word', () => {
    const state = withWord(initial(['a', 'b'], 7), 'castle');
    const result = validate(state, guess('a', 'castle'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/drawer cannot guess/);
  });

  it('refuses a second guess from a player who already solved', () => {
    const state = withWord(initial(['a', 'b', 'c'], 7), 'castle');
    const after = apply(state, guess('b', 'castle'));
    expect(validate(after, guess('b', 'castle')).ok).toBe(false);
    expect(validate(after, guess('c', 'castle')).ok).toBe(true);
  });

  it('refuses an empty guess and one from a stranger', () => {
    const state = initial(['a', 'b'], 7);
    expect(validate(state, guess('b', '   ')).ok).toBe(false);
    expect(validate(state, guess('b', '!!!')).ok).toBe(false);
    expect(validate(state, guess('mallory', 'castle')).ok).toBe(false);
  });

  it('bounds the guess feed and the number of guesses per round', () => {
    let state = withWord(initial(['a', 'b'], 7), 'castle');
    for (let i = 0; i < GUESS_FEED_LIMIT + 5; i++) state = apply(state, guess('b', `try ${i}`));
    expect(state.guesses.length).toBe(GUESS_FEED_LIMIT);
    expect(state.guesses[0]?.text).toBe(`try ${5}`); // the oldest entries fall off
    expect(state.guessCount).toBe(GUESS_FEED_LIMIT + 5);

    while (state.guessCount < MAX_GUESSES_PER_ROUND) state = apply(state, guess('b', `try ${state.guessCount}`));
    const result = validate(state, guess('b', 'one more'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/too many guesses/);
  });
});

describe('draw & guess rounds', () => {
  it('rotates the pen and resets the canvas at the end of a round', () => {
    let state = withWord(initial(['a', 'b', 'c'], 7), 'castle');
    state = apply(state, stroke('a', [1, 2]));
    state = apply(state, guess('b', 'castle'));
    state = apply(state, guess('c', 'nope'));
    state = apply(state, endRound('a'));
    expect(state.round).toBe(1);
    expect(currentDrawer(state)).toBe('b');
    expect(state.strokes).toEqual([]);
    expect(state.guesses).toEqual([]);
    expect(state.guessCount).toBe(0);
    expect(state.solved).toEqual([false, false, false]);
    expect(state.scores).toEqual([1, 3, 0]); // scores survive the round change
  });

  it('rotates through every player and then finishes', () => {
    let state = initial(['a', 'b', 'c', 'd'], 7);
    for (const drawer of ['a', 'b', 'c', 'd']) {
      expect(currentDrawer(state)).toBe(drawer);
      expect(isFinished(state)).toBe(false);
      state = apply(state, endRound(drawer));
    }
    expect(isFinished(state)).toBe(true);
    expect(currentDrawer(state)).toBeNull();
    expect(currentWord(state)).toBeNull();
    expect(drawAndGuess.status(state).kind).toBe(GameStatusKind.DRAW);
  });

  it('wraps the rotation when there are more rounds than players', () => {
    let state = initial(['a', 'b', 'c'], 7, { rounds: 5 });
    const seen: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(currentDrawer(state));
      state = apply(state, endRound(seen[i] as string));
    }
    expect(seen).toEqual(['a', 'b', 'c', 'a', 'b']);
    expect(isFinished(state)).toBe(true);
  });

  it('lets only the drawer end the round', () => {
    const state = initial(['a', 'b', 'c'], 7);
    expect(validate(state, endRound('b')).ok).toBe(false);
    expect(validate(state, endRound('a')).ok).toBe(true);
  });

  it('rejects every action once the game is over', () => {
    let state = initial(['a', 'b'], 7, { rounds: 1 });
    state = apply(state, endRound('a'));
    expect(isFinished(state)).toBe(true);
    for (const action of [stroke('a', [1, 1]), guess('b', 'castle'), endRound('a')]) {
      const result = validate(state, action);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/already finished/);
    }
  });

  it('declares the highest scorer the winner', () => {
    let state = withWord(initial(['a', 'b'], 7, { rounds: 1 }), 'castle');
    state = apply(state, guess('b', 'castle')); // b solves; the only guesser, so the round ends
    expect(isFinished(state)).toBe(true);
    expect(state.scores).toEqual([1, 3]);
    const status = drawAndGuess.status(state);
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['b']);
  });
});

describe('draw & guess over a real session pair', () => {
  it('keeps four devices byte-identical through a whole round', () => {
    const t = table(['a', 'b', 'c', 'd'], 31);
    const word = currentWord(t.view('a').currentState) as string;

    expect(t.send('a', 'stroke', { points: [0, 0, 500, 500], color: 2, width: 4 }).accepted).toBe(true);
    expect(t.send('b', 'guess', { text: 'definitely not it' }).accepted).toBe(true);
    expect(t.send('c', 'guess', { text: word.toUpperCase() }).accepted).toBe(true);
    t.converged();

    const state = t.view('d').currentState;
    expect(state.scores[2]).toBe(3);
    expect(state.scores[0]).toBe(1);
    expect(state.guesses.some((g) => g.text.length > 0 && normaliseGuess(g.text) === normaliseGuess(word))).toBe(false);

    expect(t.send('a', 'endRound', null).accepted).toBe(true);
    expect(currentDrawer(t.view('a').currentState)).toBe('b');
    t.converged();
  });

  it('refuses a stroke from a guesser and a guess from the drawer over the wire', () => {
    const t = table(['a', 'b'], 31);
    expect(t.send('b', 'stroke', { points: [1, 1], color: 0, width: 1 }).accepted).toBe(false);
    const word = currentWord(t.view('a').currentState) as string;
    expect(t.send('a', 'guess', { text: word }).accepted).toBe(false);
  });

  it('refuses a forged action attributed to a player who is not at the table', () => {
    const t = table(['a', 'b'], 31);
    const forged = drawAndGuess.encodeAction({
      type: 'stroke',
      player: 'a',
      seq: 0,
      payload: { points: [1, 1], color: 0, width: 1 },
    });
    const result = t.view('b').applyRemote(forged, 'mallory');
    expect(result.accepted).toBe(false);
    expect(result.accepted === false && result.reason).toBe('notAPlayer');
    // Re-attributed to the sender we actually authenticated, it is just illegal:
    // b is not the drawer.
    expect(t.view('b').applyRemote(forged, 'b').accepted).toBe(false);
  });

  it('rejects a replayed or out-of-order action', () => {
    const t = table(['a', 'b'], 31);
    const outcome = t.view('a').submitLocal('stroke', { points: [1, 1], color: 0, width: 1 });
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;
    const wire = drawAndGuess.encodeAction(outcome.applied.action);
    expect(t.view('b').applyRemote(wire, 'a').accepted).toBe(true);
    const again = t.view('b').applyRemote(wire, 'a');
    expect(again.accepted === false && again.reason).toBe('duplicate');
    const ahead = drawAndGuess.encodeAction({ ...outcome.applied.action, seq: 9 } as DrawAndGuessAction);
    const skipped = t.view('b').applyRemote(ahead, 'a');
    expect(skipped.accepted === false && skipped.reason).toBe('outOfOrder');
  });

  it('rejects an oversized stroke before it is ever applied', () => {
    const t = table(['a', 'b'], 31);
    const points = Array.from({ length: MAX_POINTS_PER_STROKE * 2 + 2 }, () => 1);
    const result = t.send('a', 'stroke', { points, color: 0, width: 1 });
    expect(result.accepted).toBe(false);
    expect(t.view('a').currentState.strokes).toEqual([]);
  });

  it('rejects an over-long guess before it is ever applied', () => {
    const t = table(['a', 'b'], 31);
    const result = t.send('b', 'guess', { text: 'x'.repeat(MAX_GUESS_LENGTH + 1) });
    expect(result.accepted).toBe(false);
    expect(t.view('b').currentState.guesses).toEqual([]);
  });
});

describe('draw & guess wire format', () => {
  it('round-trips every action type exactly', () => {
    const actions: DrawAndGuessAction[] = [
      stroke('a', [0, 1000, 7, 8], 15, 8, 3),
      { type: 'undo', player: 'a', seq: 1, payload: null },
      { type: 'clear', player: 'a', seq: 2, payload: null },
      { type: 'endRound', player: 'a', seq: 3, payload: null },
      guess('b', 'a wild guess', 4),
    ];
    for (const action of actions) {
      const restored = drawAndGuess.decodeAction(drawAndGuess.encodeAction(action), action.player);
      expect(restored).toEqual(action);
      expect(drawAndGuess.encodeAction(restored)).toEqual(drawAndGuess.encodeAction(action));
    }
  });

  it('round-trips a played state exactly', () => {
    let state = withWord(initial(['a', 'b', 'c'], 7), 'castle');
    state = apply(state, stroke('a', [1, 2, 3, 4], 9, 5));
    state = apply(state, guess('b', 'castel')); // close
    state = apply(state, guess('c', 'donkey')); // wrong
    state = apply(state, guess('b', 'castle')); // correct
    const encoded = drawAndGuess.encodeState(state);
    const restored = drawAndGuess.decodeState(encoded);
    expect(restored).toEqual(state);
    expect(drawAndGuess.encodeState(restored)).toEqual(encoded);
  });

  it('throws on hostile actions instead of trusting them', () => {
    const hostile: CborValue[] = [
      null,
      42,
      'nope',
      [],
      {},
      { t: 'stroke' },
      { t: 'stroke', s: -1, p: { p: [1, 1], c: 0, w: 1 } },
      { t: 'stroke', s: 1.5, p: { p: [1, 1], c: 0, w: 1 } },
      { t: 'mystery', s: 0, p: null },
      { t: 'stroke', s: 0, p: [1, 2] },
      { t: 'stroke', s: 0, p: { p: [1, 2, 3], c: 0, w: 1 } },
      { t: 'stroke', s: 0, p: { p: [], c: 0, w: 1 } },
      { t: 'stroke', s: 0, p: { p: Array.from({ length: 402 }, () => 1), c: 0, w: 1 } },
      { t: 'stroke', s: 0, p: { p: [0, 1001], c: 0, w: 1 } },
      { t: 'stroke', s: 0, p: { p: [0, -1], c: 0, w: 1 } },
      { t: 'stroke', s: 0, p: { p: [0, 0], c: 16, w: 1 } },
      { t: 'stroke', s: 0, p: { p: [0, 0], c: 0, w: 0 } },
      { t: 'stroke', s: 0, p: { p: [0, 0], c: 0, w: 9 } },
      { t: 'stroke', s: 0, p: { p: [0, 1e12], c: 0, w: 1 } },
      { t: 'guess', s: 0, p: null },
      { t: 'guess', s: 0, p: { g: 5 } },
      { t: 'guess', s: 0, p: { g: 'x'.repeat(65) } },
      { t: 'x'.repeat(500), s: 0, p: null },
    ];
    for (const junk of hostile) {
      expect(() => drawAndGuess.decodeAction(junk, 'a')).toThrow(GameDecodeError);
    }
  });

  it('never lets a peer smuggle the answer into the shared feed', () => {
    const state = withWord(initial(['a', 'b'], 7), 'castle');
    const encoded = drawAndGuess.encodeState(state) as Record<string, CborValue>;
    for (const kind of [GuessKind.CLOSE, GuessKind.CORRECT]) {
      const forged = { ...encoded, g: [{ i: 1, k: kind, t: 'castle' }] };
      expect(() => drawAndGuess.decodeState(forged)).toThrow(GameDecodeError);
    }
    // A wrong guess with text is perfectly legitimate.
    expect(() => drawAndGuess.decodeState({ ...encoded, g: [{ i: 1, k: 0, t: 'banana' }] })).not.toThrow();
  });

  it('rejects a malformed state from a peer', () => {
    const state = withWord(initial(['a', 'b'], 7), 'castle');
    const encoded = drawAndGuess.encodeState(state) as Record<string, CborValue>;
    const mutations: Record<string, CborValue>[] = [
      { ...encoded, p: ['only-one'] },
      { ...encoded, p: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      { ...encoded, n: 0 },
      { ...encoded, n: 9999 },
      { ...encoded, r: 3 }, // beyond totalRounds
      { ...encoded, w: [] },
      { ...encoded, w: [WORDS.length, WORDS.length] },
      { ...encoded, v: 4 }, // a solved bit for a player who does not exist
      { ...encoded, v: -1 },
      { ...encoded, c: -1 },
      { ...encoded, s: [0] },
      { ...encoded, s: [0, -5] },
      { ...encoded, k: [{ p: [0, 1001], c: 0, w: 1 }] },
      { ...encoded, k: [{ p: [0, 0, 0], c: 0, w: 1 }] },
      { ...encoded, k: [{ p: [0, 0], c: 99, w: 1 }] },
      { ...encoded, g: [{ i: 7, k: 0, t: 'hi' }] },
      { ...encoded, g: [{ i: 0, k: 5, t: '' }] },
      { ...encoded, g: Array.from({ length: GUESS_FEED_LIMIT + 1 }, () => ({ i: 0, k: 0, t: 'hi' })) },
    ];
    for (const forged of mutations) {
      expect(() => drawAndGuess.decodeState(forged)).toThrow(GameDecodeError);
    }
  });
});

describe('draw & guess text matching', () => {
  it('folds case, accents, punctuation and runs of whitespace', () => {
    expect(normaliseGuess('  DÉJÀ-VU!! ')).toBe('deja vu');
    expect(normaliseGuess('Ice   Cream')).toBe('ice cream');
    expect(normaliseGuess('straße')).toBe('strasse');
    expect(normaliseGuess('CAFÉ ☕')).toBe('cafe');
    expect(normaliseGuess('!?!')).toBe('');
  });

  it('folds a decomposed accent the same as a precomposed one', () => {
    const precomposed = 'déjà vu';
    const decomposed = 'déjà vu';
    expect(precomposed).not.toBe(decomposed); // different bytes on the wire
    expect(normaliseGuess(decomposed)).toBe('deja vu');
    expect(normaliseGuess(decomposed)).toBe(normaliseGuess(precomposed));
  });

  it('measures edit distance the boring, deterministic way', () => {
    expect(levenshtein('apple', 'apple')).toBe(0);
    expect(levenshtein('apple', 'apples')).toBe(1);
    expect(levenshtein('apple', 'ample')).toBe(1);
    expect(levenshtein('apple', 'aple')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('apple', 'banana')).toBe(5);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(isCloseGuess('apple', 'apple')).toBe(false);
    expect(isCloseGuess('aple', 'apple')).toBe(true);
    expect(isCloseGuess('apricot', 'apple')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The shared conformance suite. currentTurn() is null for this game - a round
// is not one player's turn - so the driver picks either player each ply, which
// exercises drawing and guessing side by side.
// ---------------------------------------------------------------------------

function conformanceHooks() {
  return {
    legalAction: (state: DrawAndGuessState, player: string, random: { nextInt(n: number): number }) => {
      if (isFinished(state)) return null;
      const word = currentWord(state) ?? 'x';
      if (player === currentDrawer(state)) {
        if (state.strokes.length >= 3) {
          const roll = random.nextInt(4);
          if (roll === 0) return { type: 'undo', payload: null };
          if (roll === 1) return { type: 'clear', payload: null };
          return { type: 'endRound', payload: null };
        }
        const points: number[] = [];
        for (let i = 0; i < 1 + random.nextInt(3); i++) {
          points.push(random.nextInt(1001), random.nextInt(1001));
        }
        return { type: 'stroke', payload: { points, color: random.nextInt(16), width: 1 + random.nextInt(8) } };
      }
      // Unreachable at two players (a lone guesser solving ends the round), but
      // a solved guesser genuinely has nothing legal left to send.
      const index = state.players.indexOf(player);
      if (state.solved[index] === true) return null;
      const roll = random.nextInt(6);
      if (roll === 0) return { type: 'guess', payload: { text: word } };
      if (roll === 1) return { type: 'guess', payload: { text: `${word}x` } }; // one edit away
      return { type: 'guess', payload: { text: `guess ${random.nextInt(1000)}` } };
    },
    maxPlies: 300,
  };
}

describe('draw & guess conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(drawAndGuess, conformanceHooks());
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(drawAndGuess, conformanceHooks(), seed);
      expect(report.failures).toEqual([]);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
