import React, { useCallback, useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { Canvas, Circle, Rect, RoundedRect, select } from '@shopify/react-native-skia';
import { Label, haptic, useTheme } from '../../../ui/index.js';
import { Hint, MIN_TARGET, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import { useFrameSignal, useSkiaGeometry } from '../realtime.js';
import type { GameRendererProps } from '../contract.js';
import { PONG_FIELD_H, PONG_FIELD_W, PongPhase, pongView, type PongState } from '../gameTypes.js';

/**
 * Pong.
 *
 * The first of the three continuous games, and the template for the other two.
 *
 * WHAT MOVES AND WHERE. The ball and the two paddles are written into a single
 * Reanimated shared value once per frame and read by Skia on the UI thread, so
 * the picture keeps its pace through anything React is doing. The score is a
 * discrete event and goes through React, once, when it changes.
 *
 * WHAT TRAVELS. A direction: -1, 0 or 1. Nothing else. The host runs the
 * authoritative simulation and ships snapshots; a guest draws an interpolated
 * view of the last two, which is why a paddle never stutters on a link that
 * delivers in bursts.
 *
 * WHY BUTTONS AND NOT A DRAG. A paddle in this game has a SPEED, not a
 * position - `tick` moves it by `dir` - so a drag would have to be turned back
 * into a direction and would fight the simulation. Two large targets under the
 * thumb are also the only control that works while the other hand is holding a
 * tray table down.
 */

const TABLE_ASPECT = PONG_FIELD_H / PONG_FIELD_W;

interface PongGeometry {
  readonly ballX: number;
  readonly ballY: number;
  readonly ballR: number;
  readonly leftY: number;
  readonly rightY: number;
  readonly paddleW: number;
  readonly paddleH: number;
  readonly leftX: number;
  readonly rightX: number;
}

const EMPTY: PongGeometry = {
  ballX: 0,
  ballY: 0,
  ballR: 0,
  leftY: 0,
  rightY: 0,
  paddleW: 0,
  paddleH: 0,
  leftX: 0,
  rightX: 0,
};

export function PongTable({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  frames,
  width,
}: GameRendererProps<PongState>): React.JSX.Element {
  const theme = useTheme();

  const tableWidth = width;
  const tableHeight = Math.round(tableWidth * TABLE_ASPECT);
  const scale = tableWidth / PONG_FIELD_W;

  const seat = players.indexOf(local) === 1 ? 1 : 0;

  const geometry = useSkiaGeometry<PongGeometry>(
    frames,
    useCallback(
      (raw: unknown): PongGeometry | null => {
        if (!raw) return null;
        const view = pongView(raw as PongState);
        return {
          ballX: view.ball.x * scale,
          ballY: view.ball.y * scale,
          ballR: view.ball.r * scale,
          leftX: view.paddles[0].x * scale,
          rightX: view.paddles[1].x * scale,
          leftY: view.paddles[0].y * scale,
          rightY: view.paddles[1].y * scale,
          paddleW: view.paddles[0].w * scale,
          paddleH: view.paddles[0].h * scale,
        };
      },
      [scale],
    ),
    EMPTY,
  );

  /**
   * The three discrete facts about a rally, packed into one string.
   *
   * They change a handful of times a minute, so watching them costs one
   * comparison per frame and re-renders React only when a point is scored or
   * the ball is put back in play.
   */
  const signal = useFrameSignal<string>(
    frames,
    useCallback((raw: unknown): string => {
      const s = raw as PongState | null;
      if (!s) return '0:0:0:0';
      return `${s.score[0]}:${s.score[1]}:${s.phase}:${s.serveBy}`;
    }, []),
    `${state.score[0]}:${state.score[1]}:${state.phase}:${state.serveBy}`,
  );

  const parts = signal.split(':');
  const scores: [number, number] = [Number(parts[0] ?? 0), Number(parts[1] ?? 0)];
  const serving = Number(parts[2] ?? 0) === PongPhase.SERVE;
  const serveBy = Number(parts[3] ?? 0);
  const myServe = serving && serveBy === seat;

  // The last direction actually sent, so holding a button does not re-send it.
  const sentDir = useRef(0);
  const push = useCallback(
    (dir: -1 | 0 | 1) => {
      if (!live || sentDir.current === dir) return;
      sentDir.current = dir;
      dispatch('input', { dir });
    },
    [dispatch, live],
  );

  // Letting go of the screen must stop the paddle even if the release never
  // arrives as an event - unmounting mid-press would otherwise leave it moving.
  useEffect(
    () => () => {
      dispatch('input', { dir: 0 });
    },
    [dispatch],
  );

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={null}
        nameFor={nameFor}
        scoreFor={(player) => scores[players.indexOf(player) === 1 ? 1 : 0] ?? 0}
      />

      <View style={{ height: theme.spacing.md }} />

      <View
        accessible
        accessibilityLabel={playText.pong.table}
        accessibilityValue={{ text: `${scores[0]} ${scores[1]}` }}
        style={{
          width: tableWidth,
          height: tableHeight,
          borderRadius: theme.radius.lg,
          overflow: 'hidden',
          backgroundColor: theme.colors.surface,
        }}
      >
        <Canvas style={{ flex: 1 }}>
          {/* The halfway line, drawn as a column of ticks rather than a dash
              pattern so it costs no path and reads the same on both schemes. */}
          {Array.from({ length: 12 }, (_, i) => (
            <Rect
              key={i}
              x={tableWidth / 2 - 1}
              y={(tableHeight / 12) * i + tableHeight / 48}
              width={2}
              height={tableHeight / 24}
              color={theme.colors.separator}
            />
          ))}
          <RoundedRect
            x={select(geometry, 'leftX')}
            y={select(geometry, 'leftY')}
            width={select(geometry, 'paddleW')}
            height={select(geometry, 'paddleH')}
            r={4}
            color={seat === 0 ? theme.colors.accent : theme.colors.text}
          />
          <RoundedRect
            x={select(geometry, 'rightX')}
            y={select(geometry, 'rightY')}
            width={select(geometry, 'paddleW')}
            height={select(geometry, 'paddleH')}
            r={4}
            color={seat === 1 ? theme.colors.accent : theme.colors.text}
          />
          <Circle
            cx={select(geometry, 'ballX')}
            cy={select(geometry, 'ballY')}
            r={select(geometry, 'ballR')}
            color={theme.colors.text}
          />
        </Canvas>
      </View>

      <View style={{ height: theme.spacing.md }} />

      {serving ? (
        myServe ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={playText.pong.serve}
            accessibilityState={{ disabled: !live }}
            disabled={!live}
            onPress={() => {
              haptic('impactMedium');
              dispatch('serve', null);
            }}
            style={({ pressed }) => [
              {
                minHeight: MIN_TARGET + 4,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.accent,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: live ? 1 : 0.45,
              },
              pressed ? { opacity: 0.75 } : null,
            ]}
          >
            <Label variant="headline" tone="onAccent">
              {playText.pong.serve}
            </Label>
          </Pressable>
        ) : (
          <Hint text={playText.pong.theirServe(nameFor(players[seat === 0 ? 1 : 0] ?? local))} />
        )
      ) : null}

      <View style={{ height: theme.spacing.md }} />

      <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
        <PaddleButton title={playText.pong.up} live={live} onDown={() => push(-1)} onUp={() => push(0)} />
        <PaddleButton title={playText.pong.down} live={live} onDown={() => push(1)} onUp={() => push(0)} />
      </View>

      {live ? null : <Hint text={playText.room.waitingForLink} />}
    </View>
  );
}

/**
 * A hold-to-move target.
 *
 * `onPressIn`/`onPressOut` rather than `onPress`, because a paddle is held, not
 * tapped - and `onPressOut` fires when a finger slides off the button as well
 * as when it lifts, which is what stops a paddle running into the wall.
 */
function PaddleButton({
  title,
  live,
  onDown,
  onUp,
}: {
  title: string;
  live: boolean;
  onDown: () => void;
  onUp: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !live }}
      disabled={!live}
      onPressIn={onDown}
      onPressOut={onUp}
      style={({ pressed }) => [
        {
          flex: 1,
          minHeight: MIN_TARGET + 20,
          borderRadius: theme.radius.md,
          backgroundColor: pressed ? theme.colors.accentMuted : theme.colors.surfaceElevated,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: live ? 1 : 0.45,
        },
      ]}
    >
      <Label variant="headline" tone={live ? 'primary' : 'tertiary'}>
        {title}
      </Label>
    </Pressable>
  );
}
