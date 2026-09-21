import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  Bandwidth,
  GameCategory,
  LatencySensitivity,
  allGames,
  needsBetterLink,
  populatedCategories,
  type GameCatalogueEntry,
} from '@airlink/games';
import type { AirLinkClient } from '../../client/AirLinkClient.js';

/**
 * Turning a list of games into something a person can choose from.
 *
 * With twelve games a single grid was fine. With thirty it is a thing to scroll
 * past, and the games somebody would actually enjoy on the link they actually
 * have are buried somewhere in the middle of it. Three ideas fix that, and none
 * of them hides anything:
 *
 *   SHELVES. Games are grouped by what kind of thing they are, so "something
 *   quick" and "something for the whole flight" are one tap apart.
 *
 *   FAVOURITES. Two people on a long flight play the same three games over and
 *   over. Those three belong at the top, chosen by them rather than by us.
 *
 *   THE LINK. Over Bluetooth, Pong is not a good time - tens of milliseconds of
 *   jitter on a paddle is the difference between a game and an argument. So a
 *   slow link reorders the catalogue rather than censoring it: the games that
 *   will feel good come first, and the ones that will not are marked, and
 *   remain perfectly possible to choose.
 */

const FAVOURITES_KEY = 'play.favourites';

/**
 * Favourites, held outside React.
 *
 * Written from a tap and read by two screens, so it follows the same shape as
 * the chat and invite centres rather than living in a component: SQLite is the
 * truth, this is a cache of it, and `useSyncExternalStore` keeps the interface
 * honest about when it changed.
 */
class FavouritesStore {
  private ids: readonly string[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly client: AirLinkClient) {
    this.ids = this.read();
  }

