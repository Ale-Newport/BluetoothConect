/**
 * The transport abstraction.
 *
 * Everything above this file - chat, games, file transfer, watch-together - is
 * written against these interfaces and has no idea whether the bytes are
 * travelling over Bluetooth, Wi-Fi or an in-memory pipe. Adding a radio means
 * adding one file here; it never means touching a feature.
 *
 * CONTRACT every Transport must honour:
 *
 *  1. Datagram semantics. A `send` of N bytes arrives as exactly one `data`
 *     event of the same N bytes, or not at all. Stream transports (TCP) MUST
 *     add their own length framing internally.
 *  2. While a link reports CONNECTED, reliable sends are delivered in order and
 *     without duplication. Loss is signalled by a state change, never silently.
 *     This is true of BLE GATT and of TCP, which are the two real transports.
 *  3. `maxDatagramSize` is honoured. Sending more throws rather than truncating.
 *  4. All callbacks are delivered asynchronously, never re-entrantly from inside
 *     a `send` call.
 *  5. `close()` is idempotent and always eventually produces a `closed` state.
 */
import type { TransportKind } from '../protocol/capabilities.js';
import type { TypedEmitter, Unsubscribe } from '../util/emitter.js';

/** How a payload should be treated when the link is congested. */
export const SendMode = {
  /** Must arrive. Queued, retried, and re-sent after a reconnect. */
  RELIABLE: 'reliable',
  /** May be dropped. Newer data supersedes older; used for game state. */
  REALTIME: 'realtime',
} as const;
export type SendMode = (typeof SendMode)[keyof typeof SendMode];

export const LinkState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CLOSING: 'closing',
  CLOSED: 'closed',
  FAILED: 'failed',
} as const;
export type LinkState = (typeof LinkState)[keyof typeof LinkState];

/** A peer as seen by discovery, before any secure session exists. */
export interface DiscoveredPeer {
  /**
   * Transport-scoped handle for this peer. NOT a stable identity - a BLE
   * peripheral identifier differs per platform and can rotate. The cryptographic
   * peer id only becomes known after the handshake.
   */
  readonly endpointId: string;
  readonly transport: TransportKind;
  /** Advertised display name, if the transport carries one. Untrusted. */
  readonly advertisedName?: string;
  /**
   * Short, rotating advertisement token. Lets us recognise a previously paired
   * friend before connecting, without broadcasting a durable identifier.
   */
  readonly advertisementToken?: Uint8Array;
  /**
   * Identifier of the advertising installation, stable for that app's run.
   *
   * This is what makes "is this me?" an exact question rather than a guess, and
   * what lets one phone seen over Bluetooth and over Wi-Fi be recognised as one
   * phone before either has said a word. It is not a durable identifier: it is
   * regenerated on every launch, so it links nothing across time.
   *
   * Optional because a transport built before discovery ids existed will not
   * carry one, and a peer without one is still a peer - it simply has to be
   * resolved rather than trusted immediately.
   */
  readonly discoveryId?: string;
  /** Protocol version from the advertisement, when the transport carries one. */
  readonly protocolVersion?: number;
  /** Persistent installation id, on the few transports that can carry one. */
  readonly installationId?: string;
  /** Long-term key fingerprint, when a transport can carry one. */
  readonly publicKeyFingerprint?: string;
  /** Received signal strength, dBm, when the transport reports it. */
  readonly rssi?: number;
  readonly discoveredAt: number;
  readonly lastSeenAt: number;
}

/** Live quality metrics for one link. Surfaced raw only in Developer Mode. */
export interface LinkMetrics {
  readonly transport: TransportKind;
  readonly maxDatagramSize: number;
  readonly rssi?: number;
  readonly rttMs?: number;
  readonly throughputBytesPerSecond?: number;
  readonly packetsSent: number;
  readonly packetsReceived: number;
  readonly packetsDropped: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

export interface LinkEvents {
  data: { readonly bytes: Uint8Array };
  state: { readonly state: LinkState; readonly reason?: string };
  /** Emitted when the negotiated datagram size changes (BLE MTU exchange). */
  mtu: { readonly maxDatagramSize: number };
  metrics: { readonly metrics: LinkMetrics };
}

/**
 * One established connection to one peer over one transport.
 *
 * A `Link` is intentionally dumb: no encryption, no sequencing, no retries. All
 * of that lives one layer up in PeerSession, so it works identically on every
 * transport and is testable without any radio.
 */
export interface Link {
  readonly id: string;
  readonly transport: TransportKind;
  readonly endpointId: string;
  readonly state: LinkState;
  /** Largest payload a single `send` may carry, in bytes. Can change at runtime. */
  readonly maxDatagramSize: number;
  /** True when the transport can move bulk data at a useful rate (files, video). */
  readonly isHighBandwidth: boolean;

  readonly events: TypedEmitter<LinkEvents>;

  /**
   * Queue a datagram. Resolves once the transport has accepted it for
   * transmission (not once the peer has received it - that is the reliability
   * layer's job). Rejects if the link is not connected or the payload exceeds
   * maxDatagramSize.
   */
  send(bytes: Uint8Array, mode: SendMode): Promise<void>;

