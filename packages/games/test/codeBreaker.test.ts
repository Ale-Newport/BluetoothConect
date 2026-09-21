import { describe, expect, it } from 'vitest';
import {
  CODE_LENGTH,
  COLOURS,
  MAX_GUESSES,
  codeBreaker,
  scoreGuess,
  type CodeBreakerAction,
  type CodeBreakerState,
} from '../src/games/codeBreaker.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext, type CborValue } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: codeBreaker, setup, localPlayer: local, isHost });
}

/** Two sessions kept in step by hand, the way two phones are kept in step by the link. */
function duel() {
  const a = session('a', true);
  const b = session('b', false);
  const play = (player: 'a' | 'b', guess: readonly number[]) => {
    const from = player === 'a' ? a : b;
    const to = player === 'a' ? b : a;
    const r = from.submitLocal('guess', { guess: [...guess] });
    if (r.accepted) to.applyRemote(codeBreaker.encodeAction(r.applied.action), player);
    return r;
  };
  return { a, b, play, secret: a.currentState.secret };
}

/** A code that is certainly not the answer, so a test can burn a guess safely. */
function miss(secret: readonly number[]): number[] {
  const wrong = [...secret];
  wrong[0] = ((secret[0] as number) + 1) % COLOURS;
  return wrong;
}

describe('code breaker scoring', () => {
  it('reports a perfect break', () => {
    expect(scoreGuess([0, 1, 2, 3], [0, 1, 2, 3])).toEqual({ exact: 4, colour: 0 });
  });

  it('reports a complete miss', () => {
    expect(scoreGuess([0, 0, 0, 0], [1, 1, 1, 1])).toEqual({ exact: 0, colour: 0 });
  });

  it('reports a full permutation as all misplaced', () => {
    expect(scoreGuess([0, 1, 2, 3], [3, 2, 1, 0])).toEqual({ exact: 0, colour: 4 });
  });

  it('does not let one peg of the code pay for several of the guess', () => {
    // The naive algorithm answers 1 exact + 3 misplaced here, claiming four
    // zeros in a code that holds exactly one.
    expect(scoreGuess([0, 1, 2, 3], [0, 0, 0, 0])).toEqual({ exact: 1, colour: 0 });
  });

  it('does not let one peg of the guess collect several of the code', () => {
    expect(scoreGuess([0, 0, 0, 0], [0, 1, 2, 3])).toEqual({ exact: 1, colour: 0 });
  });

  it('matches repeats as multisets once exact hits are removed', () => {
    expect(scoreGuess([0, 0, 1, 2], [0, 1, 0, 0])).toEqual({ exact: 1, colour: 2 });
    expect(scoreGuess([1, 2, 3, 4], [2, 1, 4, 3])).toEqual({ exact: 0, colour: 4 });
    expect(scoreGuess([5, 5, 3, 3], [3, 5, 5, 0])).toEqual({ exact: 1, colour: 2 });
  });
});

