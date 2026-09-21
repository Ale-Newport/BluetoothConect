import { describe, expect, it } from 'vitest';
import type { CborValue } from '@airlink/core';
import {
  MOST_LIKELY_TO_BANK,
  PROMPTS_PER_GAME,
  SECRET_CHOICE_BANKS,
  THIS_OR_THAT_BANK,
  WOULD_YOU_RATHER_BANK,
  createSecretChoice,
  currentRound,
  mostLikelyTo,
  roundView,
  thisOrThat,
  wouldYouRather,
  type SecretChoiceAction,
  type SecretChoiceState,
} from '../src/games/secretChoice.js';
import { MOST_LIKELY_TO, THIS_OR_THAT, WOULD_YOU_RATHER } from '../src/data/prompts.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, type GameDefinition } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };

type Definition = GameDefinition<SecretChoiceState, SecretChoiceAction>;
type Session = GameSession<SecretChoiceState, SecretChoiceAction>;

function pair(definition: Definition): { a: Session; b: Session } {
  return {
    a: new GameSession({ definition, setup, localPlayer: 'a', isHost: true }),
    b: new GameSession({ definition, setup, localPlayer: 'b', isHost: false }),
  };
}

/** One player chooses, and the other device is told. Returns the outcome. */
function choose(definition: Definition, from: Session, to: Session, who: 'a' | 'b', round: number, option: number) {
  const outcome = from.submitLocal('choose', { round, option });
  if (outcome.accepted) to.applyRemote(definition.encodeAction(outcome.applied.action), who);
  return outcome;
}

function playRound(definition: Definition, s: { a: Session; b: Session }, round: number, first: number, second: number) {
  choose(definition, s.a, s.b, 'a', round, first);
  choose(definition, s.b, s.a, 'b', round, second);
}

