/**
 * Quick Math - ten mental arithmetic problems, two players, one race per problem.
 *
 * Both phones show the SAME problem at the same moment. Each player answers
 * independently and either may answer first; the round resolves once both have
 * answered, and only then are the two answers compared and the points applied.
 * After ten rounds the higher score wins, an equal score is a draw.
 *
 * Scoring is CORRECTNESS FIRST, SPEED SECOND. A correct answer is worth
 * CORRECT_POINTS; when both players are correct, the strictly faster of the two
 * takes SPEED_BONUS on top. A correct answer therefore always outscores a wrong
 * one however slowly it arrived, and within a round speed can only ever separate
 * two players who both got it right - which is the ranking a mental arithmetic
 * game should have. Note the guarantee is per round and not per match: three
 * fast correct answers outscore two slow ones, as they should, but they also
 * outscore four slow ones, so the winner is not always the player who got most
 * right. `correct` is kept in the state precisely so the scoreboard can show
 * both numbers and let the players see which is which.
 *
 * The alternative, points scaled continuously by time, was rejected: it
 * lets a fast wrong-then-right guesser out-earn a steady solver, and it puts a
 * division in the reducer for no gain.
 *
 * ---------------------------------------------------------------------------
 * Why speed is a number in the payload and never an arrival time
 * ---------------------------------------------------------------------------
 * The answering device measures its own elapsed milliseconds since the problem
 * appeared and SENDS that number. The reducer never looks at when a packet
 * arrived, and it cannot: two answers cross a Bluetooth link with tens of
 * milliseconds of real, variable latency, so arrival order is a measurement of
 * the radios, not of the players. Deciding the speed bonus by which packet
 * landed first would hand the round to whoever had the shorter transmit queue,
 * and - worse for a peer-to-peer game with no server - the two devices would
 * disagree about it, because each sees its own answer instantly and the other's
 * late. A self-reported number is identical on both devices and is therefore the
 * only figure the two can agree on.
 *
 * The price is that a reported time is an UNTRUSTED CLAIM: a modified client can
 * shave milliseconds off its own answer and no other phone can tell. A time
 * outside 0..MAX_ANSWER_MS is REFUSED at decode time rather than clamped into
 * range: a clamp would quietly admit a ten-minute claim as a one-minute one,
 * where refusing drops the packet and leaves the sender still owing an answer.
 * What a plausible lie buys is a single point, deliberately fewer than the
 * points for being right, so lying about your speed cannot win a round you did
 * not answer correctly. Closing the hole properly needs a trusted clock, which
 * does not exist here; see the same argument at greater length in reaction.ts.
 *
 * ---------------------------------------------------------------------------
 * Where the problems live, and why they are not in the state
 * ---------------------------------------------------------------------------
 * The ten problems are DERIVED from the shared seed by a pure function and
 * recomputed on demand, exactly as trivia.ts derives its deck. They are not a
 * field of QuickMathState, so a snapshot on the wire carries the seed and
 * nothing else about the questions: six to ten small integers and two player
 * ids, measuring 36 bytes of CBOR for short ids and about 100 for a pair of
 * UUIDs - inside one 185-byte Bluetooth packet either way. Storing the ten
 * problems in the state would have added some 60 bytes to every snapshot to
 * transmit information both devices can already compute.
 *
 * A private generator seeded from the game seed is used rather than
 * `context.random`, because the position of the shared PRNG depends on how many
 * actions have been applied - a device that adopts a snapshot mid-game would
 * generate different problems from the peer that played the whole match.
 *
 * ---------------------------------------------------------------------------
 * Determinism
 * ---------------------------------------------------------------------------
 * Every value in the state is a small integer: scores, counts, milliseconds and
 * answers. There is no floating-point arithmetic anywhere in the reducer, and no
 * division, so there is nothing for two engines to round differently. Ten rounds
 * of two answers is also a hard ceiling on the game's length: it cannot fail to
 * terminate, whatever the players do.
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

/** Problems in a match. Also the hard ceiling on its length. */
export const ROUNDS = 10;

/** A correct answer. Worth strictly more than any speed bonus. */
export const CORRECT_POINTS = 2;
/** Added to the strictly faster of two correct answers. Never awarded on a tie. */
export const SPEED_BONUS = 1;

/** The largest self-reported answer time accepted on the wire. */
export const MAX_ANSWER_MS = 60_000;

/**
 * Bounds on the answer a player may submit. Wide enough to hold every mistake a
 * person actually makes - a sign slip, a stray digit - and narrow enough that the
 * field never costs more than three bytes of CBOR.
 */
