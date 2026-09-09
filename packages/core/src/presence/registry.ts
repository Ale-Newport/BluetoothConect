/**
 * The nearby registry.
 *
 * Discovery produces a messy stream: the same phone is seen over Bluetooth and
 * over Wi-Fi, its Bluetooth handle rotates, it disappears for four seconds when
 * someone puts it in a pocket, and it reappears with a different endpoint id.
 * Rendered raw, the Home screen would flicker and duplicate.
 *
 * This collapses that stream into the list a person expects: one row per human,
 * stable while they are in the room, gone shortly after they leave.
 *
 * Two things make the collapsing possible:
 *  - a recognised friend's rotating advertisement token resolves to a real peer
 *    id, so every sighting of them merges regardless of transport or handle;
 *  - an unknown device cannot be merged - there is nothing to merge on - so it
 *    is keyed by its transport handle and simply expires.
 */
import type { TransportKind } from '../protocol/capabilities.js';
import type { DiscoveredPeer } from '../transport/types.js';
import { TypedEmitter } from '../util/emitter.js';
import type { Clock, TimerHandle } from '../util/time.js';
import { NearbyKind, Proximity, proximityFromRssi, type NearbyPeer } from './types.js';

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
  displayName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  connected: boolean;
  /** One sighting per transport; a peer may be visible on several at once. */
  sightings: Map<TransportKind, Sighting>;
}

export interface NearbyRegistryEvents {
  /** The list changed in any way. The UI re-renders from `list()`. */
  changed: { readonly peers: readonly NearbyPeer[] };
  /** A trusted friend just came into range. Worth a haptic. */
  friendArrived: { readonly peer: NearbyPeer };
  friendLeft: { readonly peerId: string };
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
}

const DEFAULT_STALE_AFTER_MS = 15_000;
const DEFAULT_SWEEP_MS = 2_000;

export class NearbyRegistry {
  readonly events = new TypedEmitter<NearbyRegistryEvents>();

  private readonly entries = new Map<string, Entry>();
  /** endpointId -> entry key, so a peerLost can find what it belongs to. */
  private readonly endpointIndex = new Map<string, string>();
  private sweepTimer: TimerHandle | undefined;
  private readonly staleAfterMs: number;

  constructor(private readonly options: NearbyRegistryOptions) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
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

    // A recognised friend keys on their real identity, so Bluetooth and Wi-Fi
    // sightings of the same person collapse into one row. A stranger has no
    // identity to key on, so their transport handle has to do.
    const key = resolvedPeerId ?? `${peer.transport}:${peer.endpointId}`;

    let entry = this.entries.get(key);
    const isNew = entry === undefined;

    if (!entry) {
      // A peer may have been listed as a stranger and only now been recognised -
      // for instance because the friend list finished loading. Fold the old row in.
      const strangerKey = `${peer.transport}:${peer.endpointId}`;
      const previous = resolvedPeerId ? this.entries.get(strangerKey) : undefined;
      if (previous) {
        this.entries.delete(strangerKey);
        entry = { ...previous, key, peerId: resolvedPeerId };
      } else {
        entry = {
          key,
          peerId: resolvedPeerId,
          displayName: '',
          firstSeenAt: now,
          lastSeenAt: now,
          connected: false,
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

    entry.lastSeenAt = now;
    entry.sightings.set(peer.transport, {
      transport: peer.transport,
      endpointId: peer.endpointId,
      rssi: peer.rssi,
      lastSeenAt: now,
    });
    this.endpointIndex.set(`${peer.transport}:${peer.endpointId}`, key);

    this.emitChanged();
    if (isNew && entry.peerId) {
      this.events.emit('friendArrived', { peer: this.toPublic(entry) });
    }
  }

  /** A transport reports that an endpoint is gone. */
  forgetEndpoint(transport: TransportKind, endpointId: string): void {
    const indexKey = `${transport}:${endpointId}`;
    const key = this.endpointIndex.get(indexKey);
    this.endpointIndex.delete(indexKey);
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.sightings.delete(transport);
    // Still reachable another way: the person has not left, one radio has.
    if (entry.sightings.size > 0) {
      this.emitChanged();
      return;
    }
    this.remove(key, entry);
  }

  /** Mark a peer as connected, which pins it in the list while the session lives. */
  setConnected(peerId: string, connected: boolean): void {
    for (const entry of this.entries.values()) {
      if (entry.peerId !== peerId) continue;
      if (entry.connected === connected) return;
      entry.connected = connected;
      if (connected) entry.lastSeenAt = this.options.clock.now();
      this.emitChanged();
      return;
    }
  }

  /** The list to render, best signal first, friends before strangers. */
  list(): NearbyPeer[] {
    const out = [...this.entries.values()].map((e) => this.toPublic(e));
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

  get size(): number {
    return this.entries.size;
  }

  /** Best endpoint to dial for a peer, given the transports we prefer. */
  bestEndpointFor(key: string, preference: readonly TransportKind[]): { transport: TransportKind; endpointId: string } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    for (const transport of preference) {
      const sighting = entry.sightings.get(transport);
      if (sighting) return { transport, endpointId: sighting.endpointId };
    }
    const first = entry.sightings.values().next().value as Sighting | undefined;
    return first ? { transport: first.transport, endpointId: first.endpointId } : null;
  }

  clear(): void {
    this.entries.clear();
    this.endpointIndex.clear();
    this.emitChanged();
  }

  dispose(): void {
    this.stop();
    this.entries.clear();
    this.endpointIndex.clear();
    this.events.removeAllListeners();
  }

  private sweep(): void {
    const now = this.options.clock.now();
    let changed = false;
    for (const [key, entry] of [...this.entries]) {
      // A live session keeps someone listed even if advertising has stopped -
      // which it does, on iOS, the moment the app is backgrounded.
      if (entry.connected) continue;

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
    if (entry.peerId) this.events.emit('friendLeft', { peerId: entry.peerId });
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
