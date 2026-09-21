/**
 * The game catalogue.
 *
 * Registering a game here is the ONLY thing needed to make it appear in the
 * Play tab, be offered in capability exchange, and be playable. There is no
 * second list to keep in sync, which is what stops a button existing for a game
 * that is not really there.
 */
import type { GameAction, GameDefinition, GameMode } from './engine.js';
import { airHockey } from './games/airHockey.js';
import { codeBreaker } from './games/codeBreaker.js';
import { dotsAndBoxes } from './games/dotsAndBoxes.js';
import { gomoku } from './games/gomoku.js';
import { memoryDuel } from './games/memoryDuel.js';
import { capitalDuel, flagDuel, geographyDuel } from './games/quizDuel.js';
import { quickMath } from './games/quickMath.js';
import { reversi } from './games/reversi.js';
import { rockPaperScissors } from './games/rockPaperScissors.js';
import { mostLikelyTo, thisOrThat, wouldYouRather } from './games/secretChoice.js';
import { slidingPuzzle } from './games/slidingPuzzle.js';
import { tapRace } from './games/tapRace.js';
import { wordChain } from './games/wordChain.js';
import { battleship } from './games/battleship.js';
import { chess } from './games/chess.js';
import { connectFour } from './games/connectFour.js';
import { darts } from './games/darts.js';
import { drawAndGuess } from './games/drawAndGuess.js';
import { pong } from './games/pong.js';
import { pool } from './games/pool.js';
import { reaction } from './games/reaction.js';
import { ticTacToe } from './games/ticTacToe.js';
import { trivia } from './games/trivia.js';
import { wordDuel } from './games/wordDuel.js';

type AnyGame = GameDefinition<never, never>;
const anyGame = (definition: unknown): AnyGame => definition as AnyGame;

/**
 * How the Play tab is organised.
 *
 * Twelve games fitted in one list. Thirty do not, and a wall of tiles is not a
 * catalogue - it is a thing to scroll past. These are the shelves people
 * actually reach for: something to fill four minutes, something to think about
 * for an hour, something to play with a person rather than against them.
 */
export const GameCategory = {
  /** Over in a couple of minutes. Reflexes, luck, one decision. */
  QUICK: 'quick',
  /** Boards. Long games worth losing. */
  STRATEGY: 'strategy',
  WORDS: 'words',
  TRIVIA: 'trivia',
  PUZZLES: 'puzzles',
  /** Loud, silly, better with an audience. */
  PARTY: 'party',
  /** Not competitive. For two people who like each other. */
  TOGETHER: 'together',
  /** Continuous simulation. Wants a good link, and says so. */
  REALTIME: 'realtime',
} as const;
export type GameCategory = (typeof GameCategory)[keyof typeof GameCategory];

/**
 * How much a slow link hurts this game.
 *
 * The single most important number in this file. AirLink's floor is Bluetooth
 * between an iPhone and an Android: about five to forty kilobytes a second,
 * with tens of milliseconds of latency and jitter on top. A game of chess does
 * not notice that at all. A game of Pong is ruined by it. So the catalogue
 * knows the difference, leads with what will feel good on the link that is
 * actually up, and stops pretending the two are equivalent.
 */
export const LatencySensitivity = {
  /** Both phones play locally and compare results. Latency cannot be felt. */
  NONE: 'none',
  /** Turn-based. A few hundred milliseconds is invisible. */
  LOW: 'low',
  /** Continuous. Needs a fast, steady link to be worth playing. */
  HIGH: 'high',
} as const;
export type LatencySensitivity = (typeof LatencySensitivity)[keyof typeof LatencySensitivity];

/** Roughly what this game asks of the radio while it is being played. */
export const Bandwidth = {
  /** A few bytes a move. Bluetooth is plenty. */
  TINY: 'tiny',
  /** Steady small messages - strokes, inputs. Fine on Bluetooth, better on Wi-Fi. */
  LOW: 'low',
  /** Continuous snapshots. Wants Wi-Fi. */
  HIGH: 'high',
} as const;
export type Bandwidth = (typeof Bandwidth)[keyof typeof Bandwidth];

