import { describe, expect, it } from 'vitest';
import { decodeCbor, encodeCbor, type CborValue } from '@airlink/core';
import {
  CELL_COUNT,
  COLS,
  ROWS,
  connectFour,
  landingRow,
  type Cell,
  type ConnectFourAction,
  type ConnectFourState,
} from '../src/games/connectFour.js';
import { GameSession } from '../src/runtime.js';
import { runConformance, type ConformanceHooks } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };

/** Row-major index of (row, col); row 0 is the top row, row 5 the floor. */
const idx = (row: number, col: number): number => row * COLS + col;

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: connectFour, setup, localPlayer: local, isHost });
}

/**
 * Two linked sessions. Every accepted local move is mirrored to the peer
 * through encodeAction, exactly as the transport would.
 */
function table() {
  const a = session('a', true);
  const b = session('b', false);
  const play = (player: 'a' | 'b', column: number) => {
    const from = player === 'a' ? a : b;
    const to = player === 'a' ? b : a;
    const r = from.submitLocal('drop', { column });
    if (r.accepted) {
      const mirrored = to.applyRemote(connectFour.encodeAction(r.applied.action), player);
      expect(mirrored.accepted).toBe(true);
    }
    return r;
  };
  /** Play a list of columns, whoever is to move, all expected legal. */
  const run = (columns: readonly number[]) => {
    for (const column of columns) {
      const player = a.turn;
      expect(player).not.toBeNull();
      const r = play(player as 'a' | 'b', column);
      expect(r.accepted).toBe(true);
    }
  };
  return { a, b, play, run };
}

const sorted = (cells: readonly number[] | null): number[] => [...(cells ?? [])].sort((x, y) => x - y);

const hooks: ConformanceHooks<ConnectFourState, ConnectFourAction> = {
  legalAction: (state, player, random) => {
    if (connectFour.currentTurn?.(state) !== player) return null;
    const open: number[] = [];
    for (let col = 0; col < COLS; col++) if (landingRow(state.board, col) >= 0) open.push(col);
    if (open.length === 0) return null;
    return { type: 'drop', payload: { column: open[random.nextInt(open.length)] as number } };
  },
  maxPlies: 50,
};

/** A legal 42-move filling of the board that contains no four in a row. */
const DRAW_COLUMNS = [
  0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 4, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6,
  6, 6, 6,
];

describe('connect four board', () => {
  it('starts as an empty 7x6 board with the first player to move', () => {
    const s = session('a', true);
    expect(s.currentState.board).toHaveLength(CELL_COUNT);
    expect(s.currentState.board.every((c) => c === 0)).toBe(true);
    expect(CELL_COUNT).toBe(42);
    expect(ROWS).toBe(6);
    expect(s.currentState.moveCount).toBe(0);
    expect(s.currentState.winner).toBeNull();
    expect(s.currentState.winningLine).toBeNull();
    expect(s.turn).toBe('a');
    expect(s.isLocalTurn).toBe(true);
    expect(s.status.kind).toBe(GameStatusKind.IN_PROGRESS);
  });

  it('drops a disc to the lowest empty cell in the column', () => {
    const { a, run } = table();
    run([3]);
    expect(a.currentState.board[idx(5, 3)]).toBe(1);
    expect(a.currentState.board[idx(4, 3)]).toBe(0);
    expect(a.currentState.moveCount).toBe(1);
    expect(a.turn).toBe('b');
  });

  it('stacks discs upwards as a column fills', () => {
    const { a, run } = table();
    run([3, 3, 3]);
    expect(a.currentState.board[idx(5, 3)]).toBe(1);
    expect(a.currentState.board[idx(4, 3)]).toBe(2);
    expect(a.currentState.board[idx(3, 3)]).toBe(1);
    // Nothing else moved.
    expect(a.currentState.board.filter((c) => c !== 0)).toHaveLength(3);
  });

  it('alternates turns between exactly two players', () => {
    const { a, run } = table();
    expect(a.turn).toBe('a');
    run([0]);
    expect(a.turn).toBe('b');
    run([1]);
    expect(a.turn).toBe('a');
    expect(a.currentState.turnIndex).toBe(0);
  });

  it('reports landingRow correctly, including for a full column', () => {
    const board = new Array<Cell>(CELL_COUNT).fill(0);
    expect(landingRow(board, 0)).toBe(5);
    board[idx(5, 0)] = 1;
    expect(landingRow(board, 0)).toBe(4);
    for (let row = 0; row <= 5; row++) board[idx(row, 0)] = 1;
    expect(landingRow(board, 0)).toBe(-1);
    expect(landingRow(board, 1)).toBe(5);
  });
});

