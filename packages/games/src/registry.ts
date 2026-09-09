/**
 * The game catalogue.
 *
 * Registering a game here is the ONLY thing needed to make it appear in the
 * Play tab, be offered in capability exchange, and be playable. There is no
 * second list to keep in sync, which is what stops a button existing for a game
 * that is not really there.
 */
import type { GameAction, GameDefinition, GameMode } from './engine.js';
import { ticTacToe } from './games/ticTacToe.js';

export interface GameCatalogueEntry {
  readonly definition: GameDefinition<never, never>;
  /** Emoji used as the tile icon until real artwork exists. */
  readonly icon: string;
  /** One line shown under the name in the picker. */
  readonly blurb: string;
  /** Roughly how long a game takes, for the picker. */
  readonly typicalMinutes: number;
}

const ENTRIES: GameCatalogueEntry[] = [
  {
    definition: ticTacToe as unknown as GameDefinition<never, never>,
    icon: '⭕️',
    blurb: 'Three in a row. One minute, one winner.',
    typicalMinutes: 1,
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
