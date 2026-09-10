import React, { useEffect } from 'react';
import { AccessibilityInfo, Linking, Platform, ScrollView, View } from 'react-native';
import { strings } from '@airlink/config';
import { Button, Card, Gap, Label, StatusBanner, useTheme } from '../../ui/index.js';
import { onboardingCopy } from './copy.js';

/**
 * Why, then the ask.
 *
 * One card per prompt the operating system will actually show, so nothing here
 * promises a dialog that never arrives. The prompts themselves are raised by
 * `client.start()` when the button is pressed - never on a cold launch, where
 * they would appear with no explanation at all.
 *
 * That is true on both platforms, and it took a fix to make it so: iOS raises
 * its sheets when CoreBluetooth and the local network are first touched, which
 * `start()` does, but Android needs an explicit request and nothing was making
 * it. See `AirLinkClient.start`.
 */
export type OnboardingTrouble = 'profile' | 'radios';

interface PermissionCard {
  readonly title: string;
  readonly body: string;
}

/**
 * The two prompts that exist on each platform.
 *
 * iOS asks for Bluetooth and for the local network; Android asks for Bluetooth
 * and for nearby Wi-Fi devices. Listing the other platform's card would be a
 * promise the OS never keeps.
 */
function cardsFor(platform: typeof Platform.OS): PermissionCard[] {
  const bluetooth: PermissionCard = {
    title: strings.permissions.bluetoothTitle,
    body: strings.permissions.bluetoothBody,
  };
  const wifi: PermissionCard =
    platform === 'android'
      ? { title: strings.permissions.nearbyDevicesTitle, body: strings.permissions.nearbyDevicesBody }
      : { title: strings.permissions.localNetworkTitle, body: strings.permissions.localNetworkBody };
  return [bluetooth, wifi];
}

export function PermissionsStep({
  width,
  trouble,
}: {
  width: number;
  /** Set when the last attempt did not work. Never a stack trace. */
  trouble: OnboardingTrouble | null;
}): React.JSX.Element {
  const theme = useTheme();
  const cards = cardsFor(Platform.OS);

  /**
   * Say out loud that it did not work.
   *
   * The banner appears below the fold and the only other signal is the button
   * relabelling itself to Retry - neither of which VoiceOver notices. Without
   * this, a blind user presses Allow, waits, and is told nothing at all.
   */
  useEffect(() => {
    if (!trouble) return;
    const title = trouble === 'profile' ? onboardingCopy.profileFailed : onboardingCopy.startFailed;
    const detail =
      trouble === 'profile' ? onboardingCopy.profileFailedDetail : onboardingCopy.startFailedDetail;
    AccessibilityInfo.announceForAccessibility(`${title} ${detail}`);
  }, [trouble]);

  return (
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
      <View accessible accessibilityRole="header">
        <Label variant="title">{onboardingCopy.permissionsTitle}</Label>
      </View>
      <Gap size="sm" />
      <Label variant="subheadline" tone="secondary">
        {strings.profile.privacyBody}
      </Label>

      <Gap size="xl" />

      <View style={{ gap: theme.spacing.md }}>
        {cards.map((card) => (
          <Card key={card.title}>
            <Label variant="headline">{card.title}</Label>
            <Gap size="xs" />
            <Label variant="subheadline" tone="secondary">
              {card.body}
            </Label>
          </Card>
        ))}
      </View>

      {trouble ? (
        <>
          <Gap size="lg" />
          {/* Warning, not danger. Nothing here has broken the app - it has just
              not started listening yet, and both of these are recoverable. */}
          <StatusBanner
            tone="warning"
            title={trouble === 'profile' ? onboardingCopy.profileFailed : onboardingCopy.startFailed}
            detail={
              trouble === 'profile' ? onboardingCopy.profileFailedDetail : onboardingCopy.startFailedDetail
            }
          />
          {trouble === 'radios' ? (
            <>
              <Gap size="sm" />
              <Button
                title={strings.permissions.openSettings}
                variant="ghost"
                onPress={() => {
                  // Opening Settings can fail on a locked-down device; there is
                  // nothing useful to say if it does, and the screen still works.
                  void Linking.openSettings().catch(() => undefined);
                }}
              />
            </>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
