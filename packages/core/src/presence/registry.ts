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
 *  - a stranger has no identity to merge on, but it does have a token, and one
 *    device advertises ONE token across every transport it has at any instant.
 *    Two sightings carrying the same token are therefore the same device.
 *
 * That second rule is not a nicety. A phone publishes the same Bonjour service
 * type from both of its local-network transports - `localNetwork` and
 * `peerToPeerWifi` differ only by `includePeerToPeer` - and browses with both,
 * so without it every device sees every other device FOUR times: two services,
 * two browsers. That is what it did, and it looked like four strangers each
 * with their own Connect button.
 *
 * Merging strangers on a token confers no trust. Identity is established by the
 * handshake and the six digits, never by what a row was keyed on; a friend
 * resolves by peer id and never reaches this path at all. The worst an attacker
 * can do by cloning a stranger's token is make two unknown devices share one
 * unknown row.
 */
import type { TransportKind } from '../protocol/capabilities.js';
import type { DiscoveredPeer } from '../transport/types.js';
import { toHex } from '../util/bytes.js';
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
  /** The token this row was last seen advertising, so a rotation can re-index. */
  tokenHex: string | null;
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
  /**
   * Current advertisement token -> entry key.
   *
   * Only ever holds the token a row is advertising *now*: a rotation moves the
   * entry from the old token to the new one. A device that turns up later
   * carrying a token somebody else has since rotated away from is a different
   * device, and gets its own row.
   */
  private readonly tokenIndex = new Map<string, string>();
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
    const tokenHex = peer.advertisementToken ? toHex(peer.advertisementToken) : null;
    const endpointKey = `${peer.transport}:${peer.endpointId}`;

    // Which row does this sighting belong to? In order of how much the answer
    // can be trusted: a recognised friend's identity; the row this endpoint is
    // already in, which is what carries a stranger across a token rotation; a
    // row already advertising this exact token; and failing all of those, a new
    // row keyed by the only handle we have.
    const key =
      resolvedPeerId ??
      this.endpointIndex.get(endpointKey) ??
      (tokenHex ? this.tokenIndex.get(tokenHex) : undefined) ??
      endpointKey;

    let entry = this.entries.get(key);
    const isNew = entry === undefined;

    if (!entry) {
      // A peer may have been listed as a stranger and only now been recognised -
      // for instance because the friend list finished loading. Fold the old row
      // in, wherever it happens to be keyed.
      const previousKey = resolvedPeerId
        ? this.endpointIndex.get(endpointKey) ?? (tokenHex ? this.tokenIndex.get(tokenHex) : undefined)
        : undefined;
      const previous = previousKey ? this.entries.get(previousKey) : undefined;
      if (previous && previousKey) {
        this.entries.delete(previousKey);
        entry = { ...previous, key, peerId: resolvedPeerId };
      } else {
        entry = {
          key,
          peerId: resolvedPeerId,
          tokenHex: null,
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

    // Re-index the token: a rotation must move this row rather than leave a
    // stale entry pointing at it, or a later stranger that happens to advertise
    // the abandoned token would be folded into somebody else's row.
    if (tokenHex !== entry.tokenHex) {
      if (entry.tokenHex !== null && this.tokenIndex.get(entry.tokenHex) === key) {
        this.tokenIndex.delete(entry.tokenHex);
      }
      entry.tokenHex = tokenHex;
    }
    if (tokenHex !== null) this.tokenIndex.set(tokenHex, key);

    entry.lastSeenAt = now;
    entry.sightings.set(peer.transport, {
      transport: peer.transport,
      endpointId: peer.endpointId,
      rssi: peer.rssi,
      lastSeenAt: now,
    });
    this.endpointIndex.set(endpointKey, key);

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
    this.tokenIndex.clear();
    this.emitChanged();
  }

  dispose(): void {
    this.stop();
    this.entries.clear();
    this.endpointIndex.clear();
    this.tokenIndex.clear();
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
    if (entry.tokenHex !== null && this.tokenIndex.get(entry.tokenHex) === key) {
      this.tokenIndex.delete(entry.tokenHex);
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
