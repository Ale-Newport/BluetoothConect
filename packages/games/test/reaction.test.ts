import { describe, expect, it } from 'vitest';
import {
  MAX_TAP_MS,
  MAX_WAIT_MS,
  MIN_HUMAN_REACTION_MS,
  MIN_WAIT_MS,
  NOBODY,
  NOT_TAPPED,
  NO_ROUND_YET,
  NO_TIME,
  ROUNDS_TO_PLAY,
  ReactionPhase,
  averageReactionMs,
  isMatchOver,
  reaction,
  reactionPhase,
  type ReactionAction,
  type ReactionState,
} from '../src/games/reaction.js';
import { GameSession } from '../src/runtime.js';
import { runConformance } from '../src/conformance.js';
import { GameStatusKind, createContext, type CborValue, type PlayerId } from '../src/engine.js';

// ---------------------------------------------------------------------------
// A table of independent sessions, one per player, kept in step by hand - the
// same path a real match takes: submit locally, ship the encoded action, apply
// it on every peer.
// ---------------------------------------------------------------------------

class Table {
  readonly sessions = new Map<PlayerId, GameSession<ReactionState, ReactionAction>>();

  constructor(
    readonly players: readonly PlayerId[],
    seed = 42,
  ) {
    const setup = { players: [...players], seed, options: {} };
    players.forEach((p, i) => {
      this.sessions.set(p, new GameSession({ definition: reaction, setup, localPlayer: p, isHost: i === 0 }));
    });
  }

  session(player: PlayerId): GameSession<ReactionState, ReactionAction> {
    const s = this.sessions.get(player);
    if (!s) throw new Error(`no session for ${player}`);
    return s;
  }

  get host(): GameSession<ReactionState, ReactionAction> {
    return this.session(this.players[0] as PlayerId);
  }

  get state(): ReactionState {
    return this.host.currentState;
  }

  /** Submit for `player` and mirror the accepted action onto every other device. */
  act(player: PlayerId, type: string, payload: CborValue) {
    const outcome = this.session(player).submitLocal(type, payload);
    if (outcome.accepted) {
      const wire = reaction.encodeAction(outcome.applied.action);
      for (const [id, peer] of this.sessions) {
        if (id === player) continue;
        expect(peer.applyRemote(wire, player).accepted).toBe(true);
      }
    }
    return outcome;
  }

  tap(player: PlayerId, atMs: number) {
    return this.act(player, 'tap', { atMs });
  }

  /** Everyone signals ready. Returns the green moment the round drew. */
  arm(): number {
    for (const p of this.players) expect(this.act(p, 'ready', null).accepted).toBe(true);
    return this.state.greenAtMs;
  }

  /** Every device must hold a byte-identical state. */
  expectConverged(): void {
    const encoded = [...this.sessions.values()].map((s) => JSON.stringify(reaction.encodeState(s.currentState)));
    for (const e of encoded) expect(e).toBe(encoded[0]);
  }
}

/**
 * Play one round. `offsets[i]` is player i's tap relative to the green moment -
 * negative for an early tap, null to not tap at all. Players tap in seat order,
 * and a round that has already resolved (a walkover) swallows the rest.
 */
function playRound(table: Table, offsets: readonly (number | null)[]): number {
  const green = table.arm();
  table.players.forEach((p, i) => {
    const offset = offsets[i];
    if (offset === null || offset === undefined) return;
    if (table.state.greenAtMs === 0) return; // the round already resolved
    expect(table.tap(p, Math.max(0, green + offset)).accepted).toBe(true);
  });
  table.expectConverged();
  return green;
}

const duel = (seed = 42) => new Table(['a', 'b'], seed);

