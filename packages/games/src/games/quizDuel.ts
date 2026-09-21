/**
 * Quiz Duel: three trivia games that are one set of rules.
 *
 * Flag Duel, Capital Duel and Geography Duel differ only in what a question
 * looks like. The duel itself - eight rounds, both players answering the same
 * question, a round resolving when the second answer lands - is identical, so
 * it is written once here and instantiated three times through
 * `createQuizDuel`. Three copies of a reducer is three places for a scoring bug
 * to hide, and only one of them would get fixed.
 *
 * ---------------------------------------------------------------------------
 * Simultaneous play in a turn-based game
 * ---------------------------------------------------------------------------
 * Both players may answer the open question whenever they like; neither waits
 * for the other. That is still TURN_BASED in the engine's sense, and
 * deliberately so: what makes a game realtime is a simulation that advances
 * with the clock, not two people typing at once. Nothing here moves unless an
 * action arrives, so only actions need to travel and both devices replay them
 * to the same state. A realtime game would have meant a host authority and
 * periodic snapshots to synchronise a state that never changes on its own.
 *
 * The consequence is that `currentTurn` cannot mean what it means in chess. It
 * returns the lowest-seated player who still owes an answer - a hint for "who
 * are we waiting on", and the mover the conformance driver needs - but it is
 * NOT the gate on legality. `validateAction` is. A renderer must therefore
 * enable the answer buttons from `hasAnswered` below rather than from
 * `GameSession.isLocalTurn`, or the second player would be locked out of a
 * question they are entitled to answer.
 *
 * ---------------------------------------------------------------------------
 * Why the tie-break is a number in the payload
 * ---------------------------------------------------------------------------
 * When both players get a question right, the faster one takes a bonus point.
 * "Faster" is measured by the ANSWERING DEVICE, from the moment it displayed
 * the question to the moment the player tapped, and that measurement travels
 * inside the action. It is emphatically NOT the order the two actions arrive
 * in: arrival order over Bluetooth is a fact about radios, buffering and how
 * recently each phone woke its link, and scoring by it would hand the round to
 * whoever had the better antenna. A locally measured duration is the only
 * quantity here that is actually about the players.
 *
 * The residual, deliberate limitation is that a modified client can claim it
 * answered in one millisecond. There is no referee on this link to contradict
 * it, and the alternative - timestamping against a shared clock - needs a clock
 * synchronisation protocol that would be just as forgeable. It costs a bonus
 * point per round and nothing else: the two points for correct answers cannot
 * be stolen this way.
 *
 * ---------------------------------------------------------------------------
 * Determinism notes
 * ---------------------------------------------------------------------------
 * The eight questions are derived from the shared seed by `config.generate` and
 * are NOT part of the encoded state: `decodeState` regenerates them from the
 * seed it decodes. Eight prompts with four options each is roughly a kilobyte,
 * which is six Bluetooth packets for something both devices can already
 * compute; the seed is four bytes. The cost is that the generator is now part
 * of the wire format - changing how a game builds its questions changes what a
 * peer decodes - which is what `protocolVersion` is for.
 *
 * All scoring is integer arithmetic on values below 2^20. Nothing here reads
 * the clock or Math.random. The self-reported millisecond figure is refused at
 * decode time if it is out of range, and after that is only ever compared with
 * the other player's, never accumulated, so it cannot drift.
 *
 * Scores are not independent state: they follow entirely from the picks and
 * times recorded beside them, which is why `roundPoints` is written once and
 * `decodeState` replays it over a peer's snapshot rather than believing the
 * totals it was sent.
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
  type GameRandom,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';
import { COUNTRIES, type Country } from '../data/countries.js';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export const ROUNDS = 8;
export const OPTIONS = 4;
/** Two players, and the seat index is the index into `state.players`. */
export const SEATS = 2;
/** A slot nobody has answered yet. Distinguishable from option 0. */
export const UNANSWERED = -1;
/**
 * The largest answer time we will believe, in milliseconds. Ten minutes is far
 * beyond any real question and still small enough that a hostile peer cannot
 * use the field to smuggle a large number past the decoder.
 */
export const MAX_ANSWER_MS = 600_000;

export interface QuizQuestion {
  /** What to show. A flag emoji for Flag Duel, a sentence for the others. */
  readonly prompt: string;
  /** Exactly four, already in display order. */
  readonly options: readonly string[];
  /** Index into `options`. */
  readonly answer: number;
}

export interface QuizDuelConfig {
  readonly id: string;
  readonly name: string;
  readonly protocolVersion: number;
  /**
   * Build `count` questions from a seeded generator. Must be a pure function of
   * the random stream: both devices call it independently and must agree.
   */
  readonly generate: (random: GameRandom, count: number) => QuizQuestion[];
}

