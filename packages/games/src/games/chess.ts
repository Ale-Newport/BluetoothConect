/**
 * Chess - the full FIDE rules over the AirLink turn-based contract.
 *
 * Four design notes that matter for a serverless, two-device game:
 *
 *  DETERMINISM / FLOATING POINT. Every value in the state is an integer: the
 *  board is 64 small ints (0 empty, 1-6 white, 7-12 black), castling rights are
 *  a 4-bit mask, and the repetition fingerprint is a 32-bit FNV-1a hash built
 *  with Math.imul. There is no floating-point arithmetic anywhere in the
 *  reducer, so there is nothing to round and nothing that can drift apart
 *  between two devices - the usual realtime hazard simply does not exist here.
 *
 *  AUTOMATIC DRAWS. The fifty-move rule and threefold repetition are applied
 *  automatically instead of on a claim. Two phones have no arbiter to hear a
 *  claim, and making them automatic also guarantees that every game terminates.
 *
 *  DERIVED RESULT. `state.result` caches "is this position terminal", computed
 *  once when a state is built (checkmate/stalemate need a legal-move search, and
 *  we do not want that on every status() call). It is deliberately NOT part of
 *  the wire encoding: decodeState recomputes it from the position, so a hostile
 *  peer cannot assert a win it did not earn.
 *
 *  REPETITION HISTORY. Only positions since the last irreversible move (a
 *  capture or a pawn move) can repeat, and the fifty-move rule bounds that
 *  window at 101 positions, so the stored history is small and self-trimming.
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

// ---------------------------------------------------------------------------
// Board vocabulary
// ---------------------------------------------------------------------------

/** 0 = white (moves first, players[0]), 1 = black. */
export type Color = 0 | 1;

/** Board codes. Index 0 is a1, index 63 is h8: rank = i >> 3, file = i & 7. */
export const Piece = {
  EMPTY: 0,
  WP: 1,
  WN: 2,
  WB: 3,
  WR: 4,
  WQ: 5,
  WK: 6,
  BP: 7,
  BN: 8,
  BB: 9,
  BR: 10,
  BQ: 11,
  BK: 12,
} as const;

const EMPTY = 0;
const PAWN = 1;
const KNIGHT = 2;
const BISHOP = 3;
const ROOK = 4;
const QUEEN = 5;
const KING = 6;

/** Castling-right bits. */
const WHITE_KING_SIDE = 1;
const WHITE_QUEEN_SIDE = 2;
const BLACK_KING_SIDE = 4;
const BLACK_QUEEN_SIDE = 8;
const ALL_CASTLING = 15;

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

const PROMOTION_ORDER: readonly PromotionPiece[] = ['q', 'r', 'b', 'n'];

function promotionType(p: PromotionPiece): number {
  switch (p) {
    case 'q':
      return QUEEN;
    case 'r':
      return ROOK;
    case 'b':
      return BISHOP;
    default:
      return KNIGHT;
  }
}

function at(board: readonly number[], index: number): number {
  return board[index] as number;
}

function colorOf(piece: number): Color | -1 {
  if (piece === EMPTY) return -1;
  return piece <= 6 ? 0 : 1;
}

function typeOf(piece: number): number {
  if (piece === EMPTY) return 0;
  return piece <= 6 ? piece : piece - 6;
}

function makePiece(color: Color, type: number): number {
  return color === 0 ? type : type + 6;
}

function opposite(color: Color): Color {
  return color === 0 ? 1 : 0;
}

/** Light/dark square, used by the insufficient-material rule. */
function squareShade(index: number): number {
  return ((index >> 3) + (index & 7)) & 1;
}

/** "e4" -> 28. Throws on anything that is not a square name. */
export function squareIndex(name: string): number {
  if (name.length !== 2) throw new GameDecodeError(`chess: bad square "${name}"`);
  const file = name.charCodeAt(0) - 97; // 'a'
  const rank = name.charCodeAt(1) - 49; // '1'
  if (file < 0 || file > 7 || rank < 0 || rank > 7) throw new GameDecodeError(`chess: bad square "${name}"`);
  return rank * 8 + file;
}

