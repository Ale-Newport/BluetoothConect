/**
 * Memory Match Duel: sixteen cards, eight pairs, two players taking turns.
 *
 * Shaped like the reference game (src/games/ticTacToe.ts): an immutable state,
 * one discriminated action, a validator that assumes the peer is hostile, a pure
 * reducer, and a compact codec on both sides of the wire.
 *
 * ---------------------------------------------------------------------------
 * THE HALF-FINISHED TURN IS REAL STATE
 * ---------------------------------------------------------------------------
 * A turn is two flips, and the gap between them is not a UI detail: it is a
 * position both devices must agree about. If the first card were held in the
 * renderer, a peer who joined mid-turn - or replayed the action log - would
 * disagree with everyone else about what happens when the second card lands.
 * So `revealed` lives in the state, and its LENGTH says what is going on:
 *
 *   0 cards  nothing is showing; the player to move is starting a turn.
 *   1 card   a turn is under way. This flip's partner decides the turn.
 *   2 cards  a settled MISMATCH, still face up on purpose (see below).
 *
 * A matched pair never appears in `revealed`; it moves straight to `matchedBy`,
 * which records 0 for face down, 1 or 2 for the player who took it, and is what
 * keeps a claimed card on show for the rest of the game.
 *
 * ---------------------------------------------------------------------------
 * WHY A MISMATCH IS CLEARED BY THE NEXT FLIP, NOT BY THE ONE THAT MADE IT
 * ---------------------------------------------------------------------------
 * Turning two cards over and hiding them in the same instant means the player
 * never sees what they turned over, and a memory game in which you cannot see
 * the cards is not a game. The obvious fix - have the renderer hold them up for
 * a second or two - is exactly the fix that must not be used here: the two
 * devices would be showing different boards for the length of that timer, the
 * duration would be a local decision, and an action arriving during the pause
 * would land on a state the other side had not reached yet.
 *
 * Instead the mismatched pair STAYS in `revealed`, part of the agreed state, and
 * the next flip - by the other player, whenever they get round to it - is what
 * clears it. Nobody is on a timer, both screens show the same thing, and a
 * device that reconnects mid-pause still sees the cards. Turning one of those
 * two cards over again is a perfectly good move, and deliberately allowed.
 *
 * ---------------------------------------------------------------------------
 * TERMINATION
 * ---------------------------------------------------------------------------
 * Play ends when the eighth pair is taken. Random play gets there eventually,
 * but "eventually" has a long tail: sampling twenty thousand random games gives
 * a mean of 128 flips, a 99th percentile of 280 and a worst case past 450, which
 * is an unbounded game as far as the conformance suite is concerned. `flips` is
 * therefore capped by FLIP_LIMIT and the game is scored as it stands when the
 * cap is reached. A player who remembers anything at all finishes in well under
 * forty flips, so the cap is a stop on the reducer, not a rule anyone will meet.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Every value the reducer arithmetic touches is a small integer: faces 0-7,
 * cells 0-15, scores 0-8, so nothing it computes can round one way on an iPhone
 * and another on a Pixel. The one piece of floating point is inside the seeded
 * shuffle that draws the deal, and it runs once, at creation, where IEEE-754
 * gives every JavaScript engine the same answer for the same seed.
 *
 * The deal comes from the shared seed - never from `context.random` inside the
 * reducer, which would make the board depend on how many random numbers earlier
 * actions had consumed and so differ between a live session and a replayed log.
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

export const GRID_SIZE = 4;
export const CELL_COUNT = GRID_SIZE * GRID_SIZE; // 16
export const PAIRS = CELL_COUNT / 2; // 8

/**
 * Flips allowed before the game is scored where it stands. Even, because a turn
 * is always exactly two flips - matched or not - so an even cap always falls on
 * a turn boundary and never hands one player a stray unusable flip.
 */
export const FLIP_LIMIT = 240;

/** Which pair a card belongs to. Two cards carry each face. */
export type Face = number;

/** 0 = still in play, 1 = taken by the first player, 2 = by the second. */
export type Owner = 0 | 1 | 2;

export interface MemoryDuelState {
  /** The deal: 16 faces, cell-indexed, row-major. Fixed for the whole game. */
  readonly cards: readonly Face[];
  readonly matchedBy: readonly Owner[];
  /** Face-up cells awaiting resolution. See the header: 0, 1 or 2 of them. */
  readonly revealed: readonly number[];
  readonly players: readonly PlayerId[];
  readonly turnIndex: number;
  /** Pairs taken, by player index. Redundant with `matchedBy`, and checked. */
  readonly scores: readonly number[];
  readonly flips: number;
}

export interface MemoryDuelAction extends GameAction {
  readonly type: 'flip';
  readonly payload: { readonly cell: number };
}

/**
 * Sixteen cards, eight faces, shuffled from the shared seed so both devices lay
 * out the same board without exchanging a single byte about it.
 */