describe('secret-choice rules', () => {
  it('starts with every round closed and the first player prompted', () => {
    const s = pair(wouldYouRather);
    expect(currentRound(s.a.currentState)).toBe(0);
    expect(s.a.currentState.revealed).toEqual(new Array<boolean>(PROMPTS_PER_GAME).fill(false));
    expect(s.a.currentState.agreed).toBe(0);
    expect(s.a.turn).toBe('a');
  });

  it('keeps the first choice secret until the second one lands', () => {
    const s = pair(wouldYouRather);
    choose(wouldYouRather, s.a, s.b, 'a', 0, 1);

    // What the chooser sees: their own answer, and nothing of their partner's.
    const mine = roundView(WOULD_YOU_RATHER_BANK, s.a.currentState, 0, 'a');
    expect(mine.yours).toBe(1);
    expect(mine.theirs).toBeNull();
    expect(mine.revealed).toBe(false);

    // And what the other device sees, having already received the action.
    const theirs = roundView(WOULD_YOU_RATHER_BANK, s.b.currentState, 0, 'b');
    expect(theirs.yours).toBeNull();
    expect(theirs.theirs).toBeNull();
    expect(s.b.currentState.revealed[0]).toBe(false);
  });

  it('opens the round and counts an agreement when both choose alike', () => {
    const s = pair(wouldYouRather);
    playRound(wouldYouRather, s, 0, 1, 1);
    expect(s.a.currentState.revealed[0]).toBe(true);
    expect(s.a.currentState.agreed).toBe(1);
    const view = roundView(WOULD_YOU_RATHER_BANK, s.a.currentState, 0, 'a');
    expect(view.theirs).toBe(1);
    expect(view.revealed).toBe(true);
    expect(currentRound(s.a.currentState)).toBe(1);
  });

  it('opens the round without a tally when the two differ', () => {
    const s = pair(wouldYouRather);
    playRound(wouldYouRather, s, 0, 0, 1);
    expect(s.a.currentState.revealed[0]).toBe(true);
    expect(s.a.currentState.agreed).toBe(0);
    expect(roundView(WOULD_YOU_RATHER_BANK, s.b.currentState, 0, 'b').theirs).toBe(0);
  });

  it('prompts the other player once the first has chosen, and resets each round', () => {
    const s = pair(wouldYouRather);
    choose(wouldYouRather, s.a, s.b, 'a', 0, 0);
    expect(s.a.turn).toBe('b');
    choose(wouldYouRather, s.b, s.a, 'b', 0, 0);
    expect(s.a.turn).toBe('a');
  });

  // The whole point of the phase is that it is simultaneous, so the second
  // player must be able to go first. Nothing else in this file exercises that:
  // playRound always sends a before b, and the conformance driver follows
  // currentTurn, which always names a first. Without this, turning the UI's
  // ordering hint into a rule would break the game and pass every other test.
  it('lets either player choose first', () => {
    const s = pair(wouldYouRather);
    expect(choose(wouldYouRather, s.b, s.a, 'b', 0, 1).accepted).toBe(true);
    expect(s.a.turn).toBe('a');
    expect(roundView(WOULD_YOU_RATHER_BANK, s.a.currentState, 0, 'a').theirs).toBeNull();
    expect(choose(wouldYouRather, s.a, s.b, 'a', 0, 1).accepted).toBe(true);
    expect(s.b.currentState.revealed[0]).toBe(true);
    expect(s.b.currentState.agreed).toBe(1);
  });

  // The deal is a pure function of the seed and is never stored, so it is the
  // one piece of game content that the convergence hash cannot see: two devices
  // could hold identical states and still be reading different prompts.
  it('deals the same prompts on both devices for one seed', () => {
    const s = pair(mostLikelyTo);
    const prompts = (state: SecretChoiceState) =>
      Array.from({ length: PROMPTS_PER_GAME }, (_, i) => roundView(MOST_LIKELY_TO_BANK, state, i, 'a').prompt);
    expect(prompts(s.b.currentState)).toEqual(prompts(s.a.currentState));
    expect(prompts(mostLikelyTo.createInitialState(setup))).toEqual(prompts(s.a.currentState));
  });

  it('refuses a choice for a round that is not in play', () => {
    const s = pair(wouldYouRather);
    const ahead = s.a.submitLocal('choose', { round: 1, option: 0 });
    expect(ahead.accepted).toBe(false);
    expect(ahead.accepted === false && ahead.detail).toMatch(/round 0/);
    playRound(wouldYouRather, s, 0, 0, 0);
    const behind = s.a.submitLocal('choose', { round: 0, option: 0 });
    expect(behind.accepted).toBe(false);
  });

  it('refuses a second choice from the same player in one round', () => {
    const s = pair(wouldYouRather);
    expect(choose(wouldYouRather, s.a, s.b, 'a', 0, 0).accepted).toBe(true);
    const again = s.a.submitLocal('choose', { round: 0, option: 1 });
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already chosen/);
  });

  it('refuses an option that is not one of the two', () => {
    const s = pair(wouldYouRather);
    expect(s.a.submitLocal('choose', { round: 0, option: 2 }).accepted).toBe(false);
    expect(s.a.submitLocal('choose', { round: 0, option: -1 }).accepted).toBe(false);
    expect(s.a.submitLocal('choose', { round: 0, option: 0.5 }).accepted).toBe(false);
  });

  it('ends in a draw after the last round, with the tally as the reason', () => {
    const s = pair(wouldYouRather);
    // Agree on the even rounds, differ on the odd ones: five out of ten.
    for (let round = 0; round < PROMPTS_PER_GAME; round++) {
      playRound(wouldYouRather, s, round, 0, round % 2 === 0 ? 0 : 1);
    }
    expect(s.a.isOver).toBe(true);
    expect(s.a.status.kind).toBe(GameStatusKind.DRAW);
    expect(s.a.status.kind === GameStatusKind.DRAW && s.a.status.reason).toMatch(/agreed 5 times out of 10/);
    expect(s.b.currentState.agreed).toBe(5);
    expect(s.a.turn).toBeNull();
    // Nobody loses, so nothing about the finished game can name a winner.
    expect(s.a.status.kind).not.toBe(GameStatusKind.WON);
  });

  it('refuses a choice once the last round has opened', () => {
    const s = pair(wouldYouRather);
    for (let round = 0; round < PROMPTS_PER_GAME; round++) playRound(wouldYouRather, s, round, 0, 0);
    expect(s.a.currentState.agreed).toBe(PROMPTS_PER_GAME);
    const late = s.a.submitLocal('choose', { round: PROMPTS_PER_GAME - 1, option: 1 });
    expect(late.accepted).toBe(false);
  });

  it('takes the Most Likely To options from the players and its line from the bank', () => {
    const s = pair(mostLikelyTo);
    const view = roundView(MOST_LIKELY_TO_BANK, s.a.currentState, 0, 'a');
    expect(view.options).toEqual(['a', 'b']);
    expect(view.prompt.startsWith('Who is most likely to ')).toBe(true);
    expect(MOST_LIKELY_TO).toContain(view.prompt.replace('Who is most likely to ', ''));
  });

  it('takes the This or That options from the bank and shows no lead line', () => {
    const s = pair(thisOrThat);
    const view = roundView(THIS_OR_THAT_BANK, s.a.currentState, 0, 'a');
    expect(view.prompt).toBe('');
    expect(THIS_OR_THAT.map((p) => [p.a, p.b])).toContainEqual([view.options[0], view.options[1]]);
  });

  it('deals a different set of prompts for a different seed', () => {
    const first = wouldYouRather.createInitialState({ players: ['a', 'b'], seed: 1, options: {} });
    const second = wouldYouRather.createInitialState({ players: ['a', 'b'], seed: 2, options: {} });
    const promptsFor = (state: SecretChoiceState) =>
      Array.from({ length: PROMPTS_PER_GAME }, (_, i) => roundView(WOULD_YOU_RATHER_BANK, state, i, 'a').options[0]);
    expect(promptsFor(first)).not.toEqual(promptsFor(second));
    // A deal must never repeat a prompt inside one game.
    expect(new Set(promptsFor(first)).size).toBe(PROMPTS_PER_GAME);
  });

  it('ships enough prompts that a pack does not run dry', () => {
    for (const bank of [WOULD_YOU_RATHER, THIS_OR_THAT, MOST_LIKELY_TO]) {
      expect(bank.length).toBeGreaterThanOrEqual(40);
    }
    expect(Object.keys(SECRET_CHOICE_BANKS)).toEqual(['would-you-rather', 'most-likely-to', 'this-or-that']);
  });

  it('refuses to build a game from a bank shorter than a game', () => {
    expect(() =>
      createSecretChoice({
        id: 'too-short',
        name: 'Too Short',
        bank: { kind: 'pairs', lead: '', pairs: WOULD_YOU_RATHER.slice(0, 3) },
      }),
    ).toThrow(/at least/);
  });
});

