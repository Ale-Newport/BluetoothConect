import React from 'react';
import { Pressable, View } from 'react-native';
import { avatarColorFor, strings } from '@airlink/config';
import { Label, haptic, useTheme } from '../../ui/index.js';
import { AVATAR_COLORS, colorName } from './avatars.js';

/**
 * The colour picker, in one place.
 *
 * Onboarding and Settings both offer it, and they used to draw it twice with a
 * comment on each saying they must not drift. They had already drifted: the
 * Settings copy showed the automatic option as a plain swatch, so it was
 * indistinguishable from a chosen colour - and since the automatic colour comes
 * out of the same palette, it appeared as two identical swatches with no way to
 * tell which was which.
 *
 * A circle of the colour is the whole control. A rounded tile containing a
 * circle was two shapes doing one job, and the ring alone says "selected"
 * perfectly well.
 */
export function ColorPalette({
  /** The peer id, so the automatic swatch shows the colour actually derived. */
  peerId,
  /** Falls back to seeding the automatic colour when there is no peer id yet. */
  name,
  selected,
  onSelect,
  size = 56,
}: {
  peerId: string | null;
  name: string;
  selected: string | null;
  onSelect: (color: string | null) => void;
  size?: number;
}): React.JSX.Element {
  const theme = useTheme();
  const automatic = avatarColorFor(peerId ?? (name || 'you'));

  const swatch = (value: string | null): React.JSX.Element => {
    const resolved = value ?? automatic;
    const isSelected = value === selected;
    return (
      <Pressable
        key={value ?? 'auto'}
        accessibilityRole="button"
        // Never colour alone: each swatch says which colour it is, and the
        // automatic one says what it means rather than what it looks like.
        accessibilityLabel={value === null ? strings.onboarding.avatarAutomatic : colorName(resolved)}
        accessibilityState={{ selected: isSelected }}
        onPress={() => {
          haptic('selection');
          onSelect(value);
        }}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: resolved,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: isSelected ? 3 : 0,
          borderColor: theme.colors.text,
        }}
      >
        {value === null ? (
          <Label variant="caption" tone="onAccent">
            {strings.onboarding.avatarAutoShort}
          </Label>
        ) : null}
      </Pressable>
    );
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.spacing.md,
        justifyContent: 'center',
      }}
    >
      {swatch(null)}
      {AVATAR_COLORS.map((value) => swatch(value))}
    </View>
  );
}
