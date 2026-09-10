import React from 'react';
import { ScrollView, View } from 'react-native';
import { avatarColorFor, strings } from '@airlink/config';
import { Avatar, Gap, Label, useTheme } from '../../ui/index.js';
import { colorName } from './avatars.js';
import { ColorPalette } from './ColorPalette.js';

/**
 * Choose an avatar colour.
 *
 * Deliberately optional and deliberately low-stakes: the automatic colour,
 * derived from the peer id, already looks right, so Skip has to feel like a
 * perfectly good answer rather than a failure. See avatars.ts for why this
 * offers colours rather than emoji.
 */
export function AvatarStep({
  width,
  name,
  peerId,
  color,
  onSelect,
}: {
  width: number;
  name: string;
  /**
   * The local peer id, once the keystore has answered. The automatic colour is
   * derived from it everywhere else in the app, so seeding from it here is what
   * makes the "Auto" swatch show the colour actually about to be used. Null
   * falls back to the name - one colour change is better than a preview that
   * waits.
   */
  peerId: string | null;
  /** null means "whatever AirLink picks for me". */
  color: string | null;
  onSelect: (color: string | null) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const automatic = avatarColorFor(peerId ?? (name || 'you'));
  const shown = color ?? automatic;

  return (
    // Scrollable and centred, not a plain centred View. The two headings, the
    // 96pt preview and eleven 56pt swatches come to more than the content area
    // of a small phone once the system text size is turned up, and
    // `justifyContent: 'center'` splits an overflow in half - clipping the
    // title off the top and the last row of swatches off the bottom, with no
    // way to reach either.
    <ScrollView
      style={{ width }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.lg,
      }}
      showsVerticalScrollIndicator={false}
    >
      <Label variant="largeTitle" accessibilityRole="header">
        {strings.onboarding.avatarTitle}
      </Label>
      <Label variant="subheadline" tone="secondary">
        {strings.onboarding.avatarSubtitle}
      </Label>

      <Gap size="xxl" />
      <View style={{ alignItems: 'center' }}>
        <Avatar name={name || 'You'} color={shown} size={96} />
        <Gap size="md" />
        <Label variant="headline">{name}</Label>
        <Label variant="footnote" tone="tertiary">
          {color === null ? strings.onboarding.avatarAutomatic : colorName(shown)}
        </Label>
      </View>

      <Gap size="xxl" />
      <ColorPalette peerId={peerId} name={name} selected={color} onSelect={onSelect} />
    </ScrollView>
  );
}
