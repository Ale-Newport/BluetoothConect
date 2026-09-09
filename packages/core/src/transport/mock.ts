/**
 * In-process transport used by tests, the network harness and the simulator.
 *
 * This is the single most valuable piece of test infrastructure in the project:
 * it lets the entire stack - handshake, reliability, chat, games, file transfer,
 * watch-together - be exercised deterministically with N simulated devices, no
 * radios, no phones, and in milliseconds of virtual time.
 *
 * It can reproduce every condition a real radio inflicts:
 *   latency (with jitter), packet loss, reordering, duplication, bandwidth
 *   limits, MTU limits, abrupt disconnection and reconnection.
 */
import { TransportKind } from '../protocol/capabilities.js';
import { TypedEmitter } from '../util/emitter.js';
import { toHex } from '../util/bytes.js';
import type { Clock, TimerHandle } from '../util/time.js';
import { systemClock } from '../util/time.js';
import {
  LinkState,
  SendMode,
  type AdvertisementRecord,
  type ConnectOptions,
  type DiscoveredPeer,
  type Link,
  type LinkEvents,
  type LinkMetrics,
  type Transport,
  type TransportAvailability,
  type TransportEvents,
  type TransportProfile,
} from './types.js';

export interface NetworkConditions {
  /** One-way latency in milliseconds. */
  latencyMs: number;
  /** Random extra latency, 0..jitterMs, applied per datagram. */
  jitterMs: number;
  /** Probability in [0,1] that a REALTIME datagram is dropped. */
  realtimeLossRate: number;
  /**
   * Probability in [0,1] that a RELIABLE datagram is dropped. Real BLE GATT and
   * TCP do not lose data mid-connection, so this defaults to 0; raise it to
   * prove the reliability layer copes anyway.
   */
  reliableLossRate: number;
  /** Probability in [0,1] that a datagram is delivered out of order. */
  reorderRate: number;
  /** Probability in [0,1] that a datagram is delivered twice. */
  duplicateRate: number;
  /** Sustained bandwidth cap in bytes per second. Infinity disables the cap. */
  bandwidthBytesPerSecond: number;
  /** Largest datagram this link accepts. */
  maxDatagramSize: number;
}

export const PERFECT_CONDITIONS: NetworkConditions = {
  latencyMs: 1,
  jitterMs: 0,
  realtimeLossRate: 0,
  reliableLossRate: 0,
  reorderRate: 0,
  duplicateRate: 0,
  bandwidthBytesPerSecond: Number.POSITIVE_INFINITY,
  maxDatagramSize: 64 * 1024,
};

/** Roughly what a good BLE GATT link behaves like on modern hardware. */
export const BLE_LIKE_CONDITIONS: NetworkConditions = {
  latencyMs: 30,
  jitterMs: 20,
  realtimeLossRate: 0.01,
  reliableLossRate: 0,
  reorderRate: 0,
  duplicateRate: 0,
  bandwidthBytesPerSecond: 40_000,
  maxDatagramSize: 180,
};

/** Roughly what a local Wi-Fi TCP link behaves like. */
export const WIFI_LIKE_CONDITIONS: NetworkConditions = {
  latencyMs: 4,
  jitterMs: 3,
  realtimeLossRate: 0.002,
  reliableLossRate: 0,
  reorderRate: 0,
  duplicateRate: 0,
  bandwidthBytesPerSecond: 4_000_000,
  maxDatagramSize: 16 * 1024,
};

/** A deliberately hostile link, for proving the stack never corrupts state. */
export const HOSTILE_CONDITIONS: NetworkConditions = {
  latencyMs: 120,
  jitterMs: 180,
  realtimeLossRate: 0.25,
  reliableLossRate: 0.15,
  reorderRate: 0.2,
  duplicateRate: 0.1,
  bandwidthBytesPerSecond: 8_000,
  maxDatagramSize: 160,
};

let linkCounter = 0;

interface PendingDelivery {
  at: number;
  seqTag: number;
  bytes: Uint8Array;
}

class MockLink implements Link {
  readonly id: string;
  readonly transport = TransportKind.MOCK;
  readonly events = new TypedEmitter<LinkEvents>();

  private linkState: LinkState = LinkState.CONNECTING;
  private peerLink: MockLink | undefined;
  private queue: PendingDelivery[] = [];
  private timer: TimerHandle | undefined;
  private nextTag = 0;
  private bandwidthAvailableAt = 0;

  packetsSent = 0;
  packetsReceived = 0;
  packetsDropped = 0;
  bytesSent = 0;
  bytesReceived = 0;

