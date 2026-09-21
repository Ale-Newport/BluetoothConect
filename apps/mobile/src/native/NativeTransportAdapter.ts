/**
 * The seam between the radios and the protocol.
 *
 * `@airlink/core` is written against `Transport` and `Link` and knows nothing
 * about React Native. The native module speaks base64 strings and event
 * emitters. This file is the only place those two meet, and it is deliberately
 * thin: it translates, it does not decide.
 *
 * One native module serves every transport, so a single event stream carries
 * discoveries and data for all of them. The demultiplexing here - one
 * `NativeTransport` per kind, one `NativeLink` per open link - is what lets the
 * core keep its clean per-transport abstraction.
 */
import {
  LinkState,
  SendMode,
  TransportKind,
  TypedEmitter,
  fromBase64,
  isValidDiscoveryId,
  toBase64,
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
  type TransportUnavailableReason,
} from '@airlink/core';
import {
  NativeAirLinkTransport,
  type NativeCapabilities,
  type NativeTransportCapability,
} from '@airlink/native-transport';

/**
 * How the manager ranks transports.
 *
 * `preference` is the tie-breaker when several are available on both sides. The
 * numbers encode a judgement, not a measurement: BLE is last because it is slow,
 * but it is never zero, because it is the only thing that works everywhere.
 */
const PROFILES: Record<TransportKind, TransportProfile> = {
  [TransportKind.MOCK]: {
    kind: TransportKind.MOCK,
    preference: 0,
    expectedThroughputBytesPerSecond: 1_000_000,
    expectedRttMs: 5,
    highBandwidth: true,
    canDiscover: true,
    crossPlatform: true,
    worksInBackground: true,
  },
  [TransportKind.BLE]: {
    kind: TransportKind.BLE,
    preference: 10,
    // Measured range on real hardware is roughly 5-40 KB/s depending on MTU,
    // connection interval and whether an L2CAP channel came up. The mid-point
    // is what the ETA estimates use until a real measurement replaces it.
    expectedThroughputBytesPerSecond: 20_000,
    expectedRttMs: 60,
    highBandwidth: false,
    canDiscover: true,
    crossPlatform: true,
    // Only in the narrow sense the OS permits: an established session survives,
    // and a notification can wake the app for about ten seconds.
    worksInBackground: true,
  },
  [TransportKind.WIFI_DIRECT]: {
    kind: TransportKind.WIFI_DIRECT,
    preference: 60,
    expectedThroughputBytesPerSecond: 3_000_000,
    expectedRttMs: 15,
    highBandwidth: true,
    canDiscover: true,
    crossPlatform: false,
    worksInBackground: false,
  },
  [TransportKind.WIFI_AWARE]: {
    kind: TransportKind.WIFI_AWARE,
    preference: 65,
    expectedThroughputBytesPerSecond: 4_000_000,
    expectedRttMs: 12,
    highBandwidth: true,
    canDiscover: true,
    crossPlatform: false,
    worksInBackground: false,
  },
  [TransportKind.PEER_TO_PEER_WIFI]: {
    kind: TransportKind.PEER_TO_PEER_WIFI,
    preference: 80,
    expectedThroughputBytesPerSecond: 8_000_000,
    expectedRttMs: 8,
    highBandwidth: true,
    canDiscover: true,
    crossPlatform: false,
    worksInBackground: false,
  },
  [TransportKind.LOCAL_NETWORK]: {
    kind: TransportKind.LOCAL_NETWORK,
    preference: 90,
    expectedThroughputBytesPerSecond: 5_000_000,
    expectedRttMs: 6,
    highBandwidth: true,
    canDiscover: true,
    // The only high-bandwidth path that works between an iPhone and an Android
    // phone, which is why it outranks the platform-specific ones.
    crossPlatform: true,
    worksInBackground: false,
  },
};

const LINK_STATE_BY_NAME: Record<string, LinkState> = {
  connecting: LinkState.CONNECTING,
  connected: LinkState.CONNECTED,
  closing: LinkState.CLOSING,
  closed: LinkState.CLOSED,
  failed: LinkState.FAILED,
};

