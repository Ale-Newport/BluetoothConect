import React from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { brand, strings } from '@airlink/config';
import { Gap, Label, useTheme } from '../../ui/index.js';

/**
 * The first thing anyone sees.
 *
 * The one screen in the app allowed to be a little beautiful. Everything
 * arrives rather than appearing: the mark, then the promise, then the three
 * lines, each a beat behind the last, so the last one - "No problem." - lands
 * as a punchline rather than a bullet.
 *
 * These are Reanimated's own entering animations rather than hand-written
 * worklets, so the entrance runs on the UI thread without this screen needing
 * anything of its own compiled into a worklet. They also honour the system
 * "reduce motion" setting by default, which a hand-rolled fade would not.
 */
const MARK_DELAY = 80;
const PROMISE_DELAY = 220;
const POINTS_DELAY = 460;
const POINT_STAGGER = 130;

export function WelcomeStep({ width }: { width: number }): React.JSX.Element {
  const theme = useTheme();
  const points = strings.onboarding.welcomePoints;
  const lastIndex = points.length - 1;

  return (
    <View
      style={{
        width,
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      {/* The mark reads as a letterhead, so the accent is saved for the line
          that earns it further down. Read aloud as the full welcome, because
          "A I R L I N K" is not what a screen reader should say here. */}
      <Animated.View
        accessible
        accessibilityRole="header"
        accessibilityLabel={strings.onboarding.welcomeTitle}
        entering={FadeIn.delay(MARK_DELAY).duration(theme.motion.slow)}
      >
        <Label variant="wordmark" tone="tertiary">
          {brand.wordmark}
        </Label>
      </Animated.View>

      <Gap size="xl" />

      <Animated.View entering={FadeInDown.delay(PROMISE_DELAY).duration(theme.motion.slow)}>
        <Label variant="largeTitle">{strings.onboarding.welcomeBody}</Label>
      </Animated.View>

      <Gap size="xxl" />

      <View style={{ gap: theme.spacing.xs }}>
        {points.map((point, index) => (
          <Animated.View
            key={point}
            entering={FadeInDown.delay(POINTS_DELAY + index * POINT_STAGGER).duration(theme.motion.slow)}
          >
            <Label variant="title2" tone={index === lastIndex ? 'accent' : 'secondary'}>
              {point}
            </Label>
          </Animated.View>
        ))}
      </View>
    </View>
  );
}
