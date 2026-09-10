import React, { useEffect, useRef } from 'react';
import { Keyboard, TextInput, View, type TextInputInstance, type TextStyle } from 'react-native';
import { strings } from '@airlink/config';
import { Gap, Label, useTheme } from '../../ui/index.js';
import { MAX_NAME_LENGTH } from './name.js';

/**
 * One field, one sentence explaining what it is for.
 *
 * The keyboard is raised when the step becomes the visible one rather than on
 * mount: every step is mounted at once so the pager can be swiped, and a field
 * two pages away must not steal focus.
 */
const FOCUS_DELAY_MS = 320;

export function NameStep({
  width,
  active,
  value,
  onChange,
  onSubmit,
}: {
  width: number;
  /** True when this is the step the user is actually looking at. */
  active: boolean;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  // `TextInput` is a function component under the New Architecture, so the ref
  // holds the host instance type rather than the component itself.
  const input = useRef<TextInputInstance>(null);

  useEffect(() => {
    if (!active) {
      Keyboard.dismiss();
      return;
    }
    // Waiting out the page transition; focusing mid-scroll fights the animation.
    const timer = setTimeout(() => input.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active]);

  return (
    <View style={{ width, flex: 1, justifyContent: 'center', paddingHorizontal: theme.spacing.lg }}>
      <View accessible accessibilityRole="header">
        <Label variant="title">{strings.onboarding.nameTitle}</Label>
      </View>
      <Gap size="sm" />
      <Label variant="subheadline" tone="secondary">
        {strings.onboarding.nameSubtitle}
      </Label>

      <Gap size="xl" />

      <TextInput
        ref={input}
        value={value}
        onChangeText={onChange}
        onSubmitEditing={onSubmit}
        placeholder={strings.onboarding.namePlaceholder}
        placeholderTextColor={theme.colors.textTertiary}
        maxLength={MAX_NAME_LENGTH}
        autoCapitalize="words"
        autoCorrect={false}
        autoComplete="name"
        textContentType="nickname"
        returnKeyType="done"
        submitBehavior="submit"
        accessibilityLabel={strings.onboarding.namePlaceholder}
        selectionColor={theme.colors.accent}
        style={[
          theme.typography.title2 as TextStyle,
          {
            color: theme.colors.text,
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radius.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            minHeight: theme.spacing.xxxl,
          },
        ]}
      />
    </View>
  );
}
