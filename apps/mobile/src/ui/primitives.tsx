import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from './Icon.js';
import { avatarColorFor, initialsFor } from '@airlink/config';
import { useTheme } from './theme.js';
import { haptic } from './haptics.js';

/**
 * The design system.
 *
 * The look is the one Apple, Linear and Arc share: a quiet surface, generous
 * space, one confident accent, and type doing the work rather than decoration.
 * Games live inside this app, but the app is not a toy.
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Screen({
  children,
  scroll = false,
  padded = true,
  /**
   * Inset the top for the status bar and notch.
   *
   * On by default. A screen mounted inside a navigator that draws its own header
   * already sits below the notch and should pass false, or its content ends up
   * pushed down twice. A screen with no header - Home, the tabs - needs it, and
   * without it the wordmark sits on top of the clock.
   */
  safeTop = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  safeTop?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const content: StyleProp<ViewStyle> = [
    padded ? { paddingHorizontal: theme.spacing.lg } : null,
    safeTop ? { paddingTop: insets.top + theme.spacing.sm } : null,
    { paddingBottom: insets.bottom + theme.spacing.lg },
    style,
  ];

  if (scroll) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    );
  }
  return <View style={[{ flex: 1, backgroundColor: theme.colors.background }, content]}>{children}</View>;
}

/** Vertical spacer. Explicit beats a stray marginBottom. */
export function Gap({ size = 'md' }: { size?: keyof typeof import('@airlink/config').spacing }): React.JSX.Element {
  const theme = useTheme();
  return <View style={{ height: theme.spacing[size] }} />;
}

export function Row({
  children,
  gap = 'md',
  align = 'center',
  style,
}: {
  children: React.ReactNode;
  gap?: keyof typeof import('@airlink/config').spacing;
  align?: ViewStyle['alignItems'];
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[{ flexDirection: 'row', alignItems: align, gap: theme.spacing[gap] }, style]}>{children}</View>
  );
}

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

type TypeVariant = keyof typeof import('@airlink/config').typography;

export function Label({
  children,
  variant = 'body',
  tone = 'primary',
  align,
  numberOfLines,
  style,
  accessibilityRole,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  variant?: TypeVariant;
  tone?: 'primary' | 'secondary' | 'tertiary' | 'accent' | 'danger' | 'onAccent' | 'connected';
  align?: TextStyle['textAlign'];
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  /**
   * Forwarded to the underlying `Text`.
   *
   * Present because the alternative was worse. Without them, marking a heading
   * as a heading meant wrapping it in `<View accessible accessibilityRole=
   * "header">` - and `accessible` on a View collapses everything inside it into
   * a single node, which silently swallowed a caption that was the only line
   * stating the current choice. A role belongs on the text that has it.
   */
  accessibilityRole?: 'header' | 'text' | 'link' | 'summary';
  accessibilityLabel?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const colorByTone = {
    primary: theme.colors.text,
    secondary: theme.colors.textSecondary,
    tertiary: theme.colors.textTertiary,
    accent: theme.colors.accent,
    danger: theme.colors.danger,
    onAccent: theme.colors.onAccent,
    connected: theme.colors.connected,
  };
  return (
    <Text
      style={[theme.typography[variant] as TextStyle, { color: colorByTone[tone] }, align ? { textAlign: align } : null, style]}
      numberOfLines={numberOfLines}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
    >
      {children}
    </Text>
  );
}

/** A small uppercase section heading, as used above "NEARBY FRIENDS". */
export function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text
      style={[
        theme.typography.caption as TextStyle,
        { color: theme.colors.textTertiary, letterSpacing: 1.2, marginBottom: theme.spacing.sm },
      ]}
    >
      {String(children).toUpperCase()}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  children,
  onPress,
  style,
  elevated = true,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  elevated?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const base: StyleProp<ViewStyle> = [
    {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.separator,
    },
    elevated ? theme.shadows.card : null,
    style,
  ];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => [base, pressed ? { opacity: 0.7, transform: [{ scale: 0.99 }] } : null]}
    >
      {children}
    </Pressable>
  );
}

