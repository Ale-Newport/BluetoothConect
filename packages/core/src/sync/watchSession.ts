/**
 * Watch together - the session state machine.
 *
 * Binds the anchor maths (anchor.ts), the wire codec (codec.ts) and the drift
 * policy (session/clockSync.ts) to one `PeerSession` and one injected
 * `MediaController`. It never imports a media player, a file system or a radio,
 * so the whole feature - latency compensation, drift correction, hostile input -
 * runs deterministically against a fake player on a virtual clock.
 *
 * HOW POSITION IS AGREED
 *
 * Not by sending positions. `react-native-video` reports playback position with
 * tens of milliseconds of jitter on both platforms (AVPlayer's periodic observer
 * reports the last rendered frame; ExoPlayer quantises to the renderer buffer),
 * so polling it and broadcasting the reading would sync the two phones to the
 * noise rather than to the film.
 *
 * Instead the HOST publishes an ANCHOR - a straight line through position/time
 * space, (positionMs, hostWallClockMs, rate, playing) - once per command. Every
 * device, the host included, computes its own target continuously:
 *
 *     target = anchor.positionMs + (now_in_host_clock - anchor.hostWallClockMs) * rate
 *
 * `now_in_host_clock` comes from ClockSynchronizer's NTP-style offset. Each
 * device then compares its own (jittery) reading to that target and corrects
 * with computeDriftCorrection: below 50 ms do nothing, below 300 ms nudge the
 * playback rate by a fraction of a percent that nobody can hear, and only past
 * that spend a visible seek.
 *
 * The consequence worth stating: nobody follows anybody. Both devices follow the
 * same line, and the host's own player is corrected against the anchor exactly
 * like the guest's - one code path, so the two cannot drift apart through
 * divergent logic.
 *
 * WHY PLAY IS SCHEDULED, NOT IMMEDIATE
 *
 * "Play now" is always wrong: the command needs a one-way trip to reach the
 * peer, so the sender would begin a full trip early and then spend the next
 * minute dragging the follower forward. A play command therefore anchors to a
 * shared instant a few hundred milliseconds in the FUTURE, derived from the
 * round trip the clock synchroniser actually measured (see
 * computeSyncStartDelayMs). Both devices park on the exact frame and start
 * together.
 *
 * WHO MAY COMMAND
 *
 * Exactly one host publishes anchors. A guest may only REQUEST - its command
 * messages carry no epoch and no instant, and the host ignores those fields even
 * if a modified peer sends them. That is what keeps the epoch monotonic, and
 * with it the "never move backwards" rule that makes a lossy, reordering
 * realtime channel safe to publish heartbeats on.
 */
import { MessageType } from '../protocol/constants.js';
import { encodeCbor, type CborValue } from '../protocol/cbor.js';
import type { RandomSource } from '../crypto/random.js';
import {
  DEFAULT_DRIFT_POLICY,
  DriftAction,
  computeDriftCorrection,
  type DriftCorrection,
  type DriftPolicy,
} from '../session/clockSync.js';
import type { IncomingMessage, PeerSession } from '../session/peerSession.js';
import { toHex } from '../util/bytes.js';
import { TypedEmitter, type Unsubscribe } from '../util/emitter.js';
import { silentLogger, type Logger } from '../util/logger.js';
import type { Clock, TimerHandle } from '../util/time.js';
import {
  DEFAULT_START_DELAY_POLICY,
  anchorSupersedes,
  computeSyncStartDelayMs,
  hasStarted,
  isValidPlaybackRate,
  targetPositionAt,
  type PlaybackAnchor,
  type StartDelayPolicy,
} from './anchor.js';
import {
  decodeCommand,
  decodeContentQuery,
  decodeContentReply,
  decodeFarewell,
  decodeJoin,
  decodeSessionCreate,
  encodeAnchoredCommand,
  encodeCommandRequest,
  encodeContentQuery,
  encodeContentReply,
  encodeFarewell,
  encodeJoin,
  encodeSessionCreate,
  type SyncCommand,
  type SyncSessionCreate,
} from './codec.js';
import {
  ContentAvailability,
  ContentMatch,
  SYNC_LIMITS,
  SyncRejectReason,
  SyncRole,
  WatchState,
  compareContent,
  type ContentDescriptor,
  type ContentIdentity,
  type ContentQuery,
  type ContentReply,
  type MediaController,
} from './types.js';

export interface WatchTogetherEvents {
  stateChanged: { readonly state: WatchState; readonly role: SyncRole | null };
  /** The peer asked whether we hold a file; we have already answered. */
  contentQueried: { readonly query: ContentQuery; readonly availability: ContentAvailability };
  /** Our own query came back. */
  contentAnswered: { readonly reply: ContentReply; readonly match: ContentMatch | null };
  /**
   * A query went unanswered for `queryTimeoutMs`.
   *
   * Without this the UI would spin on "checking..." for ever whenever the peer
   * backgrounded the app, disposed its watch session, or simply stopped
   * answering - none of which produce a packet to react to.
   */
  contentQueryTimedOut: { readonly queryId: string };
  /**
   * The peer cannot watch this: it has no copy, or a different one.
   *
   * This is the hand-off point to the file-transfer module. This module
   * deliberately does not import it - it reports the fact and the app decides
   * whether to offer "send it over" (minutes, over Bluetooth) or not.
   */
  contentUnavailable: { readonly content: ContentIdentity; readonly availability: ContentAvailability };
  /** A session was created by the peer and is waiting for this user to accept. */
  invited: { readonly sessionId: string; readonly content: ContentIdentity; readonly match: ContentMatch | null };
  joined: { readonly sessionId: string; readonly role: SyncRole };
  peerJoined: { readonly sessionId: string; readonly contentConfirmed: boolean };
  /** A new line was adopted. `local` is true when this device published it. */
  anchorChanged: { readonly anchor: PlaybackAnchor; readonly local: boolean };
  /** The scheduled shared instant arrived and playback actually began. */
  playbackStarted: { readonly anchor: PlaybackAnchor };
  correction: { readonly correction: DriftCorrection; readonly targetMs: number; readonly localMs: number };
  ended: { readonly sessionId: string | null; readonly reason: string };
  /** A packet from the peer was dropped. Never fatal; surfaced for Developer Mode. */
  rejected: { readonly reason: SyncRejectReason; readonly detail: string; readonly messageType: number };
}

