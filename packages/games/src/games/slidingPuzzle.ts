/**
 * Sliding Puzzle Race: two identical fifteen-puzzles, one each, first one solved
 * wins.
 *
 * Shaped like the reference game (src/games/ticTacToe.ts): an immutable state,
 * one discriminated action, a validator that assumes the peer is hostile, a pure
 * reducer, and a compact codec on both sides of the wire.
 *
 * ---------------------------------------------------------------------------
 * TWO BOARDS, ONE STATE
 * ---------------------------------------------------------------------------
 * The players never touch each other's tiles, so it is tempting to give each
 * device only its own board and send "I have finished" at the end. That design
 * has no agreed position at all: nothing on my device can check the claim, a
 * peer that says it solved a puzzle it never touched cannot be contradicted, and
 * a reconnecting player has nothing to replay. So BOTH boards live in the one
 * state, every slide is broadcast, and each device replays the opponent's moves
 * onto the opponent's board. The win is then a property of the shared position
 * rather than an announcement, and the action log still reconstructs everything.
 * It costs a few dozen bytes a move, which is nothing over Bluetooth.
 *
 * ---------------------------------------------------------------------------
 * THE SHUFFLE MUST BE SOLVABLE, AND A RANDOM PERMUTATION IS NOT
 * ---------------------------------------------------------------------------
 * Exactly half of the 16! arrangements of fifteen tiles and a gap can be slid
 * back to the solved order; the other half cannot, because every legal slide
 * swaps the gap with a neighbour - flipping the parity of the arrangement - and
 * in the same motion carries the gap one step towards or away from its home
 * corner, flipping the parity of that distance too. The sum of the two parities
 * never changes, so an arrangement whose sum differs from the solved board's is
 * out of reach for ever. Shuffling with `random.shuffle` would therefore hand
 * both players an unsolvable puzzle one game in two - and it would look
 * completely fine, because an unsolvable board is indistinguishable from a hard
 * one until you have spent ten minutes on it. This is exactly the kind of thing
 * that ships broken.
 *
 * The fix is to never construct an arrangement, only to reach one: start from
 * the solved board and walk the gap through SHUFFLE_MOVES random legal slides.
 * Whatever that reaches is solvable by construction - retrace the walk - and no
 * parity argument is needed to believe it.
 *
 * ---------------------------------------------------------------------------
 * NOBODY'S TURN
 * ---------------------------------------------------------------------------
 * It is a race: both players slide tiles whenever they like, so `currentTurn`
 * returns null and validateAction enforces no turn order. That removes the check
 * that every other turn-based game leans on for authorisation, which is why this
 * one has to say so itself: a slide names no player - `action.player` comes from
 * the authenticated session - so the validator's own membership test is the only
 * thing standing between a stranger's action and somebody's board.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Every value here is a small integer: tiles 0-15, cell indices 0-15, move
 * counts 0-400. No floating-point arithmetic happens at all. The shuffle is
 * drawn once, at creation, from the shared seed - never from `context.random`
 * inside the reducer, which would make the board depend on how many random
 * numbers earlier actions had consumed and so differ between a live session and
 * a replayed log.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  SeededGameRandom,
  VALID,
  asArray,
  asInt,
  asMap,
  asString,
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

export const GRID_SIZE = 4;
export const CELL_COUNT = GRID_SIZE * GRID_SIZE; // 16
/** The empty square, written as tile 0 so a board is a plain array of integers. */
export const GAP = 0;

/** Tiles 1-15 in reading order with the gap in the bottom-right corner. */
export const SOLVED: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0];

