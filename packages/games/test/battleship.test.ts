import { describe, expect, it } from 'vitest';
import { decodeCbor, encodeCbor, toHex, type CborValue } from '@airlink/core';
import {
  BOARD_SIZE,
  BattleshipEnding,
  BattleshipPhase,
  CELL_COUNT,
  COMMITMENT_BYTES,
  FLEET,
  FLEET_CELLS,
  SALT_BYTES,
  battleship,
  fleetCommitment,
  fleetIsSunk,
  fleetLayout,
  isLegalLayout,
  resolveReport,
  shipCells,
  sunkCount,
  type BattleshipAction,
  type BattleshipState,
  type Ship,
  type Shot,
} from '../src/games/battleship.js';
import { GameSession } from '../src/runtime.js';
import { runConformance, type ConformanceHooks } from '../src/conformance.js';
import { GameStatusKind, SeededGameRandom, createContext } from '../src/engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Side = 'a' | 'b';

/** a: five horizontal ships down the left edge. */
const FLEET_A: Ship[] = [
  { row: 0, col: 0, vertical: false, length: 5 }, // 0-4
  { row: 2, col: 0, vertical: false, length: 4 }, // 20-23
  { row: 4, col: 0, vertical: false, length: 3 }, // 40-42
  { row: 6, col: 0, vertical: false, length: 3 }, // 60-62
  { row: 8, col: 0, vertical: false, length: 2 }, // 80-81
];
const SALT_A = [1, 2, 3, 4, 5, 6, 7, 8];

/** b: five vertical ships, scattered. */
const FLEET_B: Ship[] = [
  { row: 0, col: 9, vertical: true, length: 5 }, // 9,19,29,39,49
  { row: 0, col: 7, vertical: true, length: 4 }, // 7,17,27,37
  { row: 5, col: 5, vertical: true, length: 3 }, // 55,65,75
  { row: 6, col: 2, vertical: true, length: 3 }, // 62,72,82
  { row: 8, col: 8, vertical: true, length: 2 }, // 88,98
];
const SALT_B = [9, 10, 11, 12, 13, 14, 15, 16];

function fleetCells(ships: readonly Ship[]): number[] {
  const out: number[] = [];
  for (const ship of ships) out.push(...(shipCells(ship) as number[]));
  return out;
}

const A_CELLS = fleetCells(FLEET_A);
const B_CELLS = fleetCells(FLEET_B);
/** Every square of a's grid that holds no ship, in order. */
const A_OPEN = Array.from({ length: CELL_COUNT }, (_, i) => i).filter((c) => !A_CELLS.includes(c));

type Report = { cell: number; hit: boolean; sunk: number | null };

// ---------------------------------------------------------------------------
// A two-device table. Every accepted move is mirrored to the peer through CBOR
// and the FULL encoded state of both devices is compared - not a prefix hash.
// ---------------------------------------------------------------------------

