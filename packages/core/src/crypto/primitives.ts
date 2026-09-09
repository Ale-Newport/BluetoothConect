/**
 * The complete set of cryptographic primitives AirLink uses, and nothing else.
 *
 * Every primitive comes from the audited @noble/* suite (v2), which is pure
 * JavaScript and therefore behaves identically on Node and on Hermes. AirLink
 * defines no cryptography of its own - only a protocol composed from these
 * standard building blocks.
 *
 *   signatures  Ed25519                (RFC 8032)
 *   key agree   X25519                 (RFC 7748)
 *   AEAD        ChaCha20-Poly1305      (RFC 8439)
 *   AEAD alt    AES-256-GCM            (NIST SP 800-38D)
 *   hash        SHA-256                (FIPS 180-4)
 *   KDF         HKDF-SHA256            (RFC 5869)
 *   MAC         HMAC-SHA256            (RFC 2104)
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { utf8Encode } from '../util/bytes.js';

export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export const ED25519_PUBLIC_KEY_LENGTH = 32;
export const ED25519_SECRET_KEY_LENGTH = 32;
export const ED25519_SIGNATURE_LENGTH = 64;
export const X25519_KEY_LENGTH = 32;

// --- signatures -------------------------------------------------------------

export function generateSigningKeyPair(seed?: Uint8Array): KeyPair {
  if (seed) {
    if (seed.length !== ED25519_SECRET_KEY_LENGTH) throw new Error('ed25519: seed must be 32 bytes');
    return { secretKey: seed, publicKey: ed25519.getPublicKey(seed) };
  }
  const kp = ed25519.keygen();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verifySignature(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== ED25519_SIGNATURE_LENGTH) return false;
  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) return false;
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    // A malformed public key (not a valid curve point) throws rather than
    // returning false. A peer controls this input, so it must never escape.
    return false;
  }
}

// --- key agreement ----------------------------------------------------------

export function generateAgreementKeyPair(seed?: Uint8Array): KeyPair {
  if (seed) {
    if (seed.length !== X25519_KEY_LENGTH) throw new Error('x25519: seed must be 32 bytes');
    return { secretKey: seed, publicKey: x25519.getPublicKey(seed) };
  }
  const kp = x25519.keygen();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * X25519 Diffie-Hellman. Throws on an all-zero (low-order) shared secret, which
 * is the standard check from RFC 7748 section 6.1.
 */
export function agree(secretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  if (peerPublicKey.length !== X25519_KEY_LENGTH) {
    throw new Error('x25519: contributory behaviour check failed (peer public key must be 32 bytes)');
  }
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(secretKey, peerPublicKey);
  } catch {
    // @noble rejects low-order points itself. Normalise the message so callers
    // see one failure mode regardless of which layer caught it.
    throw new Error('x25519: contributory behaviour check failed (invalid peer public key)');
  }
  let acc = 0;
  for (let i = 0; i < shared.length; i++) acc |= shared[i] as number;
  if (acc === 0) throw new Error('x25519: contributory behaviour check failed (all-zero shared secret)');
  return shared;
}

// --- hashing and derivation -------------------------------------------------

export function hash256(...parts: readonly Uint8Array[]): Uint8Array {
  const h = sha256.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

export function mac256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message);
}

/** HKDF-SHA256. `info` is given as a string for readability at call sites. */
export function deriveKey(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8Encode(info), length);
}

// --- AEAD -------------------------------------------------------------------

export type AeadAlgorithm = 'chacha20poly1305' | 'aes256gcm';

/**
 * Seal with the negotiated AEAD. Both algorithms take a 32-byte key, a 12-byte
 * nonce and produce ciphertext followed by a 16-byte tag.
 *
 * ChaCha20-Poly1305 is the default: it is constant-time in pure JavaScript,
 * whereas a software AES implementation is not. AES-256-GCM stays available for
 * a future peer that can only offer hardware AES.
 */
export function aeadSeal(
  algorithm: AeadAlgorithm,
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array {
  const cipher = algorithm === 'aes256gcm' ? gcm(key, nonce, associatedData) : chacha20poly1305(key, nonce, associatedData);
  return cipher.encrypt(plaintext);
}

/** Open an AEAD ciphertext. Returns null on any authentication failure. */
export function aeadOpen(
  algorithm: AeadAlgorithm,
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array | null {
  try {
    const cipher =
      algorithm === 'aes256gcm' ? gcm(key, nonce, associatedData) : chacha20poly1305(key, nonce, associatedData);
    return cipher.decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** XChaCha20-Poly1305 with a 24-byte random nonce - used for at-rest encryption. */
export function sealAtRest(key: Uint8Array, nonce24: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce24).encrypt(plaintext);
}

export function openAtRest(key: Uint8Array, nonce24: Uint8Array, ciphertext: Uint8Array): Uint8Array | null {
  try {
    return xchacha20poly1305(key, nonce24).decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** Zero a key buffer once it is no longer needed. Best-effort in a GC language. */
export function wipe(buffer: Uint8Array): void {
  buffer.fill(0);
}
