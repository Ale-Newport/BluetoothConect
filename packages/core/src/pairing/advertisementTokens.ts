/**
 * Rotating advertisement tokens.
 *
 * THE PROBLEM. A Bluetooth advertisement is a broadcast: anyone within range
 * receives it, whether or not they are running AirLink. We want a paired friend
 * to recognise us BEFORE connecting - that is what makes "Maria - Trusted
 * friend" appear the moment she walks into range - but putting any durable
 * identifier in that broadcast would let a shop, an airport or a stranger with a
 * laptop follow the device around indefinitely.
 *
 * THE ANSWER. Each pairing derives a shared secret. The advertised token is a
 * truncated MAC over that secret and a coarse timestamp, so:
 *
 *   - a peer who has paired with us can compute the same value and recognise us;
 *   - anyone else sees six bytes that change every few minutes and carry no
 *     usable structure;
 *   - two different friends see two different tokens for the same device, so
 *     they cannot collude to confirm they saw the same phone.
 *
 * THE LIMITS, stated plainly. Within one rotation window the token is constant,
 * so an observer can link sightings for up to that window. Shortening the window
 * improves privacy and costs recognition reliability when clocks disagree; the
 * default of five minutes, with adjacent windows accepted, is the compromise.
 * This is unlinkability against a casual observer, not against one who watches a
 * fixed location continuously.
 */
import { concatBytes, timingSafeEqual, utf8Encode } from '../util/bytes.js';
import { mac256 } from '../crypto/primitives.js';

/** Length of the per-friend advertisement key derived at pairing time. */
export const ADVERTISEMENT_KEY_LENGTH = 32;

/** Bytes of token actually broadcast. Six is what fits comfortably in a BLE advertisement. */
export const ADVERTISEMENT_TOKEN_LENGTH = 6;

/** How long one token stays valid. */
export const TOKEN_ROTATION_WINDOW_MS = 5 * 60 * 1000;

/**
 * How many windows either side of the current one a matcher will accept.
 *
 * Two phones that have been in airplane mode for a day can disagree by minutes,
 * and a token computed from the wrong window matches nothing. Accepting the
 * neighbours costs a little linkability and buys recognition that actually
 * works after a long flight.
 */
export const TOKEN_WINDOW_TOLERANCE = 1;

const TOKEN_DOMAIN = utf8Encode('AirLink-v1-advertisement-token');

/** Window index for a wall-clock instant. */
export function windowIndexFor(wallNowMs: number, windowMs = TOKEN_ROTATION_WINDOW_MS): number {
  return Math.floor(wallNowMs / windowMs);
}

function windowBytes(index: number): Uint8Array {
  // Six bytes covers window indices well past any plausible date and keeps the
  // MAC input a fixed length.
  const out = new Uint8Array(6);
  let value = index;
  for (let i = 5; i >= 0; i--) {
    out[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return out;
}

/**
 * Compute the token this device broadcasts to one particular friend.
 *
 * Note the asymmetry this creates: a device with three friends has three
 * different tokens to advertise. A BLE advertisement has room for one, so the
 * caller rotates through them - see `tokenRotation`.
 */
export function deriveAdvertisementToken(
  advertisementKey: Uint8Array,
  wallNowMs: number,
  windowMs = TOKEN_ROTATION_WINDOW_MS,
): Uint8Array {
  if (advertisementKey.length !== ADVERTISEMENT_KEY_LENGTH) {
    throw new Error('deriveAdvertisementToken: advertisement key must be 32 bytes');
  }
  const index = windowIndexFor(wallNowMs, windowMs);
  const mac = mac256(advertisementKey, concatBytes(TOKEN_DOMAIN, windowBytes(index)));
  return mac.slice(0, ADVERTISEMENT_TOKEN_LENGTH);
}

/** Every token that is currently acceptable for one friend, oldest window first. */
export function acceptableTokens(
  advertisementKey: Uint8Array,
  wallNowMs: number,
  tolerance = TOKEN_WINDOW_TOLERANCE,
  windowMs = TOKEN_ROTATION_WINDOW_MS,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = -tolerance; offset <= tolerance; offset++) {
    out.push(deriveAdvertisementToken(advertisementKey, wallNowMs + offset * windowMs, windowMs));
  }
  return out;
}

export interface TokenCandidate {
  readonly peerId: string;
  readonly advertisementKey: Uint8Array;
}

/**
 * Match an observed token against every known friend.
 *
 * Comparison is constant-time per candidate. The loop is not - it stops at the
 * first match - but the set of people whose keys are on this device is not a
 * secret from the person holding it, so there is nothing to leak.
 */
export function matchAdvertisementToken(
  observed: Uint8Array,
  candidates: readonly TokenCandidate[],
  wallNowMs: number,
  tolerance = TOKEN_WINDOW_TOLERANCE,
  windowMs = TOKEN_ROTATION_WINDOW_MS,
): string | null {
  if (observed.length !== ADVERTISEMENT_TOKEN_LENGTH) return null;
  for (const candidate of candidates) {
    if (candidate.advertisementKey.length !== ADVERTISEMENT_KEY_LENGTH) continue;
    for (const token of acceptableTokens(candidate.advertisementKey, wallNowMs, tolerance, windowMs)) {
      if (timingSafeEqual(observed, token)) return candidate.peerId;
    }
  }
  return null;
}

/**
 * Which friend's token to broadcast next.
 *
 * With several friends we cannot advertise for all of them at once, so we cycle:
 * each rotation slot advertises for one friend, and a friend in range is
 * recognised within `friends.length` slots. Callers advertise a fresh token
 * every few seconds, so even a long friend list is covered in well under a
 * minute.
 *
 * Returns null when there is nobody to advertise for, in which case the caller
 * broadcasts a random token - a device with no friends should look exactly like
 * a device with friends to anyone watching.
 */
export function tokenRotation(
  friends: readonly TokenCandidate[],
  slot: number,
  wallNowMs: number,
  windowMs = TOKEN_ROTATION_WINDOW_MS,
): { peerId: string; token: Uint8Array } | null {
  if (friends.length === 0) return null;
  const chosen = friends[((slot % friends.length) + friends.length) % friends.length];
  if (!chosen) return null;
  return {
    peerId: chosen.peerId,
    token: deriveAdvertisementToken(chosen.advertisementKey, wallNowMs, windowMs),
  };
}
