import { describe, expect, it } from 'vitest';
import { MessageType, PROTOCOL_VERSION } from '../src/protocol/constants.js';
import { TransportKind, type PeerCapabilities } from '../src/protocol/capabilities.js';
import { SeededRandom } from '../src/crypto/random.js';
import { createIdentity, type LocalIdentity } from '../src/crypto/identity.js';
import type { HandshakeConfig } from '../src/crypto/handshake.js';
import { PeerSession, type IncomingMessage } from '../src/session/peerSession.js';
import { ConnectionState } from '../src/session/stateMachine.js';
import {
  BLE_LIKE_CONDITIONS,
  HOSTILE_CONDITIONS,
  MockNetwork,
  WIFI_LIKE_CONDITIONS,
  type MockTransport,
} from '../src/transport/mock.js';
import {
  LinkState,
  type AdvertisementRecord,
  type ConnectOptions,
  type Link,
  type LinkEvents,
  type LinkMetrics,
  type SendMode,
  type Transport,
  type TransportAvailability,
  type TransportEvents,
  type TransportProfile,
} from '../src/transport/types.js';
import { TypedEmitter } from '../src/util/emitter.js';
import { VirtualClock } from '../src/util/time.js';
import {
  CONNECTION_QUALITY_LABEL,
  ConnectionQuality,
  ConnectionQualityTracker,
  DEFAULT_TRANSPORT_PROFILES,
  TransportCapabilityManager,
  TransportUpgradeController,
  UpgradeFailureReason,
  UpgradeState,
  bestCommonTransport,
  classifyConnectionQuality,
  connectionQualityFromLink,
  decodeProbeDatagram,
  defaultProfileFor,
  encodeProbeDatagram,
  isTransportUpgrade,
  isUpgradeInitiator,
  negotiateTransports,
  sanitizeAvailability,
  sanitizeTransportKinds,
  transportScore,
} from '../src/transport/manager.js';

// ---------------------------------------------------------------------------
// Test doubles
//
// MockTransport always reports itself as TransportKind.MOCK, and the whole
// point of this module is choosing BETWEEN kinds. These two thin wrappers give
// a MockTransport a different identity - a slow "BLE" radio and a fast
// "localNetwork" one - without changing a byte of the simulator. They delegate
// everything; only `kind`, `profile` and the reported link metrics differ.
// ---------------------------------------------------------------------------

const SLOW = TransportKind.BLE;
const FAST = TransportKind.LOCAL_NETWORK;

class LabelledLink implements Link {
  constructor(
    readonly transport: TransportKind,
    private readonly inner: Link,
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get endpointId(): string {
    return this.inner.endpointId;
  }
  get state(): LinkState {
    return this.inner.state;
  }
  get maxDatagramSize(): number {
    return this.inner.maxDatagramSize;
  }
  get isHighBandwidth(): boolean {
    return defaultProfileFor(this.transport).highBandwidth;
  }
  get events(): TypedEmitter<LinkEvents> {
    return this.inner.events;
  }
  get queuedCount(): number {
    return this.inner.queuedCount;
  }
  send(bytes: Uint8Array, mode: SendMode): Promise<void> {
    return this.inner.send(bytes, mode);
  }
  metrics(): LinkMetrics {
    return { ...this.inner.metrics(), transport: this.transport };
  }
  close(reason?: string): Promise<void> {
    return this.inner.close(reason);
  }
}

class LabelledTransport implements Transport {
  readonly events = new TypedEmitter<TransportEvents>();
  /** Set to make connect() fail the way a radio that refuses to open does. */
  failConnect = false;
  private available = true;

  constructor(
    readonly kind: TransportKind,
    readonly profile: TransportProfile,
    private readonly inner: MockTransport,
  ) {
    inner.events.on('incomingLink', ({ link }) => {
      this.events.emit('incomingLink', { link: new LabelledLink(this.kind, link) });
    });
    inner.events.on('peerDiscovered', ({ peer }) => {
      this.events.emit('peerDiscovered', { peer: { ...peer, transport: this.kind } });
    });
    inner.events.on('peerLost', (event) => this.events.emit('peerLost', event));
  }

  get endpointId(): string {
    return this.inner.endpointId;
  }

  async availability(): Promise<TransportAvailability> {
    return this.available ? { available: true } : { available: false, reason: 'radioOff' };
  }

  setAvailable(available: boolean): void {
    this.available = available;
    this.events.emit('availabilityChanged', {
      availability: available ? { available: true } : { available: false, reason: 'radioOff' },
    });
  }

