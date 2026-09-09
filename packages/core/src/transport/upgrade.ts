/**
 * Transport upgrade and downgrade.
 *
 * A session starts on whatever connected first. Between an iPhone and an
 * Android that is always BLE, because BLE is the only thing they both have -
 * and BLE moves about 20 KB/s. If both phones then turn out to be on the same
 * cafe Wi-Fi, or both are iPhones with AWDL available, there is a pipe two
 * orders of magnitude faster sitting there unused. This controller finds it and
 * moves the conversation onto it, without the conversation noticing.
 *
 * The whole design exists to satisfy one requirement: THE USER MUST NEVER LOSE
 * A CONVERSATION TO A FAILED UPGRADE. Everything below follows from it.
 *
 *  - One side initiates, chosen by comparing peer ids. Two phones that both
 *    dial out would open two links and race for the same session.
 *  - The new link is PROVEN before the old one is released. We send a probe
 *    over it and require the matching response; the probe token is derived from
 *    a nonce that travelled inside the encrypted session, so only the real peer
 *    can answer it. Until that round trip completes, the old link is untouched
 *    and every message still flows over it.
 *  - Every step has a timeout. A peer that goes silent mid-negotiation costs us
 *    a few seconds and a log line, never a stuck session.
 *  - A failure at any point closes the new link and leaves the session exactly
 *    where it was. The failure is also reported to the peer, so it does not sit
 *    waiting for a timeout it could have skipped.
 *  - The reverse case matters just as much: when the fast link dies - somebody
 *    walks out of Wi-Fi range - the session does not end. It falls back to the
 *    floor transport and carries on, keys and queued messages intact.
 *
 * Negotiation messages ride the RELIABLE channel of the existing session rather
 * than the CONTROL channel: they are few, small, and must arrive. The
 * reliability layer already retransmits and orders them across a lossy BLE
 * link, and reimplementing that here would be a second, worse copy.
 */
import { MessageType, TIMING } from '../protocol/constants.js';
import { TransportKind, isTransportKind } from '../protocol/capabilities.js';
import type { CborValue } from '../protocol/cbor.js';
import { hash256 } from '../crypto/primitives.js';
import type { RandomSource } from '../crypto/random.js';
import { bytesEqual, timingSafeEqual, toHex, utf8Encode } from '../util/bytes.js';
import { TypedEmitter, type Unsubscribe } from '../util/emitter.js';
import type { Clock, TimerHandle } from '../util/time.js';
import { silentLogger, type Logger } from '../util/logger.js';
import { ConnectionState } from '../session/stateMachine.js';
import type { IncomingMessage, PeerSession } from '../session/peerSession.js';
import { LinkState, type Link, type TransportProfile } from './types.js';
import type { TransportCapabilityManager } from './capabilityManager.js';
import { defaultProfileFor, negotiateTransports, type TransportCandidate } from './negotiation.js';
import {
  ConnectionQuality,
  ConnectionQualityTracker,
  connectionQualityFromLink,
} from './quality.js';

// ---------------------------------------------------------------------------
// The probe: a tiny protocol that lives on the bare link, below the session
// ---------------------------------------------------------------------------

/**
 * "ALUP". The probe travels on a link that has no session attached, so it needs
 * its own recognisable shape. The first byte is 0x41, which is not a protocol
 * version this build emits, so a probe can never be mistaken for - or mistaken
 * as - an AirLink frame.
 */
const PROBE_MAGIC = Uint8Array.from([0x41, 0x4c, 0x55, 0x50]);

const PROBE_REQUEST = 0x01;
const PROBE_ACK = 0x02;

const UPGRADE_ID_LENGTH = 8;
const UPGRADE_NONCE_LENGTH = 32;
const PROBE_TOKEN_LENGTH = 32;
/** magic(4) + kind(1) + upgradeId(8) + token(32). Fits the smallest BLE MTU. */
const PROBE_DATAGRAM_LENGTH = PROBE_MAGIC.length + 1 + UPGRADE_ID_LENGTH + PROBE_TOKEN_LENGTH;

/**
 * How many datagrams we will look at on an unproven link before giving up on
 * it. Anything that is not our probe is somebody else's traffic or noise, and
 * an unbounded stream of it must not keep us waiting or allocating.
 */
const MAX_PROBE_DATAGRAMS = 16;

/** Retransmits of the probe inside one probe timeout. The link has no reliability yet. */
const PROBE_ATTEMPTS = 4;

interface ProbeDatagram {
  readonly kind: number;
  readonly upgradeId: Uint8Array;
  readonly token: Uint8Array;
}

/**
 * The probe token binds the probe to THIS upgrade of THIS session.
 *
 * The nonce is generated locally and sent to the peer inside the AEAD-protected
 * session, so nobody else has ever seen it. A stranger who opens a link on the
 * new transport therefore cannot produce a valid probe, and cannot answer ours.
 * That is a denial-of-service defence, not a confidentiality one: everything
 * above the link is sealed and replay-windowed regardless of who is carrying
 * the bytes.
 */
function probeToken(nonce: Uint8Array, upgradeId: Uint8Array, kind: number): Uint8Array {
  const label = kind === PROBE_ACK ? 'airlink-upgrade-probe-ack' : 'airlink-upgrade-probe';
  return hash256(utf8Encode(label), upgradeId, nonce);
}

export function encodeProbeDatagram(kind: number, upgradeId: Uint8Array, token: Uint8Array): Uint8Array {
  if (upgradeId.length !== UPGRADE_ID_LENGTH || token.length !== PROBE_TOKEN_LENGTH) {
    throw new Error('encodeProbeDatagram: bad field length');
  }
  const out = new Uint8Array(PROBE_DATAGRAM_LENGTH);
  out.set(PROBE_MAGIC, 0);
  out[PROBE_MAGIC.length] = kind & 0xff;
  out.set(upgradeId, PROBE_MAGIC.length + 1);
  out.set(token, PROBE_MAGIC.length + 1 + UPGRADE_ID_LENGTH);
  return out;
}

/**
 * Parse a datagram from an unproven link. Returns null for anything that is not
 * exactly a well-formed probe - never throws, because this runs on every byte
 * an unauthenticated stranger can put on the wire.
 */
