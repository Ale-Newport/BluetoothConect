import { describe, expect, it } from 'vitest';
import {
  CELL_COUNT,
  findAllWords,
  neighbours,
  pathSpells,
  scoreForLength,
  scores,
  wordDuel,
  type WordDuelState,
} from '../src/games/wordDuel.js';
import { DICTIONARY, isWord } from '../src/games/wordList.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 4242, options: {} };
const ctx = createContext(setup.players, setup.seed);

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: wordDuel, setup, localPlayer: local, isHost });
}

/** A grid we control, so tests assert on rules rather than on the letter draw. */
function gridState(letters: string, patch: Partial<WordDuelState> = {}): WordDuelState {
  const base = wordDuel.createInitialState(setup);
  return { ...base, grid: letters.split(''), ...patch };
}

describe('word list', () => {
  it('is sorted, which is what makes the binary search correct', () => {
    for (let i = 1; i < DICTIONARY.length; i++) {
      if ((DICTIONARY[i] as string) <= (DICTIONARY[i - 1] as string)) {
        throw new Error(`dictionary out of order at ${i}: ${DICTIONARY[i - 1]} then ${DICTIONARY[i]}`);
      }
    }
  });

  it('agrees with a linear scan for every word it contains', () => {
    // Sampling the whole list would be slow; every 40th word plus the edges is
    // enough to catch an off-by-one in the bisection.
    const sample = DICTIONARY.filter((_, i) => i % 40 === 0);
    for (const word of [...sample, DICTIONARY[0] as string, DICTIONARY[DICTIONARY.length - 1] as string]) {
      expect(isWord(word)).toBe(true);
    }
  });

  it('rejects words it does not contain', () => {
    for (const word of ['qqqq', 'zzzzzzzz', 'xyzzy', 'blorp']) {
      expect(isWord(word)).toBe(false);
    }
  });

  it('rejects words outside the length bounds', () => {
    expect(isWord('at')).toBe(false);
    expect(isWord('extraordinary')).toBe(false);
  });
});

describe('grid geometry', () => {
  it('gives a corner three neighbours and the middle eight', () => {
    expect(neighbours(0).sort((x, y) => x - y)).toEqual([1, 4, 5]);
    expect(neighbours(5)).toHaveLength(8);
    expect(neighbours(15).sort((x, y) => x - y)).toEqual([10, 11, 14]);
  });

  it('accepts a genuinely adjacent path', () => {
    //  c a t s
    //  o r e d
    //  ...
    const grid = 'catsoredlimpnest'.split('');
    expect(pathSpells(grid, 'cat', [0, 1, 2])).toBe(true);
    expect(pathSpells(grid, 'car', [0, 1, 5])).toBe(true);
  });

  it('rejects a path that jumps, repeats a cell, or misspells', () => {
    const grid = 'catsoredlimpnest'.split('');
    expect(pathSpells(grid, 'cs', [0, 3])).toBe(false); // not adjacent
    expect(pathSpells(grid, 'cac', [0, 1, 0])).toBe(false); // reuses a cell
    expect(pathSpells(grid, 'cot', [0, 1, 2])).toBe(false); // letters do not match
    expect(pathSpells(grid, 'cat', [0, 1])).toBe(false); // length mismatch
    expect(pathSpells(grid, 'cat', [0, 1, 99])).toBe(false); // out of range
    expect(pathSpells(grid, 'cat', [0, 1, -1])).toBe(false);
  });
});

describe('scoring', () => {
  it('rewards length steeply', () => {
    expect(scoreForLength(3)).toBe(1);
    expect(scoreForLength(4)).toBe(1);
    expect(scoreForLength(5)).toBe(2);
    expect(scoreForLength(6)).toBe(3);
    expect(scoreForLength(7)).toBe(5);
    expect(scoreForLength(8)).toBe(11);
  });

  it('cancels a word both players found', () => {
    const state = gridState('catsoredlimpnest', {
      submissions: [
        { player: 'a', word: 'cat', path: [0, 1, 2] },
        { player: 'b', word: 'cat', path: [0, 1, 2] },
        { player: 'a', word: 'core', path: [0, 4, 5, 6] },
      ],
    });
    const totals = scores(state);
    expect(totals.get('a')).toBe(1); // only 'core' counts
    expect(totals.get('b')).toBe(0);
  });
});