export const MIN_ANSWER_VALUE = -9999;
export const MAX_ANSWER_VALUE = 9999;

/** Highest reachable score, used to bound the decoder. */
const MAX_SCORE = ROUNDS * (CORRECT_POINTS + SPEED_BONUS);

const PLAYER_COUNT = 2;

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export type QuickMathOp = '+' | '-' | '*';

export interface QuickMathProblem {
  readonly left: number;
  readonly right: number;
  readonly op: QuickMathOp;
  readonly answer: number;
}

/** Uniform integer in [lo, hi], both inclusive. */
function between(rng: SeededGameRandom, lo: number, hi: number): number {
  return lo + rng.nextInt(hi - lo + 1);
}

/**
 * The problem for one round.
 *
 * Seeded PER ROUND rather than by walking one generator through all ten, so any
 * round can be recomputed on its own: a device that joins from a snapshot knows
 * only the seed and the round number, and must arrive at the same problem as the
 * peer that has been playing since the first question.
 *
 * The three shapes are sized to be done in the head: two-digit addition, a
 * subtraction whose answer is chosen first so it can never go negative, and a
 * multiplication inside the twelve times table.
 */
export function problemAt(seed: number, round: number): QuickMathProblem {
  const rng = new SeededGameRandom((seed ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0);
  switch (rng.nextInt(3)) {
    case 0: {
      const left = between(rng, 12, 89);
      const right = between(rng, 11, 49);
      return { left, right, op: '+', answer: left + right };
    }
    case 1: {
      const answer = between(rng, 3, 49);
      const right = between(rng, 11, 49);
      return { left: answer + right, right, op: '-', answer };
    }
    default: {
      const left = between(rng, 3, 12);
      const right = between(rng, 3, 12);
      return { left, right, op: '*', answer: left * right };
    }
  }
}

/** All ten problems of a match, for a preview screen or a post-match summary. */
export function problems(seed: number): readonly QuickMathProblem[] {
  return Array.from({ length: ROUNDS }, (_, round) => problemAt(seed, round));
}

/** The problem being answered, or null once the match is over. */
export function currentProblem(state: QuickMathState): QuickMathProblem | null {
  if (state.round >= ROUNDS) return null;
  return problemAt(state.seed, state.round);
}

/** How a problem should read on screen. The UI must not print a bare '*'. */
export function problemText(problem: QuickMathProblem): string {
  const symbol = problem.op === '*' ? '×' : problem.op;
  return `${problem.left} ${symbol} ${problem.right}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface QuickMathAnswer {
  readonly value: number;
  /** Milliseconds the answering device measured. See the header. */
  readonly ms: number;
}

export interface QuickMathState {
  readonly players: readonly PlayerId[];
  /** Regenerates every problem. The questions themselves never travel. */
  readonly seed: number;
  /** Rounds already resolved; also the index of the round being answered. */
  readonly round: number;
  /** Per player: this round's answer, or null while they still owe one. */
  readonly answers: readonly (QuickMathAnswer | null)[];
  readonly scores: readonly number[];
  /**
   * Per player: correct answers so far. Not derivable from the score - two
   * correct answers with a bonus and three without both total six - and a quiz
   * that cannot tell you how many you got right is a poor quiz.
   */
  readonly correct: readonly number[];
}

export interface QuickMathAction extends GameAction {
  readonly type: 'answer';
  readonly payload: {
    /** The round this answer is for. Stale answers are refused, not re-aimed. */
    readonly round: number;
    readonly value: number;
    readonly ms: number;
  };
}

/**
 * Points gained by each player for a resolved round.
 *
 * Called only with a full set of answers, because the comparison needs both:
 * scoring an answer the moment it arrived would leak the answer key, since a
 * score that moved would tell the other player their opponent was right.
 */
function roundPoints(problem: QuickMathProblem, answers: readonly QuickMathAnswer[]): readonly number[] {
  const first = answers[0] as QuickMathAnswer;
  const second = answers[1] as QuickMathAnswer;
  const firstRight = first.value === problem.answer;
  const secondRight = second.value === problem.answer;
  const points = [firstRight ? CORRECT_POINTS : 0, secondRight ? CORRECT_POINTS : 0];
  if (firstRight && secondRight) {
    // A dead heat to the millisecond gives the bonus to nobody. Breaking the tie
    // by player order would quietly advantage the host in every match.
    if (first.ms < second.ms) points[0] = (points[0] as number) + SPEED_BONUS;
    else if (second.ms < first.ms) points[1] = (points[1] as number) + SPEED_BONUS;
  }
  return points;
}

/** True once every player has answered the live round. */
function complete(answers: readonly (QuickMathAnswer | null)[]): boolean {
  return answers.every((a) => a !== null);
}

export const quickMath: GameDefinition<QuickMathState, QuickMathAction> = {
  id: 'quick-math',
  name: 'Quick Math',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): QuickMathState {
    return {
      players: [...setup.players],
      seed: setup.seed >>> 0,
      round: 0,
      answers: setup.players.map(() => null),
      scores: setup.players.map(() => 0),
      correct: setup.players.map(() => 0),
    };
  },

  validateAction(state, action): ValidationResult {
    if (state.round >= ROUNDS) return invalid('the game has already finished');
    if (action.type !== 'answer') return invalid(`unknown action "${action.type}"`);
    const index = state.players.indexOf(action.player);
    if (index < 0) return invalid(`${action.player} is not in this game`);
    if (state.answers[index] !== null) return invalid('you have already answered this problem');

    // Re-checked here even though decodeAction has already refused anything
    // out of range, because replay feeds actions straight from a log and a
    // validator that trusts the decoder is a validator that runs half the time.
    const payload = action.payload;
    if (!payload || typeof payload !== 'object') return invalid('an answer needs a payload');
    if (payload.round !== state.round) return invalid(`problem ${state.round + 1} is the live one`);
    if (!Number.isInteger(payload.value) || payload.value < MIN_ANSWER_VALUE || payload.value > MAX_ANSWER_VALUE) {
      return invalid(`value must be ${MIN_ANSWER_VALUE} to ${MAX_ANSWER_VALUE}`);
    }
    if (!Number.isInteger(payload.ms) || payload.ms < 0 || payload.ms > MAX_ANSWER_MS) {
      return invalid(`ms must be 0 to ${MAX_ANSWER_MS}`);
    }
    return VALID;
  },

  applyAction(state, action): QuickMathState {
    const index = state.players.indexOf(action.player);
    const answers: (QuickMathAnswer | null)[] = [...state.answers];
    answers[index] = { value: action.payload.value, ms: action.payload.ms };

    // Nothing is scored until the second answer lands; roundPoints explains why
    // the round cannot resolve any earlier.
    if (!complete(answers)) return { ...state, answers };

    const problem = problemAt(state.seed, state.round);
    const settled = answers as readonly QuickMathAnswer[];
    const gained = roundPoints(problem, settled);
    return {
      players: state.players,
      seed: state.seed,
      round: state.round + 1,
      answers: state.players.map(() => null),
      scores: state.scores.map((s, i) => s + (gained[i] as number)),
      correct: state.correct.map((c, i) => c + ((settled[i] as QuickMathAnswer).value === problem.answer ? 1 : 0)),
    };
  },

  status(state): GameStatus {
    if (state.round < ROUNDS) return { kind: GameStatusKind.IN_PROGRESS };
    const first = state.scores[0] ?? 0;
    const second = state.scores[1] ?? 0;
    if (first === second) return { kind: GameStatusKind.DRAW, reason: `level on ${first}` };
    const winner = state.players[first > second ? 0 : 1];
    if (!winner) return { kind: GameStatusKind.DRAW, reason: 'no players' };
    return {
      kind: GameStatusKind.WON,
      winners: [winner],
      reason: `${Math.max(first, second)}-${Math.min(first, second)} over ten problems`,
    };
  },

  currentTurn(state): PlayerId | null {
    if (state.round >= ROUNDS) return null;
    // Either player may answer at any moment, so there is no turn in the usual
    // sense. What this returns is the "who are we still waiting on" hint that
    // the UI and the conformance driver want: the first player who has not yet
    // answered the live problem. The reducer does not enforce it - a player who
    // owes an answer is never refused because someone else was named here.
    //
    // An open round with nobody left to answer is unreachable, because the
    // second answer resolves the round; decodeState refuses any snapshot
    // claiming otherwise. Should one arrive anyway, null - nobody is to move -
    // is the honest reply. Naming players[0] instead, as this used to, pointed
    // the UI at a player who had already answered and could only be refused.
    const waiting = state.answers.findIndex((a) => a === null);
    return state.players[waiting] ?? null;
  },

  encodeState(state): CborValue {
    // Short keys, flat integer arrays, and the seed in place of the problems:
    // 36 bytes of CBOR for a two-player match with short ids, about 100 with a
    // pair of UUIDs, comfortably inside one packet either way.
    return {
      p: [...state.players],
      g: state.seed,
      r: state.round,
      a: state.answers.map((answer) => (answer ? [answer.value, answer.ms] : null)),
      s: [...state.scores],
      c: [...state.correct],
    };
  },

  decodeState(value): QuickMathState {
    const m = asMap(value, 'quickMath.state');

    const rawPlayers = asArray(m.p, 'players', PLAYER_COUNT);
    if (rawPlayers.length !== PLAYER_COUNT) throw new GameDecodeError('quickMath: expected exactly 2 players');
    const players = rawPlayers.map((p, i) => {
      if (typeof p !== 'string') throw new GameDecodeError(`quickMath: players[${i}] must be a string`);
      if (p.length > 256) throw new GameDecodeError(`quickMath: players[${i}] is too long`);
      return p;
    });

    const rawAnswers = asArray(m.a, 'answers', PLAYER_COUNT);
    if (rawAnswers.length !== PLAYER_COUNT) throw new GameDecodeError('quickMath: expected exactly 2 answer slots');
    const answers = rawAnswers.map((entry, i) => {
      if (entry === null || entry === undefined) return null;
      const pair = asArray(entry, `answers[${i}]`, 2);
      if (pair.length !== 2) throw new GameDecodeError(`quickMath: answers[${i}] must be [value, ms]`);
      return {
        value: asInt(pair[0], `answers[${i}].value`, MIN_ANSWER_VALUE, MAX_ANSWER_VALUE),
        ms: asInt(pair[1], `answers[${i}].ms`, 0, MAX_ANSWER_MS),
      };
    });

    const rawScores = asArray(m.s, 'scores', PLAYER_COUNT);
    if (rawScores.length !== PLAYER_COUNT) throw new GameDecodeError('quickMath: expected exactly 2 scores');
    const scores = rawScores.map((s, i) => asInt(s, `scores[${i}]`, 0, MAX_SCORE));

    const rawCorrect = asArray(m.c, 'correct', PLAYER_COUNT);
    if (rawCorrect.length !== PLAYER_COUNT) throw new GameDecodeError('quickMath: expected exactly 2 tallies');
    const correct = rawCorrect.map((c, i) => asInt(c, `correct[${i}]`, 0, ROUNDS));

    const round = asInt(m.r, 'round', 0, ROUNDS);

    // A snapshot is adopted whole by a device with no history to check it
    // against, so a position that play could not have produced has to be refused
    // here; there is nowhere later that would catch it.
    //
    // A round resolves on the SECOND answer, so an open round already holding
    // both of them is not merely improbable, it is fatal. Every player has
    // answered, so validateAction refuses every player, and currentTurn can only
    // name someone with nothing left to send: the match sits IN_PROGRESS for
    // ever with no legal move on the board, a hang delivered in one packet that
    // a player can escape only by quitting.
    if (complete(answers)) throw new GameDecodeError('quickMath: an open round cannot already hold both answers');
    if (round === ROUNDS && answers.some((a) => a !== null)) {
      throw new GameDecodeError('quickMath: a finished match cannot hold a live answer');
    }

    for (const [i, tally] of correct.entries()) {
      // A tally larger than the number of resolved rounds describes a game that
      // cannot have happened.
      if (tally > round) throw new GameDecodeError(`quickMath: correct[${i}] exceeds the rounds played`);
      // Every point on the board was bought by a correct answer - CORRECT_POINTS
      // for it, and at most SPEED_BONUS more - so a score and the tally beside it
      // pin each other down to a band of one point per correct answer. Checking
      // only the 0..MAX_SCORE range let a peer hand us a snapshot asserting a
      // won match it had not played: thirty points off no correct answers at all.
      const score = scores[i] as number;
      if (score < tally * CORRECT_POINTS || score > tally * (CORRECT_POINTS + SPEED_BONUS)) {
        throw new GameDecodeError(`quickMath: scores[${i}] cannot come from ${tally} correct answers`);
      }
    }

    return {
      players,
      seed: asInt(m.g, 'seed', 0, 0xffffffff),
      round,
      answers,
      scores,
      correct,
    };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({
      ...action,
      payload: { r: action.payload.round, v: action.payload.value, m: action.payload.ms },
    });
  },

  decodeAction(value, player): QuickMathAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'answer') throw new GameDecodeError(`quickMath: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'quickMath.payload');
    return {
      type: 'answer',
      player,
      seq: envelope.seq,
      payload: {
        round: asInt(payload.r, 'round', 0, ROUNDS - 1),
        value: asInt(payload.v, 'value', MIN_ANSWER_VALUE, MAX_ANSWER_VALUE),
        // Refused, not clamped: a clamp would admit a wild claim as a merely
        // slow one, and the sender is better told its answer did not count.
        ms: asInt(payload.m, 'ms', 0, MAX_ANSWER_MS),
      },
    };
  },
};
