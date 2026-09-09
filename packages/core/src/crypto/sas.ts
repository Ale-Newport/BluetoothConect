/**
 * Short Authentication String.
 *
 * When two devices meet for the first time there is no prior key to
 * authenticate against, so an active attacker could sit in the middle and run
 * two separate handshakes. Both handshakes necessarily produce DIFFERENT
 * transcripts, so a short code derived from the transcript will differ too.
 * Having both users read the same six digits aloud closes the gap - the same
 * construction ZRTP, Matrix and WebRTC use.
 *
 * The code is derived from the handshake transcript hash, never from anything
 * an attacker can choose after seeing it.
 */
import { deriveKey } from './primitives.js';

const SAS_DIGITS = 6;
const SAS_MODULUS = 10 ** SAS_DIGITS;

/**
 * Derive the six-digit confirmation code from the handshake transcript.
 *
 * Eight bytes of key material are reduced modulo 1e6. The resulting bias is
 * below 2^-40 and is irrelevant next to the 1-in-1e6 guessing probability that
 * a six-digit code inherently accepts.
 */
export function deriveSasCode(sasSeed: Uint8Array): string {
  const material = deriveKey(sasSeed, new Uint8Array(0), 'AirLink v1 SAS', 8);
  let value = 0;
  for (let i = 0; i < 8; i++) value = (value * 256 + (material[i] as number)) % SAS_MODULUS;
  return value.toString().padStart(SAS_DIGITS, '0');
}

/** "483291" -> "483 291", for display. */
export function formatSasCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/**
 * Constant-time comparison of two user-entered codes.
 * Both inputs are normalised (whitespace removed) before comparison.
 */
export function sasCodesMatch(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, '');
  const nb = b.replace(/\s+/g, '');
  if (na.length !== nb.length) return false;
  let diff = 0;
  for (let i = 0; i < na.length; i++) diff |= na.charCodeAt(i) ^ nb.charCodeAt(i);
  return diff === 0;
}
