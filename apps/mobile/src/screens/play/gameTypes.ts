/**
 * The twelve games, reachable from the renderers.
 *
 * `@airlink/games` publishes the engine, the runtime and the catalogue, but not
 * the games themselves: its `exports` map has a single "." entry, and Metro is
 * configured with `unstable_enablePackageExports`, so a deep import by package
 * name would not resolve at runtime either. Yet every state type a renderer
 * draws - and the `view`/`lerp` helpers the realtime games publish for exactly
 * this purpose - live in those files.
 *
 * So the paths are collected HERE, once, and re-exported. Nothing else in the
 * Play screens reaches outside the app. Names that collide between two games
 * are renamed on the way through, which is also why this is a list of explicit
 * re-exports rather than a dozen `export *` lines.
 *
 * When the games package re-exports its own games, this file becomes twelve
 * one-line re-exports from '@airlink/games'. See the report.
 */

// -- turn-based ------------------------------------------------------------

export type { TicTacToeState } from '../../../../../packages/games/src/games/ticTacToe.js';

export {
  COLS as CONNECT_FOUR_COLS,
  ROWS as CONNECT_FOUR_ROWS,
  landingRow,
} from '../../../../../packages/games/src/games/connectFour.js';
export type { ConnectFourState } from '../../../../../packages/games/src/games/connectFour.js';

export {
  Piece,
  isInCheck,
  legalMoves,
  legalMovesFrom,
  squareName,
} from '../../../../../packages/games/src/games/chess.js';
export type {
  ChessMove,
  ChessState,
  Color as ChessColor,
  PromotionPiece,
} from '../../../../../packages/games/src/games/chess.js';

export {
  MAX_TAP_MS,
  NOBODY as REACTION_NOBODY,
  NO_ROUND_YET as REACTION_NO_ROUND,
  NOT_TAPPED,
  NO_TIME,
  ROUNDS_TO_PLAY,
  ReactionPhase,
  averageReactionMs,
  isFalseStart,
  reactionPhase,
} from '../../../../../packages/games/src/games/reaction.js';
export type { ReactionState } from '../../../../../packages/games/src/games/reaction.js';

export {
  MAX_ANSWER_MS,
  UNANSWERED,
  currentQuestion,
  hasAnswered,
  revealedCorrect,
} from '../../../../../packages/games/src/games/trivia.js';
export type { TriviaState } from '../../../../../packages/games/src/games/trivia.js';

export {
  GRID_SIZE as WORD_GRID_SIZE,
  neighbours,
  scoreForLength,
  scores as wordDuelScores,
} from '../../../../../packages/games/src/games/wordDuel.js';
export type { WordDuelState } from '../../../../../packages/games/src/games/wordDuel.js';
export {
  MAX_WORD_LENGTH,
  MIN_WORD_LENGTH,
  isWord,
} from '../../../../../packages/games/src/games/wordList.js';

export {
  BOARD_RADIUS as DART_BOARD_RADIUS,
  DARTS_PER_TURN,
  DartRing,
  SECTOR_ORDER,
  scoreDart,
} from '../../../../../packages/games/src/games/darts.js';
export type { DartsState } from '../../../../../packages/games/src/games/darts.js';

export {
  BOARD_SIZE as SEA_SIZE,
  BattleshipPhase,
  FLEET,
  SALT_BYTES,
  fleetCommitment,
  isLegalLayout,
  resolveReport,
  shipCells,
  sunkCount,
} from '../../../../../packages/games/src/games/battleship.js';
export type {
  BattleshipState,
  FleetEntry,
  Ship,
  Shot,
} from '../../../../../packages/games/src/games/battleship.js';

export {
  GuessKind,
  MAX_COORD as DRAW_MAX_COORD,
  MAX_GUESS_LENGTH,
  MAX_POINTS_PER_STROKE,
  currentDrawer,
  currentWord,
  isFinished as drawingIsFinished,
} from '../../../../../packages/games/src/games/drawAndGuess.js';
export type {
  DrawAndGuessState,
  GuessEntry,
  Stroke,
} from '../../../../../packages/games/src/games/drawAndGuess.js';

// -- realtime --------------------------------------------------------------

export {
  FIELD_H as PONG_FIELD_H,
  FIELD_W as PONG_FIELD_W,
  PongPhase,
  lerpPongState,
  pongView,
} from '../../../../../packages/games/src/games/pong.js';
export type { PongState, PongView } from '../../../../../packages/games/src/games/pong.js';

export {
  AIR_HOCKEY,
  airHockeyView,
  lerpAirHockey,
} from '../../../../../packages/games/src/games/airHockey.js';
export type {
  AirHockeyState,
  AirHockeyView,
} from '../../../../../packages/games/src/games/airHockey.js';

export {
  BALL_COUNT as POOL_BALL_COUNT,
  BALL_RADIUS as POOL_BALL_RADIUS,
  POCKETS as POOL_POCKETS,
  POCKET_RADIUS as POOL_POCKET_RADIUS,
  PoolGroup,
  TABLE_HEIGHT as POOL_TABLE_HEIGHT,
  TABLE_WIDTH as POOL_TABLE_WIDTH,
  anyBallMoving,
  pool,
  poolBeginShot,
  poolLerp,
  poolView,
} from '../../../../../packages/games/src/games/pool.js';
export type { PoolState, PoolView } from '../../../../../packages/games/src/games/pool.js';
