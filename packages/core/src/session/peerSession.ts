/**
 * A secure, authenticated conversation with one peer.
 *
 * This is the single place where the transport, the cryptography, the
 * reliability layer and the message protocol meet. Above it, features send and
 * receive typed messages; below it, links come and go.
 *
 * The property that makes the product work: the session OWNS the keys and the
 * reliability state, and merely BORROWS a link. Swapping a Bluetooth link for a
 * Wi-Fi one - or reconnecting after the phone was in a pocket - replaces the
 * borrowed part while the conversation, the in-flight messages and the game in
 * progress all continue untouched.
 */
import {
  Channel,
  EnvelopeFlags,
  FrameType,
  MessageType,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  TIMING,
  isKnownMessageType,
  messageTypeName,
} from '../protocol/constants.js';
import {
  FragmentReassembler,
  decodeEnvelope,
  decodeFrame,
  encodeEnvelope,
  encodeHandshakeFrame,
  encodeSecureFrame,
  fragmentFrame,
  type Envelope,
} from '../protocol/frame.js';
import { decodeCbor, encodeCbor, type CborValue } from '../protocol/cbor.js';
import type { PeerCapabilities } from '../protocol/capabilities.js';
import { Handshake, HandshakeError, HandshakeRole, type HandshakeConfig, type HandshakeResult } from '../crypto/handshake.js';
import { SecureSession } from '../crypto/session.js';
import { deriveSasCode } from '../crypto/sas.js';
import { DecodeError } from '../util/varint.js';
import { TypedEmitter } from '../util/emitter.js';
import type { Clock, TimerHandle } from '../util/time.js';
import { Logger, silentLogger } from '../util/logger.js';
import { LinkState, SendMode, type Link } from '../transport/types.js';
import { ConnectionState, ConnectionStateMachine } from './stateMachine.js';
import { RealtimeChannel, ReliableChannel } from './reliability.js';
import { ClockSynchronizer } from './clockSync.js';

export interface IncomingMessage {
  readonly type: number;
  readonly typeName: string;
  readonly channel: Channel;
  /** Decoded CBOR payload, or null when the payload is raw bytes. */
  readonly value: CborValue | null;
  readonly raw: Uint8Array;
  /** Sender's wall clock at send time. Advisory - never trusted. */
  readonly remoteTimestamp: number;
  readonly receivedAt: number;
  readonly seq: number;
  /** Set for relayed group traffic. */
  readonly senderId?: string;
}

export interface PeerSessionEvents {
  message: IncomingMessage;
  stateChanged: { readonly state: ConnectionState; readonly reason?: string };
  /** The handshake finished. For a first meeting, `requiresConfirmation` is true. */
  authenticated: {
    readonly peerId: string;
    readonly capabilities: PeerCapabilities;
    readonly requiresConfirmation: boolean;
    readonly sasCode: string;
    readonly identityKey: Uint8Array;
  };
  /** A different link is now carrying this session. */
  transportChanged: { readonly from: string | null; readonly to: string; readonly isHighBandwidth: boolean };
  /** A reliable message could not be delivered after every retry. */
  deliveryFailed: { readonly seq: number; readonly messageType: number };
  /** Reliable delivery confirmed by the peer. */
  delivered: { readonly seq: number; readonly rttMs: number | null };
  error: { readonly code: number; readonly message: string; readonly fatal: boolean };
  closed: { readonly reason: string };
}

export interface PeerSessionOptions {
  readonly clock: Clock;
  readonly handshake: HandshakeConfig;
  readonly logger?: Logger;
  /** Called when a link must be (re)established. Returning null gives up. */
  readonly openLink?: () => Promise<Link | null>;
  readonly keepaliveIntervalMs?: number;
  readonly livenessTimeoutMs?: number;
}

/** How much of the link MTU the payload may use, leaving room for headers. */
const HEADER_BUDGET = 64;

/**
 * In-flight fragmented packets the receiver will hold at once.
 *
 * Must comfortably exceed the reliable send window, or a burst of large packets
 * evicts its own fragments and nothing ever reassembles.
 */
const FRAGMENT_REASSEMBLY_SLOTS = 96;