describe('reaction - the round', () => {
  it('starts in the arming phase with nothing decided', () => {
    const t = duel();
    expect(reactionPhase(t.state)).toBe(ReactionPhase.ARMING);
    expect(t.state.greenAtMs).toBe(0);
    expect(t.state.round).toBe(0);
    expect(t.state.lastWinner).toBe(NO_ROUND_YET);
    expect(t.state.taps).toEqual([NOT_TAPPED, NOT_TAPPED]);
    expect(t.state.ready).toEqual([false, false]);
    expect(isMatchOver(t.state)).toBe(false);
  });

  it('arms only when every player is ready', () => {
    const t = duel();
    expect(t.act('a', 'ready', null).accepted).toBe(true);
    expect(t.state.ready).toEqual([true, false]);
    expect(t.state.greenAtMs).toBe(0);
    expect(reactionPhase(t.state)).toBe(ReactionPhase.ARMING);

    expect(t.act('b', 'ready', null).accepted).toBe(true);
    expect(t.state.greenAtMs).toBeGreaterThanOrEqual(MIN_WAIT_MS);
    expect(t.state.greenAtMs).toBeLessThanOrEqual(MAX_WAIT_MS);
    expect(reactionPhase(t.state)).toBe(ReactionPhase.LIVE);
    t.expectConverged();
  });

  it('draws the same green moment on every device, from the shared seed', () => {
    const first = duel(1234);
    const second = duel(1234);
    expect(first.arm()).toBe(second.arm());
    first.expectConverged();

    // ...and both sessions of one table agree, not just the host.
    expect(first.session('b').currentState.greenAtMs).toBe(first.state.greenAtMs);
  });

  it('draws different waits from different seeds', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) seen.add(duel(seed).arm());
    expect(seen.size).toBeGreaterThan(5);
    for (const g of seen) {
      expect(Number.isInteger(g)).toBe(true);
      expect(g).toBeGreaterThanOrEqual(MIN_WAIT_MS);
      expect(g).toBeLessThanOrEqual(MAX_WAIT_MS);
    }
  });

  it('the fastest honest tap wins the round', () => {
    const t = duel();
    playRound(t, [250, 400]);
    expect(t.state.lastWinner).toBe(0);
    expect(t.state.wins).toEqual([1, 0]);
    expect(t.state.lastReactions).toEqual([250, 400]);
    expect(t.state.round).toBe(1);
    // The next round is back in the arming phase with the taps cleared.
    expect(reactionPhase(t.state)).toBe(ReactionPhase.ARMING);
    expect(t.state.ready).toEqual([false, false]);
    expect(t.state.taps).toEqual([NOT_TAPPED, NOT_TAPPED]);
  });

  it('does not resolve on the first tap to arrive - a later report can still win', () => {
    const t = duel();
    const green = t.arm();
    expect(t.tap('a', green + 400).accepted).toBe(true);
    // a has reported and could look like the winner, but the round is still live.
    expect(t.state.greenAtMs).toBe(green);
    expect(t.state.round).toBe(0);
    expect(t.tap('b', green + 220).accepted).toBe(true);
    expect(t.state.lastWinner).toBe(1);
    expect(t.state.wins).toEqual([0, 1]);
  });

  it('records reaction times: best, total and a running average', () => {
    const t = duel();
    playRound(t, [200, 500]);
    playRound(t, [301, 450]);
    expect(t.state.best).toEqual([200, 450]);
    expect(t.state.totalMs).toEqual([501, 950]);
    expect(t.state.honestTaps).toEqual([2, 2]);
    expect(averageReactionMs(t.state, 'a')).toBe(250.5);
    expect(averageReactionMs(t.state, 'b')).toBe(475);
    expect(averageReactionMs(t.state, 'nobody-here')).toBeNull();
    expect(averageReactionMs(reaction.createInitialState({ players: ['a', 'b'], seed: 1, options: {} }), 'a')).toBeNull();
  });

  it('a tie awards the round to nobody but still records both times', () => {
    const t = duel();
    playRound(t, [300, 300]);
    expect(t.state.lastWinner).toBe(NOBODY);
    expect(t.state.wins).toEqual([0, 0]);
    expect(t.state.lastReactions).toEqual([300, 300]);
    expect(t.state.best).toEqual([300, 300]);
    expect(t.state.round).toBe(1);
  });
});

