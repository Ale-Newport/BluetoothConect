/**
 * Word Chain. Each word must begin with the letter the last one ended on.
 *
 * Shaped exactly like the reference game (src/games/ticTacToe.ts): an immutable
 * state, discriminated actions, a validator that assumes the peer is hostile, a
 * pure reducer, and codecs that treat the wire as bytes from an attacker.
 *
 * Three rules decide the whole design, and each had a losing alternative:
 *
 *   A PASS LOSES. The alternative - a pass that merely skips your turn - lets a
 *   player who is out of ideas stall for ever, and gives the reducer no way to
 *   ever reach a terminal status. Making the pass an admission of defeat turns
 *   "I am stuck" into a move with a consequence, which is also the only honest
 *   thing to do with a player who simply stops thinking.
 *
 *   THIRTY WORDS IS A DRAW. Something has to bound the game or two stubborn
 *   players chain words all flight. A wall clock is not available: a turn-based
 *   game gets tickMs 0 and elapsedMs 0, by design, so the only quantity the
 *   reducer can count deterministically is words. Thirty is roughly fifteen
 *   turns each, which is long enough for the chain to get genuinely hard.
 *
 *   DEAD-END LETTERS ARE NOT SPECIAL-CASED. The bundled dictionary contains
 *   seventeen words ending in "x" and not one word beginning with it, so
 *   playing "apex" hands your opponent a position with no legal reply and they
 *   must pass. That is a real tactic, not a bug, and inventing an exemption for
 *   it would only make the rules harder to explain than to play.
 *
 * Case is settled in decodeAction, the single gate every action passes through:
 * the runtime deliberately routes a LOCAL move through encodeAction ->
 * decodeAction too, so a word is lowercased once, identically on both devices,
 * before any rule looks at it. That is what stops "ACE" and "ace" becoming two
 * separate entries in one chain. Everything else about a word - its length, its
 * alphabet, its membership of the dictionary - belongs to validateAction, which
 * the contract requires to stand on its own rather than lean on how the action
 * happened to arrive.
 */
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
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
  type GameDefinition,
  type GameRandom,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';
import { DICTIONARY, MAX_WORD_LENGTH, MIN_WORD_LENGTH, isWord } from './wordList.js';

/** Words after which the chain is declared a draw. See the header. */
export const WORD_LIMIT = 30;

export interface WordChainState {
  readonly players: readonly PlayerId[];
  /** The chain so far, lowercase, oldest first. Bounded by WORD_LIMIT. */
  readonly words: readonly string[];
  readonly turnIndex: number;
  /** The player who passed, and therefore lost. Null while the chain lives. */
  readonly loser: PlayerId | null;
}

export interface WordChainPlayAction extends GameAction {
  readonly type: 'play';
  readonly payload: { readonly word: string };
}

export interface WordChainPassAction extends GameAction {
  readonly type: 'pass';
  readonly payload: null;
}

export type WordChainAction = WordChainPlayAction | WordChainPassAction;

/**
 * The letter the next word must start with, or null when the chain is empty and
 * the opening word is free. Exported because the UI needs to show it, and
 * because computing it in two places is how the two devices come to disagree.
 */
export function requiredLetter(state: WordChainState): string | null {
  const last = state.words[state.words.length - 1];
  if (last === undefined || last.length === 0) return null;
  return last[last.length - 1] as string;
}

/**
 * Index of the first dictionary word that could begin with `letter`.
 *
 * DICTIONARY is sorted, so every word starting with a given letter forms one
 * contiguous run and a bisection finds its start. A linear filter would be four
 * thousand comparisons for every hint, which is nothing once but wasteful on a
 * phone that wants to offer a suggestion as the player types.
 */