export class PeerSession {
  readonly events = new TypedEmitter<PeerSessionEvents>();
  readonly stateMachine: ConnectionStateMachine;
  readonly clockSync: ClockSynchronizer;

  private link: Link | null = null;
  private linkUnsubscribers: (() => void)[] = [];
  private handshake: Handshake | null = null;
  private secure: SecureSession | null = null;
  private result: HandshakeResult | null = null;

  private readonly reliable: ReliableChannel;
  private readonly bulk: ReliableChannel;
  private readonly realtime: RealtimeChannel;
  /**
   * Bounded, but wide enough for the reliable window: the sender may have up to
   * `windowSize` packets outstanding, and although writes are serialised, a
   * retransmission can legitimately arrive interleaved with a fresh packet.
   */
  private readonly reassembler = new FragmentReassembler(FRAGMENT_REASSEMBLY_SLOTS, 30_000);

  private keepaliveTimer: TimerHandle | undefined;
  private livenessTimer: TimerHandle | undefined;
  private lastInboundAt = 0;
  private nextFragmentPacketId = 1;
  /**
   * Serialises outbound frames onto the link.
   *
   * Without it, several fragmented packets are written CONCURRENTLY - each
   * `writeFrame` awaits the link per fragment, so their fragments interleave on
   * the wire. The receiver then has N partially-reassembled packets in flight at
   * once, blows past the reassembler's bound, and completes none of them. On a
   * Bluetooth link, where a 4 KB message is twenty-odd fragments, this stops
   * file transfer working at all.
   *
   * Fragments of one packet must therefore go out contiguously.
   */
  private writeChain: Promise<void> = Promise.resolve();
  private confirmationPending = false;
  private closed = false;
  private readonly log: Logger;

  /** Developer-mode counters. */
  packetsDropped = 0;
  malformedPackets = 0;

  constructor(
    readonly peerHandle: string,
    private readonly options: PeerSessionOptions,
  ) {
    this.log = (options.logger ?? silentLogger).child(`session:${peerHandle}`);
    this.stateMachine = new ConnectionStateMachine(options.clock);
    this.stateMachine.events.on('change', (change) => {
      this.events.emit(
        'stateChanged',
        change.reason !== undefined ? { state: change.to, reason: change.reason } : { state: change.to },
      );
    });

    this.reliable = new ReliableChannel(options.clock, {
      transmit: (record, isRetransmit) => this.transmitReliable(Channel.RELIABLE, record, isRetransmit),
      onAcknowledged: (seq, rttMs) => this.events.emit('delivered', { seq, rttMs }),
      onDeliveryFailed: (record) => {
        this.events.emit('deliveryFailed', { seq: record.seq, messageType: record.messageType });
      },
    });

    this.bulk = new ReliableChannel(
      options.clock,
      {
        transmit: (record, isRetransmit) => this.transmitReliable(Channel.BULK, record, isRetransmit),
        onAcknowledged: (seq, rttMs) => this.events.emit('delivered', { seq, rttMs }),
        onDeliveryFailed: (record) => {
          this.events.emit('deliveryFailed', { seq: record.seq, messageType: record.messageType });
        },
      },
      { windowSize: 16 },
    );

    this.realtime = new RealtimeChannel((messageType, payload) => {
      this.writeEnvelope({
        channel: Channel.REALTIME,
        flags: EnvelopeFlags.RAW_PAYLOAD,
        seq: 0,
        ...this.reliable.ackState(),
        messageType,
        timestamp: options.clock.wallNow(),
        payload,
      });
    });

    this.clockSync = new ClockSynchronizer(options.clock, (payload) => {
      this.sendControl(MessageType.CLOCK_SYNC_REQUEST, payload);
    });
  }

  // -- public surface --------------------------------------------------------

  get state(): ConnectionState {
    return this.stateMachine.current;
  }

  get peerId(): string | null {
    return this.result?.peerId ?? null;
  }

  get capabilities(): PeerCapabilities | null {
    return this.result?.peerCapabilities ?? null;
  }

  get identityKey(): Uint8Array | null {
    return this.result?.peerIdentityKey ?? null;
  }

  get currentLink(): Link | null {
    return this.link;
  }

  get isHighBandwidth(): boolean {
    return this.link?.isHighBandwidth ?? false;
  }

