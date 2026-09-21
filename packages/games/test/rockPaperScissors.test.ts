import { describe, expect, it } from 'vitest';
import { hash256, toHex, utf8Encode, type CborValue } from '@airlink/core';
import {
  PAPER,
  ROCK,
  ROUNDS,
  SCISSORS,
  commitment,
  rockPaperScissors,
  roundWinner,
  unpackOutcome,
  type Choice,
  type RockPaperScissorsAction,
  type RockPaperScissorsState,
} from '../src/games/rockPaperScissors.js';
import { GameSession, type ActionOutcome } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, type PlayerId } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };

type Rps = GameSession<RockPaperScissorsState, RockPaperScissorsAction>;

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: rockPaperScissors, setup, localPlayer: local, isHost });
}

/** Where a player sits in `setup.players`, which is what a commitment binds to. */
const seat = (player: 'a' | 'b'): number => (player === 'a' ? 0 : 1);

const board = (s: Rps) => rockPaperScissors.encodeState(s.currentState);

/** The action an outcome applied, or a failure naming why it was refused. */
function accepted(outcome: ActionOutcome<RockPaperScissorsAction>): RockPaperScissorsAction {
  if (!outcome.accepted) throw new Error(`expected this action to be accepted, but: ${outcome.detail}`);
  return outcome.applied.action;
}

/**
 * The nonce and the choice are both derived from the player and the round, and
 * never stored, because a caller has to be able to recompute them at reveal time
 * from nothing but the state. The conformance driver is the strict case: it
 * calls legalAction once per ply with no memory in between, so a nonce drawn
 * from a generator at commit time would be irrecoverable one action later.
 *
 * A real client does the opposite - a fresh random nonce, held on the device
 * until the reveal - because a nonce anyone can recompute is not a secret and
 * hides nothing at all.
 */
function testNonce(player: PlayerId, round: number): string {
  return toHex(hash256(utf8Encode(`${player}#${round}`))).slice(0, 8);
}

function testChoice(player: PlayerId, round: number): Choice {
  return ((parseInt(testNonce(player, round).slice(0, 2), 16) % 3) + 1) as Choice;
}

/** Play one action on `from` and mirror it onto `to`, exactly as the link would. */
function play(from: Rps, to: Rps, player: 'a' | 'b', type: string, payload: CborValue) {
  const outcome = from.submitLocal(type, payload);
  if (outcome.accepted) to.applyRemote(rockPaperScissors.encodeAction(outcome.applied.action), player);
  return outcome;
}

/**
 * Both players commit and both reveal, i.e. one whole round.
 *
 * One nonce serves both players deliberately: a commitment is bound to the seat
 * that makes it, so two players who choose the same thing with the same nonce
 * still publish different digests, and a round played this way is the ordinary
 * case rather than a collision to be dodged.
 */
function playRound(a: Rps, b: Rps, choiceA: Choice, choiceB: Choice, nonce = 'nonce-abc') {
  const round = a.currentState.round;
  play(a, b, 'a', 'commit', { hash: commitment(seat('a'), round, choiceA, nonce) });
  play(b, a, 'b', 'commit', { hash: commitment(seat('b'), round, choiceB, nonce) });
  play(a, b, 'a', 'reveal', { choice: choiceA, nonce });
  play(b, a, 'b', 'reveal', { choice: choiceB, nonce });
}

