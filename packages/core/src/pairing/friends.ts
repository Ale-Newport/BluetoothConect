/**
 * The friend list in motion: recognising a friend in the air, refusing someone
 * you never want to hear from again, and turning a scanned code into a row.
 *
 * This is the layer between the raw `TrustStore` and everything that happens
 * before a session exists - discovery, the advertisement we broadcast, and the
 * decision to answer an incoming connection at all.
 */
import { encodeHandshakeFrame } from '../protocol/frame.js';
import { Handshake } from '../crypto/handshake.js';
import {
  ADVERTISEMENT_TOKEN_LENGTH,
  TOKEN_ROTATION_WINDOW_MS,
  TOKEN_WINDOW_TOLERANCE,
  matchAdvertisementToken,
  type TokenCandidate,
} from './advertisementTokens.js';
import {
  PairingMethod,
  sanitiseDisplayName,
  strongerPairingMethod,
  type TrustStore,
  type TrustedPeer,
} from './trustStore.js';
import type { PairingCode } from './qrPairing.js';

/**
 * The friends we can currently advertise to, and the key each one's token comes
 * from. A device with no such friends broadcasts random bytes instead - looking
 * like a device with friends is itself a privacy property.
 */
export function advertisableFriends(store: TrustStore): TokenCandidate[] {
  const out: TokenCandidate[] = [];
  for (const peer of store.list()) {
    if (peer.blocked || !peer.selfAdvertisementKey) continue;
    out.push({ peerId: peer.peerId, advertisementKey: peer.selfAdvertisementKey });
  }
  return out;
}

export interface RecognitionOptions {
  /**
   * Include blocked friends. Off for the discovery UI, ON when screening an
   * incoming connection: a blocked friend still has a key, and recognising them
   * is precisely how we refuse them.
   */
  readonly includeBlocked?: boolean;
  readonly tolerance?: number;
  readonly windowMs?: number;
}

/** The friends whose tokens we will try to match against. */
export function recognisableFriends(store: TrustStore, options: RecognitionOptions = {}): TokenCandidate[] {
  const out: TokenCandidate[] = [];
  for (const peer of store.list()) {
    if (peer.blocked && !options.includeBlocked) continue;
    if (!peer.advertisementKey) continue;
    out.push({ peerId: peer.peerId, advertisementKey: peer.advertisementKey });
  }
  return out;
}

export interface RecognisedFriend {
  readonly peerId: string;
  readonly displayName: string;
  readonly blocked: boolean;
}

/**
 * Try to put a name to a token seen in an advertisement.
 *
 * Returns null for a stranger, which is the common case and must stay cheap.
 * A match is a hint for the UI and for the admission gate - it is not proof of
 * identity, and nothing security-relevant may be granted on it. Only the
 * handshake establishes who is actually there.
 */
export function recogniseFriendToken(
  store: TrustStore,
  observed: Uint8Array,
  wallNow: number,
  options: RecognitionOptions = {},
): RecognisedFriend | null {
  const peerId = matchAdvertisementToken(
    observed,
    recognisableFriends(store, options),
    wallNow,
    options.tolerance ?? TOKEN_WINDOW_TOLERANCE,
    options.windowMs ?? TOKEN_ROTATION_WINDOW_MS,
  );
  if (peerId === null) return null;
  const record = store.record(peerId);
  if (!record) return null;
  return { peerId, displayName: record.displayName, blocked: record.blocked || store.isBlocked(peerId) };
}

// ---------------------------------------------------------------------------
// Admission: refusing a blocked peer BEFORE the handshake begins
// ---------------------------------------------------------------------------

export interface IncomingConnectionRequest {
  /** Transport-scoped handle. Not an identity; only useful for logging. */
  readonly endpointId?: string;
  /**
   * Peer id already known out of band - from a code we just scanned, or from a
   * previous session on this endpoint that the transport manager cached.
   */
  readonly peerId?: string;
  /** The rotating token from the advertisement, when the transport carried one. */
  readonly advertisementToken?: Uint8Array;
}

export interface AdmissionResult {
  readonly allowed: boolean;
  /** Who we believe this is, when we believe anything at all. */
  readonly peerId: string | null;
  /** True when the token or the supplied id matched a friend row. */
  readonly recognised: boolean;
  readonly reason?: string;
}

