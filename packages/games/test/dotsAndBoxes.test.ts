import { describe, expect, it } from 'vitest';
import {
  EDGE_COUNT,
  H_COUNT,
  Orientation,
  V_COUNT,
  dotsAndBoxes,
  type DotsAndBoxesAction,
  type DotsAndBoxesState,
} from '../src/games/dotsAndBoxes.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };
/** Turn-based games ignore the context entirely; it is here to satisfy the signature. */
const context = createContext(setup.players, setup.seed);

type Who = 'a' | 'b';

function session(local: Who, isHost: boolean) {
  return new GameSession({ definition: dotsAndBoxes, setup, localPlayer: local, isHost });
}

/** A pair of sessions kept in step, so every test exercises the wire path. */
function table() {
  const a = session('a', true);
  const b = session('b', false);
  const play = (player: Who, orientation: number, index: number) => {
    const from = player === 'a' ? a : b;
    const to = player === 'a' ? b : a;
    const r = from.submitLocal('draw', { orientation, index });
    if (r.accepted) to.applyRemote(dotsAndBoxes.encodeAction(r.applied.action), player);
    return r;
  };
  return { a, b, play };
}

const h = (index: number) => [Orientation.HORIZONTAL, index] as const;
const v = (index: number) => [Orientation.VERTICAL, index] as const;