describe('word duel rules', () => {
  it('generates the same grid on both devices from the shared seed', () => {
    const a = session('a', true);
    const b = session('b', false);
    expect(a.currentState.grid).toEqual(b.currentState.grid);
    expect(a.currentState.grid).toHaveLength(CELL_COUNT);
    expect(a.currentState.grid.every((c) => /^[a-z]$/.test(c))).toBe(true);
  });

  it('has no turn: both players hunt at once', () => {
    expect(wordDuel.currentTurn?.(session('a', true).currentState)).toBeNull();
  });

  it('accepts a real word on a real path', () => {
    const state = gridState('catsoredlimpnest');
    const action = wordDuel.decodeAction(
      wordDuel.encodeAction({ type: 'submit', player: 'a', seq: 0, payload: { word: 'cat', path: [0, 1, 2] } }),
      'a',
    );
    expect(wordDuel.validateAction(state, action, ctx).ok).toBe(true);
  });

  it('rejects a word that is not in the dictionary', () => {
    const state = gridState('catsoredlimpnest');
    const action = wordDuel.decodeAction(
      wordDuel.encodeAction({ type: 'submit', player: 'a', seq: 0, payload: { word: 'cta', path: [0, 2, 1] } }),
      'a',
    );
    const result = wordDuel.validateAction(state, action, ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/dictionary/);
  });

  it('rejects a real word whose path does not exist on the grid', () => {
    const state = gridState('catsoredlimpnest');
    const action = wordDuel.decodeAction(
      wordDuel.encodeAction({ type: 'submit', player: 'a', seq: 0, payload: { word: 'cat', path: [0, 3, 2] } }),
      'a',
    );
    const result = wordDuel.validateAction(state, action, ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/path/);
  });

  it('rejects the same word twice from one player but allows it from the other', () => {
    let state = gridState('catsoredlimpnest');
    const submit = (player: 'a' | 'b', seq: number) =>
      wordDuel.decodeAction(
        wordDuel.encodeAction({ type: 'submit', player, seq, payload: { word: 'cat', path: [0, 1, 2] } }),
        player,
      );
    state = wordDuel.applyAction(state, submit('a', 0), ctx);
    expect(wordDuel.validateAction(state, submit('a', 1), ctx).ok).toBe(false);
    expect(wordDuel.validateAction(state, submit('b', 0), ctx).ok).toBe(true);
  });

  it('rejects a word shorter than three letters', () => {
    const state = gridState('catsoredlimpnest');
    const action = wordDuel.decodeAction(
      wordDuel.encodeAction({ type: 'submit', player: 'a', seq: 0, payload: { word: 'at', path: [1, 2] } }),
      'a',
    );
    expect(wordDuel.validateAction(state, action, ctx).ok).toBe(false);
  });

  it('ends when both players finish, and names the winner', () => {
    let state = gridState('catsoredlimpnest', {
      submissions: [{ player: 'a', word: 'core', path: [0, 4, 5, 6] }],
    });
    const finish = (player: 'a' | 'b') =>
      wordDuel.decodeAction(wordDuel.encodeAction({ type: 'finish', player, seq: 5, payload: null }), player);

    state = wordDuel.applyAction(state, finish('a'), ctx);
    expect(wordDuel.status(state).kind).toBe(GameStatusKind.IN_PROGRESS);
    state = wordDuel.applyAction(state, finish('b'), ctx);
    const status = wordDuel.status(state);
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['a']);
  });

  it('draws when both players end level', () => {
    let state = gridState('catsoredlimpnest');
    const finish = (player: 'a' | 'b') =>
      wordDuel.decodeAction(wordDuel.encodeAction({ type: 'finish', player, seq: 0, payload: null }), player);
    state = wordDuel.applyAction(state, finish('a'), ctx);
    state = wordDuel.applyAction(state, finish('b'), ctx);
    expect(wordDuel.status(state).kind).toBe(GameStatusKind.DRAW);
  });

  it('refuses anything once a player has finished', () => {
    let state = gridState('catsoredlimpnest');
    state = wordDuel.applyAction(
      state,
      wordDuel.decodeAction(wordDuel.encodeAction({ type: 'finish', player: 'a', seq: 0, payload: null }), 'a'),
      ctx,
    );
    const action = wordDuel.decodeAction(
      wordDuel.encodeAction({ type: 'submit', player: 'a', seq: 1, payload: { word: 'cat', path: [0, 1, 2] } }),
      'a',
    );
    expect(wordDuel.validateAction(state, action, ctx).ok).toBe(false);
  });

  it('caps how much a peer can add to the state', () => {
    const submissions = Array.from({ length: 60 }, (_, i) => ({
      player: 'a',
      word: 'cat',
      path: [0, 1, 2],
      // distinct words are not needed: the cap is on count
      ...(i >= 0 ? {} : {}),
    }));
    const state = gridState('catsoredlimpnest', { submissions });
    const action = wordDuel.decodeAction(
      wordDuel.encodeAction({ type: 'submit', player: 'a', seq: 0, payload: { word: 'core', path: [0, 4, 5, 6] } }),
      'a',
    );
    expect(wordDuel.validateAction(state, action, ctx).ok).toBe(false);
  });
});

