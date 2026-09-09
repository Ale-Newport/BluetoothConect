/**
 * The six-digit pairing ceremony, modelled as an explicit state machine.
 *
 * WHEN IT IS USED. There is no camera, or nobody wants to hold two phones up to
 * each other. The handshake has already run and produced a code derived from its
 * transcript (see crypto/sas.ts): an attacker relaying the exchange necessarily
 * ends up with two different transcripts, so the two phones would show different
 * digits. Two humans reading them aloud is the entire defence.
 *
 * WHY A STATE MACHINE, EXPLICITLY. A pairing sheet that can hang is worse than
 * one that refuses. Both users must act, either may decline, either may walk
 * away, and the link may die mid-ceremony - so every one of those is a named
 * state with a defined transition, and a timeout guarantees that the sheet
 * always reaches a terminal state on its own:
 *
 *     awaiting-both ──local or remote confirm──▶ one-confirmed
 *           │                                        │
 *           │                                   both confirm
 *           ├──────── either declines ─────────▶ rejected
 *           └──────── timeout elapses ─────────▶ timed-out
 *                                                    ▼
 *                                             both-confirmed
 *
 * SINGLE USE, ONE HANDSHAKE. The three terminal states latch: no later message
 * and no later tap can move the machine out of them, so a code cannot be
 * "confirmed twice" or resurrected. Every wire message carries a binding value
 * computed from this handshake's code and the two identity keys, and a message
 * whose binding does not match is dropped rather than acted on. The real
 * guarantee is stronger than that field: these messages travel inside the AEAD
 * session, whose keys come from this handshake and no other, so a confirmation
 * recorded from a different exchange cannot even be decrypted. The binding is
 * the cheap, explicit check that makes that property visible - and testable -
 * without a session.
 *
 * RETRANSMISSION. The confirmation cannot use the session's reliable channel:
 * PeerSession deliberately refuses application traffic until pairing completes,
 * which is exactly the guarantee that makes this ceremony worth running. So the
 * exchange runs on the control channel and carries its own bounded retry. On a
 * Bluetooth link losing one packet in seven, a ceremony that gave up after one
 * try would strand the user in "waiting for Maria" forever.
 */
import { MessageType, TIMING } from '../protocol/constants.js';
import type { CborValue } from '../protocol/cbor.js';
import { hash256 } from '../crypto/primitives.js';
import { timingSafeEqual, utf8Encode } from '../util/bytes.js';
import { TypedEmitter } from '../util/emitter.js';
import type { Clock, TimerHandle } from '../util/time.js';
import { ADVERTISEMENT_KEY_LENGTH } from './advertisementTokens.js';

/**
 * The pairing exchange rides on the two identity-block message types. It is not
 * application traffic - it is the last step of establishing the session - so it
 * belongs with HELLO in the 0x10 range rather than in a feature's range.
 */
export const PAIRING_CONFIRM = MessageType.HELLO;
export const PAIRING_CONFIRM_ACK = MessageType.HELLO_ACK;

/** Length of the value that ties a confirmation to one handshake. */
export const PAIRING_BINDING_LENGTH = 16;

const BINDING_DOMAIN = utf8Encode('AirLink-v1-pairing-binding');

export const SasPairingState = {
  /** Neither user has decided yet. */
  AWAITING_BOTH: 'awaiting-both',
  /** Exactly one side has accepted; still waiting on the other. */
  ONE_CONFIRMED: 'one-confirmed',
  /** Both accepted. The friendship may be written. */
  BOTH_CONFIRMED: 'both-confirmed',
  /** Somebody said the digits did not match, or tapped no. */
  REJECTED: 'rejected',
  /** Nobody finished in time. Never leave the sheet spinning. */
  TIMED_OUT: 'timed-out',
} as const;
export type SasPairingState = (typeof SasPairingState)[keyof typeof SasPairingState];

export const PairingDecision = { ACCEPT: 'accept', DECLINE: 'decline' } as const;
export type PairingDecision = (typeof PairingDecision)[keyof typeof PairingDecision];