describe('dots and boxes rules', () => {
  it('starts with an empty grid and the first player to move', () => {
    const { a } = table();
    const s = a.currentState;
    expect(s.h).toHaveLength(H_COUNT);
    expect(s.v).toHaveLength(V_COUNT);
    expect(s.h.some(Boolean)).toBe(false);
    expect(s.v.some(Boolean)).toBe(false);
    expect(s.boxes).toHaveLength(25);
    expect(s.scores).toEqual([0, 0]);
    expect(a.turn).toBe('a');
    expect(a.isLocalTurn).toBe(true);
  });

  it('refuses a move out of turn', () => {
    const { play } = table();
    expect(play('b', ...h(0)).accepted).toBe(false);
  });

  it('refuses a line that is already drawn', () => {
    const { play } = table();
    expect(play('a', ...h(0)).accepted).toBe(true);
    const r = play('b', ...h(0));
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/already drawn/);
  });

  it('refuses an index past the end of either array', () => {
    const { a } = table();
    expect(a.submitLocal('draw', { orientation: Orientation.HORIZONTAL, index: H_COUNT }).accepted).toBe(false);
    expect(a.submitLocal('draw', { orientation: Orientation.VERTICAL, index: V_COUNT }).accepted).toBe(false);
    expect(a.submitLocal('draw', { orientation: Orientation.HORIZONTAL, index: -1 }).accepted).toBe(false);
    expect(a.submitLocal('erase', { orientation: 0, index: 0 }).accepted).toBe(false);
  });

  it('refuses a third orientation instead of reading it as horizontal', () => {
    const { a } = table();
    // The interesting half of this is that the move is REFUSED rather than
    // quietly reinterpreted. Orientation is on the wire as an integer, so a
    // nonsense value survives the encoder intact and the decoder rejects it;
    // squeezing it into "is it vertical?" would have turned a 7 into a legal
    // horizontal line and drawn it.
    const r = a.submitLocal('draw', { orientation: 7, index: 0 });
    expect(r.accepted).toBe(false);
    expect(a.currentState.h[0]).toBe(false);
    expect(a.currentState.v[0]).toBe(false);
    expect(a.currentState.drawn).toBe(0);
    expect(a.turn).toBe('a');
    expect(() => dotsAndBoxes.decodeAction({ t: 'draw', s: 0, p: { o: 7, i: 0 } }, 'a')).toThrow();
    expect(() => dotsAndBoxes.decodeAction({ t: 'draw', s: 0, p: { o: -1, i: 0 } }, 'a')).toThrow();
  });

  /**
   * The validator's own branches, called directly.
   *
   * Every test above reaches it through a GameSession, which decodes first and
   * refuses an out-of-range index before the validator ever sees it - so those
   * tests prove the codec, not the validator. A hostile peer is not obliged to
   * use our codec, and the validator is the last thing standing between it and
   * the board, so it is exercised here with no codec in the way.
   */
  it('rejects hostile actions at the validator itself', () => {
    const fresh = dotsAndBoxes.createInitialState(setup);
    const draw = (player: string, orientation: number, index: number) =>
      ({ type: 'draw', player, seq: 0, payload: { orientation, index } }) as DotsAndBoxesAction;
    const ok = (action: DotsAndBoxesAction) => dotsAndBoxes.validateAction(fresh, action, context).ok;

    expect(ok(draw('a', Orientation.HORIZONTAL, 0))).toBe(true);
    expect(ok(draw('b', Orientation.HORIZONTAL, 0))).toBe(false); // out of turn
    expect(ok(draw('a', Orientation.HORIZONTAL, H_COUNT))).toBe(false);
    expect(ok(draw('a', Orientation.VERTICAL, V_COUNT))).toBe(false);
    expect(ok(draw('a', Orientation.HORIZONTAL, -1))).toBe(false);
    expect(ok(draw('a', Orientation.HORIZONTAL, 1.5))).toBe(false);
    expect(ok(draw('a', Orientation.HORIZONTAL, Number.NaN))).toBe(false);
    expect(ok(draw('a', 7, 0))).toBe(false);
    expect(ok({ type: 'erase', player: 'a', seq: 0, payload: { orientation: 0, index: 0 } } as never)).toBe(false);
    expect(ok({ type: 'draw', player: 'a', seq: 0, payload: null } as never)).toBe(false);

    // And on a finished board, nothing at all - refused for being over, which
    // is asserted by name because on a full board every line is ALSO already
    // drawn, so a check on `ok` alone would pass with the game-over branch
    // deleted.
    const finished = playOut(fresh);
    expect(finished.drawn).toBe(EDGE_COUNT);
    const refusal = dotsAndBoxes.validateAction(finished, draw('a', Orientation.HORIZONTAL, 0), context);
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toMatch(/already finished/);
  });

  it('passes the turn when a move closes nothing', () => {
    const { a, play } = table();
    play('a', ...h(0));
    expect(a.turn).toBe('b');
    play('b', ...h(5));
    expect(a.turn).toBe('a');
    expect(a.currentState.scores).toEqual([0, 0]);
  });

  it('keeps the turn and scores when a move closes a box', () => {
    // Box 0 is bounded by h0 (top), h5 (bottom), v0 (left) and v1 (right).
    const { a, b, play } = table();
    play('a', ...h(0));
    play('b', ...h(5));
    play('a', ...v(0));
    expect(a.turn).toBe('b');
    play('b', ...v(1));

    expect(a.currentState.boxes[0]).toBe(2);
    expect(a.currentState.scores).toEqual([0, 1]);
    expect(a.currentState.lastClaimed).toEqual([0]);
    // The whole game in one assertion: b closed a box, so b moves again.
    expect(a.turn).toBe('b');
    expect(b.turn).toBe('b');

    play('b', ...h(1));
    expect(a.turn).toBe('a');
  });

  it('scores two boxes and one extra move when a single line closes both', () => {
    // v1 is shared: it is box 0's right side and box 1's left side. Draw the
    // other six sides first, then close both with one line.
    const { a, play } = table();
    const opening = [h(0), h(5), v(0), h(1), h(6), v(2)];
    let mover: Who = 'a';
    for (const [orientation, index] of opening) {
      expect(play(mover, orientation, index).accepted).toBe(true);
      mover = mover === 'a' ? 'b' : 'a';
    }
    expect(a.currentState.scores).toEqual([0, 0]);
    expect(a.turn).toBe('a');

    expect(play('a', ...v(1)).accepted).toBe(true);
    expect(a.currentState.scores).toEqual([2, 0]);
    expect(a.currentState.boxes[0]).toBe(1);
    expect(a.currentState.boxes[1]).toBe(1);
    expect(a.currentState.lastClaimed).toEqual([0, 1]);
    expect(a.turn).toBe('a');
  });

  it('gives one player the whole chain, five boxes and five consecutive moves', () => {
    // The strategic heart of the game, and the thing a scoring race gets wrong:
    // opening a corridor hands the whole of it to the opponent in one visit.
    // Build the top row as a corridor - every top, every bottom, and the far
    // left wall - so that v1..v5 close boxes 0..4 one at a time.
    const { a, b, play } = table();
    let mover: Who = 'a';
    const step = (orientation: number, index: number) => {
      expect(play(mover, orientation, index).accepted).toBe(true);
      mover = mover === 'a' ? 'b' : 'a';
    };
    for (let i = 0; i < 5; i++) step(...h(i)); // the five tops
    for (let i = 5; i < 10; i++) step(...h(i)); // the five bottoms
    step(...v(0)); // the left wall
    expect(a.currentState.drawn).toBe(11);
    expect(a.currentState.scores).toEqual([0, 0]);

    // Eleven plies, so it is b's move - and b takes all five without stopping.
    const runner: Who = 'b';
    expect(a.turn).toBe(runner);
    for (let i = 1; i <= 5; i++) {
      expect(a.turn).toBe(runner);
      expect(play(runner, ...v(i)).accepted).toBe(true);
      expect(a.currentState.lastClaimed).toEqual([i - 1]);
      expect(a.currentState.scores).toEqual([0, i]);
    }
    // Still b's move after the fifth box: the run only ends on a move that
    // closes nothing.
    expect(a.turn).toBe(runner);
    expect(b.turn).toBe(runner);
    expect(play(runner, ...h(10)).accepted).toBe(true);
    expect(a.currentState.lastClaimed).toEqual([]);
    expect(a.turn).toBe('a');
  });

  it('leaves a box unclaimed until its fourth side goes down', () => {
    const { a, play } = table();
    play('a', ...h(0));
    play('b', ...h(5));
    play('a', ...v(0));
    expect(a.currentState.boxes[0]).toBe(0);
    expect(a.currentState.drawn).toBe(3);
  });

  it('ends when every line is drawn, with the boxes fully shared out', () => {
    const { a, b } = table();
    playToTheEnd(a, b);

    expect(a.currentState.drawn).toBe(EDGE_COUNT);
    expect(a.isOver).toBe(true);
    expect(a.turn).toBeNull();
    expect(a.currentState.boxes.some((o) => o === 0)).toBe(false);
    const [first, second] = a.currentState.scores;
    expect(first + second).toBe(25);
    // Twenty-five is odd, so somebody always wins on this board.
    expect(a.status.kind).toBe(GameStatusKind.WON);
    expect(b.status.kind).toBe(GameStatusKind.WON);
    expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(
      first > second ? ['a'] : ['b'],
    );
  });

  it('rejects a move once the game is over', () => {
    const { a, b } = table();
    playToTheEnd(a, b);
    const r = a.submitLocal('draw', { orientation: Orientation.HORIZONTAL, index: 0 });
    expect(r.accepted).toBe(false);
    expect(b.submitLocal('draw', { orientation: Orientation.VERTICAL, index: 0 }).accepted).toBe(false);
  });

  it('rejects a replayed action rather than drawing the line twice', () => {
    const { a, b } = table();
    const r = a.submitLocal('draw', { orientation: Orientation.HORIZONTAL, index: 3 });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = dotsAndBoxes.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });

  it('will not let one player move as another', () => {
    const b = session('b', false);
    const forged = dotsAndBoxes.encodeAction({
      type: 'draw',
      player: 'a',
      seq: 0,
      payload: { orientation: Orientation.HORIZONTAL, index: 0 },
    });
    // The session authenticated us as 'b', so the action is attributed to b -
    // and b is not to move, so it is refused.
    expect(b.applyRemote(forged, 'b').accepted).toBe(false);
  });
});

