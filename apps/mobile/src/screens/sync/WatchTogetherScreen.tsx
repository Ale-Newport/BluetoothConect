import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StatusBar,
  StyleSheet,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Video, {
  SelectedTrackType,
  type OnLoadData,
  type OnProgressData,
  type OnSeekData,
  type SelectedTrack,
} from 'react-native-video';
import {
  ContentMatch,
  SyncRole,
  WatchState,
  compareContent,
  type ContentDescriptor,
  type ContentIdentity,
} from '@airlink/core';
import { Label, haptic, useTheme, type StatusTone } from '../../ui/index.js';
import { selectPeer, useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { PlayerOverlay, type SubtitleOption } from './PlayerOverlay.js';
import { SetupPanel, type SetupHandlers, type SetupStage } from './SetupPanel.js';
import { PLAYBACK_SPEEDS, cinema } from './playerTheme.js';
import { describePickedVideo, pickVideo, type PickedVideo } from './contentSource.js';
import { syncStrings, shared } from './syncStrings.js';
import { useMediaBinding } from './useMediaBinding.js';
import { SetupOutcome, useWatchTogether } from './useWatchTogether.js';

/**
 * Watch together.
 *
 * Two phones, one film, no server and not one byte of video on the link. The
 * flow is: pick a file, ask whether the other person holds the same one, then
 * play in step.
 *
 * THE PART THAT MATTERS - AND THE PLATFORM LIMIT BEHIND IT
 *
 * `react-native-video` reports playback position with tens of milliseconds of
 * jitter on both platforms: AVPlayer's periodic observer reports the last
 * rendered frame, ExoPlayer quantises to the renderer's buffer. So this screen
 * NEVER polls the player and sends what it reads - that would synchronise the
 * two phones to the noise instead of to the film, and the correction would feed
 * on itself.
 *
 * Instead the host publishes an ANCHOR - (position, host clock, rate, playing) -
 * once per command, and every device computes its own target from it and
 * corrects with `computeDriftCorrection`: below 50 ms do nothing, below 300 ms
 * nudge the playback RATE by a fraction of a percent nobody can hear, and only
 * past that spend a visible seek. All of that lives in @airlink/core; what this
 * file does is hand the protocol a `MediaController` (useMediaBinding) and put
 * the result on screen.
 *
 * The one position this screen does read is the anchor's own projection, four
 * times a second, to draw the scrubber. It is computed locally from the line and
 * is never sent anywhere - which is why the scrubber glides instead of twitching.
 *
 * ORIENTATION. The player is full-bleed and follows the window. It does not
 * force landscape: this app declares itself portrait-only on iPhone, and the
 * usual workaround - rotating the whole surface with a transform - breaks the
 * scrubber, because a pan gesture's deltas arrive in SCREEN space and would no
 * longer lie along the seek bar's axis. Real landscape needs the orientation
 * added to Info.plist and a native lock; see the report.
 */

/** Matches the header height the rest of the app gets from the navigator. */
const TOP_BAR_HEIGHT = 44;
/** How often the scrubber re-reads the anchor's projection. */
const POSITION_TICK_MS = 250;
/** How long the controls stay up after the last touch, while playing. */
const CONTROLS_LINGER_MS = 3_500;
/**
 * How long to wait for the decoder to say anything about a picked file.
 *
 * A container the device cannot open sometimes produces neither `onLoad` nor
 * `onError` on either platform. Without this the "Reading the video…" state
 * would have no end, which is the one thing no state in this app may do.
 */
const LOAD_TIMEOUT_MS = 20_000;

export function WatchTogetherScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height: windowHeight } = useWindowDimensions();
  const route = useRoute<RouteProp<RootStackParams, 'WatchTogether'>>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const peerKey = route.params.peerKey;

  const peer = useAppStore(selectPeer(peerKey));
  const peerName = peer?.displayName ?? syncStrings.aFriend;

  const media = useMediaBinding();
  const api = useWatchTogether(peerKey, media.controller);

  // -- the chosen file -------------------------------------------------------
  const [video, setVideo] = useState<PickedVideo | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [descriptor, setDescriptor] = useState<ContentDescriptor | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  /** Bumped by [Check again], so the ask-once guard lets one more question out. */
  const [askNonce, setAskNonce] = useState(0);

  // -- the player ------------------------------------------------------------
  const [subtitles, setSubtitles] = useState<readonly SubtitleOption[]>([]);
  const [selectedSubtitle, setSelectedSubtitle] = useState<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [linePositionMs, setLinePositionMs] = useState(0);
  /** Where the finger is, while it is down. Overrides the line for drawing only. */
  const [scrubMs, setScrubMs] = useState<number | null>(null);

  const inPlayer = api.watchState === WatchState.HOSTING || api.watchState === WatchState.FOLLOWING;
  /**
   * The link is down mid-session.
   *
   * Hold the picture HERE, locally, and tell the user - never send a pause. The
   * peer cannot hear us, and a pause command that lands minutes later would
   * rewind them. Drifting apart in silence is the failure this avoids.
   */
  const linkHold = inPlayer && !api.linkUp;
  const controlsEnabled = inPlayer && api.linkUp;

  const setHold = media.setHold;
  useEffect(() => {
    setHold(linkHold);
  }, [linkHold, setHold]);

  const everPlayed = useRef(false);
  useEffect(() => {
    if (inPlayer) everPlayed.current = true;
  }, [inPlayer]);

  // ---------------------------------------------------------------------------
  // Picking a file, and turning it into something the two phones can compare
  // ---------------------------------------------------------------------------

  const resetFile = useCallback((): void => {
    setVideo(null);
    setDurationMs(0);
    setDescriptor(null);
    setReadFailed(false);
    setSubtitles([]);
    setSelectedSubtitle(null);
    setActionFailed(false);
  }, []);

  const choose = useCallback((): void => {
    if (picking) return;
    setPicking(true);
    void (async () => {
      try {
        const picked = await pickVideo();
        // A cancelled picker is not an error and must leave the screen exactly
        // as it was.
        if (picked) {
          resetFile();
          setVideo(picked);
          api.clearOutcome();
          setAskNonce((n) => n + 1);
        }
      } catch {
        resetFile();
        setReadFailed(true);
      } finally {
        setPicking(false);
      }
    })();
    // `api` is rebuilt every render; only its clearOutcome is used here and it
    // is a plain setter, so re-creating this callback would buy nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, resetFile]);

  const handleLoad = (event: OnLoadData): void => {
    media.notePositionSeconds(event.currentTime);
    const ms = Math.round(event.duration * 1000);
    if (!Number.isFinite(ms) || ms <= 0) {
      // Nothing can be matched or seeked without a duration, so this file is of
      // no use to us even though the decoder opened it.
      setReadFailed(true);
      return;
    }
    setDurationMs(ms);
    setSubtitles(
      event.textTracks.map((track, position) => ({
        index: track.index,
        label: track.title ?? track.language ?? syncStrings.subtitleTrack(position + 1),
      })),
    );
  };

  // The decoder is the only thing on this device that knows how long the film
  // is, and the duration is part of what the two phones compare - so the
  // descriptor cannot be built until the player has opened the file.
  useEffect(() => {
    if (!video || durationMs <= 0 || descriptor || readFailed) return;
    let cancelled = false;
    void describePickedVideo(video, durationMs)
      .then((built) => {
        if (!cancelled) setDescriptor(built);
      })
      .catch(() => {
        if (!cancelled) setReadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [video, durationMs, descriptor, readFailed]);

  useEffect(() => {
    if (!video || durationMs > 0 || readFailed) return;
    const timer = setTimeout(() => setReadFailed(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [video, durationMs, readFailed]);

  // ---------------------------------------------------------------------------
  // Talking to the peer
  // ---------------------------------------------------------------------------

  const session = api.session;

  useEffect(() => {
    if (session && descriptor) session.setLocalContent(descriptor);
  }, [session, descriptor]);

  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session || !descriptor || !api.linkUp) return;
    if (api.outcome !== null || api.invite !== null || api.finished) return;
    // Ask only from a standing start. MATCHING means the question is already
    // out, READY means it was answered, and the rest mean a session is running.
    // ENDED counts as a standing start: the last film is over and this is a new
    // one, which is exactly what [Watch something else] leaves behind.
    if (api.watchState !== WatchState.IDLE && api.watchState !== WatchState.ENDED) return;
    const key = `${descriptor.contentId}:${descriptor.durationMs}:${askNonce}`;
    if (askedRef.current === key) return;
    askedRef.current = key;
    try {
      session.queryPeerContent();
    } catch {
      // The handshake has not finished. Let the next connection change retry.
      askedRef.current = null;
    }
  }, [session, descriptor, api.linkUp, api.outcome, api.invite, api.finished, api.watchState, askNonce]);

  /**
   * An invitation the peer withdrew before it was ever accepted also arrives as
   * "ended". Nothing was watched, so there is nothing to say goodbye to.
   */
  useEffect(() => {
    if (api.finished && !everPlayed.current) api.clearFinished();
  });

  useEffect(() => {
    if (api.peerJoined) haptic('success');
  }, [api.peerJoined]);

  /**
   * A decoder that gives up in the middle of the film.
   *
   * Rare, but it has to end the session rather than leave the peer following a
   * line this device is no longer able to play. Nothing else in the app would
   * notice: the protocol only ever hears about the player through the
   * controller, and a controller whose picture has stopped still answers.
   */
  useEffect(() => {
    if (readFailed && inPlayer) session?.end('playback failed');
  }, [readFailed, inPlayer, session]);

  // ---------------------------------------------------------------------------
  // Where the film is
  // ---------------------------------------------------------------------------

  /**
   * The scrubber follows the ANCHOR's projection, not the player's own reading.
   *
   * The line is a straight function of time, so it advances smoothly; the
   * decoder's reading is the jittery one, and putting it on screen would make
   * the thumb twitch several times a second even when the two phones are
   * perfectly in step. This value is computed locally and is never sent.
   */
  useEffect(() => {
    if (!inPlayer || !session) return;
    const tick = (): void => setLinePositionMs(session.targetPositionMs ?? media.positionMs());
    tick();
    const timer = setInterval(tick, POSITION_TICK_MS);
    return () => clearInterval(timer);
  }, [inPlayer, session, media]);

  const shownPositionMs = scrubMs ?? linePositionMs;
  const baseRate = session?.currentAnchor?.rate ?? 1;

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepControlsUp = useCallback((): void => {
    setControlsVisible(true);
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_LINGER_MS);
  }, []);

  // Anything that is not running keeps its controls: a still picture with no
  // visible way to start it again is just a black rectangle.
  useEffect(() => {
    if (!inPlayer) return;
    if (!api.anchorPlaying || linkHold) {
      if (hideTimer.current !== undefined) clearTimeout(hideTimer.current);
      setControlsVisible(true);
      return;
    }
    keepControlsUp();
    return () => {
      if (hideTimer.current !== undefined) clearTimeout(hideTimer.current);
    };
  }, [inPlayer, api.anchorPlaying, linkHold, keepControlsUp]);

  const command = (run: (live: NonNullable<typeof session>) => void): void => {
    if (!session || !controlsEnabled) return;
    keepControlsUp();
    try {
      run(session);
    } catch {
      // A busy or reconnecting link does NOT come out here - the session
      // swallows send failures and the reliability layer keeps the message. The
      // only way to reach this is a session that ended between the render and
      // the tap, and the state change that says so is already on its way.
    }
  };

  // ---------------------------------------------------------------------------
  // The flow's decisions
  // ---------------------------------------------------------------------------

  const handlers: SetupHandlers = {
    onChoose: choose,
    onStart: () => {
      if (!session) return;
      setActionFailed(false);
      try {
        session.create({ startPositionMs: 0 });
        haptic('impactMedium');
      } catch {
        setActionFailed(true);
      }
    },
    onCheckAgain: () => {
      api.clearOutcome();
      setAskNonce((n) => n + 1);
    },
    // The share flow owns files. It has no parameter for a file chosen
    // elsewhere, so it asks again on its own screen - which the button says.
    onSendFile: () => navigation.navigate('ShareCompose', { peerKey }),
    onJoin: () => {
      if (!session) return;
      setActionFailed(false);
      try {
        session.join();
        api.clearInvite();
        haptic('impactMedium');
      } catch {
        setActionFailed(true);
      }
    },
    onDecline: () => {
      session?.decline();
      api.clearInvite();
    },
    onWatchSomethingElse: () => {
      api.clearFinished();
      api.clearOutcome();
      askedRef.current = null;
      everPlayed.current = false;
      resetFile();
    },
    onDone: () => navigation.goBack(),
  };

  const stage = currentStage({
    finished: api.finished,
    invite: api.invite,
    descriptor,
    video,
    readFailed,
    outcome: api.outcome,
    linkUp: api.linkUp && session !== null,
    watchState: api.watchState,
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const status = playerStatus({
    linkHold,
    correcting: api.correcting,
    waitingForPeer: api.role === SyncRole.HOST && !api.peerJoined,
    peerName,
  });

  const previewHeight = Math.round(((width - theme.spacing.lg * 2) * 9) / 16);
  /**
   * Where the picture lives: a 16:9 window while you are setting up, the whole
   * screen once you are watching.
   *
   * Every key is present in both shapes on purpose. The two are the SAME view
   * with a different frame, so what changes is a style diff and not a remount -
   * and a style that dropped a key between the two would leave the old value
   * behind.
   */
  const surface: ViewStyle = {
    position: 'absolute',
    top: inPlayer ? 0 : insets.top + TOP_BAR_HEIGHT + theme.spacing.sm,
    left: inPlayer ? 0 : theme.spacing.lg,
    right: inPlayer ? 0 : theme.spacing.lg,
    height: inPlayer ? windowHeight : previewHeight,
    borderRadius: inPlayer ? 0 : theme.radius.lg,
    overflow: 'hidden',
    backgroundColor: cinema.background,
  };

  const selectedTextTrack: SelectedTrack =
    selectedSubtitle === null
      ? { type: SelectedTrackType.DISABLED }
      : { type: SelectedTrackType.INDEX, value: selectedSubtitle };

  return (
    <View style={{ flex: 1, backgroundColor: inPlayer ? cinema.background : theme.colors.background }}>
      <StatusBar
        hidden={inPlayer}
        barStyle={inPlayer || theme.scheme === 'dark' ? 'light-content' : 'dark-content'}
      />

      {/*
        One player for the life of the chosen file. Only its FRAME moves between
        the setup preview and full screen - re-parenting it would remount the
        decoder, drop the ref the protocol seeks through, and re-read the file
        from disk at the exact moment two people are trying to start together.
      */}
      {video ? (
        <View style={surface}>
          <Video
            ref={media.videoRef}
            source={{ uri: video.uri }}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
            controls={false}
            paused={media.paused}
            rate={media.rate}
            selectedTextTrack={selectedTextTrack}
            progressUpdateInterval={POSITION_TICK_MS}
            playInBackground={false}
            playWhenInactive={false}
            preventsDisplaySleepDuringVideoPlayback
            ignoreSilentSwitch="ignore"
            onLoad={handleLoad}
            onProgress={(event: OnProgressData) => media.notePositionSeconds(event.currentTime)}
            onSeek={(event: OnSeekData) => media.notePositionSeconds(event.currentTime)}
            onError={() => setReadFailed(true)}
            accessibilityLabel={video.title || syncStrings.untitled}
          />
        </View>
      ) : null}

      {inPlayer ? (
        <PlayerOverlay
          title={video?.title || syncStrings.untitled}
          statusTone={status.tone}
          statusText={status.text}
          statusDetail={status.detail}
          visible={controlsVisible}
          playing={api.anchorPlaying}
          positionMs={shownPositionMs}
          durationMs={durationMs}
          controlsEnabled={controlsEnabled}
          disabledReason={controlsEnabled ? undefined : shared.connection.reconnecting}
          speed={baseRate}
          subtitles={subtitles}
          selectedSubtitle={selectedSubtitle}
          insetTop={insets.top}
          insetBottom={insets.bottom}
          onToggleControls={() => (controlsVisible ? setControlsVisible(false) : keepControlsUp())}
          onTogglePlay={() => command((live) => (api.anchorPlaying ? live.pause() : live.play()))}
          onSkip={(delta) =>
            command((live) => live.seekTo(clamp(shownPositionMs + delta, durationMs)))
          }
          onScrubStart={() => {
            keepControlsUp();
            setScrubMs(shownPositionMs);
          }}
          onScrubMove={(ms) => setScrubMs(clamp(ms, durationMs))}
          onScrubEnd={(ms) => {
            setScrubMs(null);
            command((live) => live.seekTo(clamp(ms, durationMs)));
          }}
          onCycleSpeed={() => command((live) => live.setRate(nextSpeed(baseRate)))}
          onCycleSubtitles={() => {
            keepControlsUp();
            setSelectedSubtitle(nextSubtitle(subtitles, selectedSubtitle));
          }}
          onLeave={() => {
            // Say goodbye rather than vanish: the peer's player would otherwise
            // keep being corrected against a line nobody is publishing any
            // more. The farewell lands as `ended`, which is what puts the
            // "Session over" card up rather than dropping the user out of the
            // screen with no explanation.
            session?.end('left');
          }}
        />
      ) : (
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <View
            style={{
              height: TOP_BAR_HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: theme.spacing.sm,
              gap: theme.spacing.xs,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={shared.common.back}
              onPress={() => navigation.goBack()}
              style={({ pressed }) => [
                {
                  width: TOP_BAR_HEIGHT,
                  height: TOP_BAR_HEIGHT,
                  alignItems: 'center',
                  justifyContent: 'center',
                },
                pressed ? { opacity: 0.6 } : null,
              ]}
            >
              <Label variant="title" tone="accent">
                ‹
              </Label>
            </Pressable>
            <View style={{ flex: 1 }}>
              <Label variant="headline" numberOfLines={1}>
                {shared.sync.watchTogether}
              </Label>
              <Label variant="caption" tone="tertiary" numberOfLines={1}>
                {peerName}
              </Label>
            </View>
          </View>

          {/* The preview shows through this gap; it is drawn behind the chrome. */}
          {video ? <View style={{ height: theme.spacing.sm + previewHeight }} /> : null}

          <View style={{ flex: 1, justifyContent: video ? 'flex-start' : 'center', padding: theme.spacing.lg }}>
            <SetupPanel
              stage={stage}
              peerName={peerName}
              peerId={peer?.peerId ?? null}
              peerAvatar={peer?.avatarEmoji ?? null}
              videoTitle={video?.title ?? ''}
              durationMs={durationMs}
              picking={picking}
              actionFailed={actionFailed}
              handlers={handlers}
            />
          </View>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function clamp(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || positionMs < 0) return 0;
  if (durationMs > 0 && positionMs > durationMs) return durationMs;
  return positionMs;
}

function nextSpeed(current: number): number {
  const index = PLAYBACK_SPEEDS.findIndex((speed) => Math.abs(speed - current) < 0.001);
  return PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length] ?? 1;
}

/** Off → first track → … → last track → off. */
function nextSubtitle(tracks: readonly SubtitleOption[], selected: number | null): number | null {
  if (tracks.length === 0) return null;
  if (selected === null) return tracks[0]?.index ?? null;
  const position = tracks.findIndex((track) => track.index === selected);
  const next = tracks[position + 1];
  return next ? next.index : null;
}

/**
 * What the small pill in the corner says.
 *
 * "Catching up…" is deliberately the only word for a correction, whatever the
 * protocol actually did - a rate nudge of half a percent and a seek are the same
 * fact to the person watching, and neither is a problem.
 */
function playerStatus(input: {
  linkHold: boolean;
  correcting: boolean;
  waitingForPeer: boolean;
  peerName: string;
}): { tone: StatusTone; text: string; detail: string | undefined } {
  if (input.linkHold) {
    return {
      tone: 'connecting',
      text: shared.connection.reconnecting,
      detail: syncStrings.holdingForLink,
    };
  }
  if (input.waitingForPeer) {
    return {
      tone: 'connecting',
      text: shared.sync.waitingToStart,
      detail: syncStrings.waitingDetail(input.peerName),
    };
  }
  if (input.correcting) {
    return { tone: 'connecting', text: shared.sync.catchingUp, detail: undefined };
  }
  return { tone: 'connected', text: shared.sync.inSync, detail: undefined };
}

function currentStage(input: {
  finished: boolean;
  invite: { readonly content: ContentIdentity } | null;
  descriptor: ContentDescriptor | null;
  video: PickedVideo | null;
  readFailed: boolean;
  outcome: SetupOutcome | null;
  linkUp: boolean;
  watchState: WatchState;
}): SetupStage {
  // Order is priority. Somebody asking you a question comes first, then
  // anything broken, then anything over - and only after all three does the
  // ordinary "where are we in the flow" question get asked.
  if (input.invite) {
    return {
      kind: 'invited',
      haveFile: input.descriptor !== null,
      matches:
        input.descriptor !== null &&
        compareContent(input.descriptor, input.invite.content) === ContentMatch.MATCH,
    };
  }
  if (input.readFailed) return { kind: 'unreadable' };
  if (input.finished) return { kind: 'ended' };
  if (!input.video) return { kind: 'empty' };
  if (!input.descriptor) return { kind: 'preparing' };
  if (input.outcome === SetupOutcome.PEER_MISSING) return { kind: 'peerMissing' };
  if (input.outcome === SetupOutcome.PEER_MISMATCH) return { kind: 'peerMismatch' };
  if (input.outcome === SetupOutcome.NO_ANSWER) return { kind: 'noAnswer' };
  if (!input.linkUp) return { kind: 'offline' };
  if (input.watchState === WatchState.READY) return { kind: 'ready' };
  // IDLE (or ENDED, after a previous film) means the query effect is about to
  // run: the question is on its way, and saying so is more honest than a blank
  // panel for one frame.
  return { kind: 'checking' };
}
