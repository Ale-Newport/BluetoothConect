import { describe, expect, it } from 'vitest';
import type { CborValue } from '@airlink/core';
import { CELL_COUNT, FLIP_LIMIT, PAIRS, deal, memoryDuel } from '../src/games/memoryDuel.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const SEED = 42;
const setup = { players: ['a', 'b'], seed: SEED, options: {} };

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: memoryDuel, setup, localPlayer: local, isHost });
}

/** The two cells carrying each face, for the seed the tests play with. */
function pairCells(seed = SEED): number[][] {
  const cards = deal(seed);
  const cells: number[][] = Array.from({ length: PAIRS }, () => []);
  cards.forEach((face, cell) => (cells[face] as number[]).push(cell));
  return cells;
}

/** A pair of sessions kept in step, so every test plays over a real link. */
function table() {
  const a = session('a', true);
  const b = session('b', false);
  const flip = (player: 'a' | 'b', cell: number) => {
    const from = player === 'a' ? a : b;
    const to = player === 'a' ? b : a;
    const r = from.submitLocal('flip', { cell });
    if (r.accepted) to.applyRemote(memoryDuel.encodeAction(r.applied.action), player);
    return r;
  };
  return { a, b, flip };
}

describe('memory duel rules', () => {
  it('deals eight pairs face down, first player to move', () => {
    const s = session('a', true);
    expect(s.currentState.cards).toHaveLength(CELL_COUNT);
    expect(s.currentState.matchedBy).toEqual(new Array<number>(CELL_COUNT).fill(0));
    expect(s.currentState.revealed).toEqual([]);
    expect(s.currentState.scores).toEqual([0, 0]);
    expect(s.turn).toBe('a');
    for (let face = 0; face < PAIRS; face++) {
      expect(s.currentState.cards.filter((c) => c === face)).toHaveLength(2);
    }
  });

  it('deals the same board on both devices, and a different one per seed', () => {
    expect(deal(SEED)).toEqual(session('b', false).currentState.cards);
    expect(deal(SEED)).not.toEqual(deal(SEED + 1));
  });

  it('refuses a flip out of turn', () => {
    const { flip } = table();
    const r = flip('b', 0);
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/turn/);
  });

  it('holds one card face up between the two flips of a turn', () => {
    const { a, flip } = table();
    expect(flip('a', 3).accepted).toBe(true);
    expect(a.currentState.revealed).toEqual([3]);
    // The turn is not over, so it is still the same player to move.
    expect(a.turn).toBe('a');
    expect(a.currentState.flips).toBe(1);
  });

  it('scores a match, claims both cards and lets the same player go again', () => {
    const [first, second] = pairCells()[0] as number[];
    const { a, b, flip } = table();
    flip('a', first as number);
    flip('a', second as number);
    expect(a.currentState.scores).toEqual([1, 0]);
    expect(a.currentState.matchedBy[first as number]).toBe(1);
    expect(a.currentState.matchedBy[second as number]).toBe(1);
    expect(a.currentState.revealed).toEqual([]);
    expect(a.turn).toBe('a');
    expect(b.currentState.scores).toEqual([1, 0]);
  });

  it('leaves a mismatched pair face up and passes the turn', () => {
    const pairs = pairCells();
    const x = (pairs[0] as number[])[0] as number;
    const y = (pairs[1] as number[])[0] as number;
    const { a, flip } = table();
    flip('a', x);
    flip('a', y);
    expect(a.currentState.revealed).toEqual([x, y]);
    expect(a.currentState.scores).toEqual([0, 0]);
    expect(a.turn).toBe('b');
  });

  it('clears the mismatched pair on the next flip, not before', () => {
    const pairs = pairCells();
    const x = (pairs[0] as number[])[0] as number;
    const y = (pairs[1] as number[])[0] as number;
    const z = (pairs[2] as number[])[0] as number;
    const { a, flip } = table();
    flip('a', x);
    flip('a', y);
    expect(flip('b', z).accepted).toBe(true);
    expect(a.currentState.revealed).toEqual([z]);
    expect(a.currentState.matchedBy[x]).toBe(0);
    expect(a.currentState.matchedBy[y]).toBe(0);
  });

  it('allows the next player to flip a card the mismatch left showing', () => {
    const pairs = pairCells();
    const x = (pairs[0] as number[])[0] as number;
    const y = (pairs[1] as number[])[0] as number;
    const { a, flip } = table();
    flip('a', x);
    flip('a', y);
    const r = flip('b', x);
    expect(r.accepted).toBe(true);
    expect(a.currentState.revealed).toEqual([x]);
  });

  it('refuses the same card twice inside one turn', () => {
    const { a, flip } = table();
    flip('a', 5);
    const r = flip('a', 5);
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/already face up/);
    expect(a.currentState.flips).toBe(1);
  });

  it('refuses a card that has already been matched', () => {
    const [first, second] = pairCells()[0] as number[];
    const { flip } = table();
    flip('a', first as number);
    flip('a', second as number);
    const r = flip('a', first as number);
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/already been matched/);
  });

  it('refuses a cell outside the grid', () => {
    const { flip } = table();
    expect(flip('a', -1).accepted).toBe(false);
    expect(flip('a', CELL_COUNT).accepted).toBe(false);
    expect(flip('a', 1.5).accepted).toBe(false);
  });

  it('refuses a cell outside the grid at the validator, not only at the codec', () => {
    // The test above goes through submitLocal, which encodes and decodes before
    // it validates - so decodeAction rejects all three and validateAction is
    // never consulted. A peer whose packet is well formed but whose CELL is not
    // has to be stopped by the validator itself, which is what this checks.
    const state = session('a', true).currentState;
    const context = createContext(['a', 'b'], SEED);
    const verdict = (cell: number) =>
      memoryDuel.validateAction(state, { type: 'flip', player: 'a', seq: 0, payload: { cell } }, context);
    for (const cell of [-1, CELL_COUNT, 1.5, Number.NaN, 1e12]) {
      expect(verdict(cell).ok).toBe(false);
    }
    expect(verdict(0).ok).toBe(true);
    expect(verdict(CELL_COUNT - 1).ok).toBe(true);
  });

  it('attributes a pair to whichever player took it', () => {
    const pairs = pairCells();
    const { a, flip } = table();
    // a misses, so b is on strike when the pair goes.
    flip('a', (pairs[0] as number[])[0] as number);
    flip('a', (pairs[1] as number[])[0] as number);
    const pair = pairs[2] as number[];
    flip('b', pair[0] as number);
    flip('b', pair[1] as number);
    expect(a.currentState.scores).toEqual([0, 1]);
    expect(a.currentState.matchedBy[pair[0] as number]).toBe(2);
    expect(a.currentState.matchedBy[pair[1] as number]).toBe(2);
    expect(a.turn).toBe('b');
  });

  it('ends when the last pair is taken, and names the higher score', () => {
    const pairs = pairCells();
    const { a, b, flip } = table();
    for (const pair of pairs) {
      expect(flip('a', (pair as number[])[0] as number).accepted).toBe(true);
      expect(flip('a', (pair as number[])[1] as number).accepted).toBe(true);
    }
    expect(a.currentState.scores).toEqual([PAIRS, 0]);
    expect(a.status.kind).toBe(GameStatusKind.WON);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['a']);
    expect(b.status.kind).toBe(GameStatusKind.WON);
    expect(a.turn).toBeNull();
    expect(flip('a', 0).accepted).toBe(false);
  });

  it('calls an even split a draw', () => {
    const pairs = pairCells();
    const { a, flip } = table();
    // Each player takes two pairs, then deliberately mismatches the next two
    // faces to hand the turn over.
    const take = (player: 'a' | 'b', face: number) => {
      const pair = pairs[face] as number[];
      expect(flip(player, pair[0] as number).accepted).toBe(true);
      expect(flip(player, pair[1] as number).accepted).toBe(true);
    };
    const miss = (player: 'a' | 'b', left: number, right: number) => {
      expect(flip(player, (pairs[left] as number[])[0] as number).accepted).toBe(true);
      expect(flip(player, (pairs[right] as number[])[0] as number).accepted).toBe(true);
    };
    take('a', 0);
    take('a', 1);
    miss('a', 2, 3);
    take('b', 2);
    take('b', 3);
    miss('b', 4, 5);
    take('a', 4);
    take('a', 5);
    miss('a', 6, 7);
    take('b', 6);
    take('b', 7);
    expect(a.currentState.scores).toEqual([4, 4]);
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
  });

  it('stops at the flip limit even when nobody ever matches', () => {
    const pairs = pairCells();
    const x = (pairs[0] as number[])[0] as number;
    const y = (pairs[1] as number[])[0] as number;
    const { a, flip } = table();
    // Two players who never learn: the same two cards, turn after turn. Nothing
    // is ever matched, so only the cap can end this.
    for (let turn = 0; turn < FLIP_LIMIT / 2; turn++) {
      const player = turn % 2 === 0 ? 'a' : 'b';
      expect(flip(player, x).accepted).toBe(true);
      expect(flip(player, y).accepted).toBe(true);
    }
    expect(a.currentState.flips).toBe(FLIP_LIMIT);
    // The cap is even so that it lands between turns. A game stopped with one
    // card face up would have taken a flip off somebody without giving them
    // the second one it is only ever half of.
    expect(a.currentState.revealed).not.toHaveLength(1);
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
    expect(a.status.kind === GameStatusKind.DRAW && a.status.reason).toMatch(/flip limit/);
    expect(a.turn).toBeNull();
    expect(flip('a', x).accepted).toBe(false);
  });

  it('rejects a replayed action rather than applying it twice', () => {
    const { b, flip } = table();
    const r = flip('a', 0);
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const again = b.applyRemote(memoryDuel.encodeAction(r.applied.action), 'a');
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });

  it('will not let one player move as another', () => {
    const b = session('b', false);
    const forged = memoryDuel.encodeAction({ type: 'flip', player: 'a', seq: 0, payload: { cell: 0 } });
    // The session authenticated us as 'b', so the action is attributed to b, and
    // b is not to move.
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
  });
});

