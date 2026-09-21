import { findGame } from '@airlink/games';
import type { GameRenderer } from '../contract.js';
import { AirHockeyTable } from './AirHockeyTable.js';
import { CodeBreakerBoard } from './CodeBreakerBoard.js';
import { DotsAndBoxesBoard } from './DotsAndBoxesBoard.js';
import { GomokuBoard } from './GomokuBoard.js';
import { MemoryDuelBoard } from './MemoryDuelBoard.js';
import { QuickMathBoard } from './QuickMathBoard.js';
import { QuizDuelBoard } from './QuizDuelBoard.js';
import { ReversiBoard } from './ReversiBoard.js';
import { SecretChoiceBoard } from './SecretChoiceBoard.js';
import { RockPaperScissorsBoard } from './RockPaperScissorsBoard.js';
import { SlidingPuzzleBoard } from './SlidingPuzzleBoard.js';
import { TapRaceBoard } from './TapRaceBoard.js';
import { WordChainBoard } from './WordChainBoard.js';
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

  gomoku: draws(GomokuBoard),
  reversi: draws(ReversiBoard),
  'dots-and-boxes': draws(DotsAndBoxesBoard),
  'code-breaker': draws(CodeBreakerBoard),
  'memory-duel': draws(MemoryDuelBoard),
  'sliding-puzzle': draws(SlidingPuzzleBoard),
  'rock-paper-scissors': draws(RockPaperScissorsBoard),
  'tap-race': draws(TapRaceBoard),
  'quick-math': draws(QuickMathBoard),
  'word-chain': draws(WordChainBoard),

  /*
   * One renderer, three games.
   *
   * The three quiz duels differ only in what they draw a question FROM - a
   * flag, a country, a comparison - and share a state type, so they share a
   * board. Three near-identical files would have been three places for the same
   * fix to be needed.
   */
  'flag-duel': draws(QuizDuelBoard),
  'capital-duel': draws(QuizDuelBoard),
  'geography-duel': draws(QuizDuelBoard),

  /*
   * And again, for the three games where nobody wins.
   *
   * Same rules, three prompt banks. The board reads its bank from the game id,
   * so a fourth pack is a data change rather than a fourth near-identical file.
   */
  'would-you-rather': draws(SecretChoiceBoard),
  'most-likely-to': draws(SecretChoiceBoard),
  'this-or-that': draws(SecretChoiceBoard),
};

/**
 * A key here that is not a real game would show as a permanently disabled tile
 * with an honest-sounding but completely wrong reason, which is the hardest
 * kind of mistake to notice. So it fails at module load in development instead.
 */
if (__DEV__) {
  for (const id of Object.keys(RENDERERS)) {
    if (!findGame(id)) throw new Error(`games/index: "${id}" is not a game in the catalogue`);
  }
}

export function rendererFor(gameId: string): GameRenderer<unknown> | null {
  return RENDERERS[gameId] ?? null;
}

/** Can this build draw this game at all? The Play tab asks before it offers it. */
export function hasRenderer(gameId: string): boolean {
  return gameId in RENDERERS;
}