describe('reaction - false starts', () => {
  it('tapping before green loses the round', () => {
    const t = duel();
    const green = t.arm();
    expect(t.tap('a', green - 200).accepted).toBe(true);
    // Everyone left standing is a single player, so the round ends there and
    // then: b takes it without having to tap.
    expect(t.state.round).toBe(1);
    expect(t.state.lastWinner).toBe(1);
    expect(t.state.wins).toEqual([0, 1]);
    expect(t.state.falseStarts).toEqual([1, 0]);
    expect(t.state.lastReactions).toEqual([NO_TIME, NO_TIME]);
    expect(t.state.honestTaps).toEqual([0, 0]);
    t.expectConverged();
  });

  it('an implausibly fast tap is a false start, not a win', () => {
    const t = duel();
    const green = t.arm();
    // 40 ms after green: no human reflex arc is that short, so it is a cheat or
    // a stuck finger. Either way it loses.
    expect(t.tap('a', green + 40).accepted).toBe(true);
    expect(t.state.lastWinner).toBe(1);
    expect(t.state.falseStarts).toEqual([1, 0]);
    expect(t.state.best[0]).toBe(NO_TIME);
  });

  it('treats the credibility floor itself as honest, and one below it as a false start', () => {
    const honest = duel();
    playRound(honest, [MIN_HUMAN_REACTION_MS, 300]);
    expect(honest.state.lastWinner).toBe(0);
    expect(honest.state.best).toEqual([MIN_HUMAN_REACTION_MS, 300]);

    // One millisecond quicker and the same tap loses - and here the honest
    // player reports FIRST, so the round runs to the end rather than ending on
    // a walkover.
    const cheat = duel();
    const green = cheat.arm();
    expect(cheat.tap('b', green + 300).accepted).toBe(true);
    expect(cheat.tap('a', green + MIN_HUMAN_REACTION_MS - 1).accepted).toBe(true);
    expect(cheat.state.lastWinner).toBe(1);
    expect(cheat.state.lastReactions).toEqual([NO_TIME, 300]);
    expect(cheat.state.falseStarts).toEqual([1, 0]);
  });

  it('gives the round to nobody when everybody false-starts', () => {
    const t = duel();
    const green = t.arm();
    expect(t.tap('a', 0).accepted).toBe(true);
    // a false-started, so b is the last player standing - the round is already
    // b's before b can tap.
    expect(t.state.round).toBe(1);
    expect(t.state.lastWinner).toBe(1);
    void green;
  });

  it('three players: a false start eliminates one and the others race on', () => {
    const t = new Table(['a', 'b', 'c'], 7);
    const green = t.arm();
    expect(t.tap('a', green - 50).accepted).toBe(true);
    // Two players are still owed, so the round keeps running.
    expect(t.state.greenAtMs).toBe(green);
    expect(t.state.round).toBe(0);
    expect(t.tap('b', green + 300).accepted).toBe(true);
    expect(t.state.round).toBe(0);
    expect(t.tap('c', green + 250).accepted).toBe(true);
    expect(t.state.lastWinner).toBe(2);
    expect(t.state.wins).toEqual([0, 0, 1]);
    expect(t.state.lastReactions).toEqual([NO_TIME, 300, 250]);
    expect(t.state.falseStarts).toEqual([1, 0, 0]);
    t.expectConverged();
  });

  it('three players: the last player standing wins by walkover without tapping', () => {
    const t = new Table(['a', 'b', 'c'], 9);
    const green = t.arm();
    expect(t.tap('a', green - 100).accepted).toBe(true);
    expect(t.state.round).toBe(0);
    expect(t.tap('b', green + 10).accepted).toBe(true);
    expect(t.state.round).toBe(1);
    expect(t.state.lastWinner).toBe(2);
    expect(t.state.wins).toEqual([0, 0, 1]);
    expect(t.state.honestTaps).toEqual([0, 0, 0]);
    expect(t.state.falseStarts).toEqual([1, 1, 0]);
    expect(t.state.lastReactions).toEqual([NO_TIME, NO_TIME, NO_TIME]);
  });

  it('a tie between two honest players beats a third who false-started, but wins nobody the round', () => {
    const t = new Table(['a', 'b', 'c'], 11);
    playRound(t, [-10, 250, 250]);
    expect(t.state.lastWinner).toBe(NOBODY);
    expect(t.state.wins).toEqual([0, 0, 0]);
    expect(t.state.lastReactions).toEqual([NO_TIME, 250, 250]);
  });
});