describe('connect four win detection', () => {
  it('detects a horizontal win', () => {
    const { a, b, run } = table();
    // a takes the bottom row of columns 0-3; b stacks on top of 0-2.
    run([0, 0, 1, 1, 2, 2, 3]);
    expect(a.status.kind).toBe(GameStatusKind.WON);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['a']);
    expect(b.status.kind).toBe(GameStatusKind.WON);
    expect(sorted(a.currentState.winningLine)).toEqual([idx(5, 0), idx(5, 1), idx(5, 2), idx(5, 3)]);
    expect(a.currentState.winningLine).toEqual(b.currentState.winningLine);
  });

  it('detects a vertical win', () => {
    const { a, run } = table();
    run([0, 1, 0, 1, 0, 1, 0]);
    expect(a.status.kind).toBe(GameStatusKind.WON);
    expect(a.currentState.winner).toBe('a');
    expect(sorted(a.currentState.winningLine)).toEqual([idx(2, 0), idx(3, 0), idx(4, 0), idx(5, 0)]);
  });

  it('detects a down-right diagonal win', () => {
    const { a, run } = table();
    // a builds (2,0) (3,1) (4,2) (5,3); b fills the cells underneath.
    run([3, 0, 6, 0, 6, 0, 0, 1, 5, 1, 1, 2, 2]);
    expect(a.currentState.winner).toBe('a');
    expect(sorted(a.currentState.winningLine)).toEqual([idx(2, 0), idx(3, 1), idx(4, 2), idx(5, 3)]);
  });

  it('detects a down-left diagonal win', () => {
    const { a, run } = table();
    // a builds (5,0) (4,1) (3,2) (2,3); b fills the cells underneath.
    run([0, 1, 1, 2, 6, 2, 2, 3, 6, 3, 6, 3, 3]);
    expect(a.currentState.winner).toBe('a');
    expect(sorted(a.currentState.winningLine)).toEqual([idx(2, 3), idx(3, 2), idx(4, 1), idx(5, 0)]);
  });

  it('lets the second player win too', () => {
    const { a, b, run } = table();
    // a plays column 6 harmlessly; b takes the bottom of 0-3.
    run([6, 0, 6, 1, 6, 2, 5, 3]);
    expect(a.currentState.winner).toBe('b');
    expect(b.status.kind === GameStatusKind.WON && b.status.winners).toEqual(['b']);
    expect(sorted(b.currentState.winningLine)).toEqual([idx(5, 0), idx(5, 1), idx(5, 2), idx(5, 3)]);
  });

  it('reports a winning line of exactly four cells, all owned by the winner', () => {
    const { a, run } = table();
    run([0, 1, 0, 1, 0, 1, 0]);
    const line = a.currentState.winningLine;
    expect(line).not.toBeNull();
    expect(line).toHaveLength(4);
    expect(new Set(line).size).toBe(4);
    for (const cell of line ?? []) expect(a.currentState.board[cell]).toBe(1);
  });

  it('picks a four-cell window containing the winning disc when the run is five long', () => {
    const { a, run } = table();
    // a ends up with the bottom row of columns 0-4, completing it at column 2.
    run([0, 0, 1, 1, 3, 3, 4, 4, 2]);
    expect(a.currentState.winner).toBe('a');
    const line = a.currentState.winningLine ?? [];
    expect(line).toHaveLength(4);
    expect(line).toContain(idx(5, 2));
    for (const cell of line) expect(a.currentState.board[cell]).toBe(1);
  });

  it('does not call three in a row a win', () => {
    const { a, run } = table();
    run([0, 1, 0, 1, 0]);
    expect(a.currentState.winner).toBeNull();
    expect(a.status.kind).toBe(GameStatusKind.IN_PROGRESS);
  });

  it('does not connect across the board edge', () => {
    const { a, run } = table();
    // a on (5,5) (5,6) then (4,0) (4,1) - wrapping would be four "in a row".
    run([5, 0, 6, 1, 0, 2, 1]);
    expect(a.currentState.winner).toBeNull();
  });

  it('reaches a draw when the board fills with no line', () => {
    const { a, b, run } = table();
    run(DRAW_COLUMNS);
    expect(a.currentState.moveCount).toBe(42);
    expect(a.currentState.board.some((c) => c === 0)).toBe(false);
    expect(a.currentState.winner).toBeNull();
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
    expect(b.status.kind).toBe(GameStatusKind.DRAW);
    expect(a.turn).toBeNull();
    expect(connectFour.currentTurn?.(a.currentState)).toBeNull();
  });
});

