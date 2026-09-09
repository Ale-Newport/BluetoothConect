/**
 * Watch-together - domain types and wire limits.
 *
 * The whole feature moves COMMANDS only. Not one byte of video crosses the
 * link: both phones already hold the same file (the file-transfer module puts it
 * there if one of them does not), and this module only ever agrees on *where in
 * that file* the two players should be.
 *
 * Split into four testable layers, the same way chat is:
 *
 *   types.ts       this file - pure data and bounds
 *   contentHash.ts the sampled hash, a pure function of the file's bytes
 *   codec.ts       pure CBOR encode/decode, every field bounded
 *   watchSession.ts the state machine that binds the above to a PeerSession
 *
 * Nothing here imports a media player. The protocol drives an injected
 * `MediaController`, so the entire feature - including drift correction and
 * latency compensation - is tested against a fake player on a virtual clock.
 */

// ---------------------------------------------------------------------------
// Limits
//
// Every bound below constrains something a PEER controls. They are enforced on
// decode, where the answer to anything out of range is to drop the packet.
// ---------------------------------------------------------------------------

export const SYNC_LIMITS = {
  /** Session and query identifiers: 16 hex characters in practice. */
  maxIdChars: 64,
  /** Display title. Never parsed, only shown. */
  maxTitleChars: 200,
  maxMimeTypeChars: 128,
  /** Reason strings on leave/end. */
  maxReasonChars: 120,
  /** The sampled content hash is a SHA-256 digest and nothing else. */
  contentHashBytes: 32,
  /**
   * 64 GiB. Far larger than any file a phone will hold; a sanity bound that
   * keeps every size computation inside the safe-integer range.
   */
  maxContentBytes: 64 * 1024 * 1024 * 1024,
  /**
   * Epoch ceiling. A host bumps the epoch once per command, so 2^31 commands
   * is not reachable by a human - but it is reachable by a peer that simply
   * sends the number, and unbounded integers make the comparison logic sloppy.
   */
  maxEpoch: 0x7fff_ffff,
  /**
   * How far ahead of *our* clock a scheduled start may be. Latency compensation
   * needs a few hundred milliseconds; anything beyond a few seconds is either a
   * broken clock estimate or a peer trying to freeze our player, and the right
   * answer to both is to drop the anchor.
   */
  maxScheduleAheadMs: 10_000,
  /**
   * How far past the end of the content a peer's position may sit before we
   * call it absurd. A little slack absorbs the difference between the container
   * duration and the last decodable frame.
   */
  positionOverrunSlackMs: 5_000,
  /**
   * Duration reported by a decoder is not a byte-exact fact about the file:
   * AVFoundation and ExoPlayer round the last frame differently, and a
   * container's declared duration can disagree with the stream by a frame or
   * two. Two files whose durations differ by less than this are still "the same
   * film" as far as matching is concerned.
   */
  durationToleranceMs: 1_000,
} as const;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Everything the two sides compare before they agree to watch something.
 * This is exactly what travels; nothing device-local is in it.
 */
export interface ContentIdentity {
  /** Exact file size in bytes. A byte-exact fact, and part of the hash. */
  readonly byteLength: number;
  /** Duration as the local decoder reports it. Compared with a tolerance. */
  readonly durationMs: number;
  /** SHA-256 over the sampled windows. See contentHash.ts. */
  readonly sampledHash: Uint8Array;
  /** Display title. Advisory, never used for matching. */
  readonly title?: string;
  readonly mimeType?: string;
}

/**
 * A local file, identified the way this device identifies it.
 *
 * `contentId` is LOCAL - it is how this device finds the file again - and is
 * deliberately not part of the wire format or of matching. Two phones that
 * downloaded the same film have no reason to agree on a filename.
 */
export interface ContentDescriptor extends ContentIdentity {
  /** Local handle for the file. Never sent, never compared. */
  readonly contentId: string;
}

/** Why two descriptors are, or are not, the same piece of content. */
export const ContentMatch = {
  MATCH: 'match',
  SIZE_MISMATCH: 'sizeMismatch',
  DURATION_MISMATCH: 'durationMismatch',
  HASH_MISMATCH: 'hashMismatch',
} as const;
export type ContentMatch = (typeof ContentMatch)[keyof typeof ContentMatch];

/** The peer's answer to "do you have this file?". */
export const ContentAvailability = {
  /** Same size, same sampled hash, duration within tolerance. */
  HAVE: 0,
  /** No file that looks anything like it. Offer to send it. */
  MISSING: 1,
  /** A file with the same name or duration, but not the same bytes. */
  MISMATCH: 2,
} as const;
export type ContentAvailability = (typeof ContentAvailability)[keyof typeof ContentAvailability];