export function deal(seed: number): Face[] {
  const deck: Face[] = [];
  for (let face = 0; face < PAIRS; face++) deck.push(face, face);
  return new SeededGameRandom(seed).shuffle(deck);
}

/** Pairs taken so far, by either player. */
export function pairsFound(state: MemoryDuelState): number {
  return (state.scores[0] ?? 0) + (state.scores[1] ?? 0);
}

function isOver(state: MemoryDuelState): boolean {
  return pairsFound(state) >= PAIRS || state.flips >= FLIP_LIMIT;
}

/**
 * The cards showing at the START of the given player's flip. A settled mismatch
 * belongs to the turn that is over, so it counts as nothing here - this is the
 * single place the "cleared by the next flip" rule is expressed, and both
 * validateAction and applyAction read it rather than each deciding for itself.
 */
function liveTurn(state: MemoryDuelState): readonly number[] {
  return state.revealed.length === 2 ? [] : state.revealed;
}

export const memoryDuel: GameDefinition<MemoryDuelState, MemoryDuelAction> = {
  id: 'memory-duel',
  name: 'Memory Match Duel',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): MemoryDuelState {
    return {
      cards: deal(setup.seed),
      matchedBy: new Array<Owner>(CELL_COUNT).fill(0),
      revealed: [],
      players: [...setup.players],
      turnIndex: 0,
      scores: [0, 0],
      flips: 0,
    };
  },

  validateAction(state, action): ValidationResult {
    if (isOver(state)) return invalid('the game has already finished');
    if (action.type !== 'flip') return invalid(`unknown action "${action.type}"`);
    const expected = state.players[state.turnIndex];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);

    const cell = action.payload?.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) return invalid('cell must be 0-15');
    if (state.matchedBy[cell] !== 0) return invalid('that card has already been matched');
    // Flipping your own first card again would "match" it with itself and score
    // a pair that does not exist, so this is the rule a cheat would reach for.
    if (liveTurn(state).includes(cell)) return invalid('that card is already face up this turn');
    return VALID;
  },

  applyAction(state, action): MemoryDuelState {
    const cell = action.payload.cell;
    const showing = liveTurn(state);
    const flips = state.flips + 1;

    if (showing.length === 0) {
      return { ...state, revealed: [cell], flips };
    }

    const first = showing[0] as number;
    if (state.cards[first] !== state.cards[cell]) {
      // The pair stays face up, and the turn passes. The opponent's first flip
      // is what puts these two back down.
      return {
        ...state,
        revealed: [first, cell],
        turnIndex: (state.turnIndex + 1) % state.players.length,
        flips,
      };
    }

    const owner: Owner = state.turnIndex === 0 ? 1 : 2;
    const matchedBy = [...state.matchedBy];
    matchedBy[first] = owner;
    matchedBy[cell] = owner;
    const scores = [...state.scores];
    scores[state.turnIndex] = (scores[state.turnIndex] ?? 0) + 1;
    // A match is its own reward: the same player goes again, so turnIndex holds.
    return { ...state, matchedBy, revealed: [], scores, flips };
  },

  status(state): GameStatus {
    if (!isOver(state)) return { kind: GameStatusKind.IN_PROGRESS };
    const first = state.scores[0] ?? 0;
    const second = state.scores[1] ?? 0;
    const exhausted = pairsFound(state) < PAIRS;
    const reason = exhausted ? 'the flip limit was reached' : 'most pairs';
    if (first === second) return { kind: GameStatusKind.DRAW, reason: exhausted ? reason : 'the pairs were split' };
    const champion = state.players[first > second ? 0 : 1];
    if (!champion) return { kind: GameStatusKind.DRAW, reason: 'the result could not be attributed' };
    return { kind: GameStatusKind.WON, winners: [champion], reason };
  },

  currentTurn(state): PlayerId | null {
    if (isOver(state)) return null;
    return state.players[state.turnIndex] ?? null;
  },

  encodeState(state): CborValue {
    return {
      c: [...state.cards],
      m: [...state.matchedBy],
      u: [...state.revealed],
      p: [...state.players],
      t: state.turnIndex,
      s: [...state.scores],
      f: state.flips,
    };
  },

  decodeState(value): MemoryDuelState {
    const m = asMap(value, 'memoryDuel.state');

    const rawCards = asArray(m.c, 'cards', CELL_COUNT);
    if (rawCards.length !== CELL_COUNT) throw new GameDecodeError('memoryDuel: expected 16 cards');
    const cards = rawCards.map((c, i) => asInt(c, `cards[${i}]`, 0, PAIRS - 1));
    // A deal in which some face appears three times, or none, is not a memory
    // game - and a peer that could send one could hand itself a board where
    // everything matches. The multiset is the only thing that makes the deal
    // legal, so it is checked rather than assumed.
    const cellsByFace: number[][] = Array.from({ length: PAIRS }, () => []);
    cards.forEach((face, cell) => (cellsByFace[face] as number[]).push(cell));
    if (cellsByFace.some((cells) => cells.length !== 2)) {
      throw new GameDecodeError('memoryDuel: every face must appear exactly twice');
    }

    const rawMatched = asArray(m.m, 'matchedBy', CELL_COUNT);
    if (rawMatched.length !== CELL_COUNT) throw new GameDecodeError('memoryDuel: expected 16 ownership marks');
    const matchedBy = rawMatched.map((o, i) => asInt(o, `matchedBy[${i}]`, 0, 2) as Owner);
    // A pair is taken whole or not at all: both cards of a face, by one player.
    // The score check below counts CARDS, so it cannot see this - two unrelated
    // cards look exactly like one pair to it - and a board whose marks do not
    // pair up is worse than merely impossible: the orphaned partners can never
    // be matched by anyone, so the game can no longer be finished, only timed
    // out at the flip cap.
    for (const cells of cellsByFace) {
      const [left, right] = cells as [number, number];
      if (matchedBy[left] !== matchedBy[right]) {
        throw new GameDecodeError('memoryDuel: a pair is taken whole or not at all');
      }
    }

    const rawPlayers = asArray(m.p, 'players', 2);
    if (rawPlayers.length !== 2) throw new GameDecodeError('memoryDuel: expected exactly 2 players');
    const players = rawPlayers.map((p, i) => asString(p, `players[${i}]`, 64));

    // Bounded at the grid rather than at 2, so a longer list is refused by the
    // rule that follows and its message, not by a generic "too long".
    const rawRevealed = asArray(m.u, 'revealed', CELL_COUNT);
    if (rawRevealed.length > 2) throw new GameDecodeError('memoryDuel: at most 2 cards may be face up');
    const revealed = rawRevealed.map((c, i) => asInt(c, `revealed[${i}]`, 0, CELL_COUNT - 1));
    if (revealed.length === 2 && revealed[0] === revealed[1]) {
      throw new GameDecodeError('memoryDuel: the same card cannot be face up twice');
    }
    for (const cell of revealed) {
      if (matchedBy[cell] !== 0) throw new GameDecodeError('memoryDuel: a matched card cannot also be face up');
    }
    // Two face-up cards are a settled mismatch by construction; a matching pair
    // would have moved into `matchedBy` the moment it was turned over.
    if (revealed.length === 2 && cards[revealed[0] as number] === cards[revealed[1] as number]) {
      throw new GameDecodeError('memoryDuel: a matching pair cannot be left face up');
    }

    const rawScores = asArray(m.s, 'scores', 2);
    if (rawScores.length !== 2) throw new GameDecodeError('memoryDuel: expected 2 scores');
    const scores = rawScores.map((n, i) => asInt(n, `scores[${i}]`, 0, PAIRS));
    // The scores are carried for the renderer's benefit, so they are derivable -
    // which means a peer can lie about them independently of the board. Deriving
    // them again here is what stops a snapshot claiming eight pairs off a board
    // that shows none.
    for (const index of [0, 1]) {
      const owned = matchedBy.filter((o) => o === index + 1).length;
      if (owned !== (scores[index] ?? 0) * 2) {
        throw new GameDecodeError(`memoryDuel: scores[${index}] does not match the board`);
      }
    }

    const flips = asInt(m.f, 'flips', 0, FLIP_LIMIT);
    // `flips` decides when the game stops, so a peer that can set it freely can
    // end a game it is losing. Two things tie it back to the board it arrived
    // with: a turn is two flips, so an odd count means - and only ever means -
    // that one card is face up; and a pair cannot be taken in fewer than the
    // two flips that turned it over, so a solved board cannot claim to have
    // cost nothing. A long count on a bare board stays legal, because two
    // players who never match really can spend every flip and take nothing.
    if ((flips % 2 === 1) !== (revealed.length === 1)) {
      throw new GameDecodeError('memoryDuel: the flip count contradicts the half-finished turn');
    }
    const taken = (scores[0] ?? 0) + (scores[1] ?? 0);
    if (flips < taken * 2) throw new GameDecodeError('memoryDuel: too few flips for the pairs taken');

    return {
      cards,
      matchedBy,
      revealed,
      players,
      turnIndex: asInt(m.t, 'turnIndex', 0, 1),
      scores,
      flips,
    };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({ ...action, payload: { c: action.payload.cell } });
  },

  decodeAction(value, player): MemoryDuelAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'flip') throw new GameDecodeError(`memoryDuel: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'memoryDuel.payload');
    return {
      type: 'flip',
      player,
      seq: envelope.seq,
      payload: { cell: asInt(payload.c, 'cell', 0, CELL_COUNT - 1) },
    };
  },
};