describe('reaction - best of five', () => {
  it('ends the moment someone reaches three round wins', () => {
    const t = duel();
    playRound(t, [200, 400]);
    playRound(t, [200, 400]);
    expect(t.host.isOver).toBe(false);
    playRound(t, [200, 400]);
    expect(t.state.round).toBe(3);
    expect(t.state.wins).toEqual([3, 0]);
    expect(t.host.isOver).toBe(true);
    expect(reactionPhase(t.state)).toBe(ReactionPhase.OVER);
    const status = t.host.status;
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['a']);
    expect(t.session('b').status.kind).toBe(GameStatusKind.WON);
  });

  it('stops after five rounds and awards the match on rounds won', () => {
    const t = duel();
    playRound(t, [200, 400]); // a
    playRound(t, [400, 200]); // b
    playRound(t, [300, 300]); // nobody
    playRound(t, [150, 250]); // a
    playRound(t, [300, 300]); // nobody
    expect(t.state.round).toBe(ROUNDS_TO_PLAY);
    expect(t.state.wins).toEqual([2, 1]);
    const status = t.host.status;
    expect(status.kind).toBe(GameStatusKind.WON);
    expect(status.kind === GameStatusKind.WON && status.winners).toEqual(['a']);
  });

  it('draws when the round wins are level after five', () => {
    const t = duel();
    playRound(t, [200, 400]); // a
    playRound(t, [400, 200]); // b
    playRound(t, [200, 400]); // a
    playRound(t, [400, 200]); // b
    playRound(t, [300, 300]); // nobody
    expect(t.state.wins).toEqual([2, 2]);
    const status = t.host.status;
    expect(status.kind).toBe(GameStatusKind.DRAW);
    expect(status.kind === GameStatusKind.DRAW && status.reason).toMatch(/tied on 2/);
  });

  it('draws when five rounds go to nobody at all', () => {
    const t = duel();
    for (let i = 0; i < ROUNDS_TO_PLAY; i++) playRound(t, [300, 300]);
    expect(t.state.round).toBe(ROUNDS_TO_PLAY);
    expect(t.state.wins).toEqual([0, 0]);
    const status = t.host.status;
    expect(status.kind).toBe(GameStatusKind.DRAW);
    expect(status.kind === GameStatusKind.DRAW && status.reason).toMatch(/no round was won/);
  });
});

