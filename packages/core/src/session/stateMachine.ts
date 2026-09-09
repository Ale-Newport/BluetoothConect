/**
 * The connection state machine.
 *
 * Every illegal transition is rejected rather than silently applied, which is
 * what stops the UI from ever showing a stuck "Connecting..." spinner: the
 * machine always has exactly one well-defined state, every state that can hang
 * carries a timeout, and every terminal state has a route back out.
 */
import { TypedEmitter } from '../util/emitter.js';
import type { Clock, TimerHandle } from '../util/time.js';

export const ConnectionState = {
  /** No link, not looking. */
  DISCONNECTED: 'disconnected',
  /** Actively scanning for peers. */
  DISCOVERING: 'discovering',
  /** This peer has been seen nearby but nothing has been attempted. */
  DISCOVERED: 'discovered',
  /** First meeting: exchanging identities and waiting on user confirmation. */
  PAIRING: 'pairing',
  /** A transport link is being opened. */
  CONNECTING: 'connecting',
  /** Link is up; running the cryptographic handshake. */
  AUTHENTICATING: 'authenticating',
  /** Authenticated; choosing the best transport both sides support. */
  NEGOTIATING_TRANSPORT: 'negotiatingTransport',
  /** Fully usable: encrypted, authenticated, transport chosen. */
  CONNECTED: 'connected',
  /** Link dropped; retrying with backoff. Session keys are retained. */
  RECONNECTING: 'reconnecting',
  /** Gave up. Carries a reason. The user can retry from here. */
  FAILED: 'failed',
} as const;
export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];

/**
 * Legal transitions. Anything absent here is a bug, and is reported as one
 * rather than corrupting the session.
 */
const TRANSITIONS: Record<ConnectionState, readonly ConnectionState[]> = {
  [ConnectionState.DISCONNECTED]: [ConnectionState.DISCOVERING, ConnectionState.CONNECTING, ConnectionState.FAILED],
  [ConnectionState.DISCOVERING]: [
    ConnectionState.DISCOVERED,
    ConnectionState.DISCONNECTED,
    ConnectionState.CONNECTING,
    ConnectionState.FAILED,
  ],
  [ConnectionState.DISCOVERED]: [
    ConnectionState.CONNECTING,
    ConnectionState.DISCOVERING,
    ConnectionState.DISCONNECTED,
    ConnectionState.FAILED,
  ],
  [ConnectionState.CONNECTING]: [
    ConnectionState.AUTHENTICATING,
    ConnectionState.RECONNECTING,
    ConnectionState.DISCONNECTED,
    ConnectionState.FAILED,
  ],
  [ConnectionState.AUTHENTICATING]: [
    ConnectionState.PAIRING,
    ConnectionState.NEGOTIATING_TRANSPORT,
    ConnectionState.CONNECTED,
    ConnectionState.RECONNECTING,
    ConnectionState.DISCONNECTED,
    ConnectionState.FAILED,
  ],
  [ConnectionState.PAIRING]: [
    ConnectionState.NEGOTIATING_TRANSPORT,
    ConnectionState.CONNECTED,
    ConnectionState.DISCONNECTED,
    ConnectionState.FAILED,
  ],
  [ConnectionState.NEGOTIATING_TRANSPORT]: [
    ConnectionState.CONNECTED,
    ConnectionState.RECONNECTING,
    ConnectionState.DISCONNECTED,
    ConnectionState.FAILED,
  ],
  [ConnectionState.CONNECTED]: [
    ConnectionState.RECONNECTING,
    ConnectionState.NEGOTIATING_TRANSPORT,
    ConnectionState.DISCONNECTED,
    ConnectionState.FAILED,
  ],
  [ConnectionState.RECONNECTING]: [
    ConnectionState.CONNECTING,
    ConnectionState.AUTHENTICATING,
    ConnectionState.CONNECTED,
    ConnectionState.DISCONNECTED,
    ConnectionState.FAILED,
  ],
  [ConnectionState.FAILED]: [ConnectionState.DISCOVERING, ConnectionState.CONNECTING, ConnectionState.DISCONNECTED],
};

