/**
 * Tap Race - twenty seconds, count your own taps, best of three.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS TRANSMITTED PER TAP. That is the whole design.
 * ---------------------------------------------------------------------------
 * A tap is the cheapest possible event, and streaming one packet per tap is the
 * obvious implementation. It is also the wrong one, for three separate reasons,
 * any one of which would sink the game:
 *
 *  1. THE LINK CANNOT CARRY IT. A Bluetooth LE connection delivers at a
 *     connection interval - typically 15-50 ms - so a player managing eight
 *     taps a second is already asking for more packets than the radio will
 *     schedule. The queue grows, and it never drains inside twenty seconds.
 *
 *  2. THE QUEUE WOULD DECIDE THE RACE. If taps arrive as messages, the count
 *     that lands is the count that got through, so the winner is whoever has
 *     the shorter radio queue and the fewer retransmissions. That is a test of
 *     the two phones' antennas, not of the two players' thumbs.
 *
 *  3. THERE IS NOTHING TO SYNCHRONISE ANYWAY. Each player is racing their own
 *     twenty seconds. Neither one's taps affect the other's, so the peer has no
 *     use for a tap until the window closes.
 *
 * So each device counts locally and sends ONE integer when its window ends:
 * roughly thirty bytes, once per player per round, on a link that would have
 * choked on the alternative. The outcome then depends on nothing the radio did.
 *
 * ---------------------------------------------------------------------------
 * THE REDUCER NEVER SEES A CLOCK
 * ---------------------------------------------------------------------------
 * `ROUND_MS` exists for the renderer to count down; the rules never consult it,
 * and the reducer reads neither `context.tickMs` nor `context.elapsedMs`. The
 * alternative - a realtime game ticking a shared twenty-second timer - was
 * rejected because it buys nothing and costs the hardest problem in the
 * codebase. The two phones do not start their windows at the same instant, and
 * with a simultaneous timer that skew would be a bug to chase for ever. With a
 * local one it is not even a defect: the windows need not overlap, because each
 * player is only ever measured against their own twenty seconds. A game with no
 * clock in its state has no clock to disagree about.
 *
 * ---------------------------------------------------------------------------
 * WHAT A LYING PEER CAN AND CANNOT DO
 * ---------------------------------------------------------------------------
 * A reported count is an untrusted claim, exactly like the reported reaction
 * times in reaction.ts, and for the same reason: one phone cannot time another
 * phone's finger. `MAX_TAPS` bounds the damage at 2000, which is 100 taps a
 * second sustained for twenty seconds - beyond any human hand, and beyond the
 * sample rate of most touch digitisers, so no honest device can produce it.
 * Anything above it is a peer lying or a script, and it is refused at the wire
 * before the rules ever see it.
 *
 * What the bound does NOT do is make the round fair, and that is worth stating
 * outright rather than leaving to be discovered. Both counts sit in the shared
 * state, so whoever reports SECOND has already read the first, and "one more
 * than yours" is a legal claim every time: 141 against an honest 140 never goes
 * near MAX_TAPS and takes the match 2-0 without a finger moving. It is the same
 * second-mover problem rockPaperScissors.ts solves by committing to a hash and
 * revealing afterwards, and it is NOT solved here: a single number per player
 * per round cannot be hidden from the peer that has to replay it. Closing it
 * costs what RPS pays - two actions a round, commit H(count||nonce) and then
 * reveal - and the identical hole is open in reaction.ts, so it is a decision
 * about both games rather than a patch to this one. Until then the guarantee is
 * the narrower one, and only this: both devices agree on the outcome, and no
 * claim can produce an impossible one. Not that the higher count belongs to the
 * faster thumb.
 *
 * ---------------------------------------------------------------------------
 * STATE: SIX INTEGERS, AND EVERYTHING ELSE DERIVED
 * ---------------------------------------------------------------------------
 * The state holds the per-round counts and nothing more. Round winners, the
 * running tally and "is it over" are computed on demand by the helpers below.
 * Storing the tally as well - the shape reaction.ts uses, where a round's detail
 * is discarded once folded in - would have meant two facts on the wire that can
 * contradict each other, and a decoder that has to decide which of the two to
 * believe. Here a round's counts ARE its result, so there is nothing to
 * reconcile and no redundant field for a hostile peer to poison.
 *
 * Every value in the state is a small integer, so there is no floating-point
 * arithmetic anywhere in the reducer and nothing that could round differently
 * on two devices.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  VALID,
  asArray,
  asInt,
  asMap,
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
// Rules constants
// ---------------------------------------------------------------------------

/** How long a tapping window lasts. For the renderer's countdown only. */
export const ROUND_MS = 20_000;