  get isSecure(): boolean {
    return this.secure !== null && !this.secure.isDestroyed;
  }

  /** Six-digit code the two users compare on a first meeting. */
  get sasCode(): string | null {
    return this.result ? deriveSasCode(this.result.sasCodeSeed) : null;
  }

  get awaitingUserConfirmation(): boolean {
    return this.confirmationPending;
  }

  /** Bytes of application payload that fit in one datagram on the current link. */
  get maxPayloadBytes(): number {
    const linkMtu = this.link?.maxDatagramSize ?? 180;
    // Fragmentation lets us exceed the link MTU; the ceiling is the peer's
    // declared limit, or a safe default before capabilities are known.
    return Math.min(this.result?.peerCapabilities.maxPayloadBytes ?? 65536, 256 * 1024 - HEADER_BUDGET - linkMtu);
  }

  /**
   * Attach a link and run the handshake as the initiator.
   * Called for an outgoing connection.
   */
  async startAsInitiator(link: Link): Promise<void> {
    if (this.secure) {
      throw new Error(
        'startAsInitiator: this session is already authenticated - use migrateToLink() to move it to a new link',
      );
    }
    this.attachLink(link);
    // DISCONNECTED -> CONNECTING -> AUTHENTICATING. The machine rejects a jump
    // straight to AUTHENTICATING, and rightly so: a link exists before a
    // handshake does.
    this.stateMachine.transitionTo(ConnectionState.CONNECTING, 'link attached');
    this.stateMachine.transitionTo(ConnectionState.AUTHENTICATING, 'starting handshake');
    this.handshake = new Handshake(HandshakeRole.INITIATOR, this.options.handshake);
    await this.sendHandshake(this.handshake.createInit());
  }

  /**
   * Attach a link and wait for the peer to start the handshake.
   * Called for an incoming connection.
   */
  startAsResponder(link: Link): void {
    if (this.secure) {
      throw new Error(
        'startAsResponder: this session is already authenticated - use migrateToLink() to move it to a new link',
      );
    }
    this.attachLink(link);
    this.stateMachine.transitionTo(ConnectionState.CONNECTING, 'link attached');
    this.stateMachine.transitionTo(ConnectionState.AUTHENTICATING, 'awaiting handshake');
    this.handshake = new Handshake(HandshakeRole.RESPONDER, this.options.handshake);
  }

  /**
   * Replace the link carrying an already-authenticated session.
   *
   * This is the transport upgrade path (Bluetooth to Wi-Fi) and the reconnect
   * path. Keys, sequence numbers and queued messages all survive; the peer sees
   * only a brief pause.
   */
  migrateToLink(link: Link): void {
    if (!this.secure) throw new Error('migrateToLink: no established session to migrate');
    const previous = this.link?.id ?? null;
    this.detachLink();
    this.attachLink(link);
    this.reassembler.reset();
    this.reliable.resume();
    this.bulk.resume();
    this.stateMachine.transitionTo(ConnectionState.CONNECTED, 'transport migrated');
    this.startKeepalive();
    this.events.emit('transportChanged', {
      from: previous,
      to: link.id,
      isHighBandwidth: link.isHighBandwidth,
    });
    this.log.info('migrated to a new link', { link: link.id, transport: link.transport });
  }

  /**
   * Confirm (or reject) a first-meeting pairing after the user has compared the
   * six-digit code.
   */
  confirmPairing(accepted: boolean): void {
    if (!this.confirmationPending) return;
    this.confirmationPending = false;
    if (!accepted) {
      void this.close('pairing rejected by user');
      return;
    }
    this.stateMachine.transitionTo(ConnectionState.CONNECTED, 'pairing confirmed');
    this.startKeepalive();
  }

  /** Send a CBOR message with guaranteed, ordered delivery. */
  sendReliable(messageType: number, value: CborValue, options: { bulk?: boolean } = {}): number {
    return this.enqueueReliable(messageType, encodeCbor(value), 0, options);
  }

  /** Send raw bytes with guaranteed, ordered delivery (file chunks, game state). */
  sendReliableRaw(messageType: number, payload: Uint8Array, options: { bulk?: boolean } = {}): number {
    return this.enqueueReliable(messageType, payload, EnvelopeFlags.RAW_PAYLOAD, options);
  }

