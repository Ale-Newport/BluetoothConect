/**
 * Gomoku: five in a row on a 15x15 board.
 *
 * Shaped exactly like the reference game (src/games/ticTacToe.ts):
 *   - an immutable state type
 *   - a single discriminated action type
 *   - validateAction rejecting anything a hostile peer must not do
 *   - applyAction as a pure reducer
 *   - compact encode/decode for both state and action
 *   - decodeAction treating its input as bytes from an attacker
 *
 * ---------------------------------------------------------------------------
 * RULES WE CHOSE, AND THE ONES WE DID NOT
 * ---------------------------------------------------------------------------
 * This is "free-style" Gomoku: a run of five OR MORE wins. Tournament Gomoku
 * instead calls an overline (six or more) a non-win, and serious variants pile
 * on opening restrictions - Renju forbids the first player certain double-threes
 * and double-fours - because free-style is a known first-player win with perfect
 * play. All of that lost here for one reason: two people passing a phone back
 * and forth need a rule they can check by looking at the board. A player who has
 * just drawn six stones through the centre and been told they have not won will
 * conclude the app is broken, and they will be right to.
 *
 * ---------------------------------------------------------------------------
 * WHY lastMove IS IN THE STATE
 * ---------------------------------------------------------------------------
 * On a nine-square board you can see the whole position at a glance. On 225
 * squares, rendered at phone size, a player genuinely cannot find the stone the
 * opponent has just played, and then cannot reason about the position at all.
 * `lastMove` is therefore load-bearing rather than decorative: without it the
 * renderer has no way to recover which stone is new, because the board alone
 * does not say. It costs three or four bytes on the wire - a one-character key
 * plus an index - and is only ever in a snapshot.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Every value here is a small integer: cell marks 0/1/2, indices 0-224,
 * counters 0-225. The only division is `index / SIZE` inside Math.floor, exact
 * for integers this far below 2^53 on every IEEE-754 engine. There is nothing
 * to round and so no way for two devices to drift apart.
 *
 * ---------------------------------------------------------------------------
 * WIRE SIZE (~180 usable bytes per Bluetooth packet)
 * ---------------------------------------------------------------------------
 * A `place` action is 18 to 20 bytes - one small integer and the envelope - so
 * a move is comfortably one packet, which is the number that matters, because
 * it is the only thing sent per turn. A full state is roughly 260 bytes and so
 * does NOT fit one packet; it is fragmented by the transport, and it is only
 * ever sent to catch up a peer that rejoined or to persist a game. Packing the
 * board into a Uint8Array would save nothing worth having - CBOR spends one
 * byte per cell either way for values under 24 - and would cost the per-cell
 * range checking that decodeState does now, so the plain array stays.
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

export const SIZE = 15;
export const CELL_COUNT = SIZE * SIZE; // 225
/** Stones needed in a row to win. A longer run counts too; see the header. */
export const WIN_LENGTH = 5;

export interface GomokuState {
  /** 225 cells, row-major. */
  readonly board: readonly Cell[];
  readonly players: readonly PlayerId[];
  readonly turnIndex: number;
  readonly moveCount: number;
  /** Index of the stone played last, or -1 before the first move. */
  readonly lastMove: number;
  readonly winner: PlayerId | null;
  /** The five cell indices that won, for the UI to highlight. */
  readonly winningLine: readonly number[] | null;
}

export interface GomokuAction extends GameAction {
  readonly type: 'place';
  readonly payload: { readonly cell: number };
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
  return row * SIZE + col;
}

/**
 * Look for a run of five through `index`, which has just been filled with
 * `mark`. Only lines through the new stone can be new, so this is all we check:
 * scanning the whole board every move would be 225 cells times four directions
 * for a result that cannot differ.
 *
 * A run may be longer than five. The returned line is always exactly five
 * contiguous cells and always contains the stone that was just played: the
 * window that STARTS on that stone, slid back only as far as it must to fit
 * inside the run. Any fixed choice of window would do; what matters is that it
 * is the same choice on both devices, because two phones highlighting different
 * fives would be a visible divergence even though the winner agreed.
 *
 * Walking by (row, col) rather than by flat index is what stops a run wrapping
 * around the right-hand edge onto the next row, which flat-index arithmetic
 * would happily let it do.
 */
function findWinThrough(board: readonly Cell[], index: number, mark: Cell): readonly number[] | null {
  if (mark === 0) return null;
  const row = Math.floor(index / SIZE);
  const col = index - row * SIZE;

  for (const dir of DIRECTIONS) {
    const dr = dir[0];
    const dc = dir[1];

    // Walk backwards to the start of the run, then forwards to its end.
    let back = 0;
    while (back < WIN_LENGTH - 1) {
      const r = row - dr * (back + 1);
      const c = col - dc * (back + 1);
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) break;
      if (board[at(r, c)] !== mark) break;
      back += 1;
    }
    let forward = 0;
    while (forward < WIN_LENGTH - 1) {
      const r = row + dr * (forward + 1);
      const c = col + dc * (forward + 1);
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) break;
      if (board[at(r, c)] !== mark) break;
      forward += 1;
    }

    const runLength = back + 1 + forward;
    if (runLength < WIN_LENGTH) continue;

    // The new stone sits `back` cells along the run, so a window opening on it
    // fits whenever four more cells follow it; when they do not, slide the
    // window back just far enough to stay inside the run.
    const start = Math.min(back, runLength - WIN_LENGTH);
    const line: number[] = [];
    for (let k = 0; k < WIN_LENGTH; k++) {
      const step = start + k - back;
      line.push(at(row + dr * step, col + dc * step));
    }
    return line;
  }
  return null;
}