function isTerminalState(state: SasPairingState): boolean {
  return (
    state === SasPairingState.BOTH_CONFIRMED ||
    state === SasPairingState.REJECTED ||
    state === SasPairingState.TIMED_OUT
  );
}

/**
 * The value both peers put in every confirmation message.
 *
 * Derived from the six-digit code (unique to this handshake's transcript) and
 * both identity keys in a canonical order, so the two sides compute the same
 * bytes without exchanging anything, and a confirmation meant for a different
 * pair or a different handshake is visibly foreign.
 */
export function pairingBinding(sasCode: string, identityA: Uint8Array, identityB: Uint8Array): Uint8Array {
  const [first, second] = compareBytes(identityA, identityB) <= 0 ? [identityA, identityB] : [identityB, identityA];
  return hash256(BINDING_DOMAIN, first, second, utf8Encode(sasCode)).slice(0, PAIRING_BINDING_LENGTH);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}

export interface SasPairingEvents {
  stateChanged: { readonly state: SasPairingState; readonly previous: SasPairingState };
  /** Fired once, when the machine first reaches a terminal state. */
  settled: { readonly state: SasPairingState };
}

export interface SasPairingOptions {
  readonly clock: Clock;
  /** The six digits from THIS handshake, already derived by the session. */
  readonly sasCode: string;
  /** Our own long-term identity key. */
  readonly localIdentityKey: Uint8Array;
  /** The peer's, as proven by the handshake. */
  readonly remoteIdentityKey: Uint8Array;
  /** Ships one control-channel message. Wired to PeerSession.sendControl. */
  readonly send: (messageType: number, value: CborValue) => void;
  /**
   * The advertisement key we want this friend to recognise us by. Piggybacked on
   * the confirmation because a friendship is exactly the moment it becomes
   * meaningful, and a Bluetooth round trip is too expensive to spend on a
   * separate message.
   */
  readonly localAdvertisementKey?: Uint8Array;
  /** Defaults to TIMING.pairingTimeoutMs. */
  readonly timeoutMs?: number;
  readonly resendIntervalMs?: number;
  /** Bound on retries, so a peer that never answers costs a fixed amount. */
  readonly maxResends?: number;
}

const DEFAULT_RESEND_INTERVAL_MS = 700;
const DEFAULT_MAX_RESENDS = 24;

/**
 * Smallest number of acknowledgements we will ever emit, whatever the retry
 * settings. Comfortably more than a well-behaved peer needs.
 */
const MIN_ACK_BUDGET = 16;

/**
 * How many times a link change may top the retry budget back up.
 *
 * A migration is a local event - our transport manager decided to move - but it
 * can be provoked by a peer who keeps offering upgrades, so the number of times
 * it can buy fresh retransmissions is bounded rather than open ended.
 */
const MAX_RETRANSMISSION_RESUMES = 8;

/**
 * One pairing ceremony. Create it when the handshake completes, dispose it when
 * the session goes away.
 */
export class SasPairing {
  readonly events = new TypedEmitter<SasPairingEvents>();

  private state: SasPairingState = SasPairingState.AWAITING_BOTH;
  private local: PairingDecision | null = null;
  private remote: PairingDecision | null = null;
  private remoteKey: Uint8Array | null = null;
  private localAcknowledged = false;
  private settledEmitted = false;
  private disposed = false;

  private resendTimer: TimerHandle | undefined;
  private timeoutTimer: TimerHandle | undefined;
  private resendsLeft: number;
  /**
   * How many more acknowledgements this ceremony will emit.
   *
   * We answer every confirmation we receive, including repeats, because our
   * previous answer may have been the packet that was lost. That reply is
   * driven entirely by the peer, so without a ceiling an authenticated peer
   * could make this phone transmit forever by looping one message - which on a
   * radio is somebody else's battery. The budget is set from the retry limit,
   * so it is always well above what a genuinely lossy peer needs.
   */
  private ackBudget: number;
  private readonly initialAckBudget: number;
  private resumesLeft = MAX_RETRANSMISSION_RESUMES;