function table(seed = 42) {
  const setup = { players: ['a', 'b'], seed, options: {} };
  const A = new GameSession({ definition: battleship, setup, localPlayer: 'a', isHost: true });
  const B = new GameSession({ definition: battleship, setup, localPlayer: 'b', isHost: false });

  const wireState = (session: GameSession<BattleshipState, BattleshipAction>): string =>
    toHex(encodeCbor(battleship.encodeState(session.currentState)));

  const submit = (side: Side, type: string, payload: CborValue) => {
    const from = side === 'a' ? A : B;
    const to = side === 'a' ? B : A;
    const outcome = from.submitLocal(type, payload);
    if (outcome.accepted) {
      const wire = decodeCbor(encodeCbor(battleship.encodeAction(outcome.applied.action)));
      const mirrored = to.applyRemote(wire, side);
      expect(mirrored.accepted).toBe(true);
      expect(wireState(A)).toBe(wireState(B));
    }
    return outcome;
  };

  const state = (): BattleshipState => A.currentState;
  const shotsAt = (index: number): readonly Shot[] => state().shots[index] ?? [];
  const shipsOf = (side: Side): Ship[] => (side === 'a' ? FLEET_A : FLEET_B);
  const indexOf = (side: Side): number => (side === 'a' ? 0 : 1);

  let openCursor = 0;

  const t = {
    A,
    B,
    submit,
    state,
    shotsAt,
    wireState,

    commit(which: Side, ships: Ship[] = shipsOf(which), salt: number[] = which === 'a' ? SALT_A : SALT_B) {
      return submit(which, 'place', { commitment: fleetCommitment(ships, salt) });
    },

    openFire() {
      expect(t.commit('a').accepted).toBe(true);
      expect(t.commit('b').accepted).toBe(true);
      expect(state().phase).toBe(BattleshipPhase.FIRING);
    },

    fire(which: Side, cell: number) {
      return submit(which, 'fire', { cell });
    },

    /** The truthful answer to the pending shot, from the grid's owner. */
    honestAnswer(owner: Side): Report {
      const pending = state().pending;
      if (!pending) throw new Error('no pending shot');
      return resolveReport(shipsOf(owner), shotsAt(indexOf(owner)), pending.cell);
    },

    report(owner: Side, answer: Report = t.honestAnswer(owner)) {
      return submit(owner, 'report', { cell: answer.cell, hit: answer.hit, sunk: answer.sunk });
    },

    /** b fires back at a square of a's grid known to be empty, and a answers. */
    returnFire() {
      const cell = A_OPEN[openCursor++] as number;
      expect(t.fire('b', cell).accepted).toBe(true);
      expect(t.report('a').accepted).toBe(true);
    },

    /**
     * a works through b's fleet; `tamper` lets b lie about a given answer.
     *
     * Squares a has already fired at are skipped: firing twice at the same cell
     * is correctly refused by the rules, so a caller that opened with its own
     * shot must not be punished for it.
     */
    sinkFleetB(tamper?: (shotIndex: number, honest: Report) => Report) {
      for (let i = 0; i < B_CELLS.length; i++) {
        const cell = B_CELLS[i] as number;
        if (shotsAt(indexOf('b')).some((shot) => shot.cell === cell)) continue;
        // A miss hands the turn over, so if a caller's own opening shot left b
        // to play, let b take it before carrying on.
        if (state().phase === BattleshipPhase.FIRING && state().turnIndex !== indexOf('a')) t.returnFire();
        if (state().phase !== BattleshipPhase.FIRING) break;
        expect(t.fire('a', cell).accepted).toBe(true);
        const honest = t.honestAnswer('b');
        expect(t.report('b', tamper ? tamper(i, honest) : honest).accepted).toBe(true);
        if (state().phase === BattleshipPhase.FIRING) t.returnFire();
      }
    },

    reveal(which: Side, ships: Ship[] = shipsOf(which), salt: number[] = which === 'a' ? SALT_A : SALT_B) {
      return submit(which, 'reveal', { ships, salt });
    },
  };

  return t;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe('battleship setup and placement', () => {
  it('starts in placement with two empty grids and the first player to commit', () => {
    const t = table();
    const s = t.state();
    expect(s.phase).toBe(BattleshipPhase.PLACEMENT);
    expect(s.commitments).toEqual([null, null]);
    expect(s.shots).toEqual([[], []]);
    expect(s.pending).toBeNull();
    expect(t.A.turn).toBe('a');
    expect(t.A.isOver).toBe(false);
    expect(t.A.status.kind).toBe(GameStatusKind.IN_PROGRESS);
  });

  it('has a 17-cell fleet of 5/4/3/3/2', () => {
    expect(FLEET.map((f) => f.length)).toEqual([5, 4, 3, 3, 2]);
    expect(FLEET.reduce((n, f) => n + f.length, 0)).toBe(FLEET_CELLS);
    expect(A_CELLS).toHaveLength(FLEET_CELLS);
    expect(new Set(B_CELLS).size).toBe(FLEET_CELLS);
  });

  it('opens the firing phase once both fleets are committed, host first', () => {
    const t = table();
    expect(t.commit('a').accepted).toBe(true);
    expect(t.state().phase).toBe(BattleshipPhase.PLACEMENT);
    expect(t.A.turn).toBe('b');
    expect(t.commit('b').accepted).toBe(true);
    expect(t.state().phase).toBe(BattleshipPhase.FIRING);
    expect(t.A.turn).toBe('a');
    expect(t.state().commitments[0]).toHaveLength(COMMITMENT_BYTES);
  });

  it('reaches the same state whichever order the two commitments arrive in', () => {
    const forwards = table();
    expect(forwards.commit('a').accepted).toBe(true);
    expect(forwards.commit('b').accepted).toBe(true);
    const backwards = table();
    expect(backwards.commit('b').accepted).toBe(true);
    expect(backwards.commit('a').accepted).toBe(true);
    expect(forwards.wireState(forwards.A)).toBe(backwards.wireState(backwards.A));
  });

  it('refuses a second commitment from the same player', () => {
    const t = table();
    expect(t.commit('a').accepted).toBe(true);
    const again = t.commit('a');
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already committed/);
  });

  it('refuses a shot before both fleets are committed', () => {
    const t = table();
    expect(t.commit('a').accepted).toBe(true);
    const r = t.fire('a', 0);
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/committed first/);
  });
});

