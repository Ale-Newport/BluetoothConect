/**
 * Tic-Tac-Toe. The reference implementation for the AirLink game contract.
 *
 * Every other game follows this shape:
 *   - an immutable state type
 *   - a discriminated action type
 *   - validateAction rejecting anything a peer must not do
 *   - applyAction as a pure reducer
 *   - compact encode/decode for both state and action
 *   - decodeAction treating its input as hostile
 */
import type { CborValue } from '@airlink/core';
import {
  GameMode,
  GameStatusKind,
  VALID,
  asArray,
  asInt,
  asMap,
  decodeActionEnvelope,
  encodeActionEnvelope,
  invalid,
  type GameAction,
  type GameDefinition,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';

/** 0 = empty, 1 = first player, 2 = second player. */
export type Cell = 0 | 1 | 2;

export interface TicTacToeState {
  readonly board: readonly Cell[]; // 9 cells, row-major
  readonly players: readonly PlayerId[];
  readonly turnIndex: number;
  readonly moveCount: number;
  readonly winner: PlayerId | null;
  readonly winningLine: readonly number[] | null;
}

export interface TicTacToeAction extends GameAction {
  readonly type: 'place';
  readonly payload: { readonly cell: number };
}

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function findWin(board: readonly Cell[]): { mark: Cell; line: readonly number[] } | null {
  for (const line of LINES) {
    const [a, b, c] = line;
    const mark = board[a] as Cell;
    if (mark !== 0 && mark === board[b] && mark === board[c]) return { mark, line };
  }
  return null;
}

export const ticTacToe: GameDefinition<TicTacToeState, TicTacToeAction> = {
  id: 'tic-tac-toe',
  name: 'Tic-Tac-Toe',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): TicTacToeState {
    return {
      board: new Array<Cell>(9).fill(0),
      players: [...setup.players],
      turnIndex: 0,
      moveCount: 0,
      winner: null,
      winningLine: null,
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.winner !== null || state.moveCount >= 9) return invalid('the game has already finished');
    if (action.type !== 'place') return invalid(`unknown action "${action.type}"`);
    const expected = state.players[state.turnIndex];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);
    const cell = action.payload.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) return invalid('cell must be 0-8');
    if (state.board[cell] !== 0) return invalid('that square is already taken');
    return VALID;
  },

  applyAction(state, action): TicTacToeState {
    const mark: Cell = state.turnIndex === 0 ? 1 : 2;
    const board = [...state.board];
    board[action.payload.cell] = mark;
    const win = findWin(board);
    return {
      board,
      players: state.players,
      turnIndex: (state.turnIndex + 1) % state.players.length,
      moveCount: state.moveCount + 1,
      winner: win ? (state.players[win.mark - 1] ?? null) : null,
      winningLine: win ? win.line : null,
    };
  },

  status(state): GameStatus {
    if (state.winner !== null) {
      return { kind: GameStatusKind.WON, winners: [state.winner], reason: 'three in a row' };
    }
    if (state.moveCount >= 9) return { kind: GameStatusKind.DRAW, reason: 'the board is full' };
    return { kind: GameStatusKind.IN_PROGRESS };
  },

  currentTurn(state): PlayerId | null {
    if (state.winner !== null || state.moveCount >= 9) return null;
    return state.players[state.turnIndex] ?? null;
  },

  encodeState(state): CborValue {
    return {
      b: [...state.board],
      p: [...state.players],
      t: state.turnIndex,
      m: state.moveCount,
      w: state.winner,
      l: state.winningLine ? [...state.winningLine] : null,
    };
  },

  decodeState(value): TicTacToeState {
    const m = asMap(value, 'ticTacToe.state');
    const board = asArray(m.b, 'board', 9).map((c, i) => {
      const v = asInt(c, `board[${i}]`, 0, 2);
      return v as Cell;
    });
    if (board.length !== 9) throw new Error('ticTacToe: board must have 9 cells');
    const players = asArray(m.p, 'players', 2).map((p) => {
      if (typeof p !== 'string') throw new Error('ticTacToe: player id must be a string');
      return p;
    });
    return {
      board,
      players,
      turnIndex: asInt(m.t, 'turnIndex', 0, 1),
      moveCount: asInt(m.m, 'moveCount', 0, 9),
      winner: typeof m.w === 'string' ? m.w : null,
      winningLine: Array.isArray(m.l) ? asArray(m.l, 'winningLine', 3).map((n) => asInt(n, 'line', 0, 8)) : null,
    };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({ ...action, payload: { c: action.payload.cell } });
  },

  decodeAction(value, player): TicTacToeAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'place') throw new Error(`ticTacToe: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'ticTacToe.payload');
    return {
      type: 'place',
      player,
      seq: envelope.seq,
      payload: { cell: asInt(payload.c, 'cell', 0, 8) },
    };
  },
};
