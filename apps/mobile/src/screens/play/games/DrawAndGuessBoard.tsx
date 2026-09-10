import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View, type GestureResponderEvent } from 'react-native';
import { Canvas, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { Button, Divider, Label, haptic, useTheme } from '../../../ui/index.js';
import { ChipRow, Hint, MIN_TARGET, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  DRAW_MAX_COORD,
  GuessKind,
  MAX_GUESS_LENGTH,
  MAX_POINTS_PER_STROKE,
  currentDrawer,
  currentWord,
  drawingIsFinished,
  type DrawAndGuessState,
} from '../gameTypes.js';

/**
 * Draw and Guess.
 *
 * WHAT TRAVELS IS A STROKE, NOT A PICTURE. Each stroke is a flat list of
 * integer coordinates on a fixed 0-1000 grid, so it is a few dozen bytes and it
 * redraws at any size on any screen. An image would be tens of kilobytes and
 * would arrive after the round was over.
 *
 * THE WORD IS ON BOTH DEVICES AND THAT IS FINE. With no server there is nowhere
 * else to keep it: `currentWord` derives it from the shared seed, and the
 * guesser's screen simply does not ask for it. What the rules DO protect is the
 * feed - a correct or nearly-correct guess travels with its text stripped,
 * because that feed is rendered on every device and would otherwise hand the
 * answer to everyone the moment one person got it.
 *
 * A stroke is buffered locally while the finger is down and sent once on lift.
 * Sending per touch would be a packet every few milliseconds, and the reducer
 * only cares about finished strokes.
 */

const MAX_CANVAS = 360;
const BRUSH_WIDTHS = [2, 4, 8] as const;
type BrushWidth = (typeof BRUSH_WIDTHS)[number];
/**
 * The palette. Sixteen indices exist in the protocol; the five here are the
 * app's own tokens, because a drawing that comes back in colours the app does
 * not otherwise use looks like it came from somewhere else.
 */
const PALETTE_KEYS = ['text', 'accent', 'connected', 'warning', 'danger'] as const;
/**
 * How far the finger must travel before a point is kept, in grid units.
 *
 * A touch stream delivers a point per frame, which is both far more detail than
 * a drawing needs and a re-render per frame. Eight units is about three screen
 * pixels: invisible in the line, and it keeps a long stroke inside the
 * protocol's point cap instead of being truncated by it.
 */
const MIN_POINT_GAP = 8;

export function DrawAndGuessBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  width,
}: GameRendererProps<DrawAndGuessState>): React.JSX.Element {
  const theme = useTheme();

  const canvas = Math.min(width, MAX_CANVAS);
  const scale = canvas / DRAW_MAX_COORD;

  const drawer = currentDrawer(state);
  const iAmDrawer = drawer === local;
  const seat = players.indexOf(local);
  const solved = state.solved[seat] === true;
  const finished = drawingIsFinished(state);

  const [colorIndex, setColorIndex] = useState(0);
  const [brush, setBrush] = useState<BrushWidth>(BRUSH_WIDTHS[1]);
  const [guess, setGuess] = useState('');
  /** The stroke in progress, in grid units. Committed on lift. */
  const wetPoints = useRef<number[]>([]);
  const [wet, setWet] = useState<readonly number[]>([]);

  const palette = PALETTE_KEYS.map((key) => theme.colors[key]);

  const toGrid = useCallback(
    (event: GestureResponderEvent): [number, number] => {
      const x = Math.round(event.nativeEvent.locationX / scale);
      const y = Math.round(event.nativeEvent.locationY / scale);
      const clamp = (v: number): number => (v < 0 ? 0 : v > DRAW_MAX_COORD ? DRAW_MAX_COORD : v);
      return [clamp(x), clamp(y)];
    },
    [scale],
  );

  const extend = useCallback(
    (event: GestureResponderEvent) => {
      const [x, y] = toGrid(event);
      const points = wetPoints.current;
      const lastX = points[points.length - 2];
      const lastY = points[points.length - 1];
      if (lastX !== undefined && lastY !== undefined) {
        if (Math.abs(lastX - x) < MIN_POINT_GAP && Math.abs(lastY - y) < MIN_POINT_GAP) return;
      }
      // The protocol caps a stroke; going over would have the reducer refuse
      // the whole thing, so the stroke is simply broken here instead.
      if (points.length >= MAX_POINTS_PER_STROKE * 2) return;
      points.push(x, y);
      setWet([...points]);
    },
    [toGrid],
  );

  const commit = useCallback(() => {
    const points = wetPoints.current;
    wetPoints.current = [];
    setWet([]);
    if (points.length < 4) return;
    dispatch('stroke', { points, color: colorIndex, width: brush });
  }, [brush, colorIndex, dispatch]);

  const paths = useMemo(
    () => state.strokes.map((stroke) => ({ path: toPath(stroke.points, scale), stroke })),
    [scale, state.strokes],
  );
  const wetPath = useMemo(() => (wet.length >= 4 ? toPath(wet, scale) : null), [scale, wet]);

  const send = (): void => {
    const text = guess.trim();
    if (text.length === 0) return;
    setGuess('');
    haptic('impactLight');
    dispatch('guess', { text });
  };

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={drawer}
        nameFor={nameFor}
        scoreFor={(player) => state.scores[players.indexOf(player)] ?? 0}
        captionFor={(player) =>
          state.solved[players.indexOf(player)] === true ? playText.drawAndGuess.solved : null
        }
      />

      <View style={{ height: theme.spacing.md }} />

      <Label variant="footnote" tone="tertiary" align="center">
        {playText.drawAndGuess.round(Math.min(state.round + 1, state.totalRounds), state.totalRounds)}
      </Label>
      <Label variant="title2" align="center" style={{ marginTop: theme.spacing.xs }}>
        {iAmDrawer
          ? playText.drawAndGuess.youDraw(currentWord(state) ?? '')
          : playText.drawAndGuess.theyDraw(drawer === null ? '' : nameFor(drawer))}
      </Label>

      <View style={{ height: theme.spacing.md }} />

      <View
        accessible
        accessibilityLabel={playText.drawAndGuess.canvas}
        style={{
          width: canvas,
          height: canvas,
          alignSelf: 'center',
          borderRadius: theme.radius.lg,
          overflow: 'hidden',
          backgroundColor: theme.colors.surface,
        }}
        onStartShouldSetResponder={() => iAmDrawer && live && !finished}
        onMoveShouldSetResponder={() => iAmDrawer && live && !finished}
        onResponderGrant={extend}
        onResponderMove={extend}
        onResponderRelease={commit}
        onResponderTerminate={commit}
      >
        <Canvas style={{ flex: 1 }}>
          {paths.map((entry, index) => (
            <Path
              key={index}
              path={entry.path}
              style="stroke"
              strokeWidth={entry.stroke.width}
              strokeCap="round"
              strokeJoin="round"
              color={palette[entry.stroke.color % palette.length] ?? theme.colors.text}
            />
          ))}
          {wetPath ? (
            <Path
              path={wetPath}
              style="stroke"
              strokeWidth={brush}
              strokeCap="round"
              strokeJoin="round"
              color={palette[colorIndex] ?? theme.colors.text}
            />
          ) : null}
        </Canvas>
      </View>

      <View style={{ height: theme.spacing.md }} />

      {iAmDrawer ? (
        <View style={{ gap: theme.spacing.md }}>
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm, justifyContent: 'center' }}>
            {palette.map((color, index) => (
              <Swatch
                key={index}
                color={color}
                selected={index === colorIndex}
                label={playText.drawAndGuess.colour(index + 1)}
                onPress={() => setColorIndex(index)}
              />
            ))}
          </View>
          <ChipRow
            options={BRUSH_WIDTHS}
            value={brush}
            onChange={setBrush}
            labelFor={(w) => playText.drawAndGuess.brush(w)}
          />
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
            <Button
              title={playText.drawAndGuess.undo}
              variant="secondary"
              style={{ flex: 1 }}
              onPress={() => dispatch('undo', null)}
              disabled={!live || state.strokes.length === 0}
              disabledReason={
                !live ? playText.room.waitingForLink : state.strokes.length === 0 ? playText.drawAndGuess.nothingToUndo : undefined
              }
            />
            <Button
              title={playText.drawAndGuess.clear}
              variant="secondary"
              style={{ flex: 1 }}
              onPress={() => dispatch('clear', null)}
              disabled={!live || state.strokes.length === 0}
              disabledReason={
                !live ? playText.room.waitingForLink : state.strokes.length === 0 ? playText.drawAndGuess.nothingToUndo : undefined
              }
            />
          </View>
          <Button
            title={playText.drawAndGuess.endRound}
            variant="ghost"
            onPress={() => dispatch('endRound', null)}
            disabled={!live}
            disabledReason={live ? undefined : playText.room.waitingForLink}
          />
        </View>
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
            <TextInput
              accessibilityLabel={playText.drawAndGuess.guessPlaceholder}
              placeholder={playText.drawAndGuess.guessPlaceholder}
              placeholderTextColor={theme.colors.textTertiary}
              value={guess}
              onChangeText={setGuess}
              onSubmitEditing={send}
              editable={live && !solved && !finished}
              maxLength={MAX_GUESS_LENGTH}
              returnKeyType="send"
              autoCorrect={false}
              style={{
                flex: 1,
                minHeight: MIN_TARGET,
                paddingHorizontal: theme.spacing.md,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surfaceElevated,
                color: theme.colors.text,
                fontSize: theme.typography.body.fontSize,
              }}
            />
            <Button
              title={playText.drawAndGuess.guessSend}
              onPress={send}
              disabled={!live || solved || guess.trim().length === 0}
              disabledReason={
                !live ? playText.room.waitingForLink : solved ? playText.drawAndGuess.solved : undefined
              }
            />
          </View>
          {solved ? <Hint text={playText.drawAndGuess.solved} /> : null}
        </View>
      )}

      <View style={{ height: theme.spacing.lg }} />
      <Divider />
      <View style={{ height: theme.spacing.md }} />

      <Label variant="caption" tone="tertiary">
        {playText.drawAndGuess.guessesTitle.toUpperCase()}
      </Label>
      <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.sm }}>
        {state.guesses.length === 0 ? (
          <Label variant="footnote" tone="tertiary">
            {playText.drawAndGuess.noGuesses}
          </Label>
        ) : (
          state.guesses
            .slice()
            .reverse()
            .map((entry, index) => {
              const who = players[entry.player] ?? '';
              const name = who === local ? playText.room.you : nameFor(who);
              const body =
                entry.kind === GuessKind.CORRECT
                  ? playText.drawAndGuess.gotIt
                  : entry.kind === GuessKind.CLOSE
                  ? playText.drawAndGuess.close
                  : entry.text;
              return (
                <Label
                  key={`${index}-${entry.text}`}
                  variant="footnote"
                  tone={entry.kind === GuessKind.WRONG ? 'secondary' : 'connected'}
                >
                  {`${name}: ${body}`}
                </Label>
              );
            })
        )}
      </View>
    </View>
  );
}

/** A flat [x, y, x, y, ...] list, scaled into a Skia path. */
function toPath(points: readonly number[], scale: number): SkPath {
  const path = Skia.Path.Make();
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = (points[i] as number) * scale;
    const y = (points[i + 1] as number) * scale;
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  return path;
}

function Swatch({
  color,
  selected,
  label,
  onPress,
}: {
  color: string;
  selected: boolean;
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        width: MIN_TARGET,
        height: MIN_TARGET,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: selected ? 30 : 24,
          height: selected ? 30 : 24,
          borderRadius: theme.radius.pill,
          backgroundColor: color,
          borderWidth: selected ? 2 : 0,
          borderColor: theme.colors.background,
        }}
      />
    </Pressable>
  );
}
