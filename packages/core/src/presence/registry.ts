/**
 * The nearby registry: one row per human, whatever the radios are doing.
 *
 * Discovery produces a mess. The same phone arrives over Bluetooth and over
 * Wi-Fi under two unrelated handles; an Android peer re-registers its Bonjour
 * service under a new name every few seconds; an iPhone's first Bluetooth
 * sighting carries neither a name nor a token, because iOS will not put service
 * data in an advertisement and the token has to be read from a characteristic
 * afterwards. Rendered raw, the Home screen showed one person four times, and
 * showed some of those four as "Unknown Device".
 *
 * Three rules collapse that stream, in descending order of trust:
 *
 *   1. IDENTITY. A recognised friend's rotating token resolves to a peer id,
 *      and a session that has completed its handshake binds one. Every sighting
 *      of that person merges, regardless of transport or handle.
 *
 *   2. DISCOVERY ID. One installation broadcasts ONE discovery id on every
 *      transport for as long as the app runs. Two sightings carrying the same
 *      one are the same device - which is what finally makes Bluetooth and
 *      Wi-Fi sightings of a stranger merge, and what survives an endpoint
 *      handle changing underneath us.
 *
 *   3. TOKEN. The fallback for a native layer that does not carry a discovery
 *      id yet. One device advertises one token at any instant, so two sightings
 *      carrying the same token are the same device.
 *
 * Merging strangers confers no trust: identity is established by the handshake
 * and the six digits, never by what a row was keyed on.
 *
 * TWO THINGS THIS REFUSES TO DO, both of which it used to do:
 *
 *   A HALF-IDENTIFIED PEER NEVER REACHES THE INTERFACE. A sighting with no
 *   identifier at all is held as `DISCOVERED_UNRESOLVED` for a few seconds
 *   while the transport fills it in, and is then discarded. It is not a row
 *   with a Connect button and the word "Unknown" on it.
 *
 *   A CONNECTED PEER IS NEVER OFFERED FOR CONNECTION. While a session is live,
 *   discovery of that peer updates its metadata - signal, transports, last
 *   seen - and can do nothing else. It cannot open a second row, it cannot be
 *   swept for going quiet, and it cannot be re-keyed out from under the
 *   session.
 */
import type { TransportKind } from '../protocol/capabilities.js';
import type { DiscoveredPeer } from '../transport/types.js';
import { toHex } from '../util/bytes.js';
import { PROTOCOL_VERSION, TIMING } from '../protocol/constants.js';
import { TypedEmitter } from '../util/emitter.js';
import type { Clock, TimerHandle } from '../util/time.js';
import { isValidDiscoveryId } from './identity.js';
import {
  NearbyKind,
  PeerResolution,
  Proximity,
  proximityFromRssi,
  type NearbyPeer,
} from './types.js';

/** Resolves an advertisement token to a peer id, or null for a stranger. */
export type TokenResolver = (token: Uint8Array) => string | null;

interface Sighting {
  readonly transport: TransportKind;
  readonly endpointId: string;
  rssi: number | undefined;
  lastSeenAt: number;
}

interface Entry {
  key: string;
  peerId: string | null;
  /** Persistent id of the remote installation, once a handshake has revealed it. */
  installationId: string | null;
  /** Per-run id from the advertisement. The strongest pre-handshake handle. */
  discoveryId: string | null;
  /** The token this row was last seen advertising, so a rotation can re-index. */
  tokenHex: string | null;
  protocolVersion: number | null;
  displayName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  connected: boolean;
  resolution: PeerResolution;
  /** One sighting per transport; a peer may be visible on several at once. */
  sightings: Map<TransportKind, Sighting>;
}

export interface NearbyRegistryEvents {
  /** The list changed in any way. The UI re-renders from `list()`. */
  changed: { readonly peers: readonly NearbyPeer[] };
  /** A trusted friend just came into range. Worth a haptic. */
  friendArrived: { readonly peer: NearbyPeer };
  friendLeft: { readonly peerId: string };
  /** A row was held back or thrown away. Developer Mode only. */
  resolutionChanged: {
    readonly key: string;
    readonly from: PeerResolution;
    readonly to: PeerResolution;
  };
}