  startAdvertising(record: AdvertisementRecord): Promise<void> {
    return this.inner.startAdvertising(record);
  }
  stopAdvertising(): Promise<void> {
    return this.inner.stopAdvertising();
  }
  startDiscovery(): Promise<void> {
    return this.inner.startDiscovery();
  }
  stopDiscovery(): Promise<void> {
    return this.inner.stopDiscovery();
  }
  async connect(endpointId: string, options?: ConnectOptions): Promise<Link> {
    if (this.failConnect) throw new Error(`${this.kind}: the radio refused to open a link`);
    return new LabelledLink(this.kind, await this.inner.connect(endpointId, options));
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Two-peer scenario
// ---------------------------------------------------------------------------

function caps(name: string, deviceId: string): PeerCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '0.1.0',
    platform: 'node',
    deviceModel: 'simulator',
    displayName: name,
    deviceId,
    transports: [SLOW, FAST],
    features: ['chat', 'transportUpgrade'],
    games: [],
    maxPayloadBytes: 65536,
  };
}

interface Device {
  identity: LocalIdentity;
  config: HandshakeConfig;
  trust: Map<string, Uint8Array>;
  random: SeededRandom;
}

function makeDevice(name: string, seed: number): Device {
  const random = new SeededRandom(seed);
  const identity = createIdentity(random, 1000);
  const trust = new Map<string, Uint8Array>();
  return {
    identity,
    random,
    trust,
    config: {
      identity,
      capabilities: caps(name, `device-${name}`),
      random,
      lookupTrustedKey: (peerId) => trust.get(peerId),
    },
  };
}

interface Side {
  readonly name: string;
  readonly device: Device;
  readonly session: PeerSession;
  readonly slow: LabelledTransport;
  readonly fast: LabelledTransport;
  readonly manager: TransportCapabilityManager;
  readonly controller: TransportUpgradeController;
  /** Turn off to simulate an app that never routes the upgrade link anywhere. */
  routeIncoming: boolean;
}

/**
 * Two devices, each with a slow radio and a fast one, already authenticated
 * over the slow one - which is exactly the state a real iPhone/Android pair is
 * in a second after they meet.
 */
async function connectPair(options: { autoUpgrade?: boolean; fastAvailable?: boolean } = {}) {
  const clock = new VirtualClock();
  const network = new MockNetwork(clock, 0xa11);

  const alejandro = makeDevice('Alejandro', 101);
  const maria = makeDevice('Maria', 202);
  alejandro.trust.set(maria.identity.peerId, maria.identity.signing.publicKey);
  maria.trust.set(alejandro.identity.peerId, alejandro.identity.signing.publicKey);

  const inner = {
    aSlow: network.createTransport('a-ble'),
    aFast: network.createTransport('a-wifi'),
    bSlow: network.createTransport('b-ble'),
    bFast: network.createTransport('b-wifi'),
  };
  inner.aSlow.applyConditions(BLE_LIKE_CONDITIONS);
  inner.bSlow.applyConditions(BLE_LIKE_CONDITIONS);
  inner.aFast.applyConditions(WIFI_LIKE_CONDITIONS);
  inner.bFast.applyConditions(WIFI_LIKE_CONDITIONS);

  const sessionA = new PeerSession('b', { clock, handshake: alejandro.config });
  const sessionB = new PeerSession('a', { clock, handshake: maria.config });

  const build = (
    name: string,
    device: Device,
    session: PeerSession,
    slowInner: MockTransport,
    fastInner: MockTransport,
    peerPrefix: string,
  ): Side => {
    const slow = new LabelledTransport(SLOW, DEFAULT_TRANSPORT_PROFILES[SLOW], slowInner);
    const fast = new LabelledTransport(FAST, DEFAULT_TRANSPORT_PROFILES[FAST], fastInner);
    const fastAvailable = options.fastAvailable ?? true;
    if (!fastAvailable) fast.setAvailable(false);
    const manager = new TransportCapabilityManager();
    manager.register(slow, { availability: { available: true } });
    manager.register(fast, { availability: { available: fastAvailable } });

    const controller = new TransportUpgradeController({
      session,
      capabilities: manager,
      clock,
      random: device.random,
      localPeerId: device.identity.peerId,
      resolveEndpoint: (kind) => (kind === SLOW ? `${peerPrefix}-ble` : kind === FAST ? `${peerPrefix}-wifi` : null),
      autoUpgrade: options.autoUpgrade ?? false,
    });

    const side: Side = { name, device, session, slow, fast, manager, controller, routeIncoming: true };

    // Exactly what a real session manager does with an incoming link: offer it
    // to the upgrade controller, and only fall back to a fresh handshake when
    // the controller does not want it.
    const route = ({ link }: { link: Link }): void => {
      if (!side.routeIncoming) return;
      if (controller.handleIncomingLink(link)) return;
      if (session.isSecure) return;
      session.startAsResponder(link);
    };
    slow.events.on('incomingLink', route);
    fast.events.on('incomingLink', route);
    return side;
  };

  const a = build('a', alejandro, sessionA, inner.aSlow, inner.aFast, 'b');
  const b = build('b', maria, sessionB, inner.bSlow, inner.bFast, 'a');

  const connecting = a.slow.connect('b-ble');
  await clock.advanceAsync(200);
  await sessionA.startAsInitiator(await connecting);
  await clock.advanceAsync(3000);

  a.controller.start();
  b.controller.start();
  await clock.advanceAsync(50);

  // Whoever holds the lexicographically smaller peer id dials; both sides work
  // that out on their own, with no round trip.
  const initiator = a.controller.isInitiator ? a : b;
  const responder = initiator === a ? b : a;

  return {
    clock,
    network,
    a,
    b,
    initiator,
    responder,
    /** Make every link on the network hostile, but leave the fast radio usable. */
    degrade(conditions = HOSTILE_CONDITIONS): void {
      network.setConditions(conditions);
      inner.aFast.applyConditions(WIFI_LIKE_CONDITIONS);
      inner.bFast.applyConditions(WIFI_LIKE_CONDITIONS);
    },
  };
}

function collect(session: PeerSession): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  session.events.on('message', (m) => out.push(m));
  return out;
}

function chatIndexes(messages: readonly IncomingMessage[]): number[] {
  return messages.filter((m) => m.type === MessageType.MESSAGE).map((m) => (m.value as { i: number }).i);
}

// ---------------------------------------------------------------------------
// Negotiation - pure logic
// ---------------------------------------------------------------------------