  private enqueueReliable(
    messageType: number,
    payload: Uint8Array,
    flags: number,
    options: { bulk?: boolean },
  ): number {
    this.assertUsable();
    if (payload.length > this.maxPayloadBytes) {
      throw new Error(`payload of ${payload.length} bytes exceeds the peer's limit of ${this.maxPayloadBytes}`);
    }
    const channel = options.bulk ? this.bulk : this.reliable;
    return channel.send(messageType, payload, flags);
  }

  /**
   * Send best-effort. Superseded by any later message sharing `coalesceKey`,
   * which is what keeps a congested link showing current game state rather than
   * a backlog of stale frames.
   */
  sendRealtime(messageType: number, payload: Uint8Array, coalesceKey?: string): void {
    this.assertUsable();
    this.realtime.send(messageType, payload, coalesceKey);
  }

  /** Like sendControl, but resolves once the bytes have reached the transport. */
  private async sendControlAndFlush(messageType: number, value: CborValue): Promise<void> {
    if (!this.secure) return;
    await this.writeEnvelope(
      {
        channel: Channel.CONTROL,
        flags: EnvelopeFlags.NONE,
        seq: 0,
        ...this.reliable.ackState(),
        messageType,
        timestamp: this.options.clock.wallNow(),
        payload: encodeCbor(value),
      },
      true,
    );
  }

  /** Send a control message. Not retried; used for liveness and negotiation. */
  sendControl(messageType: number, value: CborValue): void {
    if (!this.secure) return;
    this.writeEnvelope({
      channel: Channel.CONTROL,
      flags: EnvelopeFlags.NONE,
      seq: 0,
      ...this.reliable.ackState(),
      messageType,
      timestamp: this.options.clock.wallNow(),
      payload: encodeCbor(value),
    });
  }