describe('connect four rejects illegal play', () => {
  it('refuses a move out of turn', () => {
    const b = session('b', false);
    const r = b.submitLocal('drop', { column: 0 });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/turn/);
  });

  it('refuses a second move in a row from the same player', () => {
    const { play } = table();
    expect(play('a', 0).accepted).toBe(true);
    expect(play('a', 1).accepted).toBe(false);
  });

  it('refuses a drop into a full column', () => {
    const { a, play, run } = table();
    run([2, 2, 2, 2, 2, 2]);
    expect(landingRow(a.currentState.board, 2)).toBe(-1);
    const r = play('a', 2);
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/full/);
    // A different column is still fine.
    expect(play('a', 3).accepted).toBe(true);
  });

  it('refuses a column outside 0-6', () => {
    const { play } = table();
    for (const column of [7, 8, -1, 42, 1.5, Number.NaN, 1e12]) {
      expect(play('a', column).accepted).toBe(false);
    }
    expect(play('a', 0).accepted).toBe(true);
  });

  it('refuses an out-of-range column at the validator, not only the decoder', () => {
    const state = connectFour.createInitialState(setup);
    const context = createContext(setup.players, setup.seed);
    for (const column of [-1, 7, 1.5, 1e9]) {
      const forged = { type: 'drop', player: 'a', seq: 0, payload: { column } } as ConnectFourAction;
      const result = connectFour.validateAction(state, forged, context);
      expect(result.ok).toBe(false);
    }
  });

  it('refuses an unknown action type at the validator', () => {
    const state = connectFour.createInitialState(setup);
    const context = createContext(setup.players, setup.seed);
    const forged = { type: 'nudge', player: 'a', seq: 0, payload: { column: 0 } } as unknown as ConnectFourAction;
    expect(connectFour.validateAction(state, forged, context).ok).toBe(false);
  });

  it('rejects a move once the game is over', () => {
    const { a, play, run } = table();
    run([0, 1, 0, 1, 0, 1, 0]);
    expect(a.isOver).toBe(true);
    expect(play('b', 5).accepted).toBe(false);
    expect(play('a', 5).accepted).toBe(false);
    // And the reducer itself refuses, not just the session.
    const context = createContext(setup.players, setup.seed);
    const after = { type: 'drop', player: 'b', seq: 9, payload: { column: 5 } } as ConnectFourAction;
    expect(connectFour.validateAction(a.currentState, after, context).ok).toBe(false);
  });

  it('rejects a move onto a drawn board', () => {
    const { a, play, run } = table();
    run(DRAW_COLUMNS);
    expect(play('a', 0).accepted).toBe(false);
    expect(play('b', 0).accepted).toBe(false);
    expect(a.currentState.moveCount).toBe(42);
  });

  it('will not let one player move as another', () => {
    const b = session('b', false);
    const forged = connectFour.encodeAction({ type: 'drop', player: 'a', seq: 0, payload: { column: 0 } });
    // The session authenticated us as 'b', so the action is attributed to b -
    // and b is not to move, so it is refused.
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
  });

  it('refuses an action from someone who is not in the game', () => {
    const a = session('a', true);
    const stolen = connectFour.encodeAction({ type: 'drop', player: 'a', seq: 0, payload: { column: 0 } });
    const r = a.applyRemote(stolen, 'mallory');
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.reason).toBe('notAPlayer');
  });

  it('rejects a replayed action rather than applying it twice', () => {
    const a = session('a', true);
    const b = session('b', false);
    const r = a.submitLocal('drop', { column: 0 });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = connectFour.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.reason).toBe('duplicate');
    expect(b.currentState.moveCount).toBe(1);
  });
});

