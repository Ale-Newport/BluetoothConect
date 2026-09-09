import React from 'react';
import { Animated, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Divider, Label, StatusDot, haptic, useTheme } from '../../ui/index.js';

/**
 * Two small controls the design system does not have yet.
 *
 * `Button` is the right size for a decision at the bottom of a screen and too
 * heavy for a list row or a status banner, so these fill the gap. They take the
 * same tokens and the same accessibility rules: a real role, a real label, and
 * a touch target no smaller than 44pt even where the ink is smaller than that.
 */

const MIN_TARGET = 44;

/** A text action inside a banner or a row. Quiet ink, full-size target. */
export function InlineAction({
  title,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  accessibilityLabel?: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      hitSlop={theme.spacing.md}
      style={({ pressed }) => [
        { minHeight: MIN_TARGET, justifyContent: 'center', paddingHorizontal: theme.spacing.xs },
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      <Label variant="footnote" tone="accent">
        {title}
      </Label>
    </Pressable>
  );
}

/** The pill on the right of a row that is not connected yet. */
export function ConnectChip({
  title,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  accessibilityLabel: string;
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
      style={({ pressed }) => [
        {
          minHeight: MIN_TARGET,
          justifyContent: 'center',
          paddingHorizontal: theme.spacing.lg,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.accentMuted,
        },
        pressed ? { opacity: 0.7 } : null,
      ]}
    >
      <Label variant="footnote" tone="accent">
        {title}
      </Label>
    </Pressable>
  );
}

/**
 * A dot that breathes while we are looking for people.
 *
 * Deliberately not a spinner: a spinner reads as "something is loading and will
 * finish", and discovery never finishes - it keeps listening for as long as the
 * screen is open. A slow pulse says "still listening" without demanding
 * attention.
 */
export function PulsingDot({ style }: { style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const theme = useTheme();
  const pulse = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: theme.motion.slow, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: theme.motion.slow, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, theme.motion.slow]);

  return (
    <Animated.View
      // Decorative: the words next to it already say what is happening.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }],
        },
        style,
      ]}
    >
      <StatusDot tone="connecting" />
    </Animated.View>
  );
}

/** A hairline between rows, inset past the avatar so the list reads as a group. */
export function RowSeparator({ inset }: { inset: number }): React.JSX.Element {
  return (
    <View style={{ paddingLeft: inset }}>
      <Divider />
    </View>
  );
}
