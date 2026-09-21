import { describe, expect, it } from 'vitest';
import {
  MAX_ANSWER_MS,
  OPTIONS,
  ROUNDS,
  capitalDuel,
  flagDuel,
  geographyDuel,
  hasAnswered,
  type QuizDuelAction,
  type QuizDuelState,
} from '../src/games/quizDuel.js';
import { COUNTRIES } from '../src/data/countries.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, SeededGameRandom, createContext, type GameDefinition } from '../src/engine.js';

type Duel = GameDefinition<QuizDuelState, QuizDuelAction>;

const DUELS: readonly (readonly [string, Duel])[] = [
  ['flag-duel', flagDuel],
  ['capital-duel', capitalDuel],
  ['geography-duel', geographyDuel],
];

const SEATS = 2;
const setup = { players: ['a', 'b'], seed: 42, options: {} };

function pair(definition: Duel, seed = setup.seed) {
  const table = { ...setup, seed };
  const a = new GameSession({ definition, setup: table, localPlayer: 'a', isHost: true });
  const b = new GameSession({ definition, setup: table, localPlayer: 'b', isHost: false });
  return { a, b };
}

/** A fresh encoded state, as a plain map, to be spoiled one field at a time. */
function encodedStart(definition: Duel = flagDuel): Record<string, unknown> {
  return definition.encodeState(definition.createInitialState(setup)) as Record<string, unknown>;
}

/** Submit an answer on one device and mirror it onto the other, as the link would. */
function answer(
  definition: Duel,
  sessions: { a: GameSession<QuizDuelState, QuizDuelAction>; b: GameSession<QuizDuelState, QuizDuelAction> },
  player: 'a' | 'b',
  payload: { round: number; option: number; ms: number },
) {
  const from = player === 'a' ? sessions.a : sessions.b;
  const to = player === 'a' ? sessions.b : sessions.a;
  const outcome = from.submitLocal('answer', payload);
  if (outcome.accepted) to.applyRemote(definition.encodeAction(outcome.applied.action), player);
  return outcome;
}

/** The option index that is right for the open round. */
function right(state: QuizDuelState, round = state.round): number {
  return state.questions[round]?.answer ?? 0;
}

/** Any option index that is wrong for the open round. */
function wrong(state: QuizDuelState, round = state.round): number {
  return (right(state, round) + 1) % OPTIONS;
}

describe('quiz duel questions', () => {
  it('builds eight well-formed questions for every duel', () => {
    for (const [id, definition] of DUELS) {
      const state = definition.createInitialState(setup);
      expect(state.questions).toHaveLength(ROUNDS);
      for (const q of state.questions) {
        expect(q.prompt.length).toBeGreaterThan(0);
        expect(q.options).toHaveLength(OPTIONS);
        expect(new Set(q.options).size).toBe(OPTIONS);
        expect(q.answer).toBeGreaterThanOrEqual(0);
        expect(q.answer).toBeLessThan(OPTIONS);
      }
      // Options and answer index too, not only the prompt. An action carries
      // the option INDEX rather than the text, so two devices that ordered the
      // same four buttons differently would score each other against the wrong
      // answer while agreeing about every question they were asked.
      expect(state.questions, id).toEqual(definition.createInitialState(setup).questions);
    }
  });

  it('asks about a different country every round', () => {
    // The subjects are drawn by shuffling the table, so a duel never repeats a
    // country; independent draws would collide about a quarter of the time.
    for (let seed = 1; seed <= 20; seed++) {
      const state = flagDuel.createInitialState({ ...setup, seed });
      expect(new Set(state.questions.map((q) => q.prompt)).size).toBe(ROUNDS);
    }
  });

  it('shows a flag and offers four country names from its region', () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const q of flagDuel.createInitialState({ ...setup, seed }).questions) {
        const subject = COUNTRIES.find((c) => c.flag === q.prompt);
        expect(subject).toBeDefined();
        expect(q.options[q.answer]).toBe(subject?.name);
        const regions = q.options.map((name) => COUNTRIES.find((c) => c.name === name)?.region);
        expect(new Set(regions).size).toBe(1);
        expect(regions[0]).toBe(subject?.region);
      }
    }
  });

  it('offers only same-region capitals as distractors', () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const q of capitalDuel.createInitialState({ ...setup, seed }).questions) {
        const name = /^Which city is the capital of (.+)\?$/.exec(q.prompt)?.[1];
        const subject = COUNTRIES.find((c) => c.name === name);
        expect(subject).toBeDefined();
        expect(q.options[q.answer]).toBe(subject?.capital);
        const regions = q.options.map((capital) => COUNTRIES.find((c) => c.capital === capital)?.region);
        expect(new Set(regions).size).toBe(1);
      }
    }
  });

  it('mixes all three kinds of geography question', () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      for (const q of geographyDuel.createInitialState({ ...setup, seed }).questions) {
        if (q.prompt.startsWith('Which of these countries is the largest')) kinds.add('largest');
        else if (q.prompt.startsWith('Which of these countries is in')) kinds.add('region');
        else if (q.prompt.startsWith('Which capital belongs to')) kinds.add('capital');
        else throw new Error(`unrecognised prompt: ${q.prompt}`);
      }
    }
    expect([...kinds].sort()).toEqual(['capital', 'largest', 'region']);
  });

  it('marks the genuinely largest country and the genuinely right region', () => {
    for (let seed = 1; seed <= 30; seed++) {
      for (const q of geographyDuel.createInitialState({ ...setup, seed }).questions) {
        if (q.prompt.startsWith('Which of these countries is the largest')) {
          const areas = q.options.map((name) => COUNTRIES.find((c) => c.name === name)?.areaKm2 ?? 0);
          expect(areas[q.answer]).toBe(Math.max(...areas));
        } else if (q.prompt.startsWith('Which of these countries is in')) {
          const region = /^Which of these countries is in (.+)\?$/.exec(q.prompt)?.[1];
          const inRegion = q.options.filter((name) => COUNTRIES.find((c) => c.name === name)?.region === region);
          expect(inRegion).toEqual([q.options[q.answer]]);
        }
      }
    }
  });
});

