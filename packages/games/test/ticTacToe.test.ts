import { describe, expect, it } from 'vitest';
import { ticTacToe } from '../src/games/ticTacToe.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext } from '../src/engine.js';

const setup = { players: ['a', 'b'], seed: 42, options: {} };

function session(local: 'a' | 'b', isHost: boolean) {
  return new GameSession({ definition: ticTacToe, setup, localPlayer: local, isHost });
}

describe('tic-tac-toe rules', () => {
  it('starts empty with the first player to move', () => {
    const s = session('a', true);
    expect(s.currentState.board).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(s.turn).toBe('a');
    expect(s.isLocalTurn).toBe(true);
  });

  it('refuses a move out of turn', () => {
    const s = session('b', false);
    const r = s.submitLocal('place', { cell: 0 });
    expect(r.accepted).toBe(false);
  });

  it('refuses an occupied square', () => {
    const a = session('a', true);
    a.submitLocal('place', { cell: 4 });
    const b = session('b', false);
    b.applyRemote(ticTacToe.encodeAction({ type: 'place', player: 'a', seq: 0, payload: { cell: 4 } }), 'a');
    const r = b.submitLocal('place', { cell: 4 });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/taken/);
  });

  it('detects a win on every line', () => {
    for (const line of [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ]) {
      const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((c) => !line.includes(c));
      const a = session('a', true);
      const b = session('b', false);
      const play = (player: 'a' | 'b', cell: number) => {
        const from = player === 'a' ? a : b;
        const to = player === 'a' ? b : a;
        const r = from.submitLocal('place', { cell });
        expect(r.accepted).toBe(true);
        if (r.accepted) to.applyRemote(ticTacToe.encodeAction(r.applied.action), player);
      };
      play('a', line[0] as number);
      play('b', free[0] as number);
      play('a', line[1] as number);
      play('b', free[1] as number);
      play('a', line[2] as number);
      expect(a.status.kind).toBe(GameStatusKind.WON);
      expect(a.status.kind === GameStatusKind.WON && a.status.winners).toEqual(['a']);
      expect(b.status.kind).toBe(GameStatusKind.WON);
    }
  });

  it('reaches a draw on a full board with no line', () => {
    // a: 0 1 5 6 7   b: 2 3 4 8
    const order: [('a' | 'b'), number][] = [
      ['a', 0], ['b', 2], ['a', 1], ['b', 4], ['a', 5], ['b', 3], ['a', 6], ['b', 8], ['a', 7],
    ];
    const a = session('a', true);
    const b = session('b', false);
    for (const [player, cell] of order) {
      const from = player === 'a' ? a : b;
      const to = player === 'a' ? b : a;
      const r = from.submitLocal('place', { cell });
      expect(r.accepted).toBe(true);
      if (r.accepted) to.applyRemote(ticTacToe.encodeAction(r.applied.action), player);
    }
    expect(a.status.kind).toBe(GameStatusKind.DRAW);
  });

  it('rejects a move once the game is over', () => {
    const a = session('a', true);
    const b = session('b', false);
    const play = (player: 'a' | 'b', cell: number) => {
      const from = player === 'a' ? a : b;
      const to = player === 'a' ? b : a;
      const r = from.submitLocal('place', { cell });
      if (r.accepted) to.applyRemote(ticTacToe.encodeAction(r.applied.action), player);
      return r;
    };
    play('a', 0); play('b', 3); play('a', 1); play('b', 4); play('a', 2);
    expect(a.isOver).toBe(true);
    expect(play('b', 5).accepted).toBe(false);
  });

  it('rejects a duplicate action rather than applying it twice', () => {
    const a = session('a', true);
    const b = session('b', false);
    const r = a.submitLocal('place', { cell: 0 });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    const wire = ticTacToe.encodeAction(r.applied.action);
    expect(b.applyRemote(wire, 'a').accepted).toBe(true);
    const again = b.applyRemote(wire, 'a');
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });

  it('will not let one player move as another', () => {
    const b = session('b', false);
    const forged = ticTacToe.encodeAction({ type: 'place', player: 'a', seq: 0, payload: { cell: 0 } });
    // Session authenticated us as 'b', so the action is attributed to b - and b
    // is not to move, so it is refused.
    const r = b.applyRemote(forged, 'b');
    expect(r.accepted).toBe(false);
  });
});

describe('tic-tac-toe conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(ticTacToe, {
      legalAction: (state, player, random) => {
        if (ticTacToe.currentTurn?.(state) !== player) return null;
        const free = state.board.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0);
        if (free.length === 0) return null;
        return { type: 'place', payload: { cell: free[random.nextInt(free.length)] as number } };
      },
      maxPlies: 20,
    });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(
        ticTacToe,
        {
          legalAction: (state, player, random) => {
            if (ticTacToe.currentTurn?.(state) !== player) return null;
            const free = state.board.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0);
            if (free.length === 0) return null;
            return { type: 'place', payload: { cell: free[random.nextInt(free.length)] as number } };
          },
          maxPlies: 20,
        },
        seed,
      );
      expect(report.failures).toEqual([]);
    }
  });
});

describe('a winner off the wire', () => {
  /**
   * A snapshot decides what every screen says about who won, so a name in it
   * that belongs to nobody at the table is not a missing winner - it is a peer
   * claiming a result that cannot have happened. Shared with Connect Four and
   * Gomoku, which have the same field and had the same gap.
   */
  it('is refused when it names somebody who is not playing', () => {
    const start = ticTacToe.createInitialState({ players: ['a', 'b'], seed: 1, options: {} });
    const encoded = ticTacToe.encodeState(start) as Record<string, unknown>;
    encoded.w = 'mallory';
    expect(() => ticTacToe.decodeState(encoded as never)).toThrow();
  });

  it('is refused when it is not a string at all', () => {
    const start = ticTacToe.createInitialState({ players: ['a', 'b'], seed: 1, options: {} });
    const encoded = ticTacToe.encodeState(start) as Record<string, unknown>;
    encoded.w = 7;
    expect(() => ticTacToe.decodeState(encoded as never)).toThrow();
  });

  it('is accepted when it names a real player, and round-trips', () => {
    const setup = { players: ['a', 'b'], seed: 1, options: {} };
    const context = createContext(setup.players, setup.seed);
    let state = ticTacToe.createInitialState(setup);
    for (const [player, cell] of [['a', 0], ['b', 3], ['a', 1], ['b', 4], ['a', 2]] as const) {
      state = ticTacToe.applyAction(state, { type: 'place', player, seq: 0, payload: { cell } }, context);
    }
    expect(state.winner).toBe('a');
    expect(ticTacToe.decodeState(ticTacToe.encodeState(state)).winner).toBe('a');
  });
});