describe('connect four purity and determinism', () => {
  it('does not mutate the state handed to applyAction', () => {
    const state = connectFour.createInitialState(setup);
    const before = JSON.stringify(connectFour.encodeState(state));
    const context = createContext(setup.players, setup.seed);
    const action = { type: 'drop', player: 'a', seq: 0, payload: { column: 3 } } as ConnectFourAction;
    const next = connectFour.applyAction(state, action, context);
    expect(JSON.stringify(connectFour.encodeState(state))).toBe(before);
    expect(next).not.toBe(state);
    expect(next.board).not.toBe(state.board);
    expect(next.board[idx(5, 3)]).toBe(1);
  });

  it('produces identical states for identical action sequences', () => {
    const columns = [3, 3, 3, 3, 3, 3, 0, 1, 0, 1];
    const one = table();
    const two = table();
    one.run(columns);
    two.run(columns);
    expect(connectFour.encodeState(one.a.currentState)).toEqual(connectFour.encodeState(two.a.currentState));
    expect(connectFour.encodeState(one.a.currentState)).toEqual(connectFour.encodeState(one.b.currentState));
  });

  it('replays an action log back to the same state', () => {
    const { a, run } = table();
    run([3, 3, 4, 2, 5, 4, 1]);
    const replayed = GameSession.replay(connectFour, setup, a.history());
    expect(connectFour.encodeState(replayed)).toEqual(connectFour.encodeState(a.currentState));
  });
});

describe('connect four encoding', () => {
  it('round-trips an action through CBOR exactly', () => {
    for (let column = 0; column < COLS; column++) {
      const action: ConnectFourAction = { type: 'drop', player: 'a', seq: column, payload: { column } };
      const wire = decodeCbor(encodeCbor(connectFour.encodeAction(action)));
      const restored = connectFour.decodeAction(wire, 'a');
      expect(restored).toEqual(action);
    }
  });

  it('uses the compact wire shape and stays far inside one Bluetooth packet', () => {
    const action: ConnectFourAction = { type: 'drop', player: 'a', seq: 3, payload: { column: 6 } };
    expect(connectFour.encodeAction(action)).toEqual({ t: 'drop', s: 3, p: { c: 6 } });
    expect(encodeCbor(connectFour.encodeAction(action)).length).toBeLessThan(32);
  });

  it('round-trips a mid-game state through CBOR exactly', () => {
    const { a, run } = table();
    run([3, 3, 4, 2, 5, 4, 1]);
    const encoded = connectFour.encodeState(a.currentState);
    const restored = connectFour.decodeState(decodeCbor(encodeCbor(encoded)));
    expect(connectFour.encodeState(restored)).toEqual(encoded);
    expect(restored).toEqual(a.currentState);
  });

  it('round-trips a finished state, winning line and all', () => {
    const { a, run } = table();
    run([0, 1, 0, 1, 0, 1, 0]);
    const encoded = connectFour.encodeState(a.currentState);
    const restored = connectFour.decodeState(decodeCbor(encodeCbor(encoded)));
    expect(restored.winner).toBe('a');
    expect(restored.winningLine).toEqual(a.currentState.winningLine);
    expect(connectFour.encodeState(restored)).toEqual(encoded);
  });

  it('fits a whole snapshot inside a couple of Bluetooth packets', () => {
    const { a, run } = table();
    run(DRAW_COLUMNS.slice(0, 20));
    expect(encodeCbor(connectFour.encodeState(a.currentState)).length).toBeLessThan(360);
  });
});