export interface NearbyRegistryOptions {
  readonly clock: Clock;
  /** Resolve a rotating token to a known friend. */
  readonly resolveToken: TokenResolver;
  /** Look up a friend's stored display name, which beats an advertised one. */
  readonly friendName?: (peerId: string) => string | undefined;
  /**
   * How long a peer stays listed after its last sighting.
   *
   * Long enough to ride out a pocket or a passing body, short enough that
   * someone who walked off the plane disappears. Backgrounded iOS advertising
   * is throttled hard, so anything under about ten seconds flickers.
   */
  readonly staleAfterMs?: number;
  readonly sweepIntervalMs?: number;
  /**
   * How long a sighting with no usable identifier is kept while the transport
   * fills it in.
   *
   * iOS is the reason this is not zero: a Bluetooth peer arrives with no name
   * and no token, and both are filled in a moment later by a read of the
   * identity characteristic. Discarding immediately would make iPhones
   * invisible over Bluetooth; listing immediately is what produced a screen
   * full of "Unknown Device".
   */
  readonly resolveWindowMs?: number;
}

/**
 * Tied to the transport contract rather than chosen here.
 *
 * `TIMING.presenceRefreshMs` is how often a transport promises to re-announce a
 * peer it can still see; this is how long we wait before believing the silence.
 * Three missed beats, so a dropped packet or a busy radio does not evict
 * somebody standing in the room. See `TransportEvents.peerDiscovered`.
 */
const DEFAULT_STALE_AFTER_MS = TIMING.nearbyStaleAfterMs;
const DEFAULT_SWEEP_MS = 2_000;
/** Comfortably longer than one Bluetooth identity read, and still invisible. */
const DEFAULT_RESOLVE_WINDOW_MS = 8_000;

export class NearbyRegistry {
  readonly events = new TypedEmitter<NearbyRegistryEvents>();

  private readonly entries = new Map<string, Entry>();
  /** endpointId -> entry key, so a peerLost can find what it belongs to. */
  private readonly endpointIndex = new Map<string, string>();
  /**
   * Current advertisement token -> entry key.
   *
   * Only ever holds the token a row is advertising *now*: a rotation moves the
   * entry from the old token to the new one. A device that turns up later
   * carrying a token somebody else has since rotated away from is a different
   * device, and gets its own row.
   */
  private readonly tokenIndex = new Map<string, string>();
  /** discoveryId -> entry key. Stable for a whole app run, unlike the token. */
  private readonly discoveryIndex = new Map<string, string>();
  private sweepTimer: TimerHandle | undefined;
  private readonly staleAfterMs: number;
  private readonly resolveWindowMs: number;

