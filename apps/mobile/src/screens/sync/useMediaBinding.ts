import { useCallback, useMemo, useRef, useState } from 'react';
import type { MediaController } from '@airlink/core';
import type { VideoRef } from 'react-native-video';

/**
 * The bridge between `react-native-video` and the protocol's `MediaController`.
 *
 * Three impedance mismatches are resolved here and nowhere else.
 *
 * SECONDS AND MILLISECONDS. The player works in seconds and the protocol works
 * in milliseconds. Every conversion happens at this boundary, so nothing above
 * or below it has to remember which unit it is in.
 *
 * DECLARATIVE AND IMPERATIVE. `MediaController` is imperative - play(), pause(),
 * setRate() - while the player takes `paused` and `rate` as props. So the
 * controller writes to React state and the caller feeds that state back to
 * `<Video>`. The controller object itself is created once and never replaced,
 * which matters: `WatchTogetherSession` holds it for its whole life and calls it
 * from timer callbacks.
 *
 * A LINK THAT IS NOT THERE. See `setHold` below.
 *
 * The position it reports is the JITTERY reading the whole anchor design exists
 * to work around - tens of milliseconds of noise on both platforms. It is read
 * only to measure this device's own drift from the shared line, and is never
 * published to the peer.
 */
export interface MediaBinding {
  /** Handed to `WatchTogetherSession`. Stable for the life of the screen. */
  readonly controller: MediaController;
  readonly videoRef: React.RefObject<VideoRef | null>;
  /** Feed straight to `<Video paused>`. Already accounts for the hold. */
  readonly paused: boolean;
  /** Feed to `<Video rate>`. Carries the sub-percent drift nudges. */
  readonly rate: number;
  /** True while the picture is frozen waiting for the peer to come back. */
  readonly held: boolean;
  /**
   * Freeze the picture, and stop the protocol from moving it.
   *
   * Called when the two phones lose sight of each other mid-film. The anchor is
   * a LINE, so it keeps extrapolating forward from the last heartbeat even
   * though nothing is refreshing it - and the correction loop, seeing the
   * paused player fall further behind that line every half second, would seek a
   * little further forward each tick. The result is the film advancing as a
   * silent slideshow towards a position nobody is publishing any more.
   *
   * So the hold suppresses seeks as well as playback. When the peer is back,
   * releasing it lets one correction put this device on the line in a single
   * jump - which is what "Catching up…" on screen is describing.
   */
  setHold(active: boolean): void;
  /** Latest position reading, in milliseconds. For the scrubber's fallback only. */
  positionMs(): number;
  /** Call from onProgress / onSeek / onLoad. Seconds, as the player reports them. */
  notePositionSeconds(seconds: number): void;
}

export function useMediaBinding(): MediaBinding {
  const videoRef = useRef<VideoRef | null>(null);
  const positionRef = useRef(0);
  const [paused, setPaused] = useState(true);
  const [rate, setRate] = useState(1);
  const [held, setHeld] = useState(false);
  // The controller is built once and called from timers, so it reads the hold
  // through a ref rather than closing over the render's value.
  const heldRef = useRef(false);

  const notePositionSeconds = useCallback((seconds: number): void => {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    positionRef.current = seconds * 1000;
  }, []);

  const positionMs = useCallback((): number => positionRef.current, []);

  const setHold = useCallback((active: boolean): void => {
    heldRef.current = active;
    setHeld(active);
  }, []);

  const controller = useMemo<MediaController>(
    () => ({
      play: () => setPaused(false),
      pause: () => setPaused(true),
      seek: (positionMillis: number) => {
        if (heldRef.current) return;
        // Update the cached reading BEFORE the seek lands. The correction loop
        // runs every 500 ms and the player will not report its new position for
        // a frame or two; without this it would measure the drift it has just
        // corrected and seek a second time, which is visible as a stutter.
        positionRef.current = positionMillis;
        videoRef.current?.seek(positionMillis / 1000);
      },
      setRate: (next: number) => setRate(next),
      getPosition: () => positionRef.current,
    }),
    [],
  );

  return {
    controller,
    videoRef,
    // The protocol's intent, and this device's own reason to stop, are the same
    // prop as far as the player is concerned.
    paused: paused || held,
    rate,
    held,
    setHold,
    positionMs,
    notePositionSeconds,
  };
}
