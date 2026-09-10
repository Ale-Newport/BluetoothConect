import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import { useTheme } from '../../ui/index.js';
import { cinema, formatClock } from './playerTheme.js';
import { syncStrings } from './syncStrings.js';

/**
 * The seek bar.
 *
 * Built by hand because there is no slider in this project - and because a
 * player's scrubber wants behaviour a generic slider does not have: the film
 * keeps running under your finger, and the seek is only committed on release, so
 * dragging across an hour of footage costs one seek rather than two hundred.
 *
 * On a guest device the release does not seek anything locally: it asks the
 * host, who publishes the anchor both players then land on. Same gesture, same
 * code, one authority.
 */

/** Comfortably past the 44pt minimum, because this one is dragged, not tapped. */
const TOUCH_HEIGHT = 44;
const TRACK_HEIGHT = 4;
const KNOB = 14;
const KNOB_DRAGGING = 20;
/** How far the accessibility increment/decrement actions move. */
const STEP_MS = 10_000;

interface ScrubberProps {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly enabled: boolean;
  onScrubStart(): void;
  onScrubMove(positionMs: number): void;
  onScrubEnd(positionMs: number): void;
}

export function Scrubber({
  positionMs,
  durationMs,
  enabled,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: ScrubberProps): React.JSX.Element {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);

  // The gesture handlers are created once and must never close over a stale
  // duration or width, so the render's values are mirrored into a ref.
  const latest = useRef({ width, durationMs, enabled, onScrubStart, onScrubMove, onScrubEnd });
  useEffect(() => {
    latest.current = { width, durationMs, enabled, onScrubStart, onScrubMove, onScrubEnd };
  });

  const grantX = useRef(0);

  const responder = useMemo(() => {
    const msAt = (x: number): number => {
      const { width: w, durationMs: d } = latest.current;
      if (w <= 0 || d <= 0) return 0;
      const fraction = Math.min(1, Math.max(0, x / w));
      return fraction * d;
    };
    const usable = (): boolean => latest.current.enabled && latest.current.width > 0 && latest.current.durationMs > 0;

    return PanResponder.create({
      onStartShouldSetPanResponder: usable,
      onMoveShouldSetPanResponder: usable,
      onPanResponderGrant: (event: GestureResponderEvent) => {
        grantX.current = event.nativeEvent.locationX;
        setDragging(true);
        latest.current.onScrubStart();
        latest.current.onScrubMove(msAt(grantX.current));
      },
      onPanResponderMove: (_event, gesture: PanResponderGestureState) => {
        latest.current.onScrubMove(msAt(grantX.current + gesture.dx));
      },
      onPanResponderRelease: (_event, gesture: PanResponderGestureState) => {
        setDragging(false);
        latest.current.onScrubEnd(msAt(grantX.current + gesture.dx));
      },
      // A gesture the system takes away (a call arriving, a system sheet) still
      // has to land somewhere, or the thumb stays stuck where the finger left it.
      onPanResponderTerminate: (_event, gesture: PanResponderGestureState) => {
        setDragging(false);
        latest.current.onScrubEnd(msAt(grantX.current + gesture.dx));
      },
    });
  }, []);

  const fraction = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  const knobSize = dragging ? KNOB_DRAGGING : KNOB;
  const knobLeft = Math.min(Math.max(0, fraction * width - knobSize / 2), Math.max(0, width - knobSize));

  return (
    <View
      {...responder.panHandlers}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityRole="adjustable"
      accessibilityLabel={syncStrings.position}
      accessibilityState={{ disabled: !enabled }}
      accessibilityValue={{
        min: 0,
        max: Math.max(0, Math.round(durationMs)),
        now: Math.round(positionMs),
        text: formatClock(positionMs),
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (!enabled || durationMs <= 0) return;
        const delta = event.nativeEvent.actionName === 'increment' ? STEP_MS : -STEP_MS;
        onScrubEnd(Math.min(durationMs, Math.max(0, positionMs + delta)));
      }}
      style={{ height: TOUCH_HEIGHT, justifyContent: 'center' }}
    >
      <View
        style={{
          height: TRACK_HEIGHT,
          borderRadius: theme.radius.pill,
          backgroundColor: cinema.separator,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${fraction * 100}%`,
            height: '100%',
            backgroundColor: enabled ? cinema.accent : cinema.textTertiary,
          }}
        />
      </View>
      <View
        style={{
          position: 'absolute',
          left: knobLeft,
          width: knobSize,
          height: knobSize,
          borderRadius: knobSize / 2,
          backgroundColor: enabled ? cinema.text : cinema.textTertiary,
        }}
      />
    </View>
  );
}