export interface GameCatalogueEntry {
  readonly definition: GameDefinition<never, never>;
  /** One line shown under the name in the picker. */
  readonly blurb: string;
  /** Roughly how long a game takes, for the picker. */
  readonly typicalMinutes: number;
  readonly category: GameCategory;
  readonly latencySensitivity: LatencySensitivity;
  readonly bandwidth: Bandwidth;
}

/**
 * Order matters: this is the order the Play tab shows. Quick games that read
 * instantly come first, the longer and more involved ones after.
 */
const ENTRIES: GameCatalogueEntry[] = [
  {
    definition: anyGame(ticTacToe),
    blurb: 'Three in a row. One minute, one winner.',
    typicalMinutes: 1,
    category: GameCategory.QUICK,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(connectFour),
    blurb: 'Drop, stack, and line up four.',
    typicalMinutes: 3,
    category: GameCategory.STRATEGY,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(reaction),
    blurb: 'Wait for green. Do not blink.',
    typicalMinutes: 2,
    category: GameCategory.QUICK,
    latencySensitivity: LatencySensitivity.NONE,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(pong),
    blurb: 'The original. First to seven.',
    typicalMinutes: 4,
    category: GameCategory.REALTIME,
    latencySensitivity: LatencySensitivity.HIGH,
    bandwidth: Bandwidth.HIGH,
  },
  {
    definition: anyGame(airHockey),
    blurb: 'Fast, loud, and over quickly.',
    typicalMinutes: 4,
    category: GameCategory.REALTIME,
    latencySensitivity: LatencySensitivity.HIGH,
    bandwidth: Bandwidth.HIGH,
  },
  {
    definition: anyGame(drawAndGuess),
    blurb: 'Draw it. Watch them fail to get it.',
    typicalMinutes: 8,
    category: GameCategory.PARTY,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.LOW,
  },
  {
    definition: anyGame(trivia),
    blurb: 'Ten questions. No looking anything up.',
    typicalMinutes: 6,
    category: GameCategory.TRIVIA,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(darts),
    blurb: '501, and you must finish on a double.',
    typicalMinutes: 8,
    category: GameCategory.QUICK,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(battleship),
    blurb: 'Hide a fleet. Find theirs first.',
    typicalMinutes: 10,
    category: GameCategory.STRATEGY,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(pool),
    blurb: 'Solids, stripes, and the black.',
    typicalMinutes: 10,
    category: GameCategory.REALTIME,
    latencySensitivity: LatencySensitivity.HIGH,
    bandwidth: Bandwidth.HIGH,
  },
  {
    definition: anyGame(wordDuel),
    blurb: 'Sixteen letters. Find what they missed.',
    typicalMinutes: 5,
    category: GameCategory.WORDS,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(chess),
    blurb: 'The long flight game.',
    typicalMinutes: 25,
    category: GameCategory.STRATEGY,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(rockPaperScissors),
    blurb: 'Best of five, and nobody gets to peek.',
    typicalMinutes: 2,
    category: GameCategory.QUICK,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(tapRace),
    blurb: 'Twenty seconds. Tap like you mean it.',
    typicalMinutes: 2,
    category: GameCategory.QUICK,
    latencySensitivity: LatencySensitivity.NONE,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(quickMath),
    blurb: 'Ten sums. Correct first, fastest second.',
    typicalMinutes: 3,
    category: GameCategory.QUICK,
    latencySensitivity: LatencySensitivity.NONE,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(gomoku),
    blurb: 'Five in a row, on a much bigger board.',
    typicalMinutes: 6,
    category: GameCategory.STRATEGY,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(reversi),
    blurb: 'Flip their line. Own the board.',
    typicalMinutes: 10,
    category: GameCategory.STRATEGY,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(dotsAndBoxes),
    blurb: 'Close the fourth side, keep the pencil.',
    typicalMinutes: 8,
    category: GameCategory.STRATEGY,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(wordChain),
    blurb: 'Last letter in, next word out.',
    typicalMinutes: 5,
    category: GameCategory.WORDS,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(flagDuel),
    blurb: 'Whose flag is that? Eight to find out.',
    typicalMinutes: 3,
    category: GameCategory.TRIVIA,
    latencySensitivity: LatencySensitivity.NONE,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(capitalDuel),
    blurb: 'The country is easy. The capital is not.',
    typicalMinutes: 3,
    category: GameCategory.TRIVIA,
    latencySensitivity: LatencySensitivity.NONE,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(geographyDuel),
    blurb: 'Bigger, colder, further north. Guess.',
    typicalMinutes: 4,
    category: GameCategory.TRIVIA,
    latencySensitivity: LatencySensitivity.NONE,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(codeBreaker),
    blurb: 'Race a rival to crack the same code.',
    typicalMinutes: 6,
    category: GameCategory.PUZZLES,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(memoryDuel),
    blurb: 'Sixteen cards. Remember better.',
    typicalMinutes: 4,
    category: GameCategory.PUZZLES,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(slidingPuzzle),
    blurb: 'Fifteen tiles each. First one home.',
    typicalMinutes: 4,
    category: GameCategory.PUZZLES,
    latencySensitivity: LatencySensitivity.NONE,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(wouldYouRather),
    blurb: 'Choose in secret. Open together.',
    typicalMinutes: 4,
    category: GameCategory.TOGETHER,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(mostLikelyTo),
    blurb: 'Which of you is it? Both answer at once.',
    typicalMinutes: 4,
    category: GameCategory.TOGETHER,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
  {
    definition: anyGame(thisOrThat),
    blurb: 'Forty tiny decisions. See how alike you are.',
    typicalMinutes: 4,
    category: GameCategory.TOGETHER,
    latencySensitivity: LatencySensitivity.LOW,
    bandwidth: Bandwidth.TINY,
  },
];

/** Register a game. Called at module load by the catalogue file. */
export function registerGame(entry: GameCatalogueEntry): void {
  if (ENTRIES.some((e) => e.definition.id === entry.definition.id)) {
    throw new Error(`registerGame: duplicate game id "${entry.definition.id}"`);
  }
  ENTRIES.push(entry);
}

export function allGames(): readonly GameCatalogueEntry[] {
  return ENTRIES;
}

export function findGame(id: string): GameCatalogueEntry | undefined {
  return ENTRIES.find((e) => e.definition.id === id);
}

/** The capability list sent to a peer during the handshake. */
export function gameCapabilities(): { id: string; version: number }[] {
  return ENTRIES.map((e) => ({ id: e.definition.id, version: e.definition.protocolVersion }));
}

export function gamesByMode(mode: GameMode): readonly GameCatalogueEntry[] {
  return ENTRIES.filter((e) => e.definition.mode === mode);
}

export function gamesByCategory(category: GameCategory): readonly GameCatalogueEntry[] {
  return ENTRIES.filter((e) => e.category === category);
}

/** Every category that currently has a game in it, in shelf order. */
export function populatedCategories(): readonly GameCategory[] {
  const order: GameCategory[] = [
    GameCategory.QUICK,
    GameCategory.STRATEGY,
    GameCategory.WORDS,
    GameCategory.TRIVIA,
    GameCategory.PUZZLES,
    GameCategory.PARTY,
    GameCategory.TOGETHER,
    GameCategory.REALTIME,
  ];
  return order.filter((category) => ENTRIES.some((e) => e.category === category));
}

/**
 * What to offer over the link that is actually up.
 *
 * Not a filter - nothing is hidden, and somebody who wants to try Pong over
 * Bluetooth is welcome to. It is an ORDER: on a slow link the games that will
 * feel good come first, and the ones that will feel broken stop being the
 * things a person sees first and forms an opinion of the whole app from.
 */
export function gamesForLink(highBandwidth: boolean): readonly GameCatalogueEntry[] {
  if (highBandwidth) return ENTRIES;
  const rank = (e: GameCatalogueEntry): number =>
    e.latencySensitivity === LatencySensitivity.HIGH ? 1 : 0;
  return [...ENTRIES].sort((a, b) => rank(a) - rank(b));
}

/** True when this game will feel wrong on the link described. */
export function needsBetterLink(entry: GameCatalogueEntry, highBandwidth: boolean): boolean {
  return !highBandwidth && entry.latencySensitivity === LatencySensitivity.HIGH;
}

/**
 * Games that fit in the time available.
 *
 * "We have twenty minutes before we land" is a real question, and the answer
 * used to require knowing every game in the list.
 */
export function gamesUnderMinutes(minutes: number): readonly GameCatalogueEntry[] {
  return ENTRIES.filter((e) => e.typicalMinutes <= minutes);
}

export type { GameAction };
