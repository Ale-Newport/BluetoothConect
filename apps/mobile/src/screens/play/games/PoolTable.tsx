import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import { Canvas, Circle, Line, select, vec } from '@shopify/react-native-skia';
import { useSharedValue } from 'react-native-reanimated';
import { createContext } from '@airlink/games';
import { Label, haptic, useTheme } from '../../../ui/index.js';
import { Hint, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  POOL_BALL_COUNT,
  POOL_BALL_RADIUS,
  POOL_POCKETS,
  POOL_POCKET_RADIUS,
  POOL_TABLE_HEIGHT,
  POOL_TABLE_WIDTH,
  PoolGroup,
  anyBallMoving,
  pool,
  poolBeginShot,
  poolView,
  type PoolState,
} from '../gameTypes.js';

/**
 * 8-Ball.
 *
 * ONE ACTION, TWENTY BYTES. A shot is an angle and a power, and that is the
 * whole wire format - the entire break, every collision and every ball that
 * drops is computed identically on both phones by the game's own deterministic
 * physics. Nothing about the table is ever transmitted.
 *
 * THE SHOT IS ANIMATED LOCALLY, AND CANNOT DESYNC ANYTHING. `applyAction`
 * resolves a shot to rest in one step, because a reducer that took three
 * seconds to return would be a reducer the tests could not drive - so the state
 * this screen is handed has the balls already parked. To make that look like
 * pool rather than a teleport, the screen replays the shot for itself:
 * `poolBeginShot` on the position from BEFORE the shot, then the game's own
 * `tick` frame by frame. The last frame of that replay is byte-identical to the
 * state the reducer computed - it is literally the same function - so this is a
 * picture of the authoritative result, never an input to it.
 *
 * The positions go into one Reanimated shared value and are drawn by Skia on
 * the UI thread, so the replay keeps its pace regardless of React.
 *
 * PULL TO AIM. Touch the table and drag: the line from the cue ball through
 * your finger is the direction, and how far you drag is how hard you hit it.
 * Lifting takes the shot - one gesture rather than an aim control plus a power
 * slider plus a button, which on a phone is three chances to lose your line.
 *
 * BALL IN HAND IS NOT A DRAG. There is deliberately no placement action in the
 * protocol; the rules re-spot the cue ball on a fixed, deterministic search
 * pattern. So this screen reports that rather than offering a placement that
 * would have nowhere to go.
 */

/** How far a drag has to travel for a full-power shot, in table units. */
const MAX_DRAG_UNITS = 320;
/** The rules' own floor. Below this the shot is refused rather than feeble. */
const MIN_POWER = 0.05;
const TAU = Math.PI * 2;
const POOL_TICK_MS = 1000 / 60;
/** A replay that will not settle is cut off rather than run for ever. */
const MAX_REPLAY_MS = 12_000;

/** Every ball's centre and radius, flattened for Skia's per-key binding. */
type TableGeometry = Record<string, number>;

function geometryOf(state: PoolState, scale: number): TableGeometry {
  const out: TableGeometry = {};
  for (let i = 0; i < POOL_BALL_COUNT; i++) {
    const ball = state.balls[i];
    out[`x${i}`] = (ball?.x ?? 0) * scale;
    out[`y${i}`] = (ball?.y ?? 0) * scale;
    // A potted ball is drawn with no radius rather than removed, so the number
    // of Skia nodes never changes and nothing has to remount mid-shot.
    out[`r${i}`] = !ball || ball.potted ? 0 : POOL_BALL_RADIUS * scale;
  }
  return out;
}

