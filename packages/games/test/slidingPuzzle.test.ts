import { describe, expect, it } from 'vitest';
import {
  CELL_COUNT,
  MOVE_LIMIT,
  SOLVED,
  isSolvable,
  isSolved,
  neighbours,
  shuffledBoard,
  slidingPuzzle,
  type SlidingPuzzleState,
} from '../src/games/slidingPuzzle.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };
/** The reducer ignores it - see the header - but the signature wants one. */
const ctx = createContext(setup.players, setup.seed);

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: slidingPuzzle, setup, localPlayer: local, isHost });
}

/** The tile a player could legally slide, chosen as the gap's first neighbour. */
function anyLegalTile(state: SlidingPuzzleState, index: number): number {
  const board = state.boards[index] as readonly number[];
  return board[neighbours(board.indexOf(0))[0] as number] as number;
}

/** Solved except that tile 15 has been slid one square to the right. */
const ONE_FROM_HOME = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 0, 15];

describe('sliding puzzle board geometry', () => {
  it('counts orthogonal neighbours only, and never across an edge', () => {
    const sorted = (index: number) => neighbours(index).sort((x, y) => x - y);
    expect(sorted(0)).toEqual([1, 4]);
    expect(sorted(3)).toEqual([2, 7]);
    expect(sorted(12)).toEqual([8, 13]);
    expect(sorted(15)).toEqual([11, 14]);
    expect(sorted(5)).toEqual([1, 4, 6, 9]);
    // The two that a plain index +/- 1 would join up across the right-hand edge.
    expect(sorted(7)).toEqual([3, 6, 11]);
    expect(sorted(8)).toEqual([4, 9, 12]);
  });
});

describe('sliding puzzle shuffle', () => {
  it('deals both players the same board, shuffled but not solved', () => {
    const s = session('a', true);
    expect(s.currentState.boards[0]).toEqual(s.currentState.boards[1]);
    expect(isSolved(s.currentState.boards[0] as readonly number[])).toBe(false);
    expect(s.currentState.moves).toEqual([0, 0]);
  });

  it('only ever produces a solvable puzzle', () => {
    // The whole point of walking out of the solved position: a permutation drawn
    // at random would fail this half the time.
    for (let seed = 0; seed < 300; seed++) {
      const board = shuffledBoard(seed);
      expect([...board].sort((x, y) => x - y)).toEqual([...SOLVED].sort((x, y) => x - y));
      expect(isSolvable(board)).toBe(true);
      expect(isSolved(board)).toBe(false);
      // Not merely unsolved: a walk that had gone nowhere would still pass the
      // two checks above while dealing a puzzle three slides from home.
      expect(board.filter((tile, cell) => tile !== SOLVED[cell]).length).toBeGreaterThan(5);
    }
  });

  it('can leave the gap on any of the sixteen cells', () => {
    // Every slide moves the gap to a cell of the opposite colour, so a walk of
    // fixed length always finishes on the colour it started on and half the
    // board - and half the solvable puzzles - would never be dealt at all.
    const cells = new Set<number>();
    for (let seed = 0; seed < 200; seed++) cells.add(shuffledBoard(seed).indexOf(0));
    expect(cells.size).toBe(CELL_COUNT);
  });

  it('agrees with the parity rule on boards it did not make', () => {
    expect(isSolvable(SOLVED)).toBe(true);
    // Swapping the last two tiles is the textbook unsolvable position.
    expect(isSolvable([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 14, 0])).toBe(false);
    expect(isSolvable(ONE_FROM_HOME)).toBe(true);
  });

  it('is identical on both devices for one seed and different across seeds', () => {
    expect(shuffledBoard(7)).toEqual(shuffledBoard(7));
    expect(shuffledBoard(7)).not.toEqual(shuffledBoard(8));
  });
});