describe('secret-choice decoding', () => {
  it('throws on a malformed action rather than guessing', () => {
    const junk: CborValue[] = [
      'nonsense',
      {},
      { t: 'shrug', s: 0, p: { r: 0, o: 0 } },
      { t: 'choose', s: 0, p: null },
      { t: 'choose', s: 0, p: { r: PROMPTS_PER_GAME, o: 0 } },
      { t: 'choose', s: 0, p: { r: -1, o: 0 } },
      { t: 'choose', s: 0, p: { r: 1.5, o: 0 } },
      { t: 'choose', s: 0, p: { r: 0, o: 2 } },
      { t: 'choose', s: 0, p: { r: 0, o: 'a' } },
    ];
    for (const value of junk) {
      expect(() => wouldYouRather.decodeAction(value, 'a')).toThrow();
    }
  });

  it('round-trips a state exactly', () => {
    const s = pair(thisOrThat);
    playRound(thisOrThat, s, 0, 1, 1);
    choose(thisOrThat, s.a, s.b, 'a', 1, 0);
    const restored = thisOrThat.decodeState(thisOrThat.encodeState(s.a.currentState));
    expect(restored).toEqual(s.a.currentState);
  });

  it('refuses a snapshot whose reveal flags disagree with its choices', () => {
    const s = pair(wouldYouRather);
    choose(wouldYouRather, s.a, s.b, 'a', 0, 0);
    const raw = wouldYouRather.encodeState(s.a.currentState) as Record<string, CborValue>;
    (raw.v as boolean[])[0] = true; // one choice in, round claimed open
    expect(() => wouldYouRather.decodeState(raw)).toThrow(/disagrees/);
  });

  it('refuses a snapshot claiming a friendlier tally than the choices support', () => {
    const s = pair(wouldYouRather);
    playRound(wouldYouRather, s, 0, 0, 1);
    const raw = wouldYouRather.encodeState(s.a.currentState) as Record<string, CborValue>;
    raw.a = 1;
    expect(() => wouldYouRather.decodeState(raw)).toThrow(/agreement count/);
  });

  it('refuses a snapshot with rounds opened out of order', () => {
    // A second round played while the first was never answered. Internally
    // consistent round by round, and still a position the reducer cannot reach.
    const s = pair(wouldYouRather);
    const raw = wouldYouRather.encodeState(s.a.currentState) as Record<string, CborValue>;
    (raw.c as number[])[2] = 0;
    (raw.c as number[])[3] = 0;
    (raw.v as boolean[])[1] = true;
    raw.a = 1;
    expect(() => wouldYouRather.decodeState(raw)).toThrow(/out of order/);
  });

  it('refuses a snapshot holding a choice for a round nobody has reached', () => {
    // A guest adopts whatever the host sends, so the only defence against a
    // planted answer is that the reducer could never have produced one. Round 0
    // is in play; a choice sitting in round 4 was put there by hand. Left
    // unchecked it locked the victim out of round 4 - the slot was already
    // full - and counted an answer they never gave towards the final tally.
    const s = pair(wouldYouRather);
    const raw = wouldYouRather.encodeState(s.a.currentState) as Record<string, CborValue>;
    (raw.c as number[])[8] = 1;
    expect(() => wouldYouRather.decodeState(raw)).toThrow(/before anyone reached it/);

    const guest = new GameSession({ definition: wouldYouRather, setup, localPlayer: 'a', isHost: false });
    expect(guest.applySnapshot(raw)).toBe(false);
    expect(guest.submitLocal('choose', { round: 0, option: 0 }).accepted).toBe(true);
  });

  it('refuses a snapshot of the wrong shape', () => {
    expect(() => wouldYouRather.decodeState({ p: ['a'], g: 0, c: [], v: [], a: 0 })).toThrow(/2 players/);
    expect(() => wouldYouRather.decodeState('not a state')).toThrow();
  });
});

describe('secret-choice conformance', () => {
  const games: readonly Definition[] = [wouldYouRather, mostLikelyTo, thisOrThat];

  const hooks = (definition: Definition) => ({
    legalAction: (state: SecretChoiceState, player: string, random: { nextInt(n: number): number }) => {
      if (definition.currentTurn?.(state) !== player) return null;
      const round = currentRound(state);
      if (round >= PROMPTS_PER_GAME) return null;
      return { type: 'choose', payload: { round, option: random.nextInt(2) } as CborValue };
    },
    maxPlies: PROMPTS_PER_GAME * 2 + 4,
  });

  it('passes the shared game conformance suite', () => {
    for (const definition of games) {
      const report = runConformance(definition, hooks(definition));
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.finalStatus).toBe(GameStatusKind.DRAW);
    }
  });

  it('passes conformance across many seeds', () => {
    for (const definition of games) {
      for (let seed = 1; seed <= 60; seed++) {
        const report = runConformance(definition, hooks(definition), seed);
        expect(report.failures).toEqual([]);
      }
    }
  });
});