export interface WatchTogetherOptions {
  readonly session: PeerSession;
  readonly clock: Clock;
  readonly media: MediaController;
  readonly random: RandomSource;
  readonly logger?: Logger;
  readonly driftPolicy?: DriftPolicy;
  readonly startDelayPolicy?: StartDelayPolicy;
  /**
   * How often each device measures its own drift from the line. 500 ms is about
   * twice the rate `react-native-video` emits progress at, which is as often as
   * a fresh reading is available.
   */
  readonly correctionIntervalMs?: number;
  /**
   * How often the host republishes the current anchor on the REALTIME channel.
   * A heartbeat is what lets a device that reconnected, or that missed a
   * command, re-join the line without any repair protocol.
   */
  readonly heartbeatIntervalMs?: number;
  /** How often the clock offset is re-measured while a session is live. */
  readonly clockSyncIntervalMs?: number;
  /**
   * How long to wait for an answer to a content query before giving up. A peer
   * that never answers must not strand the state machine in MATCHING.
   */
  readonly queryTimeoutMs?: number;
  /** Accept a peer's session automatically. False surfaces `invited` instead. */
  readonly autoJoin?: boolean;
  /**
   * Find the local file matching what a peer is asking about. Without it, the
   * descriptor last handed to `setLocalContent` is the only candidate.
   */
  readonly resolveContent?: (content: ContentIdentity) => ContentDescriptor | null;
}

const DEFAULT_CORRECTION_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_CLOCK_SYNC_INTERVAL_MS = 15_000;
/**
 * How long a content query may go unanswered. Generous, because on a hostile
 * BLE link the reliable channel legitimately spends several seconds retrying -
 * but finite, because "waiting" is not a state a user can get out of.
 */
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
/**
 * Smallest gap between two guest requests the host will honour. A guest that
 * spams "play" cannot make the host publish an anchor - and burn a reliable
 * packet on a 40 KB/s link - faster than this.
 */
const MIN_REQUEST_INTERVAL_MS = 250;

export class WatchTogetherSession {
  readonly events = new TypedEmitter<WatchTogetherEvents>();

  private readonly session: PeerSession;
  private readonly clock: Clock;
  private readonly media: MediaController;
  private readonly random: RandomSource;
  private readonly log: Logger;
  private readonly driftPolicy: DriftPolicy;
  private readonly startDelayPolicy: StartDelayPolicy;
  private readonly correctionIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly clockSyncIntervalMs: number;
  private readonly queryTimeoutMs: number;
  private readonly autoJoin: boolean;
  private readonly resolveContent: ((content: ContentIdentity) => ContentDescriptor | null) | undefined;

  private state: WatchState = WatchState.IDLE;
  private role: SyncRole | null = null;
  private sessionId: string | null = null;
  private anchor: PlaybackAnchor | null = null;
  private epoch = 0;
  private baseRate = 1;
  private localContent: ContentDescriptor | null = null;
  private remoteContent: ContentIdentity | null = null;
  private pendingQueryId: string | null = null;
  private pendingInvite: SyncSessionCreate | null = null;
  private peerPresent = false;
  private appliedRate = 1;
  private lastHonouredRequestAt = Number.NEGATIVE_INFINITY;
  private clockSyncRunning = false;

  private subscriptions: Unsubscribe[] = [];
  private correctionTimer: TimerHandle | undefined;
  private heartbeatTimer: TimerHandle | undefined;
  private startTimer: TimerHandle | undefined;
  private queryTimer: TimerHandle | undefined;
  private disposed = false;

  /** Developer-mode counters. */
  rejectedPackets = 0;
  throttledRequests = 0;
  seekCount = 0;
  rateAdjustCount = 0;

  constructor(options: WatchTogetherOptions) {
    this.session = options.session;
    this.clock = options.clock;
    this.media = options.media;
    this.random = options.random;
    this.log = (options.logger ?? silentLogger).child('sync');
    this.driftPolicy = options.driftPolicy ?? DEFAULT_DRIFT_POLICY;
    this.startDelayPolicy = options.startDelayPolicy ?? DEFAULT_START_DELAY_POLICY;
    this.correctionIntervalMs = options.correctionIntervalMs ?? DEFAULT_CORRECTION_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.clockSyncIntervalMs = options.clockSyncIntervalMs ?? DEFAULT_CLOCK_SYNC_INTERVAL_MS;
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.autoJoin = options.autoJoin ?? true;
    this.resolveContent = options.resolveContent;

    this.subscriptions = [
      this.session.events.on('message', (message) => this.onMessage(message)),
      // A link that merely drops is repaired by PeerSession and must NOT end the
      // watch party. `closed` is the other thing: the session is gone for good,
      // and nothing will ever publish another anchor.
      this.session.events.on('closed', ({ reason }) => this.onPeerSessionClosed(reason)),
    ];
  }

  // -- public surface --------------------------------------------------------

  get currentState(): WatchState {
    return this.state;
  }

  get currentRole(): SyncRole | null {
    return this.role;
  }

  get id(): string | null {
    return this.sessionId;
  }

  get currentAnchor(): PlaybackAnchor | null {
    return this.anchor;
  }

  get isActive(): boolean {
    return this.state === WatchState.HOSTING || this.state === WatchState.FOLLOWING;
  }

  /** Where this device should be right now, per the shared line. */
  get targetPositionMs(): number | null {
    if (!this.anchor) return null;
    return targetPositionAt(this.anchor, this.hostNow(), this.localContent?.durationMs);
  }

  /** Declare which local file this device would watch. */
  setLocalContent(content: ContentDescriptor | null): void {
    this.localContent = content;
  }

  get content(): ContentDescriptor | null {
    return this.localContent;
  }

  /** What the peer said it was playing. Null until a query or a create arrives. */
  get peerContent(): ContentIdentity | null {
    return this.remoteContent;
  }