describe('sliding puzzle rules', () => {
  it('slides the named tile into the gap and counts the move', () => {
    const s = session('a', true);
    const before = s.currentState.boards[0] as readonly number[];
    const gap = before.indexOf(0);
    const tile = anyLegalTile(s.currentState, 0);
    const from = before.indexOf(tile);

    const r = s.submitLocal('slide', { tile });
    expect(r.accepted).toBe(true);
    const after = s.currentState.boards[0] as readonly number[];
    expect(after[gap]).toBe(tile);
    expect(after[from]).toBe(0);
    expect(s.currentState.moves).toEqual([1, 0]);
    // The opponent's board is untouched by my slide.
    expect(s.currentState.boards[1]).toEqual(before);
  });

  it('does not mutate the state it was given', () => {
    const s = session('a', true);
    const before = s.currentState;
    const snapshot = JSON.stringify(slidingPuzzle.encodeState(before));
    s.submitLocal('slide', { tile: anyLegalTile(before, 0) });
    expect(JSON.stringify(slidingPuzzle.encodeState(before))).toBe(snapshot);
    expect(s.currentState).not.toBe(before);
  });

  it('refuses a tile that does not touch the gap', () => {
    const s = session('a', true);
    const board = s.currentState.boards[0] as readonly number[];
    const touching = neighbours(board.indexOf(0)).map((cell) => board[cell] as number);
    const stranded = board.find((t) => t !== 0 && !touching.includes(t)) as number;
    const r = s.submitLocal('slide', { tile: stranded });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/does not touch the gap/);
  });

  it('refuses a tile that is not a tile', () => {
    const s = session('a', true);
    expect(s.submitLocal('slide', { tile: 0 }).accepted).toBe(false);
    expect(s.submitLocal('slide', { tile: CELL_COUNT }).accepted).toBe(false);
    expect(s.submitLocal('slide', { tile: 1.5 }).accepted).toBe(false);
    expect(s.submitLocal('nudge', { tile: 1 }).accepted).toBe(false);
  });

  it('refuses the same things at the validator, not only at the decoder', () => {
    // Everything above dies in decodeAction, which is the first of the two
    // gates - so on its own it proves nothing about the second. An action can
    // reach validateAction without passing the codec at all: replaying a log
    // does exactly that.
    const state = session('a', true).currentState;
    const allows = (action: unknown): boolean => slidingPuzzle.validateAction(state, action as never, ctx).ok;
    expect(allows({ type: 'slide', player: 'a', seq: 0, payload: { tile: 0 } })).toBe(false);
    expect(allows({ type: 'slide', player: 'a', seq: 0, payload: { tile: CELL_COUNT } })).toBe(false);
    expect(allows({ type: 'slide', player: 'a', seq: 0, payload: { tile: 1.5 } })).toBe(false);
    expect(allows({ type: 'slide', player: 'a', seq: 0, payload: {} })).toBe(false);
    expect(allows({ type: 'nudge', player: 'a', seq: 0, payload: { tile: 1 } })).toBe(false);
    expect(allows({ type: 'slide', player: 'c', seq: 0, payload: { tile: 1 } })).toBe(false);

    // And every one of the fifteen tiles, so that the tiles it does allow are
    // exactly the ones touching the gap - no diagonal, nothing over an edge.
    const board = state.boards[0] as readonly number[];
    const touching = new Set(neighbours(board.indexOf(0)).map((cell) => board[cell] as number));
    for (let tile = 1; tile < CELL_COUNT; tile++) {
      expect(allows({ type: 'slide', player: 'a', seq: 0, payload: { tile } })).toBe(touching.has(tile));
    }
  });

  it('slides a tile back where it came from, and nothing else moves', () => {
    const s = session('a', true);
    const before = s.currentState.boards[0];
    const tile = anyLegalTile(s.currentState, 0);
    expect(s.submitLocal('slide', { tile }).accepted).toBe(true);
    // The tile and the gap have swapped, so the same tile is still touching it.
    expect(s.submitLocal('slide', { tile }).accepted).toBe(true);
    expect(s.currentState.boards[0]).toEqual(before);
    expect(s.currentState.moves).toEqual([2, 0]);
  });

  it('lets either player move at any time, in any order', () => {
    const a = session('a', true);
    const b = session('b', false);
    expect(a.turn).toBeNull();
    expect(a.isLocalTurn).toBe(false);

    const play = (player: 'a' | 'b') => {
      const from = player === 'a' ? a : b;
      const to = player === 'a' ? b : a;
      const index = player === 'a' ? 0 : 1;
      const r = from.submitLocal('slide', { tile: anyLegalTile(from.currentState, index) });
      expect(r.accepted).toBe(true);
      if (r.accepted) expect(to.applyRemote(slidingPuzzle.encodeAction(r.applied.action), player).accepted).toBe(true);
    };

    // Three slides from one player before the other has touched a tile: a turn
    // order would have rejected the second of them.
    play('a');
    play('a');
    play('a');
    play('b');
    expect(a.currentState.moves).toEqual([3, 1]);
    expect(b.currentState.moves).toEqual([3, 1]);
    expect(slidingPuzzle.encodeState(a.currentState)).toEqual(slidingPuzzle.encodeState(b.currentState));
  });

  it('will not let one player slide a tile on the other player\'s board', () => {
    const a = session('a', true);
    const b = session('b', false);
    // Authenticated as 'b', so the action is attributed to b however it was
    // addressed, and it is b's own board the tile is then looked for on.
    const boardB = b.currentState.boards[1] as readonly number[];
    const touching = neighbours(boardB.indexOf(0)).map((cell) => boardB[cell] as number);
    const stranded = boardB.find((t) => t !== 0 && !touching.includes(t)) as number;
    const forged = slidingPuzzle.encodeAction({ type: 'slide', player: 'a', seq: 0, payload: { tile: stranded } });
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
    expect(a.applyRemote(forged, 'nobody-in-this-game').accepted).toBe(false);
  });

  it('declares the first player home the winner and stops the race', () => {
    const b = session('b', false);
    expect(
      b.applySnapshot({ p: ['a', 'b'], b: [shuffledBoard(42), ONE_FROM_HOME], m: [9, 9] }),
    ).toBe(true);
    expect(b.status.kind).toBe(GameStatusKind.IN_PROGRESS);

    const r = b.submitLocal('slide', { tile: 15 });
    expect(r.accepted).toBe(true);
    expect(isSolved(b.currentState.boards[1] as readonly number[])).toBe(true);
    expect(b.status.kind).toBe(GameStatusKind.WON);
    expect(b.status.kind === GameStatusKind.WON && b.status.winners).toEqual(['b']);
    expect(b.isOver).toBe(true);
    // The loser cannot keep sliding once somebody is home.
    expect(b.applyRemote(slidingPuzzle.encodeAction({ type: 'slide', player: 'a', seq: 0, payload: { tile: 1 } }), 'a').accepted).toBe(false);
  });

  it('draws when a player runs out of moves', () => {
    const b = session('b', false);
    expect(
      b.applySnapshot({ p: ['a', 'b'], b: [shuffledBoard(42), shuffledBoard(42)], m: [MOVE_LIMIT, 12] }),
    ).toBe(true);
    expect(b.status.kind).toBe(GameStatusKind.DRAW);
    expect(b.submitLocal('slide', { tile: anyLegalTile(b.currentState, 1) }).accepted).toBe(false);
  });

  it('gives each player exactly MOVE_LIMIT slides, played out for real', () => {
    // The snapshot above asserts what a state at the limit means; this asserts
    // that a player can actually reach it, one accepted slide at a time, and is
    // stopped on the next one rather than on the one before.
    const s = session('a', true);
    for (let i = 0; i < MOVE_LIMIT; i++) {
      expect(s.submitLocal('slide', { tile: anyLegalTile(s.currentState, 0) }).accepted).toBe(true);
    }
    expect(s.currentState.moves).toEqual([MOVE_LIMIT, 0]);
    expect(isSolved(s.currentState.boards[0] as readonly number[])).toBe(false);
    expect(s.status.kind).toBe(GameStatusKind.DRAW);
    expect(s.submitLocal('slide', { tile: anyLegalTile(s.currentState, 0) }).accepted).toBe(false);
  });

  it('rejects a duplicate action rather than applying it twice', () => {
    const a = session('a', true);
    const b = session('b', false);
    const r = a.submitLocal('slide', { tile: anyLegalTile(a.currentState, 0) });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = slidingPuzzle.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });
});

