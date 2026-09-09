/**
 * Reaction - a reflex duel for two to six players, best of five rounds.
 *
 * A round runs in two phases:
 *
 *   ARMING   every player sends `ready`. The round arms on the action that
 *            completes the set, and THAT action draws the wait from the shared
 *            PRNG, so every device turns green at the same millisecond offset
 *            from the round start.
 *   LIVE     the screen is red, then green at `greenAtMs`. Each player sends
 *            exactly one `tap` carrying `atMs`, milliseconds since the round
 *            started on their own device.
 *
 * Scoring: the lowest honest reaction time takes the round. An identical pair of
 * best times gives the round to nobody. First to three round wins takes the
 * match; five rounds is the hard ceiling.
 *
 * ---------------------------------------------------------------------------
 * The self-reported-time problem (this is the part that matters)
 * ---------------------------------------------------------------------------
 * `atMs` is measured on the tapping device and travels over a Bluetooth link
 * with tens of milliseconds of real, variable latency. Arrival order therefore
 * says NOTHING about who tapped first, and there is no server to arbitrate. Two
 * consequences run through the whole design:
 *
 *  1. THE ROUND CANNOT END ON THE FIRST TAP TO ARRIVE. It ends when every player
 *     has reported (or when everyone who has reported false-started and a single
 *     player is left standing, who then wins by walkover - which is what makes a
 *     two-player false start end the round immediately, as it should). Only then
 *     are the reported times compared. Ending on arrival order would hand the
 *     round to whoever has the shorter radio queue.
 *
 *  2. A REPORTED TIME IS AN UNTRUSTED CLAIM. A cheating peer can send any number
 *     it likes, so the reducer treats an implausible claim as a false start
 *     rather than as a win: anything faster than MIN_HUMAN_REACTION_MS after the
 *     green - 80 ms, below the floor of human visual reaction - loses the round
 *     exactly like tapping early does. `atMs` is additionally clamped to
 *     0..MAX_TAP_MS on the wire, so no value outside that window ever reaches
 *     the rules. That bounds the damage; it cannot eliminate it, because there
 *     is no way for one phone to time another phone's finger. A peer shaving
 *     40 ms off an honest 300 ms tap is undetectable here and always will be.
 *     What the design guarantees is that both devices agree on the OUTCOME, and
 *     that no claim can produce an impossible one.
 *
 * ---------------------------------------------------------------------------
 * Determinism
 * ---------------------------------------------------------------------------
 * Every value stored in the state is an INTEGER: milliseconds, counts and player
 * indices. There is not one floating-point operation in the reducer, so the
 * question of divergence between two devices' arithmetic never arises and there
 * is nothing to round. The running average is deliberately NOT stored - the sum
 * and the count are, and `averageReactionMs` divides on demand, outside the
 * reducer, where a last-bit difference cannot enter the shared state.
 *
 * `context.random` is consulted in exactly one place - arming a round - so both
 * devices draw the same number of values in the same order and stay in step.
 * Rejected actions never reach `applyAction`, so they never consume a draw.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  VALID,
  asArray,
  asInt,
  asMap,
  decodeActionEnvelope,
  encodeActionEnvelope,
  invalid,
  type GameAction,
  type GameContext,
  type GameDefinition,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';

// ---------------------------------------------------------------------------
// Rules constants
// ---------------------------------------------------------------------------

/** Shortest wait before the screen turns green, in ms after the round start. */
export const MIN_WAIT_MS = 1000;
/** Longest wait before green. Drawn uniformly from [MIN_WAIT_MS, MAX_WAIT_MS]. */
export const MAX_WAIT_MS = 4000;

/**
 * The credibility floor. No human sees green and moves a finger in under 80 ms;
 * the record for a simple visual reaction sits around 100 ms and typical play is
 * 200-350 ms. A tap claiming to beat the floor is treated as a false start.
 */
export const MIN_HUMAN_REACTION_MS = 80;

/** `atMs` is clamped to this window on the wire. Ten seconds is a lifetime here. */
export const MAX_TAP_MS = 10_000;

/** Hard ceiling on rounds - "best of five". */
export const ROUNDS_TO_PLAY = 5;
/** Round wins needed to take the match outright. */
export const WINS_TO_TAKE_IT = 3;

