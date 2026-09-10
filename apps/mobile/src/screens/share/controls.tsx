import React from 'react';
import { Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Label, haptic, useTheme } from '../../ui/index.js';
import { KIND_GLYPH, type FileKind } from './presentation.js';

/**
 * The few controls the Share screens need that the design system does not have.
 *
 * Deliberately small and local. A progress bar and a file tile are the only two
 * pieces of vocabulary this feature adds, and both belong in `ui/primitives`
 * the moment a second feature wants them - which is why they take theme tokens
 * and nothing else, and hard-code nothing.
 */

/** The bar itself, in the 4pt scale. Thin: this is information, not decoration. */
const BAR_HEIGHT = 4;
/** Minimum iOS touch target, and the floor for every control in this file. */
const TOUCH_MIN = 44;
/**
 * The square that leads a file row. Exported because the hairline between two
 * rows is inset past it, and a separator that disagrees with the tile it lines
 * up under is the sort of thing nobody can name but everybody notices.
 */
export const TILE_SIZE = 44;

/**
 * A determinate progress bar.
 *
 * Determinate only, on purpose. Every long operation in this feature knows how
 * far along it is, and the one that does not - hashing a file before it is
 * offered - is a button in its loading state rather than a bar that could spin
 * forever.
 */
export function ProgressBar({
  percent,
  tone = 'accent',
  accessibilityLabel,
}: {
  percent: number;
  /** Paused draws grey: nothing is wrong, it is simply waiting for the link. */
  tone?: 'accent' | 'paused' | 'complete';
  accessibilityLabel: string;
}): React.JSX.Element {
  const theme = useTheme();
  const clamped = Math.max(0, Math.min(100, percent));
  const fill = {
    accent: theme.colors.accent,
    paused: theme.colors.disconnected,
    complete: theme.colors.connected,
  }[tone];

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped) }}
      style={{
        height: BAR_HEIGHT,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.surfaceElevated,
        overflow: 'hidden',
      }}
    >
      <View style={{ width: `${clamped}%`, height: '100%', borderRadius: theme.radius.pill, backgroundColor: fill }} />
    </View>
  );
}

/**
 * The square beside a filename.
 *
 * Shows the real photo when there is one to show, and a typographic mark
 * otherwise. The mark carries nothing a screen reader needs - the filename is
 * right beside it - so it is hidden from accessibility rather than read out as
 * a piece of punctuation.
 */
export function FileTile({
  kind,
  previewUri,
  size = 44,
  style,
}: {
  kind: FileKind;
  previewUri?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const theme = useTheme();
  const base: StyleProp<ViewStyle> = [
    {
      width: size,
      height: size,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surfaceElevated,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    style,
  ];

  if (previewUri) {
    return (
      <View style={base} accessible={false} importantForAccessibility="no-hide-descendants">
        <Image source={{ uri: previewUri }} style={{ width: size, height: size }} resizeMode="cover" />
      </View>
    );
  }

  return (
    <View style={base} accessible={false} importantForAccessibility="no-hide-descendants">
      <Text style={{ fontSize: size * 0.4, color: theme.colors.textSecondary }}>{KIND_GLYPH[kind]}</Text>
    </View>
  );
}

/**
 * A compact action at the end of a row.
 *
 * `Button` is the right control for a decision at the bottom of a screen; this
 * is for the one beside a filename, where a full-width 48pt button would shout.
 * It keeps the 44pt touch target by padding rather than by height, so the row
 * itself stays the size the content wants.
 */
export function RowAction({
  title,
  onPress,
  accessibilityLabel,
  tone = 'accent',
}: {
  title: string;
  onPress: () => void;
  accessibilityLabel: string;
  tone?: 'accent' | 'quiet';
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      hitSlop={theme.spacing.sm}
      style={({ pressed }) => [
        {
          minHeight: TOUCH_MIN,
          minWidth: TOUCH_MIN,
          paddingHorizontal: theme.spacing.md,
          alignItems: 'center',
          justifyContent: 'center',
        },
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      <Label variant="subheadline" tone={tone === 'accent' ? 'accent' : 'secondary'}>
        {title}
      </Label>
    </Pressable>
  );
}

/**
 * A row inside a card that can be chosen: the two pickers on Compose, and the
 * recipient list under them.
 *
 * A tick rather than a radio circle, because the app draws no controls of its
 * own anywhere else and a tick is the one mark iOS and Android agree on.
 */
export function ChoiceRow({
  title,
  subtitle,
  left,
  selected = false,
  disabled = false,
  /** 'radio' when the row is one of a set the user is choosing between. */
  role = 'button',
  onPress,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  subtitle?: string;
  left?: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  role?: 'radio' | 'button';
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          minHeight: 56,
          paddingVertical: theme.spacing.sm,
          opacity: disabled ? 0.45 : 1,
        },
        pressed && !disabled ? { opacity: 0.6 } : null,
      ]}
    >
      {left}
      <View style={{ flex: 1 }}>
        <Label variant="body" numberOfLines={1}>
          {title}
        </Label>
        {subtitle ? (
          <Label variant="footnote" tone="secondary" numberOfLines={1}>
            {subtitle}
          </Label>
        ) : null}
      </View>
      {selected ? (
        <Label variant="headline" tone="accent">
          ✓
        </Label>
      ) : null}
    </Pressable>
  );
}

/** Hairline between rows inside a card, inset past whatever leads the row. */
export function RowSeparator({ inset = 0 }: { inset?: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        marginLeft: inset,
        backgroundColor: theme.colors.separator,
      }}
    />
  );
}