/**
 * Random slides applied to the solved board to make the puzzle.
 *
 * Long enough that the walk has thoroughly mixed - the fifteen-puzzle's
 * diameter is 80 moves, so 160 is twice the width of the whole graph - and
 * short enough that creating a game is instant.
 *
 * The walk actually runs for this many slides or one more, chosen from the
 * seed, because a walk of FIXED length deals only half the puzzles it looks as
 * though it deals. Every slide moves the gap to a cell of the opposite colour
 * on the board's checkerboard, so after an even number of slides the gap is
 * always back on a cell of the colour it started on: eight of the sixteen
 * cells, and with them half of the solvable arrangements, would never come up
 * at all.
 */
export const SHUFFLE_MOVES = 160;

/**
 * Slides each player may make before the race is abandoned as a draw.
 *
 * This is a stop on the reducer, not a rule anyone will meet: the hardest
 * fifteen-puzzle takes 80 moves optimally and a human fumbling through one
 * rarely passes 200. Without it a game where both players simply stop trying
 * never terminates, and random play - which solves a fifteen-puzzle roughly
 * never - would run for ever.
 */
export const MOVE_LIMIT = 400;

export interface SlidingPuzzleState {
  readonly players: readonly PlayerId[];
  /** One 16-cell board per player, same index as `players`. Row-major, 0 is the gap. */
  readonly boards: readonly (readonly number[])[];
  /** Slides made so far, by player index. */
  readonly moves: readonly number[];
}

export interface SlidingPuzzleAction extends GameAction {
  readonly type: 'slide';
  /**
   * The tile to push into the gap, 1-15. Naming the tile rather than a
   * direction means an action that arrives after the board has moved on is
   * rejected outright instead of quietly sliding whatever now sits there.
   */
  readonly payload: { readonly tile: number };
}

/** The cells orthogonally adjacent to `index`. Two, three or four of them. */
export function neighbours(index: number): number[] {
  const row = Math.floor(index / GRID_SIZE);
  const col = index - row * GRID_SIZE;
  const out: number[] = [];
  if (row > 0) out.push(index - GRID_SIZE);
  if (row < GRID_SIZE - 1) out.push(index + GRID_SIZE);
  if (col > 0) out.push(index - 1);
  if (col < GRID_SIZE - 1) out.push(index + 1);
  return out;
}

export function isSolved(board: readonly number[]): boolean {
  for (let i = 0; i < CELL_COUNT; i++) {
    if (board[i] !== SOLVED[i]) return false;
  }
  return true;
}

/**
 * Whether a board can be slid back to the solved order.
 *
 * Nothing this file produces is ever unsolvable, so this exists for one reason:
 * a board arriving from a peer through decodeState has not been walked from the
 * solved position, and handing somebody an unsolvable puzzle is a way to win a
 * race without playing it. For a grid of even width the invariant is that the
 * inversion count plus the gap's row number counted from the bottom is odd.
 */
export function isSolvable(board: readonly number[]): boolean {
  const tiles = board.filter((t) => t !== GAP);
  let inversions = 0;
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      if ((tiles[i] as number) > (tiles[j] as number)) inversions += 1;
    }
  }
  const rowFromBottom = GRID_SIZE - Math.floor(board.indexOf(GAP) / GRID_SIZE);
  return (inversions + rowFromBottom) % 2 === 1;
}

/**
 * The puzzle both players are handed, walked out of the solved position with the
 * shared seed so the two devices lay out the same board without exchanging a
 * byte about it.
 *
 * The walk never immediately undoes its last slide. A pure random walk spends a
 * lot of its time shuffling one tile back and forth and drifts away from the
 * start far more slowly; forbidding the reversal costs nothing and makes 160
 * moves worth 160 moves.
 */
