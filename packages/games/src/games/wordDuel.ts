/**
 * Word Duel - a head-to-head word hunt on a shared 4x4 grid.
 *
 * Both players see the same sixteen letters and race to find words in them. A
 * word must be at least three letters and trace a path of adjacent cells
 * (diagonals count) without reusing a cell.
 *
 * The design decision worth explaining: a word found by BOTH players scores for
 * NEITHER. That single rule turns the game from "who types faster" into "who
 * sees what the other one missed", which is far more fun with someone sitting
 * next to you - and it makes the shared-reducer model a virtue rather than a
 * constraint, because both devices must hold every submission anyway to work
 * out the overlap.
 *
 * The grid comes from the shared seed, so both devices generate identical
 * letters with no exchange at all.
 */
import {
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
  type CborValue,
  type GameAction,
  type GameContext,
  type GameDefinition,
  type GameRandom,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';
import { MAX_WORD_LENGTH, MIN_WORD_LENGTH, isWord } from './wordList.js';

export const GRID_SIZE = 4;
export const CELL_COUNT = GRID_SIZE * GRID_SIZE;
/** Submissions allowed per player. Also the hard bound on state growth. */
export const MAX_SUBMISSIONS_PER_PLAYER = 60;

/**
 * Letter frequencies, weighted so a grid is actually playable.
 *
 * A uniform draw over the alphabet produces grids full of Q, X and Z that
 * contain almost no words. These weights follow English letter frequency, with
 * vowels boosted a little further because a Boggle-style grid lives or dies on
 * having enough of them.
 */
const LETTER_WEIGHTS: readonly (readonly [string, number])[] = [
  ['a', 90], ['b', 20], ['c', 32], ['d', 42], ['e', 120], ['f', 22], ['g', 24],
  ['h', 34], ['i', 88], ['j', 3], ['k', 11], ['l', 50], ['m', 28], ['n', 68],
  ['o', 82], ['p', 24], ['q', 2], ['r', 64], ['s', 66], ['t', 72], ['u', 42],
  ['v', 10], ['w', 14], ['x', 2], ['y', 22], ['z', 2],
];

const TOTAL_WEIGHT = LETTER_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

function drawLetter(random: GameRandom): string {
  let n = random.nextInt(TOTAL_WEIGHT);
  for (const [letter, weight] of LETTER_WEIGHTS) {
    if (n < weight) return letter;
    n -= weight;
  }
  return 'e';
}

/**
 * Score by length. Steeply progressive, so finding one seven-letter word beats
 * grinding out five three-letter ones - which is what makes the game tense
 * rather than a typing race.
 */
export function scoreForLength(length: number): number {
  if (length <= 4) return 1;
  if (length === 5) return 2;
  if (length === 6) return 3;
  if (length === 7) return 5;
  return 11;
}

export interface Submission {
  readonly player: PlayerId;
  readonly word: string;
  readonly path: readonly number[];
}

export interface WordDuelState {
  readonly players: readonly PlayerId[];
  /** Sixteen lowercase letters, row-major. */
  readonly grid: readonly string[];
  readonly submissions: readonly Submission[];
  /** True once every player has declared themselves finished. */
  readonly finishedBy: readonly PlayerId[];
  /**
   * How many submissions were in when the FIRST player stopped playing.
   *
   * The cancellation rule - a word both players found scores for neither -
   * needs a boundary, and without one it punished exactly the wrong person.
   * A player who finished early sat and watched their words be cancelled one
   * by one by an opponent who could take as long as they liked, and there was
   * no clock to stop it. Nothing you do after somebody has put their pencil
   * down should be able to take their points away.
   *
   * So cancellation only applies among the words found while BOTH were still
   * hunting. A word the late finisher finds afterwards still scores for them;
   * it simply cannot reach back.
   *
   * -1 until somebody finishes.
   */
  readonly openUntil: number;
}

export interface WordDuelAction extends GameAction {
  readonly type: 'submit' | 'finish';
  readonly payload: { readonly word: string; readonly path: number[] } | null;
}

/** Neighbours of a cell, including diagonals. */
export function neighbours(cell: number): number[] {
  const row = Math.floor(cell / GRID_SIZE);
  const col = cell % GRID_SIZE;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) continue;
      out.push(r * GRID_SIZE + c);
    }
  }
  return out;
}

/** Does `path` spell `word` by walking adjacent, non-repeating cells? */
export function pathSpells(grid: readonly string[], word: string, path: readonly number[]): boolean {
  if (path.length !== word.length) return false;
  const seen = new Set<number>();
  for (let i = 0; i < path.length; i++) {
    const cell = path[i] as number;
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) return false;
    if (seen.has(cell)) return false;
    seen.add(cell);
    if (grid[cell] !== word[i]) return false;
    if (i > 0 && !neighbours(path[i - 1] as number).includes(cell)) return false;
  }
  return true;
}