/**
 * Decide whether to let a connection get as far as a handshake.
 *
 * Blocking has to bite HERE, not after authentication. A handshake costs two
 * round trips on a link that may be Bluetooth, it hands the peer our capability
 * record, and it puts a pairing sheet in front of the user - none of which a
 * blocked peer should be able to make happen by walking past.
 *
 * The limit is honest and worth stating: before the handshake the only handle we
 * have on a stranger is a six-byte token they choose to broadcast. Someone who
 * has been blocked can simply stop broadcasting a recognisable token and get as
 * far as the handshake, where the post-authentication check refuses them. This
 * gate removes the cost of the common case, not the possibility of the attempt.
 */
export function screenIncomingConnection(
  store: TrustStore,
  request: IncomingConnectionRequest,
  wallNow: number,
): AdmissionResult {
  if (typeof request.peerId === 'string' && request.peerId.length > 0) {
    const blocked = store.isBlocked(request.peerId) || store.record(request.peerId)?.blocked === true;
    if (blocked) {
      return { allowed: false, peerId: request.peerId, recognised: true, reason: 'peer is blocked' };
    }
    return { allowed: true, peerId: request.peerId, recognised: store.record(request.peerId) !== undefined };
  }

  const token = request.advertisementToken;
  if (token instanceof Uint8Array && token.length === ADVERTISEMENT_TOKEN_LENGTH) {
    const friend = recogniseFriendToken(store, token, wallNow, { includeBlocked: true });
    if (friend) {
      if (friend.blocked) {
        return { allowed: false, peerId: friend.peerId, recognised: true, reason: 'peer is blocked' };
      }
      return { allowed: true, peerId: friend.peerId, recognised: true };
    }
  }

  // A stranger. Allowed through to the handshake, where they will need the user
  // to confirm six digits before anything else can happen.
  return { allowed: true, peerId: null, recognised: false };
}

/**
 * The bytes to send before hanging up on a refused peer.
 *
 * The reason is deliberately vague. Telling someone "you are blocked" confirms
 * both that this device knows them and that this device is here, which is
 * exactly what a person who has been blocked would like to learn.
 */
export function refusalFrame(): Uint8Array {
  return encodeHandshakeFrame(Handshake.createReject('unavailable'));
}

// ---------------------------------------------------------------------------
// Writing friend rows
// ---------------------------------------------------------------------------

/**
 * Record a friendship created by scanning someone's code.
 *
 * The identity key came out of band, so this row can be written before any
 * connection exists - and once it is written, the very next handshake with that
 * peer demands exactly this key and completes with no user interaction at all.
 * That is the whole point of the camera path.
 *
 * The advertisement keys are absent until the two devices have actually met:
 * they are exchanged inside the encrypted session, which does not exist yet.
 */
export function recordScannedFriend(
  store: TrustStore,
  code: PairingCode,
  wallNow: number,
): { ok: true; peer: TrustedPeer } | { ok: false; reason: string } {
  if (store.isBlocked(code.peerId)) return { ok: false, reason: 'peer is blocked' };
  const existing = store.record(code.peerId);
  const peer: TrustedPeer = {
    peerId: code.peerId,
    identityKey: code.identityKey,
    displayName: sanitiseDisplayName(code.displayName),
    method: existing ? strongerPairingMethod(existing.method, PairingMethod.QR) : PairingMethod.QR,
    pairedAt: existing?.pairedAt ?? wallNow,
    lastSeenAt: wallNow,
    ...(existing?.advertisementKey ? { advertisementKey: existing.advertisementKey } : {}),
    ...(existing?.selfAdvertisementKey ? { selfAdvertisementKey: existing.selfAdvertisementKey } : {}),
    blocked: false,
  };
  store.set(peer);
  const stored = store.record(code.peerId);
  return { ok: true, peer: stored ?? peer };
}

/**
 * The two ways a friendship ends.
 *
 * "Remove" forgets the row entirely: the next meeting is a first meeting again,
 * six digits and all. "Block" KEEPS the row, marked blocked, and that is
 * deliberate - the row holds the advertisement key, and without it we could not
 * recognise the person in the air and would only be able to refuse them after a
 * handshake we did not want to run. A block therefore costs one stored key, and
 * buys refusal before the radio ever completes a connection.
 */
export function endFriendship(store: TrustStore, peerId: string, options: { block?: boolean } = {}): void {
  if (options.block) {
    store.block(peerId);
    return;
  }
  store.remove(peerId);
}
