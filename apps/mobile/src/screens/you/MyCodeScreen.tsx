import React, { useCallback, useMemo, useState } from 'react';
import { AppState, useWindowDimensions, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import QRCode from 'react-native-qrcode-svg';
import { DEFAULT_PAIRING_CODE_MAX_AGE_MS, buildPairingCode } from '@airlink/core';
import { colors, strings } from '@airlink/config';
import { Avatar, Button, Card, EmptyState, Gap, Label, Screen, useTheme } from '../../ui/index.js';
import { useClient } from '../../client/ClientProvider.js';
import { selectProfile, useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { local } from './localStrings.js';
import { friendlyCode } from './shared.js';

/**
 * My code.
 *
 * The strongest way to add a friend, and the screen says so in one line: the
 * identity key travels between two screens as photons, over a channel an
 * attacker sitting on the radio cannot reach. Once the other phone holds the
 * key, the handshake demands exactly that key and there is nothing for a man in
 * the middle to offer - no six digits, no decision left to a tired human.
 */

/**
 * How often the displayed code is rebuilt.
 *
 * A pairing code expires five minutes after it is issued, which is what stops a
 * screenshot in a group chat from working next week. Refreshing well inside that
 * window means the code on screen is always comfortably fresh, so a friend who
 * takes a while to find the camera never gets an "expired" message from a code
 * they can see in front of them.
 */
const REFRESH_INTERVAL_MS = Math.floor(DEFAULT_PAIRING_CODE_MAX_AGE_MS / 3);

/** Error correction level. M survives a fingerprint on the glass; H makes the squares too small. */
const ERROR_CORRECTION = 'M' as const;

export function MyCodeScreen(): React.JSX.Element {
  const theme = useTheme();
  const client = useClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useAppStore(selectProfile);
  const { width } = useWindowDimensions();

  const displayName = profile?.displayName ?? client.profile?.displayName ?? '';
  const peerId = profile?.peerId ?? client.profile?.peerId ?? null;
  const avatarEmoji = profile?.avatarEmoji ?? client.profile?.avatarEmoji ?? null;

  const [issuedAt, setIssuedAt] = useState(() => Date.now());

  const uri = useMemo<string | null>(() => {
    try {
      return buildPairingCode(client.localIdentity, displayName, issuedAt);
    } catch {
      // No identity, or a clock the signer refused. Either way there is nothing
      // to show, and pretending otherwise would hand a friend a dead code.
      return null;
    }
  }, [client, displayName, issuedAt]);

  const rebuild = useCallback(() => setIssuedAt(Date.now()), []);

  /**
   * Rebuild while the screen is open, and again the moment it comes back.
   *
   * "Comes back" means two different things and both have to be handled. Focus
   * covers navigating here. The AppState listener covers the case the interval
   * cannot: iOS suspends JS timers while the app is in the background, so a
   * phone that sat in a pocket for ten minutes wakes with a timer that has not
   * fired and a code that expired eight minutes ago. Without this the screen
   * would hand a friend a dead code and blame their camera for it.
   */
  useFocusEffect(
    useCallback(() => {
      rebuild();
      const timer = setInterval(rebuild, REFRESH_INTERVAL_MS);
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') rebuild();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, [rebuild]),
  );

  if (uri === null) {
    return (
      <Screen safeTop={false}>
        <EmptyState
          icon="▣"
          title={local.myCode.unavailableTitle}
          body={local.myCode.unavailableBody}
          action={<Button title={local.myCode.tryAgain} onPress={rebuild} />}
        />
      </Screen>
    );
  }

  // The QR itself is sized to the page rather than to a constant, so it stays
  // large on a small phone and does not become absurd on a tablet.
  const available = width - theme.spacing.lg * 2 - theme.spacing.lg * 2;
  const qrSize = Math.max(180, Math.min(available, 320));

  return (
    <Screen scroll>
      <Gap size="lg" />

      <Label variant="title2" align="center">
        {local.myCode.lead}
      </Label>
      <Gap size="lg" />

      <Card>
        <View style={{ alignItems: 'center' }}>
          {/*
            Always dark-on-light, in both themes.

            A QR code is defined as dark modules on a light quiet zone, and a
            fair number of scanners - including the one on the other phone -
            simply will not lock onto an inverted one. So the code keeps the
            LIGHT scheme's tokens whatever the app is wearing, and sits on its
            own white plate inside the themed card. Still tokens, never a hex
            literal.
          */}
          <View
            style={{
              backgroundColor: colors.light.surface,
              borderRadius: theme.radius.md,
              padding: theme.spacing.md,
            }}
          >
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel={local.myCode.accessibilityLabel(displayName)}
            >
              <QRCode
                value={uri}
                size={qrSize}
                color={colors.light.text}
                backgroundColor={colors.light.surface}
                ecl={ERROR_CORRECTION}
              />
            </View>
          </View>

          <Gap size="lg" />
          <Avatar name={displayName} peerId={peerId} emoji={avatarEmoji} size={44} />
          <Gap size="sm" />
          <Label variant="headline" align="center" numberOfLines={1}>
            {displayName}
          </Label>
          <Label variant="mono" tone="tertiary" align="center">
            {friendlyCode(peerId)}
          </Label>
        </View>
      </Card>

      <Gap size="lg" />
      <Label variant="subheadline" tone="secondary" align="center">
        {local.myCode.why}
      </Label>
      <Gap size="xs" />
      <Label variant="footnote" tone="tertiary" align="center">
        {local.myCode.refreshes}
      </Label>

      <Gap size="xl" />
      <Button
        title={strings.profile.scanQr}
        variant="secondary"
        onPress={() => {
          // Replace rather than push: the two codes are the two halves of one
          // task, and nobody wants a stack of alternating QR screens.
          navigation.replace('ScanCode');
        }}
      />
      <Gap size="sm" />
      <Button title={strings.common.done} variant="ghost" onPress={() => navigation.goBack()} />
    </Screen>
  );
}