describe('memory duel codecs', () => {
  it('round-trips a state in the middle of a turn', () => {
    const { a, flip } = table();
    flip('a', 4);
    const restored = memoryDuel.decodeState(memoryDuel.encodeState(a.currentState));
    expect(restored).toEqual(a.currentState);
    expect(memoryDuel.encodeState(restored)).toEqual(memoryDuel.encodeState(a.currentState));
  });

  it('round-trips a settled mismatch, the state this game invented', () => {
    const pairs = pairCells();
    const { a, flip } = table();
    flip('a', (pairs[0] as number[])[0] as number);
    flip('a', (pairs[1] as number[])[0] as number);
    expect(a.currentState.revealed).toHaveLength(2);
    const restored = memoryDuel.decodeState(memoryDuel.encodeState(a.currentState));
    expect(restored).toEqual(a.currentState);
    expect(restored.turnIndex).toBe(1);
  });

  it('throws on a malformed action', () => {
    expect(() => memoryDuel.decodeAction(null, 'a')).toThrow();
    expect(() => memoryDuel.decodeAction({ t: 'place', s: 0, p: { c: 0 } }, 'a')).toThrow(/unknown action/);
    expect(() => memoryDuel.decodeAction({ t: 'flip', s: 0, p: null }, 'a')).toThrow();
    expect(() => memoryDuel.decodeAction({ t: 'flip', s: 0, p: { c: CELL_COUNT } }, 'a')).toThrow();
    expect(() => memoryDuel.decodeAction({ t: 'flip', s: 0, p: { c: 'x' } }, 'a')).toThrow();
    expect(() => memoryDuel.decodeAction({ t: 'flip', s: -1, p: { c: 0 } }, 'a')).toThrow();
  });

  it('throws on a state a hostile peer rigged', () => {
    const encoded = memoryDuel.encodeState(session('a', true).currentState) as Record<string, CborValue>;
    const tamper = (patch: Record<string, CborValue>): CborValue => ({ ...encoded, ...patch });

    // A deck of one face would match every card against every other.
    expect(() => memoryDuel.decodeState(tamper({ c: new Array<number>(CELL_COUNT).fill(0) }))).toThrow(/exactly twice/);
    // Eight pairs claimed off a board that shows none.
    expect(() => memoryDuel.decodeState(tamper({ s: [PAIRS, 0] }))).toThrow(/does not match the board/);
    expect(() => memoryDuel.decodeState(tamper({ u: [3, 3] }))).toThrow(/cannot be face up twice/);
    expect(() => memoryDuel.decodeState(tamper({ u: [0, 1, 2] }))).toThrow(/at most 2 cards/);
    expect(() => memoryDuel.decodeState(tamper({ f: FLIP_LIMIT + 1 }))).toThrow();
    expect(() => memoryDuel.decodeState(tamper({ p: ['a'] }))).toThrow(/exactly 2 players/);
    expect(() => memoryDuel.decodeState('not a state')).toThrow();
  });

  it('refuses a board whose claimed pairs are not pairs', () => {
    // Two cards of DIFFERENT faces, both marked as taken by the first player.
    // The card count comes out right, so the scores check waves it through; it
    // is only wrong pairwise. Left standing it strands both partners, which no
    // one can ever match, so the game could only ever end at the flip cap.
    const encoded = memoryDuel.encodeState(session('a', true).currentState) as Record<string, CborValue>;
    const pairs = pairCells();
    const marks = new Array<number>(CELL_COUNT).fill(0);
    marks[(pairs[0] as number[])[0] as number] = 1;
    marks[(pairs[1] as number[])[0] as number] = 1;
    expect(() => memoryDuel.decodeState({ ...encoded, m: marks, s: [1, 0], f: 4 })).toThrow(/whole or not at all/);
  });

  it('refuses a flip count that contradicts the board', () => {
    const encoded = memoryDuel.encodeState(session('a', true).currentState) as Record<string, CborValue>;
    // Eight pairs cannot have been turned over in no flips at all.
    const solved = new Array<number>(CELL_COUNT).fill(1);
    expect(() => memoryDuel.decodeState({ ...encoded, m: solved, s: [PAIRS, 0], f: 0 })).toThrow(/too few flips/);
    // An odd count means one card is face up, and an even one means none is.
    expect(() => memoryDuel.decodeState({ ...encoded, u: [0], f: 4 })).toThrow(/half-finished turn/);
    expect(() => memoryDuel.decodeState({ ...encoded, u: [], f: 5 })).toThrow(/half-finished turn/);
    // Nobody matching anything for the whole game is legal, however, so a long
    // count on an untouched board must still decode.
    expect(memoryDuel.decodeState({ ...encoded, f: FLIP_LIMIT }).flips).toBe(FLIP_LIMIT);
  });

  it('refuses a matching pair left face up, which the reducer can never produce', () => {
    const state = session('a', true).currentState;
    const encoded = memoryDuel.encodeState(state) as Record<string, CborValue>;
    const pair = pairCells()[0] as number[];
    const showing = [pair[0] as number, pair[1] as number];
    expect(() => memoryDuel.decodeState({ ...encoded, u: showing })).toThrow(/matching pair/);
  });
});

const conformanceHooks = {
  legalAction: (
    state: ReturnType<typeof memoryDuel.createInitialState>,
    player: string,
    random: { nextInt(n: number): number },
  ) => {
    if (memoryDuel.currentTurn?.(state) !== player) return null;
    const showing = state.revealed.length === 2 ? [] : state.revealed;
    const choices: number[] = [];
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (state.matchedBy[cell] === 0 && !showing.includes(cell)) choices.push(cell);
    }
    if (choices.length === 0) return null;
    return { type: 'flip', payload: { cell: choices[random.nextInt(choices.length)] as number } };
  },
  // The flip cap bounds the game; a couple of plies of headroom keeps the suite
  // measuring the game's own limit rather than its own.
  maxPlies: FLIP_LIMIT + 4,
};

describe('memory duel conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(memoryDuel, conformanceHooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const report = runConformance(memoryDuel, conformanceHooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