/** Hard ceiling on rounds. With it, random play cannot fail to terminate. */
export const ROUNDS = 3;
/** Round wins that take the match outright - the majority of three. */
export const WINS_TO_TAKE_IT = 2;

/** The most taps a report may claim. See the note on lying peers above. */
export const MAX_TAPS = 2000;

/** A round's entry for a player who has not reported yet. */
export const NOT_REPORTED = -1;
/** `roundWinner` for a round both players tied. */
export const NOBODY = -1;
/** `roundWinner` for a round still waiting on a report. */
export const ROUND_PENDING = -2;

const PLAYER_COUNT = 2;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TapRaceState {
  readonly players: readonly PlayerId[];
  /**
   * `counts[round][playerIndex]`: the taps that player claimed for that round,
   * or NOT_REPORTED. Kept for the whole match so the renderer can show the
   * per-round tally rather than just the score.
   */
  readonly counts: readonly (readonly number[])[];
}

export interface TapRaceAction extends GameAction {
  readonly type: 'report';
  readonly payload: { readonly round: number; readonly count: number };
}

// ---------------------------------------------------------------------------
// Derived helpers - pure reads, safe for the UI
// ---------------------------------------------------------------------------

/** What a player claimed for a round, or NOT_REPORTED. */
export function reportedCount(state: TapRaceState, round: number, playerIndex: number): number {
  return state.counts[round]?.[playerIndex] ?? NOT_REPORTED;
}

/**
 * Index of the player who took `round`, or NOBODY for a tie, or ROUND_PENDING
 * while either player still owes a report.
 *
 * A tie takes the round from both of them rather than giving it to whoever
 * reported first. Arrival order over Bluetooth says nothing about who tapped
 * harder, so breaking the tie with it would be inventing a result.
 */
export function roundWinner(state: TapRaceState, round: number): number {
  const first = reportedCount(state, round, 0);
  const second = reportedCount(state, round, 1);
  if (first === NOT_REPORTED || second === NOT_REPORTED) return ROUND_PENDING;
  if (first === second) return NOBODY;
  return first > second ? 0 : 1;
}

/** Rounds won, per player index. */
export function winCounts(state: TapRaceState): readonly number[] {
  const wins = new Array<number>(PLAYER_COUNT).fill(0);
  for (let round = 0; round < ROUNDS; round++) {
    const winner = roundWinner(state, round);
    if (winner >= 0) wins[winner] = (wins[winner] ?? 0) + 1;
  }
  return wins;
}

/** The round both players are tapping now, or ROUNDS once all three are done. */
export function currentRound(state: TapRaceState): number {
  for (let round = 0; round < ROUNDS; round++) {
    if (roundWinner(state, round) === ROUND_PENDING) return round;
  }
  return ROUNDS;
}

/**
 * A match ends the moment it is decided rather than when the three rounds run
 * out: a player two rounds up cannot be caught, so the third is never tapped.
 */