describe('sliding puzzle codec', () => {
  it('round-trips a state exactly', () => {
    const a = session('a', true);
    a.submitLocal('slide', { tile: anyLegalTile(a.currentState, 0) });
    const encoded = slidingPuzzle.encodeState(a.currentState);
    expect(slidingPuzzle.encodeState(slidingPuzzle.decodeState(encoded))).toEqual(encoded);
    expect(slidingPuzzle.decodeState(encoded)).toEqual(a.currentState);
  });

  it('round-trips an action exactly', () => {
    const action = { type: 'slide', player: 'a', seq: 3, payload: { tile: 11 } } as const;
    const restored = slidingPuzzle.decodeAction(slidingPuzzle.encodeAction(action), 'a');
    expect(restored).toEqual(action);
  });

  it('throws on a malformed action', () => {
    expect(() => slidingPuzzle.decodeAction(null, 'a')).toThrow();
    expect(() => slidingPuzzle.decodeAction('slide', 'a')).toThrow();
    expect(() => slidingPuzzle.decodeAction({ t: 'shove', s: 0, p: { t: 4 } }, 'a')).toThrow();
    expect(() => slidingPuzzle.decodeAction({ t: 'slide', s: 0, p: null }, 'a')).toThrow();
    expect(() => slidingPuzzle.decodeAction({ t: 'slide', s: 0, p: { t: 0 } }, 'a')).toThrow();
    expect(() => slidingPuzzle.decodeAction({ t: 'slide', s: 0, p: { t: 16 } }, 'a')).toThrow();
    expect(() => slidingPuzzle.decodeAction({ t: 'slide', s: 0, p: { t: 'four' } }, 'a')).toThrow();
    expect(() => slidingPuzzle.decodeAction({ t: 'slide', s: -1, p: { t: 4 } }, 'a')).toThrow();
  });

  it('throws on a state a peer has tampered with', () => {
    const good = shuffledBoard(3);
    expect(() => slidingPuzzle.decodeState({ p: ['a', 'b'], b: [good, good], m: [0] })).toThrow();
    expect(() => slidingPuzzle.decodeState({ p: ['a'], b: [good, good], m: [0, 0] })).toThrow();
    expect(() => slidingPuzzle.decodeState({ p: ['a', 'b'], b: [good.slice(1), good], m: [0, 0] })).toThrow();
    // A tile appearing twice, which would let a cheat build a board that solves.
    const doubled = [...good];
    doubled[0] = doubled[1] as number;
    expect(() => slidingPuzzle.decodeState({ p: ['a', 'b'], b: [doubled, good], m: [0, 0] })).toThrow();
    // An unsolvable board handed to the opponent wins the race without playing.
    const unsolvable = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 14, 0];
    expect(() => slidingPuzzle.decodeState({ p: ['a', 'b'], b: [good, unsolvable], m: [0, 0] })).toThrow();
    expect(() => slidingPuzzle.decodeState({ p: ['a', 'b'], b: [[...SOLVED], [...SOLVED]], m: [0, 0] })).toThrow();
    expect(() => slidingPuzzle.decodeState({ p: ['a', 'b'], b: [good, good], m: [0, MOVE_LIMIT + 1] })).toThrow();
    // A board already home before its owner has slid anything: the tiles are a
    // real puzzle and the parity is right, and it still cannot have been
    // played. The same board with one slide against it is an ordinary win.
    expect(() => slidingPuzzle.decodeState({ p: ['a', 'b'], b: [good, [...SOLVED]], m: [7, 0] })).toThrow();
    expect(slidingPuzzle.decodeState({ p: ['a', 'b'], b: [good, [...SOLVED]], m: [7, 1] }).moves).toEqual([7, 1]);
    // One id twice: the second player would be a stranger to their own race.
    expect(() => slidingPuzzle.decodeState({ p: ['a', 'a'], b: [good, good], m: [0, 0] })).toThrow();
  });
});

describe('sliding puzzle conformance', () => {
  const hooks = {
    legalAction: (state: SlidingPuzzleState, player: string, random: { nextInt(n: number): number }) => {
      const index = state.players.indexOf(player);
      const board = state.boards[index];
      if (!board) return null;
      const options = neighbours(board.indexOf(0));
      const cell = options[random.nextInt(options.length)] as number;
      return { type: 'slide', payload: { tile: board[cell] as number } };
    },
    // Random play never solves a fifteen-puzzle, so the race runs to the move
    // limit: one budget of MOVE_LIMIT slides emptied while the driver hands out
    // roughly half the plies to each player, plus room for the imbalance.
    maxPlies: MOVE_LIMIT * 2 + 200,
  };

  it('passes the shared game conformance suite', () => {
    const report = runConformance(slidingPuzzle, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const report = runConformance(slidingPuzzle, hooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
