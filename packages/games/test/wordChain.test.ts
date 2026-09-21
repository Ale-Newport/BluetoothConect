import { describe, expect, it } from 'vitest';
import { WORD_LIMIT, findPlayableWord, requiredLetter, wordChain } from '../src/games/wordChain.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, SeededGameRandom, createContext, type GameRandom } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };
/** Word Chain never reads the context; the contract just insists on one. */
const ctx = createContext(setup.players, setup.seed);

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: wordChain, setup, localPlayer: local, isHost });
}

/** A pair of sessions and a helper that plays a move on both, as the link would. */
function table() {
  const a = session('a', true);
  const b = session('b', false);
  const move = (player: 'a' | 'b', type: 'play' | 'pass', payload: unknown = null) => {
    const from = player === 'a' ? a : b;
    const to = player === 'a' ? b : a;
    const r = from.submitLocal(type, payload as never);
    if (r.accepted) to.applyRemote(wordChain.encodeAction(r.applied.action), player);
    return r;
  };
  return { a, b, move };
}

/**
 * Always takes the alphabetically first legal word, so a chain built with it is
 * the same on every run and a failure is reproducible.
 */
const greedy: GameRandom = {
  next: () => 0,
  nextInt: () => 0,
  shuffle: <T,>(items: readonly T[]) => [...items],
};