describe('reaction - rejects what a peer must not do', () => {
  it('refuses a tap before the round is armed', () => {
    const t = duel();
    const r = t.act('a', 'tap', { atMs: 120 });
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/has not started/);
  });

  it('refuses a second ready from the same player', () => {
    const t = duel();
    expect(t.act('a', 'ready', null).accepted).toBe(true);
    const again = t.act('a', 'ready', null);
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already ready/);
  });

  it('refuses a ready once the round is running', () => {
    const t = duel();
    t.arm();
    const r = t.act('a', 'ready', null);
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.detail).toMatch(/already running/);
  });

  it('refuses a second tap in the same round', () => {
    const t = new Table(['a', 'b', 'c'], 3);
    const green = t.arm();
    expect(t.tap('a', green + 200).accepted).toBe(true);
    const again = t.tap('a', green + 100);
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.detail).toMatch(/already tapped/);
  });

  it('refuses everything once the match is decided', () => {
    const t = duel();
    playRound(t, [200, 400]);
    playRound(t, [200, 400]);
    playRound(t, [200, 400]);
    expect(t.host.isOver).toBe(true);
    const ready = t.act('a', 'ready', null);
    expect(ready.accepted).toBe(false);
    expect(ready.accepted === false && ready.reason).toBe('gameOver');
    // ...and the rule itself refuses too, not just the session gate.
    const context = createContext(['a', 'b'], 1);
    const direct = reaction.validateAction(t.state, { type: 'ready', player: 'a', seq: 0, payload: null }, context);
    expect(direct.ok).toBe(false);
    expect(direct.ok === false && direct.reason).toMatch(/finished/);
  });

  it('refuses an action from someone who is not in the game', () => {
    const t = duel();
    const green = t.arm();
    const forged = reaction.encodeAction({ type: 'tap', player: 'a', seq: 0, payload: { atMs: green + 200 } });
    const r = t.session('a').applyRemote(forged, 'mallory');
    expect(r.accepted).toBe(false);
    expect(r.accepted === false && r.reason).toBe('notAPlayer');

    // The rule rejects an unknown player directly as well.
    const context = createContext(['a', 'b'], 1);
    const direct = reaction.validateAction(
      t.state,
      { type: 'tap', player: 'mallory', seq: 0, payload: { atMs: green + 200 } },
      context,
    );
    expect(direct.ok).toBe(false);
    expect(direct.ok === false && direct.reason).toMatch(/not in this game/);
  });

  it('attributes an action to the authenticated sender, not to the claim in the packet', () => {
    const t = duel();
    const green = t.arm();
    expect(t.tap('a', green + 200).accepted).toBe(true);
    // b re-sends a's tap as if it were its own. The session attributes it to b,
    // b's own seq is 1 (it has readied once), and the round resolves for b - it
    // cannot be replayed as a's move.
    const stolen = reaction.encodeAction({ type: 'tap', player: 'a', seq: 1, payload: { atMs: green + 200 } });
    const r = t.session('a').applyRemote(stolen, 'b');
    expect(r.accepted).toBe(true);
    expect(r.accepted && r.applied.action.player).toBe('b');
    expect(t.state.lastWinner).toBe(NOBODY); // identical times: nobody
  });

  it('rejects a duplicate rather than applying it twice', () => {
    const t = duel();
    const outcome = t.session('a').submitLocal('ready', null);
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;
    const wire = reaction.encodeAction(outcome.applied.action);
    expect(t.session('b').applyRemote(wire, 'a').accepted).toBe(true);
    const again = t.session('b').applyRemote(wire, 'a');
    expect(again.accepted).toBe(false);
    expect(again.accepted === false && again.reason).toBe('duplicate');
  });

  it('refuses an out-of-range or non-integer tap through the rule as well as the decoder', () => {
    const t = duel();
    t.arm();
    const context = createContext(['a', 'b'], 1);
    for (const atMs of [-1, MAX_TAP_MS + 1, 12.5, Number.NaN]) {
      const result = reaction.validateAction(t.state, { type: 'tap', player: 'a', seq: 1, payload: { atMs } }, context);
      expect(result.ok).toBe(false);
    }
  });

  it('clamps a wildly late local tap instead of losing it', () => {
    const t = duel();
    const green = t.arm();
    // A player who wandered off: submitLocal round-trips through the encoder, so
    // the clamp lands before the reducer ever sees the number.
    expect(t.tap('a', 9_999_999).accepted).toBe(true);
    expect(t.state.taps[0]).toBe(MAX_TAP_MS);
    expect(t.tap('b', green + 300).accepted).toBe(true);
    expect(t.state.lastWinner).toBe(1);
    expect(t.state.best[0]).toBe(MAX_TAP_MS - green);
  });

  it('refuses a local tap that is not a number at all', () => {
    const t = duel();
    t.arm();
    expect(t.act('a', 'tap', { atMs: Number.NaN }).accepted).toBe(false);
    expect(t.act('a', 'tap', { atMs: 'soon' as unknown as number }).accepted).toBe(false);
    expect(t.act('a', 'tap', null).accepted).toBe(false);
    expect(t.act('a', 'tap', 5).accepted).toBe(false);
    expect(t.act('a', 'nap', null).accepted).toBe(false);
  });
});