export function PoolTable({
  state,
  dispatch,
  local,
  players,
  nameFor,
  turn,
  lastAction,
  live,
  disabledReason,
  width,
}: GameRendererProps<PoolState>): React.JSX.Element {
  const theme = useTheme();

  const tableWidth = width;
  const scale = tableWidth / POOL_TABLE_WIDTH;
  const tableHeight = POOL_TABLE_HEIGHT * scale;

  const view = useMemo(() => poolView(state, local), [state, local]);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [replaying, setReplaying] = useState(false);

  const geometry = useSharedValue<TableGeometry>(geometryOf(state, scale));

  /**
   * The position before the shot that is being replayed.
   *
   * Held from render to render because a replay needs the table as it was, and
   * by the time an action has been applied the state has moved on.
   */
  const before = useRef<PoolState>(state);
  const replayedShots = useRef(state.shots);

  useEffect(() => {
    const authoritative = state;
    const previous = before.current;
    before.current = authoritative;

    // Nothing new: keep the picture in step with the state and stop.
    if (authoritative.shots === replayedShots.current) {
      geometry.value = geometryOf(authoritative, scale);
      return;
    }
    replayedShots.current = authoritative.shots;

    // The shot to replay comes from the action that produced this state. When
    // there is none - a resync after a reconnect, a replayed log on resume -
    // the table snaps, which is the honest picture of a shot this device never
    // saw taken. Two shots at once means one was missed; the same applies.
    const shot = authoritative.shots === previous.shots + 1 ? shotOf(lastAction) : null;
    if (!shot) {
      geometry.value = geometryOf(authoritative, scale);
      return;
    }

    let display = poolBeginShot(previous, shot.angle, shot.power);
    let frame = 0;
    let elapsed = 0;
    let cancelled = false;
    setReplaying(true);

    const step = (): void => {
      if (cancelled) return;
      elapsed += POOL_TICK_MS;
      // The game's OWN tick, at the game's own fixed step. Anything else would
      // be a second, approximate physics engine in the UI.
      display = pool.tick?.(display, createContext(display.players, 0, elapsed, POOL_TICK_MS)) ?? display;
      geometry.value = geometryOf(display, scale);
      if (anyBallMoving(display) && elapsed < MAX_REPLAY_MS) {
        frame = requestAnimationFrame(step);
        return;
      }
      // The replay has arrived where the reducer already was; snap to it so the
      // picture and the state cannot disagree by a rounding.
      geometry.value = geometryOf(authoritative, scale);
      setReplaying(false);
    };
    frame = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      setReplaying(false);
    };
    // `lastAction` is read, not depended on: it changes for every action in
    // every game, and only a change in `state.shots` starts a replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, scale, state]);

  const myShot = turn === local && !replaying && live && state.winner < 0 && !anyBallMoving(state);

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
              // A mid grey reads as a hole against the felt in BOTH schemes,
              // which neither the background nor the text colour manages.
              color={theme.colors.textTertiary}
            />
          ))}

          {/* The aiming line, from the cue ball through the finger. */}
          {drag ? (
            <Line
              p1={vec(cueX, cueY)}
              p2={vec(drag.x * scale, drag.y * scale)}
              color={theme.colors.accent}
              strokeWidth={2}
            />
          ) : null}

          {Array.from({ length: POOL_BALL_COUNT }, (_unused, index) => {
            if (index === 0) return null;
            const kind = view.balls[index]?.kind ?? 'solid';
            return (
              <Circle
                key={index}
                cx={select(geometry, `x${index}`)}
                cy={select(geometry, `y${index}`)}
                r={select(geometry, `r${index}`)}
                color={kind === 'eight' ? theme.colors.text : theme.colors.accent}
                style={kind === 'stripe' ? 'stroke' : 'fill'}
                strokeWidth={kind === 'stripe' ? POOL_BALL_RADIUS * scale * 0.55 : undefined}
              />
            );
          })}

          {/* The cue ball is white with a ring round it: white alone disappears
              into a light felt, and the ring survives both schemes. */}
          <Circle
            cx={select(geometry, 'x0')}
            cy={select(geometry, 'y0')}
            r={select(geometry, 'r0')}
            color={theme.colors.onAccent}
          />
          <Circle
            cx={select(geometry, 'x0')}
            cy={select(geometry, 'y0')}
            r={select(geometry, 'r0')}
            color={theme.colors.text}
            style="stroke"
            strokeWidth={1.5}
          />
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
        {replaying
          ? playText.pool.rolling
          : // A finished table is not "not your turn", and a dropped link is
            // not either. Both say what they actually are.
            disabledReason ??
            (state.ballInHand && turn === local
              ? playText.pool.ballInHand
              : myShot
              ? view.onEight
                ? playText.pool.onEight
                : playText.pool.yourShot
              : playText.room.notYourTurn)}
      </Label>

      {myShot ? <Hint text={playText.pool.aimHint} /> : null}
    </View>
  );
}

/**
 * The angle and power of a shot, from the action that carried it.
 *
 * `lastAction` is typed as the generic envelope, so its payload is read
 * defensively: this is the one place in the renderer where a value crosses from
 * "some action" to "this game's shot", and a malformed one must produce a snap
 * rather than a NaN table.
 */
function shotOf(action: { readonly payload: unknown } | null): { angle: number; power: number } | null {
  const payload = action?.payload as { angle?: unknown; power?: unknown } | null | undefined;
  if (!payload || typeof payload.angle !== 'number' || typeof payload.power !== 'number') return null;
  if (!Number.isFinite(payload.angle) || !Number.isFinite(payload.power)) return null;
  return { angle: payload.angle, power: payload.power };
}
