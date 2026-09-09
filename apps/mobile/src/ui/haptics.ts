import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

/**
 * Haptics.
 *
 * Used sparingly and only where something real happened: a connection formed, a
 * move landed, a transfer finished. Buzzing on every tap is the fastest way to
 * make an app feel cheap, and the fastest way to get haptics switched off
 * system-wide.
 */
export type HapticKind =
  | 'selection'
  | 'impactLight'
  | 'impactMedium'
  | 'success'
  | 'warning'
  | 'error';

type FeedbackName = Parameters<typeof ReactNativeHapticFeedback.trigger>[0];

const NAMES: Record<HapticKind, FeedbackName> = {
  selection: 'selection',
  impactLight: 'impactLight',
  impactMedium: 'impactMedium',
  success: 'notificationSuccess',
  warning: 'notificationWarning',
  error: 'notificationError',
};

export function haptic(kind: HapticKind): void {
  try {
    ReactNativeHapticFeedback.trigger(NAMES[kind], {
      enableVibrateFallback: false,
      ignoreAndroidSystemSettings: false,
    });
  } catch {
    // A device without a taptic engine is not a failure worth surfacing.
  }
}
