/**
 * Who a device is, before and after a handshake.
 *
 * AirLink has always had a durable identity - an Ed25519 key pair whose public
 * half hashes to a `peerId` - but that identity only becomes known once the
 * handshake has run. Everything that happens BEFORE the handshake had nothing
 * stable to work with, and that is where every discovery bug lived: the only
 * identifier in an advertisement was a token that rotates every four seconds
 * and means nothing at all to a device that has never paired with us.
 *
 * So three questions had no reliable answer:
 *
 *   "Is this me?"            -> compared against a bounded set of recent
 *                               tokens, which evicts after about two minutes
 *                               and cannot match an advertisement that carries
 *                               no token at all.
 *   "Have I already got a    -> compared on a per-transport endpoint handle, so
 *    row for this device?"      one phone seen over Bluetooth and Wi-Fi was two
 *                               strangers.
 *   "Which of us dials?"     -> nothing; both dialled.
 *
 * This module gives all three a real answer, using two identifiers with
 * deliberately different lifetimes:
 *
 *   installationId   Persistent, per-installation, random, and never derived
 *                    from hardware. It already existed as `LocalIdentity.deviceId`
 *                    and already travels inside the encrypted handshake as part
 *                    of `PeerCapabilities`, so it costs nothing new on the wire.
 *                    It is what makes two sessions with one phone recognisable
 *                    as one phone, and what breaks a simultaneous-dial tie.
 *                    It is NEVER broadcast in the clear.
 *
 *   discoveryId      Random, eight bytes, generated once per app run and
 *                    broadcast in every advertisement on every transport. Its
 *                    only job is "is this me?", and for that it is exact: our
 *                    own advertisement carries our own value, whatever radio it
 *                    came back on and however long ago advertising started.
 *
 * Why the second one is not simply the first: broadcasting a durable identifier
 * in the clear would let anyone within radio range log a phone's comings and
 * goings across days, which is the precise thing the rotating token exists to
 * prevent. A value that is fresh on every launch answers the self question
 * completely while linking nothing across time.
 */
import { toHex, utf8Encode } from '../util/bytes.js';
import { hash256 } from '../crypto/primitives.js';
import type { RandomSource } from '../crypto/random.js';
import type { LocalIdentity } from '../crypto/identity.js';

const FINGERPRINT_DOMAIN = utf8Encode('AirLink-v1-key-fingerprint');

/**
 * Bytes in a discovery id.
 *
 * Eight is chosen against the tightest budget in the system: a BLE
 * advertisement, where every byte competes with the service UUID. Sixty-four
 * random bits make an accidental collision between two phones in one cabin
 * indistinguishable from impossible, and a deliberate one useless - claiming
 * somebody else's discovery id only makes them ignore you.
 */
export const DISCOVERY_ID_BYTES = 8;

/** Hex characters in a rendered discovery id. */
export const DISCOVERY_ID_LENGTH = DISCOVERY_ID_BYTES * 2;

/**
 * The canonical description of a peer, used everywhere one is identified.
 *
 * Nothing here is a radio handle. A peripheral UUID, a Bonjour service name, a
 * MAC address and an advertised name are all absent by design: they rotate,
 * they differ per platform, and two of them are attacker-controlled.
 */
export interface PeerIdentity {
  /** Persistent id of the remote installation. Known after the handshake. */
  readonly installationId: string | null;
  /** Cryptographic identity. Known after the handshake, and self-certifying. */
  readonly peerId: string | null;
  /** Fingerprint of the long-term public key, for display and for self-checks. */
  readonly publicKeyFingerprint: string | null;
  /** Name to show. Untrusted until the peer is a stored friend. */
  readonly displayName: string;
  /** Per-run identifier from the advertisement. Present before a handshake. */
  readonly discoveryId: string | null;
}

/** This device's own identity, in the same vocabulary. */
export interface LocalPeerIdentity {
  readonly installationId: string;
  readonly peerId: string;
  readonly publicKeyFingerprint: string;
  readonly displayName: string;
  readonly discoveryId: string;
}

/**
 * A short, stable fingerprint of a long-term public key.
 *
 * Domain-separated from the peer id so that seeing one never lets anybody
 * compute the other, and truncated to sixteen hex characters, which is plenty
 * to compare two keys for equality and short enough to put in a log line.
 */
export function fingerprintOfKey(identityKey: Uint8Array): string {
  return toHex(hash256(FINGERPRINT_DOMAIN, identityKey).subarray(0, 8));
}

/** A fresh discovery id. Called once per app run, never per advertisement. */
export function newDiscoveryId(random: RandomSource): string {
  return toHex(random.randomBytes(DISCOVERY_ID_BYTES));
}

/**
 * Whether a value off the wire could be a discovery id.
 *
 * Everything arriving from a radio is hostile, and a discovery id is compared
 * against our own, so a malformed one must be rejected rather than normalised -
 * a peer that could make `isSelf` return true for an arbitrary string could
 * make itself invisible.
 */
export function isValidDiscoveryId(value: unknown): value is string {
  return typeof value === 'string' && value.length === DISCOVERY_ID_LENGTH && /^[0-9a-f]+$/.test(value);
}

/** Build this device's identity from its stored key and profile. */
export function localPeerIdentity(
  identity: LocalIdentity,
  discoveryId: string,
  displayName: string,
): LocalPeerIdentity {
  return {
    installationId: identity.deviceId,
    peerId: identity.peerId,
    publicKeyFingerprint: fingerprintOfKey(identity.signing.publicKey),
    displayName,
    discoveryId,
  };
}

/**
 * Shorten an identifier for a log line.
 *
 * Logs are read on a phone with no laptop attached, and a full peer id is
 * sixteen characters of base32 that nobody can hold in their head. Eight is
 * enough to tell two peers apart in a cabin and to match a line against the
 * Developer Mode screen.
 */
export function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length <= 8 ? value : value.slice(0, 8);
}

/**
 * Which installation should open the connection when both tried at once.
 *
 * Both phones compute this from the same pair of values and necessarily reach
 * opposite conclusions, so exactly one of them yields - with no round trip, no
 * timer, and nothing to go wrong if a message is lost. Ordering is by string
 * comparison of two random 128-bit identifiers, which is arbitrary and fair.
 */
export function initiatorWins(localInstallationId: string, remoteInstallationId: string): boolean {
  return localInstallationId < remoteInstallationId;
}
