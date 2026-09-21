import { describe, expect, it } from 'vitest';
import type { CborValue } from '@airlink/core';
import { CELL_COUNT, SIZE, gomoku, type Cell, type GomokuAction } from '../src/games/gomoku.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };
const ctx = createContext(setup.players, setup.seed);

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: gomoku, setup, localPlayer: local, isHost });
}

const at = (row: number, col: number) => row * SIZE + col;

/**
 * Stones for whichever player is only keeping the turn moving. Spaced along
 * row 12 so they never touch each other, never make a line of their own, and
 * never land in the rows the rule tests build their lines in.
 */
const FILLER = [at(12, 0), at(12, 2), at(12, 4), at(12, 6), at(12, 8), at(12, 10), at(12, 12), at(12, 14)];

/**
 * A pair of sessions and a `play` that mirrors every accepted move onto the
 * other one, so every rule test also exercises the two-device path rather than
 * a single reducer talking to itself.
 */
function table() {
  const a = session('a', true);
  const b = session('b', false);
  const play = (player: 'a' | 'b', cell: number) => {
    const from = player === 'a' ? a : b;
    const to = player === 'a' ? b : a;
    const r = from.submitLocal('place', { cell });
    if (r.accepted) to.applyRemote(gomoku.encodeAction(r.applied.action), player);
    return r;
  };
  return { a, b, play };
}

