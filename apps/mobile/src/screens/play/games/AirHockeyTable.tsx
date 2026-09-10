import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import { Canvas, Circle, Line, Rect, select, vec } from '@shopify/react-native-skia';
import { useTheme } from '../../../ui/index.js';
import { Hint, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import { useFrameSignal, useSkiaGeometry, throttledInput } from '../realtime.js';
import type { GameRendererProps } from '../contract.js';
import { AIR_HOCKEY, airHockeyView, type AirHockeyState } from '../gameTypes.js';

/**
 * Air Hockey.
 *
 * BOTH PLAYERS DEFEND THE BOTTOM. The rules give seat 0 the bottom goal and
 * seat 1 the top, and that never changes - but a guest sees the table FLIPPED,
 * so the goal under their thumb is always their own. The flip is a rendering
 * transform and nothing more: the coordinates that travel are always the
 * table's, so both devices are simulating the same game of air hockey seen from
 * opposite ends, exactly as two people sat at a real table would.
 *
 * INPUT IS A POSITION, NOT A FORCE. A mallet is dragged, so a touch is worth a
 * coordinate; the reducer clamps it to the player's own half and to a maximum
 * step per tick, which is what stops a mallet from teleporting through the puck.
 * The stream is throttled to the tick rate, because a finger produces touches
 * faster than the simulation can use them and every one of them would otherwise
 * become a packet.
 */

const MAX_TABLE_WIDTH = 320;
/** One input per simulation tick. Anything faster is bytes nobody reads. */
const INPUT_INTERVAL_MS = 33;

interface HockeyGeometry {
  readonly puckX: number;
  readonly puckY: number;
  readonly puckR: number;
  readonly mineX: number;
  readonly mineY: number;
  readonly theirsX: number;
  readonly theirsY: number;
  readonly malletR: number;
}

const EMPTY: HockeyGeometry = {
  puckX: 0,
  puckY: 0,
  puckR: 0,
  mineX: 0,
  mineY: 0,
  theirsX: 0,
  theirsY: 0,
  malletR: 0,
};

export function AirHockeyTable({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  frames,
  elapsedMs,
  width,
}: GameRendererProps<AirHockeyState>): React.JSX.Element {
  const theme = useTheme();

  const tableWidth = Math.min(width, MAX_TABLE_WIDTH);
  const scale = tableWidth / AIR_HOCKEY.WIDTH;
  const tableHeight = AIR_HOCKEY.HEIGHT * scale;

  const seat = players.indexOf(local) === 1 ? 1 : 0;
  const flipped = seat === 1;

  /** Table y as drawn: a guest's half is mirrored to the bottom of the screen. */
  const drawY = useCallback(
    (y: number): number => (flipped ? AIR_HOCKEY.HEIGHT - y : y) * scale,
    [flipped, scale],
  );

  const geometry = useSkiaGeometry<HockeyGeometry>(
    frames,
    useCallback(
      (raw: unknown): HockeyGeometry | null => {
        if (!raw) return null;
        const view = airHockeyView(raw as AirHockeyState, 0);
        const mine = view.mallets[seat === 1 ? 1 : 0];
        const theirs = view.mallets[seat === 1 ? 0 : 1];
        return {
          puckX: view.puck.x * scale,
          puckY: drawY(view.puck.y),
          puckR: view.puck.radius * scale,
          mineX: mine.x * scale,
          mineY: drawY(mine.y),
          theirsX: theirs.x * scale,
          theirsY: drawY(theirs.y),
          malletR: mine.radius * scale,
        };
      },
      [drawY, scale, seat],
    ),
    EMPTY,
  );

  const signal = useFrameSignal<string>(
    frames,
    useCallback((raw: unknown): string => {
      const s = raw as AirHockeyState | null;
      if (!s) return '0:0:0';
      return `${s.scores[0]}:${s.scores[1]}:${s.winnerIndex}`;
    }, []),
    `${state.scores[0]}:${state.scores[1]}:${state.winnerIndex}`,
  );
  const parts = signal.split(':');
  const scores: [number, number] = [Number(parts[0] ?? 0), Number(parts[1] ?? 0)];

  const countdownMs = Math.max(0, state.serveAt - elapsedMs);

  const input = useMemo(
    () =>
      throttledInput<{ x: number; y: number }>(
        (payload) => dispatch('aim', payload),
        INPUT_INTERVAL_MS,
      ),
    [dispatch],
  );
  useEffect(() => () => input.stop(), [input]);

  const liveRef = useRef(live);
  liveRef.current = live;

  const aim = useCallback(
    (event: GestureResponderEvent) => {
      if (!liveRef.current) return;
      const { locationX, locationY } = event.nativeEvent;
      const x = locationX / scale;
      const drawn = locationY / scale;
      const y = flipped ? AIR_HOCKEY.HEIGHT - drawn : drawn;
      // Rounded to a whole table unit: the wire form is an integer, and a
      // fractional target would be quantised on the way out anyway.
      input.push({ x: Math.round(x), y: Math.round(y) });
    },
    [flipped, input, scale],
  );

  const goalWidth = (AIR_HOCKEY.GOAL_MAX_X - AIR_HOCKEY.GOAL_MIN_X) * scale;
  const goalX = AIR_HOCKEY.GOAL_MIN_X * scale;

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
        accessibilityLabel={playText.airHockey.table}
        accessibilityHint={playText.airHockey.dragHint}
        accessibilityValue={{ text: `${scores[0]} ${scores[1]}` }}
        style={{
          width: tableWidth,
          height: tableHeight,
          alignSelf: 'center',
          borderRadius: theme.radius.lg,
          overflow: 'hidden',
          backgroundColor: theme.colors.surface,
        }}
        onStartShouldSetResponder={() => live}
        onMoveShouldSetResponder={() => live}
        onResponderGrant={aim}
        onResponderMove={aim}
      >
        <Canvas style={{ flex: 1 }}>
          <Line
            p1={vec(0, tableHeight / 2)}
            p2={vec(tableWidth, tableHeight / 2)}
            color={theme.colors.separator}
            strokeWidth={1}
          />
          <Circle
            cx={tableWidth / 2}
            cy={tableHeight / 2}
            r={AIR_HOCKEY.MALLET_RADIUS * scale}
            color={theme.colors.separator}
            style="stroke"
            strokeWidth={1}
          />
          {/* The goal mouths. The near one is the accent because it is the one
              that costs this player a point. */}
          <Rect x={goalX} y={tableHeight - 4} width={goalWidth} height={4} color={theme.colors.accent} />
          <Rect x={goalX} y={0} width={goalWidth} height={4} color={theme.colors.text} />

          <Circle
            cx={select(geometry, 'theirsX')}
            cy={select(geometry, 'theirsY')}
            r={select(geometry, 'malletR')}
            color={theme.colors.text}
          />
          <Circle
            cx={select(geometry, 'mineX')}
            cy={select(geometry, 'mineY')}
            r={select(geometry, 'malletR')}
            color={theme.colors.accent}
          />
          <Circle
            cx={select(geometry, 'puckX')}
            cy={select(geometry, 'puckY')}
            r={select(geometry, 'puckR')}
            color={theme.colors.textSecondary}
          />
        </Canvas>
      </View>

      {countdownMs > 0 ? (
        <Hint text={playText.airHockey.faceOff(Math.ceil(countdownMs / 1000))} tone="secondary" />
      ) : (
        <Hint text={live ? playText.airHockey.dragHint : playText.room.waitingForLink} />
      )}
    </View>
  );
}