/**
 * States that must not last forever. Each carries the timeout after which the
 * machine moves itself on, so the interface can never lock up.
 */
const STATE_TIMEOUTS: Partial<Record<ConnectionState, { ms: number; onTimeout: ConnectionState }>> = {
  [ConnectionState.CONNECTING]: { ms: 20_000, onTimeout: ConnectionState.FAILED },
  [ConnectionState.AUTHENTICATING]: { ms: 15_000, onTimeout: ConnectionState.FAILED },
  [ConnectionState.NEGOTIATING_TRANSPORT]: { ms: 10_000, onTimeout: ConnectionState.CONNECTED },
  [ConnectionState.PAIRING]: { ms: 120_000, onTimeout: ConnectionState.FAILED },
};

export interface StateChange {
  readonly from: ConnectionState;
  readonly to: ConnectionState;
  readonly reason?: string;
  readonly at: number;
}

export interface ConnectionStateEvents {
  change: StateChange;
  /** An illegal transition was attempted. Always a bug; surfaced, never hidden. */
  illegalTransition: { readonly from: ConnectionState; readonly to: ConnectionState };
  timeout: { readonly state: ConnectionState };
}

export class ConnectionStateMachine {
  readonly events = new TypedEmitter<ConnectionStateEvents>();
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private timer: TimerHandle | undefined;
  private lastReason: string | undefined;
  private readonly history: StateChange[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly historyLimit = 50,
  ) {}

  get current(): ConnectionState {
    return this.state;
  }

  get reason(): string | undefined {
    return this.lastReason;
  }

  /** Recent transitions, newest last. Rendered by Developer Mode. */
  get recentHistory(): readonly StateChange[] {
    return [...this.history];
  }

  canTransitionTo(next: ConnectionState): boolean {
    return next === this.state || (TRANSITIONS[this.state] ?? []).includes(next);
  }

  /**
   * Attempt a transition. Returns false (and emits `illegalTransition`) when the
   * move is not permitted, so a race between the UI and the radio degrades into
   * an ignored request rather than an inconsistent state.
   */
  transitionTo(next: ConnectionState, reason?: string): boolean {
    if (next === this.state) {
      if (reason !== undefined) this.lastReason = reason;
      return true;
    }
    if (!this.canTransitionTo(next)) {
      this.events.emit('illegalTransition', { from: this.state, to: next });
      return false;
    }
    const change: StateChange = {
      from: this.state,
      to: next,
      at: this.clock.now(),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.state = next;
    this.lastReason = reason;
    this.history.push(change);
    if (this.history.length > this.historyLimit) this.history.shift();

    this.armTimeout();
    this.events.emit('change', change);
    return true;
  }

  private armTimeout(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const spec = STATE_TIMEOUTS[this.state];
    if (!spec) return;
    const stateWhenArmed = this.state;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (this.state !== stateWhenArmed) return;
      this.events.emit('timeout', { state: stateWhenArmed });
      this.transitionTo(spec.onTimeout, `timed out in ${stateWhenArmed}`);
    }, spec.ms);
  }

  /** True once the session can carry application traffic. */
  get isUsable(): boolean {
    return this.state === ConnectionState.CONNECTED || this.state === ConnectionState.NEGOTIATING_TRANSPORT;
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.events.removeAllListeners();
  }
}

/**
 * Reconnect backoff with full jitter. Jitter matters: without it, two phones
 * that lose each other retry in lockstep and collide on the radio every time.
 */
export class ReconnectPolicy {
  private attempt = 0;

  constructor(
    private readonly schedule: readonly number[],
    private readonly random: () => number,
  ) {}

  nextDelayMs(): number {
    const base = this.schedule[Math.min(this.attempt, this.schedule.length - 1)] ?? 30_000;
    this.attempt += 1;
    // Full jitter: uniform in [base/2, base].
    return Math.round(base / 2 + this.random() * (base / 2));
  }

  get attempts(): number {
    return this.attempt;
  }

  get exhausted(): boolean {
    return this.attempt > this.schedule.length * 2;
  }

  reset(): void {
    this.attempt = 0;
  }
}