describe('transport negotiation', () => {
  const local = [DEFAULT_TRANSPORT_PROFILES[SLOW], DEFAULT_TRANSPORT_PROFILES[FAST]];

  it('picks the transport both sides support, best first', () => {
    const ranked = negotiateTransports(local, [SLOW, FAST]);
    expect(ranked.map((c) => c.kind)).toEqual([FAST, SLOW]);
  });

  it('returns the runner-up too, so a failed attempt can fall through', () => {
    expect(negotiateTransports(local, [SLOW, FAST])).toHaveLength(2);
  });

  it('never picks a transport the peer cannot do', () => {
    expect(bestCommonTransport(local, [SLOW])?.kind).toBe(SLOW);
    expect(bestCommonTransport(local, [TransportKind.WIFI_DIRECT])).toBeNull();
    expect(bestCommonTransport(local, [])).toBeNull();
    expect(bestCommonTransport(local, undefined)).toBeNull();
  });

  it('only offers something better than what we are already on', () => {
    const better = negotiateTransports(local, [SLOW, FAST], { betterThan: DEFAULT_TRANSPORT_PROFILES[SLOW] });
    expect(better.map((c) => c.kind)).toEqual([FAST]);
    const best = negotiateTransports(local, [SLOW, FAST], { betterThan: DEFAULT_TRANSPORT_PROFILES[FAST] });
    expect(best).toEqual([]);
  });

  it('honours exclusions and the high-bandwidth filter', () => {
    expect(negotiateTransports(local, [SLOW, FAST], { exclude: [FAST] }).map((c) => c.kind)).toEqual([SLOW]);
    expect(negotiateTransports(local, [SLOW, FAST], { requireHighBandwidth: true }).map((c) => c.kind)).toEqual([FAST]);
  });

  it('ranks Wi-Fi Aware below BLE, because it does not work between platforms', () => {
    expect(transportScore(DEFAULT_TRANSPORT_PROFILES[TransportKind.WIFI_AWARE])).toBeLessThan(
      transportScore(DEFAULT_TRANSPORT_PROFILES[SLOW]),
    );
    expect(isTransportUpgrade(DEFAULT_TRANSPORT_PROFILES[SLOW], DEFAULT_TRANSPORT_PROFILES[FAST])).toBe(true);
    expect(isTransportUpgrade(DEFAULT_TRANSPORT_PROFILES[FAST], DEFAULT_TRANSPORT_PROFILES[SLOW])).toBe(false);
  });

  it('bounds, deduplicates and filters a peer-supplied transport list', () => {
    const hostile = [
      ...Array.from({ length: 500 }, () => SLOW),
      FAST,
      'not-a-transport',
      42,
      null,
      { kind: 'ble' },
      ['ble'],
    ];
    // 500 repeats collapse to one entry, the junk is dropped, and the real
    // second transport still survives at the end of the list.
    expect(sanitizeTransportKinds(hostile as unknown[])).toEqual([SLOW, FAST]);
    expect(sanitizeTransportKinds(undefined)).toEqual([]);
    expect(sanitizeTransportKinds('ble' as unknown as unknown[])).toEqual([]);

    // A wall of unknown names cannot crowd out a real transport either, because
    // only recognised kinds count against the cap.
    const padded = [...Array.from({ length: 64 }, (_, i) => `radio-${i}`), FAST];
    expect(sanitizeTransportKinds(padded)).toEqual([FAST]);

    // ...and the cap really does bite once there are more real kinds than we
    // are willing to consider.
    const flood = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? SLOW : FAST));
    expect(sanitizeTransportKinds(flood).length).toBeLessThanOrEqual(16);
  });

  it('does not let a garbage profile make the ranking non-deterministic', () => {
    const broken: TransportProfile = {
      ...DEFAULT_TRANSPORT_PROFILES[FAST],
      preference: Number.NaN,
      expectedThroughputBytesPerSecond: Number.POSITIVE_INFINITY,
      expectedRttMs: Number.NaN,
    };
    expect(Number.isFinite(transportScore(broken))).toBe(true);
    const ranked = negotiateTransports([broken, DEFAULT_TRANSPORT_PROFILES[SLOW]], [SLOW, FAST]);
    expect(ranked.map((c) => c.kind)).toEqual([SLOW, FAST]);
  });
});

// ---------------------------------------------------------------------------
// Capability manager
// ---------------------------------------------------------------------------

