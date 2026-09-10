import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { PlayerId } from '@airlink/games';
import { Avatar, Label, StatusDot, haptic, useTheme } from '../../ui/index.js';
import { playText } from './strings.js';

/**
 * The vocabulary every board is drawn from.
 *
 * Twelve games could easily have looked like twelve apps. They do not, because
 * every one of them uses the same surface, the same two inks, the same player
 * bar and the same hint line - so a chess board and a dartboard read as two
 * views of one product rather than two products.
 *
 * The two inks are the whole colour story. AirLink has ONE accent, so the
 * device's own player owns it and the opponent takes the strongest neutral in
 * the palette. That is the same convention as an outgoing and an incoming chat
 * bubble, it survives both schemes without a second thought, and it means no
 * game ever has to invent a colour.
 */

/** The smallest touch target Apple will defend, and so the smallest we ship. */
export const MIN_TARGET = 44;

export interface Ink {
  /** The device's own player. */
  readonly mine: string;
  /** Everybody else. */
  readonly theirs: string;
  /** A square, a cell, an empty seat. */
  readonly empty: string;
  /** The line around a board and between its cells. */
  readonly rule: string;
  /** The board itself. */
  readonly felt: string;
}

export function useInk(): Ink {
  const theme = useTheme();
  return {
    mine: theme.colors.accent,
    theirs: theme.colors.text,
    empty: theme.colors.surfaceElevated,
    rule: theme.colors.separator,
    felt: theme.colors.surface,
  };
}

/** The ink for one player, from the point of view of this device. */
export function inkFor(ink: Ink, player: PlayerId | null, local: PlayerId): string {
  if (player === null) return ink.empty;
  return player === local ? ink.mine : ink.theirs;
}

// ---------------------------------------------------------------------------
// Chrome around a board
// ---------------------------------------------------------------------------

/**
 * The two players, their scores, and a dot on whoever is to move.
 *
 * Deliberately not a "VS" banner. It is a status line: it answers "whose turn"
 * and "what is the score" at a glance and then gets out of the way.
 */
export function PlayerBar({
  players,
  local,
  turn,
  nameFor,
  scoreFor,
  captionFor,
}: {
  players: readonly PlayerId[];
  local: PlayerId;
  turn: PlayerId | null;
  nameFor: (player: PlayerId) => string;
  /** A number to show next to the name, or null for games without a running score. */
  scoreFor?: (player: PlayerId) => number | null;
  /** A word under the name: "Ready", "3 darts left". */
  captionFor?: (player: PlayerId) => string | null;
}): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
      {players.map((player) => {
        const isLocal = player === local;
        const name = isLocal ? playText.room.you : nameFor(player);
        const score = scoreFor?.(player) ?? null;
        const caption = captionFor?.(player) ?? null;
        const active = turn === player;
        return (
          <View
            key={player}
            accessible
            accessibilityLabel={[
              name,
              score === null ? null : `${playText.room.score} ${score}`,
              caption,
              active ? (isLocal ? undefined : undefined) : undefined,
            ]
              .filter((part): part is string => typeof part === 'string')
              .join(', ')}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.sm,
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.md,
              borderRadius: theme.radius.md,
              backgroundColor: active ? theme.colors.surfaceElevated : 'transparent',
            }}
          >
            <View
              style={{
                width: theme.spacing.xs,
                alignSelf: 'stretch',
                borderRadius: theme.radius.sm,
                backgroundColor: isLocal ? ink.mine : ink.theirs,
              }}
            />
            <View style={{ flex: 1 }}>
              <Label variant="footnote" numberOfLines={1}>
                {name}
              </Label>
              {caption ? (
                <Label variant="caption" tone="tertiary" numberOfLines={1}>
                  {caption}
                </Label>
              ) : null}
            </View>
            {score === null ? null : (
              <Label variant="headline" tone={isLocal ? 'accent' : 'primary'}>
                {score}
              </Label>
            )}
          </View>
        );
      })}
    </View>
  );
}

