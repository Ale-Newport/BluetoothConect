import {
  BLE_RX_CHARACTERISTIC_UUID,
  BLE_SERVICE_UUID,
  BLE_TX_CHARACTERISTIC_UUID,
  ChatProtocol,
  ConnectionState,
  LOCAL_NETWORK_SERVICE_TYPE,
  Logger,
  NearbyRegistry,
  PROTOCOL_VERSION,
  PairingController,
  PeerSession,
  TransportCapabilityManager,
  TransportKind,
  TypedEmitter,
  connectionQualityFromLink,
  deriveAdvertisementToken,
  matchAdvertisementToken,
  publicIdentityOf,
  systemClock,
  systemRandom,
  toHex,
  tokenRotation,
  type LocalIdentity,
  type PeerCapabilities,
  type TrustStore,
  type Transport,
} from '@airlink/core';
import { gameCapabilities } from '@airlink/games';
import { createRepositories, migrate, type Repositories } from '@airlink/db';
import { brand, nativeIdentity } from '@airlink/config';
import { NativeTransportHost } from '../native/NativeTransportAdapter.js';
import { openAppDatabase } from '../data/opSqliteDriver.js';
import { SqliteTrustStore } from '../data/sqliteTrustStore.js';
import { createAndStoreIdentity, loadIdentity } from '../data/identityStore.js';

/**
 * The single object the interface talks to.
 *
 * It owns the lifetime of everything: the identity, the database, the trust
 * store, the radios, discovery, and one `PeerSession` per peer. Screens read
 * from the store and call methods here; they never touch a `Link`, an
 * `Envelope` or a `TransportKind`.
 *
 * Everything below the surface is `@airlink/core`, which is why this file is
 * mostly wiring rather than logic - and why the logic it wires is covered by a
 * thousand tests that never open a socket.
 */

export interface PeerHandle {
  readonly key: string;
  readonly peerId: string | null;
  readonly session: PeerSession;
  readonly chat: ChatProtocol;
  readonly pairing: PairingController;
}

export interface AirLinkClientEvents {
  peersChanged: { readonly count: number };
  /** Both users must now compare these six digits. */
  pairingRequired: { readonly peerKey: string; readonly displayName: string; readonly code: string };
  pairingResolved: { readonly peerKey: string; readonly trusted: boolean };
  connectionChanged: {
    readonly peerKey: string;
    readonly state: ConnectionState;
    readonly quality: string | null;
  };
  message: { readonly peerKey: string; readonly messageId: string };
  radioChanged: { readonly transport: TransportKind; readonly available: boolean; readonly detail: string };
  error: { readonly message: string; readonly fatal: boolean };
}

export interface AirLinkClientOptions {
  readonly appVersion: string;
  readonly platform: 'ios' | 'android';
  readonly deviceModel: string;
  readonly logger?: Logger;
}

export class AirLinkClient {
  readonly events = new TypedEmitter<AirLinkClientEvents>();

  private identity!: LocalIdentity;
  private repositories!: Repositories;
  private trust!: SqliteTrustStore;
  private host!: NativeTransportHost;
  private capabilities!: TransportCapabilityManager;
  private registry!: NearbyRegistry;

  private readonly peers = new Map<string, PeerHandle>();
  private readonly unsubscribers: (() => void)[] = [];
  private advertisingSlot = 0;
  /**
   * Tokens this device has advertised recently, as hex.
   *
   * Bonjour is not selective: a listener and a browser on the same device see
   * each other, so without this the phone lists ITSELF as a nearby device -
   * which is exactly what happened the first time the app ran on a real
   * network. Only we can produce our own tokens, so recognising them is a
   * complete filter, and it works for every transport rather than needing a
   * special case per radio.
   *
   * Bounded: a handful of rotation slots is all that can be in flight.
   */
  private readonly ownTokens = new Set<string>();
  private advertiseTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private readonly log: Logger;

