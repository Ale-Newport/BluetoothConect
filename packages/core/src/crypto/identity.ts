/**
 * Local cryptographic identity.
 *
 * One long-term Ed25519 key pair per installation. Its public key IS the user's
 * durable identity: two devices that have paired once recognise each other
 * forever afterwards with no server and no network.
 *
 * Deliberately NOT used as an identifier: MAC address, IDFV/IDFA, ANDROID_ID,
 * IMEI, phone number, email. The public peer id is a hash of the public key, so
 * it is stable, self-certifying and reveals nothing about the hardware.
 */
import { toBase32, toHex, utf8Encode } from '../util/bytes.js';
import {
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SECRET_KEY_LENGTH,
  generateSigningKeyPair,
  hash256,
  type KeyPair,
} from './primitives.js';
import type { RandomSource } from './random.js';

const PEER_ID_DOMAIN = utf8Encode('AirLink-v1-peer-id');
const FINGERPRINT_DOMAIN = utf8Encode('AirLink-v1-fingerprint');

/** Length of the truncated hash rendered as the public peer id. */
const PEER_ID_BYTES = 10; // -> 16 base32 characters

export interface LocalIdentity {
  /** Public, shareable identifier derived from the identity public key. */
  readonly peerId: string;
  /** Long-term Ed25519 key pair. The secret key never leaves the device. */
  readonly signing: KeyPair;
  /** Random per-installation device identifier, rotatable independently. */
  readonly deviceId: string;
  readonly createdAt: number;
}

/** The public half of an identity - what gets exchanged during a handshake. */
export interface PublicIdentity {
  readonly peerId: string;
  readonly identityKey: Uint8Array;
}

export function peerIdFromIdentityKey(identityKey: Uint8Array): string {
  if (identityKey.length !== ED25519_PUBLIC_KEY_LENGTH) throw new Error('identity: public key must be 32 bytes');
  return toBase32(hash256(PEER_ID_DOMAIN, identityKey).subarray(0, PEER_ID_BYTES));
}

export function createIdentity(random: RandomSource, now: number): LocalIdentity {
  const seed = random.randomBytes(ED25519_SECRET_KEY_LENGTH);
  const signing = generateSigningKeyPair(seed);
  return {
    peerId: peerIdFromIdentityKey(signing.publicKey),
    signing,
    deviceId: toHex(random.randomBytes(16)),
    createdAt: now,
  };
}

/** Rebuild an identity from persisted material. */
export function restoreIdentity(secretKey: Uint8Array, deviceId: string, createdAt: number): LocalIdentity {
  if (secretKey.length !== ED25519_SECRET_KEY_LENGTH) throw new Error('identity: secret key must be 32 bytes');
  const signing = generateSigningKeyPair(secretKey);
  return { peerId: peerIdFromIdentityKey(signing.publicKey), signing, deviceId, createdAt };
}

export function publicIdentityOf(identity: LocalIdentity): PublicIdentity {
  return { peerId: identity.peerId, identityKey: identity.signing.publicKey };
}

/**
 * Human-readable safety number for two identities, in the style of Signal's.
 * Order-independent so both sides display the same string.
 */
export function safetyNumber(a: Uint8Array, b: Uint8Array): string {
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const digest = hash256(FINGERPRINT_DOMAIN, first, second);
  const groups: string[] = [];
  for (let i = 0; i < 10; i++) {
    const chunk = ((digest[i * 2] as number) << 8) | (digest[i * 2 + 1] as number);
    groups.push((chunk % 100000).toString().padStart(5, '0'));
  }
  return groups.join(' ');
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}