describe('TransportCapabilityManager', () => {
  function fixture() {
    const clock = new VirtualClock();
    const network = new MockNetwork(clock, 7);
    const slow = new LabelledTransport(SLOW, DEFAULT_TRANSPORT_PROFILES[SLOW], network.createTransport('x-ble'));
    const fast = new LabelledTransport(FAST, DEFAULT_TRANSPORT_PROFILES[FAST], network.createTransport('x-wifi'));
    const manager = new TransportCapabilityManager();
    return { manager, slow, fast };
  }

  it('answers "what can this device do" as a ranked list', async () => {
    const { manager, slow, fast } = fixture();
    manager.register(slow);
    manager.register(fast);
    await manager.refresh();
    expect(manager.availableKinds()).toEqual([FAST, SLOW]);
    expect(manager.best()?.kind).toBe(FAST);
    expect(manager.rankedTransports().map((s) => s.kind)).toEqual([FAST, SLOW]);
  });

  it('reports nothing usable until a transport has actually been probed', () => {
    const { manager, slow } = fixture();
    manager.register(slow);
    // Optimism here would send the user into a spinner on a radio that is off.
    expect(manager.availableKinds()).toEqual([]);
    expect(manager.isAvailable(SLOW)).toBe(false);
  });

  it('reacts to availabilityChanged when a radio is switched off', async () => {
    const { manager, slow, fast } = fixture();
    manager.register(slow);
    manager.register(fast);
    await manager.refresh();

    const changes: (readonly TransportKind[])[] = [];
    manager.events.on('changed', ({ available }) => changes.push(available));

    fast.setAvailable(false);
    expect(manager.availableKinds()).toEqual([SLOW]);
    expect(manager.availabilityOf(FAST).reason).toBe('radioOff');
    expect(changes[changes.length - 1]).toEqual([SLOW]);

    fast.setAvailable(true);
    expect(manager.availableKinds()).toEqual([FAST, SLOW]);
  });

  it('refuses a second transport of the same kind', () => {
    const { manager, slow } = fixture();
    manager.register(slow);
    expect(() => manager.register(slow)).toThrow(/already registered/);
  });

  it('forgets a transport that is unregistered', async () => {
    const { manager, slow, fast } = fixture();
    manager.register(slow);
    manager.register(fast);
    await manager.refresh();
    manager.unregister(FAST);
    expect(manager.has(FAST)).toBe(false);
    expect(manager.get(FAST)).toBeUndefined();
    expect(manager.availableKinds()).toEqual([SLOW]);
    // A late event from a transport we no longer hold must change nothing.
    fast.setAvailable(false);
    expect(manager.availableKinds()).toEqual([SLOW]);
  });

  it('treats a malformed availability record from a native bridge as unavailable', () => {
    expect(sanitizeAvailability(undefined).available).toBe(false);
    expect(sanitizeAvailability({ available: 'yes' } as unknown as TransportAvailability).available).toBe(false);
    expect(sanitizeAvailability({ available: false, reason: 'made-up' } as unknown as TransportAvailability).reason).toBe(
      'unknown',
    );
    const long = sanitizeAvailability({ available: false, reason: 'radioOff', detail: 'x'.repeat(9999) });
    expect((long.detail ?? '').length).toBe(200);
    // A reason on an available transport is contradictory, so it is dropped.
    expect(sanitizeAvailability({ available: true, reason: 'radioOff' }).reason).toBeUndefined();
  });

  it('survives a transport whose availability() rejects', async () => {
    const { manager, slow } = fixture();
    const broken = {
      ...slow,
      kind: FAST,
      profile: DEFAULT_TRANSPORT_PROFILES[FAST],
      events: new TypedEmitter<TransportEvents>(),
      availability: () => Promise.reject(new Error('bridge exploded')),
    } as unknown as Transport;
    manager.register(slow, { availability: { available: true } });
    manager.register(broken);
    await manager.refresh();
    expect(manager.availableKinds()).toEqual([SLOW]);
    expect(manager.availabilityOf(FAST).available).toBe(false);
  });

  it('renders a developer-mode snapshot', async () => {
    const { manager, slow, fast } = fixture();
    manager.register(slow);
    manager.register(fast);
    await manager.refresh();
    const d = manager.diagnostics();
    expect(d.registered).toBe(2);
    expect(d.available).toEqual([FAST, SLOW]);
  });
});

// ---------------------------------------------------------------------------
// Connection quality
// ---------------------------------------------------------------------------

describe('ConnectionQuality', () => {
  it('shows four labels and never a number', () => {
    expect(Object.values(ConnectionQuality)).toEqual(['excellent', 'good', 'weak', 'reconnecting']);
    expect(CONNECTION_QUALITY_LABEL[ConnectionQuality.WEAK]).toBe('Weak');
  });

  it('calls a clean fast link excellent', () => {
    expect(classifyConnectionQuality({ connected: true, transport: FAST, rttMs: 12, packetLossRate: 0 })).toBe(
      ConnectionQuality.EXCELLENT,
    );
  });

  it('never calls Bluetooth excellent, however clean its numbers are', () => {
    // A flawless BLE link still needs minutes for a photo. Saying "excellent"
    // would promise something the radio cannot deliver.
    expect(classifyConnectionQuality({ connected: true, transport: SLOW, rttMs: 5, packetLossRate: 0, rssi: -30 })).toBe(
      ConnectionQuality.GOOD,
    );
  });

  it('drops to weak on loss, latency or a faint signal', () => {
    expect(classifyConnectionQuality({ connected: true, transport: FAST, packetLossRate: 0.4 })).toBe(ConnectionQuality.WEAK);
    expect(classifyConnectionQuality({ connected: true, transport: FAST, rttMs: 2000 })).toBe(ConnectionQuality.WEAK);
    expect(classifyConnectionQuality({ connected: true, transport: SLOW, rssi: -95 })).toBe(ConnectionQuality.WEAK);
  });

  it('says reconnecting whenever there is no link, whatever the metrics claim', () => {
    expect(classifyConnectionQuality({ connected: false, transport: FAST, rttMs: 1 })).toBe(ConnectionQuality.RECONNECTING);
    expect(connectionQualityFromLink(null, { connected: true })).toBe(ConnectionQuality.RECONNECTING);
  });

  it('ignores impossible metrics instead of trusting them', () => {
    const nonsense = classifyConnectionQuality({
      connected: true,
      transport: FAST,
      rttMs: Number.NaN,
      packetLossRate: Number.POSITIVE_INFINITY,
      rssi: 40, // a positive dBm is a bridge bug, not a miraculous signal
    });
    expect(nonsense).toBe(ConnectionQuality.EXCELLENT);
    // Loss reported as a percentage rather than a fraction still clamps to 1.
    expect(classifyConnectionQuality({ connected: true, transport: FAST, packetLossRate: 85 })).toBe(ConnectionQuality.WEAK);
  });

  it('derives loss from raw link counters', () => {
    const metrics: LinkMetrics = {
      transport: FAST,
      maxDatagramSize: 1024,
      rttMs: 10,
      packetsSent: 100,
      packetsReceived: 60,
      packetsDropped: 40,
      bytesSent: 0,
      bytesReceived: 0,
    };
    expect(connectionQualityFromLink(metrics, { connected: true })).toBe(ConnectionQuality.WEAK);
    expect(connectionQualityFromLink({ ...metrics, packetsDropped: 0 }, { connected: true })).toBe(
      ConnectionQuality.EXCELLENT,
    );
  });

  it('does not let the badge flicker, but drops to reconnecting at once', () => {
    const tracker = new ConnectionQualityTracker({ initial: ConnectionQuality.EXCELLENT, confirmations: 2 });
    expect(tracker.observe(ConnectionQuality.WEAK)).toBeNull(); // one bad sample proves nothing
    expect(tracker.current).toBe(ConnectionQuality.EXCELLENT);
    expect(tracker.observe(ConnectionQuality.WEAK)).toBe(ConnectionQuality.WEAK);

    // A single sample the other way must not bounce it back.
    expect(tracker.observe(ConnectionQuality.EXCELLENT)).toBeNull();
    expect(tracker.current).toBe(ConnectionQuality.WEAK);

    // Losing the link is different: the user needs to know immediately.
    expect(tracker.observe(ConnectionQuality.RECONNECTING)).toBe(ConnectionQuality.RECONNECTING);
  });
});