  async close(reason = 'closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.secure) {
      try {
        // Await the write: detaching the link a microtask later would otherwise
        // cancel the goodbye and leave the peer waiting for a liveness timeout.
        await this.sendControlAndFlush(MessageType.BYE, { r: reason.slice(0, 80) });
      } catch {
        // The link may already be gone; closing must never throw.
      }
    }
    this.stopKeepalive();
    this.reliable.dispose();
    this.bulk.dispose();
    this.clockSync.dispose();
    this.detachLink();
    this.secure?.destroy();
    this.secure = null;
    this.stateMachine.transitionTo(ConnectionState.DISCONNECTED, reason);
    this.stateMachine.dispose();
    this.events.emit('closed', { reason });
    this.events.removeAllListeners();
  }

  /** Snapshot for Developer Mode. */
  diagnostics(): Record<string, unknown> {
    return {
      peerHandle: this.peerHandle,
      peerId: this.peerId,
      state: this.state,
      transport: this.link?.transport ?? null,
      linkId: this.link?.id ?? null,
      maxDatagramSize: this.link?.maxDatagramSize ?? null,
      isHighBandwidth: this.isHighBandwidth,
      encryption: this.secure ? this.secure.algorithm : 'none',
      protocolVersion: this.result?.negotiatedProtocolVersion ?? PROTOCOL_VERSION,
      sessionId: this.secure ? Array.from(this.secure.sessionId) : null,
      packetsSent: this.secure?.packetsSent ?? 0,
      packetsReceived: this.secure?.packetsReceived ?? 0,
      packetsRejected: this.secure?.packetsRejected ?? 0,
      packetsDropped: this.packetsDropped,
      malformedPackets: this.malformedPackets,
      reliableInFlight: this.reliable.inFlightCount,
      reliableQueued: this.reliable.queuedCount,
      bulkInFlight: this.bulk.inFlightCount,
      rttMs: this.reliable.smoothedRttMs,
      rtoMs: this.reliable.currentRtoMs,
      clockOffsetMs: this.clockSync.offsetMs,
      linkMetrics: this.link?.metrics() ?? null,
    };
  }

  // -- link plumbing ---------------------------------------------------------

  private attachLink(link: Link): void {
    this.link = link;
    this.lastInboundAt = this.options.clock.now();
    this.applyLinkPacing(link);
    this.linkUnsubscribers = [
      link.events.on('data', ({ bytes }) => this.handleDatagram(bytes)),
      link.events.on('state', ({ state, reason }) => this.handleLinkState(state, reason)),
      link.events.on('mtu', () => {
        this.log.debug('link MTU changed', { mtu: link.maxDatagramSize });
        this.applyLinkPacing(link);
      }),
    ];
  }

  /**
   * Tell the reliability layer how fast the link is.
   *
   * Without this the retransmission timer is pure round-trip time, which is
   * badly wrong on Bluetooth: a 4 KB message fragmented across a 180-byte MTU
   * spends over a hundred milliseconds simply being transmitted, so a timer
   * that ignores transmission time fires while the packet is still going out
   * and floods an already-saturated link with duplicates.
   *
   * Where the transport reports real measured throughput we use it; otherwise
   * we estimate from the MTU, which at least distinguishes a Bluetooth link
   * from a Wi-Fi one by two orders of magnitude.
   */
  private applyLinkPacing(link: Link): void {
    const measured = link.metrics().throughputBytesPerSecond;
    const estimated = link.isHighBandwidth ? 2_000_000 : 20_000;
    const throughput = measured !== undefined && measured > 0 ? measured : estimated;
    this.reliable.setLinkThroughput(throughput);
    this.bulk.setLinkThroughput(throughput);
  }

  private detachLink(): void {
    for (const off of this.linkUnsubscribers) off();
    this.linkUnsubscribers = [];
    const link = this.link;
    this.link = null;
    if (link && link.state !== LinkState.CLOSED) void link.close('detached').catch(() => undefined);
  }

  private handleLinkState(state: LinkState, reason?: string): void {
    if (state !== LinkState.CLOSED && state !== LinkState.FAILED) return;
    if (this.closed) return;

    this.reliable.pause();
    this.bulk.pause();
    this.stopKeepalive();

    if (this.secure) {
      // Keys survive: this is a reconnect, not a teardown.
      this.stateMachine.transitionTo(ConnectionState.RECONNECTING, reason ?? 'link lost');
      this.log.info('link lost, session retained for reconnect', { reason });
    } else {
      this.stateMachine.transitionTo(ConnectionState.FAILED, reason ?? 'link lost before authentication');
    }
  }

  // -- outbound --------------------------------------------------------------

  private async sendHandshake(body: Uint8Array): Promise<void> {
    const link = this.link;
    if (!link) throw new Error('sendHandshake: no link attached');
    const frame = encodeHandshakeFrame(body);
    await this.writeFrame(link, frame, SendMode.RELIABLE);
  }

  private transmitReliable(
    channel: Channel,
    record: { seq: number; payload: Uint8Array; messageType: number; flags: number },
    isRetransmit: boolean,
  ): void {
    this.writeEnvelope({
      channel,
      flags: EnvelopeFlags.NEEDS_ACK | record.flags | (isRetransmit ? EnvelopeFlags.RETRANSMIT : 0),
      seq: record.seq,
      ...this.reliable.ackState(),
      messageType: record.messageType,
      timestamp: this.options.clock.wallNow(),
      payload: record.payload,
    });
  }

  private writeEnvelope(envelope: Envelope): void;
  private writeEnvelope(envelope: Envelope, awaitFlush: true): Promise<void>;
  private writeEnvelope(envelope: Envelope, awaitFlush = false): Promise<void> | void {
    const secure = this.secure;
    const link = this.link;
    if (!secure || !link || link.state !== LinkState.CONNECTED) {
      this.packetsDropped++;
      return awaitFlush ? Promise.resolve() : undefined;
    }
    let frame: Uint8Array;
    try {
      const plaintext = encodeEnvelope(envelope);
      frame = encodeSecureFrame(secure.sessionId, secure.nextSendCounter, plaintext, (pt, aad) => {
        return secure.seal(pt, aad).ciphertext;
      });
    } catch (err) {
      // Encoding our OWN outbound frame can only fail because of a bug on this
      // side, never because of anything a peer sent. Loud, and counted.
      this.packetsDropped++;
      this.log.error('failed to encode an outbound frame', {
        messageType: messageTypeName(envelope.messageType),
        channel: envelope.channel,
        err: String(err),
      });
      return awaitFlush ? Promise.resolve() : undefined;
    }
    const mode = envelope.channel === Channel.REALTIME ? SendMode.REALTIME : SendMode.RELIABLE;
    // Realtime traffic is deliberately NOT queued behind bulk: a paddle position
    // that waits for a file chunk is worse than useless. It fits in one datagram
    // by construction, so it cannot interleave with anything.
    const promise =
      mode === SendMode.REALTIME
        ? this.writeFrame(link, frame, mode)
        : this.enqueueWrite(() => this.writeFrame(link, frame, mode));

    const guarded = promise.catch((err: unknown) => {
      this.packetsDropped++;
      this.log.debug('send failed', { err: String(err) });
    });
    if (awaitFlush) return guarded;
    void guarded;
    return undefined;
  }

  /** Run `task` after every previously queued write has finished. */
  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task, task);
    // Keep the chain alive after a failure; one dropped frame must not wedge
    // every frame behind it.
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async writeFrame(link: Link, frame: Uint8Array, mode: SendMode): Promise<void> {
    if (frame.length <= link.maxDatagramSize) {
      await link.send(frame, mode);
      return;
    }
    const packetId = this.nextFragmentPacketId;
    this.nextFragmentPacketId = (this.nextFragmentPacketId + 1) & 0xffff || 1;
    for (const piece of fragmentFrame(frame, link.maxDatagramSize, packetId)) {
      await link.send(piece, mode);
    }
  }

  // -- inbound ---------------------------------------------------------------

  private handleDatagram(bytes: Uint8Array): void {
    if (this.closed) return;
    this.lastInboundAt = this.options.clock.now();
    try {
      const frame = decodeFrame(bytes);
      switch (frame.kind) {
        case FrameType.FRAGMENT: {
          const complete = this.reassembler.push(frame, this.options.clock.now());
          if (complete) this.handleDatagram(complete);
          return;
        }
        case FrameType.HANDSHAKE:
          this.handleHandshakeFrame(frame.body);
          return;
        case FrameType.SECURE:
          this.handleSecureFrame(frame.sessionId, frame.counter, frame.ciphertext, frame.aad);
          return;
        case FrameType.BEACON:
          // Beacons carry no session data and are ignored on an open link.
          return;
        default:
          return;
      }
    } catch (err) {
      this.malformedPackets++;
      if (err instanceof HandshakeError) {
        this.events.emit('error', {
          code: ProtocolErrorCode.AUTHENTICATION_FAILED,
          message: err.message,
          fatal: true,
        });
        this.stateMachine.transitionTo(ConnectionState.FAILED, err.message);
        return;
      }
      if (err instanceof DecodeError) {
        // A malformed packet is dropped, never fatal: the radio, not the peer,
        // is the likeliest culprit.
        this.log.debug('dropped malformed packet', { err: err.message });
        return;
      }
      this.log.error('unexpected error handling packet', { err: String(err) });
    }
  }

  private handleHandshakeFrame(bodyBytes: Uint8Array): void {
    const hs = this.handshake;
    if (!hs) {
      this.log.debug('handshake frame with no handshake in progress');
      return;
    }
    if (hs.role === HandshakeRole.RESPONDER) {
      switch (hs.currentPhase) {
        case 'idle': {
          const response = hs.readInitAndCreateResponse(bodyBytes);
          void this.sendHandshake(response).then(() => this.sendHandshake(hs.createResponderAuth()));
          return;
        }
        case 'sentAuth': {
          this.completeHandshake(hs.readInitiatorAuth(bodyBytes));
          return;
        }
        default:
          this.log.debug('unexpected handshake frame', { phase: hs.currentPhase });
          return;
      }
    }
    switch (hs.currentPhase) {
      case 'sentInit':
        hs.readResponse(bodyBytes);
        return;
      case 'sentResponse': {
        const { message, result } = hs.readResponderAuthAndCreateAuth(bodyBytes);
        void this.sendHandshake(message);
        this.completeHandshake(result);
        return;
      }
      default:
        this.log.debug('unexpected handshake frame', { phase: hs.currentPhase });
    }
  }

  private completeHandshake(result: HandshakeResult): void {
    this.result = result;
    this.secure = new SecureSession(result.keys);
    this.handshake = null;

    const requiresConfirmation = !result.recognisedFromTrustStore;
    this.confirmationPending = requiresConfirmation;

    this.events.emit('authenticated', {
      peerId: result.peerId,
      capabilities: result.peerCapabilities,
      requiresConfirmation,
      sasCode: deriveSasCode(result.sasCodeSeed),
      identityKey: result.peerIdentityKey,
    });

    if (requiresConfirmation) {
      this.stateMachine.transitionTo(ConnectionState.PAIRING, 'awaiting six-digit confirmation');
      return;
    }
    this.stateMachine.transitionTo(ConnectionState.CONNECTED, 'authenticated from trust store');
    this.reliable.resume();
    this.bulk.resume();
    this.startKeepalive();
    if (this.link) {
      this.events.emit('transportChanged', {
        from: null,
        to: this.link.id,
        isHighBandwidth: this.link.isHighBandwidth,
      });
    }
  }

  private handleSecureFrame(sessionId: Uint8Array, counter: number, ciphertext: Uint8Array, aad: Uint8Array): void {
    const secure = this.secure;
    if (!secure) {
      this.packetsDropped++;
      return;
    }
    // Session id mismatch means the packet belongs to a different session.
    for (let i = 0; i < sessionId.length; i++) {
      if (sessionId[i] !== secure.sessionId[i]) {
        this.packetsDropped++;
        return;
      }
    }
    const plaintext = secure.open(ciphertext, aad, counter);
    if (plaintext === null) {
      // Replay, forgery or corruption. Indistinguishable by design.
      this.packetsDropped++;
      return;
    }

    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(plaintext);
    } catch (err) {
      this.malformedPackets++;
      this.log.debug('malformed envelope inside an authenticated packet', { err: String(err) });
      return;
    }
    this.processEnvelope(envelope);
  }

  private processEnvelope(envelope: Envelope): void {
    // Piggybacked acknowledgements apply regardless of the message type - but
    // ONLY to the RELIABLE channel, which is the one they are computed from.
    //
    // An explicit ACK message names the channel it refers to, so it must be
    // excluded here and routed in handleControlMessage instead: feeding BULK's
    // watermark to the reliable channel would acknowledge chat messages the peer
    // has never seen.
    const isExplicitAck = envelope.channel === Channel.CONTROL && envelope.messageType === MessageType.ACK;
    if (!isExplicitAck && (envelope.channel === Channel.RELIABLE || envelope.channel === Channel.CONTROL)) {
      this.reliable.handleAck(envelope.ack, envelope.ackBits);
    }

    switch (envelope.channel) {
      case Channel.CONTROL:
        this.handleControlMessage(envelope);
        return;

      case Channel.REALTIME:
        this.deliver(envelope, envelope.payload);
        return;

      case Channel.RELIABLE:
      case Channel.BULK: {
        const channel = envelope.channel === Channel.BULK ? this.bulk : this.reliable;
        const ready = channel.receive(envelope.seq, envelope.payload);
        // Acknowledge even a duplicate: the peer's ACK may have been the loss.
        this.sendAck(envelope.channel);
        for (const payload of ready) this.deliver(envelope, payload);
        return;
      }

      default:
        return;
    }
  }

  private sendAck(channel: Channel): void {
    const source = channel === Channel.BULK ? this.bulk : this.reliable;
    const { ack, ackBits } = source.ackState();
    this.writeEnvelope({
      channel: Channel.CONTROL,
      flags: EnvelopeFlags.NONE,
      seq: 0,
      ack,
      ackBits,
      messageType: MessageType.ACK,
      timestamp: this.options.clock.wallNow(),
      payload: encodeCbor({ c: channel }),
    });
  }

  private handleControlMessage(envelope: Envelope): void {
    switch (envelope.messageType) {
      case MessageType.ACK: {
        // Route the acknowledgement to whichever channel it refers to.
        try {
          const value = decodeCbor(envelope.payload);
          const channel =
            value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
              ? (value as Record<string, CborValue>).c
              : undefined;
          if (channel === Channel.BULK) this.bulk.handleAck(envelope.ack, envelope.ackBits);
          else if (channel === Channel.RELIABLE) this.reliable.handleAck(envelope.ack, envelope.ackBits);
        } catch {
          // A malformed ACK simply does not acknowledge anything.
        }
        return;
      }
      case MessageType.PING:
        this.writeEnvelope({
          channel: Channel.CONTROL,
          flags: EnvelopeFlags.NONE,
          seq: 0,
          ...this.reliable.ackState(),
          messageType: MessageType.PONG,
          timestamp: this.options.clock.wallNow(),
          payload: envelope.payload,
        });
        return;
      case MessageType.PONG:
        return;
      case MessageType.KEEPALIVE:
        return;
      case MessageType.CLOCK_SYNC_REQUEST: {
        const reply = this.clockSync.buildResponse(envelope.payload);
        if (reply) this.sendControl(MessageType.CLOCK_SYNC_RESPONSE, reply);
        return;
      }
      case MessageType.CLOCK_SYNC_RESPONSE:
        this.clockSync.handleResponse(envelope.payload);
        return;
      case MessageType.BYE:
        void this.close('peer said goodbye');
        return;
      case MessageType.ERROR: {
        try {
          const value = decodeCbor(envelope.payload) as Record<string, CborValue>;
          this.events.emit('error', {
            code: typeof value.c === 'number' ? value.c : ProtocolErrorCode.UNKNOWN,
            message: typeof value.m === 'string' ? value.m : 'peer reported an error',
            fatal: value.f === true,
          });
        } catch {
          // ignore a malformed error report
        }
        return;
      }
      default:
        this.deliver(envelope, envelope.payload);
    }
  }

  private deliver(envelope: Envelope, payload: Uint8Array): void {
    if (!isKnownMessageType(envelope.messageType)) {
      // A newer peer may send message types this build has never heard of.
      // Ignoring them is what makes the protocol forward compatible.
      this.log.debug('ignoring unknown message type', { type: envelope.messageType });
      return;
    }
    let value: CborValue | null = null;
    if ((envelope.flags & EnvelopeFlags.RAW_PAYLOAD) === 0) {
      try {
        value = decodeCbor(payload);
      } catch (err) {
        this.malformedPackets++;
        this.log.debug('malformed payload', { type: messageTypeName(envelope.messageType), err: String(err) });
        return;
      }
    }
    const message: IncomingMessage = {
      type: envelope.messageType,
      typeName: messageTypeName(envelope.messageType),
      channel: envelope.channel,
      value,
      raw: payload,
      remoteTimestamp: envelope.timestamp,
      receivedAt: this.options.clock.wallNow(),
      seq: envelope.seq,
      ...(envelope.senderId !== undefined ? { senderId: envelope.senderId } : {}),
    };
    this.events.emit('message', message);
  }

  // -- liveness --------------------------------------------------------------

  private startKeepalive(): void {
    this.stopKeepalive();
    const interval = this.options.keepaliveIntervalMs ?? TIMING.keepaliveIntervalMs;
    const timeout = this.options.livenessTimeoutMs ?? TIMING.livenessTimeoutMs;
    this.lastInboundAt = this.options.clock.now();

    this.keepaliveTimer = this.options.clock.setInterval(() => {
      if (!this.secure || !this.link || this.link.state !== LinkState.CONNECTED) return;
      this.writeEnvelope({
        channel: Channel.CONTROL,
        flags: EnvelopeFlags.NONE,
        seq: 0,
        ...this.reliable.ackState(),
        messageType: MessageType.KEEPALIVE,
        timestamp: this.options.clock.wallNow(),
        payload: new Uint8Array(0),
      });
    }, interval);

    this.livenessTimer = this.options.clock.setInterval(() => {
      if (this.options.clock.now() - this.lastInboundAt <= timeout) return;
      this.log.warn('no traffic from peer within the liveness window');
      this.stopKeepalive();
      this.reliable.pause();
      this.bulk.pause();
      this.stateMachine.transitionTo(ConnectionState.RECONNECTING, 'peer stopped responding');
    }, Math.max(1000, Math.floor(timeout / 3)));
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== undefined) {
      this.options.clock.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    if (this.livenessTimer !== undefined) {
      this.options.clock.clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
  }

  private assertUsable(): void {
    if (this.closed) throw new Error('PeerSession: session is closed');
    if (!this.secure) throw new Error('PeerSession: no secure session established');
    if (this.confirmationPending) throw new Error('PeerSession: waiting for the user to confirm the pairing code');
  }
}
