/**
 * Presence: who is nearby, and what state are they in.
 */
import type { TransportKind } from '../protocol/capabilities.js';

export const PresenceState = {
  /** Nearby and free to talk. */
  AVAILABLE: 'available',
  /** Nearby but in a game or a call. */
  BUSY: 'busy',
  /** The app is backgrounded; discovery may be degraded. */
  AWAY: 'away',
} as const;
export type PresenceState = (typeof PresenceState)[keyof typeof PresenceState];

export const NearbyKind = {
  /** A peer we have paired with, recognised from its rotating token. */
  TRUSTED_FRIEND: 'trustedFriend',
  /** Advertising AirLink, but we have never met. Needs explicit approval. */
  UNKNOWN_DEVICE: 'unknownDevice',
} as const;
export type NearbyKind = (typeof NearbyKind)[keyof typeof NearbyKind];

/**
 * One nearby device as the UI sees it.
 *
 * Note what is deliberately absent: no RSSI, no transport name, no endpoint id.
 * Those exist on the underlying sightings and are surfaced only in Developer
 * Mode. The Home screen shows a person, not a radio.
 */
export interface NearbyPeer {
  /** Stable key for the UI. The peer id once known, otherwise a transport handle. */
  readonly key: string;
  readonly kind: NearbyKind;
  /** Cryptographic peer id. Only known for a recognised friend. */
  readonly peerId: string | null;
  /** Name to show. For an unknown device this is advertised and untrusted. */
  readonly displayName: string;
  /** Signal quality, bucketed. Never a raw dBm. */
  readonly proximity: Proximity;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  /** Every transport this peer is currently reachable on, best first. */
  readonly reachableVia: readonly TransportKind[];
  /** True while a session with this peer is live. */
  readonly connected: boolean;
}

export const Proximity = {
  /** Right next to you. */
  IMMEDIATE: 'immediate',
  NEAR: 'near',
  FAR: 'far',
  UNKNOWN: 'unknown',
} as const;
export type Proximity = (typeof Proximity)[keyof typeof Proximity];

/**
 * Map a raw RSSI onto a bucket.
 *
 * The thresholds are deliberately coarse. RSSI is noisy enough that a numeric
 * distance would be a lie, and the only question the interface actually asks is
 * "is this the person sitting next to me, or someone across the carriage?".
 */
export function proximityFromRssi(rssi: number | undefined): Proximity {
  if (rssi === undefined || rssi === 0) return Proximity.UNKNOWN;
  if (rssi >= -55) return Proximity.IMMEDIATE;
  if (rssi >= -75) return Proximity.NEAR;
  return Proximity.FAR;
}
