/**
 * Draw & Guess. One player draws a secret word, everyone else types guesses.
 *
 * The interesting problems in this game are not the rules, they are the three
 * constraints the AirLink contract puts on it:
 *
 *  1. NO SERVER. Both devices must agree on the secret word without anyone
 *     handing it to them, so the word is derived from the shared seed at
 *     creation time (see `createInitialState`). Every device can therefore
 *     compute the answer; secrecy is a UI concern, not a cryptographic one, and
 *     the state deliberately makes that explicit rather than pretending
 *     otherwise. What we *can* enforce - and do - is that a correct or nearly
 *     correct guess never travels into the shared guess feed as plain text,
 *     because that feed is rendered on every screen (see `applyAction`).
 *
 *  2. ~180 USABLE BYTES PER PACKET. Strokes are the bulk of the traffic, so a
 *     stroke is a flat array of integer coordinates in a 0..1000 space with a
 *     4-bit colour index and a 3-bit width, not a list of {x, y} objects.
 *
 *  3. DETERMINISM. Every number in this game is an integer: coordinates,
 *     colours, widths, scores, round counters. There is no floating-point
 *     arithmetic in the state at all, so the "round the state each tick" rule
 *     for realtime games simply does not apply here - there is nothing that
 *     could drift. String comparison is likewise done with an explicit ASCII
 *     fold table rather than String.prototype.normalize, whose availability and
 *     data tables vary between JavaScript engines (Hermes builds without ICU in
 *     particular). Two devices must fold "DÉJÀ VU" to exactly the same bytes.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
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
  type GameAction,
  type GameDefinition,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';

// ---------------------------------------------------------------------------
// Limits. Every one of these is enforced twice: once in decodeAction, because
// the bytes came from an unauthenticated peer, and once in validateAction,
// because a state may also have arrived over the wire.
// ---------------------------------------------------------------------------

/** Points (x,y pairs) in a single stroke. A long swipe is split by the UI. */
export const MAX_POINTS_PER_STROKE = 200;
/** Strokes retained for one round's canvas. */
export const MAX_STROKES_PER_ROUND = 400;
/** Characters in a guess. */
export const MAX_GUESS_LENGTH = 64;
/** Guesses accepted in one round, across all players. Anti-spam. */
export const MAX_GUESSES_PER_ROUND = 200;
/** Guess feed entries kept in the shared state; older ones are dropped. */
export const GUESS_FEED_LIMIT = 40;
/** Upper bound on the configurable round count. */
export const MAX_ROUNDS = 24;
/** Drawing canvas is a 0..1000 square; the UI scales it to the real screen. */
export const MAX_COORD = 1000;
const MAX_COLOR = 15;
const MAX_WIDTH = 8;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const MAX_SCORE = 1_000_000;

// ---------------------------------------------------------------------------
// The built-in word list. NEVER fetched: an AirLink game has no network.
// 150 words across three tiers. Changing this list changes what a given seed
// draws, so it is part of the wire contract - bump protocolVersion if you edit
// it, or two devices on different app versions would draw different words.
// ---------------------------------------------------------------------------

export interface DrawWord {
  readonly word: string;
  /** 0 = easy, 1 = medium, 2 = hard. */
  readonly tier: 0 | 1 | 2;
}

const EASY: readonly string[] = [
  'cat', 'dog', 'sun', 'moon', 'star', 'tree', 'house', 'car', 'boat', 'fish',
  'bird', 'apple', 'banana', 'book', 'chair', 'table', 'door', 'hat', 'shoe', 'sock',
  'ball', 'cup', 'key', 'clock', 'flower', 'cloud', 'rain', 'snow', 'fire', 'heart',
  'eye', 'hand', 'foot', 'nose', 'smile', 'cake', 'pizza', 'egg', 'milk', 'bread',
  'spoon', 'fork', 'knife', 'bed', 'lamp', 'phone', 'train', 'plane', 'bike', 'kite',
];