describe('connect four hostile input', () => {
  it('throws on malformed actions instead of trusting them', () => {
    const junk: CborValue[] = [
      null,
      0,
      'drop',
      [],
      {},
      new Uint8Array(8),
      { t: 'drop' },
      { t: 'drop', s: 0 },
      { t: 'drop', s: 0, p: null },
      { t: 'drop', s: 0, p: [] },
      { t: 'drop', s: 0, p: new Uint8Array(4) },
      { t: 'drop', s: 0, p: { c: 7 } },
      { t: 'drop', s: 0, p: { c: -1 } },
      { t: 'drop', s: 0, p: { c: 1.5 } },
      { t: 'drop', s: 0, p: { c: 1e12 } },
      { t: 'drop', s: 0, p: { c: '3' } },
      { t: 'drop', s: 0, p: { c: true } },
      { t: 'drop', s: 0, p: { column: 3 } },
      { t: 'drop', s: -1, p: { c: 0 } },
      { t: 'drop', s: 1.5, p: { c: 0 } },
      { t: 'place', s: 0, p: { c: 0 } },
      { t: 'x'.repeat(500), s: 0, p: { c: 0 } },
      { t: 'drop', s: 0, p: Array.from({ length: 200 }, () => 1) },
    ];
    for (const value of junk) {
      expect(() => connectFour.decodeAction(value, 'a'), JSON.stringify(value) ?? 'binary').toThrow();
    }
  });

  it('never lets a hostile packet escape applyRemote as a throw', () => {
    const a = session('a', true);
    const junk: CborValue[] = [
      null,
      0,
      'nope',
      [],
      {},
      { t: 'drop', s: 0, p: { c: 99 } },
      { t: 'drop', s: 0, p: new Uint8Array(64) },
      { t: 'drop', s: 0, p: { c: Number.MAX_SAFE_INTEGER } },
      { t: 'drop', s: Number.MAX_SAFE_INTEGER, p: { c: 0 } },
    ];
    for (const value of junk) {
      expect(() => a.applyRemote(value, 'a')).not.toThrow();
      expect(a.applyRemote(value, 'a').accepted).toBe(false);
    }
    expect(a.currentState.moveCount).toBe(0);
  });

  it('accepts every legal column and only those', () => {
    for (let column = -2; column <= 8; column++) {
      const wire = { t: 'drop', s: 0, p: { c: column } };
      if (column >= 0 && column <= 6) {
        expect(connectFour.decodeAction(wire, 'a').payload.column).toBe(column);
      } else {
        expect(() => connectFour.decodeAction(wire, 'a')).toThrow();
      }
    }
  });

  it('throws on malformed states instead of adopting them', () => {
    const good = connectFour.encodeState(connectFour.createInitialState(setup)) as Record<string, CborValue>;
    const bad: CborValue[] = [
      null,
      0,
      'state',
      [],
      {},
      { ...good, b: [] },
      { ...good, b: new Array(41).fill(0) },
      { ...good, b: new Array(43).fill(0) },
      { ...good, b: new Array(42).fill(3) },
      { ...good, b: new Array(42).fill('x') },
      { ...good, b: new Array(42).fill(-1) },
      { ...good, p: [] },
      { ...good, p: ['a'] },
      { ...good, p: ['a', 'b', 'c'] },
      { ...good, p: [1, 2] },
      { ...good, t: 2 },
      { ...good, t: -1 },
      { ...good, t: null },
      { ...good, m: 43 },
      { ...good, m: -1 },
      { ...good, m: 'lots' },
      { ...good, w: 7 },
      { ...good, l: [0, 1, 2] },
      { ...good, l: [0, 1, 2, 3, 4] },
      { ...good, l: [0, 1, 2, 42] },
      { ...good, l: ['a', 'b', 'c', 'd'] },
    ];
    for (const value of bad) {
      expect(() => connectFour.decodeState(value), JSON.stringify(value)?.slice(0, 80) ?? 'binary').toThrow();
    }
    // The untouched original is of course fine.
    expect(() => connectFour.decodeState(good)).not.toThrow();
  });

  it('does not let a decoded state smuggle in an oversized board', () => {
    const good = connectFour.encodeState(connectFour.createInitialState(setup)) as Record<string, CborValue>;
    expect(() => connectFour.decodeState({ ...good, b: new Array(5000).fill(0) })).toThrow();
  });
});

describe('connect four conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(connectFour, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(connectFour, hooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