/** Per-player score, with words found by everyone cancelled out. */
export function scores(state: WordDuelState): Map<PlayerId, number> {
  const counts = new Map<string, Set<PlayerId>>();
  // Only the words found while everybody was still playing can cancel. See
  // `WordDuelState.openUntil`.
  const boundary = state.openUntil < 0 ? state.submissions.length : state.openUntil;
  for (let i = 0; i < boundary; i++) {
    const s = state.submissions[i] as Submission;
    let holders = counts.get(s.word);
    if (!holders) {
      holders = new Set();
      counts.set(s.word, holders);
    }
    holders.add(s.player);
  }

  const totals = new Map<PlayerId, number>();
  for (const player of state.players) totals.set(player, 0);
  for (let i = 0; i < state.submissions.length; i++) {
    const s = state.submissions[i] as Submission;
    const holders = i < boundary ? counts.get(s.word) : undefined;
    // Found by everyone, while everyone was still looking: it cancels.
    if (holders && holders.size === state.players.length) continue;
    totals.set(s.player, (totals.get(s.player) ?? 0) + scoreForLength(s.word.length));
  }
  return totals;
}

/** Words this player has already banked - used to reject a duplicate. */
function wordsBy(state: WordDuelState, player: PlayerId): Set<string> {
  const out = new Set<string>();
  for (const s of state.submissions) if (s.player === player) out.add(s.word);
  return out;
}