const MEDIUM: readonly string[] = [
  'bridge', 'castle', 'camera', 'guitar', 'rocket', 'dragon', 'ladder', 'mountain',
  'island', 'volcano', 'penguin', 'octopus', 'giraffe', 'dolphin', 'butterfly',
  'spider web', 'campfire', 'lighthouse', 'windmill', 'treasure chest', 'pirate ship',
  'submarine', 'telescope', 'umbrella', 'backpack', 'sandwich', 'popcorn', 'ice cream',
  'sunglasses', 'snowman', 'scarecrow', 'skeleton', 'vampire', 'robot', 'alien',
  'wizard', 'knight', 'mermaid', 'unicorn', 'dinosaur', 'elephant', 'kangaroo',
  'tornado', 'rainbow', 'waterfall', 'hourglass', 'jungle', 'canyon', 'glacier', 'harbour',
];

const HARD: readonly string[] = [
  'gravity', 'jealousy', 'nostalgia', 'deadline', 'teamwork', 'democracy', 'inflation',
  'evolution', 'symphony', 'algorithm', 'gossip', 'insomnia', 'procrastination',
  'camouflage', 'hibernation', 'migration', 'recycling', 'photosynthesis', 'magnetism',
  'echo', 'mirage', 'eclipse', 'hurricane', 'avalanche', 'quicksand', 'labyrinth',
  'kaleidoscope', 'metronome', 'chandelier', 'gargoyle', 'harpsichord', 'marionette',
  'origami', 'calligraphy', 'acupuncture', 'taxidermy', 'philosophy', 'bureaucracy',
  'capitalism', 'superstition', 'telepathy', 'hypnosis', 'allergy', 'vertigo',
  'déjà vu', 'escalator', 'revolving door', 'time travel', 'black hole', 'parallel universe',
];

function tierOf(words: readonly string[], tier: 0 | 1 | 2): DrawWord[] {
  return words.map((word) => ({ word, tier }));
}

export const WORDS: readonly DrawWord[] = [
  ...tierOf(EASY, 0),
  ...tierOf(MEDIUM, 1),
  ...tierOf(HARD, 2),
];

// ---------------------------------------------------------------------------
// Guess normalisation
// ---------------------------------------------------------------------------

/**
 * Accent fold table, written out by hand on purpose.
 *
 * `"é".normalize('NFD')` is the usual trick, but normalize() depends on the
 * engine's Unicode tables and is absent from ICU-less Hermes builds. If one
 * device folded an accent and the other did not, the same guess would score on
 * one phone and not on the other - a divergence bug that would only ever show
 * up on someone else's handset. An explicit table is boring and identical
 * everywhere, which is exactly what this needs to be.
 */
function buildFoldTable(): ReadonlyMap<string, string> {
  const groups: readonly (readonly [string, string])[] = [
    ['àáâãäåāăą', 'a'],
    ['çćĉċč', 'c'],
    ['ďđ', 'd'],
    ['èéêëēĕėęě', 'e'],
    ['ĝğġģ', 'g'],
    ['ĥħ', 'h'],
    ['ìíîïĩīĭįı', 'i'],
    ['ĵ', 'j'],
    ['ķ', 'k'],
    ['ĺļľłŀ', 'l'],
    ['ñńņňŉ', 'n'],
    ['òóôõöøōŏő', 'o'],
    ['ŕŗř', 'r'],
    ['śŝşš', 's'],
    ['ţťŧ', 't'],
    ['ùúûüũūŭůűų', 'u'],
    ['ŵ', 'w'],
    ['ýÿŷ', 'y'],
    ['žźż', 'z'],
    ['ß', 'ss'],
    ['æ', 'ae'],
    ['œ', 'oe'],
  ];
  const table = new Map<string, string>();
  for (const [chars, replacement] of groups) {
    for (const ch of chars) table.set(ch, replacement);
  }
  return table;
}

const FOLD = buildFoldTable();