  private readonly binding: Uint8Array;

  /** Messages dropped because they did not belong to this ceremony. Developer Mode. */
  foreignMessages = 0;
  /** Messages dropped because a field was missing, mistyped or out of range. */
  malformedMessages = 0;
  /** Acknowledgements withheld because the peer had exhausted its budget. */
  suppressedAcks = 0;

  constructor(private readonly options: SasPairingOptions) {
    if (options.localAdvertisementKey && options.localAdvertisementKey.length !== ADVERTISEMENT_KEY_LENGTH) {
      throw new Error('SasPairing: advertisement key must be 32 bytes');
    }
    this.binding = pairingBinding(options.sasCode, options.localIdentityKey, options.remoteIdentityKey);
    const maxResends = options.maxResends ?? DEFAULT_MAX_RESENDS;
    this.resendsLeft = maxResends;
    this.initialAckBudget = Math.max(MIN_ACK_BUDGET, (Math.max(0, maxResends) + 1) * 2);
    this.ackBudget = this.initialAckBudget;
    const timeoutMs = options.timeoutMs ?? TIMING.pairingTimeoutMs;
    this.timeoutTimer = options.clock.setTimeout(() => {
      this.timeoutTimer = undefined;
      // The timeout's second job is to stop a retransmission the peer is never
      // going to acknowledge, which is why it runs even in a terminal state.
      this.stopResending();
      if (!isTerminalState(this.state)) this.moveTo(SasPairingState.TIMED_OUT);
    }, timeoutMs);
  }

  // -- inspection ------------------------------------------------------------

  get current(): SasPairingState {
    return this.state;
  }

  get code(): string {
    return this.options.sasCode;
  }

  get localDecision(): PairingDecision | null {
    return this.local;
  }

  get remoteDecision(): PairingDecision | null {
    return this.remote;
  }

  /** The key this friend's advertisement tokens will be computed from. */
  get remoteAdvertisementKey(): Uint8Array | null {
    return this.remoteKey;
  }

  get isTerminal(): boolean {
    return isTerminalState(this.state);
  }

  /** True once the peer has acknowledged our decision, so we can stop repeating it. */
  get isAcknowledged(): boolean {
    return this.localAcknowledged;
  }

  /** Acknowledgements this ceremony will still emit. Developer Mode. */
  get acknowledgementsLeft(): number {
    return this.ackBudget;
  }

  // -- user actions ----------------------------------------------------------

  /** The user says the digits match. Idempotent; ignored once terminal. */
  confirm(): void {
    this.decide(PairingDecision.ACCEPT);
  }

  /** The user says they do not, or taps cancel. Idempotent; ignored once terminal. */
  decline(): void {
    this.decide(PairingDecision.DECLINE);
  }

  private decide(decision: PairingDecision): void {
    if (this.disposed) return;
    // Terminal states latch: this is what makes a code single-use.
    if (isTerminalState(this.state)) return;
    if (this.local !== null) return;
    this.local = decision;
    this.sendDecision();
    this.startResending();
    this.recompute();
  }

  // -- wire ------------------------------------------------------------------

  /**
   * Feed one control-channel message from the peer. Returns true when the
   * message was accepted; false means it was dropped, which is never fatal.
   *
   * Every field is validated: the payload came from a peer whose identity is
   * proven but whose intentions are not.
   */
  handlePeerMessage(messageType: number, value: CborValue | null): boolean {
    if (this.disposed) return false;
    if (messageType !== PAIRING_CONFIRM && messageType !== PAIRING_CONFIRM_ACK) return false;
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
      this.malformedMessages++;
      return false;
    }
    const m = value as Record<string, CborValue>;

    const binding = m.b;
    if (!(binding instanceof Uint8Array) || binding.length !== PAIRING_BINDING_LENGTH) {
      this.malformedMessages++;
      return false;
    }
    if (!timingSafeEqual(binding, this.binding)) {
      // A confirmation from some other handshake or some other pair.
      this.foreignMessages++;
      return false;
    }