describe('word duel hostile input', () => {
  const cases: unknown[] = [
    null,
    'nope',
    { t: 'submit', s: 0, p: null },
    { t: 'submit', s: 0, p: { w: 'cat' } },
    { t: 'submit', s: 0, p: { w: 'cat', p: [0, 1, 99] } },
    { t: 'submit', s: 0, p: { w: 'x'.repeat(500), p: [0] } },
    { t: 'submit', s: 0, p: { w: 'cat', p: Array.from({ length: 400 }, () => 0) } },
    { t: 'submit', s: 0, p: { w: 123, p: [0, 1, 2] } },
    { t: 'nonsense', s: 0, p: null },
  ];

  it('throws rather than accepting anything malformed', () => {
    for (const junk of cases) {
      expect(() => wordDuel.decodeAction(junk as never, 'a')).toThrow();
    }
  });

  it('never lets applyRemote throw', () => {
    const s = session('a', true);
    for (const junk of cases) {
      expect(() => s.applyRemote(junk as never, 'a')).not.toThrow();
    }
  });

  it('rejects a malformed state', () => {
    expect(() => wordDuel.decodeState({ p: ['a', 'b'], g: 'short', s: [], f: [] } as never)).toThrow();
    expect(() => wordDuel.decodeState({ p: ['a', 'b'], g: 'CATSOREDLIMPNEST', s: [], f: [] } as never)).toThrow();
  });
});

describe('word duel conformance', () => {
  /** Play like a person: find real words on the grid and submit them. */
  const hooks = {
    legalAction: (state: WordDuelState, player: string, random: { nextInt: (n: number) => number }) => {
      if (state.finishedBy.includes(player)) return null;
      const already = new Set(state.submissions.filter((s) => s.player === player).map((s) => s.word));
      const options = findAllWords(state.grid).filter((w) => !already.has(w.word));
      if (options.length === 0 || already.size >= 6) return { type: 'finish', payload: null };
      const pick = options[random.nextInt(Math.min(options.length, 12))];
      if (!pick) return { type: 'finish', payload: null };
      return { type: 'submit', payload: { word: pick.word, path: pick.path } };
    },
    maxPlies: 60,
  };

  it('passes the shared conformance suite', () => {
    const report = runConformance(wordDuel as never, hooks as never, 91);
    expect(report.failures).toEqual([]);
  });

  it('passes across many seeds', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const report = runConformance(wordDuel as never, hooks as never, seed);
      expect(report.failures).toEqual([]);
    }
  });
});