  /** Ask the peer whether it holds the same file. Returns the query id. */
  queryPeerContent(): string {
    this.requireLiveSession();
    const local = this.requireContent();
    this.cancelQuery();
    const queryId = this.newId();
    this.pendingQueryId = queryId;
    // MATCHING is a waiting state, and every waiting state needs a way out that
    // does not depend on the peer choosing to send something.
    this.queryTimer = this.clock.setTimeout(() => this.onQueryTimeout(queryId), this.queryTimeoutMs);
    this.setState(WatchState.MATCHING);
    this.send(MessageType.SYNC_CONTENT_QUERY, encodeContentQuery({ queryId, content: identityOf(local) }));
    return queryId;
  }

  /**
   * Stop waiting for a reply. Nothing is retried and the peer is told nothing:
   * a query is a question, and the user is entitled to stop asking.
   */
  cancelQuery(): void {
    if (this.queryTimer !== undefined) {
      this.clock.clearTimeout(this.queryTimer);
      this.queryTimer = undefined;
    }
    this.pendingQueryId = null;
  }

  /**
   * Become the host. Publishes a PAUSED anchor at `startPositionMs`, so both
   * players park on the same frame and nothing moves until someone presses play.
   */
  create(options: { startPositionMs?: number; rate?: number } = {}): string {
    if (this.isActive) throw new Error('WatchTogetherSession: a session is already running');
    this.requireLiveSession();
    const local = this.requireContent();
    const rate = options.rate ?? 1;
    if (!isValidPlaybackRate(rate)) throw new Error('WatchTogetherSession: rate is out of range');

    this.cancelQuery();
    const sessionId = this.newId();
    this.sessionId = sessionId;
    this.role = SyncRole.HOST;
    this.epoch = 1;
    this.baseRate = rate;
    this.peerPresent = false;
    this.remoteContent = null;
    this.setState(WatchState.HOSTING);
    this.startClockSync();
    this.startLoops();

    const anchor: PlaybackAnchor = {
      epoch: 1,
      positionMs: this.clampPosition(options.startPositionMs ?? 0),
      hostWallClockMs: this.clock.wallNow(),
      rate,
      playing: false,
    };
    this.applyAnchor(anchor, true);
    this.send(
      MessageType.SYNC_CREATE,
      encodeSessionCreate({ sessionId, content: identityOf(local), anchor }),
    );
    return sessionId;
  }

  /** Accept an invitation surfaced by the `invited` event. */
  join(): void {
    const invite = this.pendingInvite;
    if (!invite) throw new Error('WatchTogetherSession: no invitation to accept');
    this.pendingInvite = null;
    this.acceptInvite(invite);
  }

  /** Decline an invitation. The peer is told, and keeps watching on its own. */
  decline(reason = 'declined'): void {
    const invite = this.pendingInvite;
    if (!invite) return;
    this.pendingInvite = null;
    this.send(MessageType.SYNC_LEAVE, encodeFarewell({ sessionId: invite.sessionId, reason }));
    this.setState(WatchState.IDLE);
  }

  /**
   * Start playback at a shared future instant. On a guest this is a request; the
   * host answers with the anchor everyone then follows.
   */
  play(): void {
    if (!this.isActive) throw new Error('WatchTogetherSession: no session');
    if (this.role === SyncRole.GUEST) {
      this.request(MessageType.SYNC_PLAY);
      return;
    }
    const now = this.clock.wallNow();
    const from = this.anchor ? targetPositionAt(this.anchor, now, this.localContent?.durationMs) : 0;
    const delay = computeSyncStartDelayMs(this.session.clockSync.roundTripMs, this.startDelayPolicy);
    this.publish(MessageType.SYNC_PLAY, {
      epoch: this.nextEpoch(),
      positionMs: from,
      hostWallClockMs: now + delay,
      rate: this.baseRate,
      playing: true,
    });
  }

  pause(): void {
    if (!this.isActive) throw new Error('WatchTogetherSession: no session');
    if (this.role === SyncRole.GUEST) {
      this.request(MessageType.SYNC_PAUSE);
      return;
    }
    const now = this.clock.wallNow();
    // Pause AT THE LINE, not at whatever the local player happens to report.
    // Taking the reading here would bake this device's jitter into the shared
    // state, which is the one thing the anchor design exists to prevent.
    const at = this.anchor ? targetPositionAt(this.anchor, now, this.localContent?.durationMs) : 0;
    this.publish(MessageType.SYNC_PAUSE, {
      epoch: this.nextEpoch(),
      positionMs: at,
      hostWallClockMs: now,
      rate: this.baseRate,
      playing: false,
    });
  }

  seekTo(positionMs: number): void {
    if (!this.isActive) throw new Error('WatchTogetherSession: no session');
    if (!Number.isFinite(positionMs)) throw new Error('WatchTogetherSession: seek target must be finite');
    if (this.role === SyncRole.GUEST) {
      this.request(MessageType.SYNC_SEEK, { positionMs: this.clampPosition(positionMs) });
      return;
    }
    const playing = this.anchor?.playing ?? false;
    const now = this.clock.wallNow();
    // A seek while playing re-schedules a shared start: both players have to
    // find the keyframe, and doing it against a shared instant means they
    // resume together instead of one waiting for the other to catch up.
    const startAt = playing ? now + computeSyncStartDelayMs(this.session.clockSync.roundTripMs, this.startDelayPolicy) : now;
    this.publish(MessageType.SYNC_SEEK, {
      epoch: this.nextEpoch(),
      positionMs: this.clampPosition(positionMs),
      hostWallClockMs: startAt,
      rate: this.baseRate,
      playing,
    });
  }

  setRate(rate: number): void {
    if (!this.isActive) throw new Error('WatchTogetherSession: no session');
    if (!isValidPlaybackRate(rate)) throw new Error('WatchTogetherSession: rate is out of range');
    if (this.role === SyncRole.GUEST) {
      this.request(MessageType.SYNC_RATE, { rate });
      return;
    }
    const now = this.clock.wallNow();
    // The new line pivots through the current position, so the picture does not
    // jump when the speed changes.
    const at = this.anchor ? targetPositionAt(this.anchor, now, this.localContent?.durationMs) : 0;
    this.baseRate = rate;
    this.publish(MessageType.SYNC_RATE, {
      epoch: this.nextEpoch(),
      positionMs: at,
      hostWallClockMs: now,
      rate,
      playing: this.anchor?.playing ?? false,
    });
  }

