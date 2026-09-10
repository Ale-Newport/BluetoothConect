import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, View, type GestureResponderEvent } from 'react-native';
import { Canvas, Circle, Line, vec } from '@shopify/react-native-skia';
import { Label, haptic, useTheme } from '../../../ui/index.js';
import { Hint, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  DARTS_PER_TURN,
  DART_BOARD_RADIUS,
  DartRing,
  scoreDart,
  type DartsState,
} from '../gameTypes.js';

/**
 * Darts - 501, finishing on a double.
 *
 * THE BOARD IS DRAWN, NOT PHOTOGRAPHED. Rings and wires at their real radii, in
 * the app's own two surface tones, so it belongs to AirLink rather than looking
 * like a clip-art board dropped into it. The numbers round the rim are
 * deliberately absent: at phone size they are unreadable, and the score of the
 * bed under the finger is printed under the board where it can actually be
 * read.
 *
 * AIMING IS A DRAG, THROWING IS A RELEASE. Move a finger over the board to aim
 * - the crosshair follows, and the bed it is over is named live - then lift to
 * throw. The steadiness bar sweeping underneath decides the scatter: releasing
 * near the middle throws straight, releasing at either end sprays. That single
 * mechanic is what makes this a game of timing rather than a test of how
 * precisely a thumb can be placed.
 *
 * The scatter itself is NOT applied here. `applyAction` draws it from the
 * shared seeded PRNG, so both phones see the dart land in the same place - a
 * throw resolved locally would put two different darts on two boards.
 */

const MAX_BOARD = 320;
/** Ring radii in board units. The rules score against squared versions of these. */
const R_INNER_BULL = 6.35;
const R_OUTER_BULL = 15.9;
const R_TREBLE_INNER = 99;
const R_TREBLE_OUTER = 107;
const R_DOUBLE_INNER = 162;
const R_DOUBLE_OUTER = DART_BOARD_RADIUS;

/** One full sweep of the steadiness bar. Fast enough to be a real decision. */
const SWEEP_MS = 1100;