/**
 * A winner off the wire, checked against the seats.
 *
 * `null` for "nobody has won", and an error for anything else: a string that
 * names no player is not a missing winner, it is a peer claiming a result that
 * cannot have happened.
 */
function decodeWinner(value: CborValue | undefined, players: readonly PlayerId[]): PlayerId | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('gomoku: winner must be a player id or null');
  if (!players.includes(value)) throw new Error('gomoku: winner is not a player in this game');
  return value;
}

export const gomoku: GameDefinition<GomokuState, GomokuAction> = {
  id: 'gomoku',
  name: 'Gomoku',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): GomokuState {
    return {
      board: new Array<Cell>(CELL_COUNT).fill(0),
      players: [...setup.players],
      turnIndex: 0,
      moveCount: 0,
      lastMove: -1,
      winner: null,
      winningLine: null,
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.winner !== null || state.moveCount >= CELL_COUNT) return invalid('the game has already finished');
    if (action.type !== 'place') return invalid(`unknown action "${action.type}"`);
    const expected = state.players[state.turnIndex];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);
    const cell = action.payload?.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell > CELL_COUNT - 1) return invalid('cell must be 0-224');
    if (state.board[cell] !== 0) return invalid('that point is already taken');
    return VALID;
  },

  applyAction(state, action): GomokuState {
    const mark: Cell = state.turnIndex === 0 ? 1 : 2;
    const cell = action.payload.cell;
    const board = [...state.board];
    board[cell] = mark;
    const line = findWinThrough(board, cell, mark);
    return {
      board,
      players: state.players,
      turnIndex: (state.turnIndex + 1) % state.players.length,
      moveCount: state.moveCount + 1,
      lastMove: cell,
      winner: line ? (state.players[mark - 1] ?? null) : null,
      winningLine: line,
    };
  },

  status(state): GameStatus {
    if (state.winner !== null) {
      return { kind: GameStatusKind.WON, winners: [state.winner], reason: 'five in a row' };
    }
    // The board filling is the hard backstop: 225 plies and the game is over
    // whatever the position looks like, so random play cannot run for ever.
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
      x: state.lastMove,
      w: state.winner,
      l: state.winningLine ? [...state.winningLine] : null,
    };
  },

  decodeState(value): GomokuState {
    const m = asMap(value, 'gomoku.state');
    const cells = asArray(m.b, 'board', CELL_COUNT);
    if (cells.length !== CELL_COUNT) throw new GameDecodeError('gomoku: board must have 225 cells');
    const board = cells.map((c, i) => asInt(c, `board[${i}]`, 0, 2) as Cell);
    const raw = asArray(m.p, 'players', 2);
    if (raw.length !== 2) throw new GameDecodeError('gomoku: expected exactly 2 players');
    const players = raw.map((p, i) => {
      if (typeof p !== 'string') throw new GameDecodeError(`gomoku: players[${i}] must be a string`);
      if (p.length > 256) throw new GameDecodeError(`gomoku: players[${i}] is too long`);
      return p;
    });
    let winningLine: readonly number[] | null = null;
    if (m.l !== null && m.l !== undefined) {
      const line = asArray(m.l, 'winningLine', WIN_LENGTH);
      if (line.length !== WIN_LENGTH) throw new GameDecodeError('gomoku: winningLine must have 5 cells');
      winningLine = line.map((n, i) => asInt(n, `winningLine[${i}]`, 0, CELL_COUNT - 1));
    }
    if (m.w !== null && m.w !== undefined && typeof m.w !== 'string') {
      throw new GameDecodeError('gomoku: winner must be a string or null');
    }
    return {
      board,
      players,
      turnIndex: asInt(m.t, 'turnIndex', 0, 1),
      moveCount: asInt(m.m, 'moveCount', 0, CELL_COUNT),
      // -1 is the legitimate "no stone yet" value, so the floor is -1 and not 0.
      lastMove: asInt(m.x, 'lastMove', -1, CELL_COUNT - 1),
      // A winner has to be somebody who is actually playing. A snapshot
      // arriving from a peer decides what every screen shows about the
      // result, so a name that is in no seat is refused rather than
      // rendered as the person who won.
      winner: decodeWinner(m.w, players),
      winningLine,
    };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({ ...action, payload: { c: action.payload.cell } });
  },

  decodeAction(value, player): GomokuAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'place') throw new GameDecodeError(`gomoku: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'gomoku.payload');
    return {
      type: 'place',
      player,
      seq: envelope.seq,
      payload: { cell: asInt(payload.c, 'cell', 0, CELL_COUNT - 1) },
    };
  },
};
