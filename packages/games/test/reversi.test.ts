import { describe, expect, it } from 'vitest';
import type { CborValue } from '@airlink/core';
import { CELL_COUNT, capturesFor, legalMovesFor, reversi, type Cell, type ReversiAction, type ReversiState } from '../src/games/reversi.js';
import { GameSession } from '../src/runtime.js';
import { runConformance, type ConformanceHooks } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: reversi, setup, localPlayer: local, isHost });
}

type Session = ReturnType<typeof session>;

const ctx = () => createContext(['a', 'b'], 42);
const at = (row: number, col: number) => row * 8 + col;

/** Play `cell` on `from` and mirror the action onto `to`, as the link would. */
function play(from: Session, to: Session, player: 'a' | 'b', cell: number) {
  const r = from.submitLocal('play', { cell });
  if (r.accepted) to.applyRemote(reversi.encodeAction(r.applied.action), player);
  return r;
}

/**
 * A board written as eight rows of '.', 'D' and 'L'. Far easier to check by eye
 * than sixty-four numbers on one line, and the positions below are all corner
 * cases that need to be read carefully.
 */
function boardFrom(rows: readonly string[]): Cell[] {
  const cells: Cell[] = [];
  for (const row of rows) {
    for (const ch of row) cells.push(ch === 'D' ? 1 : ch === 'L' ? 2 : 0);
  }
  return cells;
}

/** A state built from a literal board, taken through the real decoder. */
function stateFrom(rows: readonly string[], turnIndex: 0 | 1, moveCount = 1, skipped = false): ReversiState {
  return reversi.decodeState({ b: boardFrom(rows), p: ['a', 'b'], t: turnIndex, m: moveCount, k: skipped });
}

/** Dark buried light in the corner: dark may move, light may not. */
const LIGHT_IS_STUCK = [
  'DDDDDDDD',
  'DDDDDDDD',
  'DDDDDDDD',
  'DDDDDDDD',
  'DDDDDDDD',
  'DDDDDDDD',
  'DDDDDDLL',
  'DDDDDD..',
];

/**
 * Light to play (4, 2), after which light owns everything but (3, 4) and has no
 * reply of its own - yet nobody has been skipped, because it is dark's turn and
 * dark has eight moves. Reached in a real game at move ten.
 */
const BEFORE_LIGHT_STRANDS_ITSELF = [
  '........',
  '........',
  '..LLLLL.',
  '..DDDL..',
  '...DDDL.',
  '........',
  '........',
  '........',
];

/** One empty square, one light stone off every ray from it: nobody can move. */
const NOBODY_CAN_MOVE = [
  'DDDDDDDD',
  'DDDDDDDD',
  'DDDDDDDD',
  'DDDDDDLD',
  'DDDDDDDD',
  'DDDDDDDD',
  'DDDDDDDD',
  'DDDDDDD.',
];