    if (messageType === PAIRING_CONFIRM_ACK) {
      // An acknowledgement for a decision we have not made cannot be honest: the
      // peer only ever sends one in reply to our confirmation. Honouring it
      // anyway would silently disable the retransmission BEFORE it has sent
      // anything, so the one confirmation we do send later would be the only
      // one - and on a radio that loses a packet in seven, that is a pairing
      // sheet that hangs until the timeout.
      if (this.local === null) {
        this.foreignMessages++;
        return false;
      }
      this.localAcknowledged = true;
      this.stopResending();
      this.maybeStopTimeout();
      return true;
    }

    const accepted = m.a;
    if (typeof accepted !== 'boolean') {
      this.malformedMessages++;
      return false;
    }

    const key = m.k;
    if (key !== undefined) {
      if (!(key instanceof Uint8Array) || key.length !== ADVERTISEMENT_KEY_LENGTH) {
        this.malformedMessages++;
        return false;
      }
    }

    // Acknowledge even a repeat, and even once terminal: our previous ACK may
    // have been the packet that was lost, and the peer is still repeating.
    this.options.send(PAIRING_CONFIRM_ACK, { b: this.binding });

    if (isTerminalState(this.state)) return true;
    // First decision wins. A peer that says yes and then no is either buggy or
    // hostile; either way the ceremony is already decided.
    if (this.remote !== null) return true;

    this.remote = accepted ? PairingDecision.ACCEPT : PairingDecision.DECLINE;
    if (key instanceof Uint8Array) this.remoteKey = key.slice();
    this.recompute();
    return true;
  }

  // -- internals -------------------------------------------------------------

  private sendDecision(): void {
    const advertisementKey = this.options.localAdvertisementKey;
    this.options.send(PAIRING_CONFIRM, {
      b: this.binding,
      a: this.local === PairingDecision.ACCEPT,
      ...(advertisementKey ? { k: advertisementKey } : {}),
    });
  }

  private startResending(): void {
    if (this.resendTimer !== undefined || this.localAcknowledged) return;
    const interval = this.options.resendIntervalMs ?? DEFAULT_RESEND_INTERVAL_MS;
    this.resendTimer = this.options.clock.setInterval(() => {
      if (this.localAcknowledged || this.local === null || this.resendsLeft <= 0) {
        this.stopResending();
        this.maybeStopTimeout();
        return;
      }
      this.resendsLeft--;
      this.sendDecision();
    }, interval);
  }

  private stopResending(): void {
    if (this.resendTimer === undefined) return;
    this.options.clock.clearInterval(this.resendTimer);
    this.resendTimer = undefined;
  }

  /** Once nothing is outstanding, the timeout has no work left to do. */
  private maybeStopTimeout(): void {
    if (!isTerminalState(this.state) || !this.localAcknowledged) return;
    if (this.timeoutTimer === undefined) return;
    this.options.clock.clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }

  private recompute(): void {
    if (isTerminalState(this.state)) return;
    if (this.local === PairingDecision.DECLINE || this.remote === PairingDecision.DECLINE) {
      this.moveTo(SasPairingState.REJECTED);
      return;
    }
    if (this.local === PairingDecision.ACCEPT && this.remote === PairingDecision.ACCEPT) {
      this.moveTo(SasPairingState.BOTH_CONFIRMED);
      return;
    }
    if (this.local !== null || this.remote !== null) this.moveTo(SasPairingState.ONE_CONFIRMED);
  }

  private moveTo(next: SasPairingState): void {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    this.events.emit('stateChanged', { state: next, previous });
    if (isTerminalState(next) && !this.settledEmitted) {
      this.settledEmitted = true;
      this.maybeStopTimeout();
      this.events.emit('settled', { state: next });
    }
  }

  /** Release timers. Safe to call twice; the machine is inert afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopResending();
    if (this.timeoutTimer !== undefined) {
      this.options.clock.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    this.events.removeAllListeners();
  }
}
