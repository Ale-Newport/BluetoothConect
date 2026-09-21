/**
 * Reversi (Othello). Eight by eight, bracket a line of enemy stones to flip it.
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
 * THE SKIP RULE, AND WHY IT LIVES IN THE STATE TRANSITION
 * ---------------------------------------------------------------------------
 * A player with no capturing move does not pass by sending a "pass" action -
 * they are simply skipped. That could have been modelled as an explicit action
 * the runtime asks for, but a pass carries no information: given the board,
 * both devices can see that it was forced, so making a player press a button to
 * confirm what the rules already decided would be ceremony over the link for
 * nothing. Instead applyAction advances the turn PAST any player who cannot
 * move, and `currentTurn` therefore always names somebody with a legal move, or
 * null when the game is over. The renderer reads `skipped` to say so out loud.
 *
 * The consequence to keep in mind when reading `turnIndex`: consecutive moves
 * by the same player are normal and legal here, unlike in every other
 * two-player game in this package.
 *
 * A skip is also the one thing about this game that a board does not remember.
 * See `skipped` and `encodeState`.
 *
 * ---------------------------------------------------------------------------
 * TERMINATION
 * ---------------------------------------------------------------------------
 * No round limit is needed, and none is imposed. Every legal move fills one
 * empty square and no move ever empties one, so play cannot run longer than the
 * 60 squares the opening leaves free; the game ends earlier the moment neither
 * player can capture. Random play therefore always reaches a terminal status,
 * which is what the conformance suite insists on.
 *
 * FLOATING POINT: nothing here is a real number. Cells are 0/1/2, indices are
 * 0-63 and the scores are 0-64, so there is nothing to round and no way for two
 * devices to disagree about arithmetic.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  VALID,
  asArray,
  asBool,
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

/** 0 = empty, 1 = the first player (dark, moves first), 2 = the second (light). */
export type Cell = 0 | 1 | 2;

export const SIZE = 8;
export const CELL_COUNT = SIZE * SIZE; // 64

export interface ReversiState {
  /** 64 cells, row-major, index = row * 8 + col. */
  readonly board: readonly Cell[];
  readonly players: readonly PlayerId[];
  /** The player to move. Already advanced past anyone who cannot move. */
  readonly turnIndex: number;
  /** Stones on the board, in player order. Both are derived from `board`. */
  readonly scores: readonly [number, number];
  readonly moveCount: number;
  readonly over: boolean;
  /**
   * True when the move just played did NOT change hands, because the player
   * who should have replied had no capture and was passed over.
   *
   * This is history, not geometry. A player with nothing to play in the current
   * position has not necessarily been skipped - far more often they are simply
   * waiting, and the move about to be made will open a square for them. So the
   * board cannot be asked; the flag has to travel. See `encodeState`.
   */
  readonly skipped: boolean;
}

export interface ReversiAction extends GameAction {
  readonly type: 'play';
  readonly payload: { readonly cell: number };
}

/** [dRow, dCol] for the eight rays a bracket may run along. */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

function at(row: number, col: number): number {
  return row * SIZE + col;
}

function opponentOf(mark: 1 | 2): 1 | 2 {
  return mark === 1 ? 2 : 1;
}

/**
 * Every stone playing `mark` at `index` would flip, in a fixed ray order so
 * both devices produce the same array and any future animation matches.
 *
 * Empty when the move is illegal, which is exactly the test validateAction
 * needs: a Reversi move is legal precisely when it captures something.
 */
export function capturesFor(board: readonly Cell[], index: number, mark: 1 | 2): number[] {
  if (board[index] !== 0) return [];
  const row = Math.floor(index / SIZE);
  const col = index - row * SIZE;
  const enemy = opponentOf(mark);
  const flipped: number[] = [];

  for (const dir of DIRECTIONS) {
    const dr = dir[0];
    const dc = dir[1];
    const run: number[] = [];
    let r = row + dr;
    let c = col + dc;
    // Walk over a solid run of enemy stones; the ray only counts if it is then
    // closed by one of our own. Running off the board closes nothing.
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[at(r, c)] === enemy) {
      run.push(at(r, c));
      r += dr;
      c += dc;
    }
    if (run.length === 0) continue;
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
    if (board[at(r, c)] !== mark) continue;
    for (const cell of run) flipped.push(cell);
  }
  return flipped;
}