describe('reversi rules', () => {
  it('opens with four stones in the middle and dark to move', () => {
    const s = session('a', true);
    expect(s.currentState.scores).toEqual([2, 2]);
    expect(s.currentState.board[at(3, 3)]).toBe(2);
    expect(s.currentState.board[at(3, 4)]).toBe(1);
    expect(s.currentState.board[at(4, 3)]).toBe(1);
    expect(s.currentState.board[at(4, 4)]).toBe(2);
    expect(s.currentState.board.filter((c) => c !== 0)).toHaveLength(4);
    expect(s.turn).toBe('a');
  });

  it('offers exactly the four opening moves to each side', () => {
    const s = session('a', true).currentState;
    expect(legalMovesFor(s, 'a')).toEqual([at(2, 3), at(3, 2), at(4, 5), at(5, 4)]);
    expect(legalMovesFor(s, 'b')).toEqual([at(2, 4), at(3, 5), at(4, 2), at(5, 3)]);
    expect(legalMovesFor(s, 'nobody-here')).toEqual([]);
  });

  it('flips the bracketed stone and updates both scores', () => {
    const a = session('a', true);
    const b = session('b', false);
    expect(play(a, b, 'a', at(2, 3)).accepted).toBe(true);
    expect(a.currentState.board[at(2, 3)]).toBe(1);
    // (3, 3) was light, and is now bracketed between the new stone and (4, 3).
    expect(a.currentState.board[at(3, 3)]).toBe(1);
    expect(a.currentState.scores).toEqual([4, 1]);
    expect(b.currentState.scores).toEqual([4, 1]);
    expect(a.turn).toBe('b');
  });

  it('flips along every closed ray at once, and only those', () => {
    const board = boardFrom([
      '........',
      '........',
      '.DDDDD..',
      '..LLL...',
      '........',
      '........',
      '........',
      '........',
    ]);
    // Dark at (4, 3) closes three rays upwards - the left diagonal, the file
    // and the right diagonal - and the result follows the fixed ray order.
    expect(capturesFor(board, at(4, 3), 1)).toEqual([at(3, 2), at(3, 3), at(3, 4)]);
    expect(capturesFor(board, at(4, 0), 1)).toEqual([]);
    // An occupied square captures nothing however good the bracket looks.
    expect(capturesFor(board, at(3, 3), 1)).toEqual([]);
  });

  it('does not let a ray wrap round the edge of the board', () => {
    // Stepping left from (4, 1) reaches (4, 0) and then leaves the board. An
    // implementation walking flat indices would carry on into (3, 7) instead.
    const board = boardFrom([
      '........',
      '........',
      '........',
      '.......D',
      'L.......',
      '........',
      '........',
      '........',
    ]);
    expect(capturesFor(board, at(4, 1), 1)).toEqual([]);
  });

  it('refuses a move out of turn', () => {
    const b = session('b', false);
    expect(b.submitLocal('play', { cell: at(2, 4) }).accepted).toBe(false);
  });

  it('refuses an occupied square', () => {
    const a = session('a', true);
    const r = a.submitLocal('play', { cell: at(3, 3) });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/taken/);
  });

  it('refuses a move that captures nothing', () => {
    const a = session('a', true);
    const r = a.submitLocal('play', { cell: at(0, 0) });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/captures nothing/);
  });

  it('refuses a cell outside the board', () => {
    const a = session('a', true);
    // Out of range never reaches validateAction: the decoder refuses it first.
    expect(a.submitLocal('play', { cell: CELL_COUNT }).accepted).toBe(false);
    expect(a.submitLocal('play', { cell: -1 }).accepted).toBe(false);
  });

  it('alternates turns while both players can move', () => {
    const a = session('a', true);
    const b = session('b', false);
    expect(play(a, b, 'a', at(2, 3)).accepted).toBe(true);
    expect(a.turn).toBe('b');
    expect(b.turn).toBe('b');
    const reply = legalMovesFor(b.currentState, 'b')[0] as number;
    expect(play(b, a, 'b', reply).accepted).toBe(true);
    expect(a.turn).toBe('a');
    expect(a.currentState.moveCount).toBe(2);
  });

  it('skips a player with no legal move and leaves the turn where it was', () => {
    const state = stateFrom(LIGHT_IS_STUCK, 0);
    expect(legalMovesFor(state, 'b')).toEqual([]);
    expect(legalMovesFor(state, 'a')).toEqual([at(7, 6), at(7, 7)]);
    expect(reversi.currentTurn?.(state)).toBe('a');

    const action: ReversiAction = { type: 'play', player: 'a', seq: 0, payload: { cell: at(7, 6) } };
    expect(reversi.validateAction(state, action, ctx()).ok).toBe(true);
    const next = reversi.applyAction(state, action, ctx());
    expect(next.skipped).toBe(true);
    expect(next.over).toBe(false);
    expect(reversi.currentTurn?.(next)).toBe('a');
  });

  it('ends when neither player can move, and the higher count wins', () => {
    const state = stateFrom(NOBODY_CAN_MOVE, 0);
    expect(state.over).toBe(true);
    expect(state.scores).toEqual([62, 1]);
    expect(reversi.currentTurn?.(state)).toBeNull();
    const status = reversi.status(state);
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['a']);
  });

  it('calls an equal full board a draw', () => {
    const half = stateFrom(
      ['DDDDDDDD', 'DDDDDDDD', 'DDDDDDDD', 'DDDDDDDD', 'LLLLLLLL', 'LLLLLLLL', 'LLLLLLLL', 'LLLLLLLL'],
      0,
      60,
    );
    expect(half.over).toBe(true);
    expect(half.scores).toEqual([32, 32]);
    expect(reversi.status(half).kind).toBe(GameStatusKind.DRAW);
  });

  it('rejects a move once the game is over', () => {
    const state = stateFrom(NOBODY_CAN_MOVE, 0);
    const r = reversi.validateAction(state, { type: 'play', player: 'a', seq: 0, payload: { cell: at(7, 7) } }, ctx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/finished/);
  });

  it('rejects a duplicate action rather than applying it twice', () => {
    const a = session('a', true);
    const b = session('b', false);
    const r = a.submitLocal('play', { cell: at(2, 3) });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = reversi.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });

  it('will not let one player move as another', () => {
    const b = session('b', false);
    const forged = reversi.encodeAction({ type: 'play', player: 'a', seq: 0, payload: { cell: at(2, 3) } });
    // The session authenticated us as b, so the move is attributed to b, and b
    // is not to move.
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
  });

  it('does not mutate the state it is given', () => {
    const before = session('a', true).currentState;
    const snapshot = JSON.stringify(reversi.encodeState(before));
    reversi.applyAction(before, { type: 'play', player: 'a', seq: 0, payload: { cell: at(2, 3) } }, ctx());
    expect(JSON.stringify(reversi.encodeState(before))).toBe(snapshot);
  });

  it('round-trips a state field for field, not merely byte for byte', () => {
    const a = session('a', true);
    const b = session('b', false);
    play(a, b, 'a', at(2, 3));
    // Comparing re-encoded bytes would only prove encodeState is a function of
    // itself: a field it drops can never show up in its own output. Compare the
    // whole decoded state against the live one instead.
    const restored = reversi.decodeState(reversi.encodeState(a.currentState));
    expect(restored).toEqual(a.currentState);
  });

  it('round-trips a skip, which the board cannot imply', () => {
    const skippedState = reversi.applyAction(
      stateFrom(LIGHT_IS_STUCK, 0, 40),
      { type: 'play', player: 'a', seq: 0, payload: { cell: at(7, 6) } },
      ctx(),
    );
    expect(skippedState.skipped).toBe(true);
    expect(reversi.decodeState(reversi.encodeState(skippedState))).toEqual(skippedState);
  });

  it('does not invent a skip when the side that just moved is merely stuck', () => {
    // Light sweeps the board and is left with nothing to play - but it is dark's
    // turn and dark has eight moves, so nobody was passed over. Deriving
    // `skipped` from the board would announce a pass that never happened, and
    // the two devices would caption the same position differently.
    const before = stateFrom(BEFORE_LIGHT_STRANDS_ITSELF, 1, 9);
    const after = reversi.applyAction(
      before,
      { type: 'play', player: 'b', seq: 0, payload: { cell: at(4, 2) } },
      ctx(),
    );
    expect(after.turnIndex).toBe(0);
    expect(legalMovesFor(after, 'b')).toEqual([]);
    expect(legalMovesFor(after, 'a').length).toBe(8);
    expect(after.skipped).toBe(false);
    expect(after.over).toBe(false);
    expect(reversi.decodeState(reversi.encodeState(after)).skipped).toBe(false);
  });

  it('round-trips every position of a whole game', () => {
    const a = session('a', true);
    const b = session('b', false);
    let plies = 0;
    while (!a.isOver) {
      const player = a.turn as 'a' | 'b';
      const moves = legalMovesFor(a.currentState, player);
      expect(moves.length).toBeGreaterThan(0);
      // Deterministic without a generator: always take the lowest legal square.
      expect(play(player === 'a' ? a : b, player === 'a' ? b : a, player, moves[0] as number).accepted).toBe(true);
      plies += 1;
      const state = a.currentState;
      expect(reversi.decodeState(reversi.encodeState(state))).toEqual(state);
      expect(b.currentState).toEqual(state);
    }
    expect(plies).toBeGreaterThan(30);
    expect(a.status.kind).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('still refuses the skipped player a move out of turn', () => {
    const state = stateFrom(LIGHT_IS_STUCK, 0, 40);
    const next = reversi.applyAction(state, { type: 'play', player: 'a', seq: 0, payload: { cell: at(7, 6) } }, ctx());
    expect(next.skipped).toBe(true);
    // Being skipped is not an invitation to play anyway, and (7, 7) is the only
    // square left.
    const r = reversi.validateAction(next, { type: 'play', player: 'b', seq: 0, payload: { cell: at(7, 7) } }, ctx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/a's turn/);
  });
});

describe('reversi hostile input', () => {
  it('throws on every malformed action', () => {
    const junk: CborValue[] = [
      null,
      0,
      'play',
      [],
      {},
      { t: 'play' },
      { t: 'pass', s: 0, p: { c: 0 } },
      { t: 'play', s: 0, p: null },
      { t: 'play', s: 0, p: { c: CELL_COUNT } },
      { t: 'play', s: 0, p: { c: -1 } },
      { t: 'play', s: 0, p: { c: 1.5 } },
      { t: 'play', s: 0, p: { c: 'e3' } },
      { t: 'play', s: -1, p: { c: 0 } },
    ];
    for (const value of junk) {
      expect(() => reversi.decodeAction(value, 'a')).toThrow();
    }
  });

  it('throws on a malformed state', () => {
    const opening = boardFrom([
      '........',
      '........',
      '........',
      '...LD...',
      '...DL...',
      '........',
      '........',
      '........',
    ]);
    expect(() => reversi.decodeState(null)).toThrow();
    expect(() => reversi.decodeState({ b: opening.slice(0, 63), p: ['a', 'b'], t: 0, m: 0, k: false })).toThrow();
    expect(() => reversi.decodeState({ b: opening, p: ['a'], t: 0, m: 0, k: false })).toThrow();
    expect(() => reversi.decodeState({ b: opening, p: ['a', 7], t: 0, m: 0, k: false })).toThrow();
    expect(() => reversi.decodeState({ b: opening, p: ['a', 'b'], t: 2, m: 0, k: false })).toThrow();
    expect(() => reversi.decodeState({ b: opening.map(() => 3), p: ['a', 'b'], t: 0, m: 0, k: false })).toThrow();
    expect(() => reversi.decodeState({ b: opening, p: ['a', 'b'], t: 0, m: -1, k: false })).toThrow();
    // The skip flag is a field like any other: absent or the wrong type is junk.
    expect(() => reversi.decodeState({ b: opening, p: ['a', 'b'], t: 0, m: 0 })).toThrow();
    expect(() => reversi.decodeState({ b: opening, p: ['a', 'b'], t: 0, m: 0, k: 1 })).toThrow();
  });

  it('rejects a board on which the named player could not be to move', () => {
    const buried = boardFrom(LIGHT_IS_STUCK);
    expect(() => reversi.decodeState({ b: buried, p: ['a', 'b'], t: 1, m: 40, k: false })).toThrow();
    expect(() => reversi.decodeState({ b: buried, p: ['a', 'b'], t: 0, m: 40, k: false })).not.toThrow();
  });

  it('rejects a claimed skip that the board contradicts', () => {
    // Both sides can move from the opening, so nobody was passed over on the
    // way to it. A peer saying otherwise is describing a ply that never was.
    const opening = boardFrom(['........', '........', '........', '...LD...', '...DL...', '........', '........', '........']);
    expect(() => reversi.decodeState({ b: opening, p: ['a', 'b'], t: 0, m: 0, k: true })).toThrow();
    // Nor can there have been a skip on a board where the game is already over.
    expect(() => reversi.decodeState({ b: boardFrom(NOBODY_CAN_MOVE), p: ['a', 'b'], t: 0, m: 40, k: true })).toThrow();
    // But a real skip decodes: light is buried, dark plays on.
    const buried = boardFrom(LIGHT_IS_STUCK);
    expect(reversi.decodeState({ b: buried, p: ['a', 'b'], t: 0, m: 40, k: true }).skipped).toBe(true);
  });
});

describe('reversi conformance', () => {
  const hooks: ConformanceHooks<ReversiState, ReversiAction> = {
    legalAction: (state, player, random) => {
      if (reversi.currentTurn?.(state) !== player) return null;
      const moves = legalMovesFor(state, player);
      if (moves.length === 0) return null;
      return { type: 'play', payload: { cell: moves[random.nextInt(moves.length)] as number } };
    },
    // Sixty empty squares, one filled per move, so play cannot outlast this.
    maxPlies: 64,
  };

  it('passes the shared game conformance suite', () => {
    const report = runConformance(reversi, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(reversi, hooks, seed);
      expect(report.failures).toEqual([]);
      // The suite stops quietly when legalAction returns null, so an empty
      // failure list alone would also be what a game that stalled looks like.
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