// ---------------------------------------------------------------------------
// Probe codec - every byte of this arrives on an unauthenticated link
// ---------------------------------------------------------------------------

describe('upgrade probe codec', () => {
  const id = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const token = new Uint8Array(32).fill(9);

  it('round-trips', () => {
    const bytes = encodeProbeDatagram(0x01, id, token);
    const probe = decodeProbeDatagram(bytes);
    expect(probe?.kind).toBe(0x01);
    expect(probe?.upgradeId).toEqual(id);
    expect(probe?.token).toEqual(token);
  });

  it('rejects anything that is not exactly a probe', () => {
    const good = encodeProbeDatagram(0x02, id, token);
    expect(decodeProbeDatagram(new Uint8Array(0))).toBeNull();
    expect(decodeProbeDatagram(new Uint8Array(45))).toBeNull(); // right length, wrong magic
    expect(decodeProbeDatagram(good.slice(0, good.length - 1))).toBeNull(); // truncated
    expect(decodeProbeDatagram(new Uint8Array([...good, 0]))).toBeNull(); // padded

    const badKind = good.slice();
    badKind[4] = 0x77;
    expect(decodeProbeDatagram(badKind)).toBeNull();

    const badMagic = good.slice();
    badMagic[2] = 0x00;
    expect(decodeProbeDatagram(badMagic)).toBeNull();

    // A frame from the real protocol must never parse as a probe.
    expect(decodeProbeDatagram(Uint8Array.from([PROTOCOL_VERSION, 0x02, ...new Uint8Array(43)]))).toBeNull();
  });

  it('refuses to encode a malformed probe rather than emitting a short one', () => {
    expect(() => encodeProbeDatagram(0x01, new Uint8Array(4), token)).toThrow();
    expect(() => encodeProbeDatagram(0x01, id, new Uint8Array(8))).toThrow();
  });
});