  /**
   * Leave or end the session.
   *
   * A guest sends SYNC_LEAVE, a host sends SYNC_END. Neither touches the media
   * player: leaving a watch party does not stop your film, it stops you being
   * corrected.
   */
  end(reason = 'ended'): void {
    // An invitation that was never accepted is declined, not silently dropped:
    // the peer is sitting there waiting for a join that will never come.
    if (this.state === WatchState.INVITED) {
      this.decline(reason);
      return;
    }
    // Nothing has been created yet, so there is nothing to tell the peer - but
    // an outstanding query has to stop, or the user cannot get out of the
    // waiting state they just asked to leave.
    if (this.state === WatchState.MATCHING || this.state === WatchState.READY) {
      this.cancelQuery();
      this.setState(WatchState.IDLE);
      return;
    }
    if (!this.sessionId || !this.isActive) return;
    const type = this.role === SyncRole.HOST ? MessageType.SYNC_END : MessageType.SYNC_LEAVE;
    this.send(type, encodeFarewell({ sessionId: this.sessionId, reason }));
    this.finish(reason);
  }

  /** Alias for `end`, for call sites where "leave" reads better. */
  leave(reason = 'left'): void {
    this.end(reason);
  }

  /** Detach from the peer session. Sends nothing and never touches the player. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    this.stopLoops();
    this.cancelQuery();
    this.stopClockSync();
    this.events.removeAllListeners();
  }

  diagnostics(): Record<string, unknown> {
    return {
      state: this.state,
      role: this.role,
      sessionId: this.sessionId,
      epoch: this.epoch,
      anchor: this.anchor,
      peerPresent: this.peerPresent,
      targetPositionMs: this.targetPositionMs,
      appliedRate: this.appliedRate,
      clockOffsetMs: this.session.clockSync.offsetMs,
      roundTripMs: this.session.clockSync.roundTripMs,
      rejectedPackets: this.rejectedPackets,
      throttledRequests: this.throttledRequests,
      seekCount: this.seekCount,
      rateAdjustCount: this.rateAdjustCount,
    };
  }

  // -- anchors ---------------------------------------------------------------

  /** Host: adopt a new line locally and tell the peer about it. */
  private publish(messageType: number, anchor: PlaybackAnchor): void {
    if (!this.sessionId) return;
    this.applyAnchor(anchor, true);
    this.send(messageType, encodeAnchoredCommand(this.sessionId, anchor));
  }

  /**
   * Adopt a line.
   *
   * A heartbeat republishes the SAME line with a fresher anchor point, so it
   * carries the same epoch - and in that case the player must not be touched at
   * all. Re-issuing play/seek/setRate every two seconds would cancel any rate
   * nudge in flight and could make a player stutter for no reason.
   */
  private applyAnchor(anchor: PlaybackAnchor, local: boolean): void {
    const sameLine = this.anchor !== null && this.anchor.epoch === anchor.epoch;
    this.anchor = anchor;
    if (sameLine) {
      this.events.emit('anchorChanged', { anchor, local });
      return;
    }

    this.clearStartTimer();
    const hostNow = this.hostNow();

    if (!anchor.playing) {
      this.mediaPause();
      this.applyRate(anchor.rate);
      this.seekIfOff(anchor.positionMs, this.driftPolicy.ignoreThresholdMs);
    } else if (!hasStarted(anchor, hostNow)) {
      // Scheduled start: park exactly on the frame and wait for the instant.
      this.mediaPause();
      this.seekIfOff(anchor.positionMs, this.driftPolicy.ignoreThresholdMs);
      this.applyRate(anchor.rate);
      this.scheduleStart(anchor);
    } else {
      // The instant has already passed - a slow link, or a line picked up from
      // a heartbeat after a reconnect. Land on it and start.
      const target = targetPositionAt(anchor, hostNow, this.localContent?.durationMs);
      this.seekIfOff(target, this.driftPolicy.ignoreThresholdMs);
      this.applyRate(anchor.rate);
      this.mediaPlay();
      this.events.emit('playbackStarted', { anchor });
    }

    this.events.emit('anchorChanged', { anchor, local });
  }

  private scheduleStart(anchor: PlaybackAnchor): void {
    const delay = this.toLocalWall(anchor.hostWallClockMs) - this.clock.wallNow();
    if (delay <= 0) {
      this.beginPlayback(anchor);
      return;
    }
    this.startTimer = this.clock.setTimeout(() => {
      this.startTimer = undefined;
      // The line may have been replaced while we waited.
      if (this.anchor?.epoch !== anchor.epoch) return;
      this.beginPlayback(anchor);
    }, delay);
  }

  private beginPlayback(anchor: PlaybackAnchor): void {
    this.applyRate(anchor.rate);
    this.mediaPlay();
    this.events.emit('playbackStarted', { anchor });
  }

  // -- the correction loop ---------------------------------------------------

  private tick(): void {
    const anchor = this.anchor;
    if (!anchor || !this.isActive) return;
    const hostNow = this.hostNow();
    // Nothing to correct before the shared start instant: everyone is parked.
    if (anchor.playing && !hasStarted(anchor, hostNow)) return;

    const duration = this.localContent?.durationMs;
    const target = targetPositionAt(anchor, hostNow, duration);

    // The line has run past the end of the film. The host publishes the stop so
    // both devices land on the same final frame rather than each deciding for
    // itself when the file ended.
    if (this.role === SyncRole.HOST && anchor.playing && duration !== undefined && target >= duration) {
      this.publish(MessageType.SYNC_PAUSE, {
        epoch: this.nextEpoch(),
        positionMs: duration,
        hostWallClockMs: this.clock.wallNow(),
        rate: this.baseRate,
        playing: false,
      });
      return;
    }

    const localPosition = this.readPosition();
    if (localPosition === null) return;
    const correction = computeDriftCorrection(localPosition, target, anchor.rate, this.driftPolicy);

    switch (correction.action) {
      case DriftAction.IGNORE:
        // Back on the line: retire any nudge still applied.
        this.applyRate(anchor.rate);
        break;
      case DriftAction.ADJUST_RATE:
        if (anchor.playing) {
          this.applyRate(correction.rate);
          this.rateAdjustCount++;
        } else {
          // A paused player cannot be nudged - its rate advances nothing - so
          // the only correction available while paused is a seek.
          this.mediaSeek(target);
        }
        break;
      case DriftAction.SEEK:
        this.mediaSeek(target);
        this.applyRate(anchor.rate);
        break;
      default:
        break;
    }
    this.events.emit('correction', { correction, targetMs: target, localMs: localPosition });
  }