describe('gomoku rules', () => {
  it('starts on an empty board with the first player to move and no last stone', () => {
    const s = session('a', true);
    expect(s.currentState.board).toHaveLength(CELL_COUNT);
    expect(s.currentState.board.every((c) => c === 0)).toBe(true);
    expect(s.currentState.lastMove).toBe(-1);
    expect(s.turn).toBe('a');
    expect(s.isLocalTurn).toBe(true);
  });

  it('alternates turns and records the stone just played', () => {
    const { a, play } = table();
    expect(play('a', at(7, 7)).accepted).toBe(true);
    expect(a.currentState.lastMove).toBe(at(7, 7));
    expect(a.turn).toBe('b');
    expect(play('b', at(7, 8)).accepted).toBe(true);
    expect(a.currentState.lastMove).toBe(at(7, 8));
    expect(a.turn).toBe('a');
    expect(a.currentState.board[at(7, 7)]).toBe(1);
    expect(a.currentState.board[at(7, 8)]).toBe(2);
  });

  it('refuses a move out of turn', () => {
    const s = session('b', false);
    expect(s.submitLocal('place', { cell: at(7, 7) }).accepted).toBe(false);
  });

  it('refuses a point that already holds a stone', () => {
    const { play } = table();
    play('a', at(7, 7));
    const r = play('b', at(7, 7));
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/taken/);
  });

  it('refuses a second stone from the player who has just moved', () => {
    const { a, play } = table();
    expect(play('a', at(7, 7)).accepted).toBe(true);
    const again = play('a', at(7, 8));
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/b's turn/);
    expect(a.currentState.board[at(7, 8)]).toBe(0);
    expect(a.currentState.moveCount).toBe(1);
  });

  it('refuses a cell off the board', () => {
    const { play } = table();
    expect(play('a', CELL_COUNT).accepted).toBe(false);
    expect(play('a', -1).accepted).toBe(false);
    expect(play('a', 7.5).accepted).toBe(false);
  });

  it('refuses an impossible cell in the rules, not only in the decoder', () => {
    // A session runs every payload through decodeAction first, which throws on
    // anything outside 0-224, so the test above never reaches validateAction at
    // all. The rules have to refuse these on their own account, because
    // validateAction is the last guard an action meets before it is applied.
    //
    // The reason matters as much as the refusal: `board[cell]` is undefined for
    // any index off the board, so even with no bounds check at all the answer is
    // still no - just "that point is already taken" about a point that does not
    // exist. Insisting on the right reason is what pins the check down.
    const state = gomoku.createInitialState(setup);
    const impossible = [CELL_COUNT, -1, 7.5, Number.NaN, Number.POSITIVE_INFINITY, 1e12];
    for (const cell of impossible) {
      const action = { type: 'place' as const, player: 'a', seq: 0, payload: { cell } };
      const result = gomoku.validateAction(state, action, ctx);
      expect(result.ok === false && result.reason).toMatch(/0-224/);
    }
    const noCell = { type: 'place' as const, player: 'a', seq: 0, payload: {} as { cell: number } };
    const missing = gomoku.validateAction(state, noCell, ctx);
    expect(missing.ok === false && missing.reason).toMatch(/0-224/);
    const notPlace = { type: 'resign', player: 'a', seq: 0, payload: { cell: 0 } } as unknown as GomokuAction;
    const unknown = gomoku.validateAction(state, notPlace, ctx);
    expect(unknown.ok === false && unknown.reason).toMatch(/resign/);
  });

  it('detects five in a row in all four directions', () => {
    const lines: readonly number[][] = [
      [0, 1, 2, 3, 4].map((k) => at(3, 3 + k)), // horizontal
      [0, 1, 2, 3, 4].map((k) => at(3 + k, 3)), // vertical
      [0, 1, 2, 3, 4].map((k) => at(3 + k, 3 + k)), // "\"
      [0, 1, 2, 3, 4].map((k) => at(3 + k, 7 - k)), // "/"
    ];
    for (const line of lines) {
      const { a, b, play } = table();
      for (let k = 0; k < 5; k++) {
        expect(play('a', line[k] as number).accepted).toBe(true);
        if (k < 4) expect(play('b', FILLER[k] as number).accepted).toBe(true);
      }
      expect(a.status.kind).toBe(GameStatusKind.WON);
      expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['a']);
      expect(a.currentState.winningLine).toEqual(line);
      // The peer that only ever saw the encoded actions must agree.
      expect(b.status.kind).toBe(GameStatusKind.WON);
      expect(b.currentState.winningLine).toEqual(line);
      expect(b.turn).toBeNull();
    }
  });

  it('does not let a run wrap around the edge of the board, in any direction', () => {
    // Each of these fives is evenly spaced in FLAT index - by 1, by SIZE + 1 and
    // by SIZE - 1, the strides a row, a "\" and a "/" have - but every one of
    // them steps over an edge and so is not a line at all. Index arithmetic that
    // forgot the edge would call all three a win; the last is the cruellest,
    // because four of its stones really are a "/" run and only the fifth lies.
    const wrapped: readonly (readonly number[])[] = [
      [at(0, 12), at(0, 13), at(0, 14), at(1, 0), at(1, 1)],
      [at(0, 13), at(1, 14), at(3, 0), at(4, 1), at(5, 2)],
      [at(1, 0), at(1, 14), at(2, 13), at(3, 12), at(4, 11)],
    ];
    for (const cells of wrapped) {
      const { a, play } = table();
      for (let k = 0; k < 5; k++) {
        expect(play('a', cells[k] as number).accepted).toBe(true);
        if (k < 4) expect(play('b', FILLER[k] as number).accepted).toBe(true);
      }
      expect(a.status.kind).toBe(GameStatusKind.IN_PROGRESS);
      expect(a.currentState.winner).toBeNull();
    }
  });

  it('does not call four in a row a win', () => {
    // b takes both ends before a's fourth stone lands, so the four can never
    // grow: what is being checked is that four is not five, not that a ran out
    // of room.
    const { a, play } = table();
    play('a', at(6, 3));
    play('b', at(6, 7));
    play('a', at(6, 4));
    play('b', at(6, 2));
    play('a', at(6, 5));
    play('b', FILLER[0] as number);
    expect(play('a', at(6, 6)).accepted).toBe(true);
    expect(a.currentState.winner).toBeNull();
    expect(a.status.kind).toBe(GameStatusKind.IN_PROGRESS);
    expect(a.turn).toBe('b');
  });

  it('lets the second player win, and names them as the winner', () => {
    // Every other win here is the first player's, so nothing yet proves that
    // mark 2 maps back to players[1] rather than to whoever opened.
    const { a, b, play } = table();
    const line = [0, 1, 2, 3, 4].map((k) => at(9, 2 + k));
    for (let k = 0; k < 5; k++) {
      expect(play('a', FILLER[k] as number).accepted).toBe(true);
      expect(play('b', line[k] as number).accepted).toBe(true);
    }
    expect(a.status.kind).toBe(GameStatusKind.WON);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['b']);
    expect(a.currentState.board[at(9, 2)]).toBe(2);
    expect(a.currentState.winningLine).toEqual(line);
    expect(b.currentState.winner).toBe('b');
    expect(a.turn).toBeNull();
  });

  it('counts an overline as a win and highlights exactly five cells around the new stone', () => {
    // a fills columns 3,4,6,7,8 of row 5 - no five anywhere - then plugs the gap
    // at column 5, making a run of six.
    const { a, play } = table();
    const aCells = [at(5, 3), at(5, 4), at(5, 6), at(5, 7), at(5, 8)];
    for (let k = 0; k < 5; k++) {
      expect(play('a', aCells[k] as number).accepted).toBe(true);
      expect(a.status.kind).toBe(GameStatusKind.IN_PROGRESS);
      play('b', FILLER[k] as number);
    }
    expect(play('a', at(5, 5)).accepted).toBe(true);
    expect(a.status.kind).toBe(GameStatusKind.WON);
    expect(a.currentState.winningLine).toHaveLength(5);
    expect(a.currentState.winningLine).toContain(at(5, 5));
    expect(a.currentState.winningLine).toEqual([at(5, 4), at(5, 5), at(5, 6), at(5, 7), at(5, 8)]);
  });

  it('rejects a move once the game is over', () => {
    const { a, play } = table();
    for (let k = 0; k < 5; k++) {
      play('a', at(3, 3 + k));
      if (k < 4) play('b', FILLER[k] as number);
    }
    expect(a.isOver).toBe(true);
    expect(play('b', at(9, 9)).accepted).toBe(false);
    // The session stops that one before the rules are ever consulted, so the
    // reducer's own guard is asked separately. It is the guard that matters to a
    // device which adopted an already-finished board from a snapshot.
    const finished = gomoku.validateAction(
      a.currentState,
      { type: 'place', player: 'b', seq: 9, payload: { cell: at(9, 9) } },
      ctx,
    );
    expect(finished.ok).toBe(false);
    expect(finished.ok === false && finished.reason).toMatch(/finished/);
  });

  it('draws when the board fills with no line', () => {
    // Colouring by (row + 2*col) mod 4 gives a board whose longest run in any
    // direction is two, so it is a genuine drawn position rather than a state
    // hand-set to "draw". The centre point is left empty and played for real,
    // which is what puts the final move through the reducer.
    const board: Cell[] = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) board.push(((r + 2 * c) % 4 < 2 ? 1 : 2) as Cell);
    }
    const centre = at(7, 7);
    board[centre] = 0;
    const s = session('a', false);
    const adopted = s.applySnapshotEnvelope({
      state: {
        b: board as unknown as CborValue,
        p: ['a', 'b'],
        t: 0,
        m: CELL_COUNT - 1,
        x: at(14, 14),
        w: null,
        l: null,
      },
      seq: { a: 112, b: 112 },
      version: CELL_COUNT - 1,
      elapsedMs: 0,
    });
    expect(adopted).toBe(true);
    expect(s.status.kind).toBe(GameStatusKind.IN_PROGRESS);

    const r = s.submitLocal('place', { cell: centre });
    expect(r.accepted).toBe(true);
    expect(s.currentState.winner).toBeNull();
    expect(s.status.kind).toBe(GameStatusKind.DRAW);
    expect(s.turn).toBeNull();
    // A drawn board is as finished as a won one, and the rules say so first,
    // before they get as far as noticing that every point is occupied.
    const after = gomoku.validateAction(
      s.currentState,
      { type: 'place', player: 'b', seq: 1, payload: { cell: 0 } },
      ctx,
    );
    expect(after.ok === false && after.reason).toMatch(/finished/);
  });

  it('does not mutate the state it is given', () => {
    const state = gomoku.createInitialState(setup);
    const before = [...state.board];
    const next = gomoku.applyAction(state, { type: 'place', player: 'a', seq: 0, payload: { cell: at(7, 7) } }, ctx);
    expect(state.board).toEqual(before);
    expect(state.lastMove).toBe(-1);
    expect(next.board[at(7, 7)]).toBe(1);
  });

  it('rejects a duplicate action rather than applying it twice', () => {
    const a = session('a', true);
    const b = session('b', false);
    const r = a.submitLocal('place', { cell: at(7, 7) });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = gomoku.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });

  it('will not let one player move as another', () => {
    const b = session('b', false);
    const forged = gomoku.encodeAction({ type: 'place', player: 'a', seq: 0, payload: { cell: 0 } });
    // The session authenticated us as 'b', so the action is attributed to b -
    // and b is not to move, so it is refused.
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
  });
});