describe('who initiates an upgrade', () => {
  it('is decided by both sides with no round trip, and never by both at once', () => {
    expect(isUpgradeInitiator('aaa', 'bbb')).toBe(true);
    expect(isUpgradeInitiator('bbb', 'aaa')).toBe(false);
    // Identical ids cannot happen between two identities; if they did, nobody
    // dials, which loses an upgrade and prevents a race.
    expect(isUpgradeInitiator('same', 'same')).toBe(false);
    expect(isUpgradeInitiator('', 'bbb')).toBe(false);
    expect(isUpgradeInitiator(null as unknown as string, 'bbb')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end, two real PeerSessions over MockNetwork
// ---------------------------------------------------------------------------

describe('transport upgrade end to end', () => {
  it('starts on the slow radio and agrees on exactly one initiator', async () => {
    const ctx = await connectPair();
    expect(ctx.a.session.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.b.session.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.a.session.currentLink?.transport).toBe(SLOW);
    expect([ctx.a.controller.isInitiator, ctx.b.controller.isInitiator].filter(Boolean)).toHaveLength(1);
  });

  it('negotiates the fast transport from the capability records of both sides', async () => {
    const ctx = await connectPair();
    expect(ctx.initiator.controller.upgradeCandidates().map((c) => c.kind)).toEqual([FAST]);
    // Take the fast radio away on one side and there is nothing to offer.
    ctx.initiator.fast.setAvailable(false);
    expect(ctx.initiator.controller.upgradeCandidates()).toEqual([]);
  });

  it('migrates the session onto the fast link without losing a message', async () => {
    const ctx = await connectPair();
    const got = collect(ctx.responder.session);
    const completed: { to: TransportKind; isHighBandwidth: boolean }[] = [];
    ctx.initiator.controller.events.on('upgradeCompleted', (e) => completed.push(e));

    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 0 });
    await ctx.clock.advanceAsync(500);

    const running = ctx.initiator.controller.considerUpgrade();
    // Keep talking straight through the negotiation.
    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 1 });
    await ctx.clock.advanceAsync(400);
    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 2 });
    await ctx.clock.advanceAsync(20_000);

    const outcome = await running;
    expect(outcome.upgraded).toBe(true);
    expect(outcome.kind).toBe(FAST);

    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 3 });
    await ctx.clock.advanceAsync(3000);

    // Both sides are on the fast radio, the session never re-authenticated, and
    // every message arrived exactly once, in order.
    expect(ctx.initiator.session.currentLink?.transport).toBe(FAST);
    expect(ctx.responder.session.currentLink?.transport).toBe(FAST);
    expect(ctx.initiator.session.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.responder.session.state).toBe(ConnectionState.CONNECTED);
    expect(chatIndexes(got)).toEqual([0, 1, 2, 3]);
    expect(completed[0]?.to).toBe(FAST);
    expect(completed[0]?.isHighBandwidth).toBe(true);
    expect(ctx.initiator.controller.state).toBe(UpgradeState.IDLE);
    expect(ctx.responder.controller.state).toBe(UpgradeState.IDLE);
  });

  it('carries traffic in both directions after the switch', async () => {
    const ctx = await connectPair();
    const atInitiator = collect(ctx.initiator.session);
    const running = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(20_000);
    expect((await running).upgraded).toBe(true);

    ctx.responder.session.sendReliable(MessageType.MESSAGE, { i: 7 });
    await ctx.clock.advanceAsync(2000);
    expect(chatIndexes(atInitiator)).toEqual([7]);
  });

  it('reports quality as good on Bluetooth and excellent once upgraded', async () => {
    const ctx = await connectPair();
    await ctx.clock.advanceAsync(6000);
    expect(ctx.initiator.controller.quality).toBe(ConnectionQuality.GOOD);

    const running = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(20_000);
    expect((await running).upgraded).toBe(true);
    await ctx.clock.advanceAsync(6000);
    expect(ctx.initiator.controller.quality).toBe(ConnectionQuality.EXCELLENT);
  });

  it('upgrades on its own when a better radio appears', async () => {
    // Two phones meet with only Bluetooth in common, then both join the same
    // Wi-Fi. Nobody taps anything.
    const ctx = await connectPair({ autoUpgrade: true, fastAvailable: false });
    await ctx.clock.advanceAsync(6000);
    expect(ctx.initiator.session.currentLink?.transport).toBe(SLOW);

    ctx.responder.fast.setAvailable(true);
    ctx.initiator.fast.setAvailable(true);
    await ctx.clock.advanceAsync(20_000);
    expect(ctx.initiator.session.currentLink?.transport).toBe(FAST);
    expect(ctx.responder.session.currentLink?.transport).toBe(FAST);
  });

  it('completes over a hostile link, with heavy loss, reordering and duplication', async () => {
    const ctx = await connectPair();
    const got = collect(ctx.responder.session);
    // Degrade AFTER the handshake: the negotiation now has to survive 15%
    // reliable loss, 20% reordering and 10% duplication on the way through.
    ctx.degrade(HOSTILE_CONDITIONS);

    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 0 });
    const running = ctx.initiator.controller.considerUpgrade();
    // Keep chatting straight through a negotiation that is being reordered,
    // duplicated and dropped under itself.
    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 1 });
    await ctx.clock.advanceAsync(2_000);
    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 2 });
    await ctx.clock.advanceAsync(88_000, 10);
    const outcome = await running;

    expect(outcome).toMatchObject({ upgraded: true, kind: FAST });
    expect(ctx.initiator.session.currentLink?.transport).toBe(FAST);
    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 3 });
    await ctx.clock.advanceAsync(20_000);
    expect(chatIndexes(got)).toEqual([0, 1, 2, 3]);
  });

  it('completes over a BLE-like link', async () => {
    const ctx = await connectPair();
    ctx.degrade(BLE_LIKE_CONDITIONS);
    const running = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(30_000);
    expect((await running).upgraded).toBe(true);
  });
});

describe('a failed upgrade never costs the user the conversation', () => {
  it('keeps the original session when the new radio refuses to open', async () => {
    const ctx = await connectPair();
    const got = collect(ctx.responder.session);
    ctx.initiator.fast.failConnect = true;

    const running = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(30_000);
    const outcome = await running;

    expect(outcome.upgraded).toBe(false);
    expect(outcome.reason).toBe(UpgradeFailureReason.CONNECT_FAILED);

    // The old link was never touched.
    expect(ctx.initiator.session.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.responder.session.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.initiator.session.currentLink?.transport).toBe(SLOW);
    expect(ctx.responder.session.currentLink?.transport).toBe(SLOW);

    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 0 });
    await ctx.clock.advanceAsync(3000);
    expect(chatIndexes(got)).toEqual([0]);
    expect(ctx.initiator.controller.state).toBe(UpgradeState.IDLE);
    expect(ctx.responder.controller.state).toBe(UpgradeState.IDLE);
  });

  it('keeps the original session when the new link opens but never answers', async () => {
    const ctx = await connectPair();
    const got = collect(ctx.responder.session);
    // The peer accepts, but its app never routes the incoming link anywhere -
    // an app in the background, a permission revoked between the two steps.
    ctx.responder.routeIncoming = false;

    const running = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(120_000, 10);
    const outcome = await running;

    expect(outcome.upgraded).toBe(false);
    expect(outcome.reason).toBe(UpgradeFailureReason.PROBE_FAILED);
    expect(ctx.initiator.session.currentLink?.transport).toBe(SLOW);
    expect(ctx.responder.session.currentLink?.transport).toBe(SLOW);

    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 0 });
    ctx.responder.session.sendReliable(MessageType.MESSAGE, { i: 1 });
    await ctx.clock.advanceAsync(5000);
    expect(chatIndexes(got)).toEqual([0]);
    expect(ctx.responder.controller.state).toBe(UpgradeState.IDLE);
  });

  it('does not hammer a transport that has just failed', async () => {
    const ctx = await connectPair();
    ctx.initiator.fast.failConnect = true;
    const first = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(30_000);
    expect((await first).upgraded).toBe(false);

    ctx.initiator.fast.failConnect = false;
    // Still inside the cooldown window, so there is nothing left to try.
    expect(ctx.initiator.controller.upgradeCandidates()).toEqual([]);
    const second = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(1000);
    expect((await second).reason).toBe(UpgradeFailureReason.NO_CANDIDATE);
  });

  it('declines to upgrade when there is nowhere better to go', async () => {
    const ctx = await connectPair();
    ctx.initiator.fast.setAvailable(false);
    const outcome = await ctx.initiator.controller.considerUpgrade();
    expect(outcome.upgraded).toBe(false);
    expect(outcome.reason).toBe(UpgradeFailureReason.NO_CANDIDATE);
  });

  it('refuses to be the one who dials when the peer id says otherwise', async () => {
    const ctx = await connectPair();
    const outcome = await ctx.responder.controller.considerUpgrade();
    expect(outcome.reason).toBe(UpgradeFailureReason.ROLE_CONFLICT);
  });
});