describe('quiz duel rules', () => {
  it('starts on round zero waiting for the first seat', () => {
    for (const [id, definition] of DUELS) {
      const { a } = pair(definition);
      expect(a.currentState.round, id).toBe(0);
      expect(a.currentState.scores).toEqual([0, 0]);
      expect(a.turn).toBe('a');
      expect(hasAnswered(a.currentState, 0)).toBe(false);
    }
  });

  it('holds the round open until both players have answered', () => {
    const sessions = pair(flagDuel);
    expect(answer(flagDuel, sessions, 'a', { round: 0, option: 0, ms: 900 }).accepted).toBe(true);
    expect(sessions.a.currentState.round).toBe(0);
    expect(sessions.b.currentState.round).toBe(0);
    expect(sessions.b.turn).toBe('b');
    expect(answer(flagDuel, sessions, 'b', { round: 0, option: 1, ms: 1200 }).accepted).toBe(true);
    expect(sessions.a.currentState.round).toBe(1);
    expect(sessions.b.currentState.round).toBe(1);
  });

  it('refuses a second answer from the same player', () => {
    const sessions = pair(capitalDuel);
    expect(answer(capitalDuel, sessions, 'a', { round: 0, option: 0, ms: 500 }).accepted).toBe(true);
    const again = answer(capitalDuel, sessions, 'a', { round: 0, option: 2, ms: 400 });
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already answered/);
  });

  it('refuses an answer aimed at a round that is not open', () => {
    const sessions = pair(capitalDuel);
    const ahead = answer(capitalDuel, sessions, 'a', { round: 3, option: 0, ms: 500 });
    expect(ahead.accepted).toBe(false);
    expect(ahead.accepted === false && ahead.detail).toMatch(/not the open round/);
  });

  it('refuses an option outside the four on offer', () => {
    const sessions = pair(flagDuel);
    expect(answer(flagDuel, sessions, 'a', { round: 0, option: OPTIONS, ms: 100 }).accepted).toBe(false);
    expect(answer(flagDuel, sessions, 'a', { round: 0, option: -1, ms: 100 }).accepted).toBe(false);
    expect(answer(flagDuel, sessions, 'a', { round: 0, option: 0, ms: MAX_ANSWER_MS + 1 }).accepted).toBe(false);
    expect(answer(flagDuel, sessions, 'a', { round: 0, option: 0, ms: -5 }).accepted).toBe(false);
    expect(sessions.a.currentState.picks.every((p) => p === -1)).toBe(true);
  });

  it('scores a correct answer and gives the faster of two a bonus', () => {
    const sessions = pair(flagDuel);
    const state = sessions.a.currentState;
    answer(flagDuel, sessions, 'a', { round: 0, option: right(state), ms: 2000 });
    answer(flagDuel, sessions, 'b', { round: 0, option: right(state), ms: 1000 });
    // Both right, so both take a point; b answered in half the time and takes
    // the bonus. Arrival order says the opposite and is deliberately ignored.
    expect(sessions.a.currentState.scores).toEqual([1, 2]);
    expect(sessions.b.currentState.scores).toEqual([1, 2]);
  });

  it('scores the same pair of answers whichever order they arrive in', () => {
    // The point of carrying a locally measured time is that the link cannot
    // decide the round. The same two answers played in the opposite order must
    // land on the same score, so the second seat has to be able to lead.
    const forward = pair(flagDuel);
    const question = forward.a.currentState;
    answer(flagDuel, forward, 'a', { round: 0, option: right(question), ms: 800 });
    answer(flagDuel, forward, 'b', { round: 0, option: right(question), ms: 300 });

    const reversed = pair(flagDuel);
    // currentTurn names the lower seat still owing an answer; it is a hint
    // about who is being waited on, not the gate on legality.
    expect(reversed.b.turn).toBe('a');
    expect(answer(flagDuel, reversed, 'b', { round: 0, option: right(question), ms: 300 }).accepted).toBe(true);
    expect(reversed.a.currentState.round).toBe(0);
    answer(flagDuel, reversed, 'a', { round: 0, option: right(question), ms: 800 });

    expect(reversed.a.currentState.scores).toEqual([1, 2]);
    expect(reversed.a.currentState.scores).toEqual(forward.a.currentState.scores);
  });

  it('keeps both scores still until the round resolves', () => {
    // A score that moved on the first answer would tell the player still
    // choosing whether their opponent had got it right.
    const sessions = pair(capitalDuel);
    const question = sessions.a.currentState;
    answer(capitalDuel, sessions, 'a', { round: 0, option: right(question), ms: 700 });
    expect(sessions.a.currentState.scores).toEqual([0, 0]);
    expect(sessions.b.currentState.scores).toEqual([0, 0]);
    answer(capitalDuel, sessions, 'b', { round: 0, option: wrong(question), ms: 700 });
    expect(sessions.a.currentState.scores).toEqual([1, 0]);
  });

  it('scores nothing when both players are wrong, and still moves on', () => {
    const sessions = pair(flagDuel);
    const question = sessions.a.currentState;
    answer(flagDuel, sessions, 'a', { round: 0, option: wrong(question), ms: 100 });
    answer(flagDuel, sessions, 'b', { round: 0, option: wrong(question), ms: 200 });
    expect(sessions.a.currentState.scores).toEqual([0, 0]);
    expect(sessions.a.currentState.round).toBe(1);
  });

  it('refuses an answer to a round that has already resolved', () => {
    // The stale direction of the round check: an answer that was in flight
    // while the round closed must not be credited to the question after it.
    const sessions = pair(flagDuel);
    const question = sessions.a.currentState;
    answer(flagDuel, sessions, 'a', { round: 0, option: right(question), ms: 500 });
    answer(flagDuel, sessions, 'b', { round: 0, option: right(question), ms: 600 });
    const stale = answer(flagDuel, sessions, 'a', { round: 0, option: 0, ms: 500 });
    expect(stale.accepted).toBe(false);
    expect(stale.accepted === false && stale.detail).toMatch(/not the open round/);
  });

  it('validates on its own account rather than trusting the decoder', () => {
    // Everything a session applies has been through decodeAction, which is
    // stricter - so these branches of validateAction are unreachable from the
    // tests above. GameSession.replay feeds actions straight from a log without
    // decoding them, and then validateAction is the only thing between a bad
    // payload and the arrays it indexes.
    const state = flagDuel.createInitialState(setup);
    const context = createContext(setup.players, setup.seed);
    const legal = (payload: unknown, player = 'a', type = 'answer'): boolean =>
      flagDuel.validateAction(state, { type, player, seq: 0, payload } as never, context).ok;

    expect(legal({ round: 0, option: right(state), ms: 10 })).toBe(true);
    expect(legal({ round: 0, option: OPTIONS, ms: 10 })).toBe(false);
    expect(legal({ round: 0, option: -1, ms: 10 })).toBe(false);
    expect(legal({ round: 0, option: 1.5, ms: 10 })).toBe(false);
    expect(legal({ round: 0, option: Number.NaN, ms: 10 })).toBe(false);
    expect(legal({ round: 0, option: 0, ms: MAX_ANSWER_MS + 1 })).toBe(false);
    expect(legal({ round: 0, option: 0, ms: -1 })).toBe(false);
    expect(legal({ round: 0, option: 0, ms: Number.POSITIVE_INFINITY })).toBe(false);
    expect(legal({ round: 1, option: 0, ms: 10 })).toBe(false);
    expect(legal({ round: '0', option: 0, ms: 10 })).toBe(false);
    expect(legal(null)).toBe(false);
    expect(legal(undefined)).toBe(false);
    expect(legal({ round: 0, option: 0, ms: 10 }, 'stranger')).toBe(false);
    expect(legal({ round: 0, option: 0, ms: 10 }, 'a', 'skip')).toBe(false);
  });

  it('gives no bonus for a dead heat', () => {
    const sessions = pair(flagDuel);
    const state = sessions.a.currentState;
    answer(flagDuel, sessions, 'a', { round: 0, option: right(state), ms: 1500 });
    answer(flagDuel, sessions, 'b', { round: 0, option: right(state), ms: 1500 });
    expect(sessions.a.currentState.scores).toEqual([1, 1]);
  });

  it('scores nothing for a wrong answer, however fast', () => {
    const sessions = pair(capitalDuel);
    const state = sessions.a.currentState;
    answer(capitalDuel, sessions, 'a', { round: 0, option: wrong(state), ms: 1 });
    answer(capitalDuel, sessions, 'b', { round: 0, option: right(state), ms: 9000 });
    expect(sessions.a.currentState.scores).toEqual([0, 1]);
  });

  it('crowns the higher score after eight questions and refuses a ninth answer', () => {
    for (const [id, definition] of DUELS) {
      const sessions = pair(definition);
      for (let round = 0; round < ROUNDS; round++) {
        const state = sessions.a.currentState;
        answer(definition, sessions, 'a', { round, option: right(state), ms: 1000 });
        answer(definition, sessions, 'b', { round, option: wrong(state), ms: 500 });
      }
      expect(sessions.a.currentState.round, id).toBe(ROUNDS);
      expect(sessions.a.currentState.scores).toEqual([ROUNDS, 0]);
      expect(sessions.a.status.kind).toBe(GameStatusKind.WON);
      expect(sessions.a.status.kind === GameStatusKind.WON && sessions.a.status.winners).toEqual(['a']);
      expect(sessions.b.status.kind).toBe(GameStatusKind.WON);
      expect(definition.currentTurn?.(sessions.a.currentState)).toBeNull();
      expect(answer(definition, sessions, 'a', { round: 0, option: 0, ms: 10 }).accepted).toBe(false);
    }
  });

  it('draws when both players end level', () => {
    const sessions = pair(geographyDuel);
    for (let round = 0; round < ROUNDS; round++) {
      const state = sessions.a.currentState;
      answer(geographyDuel, sessions, 'a', { round, option: right(state), ms: 1000 });
      answer(geographyDuel, sessions, 'b', { round, option: right(state), ms: 1000 });
    }
    expect(sessions.a.status.kind).toBe(GameStatusKind.DRAW);
    expect(sessions.a.currentState.scores).toEqual([ROUNDS, ROUNDS]);
  });

  it('will not let one player answer as another', () => {
    const b = new GameSession({ definition: flagDuel, setup, localPlayer: 'b', isHost: false });
    const forged = flagDuel.encodeAction({
      type: 'answer',
      player: 'a',
      seq: 0,
      payload: { round: 0, option: 0, ms: 10 },
    });
    // The session authenticated us as 'b', so the answer is credited to b's
    // seat; 'a' cannot be spoofed into having answered.
    expect(b.applyRemote(forged, 'b').accepted).toBe(true);
    expect(hasAnswered(b.currentState, 0)).toBe(false);
    expect(hasAnswered(b.currentState, 1)).toBe(true);
    expect(b.applyRemote(forged, 'stranger').accepted).toBe(false);
  });

  it('round-trips the state and rebuilds the questions from the seed', () => {
    const sessions = pair(geographyDuel);
    const state = sessions.a.currentState;
    answer(geographyDuel, sessions, 'a', { round: 0, option: right(state), ms: 2500 });
    answer(geographyDuel, sessions, 'b', { round: 0, option: wrong(state), ms: 300 });
    const restored = geographyDuel.decodeState(geographyDuel.encodeState(sessions.a.currentState));
    expect(restored).toEqual(sessions.a.currentState);
    expect(restored.questions.map((q) => q.prompt)).toEqual(state.questions.map((q) => q.prompt));
  });

  it('throws on a malformed action rather than trusting it', () => {
    const hostile: unknown[] = [
      null,
      'answer',
      [],
      {},
      { t: 'guess', s: 0, p: { r: 0, o: 0, m: 0 } },
      { t: 'answer', s: 0, p: null },
      { t: 'answer', s: 0, p: { r: ROUNDS, o: 0, m: 0 } },
      { t: 'answer', s: 0, p: { r: 0, o: OPTIONS, m: 0 } },
      { t: 'answer', s: 0, p: { r: 0, o: 1.5, m: 0 } },
      { t: 'answer', s: 0, p: { r: 0, o: 0, m: MAX_ANSWER_MS + 1 } },
      { t: 'answer', s: 0, p: { r: 0, o: 0, m: 'quick' } },
      { t: 'answer', s: -1, p: { r: 0, o: 0, m: 0 } },
    ];
    for (const junk of hostile) {
      expect(() => flagDuel.decodeAction(junk as never, 'a'), JSON.stringify(junk)).toThrow();
    }
  });

  it('round-trips a round that is still open', () => {
    const sessions = pair(capitalDuel);
    const question = sessions.a.currentState;
    answer(capitalDuel, sessions, 'a', { round: 0, option: right(question), ms: 4321 });
    const restored = capitalDuel.decodeState(capitalDuel.encodeState(sessions.a.currentState));
    expect(restored).toEqual(sessions.a.currentState);
    expect(hasAnswered(restored, 0)).toBe(true);
    expect(hasAnswered(restored, 1)).toBe(false);
    expect(restored.times[0]).toBe(4321);
  });

  it('admits the best score the rules can produce', () => {
    // Two points a round is what the decoder is told to expect: a correct
    // answer and the speed bonus, eight times over.
    const sessions = pair(flagDuel);
    for (let round = 0; round < ROUNDS; round++) {
      const question = sessions.a.currentState;
      answer(flagDuel, sessions, 'a', { round, option: right(question), ms: 100 });
      answer(flagDuel, sessions, 'b', { round, option: right(question), ms: 200 });
    }
    const finished = sessions.a.currentState;
    expect(finished.scores).toEqual([ROUNDS * 2, ROUNDS]);
    expect(flagDuel.decodeState(flagDuel.encodeState(finished))).toEqual(finished);
  });

  it('throws on a malformed state rather than trusting it', () => {
    const good = encodedStart();
    expect(() => flagDuel.decodeState({ ...good, p: ['a'] } as never)).toThrow();
    expect(() => flagDuel.decodeState({ ...good, k: [0, 0] } as never)).toThrow();
    expect(() => flagDuel.decodeState({ ...good, r: ROUNDS + 1 } as never)).toThrow();
    expect(() => flagDuel.decodeState({ ...good, s: [0, 99] } as never)).toThrow();
    expect(() => flagDuel.decodeState({ ...good, d: -1 } as never)).toThrow();
  });

  it('refuses an open round that already holds both answers', () => {
    // The second answer resolves the round, so this position cannot be reached
    // by play - and adopting it hangs the duel for ever: both seats have
    // answered, so validateAction refuses both, currentTurn has nobody left to
    // name, and the status stays IN_PROGRESS. Alive, and accepting nothing.
    const good = encodedStart();
    const picks = [...(good.k as number[])];
    picks[0] = 0;
    picks[1] = 1;
    const deadlock = { ...good, k: picks, r: 0 };
    expect(() => flagDuel.decodeState(deadlock as never)).toThrow(/both answers/);

    const guest = new GameSession({ definition: flagDuel, setup, localPlayer: 'b', isHost: false });
    expect(guest.applySnapshot(deadlock as never)).toBe(false);
    expect(guest.currentState.picks.every((p) => p === -1)).toBe(true);
    expect(guest.turn).toBe('a');
  });

  it('refuses a history no sequence of answers could have produced', () => {
    const good = encodedStart();
    const spoiled = (key: 'k' | 'm', index: number, value: number): Record<string, unknown> => {
      const slots = [...(good[key] as number[])];
      slots[index] = value;
      return { ...good, [key]: slots };
    };
    // A round counted as resolved while holding only one answer.
    expect(() => flagDuel.decodeState({ ...spoiled('k', 0, 0), r: 1 } as never)).toThrow(/resolved on one answer/);
    // An answer to a question this duel has not reached yet.
    expect(() => flagDuel.decodeState(spoiled('k', 7 * SEATS, 2) as never)).toThrow(/before it was reached/);
    // A time with no answer beside it: the two are only ever written together.
    expect(() => flagDuel.decodeState(spoiled('m', 5, 1234) as never)).toThrow(/never given/);
  });

  it('refuses a score the recorded answers did not buy', () => {
    // A won duel asserted rather than played: full marks off no answers at all.
    expect(() => flagDuel.decodeState({ ...encodedStart(), s: [ROUNDS * 2, 0] } as never)).toThrow(/do not follow/);

    // And a genuine board with a single point quietly added to it. b was wrong,
    // so a takes the point and no bonus is owed to anyone.
    const sessions = pair(flagDuel);
    const question = sessions.a.currentState;
    answer(flagDuel, sessions, 'a', { round: 0, option: right(question), ms: 400 });
    answer(flagDuel, sessions, 'b', { round: 0, option: wrong(question), ms: 900 });
    const played = flagDuel.encodeState(sessions.a.currentState) as Record<string, unknown>;
    expect(played.s).toEqual([1, 0]);
    expect(() => flagDuel.decodeState(played as never)).not.toThrow();
    expect(() => flagDuel.decodeState({ ...played, s: [2, 0] } as never)).toThrow(/do not follow/);
    expect(() => flagDuel.decodeState({ ...played, s: [1, 1] } as never)).toThrow(/do not follow/);
  });

  it('stays in step when either player may answer at any moment', () => {
    // The conformance driver only ever moves the player currentTurn names,
    // which in a duel is always the lower seat still owing an answer. Real play
    // is not that tidy: both players answer whenever they like, so the two
    // devices see the same pair of actions in opposite orders.
    for (const [id, definition] of DUELS) {
      for (let seed = 1; seed <= 25; seed++) {
        const random = new SeededGameRandom(seed);
        const sessions = pair(definition, seed);
        for (let attempt = 0; attempt < 200 && !sessions.a.isOver; attempt++) {
          const player = random.nextInt(SEATS) === 0 ? 'a' : 'b';
          const state = (player === 'a' ? sessions.a : sessions.b).currentState;
          const outcome = answer(definition, sessions, player, {
            round: state.round,
            option: random.nextInt(OPTIONS),
            ms: random.nextInt(30_000),
          });
          // Answering twice in a round is the only rejection random play can
          // provoke here, and it must leave the board untouched.
          if (!outcome.accepted) continue;
          expect(definition.encodeState(sessions.a.currentState), `${id} seed ${seed}`).toEqual(
            definition.encodeState(sessions.b.currentState),
          );
        }
        expect(sessions.a.isOver, `${id} seed ${seed}`).toBe(true);
        expect(sessions.a.currentState.round).toBe(ROUNDS);
        expect(sessions.a.currentState.scores).toEqual(sessions.b.currentState.scores);
        // A duel played out this way is still a duel a peer would accept.
        const wire = definition.encodeState(sessions.a.currentState);
        expect(definition.encodeState(definition.decodeState(wire))).toEqual(wire);
      }
    }
  });
});

/** Random but legal: answer the open round with any option and any plausible time. */
const legalAction = (definition: Duel) => (state: QuizDuelState, player: string, random: { nextInt(n: number): number }) => {
  if (definition.currentTurn?.(state) !== player) return null;
  return {
    type: 'answer',
    payload: { round: state.round, option: random.nextInt(OPTIONS), ms: random.nextInt(30000) },
  };
};

describe('quiz duel conformance', () => {
  for (const [id, definition] of DUELS) {
    it(`passes the shared game conformance suite: ${id}`, () => {
      const report = runConformance(definition, { legalAction: legalAction(definition), maxPlies: 40 });
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.playedPlies).toBe(ROUNDS * 2);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    });

    it(`passes conformance across many seeds: ${id}`, () => {
      for (let seed = 1; seed <= 60; seed++) {
        const report = runConformance(definition, { legalAction: legalAction(definition), maxPlies: 40 }, seed);
        expect(report.failures, `seed ${seed}`).toEqual([]);
        expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
      }
    });
  }
});