  private read(): readonly string[] {
    try {
      const raw = this.client.db.settings.getJson<string[]>(FAVOURITES_KEY, []);
      return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
    } catch {
      // A favourite is a convenience. Losing the list must never stop the tab
      // from opening.
      return [];
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  list = (): readonly string[] => this.ids;

  toggle(gameId: string): void {
    const next = this.ids.includes(gameId)
      ? this.ids.filter((id) => id !== gameId)
      : [...this.ids, gameId];
    this.ids = next;
    try {
      this.client.db.settings.setJson(FAVOURITES_KEY, next, Date.now());
    } catch {
      // Kept in memory for this run either way.
    }
    for (const listener of this.listeners) listener();
  }
}

const stores = new WeakMap<AirLinkClient, FavouritesStore>();

function favouritesFor(client: AirLinkClient): FavouritesStore {
  const existing = stores.get(client);
  if (existing) return existing;
  const created = new FavouritesStore(client);
  stores.set(client, created);
  return created;
}

const NO_FAVOURITES: readonly string[] = [];
const noSubscribe = (): (() => void) => (): void => undefined;
const noFavourites = (): readonly string[] => NO_FAVOURITES;

export function useFavourites(client: AirLinkClient | null): {
  ids: readonly string[];
  toggle: (gameId: string) => void;
  isFavourite: (gameId: string) => boolean;
} {
  const store = client ? favouritesFor(client) : null;
  const ids = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.list ?? noFavourites);
  const toggle = useCallback((gameId: string) => store?.toggle(gameId), [store]);
  const isFavourite = useCallback((gameId: string) => ids.includes(gameId), [ids]);
  return { ids, toggle, isFavourite };
}

/** How long somebody has. Chosen from the four answers people actually give. */
export const DurationFilter = {
  ANY: 'any',
  TWO: 2,
  FIVE: 5,
  TEN: 10,
  LONG: 20,
} as const;
export type DurationFilter = (typeof DurationFilter)[keyof typeof DurationFilter];

export interface Shelf {
  readonly key: string;
  readonly title: string;
  readonly entries: readonly GameCatalogueEntry[];
}

/** Human names for the shelves. Kept here so the screen holds no copy. */
export const CATEGORY_TITLE: Record<GameCategory, string> = {
  [GameCategory.QUICK]: 'Quick',
  [GameCategory.STRATEGY]: 'Strategy',
  [GameCategory.WORDS]: 'Words',
  [GameCategory.TRIVIA]: 'Trivia',
  [GameCategory.PUZZLES]: 'Puzzles',
  [GameCategory.PARTY]: 'Party',
  [GameCategory.TOGETHER]: 'Just the two of you',
  [GameCategory.REALTIME]: 'Real-time',
};

export const catalogueCopy = {
  favourites: 'Favourites',
  all: 'All games',
  random: 'Surprise us',
  anyLength: 'Any length',
  minutes: (n: number): string => `${n} min`,
  longer: '20 min +',
  /** Said once, above the grid, when the only link is a slow one. */
  slowLinkNote: 'On Bluetooth, turn-based games play best. Real-time ones are further down.',
  needsBetterLink: 'Best over Wi-Fi',
  favouriteOn: (name: string): string => `Remove ${name} from favourites`,
  favouriteOff: (name: string): string => `Add ${name} to favourites`,
} as const;

/**
 * The shelves to render, in order, for this link and this filter.
 *
 * Favourites first when there are any, then the categories that still have
 * something in them after filtering. A shelf with nothing on it is not rendered
 * at all - an empty "Puzzles" heading is worse than no heading.
 */
export function buildShelves(options: {
  favourites: readonly string[];
  duration: DurationFilter;
  highBandwidth: boolean;
}): readonly Shelf[] {
  const { favourites, duration, highBandwidth } = options;

  const fits = (entry: GameCatalogueEntry): boolean =>
    duration === DurationFilter.ANY ||
    (duration === DurationFilter.LONG
      ? entry.typicalMinutes >= DurationFilter.LONG
      : entry.typicalMinutes <= duration);

  const all = allGames().filter(fits);
  const shelves: Shelf[] = [];

  const favourited = all.filter((entry) => favourites.includes(entry.definition.id));
  if (favourited.length > 0) {
    shelves.push({ key: 'favourites', title: catalogueCopy.favourites, entries: favourited });
  }

  for (const category of populatedCategories()) {
    // Real-time games go last on a slow link. Not hidden: last, and marked.
    const entries = all.filter((entry) => entry.category === category);
    if (entries.length === 0) continue;
    shelves.push({ key: category, title: CATEGORY_TITLE[category], entries });
  }

  if (!highBandwidth) {
    const isRealtime = (shelf: Shelf): boolean => shelf.key === GameCategory.REALTIME;
    shelves.sort((a, b) => Number(isRealtime(a)) - Number(isRealtime(b)));
  }
  return shelves;
}

/**
 * One game, chosen for you.
 *
 * Deliberately never picks something that will feel broken on the link that is
 * up: "surprise us" handing back Air Hockey over Bluetooth would be a bad
 * surprise. Falls back to the whole list if that leaves nothing, which it
 * cannot in practice.
 */
export function randomGame(highBandwidth: boolean, pick: number): GameCatalogueEntry | null {
  const all = allGames();
  const suitable = all.filter((entry) => !needsBetterLink(entry, highBandwidth));
  const pool = suitable.length > 0 ? suitable : all;
  if (pool.length === 0) return null;
  return pool[Math.floor(pick * pool.length) % pool.length] ?? null;
}

/** Every duration filter, with its label, for a chip row. */
export function durationOptions(): readonly { value: DurationFilter; label: string }[] {
  return [
    { value: DurationFilter.ANY, label: catalogueCopy.anyLength },
    { value: DurationFilter.TWO, label: catalogueCopy.minutes(2) },
    { value: DurationFilter.FIVE, label: catalogueCopy.minutes(5) },
    { value: DurationFilter.TEN, label: catalogueCopy.minutes(10) },
    { value: DurationFilter.LONG, label: catalogueCopy.longer },
  ];
}

/** Whether to warn, above the grid, that this link suits turn-based games. */
export function useSlowLinkNote(highBandwidth: boolean): string | null {
  return useMemo(() => (highBandwidth ? null : catalogueCopy.slowLinkNote), [highBandwidth]);
}

export { Bandwidth, GameCategory, LatencySensitivity, needsBetterLink };