/**
 * Case-insensitive, accent-insensitive, punctuation-insensitive comparison key.
 *
 * "  DÉJÀ-VU!! " and "deja vu" both fold to "deja vu". Runs of whitespace
 * collapse to a single space and anything that is not a letter or a digit is
 * dropped, so a guesser is not punished for a stray emoji or a trailing "?".
 */
export function normaliseGuess(raw: string): string {
  let out = '';
  let pendingSpace = false;
  for (const ch of raw.toLowerCase()) {
    const folded = FOLD.get(ch) ?? ch;
    for (const c of folded) {
      // A soft keyboard may send a decomposed accent ("e" + U+0301) where
      // another sends the precomposed "é". Combining marks are dropped rather
      // than treated as a word break, so both spellings fold to the same key.
      const code = c.codePointAt(0) ?? 0;
      if (code >= 0x0300 && code <= 0x036f) continue;
      const isWord = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
      if (isWord) {
        if (pendingSpace && out.length > 0) out += ' ';
        pendingSpace = false;
        out += c;
      } else {
        // Everything else - spaces, hyphens, punctuation, emoji - is a break.
        pendingSpace = true;
      }
    }
  }
  return out;
}

/**
 * Classic two-row Levenshtein. Integer arithmetic only, and both inputs are
 * bounded (a guess by MAX_GUESS_LENGTH, a word by the built-in list), so this
 * is a few thousand integer operations in the worst case.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous: number[] = [];
  for (let j = 0; j <= b.length; j++) previous.push(j);
  let current: number[] = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] as number;
}

/** A guess one edit away from the answer: right idea, wrong spelling. */
export function isCloseGuess(guess: string, answer: string): boolean {
  if (guess === answer) return false;
  if (Math.abs(guess.length - answer.length) > 1) return false;
  return levenshtein(guess, answer) === 1;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const GuessKind = {
  WRONG: 0,
  /** One edit away. The text is withheld - it would practically be the answer. */
  CLOSE: 1,
  CORRECT: 2,
} as const;
export type GuessKind = (typeof GuessKind)[keyof typeof GuessKind];

export interface GuessEntry {
  /** Index into `players`, not a name: shorter on the wire and unforgeable. */
  readonly player: number;
  readonly kind: GuessKind;
  /**
   * The guess as typed - but ONLY for a wrong guess. A close or correct guess
   * carries the empty string, because this feed is rendered on every device.
   */
  readonly text: string;
}

export interface Stroke {
  /** Flat [x0, y0, x1, y1, ...], integers in 0..1000. */
  readonly points: readonly number[];
  /** Palette index 0..15. The palette itself lives in the UI. */
  readonly color: number;
  /** Brush width 1..8. */
  readonly width: number;
}

export interface DrawAndGuessState {
  readonly players: readonly PlayerId[];
  /** Rounds in the whole game. Defaults to one per player. */
  readonly totalRounds: number;
  /** 0-based. Equal to `totalRounds` once the game is over. */
  readonly round: number;
  /** Word index per round, drawn from the seed. See createInitialState. */
  readonly words: readonly number[];
  readonly strokes: readonly Stroke[];
  readonly guesses: readonly GuessEntry[];
  /**
   * Per player: have they already solved this round? A BOOLEAN, never the text
   * they sent. If we stored the winning guess, every other device would render
   * the answer in its chat feed the instant somebody got it.
   */
  readonly solved: readonly boolean[];
  /** Guesses submitted this round, including wrong ones. */
  readonly guessCount: number;
  /** Cumulative score per player. */
  readonly scores: readonly number[];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface StrokeAction extends GameAction {
  readonly type: 'stroke';
  readonly payload: { readonly points: number[]; readonly color: number; readonly width: number };
}
export interface UndoAction extends GameAction {
  readonly type: 'undo';
  readonly payload: null;
}
export interface ClearAction extends GameAction {
  readonly type: 'clear';
  readonly payload: null;
}
export interface GuessAction extends GameAction {
  readonly type: 'guess';
  readonly payload: { readonly text: string };
}
export interface EndRoundAction extends GameAction {
  readonly type: 'endRound';
  readonly payload: null;
}

export type DrawAndGuessAction = StrokeAction | UndoAction | ClearAction | GuessAction | EndRoundAction;

// ---------------------------------------------------------------------------
// Derived helpers, exported for the UI and the tests
// ---------------------------------------------------------------------------

export function isFinished(state: DrawAndGuessState): boolean {
  return state.round >= state.totalRounds;
}

function drawerIndex(state: DrawAndGuessState): number {
  return state.round % state.players.length;
}

/** Whoever is drawing this round. Rounds rotate through the player list. */
export function currentDrawer(state: DrawAndGuessState): PlayerId | null {
  if (isFinished(state)) return null;
  return state.players[drawerIndex(state)] ?? null;
}

/**
 * The secret word for this round.
 *
 * Every device can call this - with no server there is nowhere else for the
 * word to live. The UI must show it to the drawer only, and to everyone once
 * the round is over.
 */
export function currentWord(state: DrawAndGuessState): string | null {
  if (isFinished(state)) return null;
  const index = state.words[state.round];
  if (index === undefined) return null;
  return WORDS[index]?.word ?? null;
}

/** Points for the Nth player to solve a round: 3, then 2, then 1 each. */
function solveReward(alreadySolved: number): number {
  if (alreadySolved === 0) return 3;
  if (alreadySolved === 1) return 2;
  return 1;
}

function clampScore(value: number): number {
  return value > MAX_SCORE ? MAX_SCORE : value;
}

/** Reset the canvas and the guess feed, then hand the pen to the next player. */
function startNextRound(state: DrawAndGuessState): DrawAndGuessState {
  return {
    ...state,
    round: state.round + 1,
    strokes: [],
    guesses: [],
    solved: state.players.map(() => false),
    guessCount: 0,
  };
}

function strokePayloadProblem(payload: StrokeAction['payload']): string | null {
  const { points, color, width } = payload;
  if (!Array.isArray(points)) return 'a stroke needs a points array';
  if (points.length < 2) return 'a stroke needs at least one point';
  if (points.length % 2 !== 0) return 'stroke points must be whole x,y pairs';
  if (points.length > MAX_POINTS_PER_STROKE * 2) return `a stroke may hold at most ${MAX_POINTS_PER_STROKE} points`;
  for (const value of points) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_COORD) {
      return `stroke coordinates must be integers 0-${MAX_COORD}`;
    }
  }
  if (!Number.isInteger(color) || color < 0 || color > MAX_COLOR) return 'colour must be 0-15';
  if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH) return 'width must be 1-8';
  return null;
}

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