describe('battleship firing and reporting', () => {
  it('hands the turn to the grid owner while a shot is unanswered', () => {
    const t = table();
    t.openFire();
    expect(t.fire('a', 55).accepted).toBe(true);
    expect(t.state().pending).toEqual({ shooter: 0, cell: 55 });
    expect(t.A.turn).toBe('b'); // b must answer before anyone fires again
    expect(t.fire('a', 56).accepted).toBe(false);
  });

  it('records a miss and passes the turn to the other player', () => {
    const t = table();
    t.openFire();
    expect(t.fire('a', 0).accepted).toBe(true); // open water on b's grid
    const answer = t.honestAnswer('b');
    expect(answer).toEqual({ cell: 0, hit: false, sunk: null });
    expect(t.report('b', answer).accepted).toBe(true);
    expect(t.state().shots[1]).toEqual([{ cell: 0, hit: false, sunk: null }]);
    expect(t.state().pending).toBeNull();
    expect(t.A.turn).toBe('b');
  });

  it('reports a hit, and a sink only on the ship’s last cell', () => {
    const t = table();
    t.openFire();
    // b's destroyer sits on 88 and 98.
    expect(t.fire('a', 88).accepted).toBe(true);
    expect(t.honestAnswer('b')).toEqual({ cell: 88, hit: true, sunk: null });
    expect(t.report('b').accepted).toBe(true);
    t.returnFire();
    expect(t.fire('a', 98).accepted).toBe(true);
    expect(t.honestAnswer('b')).toEqual({ cell: 98, hit: true, sunk: 4 });
    expect(t.report('b').accepted).toBe(true);
    expect(sunkCount(t.state().shots[1] ?? [])).toBe(1);
    expect(fleetIsSunk(t.state().shots[1] ?? [])).toBe(false);
  });

  it('refuses a shot fired out of turn', () => {
    const t = table();
    t.openFire();
    const r = t.fire('b', 0);
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/turn to fire/);
  });

  it('refuses a shot at a square already fired at', () => {
    const t = table();
    t.openFire();
    expect(t.fire('a', 33).accepted).toBe(true);
    expect(t.report('b').accepted).toBe(true);
    t.returnFire();
    const again = t.fire('a', 33);
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already been fired at/);
  });

  it('refuses to let the shooter answer their own shot', () => {
    const t = table();
    t.openFire();
    expect(t.fire('a', 12).accepted).toBe(true);
    const r = t.submit('a', 'report', { cell: 12, hit: false, sunk: null });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/owner of the targeted grid/);
  });

  it('refuses a report that answers a different square', () => {
    const t = table();
    t.openFire();
    expect(t.fire('a', 12).accepted).toBe(true);
    const r = t.submit('b', 'report', { cell: 13, hit: false, sunk: null });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/answer the pending shot/);
  });

  it('refuses a report when no shot is pending', () => {
    const t = table();
    t.openFire();
    const r = t.submit('b', 'report', { cell: 0, hit: false, sunk: null });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/no shot to answer/);
  });

  it('refuses to sink the same ship twice', () => {
    const t = table();
    t.openFire();
    expect(t.fire('a', 88).accepted).toBe(true);
    expect(t.report('b').accepted).toBe(true);
    t.returnFire();
    expect(t.fire('a', 98).accepted).toBe(true);
    expect(t.report('b').accepted).toBe(true); // destroyer (index 4) down
    t.returnFire();
    expect(t.fire('a', 9).accepted).toBe(true);
    const r = t.submit('b', 'report', { cell: 9, hit: true, sunk: 4 });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/already reported sunk/);
  });

  it('cannot even express a sink on a miss', () => {
    const t = table();
    t.openFire();
    expect(t.fire('a', 0).accepted).toBe(true);
    const r = t.submit('b', 'report', { cell: 0, hit: false, sunk: 2 });
    expect(r.accepted).toBe(false);
    expect(() =>
      battleship.decodeAction({ t: 'report', s: 0, p: { c: 0, h: false, k: 3 } }, 'b'),
    ).toThrow(/miss cannot sink/);
  });
});

describe('battleship honest endgame', () => {
  it('plays a whole game out and awards the win once both reveals check out', () => {
    const t = table();
    t.openFire();
    t.sinkFleetB();

    expect(t.state().phase).toBe(BattleshipPhase.REVEAL);
    expect(fleetIsSunk(t.state().shots[1] ?? [])).toBe(true);
    expect(fleetIsSunk(t.state().shots[0] ?? [])).toBe(false);
    expect(t.A.isOver).toBe(false); // the audit still has to happen
    expect(t.A.turn).toBe('a');

    expect(t.reveal('a').accepted).toBe(true);
    expect(t.state().phase).toBe(BattleshipPhase.REVEAL);
    expect(t.reveal('b').accepted).toBe(true);

    const s = t.state();
    expect(s.phase).toBe(BattleshipPhase.FINISHED);
    expect(s.cheated).toEqual([false, false]);
    expect(s.ending).toBe(BattleshipEnding.FLEET_SUNK);
    expect(t.A.status).toEqual({ kind: GameStatusKind.WON, winners: ['a'], reason: 'fleet sunk' });
    expect(t.B.status).toEqual({ kind: GameStatusKind.WON, winners: ['a'], reason: 'fleet sunk' });
    expect(t.A.turn).toBeNull();
  });

  it('refuses a reveal before the fleet is down, and a second reveal after', () => {
    const t = table();
    t.openFire();
    const early = t.reveal('a');
    expect(early.accepted).toBe(false);
    expect(early.accepted === false && early.detail).toMatch(/nothing to reveal/);
    t.sinkFleetB();
    expect(t.reveal('a').accepted).toBe(true);
    const twice = t.reveal('a');
    expect(twice.accepted).toBe(false);
    expect(twice.accepted === false && twice.detail).toMatch(/already revealed/);
  });

  it('refuses every action once the game is over', () => {
    const t = table();
    t.openFire();
    t.sinkFleetB();
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b').accepted).toBe(true);
    expect(t.A.isOver).toBe(true);
    for (const attempt of [
      t.fire('a', 99),
      t.submit('b', 'report', { cell: 99, hit: false, sunk: null }),
      t.reveal('a'),
      t.commit('a'),
    ]) {
      expect(attempt.accepted).toBe(false);
      expect(attempt.accepted === false && attempt.reason).toBe('gameOver');
    }
  });
});