  constructor(
    readonly endpointId: string,
    private conditions: NetworkConditions,
    private readonly clock: Clock,
    private readonly rng: () => number,
    readonly isHighBandwidth: boolean,
  ) {
    this.id = `mock-link-${++linkCounter}`;
  }

  get state(): LinkState {
    return this.linkState;
  }

  get maxDatagramSize(): number {
    return this.conditions.maxDatagramSize;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Wire two half-links together and bring both up. */
  static pair(a: MockLink, b: MockLink): void {
    a.peerLink = b;
    b.peerLink = a;
    a.setState(LinkState.CONNECTED);
    b.setState(LinkState.CONNECTED);
  }

  setConditions(next: Partial<NetworkConditions>): void {
    const previousMtu = this.conditions.maxDatagramSize;
    this.conditions = { ...this.conditions, ...next };
    if (this.conditions.maxDatagramSize !== previousMtu) {
      this.events.emit('mtu', { maxDatagramSize: this.conditions.maxDatagramSize });
    }
  }

  private setState(state: LinkState, reason?: string): void {
    if (this.linkState === state) return;
    this.linkState = state;
    // Deliver asynchronously so callers never see a re-entrant state change.
    this.clock.setTimeout(() => {
      this.events.emit('state', reason !== undefined ? { state, reason } : { state });
    }, 0);
  }

  async send(bytes: Uint8Array, mode: SendMode): Promise<void> {
    if (this.linkState !== LinkState.CONNECTED) {
      throw new Error(`MockLink.send: link is ${this.linkState}`);
    }
    if (bytes.length > this.conditions.maxDatagramSize) {
      throw new Error(`MockLink.send: ${bytes.length} bytes exceeds MTU ${this.conditions.maxDatagramSize}`);
    }
    const peer = this.peerLink;
    if (!peer) throw new Error('MockLink.send: not paired');

    this.packetsSent++;
    this.bytesSent += bytes.length;

    const lossRate = mode === SendMode.REALTIME ? this.conditions.realtimeLossRate : this.conditions.reliableLossRate;
    if (this.rng() < lossRate) {
      this.packetsDropped++;
      return;
    }

    // Bandwidth shaping: each byte occupies the link for a slice of time.
    const now = this.clock.now();
    const transmitMs =
      this.conditions.bandwidthBytesPerSecond === Number.POSITIVE_INFINITY
        ? 0
        : (bytes.length / this.conditions.bandwidthBytesPerSecond) * 1000;
    const startAt = Math.max(now, this.bandwidthAvailableAt);
    this.bandwidthAvailableAt = startAt + transmitMs;

    let arriveAt = this.bandwidthAvailableAt + this.conditions.latencyMs + this.rng() * this.conditions.jitterMs;
    if (this.rng() < this.conditions.reorderRate) {
      arriveAt += this.conditions.latencyMs + this.conditions.jitterMs;
    }

    // Copy: the caller may reuse its buffer immediately after send() resolves.
    const copy = bytes.slice();
    peer.enqueue({ at: arriveAt, seqTag: this.nextTag++, bytes: copy });
    if (this.rng() < this.conditions.duplicateRate) {
      peer.enqueue({ at: arriveAt + 1, seqTag: this.nextTag++, bytes: copy.slice() });
    }
  }

  private enqueue(delivery: PendingDelivery): void {
    this.queue.push(delivery);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined || this.queue.length === 0) return;
    let earliest = Infinity;
    for (const d of this.queue) earliest = Math.min(earliest, d.at);
    const delay = Math.max(0, earliest - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delay);
  }

  private flush(): void {
    const now = this.clock.now();
    const due = this.queue.filter((d) => d.at <= now).sort((x, y) => x.at - y.at || x.seqTag - y.seqTag);
    this.queue = this.queue.filter((d) => d.at > now);
    for (const d of due) {
      if (this.linkState !== LinkState.CONNECTED) break;
      this.packetsReceived++;
      this.bytesReceived += d.bytes.length;
      this.events.emit('data', { bytes: d.bytes });
    }
    this.scheduleFlush();
  }

  /**
   * Deliver everything already in flight right now. Used by a graceful close so
   * a goodbye packet is not thrown away by the teardown that follows it.
   */
  flushImmediately(): void {
    for (const d of this.queue) d.at = this.clock.now();
    this.flush();
  }

  /** Sever the link abruptly, as a radio going out of range would. */
  drop(reason = 'peer went out of range'): void {
    if (this.linkState === LinkState.CLOSED) return;
    this.queue = [];
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const peer = this.peerLink;
    this.peerLink = undefined;
    this.setState(LinkState.CLOSED, reason);
    if (peer) peer.drop(reason);
  }