  constructor(private readonly options: NearbyRegistryOptions) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.resolveWindowMs = options.resolveWindowMs ?? DEFAULT_RESOLVE_WINDOW_MS;
  }

  start(): void {
    this.stop();
    this.sweepTimer = this.options.clock.setInterval(
      () => this.sweep(),
      this.options.sweepIntervalMs ?? DEFAULT_SWEEP_MS,
    );
  }

  stop(): void {
    if (this.sweepTimer !== undefined) {
      this.options.clock.clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** Feed in a discovery event from any transport. */
  observe(peer: DiscoveredPeer): void {
    const now = this.options.clock.now();
    const resolvedPeerId = peer.advertisementToken ? this.options.resolveToken(peer.advertisementToken) : null;
    const tokenHex = peer.advertisementToken?.length ? toHex(peer.advertisementToken) : null;
    const discoveryId = isValidDiscoveryId(peer.discoveryId) ? peer.discoveryId : null;
    const endpointKey = `${peer.transport}:${peer.endpointId}`;

    // Which row does this sighting belong to? In order of how much the answer
    // can be trusted: a recognised friend's identity; the per-run discovery id,
    // which is the same on every radio this device owns; the row this endpoint
    // is already in, which carries a stranger across a token rotation; a row
    // already advertising this exact token; and failing all of those, a new row
    // keyed by the only handle we have.
    const key =
      resolvedPeerId ??
      (discoveryId ? this.discoveryIndex.get(discoveryId) : undefined) ??
      this.endpointIndex.get(endpointKey) ??
      (tokenHex ? this.tokenIndex.get(tokenHex) : undefined) ??
      endpointKey;

    let entry = this.entries.get(key);
    const isNew = entry === undefined;

    if (!entry) {
      // A peer may have been listed under a weaker handle and only now been
      // recognised - because the friend list finished loading, or because the
      // discovery id arrived on a later sighting. Fold the old row in, wherever
      // it happens to be keyed.
      const previousKey =
        this.endpointIndex.get(endpointKey) ??
        (discoveryId ? this.discoveryIndex.get(discoveryId) : undefined) ??
        (tokenHex ? this.tokenIndex.get(tokenHex) : undefined);
      const previous = previousKey && previousKey !== key ? this.entries.get(previousKey) : undefined;
      if (previous && previousKey) {
        this.entries.delete(previousKey);
        entry = { ...previous, key, peerId: resolvedPeerId ?? previous.peerId };
        // Re-point EVERY index that named the old row, not just the endpoint
        // this event arrived on. A peer is usually visible on more than one
        // transport at once, and an index left pointing at a deleted row is
        // worse than no index: `forgetEndpoint` for it finds nothing and gives
        // up silently, and a later sighting on it resolves to a dead entry and
        // opens a duplicate row for somebody already listed.
        for (const sighting of previous.sightings.values()) {
          this.endpointIndex.set(`${sighting.transport}:${sighting.endpointId}`, key);
        }
        if (previous.tokenHex !== null && this.tokenIndex.get(previous.tokenHex) === previousKey) {
          this.tokenIndex.set(previous.tokenHex, key);
        }
        if (previous.discoveryId !== null && this.discoveryIndex.get(previous.discoveryId) === previousKey) {
          this.discoveryIndex.set(previous.discoveryId, key);
        }
      } else {
        entry = {
          key,
          peerId: resolvedPeerId,
          installationId: null,
          discoveryId: null,
          tokenHex: null,
          protocolVersion: null,
          displayName: '',
          firstSeenAt: now,
          lastSeenAt: now,
          connected: false,
          resolution: PeerResolution.DISCOVERED_UNRESOLVED,
          sightings: new Map(),
        };
      }
      this.entries.set(key, entry);
    }

    if (resolvedPeerId && entry.peerId !== resolvedPeerId) entry.peerId = resolvedPeerId;

    // A stored friend name beats whatever the advertisement claims - the
    // advertised name is attacker-controlled and only useful for strangers.
    const storedName = entry.peerId ? this.options.friendName?.(entry.peerId) : undefined;
    entry.displayName = storedName ?? peer.advertisedName ?? entry.displayName;
    if (peer.protocolVersion !== undefined) entry.protocolVersion = peer.protocolVersion;

    // Fields are only ever filled in, never blanked. A scan response without a
    // name does not mean the peer withdrew the one it published a moment ago.
    if (discoveryId && discoveryId !== entry.discoveryId) {
      if (entry.discoveryId !== null && this.discoveryIndex.get(entry.discoveryId) === key) {
        this.discoveryIndex.delete(entry.discoveryId);
      }
      entry.discoveryId = discoveryId;
    }
    if (entry.discoveryId !== null) this.discoveryIndex.set(entry.discoveryId, key);

    // Re-index the token: a rotation must move this row rather than leave a
    // stale entry pointing at it, or a later stranger that happens to advertise
    // the abandoned token would be folded into somebody else's row.
    if (tokenHex !== entry.tokenHex) {
      if (entry.tokenHex !== null && this.tokenIndex.get(entry.tokenHex) === key) {
        this.tokenIndex.delete(entry.tokenHex);
      }
      if (tokenHex !== null) entry.tokenHex = tokenHex;
    }
    if (entry.tokenHex !== null) this.tokenIndex.set(entry.tokenHex, key);

    entry.lastSeenAt = now;
    // A transport slot holds one endpoint. When a device turns up on the same
    // radio under a NEW handle - which Android's Bonjour registration used to
    // do every four seconds, and a rotating BLE address does routinely - the
    // old handle's index entry has to go with it. Left behind it points at a
    // row that may since have been re-keyed, and a later sighting on it opens a
    // duplicate for somebody already listed.
    const displaced = entry.sightings.get(peer.transport);
    if (displaced && displaced.endpointId !== peer.endpointId) {
      this.endpointIndex.delete(`${displaced.transport}:${displaced.endpointId}`);
    }
    entry.sightings.set(peer.transport, {
      transport: peer.transport,
      endpointId: peer.endpointId,
      rssi: peer.rssi,
      lastSeenAt: now,
    });
    this.endpointIndex.set(endpointKey, key);

    const becameVisible = this.reassess(entry);
    this.emitChanged();
    if ((isNew || becameVisible) && entry.peerId && entry.resolution === PeerResolution.DISCOVERED_VALID) {
      this.events.emit('friendArrived', { peer: this.toPublic(entry) });
    }
  }

  /**
   * Attach a real identity to a row, once a handshake has revealed one.
   *
   * This is the write-side half of "connected means connected". A peer met for
   * the first time is discovered as a stranger, so its row has no peer id; when
   * the session completes, `setConnected(peerId)` had nothing to match and the
   * row kept its Connect button over a live, encrypted session. Binding the
   * identity to the row that produced the connection closes that gap, and
   * re-keys the row so every later sighting of that person - on any transport,
   * under any handle - lands on it.
   */
  bindIdentity(
    key: string,
    identity: { peerId?: string | null; installationId?: string | null; displayName?: string | null },
  ): void {
    const entry = this.entries.get(key) ?? this.findByIdentity(identity.peerId ?? null, identity.installationId ?? null);
    if (!entry) return;

    if (identity.installationId) entry.installationId = identity.installationId;
    if (identity.displayName) entry.displayName = identity.displayName;

    const peerId = identity.peerId ?? null;
    if (!peerId || entry.peerId === peerId) {
      this.reassess(entry);
      this.emitChanged();
      return;
    }

    // Re-key onto the identity, folding in any row already keyed there. Two
    // rows for one person is exactly what happens when both phones dial at the
    // same instant, and this is where they become one.
    const existing = this.entries.get(peerId);
    this.entries.delete(entry.key);
    const merged: Entry = existing && existing !== entry ? this.merge(existing, entry) : entry;
    merged.key = peerId;
    merged.peerId = peerId;
    if (existing && existing !== entry) this.entries.delete(existing.key);
    this.entries.set(peerId, merged);
    this.reindex(merged);
    this.reassess(merged);
    this.emitChanged();
  }

  /** A transport reports that an endpoint is gone. */
  forgetEndpoint(transport: TransportKind, endpointId: string): void {
    const indexKey = `${transport}:${endpointId}`;
    const key = this.endpointIndex.get(indexKey);
    this.endpointIndex.delete(indexKey);
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;

    // Only if the slot still holds THIS endpoint. One device publishes several
    // services on the same transport - two Bonjour records, seen by one browser
    // - and the per-transport slot holds whichever was seen last. Deleting on
    // the name of the transport alone threw away a sighting that had just been
    // refreshed by the peer's other record, and took the whole row with it.
    const sighting = entry.sightings.get(transport);
    if (!sighting || sighting.endpointId !== endpointId) {
      this.emitChanged();
      return;
    }
    entry.sightings.delete(transport);
    // Still reachable another way: the person has not left, one radio has.
    if (entry.sightings.size > 0) {
      this.emitChanged();
      return;
    }
    // A live session outlives its advertisement. iOS stops advertising the
    // instant the app is backgrounded, and the link is entirely unaffected.
    if (entry.connected) {
      this.emitChanged();
      return;
    }
    this.remove(key, entry);
  }

  /**
   * Mark a peer connected, which pins its row for as long as the session lives.
   *
   * Matches on peer id OR installation id OR row key, because at the moment a
   * first-time session completes the row may still be keyed on a transport
   * handle - and that mismatch is exactly what used to leave a connected friend
   * showing a Connect button.
   */
  setConnected(identifier: string, connected: boolean): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.peerId !== identifier && entry.installationId !== identifier && entry.key !== identifier) continue;
      if (entry.connected === connected) continue;
      entry.connected = connected;
      if (connected) {
        entry.lastSeenAt = this.options.clock.now();
        // A connected peer is, by definition, a real one.
        this.setResolution(entry, PeerResolution.DISCOVERED_VALID);
      }
      changed = true;
      // Deliberately NOT returning: duplicate rows for one person are the very
      // condition this pins against, and stopping at the first left the others
      // behind, still offering to connect.
    }
    if (changed) this.emitChanged();
  }

  /** True while a session with this peer is live, by any of its names. */
  isConnected(identifier: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.peerId === identifier || entry.installationId === identifier || entry.key === identifier) {
        if (entry.connected) return true;
      }
    }
    return false;
  }

  /** The list to render, best signal first, friends before strangers. */
  list(): NearbyPeer[] {
    const out: NearbyPeer[] = [];
    for (const entry of this.entries.values()) {
      // Half-identified rows stay internal. This is the whole of the fix for a
      // screen full of "Unknown Device": they are not hidden after the fact,
      // they never arrive.
      if (!entry.connected && entry.resolution !== PeerResolution.DISCOVERED_VALID) continue;
      out.push(this.toPublic(entry));
    }
    const rank: Record<string, number> = {
      [Proximity.IMMEDIATE]: 0,
      [Proximity.NEAR]: 1,
      [Proximity.FAR]: 2,
      [Proximity.UNKNOWN]: 3,
    };
    return out.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      if (a.kind !== b.kind) return a.kind === NearbyKind.TRUSTED_FRIEND ? -1 : 1;
      const byProximity = (rank[a.proximity] ?? 3) - (rank[b.proximity] ?? 3);
      if (byProximity !== 0) return byProximity;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  /** Every row, including the ones being held back. Developer Mode only. */
  diagnostics(): {
    key: string;
    peerId: string | null;
    installationId: string | null;
    discoveryId: string | null;
    resolution: PeerResolution;
    displayName: string;
    connected: boolean;
    transports: TransportKind[];
    lastSeenAt: number;
  }[] {
    return [...this.entries.values()].map((entry) => ({
      key: entry.key,
      peerId: entry.peerId,
      installationId: entry.installationId,
      discoveryId: entry.discoveryId,
      resolution: entry.resolution,
      displayName: entry.displayName,
      connected: entry.connected,
      transports: [...entry.sightings.keys()],
      lastSeenAt: entry.lastSeenAt,
    }));
  }

  /** Rows the interface can see. */
  get size(): number {
    return this.list().length;
  }

  /** Every row, resolved or not. */
  get trackedSize(): number {
    return this.entries.size;
  }

  /** Best endpoint to dial for a peer, given the transports we prefer. */
  bestEndpointFor(
    key: string,
    preference: readonly TransportKind[],
  ): { transport: TransportKind; endpointId: string } | null {
    const entry = this.entries.get(key) ?? this.findByIdentity(key, key);
    if (!entry) return null;
    for (const transport of preference) {
      const sighting = entry.sightings.get(transport);
      if (sighting) return { transport, endpointId: sighting.endpointId };
    }
    const first = entry.sightings.values().next().value as Sighting | undefined;
    return first ? { transport: first.transport, endpointId: first.endpointId } : null;
  }

  /** The row for a peer, by any of its names. */
  find(identifier: string): NearbyPeer | null {
    const direct = this.entries.get(identifier);
    if (direct) return this.toPublic(direct);
    const byIdentity = this.findByIdentity(identifier, identifier);
    return byIdentity ? this.toPublic(byIdentity) : null;
  }

  clear(): void {
    this.entries.clear();
    this.endpointIndex.clear();
    this.tokenIndex.clear();
    this.discoveryIndex.clear();
    this.emitChanged();
  }

  dispose(): void {
    this.stop();
    this.entries.clear();
    this.endpointIndex.clear();
    this.tokenIndex.clear();
    this.discoveryIndex.clear();
    this.events.removeAllListeners();
  }

  // -- internals -------------------------------------------------------------

  private findByIdentity(peerId: string | null, installationId: string | null): Entry | undefined {
    for (const entry of this.entries.values()) {
      if (peerId && entry.peerId === peerId) return entry;
      if (installationId && entry.installationId === installationId) return entry;
    }
    return undefined;
  }

  /** Fold `from` into `to`, keeping whichever side actually knows something. */
  private merge(to: Entry, from: Entry): Entry {
    to.peerId = to.peerId ?? from.peerId;
    to.installationId = to.installationId ?? from.installationId;
    to.discoveryId = to.discoveryId ?? from.discoveryId;
    to.tokenHex = from.tokenHex ?? to.tokenHex;
    to.protocolVersion = to.protocolVersion ?? from.protocolVersion;
    if (!to.displayName) to.displayName = from.displayName;
    to.firstSeenAt = Math.min(to.firstSeenAt, from.firstSeenAt);
    to.lastSeenAt = Math.max(to.lastSeenAt, from.lastSeenAt);
    to.connected = to.connected || from.connected;
    for (const [transport, sighting] of from.sightings) {
      const held = to.sightings.get(transport);
      if (!held || held.lastSeenAt < sighting.lastSeenAt) to.sightings.set(transport, sighting);
    }
    return to;
  }

  /** Point every index at this row's current key. */
  private reindex(entry: Entry): void {
    for (const sighting of entry.sightings.values()) {
      this.endpointIndex.set(`${sighting.transport}:${sighting.endpointId}`, entry.key);
    }
    if (entry.tokenHex !== null) this.tokenIndex.set(entry.tokenHex, entry.key);
    if (entry.discoveryId !== null) this.discoveryIndex.set(entry.discoveryId, entry.key);
  }

  /**
   * Decide whether this row is fit to show, and return true if it just became so.
   *
   * "Fit" means we know WHICH DEVICE this is and that it speaks a protocol we
   * can speak. It deliberately does not mean we know its name: a device that
   * publishes no name is still a real, connectable peer, and the interface has
   * an honest word for it. What it excludes is the genuinely partial sighting -
   * no identity of any kind - which is what iOS emits for a Bluetooth peer
   * before its identity characteristic has been read.
   */
  private reassess(entry: Entry): boolean {
    const before = entry.resolution;

    if (entry.protocolVersion !== null && entry.protocolVersion !== PROTOCOL_VERSION) {
      this.setResolution(entry, PeerResolution.IGNORED);
      return false;
    }

    const identified =
      entry.peerId !== null ||
      entry.installationId !== null ||
      entry.discoveryId !== null ||
      entry.tokenHex !== null;

    if (identified) {
      this.setResolution(entry, PeerResolution.DISCOVERED_VALID);
      return before !== PeerResolution.DISCOVERED_VALID;
    }

    // Nothing to go on yet. Give the transport a moment to fill it in; the
    // sweep discards it if it never does.
    this.setResolution(
      entry,
      before === PeerResolution.DISCOVERED_UNRESOLVED
        ? PeerResolution.RESOLVING_IDENTITY
        : before === PeerResolution.DISCOVERED_VALID
          ? PeerResolution.DISCOVERED_VALID
          : before,
    );
    return false;
  }

  private setResolution(entry: Entry, to: PeerResolution): void {
    if (entry.resolution === to) return;
    const from = entry.resolution;
    entry.resolution = to;
    this.events.emit('resolutionChanged', { key: entry.key, from, to });
  }

  private sweep(): void {
    const now = this.options.clock.now();
    let changed = false;
    for (const [key, entry] of [...this.entries]) {
      // A live session keeps someone listed even if advertising has stopped -
      // which it does, on iOS, the moment the app is backgrounded.
      if (entry.connected) continue;

      // A row that never told us who it was is thrown away rather than shown.
      if (
        entry.resolution !== PeerResolution.DISCOVERED_VALID &&
        now - entry.firstSeenAt > this.resolveWindowMs
      ) {
        this.remove(key, entry, false);
        changed = true;
        continue;
      }

      for (const [transport, sighting] of [...entry.sightings]) {
        if (now - sighting.lastSeenAt > this.staleAfterMs) {
          entry.sightings.delete(transport);
          this.endpointIndex.delete(`${transport}:${sighting.endpointId}`);
          changed = true;
        }
      }
      if (entry.sightings.size === 0) {
        this.remove(key, entry, false);
        changed = true;
      }
    }
    if (changed) this.emitChanged();
  }

  private remove(key: string, entry: Entry, emit = true): void {
    this.entries.delete(key);
    for (const sighting of entry.sightings.values()) {
      this.endpointIndex.delete(`${sighting.transport}:${sighting.endpointId}`);
    }
    if (entry.tokenHex !== null && this.tokenIndex.get(entry.tokenHex) === key) {
      this.tokenIndex.delete(entry.tokenHex);
    }
    if (entry.discoveryId !== null && this.discoveryIndex.get(entry.discoveryId) === key) {
      this.discoveryIndex.delete(entry.discoveryId);
    }
    if (entry.peerId && entry.resolution === PeerResolution.DISCOVERED_VALID) {
      this.events.emit('friendLeft', { peerId: entry.peerId });
    }
    if (emit) this.emitChanged();
  }

  private toPublic(entry: Entry): NearbyPeer {
    // Best signal across every transport we can currently see them on.
    let bestRssi: number | undefined;
    for (const sighting of entry.sightings.values()) {
      if (sighting.rssi === undefined) continue;
      if (bestRssi === undefined || sighting.rssi > bestRssi) bestRssi = sighting.rssi;
    }
    return {
      key: entry.key,
      kind: entry.peerId ? NearbyKind.TRUSTED_FRIEND : NearbyKind.UNKNOWN_DEVICE,
      peerId: entry.peerId,
      installationId: entry.installationId,
      discoveryId: entry.discoveryId,
      resolution: entry.resolution,
      displayName: entry.displayName,
      proximity: proximityFromRssi(bestRssi),
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      reachableVia: [...entry.sightings.keys()],
      connected: entry.connected,
    };
  }

  private emitChanged(): void {
    this.events.emit('changed', { peers: this.list() });
  }
}

/** The name this is heading towards. One logical peer, whatever the radios say. */
export { NearbyRegistry as PeerRegistry };