describe('code breaker rules', () => {
  it('derives the same code on both devices, and only from the seed', () => {
    const a = session('a', true);
    const b = session('b', false);
    expect(a.currentState.secret).toEqual(b.currentState.secret);
    expect(a.currentState.secret).toHaveLength(CODE_LENGTH);
    for (const peg of a.currentState.secret) {
      expect(Number.isInteger(peg)).toBe(true);
      expect(peg).toBeGreaterThanOrEqual(0);
      expect(peg).toBeLessThan(COLOURS);
    }
  });

  it('starts with two empty boards and the first player to move', () => {
    const s = session('a', true);
    expect(s.currentState.boards).toEqual([[], []]);
    expect(s.turn).toBe('a');
    expect(s.isLocalTurn).toBe(true);
  });

  it('scores a guess onto the guesser\'s own board and passes the turn', () => {
    const { a, play, secret } = duel();
    const guess = miss(secret);
    expect(play('a', guess).accepted).toBe(true);
    // The expectation is a literal rather than another call to scoreGuess,
    // which would only assert that the reducer agrees with itself. `miss`
    // moves exactly one peg to a colour the code does not hold in that place,
    // so whatever the code is, the answer is three exact and nothing else.
    expect(a.currentState.boards[0]).toEqual([{ guess, exact: 3, colour: 0 }]);
    expect(a.currentState.boards[1]).toEqual([]);
    expect(a.turn).toBe('b');
  });

  it('draws a different code from a different seed', () => {
    // Without this, a game that ignored the seed entirely and dealt the same
    // four pegs for ever would pass every other test in this file: the rest
    // only ever check that two devices sharing ONE seed agree with each other.
    const codeOf = (seed: number) =>
      codeBreaker.createInitialState({ players: ['a', 'b'], seed, options: {} }).secret.join('');
    const codes = new Set(Array.from({ length: 200 }, (_, seed) => codeOf(seed)));
    expect(codes.size).toBeGreaterThan(100);
    expect(codeOf(42)).toBe(codeOf(42));
  });

  it('decides a race that runs past the first round', () => {
    // Every other outcome test here is settled on round one, which cannot tell
    // a working history apart from one that only ever reads its last entry.
    const { a, play, secret } = duel();
    const wrong = miss(secret);
    for (let round = 0; round < 3; round++) {
      expect(play('a', wrong).accepted).toBe(true);
      expect(play('b', wrong).accepted).toBe(true);
    }
    expect(a.status.kind).toBe(GameStatusKind.IN_PROGRESS);
    play('a', wrong);
    expect(play('b', secret).accepted).toBe(true);
    expect(a.currentState.boards[1]).toHaveLength(4);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['b']);
  });

  it('lets the trailing player read the leader\'s break off the shared board', () => {
    // Not a rule anybody wanted: a characterisation test for the flaw the
    // header describes. The code is unique, so player one's breaking guess IS
    // the only guess that breaks it, and it is on player two's screen before
    // player two answers. Copying it draws, every time, in every game player
    // one would otherwise have won. Pinned here so that a change which claims
    // to fix the equalising guess has to come and delete this test on purpose.
    const { a, play, secret } = duel();
    play('a', miss(secret));
    play('b', miss(secret));
    expect(play('a', secret).accepted).toBe(true);
    const leadersBoard = a.currentState.boards[0] ?? [];
    const leadersBreak = leadersBoard[leadersBoard.length - 1];
    expect(leadersBreak?.exact).toBe(CODE_LENGTH);
    expect(play('b', leadersBreak?.guess ?? []).accepted).toBe(true);
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
  });

  it('refuses a guess out of turn', () => {
    const { play, secret } = duel();
    expect(play('b', miss(secret)).accepted).toBe(false);
  });

  it('refuses a guess of the wrong length or with an out-of-range peg', () => {
    const s = session('a', true);
    expect(s.submitLocal('guess', { guess: [0, 1, 2] }).accepted).toBe(false);
    expect(s.submitLocal('guess', { guess: [0, 1, 2, 3, 4] }).accepted).toBe(false);
    expect(s.submitLocal('guess', { guess: [0, 1, 2, COLOURS] }).accepted).toBe(false);
    expect(s.submitLocal('guess', { guess: [-1, 0, 0, 0] }).accepted).toBe(false);
    expect(s.submitLocal('guess', { guess: 'nope' }).accepted).toBe(false);
  });

  it('does not end the game until the leader\'s opponent has answered', () => {
    const { a, play, secret } = duel();
    expect(play('a', secret).accepted).toBe(true);
    // Player one broke it, but player two has had one guess fewer.
    expect(a.status.kind).toBe(GameStatusKind.IN_PROGRESS);
    expect(a.turn).toBe('b');
    expect(play('b', miss(secret)).accepted).toBe(true);
    expect(a.status.kind).toBe(GameStatusKind.WON);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['a']);
    expect(a.turn).toBeNull();
  });

  it('ends at once when the second player breaks it, the round being complete', () => {
    const { a, b, play, secret } = duel();
    play('a', miss(secret));
    expect(play('b', secret).accepted).toBe(true);
    expect(b.status.kind === GameStatusKind.WON && b.status.winners).toEqual(['b']);
    expect(a.status.kind).toBe(GameStatusKind.WON);
  });

  it('calls a dead heat a draw', () => {
    const { a, play, secret } = duel();
    play('a', secret);
    play('b', secret);
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
  });

  it('draws when neither breaks the code in ten guesses', () => {
    const { a, play, secret } = duel();
    const wrong = miss(secret);
    for (let round = 0; round < MAX_GUESSES; round++) {
      expect(play('a', wrong).accepted).toBe(true);
      expect(play('b', wrong).accepted).toBe(true);
    }
    expect(a.currentState.boards[0]).toHaveLength(MAX_GUESSES);
    expect(a.currentState.boards[1]).toHaveLength(MAX_GUESSES);
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
    expect(a.turn).toBeNull();
    expect(play('a', wrong).accepted).toBe(false);
  });

  it('rejects a guess once the game is over', () => {
    const { play, secret } = duel();
    play('a', secret);
    play('b', miss(secret));
    expect(play('a', miss(secret)).accepted).toBe(false);
  });

  it('rejects a duplicate action rather than scoring it twice', () => {
    const { a, b, secret } = duel();
    const r = a.submitLocal('guess', { guess: miss(secret) });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = codeBreaker.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted === false && again.reason).toBe('duplicate');
    expect(b.currentState.boards[0]).toHaveLength(1);
  });

  it('will not let one player guess as another', () => {
    const b = session('b', false);
    const forged = codeBreaker.encodeAction({ type: 'guess', player: 'a', seq: 0, payload: { guess: [0, 0, 0, 0] } });
    // The session authenticated us as 'b', so the action is attributed to b -
    // and b is not to move, so it is refused.
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
  });

  it('does not mutate the state it is given', () => {
    const { a, secret } = duel();
    const before = a.currentState;
    const boardBefore = before.boards[0];
    const next = codeBreaker.applyAction(
      before,
      { type: 'guess', player: 'a', seq: 0, payload: { guess: miss(secret) } },
      createContext(['a', 'b'], setup.seed),
    );
    expect(boardBefore).toHaveLength(0);
    expect(before.boards[0]).toHaveLength(0);
    expect(next.boards[0]).toHaveLength(1);
    // The board nobody touched may be shared by reference; that is not mutation.
    expect(next.boards[1]).toBe(before.boards[1]);
  });
});