  metrics(): LinkMetrics {
    return {
      transport: TransportKind.MOCK,
      maxDatagramSize: this.conditions.maxDatagramSize,
      rttMs: this.conditions.latencyMs * 2,
      throughputBytesPerSecond:
        this.conditions.bandwidthBytesPerSecond === Number.POSITIVE_INFINITY
          ? undefined
          : this.conditions.bandwidthBytesPerSecond,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      packetsDropped: this.packetsDropped,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
    };
  }

  /**
   * Graceful close. In-flight bytes are delivered before the link goes down -
   * the same courtesy a TCP FIN gives, and what BLE gives in practice when the
   * app closes a connection rather than walking out of range.
   */
  async close(reason = 'closed locally'): Promise<void> {
    this.peerLink?.flushImmediately();
    this.drop(reason);
  }
}

const MOCK_PROFILE: TransportProfile = {
  kind: TransportKind.MOCK,
  preference: 0,
  expectedThroughputBytesPerSecond: 1_000_000,
  expectedRttMs: 5,
  highBandwidth: true,
  canDiscover: true,
  crossPlatform: true,
  worksInBackground: true,
};

/**
 * A simulated network. Register devices with `createTransport`, then let them
 * discover and connect to one another exactly as they would over a radio.
 */
export class MockNetwork {
  private readonly transports = new Map<string, MockTransport>();
  private conditions: NetworkConditions = { ...PERFECT_CONDITIONS };
  private rngState: number;
  /** Endpoint pairs that cannot see or reach each other (out of range). */
  private readonly partitions = new Set<string>();

  constructor(
    readonly clock: Clock = systemClock,
    seed = 0x5eed,
  ) {
    this.rngState = seed >>> 0 || 1;
  }

  /** Deterministic PRNG so a failing test reproduces exactly. */
  readonly random = (): number => {
    this.rngState ^= this.rngState << 13;
    this.rngState ^= this.rngState >>> 17;
    this.rngState ^= this.rngState << 5;
    this.rngState >>>= 0;
    return this.rngState / 0x1_0000_0000;
  };

  setConditions(next: Partial<NetworkConditions>): void {
    this.conditions = { ...this.conditions, ...next };
    for (const t of this.transports.values()) t.applyConditions(next);
  }

  get currentConditions(): NetworkConditions {
    return { ...this.conditions };
  }

  createTransport(endpointId: string, options: { highBandwidth?: boolean } = {}): MockTransport {
    if (this.transports.has(endpointId)) throw new Error(`MockNetwork: duplicate endpoint ${endpointId}`);
    const transport = new MockTransport(endpointId, this, options.highBandwidth ?? true);
    this.transports.set(endpointId, transport);
    return transport;
  }

  removeTransport(endpointId: string): void {
    this.transports.delete(endpointId);
    for (const t of this.transports.values()) t.notifyPeerLost(endpointId);
  }

  private partitionKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /** Put two endpoints out of range of each other. */
  partition(a: string, b: string): void {
    this.partitions.add(this.partitionKey(a, b));
    this.transports.get(a)?.dropLinksTo(b, 'out of range');
    this.transports.get(b)?.dropLinksTo(a, 'out of range');
    this.transports.get(a)?.notifyPeerLost(b);
    this.transports.get(b)?.notifyPeerLost(a);
  }

  heal(a: string, b: string): void {
    this.partitions.delete(this.partitionKey(a, b));
    this.transports.get(a)?.rescan();
    this.transports.get(b)?.rescan();
  }

  canReach(a: string, b: string): boolean {
    return !this.partitions.has(this.partitionKey(a, b));
  }

  /** @internal */
  allTransports(): MockTransport[] {
    return [...this.transports.values()];
  }

  /** @internal */
  find(endpointId: string): MockTransport | undefined {
    return this.transports.get(endpointId);
  }

  /** @internal */
  linkConditions(): NetworkConditions {
    return { ...this.conditions };
  }
}

export class MockTransport implements Transport {
  readonly kind = TransportKind.MOCK;
  readonly profile = MOCK_PROFILE;
  readonly events = new TypedEmitter<TransportEvents>();

  private advertising: AdvertisementRecord | undefined;
  private discovering = false;
  private readonly links = new Map<string, MockLink>();
  private available = true;
  private conditionOverrides: Partial<NetworkConditions> = {};

