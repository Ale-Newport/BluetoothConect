/**
 * What the interface knows about.
 *
 * These are UI shapes, deliberately separate from the protocol types in
 * @airlink/core. A screen should never have to think about a `Link`, an
 * `Envelope` or a `TransportKind`; it thinks about a person, a conversation and
 * whether things are working.
 */
import type { ConnectionState, NearbyPeer, TransportUnavailableReason } from '@airlink/core';

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

/**
 * How many things are waiting on the user, as the tab bar draws them.
 *
 * Counts, not lists. A badge only ever needs a number, and keeping the rows
 * here would be a second copy of what SQLite and the invite centre already
 * hold - which is exactly the kind of duplicate that drifts, and then argues
 * with the screen it was meant to agree with.
 *
 * `unreadChats` counts CONVERSATIONS with something unread rather than unread
 * messages. "3" meaning three people are waiting is a number somebody can act
 * on; "47" meaning forty-seven messages is a number they can only feel bad
 * about. The app icon carries the same figure, so the badge on the phone's home
 * screen and the badge on the tab bar never say different things.
 */
export interface WaitingCounts {
  readonly unreadChats: number;
  /** Game invitations still open, still unanswered, and not yet expired. */
  readonly pendingInvites: number;
}

export interface RadioStatus {
  readonly bluetoothOn: boolean;
  readonly wifiOn: boolean;
  /** Reason to show the user when something is off, already phrased for them. */
  readonly detail: string | null;
  /**
   * WHY Bluetooth is unavailable, not merely that it is.
   *
   * "Off", "you declined the permission" and "this device has no Bluetooth
   * radio" are three different facts, and only the first two are worth sending
   * somebody to Settings for. Collapsing them into one boolean is what put a
   * dead "Open Settings" button in front of anyone whose hardware has no radio
   * at all, and told a person who had denied the permission that their
   * Bluetooth was switched off.
   */
  readonly bluetoothReason: TransportUnavailableReason | null;
}

export type { NearbyPeer };