export function shuffledBoard(seed: number): number[] {
  const random = new SeededGameRandom(seed);
  const board = [...SOLVED];
  let gap = board.indexOf(GAP);
  let previousGap = -1;

  const slide = (into: number): void => {
    board[gap] = board[into] as number;
    board[into] = GAP;
    previousGap = gap;
    gap = into;
  };

  // See SHUFFLE_MOVES: the length of the walk carries a parity of its own, and
  // a fixed one pins the gap to half the board.
  const length = SHUFFLE_MOVES + random.nextInt(2);
  for (let i = 0; i < length; i++) {
    const options = neighbours(gap).filter((cell) => cell !== previousGap);
    slide(options[random.nextInt(options.length)] as number);
  }

  // The walk can land back on the solved board, which would end the race before
  // it started. One more slide is enough and needs no loop: any legal slide from
  // the solved position leaves a tile out of place.
  if (isSolved(board)) {
    const options = neighbours(gap).filter((cell) => cell !== previousGap);
    slide(options[random.nextInt(options.length)] as number);
  }

  return board;
}

/** The index of the player whose board is solved, or -1 while the race is on. */
function solvedBy(state: SlidingPuzzleState): number {
  return state.boards.findIndex((board) => isSolved(board));
}

function isOver(state: SlidingPuzzleState): boolean {
  return solvedBy(state) >= 0 || state.moves.some((n) => n >= MOVE_LIMIT);
}