/**
 * The board itself: a quiet raised square with a hairline round it.
 *
 * `size` is computed by the renderer from the width the room hands it, never
 * measured, so the board is laid out correctly on its very first frame instead
 * of appearing at the wrong size and snapping.
 */
export function BoardSurface({
  size,
  children,
  padded = true,
  style,
  accessibilityLabel,
}: {
  size: number;
  children: React.ReactNode;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
      style={[
        {
          width: size,
          alignSelf: 'center',
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.separator,
          padding: padded ? theme.spacing.sm : 0,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** One line of quiet guidance under a board. Never shouts, never blocks. */
export function Hint({ text, tone = 'tertiary' }: { text: string; tone?: 'tertiary' | 'secondary' }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Label variant="footnote" tone={tone} align="center" style={{ marginTop: theme.spacing.md }}>
      {text}
    </Label>
  );
}

/**
 * A square on a board.
 *
 * Cells are frequently smaller than 44pt - a chess square on a phone is about
 * 40 - so `hitSlop` makes up the difference rather than the board being drawn
 * too big to fit. Every cell carries its own label, because a screen reader
 * moving across a grid of unlabelled buttons is useless.
 */
export function Cell({
  size,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityState,
  style,
  children,
}: {
  size: number;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  accessibilityState?: { disabled?: boolean; selected?: boolean };
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}): React.JSX.Element {
  const slop = Math.max(0, (MIN_TARGET - size) / 2);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled || !onPress, ...accessibilityState }}
      disabled={disabled || !onPress}
      hitSlop={slop}
      onPress={
        onPress
          ? () => {
              haptic('selection');
              onPress();
            }
          : undefined
      }
      style={({ pressed }) => [
        { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
        style,
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      {children}
    </Pressable>
  );
}

/**
 * A pill of choices - a promotion piece, a brush, a ship.
 *
 * Small, quiet, and always at least 44pt tall, which is why it is a component
 * rather than five inline Pressables in five different renderers.
 */
export function ChipRow<T extends string | number>({
  options,
  value,
  onChange,
  labelFor,
  accessibilityLabelFor,
  disabled = false,
}: {
  options: readonly T[];
  value: T | null;
  onChange: (next: T) => void;
  labelFor: (option: T) => string;
  accessibilityLabelFor?: (option: T) => string;
  disabled?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
      {options.map((option) => {
        const selected = option === value;
        return (
          <Pressable
            key={String(option)}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabelFor?.(option) ?? labelFor(option)}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => {
              haptic('selection');
              onChange(option);
            }}
            style={({ pressed }) => [
              {
                minHeight: MIN_TARGET,
                justifyContent: 'center',
                paddingHorizontal: theme.spacing.lg,
                borderRadius: theme.radius.pill,
                backgroundColor: selected ? theme.colors.accent : theme.colors.surfaceElevated,
                opacity: disabled ? 0.45 : 1,
              },
              pressed ? { opacity: 0.7 } : null,
            ]}
          >
            <Label variant="footnote" tone={selected ? 'onAccent' : 'primary'}>
              {labelFor(option)}
            </Label>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A person, for a waiting or a result state. */
export function FaceOff({
  players,
  local,
  nameFor,
}: {
  players: readonly PlayerId[];
  local: PlayerId;
  nameFor: (player: PlayerId) => string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.spacing.lg }}>
      {players.map((player) => (
        <View key={player} style={{ alignItems: 'center', gap: theme.spacing.xs }}>
          <Avatar name={player === local ? playText.room.you : nameFor(player)} peerId={player} size={48} />
          <Label variant="footnote" tone="secondary" numberOfLines={1}>
            {player === local ? playText.room.you : nameFor(player)}
          </Label>
        </View>
      ))}
    </View>
  );
}

/** The dot the room uses to say the link is up, down or coming back. */
export function LiveDot({ live }: { live: boolean }): React.JSX.Element {
  return <StatusDot tone={live ? 'connected' : 'connecting'} />;
}