/** `taps[i]` when player i has not reported yet. */
export const NOT_TAPPED = -1;
/** A missing reaction time: a false start, or a round won by walkover. */
export const NO_TIME = -1;
/** `lastWinner` when the round went to nobody. */
export const NOBODY = -1;
/** `lastWinner` before any round has been resolved. */
export const NO_ROUND_YET = -2;

const MAX_PLAYERS = 6;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ReactionState {
  readonly players: readonly PlayerId[];
  /** Rounds already resolved; also the index of the round being played. */
  readonly round: number;
  /** Per player: have they signalled ready for the round about to start. */
  readonly ready: readonly boolean[];
  /**
   * Milliseconds after the round start at which the screen turns green, or 0
   * while the round is not armed. A live round always holds at least
   * MIN_WAIT_MS, so 0 is an unambiguous "not armed yet".
   */
  readonly greenAtMs: number;
  /** Per player: the reported tap time this round, or NOT_TAPPED. */
  readonly taps: readonly number[];
  /** Per player: rounds won. */
  readonly wins: readonly number[];
  /** Per player: fastest honest reaction so far, or NO_TIME. */
  readonly best: readonly number[];
  /** Per player: sum of honest reaction times. With `honestTaps`, the average. */
  readonly totalMs: readonly number[];
  /** Per player: how many honest taps went into `totalMs`. */
  readonly honestTaps: readonly number[];
  /** Per player: false starts, early or implausibly fast. */
  readonly falseStarts: readonly number[];
  /** Index of the last round's winner, or NOBODY, or NO_ROUND_YET. */
  readonly lastWinner: number;
  /** Per player: last round's reaction time, NO_TIME for a false start or no tap. */
  readonly lastReactions: readonly number[];
}

export interface ReactionReadyAction extends GameAction {
  readonly type: 'ready';
  readonly payload: null;
}

export interface ReactionTapAction extends GameAction {
  readonly type: 'tap';
  readonly payload: { readonly atMs: number };
}

export type ReactionAction = ReactionReadyAction | ReactionTapAction;

export const ReactionPhase = {
  /** Waiting for everyone to signal ready. */
  ARMING: 'arming',
  /** The round is running: red, then green at `greenAtMs`. */
  LIVE: 'live',
  /** The match is decided. */
  OVER: 'over',
} as const;
export type ReactionPhase = (typeof ReactionPhase)[keyof typeof ReactionPhase];

// ---------------------------------------------------------------------------
// Derived helpers - pure reads, safe for the UI
// ---------------------------------------------------------------------------

function highestWins(state: ReactionState): number {
  let top = 0;
  for (const w of state.wins) if (w > top) top = w;
  return top;
}

/** The match is decided once someone reaches the target or the rounds run out. */
export function isMatchOver(state: ReactionState): boolean {
  return state.round >= ROUNDS_TO_PLAY || highestWins(state) >= WINS_TO_TAKE_IT;
}

export function reactionPhase(state: ReactionState): ReactionPhase {
  if (isMatchOver(state)) return ReactionPhase.OVER;
  return state.greenAtMs > 0 ? ReactionPhase.LIVE : ReactionPhase.ARMING;
}

/**
 * Mean honest reaction time for a player, or null before their first honest tap.
 *
 * Computed on demand and never stored: this is the only division in the file and
 * keeping it out of the state is what lets the state stay integral.
 * Rounded to one decimal because it is a display value.
 */
export function averageReactionMs(state: ReactionState, player: PlayerId): number | null {
  const i = state.players.indexOf(player);
  if (i < 0) return null;
  const count = state.honestTaps[i] ?? 0;
  if (count <= 0) return null;
  const total = state.totalMs[i] ?? 0;
  return Math.round((total / count) * 10) / 10;
}

/** Was this reported time a false start - early, or faster than a human can be? */
export function isFalseStart(greenAtMs: number, atMs: number): boolean {
  return atMs - greenAtMs < MIN_HUMAN_REACTION_MS;
}

// ---------------------------------------------------------------------------
// Round resolution
// ---------------------------------------------------------------------------

function filled<T>(length: number, value: T): T[] {
  return new Array<T>(length).fill(value);
}