export const wordDuel: GameDefinition<WordDuelState, WordDuelAction> = {
  id: 'word-duel',
  name: 'Word Duel',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): WordDuelState {
    /*
     * The engine's generator, not a copy of it.
     *
     * There was a hand-rolled duplicate here - the same mulberry32, plus a
     * `shuffle` that returned its input untouched. Nothing called that shuffle,
     * which is the only reason it never produced a visible bug, but a second
     * implementation of the one thing in this codebase that MUST agree
     * byte-for-byte across two devices is not something to keep.
     */
    const random = new SeededGameRandom(setup.seed);

    const grid: string[] = [];
    for (let i = 0; i < CELL_COUNT; i++) grid.push(drawLetter(random));
    return { players: [...setup.players], grid, submissions: [], finishedBy: [], openUntil: -1 };
  },

  validateAction(state, action, _context: GameContext): ValidationResult {
    if (state.finishedBy.length >= state.players.length) return invalid('the round is over');
    if (!state.players.includes(action.player)) return invalid('not a player in this game');

    if (action.type === 'finish') {
      if (state.finishedBy.includes(action.player)) return invalid('already finished');
      return VALID;
    }

    if (action.type !== 'submit') return invalid(`unknown action "${String(action.type)}"`);
    if (state.finishedBy.includes(action.player)) return invalid('you have already finished');

    const payload = action.payload;
    if (!payload) return invalid('submit needs a word and a path');

    const word = payload.word;
    if (word.length < MIN_WORD_LENGTH) return invalid(`words must be at least ${MIN_WORD_LENGTH} letters`);
    if (word.length > MAX_WORD_LENGTH) return invalid(`words may be at most ${MAX_WORD_LENGTH} letters`);
    if (!/^[a-z]+$/.test(word)) return invalid('words must be plain lowercase letters');
    if (!isWord(word)) return invalid('that is not in the dictionary');
    if (!pathSpells(state.grid, word, payload.path)) return invalid('that path does not spell the word on this grid');

    if (wordsBy(state, action.player).has(word)) return invalid('you have already found that word');
    const mine = state.submissions.filter((s) => s.player === action.player).length;
    if (mine >= MAX_SUBMISSIONS_PER_PLAYER) return invalid('submission limit reached');

    return VALID;
  },

  applyAction(state, action): WordDuelState {
    if (action.type === 'finish') {
      const first = state.finishedBy.length === 0;
      return {
        ...state,
        finishedBy: [...state.finishedBy, action.player],
        openUntil: first ? state.submissions.length : state.openUntil,
      };
    }
    const payload = action.payload as { word: string; path: number[] };
    return {
      ...state,
      submissions: [...state.submissions, { player: action.player, word: payload.word, path: [...payload.path] }],
    };
  },

  status(state): GameStatus {
    if (state.finishedBy.length < state.players.length) return { kind: GameStatusKind.IN_PROGRESS };
    const totals = scores(state);
    let best = -1;
    let winners: PlayerId[] = [];
    for (const player of state.players) {
      const value = totals.get(player) ?? 0;
      if (value > best) {
        best = value;
        winners = [player];
      } else if (value === best) {
        winners.push(player);
      }
    }
    if (winners.length !== 1) return { kind: GameStatusKind.DRAW, reason: 'level on points' };
    return { kind: GameStatusKind.WON, winners, reason: `${best} points` };
  },

  /**
   * Both players hunt at once, so there is no turn. Returning null tells the
   * runtime and the UI exactly that.
   */
  currentTurn(): PlayerId | null {
    return null;
  },

  encodeState(state): CborValue {
    return {
      p: [...state.players],
      g: state.grid.join(''),
      s: state.submissions.map((s) => [s.player, s.word, [...s.path]] as CborValue),
      f: [...state.finishedBy],
      o: state.openUntil,
    };
  },

  decodeState(value): WordDuelState {
    const m = asMap(value, 'wordDuel.state');
    const gridText = asString(m.g, 'grid', CELL_COUNT);
    if (gridText.length !== CELL_COUNT) throw new Error('wordDuel: grid must have 16 letters');
    if (!/^[a-z]+$/.test(gridText)) throw new Error('wordDuel: grid must be lowercase letters');

    const players = asArray(m.p, 'players', 2).map((p) => asString(p, 'player', 64));
    const submissions = asArray(m.s, 'submissions', MAX_SUBMISSIONS_PER_PLAYER * 2).map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 3) throw new Error('wordDuel: malformed submission');
      const word = asString(entry[1] as CborValue, 'word', MAX_WORD_LENGTH);
      if (word.length < MIN_WORD_LENGTH || !/^[a-z]+$/.test(word)) throw new Error('wordDuel: bad word');
      const path = asArray(entry[2] as CborValue, 'path', MAX_WORD_LENGTH).map((c) =>
        asInt(c, 'path cell', 0, CELL_COUNT - 1),
      );
      const player = asString(entry[0] as CborValue, 'player', 64);
      // A submission credited to somebody who is not in this game would score
      // for a player the reducer has never heard of, and - worse - would count
      // towards the cancellation rule, silently deleting the real players'
      // words. Every string off the wire is checked against the seat list.
      if (!players.includes(player)) throw new Error('wordDuel: submission from a player not in this game');
      return { player, word, path };
    });

    const finishedBy = asArray(m.f ?? [], 'finishedBy', 2).map((p) => {
      const player = asString(p, 'player', 64);
      if (!players.includes(player)) throw new Error('wordDuel: finish from a player not in this game');
      return player;
    });

    return {
      players,
      grid: gridText.split(''),
      submissions,
      finishedBy,
      openUntil: m.o === undefined ? -1 : asInt(m.o, 'openUntil', -1, MAX_SUBMISSIONS_PER_PLAYER * 2),
    };
  },

  encodeAction(action): CborValue {
    if (action.type === 'finish') return encodeActionEnvelope({ ...action, payload: null });
    const payload = action.payload as { word: string; path: number[] };
    return encodeActionEnvelope({ ...action, payload: { w: payload.word, p: [...payload.path] } });
  },

  decodeAction(value, player): WordDuelAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type === 'finish') {
      return { type: 'finish', player, seq: envelope.seq, payload: null };
    }
    if (envelope.type !== 'submit') throw new Error(`wordDuel: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'wordDuel.payload');
    const word = asString(payload.w, 'word', MAX_WORD_LENGTH).toLowerCase();
    const path = asArray(payload.p, 'path', MAX_WORD_LENGTH).map((c) => asInt(c, 'path cell', 0, CELL_COUNT - 1));
    return { type: 'submit', player, seq: envelope.seq, payload: { word, path } };
  },
};

/**
 * Every word findable on a grid. Used by the UI to show what was missed once the
 * round ends, and by the tests to drive realistic play.
 *
 * Bounded by construction: the search only ever extends a path that is still a
 * prefix of some dictionary word, so it cannot blow up on a vowel-heavy grid.
 */
export function findAllWords(grid: readonly string[]): { word: string; path: number[] }[] {
  const found = new Map<string, number[]>();
  const prefixes = buildPrefixSet();

  const walk = (cell: number, path: number[], word: string): void => {
    if (word.length > MAX_WORD_LENGTH) return;
    if (word.length >= MIN_WORD_LENGTH && isWord(word) && !found.has(word)) found.set(word, [...path]);
    if (word.length === MAX_WORD_LENGTH) return;
    if (word.length >= 2 && !prefixes.has(word)) return;
    for (const next of neighbours(cell)) {
      if (path.includes(next)) continue;
      path.push(next);
      walk(next, path, word + grid[next]);
      path.pop();
    }
  };

  for (let cell = 0; cell < CELL_COUNT; cell++) walk(cell, [cell], grid[cell] as string);
  return [...found.entries()].map(([word, path]) => ({ word, path }));
}

let prefixCache: Set<string> | null = null;

function buildPrefixSet(): Set<string> {
  if (prefixCache) return prefixCache;
  const set = new Set<string>();
  // Only prefixes long enough to prune usefully; below that almost everything
  // is a prefix and the set is pure overhead.
  for (const word of DICTIONARY_FOR_PREFIXES) {
    for (let length = 2; length < word.length; length++) set.add(word.slice(0, length));
  }
  prefixCache = set;
  return set;
}

// Imported lazily via the module so the prefix set is built once, on first use,
// rather than at import time - a cold start should not pay for a feature the
// user may never open.
import { DICTIONARY as DICTIONARY_FOR_PREFIXES } from './wordList.js';
