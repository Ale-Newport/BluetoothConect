import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { areaColor, strings } from '@airlink/config';
import { Avatar, Card, Gap, Label, Screen, SectionHeading, haptic, useTheme } from '../../ui/index.js';
import { useClient } from '../../client/ClientProvider.js';
import { selectDeveloperMode, selectProfile, useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { local } from './localStrings.js';
import { Chevron, DEVELOPER_MODE_SETTING_KEY, Group, NavRow, PageModal, asString, friendlyCode } from './shared.js';
import { PrivacyPanel } from './PrivacyScreen.js';
import { SecurityOverviewPanel } from './SecurityScreen.js';

/**
 * You.
 *
 * The profile, and the way in to everything about this person's own device.
 * Deliberately quiet: an avatar, a name, the code a friend can scan, and a
 * short grouped list. Nothing here blinks.
 */

/** The usual gesture. Seven taps on the version reveals Developer Mode. */
const REVEAL_TAPS = 7;
/** Taps have to be consecutive; a stray one a minute ago does not count. */
const REVEAL_WINDOW_MS = 2_000;

export function YouScreen(): React.JSX.Element {
  const theme = useTheme();
  const client = useClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useAppStore(selectProfile);
  const developerMode = useAppStore(selectDeveloperMode);

  const [friendCount, setFriendCount] = useState(0);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);

  const appVersion = useMemo(() => asString(client.diagnostics().appVersion) ?? '—', [client]);

  const displayName = profile?.displayName ?? client.profile?.displayName ?? '';
  const peerId = profile?.peerId ?? client.profile?.peerId ?? null;
  const avatarColor = profile?.avatarColor ?? client.profile?.avatarColor ?? null;

  // The friend list is not reactive - it is a synchronous table read by the
  // handshake - so it is re-read whenever this screen comes back into view.
  const refreshFriends = useCallback(() => {
    try {
      setFriendCount(client.trustStore.list().length);
    } catch {
      setFriendCount(0);
    }
  }, [client]);

  useFocusEffect(refreshFriends);

  // Developer mode survives a relaunch, so it is read back from the settings
  // table rather than only living in the store.
  useEffect(() => {
    try {
      if (client.db.settings.get(DEVELOPER_MODE_SETTING_KEY) === 'true') {
        useAppStore.getState().setDeveloperMode(true);
      }
    } catch {
      // A settings table we cannot read is not worth interrupting the user for.
    }
  }, [client]);

  const taps = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(tapTimer.current), []);

  const onVersionPress = useCallback(() => {
    if (developerMode) return;
    taps.current += 1;
    clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      taps.current = 0;
    }, REVEAL_WINDOW_MS);
    if (taps.current < REVEAL_TAPS) return;
    taps.current = 0;
    haptic('success');
    useAppStore.getState().setDeveloperMode(true);
    try {
      client.db.settings.set(DEVELOPER_MODE_SETTING_KEY, 'true', Date.now());
    } catch {
      // Failing to remember the switch is harmless; it is on for this session.
    }
  }, [client, developerMode]);

  /** The tab's hue, and the ground it is allowed to sit on. */
  const youHue = areaColor(theme.colors, 'You');

  return (
    <Screen scroll>
      <Gap size="xxl" />

      {/*
        The profile card is the one surface on this tab that is tinted rather
        than white, because it is the one thing on the screen that is about this
        person rather than about a setting. The tint is the muted partner, so
        every word on it keeps the full-strength text colour and none of the
        contrast the plain card had is given up.
      */}
      <Card
        onPress={() => navigation.navigate('Settings')}
        style={{ backgroundColor: theme.colors.areaYouMuted, borderColor: youHue }}
      >
        <View style={{ alignItems: 'center' }}>
          <Avatar name={displayName} peerId={peerId} color={avatarColor} size={84} />
          <Gap size="md" />
          <Label variant="title2" align="center" numberOfLines={1}>
            {displayName}
          </Label>
          <Gap size="xs" />
          <Label variant="caption" tone="tertiary">
            {strings.profile.yourCode.toUpperCase()}
          </Label>
          <Label variant="mono" tone="secondary" align="center">
            {friendlyCode(peerId)}
          </Label>
        </View>
      </Card>

      <Gap size="sm" />
      <Label variant="footnote" tone="tertiary" align="center">
        {local.you.yourCodeHint}
      </Label>

      <Gap size="xl" />
      <SectionHeading hue={youHue}>{local.you.peopleSection}</SectionHeading>
      <Group>
        <NavRow
          title={strings.profile.friends}
          subtitle={friendCount > 0 ? local.you.friendsCount(friendCount) : local.you.noFriendsYet}
          right={<Chevron />}
          onPress={() => navigation.navigate('Friends')}
        />
        <NavRow
          title={strings.profile.showQr}
          right={<Chevron />}
          onPress={() => navigation.navigate('MyCode')}
        />
        <NavRow
          title={strings.profile.scanQr}
          right={<Chevron />}
          onPress={() => navigation.navigate('ScanCode')}
        />
      </Group>

      <Gap size="xl" />
      <SectionHeading hue={youHue}>{local.you.privacySection}</SectionHeading>
      <Group>
        <NavRow title={strings.profile.privacy} right={<Chevron />} onPress={() => setPrivacyOpen(true)} />
        <NavRow title={strings.profile.security} right={<Chevron />} onPress={() => setSecurityOpen(true)} />
      </Group>

      <Gap size="xl" />
      <SectionHeading hue={youHue}>{local.you.aboutSection}</SectionHeading>
      <Group>
        <NavRow title={local.you.settings} right={<Chevron />} onPress={() => navigation.navigate('Settings')} />
        {developerMode ? (
          <NavRow
            title={strings.profile.developerMode}
            right={<Chevron />}
            onPress={() => navigation.navigate('DeveloperMode')}
          />
        ) : null}
      </Group>

      <Gap size="xl" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${strings.profile.version} ${appVersion}`}
        onPress={onVersionPress}
        style={({ pressed }) => [
          { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
          pressed ? { opacity: 0.6 } : null,
        ]}
      >
        <Label variant="footnote" tone="tertiary">
          {`${strings.profile.version} ${appVersion}`}
        </Label>
        {developerMode ? (
          <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.xs }}>
            {local.you.developerModeOn}
          </Label>
        ) : null}
      </Pressable>

      <PageModal visible={privacyOpen} onClose={() => setPrivacyOpen(false)} title={local.privacy.title}>
        <PrivacyPanel />
      </PageModal>

      <PageModal visible={securityOpen} onClose={() => setSecurityOpen(false)} title={local.security.overviewTitle}>
        <SecurityOverviewPanel
          onPickFriend={(friendPeerId) => {
            setSecurityOpen(false);
            // Let the sheet finish dismissing before the push, or iOS drops the
            // navigation on the floor while its presentation is still animating.
            setTimeout(() => navigation.navigate('Security', { peerId: friendPeerId }), theme.motion.quick);
          }}
          onAddFriend={() => {
            setSecurityOpen(false);
            setTimeout(() => navigation.navigate('ScanCode'), theme.motion.quick);
          }}
          onShowMyCode={() => {
            setSecurityOpen(false);
            setTimeout(() => navigation.navigate('MyCode'), theme.motion.quick);
          }}
        />
      </PageModal>
    </Screen>
  );
}