  /** Number of datagrams accepted but not yet handed to the radio. */
  readonly queuedCount: number;

  metrics(): LinkMetrics;

  close(reason?: string): Promise<void>;
}

export interface TransportEvents {
  /**
   * A peer is visible. Emitted repeatedly, not once.
   *
   * THIS IS A HEARTBEAT, AND THE WORD IS LOAD-BEARING. A transport must re-emit
   * this at least every `TIMING.presenceRefreshMs` for as long as the peer can
   * be seen, because `NearbyRegistry` expires a row that stops being fed. The
   * registry works that way on purpose: Bluetooth has no reliable "gone" event,
   * so absence of presence is the only signal that somebody left the room.
   *
   * A transport whose underlying discovery is LEVEL-triggered - Bonjour, where
   * the record simply exists until it is withdrawn - must therefore add its own
   * timer. Getting this wrong is not a subtle degradation: it worked perfectly
   * for unpaired devices, whose advertisement token was random and changed
   * every four seconds, and then a peer became a friend, its token went stable
   * for five minutes, the change-driven events stopped, and the friend vanished
   * from the list fifteen seconds later and could not be dialled again.
   *
   * Re-emitting for a peer that is genuinely gone is the lesser error: the row
   * is untrusted, the dial fails gracefully, and the next `peerLost` corrects
   * it. Not re-emitting loses people who are standing right there.
   */
  peerDiscovered: { readonly peer: DiscoveredPeer };
  peerLost: { readonly endpointId: string };
  /** A peer initiated a connection to us. */
  incomingLink: { readonly link: Link };
  availabilityChanged: { readonly availability: TransportAvailability };
}

/** Why a transport cannot currently be used. Drives the permission UI. */
export const TransportUnavailableReason = {
  UNSUPPORTED_HARDWARE: 'unsupportedHardware',
  UNSUPPORTED_OS_VERSION: 'unsupportedOsVersion',
  PERMISSION_DENIED: 'permissionDenied',
  PERMISSION_NOT_REQUESTED: 'permissionNotRequested',
  RADIO_OFF: 'radioOff',
  NO_LOCAL_NETWORK: 'noLocalNetwork',
  UNKNOWN: 'unknown',
} as const;
export type TransportUnavailableReason =
  (typeof TransportUnavailableReason)[keyof typeof TransportUnavailableReason];

export interface TransportAvailability {
  readonly available: boolean;
  readonly reason?: TransportUnavailableReason;
  /** Human-readable, already localised by the caller. Shown in the UI. */
  readonly detail?: string;
}

/**
 * Static description of what a transport can do. The TransportCapabilityManager
 * ranks transports using these numbers, so a new radio slots in without any
 * feature code changing.
 */
export interface TransportProfile {
  readonly kind: TransportKind;
  /** Higher wins when both peers support several transports. */
  readonly preference: number;
  /** Rough sustained throughput, bytes per second. Used for ETA estimates. */
  readonly expectedThroughputBytesPerSecond: number;
  /** Rough round-trip latency in milliseconds. */
  readonly expectedRttMs: number;
  /** True when this transport can carry photos and video at a tolerable rate. */
  readonly highBandwidth: boolean;
  /** True when this transport can discover peers by itself. */
  readonly canDiscover: boolean;
  /** True when this transport works between iOS and Android. */
  readonly crossPlatform: boolean;
  /** True when the OS lets this keep running while the app is backgrounded. */
  readonly worksInBackground: boolean;
}

export interface Transport {
  readonly kind: TransportKind;
  readonly profile: TransportProfile;
  readonly events: TypedEmitter<TransportEvents>;

  availability(): Promise<TransportAvailability>;

  /** Begin advertising our presence so other peers can find us. */
  startAdvertising(record: AdvertisementRecord): Promise<void>;
  stopAdvertising(): Promise<void>;

  /** Begin looking for peers. Results arrive as `peerDiscovered` events. */
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;

  /** Open a link to a discovered peer. */
  connect(endpointId: string, options?: ConnectOptions): Promise<Link>;

  /** Release every resource. The transport may be started again afterwards. */
  shutdown(): Promise<void>;
}

export interface ConnectOptions {
  readonly timeoutMs?: number;
}

/**
 * What we broadcast so nearby devices can find us.
 *
 * Kept deliberately small - a BLE advertisement has roughly 26 usable bytes -
 * and deliberately free of durable identifiers. The token rotates, and only a
 * peer that already knows our identity key can link it back to us.
 */
export interface AdvertisementRecord {
  readonly protocolVersion: number;
  /** Rotating 6-byte token; recognisable only to peers we have paired with. */
  readonly token: Uint8Array;
  /** Optional short display name. Included only when the user opts in. */
  readonly displayName?: string;
  /**
   * Per-run identifier, sixteen hex characters. See `DiscoveredPeer.discoveryId`.
   *
   * Every transport that can carry any payload at all should carry this one:
   * it is eight bytes, and it is what stops a device connecting to itself.
   */
  readonly discoveryId?: string;
}

export type { Unsubscribe };
