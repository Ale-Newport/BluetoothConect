import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useTheme } from '../../ui/index.js';
import { onboardingCopy } from './copy.js';

/**
 * Four segments, one per step.
 *
 * Animated with React Native's own `Animated` rather than Reanimated: this is a
 * two-property fade that never has to keep up with a finger, and keeping it off
 * the worklet runtime means the progress indicator cannot be the thing that
 * stutters while the keyboard is coming up.
 */
function Segment({ filled }: { filled: boolean }): React.JSX.Element {
  const theme = useTheme();
  const fill = useRef(new Animated.Value(filled ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(fill, {
      toValue: filled ? 1 : 0,
      duration: theme.motion.standard,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [filled, fill, theme.motion.standard]);

  return (
    <View
      style={{
        flex: 1,
        height: theme.spacing.xs,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.separator,
        overflow: 'hidden',
      }}
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.accent, opacity: fill }]}
      />
    </View>
  );
}

export function ProgressBar({ step, total }: { step: number; total: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={onboardingCopy.stepProgress(step + 1, total)}
      accessibilityValue={{ min: 1, max: total, now: step + 1 }}
      style={{ flexDirection: 'row', gap: theme.spacing.sm }}
    >
      {Array.from({ length: total }, (_, index) => (
        <Segment key={index} filled={index <= step} />
      ))}
    </View>
  );
}