export function Divider(): React.JSX.Element {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.separator }} />;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  /** Why the button is disabled. Shown under it - never leave the user guessing. */
  disabledReason,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  disabledReason?: string;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const theme = useTheme();
  const inactive = disabled || loading;

  const background = {
    primary: theme.colors.accent,
    secondary: theme.colors.surfaceElevated,
    ghost: 'transparent',
    danger: theme.colors.danger,
  }[variant];

  const textTone = variant === 'primary' || variant === 'danger' ? 'onAccent' : variant === 'ghost' ? 'accent' : 'primary';

  return (
    <View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: inactive }}
        disabled={inactive}
        onPress={() => {
          haptic(variant === 'danger' ? 'warning' : 'impactLight');
          onPress();
        }}
        style={({ pressed }) => [
          {
            backgroundColor: background,
            borderRadius: theme.radius.md,
            paddingVertical: theme.spacing.md + 2,
            paddingHorizontal: theme.spacing.lg,
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 48,
            opacity: inactive ? 0.45 : 1,
          },
          pressed ? { opacity: 0.75 } : null,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={variant === 'primary' || variant === 'danger' ? theme.colors.onAccent : theme.colors.accent} />
        ) : (
          <Label variant="headline" tone={textTone}>
            {title}
          </Label>
        )}
      </Pressable>
      {disabled && disabledReason ? (
        <Label variant="footnote" tone="tertiary" align="center" style={{ marginTop: theme.spacing.xs }}>
          {disabledReason}
        </Label>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function Avatar({
  name,
  peerId,
  color,
  size = 44,
}: {
  name: string;
  peerId?: string | null;
  /** A chosen colour. Null or absent means derive one, which is the default. */
  color?: string | null;
  size?: number;
}): React.JSX.Element {
  // Initials on a colour, and nothing else. An avatar built out of an emoji is
  // only as reliable as the font behind it, and a glyph the font does not have
  // draws as an empty box with no way to detect it at runtime - so the identity
  // people see is drawn entirely from type the app is already rendering.
  //
  // Without a choice the colour is derived from the peer id, so a friend's
  // colour never changes and two people with the same name still look
  // different.
  const background = color ?? avatarColorFor(peerId ?? name);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: size * 0.38, fontWeight: '600', color: '#FFFFFF' }}>{initialsFor(name)}</Text>
    </View>
  );
}

export type StatusTone = 'connected' | 'connecting' | 'disconnected' | 'warning';

/** The small coloured dot next to a name. The whole status vocabulary. */
export function StatusDot({ tone, size = 8 }: { tone: StatusTone; size?: number }): React.JSX.Element {
  const theme = useTheme();
  const color = {
    connected: theme.colors.connected,
    connecting: theme.colors.connecting,
    disconnected: theme.colors.disconnected,
    warning: theme.colors.warning,
  }[tone];
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

// ---------------------------------------------------------------------------
// Lists and empty states
// ---------------------------------------------------------------------------

export function ListRow({
  title,
  subtitle,
  left,
  right,
  onPress,
  destructive = false,
}: {
  title: string;
  subtitle?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  onPress?: () => void;
  destructive?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        minHeight: 56,
      }}
    >
      {left}
      <View style={{ flex: 1 }}>
        <Label variant="body" tone={destructive ? 'danger' : 'primary'} numberOfLines={1}>
          {title}
        </Label>
        {subtitle ? (
          <Label variant="footnote" tone="secondary" numberOfLines={1}>
            {subtitle}
          </Label>
        ) : null}
      </View>
      {right}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
    >
      {body}
    </Pressable>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  /**
   * A name from the drawn icon set, not a character. An empty state whose icon
   * is a missing-glyph box is worse than one with no icon at all, and that is
   * what every text icon in this app turned out to be - see ui/Icon.tsx.
   */
  icon: IconName;
  title: string;
  body?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: theme.spacing.xxxl, paddingHorizontal: theme.spacing.xl }}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ marginBottom: theme.spacing.lg }}
      >
        {/* Decorative: the title below says the same thing in words, so
            announcing the icon as well would say it twice. */}
        <Icon name={icon} size={44} color={theme.colors.textSecondary} />
      </View>
      <Label variant="headline" align="center">
        {title}
      </Label>
      {body ? (
        <Label variant="subheadline" tone="secondary" align="center" style={{ marginTop: theme.spacing.xs }}>
          {body}
        </Label>
      ) : null}
      {action ? <View style={{ marginTop: theme.spacing.lg }}>{action}</View> : null}
    </View>
  );
}

/**
 * The offline banner.
 *
 * Deliberately not an error. AirLink is FOR being offline, so no internet is the
 * normal state and is shown in the same calm grey as everything else. The only
 * red in the app is a genuine failure.
 */
export function StatusBanner({
  tone,
  title,
  detail,
  action,
}: {
  tone: StatusTone;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        backgroundColor: theme.colors.surfaceElevated,
        borderRadius: theme.radius.md,
        paddingVertical: theme.spacing.sm + 2,
        paddingHorizontal: theme.spacing.md,
      }}
    >
      <StatusDot tone={tone} />
      <View style={{ flex: 1 }}>
        <Label variant="footnote">{title}</Label>
        {detail ? (
          <Label variant="caption" tone="tertiary">
            {detail}
          </Label>
        ) : null}
      </View>
      {action}
    </View>
  );
}
