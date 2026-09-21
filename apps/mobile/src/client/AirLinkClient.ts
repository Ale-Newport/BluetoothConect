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
  SelfIdentityGuard,
  PairingController,
  PeerSession,
  ReconnectPolicy,
  TIMING,
  TransportCapabilityManager,
  TransportKind,
  TypedEmitter,
  connectionQualityFromLink,
  deriveAdvertisementToken,
  initiatorWins,
  localPeerIdentity,
  newDiscoveryId,
  newUuidLike,
  shortId,
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
  type TransportUnavailableReason,
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

/**
 * How long a dial may take before it is abandoned.
 *
 * Matched deliberately to `ConnectionState.CONNECTING`'s own timeout in the
 * state machine. They used to differ, so the two clocks raced and which of them
 * fired first decided whether the user saw "couldn't reach them" or a spinner
 * that never resolved.
 */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * A uniform fraction in [0, 1), from the same CSPRNG as everything else.
 *
 * `ReconnectPolicy` wants a float and the random source deals in bytes. It is
 * used only for backoff jitter, which is not a security decision - but reaching
 * for `Math.random` in a file where every other random byte is cryptographic is
 * the kind of inconsistency that later gets copied somewhere it does matter.
 */
/**
 * How many packets a session has successfully decrypted.
 *
 * Read through `diagnostics()` rather than a dedicated accessor because that is
 * where `PeerSession` already publishes it, and this is the only caller. Zero
 * for a session with no secure channel yet.
 */
function packetsReceivedOf(session: PeerSession): number {
  const value = session.diagnostics().packetsReceived;
  return typeof value === 'number' ? value : 0;
}

function randomFraction(): number {
  const bytes = systemRandom.randomBytes(4);
  const value =
    (((bytes[0] as number) << 24) | ((bytes[1] as number) << 16) | ((bytes[2] as number) << 8) | (bytes[3] as number)) >>>
    0;
  return value / 0x1_0000_0000;
}

/**
 * States in which a session is alive and working towards being usable.
 *
 * A second `connect()` for a peer in any of these must leave it alone; every
 * other state is a finished attempt that is safe to clear and redial.
 *
 * It used to be CONNECTING and AUTHENTICATING only, with "anything else is a
 * corpse" as the fall-through - and PAIRING was anything else. A session
 * showing six digits is authenticated but not yet secure, since it becomes
 * usable only once both people confirm, so neither the secure check nor the
 * dialling check caught it. Any second call - a retry, a reconnect, a second
 * tap - threw away the live ceremony the user was reading, refused it, and
 * dialled a new one they had never seen. Found on three simulators, where
 * pairing failed with both people having confirmed the same digits.
 *
 * Written as an explicit list rather than a negative check so that a new state
 * added later is treated as finished by default: the failure mode of guessing
 * wrong that way is a redial, not a destroyed ceremony.
 */
const IN_PROGRESS: ReadonlySet<ConnectionState> = new Set([
  ConnectionState.CONNECTING,
  ConnectionState.AUTHENTICATING,
  ConnectionState.NEGOTIATING_TRANSPORT,
  ConnectionState.PAIRING,
]);

