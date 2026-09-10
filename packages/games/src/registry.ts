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

export interface GameCatalogueEntry {
  readonly definition: GameDefinition<never, never>;
  /** One line shown under the name in the picker. */
  readonly blurb: string;
  /** Roughly how long a game takes, for the picker. */
  readonly typicalMinutes: number;
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
  },
  {
    definition: anyGame(connectFour),
    blurb: 'Drop, stack, and line up four.',
    typicalMinutes: 3,
  },
  {
    definition: anyGame(reaction),
    blurb: 'Wait for green. Do not blink.',
    typicalMinutes: 2,
  },
  {
    definition: anyGame(pong),
    blurb: 'The original. First to seven.',
    typicalMinutes: 4,
  },
  {
    definition: anyGame(airHockey),
    blurb: 'Fast, loud, and over quickly.',
    typicalMinutes: 4,
  },
  {
    definition: anyGame(drawAndGuess),
    blurb: 'Draw it. Watch them fail to get it.',
    typicalMinutes: 8,
  },
  {
    definition: anyGame(trivia),
    blurb: 'Ten questions. No looking anything up.',
    typicalMinutes: 6,
  },
  {
    definition: anyGame(darts),
    blurb: '501, and you must finish on a double.',
    typicalMinutes: 8,
  },
  {
    definition: anyGame(battleship),
    blurb: 'Hide a fleet. Find theirs first.',
    typicalMinutes: 10,
  },
  {
    definition: anyGame(pool),
    blurb: 'Solids, stripes, and the black.',
    typicalMinutes: 10,
  },
  {
    definition: anyGame(wordDuel),
    blurb: 'Sixteen letters. Find what they missed.',
    typicalMinutes: 5,
  },
  {
    definition: anyGame(chess),
    blurb: 'The long flight game.',
    typicalMinutes: 25,
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

export type { GameAction };
