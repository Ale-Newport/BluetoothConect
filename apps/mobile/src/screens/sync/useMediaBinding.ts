import { useCallback, useMemo, useRef, useState } from 'react';
import type { MediaController } from '@airlink/core';
import type { VideoRef } from 'react-native-video';

/**
 * The bridge between `react-native-video` and the protocol's `MediaController`.
 *
 * Two impedance mismatches are resolved here and nowhere else.
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
 * The position it reports is the JITTERY reading the whole anchor design exists
 * to work around - tens of milliseconds of noise on both platforms. It is read
 * only to measure this device's own drift from the shared line, and is never
 * published to the peer.
 */
export interface MediaBinding {
  /** Handed to `WatchTogetherSession`. Stable for the life of the screen. */
  readonly controller: MediaController;
  readonly videoRef: React.RefObject<VideoRef | null>;
  /** Feed to `<Video paused>`, combined with any local hold. */
  readonly paused: boolean;
  /** Feed to `<Video rate>`. Carries the sub-percent drift nudges. */
  readonly rate: number;
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

  const notePositionSeconds = useCallback((seconds: number): void => {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    positionRef.current = seconds * 1000;
  }, []);

  const positionMs = useCallback((): number => positionRef.current, []);

  const controller = useMemo<MediaController>(
    () => ({
      play: () => setPaused(false),
      pause: () => setPaused(true),
      seek: (positionMillis: number) => {
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

  return { controller, videoRef, paused, rate, positionMs, notePositionSeconds };
}
