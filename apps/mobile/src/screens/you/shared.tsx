import React from 'react';
import { Clipboard, Modal, Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PairingMethod, type TrustedPeer } from '@airlink/core';
import { strings } from '@airlink/config';
import { Card, Divider, Label, haptic, useTheme } from '../../ui/index.js';
import { local } from './localStrings.js';

/**
 * Pieces shared by the five "You" screens.
 *
 * Everything here composes `ui/primitives` rather than replacing it. Two things
 * are built rather than imported, and both for a reason worth stating:
 *
 *  - `NavRow` exists because `ListRow` takes no `onLongPress` and sets no
 *    accessibility role or label on its pressable. Both are required here: the
 *    friend list needs a long press, and every control in this app must be
 *    reachable by a screen reader.
 *  - `Sheet` and `PageModal` exist because the route map has no Privacy route
 *    and no per-friend action route, and the navigator is not ours to edit.
 */

// ---------------------------------------------------------------------------
// Rows and groups
// ---------------------------------------------------------------------------

export function NavRow({
  title,
  subtitle,
  caption,
  left,
  right,
  onPress,
  onLongPress,
  destructive = false,
  accessibilityHint,
}: {
  title: string;
  subtitle?: string;
  caption?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  destructive?: boolean;
  accessibilityHint?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        // 44pt is the smallest target a finger can be asked to hit; rows here
        // run a little taller because they carry two lines of type.
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
        {caption ? (
          <Label variant="caption" tone="tertiary" numberOfLines={1}>
            {caption}
          </Label>
        ) : null}
      </View>
      {right}
    </View>
  );

  if (!onPress && !onLongPress) return body;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, caption].filter(Boolean).join(', ')}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      onPress={
        onPress
          ? () => {
              haptic('selection');
              onPress();
            }
          : undefined
      }
      onLongPress={
        onLongPress
          ? () => {
              haptic('impactLight');
              onLongPress();
            }
          : undefined
      }
      style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
    >
      {body}
    </Pressable>
  );
}

/** A card of rows with hairlines between them. The iOS grouped-list shape. */
export function Group({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const theme = useTheme();
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <Card style={[{ paddingVertical: 0 }, style]}>
      {items.map((child, index) => (
        <View key={index}>
          {index > 0 ? <Divider /> : null}
          {child}
        </View>
      ))}
    </Card>
  );
}

/** The disclosure mark. Type rather than an icon set we do not have yet. */
export function Chevron(): React.JSX.Element {
  return (
    <Label variant="body" tone="tertiary">
      ›
    </Label>
  );
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

/** A bottom sheet of choices. Used where a route would be overkill. */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.common.close}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' }}
      >
        {/* Taps inside the sheet must not reach the scrim behind it. */}
        <View
          onStartShouldSetResponder={() => true}
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.xl,
              borderTopRightRadius: theme.radius.xl,
              paddingHorizontal: theme.spacing.lg,
              paddingTop: theme.spacing.lg,
              paddingBottom: insets.bottom + theme.spacing.lg,
            },
            theme.shadows.sheet,
          ]}
        >
          <Label variant="headline">{title}</Label>
          {subtitle ? (
            <Label variant="footnote" tone="secondary" style={{ marginTop: theme.spacing.xs }}>
              {subtitle}
            </Label>
          ) : null}
          <View style={{ marginTop: theme.spacing.md }}>{children}</View>
        </View>
      </Pressable>
    </Modal>
  );
}

/**
 * A full page presented over the tab bar.
 *
 * Privacy and the security overview have no entry in `navigation/routes.ts`,
 * and the navigator belongs to another agent. This gives them a real page
 * without inventing a route.
 */
export function PageModal({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.colors.separator,
          }}
        >
          <Label variant="headline" style={{ flex: 1 }}>
            {title}
          </Label>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.common.done}
            onPress={onClose}
            style={({ pressed }) => [
              { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <Label variant="headline" tone="accent">
              {strings.common.done}
            </Label>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.lg,
            paddingTop: theme.spacing.lg,
            paddingBottom: insets.bottom + theme.spacing.xxl,
          }}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The peer id as something a person can read out loud.
 *
 * It is a base32 hash, never described to the user as an id - it is "your
 * code", the thing a friend can compare against what their phone shows.
 */
export function friendlyCode(peerId: string | null | undefined): string {
  if (!peerId) return '';
  const upper = peerId.toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < upper.length; i += 4) groups.push(upper.slice(i, i + 4));
  return groups.join(' ');
}

export function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function isYesterday(at: number, now: number): boolean {
  const then = new Date(at);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return (
    then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate()
  );
}

/** "Seen 2 hours ago". Never a timestamp, never a raw epoch. */
export function formatSeen(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return local.friends.seenNever;
  const delta = now - at;
  // A friend's clock can be a little ahead of ours after a week offline. That
  // is not "in the future", it is "just now".
  if (delta < MINUTE) return local.friends.seenJustNow;
  if (delta < HOUR) return local.friends.seenMinutes(Math.floor(delta / MINUTE));
  if (delta < DAY) return local.friends.seenHours(Math.floor(delta / HOUR));
  if (isYesterday(at, now)) return local.friends.seenYesterday;
  return local.friends.seenOn(formatDate(at));
}

export interface Verification {
  readonly label: string;
  readonly strength: string;
  /** True only for a QR pairing: the key never touched the air. */
  readonly strongest: boolean;
}

export function verificationOf(method: TrustedPeer['method']): Verification {
  if (method === PairingMethod.QR) {
    return { label: local.friends.verifiedByQr, strength: local.friends.qrIsStronger, strongest: true };
  }
  if (method === PairingMethod.SAS) {
    return { label: local.friends.verifiedByCode, strength: local.friends.codeIsGood, strongest: false };
  }
  return { label: local.friends.verifiedRestored, strength: local.friends.restoredIsWeak, strongest: false };
}

/**
 * Where the developer-mode switch is remembered.
 *
 * In the settings table rather than the zustand store alone, so a developer who
 * revealed it once does not have to tap the version seven times again after
 * every cold launch.
 */
export const DEVELOPER_MODE_SETTING_KEY = 'you.developerMode';

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * Copy text to the pasteboard.
 *
 * `Clipboard` is deprecated in React Native core and logs a warning the first
 * time it is touched, but the community package is not a dependency of this app
 * and adding one is not this agent's call. The access is deliberately inside
 * the function so the warning only appears if a developer actually copies
 * something out of Developer Mode.
 */
export function copyText(value: string): boolean {
  try {
    Clipboard.setString(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading `unknown` safely
// ---------------------------------------------------------------------------
// `AirLinkClient.diagnostics()` is typed `Record<string, unknown>` and its shape
// is owned by the core package, which is still moving. Developer Mode therefore
// reads it defensively: a field that changes name shows as "—" rather than
// crashing the one screen you open when everything else is broken.

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Fallback rendering for a value whose shape we do not recognise. */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > 0 ? value : '—';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(describeValue).join(', ');
  return stringifyForBugReport(value);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * A diagnostics blob a developer can paste into a bug report.
 *
 * Byte arrays become hex, cycles become a marker, and BigInt does not throw -
 * this runs on a plane, where a crash in the debugging screen is the end of the
 * investigation.
 */
export function stringifyForBugReport(value: unknown): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (item instanceof Uint8Array) return bytesToHex(item);
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    },
    2,
  );
  return json ?? '—';
}