  private heartbeat(): void {
    const anchor = this.anchor;
    if (this.role !== SyncRole.HOST || !anchor || !this.peerPresent || !this.sessionId) return;
    const now = this.clock.wallNow();
    // Never slide a scheduled start: refreshing its anchor point would turn a
    // shared future instant into "start now" and undo the latency compensation.
    if (anchor.playing && !hasStarted(anchor, now)) return;

    const refreshed: PlaybackAnchor = {
      epoch: anchor.epoch,
      positionMs: targetPositionAt(anchor, now, this.localContent?.durationMs),
      hostWallClockMs: now,
      rate: anchor.rate,
      playing: anchor.playing,
    };
    this.anchor = refreshed;
    // REALTIME: a heartbeat that is late is worthless, and one that is lost is
    // replaced two seconds later. The coalesce key means a congested link
    // carries the newest anchor rather than a backlog of stale ones.
    this.sendRealtime(MessageType.SYNC_HEARTBEAT, encodeAnchoredCommand(this.sessionId, refreshed), 'sync:anchor');
  }

  // -- inbound ---------------------------------------------------------------

  private onMessage(message: IncomingMessage): void {
    switch (message.type) {
      case MessageType.SYNC_CONTENT_QUERY:
        this.onContentQuery(message.raw);
        return;
      case MessageType.SYNC_CONTENT_REPLY:
        this.onContentReply(message.raw);
        return;
      case MessageType.SYNC_CREATE:
        this.onCreate(message.raw);
        return;
      case MessageType.SYNC_JOIN:
        this.onJoin(message.raw);
        return;
      case MessageType.SYNC_LEAVE:
        this.onFarewell(message.raw, MessageType.SYNC_LEAVE, 'peer left the session');
        return;
      case MessageType.SYNC_END:
        this.onFarewell(message.raw, MessageType.SYNC_END, 'host ended the session');
        return;
      case MessageType.SYNC_PLAY:
      case MessageType.SYNC_PAUSE:
      case MessageType.SYNC_SEEK:
      case MessageType.SYNC_RATE:
      case MessageType.SYNC_HEARTBEAT:
        this.onCommand(message.type, message.raw);
        return;
      default:
        return;
    }
  }

  private onContentQuery(raw: Uint8Array): void {
    let query: ContentQuery;
    try {
      query = decodeContentQuery(raw);
    } catch (err) {
      this.reject(SyncRejectReason.MALFORMED, String(err), MessageType.SYNC_CONTENT_QUERY);
      return;
    }
    const local = this.resolve(query.content);
    let availability: ContentAvailability = ContentAvailability.MISSING;
    // Whether our own descriptor - which carries the file's TITLE - goes back.
    let describe = false;
    if (local) {
      if (compareContent(local, query.content) === ContentMatch.MATCH) {
        availability = ContentAvailability.HAVE;
        describe = true;
      } else if (isPlausibleAlternative(local, query.content)) {
        availability = ContentAvailability.MISMATCH;
        describe = true;
      }
    }
    this.send(
      MessageType.SYNC_CONTENT_REPLY,
      encodeContentReply({
        queryId: query.queryId,
        availability,
        ...(local && describe ? { content: identityOf(local) } : {}),
      }),
    );
    this.events.emit('contentQueried', { query, availability });
  }

  private onContentReply(raw: Uint8Array): void {
    let reply: ContentReply;
    try {
      reply = decodeContentReply(raw);
    } catch (err) {
      this.reject(SyncRejectReason.MALFORMED, String(err), MessageType.SYNC_CONTENT_REPLY);
      return;
    }
    // An unsolicited reply, or one for a query we already resolved, tells us
    // nothing and must not move the state machine.
    if (this.pendingQueryId === null || reply.queryId !== this.pendingQueryId) {
      this.reject(SyncRejectReason.WRONG_SESSION, 'reply for an unknown query', MessageType.SYNC_CONTENT_REPLY);
      return;
    }
    this.cancelQuery();
    const match =
      this.localContent && reply.content ? compareContent(this.localContent, reply.content) : null;
    this.events.emit('contentAnswered', { reply, match });

    let availability = reply.availability;
    if (availability === ContentAvailability.HAVE) {
      // Trust but VERIFY. "I have it" is a claim, and the only thing that backs
      // it is a descriptor that matches ours byte for byte. A peer that claims
      // HAVE while sending back a different descriptor - or, the hole this
      // check used to have, while sending back NO descriptor at all - has
      // proved nothing and is not somebody to start a session with.
      if (reply.content !== undefined && match === ContentMatch.MATCH) {
        this.setState(WatchState.READY);
        return;
      }
      this.reject(
        SyncRejectReason.CONTENT_MISMATCH,
        reply.content === undefined ? 'claimed HAVE with no descriptor' : `claimed HAVE but ${match}`,
        MessageType.SYNC_CONTENT_REPLY,
      );
      availability = ContentAvailability.MISMATCH;
    }
    this.setState(WatchState.IDLE);
    if (this.localContent) {
      this.events.emit('contentUnavailable', { content: identityOf(this.localContent), availability });
    }
  }