/**
 * The rules on their own account.
 *
 * Everything in `code breaker rules` above goes through a GameSession, and a
 * session decodes an action before it validates one and refuses to touch a
 * finished game at all. So those tests prove decodeAction and the runtime work,
 * not that these rules do: every guard in validateAction except the turn check
 * can be deleted outright and the suite above stays green. validateAction is
 * the last thing an action meets before it is applied, and a replay or a future
 * runtime may be all that stands in front of it, so it is checked here directly.
 */
describe('code breaker validation', () => {
  const ctx = createContext(setup.players, setup.seed);
  const guess = (player: string, pegs: unknown, seq = 0) =>
    ({ type: 'guess', player, seq, payload: { guess: pegs } }) as unknown as CodeBreakerAction;

  /** A board of `count` attempts. Only its length is ever read. */
  const filler = (count: number, secret: readonly number[]) =>
    Array.from({ length: count }, () => ({ guess: miss(secret), exact: 3, colour: 0 }));

  it('refuses an impossible peg in the rules, not only in the decoder', () => {
    const state = codeBreaker.createInitialState(setup);
    for (const pegs of [
      [0, 0, 0, COLOURS],
      [0, 0, 0, -1],
      [0, 0, 0, 1.5],
      [0, 0, 0, Number.NaN],
      [0, 0, 0, Number.POSITIVE_INFINITY],
      [0, 0, 0, 1e12],
      [0, 0, 0, '3'],
    ]) {
      const result = codeBreaker.validateAction(state, guess('a', pegs), ctx);
      expect(result.ok === false && result.reason).toMatch(/each peg must be/);
    }
  });

  it('refuses a guess that is not four pegs, in the rules', () => {
    const state = codeBreaker.createInitialState(setup);
    for (const pegs of [[0, 0, 0], [0, 0, 0, 0, 0], [], 'nope', null, undefined, 4, { 0: 0, length: 4 }]) {
      const result = codeBreaker.validateAction(state, guess('a', pegs), ctx);
      expect(result.ok === false && result.reason).toMatch(/must be 4 pegs/);
    }
    const noPayload = { type: 'guess', player: 'a', seq: 0 } as unknown as CodeBreakerAction;
    expect(codeBreaker.validateAction(state, noPayload, ctx).ok).toBe(false);
  });

  it('refuses an action that is not a guess, in the rules', () => {
    const state = codeBreaker.createInitialState(setup);
    const resign = { type: 'resign', player: 'a', seq: 0, payload: { guess: [0, 0, 0, 0] } };
    const result = codeBreaker.validateAction(state, resign as unknown as CodeBreakerAction, ctx);
    expect(result.ok === false && result.reason).toMatch(/resign/);
  });

  it('refuses a guess after the end, in the rules', () => {
    // Built with the reducer rather than a session, so nothing but
    // validateAction is standing in the way when the guess arrives.
    let state = codeBreaker.createInitialState(setup);
    state = codeBreaker.applyAction(state, guess('a', [...state.secret]), ctx);
    state = codeBreaker.applyAction(state, guess('b', miss(state.secret)), ctx);
    expect(codeBreaker.status(state).kind).toBe(GameStatusKind.WON);
    for (const player of ['a', 'b']) {
      const result = codeBreaker.validateAction(state, guess(player, [0, 0, 0, 0]), ctx);
      expect(result.ok === false && result.reason).toMatch(/already finished/);
    }
  });

  it('will not grow a board past the guess limit even if status is wrong about it', () => {
    // Unreachable through play - a player out of guesses is either finished or
    // owed nothing - so the state is built by hand, which is the only way to
    // test a guard whose whole job is to survive a future rule change. Boards
    // of 11 and 10 leave status() calling the game in progress and the turn
    // with a player who has nothing left.
    const secret = [0, 1, 2, 3];
    const state: CodeBreakerState = {
      players: ['a', 'b'],
      secret,
      boards: [filler(MAX_GUESSES + 1, secret), filler(MAX_GUESSES, secret)],
    };
    expect(codeBreaker.status(state).kind).toBe(GameStatusKind.IN_PROGRESS);
    expect(codeBreaker.currentTurn?.(state)).toBe('b');
    const result = codeBreaker.validateAction(state, guess('b', [0, 0, 0, 0]), ctx);
    expect(result.ok === false && result.reason).toMatch(/all 10 guesses/);
  });
});