  constructor(
    readonly endpointId: string,
    private readonly network: MockNetwork,
    private readonly highBandwidth: boolean,
  ) {}

  async availability(): Promise<TransportAvailability> {
    return this.available ? { available: true } : { available: false, reason: 'radioOff' };
  }

  /** Simulate the radio being switched off. */
  setAvailable(available: boolean): void {
    this.available = available;
    this.events.emit('availabilityChanged', {
      availability: available ? { available: true } : { available: false, reason: 'radioOff' },
    });
    if (!available) {
      for (const link of [...this.links.values()]) link.drop('radio turned off');
      this.links.clear();
    }
  }

  applyConditions(next: Partial<NetworkConditions>): void {
    this.conditionOverrides = { ...this.conditionOverrides, ...next };
    for (const link of this.links.values()) link.setConditions(next);
  }

  async startAdvertising(record: AdvertisementRecord): Promise<void> {
    this.advertising = record;
    for (const other of this.network.allTransports()) {
      if (other !== this) other.rescan();
    }
  }

  async stopAdvertising(): Promise<void> {
    this.advertising = undefined;
    for (const other of this.network.allTransports()) {
      if (other !== this) other.notifyPeerLost(this.endpointId);
    }
  }

  async startDiscovery(): Promise<void> {
    this.discovering = true;
    this.rescan();
  }

  async stopDiscovery(): Promise<void> {
    this.discovering = false;
  }

  /** @internal Re-emit peerDiscovered for everything currently advertising. */
  rescan(): void {
    if (!this.discovering || !this.available) return;
    const now = this.network.clock.now();
    for (const other of this.network.allTransports()) {
      if (other === this || !other.advertising || !other.available) continue;
      if (!this.network.canReach(this.endpointId, other.endpointId)) continue;
      const record = other.advertising;
      const peer: DiscoveredPeer = {
        endpointId: other.endpointId,
        transport: TransportKind.MOCK,
        ...(record.displayName !== undefined ? { advertisedName: record.displayName } : {}),
        advertisementToken: record.token,
        rssi: -45,
        discoveredAt: now,
        lastSeenAt: now,
      };
      this.events.emit('peerDiscovered', { peer });
    }
  }

  /** @internal */
  notifyPeerLost(endpointId: string): void {
    this.events.emit('peerLost', { endpointId });
  }

  /** @internal */
  dropLinksTo(endpointId: string, reason: string): void {
    for (const [key, link] of [...this.links]) {
      if (link.endpointId === endpointId) {
        link.drop(reason);
        this.links.delete(key);
      }
    }
  }

  async connect(endpointId: string, options: ConnectOptions = {}): Promise<Link> {
    if (!this.available) throw new Error('MockTransport.connect: radio is off');
    const peer = this.network.find(endpointId);
    if (!peer) throw new Error(`MockTransport.connect: unknown endpoint ${endpointId}`);
    if (!peer.available) throw new Error(`MockTransport.connect: ${endpointId} radio is off`);
    if (!this.network.canReach(this.endpointId, endpointId)) {
      throw new Error(`MockTransport.connect: ${endpointId} is out of range`);
    }

    const conditions = { ...this.network.linkConditions(), ...this.conditionOverrides };
    const local = new MockLink(endpointId, conditions, this.network.clock, this.network.random, this.highBandwidth);
    const remote = new MockLink(
      this.endpointId,
      conditions,
      this.network.clock,
      this.network.random,
      peer.highBandwidth,
    );

    this.links.set(local.id, local);
    peer.links.set(remote.id, remote);

    // Connection setup takes a moment, exactly as a real radio does.
    await new Promise<void>((resolve) => {
      this.network.clock.setTimeout(resolve, Math.max(1, conditions.latencyMs));
    });

    MockLink.pair(local, remote);
    peer.events.emit('incomingLink', { link: remote });

    void options;
    return local;
  }

  /** Number of live links. Useful for leak assertions in tests. */
  get linkCount(): number {
    return [...this.links.values()].filter((l) => l.state === LinkState.CONNECTED).length;
  }

  async shutdown(): Promise<void> {
    for (const link of [...this.links.values()]) link.drop('transport shut down');
    this.links.clear();
    this.advertising = undefined;
    this.discovering = false;
    this.events.removeAllListeners();
  }
}

/** Convenience: a token that identifies a mock device in test output. */
export function mockToken(seed: number): Uint8Array {
  const out = new Uint8Array(6);
  for (let i = 0; i < 6; i++) out[i] = (seed * 31 + i * 7) & 0xff;
  return out;
}

export { toHex as debugHex };