  private onCreate(raw: Uint8Array): void {
    let create: SyncSessionCreate;
    try {
      create = decodeSessionCreate(raw);
    } catch (err) {
      this.reject(SyncRejectReason.MALFORMED, String(err), MessageType.SYNC_CREATE);
      return;
    }

    if (this.role === SyncRole.HOST && this.isActive && this.sessionId !== null) {
      // Both users tapped "watch together" within a round trip of each other.
      // Deterministic tie-break, so the two devices reach the same answer with
      // no extra negotiation: the lexicographically smaller session id wins.
      // The loser is us only when the peer's id sorts lower - and the peer,
      // running this same comparison, will keep hosting.
      //
      // `peerPresent` is what keeps that from being a takeover primitive. Once
      // the peer has JOINED our session it is our guest, and a guest does not
      // get to promote itself to host by minting a create with a low id: it
      // would seize the epoch, the rate and the content, and both users' UIs
      // would flap from hosting to following mid-film. A genuinely simultaneous
      // create is, by definition, one where neither side has joined yet.
      if (this.peerPresent || create.sessionId >= this.sessionId) {
        this.reject(
          SyncRejectReason.UNEXPECTED_ROLE,
          this.peerPresent ? 'create from a peer that already joined our session' : 'already hosting a session that wins the tie-break',
          MessageType.SYNC_CREATE,
        );
        return;
      }
      this.finish('yielded to the peer');
    }

    this.remoteContent = create.content;
    this.pendingInvite = create;
    if (!this.autoJoin) {
      const local = this.resolve(create.content);
      this.setState(WatchState.INVITED);
      this.events.emit('invited', {
        sessionId: create.sessionId,
        content: create.content,
        match: local ? compareContent(local, create.content) : null,
      });
      return;
    }
    this.pendingInvite = null;
    this.acceptInvite(create);
  }

  private acceptInvite(create: SyncSessionCreate): void {
    const local = this.resolve(create.content);
    const match = local ? compareContent(local, create.content) : null;
    if (local) this.localContent = local;

    this.sessionId = create.sessionId;
    this.role = SyncRole.GUEST;
    this.epoch = create.anchor.epoch;
    this.baseRate = create.anchor.rate;
    this.peerPresent = true;
    this.anchor = null;
    this.setState(WatchState.FOLLOWING);
    this.startClockSync();
    this.startLoops();

    this.send(
      MessageType.SYNC_JOIN,
      encodeJoin({ sessionId: create.sessionId, contentConfirmed: match === ContentMatch.MATCH }),
    );
    this.events.emit('joined', { sessionId: create.sessionId, role: SyncRole.GUEST });
    if (match !== ContentMatch.MATCH) {
      this.events.emit('contentUnavailable', {
        content: create.content,
        availability: local ? ContentAvailability.MISMATCH : ContentAvailability.MISSING,
      });
    }
    // The create anchor is always paused, so no clock offset is needed to apply
    // it correctly - which matters, because the first probe round has not
    // finished yet at this point.
    if (this.acceptAnchor(create.anchor, MessageType.SYNC_CREATE)) this.applyAnchor(create.anchor, false);
  }

  private onJoin(raw: Uint8Array): void {
    let join;
    try {
      join = decodeJoin(raw);
    } catch (err) {
      this.reject(SyncRejectReason.MALFORMED, String(err), MessageType.SYNC_JOIN);
      return;
    }
    if (this.role !== SyncRole.HOST || !this.isActive) {
      this.reject(SyncRejectReason.UNEXPECTED_ROLE, 'join while not hosting', MessageType.SYNC_JOIN);
      return;
    }
    if (join.sessionId !== this.sessionId) {
      this.reject(SyncRejectReason.WRONG_SESSION, 'join for another session', MessageType.SYNC_JOIN);
      return;
    }
    this.peerPresent = true;
    this.events.emit('peerJoined', { sessionId: join.sessionId, contentConfirmed: join.contentConfirmed });
    if (!join.contentConfirmed && this.localContent) {
      // The peer is in the session but cannot see the same frames. This is the
      // cue for the app to offer the file over the file-transfer module.
      this.events.emit('contentUnavailable', {
        content: identityOf(this.localContent),
        availability: ContentAvailability.MISSING,
      });
    }
  }

  private onFarewell(raw: Uint8Array, messageType: number, reason: string): void {
    let farewell;
    try {
      farewell = decodeFarewell(raw);
    } catch (err) {
      this.reject(SyncRejectReason.MALFORMED, String(err), messageType);
      return;
    }

    // An invitation WITHDRAWN before it was accepted. There is no sessionId on
    // this side yet, so the plain comparison below would drop the packet as
    // "another session" and leave the invite card on screen for ever - and a
    // later join() would then send a SYNC_JOIN into a session that no longer
    // exists, stranding this device in FOLLOWING with nobody publishing.
    const invite = this.pendingInvite;
    if (invite && this.sessionId === null && farewell.sessionId === invite.sessionId) {
      this.pendingInvite = null;
      this.remoteContent = null;
      this.setState(WatchState.IDLE);
      this.events.emit('ended', { sessionId: invite.sessionId, reason: farewell.reason ?? reason });
      return;
    }

    if (farewell.sessionId !== this.sessionId) {
      this.reject(SyncRejectReason.WRONG_SESSION, 'farewell for another session', messageType);
      return;
    }
    this.finish(farewell.reason ?? reason);
  }

  private onCommand(messageType: number, raw: Uint8Array): void {
    let command: SyncCommand;
    try {
      command = decodeCommand(raw);
    } catch (err) {
      this.reject(SyncRejectReason.MALFORMED, String(err), messageType);
      return;
    }
    if (!this.isActive || this.sessionId === null) {
      this.reject(SyncRejectReason.NOT_IN_SESSION, 'command outside a session', messageType);
      return;
    }
    if (command.sessionId !== this.sessionId) {
      this.reject(SyncRejectReason.WRONG_SESSION, 'command for another session', messageType);
      return;
    }

    if (this.role === SyncRole.HOST) {
      // Anything a guest sends is a REQUEST. Note what is NOT read here: the
      // epoch, the instant and the playing flag, even if the peer sent them.
      // The host alone advances the epoch, which is what keeps the ordering
      // rule on the realtime channel sound.
      this.onGuestRequest(messageType, command);
      return;
    }

    if (!command.anchor) {
      this.reject(SyncRejectReason.MISSING_ANCHOR, 'host command without an anchor', messageType);
      return;
    }
    if (!this.acceptAnchor(command.anchor, messageType)) return;
    this.applyAnchor(command.anchor, false);
  }