/**
 * Close the round out and fold it into the running totals.
 *
 * `walkover` is the index of a player who never had to tap because everyone else
 * false-started, or NOBODY when the round is decided on the reported times.
 */
function resolveRound(state: ReactionState, taps: readonly number[], walkover: number): ReactionState {
  const count = state.players.length;
  const reactions: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = taps[i] ?? NOT_TAPPED;
    reactions.push(at === NOT_TAPPED || isFalseStart(state.greenAtMs, at) ? NO_TIME : at - state.greenAtMs);
  }

  let winner = walkover;
  if (winner === NOBODY) {
    let bestTime = MAX_TAP_MS + 1;
    let tied = false;
    for (let i = 0; i < count; i++) {
      const r = reactions[i] as number;
      if (r === NO_TIME) continue;
      if (r < bestTime) {
        bestTime = r;
        winner = i;
        tied = false;
      } else if (r === bestTime) {
        // An exact draw on the reported millisecond. Nobody takes the round -
        // with self-reported times there is no honest way to break the tie.
        tied = true;
      }
    }
    if (tied) winner = NOBODY;
  }

  const wins = [...state.wins];
  const best = [...state.best];
  const totalMs = [...state.totalMs];
  const honestTaps = [...state.honestTaps];
  const falseStarts = [...state.falseStarts];

  for (let i = 0; i < count; i++) {
    const r = reactions[i] as number;
    if (r !== NO_TIME) {
      honestTaps[i] = (honestTaps[i] ?? 0) + 1;
      totalMs[i] = (totalMs[i] ?? 0) + r;
      const previous = best[i] ?? NO_TIME;
      best[i] = previous === NO_TIME || r < previous ? r : previous;
    } else if ((taps[i] ?? NOT_TAPPED) !== NOT_TAPPED) {
      falseStarts[i] = (falseStarts[i] ?? 0) + 1;
    }
  }
  if (winner >= 0) wins[winner] = (wins[winner] ?? 0) + 1;

  return {
    players: state.players,
    round: state.round + 1,
    ready: filled(count, false),
    greenAtMs: 0,
    taps: filled(count, NOT_TAPPED),
    wins,
    best,
    totalMs,
    honestTaps,
    falseStarts,
    lastWinner: winner,
    lastReactions: reactions,
  };
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

/**
 * Round a reported tap time for the wire and clamp it into 0..MAX_TAP_MS.
 *
 * Non-finite input is passed through untouched so `asInt` rejects it on the way
 * back in, rather than nonsense being quietly turned into a legal tap. Because
 * GameSession.submitLocal round-trips local actions through encode -> decode,
 * the clamp applies identically to our own taps and to a peer's.
 */
function wireTapMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Number.NaN;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  return rounded >= MAX_TAP_MS ? MAX_TAP_MS : rounded;
}

function decodePlayers(value: CborValue | undefined): PlayerId[] {
  const raw = asArray(value, 'reaction.players', MAX_PLAYERS);
  if (raw.length < 2) throw new GameDecodeError('reaction.players: need at least 2 players');
  return raw.map((p, i) => {
    if (typeof p !== 'string') throw new GameDecodeError(`reaction.players[${i}]: expected a string`);
    if (p.length === 0 || p.length > 64) throw new GameDecodeError(`reaction.players[${i}]: bad length`);
    return p;
  });
}