export interface QuizDuelState {
  readonly players: readonly PlayerId[];
  /** The generator seed, kept so `decodeState` can rebuild the questions. */
  readonly seed: number;
  readonly questions: readonly QuizQuestion[];
  /** The open round, 0-7. ROUNDS means the duel is over. */
  readonly round: number;
  /** ROUNDS * SEATS option indices, round-major. UNANSWERED until answered. */
  readonly picks: readonly number[];
  /** ROUNDS * SEATS answer times in milliseconds, laid out like `picks`. */
  readonly times: readonly number[];
  /** One score per seat. */
  readonly scores: readonly number[];
}

export interface QuizDuelAction extends GameAction {
  readonly type: 'answer';
  readonly payload: {
    /** The round this answer is FOR, so a late answer cannot land on the next question. */
    readonly round: number;
    readonly option: number;
    /** Milliseconds the answering device measured. See the header. */
    readonly ms: number;
  };
}

/** Has `seat` answered round `round`? The predicate a renderer should gate on. */
export function hasAnswered(state: QuizDuelState, seat: number, round: number = state.round): boolean {
  return (state.picks[round * SEATS + seat] ?? UNANSWERED) !== UNANSWERED;
}

// ---------------------------------------------------------------------------
// Question generators
// ---------------------------------------------------------------------------

/**
 * `count` distinct countries, by shuffling the whole table and taking a prefix.
 *
 * The obvious alternative - `count` independent draws - repeats: with 99 rows
 * and eight questions there is about a one-in-four chance of asking about the
 * same country twice in one duel, which players read as a bug rather than as
 * chance.
 */
function subjects(random: GameRandom, count: number): Country[] {
  return random.shuffle(COUNTRIES).slice(0, count);
}

/**
 * Three countries from the same region as `subject`.
 *
 * Distractors from the same region are the whole difficulty of the question. A
 * capital question offering Lisbon, Tokyo, Lima and Cairo answers itself from
 * the shape of the world rather than from anything the player knows.
 *
 * Every region in the table has at least ten members, so three neighbours
 * always exist; the fallback is here only so that thinning a region in a future
 * edit degrades to an easier question rather than to a short options array,
 * which would break the four-option invariant the decoders rely on.
 */
function neighbours(random: GameRandom, subject: Country): Country[] {
  const pool = COUNTRIES.filter((c) => c.region === subject.region && c.code !== subject.code);
  const source = pool.length >= OPTIONS - 1 ? pool : COUNTRIES.filter((c) => c.code !== subject.code);
  return random.shuffle(source).slice(0, OPTIONS - 1);
}

/**
 * Put the right answer among three wrong ones in a seeded order.
 *
 * Shuffling all four and then LOOKING UP where the correct one landed, rather
 * than choosing a slot and inserting, keeps the answer index and the option
 * order from ever disagreeing. Both devices run the same shuffle, so both show
 * the same four buttons in the same places - which matters, because an action
 * carries the option INDEX and not the text.
 */
function arrange(random: GameRandom, prompt: string, correct: string, wrong: readonly string[]): QuizQuestion {
  const options = random.shuffle([correct, ...wrong]);
  return { prompt, options, answer: options.indexOf(correct) };
}

/**
 * A flag, four country names. The prompt is the bare emoji: the renderer shows
 * it at the size of a card, and a sentence beside four country names would only
 * be telling the player what they can already see.
 */
function flagQuestions(random: GameRandom, count: number): QuizQuestion[] {
  return subjects(random, count).map((subject) =>
    arrange(
      random,
      subject.flag,
      subject.name,
      neighbours(random, subject).map((c) => c.name),
    ),
  );
}

function capitalQuestions(random: GameRandom, count: number): QuizQuestion[] {
  return subjects(random, count).map((subject) =>
    arrange(
      random,
      `Which city is the capital of ${subject.name}?`,
      subject.capital,
      neighbours(random, subject).map((c) => c.capital),
    ),
  );
}

/**
 * "Which of these is the largest?" - four neighbours, ordered by area.
 *
 * Phrased as a superlative rather than the comparative the brief asks for,
 * because four options make "larger" a question about which pair. Every area in
 * the table is distinct, so the answer is unambiguous; were two ever equal,
 * `reduce` still picks the earlier one on both devices, so the game would stay
 * in step while asking a poor question.
 */