describe('dots and boxes codecs', () => {
  it('round-trips a played-out state exactly', () => {
    const { a, b, play } = table();
    play('a', ...h(0));
    play('b', ...h(5));
    play('a', ...v(0));
    play('b', ...v(1));
    play('b', ...h(2));
    const encoded = dotsAndBoxes.encodeState(a.currentState);
    const restored = dotsAndBoxes.decodeState(encoded);
    expect(restored).toEqual(a.currentState);
    expect(dotsAndBoxes.encodeState(restored)).toEqual(encoded);
    expect(b.currentState).toEqual(a.currentState);
  });

  it('round-trips the claim itself, not just the board under it', () => {
    // The state above ends on a move that claimed nothing, so its lastClaimed
    // is empty and an encoder that dropped the field would round-trip through
    // it unnoticed. This one stops on the claim.
    const { a, play } = table();
    play('a', ...h(0));
    play('b', ...h(5));
    play('a', ...v(0));
    play('b', ...v(1));
    expect(a.currentState.lastClaimed).toEqual([0]);
    const restored = dotsAndBoxes.decodeState(dotsAndBoxes.encodeState(a.currentState));
    expect(restored).toEqual(a.currentState);
    expect(restored.lastClaimed).toEqual([0]);
    expect(restored.scores).toEqual([0, 1]);
    expect(restored.turnIndex).toBe(1);
  });

  it('throws on a malformed action rather than returning a half-decoded one', () => {
    expect(() => dotsAndBoxes.decodeAction(null, 'a')).toThrow();
    expect(() => dotsAndBoxes.decodeAction({ t: 'draw', s: 0 }, 'a')).toThrow();
    expect(() => dotsAndBoxes.decodeAction({ t: 'erase', s: 0, p: { o: 0, i: 0 } }, 'a')).toThrow();
    expect(() => dotsAndBoxes.decodeAction({ t: 'draw', s: 0, p: { o: 2, i: 0 } }, 'a')).toThrow();
    expect(() => dotsAndBoxes.decodeAction({ t: 'draw', s: 0, p: { o: true, i: 0 } }, 'a')).toThrow();
    expect(() => dotsAndBoxes.decodeAction({ t: 'draw', s: 0, p: { o: 0, i: H_COUNT } }, 'a')).toThrow();
    expect(() => dotsAndBoxes.decodeAction({ t: 'draw', s: 0, p: { o: 1, i: V_COUNT } }, 'a')).toThrow();
    expect(() => dotsAndBoxes.decodeAction({ t: 'draw', s: 0, p: { o: 1, i: 1.5 } }, 'a')).toThrow();
    expect(() => dotsAndBoxes.decodeAction({ t: 'draw', s: -1, p: { o: 1, i: 0 } }, 'a')).toThrow();
    // ...and a well-formed one still decodes to exactly what was sent.
    const good = dotsAndBoxes.decodeAction({ t: 'draw', s: 4, p: { o: 1, i: 29 } }, 'a');
    expect(good).toEqual({
      type: 'draw',
      player: 'a',
      seq: 4,
      payload: { orientation: Orientation.VERTICAL, index: 29 },
    });
  });

  it('throws on a state whose scoreboard contradicts its grid', () => {
    const honest = dotsAndBoxes.encodeState(dotsAndBoxes.createInitialState(setup)) as unknown as Record<
      string,
      unknown
    >;
    expect(() => dotsAndBoxes.decodeState({ ...honest, s: [9, 0] } as never)).toThrow(/scores/);
    expect(() => dotsAndBoxes.decodeState({ ...honest, d: 7 } as never)).toThrow(/drawn/);
    expect(() => dotsAndBoxes.decodeState({ ...honest, b: [0, 0] } as never)).toThrow(/25/);
    expect(() => dotsAndBoxes.decodeState({ ...honest, p: ['only-me'] } as never)).toThrow(/2 players/);
    expect(() => dotsAndBoxes.decodeState('not a state' as never)).toThrow();
  });

  it('throws on a state whose boxes contradict the lines around them', () => {
    const empty = dotsAndBoxes.encodeState(dotsAndBoxes.createInitialState(setup)) as unknown as Record<
      string,
      unknown
    >;
    // A box claimed on a board with no lines on it. The scoreboard agrees with
    // the grid, so the score cross-check waves it through; only the grid itself
    // gives it away.
    const owned = new Array(25).fill(0);
    owned[7] = 1;
    expect(() => dotsAndBoxes.decodeState({ ...empty, b: owned, s: [1, 0] } as never)).toThrow(/box 7/);

    // And the mirror image: a box with all four sides down that nobody owns.
    const { a, play } = table();
    play('a', ...h(0));
    play('b', ...h(5));
    play('a', ...v(0));
    play('b', ...v(1));
    const closed = dotsAndBoxes.encodeState(a.currentState) as unknown as Record<string, unknown>;
    expect(() => dotsAndBoxes.decodeState({ ...closed, b: new Array(25).fill(0), s: [0, 0] } as never)).toThrow(
      /box 0/,
    );
    // The honest version of that same board still decodes.
    expect(dotsAndBoxes.decodeState(closed as never)).toEqual(a.currentState);
  });
});

