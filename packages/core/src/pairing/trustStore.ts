/**
 * The friend list - the durable answer to "have I met this person before?".
 *
 * One row per friend, keyed by the peer id, holding the long-term Ed25519
 * public key that was cryptographically proven during the pairing handshake.
 * On every later meeting the handshake demands that exact key, which is what
 * makes a repeat meeting immune to an active attacker with ZERO user
 * interaction. Everything the product promises about "recognise each other
 * forever afterwards" rests on this table.
 *
 * The interface is deliberately SYNCHRONOUS. `HandshakeConfig.lookupTrustedKey`
 * is called from inside the handshake state machine, which cannot await, so an
 * async store would be unusable there. The app's SQLite-backed implementation
 * therefore loads the friend table into memory once at startup - it is a
 * handful of rows of 32-byte keys, not a database in any meaningful sense - and
 * writes through on every mutation.
 */
import { ED25519_PUBLIC_KEY_LENGTH } from '../crypto/primitives.js';
import { peerIdFromIdentityKey } from '../crypto/identity.js';
import { ADVERTISEMENT_KEY_LENGTH } from './advertisementTokens.js';

/** How the friendship was established. Shown in the UI; affects nothing else. */
export const PairingMethod = {
  /** Identity key arrived out of band in a scanned QR code. Strongest. */
  QR: 'qr',
  /** Both users compared the six-digit code derived from the transcript. */
  SAS: 'sas',
  /** Restored from a backup or migrated from an older install. */
  RESTORED: 'restored',
} as const;
export type PairingMethod = (typeof PairingMethod)[keyof typeof PairingMethod];

const ALL_PAIRING_METHODS: readonly string[] = [PairingMethod.QR, PairingMethod.SAS, PairingMethod.RESTORED];

export function isPairingMethod(value: unknown): value is PairingMethod {
  return typeof value === 'string' && ALL_PAIRING_METHODS.includes(value);
}

/**
 * Ranking used when a friendship is re-established by a weaker route than the
 * one that created it. Scanning a code proves the identity key out of band;
 * comparing six digits only proves that no attacker sat in the middle of THIS
 * exchange. A later SAS pairing must therefore not quietly downgrade the record
 * of a friend who was originally scanned.
 */
const METHOD_STRENGTH: Record<PairingMethod, number> = {
  [PairingMethod.QR]: 3,
  [PairingMethod.SAS]: 2,
  [PairingMethod.RESTORED]: 1,
};

export function strongerPairingMethod(a: PairingMethod, b: PairingMethod): PairingMethod {
  return METHOD_STRENGTH[a] >= METHOD_STRENGTH[b] ? a : b;
}

export interface TrustedPeer {
  readonly peerId: string;
  /** Long-term Ed25519 public key. Proven, never merely claimed. */
  readonly identityKey: Uint8Array;
  /** Last name this peer told us. Untrusted, display-only, already sanitised. */
  readonly displayName: string;
  readonly method: PairingMethod;
  /** Wall-clock milliseconds. */
  readonly pairedAt: number;
  readonly lastSeenAt: number;
  /**
   * The peer's advertisement key: the secret THEIR rotating BLE token is
   * computed from, so we can recognise them before connecting. It is handed to
   * us inside the encrypted session during the pairing exchange, so it is
   * absent on a record created by a scanned QR code until we have actually met.
   */
  readonly advertisementKey?: Uint8Array;
  /**
   * The key OUR token to this friend is computed from. Per friendship, not per
   * device: if every friend saw the same token from us, two of them could
   * compare notes and prove they had seen the same phone.
   */
  readonly selfAdvertisementKey?: Uint8Array;
  readonly blocked: boolean;
}

/** Longest peer id we will store. A peer id is 16 characters; this is slack. */
const MAX_PEER_ID_LENGTH = 64;
/** Longest display name we will store. Matches the capability record's limit. */
export const MAX_TRUSTED_DISPLAY_NAME_LENGTH = 64;

/**
 * True when a string carries C0/C1 control characters.
 *
 * A display name reaches us from a peer or from a scanned code. Control
 * characters in it are never legitimate and are the classic way to spoof a UI
 * row - a right-to-left override turns "evil.exe" into something else entirely.
 * A strict parser rejects them outright; a lenient one strips them.
 */
