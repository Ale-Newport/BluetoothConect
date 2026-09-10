import type { GameRenderer } from '../contract.js';
import { AirHockeyTable } from './AirHockeyTable.js';
import { BattleshipBoard } from './BattleshipBoard.js';
import { ChessBoard } from './ChessBoard.js';
import { ConnectFourBoard } from './ConnectFourBoard.js';
import { DartsBoard } from './DartsBoard.js';
import { DrawAndGuessBoard } from './DrawAndGuessBoard.js';
import { PongTable } from './PongTable.js';
import { PoolTable } from './PoolTable.js';
import { ReactionBoard } from './ReactionBoard.js';
import { TicTacToeBoard } from './TicTacToeBoard.js';
import { TriviaBoard } from './TriviaBoard.js';
import { WordDuelBoard } from './WordDuelBoard.js';

/**
 * Which component draws which game.
 *
 * This map is the SECOND half of the promise the catalogue makes. A game in
 * `allGames()` really exists as rules; a game with an entry here can also be
 * drawn. The Play tab checks both, so a tile can never open a screen that has
 * nothing to put on it - the tile goes disabled instead, with a reason.
 *
 * The keys are the game ids from @airlink/games. They are checked against the
 * catalogue at module load, so a typo here is a crash on the first render in
 * development rather than a dead tile in someone's hand on a plane.
 */

/**
 * One cast, in one place.
 *
 * A room holds ONE game and therefore one state type, but it is chosen at
 * runtime by an id, so the room's own view of it is `unknown`. The pairing of
 * key to renderer below is what makes the two agree; expressing that in the
 * type system would need a mapped type over the whole catalogue, which would
 * say the same thing at ten times the length. The cast is confined to this
 * function and no renderer sees `unknown`.
 */
function draws<TState>(renderer: GameRenderer<TState>): GameRenderer<unknown> {
  return renderer as unknown as GameRenderer<unknown>;
}

const RENDERERS: Readonly<Record<string, GameRenderer<unknown>>> = {
  'tic-tac-toe': draws(TicTacToeBoard),
  'connect-four': draws(ConnectFourBoard),
  chess: draws(ChessBoard),
  reaction: draws(ReactionBoard),
  trivia: draws(TriviaBoard),
  'word-duel': draws(WordDuelBoard),
  darts: draws(DartsBoard),
  battleship: draws(BattleshipBoard),
  'draw-and-guess': draws(DrawAndGuessBoard),
  pong: draws(PongTable),
  'air-hockey': draws(AirHockeyTable),
  pool: draws(PoolTable),
};

export function rendererFor(gameId: string): GameRenderer<unknown> | null {
  return RENDERERS[gameId] ?? null;
}

/** Can this build draw this game at all? The Play tab asks before it offers it. */
export function hasRenderer(gameId: string): boolean {
  return gameId in RENDERERS;
}
