import { describe, expect, it } from 'vitest';
import {
  Piece,
  chess,
  isInsufficientMaterial,
  legalMoves,
  legalMovesFrom,
  squareIndex,
  squareName,
  type ChessAction,
  type ChessMove,
  type ChessState,
  type PromotionPiece,
} from '../src/games/chess.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLAYERS = ['a', 'b'] as const;
const setup = { players: [...PLAYERS], seed: 42, options: {} };
const ctx = createContext(setup.players, setup.seed);

/**
 * Piece letters exactly as chess.ts encodes them. Spelling them out here rather
 * than importing a helper means the tests independently pin the wire encoding.
 */
const PIECE_BY_CHAR: Readonly<Record<string, number>> = {
  P: 1,
  N: 2,
  B: 3,
  R: 4,
  Q: 5,
  K: 6,
  p: 7,
  n: 8,
  b: 9,
  r: 10,
  q: 11,
  k: 12,
};

function boardFromFen(placement: string): number[] {
  const board = new Array<number>(64).fill(0);
  const rows = placement.split('/');
  if (rows.length !== 8) throw new Error(`bad FEN placement: ${placement}`);
  for (let rowIndex = 0; rowIndex < 8; rowIndex++) {
    const rank = 7 - rowIndex; // FEN starts at rank 8; index 0 is a1
    let file = 0;
    for (const ch of rows[rowIndex] as string) {
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
        continue;
      }
      const code = PIECE_BY_CHAR[ch];
      if (code === undefined) throw new Error(`bad FEN piece: ${ch}`);
      board[rank * 8 + file] = code;
      file += 1;
    }
    if (file !== 8) throw new Error(`bad FEN rank: ${rows[rowIndex] as string}`);
  }
  return board;
}

/** Build a state through decodeState, the way a peer snapshot would arrive. */
function stateFromFen(fen: string, players: readonly string[] = PLAYERS): ChessState {
  const parts = fen.trim().split(/\s+/);
  const placement = parts[0] as string;
  const side = (parts[1] ?? 'w') as string;
  const rights = (parts[2] ?? '-') as string;
  const ep = (parts[3] ?? '-') as string;
  const halfmove = Number(parts[4] ?? '0');
  const fullmove = Number(parts[5] ?? '1');
  let castling = 0;
  if (rights.includes('K')) castling |= 1;
  if (rights.includes('Q')) castling |= 2;
  if (rights.includes('k')) castling |= 4;
  if (rights.includes('q')) castling |= 8;
  return chess.decodeState({
    b: boardFromFen(placement),
    t: side === 'w' ? 0 : 1,
    c: castling,
    e: ep === '-' ? -1 : squareIndex(ep),
    h: halfmove,
    f: fullmove,
    p: [...players],
  });
}

function actionFor(state: ChessState, from: string, to: string, promotion?: PromotionPiece): ChessAction {
  const player = state.players[state.turn] as string;
  const draft: ChessAction = {
    type: 'move',
    player,
    seq: 0,
    payload: { from: squareIndex(from), to: squareIndex(to), promotion },
  };
  // Round-tripping through the wire is how the runtime feeds every action in.
  return chess.decodeAction(chess.encodeAction(draft), player);
}

/** Play a move that is expected to be legal, returning the new state. */
function play(state: ChessState, from: string, to: string, promotion?: PromotionPiece): ChessState {
  const action = actionFor(state, from, to, promotion);
  const verdict = chess.validateAction(state, action, ctx);
  expect(verdict.ok, `${from}${to}: ${verdict.ok ? '' : verdict.reason}`).toBe(true);
  return chess.applyAction(state, action, ctx);
}

/** Assert a move is refused, and return the refusal reason. */
function refuse(state: ChessState, from: string, to: string, promotion?: PromotionPiece): string {
  const action = actionFor(state, from, to, promotion);
  const verdict = chess.validateAction(state, action, ctx);
  expect(verdict.ok, `${from}${to} should have been refused`).toBe(false);
  return verdict.ok ? '' : verdict.reason;
}

function pieceOn(state: ChessState, square: string): number {
  return state.board[squareIndex(square)] as number;
}

function movesFrom(state: ChessState, from: string): ChessMove[] {
  const origin = squareIndex(from);
  return legalMoves(state).filter((m) => m.from === origin);
}

function moveNames(state: ChessState, from: string): string[] {
  return movesFrom(state, from)
    .map((m) => `${squareName(m.to)}${m.promotion ?? ''}`)
    .sort();
}

function session(local: 'a' | 'b', isHost: boolean): GameSession<ChessState, ChessAction> {
  return new GameSession<ChessState, ChessAction>({ definition: chess, setup, localPlayer: local, isHost });
}