export interface PeerHandle {
  /**
   * The canonical name for this peer: its peer id once the handshake has
   * produced one, and a discovery-row key or an `inbound:` placeholder before
   * that. There used to be two namespaces here that never met, which is why a
   * connected friend could be shown a Connect button.
   */
  readonly key: string;
  /** Cryptographic identity, once known. */
  peerId: string | null;
  /** The remote installation, from the capability exchange. Breaks dial ties. */
  installationId: string | null;
  readonly session: PeerSession;
  readonly chat: ChatProtocol;
  readonly pairing: PairingController;
  /**
   * The name a six-digit prompt was RAISED under, held until it is answered.
   *
   * `key` is not stable across a pairing: `adoptIdentity` renames the handle
   * from its discovery key onto the peer id the moment the session enters
   * PAIRING, and that can land between the prompt going up and the answer
   * coming back. The pending pairing lives in the store under the name it was
   * raised with, so it has to be taken down under that same name. Resolving it
   * under the NEW key found nothing and removed nothing: both people confirmed,
   * the friendship was recorded and the session came up Connected, and both
   * screens still waited forty-five seconds and then said "Couldn't connect".
   */
  pairingKey: string | null;
  /**
   * Identifies THIS attempt at THIS peer.
   *
   * A radio callback can arrive long after the attempt that asked for it was
   * abandoned. Every such callback is checked against the attempt that is
   * current now, and a stale one is dropped instead of being allowed to attach
   * a link to a session that has moved on.
   */
  readonly attemptId: string;
  /**
   * Every name this handle has ever been filed under.
   *
   * Re-keying onto the peer id is what makes a session findable by the presence
   * layer - but anything the interface was already holding still names it the
   * OLD way, and a screen cannot be asked to notice that its peer was renamed
   * underneath it. The six-digit prompt is the case that proved it: `pairing`
   * is raised with the key the row had, the handshake then renames the handle,
   * and "They match" resolved to nothing at all. Both phones sat showing the
   * code until the two-minute pairing timeout gave up.
   *
   * So a handle answers to every name it has had. They are ours, they are
   * bounded by the number of times one session can be re-keyed - once - and
   * they die with the handle.
   */
  readonly aliases: Set<string>;
  /**
   * Packets received at the moment this session was last migrated onto a new
   * link, or null if it never has been.
   *
   * A migration keeps the keys and assumes THE PEER STILL HAS THEM TOO. That is
   * true for a pocket, a walk out of range, or a transport upgrade - and false
   * for a peer whose app restarted, which threw its keys away and is trying to
   * run a fresh handshake. Migrating into that produces a session this device
   * believes is healthy and the other end cannot read: one phone shows
   * "Connected" and a live green dot while the other shows the person as merely
   * nearby, and nothing either of them does arrives.
   *
   * So a migration is provisional until something actually comes back. If the
   * link drops again without a single packet having been received, the
   * migration was into a void and the session is rebuilt from nothing instead.
   */
  migratedAtPackets: number | null;
  readonly startedAt: number;
  /** Everything subscribed on behalf of this handle, so it can all be undone. */
  readonly offs: (() => void)[];
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
  radioChanged: {
    readonly transport: TransportKind;
    readonly available: boolean;
    readonly detail: string;
    /**
     * Why it is unavailable. The interface needs this to tell "switched off"
     * from "permission declined" from "this hardware has no radio" - the first
     * two are worth offering Settings for and the third is not.
     */
    readonly reason: TransportUnavailableReason | null;
  };
  error: { readonly message: string; readonly fatal: boolean };
  /**
   * A line from the radios themselves.
   *
   * The native layer has always produced these - every Swift and Kotlin
   * transport calls `log(level:message:)` - and until now nothing subscribed to
   * them, so they were emitted across the bridge and dropped. That is the half
   * of the story you most want when a connection fails on a phone with no
   * laptop attached, which is precisely what Developer Mode is for.
   */
  nativeLog: { readonly level: string; readonly scope: string; readonly message: string };
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
  private selfGuard!: SelfIdentityGuard;
  /**
   * This installation's identifier for the run, broadcast on every transport.
   *
   * Fresh on every launch, so it links nothing across time, and constant while
   * the app runs, so recognising our own advertisement is exact rather than a
   * race against a rotation. See `packages/core/src/presence/identity.ts`.
   */
  private readonly discoveryId = newDiscoveryId(systemRandom);
  private advertiseTimer: ReturnType<typeof setInterval> | undefined;
  private inboundCounter = 0;
  /** Transports already scanning, so re-arming one is idempotent. */
  private readonly armed = new Set<TransportKind>();
  /** One pending redial per session. See `scheduleReconnect`. */
  private readonly reconnects = new Map<string, ReturnType<typeof setTimeout>>();
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
    const profile = this.repositories.users.get();
    // The keystore is the authority on who we are. If the profile row disagrees
    // - which happens after a restore, or a reinstall over an existing database
    // - it is corrected here rather than left to poison every "is this for me?"
    // question in the app. A stale peer id silently discarded game invitations
    // that named us perfectly correctly.
    if (profile && profile.peerId !== existing.peerId) {
      const publicIdentity = publicIdentityOf(existing);
      this.repositories.users.adoptIdentity(
        publicIdentity.peerId,
        publicIdentity.identityKey,
        existing.deviceId,
        Date.now(),
      );
      this.log.info('profile identity reconciled with the keystore', {
        was: shortId(profile.peerId),
        now: shortId(publicIdentity.peerId),
      });
    }