/**
 * What a suppressed transport reports. `noLocalNetwork` is the same reason
 * `LocalNetworkTransport.evaluate()` returns when NWPathMonitor sees no usable
 * interface, so the UI cannot tell this apart from a genuinely absent network -
 * which is the point.
 */
const SUPPRESSED_AVAILABILITY: TransportAvailability = {
  available: false,
  reason: 'noLocalNetwork' as TransportUnavailableReason,
  detail: 'Switched off in Developer Mode.',
};

class NativeLink implements Link {
  readonly events = new TypedEmitter<LinkEvents>();
  private currentState: LinkState = LinkState.CONNECTING;
  private datagramSize: number;
  private inFlight = 0;

  private packetsSent = 0;
  private packetsReceived = 0;
  private packetsDropped = 0;
  private bytesSent = 0;
  private bytesReceived = 0;

  constructor(
    readonly id: string,
    readonly transport: TransportKind,
    readonly endpointId: string,
    maxDatagramSize: number,
    readonly isHighBandwidth: boolean,
  ) {
    this.datagramSize = maxDatagramSize;
  }

  get state(): LinkState {
    return this.currentState;
  }

  get maxDatagramSize(): number {
    return this.datagramSize;
  }

  get queuedCount(): number {
    return this.inFlight;
  }

  /** @internal */
  applyState(state: LinkState, reason: string): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.events.emit('state', reason ? { state, reason } : { state });
  }

  /** @internal */
  applyMtu(size: number): void {
    if (size === this.datagramSize || size <= 0) return;
    this.datagramSize = size;
    this.events.emit('mtu', { maxDatagramSize: size });
  }

  /** @internal */
  applyData(bytes: Uint8Array): void {
    this.packetsReceived++;
    this.bytesReceived += bytes.length;
    this.events.emit('data', { bytes });
  }

  async send(bytes: Uint8Array, mode: SendMode): Promise<void> {
    if (this.currentState !== LinkState.CONNECTED) {
      throw new Error(`NativeLink.send: link is ${this.currentState}`);
    }
    if (bytes.length > this.datagramSize) {
      // Never truncate. The fragmentation layer above is responsible for
      // splitting, and it reads maxDatagramSize; if it got here oversized, that
      // is a bug worth surfacing rather than silently corrupting a packet.
      throw new Error(`NativeLink.send: ${bytes.length} bytes exceeds MTU ${this.datagramSize}`);
    }
    this.inFlight++;
    try {
      await NativeAirLinkTransport.send(this.id, toBase64(bytes), mode === SendMode.RELIABLE);
      this.packetsSent++;
      this.bytesSent += bytes.length;
    } catch (err) {
      this.packetsDropped++;
      throw err;
    } finally {
      this.inFlight--;
    }
  }

  metrics(): LinkMetrics {
    return {
      transport: this.transport,
      maxDatagramSize: this.datagramSize,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      packetsDropped: this.packetsDropped,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
    };
  }

  /** Ask the native side for the numbers only it knows: RSSI, real throughput. */
  async detailedMetrics(): Promise<LinkMetrics> {
    try {
      const native = await NativeAirLinkTransport.getLinkMetrics(this.id);
      return {
        transport: this.transport,
        maxDatagramSize: native.maxDatagramSize,
        ...(native.rssi !== 0 ? { rssi: native.rssi } : {}),
        packetsSent: native.packetsSent,
        packetsReceived: native.packetsReceived,
        packetsDropped: native.packetsDropped,
        bytesSent: native.bytesSent,
        bytesReceived: native.bytesReceived,
        ...(native.throughput > 0 ? { throughputBytesPerSecond: native.throughput } : {}),
      };
    } catch {
      // A link that closed between the call and the answer is not an error.
      return this.metrics();
    }
  }

  async close(reason = 'closed locally'): Promise<void> {
    if (this.currentState === LinkState.CLOSED) return;
    this.applyState(LinkState.CLOSING, reason);
    try {
      await NativeAirLinkTransport.disconnect(this.id, reason);
    } catch {
      // Closing must never throw; the link is going away either way.
    }
    this.applyState(LinkState.CLOSED, reason);
  }
}

class NativeTransport implements Transport {
  readonly events = new TypedEmitter<TransportEvents>();
  readonly profile: TransportProfile;

