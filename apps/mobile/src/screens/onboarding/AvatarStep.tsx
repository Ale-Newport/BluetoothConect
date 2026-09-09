import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { initialsFor, strings } from '@airlink/config';
import { Avatar, Gap, Label, haptic, useTheme } from '../../ui/index.js';
import { AVATAR_EMOJI } from './avatars.js';
import { onboardingCopy } from './copy.js';

/**
 * Optional, and it has to feel optional.
 *
 * The initials are the first tile rather than an absence, so choosing them is a
 * choice like any other and Skip is not a door marked "gave up". The preview is
 * the real `Avatar`, so what you see here is exactly what a friend's phone will
 * draw in a list row.
 */
export function AvatarStep({
  width,
  name,
  emoji,
  onSelect,
}: {
  width: number;
  name: string;
  emoji: string | null;
  onSelect: (emoji: string | null) => void;
}): React.JSX.Element {
  const theme = useTheme();

  // 44pt is the floor for a touch target; this sits comfortably above it and
  // still fits five to a row on the narrowest phone we support.
  const tile = theme.spacing.xxxl + theme.spacing.md;
  const preview = theme.spacing.xxxl * 2;

  const choose = (next: string | null): void => {
    haptic('selection');
    onSelect(next);
  };

  const tileStyle = (selected: boolean): StyleSheet.NamedStyles<never>[string] => ({
    width: tile,
    height: tile,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: selected ? theme.colors.accent : theme.colors.separator,
    backgroundColor: selected ? theme.colors.accent : theme.colors.surface,
  });

  return (
    <View style={{ width, flex: 1, justifyContent: 'center', paddingHorizontal: theme.spacing.lg }}>
      <View accessible accessibilityRole="header">
        <Label variant="title">{strings.onboarding.avatarTitle}</Label>
      </View>
      <Gap size="sm" />
      <Label variant="subheadline" tone="secondary">
        {strings.onboarding.avatarSubtitle}
      </Label>

      <Gap size="xl" />

      <View accessible accessibilityLabel={name} style={{ alignItems: 'center' }}>
        <Avatar name={name} emoji={emoji} size={preview} />
        <Gap size="sm" />
        <Label variant="headline" align="center" numberOfLines={1}>
          {name}
        </Label>
        <Label variant="footnote" tone="tertiary" align="center">
          {emoji ? strings.onboarding.avatarTitle : onboardingCopy.useInitials}
        </Label>
      </View>

      <Gap size="xl" />

      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={onboardingCopy.useInitials}
          accessibilityState={{ selected: emoji === null }}
          onPress={() => choose(null)}
          style={({ pressed }) => [tileStyle(emoji === null), pressed ? { opacity: 0.7 } : null]}
        >
          <Label variant="headline" tone={emoji === null ? 'onAccent' : 'secondary'}>
            {initialsFor(name)}
          </Label>
        </Pressable>

        {AVATAR_EMOJI.map((option) => {
          const selected = option === emoji;
          return (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityLabel={option}
              accessibilityState={{ selected }}
              onPress={() => choose(option)}
              style={({ pressed }) => [tileStyle(selected), pressed ? { opacity: 0.7 } : null]}
            >
              <Text style={{ fontSize: theme.spacing.xl }}>{option}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