/** 28 -> "e4". */
export function squareName(index: number): string {
  return `${String.fromCharCode(97 + (index & 7))}${String.fromCharCode(49 + (index >> 3))}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type ChessOutcome =
  | { readonly kind: 'inProgress' }
  | { readonly kind: 'checkmate'; readonly winner: Color }
  | { readonly kind: 'stalemate' }
  | { readonly kind: 'fiftyMove' }
  | { readonly kind: 'threefold' }
  | { readonly kind: 'insufficientMaterial' };

/** Everything a move generator needs; ChessState is a superset of it. */
export interface Position {
  readonly board: readonly number[];
  readonly turn: Color;
  /** Bit mask: 1 white O-O, 2 white O-O-O, 4 black O-O, 8 black O-O-O. */
  readonly castling: number;
  /** Square a pawn may be captured on this move, or -1. */
  readonly epTarget: number;
}

export interface ChessState extends Position {
  readonly players: readonly PlayerId[];
  /** Plies since the last capture or pawn move. 100 is the fifty-move draw. */
  readonly halfmove: number;
  readonly fullmove: number;
  /** Position hashes since the last irreversible move, current position last. */
  readonly history: readonly number[];
  /** Derived, never transmitted: recomputed by decodeState. */
  readonly result: ChessOutcome;
}

export interface ChessMove {
  readonly from: number;
  readonly to: number;
  /** Present only on moves that promote. */
  readonly promotion?: PromotionPiece;
}

export interface ChessAction extends GameAction {
  readonly type: 'move';
  readonly payload: { readonly from: number; readonly to: number; readonly promotion?: PromotionPiece };
}

const INITIAL_BACK_RANK: readonly number[] = [ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK];

function initialBoard(): number[] {
  const board = new Array<number>(64).fill(EMPTY);
  for (let file = 0; file < 8; file++) {
    board[file] = makePiece(0, INITIAL_BACK_RANK[file] as number);
    board[8 + file] = makePiece(0, PAWN);
    board[48 + file] = makePiece(1, PAWN);
    board[56 + file] = makePiece(1, INITIAL_BACK_RANK[file] as number);
  }
  return board;
}

/**
 * FNV-1a over the position. Math.imul keeps this exact 32-bit integer
 * arithmetic on every JavaScript engine - a plain `*` would lose precision and
 * the two devices would disagree about repetitions.
 */
function positionHash(board: readonly number[], turn: Color, castling: number, epTarget: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < 64; i++) {
    h = Math.imul(h ^ at(board, i), 0x01000193) >>> 0;
  }
  h = Math.imul(h ^ turn, 0x01000193) >>> 0;
  h = Math.imul(h ^ castling, 0x01000193) >>> 0;
  h = Math.imul(h ^ (epTarget + 1), 0x01000193) >>> 0;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Attacks and move generation
// ---------------------------------------------------------------------------

const KNIGHT_DELTAS: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];
const BISHOP_DIRS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const ROOK_DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const KING_DIRS: readonly (readonly [number, number])[] = [...BISHOP_DIRS, ...ROOK_DIRS];

export function findKing(board: readonly number[], color: Color): number {
  const king = makePiece(color, KING);
  for (let i = 0; i < 64; i++) if (at(board, i) === king) return i;
  return -1;
}

/** Is `target` attacked by any piece of colour `by`? */
export function isAttacked(board: readonly number[], target: number, by: Color): boolean {
  const tf = target & 7;
  const tr = target >> 3;

  // Pawns: a white pawn attacks upward, so it must sit one rank below.
  const pawnRank = by === 0 ? tr - 1 : tr + 1;
  if (pawnRank >= 0 && pawnRank <= 7) {
    const pawn = makePiece(by, PAWN);
    if (tf > 0 && at(board, pawnRank * 8 + tf - 1) === pawn) return true;
    if (tf < 7 && at(board, pawnRank * 8 + tf + 1) === pawn) return true;
  }

  const knight = makePiece(by, KNIGHT);
  for (const [df, dr] of KNIGHT_DELTAS) {
    const f = tf + df;
    const r = tr + dr;
    if (f < 0 || f > 7 || r < 0 || r > 7) continue;
    if (at(board, r * 8 + f) === knight) return true;
  }

  const king = makePiece(by, KING);
  for (const [df, dr] of KING_DIRS) {
    const f = tf + df;
    const r = tr + dr;
    if (f < 0 || f > 7 || r < 0 || r > 7) continue;
    if (at(board, r * 8 + f) === king) return true;
  }

  const bishop = makePiece(by, BISHOP);
  const rook = makePiece(by, ROOK);
  const queen = makePiece(by, QUEEN);
  for (const [df, dr] of BISHOP_DIRS) {
    let f = tf + df;
    let r = tr + dr;
    while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
      const piece = at(board, r * 8 + f);
      if (piece !== EMPTY) {
        if (piece === bishop || piece === queen) return true;
        break;
      }
      f += df;
      r += dr;
    }
  }
  for (const [df, dr] of ROOK_DIRS) {
    let f = tf + df;
    let r = tr + dr;
    while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
      const piece = at(board, r * 8 + f);
      if (piece !== EMPTY) {
        if (piece === rook || piece === queen) return true;
        break;
      }
      f += df;
      r += dr;
    }
  }
  return false;
}

export function isInCheck(position: Position, color: Color): boolean {
  const king = findKing(position.board, color);
  return king >= 0 && isAttacked(position.board, king, opposite(color));
}

function pushSliding(
  out: ChessMove[],
  board: readonly number[],
  from: number,
  dirs: readonly (readonly [number, number])[],
  us: Color,
  singleStep: boolean,
): void {
  const f0 = from & 7;
  const r0 = from >> 3;
  for (const [df, dr] of dirs) {
    let f = f0 + df;
    let r = r0 + dr;
    while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
      const to = r * 8 + f;
      const occupant = at(board, to);
      if (occupant === EMPTY) {
        out.push({ from, to });
      } else {
        if (colorOf(occupant) !== us) out.push({ from, to });
        break;
      }
      if (singleStep) break;
      f += df;
      r += dr;
    }
  }
}

function pushPawn(out: ChessMove[], from: number, to: number, promotes: boolean): void {
  if (promotes) {
    for (const promotion of PROMOTION_ORDER) out.push({ from, to, promotion });
  } else {
    out.push({ from, to });
  }
}

/**
 * Pseudo-legal moves: everything the piece rules allow, before checking whether
 * the mover leaves their own king en prise. Castling is fully checked here
 * (through-check included) because the king's path is not covered by the
 * leaves-king-in-check filter.
 */
function pseudoMoves(position: Position, fromFilter: number): ChessMove[] {
  const out: ChessMove[] = [];
  const board = position.board;
  const us = position.turn;
  const them = opposite(us);

  let checkComputed = false;
  let checkCached = false;
  const inCheckNow = (): boolean => {
    if (!checkComputed) {
      checkCached = isInCheck(position, us);
      checkComputed = true;
    }
    return checkCached;
  };

  for (let from = 0; from < 64; from++) {
    if (fromFilter >= 0 && from !== fromFilter) continue;
    const piece = at(board, from);
    if (piece === EMPTY || colorOf(piece) !== us) continue;
    const file = from & 7;
    const rank = from >> 3;

    switch (typeOf(piece)) {
      case PAWN: {
        const dir = us === 0 ? 1 : -1;
        const startRank = us === 0 ? 1 : 6;
        const promoRank = us === 0 ? 7 : 0;
        const nextRank = rank + dir;
        if (nextRank < 0 || nextRank > 7) break; // decodeState forbids pawns on the back ranks
        const ahead = nextRank * 8 + file;
        if (at(board, ahead) === EMPTY) {
          pushPawn(out, from, ahead, nextRank === promoRank);
          if (rank === startRank) {
            const twoAhead = (rank + 2 * dir) * 8 + file;
            if (at(board, twoAhead) === EMPTY) out.push({ from, to: twoAhead });
          }
        }
        for (const df of [-1, 1]) {
          const cf = file + df;
          if (cf < 0 || cf > 7) continue;
          const to = nextRank * 8 + cf;
          const victim = at(board, to);
          if (victim !== EMPTY) {
            if (colorOf(victim) === them) pushPawn(out, from, to, nextRank === promoRank);
          } else if (to === position.epTarget) {
            out.push({ from, to });
          }
        }
        break;
      }
      case KNIGHT: {
        for (const [df, dr] of KNIGHT_DELTAS) {
          const f = file + df;
          const r = rank + dr;
          if (f < 0 || f > 7 || r < 0 || r > 7) continue;
          const to = r * 8 + f;
          const occupant = at(board, to);
          if (occupant === EMPTY || colorOf(occupant) !== us) out.push({ from, to });
        }
        break;
      }
      case BISHOP:
        pushSliding(out, board, from, BISHOP_DIRS, us, false);
        break;
      case ROOK:
        pushSliding(out, board, from, ROOK_DIRS, us, false);
        break;
      case QUEEN:
        pushSliding(out, board, from, KING_DIRS, us, false);
        break;
      case KING: {
        pushSliding(out, board, from, KING_DIRS, us, true);
        const home = us === 0 ? 4 : 60;
        if (from !== home) break;
        const rookPiece = makePiece(us, ROOK);
        const kingSideBit = us === 0 ? WHITE_KING_SIDE : BLACK_KING_SIDE;
        const queenSideBit = us === 0 ? WHITE_QUEEN_SIDE : BLACK_QUEEN_SIDE;
        const base = us === 0 ? 0 : 56;
        if ((position.castling & kingSideBit) !== 0 && at(board, base + 7) === rookPiece) {
          if (
            at(board, base + 5) === EMPTY &&
            at(board, base + 6) === EMPTY &&
            !inCheckNow() &&
            !isAttacked(board, base + 5, them) &&
            !isAttacked(board, base + 6, them)
          ) {
            out.push({ from, to: base + 6 });
          }
        }
        if ((position.castling & queenSideBit) !== 0 && at(board, base + 0) === rookPiece) {
          if (
            at(board, base + 1) === EMPTY &&
            at(board, base + 2) === EMPTY &&
            at(board, base + 3) === EMPTY &&
            !inCheckNow() &&
            !isAttacked(board, base + 3, them) &&
            !isAttacked(board, base + 2, them)
          ) {
            out.push({ from, to: base + 2 });
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * The board after `move`, handling the three moves that touch a square other
 * than `from`/`to`: en passant removes the passed pawn, castling drags the
 * rook, promotion replaces the pawn.
 */
function applyMoveToBoard(board: readonly number[], move: ChessMove): number[] {
  const next = [...board];
  const piece = at(board, move.from);
  const type = typeOf(piece);
  const color = colorOf(piece) as Color;
  const fromFile = move.from & 7;
  const toFile = move.to & 7;

  next[move.from] = EMPTY;

  if (type === PAWN && fromFile !== toFile && at(board, move.to) === EMPTY) {
    // En passant: the captured pawn stands beside the mover, not on `to`.
    next[(move.from >> 3) * 8 + toFile] = EMPTY;
  }

  if (type === KING && (toFile - fromFile === 2 || fromFile - toFile === 2)) {
    const base = (move.from >> 3) * 8;
    if (toFile === 6) {
      next[base + 5] = at(board, base + 7);
      next[base + 7] = EMPTY;
    } else {
      next[base + 3] = at(board, base + 0);
      next[base + 0] = EMPTY;
    }
  }

  const promoRank = color === 0 ? 7 : 0;
  next[move.to] =
    type === PAWN && move.to >> 3 === promoRank ? makePiece(color, promotionType(move.promotion ?? 'q')) : piece;
  return next;
}

function leavesKingSafe(position: Position, move: ChessMove): boolean {
  const board = applyMoveToBoard(position.board, move);
  const king = findKing(board, position.turn);
  return king < 0 || !isAttacked(board, king, opposite(position.turn));
}

function generate(position: Position, fromFilter: number, stopAtFirst: boolean): ChessMove[] {
  const legal: ChessMove[] = [];
  for (const move of pseudoMoves(position, fromFilter)) {
    if (!leavesKingSafe(position, move)) continue;
    legal.push(move);
    if (stopAtFirst) break;
  }
  return legal;
}

/**
 * Every legal move for the side to move, in a deterministic order (by origin
 * square, then by the fixed direction tables above). Exported because the UI,
 * the conformance driver and validateAction all need exactly this.
 */
export function legalMoves(state: Position): ChessMove[] {
  return generate(state, -1, false);
}

/** Legal moves for one piece. Cheaper than filtering `legalMoves`. */
export function legalMovesFrom(state: Position, from: number): ChessMove[] {
  if (!Number.isInteger(from) || from < 0 || from > 63) return [];
  return generate(state, from, false);
}

function hasAnyLegalMove(position: Position): boolean {
  return generate(position, -1, true).length > 0;
}

// ---------------------------------------------------------------------------
// Terminal conditions
// ---------------------------------------------------------------------------

/** K vs K, K+B vs K, K+N vs K, and K+B vs K+B with bishops of one shade. */
export function isInsufficientMaterial(board: readonly number[]): boolean {
  let whiteKnights = 0;
  let blackKnights = 0;
  const whiteBishops: number[] = [];
  const blackBishops: number[] = [];
  for (let i = 0; i < 64; i++) {
    const piece = at(board, i);
    if (piece === EMPTY) continue;
    const type = typeOf(piece);
    if (type === KING) continue;
    if (type === PAWN || type === ROOK || type === QUEEN) return false;
    const white = colorOf(piece) === 0;
    if (type === KNIGHT) {
      if (white) whiteKnights++;
      else blackKnights++;
    } else {
      if (white) whiteBishops.push(squareShade(i));
      else blackBishops.push(squareShade(i));
    }
  }
  const white = whiteKnights + whiteBishops.length;
  const black = blackKnights + blackBishops.length;
  if (white === 0 && black === 0) return true;
  if (white + black === 1) return true;
  if (whiteKnights === 0 && blackKnights === 0 && whiteBishops.length === 1 && blackBishops.length === 1) {
    return whiteBishops[0] === blackBishops[0];
  }
  return false;
}

function repetitionCount(history: readonly number[]): number {
  if (history.length === 0) return 0;
  const current = history[history.length - 1];
  let count = 0;
  for (const h of history) if (h === current) count++;
  return count;
}

/**
 * Classify a freshly built position. Mate and stalemate come first: a
 * checkmate delivered on the hundredth halfmove is a win, not a draw.
 */
function evaluate(position: Position, halfmove: number, history: readonly number[]): ChessOutcome {
  if (!hasAnyLegalMove(position)) {
    return isInCheck(position, position.turn)
      ? { kind: 'checkmate', winner: opposite(position.turn) }
      : { kind: 'stalemate' };
  }
  if (isInsufficientMaterial(position.board)) return { kind: 'insufficientMaterial' };
  if (halfmove >= 100) return { kind: 'fiftyMove' };
  if (repetitionCount(history) >= 3) return { kind: 'threefold' };
  return { kind: 'inProgress' };
}

interface StateCore {
  readonly board: readonly number[];
  readonly turn: Color;
  readonly castling: number;
  readonly epTarget: number;
  readonly players: readonly PlayerId[];
  readonly halfmove: number;
  readonly fullmove: number;
  readonly history: readonly number[];
}

function withResult(core: StateCore): ChessState {
  return { ...core, result: evaluate(core, core.halfmove, core.history) };
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

function applyMove(state: ChessState, move: ChessMove): ChessState {
  const board = applyMoveToBoard(state.board, move);
  const piece = at(state.board, move.from);
  const type = typeOf(piece);
  const us = state.turn;
  const fromFile = move.from & 7;
  const toFile = move.to & 7;
  const captured = at(state.board, move.to) !== EMPTY || (type === PAWN && fromFile !== toFile);

  let castling = state.castling;
  if (type === KING) castling &= us === 0 ? ~(WHITE_KING_SIDE | WHITE_QUEEN_SIDE) : ~(BLACK_KING_SIDE | BLACK_QUEEN_SIDE);
  // A rook leaving or being captured on its home square kills that right.
  if (move.from === 0 || move.to === 0) castling &= ~WHITE_QUEEN_SIDE;
  if (move.from === 7 || move.to === 7) castling &= ~WHITE_KING_SIDE;
  if (move.from === 56 || move.to === 56) castling &= ~BLACK_QUEEN_SIDE;
  if (move.from === 63 || move.to === 63) castling &= ~BLACK_KING_SIDE;
  castling &= ALL_CASTLING;

  const rankDelta = (move.to >> 3) - (move.from >> 3);
  const epTarget = type === PAWN && (rankDelta === 2 || rankDelta === -2) ? (move.from + move.to) >> 1 : -1;

  const halfmove = type === PAWN || captured ? 0 : state.halfmove + 1;
  const turn = opposite(us);
  const hash = positionHash(board, turn, castling, epTarget);

  return withResult({
    board,
    turn,
    castling,
    epTarget,
    players: state.players,
    halfmove,
    fullmove: us === 1 ? state.fullmove + 1 : state.fullmove,
    // An irreversible move makes every earlier position unreachable, so the
    // repetition window restarts at the new position.
    history: halfmove === 0 ? [hash] : [...state.history, hash],
  });
}

function decodePromotion(value: CborValue | undefined): PromotionPiece | undefined {
  if (value === undefined) return undefined;
  const text = asString(value, 'chess.promotion', 1);
  if (text !== 'q' && text !== 'r' && text !== 'b' && text !== 'n') {
    throw new GameDecodeError('chess.promotion: expected one of q, r, b, n');
  }
  return text;
}

export const chess: GameDefinition<ChessState, ChessAction> = {
  id: 'chess',
  name: 'Chess',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): ChessState {
    const board = initialBoard();
    return withResult({
      board,
      turn: 0,
      castling: ALL_CASTLING,
      epTarget: -1,
      players: [...setup.players],
      halfmove: 0,
      fullmove: 1,
      history: [positionHash(board, 0, ALL_CASTLING, -1)],
    });
  },

  validateAction(state, action): ValidationResult {
    if (state.result.kind !== 'inProgress') return invalid('the game has already finished');
    if (action.type !== 'move') return invalid(`unknown action "${action.type}"`);
    const expected = state.players[state.turn];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);

    // decodeAction has already bounded these, but validateAction is a public
    // entry point: re-check rather than trust a caller that skipped the decoder.
    const payload = action.payload as Partial<ChessAction['payload']> | null | undefined;
    if (payload === null || typeof payload !== 'object') return invalid('a move needs a from and a to square');
    const from = payload.from;
    const to = payload.to;
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 0 || from > 63) {
      return invalid('from must be a square 0-63');
    }
    if (typeof to !== 'number' || !Number.isInteger(to) || to < 0 || to > 63) {
      return invalid('to must be a square 0-63');
    }

    const piece = at(state.board, from);
    if (piece === EMPTY) return invalid('there is no piece on that square');
    if (colorOf(piece) !== state.turn) return invalid('that piece belongs to your opponent');

    const candidates = generate(state, from, false).filter((m) => m.to === to);
    if (candidates.length === 0) return invalid('that move is not legal');

    const promotes = (candidates[0] as ChessMove).promotion !== undefined;
    if (promotes) {
      const wanted = payload.promotion ?? 'q';
      if (!candidates.some((m) => m.promotion === wanted)) return invalid('that promotion piece is not allowed');
    } else if (payload.promotion !== undefined) {
      return invalid('promotion piece given for a move that does not promote');
    }
    return VALID;
  },

  applyAction(state, action): ChessState {
    const { from, to } = action.payload;
    const piece = at(state.board, from);
    const promoRank = state.turn === 0 ? 7 : 0;
    const promotes = typeOf(piece) === PAWN && to >> 3 === promoRank;
    // The action may omit the promotion piece; a queen is the standard default.
    const move: ChessMove = promotes ? { from, to, promotion: action.payload.promotion ?? 'q' } : { from, to };
    return applyMove(state, move);
  },

  status(state): GameStatus {
    const result = state.result;
    switch (result.kind) {
      case 'checkmate':
        return {
          kind: GameStatusKind.WON,
          winners: [state.players[result.winner] as PlayerId],
          reason: 'checkmate',
        };
      case 'stalemate':
        return { kind: GameStatusKind.DRAW, reason: 'stalemate' };
      case 'fiftyMove':
        return { kind: GameStatusKind.DRAW, reason: 'fifty-move rule' };
      case 'threefold':
        return { kind: GameStatusKind.DRAW, reason: 'threefold repetition' };
      case 'insufficientMaterial':
        return { kind: GameStatusKind.DRAW, reason: 'insufficient material' };
      default:
        return { kind: GameStatusKind.IN_PROGRESS };
    }
  },

  currentTurn(state): PlayerId | null {
    if (state.result.kind !== 'inProgress') return null;
    return state.players[state.turn] ?? null;
  },

  encodeState(state): CborValue {
    return {
      b: [...state.board],
      t: state.turn,
      c: state.castling,
      e: state.epTarget,
      h: state.halfmove,
      f: state.fullmove,
      p: [...state.players],
      r: [...state.history],
    };
  },

  decodeState(value): ChessState {
    const m = asMap(value, 'chess.state');

    const raw = asArray(m.b, 'chess.board', 64);
    if (raw.length !== 64) throw new GameDecodeError('chess.board: expected 64 squares');
    const board = raw.map((cell, i) => asInt(cell, `chess.board[${i}]`, 0, 12));

    let whiteKings = 0;
    let blackKings = 0;
    for (let i = 0; i < 64; i++) {
      const piece = at(board, i);
      if (piece === Piece.WK) whiteKings++;
      if (piece === Piece.BK) blackKings++;
      if (typeOf(piece) === PAWN && (i < 8 || i >= 56)) {
        throw new GameDecodeError('chess.board: a pawn cannot stand on the first or last rank');
      }
    }
    if (whiteKings !== 1 || blackKings !== 1) {
      throw new GameDecodeError('chess.board: each side needs exactly one king');
    }

    const turn = asInt(m.t, 'chess.turn', 0, 1) as Color;
    const castling = asInt(m.c, 'chess.castling', 0, ALL_CASTLING);

    const epTarget = asInt(m.e, 'chess.epTarget', -1, 63);
    if (epTarget !== -1) {
      // The target sits behind the pawn that just double-pushed, so its rank is
      // fixed by whose turn it now is.
      const lo = turn === 0 ? 40 : 16;
      if (epTarget < lo || epTarget > lo + 7) throw new GameDecodeError('chess.epTarget: impossible square');
    }

    const halfmove = asInt(m.h, 'chess.halfmove', 0, 1024);
    const fullmove = asInt(m.f, 'chess.fullmove', 1, 100000);

    const players = asArray(m.p, 'chess.players', 2).map((p, i) => asString(p, `chess.players[${i}]`, 64));
    if (players.length !== 2) throw new GameDecodeError('chess.players: expected exactly two players');

    const position: Position = { board, turn, castling, epTarget };
    // A position where the side that just moved can be captured is not reachable
    // by any legal game, and would let the mover take a king.
    if (isInCheck(position, opposite(turn))) {
      throw new GameDecodeError('chess.state: the side not to move is in check');
    }

    const hash = positionHash(board, turn, castling, epTarget);
    let history: number[];
    if (m.r === undefined || m.r === null) {
      history = [hash];
    } else {
      history = asArray(m.r, 'chess.history', 256).map((h, i) => asInt(h, `chess.history[${i}]`, 0, 0xffffffff));
      if (history.length === 0) history = [hash];
      else if (history[history.length - 1] !== hash) {
        throw new GameDecodeError('chess.history: last entry does not match the position');
      }
    }

    return withResult({ board, turn, castling, epTarget, players, halfmove, fullmove, history });
  },

  encodeAction(action): CborValue {
    const wire: Record<string, CborValue> = { f: action.payload.from, t: action.payload.to };
    if (action.payload.promotion !== undefined) wire.p = action.payload.promotion;
    return encodeActionEnvelope({ ...action, payload: wire });
  },

  decodeAction(value, player): ChessAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'move') throw new GameDecodeError(`chess: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'chess.payload');
    const promotion = decodePromotion(payload.p);
    return {
      type: 'move',
      player,
      seq: envelope.seq,
      payload: {
        from: asInt(payload.f, 'chess.from', 0, 63),
        to: asInt(payload.t, 'chess.to', 0, 63),
        promotion,
      },
    };
  },
};