describe('downgrade', () => {
  it('falls back to Bluetooth when the fast link dies, without ending the session', async () => {
    const ctx = await connectPair();
    const got = collect(ctx.responder.session);
    const running = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(20_000);
    expect((await running).upgraded).toBe(true);

    const downgrades: TransportKind[] = [];
    ctx.initiator.controller.events.on('downgraded', ({ to }) => downgrades.push(to));

    // Somebody walks out of Wi-Fi range. Bluetooth still reaches.
    ctx.initiator.fast.setAvailable(false);
    ctx.responder.fast.setAvailable(false);
    ctx.network.partition('a-wifi', 'b-wifi');
    await ctx.clock.advanceAsync(500);
    expect(ctx.initiator.session.state).toBe(ConnectionState.RECONNECTING);
    // The keys survive: this is a reconnect, not a teardown.
    expect(ctx.initiator.session.isSecure).toBe(true);

    await ctx.clock.advanceAsync(20_000);
    expect(downgrades).toEqual([SLOW]);
    expect(ctx.initiator.session.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.initiator.session.currentLink?.transport).toBe(SLOW);

    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 0 });
    await ctx.clock.advanceAsync(5000);
    expect(chatIndexes(got)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// Hostile input, over a real session
// ---------------------------------------------------------------------------

describe('hostile transport negotiation traffic', () => {
  const goodId = new Uint8Array(8).fill(3);
  const goodNonce = new Uint8Array(32).fill(4);

  async function inject(payloads: { type: number; value: unknown }[]) {
    const ctx = await connectPair();
    const got = collect(ctx.initiator.session);
    for (const { type, value } of payloads) {
      ctx.responder.session.sendReliable(type, value as never);
    }
    await ctx.clock.advanceAsync(5000);
    return { ctx, got };
  }

  it('drops malformed offers and stays connected', async () => {
    const { ctx } = await inject([
      { type: MessageType.TRANSPORT_OFFER, value: {} },
      { type: MessageType.TRANSPORT_OFFER, value: { i: new Uint8Array(3), k: FAST, n: goodNonce } },
      { type: MessageType.TRANSPORT_OFFER, value: { i: goodId, k: 'teleportation', n: goodNonce } },
      { type: MessageType.TRANSPORT_OFFER, value: { i: goodId, k: FAST, n: new Uint8Array(4) } },
      { type: MessageType.TRANSPORT_OFFER, value: { i: goodId, k: FAST } },
      { type: MessageType.TRANSPORT_OFFER, value: { i: goodId, k: 42, n: goodNonce } },
      { type: MessageType.TRANSPORT_OFFER, value: [1, 2, 3] },
      { type: MessageType.TRANSPORT_OFFER, value: { i: goodNonce, k: FAST, n: goodNonce } }, // id of the wrong length
    ]);

    expect(ctx.initiator.session.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.initiator.controller.state).toBe(UpgradeState.IDLE);
    expect(ctx.initiator.session.currentLink?.transport).toBe(SLOW);

    // ...and the session is still perfectly healthy afterwards.
    const got = collect(ctx.responder.session);
    ctx.initiator.session.sendReliable(MessageType.MESSAGE, { i: 0 });
    await ctx.clock.advanceAsync(3000);
    expect(chatIndexes(got)).toEqual([0]);
  });

  it('ignores replies to an upgrade that was never offered', async () => {
    const { ctx } = await inject([
      { type: MessageType.TRANSPORT_ACCEPT, value: { i: goodId, k: FAST, e: 'a-wifi' } },
      { type: MessageType.TRANSPORT_READY, value: { i: goodId } },
      { type: MessageType.TRANSPORT_SWITCH, value: { i: goodId } },
      { type: MessageType.TRANSPORT_FAILED, value: { i: goodId, r: 3 } },
    ]);
    expect(ctx.initiator.controller.state).toBe(UpgradeState.IDLE);
    expect(ctx.initiator.session.currentLink?.transport).toBe(SLOW);
    expect(ctx.initiator.session.state).toBe(ConnectionState.CONNECTED);
  });

  it('bounds out-of-range and oversized fields', async () => {
    const { ctx } = await inject([
      { type: MessageType.TRANSPORT_FAILED, value: { i: goodId, r: 999_999 } },
      { type: MessageType.TRANSPORT_FAILED, value: { i: goodId, r: -1 } },
      { type: MessageType.TRANSPORT_FAILED, value: { i: goodId, r: 'three' } },
      { type: MessageType.TRANSPORT_ACCEPT, value: { i: goodId, k: FAST, e: 'x'.repeat(4096) } },
      { type: MessageType.TRANSPORT_OFFER, value: { i: goodId, k: FAST, n: new Uint8Array(40_000) } },
    ]);
    expect(ctx.initiator.session.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.initiator.controller.state).toBe(UpgradeState.IDLE);
  });

  it('refuses an offer from the side that is not supposed to be dialling', async () => {
    const ctx = await connectPair();
    const failures: number[] = [];
    ctx.responder.controller.events.on('upgradeFailed', ({ reason }) => failures.push(reason));

    // The responder is not the initiator, so an offer coming FROM the initiator
    // to the responder is legitimate; one going the other way is not.
    ctx.responder.session.sendReliable(MessageType.TRANSPORT_OFFER, {
      i: goodId,
      k: FAST,
      n: goodNonce,
    } as never);
    await ctx.clock.advanceAsync(3000);

    expect(ctx.initiator.controller.state).toBe(UpgradeState.IDLE);
    expect(ctx.initiator.session.currentLink?.transport).toBe(SLOW);
    expect(ctx.initiator.session.state).toBe(ConnectionState.CONNECTED);
  });

  it('answers a repeated offer again instead of declining itself as busy', async () => {
    // The initiator repeats its offer until it hears back, so a repeat means
    // our acceptance was what got lost. Treating it as "busy" would deadlock
    // the negotiation on exactly the link that most needs the upgrade.
    const ctx = await connectPair();
    const accepts: IncomingMessage[] = [];
    ctx.initiator.session.events.on('message', (m) => {
      if (m.type === MessageType.TRANSPORT_ACCEPT) accepts.push(m);
    });

    const offer = { i: new Uint8Array(8).fill(5), k: FAST, n: new Uint8Array(32).fill(6) };
    ctx.initiator.session.sendControl(MessageType.TRANSPORT_OFFER, offer as never);
    await ctx.clock.advanceAsync(1000);
    expect(ctx.responder.controller.state).toBe(UpgradeState.AWAITING_LINK);
    expect(accepts).toHaveLength(1);

    ctx.initiator.session.sendControl(MessageType.TRANSPORT_OFFER, offer as never);
    await ctx.clock.advanceAsync(1000);
    expect(accepts).toHaveLength(2);
    expect(ctx.responder.controller.state).toBe(UpgradeState.AWAITING_LINK);
  });

  it('hands back a link it has no use for, rather than swallowing it', async () => {
    const ctx = await connectPair();
    const stranger = ctx.network.createTransport('stranger-ble');
    const connecting = stranger.connect('b-ble');
    await ctx.clock.advanceAsync(200);
    const link = await connecting;
    // No upgrade is armed and the session is healthy, so the controller wants
    // nothing to do with it and says so.
    expect(ctx.b.controller.handleIncomingLink(link)).toBe(false);
    expect(ctx.b.session.state).toBe(ConnectionState.CONNECTED);
  });

  it('will not answer a probe from someone who does not hold the nonce', async () => {
    const ctx = await connectPair();
    const stranger = ctx.network.createTransport('stranger-wifi');

    // The moment the responder starts waiting for the peer's link, a third
    // device opens one of its own and floods it with plausible-looking probes.
    ctx.responder.controller.events.on('stateChanged', ({ state }) => {
      if (state !== UpgradeState.AWAITING_LINK) return;
      void stranger.connect('b-wifi').then(async (link) => {
        for (let i = 0; i < 3; i++) {
          const forged = encodeProbeDatagram(0x01, new Uint8Array(8).fill(0xaa), new Uint8Array(32).fill(0xbb));
          await link.send(forged, 'reliable').catch(() => undefined);
        }
      });
    });

    const running = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(30_000);
    const outcome = await running;

    // The stranger's link was ignored, and the real peer still got through.
    expect(outcome.upgraded).toBe(true);
    expect(ctx.responder.session.currentLink?.transport).toBe(FAST);
    expect(ctx.responder.session.currentLink?.endpointId).not.toBe('stranger-wifi');
  });

  it('ignores junk on the new link while it is being proven', async () => {
    const ctx = await connectPair();
    // Nothing but noise arrives on the fast radio; the probe never completes,
    // and the conversation carries on over Bluetooth.
    ctx.responder.routeIncoming = false;
    ctx.responder.fast.events.on('incomingLink', ({ link }) => {
      for (let i = 0; i < 40; i++) void link.send(new Uint8Array([i & 0xff]), 'reliable').catch(() => undefined);
    });

    const running = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(120_000, 10);
    expect((await running).upgraded).toBe(false);
    expect(ctx.initiator.session.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.initiator.session.currentLink?.transport).toBe(SLOW);
  });
});

describe('developer mode', () => {
  it('exposes what it chose and why', async () => {
    const ctx = await connectPair();
    const before = ctx.initiator.controller.diagnostics();
    expect(before.currentTransport).toBe(SLOW);
    expect(before.candidates).toEqual([FAST]);
    expect(before.isInitiator).toBe(true);

    const running = ctx.initiator.controller.considerUpgrade();
    await ctx.clock.advanceAsync(20_000);
    await running;

    const after = ctx.initiator.controller.diagnostics();
    expect(after.currentTransport).toBe(FAST);
    expect(after.upgradesCompleted).toBe(1);
    expect(after.state).toBe(UpgradeState.IDLE);
  });

  it('stops cleanly, leaving no timers behind', async () => {
    const ctx = await connectPair();
    ctx.a.controller.dispose();
    ctx.b.controller.dispose();
    await ctx.a.session.close('done');
    await ctx.b.session.close('done');
    await ctx.clock.advanceAsync(1000);
    expect(ctx.clock.pendingTimers).toBe(0);
  });
});
