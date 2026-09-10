import { useEffect, useRef, useState } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import type { CborValue } from '@airlink/core';
import type { FrameFeed } from './contract.js';
import { lerpAirHockey, lerpPongState, poolLerp } from './gameTypes.js';

/**
 * The realtime half of the Play screens.
 *
 * Three games run on a clock rather than on turns, and all three are drawn the
 * same way:
 *
 *   THE NUMBERS NEVER GO THROUGH REACT. `useGameRoom` runs one animation frame
 *   loop and hands each frame's state to `FrameFeed` subscribers. A subscriber
 *   here projects that state into a plain geometry object and writes it into a
 *   single Reanimated shared value. Skia reads that shared value on the UI
 *   thread, so the puck keeps moving smoothly through a React re-render, a
 *   database write or a burst of incoming packets.
 *
 *   ONE SHARED VALUE, NOT TWENTY. Skia's `select()` binds one key of a shared
 *   value to one prop, so a whole table's worth of geometry costs one
 *   cross-thread write per frame rather than one per coordinate.
 *
 *   THE SCORE IS DIFFERENT. A goal is a discrete event that changes words on
 *   the screen, so `useFrameSignal` watches the frames for a small comparable
 *   value and re-renders only when it actually changes.
 *
 * The simulation itself stays on the JavaScript thread. It has to: the
 * authoritative tick is `GameSession.tick`, which runs the game's own reducer
 * from @airlink/games - ordinary modules with closures, a seeded PRNG and
 * imports - and a Reanimated worklet can only call functions that were compiled
 * into one. Rendering is what a busy JS thread ruins, and rendering is exactly
 * what the shared values move off it.
 */

/** `SnapshotInterpolator` blends two host snapshots; each game says how. */
type UnknownLerp = (from: unknown, to: unknown, t: number) => unknown;

/**
 * The blend function for a game, for the guest's snapshot interpolator.
 *
 * Each realtime game exports its own, and each is careful about what must NOT
 * be blended - a goal, a serve, a potted ball. A game with no lerp of its own
 * simply snaps to the newest snapshot, which is the correct behaviour for a
 * turn-based game that only ever resyncs after a reconnect.
 */
export function lerpFor(gameId: string): UnknownLerp {
  switch (gameId) {
    case 'pong':
      return (from, to, t) => lerpPongState(from as never, to as never, t);
    case 'air-hockey':
      return (from, to, t) => lerpAirHockey(from as never, to as never, t);
    case 'pool':
      return (from, to, t) => poolLerp(from as never, to as never, t);
    default:
      return (_from, to) => to;
  }
}

/**
 * Project every frame into a geometry object on a shared value.
 *
 * `project` must be cheap and must return a flat object of numbers: it runs
 * sixty times a second, and Skia binds its keys straight to drawing props.
 */
export function useSkiaGeometry<TGeometry extends object>(
  frames: FrameFeed<unknown> | null,
  project: (state: unknown) => TGeometry | null,
  initial: TGeometry,
): SharedValue<TGeometry> {
  const geometry = useSharedValue<TGeometry>(initial);
  // Kept in a ref so a new inline `project` on every render does not tear the
  // subscription down and build it up again sixty times a second.
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    if (!frames) return;
    const first = projectRef.current(frames.current());
    if (first) geometry.value = first;
    return frames.subscribe((state) => {
      const next = projectRef.current(state);
      if (next) geometry.value = next;
    });
  }, [frames, geometry]);

  return geometry;
}

/**
 * Watch the frames for something discrete - a score, a phase, whose shot it is -
 * and re-render only when it changes.
 *
 * `project` must return something comparable with `===`, which in practice
 * means a number or a short string. Returning an object would re-render on
 * every frame and defeat the entire point of the shared value above.
 */
export function useFrameSignal<TSignal extends string | number | boolean>(
  frames: FrameFeed<unknown> | null,
  project: (state: unknown) => TSignal,
  initial: TSignal,
): TSignal {
  const [signal, setSignal] = useState<TSignal>(initial);
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    if (!frames) return;
    let last = projectRef.current(frames.current());
    setSignal(last);
    return frames.subscribe((state) => {
      const next = projectRef.current(state);
      if (next === last) return;
      last = next;
      setSignal(next);
    });
  }, [frames]);

  return signal;
}

/**
 * A dispatch that will not flood the link.
 *
 * A finger dragging across a table produces a touch event per frame, and every
 * one of them is a reliable, ordered message over a link that may be Bluetooth.
 * Realtime games only ever need the LATEST input, so this drops everything that
 * arrives inside `intervalMs` and sends the last value on the next tick - and
 * always sends a value that differs from the last one sent, so the final
 * position of a finger is never the one that got dropped.
 */
export function throttledInput<TPayload extends CborValue>(
  send: (payload: TPayload) => void,
  intervalMs: number,
): { push(payload: TPayload): void; stop(): void } {
  let pending: TPayload | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    if (pending === null) return;
    const payload = pending;
    pending = null;
    send(payload);
    // Keep the window open while input is still arriving, so a continuous drag
    // sends at a steady rate rather than in bursts.
    timer = setTimeout(flush, intervalMs);
  };

  return {
    push(payload: TPayload): void {
      pending = payload;
      if (timer === null) flush();
    },
    stop(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