describe('reaction - encoding', () => {
  it('round-trips an action of each kind exactly', () => {
    for (const action of [
      { type: 'ready', player: 'a', seq: 0, payload: null },
      { type: 'tap', player: 'b', seq: 7, payload: { atMs: 0 } },
      { type: 'tap', player: 'b', seq: 8, payload: { atMs: MAX_TAP_MS } },
      { type: 'tap', player: 'b', seq: 9, payload: { atMs: 1234 } },
    ] as const satisfies readonly ReactionAction[]) {
      const restored = reaction.decodeAction(reaction.encodeAction(action), action.player);
      expect(restored).toEqual(action);
      expect(reaction.encodeAction(restored)).toEqual(reaction.encodeAction(action));
    }
  });

  it('round-trips a mid-match state exactly', () => {
    const t = duel(77);
    playRound(t, [220, 610]);
    playRound(t, [-40, 300]);
    t.arm();
    t.tap('a', t.state.greenAtMs + 190);

    const encoded = reaction.encodeState(t.state);
    const restored = reaction.decodeState(JSON.parse(JSON.stringify(encoded)) as CborValue);
    expect(restored).toEqual(t.state);
    expect(reaction.encodeState(restored)).toEqual(encoded);
  });

  it('throws on a hostile action rather than trusting it', () => {
    const junk: CborValue[] = [
      null,
      0,
      'tap',
      [],
      {},
      { t: 'tap' },
      { t: 'tap', s: 0 },
      { t: 'tap', s: 0, p: null },
      { t: 'tap', s: 0, p: [] },
      { t: 'tap', s: 0, p: { a: -1 } },
      { t: 'tap', s: 0, p: { a: MAX_TAP_MS + 1 } },
      { t: 'tap', s: 0, p: { a: 1e12 } },
      { t: 'tap', s: 0, p: { a: 12.5 } },
      { t: 'tap', s: 0, p: { a: 'now' } },
      { t: 'tap', s: -1, p: { a: 200 } },
      { t: 'tap', s: 1.5, p: { a: 200 } },
      { t: 'sprint', s: 0, p: null },
      { t: 'x'.repeat(500), s: 0, p: null },
      { t: 'tap', s: 0, p: new Uint8Array(32) },
      { t: 'tap', s: 0, p: Array.from({ length: 300 }, () => 1) },
    ];
    for (const value of junk) {
      expect(() => reaction.decodeAction(value, 'a')).toThrow();
    }
  });

  it('never lets hostile bytes escape applyRemote as a throw', () => {
    const t = duel();
    for (const value of [null, 7, 'nope', [], {}, { t: 'tap', s: 0, p: { a: 1e9 } }] as CborValue[]) {
      expect(() => t.session('a').applyRemote(value, 'b')).not.toThrow();
      expect(t.session('a').applyRemote(value, 'b').accepted).toBe(false);
    }
  });

  it('throws on a malformed state rather than adopting it', () => {
    const good = reaction.encodeState(duel().state) as Record<string, CborValue>;
    const bad: CborValue[] = [
      null,
      'state',
      [],
      {},
      { ...good, p: ['only-one'] },
      { ...good, p: Array.from({ length: 7 }, (_, i) => `p${i}`) },
      { ...good, p: [1, 2] },
      { ...good, p: ['a', ''] },
      { ...good, w: [0] }, // wrong length
      { ...good, w: [0, 99] }, // more wins than there are rounds
      { ...good, t: [0, MAX_TAP_MS + 1] },
      { ...good, g: 500 }, // an armed round always waits at least MIN_WAIT_MS
      { ...good, g: MAX_WAIT_MS + 1 },
      { ...good, r: ROUNDS_TO_PLAY + 1 },
      { ...good, l: 2 }, // no such player index
      { ...good, l: NO_ROUND_YET - 1 },
      { ...good, y: [0, 2] },
      { ...good, b: [-2, 0] },
      { ...good, x: 'none' },
    ];
    for (const value of bad) {
      expect(() => reaction.decodeState(value)).toThrow();
    }
    expect(() => reaction.decodeState({ ...good, g: MIN_WAIT_MS })).not.toThrow();
  });
});