describe('code breaker codecs', () => {
  it('round-trips a played state, feedback included', () => {
    const { a, play, secret } = duel();
    play('a', miss(secret));
    play('b', [0, 0, 1, 1]);
    play('a', [5, 4, 3, 2]);
    const restored = codeBreaker.decodeState(codeBreaker.encodeState(a.currentState));
    expect(restored).toEqual(a.currentState);
    expect(codeBreaker.encodeState(restored)).toEqual(codeBreaker.encodeState(a.currentState));
  });

  it('round-trips an action', () => {
    const action = { type: 'guess' as const, player: 'a', seq: 7, payload: { guess: [1, 5, 0, 3] } };
    const restored = codeBreaker.decodeAction(codeBreaker.encodeAction(action), 'a');
    expect(restored).toEqual(action);
  });

  it('throws on a hostile action', () => {
    expect(() => codeBreaker.decodeAction(null, 'a')).toThrow();
    expect(() => codeBreaker.decodeAction('guess', 'a')).toThrow();
    expect(() => codeBreaker.decodeAction({ t: 'resign', s: 0, p: { g: [0, 0, 0, 0] } }, 'a')).toThrow();
    expect(() => codeBreaker.decodeAction({ t: 'guess', s: 0, p: null }, 'a')).toThrow();
    expect(() => codeBreaker.decodeAction({ t: 'guess', s: 0, p: { g: [0, 0, 0] } }, 'a')).toThrow();
    expect(() => codeBreaker.decodeAction({ t: 'guess', s: 0, p: { g: [0, 0, 0, 0, 0] } }, 'a')).toThrow();
    expect(() => codeBreaker.decodeAction({ t: 'guess', s: 0, p: { g: [0, 0, 0, COLOURS] } }, 'a')).toThrow();
    expect(() => codeBreaker.decodeAction({ t: 'guess', s: 0, p: { g: [0, 0, 0, 1.5] } }, 'a')).toThrow();
    expect(() => codeBreaker.decodeAction({ t: 'guess', s: 0, p: { g: [0, 0, 0, '3'] } }, 'a')).toThrow();
    expect(() => codeBreaker.decodeAction({ t: 'guess', s: -1, p: { g: [0, 0, 0, 0] } }, 'a')).toThrow();
  });

  it('throws on a hostile state', () => {
    const good = codeBreaker.encodeState(session('a', true).currentState) as Record<string, CborValue>;
    expect(() => codeBreaker.decodeState(null)).toThrow();
    expect(() => codeBreaker.decodeState({ ...good, s: [0, 1, 2] })).toThrow();
    expect(() => codeBreaker.decodeState({ ...good, s: [0, 1, 2, COLOURS] })).toThrow();
    expect(() => codeBreaker.decodeState({ ...good, p: ['a'] })).toThrow();
    expect(() => codeBreaker.decodeState({ ...good, p: ['a', 7 as CborValue] })).toThrow();
    expect(() => codeBreaker.decodeState({ ...good, g: [[]] })).toThrow();
    // Three pegs is not a whole guess.
    expect(() => codeBreaker.decodeState({ ...good, g: [[0, 0, 0], []] })).toThrow();
    // Eleven guesses is past the limit that makes this game terminate.
    expect(() =>
      codeBreaker.decodeState({ ...good, g: [Array.from({ length: 44 }, () => 0), []] }),
    ).toThrow();
    // Player two ahead of player one: the derived turn would never recover.
    expect(() => codeBreaker.decodeState({ ...good, g: [[], [0, 0, 0, 0]] })).toThrow();
    // More than two boards, which asArray refuses before the count is checked.
    expect(() => codeBreaker.decodeState({ ...good, g: [[], [], []] })).toThrow();
  });

  it('refuses a history that kept guessing after breaking the code', () => {
    const state = session('a', true).currentState;
    const good = codeBreaker.encodeState(state) as Record<string, CborValue>;
    const wrong = miss(state.secret);
    // A break ends its round, so it can only ever be a board's last attempt.
    expect(() => codeBreaker.decodeState({ ...good, g: [[...state.secret, ...wrong], [...wrong, ...wrong]] })).toThrow(
      /after breaking the code/,
    );
    // The same pegs as the final attempt are a legitimate finished game.
    const finished = codeBreaker.decodeState({ ...good, g: [[...wrong, ...state.secret], [...wrong, ...wrong]] });
    expect(codeBreaker.status(finished).kind).toBe(GameStatusKind.WON);
  });

  it('accepts a board that used every one of its guesses', () => {
    // MAX_GUESSES * CODE_LENGTH pegs is the largest legal board, and the cap
    // that rejects an eleventh guess must not also reject the tenth.
    const state = session('a', true).currentState;
    const good = codeBreaker.encodeState(state) as Record<string, CborValue>;
    const full = Array.from({ length: MAX_GUESSES * CODE_LENGTH }, (_, i) => miss(state.secret)[i % CODE_LENGTH] as number);
    const restored = codeBreaker.decodeState({ ...good, g: [full, full] });
    expect(restored.boards[0]).toHaveLength(MAX_GUESSES);
    expect(codeBreaker.status(restored).kind).toBe(GameStatusKind.DRAW);
  });
});

describe('code breaker conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(codeBreaker, {
      legalAction: (state, player, random) => {
        if (codeBreaker.currentTurn?.(state) !== player) return null;
        return {
          type: 'guess',
          payload: { guess: Array.from({ length: CODE_LENGTH }, () => random.nextInt(COLOURS)) },
        };
      },
      maxPlies: 2 * MAX_GUESSES + 5,
    });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(
        codeBreaker,
        {
          legalAction: (state, player, random) => {
            if (codeBreaker.currentTurn?.(state) !== player) return null;
            return {
              type: 'guess',
              payload: { guess: Array.from({ length: CODE_LENGTH }, () => random.nextInt(COLOURS)) },
            };
          },
          maxPlies: 2 * MAX_GUESSES + 5,
        },
        seed,
      );
      expect(report.failures).toEqual([]);
      expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
    }
  });
});