  private onGuestRequest(messageType: number, command: SyncCommand): void {
    const now = this.clock.now();
    if (now - this.lastHonouredRequestAt < MIN_REQUEST_INTERVAL_MS) {
      this.throttledRequests++;
      return;
    }
    switch (messageType) {
      case MessageType.SYNC_PLAY:
        this.lastHonouredRequestAt = now;
        this.play();
        return;
      case MessageType.SYNC_PAUSE:
        this.lastHonouredRequestAt = now;
        this.pause();
        return;
      case MessageType.SYNC_SEEK:
        if (command.positionMs === undefined) {
          this.reject(SyncRejectReason.MALFORMED, 'seek request without a position', messageType);
          return;
        }
        this.lastHonouredRequestAt = now;
        this.seekTo(command.positionMs);
        return;
      case MessageType.SYNC_RATE:
        if (command.rate === undefined) {
          this.reject(SyncRejectReason.MALFORMED, 'rate request without a rate', messageType);
          return;
        }
        this.lastHonouredRequestAt = now;
        this.setRate(command.rate);
        return;
      default:
        // Only a host publishes heartbeats. One arriving from a guest means the
        // peer disagrees about who is hosting.
        this.reject(SyncRejectReason.UNEXPECTED_ROLE, 'heartbeat from a guest', messageType);
        return;
    }
  }

  /**
   * The last gate before a peer's anchor becomes this device's playback state.
   *
   * The codec has already bounded every field on its own. What is checked here
   * is what only the session knows: is this line newer than the one we hold, is
   * the position inside the film we are actually holding, and is the instant
   * reachable in our own frame of reference.
   */
  private acceptAnchor(anchor: PlaybackAnchor, messageType: number): boolean {
    if (!anchorSupersedes(anchor, this.anchor)) {
      this.reject(SyncRejectReason.STALE_ANCHOR, `epoch ${anchor.epoch} does not supersede`, messageType);
      return false;
    }
    const duration = this.localContent?.durationMs;
    if (duration !== undefined && anchor.positionMs > duration + SYNC_LIMITS.positionOverrunSlackMs) {
      this.reject(SyncRejectReason.ABSURD_POSITION, `${anchor.positionMs}ms past a ${duration}ms file`, messageType);
      return false;
    }
    const ahead = this.toLocalWall(anchor.hostWallClockMs) - this.clock.wallNow();
    if (ahead > SYNC_LIMITS.maxScheduleAheadMs) {
      // Either the clock estimate is nonsense or the peer is trying to park our
      // player on a frame for the next hour. Both end the same way.
      this.reject(SyncRejectReason.ABSURD_SCHEDULE, `start scheduled ${Math.round(ahead)}ms out`, messageType);
      return false;
    }
    return true;
  }

  // -- plumbing --------------------------------------------------------------

  private request(messageType: number, payload: { positionMs?: number; rate?: number } = {}): void {
    if (!this.sessionId) return;
    this.send(messageType, encodeCommandRequest(this.sessionId, payload));
  }

  private send(messageType: number, value: CborValue): void {
    try {
      this.session.sendReliable(messageType, value);
    } catch (err) {
      // A closed or reconnecting session is normal; the reliability layer keeps
      // what it accepted and this module must never throw out of a timer.
      this.log.debug('sync send failed', { messageType, err: String(err) });
    }
  }

  private sendRealtime(messageType: number, value: CborValue, coalesceKey: string): void {
    try {
      this.session.sendRealtime(messageType, encodeCbor(value), coalesceKey);
    } catch (err) {
      this.log.debug('sync realtime send failed', { messageType, err: String(err) });
    }
  }

  private reject(reason: SyncRejectReason, detail: string, messageType: number): void {
    this.rejectedPackets++;
    this.log.debug('sync packet dropped', { reason, detail, messageType });
    this.events.emit('rejected', { reason, detail, messageType });
  }

  private setState(next: WatchState): void {
    if (this.state === next) return;
    this.state = next;
    this.events.emit('stateChanged', { state: next, role: this.role });
  }

  /**
   * The peer session is gone for good.
   *
   * A link that merely DROPS is not this: PeerSession keeps the keys and the
   * queued messages and repairs it, and the watch party must survive that
   * untouched. `closed` means there will never be another anchor - and without
   * reacting to it the correction and heartbeat intervals would keep firing for
   * the life of the process, each one nudging a player against a line frozen at
   * the moment the peer vanished, while the UI sat in FOLLOWING with no way out.
   */
  private onPeerSessionClosed(reason: string): void {
    if (this.state === WatchState.IDLE || this.state === WatchState.ENDED) {
      this.cancelQuery();
      return;
    }
    this.finish(`peer session closed: ${reason}`);
  }

  private onQueryTimeout(queryId: string): void {
    this.queryTimer = undefined;
    if (this.pendingQueryId !== queryId) return;
    this.pendingQueryId = null;
    if (this.state === WatchState.MATCHING) this.setState(WatchState.IDLE);
    this.events.emit('contentQueryTimedOut', { queryId });
  }

  private finish(reason: string): void {
    const id = this.sessionId;
    const anchor = this.anchor;
    this.stopLoops();
    this.stopClockSync();
    this.cancelQuery();
    // Retire OUR OWN drift nudge. Ending the session does not stop the film -
    // but the sub-percent rate correction this module applied is ours, the
    // correction loop that would have retired it has just been stopped, and
    // leaving it on means the film plays 0.8% fast for the rest of the evening.
    // Back to the LINE's rate, not to 1: the speed the user chose is theirs.
    if (anchor && this.appliedRate !== anchor.rate) this.applyRate(anchor.rate);
    this.peerPresent = false;
    this.anchor = null;
    this.pendingInvite = null;
    this.lastHonouredRequestAt = Number.NEGATIVE_INFINITY;
    this.setState(WatchState.ENDED);
    this.role = null;
    this.sessionId = null;
    this.events.emit('ended', { sessionId: id, reason });
  }

  private startLoops(): void {
    this.stopLoops();
    this.correctionTimer = this.clock.setInterval(() => this.tick(), this.correctionIntervalMs);
    this.heartbeatTimer = this.clock.setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
  }