describe('rock-paper-scissors rules', () => {
  it('starts with an empty first round and nobody committed', () => {
    const a = session('a', true);
    expect(a.currentState.round).toBe(0);
    expect(a.currentState.commits).toEqual([null, null]);
    expect(a.currentState.scores).toEqual([0, 0]);
    expect(a.turn).toBe('a');
  });

  it('asks the other player to commit once the first has, then the first to reveal', () => {
    const a = session('a', true);
    const b = session('b', false);
    expect(play(a, b, 'a', 'commit', { hash: commitment(0, 0, ROCK, 'nonce-abc') }).accepted).toBe(true);
    expect(b.turn).toBe('b');
    play(b, a, 'b', 'commit', { hash: commitment(1, 0, PAPER, 'nonce-abc') });
    expect(a.turn).toBe('a');
    play(a, b, 'a', 'reveal', { choice: ROCK, nonce: 'nonce-abc' });
    expect(a.turn).toBe('b');
  });

  it('refuses a second commitment from the same player', () => {
    const a = session('a', true);
    const b = session('b', false);
    play(a, b, 'a', 'commit', { hash: commitment(0, 0, ROCK, 'nonce-abc') });
    const again = a.submitLocal('commit', { hash: commitment(0, 0, PAPER, 'nonce-xyz') });
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already committed/);
  });

  it('refuses a reveal before the player has committed', () => {
    const a = session('a', true);
    const r = a.submitLocal('reveal', { choice: ROCK, nonce: 'nonce-abc' });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/commit before/);
  });

  it('refuses a reveal while the opponent is still free to choose', () => {
    const a = session('a', true);
    const b = session('b', false);
    play(a, b, 'a', 'commit', { hash: commitment(0, 0, ROCK, 'nonce-abc') });
    const early = a.submitLocal('reveal', { choice: ROCK, nonce: 'nonce-abc' });
    expect(early.accepted).toBe(false);
    expect(early.accepted === false && early.detail).toMatch(/has not committed/);
  });

  it('refuses a reveal that does not match its commitment', () => {
    const a = session('a', true);
    const b = session('b', false);
    play(a, b, 'a', 'commit', { hash: commitment(0, 0, ROCK, 'nonce-abc') });
    play(b, a, 'b', 'commit', { hash: commitment(1, 0, PAPER, 'nonce-xyz') });
    const lie = a.submitLocal('reveal', { choice: PAPER, nonce: 'nonce-abc' });
    expect(lie.accepted).toBe(false);
    expect(lie.accepted === false && lie.detail).toMatch(/does not match/);
    const wrongNonce = a.submitLocal('reveal', { choice: ROCK, nonce: 'nonce-different' });
    expect(wrongNonce.accepted).toBe(false);
    // The honest reveal is still available; a refused reveal changes nothing.
    expect(a.submitLocal('reveal', { choice: ROCK, nonce: 'nonce-abc' }).accepted).toBe(true);
  });

  it('refuses a reveal that opens the commitment a player made in an earlier round', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, ROCK, PAPER, 'nonce-abc');
    expect(a.currentState.round).toBe(1);
    // Round 0's digest, replayed in round 1, is not round 1's digest.
    play(a, b, 'a', 'commit', { hash: commitment(0, 0, ROCK, 'nonce-abc') });
    play(b, a, 'b', 'commit', { hash: commitment(1, 1, PAPER, 'nonce-abc') });
    expect(a.submitLocal('reveal', { choice: ROCK, nonce: 'nonce-abc' }).accepted).toBe(false);
  });

  it('refuses a nonce too short to hide a choice', () => {
    const a = session('a', true);
    const b = session('b', false);
    play(a, b, 'a', 'commit', { hash: commitment(0, 0, ROCK, 'z') });
    play(b, a, 'b', 'commit', { hash: commitment(1, 0, PAPER, 'nonce-xyz') });
    const r = a.submitLocal('reveal', { choice: ROCK, nonce: 'z' });
    expect(r.accepted).toBe(false);
  });

  it('scores a round only once both reveals are in, then starts the next', () => {
    const a = session('a', true);
    const b = session('b', false);
    play(a, b, 'a', 'commit', { hash: commitment(0, 0, PAPER, 'nonce-abc') });
    play(b, a, 'b', 'commit', { hash: commitment(1, 0, ROCK, 'nonce-xyz') });
    play(a, b, 'a', 'reveal', { choice: PAPER, nonce: 'nonce-abc' });
    expect(a.currentState.scores).toEqual([0, 0]);
    expect(a.currentState.round).toBe(0);
    play(b, a, 'b', 'reveal', { choice: ROCK, nonce: 'nonce-xyz' });
    expect(a.currentState.scores).toEqual([1, 0]);
    expect(a.currentState.round).toBe(1);
    expect(a.currentState.commits).toEqual([null, null]);
    expect(a.currentState.reveals).toEqual([0, 0]);
    // Both devices agree without either having seen the other's choice early.
    expect(board(b)).toEqual(board(a));
  });

  it('scores every pairing the way the playground does', () => {
    expect(roundWinner(ROCK, SCISSORS)).toBe(1);
    expect(roundWinner(PAPER, ROCK)).toBe(1);
    expect(roundWinner(SCISSORS, PAPER)).toBe(1);
    expect(roundWinner(SCISSORS, ROCK)).toBe(2);
    expect(roundWinner(ROCK, PAPER)).toBe(2);
    expect(roundWinner(PAPER, SCISSORS)).toBe(2);
    for (const c of [ROCK, PAPER, SCISSORS]) expect(roundWinner(c, c)).toBe(0);
  });

  it('credits the round to whichever player won it, not always the first', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, ROCK, PAPER); // paper covers rock: b
    expect(a.currentState.scores).toEqual([0, 1]);
    playRound(a, b, SCISSORS, PAPER); // scissors cut paper: a
    expect(a.currentState.scores).toEqual([1, 1]);
    playRound(a, b, ROCK, ROCK); // nothing
    expect(a.currentState.scores).toEqual([1, 1]);
  });

  it('records both choices of every finished round, reversibly', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, PAPER, ROCK);
    playRound(a, b, ROCK, SCISSORS);
    expect(a.currentState.outcomes.map(unpackOutcome)).toEqual([
      { first: PAPER, second: ROCK },
      { first: ROCK, second: SCISSORS },
    ]);
    expect(a.currentState.outcomes).toHaveLength(a.currentState.round);
  });

  it('ends the match as soon as one player has taken three rounds', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, PAPER, ROCK);
    playRound(a, b, PAPER, ROCK);
    expect(a.isOver).toBe(false);
    playRound(a, b, PAPER, ROCK);
    expect(a.status.kind).toBe(GameStatusKind.WON);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['a']);
    expect(a.currentState.round).toBe(3);
    expect(a.turn).toBeNull();
  });

  it('ends the match when the second player is the one who takes three rounds', () => {
    const a = session('a', true);
    const b = session('b', false);
    for (let round = 0; round < 3; round++) playRound(a, b, PAPER, SCISSORS);
    expect(a.currentState.scores).toEqual([0, 3]);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['b']);
    expect(a.status.kind === GameStatusKind.WON && a.status.reason).toBe('3-0');
    expect(board(b)).toEqual(board(a));
  });

  it('gives the match to the higher score when five rounds run out below three wins', () => {
    // Drawn rounds are not replayed, so a five-round match can finish 2-1.
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, ROCK, ROCK); // drawn
    playRound(a, b, PAPER, ROCK); // a
    playRound(a, b, SCISSORS, SCISSORS); // drawn
    playRound(a, b, ROCK, PAPER); // b
    playRound(a, b, SCISSORS, PAPER); // a
    expect(a.currentState.round).toBe(ROUNDS);
    expect(a.currentState.scores).toEqual([2, 1]);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['a']);
    expect(a.status.kind === GameStatusKind.WON && a.status.reason).toBe('2-1');
  });

  it('gives that same aggregate win to the second player when they are ahead', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, ROCK, ROCK); // drawn
    playRound(a, b, ROCK, PAPER); // b
    playRound(a, b, PAPER, PAPER); // drawn
    playRound(a, b, PAPER, ROCK); // a
    playRound(a, b, PAPER, SCISSORS); // b
    expect(a.currentState.scores).toEqual([1, 2]);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['b']);
    expect(a.status.kind === GameStatusKind.WON && a.status.reason).toBe('2-1');
  });

  it('draws when five drawn rounds run the match out', () => {
    const a = session('a', true);
    const b = session('b', false);
    for (let round = 0; round < ROUNDS; round++) playRound(a, b, ROCK, ROCK);
    expect(a.currentState.round).toBe(ROUNDS);
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
    expect(a.currentState.scores).toEqual([0, 0]);
  });

  it('draws when five rounds end level rather than leaving the match open', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, PAPER, ROCK); // a
    playRound(a, b, ROCK, PAPER); // b
    playRound(a, b, PAPER, ROCK); // a
    playRound(a, b, ROCK, PAPER); // b
    playRound(a, b, ROCK, ROCK); // drawn
    expect(a.currentState.scores).toEqual([2, 2]);
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
    expect(a.turn).toBeNull();
  });

  it('refuses anything at all once the match is over', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, SCISSORS, PAPER);
    playRound(a, b, SCISSORS, PAPER);
    playRound(a, b, SCISSORS, PAPER);
    expect(a.isOver).toBe(true);
    expect(a.submitLocal('commit', { hash: commitment(0, 3, ROCK, 'nonce-abc') }).accepted).toBe(false);
  });

  it('will not let one player commit as another', () => {
    const b = session('b', false);
    const forged = rockPaperScissors.encodeAction({
      type: 'commit',
      player: 'a',
      seq: 0,
      payload: { hash: commitment(0, 0, ROCK, 'nonce-abc') },
    });
    // The session authenticated the sender as 'b', so the action is attributed
    // to b however the packet was addressed - and then b has committed, not a.
    const r = b.applyRemote(forged, 'b');
    expect(r.accepted).toBe(true);
    expect(b.currentState.commits[0]).toBeNull();
    expect(b.applyRemote(forged, 'not-in-this-game').accepted).toBe(false);
  });
});