// ---------------------------------------------------------------------------
// Cheating - the whole point of the commit/reveal design
// ---------------------------------------------------------------------------

describe('battleship catches a cheat at the reveal', () => {
  const expectCaught = (t: ReturnType<typeof table>, cheat: Side) => {
    const winner = cheat === 'b' ? 'a' : 'b';
    const s = t.state();
    expect(s.phase).toBe(BattleshipPhase.FINISHED);
    expect(s.cheated[cheat === 'a' ? 0 : 1]).toBe(true);
    expect(s.cheated[cheat === 'a' ? 1 : 0]).toBe(false);
    expect(s.ending).toBe(BattleshipEnding.CHEAT);
    expect(t.A.status).toEqual({ kind: GameStatusKind.WON, winners: [winner], reason: 'opponent cheated' });
    expect(t.B.status).toEqual({ kind: GameStatusKind.WON, winners: [winner], reason: 'opponent cheated' });
  };

  it('catches a reveal that does not match the commitment', () => {
    const t = table();
    t.openFire();
    t.sinkFleetB();
    expect(t.reveal('a').accepted).toBe(true);
    // b reveals the fleet it actually played, but with a different salt: the
    // hash no longer matches what it published in phase 1.
    expect(t.reveal('b', FLEET_B, [0, 0, 0, 0, 0, 0, 0, 1]).accepted).toBe(true);
    expectCaught(t, 'b');
  });

  it('catches a defender who hides a hit', () => {
    const t = table();
    t.openFire();
    // b answers "miss" on the very first cell of its own carrier.
    t.sinkFleetB((i, honest) => (i === 0 ? { ...honest, hit: false, sunk: null } : honest));
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b').accepted).toBe(true);
    expectCaught(t, 'b');
  });

  it('catches a defender who claims a hit on open water', () => {
    const t = table();
    t.openFire();
    expect(t.fire('a', 0).accepted).toBe(true); // 0 is empty on b's grid
    expect(t.submit('b', 'report', { cell: 0, hit: true, sunk: null }).accepted).toBe(true);
    t.returnFire();
    t.sinkFleetB();
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b').accepted).toBe(true);
    expectCaught(t, 'b');
  });

  it('catches a sink announced one shot too early', () => {
    const t = table();
    t.openFire();
    t.sinkFleetB((i, honest) => {
      if (i === 3) return { ...honest, sunk: 0 }; // carrier "sunk" on its 4th cell
      if (i === 4) return { ...honest, sunk: null };
      return honest;
    });
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b').accepted).toBe(true);
    expectCaught(t, 'b');
  });

  it('catches a revealed ship that runs off the board', () => {
    const offBoard: Ship[] = [
      { row: 7, col: 0, vertical: true, length: 5 }, // rows 7-11: impossible
      ...FLEET_B.slice(1),
    ];
    const t = table();
    expect(t.commit('a').accepted).toBe(true);
    expect(t.commit('b', offBoard).accepted).toBe(true); // b commits to the bad layout
    t.sinkFleetB();
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b', offBoard).accepted).toBe(true);
    expectCaught(t, 'b');
  });

  it('catches revealed ships that overlap', () => {
    const overlapping: Ship[] = [
      { row: 0, col: 0, vertical: false, length: 5 },
      { row: 0, col: 0, vertical: true, length: 4 }, // shares cell 0
      { row: 5, col: 5, vertical: true, length: 3 },
      { row: 6, col: 2, vertical: true, length: 3 },
      { row: 8, col: 8, vertical: true, length: 2 },
    ];
    const t = table();
    expect(t.commit('a').accepted).toBe(true);
    expect(t.commit('b', overlapping).accepted).toBe(true);
    t.sinkFleetB();
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b', overlapping).accepted).toBe(true);
    expectCaught(t, 'b');
  });

  it('catches a shrunken carrier', () => {
    const shrunk: Ship[] = [{ row: 0, col: 9, vertical: true, length: 2 }, ...FLEET_B.slice(1)];
    const t = table();
    expect(t.commit('a').accepted).toBe(true);
    expect(t.commit('b', shrunk).accepted).toBe(true);
    t.sinkFleetB();
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b', shrunk).accepted).toBe(true);
    expectCaught(t, 'b');
  });

  it('gives nobody the win when both players cheated', () => {
    const t = table();
    t.openFire();
    t.sinkFleetB((i, honest) => (i === 0 ? { ...honest, hit: false, sunk: null } : honest));
    expect(t.reveal('a', FLEET_A, [7, 7, 7, 7, 7, 7, 7, 7]).accepted).toBe(true);
    expect(t.reveal('b').accepted).toBe(true);
    const s = t.state();
    expect(s.cheated).toEqual([true, true]);
    expect(s.ending).toBe(BattleshipEnding.BOTH_CHEATED);
    expect(t.A.status).toEqual({ kind: GameStatusKind.DRAW, reason: 'both players cheated' });
  });

  it('leaves a stonewalling defender nowhere to hide: the grid runs out', () => {
    const t = table();
    t.openFire();
    // b answers "miss" to everything. a's honest fleet survives because b only
    // ever fires at open water and, at the end, leaves one carrier cell alone.
    const bShots = [...A_OPEN, ...A_CELLS.slice(1)];
    for (let i = 0; i < CELL_COUNT; i++) {
      expect(t.fire('a', i).accepted).toBe(true);
      expect(t.submit('b', 'report', { cell: i, hit: false, sunk: null }).accepted).toBe(true);
      if (t.state().phase !== BattleshipPhase.FIRING) break;
      expect(t.fire('b', bShots[i] as number).accepted).toBe(true);
      expect(t.report('a').accepted).toBe(true);
    }
    const s = t.state();
    expect(s.phase).toBe(BattleshipPhase.REVEAL);
    expect(s.shots[1]).toHaveLength(CELL_COUNT);
    expect(fleetIsSunk(s.shots[0] ?? [])).toBe(false);
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b').accepted).toBe(true);
    expect(t.state().cheated).toEqual([false, true]);
    expect(t.A.status).toEqual({ kind: GameStatusKind.WON, winners: ['a'], reason: 'opponent cheated' });
  });
});