describe('dots and boxes conformance', () => {
  const hooks = {
    legalAction: (state: DotsAndBoxesState, player: string, random: { nextInt(n: number): number }) => {
      if (dotsAndBoxes.currentTurn?.(state) !== player) return null;
      const free: { orientation: number; index: number }[] = [];
      state.h.forEach((drawn, i) => {
        if (!drawn) free.push({ orientation: Orientation.HORIZONTAL, index: i });
      });
      state.v.forEach((drawn, i) => {
        if (!drawn) free.push({ orientation: Orientation.VERTICAL, index: i });
      });
      const pick = free[random.nextInt(free.length)];
      if (!pick) return null;
      return { type: 'draw', payload: { orientation: pick.orientation, index: pick.index } };
    },
    maxPlies: 80,
  };

  it('passes the shared game conformance suite', () => {
    const report = runConformance(dotsAndBoxes, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.playedPlies).toBe(EDGE_COUNT);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(dotsAndBoxes, hooks, seed);
      expect(report.failures).toEqual([]);
    }
  });
});

/**
 * Drive the reducer alone to a full board, with no session around it, for the
 * tests that want a finished state to hand straight to validateAction.
 */
function playOut(from: DotsAndBoxesState): DotsAndBoxesState {
  let state = from;
  const every: (readonly [number, number])[] = [];
  for (let i = 0; i < H_COUNT; i++) every.push(h(i));
  for (let i = 0; i < V_COUNT; i++) every.push(v(i));
  for (const [orientation, index] of every) {
    const action = {
      type: 'draw',
      player: state.players[state.turnIndex] as string,
      seq: state.drawn,
      payload: { orientation, index },
    } as DotsAndBoxesAction;
    expect(dotsAndBoxes.validateAction(state, action, context).ok).toBe(true);
    state = dotsAndBoxes.applyAction(state, action, context);
  }
  return state;
}