export function isContentAvailability(value: unknown): value is ContentAvailability {
  return value === 0 || value === 1 || value === 2;
}

/**
 * Compare two descriptors.
 *
 * Size and hash must match exactly - they are facts about bytes. Duration is
 * compared with a tolerance because it is a fact about a decoder (see
 * SYNC_LIMITS.durationToleranceMs). The order of the checks is chosen so the
 * reported reason is the most useful one: a different size explains everything
 * that follows it.
 */
export function compareContent(local: ContentIdentity, remote: ContentIdentity): ContentMatch {
  if (local.byteLength !== remote.byteLength) return ContentMatch.SIZE_MISMATCH;
  if (!hashesEqual(local.sampledHash, remote.sampledHash)) return ContentMatch.HASH_MISMATCH;
  if (Math.abs(local.durationMs - remote.durationMs) > SYNC_LIMITS.durationToleranceMs) {
    return ContentMatch.DURATION_MISMATCH;
  }
  return ContentMatch.MATCH;
}

/**
 * Plain byte comparison. Deliberately NOT the constant-time one: a content
 * hash is public information about a file both peers already hold, and using
 * the timing-safe helper here would suggest a secret that is not there.
 */
function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** A peer asking whether we hold a particular file. */
export interface ContentQuery {
  readonly queryId: string;
  readonly content: ContentIdentity;
}

/**
 * Our answer. When we hold a file that is close but not equal - the same film
 * at a different bitrate, say - we send our own numbers back too, so the asker
 * can tell the user *why* it did not match instead of just "no".
 */
export interface ContentReply {
  readonly queryId: string;
  readonly availability: ContentAvailability;
  readonly content?: ContentIdentity;
}

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

/**
 * The only thing this module knows about video.
 *
 * Modelled on the imperative surface `react-native-video` exposes through a ref,
 * with one deliberate omission: there is no `isPlaying()`. Both platforms report
 * that asynchronously and late, so a protocol that branched on it would branch
 * on stale information. The anchor already says whether playback should be
 * running; this module keeps the player matching the anchor and never asks.
 *
 * Implementations must not throw. If one does, the drift loop treats the reading
 * as unavailable and skips the tick rather than tearing down the session.
 */
export interface MediaController {
  play(): void;
  pause(): void;
  /** Jump to an absolute position in the content, in milliseconds. */
  seek(positionMs: number): void;
  /** 1 = normal speed. Also used for the sub-percent drift nudges. */
  setRate(rate: number): void;
  /**
   * Current playback position in milliseconds.
   *
   * Expected to be JITTERY - that is the platform limit this whole design is
   * built around. It is only ever read locally, to measure our own drift from
   * the anchor line, and is never published to the peer.
   */
  getPosition(): number;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export const SyncRole = {
  /** Publishes anchors. Exactly one per session. */
  HOST: 'host',
  /** Follows anchors, and may *request* commands the host then publishes. */
  GUEST: 'guest',
} as const;
export type SyncRole = (typeof SyncRole)[keyof typeof SyncRole];

export const WatchState = {
  /** Nothing going on. */
  IDLE: 'idle',
  /** A content query is outstanding. */
  MATCHING: 'matching',
  /** Both sides confirmed the same file. No session created yet. */
  READY: 'ready',
  /** Invited by the peer, waiting for this device's user to accept. */
  INVITED: 'invited',
  /** We publish the anchors. */
  HOSTING: 'hosting',
  /** We follow the peer's anchors. */
  FOLLOWING: 'following',
  /** Session over. The player is deliberately left exactly as it was. */
  ENDED: 'ended',
} as const;
export type WatchState = (typeof WatchState)[keyof typeof WatchState];

/** Why a decoded packet was thrown away. Surfaced in Developer Mode. */
export const SyncRejectReason = {
  MALFORMED: 'malformed',
  WRONG_SESSION: 'wrongSession',
  NOT_IN_SESSION: 'notInSession',
  STALE_ANCHOR: 'staleAnchor',
  ABSURD_POSITION: 'absurdPosition',
  ABSURD_SCHEDULE: 'absurdSchedule',
  MISSING_ANCHOR: 'missingAnchor',
  UNEXPECTED_ROLE: 'unexpectedRole',
  CONTENT_MISMATCH: 'contentMismatch',
} as const;
export type SyncRejectReason = (typeof SyncRejectReason)[keyof typeof SyncRejectReason];