  constructor(private readonly options: AirLinkClientOptions) {
    this.log = options.logger ?? new Logger('airlink', { minLevel: 'info' });
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Open the database and read the identity.
   *
   * Deliberately separate from `start()`: onboarding needs to know whether an
   * identity exists before any radio is touched, and touching a radio is what
   * triggers the system permission prompts. Nothing here asks the user for
   * anything.
   */
  async load(): Promise<{ hasIdentity: boolean; hasProfile: boolean }> {
    const db = openAppDatabase();
    migrate(db);
    this.repositories = createRepositories(db);
    this.trust = new SqliteTrustStore(this.repositories.peers);

    const existing = await loadIdentity();
    if (!existing) return { hasIdentity: false, hasProfile: false };
    this.identity = existing;

    // The two halves live in different places - the key in the platform
    // keystore, the profile in SQLite - and they can genuinely come apart: a
    // reinstall, a restore, or a wiped database. Reporting them separately lets
    // the app ask for a name again while KEEPING the identity, so every existing
    // friendship survives. Treating it as a first run would have quietly
    // orphaned them all.
    return { hasIdentity: true, hasProfile: this.repositories.users.get() !== null };
  }

  /**
   * Create the identity if there isn't one, and return its peer id.
   *
   * Onboarding needs the peer id before the profile exists, because the
   * automatic avatar colour is derived from it: without this, the colour shown
   * under "Auto" would be seeded from the name and would then change the moment
   * the profile was written, which is a preview that lies.
   *
   * Safe to call repeatedly - it reuses the stored identity - and safe to call
   * early, because it touches the keystore and nothing else. No radio, so no
   * permission prompt.
   */
  async ensureIdentityPeerId(): Promise<string> {
    if (!this.identity) this.identity = await createAndStoreIdentity(Date.now());
    return publicIdentityOf(this.identity).peerId;
  }

  /**
   * Write the local profile.
   *
   * Reuses the existing identity when there is one. That matters: the identity
   * is what friends recognise, so generating a fresh one here would silently
   * break every pairing the user had.
   *
   * `avatarColor` is a hex string from the palette or null for "derive one from
   * my peer id", which is what everyone who never opens the picker gets.
   */
  async createProfile(displayName: string, avatarColor: string | null): Promise<void> {
    const now = Date.now();
    if (!this.identity) this.identity = await createAndStoreIdentity(now);
    const publicIdentity = publicIdentityOf(this.identity);

    const existingProfile = this.repositories.users.get();
    if (existingProfile) {
      this.repositories.users.updateProfile(displayName, null, avatarColor, now);
      return;
    }
    this.repositories.users.create({
      peerId: publicIdentity.peerId,
      displayName,
      avatarEmoji: null,
      avatarColor,
      identityPublic: publicIdentity.identityKey,
      deviceId: this.identity.deviceId,
      createdAt: now,
      updatedAt: now,
    });
  }

  get profile(): { peerId: string; displayName: string; avatarColor: string | null; deviceId: string } | null {
    const user = this.repositories?.users.get();
    if (!user) return null;
    return {
      peerId: user.peerId,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
      deviceId: user.deviceId,
    };
  }

  get db(): Repositories {
    return this.repositories;
  }

  get trustStore(): TrustStore {
    return this.trust;
  }

  get localIdentity(): LocalIdentity {
    return this.identity;
  }

  /**
   * Bring the radios up and start looking for people.
   *
   * This is the call that may prompt for permissions, so it happens after
   * onboarding has explained why - never on a cold launch.
   */
  async start(): Promise<void> {
    if (this.started) return;
    if (!this.identity) throw new Error('AirLinkClient.start: no identity; call load()/createProfile() first');

    this.host = new NativeTransportHost();
    await this.host.start({
      serviceUuid: BLE_SERVICE_UUID,
      rxCharacteristicUuid: BLE_RX_CHARACTERISTIC_UUID,
      txCharacteristicUuid: BLE_TX_CHARACTERISTIC_UUID,
      bonjourServiceType: nativeIdentity.bonjourServiceType,
    });

    // Ask for the runtime permissions the radios need, BEFORE registering them.
    //
    // On iOS this is a no-op by design: there is no request API, and the system
    // sheet appears the first time CoreBluetooth or the local network is
    // actually touched, which the calls below do. Android is the reason this
    // line exists. Nothing in `start()` raises an Android prompt on its own, so
    // without this the transports come up reporting `permission_*`, discovery
    // finds nobody, and the user lands on a home screen offering Settings for a
    // permission Android has never asked about and therefore does not list. The
    // permissions screen has just finished explaining why each one is needed,
    // so this is the moment it is owed.
    //
    // Deliberately not fatal. A refusal is a smaller app, not a broken one, and
    // what the interface shows is driven by transport availability - which the
    // native side reports honestly either way.
    //
    // The list comes from the host rather than being written out here, so a
    // transport that exists on one platform and not the other cannot be
    // forgotten: `host.all()` is exactly what this build and this device
    // support, including the ones currently blocked for want of a permission.
    const kinds = this.host.all().map((transport) => transport.kind);
    try {
      if (kinds.length > 0) {
        const outcome = await this.host.requestPermissions(kinds);
        this.log.info('permissions', {
          granted: outcome.grantedTransports.join(',') || 'none',
          denied: outcome.deniedTransports.join(',') || 'none',
          requiresSettings: outcome.requiresSettings,
        });
      }
    } catch (err) {
      this.log.debug('permission request failed', { err: String(err) });
    }

    this.capabilities = new TransportCapabilityManager({ logger: this.log });
    this.registry = new NearbyRegistry({
      clock: systemClock,
      resolveToken: (token) => this.resolveAdvertisementToken(token),
      friendName: (peerId) => this.trust.record(peerId)?.displayName,
    });
    this.registry.start();

    for (const transport of this.host.all()) {
      this.capabilities.register(transport);
      this.wireTransport(transport);
    }

    // Publish what the radios say right now.
    //
    // `availabilityChanged` fires on a *change*, which means it never fires for
    // the state a transport starts in - so on a phone whose Bluetooth was
    // already on and stays on, nothing would ever contradict the store's
    // starting assumption that it is off, and Home would offer to open Settings
    // for a radio that is working.
    await this.publishRadioState();

    this.unsubscribers.push(
      this.registry.events.on('changed', ({ peers }) => {
        this.events.emit('peersChanged', { count: peers.length });
      }),
    );

    await this.startAdvertising();
    await this.startDiscovery();
    this.started = true;
    this.log.info('AirLink started', {
      transports: this.capabilities.availableKinds().join(','),
    });
  }

  async stop(): Promise<void> {
    if (this.advertiseTimer) {
      clearInterval(this.advertiseTimer);
      this.advertiseTimer = undefined;
    }
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    for (const handle of this.peers.values()) await handle.session.close('app stopping');
    this.peers.clear();
    this.registry?.dispose();
    this.capabilities?.dispose();
    await this.host?.shutdown();
    this.started = false;
  }

  // -- discovery -------------------------------------------------------------

  /**
   * Emit `radioChanged` once per transport for its current state.
   *
   * Same event the listeners use, so there is one path into the interface
   * rather than a separate "initial" one that could disagree with it.
   */
  /**
   * Is anything other than Bluetooth able to find people right now?
   *
   * A single flag over several transports has to be an OR, not "whichever
   * reported last". Both local-network transports emit at startup, so the
   * last-wins version genuinely landed on whichever finished second.
   */
  async wifiDiscoveryAvailable(): Promise<boolean> {
    if (!this.host) return false;
    for (const transport of this.host.all()) {
      if (transport.kind === TransportKind.BLE) continue;
      if ((await transport.availability()).available) return true;
    }
    return false;
  }

  private async publishRadioState(): Promise<void> {
    for (const transport of this.host.all()) {
      const availability = await transport.availability();
      this.events.emit('radioChanged', {
        transport: transport.kind,
        available: availability.available,
        detail: availability.available ? '' : availability.reason ?? '',
      });
    }
  }

  private wireTransport(transport: Transport): void {
    this.unsubscribers.push(
      transport.events.on('peerDiscovered', ({ peer }) => {
        // Never list ourselves. See `ownTokens`.
        if (peer.advertisementToken && this.ownTokens.has(toHex(peer.advertisementToken))) return;
        this.registry.observe(peer);
      }),
      transport.events.on('peerLost', ({ endpointId }) => {
        this.registry.forgetEndpoint(transport.kind, endpointId);
      }),
      transport.events.on('incomingLink', ({ link }) => {
        void this.acceptIncoming(link.endpointId, link);
      }),
      transport.events.on('availabilityChanged', ({ availability }) => {
        this.events.emit('radioChanged', {
          transport: transport.kind,
          available: availability.available,
          detail: availability.detail ?? availability.reason ?? '',
        });
      }),
    );
  }

  /**
   * Advertise, cycling through friends.
   *
   * A device with several friends has several tokens to broadcast - one per
   * friendship, so two friends cannot compare notes and prove they saw the same
   * phone - and a BLE advertisement has room for one. So we rotate: a friend in
   * range is recognised within `friends.length` slots, which at four seconds a
   * slot is well under a minute even for a long list.
   *
   * With no friends at all we still broadcast a random token, so a new device
   * looks exactly like an established one to anyone watching.
   */
  private async startAdvertising(): Promise<void> {
    const advertise = async (): Promise<void> => {
      const friends = this.trust
        .list()
        .filter((f) => f.selfAdvertisementKey)
        .map((f) => ({ peerId: f.peerId, advertisementKey: f.selfAdvertisementKey as Uint8Array }));

      const rotation = tokenRotation(friends, this.advertisingSlot++, Date.now());
      const token = rotation?.token ?? systemRandom.randomBytes(6);

      this.ownTokens.add(toHex(token));
      // Keep only the recent ones: a stale token cannot be advertised any more,
      // and an unbounded set would be a slow leak on a long flight.
      if (this.ownTokens.size > 32) {
        const oldest = this.ownTokens.values().next().value;
        if (oldest !== undefined) this.ownTokens.delete(oldest);
      }
      const displayName = this.repositories.users.get()?.displayName ?? '';

      for (const transport of this.host.all()) {
        const availability = await transport.availability();
        if (!availability.available) continue;
        try {
          await transport.startAdvertising({
            protocolVersion: PROTOCOL_VERSION,
            token,
            // The name is only useful to a stranger; a friend's name comes from
            // the trust store, which an attacker cannot influence.
            displayName,
          });
        } catch (err) {
          this.log.debug('advertising failed', { transport: transport.kind, err: String(err) });
        }
      }
    };

    await advertise();
    this.advertiseTimer = setInterval(() => void advertise(), 4000);
  }

  private async startDiscovery(): Promise<void> {
    for (const transport of this.host.all()) {
      const availability = await transport.availability();
      if (!availability.available) continue;
      try {
        await transport.startDiscovery();
      } catch (err) {
        this.log.debug('discovery failed', { transport: transport.kind, err: String(err) });
      }
    }
  }

  private resolveAdvertisementToken(token: Uint8Array): string | null {
    const candidates = this.trust
      .list()
      .filter((f) => f.advertisementKey)
      .map((f) => ({ peerId: f.peerId, advertisementKey: f.advertisementKey as Uint8Array }));
    return matchAdvertisementToken(token, candidates, Date.now());
  }

  nearby(): ReturnType<NearbyRegistry['list']> {
    return this.registry?.list() ?? [];
  }

  // -- sessions --------------------------------------------------------------

  /** Connect to a peer the registry is showing. */
  async connect(peerKey: string): Promise<void> {
    const preference = this.capabilities
      .availableProfiles()
      .sort((a, b) => b.preference - a.preference)
      .map((p) => p.kind);
    const target = this.registry.bestEndpointFor(peerKey, preference);
    if (!target) throw new Error('That device is no longer nearby.');

    const transport = this.host.get(target.transport);
    if (!transport) throw new Error('That connection type is not available.');

    const link = await transport.connect(target.endpointId, { timeoutMs: 20_000 });
    const handle = this.createHandle(peerKey);
    await handle.session.startAsInitiator(link);
  }

  private async acceptIncoming(endpointId: string, link: Parameters<PeerSession['startAsResponder']>[0]): Promise<void> {
    // A peer we already hold a session with is MIGRATING, not re-introducing
    // itself - that is what makes a transport upgrade invisible.
    for (const handle of this.peers.values()) {
      if (handle.session.isSecure && handle.session.currentLink?.endpointId === endpointId) {
        handle.session.migrateToLink(link);
        return;
      }
    }
    const handle = this.createHandle(endpointId);
    handle.session.startAsResponder(link);
  }

  private createHandle(peerKey: string): PeerHandle {
    const existing = this.peers.get(peerKey);
    if (existing) return existing;

    const session = new PeerSession(peerKey, {
      clock: systemClock,
      logger: this.log,
      handshake: {
        identity: this.identity,
        capabilities: this.localCapabilities(),
        random: systemRandom,
        lookupTrustedKey: (peerId) => this.trust.get(peerId),
      },
    });

    const pairing = new PairingController(session, {
      clock: systemClock,
      trustStore: this.trust,
      identity: this.identity,
      random: systemRandom,
      logger: this.log,
    });

    const chat = new ChatProtocol(session, {
      clock: systemClock,
      random: systemRandom,
      logger: this.log,
    });

    const handle: PeerHandle = { key: peerKey, peerId: null, session, chat, pairing };
    this.peers.set(peerKey, handle);
    this.wireSession(handle);
    return handle;
  }

  private wireSession(handle: PeerHandle): void {
    const { session, pairing } = handle;

    session.events.on('stateChanged', ({ state }) => {
      const link = session.currentLink;
      const quality = link
        ? connectionQualityFromLink(link.metrics(), { connected: state === ConnectionState.CONNECTED })
        : null;
      if (session.peerId) this.registry.setConnected(session.peerId, state === ConnectionState.CONNECTED);
      this.events.emit('connectionChanged', { peerKey: handle.key, state, quality });
    });

    session.events.on('error', ({ message, fatal }) => {
      this.events.emit('error', { message, fatal });
    });

    session.events.on('closed', () => {
      this.peers.delete(handle.key);
    });

    pairing.events.on('confirmationRequired', (event) => {
      this.events.emit('pairingRequired', {
        peerKey: handle.key,
        displayName: event.displayName,
        code: event.sasCode,
      });
    });

    pairing.events.on('paired', (event) => {
      this.events.emit('pairingResolved', { peerKey: handle.key, trusted: true });
      this.trust.touch(event.peer.peerId, Date.now());
    });

    pairing.events.on('refused', () => {
      this.events.emit('pairingResolved', { peerKey: handle.key, trusted: false });
    });
  }

  /** The user compared the six digits and they matched. */
  confirmPairing(peerKey: string): void {
    this.peers.get(peerKey)?.pairing.confirm();
  }

  /** They did not match: something is wrong, and the session must end. */
  declinePairing(peerKey: string): void {
    this.peers.get(peerKey)?.pairing.decline();
  }

  peer(peerKey: string): PeerHandle | undefined {
    return this.peers.get(peerKey);
  }

  connectedPeers(): PeerHandle[] {
    return [...this.peers.values()].filter((h) => h.session.state === ConnectionState.CONNECTED);
  }

  async disconnect(peerKey: string): Promise<void> {
    await this.peers.get(peerKey)?.session.close('disconnected by user');
  }

  // -- capability ------------------------------------------------------------

  /**
   * What we tell a peer we can do.
   *
   * The game list comes from the registry rather than a hand-maintained
   * constant, so a game appears here only because it really exists - which is
   * what stops an invite arriving for something the other side cannot play.
   */
  private localCapabilities(): PeerCapabilities {
    const user = this.repositories.users.get();
    return {
      protocolVersion: PROTOCOL_VERSION,
      appVersion: this.options.appVersion,
      platform: this.options.platform,
      deviceModel: this.options.deviceModel,
      displayName: user?.displayName ?? brand.name,
      deviceId: this.identity.deviceId,
      transports: this.capabilities.availableKinds(),
      features: ['chat', 'reactions', 'typing', 'receipts', 'files', 'games', 'sync', 'groups', 'transportUpgrade'],
      games: gameCapabilities(),
      maxPayloadBytes: 256 * 1024,
    };
  }

  /** Everything Developer Mode shows. */
  diagnostics(): Record<string, unknown> {
    return {
      peerId: this.identity?.peerId ?? null,
      deviceId: this.identity?.deviceId ?? null,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: this.options.appVersion,
      platform: this.options.platform,
      transports: this.capabilities?.diagnostics() ?? null,
      nativeCapabilities: this.host?.deviceCapabilities ?? null,
      sessions: [...this.peers.values()].map((h) => h.session.diagnostics()),
      nearby: this.nearby().length,
      friends: this.trust?.list().length ?? 0,
    };
  }

  /** Token this device is currently broadcasting, for Developer Mode. */
  currentAdvertisementToken(): Uint8Array | null {
    const friends = this.trust
      .list()
      .filter((f) => f.selfAdvertisementKey)
      .map((f) => ({ peerId: f.peerId, advertisementKey: f.selfAdvertisementKey as Uint8Array }));
    const rotation = tokenRotation(friends, this.advertisingSlot, Date.now());
    return rotation?.token ?? null;
  }
}

export { deriveAdvertisementToken, LOCAL_NETWORK_SERVICE_TYPE };