// ---------------------------------------------------------------------------
// Hostile peers
// ---------------------------------------------------------------------------

describe('battleship rejects hostile input', () => {
  it('refuses an action from someone who is not in the game', () => {
    const t = table();
    const wire = battleship.encodeAction({
      type: 'place',
      player: 'a',
      seq: 0,
      payload: { commitment: fleetCommitment(FLEET_A, SALT_A) },
    });
    const r = t.A.applyRemote(wire, 'mallory');
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.reason).toBe('notAPlayer');
  });

  it('attributes an action to the authenticated peer, not to the packet', () => {
    const t = table();
    t.openFire();
    // b replays a's shot claiming to be a; the session knows the peer is b, so
    // the action is attributed to b - who is not to fire.
    const forged = battleship.encodeAction({ type: 'fire', player: 'a', seq: 0, payload: { cell: 5 } });
    const r = t.A.applyRemote(forged, 'b');
    expect(r.accepted).toBe(false);
  });

  it('refuses a reveal from a player who never committed', () => {
    const state = battleship.createInitialState({ players: ['a', 'b'], seed: 1, options: {} });
    const context = createContext(['a', 'b'], 1);
    const action: BattleshipAction = {
      type: 'reveal',
      player: 'zoe',
      seq: 0,
      payload: { ships: FLEET_A, salt: SALT_A },
    };
    const result = battleship.validateAction(state, action, context);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not in this game/);
  });

  it('throws a decode error on malformed packets instead of trusting them', () => {
    const bad: CborValue[] = [
      null,
      7,
      'nope',
      [],
      {},
      { t: 'fire' },
      { t: 'fire', s: 0, p: null },
      { t: 'fire', s: 0, p: { c: 100 } },
      { t: 'fire', s: 0, p: { c: -1 } },
      { t: 'fire', s: 0, p: { c: 1.5 } },
      { t: 'fire', s: 0, p: { c: 1e12 } },
      { t: 'fire', s: -1, p: { c: 0 } },
      { t: 'place', s: 0, p: { k: [1, 2, 3] } },
      { t: 'place', s: 0, p: { k: Array.from({ length: 64 }, () => 1) } },
      { t: 'place', s: 0, p: { k: [1, 2, 3, 4, 5, 6, 7, 300] } },
      { t: 'place', s: 0, p: { k: new Uint8Array(8) } },
      { t: 'report', s: 0, p: { c: 0, h: 1, k: 0 } },
      { t: 'report', s: 0, p: { c: 0, h: true, k: 9 } },
      { t: 'report', s: 0, p: { c: 0, h: false, k: 2 } },
      { t: 'reveal', s: 0, p: { f: [], z: SALT_A } },
      { t: 'reveal', s: 0, p: { f: Array.from({ length: 20 }, () => 0), z: [1] } },
      { t: 'reveal', s: 0, p: { f: Array.from({ length: 20 }, () => 99), z: SALT_A } },
      { t: 'reveal', s: 0, p: { f: Array.from({ length: 4096 }, () => 0), z: SALT_A } },
      { t: 'nonsense', s: 0, p: {} },
      { t: 'x'.repeat(500), s: 0, p: {} },
    ];
    for (const value of bad) {
      expect(() => battleship.decodeAction(value, 'a')).toThrow();
    }
  });

  it('never lets a malformed packet escape as an exception from the session', () => {
    const t = table();
    const junk: CborValue[] = [
      null,
      0,
      'garbage',
      [],
      {},
      { t: 'fire', s: 0, p: { c: 1e12 } },
      { t: 'report', s: 0, p: new Uint8Array(32) },
      { t: 'reveal', s: 0, p: { f: Array.from({ length: 200 }, () => 1), z: [] } },
    ];
    for (const value of junk) {
      expect(() => t.A.applyRemote(value, 'b')).not.toThrow();
      expect(t.A.applyRemote(value, 'b').accepted).toBe(false);
    }
  });

  it('rejects a state snapshot with an impossible field', () => {
    const t = table();
    t.openFire();
    const encoded = battleship.encodeState(t.state()) as Record<string, CborValue>;
    expect(() => battleship.decodeState({ ...encoded, f: 9 })).toThrow();
    expect(() => battleship.decodeState({ ...encoded, t: 5 })).toThrow();
    expect(() => battleship.decodeState({ ...encoded, n: 500 })).toThrow();
    expect(() => battleship.decodeState({ ...encoded, w: 7 })).toThrow();
    expect(() => battleship.decodeState({ ...encoded, p: ['only-one'] })).toThrow();
    expect(() => battleship.decodeState({ ...encoded, s: [[1, 2], [3], [4]] })).toThrow();
    expect(() => battleship.decodeState({ ...encoded, s: [[7], []] })).toThrow(); // outcome 7
    expect(() => battleship.decodeState({ ...encoded, c: [2, 0] })).toThrow();
    expect(() => battleship.decodeState('not a state')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe('battleship encoding', () => {
  it('round-trips every action type through CBOR unchanged', () => {
    const actions: BattleshipAction[] = [
      { type: 'place', player: 'a', seq: 0, payload: { commitment: fleetCommitment(FLEET_A, SALT_A) } },
      { type: 'fire', player: 'a', seq: 1, payload: { cell: 99 } },
      { type: 'report', player: 'b', seq: 2, payload: { cell: 0, hit: false, sunk: null } },
      { type: 'report', player: 'b', seq: 3, payload: { cell: 47, hit: true, sunk: null } },
      { type: 'report', player: 'b', seq: 4, payload: { cell: 47, hit: true, sunk: 4 } },
      { type: 'reveal', player: 'b', seq: 5, payload: { ships: FLEET_B, salt: SALT_B } },
    ];
    for (const action of actions) {
      const wire = decodeCbor(encodeCbor(battleship.encodeAction(action)));
      const restored = battleship.decodeAction(wire, action.player);
      expect(restored).toEqual(action);
      expect(toHex(encodeCbor(battleship.encodeAction(restored)))).toBe(
        toHex(encodeCbor(battleship.encodeAction(action))),
      );
    }
  });

  it('keeps every action inside a single Bluetooth packet', () => {
    const t = table();
    t.openFire();
    t.sinkFleetB();
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b').accepted).toBe(true);
    for (const action of t.A.history()) {
      expect(encodeCbor(battleship.encodeAction(action)).length).toBeLessThanOrEqual(180);
    }
  });

  it('round-trips the state at every phase of a game', () => {
    const t = table();
    const check = () => {
      const encoded = battleship.encodeState(t.state());
      const restored = battleship.decodeState(decodeCbor(encodeCbor(encoded)));
      expect(restored).toEqual(t.state());
      expect(toHex(encodeCbor(battleship.encodeState(restored)))).toBe(toHex(encodeCbor(encoded)));
    };
    check();
    expect(t.commit('a').accepted).toBe(true);
    check();
    expect(t.commit('b').accepted).toBe(true);
    expect(t.fire('a', 9).accepted).toBe(true);
    check(); // with a shot pending
    expect(t.report('b').accepted).toBe(true);
    check();
    t.sinkFleetB();
    check(); // reveal phase
    expect(t.reveal('a').accepted).toBe(true);
    expect(t.reveal('b').accepted).toBe(true);
    check(); // finished, with both layouts on the table
  });
});

// ---------------------------------------------------------------------------
// Purity and helpers
// ---------------------------------------------------------------------------

describe('battleship reducer purity and layout rules', () => {
  it('does not mutate the state it is given', () => {
    const setup = { players: ['a', 'b'], seed: 3, options: {} };
    const context = createContext(setup.players, setup.seed);
    const initial = battleship.createInitialState(setup);
    const before = toHex(encodeCbor(battleship.encodeState(initial)));
    const place: BattleshipAction = {
      type: 'place',
      player: 'a',
      seq: 0,
      payload: { commitment: fleetCommitment(FLEET_A, SALT_A) },
    };
    const next = battleship.applyAction(initial, place, context);
    expect(toHex(encodeCbor(battleship.encodeState(initial)))).toBe(before);
    expect(next).not.toBe(initial);
    // The encoded form of the ORIGINAL object is unchanged, which is the real
    // purity requirement. Reusing an untouched sub-object by reference is
    // correct structural sharing, not a mutation, so it is not asserted against.
    expect(initial.commitments).toEqual([null, null]);
  });

  it('accepts only legal layouts', () => {
    expect(isLegalLayout(FLEET_A)).toBe(true);
    expect(isLegalLayout(FLEET_B)).toBe(true);
    expect(isLegalLayout(FLEET_A.slice(1))).toBe(false); // too few ships
    expect(isLegalLayout([...FLEET_A, FLEET_A[0] as Ship])).toBe(false); // too many
    expect(isLegalLayout([{ row: 0, col: 0, vertical: false, length: 4 }, ...FLEET_A.slice(1)])).toBe(false);
    expect(isLegalLayout([{ row: 6, col: 6, vertical: false, length: 5 }, ...FLEET_A.slice(1)])).toBe(false);
    expect(isLegalLayout([{ row: 0, col: 0, vertical: true, length: 5 }, ...FLEET_A.slice(1)])).toBe(false); // overlap
    const layout = fleetLayout(FLEET_A) as number[];
    expect(layout).toHaveLength(CELL_COUNT);
    expect(layout.filter((v) => v >= 0)).toHaveLength(FLEET_CELLS);
    expect(layout[0]).toBe(0);
    expect(layout[81]).toBe(4);
    expect(layout[99]).toBe(-1);
  });

  it('places ships on the board along one axis only', () => {
    expect(shipCells({ row: 0, col: 0, vertical: false, length: 5 })).toEqual([0, 1, 2, 3, 4]);
    expect(shipCells({ row: 0, col: 0, vertical: true, length: 3 })).toEqual([0, 10, 20]);
    expect(shipCells({ row: 9, col: 9, vertical: false, length: 2 })).toBeNull();
    expect(shipCells({ row: 9, col: 0, vertical: true, length: 2 })).toBeNull();
    expect(shipCells({ row: -1, col: 0, vertical: false, length: 2 })).toBeNull();
    expect(shipCells({ row: 0, col: 0, vertical: false, length: BOARD_SIZE + 1 })).toBeNull();
  });

  it('binds a commitment to both the layout and the salt', () => {
    const base = fleetCommitment(FLEET_A, SALT_A);
    expect(base).toHaveLength(COMMITMENT_BYTES);
    expect(base.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true);
    expect(fleetCommitment(FLEET_A, SALT_A)).toEqual(base); // deterministic
    expect(fleetCommitment(FLEET_B, SALT_A)).not.toEqual(base);
    expect(fleetCommitment(FLEET_A, [...SALT_A.slice(0, SALT_BYTES - 1), 99])).not.toEqual(base);
    const nudged: Ship[] = [{ ...(FLEET_A[0] as Ship), col: 1 }, ...FLEET_A.slice(1)];
    expect(fleetCommitment(nudged, SALT_A)).not.toEqual(base);
  });

  it('answers a shot the same way however many times it is asked', () => {
    const shots: Shot[] = [{ cell: 9, hit: true, sunk: null }];
    expect(resolveReport(FLEET_B, shots, 19)).toEqual({ cell: 19, hit: true, sunk: null });
    expect(resolveReport(FLEET_B, shots, 19)).toEqual({ cell: 19, hit: true, sunk: null });
    expect(resolveReport(FLEET_B, shots, 0)).toEqual({ cell: 0, hit: false, sunk: null });
    const almost: Shot[] = [{ cell: 88, hit: true, sunk: null }];
    expect(resolveReport(FLEET_B, almost, 98)).toEqual({ cell: 98, hit: true, sunk: 4 });
  });
});

// ---------------------------------------------------------------------------
// Conformance
// ---------------------------------------------------------------------------

/** A deterministic legal fleet, drawn from the suite's own generator. */
function randomFleet(random: SeededGameRandom): { ships: Ship[]; salt: number[] } {
  for (let attempt = 0; attempt < 50; attempt++) {
    const ships: Ship[] = [];
    const used = new Set<number>();
    let ok = true;
    for (const spec of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 200 && !placed; tries++) {
        const vertical = random.nextInt(2) === 1;
        const row = random.nextInt(vertical ? BOARD_SIZE - spec.length + 1 : BOARD_SIZE);
        const col = random.nextInt(vertical ? BOARD_SIZE : BOARD_SIZE - spec.length + 1);
        const ship: Ship = { row, col, vertical, length: spec.length };
        const cells = shipCells(ship);
        if (cells === null || cells.some((c) => used.has(c))) continue;
        for (const c of cells) used.add(c);
        ships.push(ship);
        placed = true;
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return { ships, salt: Array.from({ length: SALT_BYTES }, () => random.nextInt(256)) };
  }
  throw new Error('randomFleet: could not place a fleet');
}

/**
 * Honest random play. Each player keeps its own fleet outside the game state -
 * exactly as a real device would - and answers shots from it.
 */
function honestHooks(): ConformanceHooks<BattleshipState, BattleshipAction> {
  const fleets = new Map<string, { ships: Ship[]; salt: number[] }>();
  const fleetFor = (player: string, random: SeededGameRandom) => {
    const existing = fleets.get(player);
    if (existing) return existing;
    const fresh = randomFleet(random);
    fleets.set(player, fresh);
    return fresh;
  };

  return {
    maxPlies: 600,
    legalAction: (state, player, random) => {
      const index = state.players.indexOf(player);
      if (index < 0) return null;
      const mine = fleetFor(player, random);

      switch (state.phase) {
        case BattleshipPhase.PLACEMENT:
          if (state.commitments[index]) return null;
          return { type: 'place', payload: { commitment: fleetCommitment(mine.ships, mine.salt) } };

        case BattleshipPhase.FIRING: {
          const pending = state.pending;
          if (pending) {
            if (pending.shooter === index) return null; // waiting on the other side
            const answer = resolveReport(mine.ships, state.shots[index] ?? [], pending.cell);
            return { type: 'report', payload: { cell: answer.cell, hit: answer.hit, sunk: answer.sunk } };
          }
          if (state.turnIndex !== index) return null;
          const fired = new Set((state.shots[1 - index] ?? []).map((shot) => shot.cell));
          const open: number[] = [];
          for (let cell = 0; cell < CELL_COUNT; cell++) if (!fired.has(cell)) open.push(cell);
          if (open.length === 0) return null;
          return { type: 'fire', payload: { cell: open[random.nextInt(open.length)] as number } };
        }

        case BattleshipPhase.REVEAL:
          if (state.reveals[index]) return null;
          return { type: 'reveal', payload: { ships: mine.ships, salt: mine.salt } };

        default:
          return null;
      }
    },
  };
}

describe('battleship conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(battleship, honestHooks());
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).toBe(GameStatusKind.WON);
  });

  it('passes conformance across many seeds', () => {
    for (let seed = 1; seed <= 45; seed++) {
      const report = runConformance(battleship, honestHooks(), seed);
      expect(report.failures).toEqual([]);
      expect(report.finalStatus).toBe(GameStatusKind.WON);
    }
  });

  it('keeps two devices byte-identical through a full random game', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const random = new SeededGameRandom(seed);
      const setup = { players: ['a', 'b'], seed, options: {} };
      const A = new GameSession({ definition: battleship, setup, localPlayer: 'a', isHost: true });
      const B = new GameSession({ definition: battleship, setup, localPlayer: 'b', isHost: false });
      const fleets = { a: randomFleet(random), b: randomFleet(random) };

      let guard = 0;
      while (!A.isOver && guard++ < 600) {
        const turn = battleship.currentTurn?.(A.currentState) ?? null;
        if (turn === null) break;
        const side: Side = turn === 'a' ? 'a' : 'b';
        const index = side === 'a' ? 0 : 1;
        const state = A.currentState;
        const mine = fleets[side];
        let proposal: { type: string; payload: CborValue } | null = null;
        if (state.phase === BattleshipPhase.PLACEMENT) {
          proposal = { type: 'place', payload: { commitment: fleetCommitment(mine.ships, mine.salt) } };
        } else if (state.phase === BattleshipPhase.FIRING && state.pending) {
          const answer = resolveReport(mine.ships, state.shots[index] ?? [], state.pending.cell);
          proposal = { type: 'report', payload: { cell: answer.cell, hit: answer.hit, sunk: answer.sunk } };
        } else if (state.phase === BattleshipPhase.FIRING) {
          const fired = new Set((state.shots[1 - index] ?? []).map((shot) => shot.cell));
          const open: number[] = [];
          for (let cell = 0; cell < CELL_COUNT; cell++) if (!fired.has(cell)) open.push(cell);
          proposal = { type: 'fire', payload: { cell: open[random.nextInt(open.length)] as number } };
        } else if (state.phase === BattleshipPhase.REVEAL) {
          proposal = { type: 'reveal', payload: { ships: mine.ships, salt: mine.salt } };
        }
        if (!proposal) break;

        const from = side === 'a' ? A : B;
        const to = side === 'a' ? B : A;
        const outcome = from.submitLocal(proposal.type, proposal.payload);
        expect(outcome.accepted).toBe(true);
        if (!outcome.accepted) break;
        const wire = decodeCbor(encodeCbor(battleship.encodeAction(outcome.applied.action)));
        expect(to.applyRemote(wire, side).accepted).toBe(true);
        // The whole encoded state, not a truncated prefix.
        expect(toHex(encodeCbor(battleship.encodeState(A.currentState)))).toBe(
          toHex(encodeCbor(battleship.encodeState(B.currentState))),
        );
      }

      expect(A.isOver).toBe(true);
      expect(A.status.kind).toBe(GameStatusKind.WON);
      expect(A.currentState.cheated).toEqual([false, false]);
      // Replaying the log from scratch must land on the same state.
      const replayed = GameSession.replay(battleship, setup, A.history());
      expect(toHex(encodeCbor(battleship.encodeState(replayed)))).toBe(
        toHex(encodeCbor(battleship.encodeState(A.currentState))),
      );
    }
  });
});