function firstIndexFrom(letter: string): number {
  let low = 0;
  let high = DICTIONARY.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((DICTIONARY[mid] as string) < letter) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * A word that would be legal for whoever is to move, chosen with `random`, or
 * null when the chain is genuinely dead.
 *
 * Deterministic given the same state and the same seeded generator, which is
 * what lets the conformance suite drive real play rather than a scripted game.
 * The UI can use it as a hint for a stuck player.
 */
export function findPlayableWord(state: WordChainState, random: GameRandom): string | null {
  const letter = requiredLetter(state);
  const candidates: string[] = [];
  for (let i = letter === null ? 0 : firstIndexFrom(letter); i < DICTIONARY.length; i++) {
    const word = DICTIONARY[i] as string;
    if (letter !== null && word[0] !== letter) break;
    // The bundled list is already within bounds; re-checking here means a later
    // edit that adds a two-letter word cannot turn this into a suggestion the
    // validator then rejects, which would surface as a baffling test failure.
    if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
    if (state.words.includes(word)) continue;
    candidates.push(word);
  }
  if (candidates.length === 0) return null;
  return candidates[random.nextInt(candidates.length)] as string;
}

export const wordChain: GameDefinition<WordChainState, WordChainAction> = {
  id: 'word-chain',
  name: 'Word Chain',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  /*
   * Two only. Word Chain works perfectly well round a table, but "the player
   * who cannot continue loses" then has to become "is eliminated, and the
   * others play on", which is a different game with a different state shape.
   * Shipping the two-player version that is right beats shipping a party
   * version that is nearly right.
   */
  maxPlayers: 2,

  createInitialState(setup: GameSetup): WordChainState {
    return { players: [...setup.players], words: [], turnIndex: 0, loser: null };
  },

  validateAction(state, action): ValidationResult {
    if (state.loser !== null || state.words.length >= WORD_LIMIT) return invalid('the game has already finished');

    const expected = state.players[state.turnIndex];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);

    // Conceding is always available: a player who cannot go must be able to say
    // so, and one who would rather stop should not be forced to invent a word.
    if (action.type === 'pass') return VALID;

    if (action.type === 'play') {
      const word = action.payload?.word;
      if (typeof word !== 'string') return invalid('play needs a word');
      if (word.length < MIN_WORD_LENGTH) return invalid(`words must be at least ${MIN_WORD_LENGTH} letters`);
      if (word.length > MAX_WORD_LENGTH) return invalid(`words may be at most ${MAX_WORD_LENGTH} letters`);
      if (!/^[a-z]+$/.test(word)) return invalid('words must be plain lowercase letters');
      if (!isWord(word)) return invalid('that is not in the dictionary');
      if (state.words.includes(word)) return invalid('that word has already been played');
      const letter = requiredLetter(state);
      if (letter !== null && word[0] !== letter) return invalid(`the next word must start with "${letter}"`);
      return VALID;
    }

    // decodeAction refuses every other type, but validateAction is the contract's
    // guard and must not assume anything about how the action reached it.
    return invalid(`unknown action "${String((action as GameAction).type)}"`);
  },

  applyAction(state, action): WordChainState {
    if (action.type === 'pass') {
      // The turn index is deliberately left where it is. Nobody is to move once
      // a player has conceded, and freezing it keeps the record of who faced the
      // position they gave up on.
      return { ...state, loser: action.player };
    }
    return {
      players: state.players,
      words: [...state.words, action.payload.word],
      turnIndex: (state.turnIndex + 1) % state.players.length,
      loser: null,
    };
  },

  status(state): GameStatus {
    if (state.loser !== null) {
      const winners = state.players.filter((p) => p !== state.loser);
      return { kind: GameStatusKind.WON, winners, reason: 'the chain was broken' };
    }
    if (state.words.length >= WORD_LIMIT) {
      return { kind: GameStatusKind.DRAW, reason: `${WORD_LIMIT} words and neither player stuck` };
    }
    return { kind: GameStatusKind.IN_PROGRESS };
  },

  currentTurn(state): PlayerId | null {
    if (state.loser !== null || state.words.length >= WORD_LIMIT) return null;
    return state.players[state.turnIndex] ?? null;
  },

  encodeState(state): CborValue {
    /*
     * The chain travels as an array of strings rather than one space-joined
     * string. Joining would save the per-string CBOR header - about thirty bytes
     * at the limit - but an empty chain then encodes as "" and splits back into
     * a one-element array containing the empty string, which is a silent
     * corruption of the very first position of every game. Thirty bytes on a
     * snapshot the transport already fragments is not worth that trap.
     */
    return {
      p: [...state.players],
      w: [...state.words],
      t: state.turnIndex,
      l: state.loser,
    };
  },

  /*
   * A snapshot is checked against the rules that produced it, not merely
   * against its shape.
   *
   * Whatever this decoder waves through is adopted wholesale as the live
   * position - see GameSession.applySnapshotEnvelope - so a chain that does not
   * chain is not a cosmetic blemish, it is a board neither device can play on.
   * requiredLetter would go on demanding a letter from a word that was never
   * legally played, and every move after that is an argument. Throwing instead
   * leaves the session able to ask for a snapshot it can actually use, which is
   * the only useful thing to do with one it cannot.
   *
   * Every check below is an exact invariant of applyAction, so no reachable
   * state can fail one: each word passed validateAction on its way in, and the
   * turn index is a running count of the chain.
   */
  decodeState(value): WordChainState {
    const m = asMap(value, 'wordChain.state');

    const raw = asArray(m.p, 'players', 2);
    if (raw.length !== 2) throw new GameDecodeError('wordChain: expected exactly 2 players');
    const players = raw.map((p, i) => asString(p, `players[${i}]`, 64));
    // Two players sharing an id would leave status() computing a win with an
    // empty winners list, which reads as "somebody lost and nobody won".
    if (players[0] === players[1]) throw new GameDecodeError('wordChain: both players have the same id');

    const words = asArray(m.w, 'words', WORD_LIMIT).map((entry, i) => {
      const word = asString(entry, `words[${i}]`, MAX_WORD_LENGTH);
      if (word.length < MIN_WORD_LENGTH) throw new GameDecodeError(`wordChain: words[${i}] is too short`);
      if (!/^[a-z]+$/.test(word)) throw new GameDecodeError(`wordChain: words[${i}] is not lowercase letters`);
      if (!isWord(word)) throw new GameDecodeError(`wordChain: words[${i}] is not in the dictionary`);
      return word;
    });
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string;
      if (words.indexOf(word) !== i) throw new GameDecodeError(`wordChain: words[${i}] is already in the chain`);
      const previous = words[i - 1];
      if (previous !== undefined && word[0] !== previous[previous.length - 1]) {
        throw new GameDecodeError(`wordChain: words[${i}] does not follow "${previous}"`);
      }
    }

    // The key must be there. encodeState always writes it, so a missing one is
    // damage - and reading damage as "nobody has lost" restarts a game somebody
    // has already won.
    if (m.l !== null && typeof m.l !== 'string') {
      throw new GameDecodeError('wordChain: loser must be a string or null');
    }
    const loser = typeof m.l === 'string' ? m.l : null;
    if (loser !== null && !players.includes(loser)) throw new GameDecodeError('wordChain: loser is not a player');

    // Play strictly alternates from index 0 and a pass leaves the index alone,
    // so the turn is not free to disagree with the length of the chain. One that
    // did would hand a player two turns running, or hand the turn to somebody
    // the other device is not waiting for, which stalls both.
    const turnIndex = asInt(m.t, 'turnIndex', 0, players.length - 1);
    if (turnIndex !== words.length % players.length) {
      throw new GameDecodeError('wordChain: turnIndex disagrees with the length of the chain');
    }

    return { players, words, turnIndex, loser };
  },

  encodeAction(action): CborValue {
    if (action.type === 'pass') return encodeActionEnvelope({ ...action, payload: null });
    return encodeActionEnvelope({ ...action, payload: { w: action.payload.word } });
  },

  decodeAction(value, player): WordChainAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type === 'pass') {
      return { type: 'pass', player, seq: envelope.seq, payload: null };
    }
    if (envelope.type !== 'play') throw new GameDecodeError(`wordChain: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'wordChain.payload');
    // Length is bounded here rather than left to the validator so a peer cannot
    // make us allocate on a megabyte of "word" before we get round to refusing it.
    const word = asString(payload.w, 'word', MAX_WORD_LENGTH).toLowerCase();
    return { type: 'play', player, seq: envelope.seq, payload: { word } };
  },
};