function largestQuestion(random: GameRandom, subject: Country): QuizQuestion {
  const four = [subject, ...neighbours(random, subject)];
  const largest = four.reduce((best, c) => (c.areaKm2 > best.areaKm2 ? c : best));
  return arrange(
    random,
    'Which of these countries is the largest?',
    largest.name,
    four.filter((c) => c.code !== largest.code).map((c) => c.name),
  );
}

/**
 * "Which of these is in <region>?" - the one question where same-region
 * distractors would be wrong, because they would all be correct. The three
 * wrong answers are drawn from the rest of the world at large rather than from
 * one other region, so the odd-one-out cannot be spotted from the pattern.
 */
function regionQuestion(random: GameRandom, subject: Country): QuizQuestion {
  const elsewhere = COUNTRIES.filter((c) => c.region !== subject.region);
  return arrange(
    random,
    `Which of these countries is in ${subject.region}?`,
    subject.name,
    random.shuffle(elsewhere).slice(0, OPTIONS - 1).map((c) => c.name),
  );
}

function capitalBelongsQuestion(random: GameRandom, subject: Country): QuizQuestion {
  return arrange(
    random,
    `Which capital belongs to ${subject.name}?`,
    subject.capital,
    neighbours(random, subject).map((c) => c.capital),
  );
}

function geographyQuestions(random: GameRandom, count: number): QuizQuestion[] {
  return subjects(random, count).map((subject) => {
    // The kind is drawn per question rather than dealt round-robin, so a duel
    // does not always open with the same sort of question.
    switch (random.nextInt(3)) {
      case 0:
        return largestQuestion(random, subject);
      case 1:
        return regionQuestion(random, subject);
      default:
        return capitalBelongsQuestion(random, subject);
    }
  });
}

// ---------------------------------------------------------------------------
// The reducer, written once
// ---------------------------------------------------------------------------

/**
 * What a resolved round is worth to each seat.
 *
 * Lifted out of `applyAction` because `decodeState` needs exactly the same
 * rule: a snapshot's scores are determined by the answers recorded beside them,
 * so the decoder replays this over the rounds already played and refuses a
 * total that does not match. Written twice, the two copies would drift and a
 * peer could hand us a score the reducer would never have awarded.
 *
 * Indexed by SEAT, never by arrival: both figures are the answering device's
 * own measurement, so which of the two actions reached this device first does
 * not enter into it.
 */
function roundPoints(
  question: QuizQuestion | undefined,
  picks: readonly number[],
  times: readonly number[],
  round: number,
): readonly [number, number] {
  const base = round * SEATS;
  // Both callers establish first that this round holds two real answers, so an
  // UNANSWERED slot can never reach the comparison below and be read as a match
  // for a missing question's UNANSWERED stand-in.
  const answer = question?.answer ?? UNANSWERED;
  const rightA = picks[base] === answer;
  const rightB = picks[base + 1] === answer;
  const points: [number, number] = [rightA ? 1 : 0, rightB ? 1 : 0];
  if (rightA && rightB) {
    // Strictly faster only. Two identical measurements are a genuine dead heat
    // and neither player is rewarded for it.
    const msA = times[base] ?? 0;
    const msB = times[base + 1] ?? 0;
    if (msA < msB) points[0] += 1;
    else if (msB < msA) points[1] += 1;
  }
  return points;
}