describe('rock-paper-scissors commitments', () => {
  it('binds a commitment to the seat and the round that made it', () => {
    // Same choice, same nonce, four different digests - which is what stops a
    // copied commitment and a replayed reveal from opening anything.
    const digests = new Set([
      commitment(0, 0, ROCK, 'nonce-abc'),
      commitment(1, 0, ROCK, 'nonce-abc'),
      commitment(0, 1, ROCK, 'nonce-abc'),
      commitment(1, 1, ROCK, 'nonce-abc'),
    ]);
    expect(digests.size).toBe(4);
    expect(commitment(0, 0, ROCK, 'nonce-abc')).toBe(commitment(0, 0, ROCK, 'nonce-abc'));
    expect(commitment(0, 0, ROCK, 'nonce-abc')).not.toBe(commitment(0, 0, PAPER, 'nonce-abc'));
  });

  it('lets a copied commitment be made, and leaves it impossible to open', () => {
    const a = session('a', true);
    const b = session('b', false);
    const hash = commitment(0, 0, ROCK, 'nonce-abc');
    play(a, b, 'a', 'commit', { hash });
    // Copying is accepted: refusing it would mean judging one player's move by
    // the other's, which the two devices cannot do in the same order.
    expect(play(b, a, 'b', 'commit', { hash }).accepted).toBe(true);
    expect(board(b)).toEqual(board(a));

    play(a, b, 'a', 'reveal', { choice: ROCK, nonce: 'nonce-abc' });
    // b now holds a's choice AND a's nonce, in the clear, off the wire. Replaying
    // the pair is the forced draw the binding exists to kill.
    expect(b.submitLocal('reveal', { choice: ROCK, nonce: 'nonce-abc' }).accepted).toBe(false);
    for (const choice of [ROCK, PAPER, SCISSORS]) {
      expect(b.submitLocal('reveal', { choice, nonce: 'nonce-abc' }).accepted).toBe(false);
    }
    expect(b.currentState.scores).toEqual([0, 0]);
  });

  it('keeps a commitment short enough for a snapshot to fit one packet', () => {
    expect(commitment(0, 0, ROCK, 'nonce-abc')).toHaveLength(32);
    expect(commitment(0, 0, ROCK, 'nonce-abc')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('rock-paper-scissors concurrency', () => {
  /**
   * The commit phase is not serialised, so each device applies its own commit at
   * once and the peer's when it lands: the two apply the SAME pair in OPPOSITE
   * orders. Every rule has to give both of them the same answer.
   */
  it('agrees on the board when both devices act at the same instant', () => {
    const choices: Choice[] = [ROCK, PAPER, SCISSORS];
    for (const choiceA of choices) {
      for (const choiceB of choices) {
        const a = session('a', true);
        const b = session('b', false);
        const nonce = 'nonce-shared';

        const commitA = accepted(a.submitLocal('commit', { hash: commitment(0, 0, choiceA, nonce) }));
        const commitB = accepted(b.submitLocal('commit', { hash: commitment(1, 0, choiceB, nonce) }));
        expect(a.applyRemote(rockPaperScissors.encodeAction(commitB), 'b').accepted).toBe(true);
        expect(b.applyRemote(rockPaperScissors.encodeAction(commitA), 'a').accepted).toBe(true);
        expect(board(b)).toEqual(board(a));

        const revealA = accepted(a.submitLocal('reveal', { choice: choiceA, nonce }));
        const revealB = accepted(b.submitLocal('reveal', { choice: choiceB, nonce }));
        expect(a.applyRemote(rockPaperScissors.encodeAction(revealB), 'b').accepted).toBe(true);
        expect(b.applyRemote(rockPaperScissors.encodeAction(revealA), 'a').accepted).toBe(true);

        expect(board(b)).toEqual(board(a));
        expect(a.currentState.round).toBe(1);
        const winner = roundWinner(choiceA, choiceB);
        expect(a.currentState.scores).toEqual([winner === 1 ? 1 : 0, winner === 2 ? 1 : 0]);
      }
    }
  });
});

describe('rock-paper-scissors wire format', () => {
  it('round-trips a state that is mid-round', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, PAPER, ROCK);
    play(a, b, 'a', 'commit', { hash: commitment(0, 1, SCISSORS, 'nonce-abc') });
    const restored = rockPaperScissors.decodeState(rockPaperScissors.encodeState(a.currentState));
    expect(restored).toEqual(a.currentState);
  });

  it('round-trips a state with one reveal open, keeping every field', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, PAPER, ROCK);
    play(a, b, 'a', 'commit', { hash: commitment(0, 1, SCISSORS, 'nonce-abc') });
    play(b, a, 'b', 'commit', { hash: commitment(1, 1, ROCK, 'nonce-xyz') });
    play(a, b, 'a', 'reveal', { choice: SCISSORS, nonce: 'nonce-abc' });
    const restored = rockPaperScissors.decodeState(rockPaperScissors.encodeState(a.currentState));
    expect(restored).toEqual(a.currentState);
    expect(restored.reveals).toEqual([SCISSORS, 0]);
    expect(restored.commits.every((c) => c !== null)).toBe(true);
    expect(restored.outcomes).toEqual(a.currentState.outcomes);
  });

  it('round-trips both action types', () => {
    const commit = {
      type: 'commit' as const,
      player: 'a',
      seq: 3,
      payload: { hash: commitment(0, 0, ROCK, 'nonce-abc') },
    };
    expect(rockPaperScissors.decodeAction(rockPaperScissors.encodeAction(commit), 'a')).toEqual(commit);
    const reveal = { type: 'reveal' as const, player: 'b', seq: 4, payload: { choice: SCISSORS, nonce: 'nonce-xyz' } };
    expect(rockPaperScissors.decodeAction(rockPaperScissors.encodeAction(reveal), 'b')).toEqual(reveal);
  });

  it('throws on anything a hostile peer might send', () => {
    const hostile = [
      null,
      'commit',
      { t: 'surrender', s: 0, p: {} },
      { t: 'commit', s: 0, p: null },
      { t: 'commit', s: 0, p: { h: 'not hex at all, not even close' } },
      { t: 'commit', s: 0, p: { h: commitment(0, 0, ROCK, 'nonce-abc').toUpperCase() } },
      { t: 'commit', s: 0, p: { h: 42 } },
      { t: 'commit', s: 0, p: { h: '' } },
      { t: 'reveal', s: 0, p: { c: 4, n: 'nonce-abc' } },
      { t: 'reveal', s: 0, p: { c: 0, n: 'nonce-abc' } },
      { t: 'reveal', s: 0, p: { c: 1.5, n: 'nonce-abc' } },
      { t: 'reveal', s: 0, p: { c: 1, n: 'short' } },
      { t: 'reveal', s: 0, p: { c: 1, n: 'x'.repeat(500) } },
      { t: 'reveal', s: 0, p: { c: 1, n: 12345678 } },
      { t: 'reveal', s: 0, p: { c: 1 } },
    ];
    for (const junk of hostile) {
      expect(() => rockPaperScissors.decodeAction(junk as CborValue, 'a')).toThrow();
    }
  });

  it('throws on a malformed state', () => {
    const good = rockPaperScissors.encodeState(session('a', true).currentState) as Record<string, unknown>;
    expect(() => rockPaperScissors.decodeState({ ...good, p: ['a'] })).toThrow();
    expect(() => rockPaperScissors.decodeState({ ...good, n: ROUNDS + 1 })).toThrow();
    expect(() => rockPaperScissors.decodeState({ ...good, c: ['nope', null] })).toThrow();
    // 8 unpacks to (2, 0), which names no second choice.
    expect(() => rockPaperScissors.decodeState({ ...good, o: [8] })).toThrow();
  });

  it('throws on a state that is well formed but could never have been played', () => {
    const a = session('a', true);
    const b = session('b', false);
    playRound(a, b, PAPER, ROCK); // a leads 1-0 after one round
    play(a, b, 'a', 'commit', { hash: commitment(0, 1, SCISSORS, 'nonce-abc') });
    play(b, a, 'b', 'commit', { hash: commitment(1, 1, ROCK, 'nonce-xyz') });
    const good = rockPaperScissors.encodeState(a.currentState) as Record<string, CborValue>;
    expect(rockPaperScissors.decodeState({ ...good })).toEqual(a.currentState);

    // A score that does not follow from the rounds actually played.
    expect(() => rockPaperScissors.decodeState({ ...good, s: [3, 0] })).toThrow(/do not follow/);
    // A round counter that does not match the rounds recorded.
    expect(() => rockPaperScissors.decodeState({ ...good, n: 4 })).toThrow(/outcomes for round/);
    // A choice revealed by a player nobody had committed against.
    expect(() => rockPaperScissors.decodeState({ ...good, c: [null, null], v: [ROCK, 0] })).toThrow(
      /without both commitments/,
    );
    // Both choices open: that position always scores at once and clears itself.
    expect(() => rockPaperScissors.decodeState({ ...good, v: [ROCK, PAPER] })).toThrow(/without the round being scored/);
  });
});

describe('rock-paper-scissors conformance', () => {
  const hooks = {
    legalAction: (state: RockPaperScissorsState, player: PlayerId) => {
      const index = state.players.indexOf(player);
      if (index < 0) return null;
      const nonce = testNonce(player, state.round);
      const choice = testChoice(player, state.round);
      if (state.commits[index] === null) {
        return { type: 'commit', payload: { hash: commitment(index, state.round, choice, nonce) } };
      }
      if (state.commits[1 - index] === null) return null; // waiting for the opponent
      if (state.reveals[index] !== 0) return null;
      return { type: 'reveal', payload: { choice, nonce } };
    },
    maxPlies: 30,
  };

  it('passes the shared game conformance suite', () => {
    const report = runConformance(rockPaperScissors, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(rockPaperScissors, hooks, seed);
      expect(report.failures).toEqual([]);
    }
  });
});