export function decodeProbeDatagram(bytes: Uint8Array): ProbeDatagram | null {
  if (!(bytes instanceof Uint8Array) || bytes.length !== PROBE_DATAGRAM_LENGTH) return null;
  for (let i = 0; i < PROBE_MAGIC.length; i++) {
    if (bytes[i] !== PROBE_MAGIC[i]) return null;
  }
  const kind = bytes[PROBE_MAGIC.length] as number;
  if (kind !== PROBE_REQUEST && kind !== PROBE_ACK) return null;
  const idAt = PROBE_MAGIC.length + 1;
  return {
    kind,
    upgradeId: bytes.slice(idAt, idAt + UPGRADE_ID_LENGTH),
    token: bytes.slice(idAt + UPGRADE_ID_LENGTH, idAt + UPGRADE_ID_LENGTH + PROBE_TOKEN_LENGTH),
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const UpgradeState = {
  IDLE: 'idle',
  /** Initiator: offer sent, waiting for the peer to accept. */
  OFFERING: 'offering',
  /** Initiator: opening the new link. */
  CONNECTING: 'connecting',
  /** Initiator: link open, proving it carries traffic both ways. */
  PROBING: 'probing',
  /** Initiator: link proven, telling the peer to switch. */
  COMMITTING: 'committing',
  /** Responder: accepted, waiting for the peer's link and probe. */
  AWAITING_LINK: 'awaitingLink',
  /** Responder: probe verified, holding the new link until told to switch. */
  AWAITING_SWITCH: 'awaitingSwitch',
} as const;
export type UpgradeState = (typeof UpgradeState)[keyof typeof UpgradeState];

export const UpgradeFailureReason = {
  UNKNOWN: 0,
  /** Nothing both sides support beats what we are already on. */
  NO_CANDIDATE: 1,
  PEER_DECLINED: 2,
  TIMEOUT: 3,
  CONNECT_FAILED: 4,
  PROBE_FAILED: 5,
  BUSY: 6,
  /** The transport went away between deciding and dialling. */
  UNAVAILABLE: 7,
  /** No session, or a session that cannot carry traffic yet. */
  SESSION_UNUSABLE: 8,
  /** The peer tried to initiate when the deterministic rule says we do. */
  ROLE_CONFLICT: 9,
  MALFORMED: 10,
  ABORTED: 11,
  LINK_LOST: 12,
} as const;
export type UpgradeFailureReason = (typeof UpgradeFailureReason)[keyof typeof UpgradeFailureReason];

const MAX_FAILURE_REASON = 12;

export interface UpgradeOutcome {
  readonly upgraded: boolean;
  readonly kind: TransportKind | null;
  readonly reason: UpgradeFailureReason;
  readonly detail?: string;
}

export interface UpgradeTimings {
  /** Waiting for TRANSPORT_ACCEPT after offering. */
  offerTimeoutMs: number;
  /** Opening the new link. */
  connectTimeoutMs: number;
  /** Probe round trip on the new link. */
  probeTimeoutMs: number;
  /** Initiator waiting for the peer's TRANSPORT_READY. */
  readyTimeoutMs: number;
  /** Initiator waiting for TRANSPORT_SWITCH to be acknowledged. */
  switchTimeoutMs: number;
  /** Responder waiting for the incoming link and its probe. */
  responderLinkTimeoutMs: number;
  /** Responder holding a proven link, waiting to be told to switch. */
  responderSwitchTimeoutMs: number;
  /** After a transport fails, do not try it again for this long. */
  failureCooldownMs: number;
  /** Floor between two upgrade attempts, successful or not. */
  minAttemptIntervalMs: number;
  /** How often the connection-quality label is recomputed. */
  qualitySampleIntervalMs: number;
}

export const DEFAULT_UPGRADE_TIMINGS: UpgradeTimings = {
  // Generous, because the negotiation itself runs over BLE, which is slow and
  // may be retransmitting under it.
  offerTimeoutMs: 12_000,
  connectTimeoutMs: 15_000,
  probeTimeoutMs: 8_000,
  readyTimeoutMs: 12_000,
  switchTimeoutMs: 12_000,
  responderLinkTimeoutMs: 25_000,
  responderSwitchTimeoutMs: 25_000,
  failureCooldownMs: 60_000,
  minAttemptIntervalMs: 5_000,
  qualitySampleIntervalMs: 2_000,
};

export interface TransportUpgradeEvents {
  stateChanged: { readonly state: UpgradeState };
  upgradeStarted: { readonly kind: TransportKind };
  upgradeCompleted: {
    readonly from: TransportKind | null;
    readonly to: TransportKind;
    readonly linkId: string;
    readonly isHighBandwidth: boolean;
  };
  upgradeFailed: { readonly kind: TransportKind | null; readonly reason: UpgradeFailureReason; readonly detail: string };
  /** The session moved back onto a slower transport and kept running. */
  downgraded: { readonly to: TransportKind; readonly linkId: string };
  qualityChanged: { readonly quality: ConnectionQuality };
}

export interface TransportUpgradeOptions {
  readonly session: PeerSession;
  readonly capabilities: TransportCapabilityManager;
  readonly clock: Clock;
  readonly random: RandomSource;
  /** Our own cryptographic peer id. Compared with the peer's to pick who dials. */
  readonly localPeerId: string;
  /**
   * The peer's endpoint handle on a given transport, from discovery. Returning
   * null means "we know of no way to reach them there", which rules the
   * transport out of this attempt.
   */
  readonly resolveEndpoint: (kind: TransportKind) => string | null | undefined;
  readonly logger?: Logger;
  readonly timings?: Partial<UpgradeTimings>;
  /** Attempt an upgrade automatically when a better transport appears. Default true. */
  readonly autoUpgrade?: boolean;
  /** Re-open a link automatically when the current one dies. Default true. */
  readonly autoDowngrade?: boolean;
  /** How many reconnect attempts before giving up and leaving it to the user. */
  readonly maxDowngradeAttempts?: number;
}

/**
 * Who dials.
 *
 * Both phones run identical code and see the same two ids, so comparing them
 * gives both sides the same answer with no round trip. Equal ids cannot happen
 * between two distinct identities; if they somehow do, NOBODY initiates, which
 * costs an upgrade and prevents a race - the safe direction to fail in.
 */
export function isUpgradeInitiator(localPeerId: string, remotePeerId: string): boolean {
  if (typeof localPeerId !== 'string' || typeof remotePeerId !== 'string') return false;
  if (localPeerId.length === 0 || remotePeerId.length === 0) return false;
  return localPeerId < remotePeerId;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

class UpgradeAbort extends Error {
  constructor(
    readonly reason: UpgradeFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'UpgradeAbort';
  }
}

/**
 * A single attempt's cancellation scope. Anything that can end an attempt early
 * - a TRANSPORT_FAILED from the peer, the session closing, dispose() - calls
 * abort() once, and every step waiting on a promise unwinds through it.
 */
class AttemptScope {
  private aborted: UpgradeAbort | null = null;
  private readonly listeners = new Set<(err: UpgradeAbort) => void>();

  get error(): UpgradeAbort | null {
    return this.aborted;
  }

  abort(err: UpgradeAbort): void {
    if (this.aborted) return;
    this.aborted = err;
    for (const listener of [...this.listeners]) listener(err);
    this.listeners.clear();
  }

  onAbort(fn: (err: UpgradeAbort) => void): Unsubscribe {
    if (this.aborted) {
      fn(this.aborted);
      return () => undefined;
    }
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

interface MessageWaiter {
  readonly type: number;
  readonly upgradeId: Uint8Array;
  readonly resolve: (payload: Record<string, CborValue>) => void;
  readonly reject: (err: UpgradeAbort) => void;
}

interface LinkWaiter {
  readonly upgradeId: Uint8Array;
  readonly kind: TransportKind;
  readonly nonce: Uint8Array;
  readonly resolve: (link: Link) => void;
  readonly reject: (err: UpgradeAbort) => void;
}

// -- bounded readers for peer-supplied payloads ------------------------------

function asMap(value: CborValue | null): Record<string, CborValue> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return null;
  return value as Record<string, CborValue>;
}

function readBytes(map: Record<string, CborValue>, key: string, exactLength: number): Uint8Array | null {
  const value = map[key];
  if (!(value instanceof Uint8Array) || value.length !== exactLength) return null;
  return value;
}

function readKind(map: Record<string, CborValue>, key: string): TransportKind | null {
  const value = map[key];
  return isTransportKind(value) ? value : null;
}

function readEndpoint(map: Record<string, CborValue>, key: string): string | null {
  const value = map[key];
  // Endpoint handles are platform strings (a BLE peripheral UUID, a Bonjour
  // name). Length-bounded because it is a peer-supplied string we will hand
  // straight to a native connect() call.
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  return value;
}

function readReason(map: Record<string, CborValue>, key: string): UpgradeFailureReason {
  const value = map[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_FAILURE_REASON) {
    return UpgradeFailureReason.UNKNOWN;
  }
  return value as UpgradeFailureReason;
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export class TransportUpgradeController {
  readonly events = new TypedEmitter<TransportUpgradeEvents>();

  private readonly session: PeerSession;
  private readonly capabilities: TransportCapabilityManager;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly timings: UpgradeTimings;
  private readonly log: Logger;

  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly cooldownUntil = new Map<TransportKind, number>();
  private readonly qualityTracker = new ConnectionQualityTracker();

  private upgradeState: UpgradeState = UpgradeState.IDLE;
  private scope: AttemptScope | null = null;
  private messageWaiter: MessageWaiter | null = null;
  private linkWaiter: LinkWaiter | null = null;
  /** A link opened for an upgrade and already proven, but not yet migrated to. */
  private provenLink: Link | null = null;
  private provenKind: TransportKind | null = null;

  private started = false;
  private disposed = false;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private downgradeAttempts = 0;
  private downgradeTimer: TimerHandle | undefined;
  private qualityTimer: TimerHandle | undefined;

  /** Developer-mode counters. */
  upgradesCompleted = 0;
  upgradesFailed = 0;
  downgrades = 0;
  probesRejected = 0;

  constructor(private readonly options: TransportUpgradeOptions) {
    this.session = options.session;
    this.capabilities = options.capabilities;
    this.clock = options.clock;
    this.random = options.random;
    this.timings = { ...DEFAULT_UPGRADE_TIMINGS, ...(options.timings ?? {}) };
    this.log = (options.logger ?? silentLogger).child('upgrade');
  }

  // -- lifecycle -------------------------------------------------------------

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;

    this.unsubscribers.push(
      this.session.events.on('message', (message) => this.handleSessionMessage(message)),
      this.session.events.on('stateChanged', ({ state }) => this.handleSessionState(state)),
      this.session.events.on('closed', () => this.dispose()),
      this.capabilities.events.on('changed', () => {
        if (this.options.autoUpgrade === false) return;
        void this.considerUpgrade();
      }),
    );

    this.qualityTimer = this.clock.setInterval(() => this.sampleQuality(), this.timings.qualitySampleIntervalMs);
    this.sampleQuality();
    if (this.options.autoUpgrade !== false) void this.considerUpgrade();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.abortAttempt(new UpgradeAbort(UpgradeFailureReason.ABORTED, 'controller disposed'));
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    if (this.qualityTimer !== undefined) {
      this.clock.clearInterval(this.qualityTimer);
      this.qualityTimer = undefined;
    }
    if (this.downgradeTimer !== undefined) {
      this.clock.clearTimeout(this.downgradeTimer);
      this.downgradeTimer = undefined;
    }
    this.events.removeAllListeners();
  }

  // -- public surface --------------------------------------------------------

  get state(): UpgradeState {
    return this.upgradeState;
  }

  get isBusy(): boolean {
    return this.upgradeState !== UpgradeState.IDLE;
  }

  /** True when THIS side is the one that dials on an upgrade. */
  get isInitiator(): boolean {
    const peerId = this.session.peerId;
    return peerId !== null && isUpgradeInitiator(this.options.localPeerId, peerId);
  }

  get quality(): ConnectionQuality {
    return this.qualityTracker.current;
  }

  /** The transports both sides support that beat the one we are on, best first. */
  upgradeCandidates(): TransportCandidate[] {
    const peerTransports = this.session.capabilities?.transports;
    if (!peerTransports) return [];
    const now = this.clock.now();
    const exclude: TransportKind[] = [];
    for (const [kind, until] of this.cooldownUntil) {
      if (until > now) exclude.push(kind);
    }
    const current = this.currentProfile();
    return negotiateTransports(this.capabilities.availableProfiles(), peerTransports, {
      exclude,
      ...(current ? { betterThan: current } : {}),
    }).filter((candidate) => {
      // No point offering a transport we have no way of reaching them on.
      const endpoint = this.safeResolveEndpoint(candidate.kind);
      return endpoint !== null;
    });
  }

  /**
   * Try to move the session onto a better transport.
   *
   * Safe to call as often as you like: it declines quickly when there is
   * nothing better, when an attempt is already running, when this side is not
   * the initiator, or when the last attempt was too recent.
   */
  async considerUpgrade(): Promise<UpgradeOutcome> {
    if (this.disposed || !this.started) return fail(null, UpgradeFailureReason.ABORTED, 'controller not running');
    if (this.isBusy) return fail(null, UpgradeFailureReason.BUSY, 'an upgrade is already in progress');
    if (!this.sessionUsable()) return fail(null, UpgradeFailureReason.SESSION_UNUSABLE, 'session cannot carry traffic');
    if (!this.isInitiator) return fail(null, UpgradeFailureReason.ROLE_CONFLICT, 'the peer initiates upgrades');
    if (this.clock.now() - this.lastAttemptAt < this.timings.minAttemptIntervalMs) {
      return fail(null, UpgradeFailureReason.BUSY, 'too soon after the last attempt');
    }

    const candidates = this.upgradeCandidates();
    if (candidates.length === 0) return fail(null, UpgradeFailureReason.NO_CANDIDATE, 'nothing better is available');

    this.lastAttemptAt = this.clock.now();

    // Fall through the ranked list: a radio that refuses to open is common, and
    // the runner-up is already in hand.
    let last: UpgradeOutcome = fail(null, UpgradeFailureReason.NO_CANDIDATE, 'nothing better is available');
    for (const candidate of candidates) {
      if (this.disposed) break;
      last = await this.attemptUpgrade(candidate);
      if (last.upgraded) return last;
      if (last.reason === UpgradeFailureReason.ABORTED || last.reason === UpgradeFailureReason.SESSION_UNUSABLE) break;
    }
    return last;
  }

  /**
   * Hand the controller a link that arrived from a transport's `incomingLink`
   * event. Returns true when the controller has taken ownership of it.
   *
   * The caller (the session manager) offers every incoming link here first,
   * because an upgrade link and a brand-new peer are indistinguishable at the
   * transport layer.
   */
  handleIncomingLink(link: Link): boolean {
    if (this.disposed) return false;

    const waiter = this.linkWaiter;
    if (waiter && link.transport === waiter.kind) {
      this.linkWaiter = null;
      this.armProbeResponder(link, waiter);
      return true;
    }

    // Not an upgrade. It may still be the reconnect we are waiting for: an
    // established session whose link has died accepts a fresh one. We only do
    // this while the session is NOT carrying traffic, so a stranger cannot
    // displace a healthy link - the worst they can do is offer one we ignore.
    if (
      this.session.isSecure &&
      this.session.state === ConnectionState.RECONNECTING &&
      link.state !== LinkState.CLOSED &&
      link.state !== LinkState.FAILED
    ) {
      this.adoptLink(link, 'incoming link while reconnecting');
      return true;
    }
    return false;
  }

  /**
   * Re-establish a link after the current one died, on the best transport still
   * available. The session, its keys and its queued messages all survive.
   */
  async reconnect(): Promise<UpgradeOutcome> {
    if (this.disposed) return fail(null, UpgradeFailureReason.ABORTED, 'controller disposed');
    if (!this.session.isSecure) return fail(null, UpgradeFailureReason.SESSION_UNUSABLE, 'no session to reconnect');
    if (this.isBusy) return fail(null, UpgradeFailureReason.BUSY, 'busy');

    const peerTransports = this.session.capabilities?.transports;
    const candidates = negotiateTransports(this.capabilities.availableProfiles(), peerTransports);
    for (const candidate of candidates) {
      const endpoint = this.safeResolveEndpoint(candidate.kind);
      const transport = this.capabilities.get(candidate.kind);
      if (endpoint === null || !transport) continue;
      try {
        const link = await this.withTimeout(
          transport.connect(endpoint, { timeoutMs: this.timings.connectTimeoutMs }),
          this.timings.connectTimeoutMs,
          UpgradeFailureReason.CONNECT_FAILED,
          `connect to ${candidate.kind} timed out`,
        );
        if (this.disposed) {
          void link.close('controller disposed').catch(() => undefined);
          return fail(candidate.kind, UpgradeFailureReason.ABORTED, 'controller disposed');
        }
        this.adoptLink(link, 'reconnected');
        this.downgrades++;
        this.events.emit('downgraded', { to: candidate.kind, linkId: link.id });
        return { upgraded: true, kind: candidate.kind, reason: UpgradeFailureReason.UNKNOWN };
      } catch (err) {
        this.log.info('reconnect attempt failed', { kind: candidate.kind, err: String(err) });
      }
    }
    return fail(null, UpgradeFailureReason.CONNECT_FAILED, 'no transport could re-open a link');
  }

  diagnostics(): Record<string, unknown> {
    return {
      state: this.upgradeState,
      isInitiator: this.isInitiator,
      quality: this.qualityTracker.current,
      currentTransport: this.session.currentLink?.transport ?? null,
      candidates: this.upgradeCandidates().map((c) => c.kind),
      cooldowns: [...this.cooldownUntil.entries()]
        .filter(([, until]) => until > this.clock.now())
        .map(([kind, until]) => ({ kind, msLeft: Math.round(until - this.clock.now()) })),
      upgradesCompleted: this.upgradesCompleted,
      upgradesFailed: this.upgradesFailed,
      downgrades: this.downgrades,
      probesRejected: this.probesRejected,
    };
  }

  // -- initiator -------------------------------------------------------------

  private async attemptUpgrade(candidate: TransportCandidate): Promise<UpgradeOutcome> {
    const transport = this.capabilities.get(candidate.kind);
    const endpoint = this.safeResolveEndpoint(candidate.kind);
    if (!transport || !this.capabilities.isAvailable(candidate.kind) || endpoint === null) {
      return fail(candidate.kind, UpgradeFailureReason.UNAVAILABLE, 'transport went away before dialling');
    }

    const upgradeId = this.random.randomBytes(UPGRADE_ID_LENGTH);
    const nonce = this.random.randomBytes(UPGRADE_NONCE_LENGTH);
    const scope = new AttemptScope();
    this.scope = scope;
    let link: Link | null = null;

    this.setState(UpgradeState.OFFERING);
    this.events.emit('upgradeStarted', { kind: candidate.kind });
    this.log.info('offering a transport upgrade', { kind: candidate.kind, id: toHex(upgradeId) });

    try {
      // 1. Offer. The nonce is confidential: it travels sealed inside the
      //    session, and it is what makes the probe unforgeable.
      if (this.send(MessageType.TRANSPORT_OFFER, { i: upgradeId, k: candidate.kind, n: nonce }) === null) {
        throw new UpgradeAbort(UpgradeFailureReason.SESSION_UNUSABLE, 'could not send the offer');
      }
      const accept = await this.waitForMessage(
        MessageType.TRANSPORT_ACCEPT,
        upgradeId,
        this.timings.offerTimeoutMs,
        scope,
      );

      // The peer names the endpoint to dial. Prefer it over our discovery
      // record: they know their own handle on that radio better than we do.
      const peerEndpoint = readEndpoint(accept, 'e') ?? endpoint;

      // 2. Open the new link. The old one is still carrying the conversation.
      this.setState(UpgradeState.CONNECTING);
      link = await this.withTimeout(
        transport.connect(peerEndpoint, { timeoutMs: this.timings.connectTimeoutMs }),
        this.timings.connectTimeoutMs,
        UpgradeFailureReason.CONNECT_FAILED,
        `connect to ${candidate.kind} timed out`,
        scope,
      );
      if (scope.error) throw scope.error;

      // 3. Prove it. Until this round trip completes we have an open socket and
      //    no evidence at all that it reaches the right peer.
      this.setState(UpgradeState.PROBING);
      await this.runProbe(link, upgradeId, nonce, scope);

      // 4. The peer's session layer confirms it is holding the same link. The
      //    probe proves the pipe; READY proves the peer is committed to it.
      await this.waitForMessage(MessageType.TRANSPORT_READY, upgradeId, this.timings.readyTimeoutMs, scope);

      // 5. Commit. We wait for the peer to acknowledge the switch over the OLD
      //    link, so we know they have it before we let that link go.
      this.setState(UpgradeState.COMMITTING);
      const seq = this.send(MessageType.TRANSPORT_SWITCH, { i: upgradeId });
      if (seq === null) throw new UpgradeAbort(UpgradeFailureReason.SESSION_UNUSABLE, 'could not send the switch');
      await this.waitForDelivery(seq, this.timings.switchTimeoutMs, scope);

      // 6. Migrate. Keys, sequence numbers and queued messages all survive.
      //    The peer moved a moment earlier, when it saw the switch, so there is
      //    a window of one link latency in which it is talking on the new link
      //    and we are not yet listening there. That is exactly what the
      //    reliability layer exists for: anything sent into the gap is
      //    retransmitted, and nothing is lost.
      const from = this.session.currentLink?.transport ?? null;
      this.session.migrateToLink(link);
      this.onUpgradeSucceeded(from, candidate.kind, link);
      return { upgraded: true, kind: candidate.kind, reason: UpgradeFailureReason.UNKNOWN };
    } catch (err) {
      const abort =
        err instanceof UpgradeAbort ? err : new UpgradeAbort(UpgradeFailureReason.UNKNOWN, String(err));

      // The old link was never touched, so the session simply carries on. Close
      // the half-built new one and tell the peer to stop waiting.
      if (link) void link.close('upgrade failed').catch(() => undefined);
      this.notifyPeerOfFailure(upgradeId, abort.reason, abort.message);
      this.finishAttempt();
      this.cooldownUntil.set(candidate.kind, this.clock.now() + this.timings.failureCooldownMs);
      this.upgradesFailed++;
      this.log.warn('transport upgrade failed', { kind: candidate.kind, reason: abort.reason, detail: abort.message });
      this.events.emit('upgradeFailed', { kind: candidate.kind, reason: abort.reason, detail: abort.message });
      return { upgraded: false, kind: candidate.kind, reason: abort.reason, detail: abort.message };
    }
  }

  /**
   * Send the probe over the new link and require the matching answer.
   *
   * The probe is retransmitted a few times inside the timeout: the new link has
   * no reliability layer on it yet, and a first datagram lost to a radio still
   * settling should not cost us the upgrade.
   */
  private runProbe(link: Link, upgradeId: Uint8Array, nonce: Uint8Array, scope: AttemptScope): Promise<void> {
    const request = encodeProbeDatagram(PROBE_REQUEST, upgradeId, probeToken(nonce, upgradeId, PROBE_REQUEST));
    const expected = probeToken(nonce, upgradeId, PROBE_ACK);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let seen = 0;
      let offData: Unsubscribe = () => undefined;
      let offState: Unsubscribe = () => undefined;
      let offAbort: Unsubscribe = () => undefined;
      let timer: TimerHandle | undefined;
      let repeat: TimerHandle | undefined;

      const finish = (err: UpgradeAbort | null): void => {
        if (settled) return;
        settled = true;
        offData();
        offState();
        offAbort();
        if (timer !== undefined) this.clock.clearTimeout(timer);
        if (repeat !== undefined) this.clock.clearInterval(repeat);
        if (err) reject(err);
        else resolve();
      };

      offData = link.events.on('data', ({ bytes }) => {
        if (settled) return;
        if (++seen > MAX_PROBE_DATAGRAMS) {
          finish(new UpgradeAbort(UpgradeFailureReason.PROBE_FAILED, 'probe channel carried only noise'));
          return;
        }
        const probe = decodeProbeDatagram(bytes);
        if (!probe || probe.kind !== PROBE_ACK) return;
        if (!bytesEqual(probe.upgradeId, upgradeId)) return;
        if (!timingSafeEqual(probe.token, expected)) {
          // Someone answered who does not know the nonce. Not our peer.
          this.probesRejected++;
          return;
        }
        finish(null);
      });

      offState = link.events.on('state', ({ state }) => {
        if (state === LinkState.CLOSED || state === LinkState.FAILED) {
          finish(new UpgradeAbort(UpgradeFailureReason.LINK_LOST, 'the new link closed during the probe'));
        }
      });

      offAbort = scope.onAbort((err) => finish(err));

      const emit = (): void => {
        if (settled || link.state !== LinkState.CONNECTED) return;
        void link.send(request, 'reliable').catch((err: unknown) => {
          finish(new UpgradeAbort(UpgradeFailureReason.PROBE_FAILED, `probe send failed: ${String(err)}`));
        });
      };
      emit();
      repeat = this.clock.setInterval(emit, Math.max(1, Math.floor(this.timings.probeTimeoutMs / PROBE_ATTEMPTS)));
      timer = this.clock.setTimeout(
        () => finish(new UpgradeAbort(UpgradeFailureReason.PROBE_FAILED, 'no probe response on the new link')),
        this.timings.probeTimeoutMs,
      );
    });
  }

  private onUpgradeSucceeded(from: TransportKind | null, to: TransportKind, link: Link): void {
    this.finishAttempt();
    this.cooldownUntil.delete(to);
    this.downgradeAttempts = 0;
    this.upgradesCompleted++;
    this.log.info('transport upgraded', { from, to, link: link.id });
    this.events.emit('upgradeCompleted', {
      from,
      to,
      linkId: link.id,
      isHighBandwidth: link.isHighBandwidth,
    });
    this.sampleQuality();
  }

  // -- responder -------------------------------------------------------------

  private async handleOffer(payload: Record<string, CborValue>): Promise<void> {
    const upgradeId = readBytes(payload, 'i', UPGRADE_ID_LENGTH);
    if (!upgradeId) {
      this.log.debug('dropped a malformed transport offer');
      return;
    }
    const kind = readKind(payload, 'k');
    const nonce = readBytes(payload, 'n', UPGRADE_NONCE_LENGTH);

    const decline = (reason: UpgradeFailureReason, detail: string): void => {
      this.log.info('declining a transport offer', { reason, detail });
      this.notifyPeerOfFailure(upgradeId, reason, detail);
    };

    if (!kind || !nonce) return decline(UpgradeFailureReason.MALFORMED, 'offer fields failed validation');
    // Both sides compute the same answer from the same two ids, so a peer
    // offering when it is not the initiator is a bug or an injection attempt.
    if (this.isInitiator) return decline(UpgradeFailureReason.ROLE_CONFLICT, 'this side initiates upgrades');
    if (this.isBusy) return decline(UpgradeFailureReason.BUSY, 'another upgrade is in progress');
    if (!this.sessionUsable()) return decline(UpgradeFailureReason.SESSION_UNUSABLE, 'session cannot carry traffic');
    if (!this.capabilities.isAvailable(kind)) return decline(UpgradeFailureReason.UNAVAILABLE, `${kind} is not usable here`);

    const transport = this.capabilities.get(kind);
    if (!transport) return decline(UpgradeFailureReason.UNAVAILABLE, `${kind} is not registered`);
    const current = this.currentProfile();
    const profile = this.capabilities.profileFor(kind) ?? defaultProfileFor(kind);
    if (current && profile && profile.kind === current.kind) {
      return decline(UpgradeFailureReason.NO_CANDIDATE, 'already on that transport');
    }

    const scope = new AttemptScope();
    this.scope = scope;
    let link: Link | null = null;

    try {
      this.setState(UpgradeState.AWAITING_LINK);
      // We answer with OUR endpoint handle on that radio, because only we know
      // what we are advertising as.
      const endpoint = this.localEndpoint(kind);
      this.send(MessageType.TRANSPORT_ACCEPT, {
        i: upgradeId,
        k: kind,
        ...(endpoint !== null ? { e: endpoint } : {}),
      });

      link = await this.waitForProbedLink(upgradeId, kind, nonce, this.timings.responderLinkTimeoutMs, scope);

      // The link is proven. Hold it - and the old one - until told to switch.
      this.provenLink = link;
      this.provenKind = kind;
      this.setState(UpgradeState.AWAITING_SWITCH);
      this.send(MessageType.TRANSPORT_READY, { i: upgradeId });

      await this.waitForMessage(
        MessageType.TRANSPORT_SWITCH,
        upgradeId,
        this.timings.responderSwitchTimeoutMs,
        scope,
      );
      this.completeResponderSwitch('peer switched transport');
    } catch (err) {
      const abort = err instanceof UpgradeAbort ? err : new UpgradeAbort(UpgradeFailureReason.UNKNOWN, String(err));
      if (this.provenLink && this.provenLink === link) {
        // Only close it if we still hold it; a concurrent migration may have
        // taken it, in which case the session owns it now.
        void link.close('upgrade abandoned').catch(() => undefined);
        this.provenLink = null;
        this.provenKind = null;
      } else if (link) {
        void link.close('upgrade abandoned').catch(() => undefined);
      }
      this.notifyPeerOfFailure(upgradeId, abort.reason, abort.message);
      this.finishAttempt();
      this.upgradesFailed++;
      this.log.warn('incoming transport upgrade failed', { kind, reason: abort.reason, detail: abort.message });
      this.events.emit('upgradeFailed', { kind: kind ?? null, reason: abort.reason, detail: abort.message });
    }
  }

  /** Arm the probe responder on a link handed to us by `handleIncomingLink`. */
  private armProbeResponder(link: Link, waiter: LinkWaiter): void {
    const expected = probeToken(waiter.nonce, waiter.upgradeId, PROBE_REQUEST);
    const answer = encodeProbeDatagram(PROBE_ACK, waiter.upgradeId, probeToken(waiter.nonce, waiter.upgradeId, PROBE_ACK));

    let settled = false;
    let seen = 0;
    let offData: Unsubscribe = () => undefined;
    let offState: Unsubscribe = () => undefined;

    const finish = (err: UpgradeAbort | null): void => {
      if (settled) return;
      settled = true;
      offData();
      offState();
      if (err) waiter.reject(err);
      else waiter.resolve(link);
    };

    offData = link.events.on('data', ({ bytes }) => {
      if (settled) return;
      if (++seen > MAX_PROBE_DATAGRAMS) {
        finish(new UpgradeAbort(UpgradeFailureReason.PROBE_FAILED, 'probe channel carried only noise'));
        return;
      }
      const probe = decodeProbeDatagram(bytes);
      if (!probe || probe.kind !== PROBE_REQUEST) return;
      if (!bytesEqual(probe.upgradeId, waiter.upgradeId)) return;
      if (!timingSafeEqual(probe.token, expected)) {
        // Wrong token: whoever opened this link does not hold the nonce, so it
        // is not the peer we are negotiating with. Ignore and keep waiting.
        this.probesRejected++;
        return;
      }
      void link.send(answer, 'reliable').catch(() => undefined);
      finish(null);
    });

    offState = link.events.on('state', ({ state }) => {
      if (state === LinkState.CLOSED || state === LinkState.FAILED) {
        finish(new UpgradeAbort(UpgradeFailureReason.LINK_LOST, 'the new link closed before the probe'));
      }
    });
  }

  /** Migrate onto the link we have been holding, and drop the negotiation state. */
  private completeResponderSwitch(reason: string): void {
    const link = this.provenLink;
    const kind = this.provenKind;
    this.provenLink = null;
    this.provenKind = null;
    this.finishAttempt();
    if (!link || !kind) return;
    if (link.state !== LinkState.CONNECTED) {
      this.log.warn('the proven link died before the switch', { reason });
      return;
    }
    const from = this.session.currentLink?.transport ?? null;
    this.adoptLink(link, reason);
    this.upgradesCompleted++;
    this.log.info('transport upgraded by the peer', { from, to: kind, link: link.id });
    this.events.emit('upgradeCompleted', {
      from,
      to: kind,
      linkId: link.id,
      isHighBandwidth: link.isHighBandwidth,
    });
    this.sampleQuality();
  }

  // -- session plumbing ------------------------------------------------------

  private handleSessionMessage(message: IncomingMessage): void {
    if (this.disposed) return;
    if (
      message.type !== MessageType.TRANSPORT_OFFER &&
      message.type !== MessageType.TRANSPORT_ACCEPT &&
      message.type !== MessageType.TRANSPORT_READY &&
      message.type !== MessageType.TRANSPORT_FAILED &&
      message.type !== MessageType.TRANSPORT_SWITCH
    ) {
      return;
    }
    const payload = asMap(message.value);
    if (!payload) {
      this.log.debug('dropped a transport message with a non-map payload', { type: message.typeName });
      return;
    }

    if (message.type === MessageType.TRANSPORT_OFFER) {
      void this.handleOffer(payload);
      return;
    }

    const upgradeId = readBytes(payload, 'i', UPGRADE_ID_LENGTH);
    if (!upgradeId) {
      this.log.debug('dropped a transport message with a bad upgrade id', { type: message.typeName });
      return;
    }

    if (message.type === MessageType.TRANSPORT_FAILED) {
      const waiter = this.messageWaiter;
      const linkWaiter = this.linkWaiter;
      const matches =
        (waiter && bytesEqual(waiter.upgradeId, upgradeId)) ||
        (linkWaiter && bytesEqual(linkWaiter.upgradeId, upgradeId));
      if (!matches && !this.isBusy) return;
      this.abortAttempt(
        new UpgradeAbort(readReason(payload, 'r') || UpgradeFailureReason.PEER_DECLINED, 'the peer abandoned the upgrade'),
      );
      return;
    }

    const waiter = this.messageWaiter;
    if (!waiter || waiter.type !== message.type || !bytesEqual(waiter.upgradeId, upgradeId)) {
      // A reply for an attempt that has already ended, or one we never made.
      this.log.debug('ignoring an unexpected transport message', { type: message.typeName });
      return;
    }
    waiter.resolve(payload);
  }

  private handleSessionState(state: ConnectionState): void {
    if (this.disposed) return;

    if (state === ConnectionState.CONNECTED) {
      this.downgradeAttempts = 0;
      this.sampleQuality();
      return;
    }
    if (state !== ConnectionState.RECONNECTING) return;

    this.sampleQuality();

    // The link carrying the session just died. If we are already holding a
    // proven link, the peer has evidently gone ahead and switched: follow it
    // rather than tearing anything down. This is what keeps the two sides from
    // diverging when the final acknowledgement is the packet that gets lost.
    if (this.provenLink && this.provenLink.state === LinkState.CONNECTED) {
      this.completeResponderSwitch('old link lost while holding a proven link');
      return;
    }

    // An upgrade in flight cannot outlive the link it was negotiated on.
    this.abortAttempt(new UpgradeAbort(UpgradeFailureReason.LINK_LOST, 'the session link was lost'));

    if (this.options.autoDowngrade === false) return;
    // Only one side dials, here too: two phones both re-opening a link after a
    // dropout produce the same race an upgrade would.
    if (!this.isInitiator) return;
    this.scheduleDowngrade();
  }

  /**
   * Re-open a link after a dropout, with the backoff the reconnect policy
   * defines, so a phone in a pocket does not burn its battery retrying.
   */
  private scheduleDowngrade(): void {
    if (this.downgradeTimer !== undefined) return;
    const max = this.options.maxDowngradeAttempts ?? 3;
    if (this.downgradeAttempts >= max) {
      this.log.info('giving up on automatic reconnection', { attempts: this.downgradeAttempts });
      return;
    }
    const schedule = TIMING.reconnectBackoffMs;
    const delay = schedule[Math.min(this.downgradeAttempts, schedule.length - 1)] ?? 1000;
    this.downgradeAttempts++;
    this.downgradeTimer = this.clock.setTimeout(() => {
      this.downgradeTimer = undefined;
      if (this.disposed) return;
      if (this.session.state !== ConnectionState.RECONNECTING) return;
      void this.reconnect().then((outcome) => {
        if (!outcome.upgraded && this.session.state === ConnectionState.RECONNECTING) this.scheduleDowngrade();
      });
    }, delay);
  }

  /** Move the session onto `link`, tolerating a session that has since closed. */
  private adoptLink(link: Link, reason: string): void {
    try {
      this.session.migrateToLink(link);
      this.log.info('session migrated', { link: link.id, transport: link.transport, reason });
    } catch (err) {
      this.log.warn('could not migrate the session', { err: String(err) });
      void link.close('migration refused').catch(() => undefined);
      return;
    }
    this.sampleQuality();
  }

  // -- waiting primitives ----------------------------------------------------

  private waitForMessage(
    type: number,
    upgradeId: Uint8Array,
    timeoutMs: number,
    scope: AttemptScope,
  ): Promise<Record<string, CborValue>> {
    return new Promise<Record<string, CborValue>>((resolve, reject) => {
      if (scope.error) {
        reject(scope.error);
        return;
      }
      let settled = false;
      let offAbort: Unsubscribe = () => undefined;
      const timer = this.clock.setTimeout(() => {
        done();
        reject(new UpgradeAbort(UpgradeFailureReason.TIMEOUT, `timed out waiting for message 0x${type.toString(16)}`));
      }, timeoutMs);

      const done = (): void => {
        settled = true;
        this.clock.clearTimeout(timer);
        offAbort();
        if (this.messageWaiter && this.messageWaiter.type === type) this.messageWaiter = null;
      };

      this.messageWaiter = {
        type,
        upgradeId,
        resolve: (payload) => {
          if (settled) return;
          done();
          resolve(payload);
        },
        reject: (err) => {
          if (settled) return;
          done();
          reject(err);
        },
      };
      offAbort = scope.onAbort((err) => {
        if (settled) return;
        done();
        reject(err);
      });
    });
  }

  private waitForProbedLink(
    upgradeId: Uint8Array,
    kind: TransportKind,
    nonce: Uint8Array,
    timeoutMs: number,
    scope: AttemptScope,
  ): Promise<Link> {
    return new Promise<Link>((resolve, reject) => {
      if (scope.error) {
        reject(scope.error);
        return;
      }
      let settled = false;
      let offAbort: Unsubscribe = () => undefined;
      const timer = this.clock.setTimeout(() => {
        done();
        reject(new UpgradeAbort(UpgradeFailureReason.TIMEOUT, 'the peer never opened the new link'));
      }, timeoutMs);

      const done = (): void => {
        settled = true;
        this.clock.clearTimeout(timer);
        offAbort();
        this.linkWaiter = null;
      };

      this.linkWaiter = {
        upgradeId,
        kind,
        nonce,
        resolve: (link) => {
          if (settled) return;
          done();
          resolve(link);
        },
        reject: (err) => {
          if (settled) return;
          done();
          reject(err);
        },
      };
      offAbort = scope.onAbort((err) => {
        if (settled) return;
        done();
        reject(err);
      });
    });
  }

  /**
   * Wait for the reliability layer to confirm the peer received `seq`. This is
   * the only end-to-end proof available that the peer knows we are switching.
   */
  private waitForDelivery(seq: number, timeoutMs: number, scope: AttemptScope): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (scope.error) {
        reject(scope.error);
        return;
      }
      let settled = false;
      const offs: Unsubscribe[] = [];
      const timer = this.clock.setTimeout(() => {
        finish(new UpgradeAbort(UpgradeFailureReason.TIMEOUT, 'the switch was never acknowledged'));
      }, timeoutMs);

      const finish = (err: UpgradeAbort | null): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        for (const off of offs) off();
        if (err) reject(err);
        else resolve();
      };

      offs.push(
        this.session.events.on('delivered', (event) => {
          if (event.seq === seq) finish(null);
        }),
        this.session.events.on('deliveryFailed', (event) => {
          if (event.seq === seq) finish(new UpgradeAbort(UpgradeFailureReason.TIMEOUT, 'the switch could not be delivered'));
        }),
        scope.onAbort((err) => finish(err)),
      );
    });
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    reason: UpgradeFailureReason,
    message: string,
    scope?: AttemptScope,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let offAbort: Unsubscribe = () => undefined;
      const timer = this.clock.setTimeout(() => finish(() => reject(new UpgradeAbort(reason, message))), timeoutMs);
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        offAbort();
        action();
      };
      if (scope) offAbort = scope.onAbort((err) => finish(() => reject(err)));
      promise.then(
        (value) => finish(() => resolve(value)),
        (err: unknown) => finish(() => reject(new UpgradeAbort(reason, `${message}: ${String(err)}`))),
      );
    });
  }

  // -- small helpers ---------------------------------------------------------

  private setState(state: UpgradeState): void {
    if (this.upgradeState === state) return;
    this.upgradeState = state;
    this.events.emit('stateChanged', { state });
  }

  private finishAttempt(): void {
    this.scope = null;
    this.messageWaiter = null;
    this.linkWaiter = null;
    this.setState(UpgradeState.IDLE);
  }

  private abortAttempt(err: UpgradeAbort): void {
    const scope = this.scope;
    this.scope = null;
    if (scope) scope.abort(err);
    // Waiters unwind through the scope; anything left is stale bookkeeping.
    this.messageWaiter = null;
    this.linkWaiter = null;
    if (this.provenLink) {
      void this.provenLink.close('upgrade aborted').catch(() => undefined);
      this.provenLink = null;
      this.provenKind = null;
    }
    this.setState(UpgradeState.IDLE);
  }

  private send(messageType: number, value: CborValue): number | null {
    try {
      return this.session.sendReliable(messageType, value);
    } catch (err) {
      this.log.debug('could not send a transport message', { err: String(err) });
      return null;
    }
  }

  private notifyPeerOfFailure(upgradeId: Uint8Array, reason: UpgradeFailureReason, detail: string): void {
    this.send(MessageType.TRANSPORT_FAILED, { i: upgradeId, r: reason, m: detail.slice(0, 80) });
  }

  private sessionUsable(): boolean {
    return (
      this.session.isSecure &&
      !this.session.awaitingUserConfirmation &&
      this.session.state === ConnectionState.CONNECTED &&
      this.session.currentLink !== null
    );
  }

  private currentProfile(): TransportProfile | null {
    const kind = this.session.currentLink?.transport;
    if (!kind || !isTransportKind(kind)) return null;
    return this.capabilities.profileFor(kind) ?? defaultProfileFor(kind) ?? null;
  }

  /**
   * `resolveEndpoint` is supplied by the app and reaches into discovery state,
   * so it is treated as fallible: a throw must not take down an upgrade, let
   * alone the session.
   */
  private safeResolveEndpoint(kind: TransportKind): string | null {
    try {
      const value = this.options.resolveEndpoint(kind);
      return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
    } catch (err) {
      this.log.warn('resolveEndpoint threw', { kind, err: String(err) });
      return null;
    }
  }

  /** Our own handle on a transport, if it exposes one. Sent in TRANSPORT_ACCEPT. */
  private localEndpoint(kind: TransportKind): string | null {
    const transport = this.capabilities.get(kind) as { endpointId?: unknown } | undefined;
    const value = transport?.endpointId;
    return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
  }

  private sampleQuality(): void {
    if (this.disposed) return;
    const link = this.session.currentLink;
    const connected = link !== null && link.state === LinkState.CONNECTED && this.session.state === ConnectionState.CONNECTED;
    const next = this.qualityTracker.observe(connectionQualityFromLink(link?.metrics() ?? null, { connected }));
    if (next !== null) this.events.emit('qualityChanged', { quality: next });
  }
}

function fail(kind: TransportKind | null, reason: UpgradeFailureReason, detail: string): UpgradeOutcome {
  return { upgraded: false, kind, reason, detail };
}
