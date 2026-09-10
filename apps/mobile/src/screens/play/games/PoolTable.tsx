import React, { useCallback, useMemo, useState } from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import { Canvas, Circle, Line, select, vec } from '@shopify/react-native-skia';
import { Label, haptic, useTheme } from '../../../ui/index.js';
import { Hint, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import { useFrameSignal, useSkiaGeometry } from '../realtime.js';
import type { GameRendererProps } from '../contract.js';
import {
  POOL_BALL_RADIUS,
  POOL_POCKETS,
  POOL_POCKET_RADIUS,
  POOL_TABLE_HEIGHT,
  POOL_TABLE_WIDTH,
  PoolGroup,
  poolView,
  type PoolState,
} from '../gameTypes.js';

/**
 * 8-Ball.
 *
 * ONE ACTION, TWENTY BYTES. A shot is an angle and a power, and that is the
 * whole wire format - the entire break, every collision and every ball that
 * drops is then computed identically on both phones by the game's own
 * deterministic physics. Nothing about the table is ever transmitted.
 *
 * PULL TO AIM. Touch the table and drag: the line from the cue ball through
 * your finger is the direction, and how far you drag is how hard you hit it.
 * Lifting takes the shot. One gesture rather than an aim control plus a power
 * slider plus a button, which on a phone is three chances to lose your line.
 *
 * BALL IN HAND IS NOT A DRAG. There is deliberately no placement action in the
 * protocol; the rules re-spot the cue ball on a fixed, deterministic search
 * pattern instead. So this screen says the cue ball has been re-spotted rather
 * than offering a placement that would have nowhere to go.
 */

/** Sixteen balls, each a number. The palette is here; the rules only know indices. */
const MAX_DRAG_UNITS = 320;
const MIN_POWER = 0.05;
const TAU = Math.PI * 2;

interface CueGeometry {
  readonly cueX: number;
  readonly cueY: number;
}

export function PoolTable({
  state,
  dispatch,
  local,
  players,
  nameFor,
  turn,
  live,
  frames,
  width,
}: GameRendererProps<PoolState>): React.JSX.Element {
  const theme = useTheme();

  const tableWidth = width;
  const scale = tableWidth / POOL_TABLE_WIDTH;
  const tableHeight = POOL_TABLE_HEIGHT * scale;

  const view = useMemo(() => poolView(state, local), [state, local]);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);

  /**
   * The balls come through React, not through a shared value.
   *
   * A pool shot is not continuous input: it resolves in one action, and between
   * shots nothing moves at all. The rolling itself is a few seconds of `tick`,
   * and the cue ball is the only thing an aiming line has to follow at frame
   * rate - so that one is a shared value and the rest of the table is drawn
   * from the state the room already re-renders on.
   */
  const cue = useSkiaGeometry<CueGeometry>(
    frames,
    useCallback(
      (raw: unknown): CueGeometry | null => {
        const s = raw as PoolState | null;
        const ball = s?.balls[0];
        if (!ball) return null;
        return { cueX: ball.x * scale, cueY: ball.y * scale };
      },
      [scale],
    ),
    { cueX: (state.balls[0]?.x ?? 0) * scale, cueY: (state.balls[0]?.y ?? 0) * scale },
  );

  /** Re-render when the table comes to rest, or a ball drops. */
  const signal = useFrameSignal<string>(
    frames,
    useCallback((raw: unknown): string => {
      const s = raw as PoolState | null;
      if (!s) return 'idle';
      const potted = s.balls.reduce((mask, ball, i) => (ball.potted ? mask | (1 << i) : mask), 0);
      return `${s.shooting ? 1 : 0}:${s.turnIndex}:${potted}`;
    }, []),
    `${state.shooting ? 1 : 0}:${state.turnIndex}:0`,
  );
  const rolling = signal.startsWith('1:') || view.moving;

  const myShot = turn === local && !rolling && live && state.winner < 0;

  const cueBall = state.balls[0];
  const cueX = (cueBall?.x ?? 0) * scale;
  const cueY = (cueBall?.y ?? 0) * scale;

  const shoot = useCallback(() => {
    const pulled = drag;
    setDrag(null);
    if (!pulled || !myShot || !cueBall) return;
    const dx = pulled.x - cueBall.x;
    const dy = pulled.y - cueBall.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return;
    // atan2 returns (-pi, pi]; the wire form is 0..2pi.
    const angle = (Math.atan2(dy, dx) + TAU) % TAU;
    const power = Math.max(MIN_POWER, Math.min(1, distance / MAX_DRAG_UNITS));
    haptic('impactMedium');
    dispatch('shoot', { angle, power });
  }, [cueBall, dispatch, drag, myShot]);

  const toTable = useCallback(
    (event: GestureResponderEvent): { x: number; y: number } => ({
      x: event.nativeEvent.locationX / scale,
      y: event.nativeEvent.locationY / scale,
    }),
    [scale],
  );

  const power = useMemo(() => {
    if (!drag || !cueBall) return 0;
    return Math.min(1, Math.hypot(drag.x - cueBall.x, drag.y - cueBall.y) / MAX_DRAG_UNITS);
  }, [cueBall, drag]);

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={turn}
        nameFor={nameFor}
        captionFor={(player) => {
          const group = player === local ? view.yourGroup : view.theirGroup;
          if (group === PoolGroup.NONE) return playText.pool.open;
          const left = player === local ? view.yourRemaining : view.theirRemaining;
          return `${group === PoolGroup.SOLIDS ? playText.pool.solids : playText.pool.stripes} · ${left}`;
        }}
      />

      <View style={{ height: theme.spacing.md }} />

      <View
        accessible
        accessibilityLabel={playText.pool.table}
        accessibilityHint={playText.pool.aimHint}
        style={{
          width: tableWidth,
          height: tableHeight,
          borderRadius: theme.radius.md,
          overflow: 'hidden',
          backgroundColor: theme.colors.surfaceElevated,
        }}
        onStartShouldSetResponder={() => myShot}
        onMoveShouldSetResponder={() => myShot}
        onResponderGrant={(event) => setDrag(toTable(event))}
        onResponderMove={(event) => setDrag(toTable(event))}
        onResponderRelease={shoot}
        onResponderTerminate={() => setDrag(null)}
      >
        <Canvas style={{ flex: 1 }}>
          {POOL_POCKETS.map((pocket, index) => (
            <Circle
              key={index}
              cx={pocket[0] * scale}
              cy={pocket[1] * scale}
              r={POOL_POCKET_RADIUS * scale}
              color={theme.colors.background}
            />
          ))}

          {state.balls.map((ball, index) => {
            if (ball.potted || index === 0) return null;
            const kind = view.balls[index]?.kind ?? 'solid';
            return (
              <React.Fragment key={index}>
                <Circle
                  cx={ball.x * scale}
                  cy={ball.y * scale}
                  r={POOL_BALL_RADIUS * scale}
                  color={kind === 'eight' ? theme.colors.text : theme.colors.accent}
                  style={kind === 'stripe' ? 'stroke' : 'fill'}
                  strokeWidth={kind === 'stripe' ? POOL_BALL_RADIUS * scale * 0.55 : undefined}
                />
              </React.Fragment>
            );
          })}

          {/* The aiming line, from the cue ball through the finger. */}
          {drag ? (
            <Line
              p1={vec(cueX, cueY)}
              p2={vec(drag.x * scale, drag.y * scale)}
              color={theme.colors.accent}
              strokeWidth={2}
            />
          ) : null}

          {cueBall?.potted ? null : (
            <Circle
              cx={select(cue, 'cueX')}
              cy={select(cue, 'cueY')}
              r={POOL_BALL_RADIUS * scale}
              color={theme.colors.onAccent}
            />
          )}
        </Canvas>
      </View>

      <View style={{ height: theme.spacing.md }} />

      {/* Power, shown only while a shot is being pulled. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          height: 6,
          borderRadius: theme.radius.sm,
          backgroundColor: theme.colors.surfaceElevated,
          overflow: 'hidden',
          opacity: drag ? 1 : 0.3,
        }}
      >
        <View style={{ width: `${power * 100}%`, height: 6, backgroundColor: theme.colors.accent }} />
      </View>

      <View style={{ height: theme.spacing.sm }} />

      <Label variant="footnote" tone="secondary" align="center">
        {rolling
          ? playText.pool.rolling
          : state.ballInHand && myShot
          ? playText.pool.ballInHand
          : myShot
          ? view.onEight
            ? playText.pool.onEight
            : playText.pool.yourShot
          : playText.room.notYourTurn}
      </Label>

      {myShot ? <Hint text={playText.pool.aimHint} /> : null}
    </View>
  );
}