    return { hasIdentity: true, hasProfile: profile !== null };
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

  /**
   * Developer Mode: pretend a radio is not there.
   *
   * Exists because the iOS Simulator has no Bluetooth radio, so "what does the
   * app do with no Wi-Fi?" is otherwise unanswerable without turning off the
   * Mac's Wi-Fi - which hits both simulators at once and takes the host's own
   * network with it. Goes through the real availability path, so the UI and
   * the session teardown behave exactly as they do on a phone that has walked
   * out of range. Session-lifetime only: nothing is persisted, so a restart is
   * always a way back.
   */
  async setTransportSuppressed(kind: TransportKind, on: boolean): Promise<void> {
    await this.host?.setSuppressed(kind, on);
  }

  /** Which transports Developer Mode is holding down right now. */
  suppressedTransports(): TransportKind[] {
    return this.host?.suppressedKinds() ?? [];
  }

  /**
   * Take every non-Bluetooth radio away, or give them all back.
   *
   * "No Wi-Fi" has to mean EVERY non-BLE transport, for the same reason
   * `wifiDiscoveryAvailable` is an OR over them: switching off the local
   * network while Apple peer-to-peer Wi-Fi keeps finding the peer would make
   * the switch look broken and prove nothing.
   */
  async setWifiSuppressed(on: boolean): Promise<void> {
    for (const transport of this.host?.all() ?? []) {
      if (transport.kind === TransportKind.BLE) continue;
      await this.setTransportSuppressed(transport.kind, on);
    }
  }