/** Play a move on both sessions, exactly as the two phones would. */
function playPair(
  a: GameSession<ChessState, ChessAction>,
  b: GameSession<ChessState, ChessAction>,
  player: 'a' | 'b',
  from: string,
  to: string,
  promotion?: PromotionPiece,
): void {
  const mover = player === 'a' ? a : b;
  const peer = player === 'a' ? b : a;
  const payload: Record<string, number | string | undefined> = {
    from: squareIndex(from),
    to: squareIndex(to),
    promotion,
  };
  const outcome = mover.submitLocal('move', payload);
  expect(outcome.accepted, `${player} ${from}${to}: ${outcome.accepted ? '' : outcome.detail}`).toBe(true);
  if (!outcome.accepted) return;
  const mirrored = peer.applyRemote(chess.encodeAction(outcome.applied.action), player);
  expect(mirrored.accepted).toBe(true);
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ---------------------------------------------------------------------------
// Move generation: perft is the definitive test of a chess move generator
// ---------------------------------------------------------------------------

function applyRaw(state: ChessState, move: ChessMove): ChessState {
  const action: ChessAction = {
    type: 'move',
    player: state.players[state.turn] as string,
    seq: 0,
    payload: { from: move.from, to: move.to, promotion: move.promotion },
  };
  return chess.applyAction(state, action, ctx);
}

function perft(state: ChessState, depth: number): number {
  const moves = legalMoves(state);
  if (depth <= 1) return moves.length;
  let total = 0;
  for (const move of moves) total += perft(applyRaw(state, move), depth - 1);
  return total;
}

describe('chess move generation (perft)', () => {
  it('counts the opening position correctly', () => {
    const state = chess.createInitialState(setup);
    expect(perft(state, 1)).toBe(20);
    expect(perft(state, 2)).toBe(400);
    expect(perft(state, 3)).toBe(8902);
    expect(perft(state, 4)).toBe(197281);
  });

  it('counts "kiwipete", which exercises castling, pins and captures', () => {
    const state = stateFromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
    expect(perft(state, 1)).toBe(48);
    expect(perft(state, 2)).toBe(2039);
    expect(perft(state, 3)).toBe(97862);
  });

  it('counts a position full of en-passant and promotion tricks', () => {
    const state = stateFromFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
    expect(perft(state, 1)).toBe(14);
    expect(perft(state, 2)).toBe(191);
    expect(perft(state, 3)).toBe(2812);
    expect(perft(state, 4)).toBe(43238);
  });

  it('counts a position with promotions and a pinned queen', () => {
    const state = stateFromFen('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1');
    expect(perft(state, 1)).toBe(6);
    expect(perft(state, 2)).toBe(264);
    expect(perft(state, 3)).toBe(9467);
  });

  it('counts a cramped promotion-heavy position', () => {
    const state = stateFromFen('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
    expect(perft(state, 1)).toBe(44);
    expect(perft(state, 2)).toBe(1486);
    expect(perft(state, 3)).toBe(62379);
  });
});

// ---------------------------------------------------------------------------
// Basic rules
// ---------------------------------------------------------------------------

describe('chess basics', () => {
  it('starts from the standard array with white to move', () => {
    const state = chess.createInitialState(setup);
    expect(pieceOn(state, 'e1')).toBe(Piece.WK);
    expect(pieceOn(state, 'd8')).toBe(Piece.BQ);
    expect(pieceOn(state, 'e4')).toBe(Piece.EMPTY);
    expect(state.turn).toBe(0);
    expect(state.castling).toBe(15);
    expect(state.epTarget).toBe(-1);
    expect(chess.currentTurn?.(state)).toBe('a');
    expect(chess.status(state).kind).toBe(GameStatusKind.IN_PROGRESS);
  });

  it('maps squares to indices the way the wire format expects', () => {
    expect(squareIndex('a1')).toBe(0);
    expect(squareIndex('h1')).toBe(7);
    expect(squareIndex('e4')).toBe(28);
    expect(squareIndex('h8')).toBe(63);
    expect(squareName(0)).toBe('a1');
    expect(squareName(28)).toBe('e4');
    expect(squareName(63)).toBe('h8');
  });

  it('moves and captures with each piece', () => {
    const state = stateFromFen('4k3/8/8/3p4/8/2N5/8/4K3 w - - 0 1');
    expect(moveNames(state, 'c3')).toEqual(['a2', 'a4', 'b1', 'b5', 'd1', 'd5', 'e2', 'e4']);
    const after = play(state, 'c3', 'd5');
    expect(pieceOn(after, 'd5')).toBe(Piece.WN);
    expect(pieceOn(after, 'c3')).toBe(Piece.EMPTY);
    expect(after.turn).toBe(1);
    expect(after.halfmove).toBe(0); // a capture resets the clock
  });

  it('does not let sliding pieces jump over anything', () => {
    const state = chess.createInitialState(setup);
    expect(refuse(state, 'a1', 'a4')).toMatch(/not legal/);
    expect(refuse(state, 'c1', 'h6')).toMatch(/not legal/);
    expect(movesFrom(state, 'b1').length).toBe(2); // only the knight can leave
  });

  it('refuses to capture its own piece', () => {
    const state = chess.createInitialState(setup);
    expect(refuse(state, 'a1', 'a2')).toMatch(/not legal/);
    expect(refuse(state, 'e1', 'd1')).toMatch(/not legal/);
  });

  it('keeps the two kings apart', () => {
    const state = stateFromFen('8/8/8/8/8/3k4/8/3K4 w - - 0 1');
    expect(moveNames(state, 'd1')).toEqual(['c1', 'e1']);
  });

  it('answers move queries for a single square', () => {
    const state = chess.createInitialState(setup);
    expect(legalMovesFrom(state, squareIndex('b1')).map((m) => squareName(m.to)).sort()).toEqual(['a3', 'c3']);
    expect(legalMovesFrom(state, squareIndex('e4'))).toEqual([]);
    expect(legalMovesFrom(state, 99)).toEqual([]);
    expect(legalMovesFrom(state, -3)).toEqual([]);
  });

  it('counts the fullmove number and the halfmove clock', () => {
    let state = chess.createInitialState(setup);
    state = play(state, 'g1', 'f3');
    expect(state.halfmove).toBe(1);
    expect(state.fullmove).toBe(1);
    state = play(state, 'g8', 'f6');
    expect(state.halfmove).toBe(2);
    expect(state.fullmove).toBe(2);
    state = play(state, 'e2', 'e4');
    expect(state.halfmove).toBe(0); // pawn move
  });
});

// ---------------------------------------------------------------------------
// Check, checkmate, stalemate
// ---------------------------------------------------------------------------

describe('chess check and mate', () => {
  it('refuses any move that leaves the king in check (pinned knight)', () => {
    const state = stateFromFen('4rk2/8/8/8/8/8/4N3/4K3 w - - 0 1');
    expect(movesFrom(state, 'e2')).toEqual([]);
    expect(refuse(state, 'e2', 'c3')).toMatch(/not legal/);
    expect(refuse(state, 'e2', 'g3')).toMatch(/not legal/);
    // The king itself may still step off the file.
    expect(moveNames(state, 'e1')).toEqual(['d1', 'd2', 'f1', 'f2']);
  });

  it('forces the side in check to answer it', () => {
    // Rook on e8 checks along the back rank; the king is walled in by its own
    // pawns, so capturing the checker is the one and only legal reply.
    const state = stateFromFen('r3R1k1/5ppp/8/8/8/8/8/6K1 b - - 0 1');
    const moves = legalMoves(state).map((m) => `${squareName(m.from)}${squareName(m.to)}`);
    expect(moves).toEqual(['a8e8']);
  });

  it('declares checkmate after scholar’s mate', () => {
    const a = session('a', true);
    const b = session('b', false);
    playPair(a, b, 'a', 'e2', 'e4');
    playPair(a, b, 'b', 'e7', 'e5');
    playPair(a, b, 'a', 'f1', 'c4');
    playPair(a, b, 'b', 'b8', 'c6');
    playPair(a, b, 'a', 'd1', 'h5');
    playPair(a, b, 'b', 'g8', 'f6');
    playPair(a, b, 'a', 'h5', 'f7');

    for (const s of [a, b]) {
      expect(s.status.kind).toBe(GameStatusKind.WON);
      expect(s.status.kind === GameStatusKind.WON && s.status.winners).toEqual(['a']);
      expect(s.status.kind === GameStatusKind.WON && s.status.reason).toBe('checkmate');
      expect(s.turn).toBeNull();
      expect(s.isOver).toBe(true);
    }
    expect(pieceOn(a.currentState, 'f7')).toBe(Piece.WQ);
  });

  it('declares a draw by stalemate', () => {
    const before = stateFromFen('7k/8/6K1/5Q2/8/8/8/8 w - - 0 1');
    expect(chess.status(before).kind).toBe(GameStatusKind.IN_PROGRESS);
    const after = play(before, 'f5', 'f7');
    expect(legalMoves(after)).toEqual([]);
    expect(chess.status(after)).toEqual({ kind: GameStatusKind.DRAW, reason: 'stalemate' });
    expect(chess.currentTurn?.(after)).toBeNull();
  });

  it('prefers checkmate over the fifty-move rule when both land together', () => {
    // 99 halfmoves already; the back-rank mate makes it 100.
    const state = stateFromFen('7k/5ppp/8/8/8/8/8/R5K1 w - - 99 1');
    const mate = play(state, 'a1', 'a8');
    expect(mate.halfmove).toBe(100);
    const status = chess.status(mate);
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.reason).toBe('checkmate');
  });
});

// ---------------------------------------------------------------------------
// Castling
// ---------------------------------------------------------------------------

describe('chess castling', () => {
  const open = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';

  it('castles kingside for white and queenside for black', () => {
    let state = stateFromFen(open);
    state = play(state, 'e1', 'g1');
    expect(pieceOn(state, 'g1')).toBe(Piece.WK);
    expect(pieceOn(state, 'f1')).toBe(Piece.WR);
    expect(pieceOn(state, 'e1')).toBe(Piece.EMPTY);
    expect(pieceOn(state, 'h1')).toBe(Piece.EMPTY);
    expect(state.castling).toBe(12); // white has spent both rights

    state = play(state, 'e8', 'c8');
    expect(pieceOn(state, 'c8')).toBe(Piece.BK);
    expect(pieceOn(state, 'd8')).toBe(Piece.BR);
    expect(pieceOn(state, 'a8')).toBe(Piece.EMPTY);
    expect(pieceOn(state, 'h8')).toBe(Piece.BR);
    expect(state.castling).toBe(0);
  });

  it('castles queenside for white and kingside for black', () => {
    let state = stateFromFen(open);
    state = play(state, 'e1', 'c1');
    expect(pieceOn(state, 'c1')).toBe(Piece.WK);
    expect(pieceOn(state, 'd1')).toBe(Piece.WR);
    state = play(state, 'e8', 'g8');
    expect(pieceOn(state, 'g8')).toBe(Piece.BK);
    expect(pieceOn(state, 'f8')).toBe(Piece.BR);
  });

  it('refuses to castle when the right has been spent', () => {
    let state = stateFromFen(open);
    state = play(state, 'e1', 'e2'); // the king moves
    state = play(state, 'a8', 'a7');
    state = play(state, 'e2', 'e1'); // and comes back
    state = play(state, 'a7', 'a8');
    expect(state.castling).toBe(4); // only black's kingside right survives
    expect(refuse(state, 'e1', 'g1')).toMatch(/not legal/);
    expect(refuse(state, 'e1', 'c1')).toMatch(/not legal/);
  });

  it('refuses to castle through an occupied square', () => {
    const state = stateFromFen('r3k2r/8/8/8/8/8/8/R2QK1NR w KQkq - 0 1');
    expect(refuse(state, 'e1', 'g1')).toMatch(/not legal/);
    expect(refuse(state, 'e1', 'c1')).toMatch(/not legal/);
  });

  it('refuses to castle out of check', () => {
    const state = stateFromFen('4r3/8/8/8/6k1/8/8/R3K2R w KQ - 0 1');
    expect(refuse(state, 'e1', 'g1')).toMatch(/not legal/);
    expect(refuse(state, 'e1', 'c1')).toMatch(/not legal/);
  });

  it('refuses to castle through an attacked square, but allows the other side', () => {
    const state = stateFromFen('r4rk1/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    // The rook on f8 covers f1, so the king may not pass over it.
    expect(refuse(state, 'e1', 'g1')).toMatch(/not legal/);
    const after = play(state, 'e1', 'c1');
    expect(pieceOn(after, 'c1')).toBe(Piece.WK);
  });

  it('refuses to castle onto an attacked square', () => {
    // The rook on g8 covers g1, the square the king would land on.
    const state = stateFromFen('6r1/8/8/8/1k6/8/8/R3K2R w KQ - 0 1');
    expect(refuse(state, 'e1', 'g1')).toMatch(/not legal/);
    expect(pieceOn(play(state, 'e1', 'c1'), 'c1')).toBe(Piece.WK);
  });

  it('allows queenside castling when only b1 is attacked', () => {
    // A black bishop on f5 hits b1 but touches none of the king's squares.
    const state = stateFromFen('4k3/8/8/5b2/8/8/8/R3K3 w Q - 0 1');
    const after = play(state, 'e1', 'c1');
    expect(pieceOn(after, 'c1')).toBe(Piece.WK);
    expect(pieceOn(after, 'd1')).toBe(Piece.WR);
  });

  it('loses the right when the rook is captured on its home square', () => {
    const state = stateFromFen('r3k2r/8/8/8/8/8/7b/R3K2R w KQkq - 0 1');
    expect(state.castling).toBe(15);
    const after = play(state, 'a1', 'a8'); // trade rooks on a8
    expect(after.castling).toBe(1 + 4); // white keeps kingside, black keeps kingside
  });
});

// ---------------------------------------------------------------------------
// En passant
// ---------------------------------------------------------------------------

describe('chess en passant', () => {
  it('opens a one-move window after a double push and captures correctly', () => {
    const start = stateFromFen('4k3/8/8/8/4p3/8/3P4/4K3 w - - 0 1');
    expect(start.epTarget).toBe(-1);
    const pushed = play(start, 'd2', 'd4');
    expect(pushed.epTarget).toBe(squareIndex('d3'));

    const captured = play(pushed, 'e4', 'd3');
    expect(pieceOn(captured, 'd3')).toBe(Piece.BP);
    expect(pieceOn(captured, 'd4')).toBe(Piece.EMPTY);
    expect(pieceOn(captured, 'e4')).toBe(Piece.EMPTY);
    expect(captured.epTarget).toBe(-1);
    expect(captured.board.filter((p) => p === Piece.WP)).toEqual([]);
  });

  it('closes the window after any other move', () => {
    let state = play(stateFromFen('4k3/8/8/8/4p3/8/3P4/4K3 w - - 0 1'), 'd2', 'd4');
    state = play(state, 'e8', 'd8'); // black declines
    expect(state.epTarget).toBe(-1);
    state = play(state, 'e1', 'e2');
    expect(refuse(state, 'e4', 'd3')).toMatch(/not legal/);
  });

  it('only opens the window on a double push', () => {
    const state = play(stateFromFen('4k3/8/8/8/4p3/3P4/8/4K3 w - - 0 1'), 'd3', 'd4');
    expect(state.epTarget).toBe(-1);
    expect(refuse(state, 'e4', 'd3')).toMatch(/not legal/);
  });

  it('refuses an en-passant capture that would expose the king', () => {
    // Removing both pawns from rank 5 would open the rook's line to the king.
    const state = stateFromFen('8/8/8/K2pP2r/8/8/8/7k w - d6 0 1');
    expect(state.epTarget).toBe(squareIndex('d6'));
    expect(moveNames(state, 'e5')).toEqual(['e6']);
    expect(refuse(state, 'e5', 'd6')).toMatch(/not legal/);
  });
});

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

describe('chess promotion', () => {
  const promo = '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1';

  it('promotes to a queen by default', () => {
    const state = play(stateFromFen(promo), 'a7', 'a8');
    expect(pieceOn(state, 'a8')).toBe(Piece.WQ);
    expect(pieceOn(state, 'a7')).toBe(Piece.EMPTY);
  });

  it('promotes to the requested piece, including on a capture', () => {
    const knight = play(stateFromFen(promo), 'a7', 'a8', 'n');
    expect(pieceOn(knight, 'a8')).toBe(Piece.WN);
    const rook = play(stateFromFen(promo), 'a7', 'b8', 'r');
    expect(pieceOn(rook, 'b8')).toBe(Piece.WR);
    expect(rook.board.filter((p) => p === Piece.BN)).toEqual([]);
  });

  it('offers exactly four promotions per target square', () => {
    const state = stateFromFen(promo);
    expect(moveNames(state, 'a7')).toEqual(['a8b', 'a8n', 'a8q', 'a8r', 'b8b', 'b8n', 'b8q', 'b8r']);
  });

  it('promotes black pawns downward', () => {
    const state = play(stateFromFen('4k3/8/8/8/8/8/6p1/4K3 b - - 0 1'), 'g2', 'g1', 'q');
    expect(pieceOn(state, 'g1')).toBe(Piece.BQ);
  });

  it('refuses a promotion piece on a move that does not promote', () => {
    const state = chess.createInitialState(setup);
    expect(refuse(state, 'e2', 'e4', 'q')).toMatch(/does not promote/);
  });

  it('rejects a promotion letter that is not a piece', () => {
    expect(() => chess.decodeAction({ t: 'move', s: 0, p: { f: 48, t: 56, p: 'k' } }, 'a')).toThrow(/promotion/);
    expect(() => chess.decodeAction({ t: 'move', s: 0, p: { f: 48, t: 56, p: 'Q' } }, 'a')).toThrow(/promotion/);
    expect(() => chess.decodeAction({ t: 'move', s: 0, p: { f: 48, t: 56, p: 5 } }, 'a')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Draws
// ---------------------------------------------------------------------------

describe('chess draws', () => {
  it('draws by the fifty-move rule on the hundredth quiet halfmove', () => {
    const state = stateFromFen('4k3/8/8/8/8/8/8/4K1R1 w - - 99 1');
    expect(chess.status(state).kind).toBe(GameStatusKind.IN_PROGRESS);
    const after = play(state, 'g1', 'g2');
    expect(after.halfmove).toBe(100);
    expect(chess.status(after)).toEqual({ kind: GameStatusKind.DRAW, reason: 'fifty-move rule' });
  });

  it('restarts the halfmove clock on a pawn move or a capture', () => {
    const state = stateFromFen('4k3/8/8/8/8/8/6P1/4K1R1 w - - 99 1');
    const after = play(state, 'g2', 'g4');
    expect(after.halfmove).toBe(0);
    expect(chess.status(after).kind).toBe(GameStatusKind.IN_PROGRESS);
    expect(after.history.length).toBe(1);
  });

  it('draws by threefold repetition when the knights shuffle back', () => {
    const a = session('a', true);
    const b = session('b', false);
    for (let round = 0; round < 2; round++) {
      playPair(a, b, 'a', 'g1', 'f3');
      playPair(a, b, 'b', 'g8', 'f6');
      playPair(a, b, 'a', 'f3', 'g1');
      playPair(a, b, 'b', 'f6', 'g8');
    }
    for (const s of [a, b]) {
      expect(s.status).toEqual({ kind: GameStatusKind.DRAW, reason: 'threefold repetition' });
    }
    // The starting position occurred three times, once per pass.
    expect(a.currentState.history.length).toBe(9);
  });

  it('does not call a draw on the second occurrence', () => {
    const a = session('a', true);
    const b = session('b', false);
    playPair(a, b, 'a', 'g1', 'f3');
    playPair(a, b, 'b', 'g8', 'f6');
    playPair(a, b, 'a', 'f3', 'g1');
    playPair(a, b, 'b', 'f6', 'g8');
    expect(a.status.kind).toBe(GameStatusKind.IN_PROGRESS);
  });

  it('draws on insufficient material', () => {
    const drawn = [
      '4k3/8/8/8/8/8/8/4K3 w - - 0 1', // K vs K
      '4k3/8/8/8/8/8/8/4KB2 w - - 0 1', // K+B vs K
      '4k3/8/8/8/8/8/8/4KN2 w - - 0 1', // K+N vs K
      '2b1k3/8/8/8/8/8/8/4KB2 w - - 0 1', // K+B vs K+B, both on dark squares
    ];
    for (const fen of drawn) {
      expect(chess.status(stateFromFen(fen)), fen).toEqual({
        kind: GameStatusKind.DRAW,
        reason: 'insufficient material',
      });
    }
  });

  it('keeps playing when the material is still sufficient', () => {
    const playable = [
      '3bk3/8/8/8/8/8/8/4KB2 w - - 0 1', // bishops on opposite colours
      '4k3/8/8/8/8/8/8/4KNN1 w - - 0 1', // two knights
      '4k3/8/8/8/8/8/7P/4K3 w - - 0 1', // a pawn can promote
      '4k3/8/8/8/8/8/8/4KR2 w - - 0 1', // a rook mates
    ];
    for (const fen of playable) {
      expect(chess.status(stateFromFen(fen)).kind, fen).toBe(GameStatusKind.IN_PROGRESS);
    }
    expect(isInsufficientMaterial(stateFromFen(playable[0] as string).board)).toBe(false);
  });

  it('ends the game the moment a capture leaves too little material', () => {
    // White is in check from the rook on d1 and takes it: K+B vs K remains.
    const state = stateFromFen('4k3/8/8/8/8/8/8/3rK1B1 w - - 0 1');
    expect(chess.status(state).kind).toBe(GameStatusKind.IN_PROGRESS);
    const after = play(state, 'e1', 'd1');
    expect(chess.status(after)).toEqual({ kind: GameStatusKind.DRAW, reason: 'insufficient material' });
  });
});

// ---------------------------------------------------------------------------
// Rejecting a hostile or careless peer
// ---------------------------------------------------------------------------

describe('chess rejects illegal actions', () => {
  it('refuses a move out of turn', () => {
    const b = session('b', false);
    const outcome = b.submitLocal('move', { from: squareIndex('e7'), to: squareIndex('e5') });
    expect(outcome.accepted).toBe(false);
    expect(outcome.accepted === false && outcome.detail).toMatch(/turn/);
  });

  it('refuses to move the opponent’s piece', () => {
    const state = chess.createInitialState(setup);
    expect(refuse(state, 'e7', 'e5')).toMatch(/opponent/);
  });

  it('refuses to move from an empty square', () => {
    const state = chess.createInitialState(setup);
    expect(refuse(state, 'e4', 'e5')).toMatch(/no piece/);
  });

  it('refuses an unknown action type', () => {
    const state = chess.createInitialState(setup);
    const verdict = chess.validateAction(
      state,
      { type: 'resign', player: 'a', seq: 0, payload: { from: 0, to: 1 } } as unknown as ChessAction,
      ctx,
    );
    expect(verdict.ok).toBe(false);
  });

  it('refuses a malformed payload from a caller that skipped the decoder', () => {
    const state = chess.createInitialState(setup);
    const bad: unknown[] = [null, undefined, 'e2e4', 42, { to: 28 }, { from: 12 }, { from: 1.5, to: 28 }, { from: 12, to: 64 }, { from: -1, to: 28 }];
    for (const payload of bad) {
      const action = { type: 'move', player: 'a', seq: 0, payload } as unknown as ChessAction;
      const verdict = chess.validateAction(state, action, ctx);
      expect(verdict.ok, JSON.stringify(payload ?? null)).toBe(false);
    }
  });

  it('refuses every move once the game is over', () => {
    const a = session('a', true);
    const b = session('b', false);
    playPair(a, b, 'a', 'e2', 'e4');
    playPair(a, b, 'b', 'e7', 'e5');
    playPair(a, b, 'a', 'f1', 'c4');
    playPair(a, b, 'b', 'b8', 'c6');
    playPair(a, b, 'a', 'd1', 'h5');
    playPair(a, b, 'b', 'g8', 'f6');
    playPair(a, b, 'a', 'h5', 'f7');
    expect(a.isOver).toBe(true);
    const late = b.submitLocal('move', { from: squareIndex('e8'), to: squareIndex('e7') });
    expect(late.accepted).toBe(false);
    // Even bypassing the session, the definition itself refuses.
    const verdict = chess.validateAction(a.currentState, actionFor(a.currentState, 'e8', 'e7'), ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/finished/);
  });

  it('will not let one player move as another', () => {
    const b = session('b', false);
    const forged = chess.encodeAction({
      type: 'move',
      player: 'a',
      seq: 0,
      payload: { from: squareIndex('e2'), to: squareIndex('e4') },
    });
    // The session authenticates us as 'b', so the action is attributed to b -
    // and b is not to move.
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
    // A player who is not in the game at all is refused outright.
    const outsider = b.applyRemote(forged, 'mallory');
    expect(outsider.accepted).toBe(false);
    expect(outsider.accepted === false && outsider.reason).toBe('notAPlayer');
  });

  it('rejects a duplicate action rather than applying it twice', () => {
    const a = session('a', true);
    const b = session('b', false);
    const outcome = a.submitLocal('move', { from: squareIndex('e2'), to: squareIndex('e4') });
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;
    const wire = chess.encodeAction(outcome.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });

  it('survives garbage in place of an action', () => {
    const a = session('a', true);
    const junk = [
      null,
      0,
      'move',
      [],
      {},
      { t: 'move' },
      { t: 'move', s: 0, p: null },
      { t: 'move', s: 0, p: { f: 64, t: 0 } },
      { t: 'move', s: 0, p: { f: -1, t: 0 } },
      { t: 'move', s: 0, p: { f: 1.5, t: 0 } },
      { t: 'move', s: 0, p: { f: 1e12, t: -1e12 } },
      { t: 'move', s: 0, p: { f: '12', t: 28 } },
      { t: 'move', s: 0, p: new Uint8Array(8) },
      { t: 'move', s: 0, p: [12, 28] },
      { t: 'x'.repeat(400), s: 0, p: { f: 12, t: 28 } },
      { t: 'move', s: -1, p: { f: 12, t: 28 } },
    ];
    for (const value of junk) {
      expect(() => a.applyRemote(value, 'a'), JSON.stringify(value)).not.toThrow();
    }
    // None of it moved a piece.
    expect(chess.encodeState(a.currentState)).toEqual(chess.encodeState(chess.createInitialState(setup)));
  });
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe('chess encoding', () => {
  it('round-trips a played-out state exactly', () => {
    let state = chess.createInitialState(setup);
    for (const [from, to] of [
      ['e2', 'e4'],
      ['d7', 'd5'],
      ['g1', 'f3'],
      ['c8', 'g4'],
      ['f1', 'e2'],
      ['b8', 'c6'],
      ['e1', 'g1'],
    ] as const) {
      state = play(state, from, to);
    }
    const encoded = chess.encodeState(state);
    const restored = chess.decodeState(encoded);
    expect(chess.encodeState(restored)).toEqual(encoded);
    expect(restored.board).toEqual(state.board);
    expect(restored.castling).toBe(state.castling);
    expect(restored.halfmove).toBe(state.halfmove);
    expect(restored.history).toEqual(state.history);
    expect(chess.status(restored)).toEqual(chess.status(state));
  });

  it('keeps the en-passant square across a round trip', () => {
    const state = play(chess.createInitialState(setup), 'e2', 'e4');
    const restored = chess.decodeState(chess.encodeState(state));
    expect(restored.epTarget).toBe(squareIndex('e3'));
    expect(legalMoves(restored).length).toBe(legalMoves(state).length);
  });

  it('round-trips actions with and without a promotion', () => {
    const plain: ChessAction = { type: 'move', player: 'a', seq: 3, payload: { from: 12, to: 28 } };
    const wire = chess.encodeAction(plain);
    expect(wire).toEqual({ t: 'move', s: 3, p: { f: 12, t: 28 } });
    const back = chess.decodeAction(wire, 'a');
    expect(back.payload.from).toBe(12);
    expect(back.payload.to).toBe(28);
    expect(back.payload.promotion).toBeUndefined();
    expect(chess.encodeAction(back)).toEqual(wire);

    const promoting: ChessAction = { type: 'move', player: 'b', seq: 9, payload: { from: 48, to: 56, promotion: 'n' } };
    const promoWire = chess.encodeAction(promoting);
    expect(promoWire).toEqual({ t: 'move', s: 9, p: { f: 48, t: 56, p: 'n' } });
    expect(chess.encodeAction(chess.decodeAction(promoWire, 'b'))).toEqual(promoWire);
  });

  it('rejects impossible states from a peer', () => {
    const base = chess.encodeState(chess.createInitialState(setup)) as Record<string, unknown>;
    const mutate = (patch: Record<string, unknown>): unknown => ({ ...base, ...patch });

    expect(() => chess.decodeState(mutate({ b: [1, 2, 3] }) as never)).toThrow(/64/);
    expect(() => chess.decodeState(mutate({ b: new Array<number>(64).fill(0) }) as never)).toThrow(/king/);
    expect(() => chess.decodeState(mutate({ t: 2 }) as never)).toThrow();
    expect(() => chess.decodeState(mutate({ c: 99 }) as never)).toThrow();
    expect(() => chess.decodeState(mutate({ e: 12 }) as never)).toThrow(/impossible/);
    expect(() => chess.decodeState(mutate({ h: -1 }) as never)).toThrow();
    expect(() => chess.decodeState(mutate({ p: ['only-one'] }) as never)).toThrow();
    expect(() => chess.decodeState(mutate({ r: [1, 2, 3] }) as never)).toThrow(/history/);
    expect(() => chess.decodeState('not a state' as never)).toThrow();

    // A pawn on the back rank could never have got there.
    const pawnOnLastRank = boardFromFen('P3k3/8/8/8/8/8/8/4K3');
    expect(() => chess.decodeState(mutate({ b: pawnOnLastRank }) as never)).toThrow(/rank/);

    // A position where the side that just moved is capturable is unreachable.
    expect(() => stateFromFen('4k3/8/8/8/8/8/8/4KR2 b - - 0 1')).not.toThrow();
    expect(() => stateFromFen('4k3/4R3/8/8/8/8/8/4K3 w - - 0 1')).toThrow(/not to move/);
  });

  it('accepts a state without a repetition history and rebuilds it', () => {
    const state = stateFromFen(START_FEN);
    expect(state.history.length).toBe(1);
    expect(chess.encodeState(state)).toEqual(chess.encodeState(chess.createInitialState(setup)));
  });

  it('does not mutate the state it is given', () => {
    const state = chess.createInitialState(setup);
    const before = JSON.stringify(chess.encodeState(state));
    const next = play(state, 'e2', 'e4');
    expect(JSON.stringify(chess.encodeState(state))).toBe(before);
    expect(next).not.toBe(state);
    expect(next.board).not.toBe(state.board);
  });
});

// ---------------------------------------------------------------------------
// Conformance
// ---------------------------------------------------------------------------

// Random play with automatic fifty-move and threefold draws always terminates.
// A survey of 150 seeds put the longest game at 651 plies, so this bound leaves
// plenty of headroom while still catching a game that cannot finish at all.
const MAX_PLIES = 1500;

function conformanceHooks() {
  return {
    legalAction: (state: ChessState, player: string, random: { nextInt(n: number): number }) => {
      if (chess.currentTurn?.(state) !== player) return null;
      const moves = legalMoves(state);
      if (moves.length === 0) return null;
      const move = moves[random.nextInt(moves.length)] as ChessMove;
      return {
        type: 'move',
        payload: { from: move.from, to: move.to, promotion: move.promotion },
      };
    },
    maxPlies: MAX_PLIES,
  };
}

describe('chess conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(chess, conformanceHooks());
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const report = runConformance(chess, conformanceHooks(), seed);
      expect(report.failures, `seed ${seed}`).toEqual([]);
      expect(report.finalStatus, `seed ${seed}`).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});