  private stopLoops(): void {
    if (this.correctionTimer !== undefined) {
      this.clock.clearInterval(this.correctionTimer);
      this.correctionTimer = undefined;
    }
    if (this.heartbeatTimer !== undefined) {
      this.clock.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.clearStartTimer();
  }

  private clearStartTimer(): void {
    if (this.startTimer !== undefined) {
      this.clock.clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
  }

  /**
   * Watch-together is the one feature that genuinely needs the two wall clocks
   * to agree to within tens of milliseconds, so it turns the probing on while a
   * session runs and off again afterwards - a probe costs a packet, and on a
   * 40 KB/s Bluetooth link packets are not free.
   */
  private startClockSync(): void {
    if (this.clockSyncRunning) return;
    this.clockSyncRunning = true;
    try {
      this.session.clockSync.startPeriodic(this.clockSyncIntervalMs);
    } catch (err) {
      this.log.debug('clock sync could not be started', { err: String(err) });
    }
  }

  private stopClockSync(): void {
    if (!this.clockSyncRunning) return;
    this.clockSyncRunning = false;
    try {
      this.session.clockSync.stopPeriodic();
    } catch {
      // Nothing to do: the session may already have disposed it.
    }
  }

  /** Now, expressed in the host's wall clock. Identity when we are the host. */
  private hostNow(): number {
    const now = this.clock.wallNow();
    return this.role === SyncRole.HOST ? now : this.session.clockSync.toPeerTime(now);
  }

  /** An instant in the host's wall clock, expressed in ours. */
  private toLocalWall(hostWallMs: number): number {
    return this.role === SyncRole.HOST ? hostWallMs : this.session.clockSync.toLocalTime(hostWallMs);
  }

  private readPosition(): number | null {
    let value: number;
    try {
      value = this.media.getPosition();
    } catch (err) {
      this.log.debug('media position unavailable', { err: String(err) });
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return value;
  }

  private seekIfOff(target: number, thresholdMs: number): void {
    const position = this.readPosition();
    if (position !== null && Math.abs(position - target) < thresholdMs) return;
    this.mediaSeek(target);
  }

  /**
   * play() and pause() are guarded exactly like seek() and setRate().
   *
   * A `react-native-video` ref whose component has unmounted throws, and both
   * of these run inside timer callbacks - beginPlayback from the scheduled-start
   * timeout, pause from the end-of-content publish in the correction interval.
   * An exception there does not just skip a frame: it escapes the timer with
   * nobody to catch it, and it abandons the rest of applyAnchor, so the anchor
   * would be adopted with no seek, no rate, no scheduled start and no
   * `anchorChanged` for the UI.
   */
  private mediaPlay(): void {
    try {
      this.media.play();
    } catch (err) {
      this.log.debug('media play failed', { err: String(err) });
    }
  }

  private mediaPause(): void {
    try {
      this.media.pause();
    } catch (err) {
      this.log.debug('media pause failed', { err: String(err) });
    }
  }

  private mediaSeek(positionMs: number): void {
    const clamped = this.clampPosition(positionMs);
    try {
      this.media.seek(clamped);
      this.seekCount++;
    } catch (err) {
      this.log.debug('media seek failed', { err: String(err) });
    }
  }

  private applyRate(rate: number): void {
    if (this.appliedRate === rate) return;
    try {
      this.media.setRate(rate);
      this.appliedRate = rate;
    } catch (err) {
      this.log.debug('media setRate failed', { err: String(err) });
    }
  }

  private clampPosition(positionMs: number): number {
    if (!Number.isFinite(positionMs) || positionMs < 0) return 0;
    const duration = this.localContent?.durationMs;
    if (duration !== undefined && positionMs > duration) return duration;
    return positionMs;
  }

  private nextEpoch(): number {
    // Wrapping is not reachable in a human lifetime of commands, but the field
    // is bounded on the wire, so the counter is bounded here too.
    this.epoch = this.epoch >= SYNC_LIMITS.maxEpoch ? 1 : this.epoch + 1;
    return this.epoch;
  }

  private resolve(content: ContentIdentity): ContentDescriptor | null {
    if (this.resolveContent) {
      try {
        const found = this.resolveContent(content);
        if (found) return found;
      } catch (err) {
        this.log.debug('resolveContent threw', { err: String(err) });
      }
    }
    return this.localContent;
  }

  private requireContent(): ContentDescriptor {
    const local = this.localContent;
    if (!local) throw new Error('WatchTogetherSession: call setLocalContent() first');
    return local;
  }

  /**
   * Starting a session before the handshake has finished would look like it
   * worked - `send` swallows the failure so a timer can never throw - and then
   * silently do nothing. A user-initiated action deserves a real error.
   */
  private requireLiveSession(): void {
    if (!this.session.isSecure) {
      throw new Error('WatchTogetherSession: the peer session is not authenticated yet');
    }
  }

  private newId(): string {
    return toHex(this.random.randomBytes(8));
  }
}

/**
 * Is our local file plausibly another copy of what the peer asked about?
 *
 * This gates whether our OWN descriptor - which carries the file's title - goes
 * back with a non-matching answer. Sending it is genuinely useful for a near
 * miss ("same film, different encode"), because it lets the asker explain why
 * rather than just say no. Sending it for an unrelated file is not: a peer that
 * asked about one film has not asked what else is on this phone, and the
 * fallback in `resolve()` means the file we answer with is simply whatever this
 * device happens to have open.
 */
function isPlausibleAlternative(local: ContentIdentity, asked: ContentIdentity): boolean {
  if (local.byteLength === asked.byteLength) return true;
  return Math.abs(local.durationMs - asked.durationMs) <= SYNC_LIMITS.durationToleranceMs;
}

/** Strip the device-local handle: only the comparable part is ever sent. */
export function identityOf(content: ContentDescriptor): ContentIdentity {
  return {
    byteLength: content.byteLength,
    durationMs: content.durationMs,
    sampledHash: content.sampledHash,
    ...(content.title !== undefined ? { title: content.title } : {}),
    ...(content.mimeType !== undefined ? { mimeType: content.mimeType } : {}),
  };
}