export function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
    // Arabic letter mark: an invisible bidi control like the ones below.
    if (code === 0x061c) return true;
    // Left/right-to-left marks. Weaker than the overrides but the same trick:
    // invisible, and they reorder the glyphs either side of them.
    if (code === 0x200e || code === 0x200f) return true;
    // Bidi overrides and embeddings: legitimate text uses the isolates, never these.
    if (code >= 0x202a && code <= 0x202e) return true;
    // Line and paragraph separators. Not C0, but a line break all the same: a
    // name carrying one renders as two rows, which is how "Maria" becomes
    // "Maria" above a forged second line the user reads as ours.
    if (code === 0x2028 || code === 0x2029) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

/** Strip anything unsafe and clamp the length, without ever throwing. */
export function sanitiseDisplayName(name: string, maxLength = MAX_TRUSTED_DISPLAY_NAME_LENGTH): string {
  if (typeof name !== 'string') return '';
  let out = '';
  // Iterating by code point keeps surrogate pairs (emoji) intact; truncating
  // between the halves of one would produce an unpaired surrogate.
  for (const ch of name) {
    if (hasControlCharacters(ch)) continue;
    if (out.length + ch.length > maxLength) break;
    out += ch;
  }
  return out.trim();
}

export interface TrustStore {
  /**
   * The identity key we require this peer to present, or undefined if we have
   * never paired with them. Wire this straight into
   * `HandshakeConfig.lookupTrustedKey`.
   *
   * A BLOCKED peer returns undefined even when a record exists. Blocking is
   * enforced before the handshake starts, but if that gate is ever bypassed the
   * worst case must be "treated as a stranger", never "silently auto-trusted".
   */
  get(peerId: string): Uint8Array | undefined;
  /** The full row, blocked or not. For the UI and for the token matcher. */
  record(peerId: string): TrustedPeer | undefined;
  set(peer: TrustedPeer): void;
  /** Forget a friendship entirely. Does NOT lift a block - see `unblock`. */
  remove(peerId: string): void;
  block(peerId: string): void;
  unblock(peerId: string): void;
  isBlocked(peerId: string): boolean;
  list(): readonly TrustedPeer[];
  /**
   * Bumped on every mutation. Caches derived from the store (the advertisement
   * token table, most importantly) compare it to know they are stale.
   */
  readonly revision: number;
}

function assertPeerId(peerId: string): void {
  if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > MAX_PEER_ID_LENGTH) {
    throw new Error('trustStore: peer id must be a non-empty string of at most 64 characters');
  }
}

/**
 * Validate a row before it is stored. Some of these fields originate with the
 * peer (the display name, the advertisement key) and some are derived locally,
 * so the check runs on the way in rather than trusting every call site.
 */
export function validateTrustedPeer(peer: TrustedPeer): void {
  assertPeerId(peer.peerId);
  if (!(peer.identityKey instanceof Uint8Array) || peer.identityKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error('trustStore: identity key must be 32 bytes');
  }
  // The peer id is a hash of the identity key. Storing a pair that does not
  // satisfy that relation would let a lookup return a key for an id it does not
  // belong to - the one inconsistency this table must never contain.
  if (peerIdFromIdentityKey(peer.identityKey) !== peer.peerId) {
    throw new Error('trustStore: peer id does not match its identity key');
  }
  if (typeof peer.displayName !== 'string' || peer.displayName.length > MAX_TRUSTED_DISPLAY_NAME_LENGTH) {
    throw new Error('trustStore: display name must be a string of at most 64 characters');
  }
  if (!isPairingMethod(peer.method)) throw new Error('trustStore: unknown pairing method');
  for (const key of [peer.advertisementKey, peer.selfAdvertisementKey]) {
    if (key === undefined) continue;
    if (!(key instanceof Uint8Array) || key.length !== ADVERTISEMENT_KEY_LENGTH) {
      throw new Error('trustStore: advertisement key must be 32 bytes');
    }
  }
  if (!Number.isFinite(peer.pairedAt) || !Number.isFinite(peer.lastSeenAt)) {
    throw new Error('trustStore: timestamps must be finite');
  }
  if (typeof peer.blocked !== 'boolean') throw new Error('trustStore: blocked must be a boolean');
}

/**
 * A row handed OUT of the store.
 *
 * `set` already copies every buffer on the way in, for the stated reason that a
 * stored identity key which can be mutated from outside is not a trust anchor.
 * That argument does not stop at the door: handing back the live `Uint8Array`
 * would let any caller - a UI list, a token matcher, a future feature - reach
 * into the table and rewrite the key the handshake authenticates against, and
 * the row would still look untouched. Rows are a handful of 32-byte keys, so
 * the copy is cheap and the invariant holds in both directions.
 */