function decodeInts(
  value: CborValue | undefined,
  what: string,
  length: number,
  min: number,
  max: number,
): number[] {
  const raw = asArray(value, what, MAX_PLAYERS);
  if (raw.length !== length) throw new GameDecodeError(`${what}: expected ${length} entries`);
  return raw.map((n, i) => asInt(n, `${what}[${i}]`, min, max));
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export const reaction: GameDefinition<ReactionState, ReactionAction> = {
  id: 'reaction',
  name: 'Reaction',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: MAX_PLAYERS,

  createInitialState(setup: GameSetup): ReactionState {
    const count = setup.players.length;
    return {
      players: [...setup.players],
      round: 0,
      ready: filled(count, false),
      greenAtMs: 0,
      taps: filled(count, NOT_TAPPED),
      wins: filled(count, 0),
      best: filled(count, NO_TIME),
      totalMs: filled(count, 0),
      honestTaps: filled(count, 0),
      falseStarts: filled(count, 0),
      lastWinner: NO_ROUND_YET,
      lastReactions: filled(count, NO_TIME),
    };
  },

  /**
   * There is no seat order to violate here - a reflex duel is simultaneous by
   * definition, and demanding that player 1's tap arrive before player 2's would
   * make the game unplayable over a link with latency. What IS enforced, and
   * enforced identically for a local action and a peer's, is that a player acts
   * only in the phase where they owe an action, and only once:
   *
   *   - no tap before the round is armed (you cannot pre-load a 12 ms "win")
   *   - no second tap in a round, and no second ready
   *   - nothing at all once the match is decided
   *   - nothing from a player who is not in this game
   */
  validateAction(state, action): ValidationResult {
    if (isMatchOver(state)) return invalid('the match has already finished');

    const index = state.players.indexOf(action.player);
    if (index < 0) return invalid(`${String(action.player)} is not in this game`);

    switch (action.type) {
      case 'ready': {
        if (state.greenAtMs > 0) return invalid('the round is already running');
        if (state.ready[index] === true) return invalid('you are already ready');
        return VALID;
      }
      case 'tap': {
        if (state.greenAtMs === 0) return invalid('the round has not started yet');
        if (state.taps[index] !== NOT_TAPPED) return invalid('you have already tapped this round');
        const atMs = action.payload.atMs;
        if (!Number.isInteger(atMs) || atMs < 0 || atMs > MAX_TAP_MS) {
          return invalid(`atMs must be a whole number of milliseconds in 0-${MAX_TAP_MS}`);
        }
        return VALID;
      }
      default:
        return invalid(`unknown action "${String((action as GameAction).type)}"`);
    }
  },

  applyAction(state, action, context: GameContext): ReactionState {
    const index = state.players.indexOf(action.player);
    if (index < 0) return state; // unreachable: validateAction rejects it first

    if (action.type === 'ready') {
      const ready = [...state.ready];
      ready[index] = true;
      if (ready.some((r) => !r)) return { ...state, ready };
      // The action that completes the ready set draws the wait. This is the one
      // and only call into the shared PRNG, and it happens on an action every
      // device applies, in the same position in the log - so every device turns
      // green at the same offset. An integer, so there is nothing to diverge.
      const greenAtMs = MIN_WAIT_MS + context.random.nextInt(MAX_WAIT_MS - MIN_WAIT_MS + 1);
      return { ...state, ready, greenAtMs, taps: filled(state.players.length, NOT_TAPPED) };
    }

    const taps = [...state.taps];
    taps[index] = action.payload.atMs;

    // Who is still owed a report, and has anyone posted a credible time?
    let pending = 0;
    let onlyPending = NOBODY;
    let honest = 0;
    for (let i = 0; i < taps.length; i++) {
      const at = taps[i] as number;
      if (at === NOT_TAPPED) {
        pending += 1;
        onlyPending = i;
      } else if (!isFalseStart(state.greenAtMs, at)) {
        honest += 1;
      }
    }

    // Still racing: more than one player owes a tap, or the last one left could
    // still beat a time that has already been posted.
    if (pending > 1 || (pending === 1 && honest > 0)) return { ...state, taps };

    // pending === 1 here means everyone who reported false-started, so the last
    // player standing takes the round without having to tap at all.
    return resolveRound(state, taps, pending === 1 ? onlyPending : NOBODY);
  },

  status(state): GameStatus {
    if (!isMatchOver(state)) return { kind: GameStatusKind.IN_PROGRESS };
    const top = highestWins(state);
    if (top === 0) return { kind: GameStatusKind.DRAW, reason: 'no round was won' };
    const leaders = state.players.filter((_, i) => state.wins[i] === top);
    if (leaders.length !== 1) {
      return { kind: GameStatusKind.DRAW, reason: `tied on ${top} round wins` };
    }
    return {
      kind: GameStatusKind.WON,
      winners: [leaders[0] as PlayerId],
      reason: top >= WINS_TO_TAKE_IT ? `first to ${WINS_TO_TAKE_IT} rounds` : `most rounds won (${top})`,
    };
  },

  /**
   * The next player who still owes an action. Advisory only - a UI prompt and a
   * deterministic ordering for the headless drivers - never a gate: any player
   * who owes an action may send it at any moment, which is exactly what
   * `validateAction` allows and what a simultaneous reflex game requires.
   */
  currentTurn(state): PlayerId | null {
    if (isMatchOver(state)) return null;
    if (state.greenAtMs === 0) {
      const waiting = state.ready.findIndex((r) => !r);
      return waiting < 0 ? null : state.players[waiting] ?? null;
    }
    const untapped = state.taps.findIndex((t) => t === NOT_TAPPED);
    return untapped < 0 ? null : state.players[untapped] ?? null;
  },

  encodeState(state): CborValue {
    // Short keys, flat integer arrays: about 60 bytes for two players, well
    // inside a single ~180-byte Bluetooth packet.
    return {
      p: [...state.players],
      r: state.round,
      y: state.ready.map((r) => (r ? 1 : 0)),
      g: state.greenAtMs,
      t: [...state.taps],
      w: [...state.wins],
      b: [...state.best],
      s: [...state.totalMs],
      n: [...state.honestTaps],
      f: [...state.falseStarts],
      l: state.lastWinner,
      x: [...state.lastReactions],
    };
  },

  decodeState(value): ReactionState {
    const m = asMap(value, 'reaction.state');
    const players = decodePlayers(m.p);
    const count = players.length;

    const greenAtMs = asInt(m.g, 'reaction.greenAtMs', 0, MAX_WAIT_MS);
    if (greenAtMs !== 0 && greenAtMs < MIN_WAIT_MS) {
      throw new GameDecodeError('reaction.greenAtMs: an armed round waits at least MIN_WAIT_MS');
    }
    const lastWinner = asInt(m.l, 'reaction.lastWinner', NO_ROUND_YET, count - 1);

    return {
      players,
      round: asInt(m.r, 'reaction.round', 0, ROUNDS_TO_PLAY),
      ready: decodeInts(m.y, 'reaction.ready', count, 0, 1).map((v) => v === 1),
      greenAtMs,
      taps: decodeInts(m.t, 'reaction.taps', count, NOT_TAPPED, MAX_TAP_MS),
      wins: decodeInts(m.w, 'reaction.wins', count, 0, ROUNDS_TO_PLAY),
      best: decodeInts(m.b, 'reaction.best', count, NO_TIME, MAX_TAP_MS),
      totalMs: decodeInts(m.s, 'reaction.totalMs', count, 0, ROUNDS_TO_PLAY * MAX_TAP_MS),
      honestTaps: decodeInts(m.n, 'reaction.honestTaps', count, 0, ROUNDS_TO_PLAY),
      falseStarts: decodeInts(m.f, 'reaction.falseStarts', count, 0, ROUNDS_TO_PLAY),
      lastWinner,
      lastReactions: decodeInts(m.x, 'reaction.lastReactions', count, NO_TIME, MAX_TAP_MS),
    };
  },

  encodeAction(action): CborValue {
    if (action.type === 'ready') {
      // Nothing to say beyond "me, now": three bytes of payload on the wire.
      return encodeActionEnvelope({ ...action, payload: null });
    }
    return encodeActionEnvelope({
      ...action,
      payload: { a: wireTapMs((action.payload as { readonly atMs?: unknown } | null | undefined)?.atMs) },
    });
  },

  decodeAction(value, player): ReactionAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type === 'ready') {
      return { type: 'ready', player, seq: envelope.seq, payload: null };
    }
    if (envelope.type === 'tap') {
      const payload = asMap(envelope.payload, 'reaction.payload');
      return {
        type: 'tap',
        player,
        seq: envelope.seq,
        // Out-of-window claims are refused outright rather than clamped here:
        // the sender already clamped, so anything outside 0..MAX_TAP_MS was
        // built by hand and has no business being reduced.
        payload: { atMs: asInt(payload.a, 'reaction.tap.atMs', 0, MAX_TAP_MS) },
      };
    }
    throw new GameDecodeError(`reaction: unknown action "${envelope.type}"`);
  },
};
