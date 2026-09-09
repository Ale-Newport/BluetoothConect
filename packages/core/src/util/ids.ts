import type { RandomSource } from '../crypto/random.js';
import { toBase32, toHex } from './bytes.js';

/**
 * Identifier helpers.
 *
 * Nothing here derives an identifier from hardware (MAC address, IMEI,
 * advertising ID or similar). Public identifiers are random, generated on the
 * device, and can be rotated by the user.
 */

/** 128-bit random identifier rendered as 32 lowercase hex characters. */
export function newUuidLike(random: RandomSource): string {
  return toHex(random.randomBytes(16));
}

/** Short human-facing code (e.g. for a pairing session): 8 Crockford base32 chars. */
export function newShortCode(random: RandomSource): string {
  return toBase32(random.randomBytes(5)).slice(0, 8);
}

/** Monotonic-per-process, lexicographically sortable id: <base36 time><random>. */
export function newSortableId(random: RandomSource, wallNow: number): string {
  const time = Math.floor(wallNow).toString(36).padStart(9, '0');
  return `${time}${toBase32(random.randomBytes(8)).toLowerCase()}`;
}