  private availabilityState: TransportAvailability;
  /**
   * Developer Mode's "pretend this radio is not here".
   *
   * The iOS Simulator has no Bluetooth radio, so the ONLY way to see what the
   * app does with no Wi-Fi is to take the local network away - and turning the
   * Mac's Wi-Fi off takes it away from both simulators at once, kills the
   * host's own network, and does nothing at all on an Ethernet-connected Mac.
   *
   * This is deliberately NOT a filter over `all()`: a transport that vanishes
   * from the list exercises a code path no phone ever takes. Instead
   * availability reports false with a real reason, which is exactly what
   * `LocalNetworkTransport.evaluate()` does when NWPathMonitor sees no usable
   * interface. The UI, the registry and the session teardown then run the same
   * logic they run on a real device.
   */
  private suppressed = false;

  constructor(
    readonly kind: TransportKind,
    capability: NativeTransportCapability,
    private readonly host: NativeTransportHost,
  ) {
    this.profile = PROFILES[kind];
    this.availabilityState = toAvailability(capability);
  }

  async availability(): Promise<TransportAvailability> {
    if (this.suppressed) return SUPPRESSED_AVAILABILITY;
    return this.availabilityState;
  }

  /**
   * @internal Developer Mode only. Emits the same event a real radio change
   * does, so every listener reacts identically.
   */
  setSuppressed(on: boolean): void {
    if (this.suppressed === on) return;
    this.suppressed = on;
    this.events.emit('availabilityChanged', {
      availability: on ? SUPPRESSED_AVAILABILITY : this.availabilityState,
    });
  }

  /** @internal */
  get isSuppressed(): boolean {
    return this.suppressed;
  }

  /** @internal */
  applyAvailability(available: boolean, reason: string): void {
    this.availabilityState = available
      ? { available: true }
      : { available: false, reason: (reason || 'unknown') as TransportUnavailableReason };
    // While suppressed the native layer is still reporting reality - the Wi-Fi
    // is genuinely there - and it must not be allowed to contradict the
    // override, or the radio would flicker back on at the next path change.
    if (this.suppressed) return;
    this.events.emit('availabilityChanged', { availability: this.availabilityState });
  }

  async startAdvertising(record: AdvertisementRecord): Promise<void> {
    await NativeAirLinkTransport.startAdvertising(
      this.kind,
      toBase64(record.token),
      record.displayName ?? '',
      record.discoveryId ?? '',
    );
  }

  async stopAdvertising(): Promise<void> {
    await NativeAirLinkTransport.stopAdvertising(this.kind);
  }

  async startDiscovery(): Promise<void> {
    await NativeAirLinkTransport.startDiscovery(this.kind);
  }

  async stopDiscovery(): Promise<void> {
    await NativeAirLinkTransport.stopDiscovery(this.kind);
  }

  async connect(endpointId: string, options: ConnectOptions = {}): Promise<Link> {
    const linkId = await NativeAirLinkTransport.connect(this.kind, endpointId, options.timeoutMs ?? 20_000);
    // The native side emits onLinkOpened for both directions, and it may arrive
    // before or after this promise resolves. Whichever wins, the host holds one
    // NativeLink per id, so both paths converge on the same object.
    return this.host.linkFor(linkId, this.kind, endpointId);
  }

  async shutdown(): Promise<void> {
    await this.stopAdvertising().catch(() => undefined);
    await this.stopDiscovery().catch(() => undefined);
    this.events.removeAllListeners();
  }
}

function toAvailability(capability: NativeTransportCapability): TransportAvailability {
  if (capability.available) return { available: true };
  return {
    available: false,
    reason: (capability.reason || 'unknown') as TransportUnavailableReason,
    ...(capability.detail ? { detail: capability.detail } : {}),
  };
}

/**
 * Owns the native module subscription and hands out one `Transport` per kind.
 *
 * Construct one of these for the lifetime of the app. It is the only thing that
 * talks to the TurboModule.
 */
export class NativeTransportHost {
  private readonly transports = new Map<TransportKind, NativeTransport>();
  private readonly links = new Map<string, NativeLink>();
  private subscriptions: { remove: () => void }[] = [];
  private capabilities: NativeCapabilities | null = null;
  private started = false;