export const drawAndGuess: GameDefinition<DrawAndGuessState, DrawAndGuessAction> = {
  id: 'draw-and-guess',
  name: 'Draw & Guess',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,

  createInitialState(setup: GameSetup): DrawAndGuessState {
    const players = [...setup.players];
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
      throw new Error(`drawAndGuess: supports ${MIN_PLAYERS}-${MAX_PLAYERS} players, got ${players.length}`);
    }

    const roundsOption = setup.options.rounds;
    const totalRounds =
      typeof roundsOption === 'number' && Number.isInteger(roundsOption) && roundsOption >= 1 && roundsOption <= MAX_ROUNDS
        ? roundsOption
        : players.length;

    const difficulty = setup.options.difficulty;
    const tier = difficulty === 'easy' ? 0 : difficulty === 'medium' ? 1 : difficulty === 'hard' ? 2 : null;
    const pool: number[] = [];
    for (let i = 0; i < WORDS.length; i++) {
      if (tier === null || WORDS[i]?.tier === tier) pool.push(i);
    }
    if (pool.length === 0) throw new Error('drawAndGuess: the word list is empty');

    // The words are drawn HERE, once, from the shared seed - the same generator
    // the runtime seeds `context.random` with. Doing it at creation rather than
    // when each round starts means the draw cannot be perturbed by how many
    // random numbers earlier actions happened to consume, which differs between
    // a live session and a replayed action log. Both devices see the same list.
    const random = new SeededGameRandom(setup.seed);
    const order = random.shuffle(pool);
    const words: number[] = [];
    for (let r = 0; r < totalRounds; r++) words.push(order[r % order.length] as number);

    return {
      players,
      totalRounds,
      round: 0,
      words,
      strokes: [],
      guesses: [],
      solved: players.map(() => false),
      guessCount: 0,
      scores: players.map(() => 0),
    };
  },

  validateAction(state, action): ValidationResult {
    if (isFinished(state)) return invalid('the game has already finished');

    const index = state.players.indexOf(action.player);
    if (index < 0) return invalid(`${action.player} is not in this game`);
    const drawer = state.players[drawerIndex(state)];
    const isDrawer = action.player === drawer;

    switch (action.type) {
      case 'stroke': {
        if (!isDrawer) return invalid(`only the drawer (${String(drawer)}) may draw`);
        if (state.strokes.length >= MAX_STROKES_PER_ROUND) return invalid('the canvas is full for this round');
        const problem = strokePayloadProblem(action.payload);
        return problem === null ? VALID : invalid(problem);
      }
      case 'undo': {
        if (!isDrawer) return invalid(`only the drawer (${String(drawer)}) may undo`);
        if (state.strokes.length === 0) return invalid('there is nothing to undo');
        return VALID;
      }
      case 'clear': {
        if (!isDrawer) return invalid(`only the drawer (${String(drawer)}) may clear the canvas`);
        if (state.strokes.length === 0) return invalid('the canvas is already empty');
        return VALID;
      }
      case 'endRound': {
        // The round timer is a UI concern, not a state one: a turn-based game
        // gets tickMs = 0 and elapsedMs = 0 from the runtime, so a deadline
        // stored here would be a clock that never advances. The drawer's device
        // runs the countdown and sends this exact action when it expires, which
        // keeps the reducer clock-free and every device in step.
        if (!isDrawer) return invalid(`only the drawer (${String(drawer)}) may end the round`);
        return VALID;
      }
      case 'guess': {
        if (isDrawer) return invalid('the drawer cannot guess their own word');
        if (state.solved[index] === true) return invalid('you have already solved this round');
        if (state.guessCount >= MAX_GUESSES_PER_ROUND) return invalid('too many guesses this round');
        const text = action.payload.text;
        if (typeof text !== 'string') return invalid('a guess must be text');
        if (text.length > MAX_GUESS_LENGTH) return invalid(`a guess may be at most ${MAX_GUESS_LENGTH} characters`);
        if (normaliseGuess(text).length === 0) return invalid('a guess cannot be empty');
        return VALID;
      }
      default:
        return invalid(`unknown action "${(action as GameAction).type}"`);
    }
  },

  applyAction(state, action): DrawAndGuessState {
    switch (action.type) {
      case 'stroke': {
        const stroke: Stroke = {
          points: [...action.payload.points],
          color: action.payload.color,
          width: action.payload.width,
        };
        return { ...state, strokes: [...state.strokes, stroke] };
      }

      case 'undo':
        return { ...state, strokes: state.strokes.slice(0, state.strokes.length - 1) };

      case 'clear':
        return { ...state, strokes: [] };

      case 'endRound':
        return startNextRound(state);

      case 'guess': {
        const index = state.players.indexOf(action.player);
        const answer = normaliseGuess(currentWord(state) ?? '');
        const guess = normaliseGuess(action.payload.text);
        const guessCount = state.guessCount + 1;

        if (guess !== answer) {
          // A close guess is one character off, so echoing it would hand the
          // word to everyone watching the feed. Wrong guesses are the actual
          // fun of the game and travel in full.
          const close = isCloseGuess(guess, answer);
          const entry: GuessEntry = {
            player: index,
            kind: close ? GuessKind.CLOSE : GuessKind.WRONG,
            text: close ? '' : action.payload.text.trim().slice(0, MAX_GUESS_LENGTH),
          };
          return {
            ...state,
            guesses: [...state.guesses, entry].slice(-GUESS_FEED_LIMIT),
            guessCount,
          };
        }

        // Correct. The word itself never enters the feed - only the fact that
        // this player got it, as a boolean in `solved`.
        const alreadySolved = state.solved.filter((s) => s).length;
        const solved = [...state.solved];
        solved[index] = true;
        const scores = [...state.scores];
        scores[index] = clampScore((scores[index] ?? 0) + solveReward(alreadySolved));
        const drawer = drawerIndex(state);
        scores[drawer] = clampScore((scores[drawer] ?? 0) + 1);

        const entry: GuessEntry = { player: index, kind: GuessKind.CORRECT, text: '' };
        const next: DrawAndGuessState = {
          ...state,
          guesses: [...state.guesses, entry].slice(-GUESS_FEED_LIMIT),
          guessCount,
          solved,
          scores,
        };

        // Everyone but the drawer has it: no reason to keep drawing.
        const everyoneSolved = next.solved.every((s, i) => s || i === drawer);
        return everyoneSolved ? startNextRound(next) : next;
      }

      default:
        return state;
    }
  },

  status(state): GameStatus {
    if (!isFinished(state)) return { kind: GameStatusKind.IN_PROGRESS };
    let best = -1;
    for (const score of state.scores) if (score > best) best = score;
    const winners = state.players.filter((_, i) => state.scores[i] === best);
    if (winners.length === state.players.length) {
      return { kind: GameStatusKind.DRAW, reason: 'everyone finished level' };
    }
    return { kind: GameStatusKind.WON, winners, reason: 'highest score' };
  },

  /**
   * Null on purpose, and not because the game is unfinished.
   *
   * A round is not one player's turn: the drawer draws while everybody else
   * types guesses, all at the same time. Squeezing that into a single "whose
   * turn is it" answer would lie to the runtime and stop guessers acting. The
   * UI asks `currentDrawer(state)` instead, which is the question it actually
   * has - and `validateAction` is what keeps each player to their own role.
   */
  currentTurn(): PlayerId | null {
    return null;
  },

  encodeState(state): CborValue {
    // `solved` becomes a bitmask: at most 6 players, so it is one small integer
    // instead of an array of CBOR booleans.
    let solvedMask = 0;
    for (let i = 0; i < state.solved.length; i++) if (state.solved[i]) solvedMask |= 1 << i;

    return {
      p: [...state.players],
      n: state.totalRounds,
      r: state.round,
      w: [...state.words],
      k: state.strokes.map((s) => ({ p: [...s.points], c: s.color, w: s.width })),
      g: state.guesses.map((e) => ({ i: e.player, k: e.kind, t: e.text })),
      v: solvedMask,
      c: state.guessCount,
      s: [...state.scores],
    };
  },

  decodeState(value): DrawAndGuessState {
    const m = asMap(value, 'drawAndGuess.state');

    const players = asArray(m.p, 'state.players', MAX_PLAYERS).map((p, i) => asString(p, `state.players[${i}]`, 128));
    if (players.length < MIN_PLAYERS) throw new GameDecodeError('state.players: too few players');

    const totalRounds = asInt(m.n, 'state.totalRounds', 1, MAX_ROUNDS);
    const round = asInt(m.r, 'state.round', 0, totalRounds);

    const words = asArray(m.w, 'state.words', MAX_ROUNDS).map((w, i) =>
      asInt(w, `state.words[${i}]`, 0, WORDS.length - 1),
    );
    if (words.length !== totalRounds) throw new GameDecodeError('state.words: one word per round is required');

    const strokes = asArray(m.k, 'state.strokes', MAX_STROKES_PER_ROUND).map((raw, i) => {
      const s = asMap(raw, `state.strokes[${i}]`);
      const points = asArray(s.p, `state.strokes[${i}].points`, MAX_POINTS_PER_STROKE * 2).map((n, j) =>
        asInt(n, `state.strokes[${i}].points[${j}]`, 0, MAX_COORD),
      );
      if (points.length < 2 || points.length % 2 !== 0) {
        throw new GameDecodeError(`state.strokes[${i}].points: expected whole x,y pairs`);
      }
      return {
        points,
        color: asInt(s.c, `state.strokes[${i}].color`, 0, MAX_COLOR),
        width: asInt(s.w, `state.strokes[${i}].width`, 1, MAX_WIDTH),
      } satisfies Stroke;
    });

    const guesses = asArray(m.g, 'state.guesses', GUESS_FEED_LIMIT).map((raw, i) => {
      const e = asMap(raw, `state.guesses[${i}]`);
      const kind = asInt(e.k, `state.guesses[${i}].kind`, 0, 2) as GuessKind;
      const text = asString(e.t, `state.guesses[${i}].text`, MAX_GUESS_LENGTH);
      // A peer must not be able to smuggle the answer into everyone's feed by
      // labelling it "correct" or "close" and attaching the text anyway.
      if (kind !== GuessKind.WRONG && text.length > 0) {
        throw new GameDecodeError(`state.guesses[${i}]: a solved guess must not carry text`);
      }
      return {
        player: asInt(e.i, `state.guesses[${i}].player`, 0, players.length - 1),
        kind,
        text,
      } satisfies GuessEntry;
    });

    const solvedMask = asInt(m.v, 'state.solved', 0, (1 << players.length) - 1);
    const solved = players.map((_, i) => (solvedMask & (1 << i)) !== 0);

    const scores = asArray(m.s, 'state.scores', MAX_PLAYERS).map((s, i) =>
      asInt(s, `state.scores[${i}]`, 0, MAX_SCORE),
    );
    if (scores.length !== players.length) throw new GameDecodeError('state.scores: one score per player is required');

    return {
      players,
      totalRounds,
      round,
      words,
      strokes,
      guesses,
      solved,
      guessCount: asInt(m.c, 'state.guessCount', 0, MAX_GUESSES_PER_ROUND),
      scores,
    };
  },

  encodeAction(action): CborValue {
    switch (action.type) {
      case 'stroke':
        return encodeActionEnvelope({
          ...action,
          payload: { p: [...action.payload.points], c: action.payload.color, w: action.payload.width },
        });
      case 'guess':
        return encodeActionEnvelope({ ...action, payload: { g: action.payload.text } });
      default:
        // undo / clear / endRound carry nothing at all: 3 bytes of payload.
        return encodeActionEnvelope({ ...action, payload: null });
    }
  },

  decodeAction(value, player): DrawAndGuessAction {
    const envelope = decodeActionEnvelope(value, player);
    switch (envelope.type) {
      case 'stroke': {
        const p = asMap(envelope.payload, 'drawAndGuess.stroke');
        const raw = asArray(p.p, 'stroke.points', MAX_POINTS_PER_STROKE * 2);
        if (raw.length < 2 || raw.length % 2 !== 0) {
          throw new GameDecodeError('stroke.points: expected whole x,y pairs');
        }
        const points = raw.map((n, i) => asInt(n, `stroke.points[${i}]`, 0, MAX_COORD));
        return {
          type: 'stroke',
          player,
          seq: envelope.seq,
          payload: {
            points,
            color: asInt(p.c, 'stroke.color', 0, MAX_COLOR),
            width: asInt(p.w, 'stroke.width', 1, MAX_WIDTH),
          },
        };
      }
      case 'guess': {
        const p = asMap(envelope.payload, 'drawAndGuess.guess');
        return {
          type: 'guess',
          player,
          seq: envelope.seq,
          payload: { text: asString(p.g, 'guess.text', MAX_GUESS_LENGTH) },
        };
      }
      case 'undo':
        return { type: 'undo', player, seq: envelope.seq, payload: null };
      case 'clear':
        return { type: 'clear', player, seq: envelope.seq, payload: null };
      case 'endRound':
        return { type: 'endRound', player, seq: envelope.seq, payload: null };
      default:
        throw new GameDecodeError(`drawAndGuess: unknown action "${envelope.type}"`);
    }
  },
};