function copyRow(peer: TrustedPeer): TrustedPeer {
  return {
    peerId: peer.peerId,
    identityKey: peer.identityKey.slice(),
    displayName: peer.displayName,
    method: peer.method,
    pairedAt: peer.pairedAt,
    lastSeenAt: peer.lastSeenAt,
    ...(peer.advertisementKey ? { advertisementKey: peer.advertisementKey.slice() } : {}),
    ...(peer.selfAdvertisementKey ? { selfAdvertisementKey: peer.selfAdvertisementKey.slice() } : {}),
    blocked: peer.blocked,
  };
}

/**
 * In-memory implementation. Complete and correct - the app subclasses nothing,
 * it simply provides a SQLite-backed object with the same shape and the same
 * synchronous contract.
 */
export class InMemoryTrustStore implements TrustStore {
  private readonly peers = new Map<string, TrustedPeer>();
  /**
   * Blocks live in their own set, independent of the friend rows. Removing a
   * friend must not quietly unblock them, and blocking someone you have never
   * met has to work too - that is how you refuse a stranger who keeps knocking.
   */
  private readonly blocks = new Set<string>();
  private rev = 0;

  get revision(): number {
    return this.rev;
  }

  get(peerId: string): Uint8Array | undefined {
    const peer = this.peers.get(peerId);
    if (!peer || peer.blocked || this.blocks.has(peerId)) return undefined;
    return peer.identityKey.slice();
  }

  record(peerId: string): TrustedPeer | undefined {
    const peer = this.peers.get(peerId);
    return peer ? copyRow(peer) : undefined;
  }

  set(peer: TrustedPeer): void {
    validateTrustedPeer(peer);
    // A row that claims to be blocked must also appear in the block set, or
    // `isBlocked` and `get` would disagree about the same peer.
    if (peer.blocked) this.blocks.add(peer.peerId);
    // Copy every buffer: callers hand us slices of decoded packets, and a stored
    // identity key that can be mutated from outside is not a trust anchor.
    const stored: TrustedPeer = {
      peerId: peer.peerId,
      identityKey: peer.identityKey.slice(),
      displayName: peer.displayName,
      method: peer.method,
      pairedAt: peer.pairedAt,
      lastSeenAt: peer.lastSeenAt,
      ...(peer.advertisementKey ? { advertisementKey: peer.advertisementKey.slice() } : {}),
      ...(peer.selfAdvertisementKey ? { selfAdvertisementKey: peer.selfAdvertisementKey.slice() } : {}),
      blocked: peer.blocked || this.blocks.has(peer.peerId),
    };
    this.peers.set(peer.peerId, stored);
    this.rev++;
  }

  remove(peerId: string): void {
    if (this.peers.delete(peerId)) this.rev++;
  }

  block(peerId: string): void {
    assertPeerId(peerId);
    this.blocks.add(peerId);
    const existing = this.peers.get(peerId);
    if (existing && !existing.blocked) this.peers.set(peerId, { ...existing, blocked: true });
    this.rev++;
  }

  unblock(peerId: string): void {
    this.blocks.delete(peerId);
    const existing = this.peers.get(peerId);
    if (existing && existing.blocked) this.peers.set(peerId, { ...existing, blocked: false });
    this.rev++;
  }

  isBlocked(peerId: string): boolean {
    return this.blocks.has(peerId);
  }

  list(): readonly TrustedPeer[] {
    const out: TrustedPeer[] = [];
    for (const peer of this.peers.values()) out.push(copyRow(peer));
    return out;
  }
}

/**
 * Adapter for `HandshakeConfig.lookupTrustedKey`.
 *
 * Returning a key here means "I have met this peer before", and the handshake
 * then requires the presented key to match exactly.
 */
export function trustedKeyLookup(store: TrustStore): (peerId: string) => Uint8Array | undefined {
  return (peerId) => store.get(peerId);
}

/** Update the "last seen" stamp without disturbing anything else. */
export function touchTrustedPeer(store: TrustStore, peerId: string, wallNow: number): void {
  const existing = store.record(peerId);
  if (!existing) return;
  store.set({ ...existing, lastSeenAt: wallNow });
}