  /** Diagnostic lines from the native layer, for Developer Mode. */
  readonly logs = new TypedEmitter<{ log: { level: string; scope: string; message: string } }>();

  /**
   * Bring the native stack up and discover what this device can do.
   *
   * The UUIDs come from the protocol constants rather than being duplicated in
   * Swift and Kotlin, so the two platforms cannot drift apart.
   */
  async start(config: {
    serviceUuid: string;
    rxCharacteristicUuid: string;
    txCharacteristicUuid: string;
    bonjourServiceType: string;
  }): Promise<NativeCapabilities> {
    if (this.started) {
      return this.capabilities ?? (await NativeAirLinkTransport.getCapabilities());
    }
    this.subscribe();
    await NativeAirLinkTransport.start(
      config.serviceUuid,
      config.rxCharacteristicUuid,
      config.txCharacteristicUuid,
      config.bonjourServiceType,
    );
    const capabilities = await NativeAirLinkTransport.getCapabilities();
    this.capabilities = capabilities;

    for (const entry of capabilities.transports) {
      if (!entry.supported) continue;
      const kind = entry.kind as TransportKind;
      if (!(kind in PROFILES)) continue;
      this.transports.set(kind, new NativeTransport(kind, entry, this));
    }
    this.started = true;
    return capabilities;
  }

  /** Every transport this build and this device actually support. */
  all(): Transport[] {
    return [...this.transports.values()];
  }

  /**
   * Developer Mode: take a transport away, or give it back.
   *
   * Reporting unavailable is not enough on its own. Two simulators talk to each
   * other over the host Mac's loopback, so an ALREADY OPEN TCP link keeps
   * carrying traffic no matter what availability says - the peer would stay
   * connected and the test would prove nothing. So discovery and advertising
   * stop and every open link on that transport is closed, which is what
   * happens when a phone really does leave the network.
   */
  async setSuppressed(kind: TransportKind, on: boolean): Promise<void> {
    const transport = this.transports.get(kind);
    if (!transport) return;
    transport.setSuppressed(on);
    if (!on) return;

    // Best effort and in this order: stop being findable, then drop what is
    // already up. A throw here would leave the radio half-off.
    try {
      await transport.stopDiscovery();
    } catch {
      // Already stopped, or never started.
    }
    try {
      await transport.stopAdvertising();
    } catch {
      // Same.
    }
    for (const link of [...this.links.values()]) {
      if (link.transport !== kind) continue;
      await link.close('switched off in Developer Mode');
    }
  }

  /** @internal Which transports Developer Mode is currently holding down. */
  suppressedKinds(): TransportKind[] {
    return [...this.transports.entries()].filter(([, t]) => t.isSuppressed).map(([kind]) => kind);
  }

  get(kind: TransportKind): Transport | undefined {
    return this.transports.get(kind);
  }

  get deviceCapabilities(): NativeCapabilities | null {
    return this.capabilities;
  }

  /** Ask for whatever the given transports need. Call at the point of use, not at launch. */
  async requestPermissions(kinds: readonly TransportKind[]): Promise<{
    granted: boolean;
    grantedTransports: TransportKind[];
    deniedTransports: TransportKind[];
    requiresSettings: boolean;
  }> {
    const result = await NativeAirLinkTransport.requestPermissions([...kinds]);
    return {
      granted: result.granted,
      grantedTransports: result.granted_transports as TransportKind[],
      deniedTransports: result.denied_transports as TransportKind[],
      requiresSettings: result.requiresSettings,
    };
  }

  openSettings(): void {
    NativeAirLinkTransport.openSettings();
  }

  /** Android hosts a hotspot so an iPhone can join it. Rejects on iOS. */
  createHotspot(): Promise<{ ssid: string; passphrase: string; active: boolean }> {
    return NativeAirLinkTransport.createHotspot();
  }

  stopHotspot(): Promise<void> {
    return NativeAirLinkTransport.stopHotspot();
  }

  /** iOS asks the OS to join a hotspot. Returns false if the user declined. */
  joinHotspot(ssid: string, passphrase: string): Promise<boolean> {
    return NativeAirLinkTransport.joinHotspot(ssid, passphrase);
  }

