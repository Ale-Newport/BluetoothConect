/**
 * "Is this advertisement my own?"
 *
 * One answer, one implementation, used by every transport. The three separate
 * self-checks this replaces - a bounded token set in the client, a service-name
 * comparison in the Android NSD listener, and another in the iOS one - each
 * worked until the radio layer was under stress, and each then failed OPEN, so
 * the phone listed itself as a stranger you could tap Connect on.
 *
 * The checks are ordered by how much they can be trusted:
 *
 *   1. discoveryId          Exact. Our own advertisement carries our own value,
 *                           on every transport, for as long as the app runs.
 *                           No window, no eviction, nothing to age out.
 *
 *   2. publicKeyFingerprint Exact, when a transport can carry one. A device
 *                           advertising our own long-term key IS us.
 *
 *   3. installationId       Exact, for the paths where one is known before a
 *                           handshake (a local socket, a resumed session).
 *
 *   4. advertisement token  The fallback, and the only one that works against
 *                           a native layer built before discovery ids existed.
 *                           It is a TIME window rather than a count: a token is
 *                           remembered for as long as any radio could still be
 *                           publishing it, so a Bonjour listener stuck on a
 *                           stale record is still recognised as ourselves. The
 *                           old thirty-two-entry cap forgot after roughly two
 *                           minutes and was the reason a phone eventually found
 *                           itself.
 *
 * A miss here is not cosmetic. A device that connects to itself burns a radio,
 * a session slot and a handshake, and puts a row on the Home screen that can
 * never do anything.
 */
import { toHex } from '../util/bytes.js';
import type { Clock } from '../util/time.js';
import type { DiscoveredPeer } from '../transport/types.js';
import { isValidDiscoveryId, type LocalPeerIdentity } from './identity.js';

/** Which check matched, for the developer log. */
export const SelfReason = {
  DISCOVERY_ID: 'discoveryId',
  FINGERPRINT: 'publicKeyFingerprint',
  INSTALLATION_ID: 'installationId',
  ADVERTISEMENT_TOKEN: 'advertisementToken',
} as const;
export type SelfReason = (typeof SelfReason)[keyof typeof SelfReason];

export interface SelfCheck {
  readonly isSelf: boolean;
  readonly reason: SelfReason | null;
}

const NOT_SELF: SelfCheck = { isSelf: false, reason: null };

/**
 * How long a token this device advertised is still treated as ours.
 *
 * Generously long, because the cost of the two mistakes is wildly asymmetric.
 * Remembering a token too long can, at worst, hide a stranger who happens to
 * advertise six bytes we used earlier - and they will be listed again on their
 * next rotation four seconds later. Forgetting one too early puts this phone in
 * its own nearby list, which is the bug being fixed.
 */
const TOKEN_MEMORY_MS = 10 * 60_000;

/**
 * Upper bound on remembered tokens.
 *
 * Not a correctness mechanism - the time window is - but a flight is long and
 * an unbounded map that gains an entry every four seconds is a leak. At one
 * token per four seconds the window above holds about a hundred and fifty, so
 * this ceiling is never reached in practice and exists only so it cannot grow
 * without limit if advertising is restarted in a tight loop.
 */
const MAX_REMEMBERED_TOKENS = 512;

export interface SelfIdentityGuardOptions {
  readonly clock: Clock;
  /** Called for every ignored advertisement, for the developer log. */
  readonly onIgnored?: (event: { transport: string; endpointId: string; reason: SelfReason }) => void;
  readonly tokenMemoryMs?: number;
}

/**
 * Holds this device's identity and every token it has advertised recently.
 *
 * One instance per client. `note` is called by whatever drives advertising;
 * `check` is called by every transport's discovery handler, and by nothing
 * else, so there is exactly one definition of "me" in the app.
 */
export class SelfIdentityGuard {
  /** token hex -> the moment it stops counting as ours. */
  private readonly tokens = new Map<string, number>();
  private identity: LocalPeerIdentity | null = null;
  private readonly tokenMemoryMs: number;

  constructor(private readonly options: SelfIdentityGuardOptions) {
    this.tokenMemoryMs = options.tokenMemoryMs ?? TOKEN_MEMORY_MS;
  }

  /** Set or replace this device's identity. Safe to call on every profile change. */
  setIdentity(identity: LocalPeerIdentity): void {
    this.identity = identity;
  }

  get local(): LocalPeerIdentity | null {
    return this.identity;
  }

  /** Remember a token this device is about to broadcast. */
  noteAdvertisedToken(token: Uint8Array): void {
    const now = this.options.clock.now();
    const hex = toHex(token);
    // Re-inserting moves it to the end, so the eviction below drops the
    // genuinely oldest rather than whichever was first seen. A Set could not
    // do this, which is part of why the old filter forgot a token still in use.
    this.tokens.delete(hex);
    this.tokens.set(hex, now + this.tokenMemoryMs);
    this.prune(now);
  }

  /** Every token still counting as ours, for Developer Mode. */
  get rememberedTokenCount(): number {
    this.prune(this.options.clock.now());
    return this.tokens.size;
  }

  /**
   * The one question. Returns why, so the log can say which check fired.
   *
   * Deliberately total: an advertisement that matches NOTHING is not ours, and
   * a transport that carries no identifying field at all therefore gets past
   * here. That is correct - resolving such a peer is the registry's job, not
   * this one's - and is why the fallback token check still matters.
   */
  check(peer: DiscoveredPeer): SelfCheck {
    const identity = this.identity;
    if (!identity) return NOT_SELF;

    if (isValidDiscoveryId(peer.discoveryId) && peer.discoveryId === identity.discoveryId) {
      return this.ignored(peer, SelfReason.DISCOVERY_ID);
    }
    if (peer.publicKeyFingerprint && peer.publicKeyFingerprint === identity.publicKeyFingerprint) {
      return this.ignored(peer, SelfReason.FINGERPRINT);
    }
    if (peer.installationId && peer.installationId === identity.installationId) {
      return this.ignored(peer, SelfReason.INSTALLATION_ID);
    }
    if (peer.advertisementToken && peer.advertisementToken.length > 0) {
      const hex = toHex(peer.advertisementToken);
      const expiry = this.tokens.get(hex);
      if (expiry !== undefined && expiry > this.options.clock.now()) {
        return this.ignored(peer, SelfReason.ADVERTISEMENT_TOKEN);
      }
    }
    return NOT_SELF;
  }

  /** Convenience for call sites that only want the boolean. */
  isSelf(peer: DiscoveredPeer): boolean {
    return this.check(peer).isSelf;
  }

  clear(): void {
    this.tokens.clear();
  }

  private ignored(peer: DiscoveredPeer, reason: SelfReason): SelfCheck {
    this.options.onIgnored?.({ transport: String(peer.transport), endpointId: peer.endpointId, reason });
    return { isSelf: true, reason };
  }

  private prune(now: number): void {
    for (const [hex, expiry] of this.tokens) {
      if (expiry > now) break; // Insertion order is expiry order.
      this.tokens.delete(hex);
    }
    while (this.tokens.size > MAX_REMEMBERED_TOKENS) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
  }
}
