/**
 * Anchor-based playback position - the one idea watch-together is built on.
 *
 * WHY NOT SEND POSITIONS
 *
 * The obvious design is to poll the player and broadcast "I am at 61,204 ms".
 * It does not work. `react-native-video` reports playback position with tens of
 * milliseconds of jitter on BOTH platforms: AVPlayer's periodic time observer
 * fires on a run loop and reports the time of the last rendered frame, and
 * ExoPlayer's `getCurrentPosition` is quantised by the renderer's buffer. Poll
 * that, put it on a link with its own latency and jitter, and the follower ends
 * up chasing noise - correcting for error that was never there, which is both
 * audible and self-sustaining.
 *
 * WHAT WE SEND INSTEAD
 *
 * The host publishes an ANCHOR: a straight line through position/time space.
 *
 *   anchor = (positionMs, hostWallClockMs, rate, playing, epoch)
 *
 * Every device - the host included - computes its own target continuously:
 *
 *   target = anchor.positionMs + (now_in_host_clock - anchor.hostWallClockMs) * rate
 *
 * `now_in_host_clock` comes from ClockSynchronizer, which measures the offset
 * between the two wall clocks NTP-style (see src/session/clockSync.ts). The
 * anchor is published once per command, not once per frame, so a jittery
 * position reading can never enter the shared state: it is only ever used
 * locally, to decide how far THIS device has strayed from the line.
 *
 * Correction is then computeDriftCorrection()'s job: ignore small drift, nudge
 * the playback rate for moderate drift, seek only when the gap is large.
 *
 * WHY AN EPOCH
 *
 * Heartbeats travel on the REALTIME channel, which may drop, duplicate and
 * reorder. A stale anchor applied after a fresh one would rewind everybody, so
 * every anchor carries a monotonically increasing epoch and a follower only
 * ever moves forward. `anchorSupersedes` is the whole of that rule.
 */

export interface PlaybackAnchor {
  /**
   * Monotonically increasing per host session. A follower never applies an
   * anchor older than the one it already has.
   */
  readonly epoch: number;
  /** Content position, in milliseconds, at `hostWallClockMs`. */
  readonly positionMs: number;
  /**
   * The instant, in the HOST's wall clock, at which playback is at
   * `positionMs`. May be in the future: that is how a play command schedules a
   * shared start (see computeSyncStartDelayMs).
   */
  readonly hostWallClockMs: number;
  /** Playback rate the line is drawn at. 1 = normal speed. */
  readonly rate: number;
  /** False for a paused anchor, which never advances. */
  readonly playing: boolean;
}

/** Slowest and fastest rate we will accept from a peer, or apply locally. */
export const MIN_PLAYBACK_RATE = 0.25;
export const MAX_PLAYBACK_RATE = 4;

/** Longest single piece of content we will sync: 24 hours. */
export const MAX_CONTENT_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * 2100-01-01T00:00:00Z. A wall clock beyond this is not a badly-set phone, it
 * is a peer feeding us nonsense, and arithmetic on it would overflow into
 * positions no player can represent.
 */
export const MAX_WALL_CLOCK_MS = 4_102_444_800_000;

export function isValidPlaybackRate(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_PLAYBACK_RATE && value <= MAX_PLAYBACK_RATE;
}

export function isValidPositionMs(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_CONTENT_DURATION_MS;
}

export function isValidWallClockMs(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_WALL_CLOCK_MS;
}

/**
 * Where this device should be right now, per the host's clock.
 *
 * A playing anchor whose instant is still in the future evaluates to its own
 * position: that is a scheduled start, and everyone waits on the same frame
 * until the instant arrives.
 */
export function targetPositionAt(anchor: PlaybackAnchor, hostNowMs: number, durationMs?: number): number {
  let position = anchor.positionMs;
  if (anchor.playing) {
    const elapsed = hostNowMs - anchor.hostWallClockMs;
    if (elapsed > 0) position += elapsed * anchor.rate;
  }
  if (!Number.isFinite(position) || position < 0) position = 0;
  if (durationMs !== undefined && position > durationMs) position = durationMs;
  return position;
}

/** True once the scheduled start instant has passed on a playing anchor. */
export function hasStarted(anchor: PlaybackAnchor, hostNowMs: number): boolean {
  return anchor.playing && hostNowMs >= anchor.hostWallClockMs;
}

/**
 * Ordering rule for anchors arriving over a lossy, reordering link.
 *
 * A higher epoch always wins. Within one epoch - the host republishing the same
 * anchor as a heartbeat - only a strictly later instant wins, so a duplicate or
 * a delayed copy of an anchor we already hold changes nothing.
 */
export function anchorSupersedes(next: PlaybackAnchor, current: PlaybackAnchor | null): boolean {
  if (!current) return true;
  if (next.epoch !== current.epoch) return next.epoch > current.epoch;
  return next.hostWallClockMs > current.hostWallClockMs;
}

export interface StartDelayPolicy {
  /** Never schedule a start closer than this: the follower needs time to buffer. */
  readonly minMs: number;
  /** Never make the user wait longer than this, however bad the link is. */
  readonly maxMs: number;
  /** Fixed allowance for the player's own start-up latency. */
  readonly guardMs: number;
  /** How many round trips of headroom to allow. */
  readonly rttMultiplier: number;
}

export const DEFAULT_START_DELAY_POLICY: StartDelayPolicy = {
  minMs: 250,
  maxMs: 2000,
  guardMs: 120,
  rttMultiplier: 1.5,
};

/**
 * How far in the future a play command should schedule playback.
 *
 * "Play now" is always wrong: the command needs a one-way trip to reach the
 * peer, so the sender would start a full trip early and the follower would
 * spend the next thirty seconds being dragged forward. Scheduling a shared
 * instant a few hundred milliseconds out - derived from the round trip the
 * clock synchroniser actually measured - means both devices press play on the
 * same frame instead.
 */
export function computeSyncStartDelayMs(
  roundTripMs: number | null,
  policy: StartDelayPolicy = DEFAULT_START_DELAY_POLICY,
): number {
  const rtt = roundTripMs !== null && Number.isFinite(roundTripMs) && roundTripMs > 0 ? roundTripMs : 0;
  const raw = rtt * policy.rttMultiplier + policy.guardMs;
  return Math.round(Math.min(policy.maxMs, Math.max(policy.minMs, raw)));
}