/**
 * Drive both sessions to the end by always drawing the lowest-numbered line
 * still free. Deliberately not random: the tests that use it assert on the
 * final position, and a fixed order makes a failure reproducible.
 */
function playToTheEnd(
  a: GameSession<DotsAndBoxesState, DotsAndBoxesAction>,
  b: GameSession<DotsAndBoxesState, DotsAndBoxesAction>,
): void {
  for (let guard = 0; guard <= EDGE_COUNT && !a.isOver; guard++) {
    const turn = a.turn;
    if (turn === null) break;
    const from = turn === 'a' ? a : b;
    const to = turn === 'a' ? b : a;
    const s = from.currentState;
    let choice: { orientation: number; index: number } | null = null;
    for (let i = 0; i < H_COUNT && !choice; i++) {
      if (!s.h[i]) choice = { orientation: Orientation.HORIZONTAL, index: i };
    }
    for (let i = 0; i < V_COUNT && !choice; i++) {
      if (!s.v[i]) choice = { orientation: Orientation.VERTICAL, index: i };
    }
    if (!choice) break;
    const r = from.submitLocal('draw', choice);
    expect(r.accepted).toBe(true);
    if (r.accepted) to.applyRemote(dotsAndBoxes.encodeAction(r.applied.action), turn);
  }
}