  /** @internal Find or create the link object for a native link id. */
  linkFor(linkId: string, transport: TransportKind, endpointId: string, mtu = 180, highBandwidth = false): NativeLink {
    let link = this.links.get(linkId);
    if (!link) {
      link = new NativeLink(linkId, transport, endpointId, mtu, highBandwidth);
      this.links.set(linkId, link);
    }
    return link;
  }

  async shutdown(): Promise<void> {
    for (const sub of this.subscriptions) sub.remove();
    this.subscriptions = [];
    for (const transport of this.transports.values()) await transport.shutdown();
    this.transports.clear();
    this.links.clear();
    this.started = false;
    try {
      await NativeAirLinkTransport.stop();
    } catch {
      // Shutting down must never throw.
    }
  }

  private subscribe(): void {
    this.subscriptions.push(
      NativeAirLinkTransport.onPeerDiscovered((event) => {
        const transport = this.transports.get(event.transport as TransportKind);
        if (!transport) return;
        transport.events.emit('peerDiscovered', { peer: toDiscoveredPeer(event) });
      }),

      NativeAirLinkTransport.onPeerLost((event) => {
        const transport = this.transports.get(event.transport as TransportKind);
        if (!transport) return;
        transport.events.emit('peerLost', { endpointId: event.endpointId });
      }),

      NativeAirLinkTransport.onLinkOpened((event) => {
        const kind = event.transport as TransportKind;
        const link = this.linkFor(event.linkId, kind, event.endpointId, event.maxDatagramSize, event.highBandwidth);
        link.applyMtu(event.maxDatagramSize);
        link.applyState(LinkState.CONNECTED, '');
        // Only an INCOMING link is announced to the transport; an outgoing one
        // is already being awaited by whoever called connect().
        if (event.incoming) {
          this.transports.get(kind)?.events.emit('incomingLink', { link });
        }
      }),

      NativeAirLinkTransport.onLinkState((event) => {
        const link = this.links.get(event.linkId);
        if (!link) return;
        const state = LINK_STATE_BY_NAME[event.state];
        if (!state) return;
        link.applyState(state, event.reason);
        if (state === LinkState.CLOSED || state === LinkState.FAILED) {
          this.links.delete(event.linkId);
        }
      }),

      NativeAirLinkTransport.onData((event) => {
        const link = this.links.get(event.linkId);
        if (!link) return;
        try {
          link.applyData(fromBase64(event.data));
        } catch {
          // Malformed base64 can only be a bug on the native side, and dropping
          // the datagram is strictly better than throwing inside an event
          // callback, where nothing is positioned to handle it.
        }
      }),

      NativeAirLinkTransport.onMtuChanged((event) => {
        this.links.get(event.linkId)?.applyMtu(event.maxDatagramSize);
      }),

      NativeAirLinkTransport.onAvailabilityChanged((event) => {
        this.transports.get(event.transport as TransportKind)?.applyAvailability(event.available, event.reason);
      }),

      NativeAirLinkTransport.onLog((event) => {
        this.logs.emit('log', event);
      }),
    );
  }
}

function toDiscoveredPeer(event: {
  transport: string;
  endpointId: string;
  name: string;
  token: string;
  discoveryId?: string;
  rssi: number;
}): DiscoveredPeer {
  const now = Date.now();
  return {
    endpointId: event.endpointId,
    transport: event.transport as TransportKind,
    ...(event.name ? { advertisedName: event.name } : {}),
    ...(event.token ? { advertisementToken: fromBase64(event.token) } : {}),
    // Validated rather than trusted: this value decides whether an
    // advertisement is treated as our own, so a peer that could put an
    // arbitrary string here could make itself invisible. `isValidDiscoveryId`
    // in @airlink/core is the one definition of the shape.
    ...(isValidDiscoveryId(event.discoveryId) ? { discoveryId: event.discoveryId } : {}),
    ...(event.rssi !== 0 ? { rssi: event.rssi } : {}),
    discoveredAt: now,
    lastSeenAt: now,
  };
}

export { PROFILES as TRANSPORT_PROFILES };