export function createQuizDuel(config: QuizDuelConfig): GameDefinition<QuizDuelState, QuizDuelAction> {
  /**
   * Rebuild the question set from a seed, checking the shape the reducer relies
   * on. A generator that returned three options or an answer index of 7 would
   * otherwise produce a game nobody could win, on both devices at once, and the
   * failure would surface as a scoring oddity rather than as a bad generator.
   */
  const questionsFor = (seed: number): readonly QuizQuestion[] => {
    const questions = config.generate(new SeededGameRandom(seed), ROUNDS);
    if (questions.length !== ROUNDS) {
      throw new Error(`${config.id}: generator produced ${questions.length} questions, expected ${ROUNDS}`);
    }
    for (const q of questions) {
      if (q.options.length !== OPTIONS) throw new Error(`${config.id}: a question has ${q.options.length} options`);
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= OPTIONS) {
        throw new Error(`${config.id}: a question has answer index ${q.answer}`);
      }
    }
    return questions;
  };

  return {
    id: config.id,
    name: config.name,
    protocolVersion: config.protocolVersion,
    mode: GameMode.TURN_BASED,
    minPlayers: SEATS,
    maxPlayers: SEATS,

    createInitialState(setup: GameSetup): QuizDuelState {
      // Coerced the way SeededGameRandom coerces it, so the seed we store and
      // the seed the generator ran on are the same number after a round trip.
      const seed = setup.seed >>> 0;
      return {
        players: [...setup.players],
        seed,
        questions: questionsFor(seed),
        round: 0,
        picks: new Array<number>(ROUNDS * SEATS).fill(UNANSWERED),
        times: new Array<number>(ROUNDS * SEATS).fill(0),
        scores: new Array<number>(SEATS).fill(0),
      };
    },

    validateAction(state, action): ValidationResult {
      if (state.round >= ROUNDS) return invalid('the duel has already finished');
      if (action.type !== 'answer') return invalid(`unknown action "${action.type}"`);
      const seat = state.players.indexOf(action.player);
      if (seat < 0) return invalid(`${action.player} is not in this duel`);

      const payload = action.payload;
      const round = payload?.round;
      const option = payload?.option;
      const ms = payload?.ms;
      // An answer names the round it belongs to, so one that was in flight
      // while the round resolved is refused rather than being credited to the
      // question that followed it.
      if (round !== state.round) return invalid(`round ${String(round)} is not the open round`);
      if (!Number.isInteger(option) || option < 0 || option >= OPTIONS) return invalid('option must be 0-3');
      if (!Number.isInteger(ms) || ms < 0 || ms > MAX_ANSWER_MS) return invalid('ms is out of range');
      if (hasAnswered(state, seat)) return invalid('you have already answered this question');
      return VALID;
    },

    applyAction(state, action): QuizDuelState {
      const seat = state.players.indexOf(action.player);
      // validateAction refused a stranger already; this guard only keeps a
      // contract violation from writing outside the arrays.
      if (seat < 0) return state;

      const base = state.round * SEATS;
      const picks = [...state.picks];
      const times = [...state.times];
      picks[base + seat] = action.payload.option;
      times[base + seat] = action.payload.ms;

      // Named by seat, not by who got here first: the round is open until BOTH
      // seats hold an answer, whichever order the two actions arrived in.
      const seatA = picks[base] ?? UNANSWERED;
      const seatB = picks[base + 1] ?? UNANSWERED;
      if (seatA === UNANSWERED || seatB === UNANSWERED) return { ...state, picks, times };

      // Both answers are in, so the round resolves. Scoring only at resolution
      // means a score never moves on the first answer - which would tell the
      // player still choosing whether their opponent got it right.
      const [gainA, gainB] = roundPoints(state.questions[state.round], picks, times, state.round);
      const scores = [(state.scores[0] ?? 0) + gainA, (state.scores[1] ?? 0) + gainB];
      return { ...state, picks, times, scores, round: state.round + 1 };
    },

    status(state): GameStatus {
      if (state.round < ROUNDS) return { kind: GameStatusKind.IN_PROGRESS };
      const a = state.scores[0] ?? 0;
      const b = state.scores[1] ?? 0;
      if (a === b) return { kind: GameStatusKind.DRAW, reason: `level on ${a} after ${ROUNDS} questions` };
      const winner = state.players[a > b ? 0 : 1];
      if (!winner) return { kind: GameStatusKind.DRAW, reason: 'no seated winner' };
      return { kind: GameStatusKind.WON, winners: [winner], reason: `${Math.max(a, b)} points to ${Math.min(a, b)}` };
    },

    currentTurn(state): PlayerId | null {
      if (state.round >= ROUNDS) return null;
      for (let seat = 0; seat < SEATS; seat++) {
        if (!hasAnswered(state, seat)) return state.players[seat] ?? null;
      }
      return null;
    },

    encodeState(state): CborValue {
      // No questions: `decodeState` rebuilds them from `d`. See the header.
      return {
        p: [...state.players],
        d: state.seed,
        r: state.round,
        k: [...state.picks],
        m: [...state.times],
        s: [...state.scores],
      };
    },

    decodeState(value): QuizDuelState {
      const m = asMap(value, `${config.id}.state`);
      const rawPlayers = asArray(m.p, 'players', SEATS);
      if (rawPlayers.length !== SEATS) throw new GameDecodeError(`${config.id}: expected exactly ${SEATS} players`);
      const players = rawPlayers.map((p, i) => {
        if (typeof p !== 'string') throw new GameDecodeError(`${config.id}: players[${i}] must be a string`);
        if (p.length > 256) throw new GameDecodeError(`${config.id}: players[${i}] is too long`);
        return p;
      });

      const seed = asInt(m.d, 'seed', 0, 0xffffffff);
      const slots = ROUNDS * SEATS;
      const rawPicks = asArray(m.k, 'picks', slots);
      if (rawPicks.length !== slots) throw new GameDecodeError(`${config.id}: picks must have ${slots} slots`);
      const rawTimes = asArray(m.m, 'times', slots);
      if (rawTimes.length !== slots) throw new GameDecodeError(`${config.id}: times must have ${slots} slots`);
      const rawScores = asArray(m.s, 'scores', SEATS);
      if (rawScores.length !== SEATS) throw new GameDecodeError(`${config.id}: scores must have ${SEATS} entries`);

      const questions = questionsFor(seed);
      const round = asInt(m.r, 'round', 0, ROUNDS);
      const picks = rawPicks.map((p, i) => asInt(p, `picks[${i}]`, UNANSWERED, OPTIONS - 1));
      const times = rawTimes.map((t, i) => asInt(t, `times[${i}]`, 0, MAX_ANSWER_MS));
      // Two points per round is the ceiling: one for a correct answer and one
      // for the speed bonus. The exact totals are re-derived below; this bound
      // only keeps a wild number out of the arithmetic that derives them.
      const scores = rawScores.map((s, i) => asInt(s, `scores[${i}]`, 0, ROUNDS * 2));

      /*
       * Refuse a board that no sequence of legal answers could have produced.
       *
       * A guest adopts a snapshot whole, so every invariant the reducer relies
       * on has to be re-established here rather than assumed. The one that
       * matters most is not a wrong score but a DEADLOCK: an open round already
       * holding both answers refuses both players through `validateAction`,
       * leaves `currentTurn` with nobody to name, and still reports
       * IN_PROGRESS. The duel would look alive, accept nothing for ever, and be
       * escapable only by quitting - a hang delivered in one packet.
       */
      let earnedA = 0;
      let earnedB = 0;
      for (let r = 0; r < ROUNDS; r++) {
        const base = r * SEATS;
        const answeredA = picks[base] !== UNANSWERED;
        const answeredB = picks[base + 1] !== UNANSWERED;
        // A time is only ever written together with the answer it measures, so
        // one standing alone is a hand-built state rather than a played one.
        if ((!answeredA && times[base] !== 0) || (!answeredB && times[base + 1] !== 0)) {
          throw new GameDecodeError(`${config.id}: round ${r} times an answer that was never given`);
        }
        if (r < round) {
          if (!answeredA || !answeredB) throw new GameDecodeError(`${config.id}: round ${r} resolved on one answer`);
          const [gainA, gainB] = roundPoints(questions[r], picks, times, r);
          earnedA += gainA;
          earnedB += gainB;
        } else if (r === round) {
          if (answeredA && answeredB) throw new GameDecodeError(`${config.id}: the open round already holds both answers`);
        } else if (answeredA || answeredB) {
          throw new GameDecodeError(`${config.id}: round ${r} was answered before it was reached`);
        }
      }
      // Every point on the board was bought by an answer that is still recorded
      // beside it, so a peer cannot assert a duel it did not play. This also
      // catches the subtler case of two devices generating different questions
      // from the same seed, which `protocolVersion` is meant to prevent and
      // which would otherwise show up as a silent scoring disagreement.
      if (scores[0] !== earnedA || scores[1] !== earnedB) {
        throw new GameDecodeError(
          `${config.id}: scores ${scores.join('-')} do not follow from the answers recorded (${earnedA}-${earnedB})`,
        );
      }

      return { players, seed, questions, round, picks, times, scores };
    },

    encodeAction(action): CborValue {
      return encodeActionEnvelope({
        ...action,
        payload: { r: action.payload.round, o: action.payload.option, m: action.payload.ms },
      });
    },

    decodeAction(value, player): QuizDuelAction {
      const envelope = decodeActionEnvelope(value, player);
      if (envelope.type !== 'answer') throw new GameDecodeError(`${config.id}: unknown action "${envelope.type}"`);
      const payload = asMap(envelope.payload, `${config.id}.payload`);
      return {
        type: 'answer',
        player,
        seq: envelope.seq,
        payload: {
          round: asInt(payload.r, 'round', 0, ROUNDS - 1),
          option: asInt(payload.o, 'option', 0, OPTIONS - 1),
          ms: asInt(payload.m, 'ms', 0, MAX_ANSWER_MS),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The three duels
// ---------------------------------------------------------------------------

export const flagDuel = createQuizDuel({
  id: 'flag-duel',
  name: 'Flag Duel',
  protocolVersion: 1,
  generate: flagQuestions,
});

export const capitalDuel = createQuizDuel({
  id: 'capital-duel',
  name: 'Capital Duel',
  protocolVersion: 1,
  generate: capitalQuestions,
});

export const geographyDuel = createQuizDuel({
  id: 'geography-duel',
  name: 'Geography Duel',
  protocolVersion: 1,
  generate: geographyQuestions,
});