export function isMatchOver(state: TapRaceState): boolean {
  const wins = winCounts(state);
  for (const won of wins) if (won >= WINS_TO_TAKE_IT) return true;
  return currentRound(state) >= ROUNDS;
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

/**
 * Could the rules themselves have produced this position?
 *
 * Rounds are tapped in order and the match stops the moment it is decided, so
 * an honest board fills front to back with at most one round part reported, and
 * holds nothing at all after the round that settled it. A snapshot is adopted
 * wholesale by a rejoining guest, and that is the one path by which a shape the
 * rules can never reach - round 0 skipped, or a third round tapped after a 2-0 -
 * could still become the board a device plays on. Six comparisons refuse it,
 * and keep "a round's counts ARE its result" true of every state we accept.
 */
function isReachable(counts: readonly (readonly number[])[]): boolean {
  let wonByFirst = 0;
  let wonBySecond = 0;
  let closed = false; // no later round may hold anything
  for (let round = 0; round < ROUNDS; round++) {
    const first = counts[round]?.[0] ?? NOT_REPORTED;
    const second = counts[round]?.[1] ?? NOT_REPORTED;
    if (closed) {
      if (first !== NOT_REPORTED || second !== NOT_REPORTED) return false;
      continue;
    }
    if (first === NOT_REPORTED || second === NOT_REPORTED) {
      // The round in progress. It may be half reported; nothing may follow it.
      closed = true;
      continue;
    }
    if (first > second) wonByFirst++;
    else if (second > first) wonBySecond++;
    if (wonByFirst >= WINS_TO_TAKE_IT || wonBySecond >= WINS_TO_TAKE_IT) closed = true;
  }
  return true;
}

function decodePlayers(value: CborValue | undefined): PlayerId[] {
  const raw = asArray(value, 'tapRace.players', PLAYER_COUNT);
  if (raw.length !== PLAYER_COUNT) throw new GameDecodeError('tapRace.players: expected exactly 2 players');
  return raw.map((p, i) => {
    if (typeof p !== 'string') throw new GameDecodeError(`tapRace.players[${i}]: expected a string`);
    if (p.length === 0 || p.length > 64) throw new GameDecodeError(`tapRace.players[${i}]: bad length`);
    return p;
  });
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export const tapRace: GameDefinition<TapRaceState, TapRaceAction> = {
  id: 'tap-race',
  name: 'Tap Race',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: PLAYER_COUNT,
  maxPlayers: PLAYER_COUNT,

  createInitialState(setup: GameSetup): TapRaceState {
    return {
      players: [...setup.players],
      counts: Array.from({ length: ROUNDS }, () => new Array<number>(PLAYER_COUNT).fill(NOT_REPORTED)),
    };
  },

  /**
   * Both players tap at once, so there is no seat order to enforce and either
   * report may arrive first. What is enforced, identically for our own action
   * and for a peer's, is that a report is for the round actually in progress,
   * that it is the player's first for that round, that it comes from someone in
   * this game, and that the number is one a hand could have produced.
   *
   * Refusing a report for a LATER round is not pedantry about ordering. A round
   * that has not opened has not been tapped, so there is no number to report
   * yet; accepting one would let a peer pre-fill rounds it never played and
   * leave the board in a shape the reducer cannot reach by playing - round 2
   * decided while round 0 is still open, and `winCounts` reading a match out of
   * rounds nobody has tapped. `decodeState` refuses that same shape on the way
   * in, and for the same reason.
   */
  validateAction(state, action): ValidationResult {
    if (isMatchOver(state)) return invalid('the match has already finished');
    if (action.type !== 'report') return invalid(`unknown action "${String((action as GameAction).type)}"`);

    const index = state.players.indexOf(action.player);
    if (index < 0) return invalid(`${String(action.player)} is not in this game`);

    const round = action.payload?.round;
    if (!Number.isInteger(round) || round < 0 || round > ROUNDS - 1) {
      return invalid(`round must be 0-${ROUNDS - 1}`);
    }
    if (round !== currentRound(state)) return invalid(`round ${round} is not the round in progress`);
    if (reportedCount(state, round, index) !== NOT_REPORTED) {
      return invalid('you have already reported this round');
    }

    const count = action.payload?.count;
    if (!Number.isInteger(count) || count < 0 || count > MAX_TAPS) {
      return invalid(`count must be a whole number in 0-${MAX_TAPS}`);
    }
    return VALID;
  },

  applyAction(state, action): TapRaceState {
    const index = state.players.indexOf(action.player);
    if (index < 0) return state; // unreachable: validateAction rejects it first

    // Every row is copied, not just the one being written. Copying the outer
    // array and then writing through a shared inner row is precisely the
    // mutation the conformance suite's purity check hunts for, and six integers
    // is not a price worth being clever about.
    const counts = state.counts.map((row) => [...row]);
    const row = counts[action.payload.round];
    if (!row) return state; // unreachable: the round was range-checked
    row[index] = action.payload.count;
    return { players: state.players, counts };
  },

  status(state): GameStatus {
    if (!isMatchOver(state)) return { kind: GameStatusKind.IN_PROGRESS };

    const wins = winCounts(state);
    const first = wins[0] ?? 0;
    const second = wins[1] ?? 0;
    if (first === second) {
      return {
        kind: GameStatusKind.DRAW,
        reason: first === 0 ? 'every round was tied' : `tied on ${first} round wins`,
      };
    }
    const index = first > second ? 0 : 1;
    const top = Math.max(first, second);
    return {
      kind: GameStatusKind.WON,
      winners: [state.players[index] as PlayerId],
      reason: top >= WINS_TO_TAKE_IT ? `won ${top} rounds of three` : `most rounds won (${top})`,
    };
  },

  /**
   * Advisory only - a prompt for the UI and a deterministic ordering for the
   * headless drivers. It names the player still owing a report, breaking a
   * both-still-tapping tie by seat order, but `validateAction` gates on nothing
   * it says: either player may report at any moment, which is what a
   * simultaneous race requires.
   */
  currentTurn(state): PlayerId | null {
    if (isMatchOver(state)) return null;
    const round = currentRound(state);
    for (let index = 0; index < PLAYER_COUNT; index++) {
      if (reportedCount(state, round, index) === NOT_REPORTED) return state.players[index] ?? null;
    }
    return null;
  },

  encodeState(state): CborValue {
    // The counts go out flat rather than nested: six integers and two ids is
    // about forty bytes, comfortably inside one ~180-byte packet, and a flat
    // array has one length for the decoder to check instead of four.
    const flat: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      for (let index = 0; index < PLAYER_COUNT; index++) flat.push(reportedCount(state, round, index));
    }
    return { p: [...state.players], c: flat };
  },

  decodeState(value): TapRaceState {
    const m = asMap(value, 'tapRace.state');
    const players = decodePlayers(m.p);

    const flat = asArray(m.c, 'tapRace.counts', ROUNDS * PLAYER_COUNT);
    if (flat.length !== ROUNDS * PLAYER_COUNT) {
      throw new GameDecodeError(`tapRace.counts: expected ${ROUNDS * PLAYER_COUNT} entries`);
    }
    const counts: number[][] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const row: number[] = [];
      for (let index = 0; index < PLAYER_COUNT; index++) {
        const at = round * PLAYER_COUNT + index;
        row.push(asInt(flat[at], `tapRace.counts[${round}][${index}]`, NOT_REPORTED, MAX_TAPS));
      }
      counts.push(row);
    }
    if (!isReachable(counts)) {
      throw new GameDecodeError('tapRace.counts: rounds are tapped in order and stop once the match is decided');
    }
    return { players, counts };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({ ...action, payload: { r: action.payload?.round, n: action.payload?.count } });
  },

  decodeAction(value, player): TapRaceAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'report') throw new GameDecodeError(`tapRace: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'tapRace.payload');
    return {
      type: 'report',
      player,
      seq: envelope.seq,
      payload: {
        round: asInt(payload.r, 'tapRace.round', 0, ROUNDS - 1),
        // The bound is applied HERE, on the way in, so an impossible claim never
        // reaches the rules at all - from a peer or, because submitLocal
        // round-trips its own actions through the codec, from us.
        count: asInt(payload.n, 'tapRace.count', 0, MAX_TAPS),
      },
    };
  },
};
