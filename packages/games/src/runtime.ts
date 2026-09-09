/**
 * Turning a pure game reducer into a synchronised multiplayer session.
 *
 * Two very different synchronisation models sit behind one interface:
 *
 *  TURN-BASED (chess, Connect Four, Battleship, trivia, word games)
 *    Only ACTIONS travel. Every device replays the same ordered action log
 *    through the same reducer and therefore holds the same state. Bandwidth is
 *    a few dozen bytes per move, which is nothing even over Bluetooth, and a
 *    reconnecting player catches up by replaying the log.
 *
 *  REALTIME (Pong, Air Hockey, Pool)
 *    The host runs the authoritative simulation at a fixed tick rate and ships
 *    periodic state SNAPSHOTS. Guests send only their INPUT and render an
 *    interpolated view of the last two snapshots, so a snapshot arriving late
 *    shows as smooth motion rather than a jump. Nothing graphical is ever
 *    transmitted; each device draws its own frames.
 *
 * Host migration is deliberately possible but not automatic: every guest holds
 * a full recent state, so promoting one to host is a matter of policy rather
 * than of missing data.
 */
import type { CborValue } from '@airlink/core';
import {
  GameMode,
  GameStatusKind,
  SeededGameRandom,
  createContext,
  type GameAction,
  type GameContext,
  type GameDefinition,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from './engine.js';

export interface GameSessionOptions<TState, TAction extends GameAction> {
  readonly definition: GameDefinition<TState, TAction>;
  readonly setup: GameSetup;
  readonly localPlayer: PlayerId;
  /** Index 0 of `setup.players` hosts. */
  readonly isHost: boolean;
  /** Retain this many past actions so a reconnecting peer can replay. */
  readonly historyLimit?: number;
}

export interface AppliedAction<TAction> {
  readonly action: TAction;
  readonly index: number;
}

export const RejectionReason = {
  INVALID: 'invalid',
  DUPLICATE: 'duplicate',
  OUT_OF_ORDER: 'outOfOrder',
  GAME_OVER: 'gameOver',
  NOT_A_PLAYER: 'notAPlayer',
} as const;
export type RejectionReason = (typeof RejectionReason)[keyof typeof RejectionReason];

export type ActionOutcome<TAction> =
  | { readonly accepted: true; readonly applied: AppliedAction<TAction> }
  | { readonly accepted: false; readonly reason: RejectionReason; readonly detail: string };

/**
 * One player's view of one game. Identical code runs on host and guest; only
 * the `isHost` flag changes behaviour, and only for realtime games.
 */
export class GameSession<TState, TAction extends GameAction = GameAction> {
  private state: TState;
  private readonly log: TAction[] = [];
  private readonly nextSeqByPlayer = new Map<PlayerId, number>();
  private localSeq = 0;
  private elapsedMs = 0;
  /** Sub-step time carried between tick() calls. See tick(). */
  private tickRemainder = 0;
  private readonly historyLimit: number;
  private readonly random: SeededGameRandom;

  constructor(private readonly options: GameSessionOptions<TState, TAction>) {
    const { definition, setup } = options;
    if (setup.players.length < definition.minPlayers || setup.players.length > definition.maxPlayers) {
      throw new Error(
        `${definition.id} supports ${definition.minPlayers}-${definition.maxPlayers} players, got ${setup.players.length}`,
      );
    }
    if (!setup.players.includes(options.localPlayer)) {
      throw new Error('GameSession: local player is not in the player list');
    }
    this.historyLimit = options.historyLimit ?? 512;
    this.random = new SeededGameRandom(setup.seed);
    this.state = definition.createInitialState(setup);
    for (const p of setup.players) this.nextSeqByPlayer.set(p, 0);
  }

  get definition(): GameDefinition<TState, TAction> {
    return this.options.definition;
  }

  get currentState(): TState {
    return this.state;
  }

  get status(): GameStatus {
    return this.options.definition.status(this.state);
  }

  get isOver(): boolean {
    return this.status.kind !== GameStatusKind.IN_PROGRESS;
  }

  get turn(): PlayerId | null {
    return this.options.definition.currentTurn?.(this.state) ?? null;
  }

  get isLocalTurn(): boolean {
    const t = this.turn;
    return t === null ? false : t === this.options.localPlayer;
  }

  get actionCount(): number {
    return this.log.length;
  }

  get simulatedMs(): number {
    return this.elapsedMs;
  }

  private context(tickMs = 0): GameContext {
    return {
      players: this.options.setup.players,
      random: this.random,
      elapsedMs: this.elapsedMs,
      tickMs,
    };
  }

  /**
   * Submit an action from the local player.
   *
   * The action is deliberately pushed through encodeAction -> decodeAction
   * before being applied, so a local move travels EXACTLY the path a remote one
   * does. That makes two whole classes of bug impossible to ship: an encoder
   * that loses a field, and a validator that is stricter for peers than for
   * ourselves. It costs one round trip through CBOR per move, which is nothing.
   *
   * `payload` is the game's own payload shape, not the wire shape.
   */
  submitLocal(type: string, payload: CborValue): ActionOutcome<TAction> {
    const draft = {
      type,
      player: this.options.localPlayer,
      seq: this.localSeq,
      payload,
    } as unknown as TAction;

    let action: TAction;
    try {
      action = this.options.definition.decodeAction(
        this.options.definition.encodeAction(draft),
        this.options.localPlayer,
      );
    } catch (err) {
      return {
        accepted: false,
        reason: RejectionReason.INVALID,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const outcome = this.applyInternal(action);
    if (outcome.accepted) this.localSeq += 1;
    return outcome;
  }

  /**
   * Apply an action received from a peer.
   *
   * `player` comes from the authenticated session, NOT from the packet, so a
   * peer cannot play on someone else's behalf.
   */
  applyRemote(value: CborValue, player: PlayerId): ActionOutcome<TAction> {
    if (!this.options.setup.players.includes(player)) {
      return { accepted: false, reason: RejectionReason.NOT_A_PLAYER, detail: `${player} is not in this game` };
    }
    let action: TAction;
    try {
      action = this.options.definition.decodeAction(value, player);
    } catch (err) {
      return {
        accepted: false,
        reason: RejectionReason.INVALID,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (action.player !== player) {
      return { accepted: false, reason: RejectionReason.NOT_A_PLAYER, detail: 'action player mismatch' };
    }
    return this.applyInternal(action);
  }

  private applyInternal(action: TAction): ActionOutcome<TAction> {
    if (this.isOver) {
      return { accepted: false, reason: RejectionReason.GAME_OVER, detail: 'the game has already finished' };
    }

    // Per-player sequence numbers give exactly-once semantics even if the
    // reliability layer re-delivers after a reconnect.
    const expected = this.nextSeqByPlayer.get(action.player) ?? 0;
    if (action.seq < expected) {
      return { accepted: false, reason: RejectionReason.DUPLICATE, detail: `seq ${action.seq} already applied` };
    }
    if (action.seq > expected) {
      return {
        accepted: false,
        reason: RejectionReason.OUT_OF_ORDER,
        detail: `expected seq ${expected}, got ${action.seq}`,
      };
    }

    const context = this.context();
    const validation: ValidationResult = this.options.definition.validateAction(this.state, action, context);
    if (!validation.ok) {
      return { accepted: false, reason: RejectionReason.INVALID, detail: validation.reason };
    }

    this.state = this.options.definition.applyAction(this.state, action, context);
    this.nextSeqByPlayer.set(action.player, expected + 1);
    this.log.push(action);
    if (this.log.length > this.historyLimit) this.log.shift();
    return { accepted: true, applied: { action, index: this.log.length - 1 } };
  }

  /**
   * Advance a realtime simulation. Only the host's result is authoritative;
   * a guest ticks too, purely to predict locally between snapshots.
   *
   * FIXED TIMESTEP WITH AN ACCUMULATOR. The simulation only ever advances in
   * whole steps of 1/tickRate, because a variable step would make the physics
   * non-deterministic and the two devices would drift apart. Time left over
   * from one call is CARRIED FORWARD rather than discarded: a frame that
   * delivers 16.6ms when a step is 16.667ms would otherwise silently drop that
   * step, so the simulation would run slow, and - far worse - two devices with
   * slightly different frame pacing would accumulate different amounts of
   * discarded time and diverge.
   */
  tick(deltaMs: number): void {
    const def = this.options.definition;
    if (def.mode !== GameMode.REALTIME || !def.tick) return;
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;

    const step = 1000 / (def.tickRate ?? 60);
    this.tickRemainder += deltaMs;

    // After a long pause - the app was backgrounded, the phone was locked -
    // there may be minutes of time to make up. Simulating all of it would lock
    // the UI, so we cap the catch-up and drop the rest. The host's next
    // snapshot corrects any resulting difference.
    const maxSteps = 600;
    let steps = Math.floor(this.tickRemainder / step);
    if (steps > maxSteps) {
      steps = maxSteps;
      this.tickRemainder = 0;
    } else {
      this.tickRemainder -= steps * step;
    }

    for (let i = 0; i < steps; i++) {
      this.elapsedMs += step;
      this.state = def.tick(this.state, this.context(step));
    }
  }

  /** Serialise the whole state, for a snapshot or for persistence. */
  snapshot(): CborValue {
    return this.options.definition.encodeState(this.state);
  }

  /**
   * Adopt an authoritative snapshot from the host. Guests call this; the host
   * ignores it, since it cannot be corrected by its own guests.
   */
  applySnapshot(value: CborValue): boolean {
    if (this.options.isHost) return false;
    try {
      this.state = this.options.definition.decodeState(value);
      return true;
    } catch {
      return false;
    }
  }

  /** Encode an action for transmission. */
  encode(action: TAction): CborValue {
    return this.options.definition.encodeAction(action);
  }

  /** The retained action log, for catching a reconnecting peer up. */
  history(): readonly TAction[] {
    return this.log;
  }

  /**
   * Replay an action log onto a fresh state. Used when a peer rejoins and its
   * history has diverged - deterministic replay converges both devices without
   * shipping the whole state.
   */
  static replay<S, A extends GameAction>(
    definition: GameDefinition<S, A>,
    setup: GameSetup,
    actions: readonly A[],
  ): S {
    let state = definition.createInitialState(setup);
    const random = new SeededGameRandom(setup.seed);
    for (const action of actions) {
      const context: GameContext = { players: setup.players, random, elapsedMs: 0, tickMs: 0 };
      if (!definition.validateAction(state, action, context).ok) break;
      state = definition.applyAction(state, action, context);
    }
    return state;
  }

  /** Merge a divergent state. Defaults to trusting the host. */
  reconcile(remoteState: CborValue, remoteIsHost: boolean): void {
    const def = this.options.definition;
    if (def.resolveConflict) {
      const remote = def.decodeState(remoteState);
      this.state = def.resolveConflict(this.state, remote, this.options.isHost);
      return;
    }
    if (remoteIsHost && !this.options.isHost) this.state = def.decodeState(remoteState);
  }
}

// ---------------------------------------------------------------------------
// Snapshot interpolation for realtime guests
// ---------------------------------------------------------------------------

export interface TimedSnapshot<T> {
  readonly at: number;
  readonly value: T;
}

/**
 * Holds the last two authoritative snapshots and renders a point between them.
 *
 * Rendering slightly in the past (by `delayMs`) is what makes motion look
 * smooth: it guarantees there is always a newer snapshot to interpolate toward,
 * so a late packet costs a few milliseconds of lag instead of a visible jump.
 */
export class SnapshotInterpolator<T> {
  private previous: TimedSnapshot<T> | null = null;
  private latest: TimedSnapshot<T> | null = null;

  constructor(
    private readonly lerp: (from: T, to: T, t: number) => T,
    /** How far behind the newest snapshot to render. One snapshot interval is typical. */
    private readonly delayMs = 100,
  ) {}

  push(value: T, at: number): void {
    if (this.latest && at <= this.latest.at) return; // stale or duplicate
    this.previous = this.latest;
    this.latest = { at, value };
  }

  /** The state to draw right now, or null before the first snapshot. */
  sample(now: number): T | null {
    if (!this.latest) return null;
    if (!this.previous) return this.latest.value;
    const target = now - this.delayMs;
    const span = this.latest.at - this.previous.at;
    if (span <= 0) return this.latest.value;
    const t = (target - this.previous.at) / span;
    if (t <= 0) return this.previous.value;
    if (t >= 1) return this.latest.value;
    return this.lerp(this.previous.value, this.latest.value, t);
  }

  get hasData(): boolean {
    return this.latest !== null;
  }

  reset(): void {
    this.previous = null;
    this.latest = null;
  }
}

export { createContext };