describe('finishing early', () => {
  /**
   * The rule that made the game unfair.
   *
   * A word both players find scores for neither - which is the whole point of
   * the game - but it used to apply to the WHOLE round, so a player who
   * finished could only sit and watch their words be cancelled one at a time by
   * an opponent taking as long as they liked. There is no clock, so there was
   * no end to it either.
   */
  function grid(seed: number) {
    return wordDuel.createInitialState({ players: ['a', 'b'], seed, options: {} });
  }

  it('cannot have a finished player\'s words cancelled afterwards', () => {
    const start = grid(11);
    const context = createContext(['a', 'b'], 11);

    // Find a word both players can legally submit on this grid.
    const found = findAnyWord(start);
    expect(found).not.toBeNull();
    const word = found as { word: string; path: number[] };

    // A submits it, then finishes.
    let state = wordDuel.applyAction(
      start,
      { type: 'submit', player: 'a', seq: 0, payload: word },
      context,
    );
    state = wordDuel.applyAction(state, { type: 'finish', player: 'a', seq: 1, payload: null }, context);
    expect(state.openUntil).toBe(1);

    // B then finds the same word, far too late for it to cancel anything.
    state = wordDuel.applyAction(
      state,
      { type: 'submit', player: 'b', seq: 0, payload: word },
      context,
    );
    state = wordDuel.applyAction(state, { type: 'finish', player: 'b', seq: 1, payload: null }, context);

    const status = wordDuel.status(state);
    // Both banked it: A because B was too late to cancel, B because they found
    // it fairly. Neither is punished.
    expect(status.kind).toBe(GameStatusKind.DRAW);
  });

  it('still cancels a word both players found while both were playing', () => {
    const start = grid(11);
    const context = createContext(['a', 'b'], 11);
    const found = findAnyWord(start);
    const word = found as { word: string; path: number[] };

    let state = wordDuel.applyAction(start, { type: 'submit', player: 'a', seq: 0, payload: word }, context);
    state = wordDuel.applyAction(state, { type: 'submit', player: 'b', seq: 0, payload: word }, context);
    state = wordDuel.applyAction(state, { type: 'finish', player: 'a', seq: 1, payload: null }, context);
    state = wordDuel.applyAction(state, { type: 'finish', player: 'b', seq: 1, payload: null }, context);

    // Both found it while both were hunting, so it cancels and nobody scores.
    expect(wordDuel.status(state).kind).toBe(GameStatusKind.DRAW);
    expect(state.openUntil).toBe(2);
  });
});

describe('hostile state', () => {
  it('refuses a submission credited to somebody not in the game', () => {
    const start = wordDuel.createInitialState({ players: ['a', 'b'], seed: 5, options: {} });
    const encoded = wordDuel.encodeState(start) as Record<string, unknown>;
    encoded.s = [['mallory', 'cat', [0, 1, 2]]];
    expect(() => wordDuel.decodeState(encoded as never)).toThrow();
  });

  it('refuses a finish credited to somebody not in the game', () => {
    const start = wordDuel.createInitialState({ players: ['a', 'b'], seed: 5, options: {} });
    const encoded = wordDuel.encodeState(start) as Record<string, unknown>;
    encoded.f = ['mallory'];
    expect(() => wordDuel.decodeState(encoded as never)).toThrow();
  });

  it('round-trips the cancellation boundary', () => {
    const start = wordDuel.createInitialState({ players: ['a', 'b'], seed: 5, options: {} });
    const context = createContext(['a', 'b'], 5);
    const state = wordDuel.applyAction(start, { type: 'finish', player: 'a', seq: 0, payload: null }, context);
    const back = wordDuel.decodeState(wordDuel.encodeState(state));
    expect(back.openUntil).toBe(state.openUntil);
  });
});

/** Any legal word on this grid, or null if the letters happen to hold none. */
function findAnyWord(state: ReturnType<typeof wordDuel.createInitialState>):
  | { word: string; path: number[] }
  | null {
  const visit = (path: number[], letters: string): { word: string; path: number[] } | null => {
    if (letters.length >= 3 && isWord(letters)) return { word: letters, path: [...path] };
    if (letters.length >= 6) return null;
    const last = path[path.length - 1] as number;
    for (const next of neighbours(last)) {
      if (path.includes(next)) continue;
      const found = visit([...path, next], letters + (state.grid[next] ?? ''));
      if (found) return found;
    }
    return null;
  };
  for (let cell = 0; cell < state.grid.length; cell++) {
    const found = visit([cell], state.grid[cell] ?? '');
    if (found) return found;
  }
  return null;
}