export function DartsBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  turn,
  live,
  width,
}: GameRendererProps<DartsState>): React.JSX.Element {
  const theme = useTheme();

  const size = Math.min(width, MAX_BOARD);
  const centre = size / 2;
  const scale = (size / 2 - 6) / DART_BOARD_RADIUS;

  const myTurn = turn === local;
  const canThrow = myTurn && live && state.winnerIndex < 0;

  const [aim, setAim] = useState<{ x: number; y: number } | null>(null);

  /**
   * The steadiness bar.
   *
   * React Native's own Animated rather than Reanimated, because the value has
   * to be READ on the JavaScript thread at the moment a finger lifts, and a
   * shared value living on the UI thread is exactly the wrong shape for that.
   * A listener keeps a ref in step; nothing re-renders.
   */
  const sweep = useRef(new Animated.Value(0)).current;
  const sweepValue = useRef(0);

  useEffect(() => {
    const subscription = sweep.addListener(({ value }) => {
      sweepValue.current = value;
    });
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, { toValue: 1, duration: SWEEP_MS, easing: Easing.linear, useNativeDriver: false }),
        Animated.timing(sweep, { toValue: 0, duration: SWEEP_MS, easing: Easing.linear, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      sweep.removeListener(subscription);
    };
  }, [sweep]);

  const toBoard = useCallback(
    (event: GestureResponderEvent): { x: number; y: number } => {
      const { locationX, locationY } = event.nativeEvent;
      // The rules measure y upward (sector 20 sits on +y); the screen measures
      // it downward. This flip is the whole difference between the two frames.
      const x = (locationX - centre) / scale;
      const y = -(locationY - centre) / scale;
      const limit = DART_BOARD_RADIUS;
      const clamp = (v: number): number => Math.round(v < -limit ? -limit : v > limit ? limit : v);
      return { x: clamp(x), y: clamp(y) };
    },
    [centre, scale],
  );

  const release = useCallback(() => {
    const target = aim;
    setAim(null);
    if (!target || !canThrow) return;
    // Middle of the sweep is a steady hand; either end is a wild one.
    const accuracy = Math.round((1 - Math.abs(sweepValue.current * 2 - 1)) * 100) / 100;
    haptic('impactMedium');
    dispatch('throw', { targetX: target.x, targetY: target.y, accuracy });
  }, [aim, canThrow, dispatch]);

  const aimed = aim ? scoreDart(aim.x, aim.y) : null;
  const wires = useMemo(
    () =>
      Array.from({ length: 20 }, (_, i) => {
        // Wires sit on the boundaries between beds, 9 degrees off each centre.
        const degrees = 90 - 18 * i - 9;
        const radians = (degrees * Math.PI) / 180;
        return {
          x1: centre + Math.cos(radians) * R_OUTER_BULL * scale,
          y1: centre - Math.sin(radians) * R_OUTER_BULL * scale,
          x2: centre + Math.cos(radians) * R_DOUBLE_OUTER * scale,
          y2: centre - Math.sin(radians) * R_DOUBLE_OUTER * scale,
        };
      }),
    [centre, scale],
  );

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={turn}
        nameFor={nameFor}
        scoreFor={(player) => state.scores[players.indexOf(player)] ?? 0}
        captionFor={(player) =>
          turn === player ? playText.darts.dartsLeft(DARTS_PER_TURN - state.dartsThrown) : null
        }
      />

      <View style={{ height: theme.spacing.md }} />

      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={playText.darts.throwLabel}
        accessibilityHint={playText.darts.aimHint}
        style={{ width: size, height: size, alignSelf: 'center' }}
        onStartShouldSetResponder={() => canThrow}
        onMoveShouldSetResponder={() => canThrow}
        onResponderGrant={(event) => setAim(toBoard(event))}
        onResponderMove={(event) => setAim(toBoard(event))}
        onResponderRelease={release}
        onResponderTerminate={() => setAim(null)}
      >
        <Canvas style={{ flex: 1 }}>
          <Circle cx={centre} cy={centre} r={R_DOUBLE_OUTER * scale} color={theme.colors.surfaceElevated} />
          {/* Double and treble rings, drawn as thick strokes on a circle at the
              middle of each band: one primitive each instead of forty wedges. */}
          <Circle
            cx={centre}
            cy={centre}
            r={((R_DOUBLE_INNER + R_DOUBLE_OUTER) / 2) * scale}
            color={theme.colors.textTertiary}
            style="stroke"
            strokeWidth={(R_DOUBLE_OUTER - R_DOUBLE_INNER) * scale}
          />
          <Circle
            cx={centre}
            cy={centre}
            r={((R_TREBLE_INNER + R_TREBLE_OUTER) / 2) * scale}
            color={theme.colors.textTertiary}
            style="stroke"
            strokeWidth={(R_TREBLE_OUTER - R_TREBLE_INNER) * scale}
          />
          {wires.map((wire, index) => (
            <Line
              key={index}
              p1={vec(wire.x1, wire.y1)}
              p2={vec(wire.x2, wire.y2)}
              color={theme.colors.separator}
              strokeWidth={1}
            />
          ))}
          <Circle cx={centre} cy={centre} r={R_OUTER_BULL * scale} color={theme.colors.connected} />
          <Circle cx={centre} cy={centre} r={R_INNER_BULL * scale} color={theme.colors.danger} />

          {/* Where the last dart actually landed, from the shared simulation. */}
          {state.lastThrower >= 0 ? (
            <Circle
              cx={centre + state.lastX * scale}
              cy={centre - state.lastY * scale}
              r={4}
              color={theme.colors.text}
            />
          ) : null}

          {aim ? (
            <Circle
              cx={centre + aim.x * scale}
              cy={centre - aim.y * scale}
              r={10}
              color={theme.colors.accent}
              style="stroke"
              strokeWidth={2}
            />
          ) : null}
        </Canvas>
      </View>

      <View style={{ height: theme.spacing.md }} />

      {/* Steadiness. It only matters while a dart is being aimed, so it only
          appears then - a bar sweeping under an idle board is just noise. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          height: 6,
          borderRadius: theme.radius.sm,
          backgroundColor: theme.colors.surfaceElevated,
          overflow: 'hidden',
          opacity: canThrow ? 1 : 0.3,
        }}
      >
        <Animated.View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: theme.colors.accent,
            transform: [
              {
                translateX: sweep.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, Math.max(0, width - 6)],
                }),
              },
            ],
          }}
        />
      </View>

      <View style={{ height: theme.spacing.md }} />

      <Label variant="headline" align="center" tone={aimed ? 'accent' : 'secondary'}>
        {aimed ? describeHit(aimed.points, aimed.ring, aimed.sector) : lastThrowText(state)}
      </Label>

      <Hint text={canThrow ? playText.darts.powerHint : playText.room.notYourTurn} />
    </View>
  );
}

/** A bed, in the words a darts player uses. */
function describeHit(points: number, ring: number, sector: number): string {
  if (ring === DartRing.INNER_BULL) return playText.darts.bull;
  if (ring === DartRing.OUTER_BULL) return playText.darts.outerBull;
  if (ring === DartRing.MISS) return playText.darts.miss;
  const prefix =
    ring === DartRing.DOUBLE
      ? playText.darts.doublePrefix
      : ring === DartRing.TREBLE
      ? playText.darts.treblePrefix
      : '';
  return `${prefix}${prefix ? ' ' : ''}${sector} · ${points}`;
}

function lastThrowText(state: DartsState): string {
  if (state.lastThrower < 0) return playText.darts.aimHint;
  if (state.lastWasBust) return playText.darts.bust;
  return `${playText.darts.lastThrow}: ${describeHit(state.lastPoints, state.lastRing, state.lastSector)}`;
}