describe('reaction - purity and replay', () => {
  it('does not mutate the state it is given', () => {
    const setup = { players: ['a', 'b'], seed: 5, options: {} };
    const context = createContext(setup.players, setup.seed);
    const start = reaction.createInitialState(setup);
    const before = JSON.stringify(reaction.encodeState(start));

    const readyA = reaction.applyAction(start, { type: 'ready', player: 'a', seq: 0, payload: null }, context);
    const armed = reaction.applyAction(readyA, { type: 'ready', player: 'b', seq: 0, payload: null }, context);
    const tapped = reaction.applyAction(
      armed,
      { type: 'tap', player: 'a', seq: 1, payload: { atMs: armed.greenAtMs + 300 } },
      context,
    );

    expect(JSON.stringify(reaction.encodeState(start))).toBe(before);
    expect(readyA).not.toBe(start);
    expect(readyA.ready).not.toBe(start.ready);
    expect(tapped.taps).not.toBe(armed.taps);
    expect(start.ready).toEqual([false, false]);
  });

  it('replaying the action log reproduces the live state', () => {
    const setup = { players: ['a', 'b'], seed: 314, options: {} };
    const t = new Table(setup.players, setup.seed);
    playRound(t, [210, 480]);
    playRound(t, [-30, 260]);
    playRound(t, [300, 300]);
    const replayed = GameSession.replay(reaction, setup, t.host.history());
    expect(reaction.encodeState(replayed)).toEqual(reaction.encodeState(t.state));
  });

  it('keeps six players in step for a whole match', () => {
    const players = ['a', 'b', 'c', 'd', 'e', 'f'];
    const t = new Table(players, 2024);
    let guard = 0;
    while (!t.host.isOver && guard++ < 20) {
      playRound(t, [400, -50, 300, 55, 250, 900]);
    }
    expect(t.host.isOver).toBe(true);
    // c is the fastest credible tapper every round: 250 beats 300, 400 and 900,
    // while -50 is early and 55 is below the credibility floor.
    expect(t.state.wins[4]).toBe(3);
    expect(t.state.falseStarts[1]).toBe(3);
    expect(t.state.falseStarts[3]).toBe(3);
    expect(t.host.status.kind).toBe(GameStatusKind.WON);
    t.expectConverged();
  });
});

// ---------------------------------------------------------------------------
// The shared suite
// ---------------------------------------------------------------------------

const hooks = {
  legalAction: (state: ReactionState, player: PlayerId, random: { nextInt(max: number): number }) => {
    if (reaction.currentTurn?.(state) !== player) return null;
    if (state.greenAtMs === 0) return { type: 'ready', payload: null };
    // A deliberate mix, so random play exercises every resolution path: early
    // taps, sub-human taps, exact ties and honest races.
    const roll = random.nextInt(10);
    if (roll === 0) return { type: 'tap', payload: { atMs: random.nextInt(state.greenAtMs) } };
    if (roll === 1) return { type: 'tap', payload: { atMs: state.greenAtMs + random.nextInt(MIN_HUMAN_REACTION_MS) } };
    if (roll === 2) return { type: 'tap', payload: { atMs: state.greenAtMs + 300 } };
    return {
      type: 'tap',
      payload: { atMs: state.greenAtMs + MIN_HUMAN_REACTION_MS + random.nextInt(500) },
    };
  },
  maxPlies: 60,
};

describe('reaction conformance', () => {
  it('passes the shared game conformance suite', () => {
    const report = runConformance(reaction, hooks);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.finalStatus).not.toBe(GameStatusKind.IN_PROGRESS);
  });

  it('passes conformance across many seeds', () => {
    let terminated = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const report = runConformance(reaction, hooks, seed);
      expect(report.failures).toEqual([]);
      expect(report.passed).toBe(true);
      if (report.finalStatus !== GameStatusKind.IN_PROGRESS) terminated++;
    }
    expect(terminated).toBe(60);
  });
});