describe('word chain rules', () => {
  it('starts with an empty chain, no required letter, and the host to move', () => {
    const s = session('a', true);
    expect(s.currentState.words).toEqual([]);
    expect(requiredLetter(s.currentState)).toBeNull();
    expect(s.turn).toBe('a');
    expect(s.isLocalTurn).toBe(true);
  });

  it('accepts any dictionary word as the opening move and then alternates', () => {
    const { a, move } = table();
    expect(move('a', 'play', { word: 'table' }).accepted).toBe(true);
    expect(a.currentState.words).toEqual(['table']);
    expect(a.turn).toBe('b');
    expect(requiredLetter(a.currentState)).toBe('e');
    expect(move('b', 'play', { word: 'eager' }).accepted).toBe(true);
    expect(a.turn).toBe('a');
  });

  it('lowercases the word before it reaches the chain', () => {
    const { a, move } = table();
    expect(move('a', 'play', { word: 'TABLE' }).accepted).toBe(true);
    expect(a.currentState.words).toEqual(['table']);
  });

  it('refuses a move out of turn', () => {
    const b = session('b', false);
    const r = b.submitLocal('play', { word: 'table' });
    expect(r.accepted).toBe(false);
  });

  it('refuses a word that does not start with the required letter', () => {
    const { move } = table();
    move('a', 'play', { word: 'table' });
    const r = move('b', 'play', { word: 'bandit' });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/must start with "e"/);
  });

  it('refuses a word already in the chain', () => {
    const { move } = table();
    move('a', 'play', { word: 'ale' });
    move('b', 'play', { word: 'era' });
    // "ale" is a legal continuation of "era" by its first letter, but it is used.
    const r = move('a', 'play', { word: 'ale' });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/already been played/);
  });

  it('refuses a word that is not in the dictionary', () => {
    const { move } = table();
    const r = move('a', 'play', { word: 'zzyzx' });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/dictionary/);
  });

  it('refuses a word shorter than the dictionary allows', () => {
    const { move } = table();
    const r = move('a', 'play', { word: 'an' });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/at least/);
  });

  it('refuses a word longer than the dictionary allows, at both gates', () => {
    const { a, move } = table();
    // The wire refuses it first: nine letters do not fit the payload at all.
    expect(() => wordChain.decodeAction({ t: 'play', s: 0, p: { w: 'abandoned' } }, 'a')).toThrow();
    expect(move('a', 'play', { word: 'abandoned' }).accepted).toBe(false);
    // And the validator refuses it on its own, without leaning on the decoder.
    const long = { type: 'play', player: 'a', seq: 0, payload: { word: 'abandoned' } } as const;
    const v = wordChain.validateAction(a.currentState, long, ctx);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/at most/);
  });

  it('hands the win to the opponent when a player passes', () => {
    const { a, b, move } = table();
    move('a', 'play', { word: 'table' });
    expect(move('b', 'pass').accepted).toBe(true);
    expect(a.status.kind).toBe(GameStatusKind.WON);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['a']);
    expect(b.status.kind).toBe(GameStatusKind.WON);
    expect(a.turn).toBeNull();
  });

  it('rejects a move once somebody has passed', () => {
    const { a, move } = table();
    move('a', 'play', { word: 'table' });
    move('b', 'pass');
    expect(a.isOver).toBe(true);
    expect(move('a', 'play', { word: 'eager' }).accepted).toBe(false);
  });

  it('draws once the chain reaches the word limit', () => {
    const { a, move } = table();
    for (let i = 0; i < WORD_LIMIT; i++) {
      const player = i % 2 === 0 ? 'a' : 'b';
      const word = findPlayableWord(a.currentState, greedy);
      expect(word).not.toBeNull();
      expect(move(player, 'play', { word }).accepted).toBe(true);
    }
    expect(a.currentState.words).toHaveLength(WORD_LIMIT);
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
    expect(a.turn).toBeNull();
    expect(new Set(a.currentState.words).size).toBe(WORD_LIMIT);
  });

  it('rejects a move once the chain has been drawn', () => {
    const { a, move } = table();
    for (let i = 0; i < WORD_LIMIT; i++) {
      move(i % 2 === 0 ? 'a' : 'b', 'play', { word: findPlayableWord(a.currentState, greedy) });
    }
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
    const next = findPlayableWord(a.currentState, greedy);
    expect(next).not.toBeNull();
    // The session refuses on its own account, and so does the validator - a
    // drawn game must not be talked back into life by either route.
    expect(move('a', 'play', { word: next }).accepted).toBe(false);
    const play = { type: 'play', player: 'a', seq: 0, payload: { word: next as string } } as const;
    expect(wordChain.validateAction(a.currentState, play, ctx).ok).toBe(false);
    const pass = { type: 'pass', player: 'a', seq: 0, payload: null } as const;
    expect(wordChain.validateAction(a.currentState, pass, ctx).ok).toBe(false);
  });

  it('finds nothing to play after a word ending in a dead-end letter', () => {
    const dead = { players: ['a', 'b'] as const, words: ['apex'], turnIndex: 1, loser: null };
    expect(requiredLetter(dead)).toBe('x');
    expect(findPlayableWord(dead, greedy)).toBeNull();
  });

  it('makes a dead-end word a winning tactic rather than a stuck game', () => {
    const { a, move } = table();
    expect(move('a', 'play', { word: 'apex' }).accepted).toBe(true);
    // b is not stuck in the sense of being unable to act: passing is the move,
    // and it costs them the game. That is the whole point of the rule.
    expect(findPlayableWord(a.currentState, greedy)).toBeNull();
    expect(move('b', 'pass').accepted).toBe(true);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['a']);
  });

  it('rejects a duplicate action rather than applying it twice', () => {
    const a = session('a', true);
    const b = session('b', false);
    const r = a.submitLocal('play', { word: 'table' });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = wordChain.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });

  it('will not let one player move as another', () => {
    const b = session('b', false);
    const forged = wordChain.encodeAction({ type: 'play', player: 'a', seq: 0, payload: { word: 'table' } });
    // The session authenticated us as 'b', so the action is attributed to b -
    // and b is not to move, so it is refused.
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
  });
});

