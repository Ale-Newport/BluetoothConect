/**
 * What the interface knows about.
 *
 * These are UI shapes, deliberately separate from the protocol types in
 * @airlink/core. A screen should never have to think about a `Link`, an
 * `Envelope` or a `TransportKind`; it thinks about a person, a conversation and
 * whether things are working.
 */
import type { ConnectionState, NearbyPeer } from '@airlink/core';

export const AppPhase = {
  /** Reading the identity and opening the database. */
  LOADING: 'loading',
  /** No identity yet: show onboarding. */
  ONBOARDING: 'onboarding',
  READY: 'ready',
  /** Something went wrong badly enough that the app cannot continue. */
  FAILED: 'failed',
} as const;
export type AppPhase = (typeof AppPhase)[keyof typeof AppPhase];

export interface LocalProfile {
  readonly peerId: string;
  readonly displayName: string;
  readonly avatarColor: string | null;
  readonly deviceId: string;
}

/** How a peer appears in the interface: a person, not a radio. */
export interface PeerView {
  readonly key: string;
  readonly peerId: string | null;
  readonly displayName: string;
  readonly avatarColor: string | null;
  readonly isFriend: boolean;
  readonly nearby: boolean;
  readonly connection: ConnectionState;
  /** Excellent · Good · Weak · Reconnecting. Never a dBm. */
  readonly quality: string | null;
  readonly lastSeenAt: number;
  /** True when a photo would move at a useful speed. */
  readonly highBandwidth: boolean;
}

/** A pairing waiting on the user to compare six digits. */
export interface PendingPairing {
  readonly peerKey: string;
  readonly displayName: string;
  readonly code: string;
  readonly startedAt: number;
}

export interface RadioStatus {
  readonly bluetoothOn: boolean;
  readonly wifiOn: boolean;
  readonly permissionsGranted: boolean;
  /** Reason to show the user when something is off, already phrased for them. */
  readonly detail: string | null;
}

export type { NearbyPeer };