function legalMovesForMark(board: readonly Cell[], mark: 1 | 2): number[] {
  const moves: number[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (board[i] !== 0) continue;
    if (capturesFor(board, i, mark).length > 0) moves.push(i);
  }
  return moves;
}

/**
 * The cells `player` may play right now, ascending.
 *
 * Exported because the board is unplayable for a beginner without the legal
 * moves marked on it, and because a renderer that worked them out for itself
 * would be a second, drifting copy of the rules. Returns empty for a player who
 * is not in this game rather than throwing: the caller is a view, and a view
 * asking about a stranger should draw nothing, not crash.
 */
export function legalMovesFor(state: ReversiState, player: PlayerId): number[] {
  const index = state.players.indexOf(player);
  if (index < 0 || state.over) return [];
  return legalMovesForMark(state.board, index === 0 ? 1 : 2);
}

function countStones(board: readonly Cell[]): [number, number] {
  let dark = 0;
  let light = 0;
  for (const cell of board) {
    if (cell === 1) dark += 1;
    else if (cell === 2) light += 1;
  }
  return [dark, light];
}

export const reversi: GameDefinition<ReversiState, ReversiAction> = {
  id: 'reversi',
  name: 'Reversi',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): ReversiState {
    const board = new Array<Cell>(CELL_COUNT).fill(0);
    // The standard opening: a two-by-two block in the middle with each colour
    // on one of its diagonals. Every Reversi game starts here, and it is what
    // gives dark four captures on move one, so the opening is never a skip.
    board[at(3, 3)] = 2;
    board[at(3, 4)] = 1;
    board[at(4, 3)] = 1;
    board[at(4, 4)] = 2;
    return {
      board,
      players: [...setup.players],
      turnIndex: 0,
      scores: [2, 2],
      moveCount: 0,
      over: false,
      skipped: false,
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.over) return invalid('the game has already finished');
    if (action.type !== 'play') return invalid(`unknown action "${action.type}"`);
    const expected = state.players[state.turnIndex];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);
    const cell = action.payload?.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell > CELL_COUNT - 1) return invalid('cell must be 0-63');
    if (state.board[cell] !== 0) return invalid('that square is already taken');
    const mark: 1 | 2 = state.turnIndex === 0 ? 1 : 2;
    if (capturesFor(state.board, cell, mark).length === 0) return invalid('that move captures nothing');
    return VALID;
  },

  applyAction(state, action): ReversiState {
    const mark: 1 | 2 = state.turnIndex === 0 ? 1 : 2;
    const cell = action.payload.cell;
    const flipped = capturesFor(state.board, cell, mark);
    // validateAction already refused a capture-free move; this guard only stops
    // a contract violation from placing a stone that flips nothing.
    if (flipped.length === 0) return state;

    const board = [...state.board];
    board[cell] = mark;
    for (const i of flipped) board[i] = mark;

    // Who is to move now? The opponent if they can capture, otherwise us again
    // if we can, otherwise nobody and the game is over.
    const next = (state.turnIndex + 1) % state.players.length;
    const nextMark: 1 | 2 = next === 0 ? 1 : 2;
    const opponentCanMove = legalMovesForMark(board, nextMark).length > 0;
    const moverCanMove = opponentCanMove ? false : legalMovesForMark(board, mark).length > 0;

    return {
      board,
      players: state.players,
      turnIndex: opponentCanMove ? next : state.turnIndex,
      scores: countStones(board),
      moveCount: state.moveCount + 1,
      over: !opponentCanMove && !moverCanMove,
      skipped: !opponentCanMove && moverCanMove,
    };
  },

  status(state): GameStatus {
    if (!state.over) return { kind: GameStatusKind.IN_PROGRESS };
    const [dark, light] = state.scores;
    if (dark === light) return { kind: GameStatusKind.DRAW, reason: `${dark} stones each` };
    const winner = state.players[dark > light ? 0 : 1];
    if (winner === undefined) return { kind: GameStatusKind.DRAW, reason: 'no such player' };
    return {
      kind: GameStatusKind.WON,
      winners: [winner],
      reason: `${Math.max(dark, light)}-${Math.min(dark, light)}`,
    };
  },

  currentTurn(state): PlayerId | null {
    if (state.over) return null;
    return state.players[state.turnIndex] ?? null;
  },

  encodeState(state): CborValue {
    // `scores` and `over` are functions of the board and the turn, and
    // decodeState recomputes them below. Sending them would spend bytes of a
    // 185-byte MTU on numbers that can only ever agree with the board - or, if
    // a peer tampers with them, disagree with it and have to be discarded.
    //
    // `skipped` is not such a function, and so it earns its two bytes. It says
    // what happened on the way to this position - that the other player was
    // passed over - and no amount of staring at the board recovers that. The
    // tempting derivation, "the player not to move has no capture", is a
    // different claim about a different ply: late in a game the side that has
    // just moved is very often stuck until the reply opens a square for them,
    // and reading that as a skip would announce a pass that never happened.
    return {
      b: [...state.board],
      p: [...state.players],
      t: state.turnIndex,
      m: state.moveCount,
      k: state.skipped,
    };
  },

  decodeState(value): ReversiState {
    const m = asMap(value, 'reversi.state');
    const cells = asArray(m.b, 'board', CELL_COUNT);
    if (cells.length !== CELL_COUNT) throw new GameDecodeError('reversi: board must have 64 cells');
    const board = cells.map((c, i) => asInt(c, `board[${i}]`, 0, 2) as Cell);
    const raw = asArray(m.p, 'players', 2);
    if (raw.length !== 2) throw new GameDecodeError('reversi: expected exactly 2 players');
    const players = raw.map((p, i) => {
      if (typeof p !== 'string') throw new GameDecodeError(`reversi: players[${i}] must be a string`);
      if (p.length > 256) throw new GameDecodeError(`reversi: players[${i}] is too long`);
      return p;
    });
    const turnIndex = asInt(m.t, 'turnIndex', 0, 1);
    const skipped = asBool(m.k, 'skipped');

    const mark: 1 | 2 = turnIndex === 0 ? 1 : 2;
    const moverCanMove = legalMovesForMark(board, mark).length > 0;
    const opponentCanMove = legalMovesForMark(board, opponentOf(mark)).length > 0;
    // A board where the named player cannot move but their opponent can is one
    // this reducer could never have produced - applyAction always hands the
    // turn to somebody who can play. Rejecting it here keeps a malformed
    // snapshot from putting a device into a position it cannot leave.
    if (!moverCanMove && opponentCanMove) throw new GameDecodeError('reversi: the named player cannot move');
    // A claimed skip that the board contradicts is refused for the same reason.
    // The flag cannot be derived, but it can be checked: a pass only happens
    // when the player not to move has no capture and the game goes on, so
    // anything else is a peer telling us a story about a ply it invented.
    if (skipped && (opponentCanMove || !moverCanMove)) {
      throw new GameDecodeError('reversi: nobody could have been skipped here');
    }

    return {
      board,
      players,
      turnIndex,
      scores: countStones(board),
      moveCount: asInt(m.m, 'moveCount', 0, CELL_COUNT),
      over: !moverCanMove && !opponentCanMove,
      skipped,
    };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({ ...action, payload: { c: action.payload.cell } });
  },

  decodeAction(value, player): ReversiAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'play') throw new GameDecodeError(`reversi: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'reversi.payload');
    return {
      type: 'play',
      player,
      seq: envelope.seq,
      payload: { cell: asInt(payload.c, 'cell', 0, CELL_COUNT - 1) },
    };
  },
};