  /** True when Developer Mode is holding down at least one Wi-Fi transport. */
  wifiSuppressed(): boolean {
    return this.suppressedTransports().some((kind) => kind !== TransportKind.BLE);
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

    // Built before any transport is wired, because the very first discovery
    // event can arrive during registration and must have something to be
    // checked against.
    this.selfGuard = new SelfIdentityGuard({
      clock: systemClock,
      onIgnored: ({ transport, endpointId, reason }) => {
        this.log.debug('DISCOVERY_IGNORED_SELF', { transport, endpoint: endpointId, matched: reason });
      },
    });
    this.selfGuard.setIdentity(
      localPeerIdentity(this.identity, this.discoveryId, this.repositories.users.get()?.displayName ?? ''),
    );

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
      // Radio lines go both into this client's own buffer, so a bug report
      // carries them, and out as an event, so Developer Mode can show them
      // live. They were being emitted to nobody before.
      this.host.logs.on('log', ({ level, scope, message }) => {
        this.log.info(`[${scope}] ${message}`, { level });
        this.events.emit('nativeLog', { level, scope, message });
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
        // `detail` is shown to a person, so it takes the transport's own
        // sentence - never `reason`, which is an identifier like
        // "unsupportedHardware" and was being rendered verbatim at launch.
        detail: availability.available ? '' : availability.detail ?? '',
        reason: availability.available ? null : availability.reason ?? null,
      });
    }
  }

  private wireTransport(transport: Transport): void {
    this.unsubscribers.push(
      transport.events.on('peerDiscovered', ({ peer }) => {
        // Never list ourselves. ONE filter, shared by every transport, so a new
        // radio cannot arrive without one and the three that existed cannot
        // drift apart. See `SelfIdentityGuard`.
        const self = this.selfGuard.check(peer);
        if (self.isSelf) return;
        this.log.debug('discovery: peer seen', {
          transport: transport.kind,
          endpoint: peer.endpointId,
          name: peer.advertisedName ?? '',
          discoveryId: shortId(peer.discoveryId),
        });
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
          detail: availability.detail ?? '',
          reason: availability.available ? null : availability.reason ?? null,
        });
        // A radio that was off at launch used to stay dark for the rest of the
        // session: discovery was armed exactly once, and a transport that was
        // not ready in that instant was skipped for ever. Turning Bluetooth on
        // afterwards did nothing at all, which looked precisely like the app
        // failing to find anybody.
        if (availability.available) void this.armTransport(transport);
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

      this.selfGuard.noteAdvertisedToken(token);
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
            // Eight bytes that say "this is the same phone" across every radio,
            // and "this is me" when it comes back on our own browser.
            discoveryId: this.discoveryId,
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
    for (const transport of this.host.all()) await this.armTransport(transport);
  }

  /**
   * Bring one transport up: scanning, and advertising with the current token.
   *
   * Called at startup for every radio and again whenever one becomes available,
   * so a radio switched on mid-flight joins in rather than staying dark.
   */
  private async armTransport(transport: Transport): Promise<void> {
    if (!this.started && this.armed.has(transport.kind)) return;
    try {
      const availability = await transport.availability();
      if (!availability.available) return;
      await transport.startDiscovery();
      this.armed.add(transport.kind);
      this.log.info('transport armed', { transport: transport.kind });
    } catch (err) {
      this.log.debug('discovery failed', { transport: transport.kind, err: String(err) });
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

  /**
   * Connect to a peer the registry is showing.
   *
   * Three guards stand in front of the radio, and every one of them was learned
   * from a phone doing the wrong thing:
   *
   *   ALREADY CONNECTED wins outright. A row that reappeared because a friend
   *   rotated their advertisement used to be a second Connect button over a
   *   live session, and pressing it opened a second link that fought the first.
   *
   *   ALREADY DIALLING is joined, not repeated. Two taps used to be two links.
   *
   *   A FAILED ATTEMPT LEAVES NOTHING BEHIND. The half-built handle used to stay
   *   in the map, and `createHandle` handed it back for ever afterwards, so one
   *   failure poisoned every later attempt at that peer until the app restarted.
   *   That is most of what "connecting is flaky" actually was.
   */
  async connect(peerKey: string): Promise<void> {
    const existing = this.peer(peerKey);
    if (existing) {
      const state = existing.session.state;
      if (state === ConnectionState.CONNECTED || existing.session.isSecure) {
        this.log.info('connect: already connected', { peer: shortId(peerKey) });
        return;
      }
      if (IN_PROGRESS.has(state)) {
        this.log.info('connect: already in progress', { peer: shortId(peerKey), state });
        return;
      }
      // Anything else is a corpse from an earlier attempt. Clear it out rather
      // than reusing it: `startAsInitiator` on a session that already ran a
      // handshake attaches a second link without detaching the first.
      await this.discardHandle(existing, 'stale handle replaced by a new attempt');
    }

    const preference = this.capabilities
      .availableProfiles()
      .sort((a, b) => b.preference - a.preference)
      .map((p) => p.kind);
    const target = this.registry.bestEndpointFor(peerKey, preference);
    if (!target) throw new Error('That device is no longer nearby.');

    const transport = this.host.get(target.transport);
    if (!transport) throw new Error('That connection type is not available.');

    const handle = this.createHandle(peerKey);
    const attemptId = handle.attemptId;
    this.log.info('connection attempt started', {
      peer: shortId(peerKey),
      attempt: shortId(attemptId),
      transport: target.transport,
    });

    try {
      const link = await transport.connect(target.endpointId, { timeoutMs: CONNECT_TIMEOUT_MS });
      // The world moved while the radio was working. A link that belongs to an
      // attempt nobody is waiting for any more is closed rather than attached -
      // this is the guard whose absence let a cancelled dial complete anyway.
      if (this.peers.get(handle.key) !== handle || handle.attemptId !== attemptId) {
        this.log.info('connect: attempt superseded, dropping link', { attempt: shortId(attemptId) });
        await link.close('superseded').catch(() => undefined);
        return;
      }
      await handle.session.startAsInitiator(link);
    } catch (err) {
      await this.discardHandle(handle, 'connection attempt failed');
      this.log.info('connection attempt failed', {
        peer: shortId(peerKey),
        attempt: shortId(attemptId),
        err: String(err),
      });
      throw err;
    }
  }

  private async acceptIncoming(endpointId: string, link: Parameters<PeerSession['startAsResponder']>[0]): Promise<void> {
    // A peer we already hold a session with is MIGRATING, not re-introducing
    // itself - that is what makes a transport upgrade invisible. Matching on
    // the endpoint alone could never see an upgrade, because an upgrade arrives
    // on a DIFFERENT transport with a different handle by definition.
    for (const handle of this.peers.values()) {
      if (!handle.session.isSecure) continue;
      const sameEndpoint = handle.session.currentLink?.endpointId === endpointId;
      const linkGone = handle.session.currentLink === null || handle.session.state === ConnectionState.RECONNECTING;
      if (sameEndpoint || linkGone) {
        this.log.info('inbound link adopted by an existing session', {
          peer: shortId(handle.peerId ?? handle.key),
        });
        handle.session.migrateToLink(link);
        return;
      }
    }

    // Nobody knows who this is yet; the handshake will say. Keyed on a name of
    // our own so it can never collide with a discovery row, and re-keyed onto
    // the peer id the moment there is one.
    const handle = this.createHandle(`inbound:${++this.inboundCounter}`);
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

    const handle: PeerHandle = {
      key: peerKey,
      peerId: null,
      installationId: null,
      session,
      chat,
      pairing,
      attemptId: newUuidLike(systemRandom).slice(0, 16),
      pairingKey: null,
      aliases: new Set([peerKey]),
      migratedAtPackets: null,
      startedAt: Date.now(),
      offs: [],
    };
    this.peers.set(peerKey, handle);
    this.wireSession(handle);
    return handle;
  }

  /**
   * Give a handle its real name, now that the handshake has produced one.
   *
   * The write-side half of "connected means connected", and the end of the two
   * key namespaces that caused most of the visible damage. Until now an
   * outgoing session was filed under a discovery row's key and an incoming one
   * under a transport handle, so the Home screen could hold a live session it
   * was completely unable to find - and drew a Connect button over it.
   *
   * This is also where a simultaneous dial is resolved. Both phones ring at
   * once, both answer, and both end up holding two sessions for one person;
   * exactly one of them survives, chosen by comparing the two installation ids,
   * which both sides can do independently and reach the same answer.
   */
  /**
   * Take down a six-digit prompt under the name it was raised with.
   *
   * See `PeerHandle.pairingKey`. Falls back to the current key for a session
   * that never raised a prompt at all - a friend recognised silently, or one
   * torn down before the ceremony started - where there is nothing pending and
   * the event only tells listeners the attempt is over.
   */
  private resolvePairing(handle: PeerHandle, trusted: boolean): void {
    const peerKey = handle.pairingKey ?? handle.key;
    handle.pairingKey = null;
    this.events.emit('pairingResolved', { peerKey, trusted });
  }

  private adoptIdentity(handle: PeerHandle): void {
    const peerId = handle.session.peerId;
    if (!peerId) return;
    handle.peerId = peerId;
    handle.installationId = handle.session.capabilities?.deviceId ?? null;

    const incumbent = [...this.peers.values()].find((other) => other !== handle && other.peerId === peerId);
    if (incumbent) {
      const loser = this.loserOf(incumbent, handle);
      const winner = loser === handle ? incumbent : handle;
      this.log.info('duplicate session resolved', {
        peer: shortId(peerId),
        kept: shortId(winner.attemptId),
        dropped: shortId(loser.attemptId),
      });
      void this.discardHandle(loser, 'duplicate session for the same peer');
      if (loser === handle) return;
    }

    if (handle.key !== peerId) {
      handle.aliases.add(handle.key);
      handle.aliases.add(peerId);
      this.peers.delete(handle.key);
      // The registry row that produced this session gets the identity too, so
      // every later sighting of this person lands on the row the session is on.
      this.registry?.bindIdentity(handle.key, {
        peerId,
        installationId: handle.installationId,
        displayName: this.trust.record(peerId)?.displayName ?? null,
      });
      (handle as { key: string }).key = peerId;
      this.peers.set(peerId, handle);
    } else {
      this.registry?.bindIdentity(peerId, { peerId, installationId: handle.installationId });
    }
  }

  /**
   * Which of two competing sessions for one person is thrown away.
   *
   * A secure session always beats one still handshaking - throwing away a
   * finished handshake to keep an unfinished one would be perverse. Otherwise
   * the two installation ids decide, which is arbitrary, symmetric and needs no
   * round trip: both phones compute it from the same pair and necessarily
   * disagree about who wins, which is the point.
   */
  private loserOf(a: PeerHandle, b: PeerHandle): PeerHandle {
    if (a.session.isSecure !== b.session.isSecure) return a.session.isSecure ? b : a;
    const local = this.identity.deviceId;
    const remoteA = a.installationId;
    const remoteB = b.installationId;
    if (remoteA && remoteB && remoteA === remoteB) {
      // One person, two links. The side that should have initiated keeps its
      // own attempt; the other keeps the one it accepted.
      const weInitiate = initiatorWins(local, remoteA);
      const aIsOurs = a.key.startsWith('inbound:') === false;
      return weInitiate ? (aIsOurs ? b : a) : aIsOurs ? a : b;
    }
    // Fall back to age: the older session has done more work.
    return a.startedAt <= b.startedAt ? b : a;
  }

  /**
   * Dial again, because nothing else was going to.
   *
   * `RECONNECTING` keeps the keys, the queued messages and the game in progress
   * and merely waits for a link - which is the whole reason walking out of range
   * and back is survivable. But nothing ever supplied that link. The state had
   * no driver and no timeout, so a session that lost its radio sat in
   * "Reconnecting…" for the rest of the flight while the board it was protecting
   * stayed perfectly intact and perfectly unusable.
   *
   * Backoff is jittered, because two phones that lose each other retry in
   * lockstep and collide on the radio every single time otherwise.
   */
  private scheduleReconnect(handle: PeerHandle): void {
    if (this.reconnects.has(handle.key)) return;

    /*
     * Did the last migration land on anything?
     *
     * Being back here with no more packets than we had when we migrated means
     * the peer never answered - almost always because its app restarted and no
     * longer holds these keys. Migrating again would produce the same silence
     * and the same lie on screen, so the session is torn down and the next
     * connection builds a real one.
     */
    if (handle.migratedAtPackets !== null && packetsReceivedOf(handle.session) <= handle.migratedAtPackets) {
      this.log.info('migration reached nobody; rebuilding the session', {
        peer: shortId(handle.peerId ?? handle.key),
      });
      void this.discardHandle(handle, 'the peer no longer holds this session');
      return;
    }
    handle.migratedAtPackets = null;

    const policy = new ReconnectPolicy(TIMING.reconnectBackoffMs, randomFraction);
    const attempt = (): void => {
      // Anything that ended the session ends this too: the handle was replaced,
      // it reconnected on its own, or it was closed.
      if (this.peers.get(handle.key) !== handle || handle.session.state !== ConnectionState.RECONNECTING) {
        this.cancelReconnect(handle);
        return;
      }
      if (policy.exhausted) {
        this.log.info('reconnect gave up', { peer: shortId(handle.peerId ?? handle.key) });
        this.cancelReconnect(handle);
        void this.discardHandle(handle, 'could not reconnect');
        return;
      }

      void this.redial(handle).then((reconnected) => {
        if (reconnected) {
          this.cancelReconnect(handle);
          return;
        }
        const timer = setTimeout(attempt, policy.nextDelayMs());
        this.reconnects.set(handle.key, timer);
      });
    };

    const timer = setTimeout(attempt, policy.nextDelayMs());
    this.reconnects.set(handle.key, timer);
    this.log.info('reconnecting', { peer: shortId(handle.peerId ?? handle.key) });
  }

  private cancelReconnect(handle: PeerHandle): void {
    const timer = this.reconnects.get(handle.key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.reconnects.delete(handle.key);
  }

  /**
   * One attempt at a new link for an existing session.
   *
   * `migrateToLink` rather than a fresh handshake: the keys are still good, the
   * unacknowledged messages are still queued, and the peer sees a pause rather
   * than a reconnection.
   */
  private async redial(handle: PeerHandle): Promise<boolean> {
    const preference = this.capabilities
      .availableProfiles()
      .sort((a, b) => b.preference - a.preference)
      .map((p) => p.kind);
    const target =
      this.registry.bestEndpointFor(handle.key, preference) ??
      (handle.peerId ? this.registry.bestEndpointFor(handle.peerId, preference) : null);
    if (!target) return false;

    const transport = this.host.get(target.transport);
    if (!transport) return false;

    try {
      const link = await transport.connect(target.endpointId, { timeoutMs: CONNECT_TIMEOUT_MS });
      // The session may have moved on while the radio worked.
      if (this.peers.get(handle.key) !== handle || !handle.session.isSecure) {
        await link.close('reconnect superseded').catch(() => undefined);
        return false;
      }
      handle.migratedAtPackets = packetsReceivedOf(handle.session);
      handle.session.migrateToLink(link);
      this.log.info('reconnected', { peer: shortId(handle.peerId ?? handle.key), transport: target.transport });
      return true;
    } catch (err) {
      this.log.debug('reconnect attempt failed', { err: String(err) });
      return false;
    }
  }

  /** Tear a handle down completely: listeners, session, map entry, registry pin. */
  private async discardHandle(handle: PeerHandle, reason: string): Promise<void> {
    for (const off of handle.offs) off();
    handle.offs.length = 0;
    this.cancelReconnect(handle);
    if (this.peers.get(handle.key) === handle) this.peers.delete(handle.key);
    // A six-digit prompt this session raised must go with it, or the user is
    // left comparing a code for a connection that no longer exists.
    this.resolvePairing(handle, false);
    // Optional because a handle can be discarded before `start()` has built a
    // registry - a session injected by a test, or a disconnect during launch.
    // Tearing one down must never depend on the radios having come up.
    if (handle.peerId) this.registry?.setConnected(handle.peerId, false);
    try {
      await handle.session.close(reason);
    } catch {
      // A session that will not close cleanly must still not keep the map.
    }
  }

  private wireSession(handle: PeerHandle): void {
    const { session, pairing } = handle;

    handle.offs.push(
      session.events.on('stateChanged', ({ state }) => {
        /*
         * As soon as the handshake has produced an identity - which is at
         * PAIRING, not only at CONNECTED.
         *
         * A first meeting reaches CONNECTED only after both people have compared
         * six digits, so arbitrating there was too late to help the case that
         * needed it most: both phones dialling at once, ending up with two
         * handshakes for one person, and showing two DIFFERENT codes. Whichever
         * one the pair happened to compare, the other never matched. Resolving
         * the duplicate here means only one ceremony is ever offered.
         */
        if (state === ConnectionState.CONNECTED || state === ConnectionState.PAIRING) {
          this.adoptIdentity(handle);
          if (this.peers.get(handle.key) !== handle) return; // We were the loser.
        }
        if (state === ConnectionState.RECONNECTING) this.scheduleReconnect(handle);
        if (state === ConnectionState.CONNECTED) this.cancelReconnect(handle);

        const link = session.currentLink;
        const quality = link
          ? connectionQualityFromLink(link.metrics(), { connected: state === ConnectionState.CONNECTED })
          : null;

        // Pin on every name this row might be under. A first meeting has no
        // peer id in the registry yet, and that is precisely the case that used
        // to be swept away fifteen seconds into a live conversation.
        const connected = state === ConnectionState.CONNECTED;
        for (const name of [handle.peerId, handle.installationId, handle.key]) {
          if (name) this.registry?.setConnected(name, connected);
        }

        this.log.info('session state', {
          peer: shortId(handle.peerId ?? handle.key),
          session: shortId(handle.attemptId),
          state,
        });
        this.events.emit('connectionChanged', { peerKey: handle.key, state, quality });
      }),

      session.events.on('error', ({ message, fatal }) => {
        // NEVER fatal to the application. One peer's handshake failing is a
        // connection that did not happen, not a broken app - and it used to
        // blank the whole interface to "Something went wrong" with no way back.
        this.log.info('session error', { peer: shortId(handle.peerId ?? handle.key), message, fatal });
        this.events.emit('error', { message, fatal: false });
      }),

      session.events.on('closed', () => {
        for (const off of handle.offs) off();
        handle.offs.length = 0;
        if (this.peers.get(handle.key) === handle) this.peers.delete(handle.key);
        for (const name of [handle.peerId, handle.installationId, handle.key]) {
          if (name) this.registry?.setConnected(name, false);
        }
        this.events.emit('connectionChanged', {
          peerKey: handle.key,
          state: ConnectionState.DISCONNECTED,
          quality: null,
        });
      }),

      pairing.events.on('confirmationRequired', (event) => {
        handle.pairingKey = handle.key;
        this.events.emit('pairingRequired', {
          peerKey: handle.pairingKey,
          displayName: event.displayName,
          code: event.sasCode,
        });
      }),

      pairing.events.on('paired', (event) => {
        this.resolvePairing(handle, true);
        this.trust.touch(event.peer.peerId, Date.now());
        this.adoptIdentity(handle);
      }),

      pairing.events.on('refused', () => {
        this.resolvePairing(handle, false);
      }),
    );
  }

  /** The user compared the six digits and they matched. */
  confirmPairing(peerKey: string): void {
    this.peer(peerKey)?.pairing.confirm();
  }

  /** They did not match: something is wrong, and the session must end. */
  declinePairing(peerKey: string): void {
    this.peer(peerKey)?.pairing.decline();
  }

  /**
   * The live session for a peer, by whichever name the caller has.
   *
   * There is now one canonical name - the peer id, adopted the moment the
   * handshake produces it - but a caller may legitimately still be holding the
   * discovery row key it started from, or the installation id from a
   * capability exchange. All three resolve here, and nowhere else.
   */
  peer(peerKey: string): PeerHandle | undefined {
    const direct = this.peers.get(peerKey);
    if (direct) return direct;
    for (const handle of this.peers.values()) {
      if (handle.peerId === peerKey) return handle;
      if (handle.session.peerId === peerKey) return handle;
      if (handle.installationId === peerKey) return handle;
      // And every name it has previously answered to. See `PeerHandle.aliases`.
      // Read defensively: this is the app's single peer lookup, it runs on
      // every render of the Home screen, and it must not be the thing that
      // throws.
      if (handle.aliases?.has(peerKey) === true) return handle;
    }
    return undefined;
  }

  connectedPeers(): PeerHandle[] {
    return [...this.peers.values()].filter((h) => h.session.state === ConnectionState.CONNECTED);
  }

  async disconnect(peerKey: string): Promise<void> {
    const handle = this.peer(peerKey);
    if (handle) await this.discardHandle(handle, 'disconnected by user');
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

  /**
   * Everything Developer Mode shows.
   *
   * Considerably more than it used to. Nearly every defect found on real phones
   * was invisible from the interface - a peer listed twice, a session keyed
   * under a name nothing else used, an invitation delivered to no listener -
   * and none of them could be seen without a laptop attached. What is added
   * here is exactly the state those bugs lived in: who we are, what discovery
   * currently believes, and what each session is actually keyed on.
   */
  diagnostics(): Record<string, unknown> {
    const identity = this.selfGuard?.local ?? null;
    return {
      peerId: this.identity?.peerId ?? null,
      installationId: this.identity?.deviceId ?? null,
      publicKeyFingerprint: identity?.publicKeyFingerprint ?? null,
      discoveryId: this.discoveryId,
      rememberedOwnTokens: this.selfGuard?.rememberedTokenCount ?? 0,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: this.options.appVersion,
      platform: this.options.platform,
      transports: this.capabilities?.diagnostics() ?? null,
      armedTransports: [...this.armed],
      nativeCapabilities: this.host?.deviceCapabilities ?? null,
      // Keyed by whatever the handle is keyed by, which is the thing worth
      // seeing: a session filed under something the presence layer does not
      // recognise is the shape of the worst bug this app had.
      sessions: [...this.peers.values()].map((h) => ({
        key: h.key,
        peerId: h.peerId,
        installationId: h.installationId,
        attemptId: h.attemptId,
        ageMs: Date.now() - h.startedAt,
        ...h.session.diagnostics(),
      })),
      // Every row discovery is holding, INCLUDING the ones being held back for
      // want of an identity - which is precisely what a screen full of
      // "Unknown Device" used to be.
      discovered: this.registry?.diagnostics() ?? [],
      nearby: this.nearby().length,
      friends: this.trust?.list().length ?? 0,
    };
  }

  /**
   * Everything the client has logged, oldest first.
   *
   * The buffer has always existed and nothing ever read it, so Developer Mode
   * could only show what happened after somebody opened Developer Mode - which
   * is never when the interesting thing happened. This is what makes a failed
   * connection legible after the fact, on a phone, with no laptop attached.
   */
  recentLog(): { at: number; level: string; scope: string; message: string }[] {
    return this.log.buffer.snapshot().map((entry) => ({
      at: entry.at,
      level: entry.level,
      scope: entry.scope,
      // The data bag is flattened rather than nested: this ends up in a text
      // report that somebody reads on a phone screen.
      message:
        entry.message +
        (entry.data
          ? ' ' +
            Object.entries(entry.data)
              .map(([key, value]) => `${key}=${String(value)}`)
              .join(' ')
          : ''),
    }));
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
