/**
 * Connect Four. Seven columns, six rows, gravity, four in a row wins.
 *
 * Shaped exactly like the reference game (src/games/ticTacToe.ts):
 *   - an immutable state type
 *   - a single discriminated action type
 *   - validateAction rejecting anything a hostile peer must not do
 *   - applyAction as a pure reducer
 *   - compact encode/decode for both state and action
 *   - decodeAction treating its input as bytes from an attacker
 *
 * FLOATING POINT: this game stores no real numbers at all. Every value in the
 * state is a small integer (cell marks 0/1/2, indices 0-41, counters 0-42), and
 * the only division performed is `index / COLS` inside Math.floor, which is
 * exact for integers far below 2^53 on every IEEE-754 engine. There is
 * therefore nothing to round and no way for two devices to drift apart.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
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

export const COLS = 7;
export const ROWS = 6;
export const CELL_COUNT = COLS * ROWS; // 42
/** Discs needed in a row to win. */
export const CONNECT = 4;

export interface ConnectFourState {
  /** 42 cells, row-major, row 0 is the TOP row and row 5 the floor. */
  readonly board: readonly Cell[];
  readonly players: readonly PlayerId[];
  readonly turnIndex: number;
  readonly moveCount: number;
  readonly winner: PlayerId | null;
  /** The four cell indices that won, for the UI to highlight. */
  readonly winningLine: readonly number[] | null;
}

export interface ConnectFourAction extends GameAction {
  readonly type: 'drop';
  readonly payload: { readonly column: number };
}

/** [dRow, dCol]: horizontal, vertical, "\" diagonal, "/" diagonal. */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/** Index of the cell at (row, col). Callers guarantee both are in range. */
function at(row: number, col: number): number {
  return row * COLS + col;
}

/**
 * The row a disc dropped into `col` would land on, or -1 when the column is
 * full. Discs fall to the largest free row index, i.e. as far down as possible.
 */
export function landingRow(board: readonly Cell[], col: number): number {
  for (let row = ROWS - 1; row >= 0; row--) {
    if (board[at(row, col)] === 0) return row;
  }
  return -1;
}

/**
 * Look for four in a row through `index`, which has just been filled with
 * `mark`. Only lines through the new disc can be new, so this is all we check.
 *
 * A run may be longer than four; the returned line is always exactly four
 * contiguous cells and always contains the disc that was just played, chosen
 * deterministically so both devices highlight the same squares.
 */
function findWinThrough(board: readonly Cell[], index: number, mark: Cell): readonly number[] | null {
  if (mark === 0) return null;
  const row = Math.floor(index / COLS);
  const col = index - row * COLS;

  for (const dir of DIRECTIONS) {
    const dr = dir[0];
    const dc = dir[1];

    // Walk backwards to the start of the run, then forwards to its end.
    let back = 0;
    while (back < CONNECT - 1) {
      const r = row - dr * (back + 1);
      const c = col - dc * (back + 1);
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      if (board[at(r, c)] !== mark) break;
      back += 1;
    }
    let forward = 0;
    while (forward < CONNECT - 1) {
      const r = row + dr * (forward + 1);
      const c = col + dc * (forward + 1);
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      if (board[at(r, c)] !== mark) break;
      forward += 1;
    }

    const runLength = back + 1 + forward;
    if (runLength < CONNECT) continue;

    // Window of four that still contains the new disc (position `back` in the
    // run, counting from the run's start).
    const start = Math.min(back, runLength - CONNECT);
    const line: number[] = [];
    for (let k = 0; k < CONNECT; k++) {
      const step = start + k - back;
      line.push(at(row + dr * step, col + dc * step));
    }
    return line;
  }
  return null;
}

export const connectFour: GameDefinition<ConnectFourState, ConnectFourAction> = {
  id: 'connect-four',
  name: 'Connect Four',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): ConnectFourState {
    return {
      board: new Array<Cell>(CELL_COUNT).fill(0),
      players: [...setup.players],
      turnIndex: 0,
      moveCount: 0,
      winner: null,
      winningLine: null,
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.winner !== null || state.moveCount >= CELL_COUNT) return invalid('the game has already finished');
    if (action.type !== 'drop') return invalid(`unknown action "${action.type}"`);
    const expected = state.players[state.turnIndex];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);
    const column = action.payload?.column;
    if (!Number.isInteger(column) || column < 0 || column > COLS - 1) return invalid('column must be 0-6');
    if (landingRow(state.board, column) < 0) return invalid('that column is full');
    return VALID;
  },

  applyAction(state, action): ConnectFourState {
    const mark: Cell = state.turnIndex === 0 ? 1 : 2;
    const column = action.payload.column;
    const row = landingRow(state.board, column);
    // validateAction already refused a full or out-of-range column; this guard
    // only keeps a contract violation from writing outside the board.
    if (row < 0) return state;
    const board = [...state.board];
    const index = at(row, column);
    board[index] = mark;
    const line = findWinThrough(board, index, mark);
    return {
      board,
      players: state.players,
      turnIndex: (state.turnIndex + 1) % state.players.length,
      moveCount: state.moveCount + 1,
      winner: line ? (state.players[mark - 1] ?? null) : null,
      winningLine: line,
    };
  },

  status(state): GameStatus {
    if (state.winner !== null) {
      return { kind: GameStatusKind.WON, winners: [state.winner], reason: 'four in a row' };
    }
    if (state.moveCount >= CELL_COUNT) return { kind: GameStatusKind.DRAW, reason: 'the board is full' };
    return { kind: GameStatusKind.IN_PROGRESS };
  },

  currentTurn(state): PlayerId | null {
    if (state.winner !== null || state.moveCount >= CELL_COUNT) return null;
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

  decodeState(value): ConnectFourState {
    const m = asMap(value, 'connectFour.state');
    const cells = asArray(m.b, 'board', CELL_COUNT);
    if (cells.length !== CELL_COUNT) throw new GameDecodeError('connectFour: board must have 42 cells');
    const board = cells.map((c, i) => asInt(c, `board[${i}]`, 0, 2) as Cell);
    const raw = asArray(m.p, 'players', 2);
    if (raw.length !== 2) throw new GameDecodeError('connectFour: expected exactly 2 players');
    const players = raw.map((p, i) => {
      if (typeof p !== 'string') throw new GameDecodeError(`connectFour: players[${i}] must be a string`);
      if (p.length > 256) throw new GameDecodeError(`connectFour: players[${i}] is too long`);
      return p;
    });
    let winningLine: readonly number[] | null = null;
    if (m.l !== null && m.l !== undefined) {
      const line = asArray(m.l, 'winningLine', CONNECT);
      if (line.length !== CONNECT) throw new GameDecodeError('connectFour: winningLine must have 4 cells');
      winningLine = line.map((n, i) => asInt(n, `winningLine[${i}]`, 0, CELL_COUNT - 1));
    }
    if (m.w !== null && m.w !== undefined && typeof m.w !== 'string') {
      throw new GameDecodeError('connectFour: winner must be a string or null');
    }
    return {
      board,
      players,
      turnIndex: asInt(m.t, 'turnIndex', 0, 1),
      moveCount: asInt(m.m, 'moveCount', 0, CELL_COUNT),
      winner: typeof m.w === 'string' ? m.w : null,
      winningLine,
    };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({ ...action, payload: { c: action.payload.column } });
  },

  decodeAction(value, player): ConnectFourAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'drop') throw new GameDecodeError(`connectFour: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'connectFour.payload');
    return {
      type: 'drop',
      player,
      seq: envelope.seq,
      payload: { column: asInt(payload.c, 'column', 0, COLS - 1) },
    };
  },
};