describe('gomoku encoding', () => {
  it('round-trips a played state exactly', () => {
    const { a, play } = table();
    play('a', at(7, 7));
    play('b', at(8, 8));
    play('a', at(7, 8));
    const encoded = gomoku.encodeState(a.currentState);
    const restored = gomoku.decodeState(encoded);
    expect(gomoku.encodeState(restored)).toEqual(encoded);
    expect(restored.lastMove).toBe(at(7, 8));
    expect(restored.moveCount).toBe(3);
  });

  it('round-trips a finished state, winner and highlighted line and all', () => {
    // The state above has no winner and no winning line, so it says nothing
    // about the two fields that only exist once somebody has won - a decoder
    // that dropped either would pass it. Compare the decoded state field for
    // field rather than by re-encoding it, so a field lost on the way in and
    // absent again on the way out cannot cancel itself out.
    const { a, play } = table();
    for (let k = 0; k < 5; k++) {
      play('a', at(3, 3 + k));
      if (k < 4) play('b', FILLER[k] as number);
    }
    const state = a.currentState;
    expect(state.winner).toBe('a');
    const restored = gomoku.decodeState(gomoku.encodeState(state));
    expect(restored).toEqual(state);
    expect(restored.winningLine).toEqual([0, 1, 2, 3, 4].map((k) => at(3, 3 + k)));
    expect(restored.lastMove).toBe(at(3, 7));
    expect(restored.moveCount).toBe(9);
    expect(restored.players).toEqual(['a', 'b']);
    expect(restored.turnIndex).toBe(state.turnIndex);
  });

  it('round-trips an action exactly', () => {
    const action = { type: 'place' as const, player: 'a', seq: 3, payload: { cell: 224 } };
    const restored = gomoku.decodeAction(gomoku.encodeAction(action), 'a');
    expect(restored).toEqual(action);
  });

  it('throws on a hostile action', () => {
    const junk: CborValue[] = [
      null,
      'place',
      [],
      {},
      { t: 'place', s: 0, p: null },
      { t: 'place', s: 0, p: { c: CELL_COUNT } },
      { t: 'place', s: 0, p: { c: -1 } },
      { t: 'place', s: 0, p: { c: 1.5 } },
      { t: 'place', s: 0, p: { c: 'middle' } },
      { t: 'place', s: -1, p: { c: 0 } },
      { t: 'resign', s: 0, p: { c: 0 } },
    ];
    for (const value of junk) {
      expect(() => gomoku.decodeAction(value, 'a')).toThrow();
    }
  });

  it('throws on a hostile state', () => {
    const good = gomoku.encodeState(gomoku.createInitialState(setup)) as Record<string, CborValue>;
    /** `good` with one key left out, as a peer that dropped a field would send. */
    const without = (key: string): CborValue => {
      const copy = { ...good };
      delete copy[key];
      return copy;
    };
    const junk: CborValue[] = [
      null,
      [],
      // A missing field must be refused rather than quietly defaulted: a board
      // that decoded to lastMove 0 or moveCount 0 would be a different game.
      without('b'),
      without('p'),
      without('t'),
      without('m'),
      without('x'),
      { ...good, b: new Array<number>(CELL_COUNT - 1).fill(0) },
      { ...good, b: [3, ...new Array<number>(CELL_COUNT - 1).fill(0)] },
      { ...good, p: ['a'] },
      { ...good, p: [1, 2] },
      { ...good, t: 2 },
      { ...good, m: CELL_COUNT + 1 },
      { ...good, x: -2 },
      { ...good, x: CELL_COUNT },
      { ...good, l: [0, 1, 2, 3] },
      { ...good, w: 7 },
    ];
    for (const value of junk) {
      expect(() => gomoku.decodeState(value)).toThrow();
    }
  });
});

describe('gomoku conformance', () => {
  const hooks = {
    legalAction: (
      state: ReturnType<typeof gomoku.createInitialState>,
      player: string,
      random: { nextInt: (n: number) => number },
    ) => {
      if (gomoku.currentTurn?.(state) !== player) return null;
      const free: number[] = [];
      for (let i = 0; i < state.board.length; i++) if (state.board[i] === 0) free.push(i);
      if (free.length === 0) return null;
      return { type: 'place', payload: { cell: free[random.nextInt(free.length)] as number } };
    },
    // A full board is 225 plies; the bound is set above that so that a game that
    // somehow avoids five in a row still terminates as a draw rather than being
    // reported as non-terminating.
    maxPlies: 260,
  };

  it('passes the shared game conformance suite', () => {
    const report = runConformance(gomoku, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const report = runConformance(gomoku, hooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