export const slidingPuzzle: GameDefinition<SlidingPuzzleState, SlidingPuzzleAction> = {
  id: 'sliding-puzzle',
  name: 'Sliding Puzzle Race',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): SlidingPuzzleState {
    const board = shuffledBoard(setup.seed);
    return {
      players: [...setup.players],
      boards: [[...board], [...board]],
      moves: new Array<number>(setup.players.length).fill(0),
    };
  },

  validateAction(state, action): ValidationResult {
    if (isOver(state)) return invalid('the race has already finished');
    if (action.type !== 'slide') return invalid(`unknown action "${action.type}"`);

    // No turn check: see the header. That makes this membership test the whole
    // of the game's authorisation, rather than a formality behind a turn order.
    const index = state.players.indexOf(action.player);
    if (index < 0) return invalid(`${String(action.player)} is not in this race`);

    const board = state.boards[index];
    if (!board) return invalid('that player has no board');
    if (isSolved(board)) return invalid('that board is already solved');
    if ((state.moves[index] ?? 0) >= MOVE_LIMIT) return invalid('that player is out of moves');

    const tile = action.payload?.tile;
    if (!Number.isInteger(tile) || tile < 1 || tile > CELL_COUNT - 1) return invalid('tile must be 1-15');
    const from = board.indexOf(tile);
    if (from < 0) return invalid('that tile is not on the board');
    if (!neighbours(from).includes(board.indexOf(GAP))) return invalid('that tile does not touch the gap');
    return VALID;
  },

  applyAction(state, action): SlidingPuzzleState {
    const index = state.players.indexOf(action.player);
    const current = state.boards[index];
    // validateAction refused an unknown player and an untouchable tile; this
    // guard only keeps a contract violation from writing outside a board.
    if (!current) return state;

    const board = [...current];
    const from = board.indexOf(action.payload.tile);
    const gap = board.indexOf(GAP);
    board[gap] = board[from] as number;
    board[from] = GAP;

    const boards = [...state.boards];
    boards[index] = board;
    const moves = [...state.moves];
    moves[index] = (moves[index] ?? 0) + 1;
    return { players: state.players, boards, moves };
  },

  status(state): GameStatus {
    const winnerIndex = solvedBy(state);
    if (winnerIndex >= 0) {
      const champion = state.players[winnerIndex];
      if (champion) return { kind: GameStatusKind.WON, winners: [champion], reason: 'first to solve the puzzle' };
    }
    // The race stops the moment either budget empties. Letting the survivor
    // carry on alone was the alternative, and it loses twice over: the race it
    // would then win is one the other player is no longer in, and it doubles the
    // worst case the reducer has to be able to reach the end of.
    if (state.moves.some((n) => n >= MOVE_LIMIT)) {
      return { kind: GameStatusKind.DRAW, reason: 'the move limit was reached' };
    }
    return { kind: GameStatusKind.IN_PROGRESS };
  },

  /**
   * Always null: both players may slide at any moment, so there is never a
   * single player who is "to move". A UI reading this must offer the local
   * player their board whenever `status` is still in progress rather than
   * waiting to be told it is their go.
   */
  currentTurn(): PlayerId | null {
    return null;
  },

  encodeState(state): CborValue {
    return {
      p: [...state.players],
      b: state.boards.map((board) => [...board]),
      m: [...state.moves],
    };
  },

  decodeState(value): SlidingPuzzleState {
    const m = asMap(value, 'slidingPuzzle.state');

    const rawPlayers = asArray(m.p, 'players', 2);
    if (rawPlayers.length !== 2) throw new GameDecodeError('slidingPuzzle: expected exactly 2 players');
    const players = rawPlayers.map((p, i) => asString(p, `players[${i}]`, 64));
    // One id twice is not a race. Every lookup here goes through
    // `players.indexOf`, which finds only the first of them, so the second
    // player would be told they are not in the game for the rest of the
    // session - a board that looks perfectly alive and accepts nothing.
    if (players[0] === players[1]) throw new GameDecodeError('slidingPuzzle: the two players must differ');

    const rawBoards = asArray(m.b, 'boards', 2);
    if (rawBoards.length !== 2) throw new GameDecodeError('slidingPuzzle: expected exactly 2 boards');
    const boards = rawBoards.map((raw, index) => {
      const cells = asArray(raw, `boards[${index}]`, CELL_COUNT);
      if (cells.length !== CELL_COUNT) throw new GameDecodeError(`slidingPuzzle: boards[${index}] must have 16 cells`);
      const board = cells.map((c, i) => asInt(c, `boards[${index}][${i}]`, 0, CELL_COUNT - 1));
      // A board with a tile missing or duplicated is not a fifteen-puzzle, and a
      // peer that could send one could send itself a board one slide from home.
      const seen = new Array<boolean>(CELL_COUNT).fill(false);
      for (const tile of board) {
        if (seen[tile]) throw new GameDecodeError(`slidingPuzzle: boards[${index}] repeats tile ${tile}`);
        seen[tile] = true;
      }
      if (!isSolvable(board)) throw new GameDecodeError(`slidingPuzzle: boards[${index}] cannot be solved`);
      return board;
    });

    const rawMoves = asArray(m.m, 'moves', 2);
    if (rawMoves.length !== 2) throw new GameDecodeError('slidingPuzzle: expected 2 move counts');
    const moves = rawMoves.map((n, i) => asInt(n, `moves[${i}]`, 0, MOVE_LIMIT));

    // Both boards solved is a position play cannot reach, because the first one
    // home ends the race. The winner is never carried on the wire - it is read
    // off the boards by `status` - so this is the only place a snapshot could
    // have claimed a second champion.
    if (boards.every((board) => isSolved(board))) {
      throw new GameDecodeError('slidingPuzzle: both boards cannot be solved at once');
    }

    // A solved board with no slides against it is the other unreachable
    // position, and a cheaper way to steal a race than tampering with the tiles
    // - which the checks above already refuse. The deal is never solved and
    // only a slide, which is counted, can change a board, so a board that is
    // home before its owner has moved was never played.
    for (let i = 0; i < boards.length; i++) {
      if (isSolved(boards[i] as readonly number[]) && moves[i] === 0) {
        throw new GameDecodeError(`slidingPuzzle: boards[${i}] is solved without a single slide`);
      }
    }

    return { players, boards, moves };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({ ...action, payload: { t: action.payload.tile } });
  },

  decodeAction(value, player): SlidingPuzzleAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'slide') throw new GameDecodeError(`slidingPuzzle: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'slidingPuzzle.payload');
    return {
      type: 'slide',
      player,
      seq: envelope.seq,
      payload: { tile: asInt(payload.t, 'tile', 1, CELL_COUNT - 1) },
    };
  },
};