describe('word chain codecs', () => {
  it('round-trips a state exactly', () => {
    const state = { players: ['a', 'b'], words: ['table', 'eager'], turnIndex: 0, loser: null };
    expect(wordChain.decodeState(wordChain.encodeState(state))).toEqual(state);
  });

  it('round-trips the fields that decide the game, not just the chain', () => {
    // A decoder that hard-coded turnIndex 0 and loser null would satisfy the
    // test above and lose the result of every finished game it carried.
    const finished = { players: ['a', 'b'], words: ['table'], turnIndex: 1, loser: 'b' };
    expect(wordChain.decodeState(wordChain.encodeState(finished))).toEqual(finished);
    const midChain = { players: ['a', 'b'], words: ['ale', 'era', 'ache'], turnIndex: 1, loser: null };
    expect(wordChain.decodeState(wordChain.encodeState(midChain))).toEqual(midChain);
  });

  it('round-trips both actions exactly', () => {
    const play = { type: 'play', player: 'a', seq: 3, payload: { word: 'table' } } as const;
    expect(wordChain.decodeAction(wordChain.encodeAction(play), 'a')).toEqual(play);
    const pass = { type: 'pass', player: 'b', seq: 7, payload: null } as const;
    expect(wordChain.decodeAction(wordChain.encodeAction(pass), 'b')).toEqual(pass);
  });

  it('throws on a hostile action rather than trusting it', () => {
    expect(() => wordChain.decodeAction(null, 'a')).toThrow();
    expect(() => wordChain.decodeAction('play', 'a')).toThrow();
    expect(() => wordChain.decodeAction({ t: 'resign', s: 0, p: null }, 'a')).toThrow();
    expect(() => wordChain.decodeAction({ t: 'play', s: 0, p: null }, 'a')).toThrow();
    expect(() => wordChain.decodeAction({ t: 'play', s: 0, p: { w: 7 } }, 'a')).toThrow();
    expect(() => wordChain.decodeAction({ t: 'play', s: 0, p: { w: 'x'.repeat(500) } }, 'a')).toThrow();
    expect(() => wordChain.decodeAction({ t: 'play', s: -1, p: { w: 'table' } }, 'a')).toThrow();
  });

  it('throws on a hostile state rather than trusting it', () => {
    expect(() => wordChain.decodeState(null)).toThrow();
    expect(() => wordChain.decodeState({ p: ['a'], w: [], t: 0, l: null })).toThrow();
    expect(() => wordChain.decodeState({ p: ['a', 'b'], w: ['TABLE'], t: 0, l: null })).toThrow();
    expect(() => wordChain.decodeState({ p: ['a', 'b'], w: [], t: 9, l: null })).toThrow();
    expect(() => wordChain.decodeState({ p: ['a', 'b'], w: [], t: 0, l: 'c' })).toThrow();
    const tooMany = Array.from({ length: WORD_LIMIT + 5 }, () => 'table');
    expect(() => wordChain.decodeState({ p: ['a', 'b'], w: tooMany, t: 0, l: null })).toThrow();
  });

  it('refuses a chain its own reducer could never have produced', () => {
    // Each of these is well-formed and would be adopted as the live position.
    // A chain that does not chain: every later move argues about the letter.
    expect(() => wordChain.decodeState({ p: ['a', 'b'], w: ['table', 'zebra'], t: 0, l: null })).toThrow();
    // A word played twice, which validateAction cannot ever have allowed.
    expect(() => wordChain.decodeState({ p: ['a', 'b'], w: ['ale', 'era', 'ale'], t: 1, l: null })).toThrow();
    // A word that is not in the dictionary the other device is holding.
    expect(() => wordChain.decodeState({ p: ['a', 'b'], w: ['qqqqq'], t: 1, l: null })).toThrow();
    // A turn that disagrees with the chain hands somebody two goes running.
    expect(() => wordChain.decodeState({ p: ['a', 'b'], w: ['table'], t: 0, l: null })).toThrow();
    // A missing loser would quietly restart a game that had already been won.
    expect(() => wordChain.decodeState({ p: ['a', 'b'], w: [], t: 0 })).toThrow();
    // One id for two players leaves a win with nobody to award it to.
    expect(() => wordChain.decodeState({ p: ['a', 'a'], w: [], t: 0, l: null })).toThrow();
  });
});

describe('word chain conformance', () => {
  const hooks = {
    legalAction: (state: ReturnType<typeof wordChain.createInitialState>, player: string, random: SeededGameRandom) => {
      if (wordChain.currentTurn?.(state) !== player) return null;
      const word = findPlayableWord(state, random);
      // Conceding is a legal action, and a dead-end letter is the only way a
      // random game ends early - so the hook must be able to give up.
      return word === null ? { type: 'pass', payload: null } : { type: 'play', payload: { word } };
    },
    maxPlies: WORD_LIMIT + 4,
  };

  it('passes the shared game conformance suite', () => {
    const report = runConformance(wordChain, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(wordChain, hooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
