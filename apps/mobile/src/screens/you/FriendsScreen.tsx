import React, { useCallback, useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ConnectionState, type TrustedPeer } from '@airlink/core';
import { strings } from '@airlink/config';
import {
  Avatar,
  Button,
  EmptyState,
  Gap,
  Label,
  Screen,
  SectionHeading,
  StatusDot,
  haptic,
  useTheme,
} from '../../ui/index.js';
import { useClient } from '../../client/ClientProvider.js';
import { selectPeers, useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { local } from './localStrings.js';
import { SCANNING_IS_SUPPORTED } from './ScannerCamera.js';
import { Chevron, Group, NavRow, Sheet, formatSeen, verificationOf } from './shared.js';

/**
 * Friends.
 *
 * The trusted list: everyone this device will recognise again with no taps and
 * no code, because their identity key is on file. Each row says when they were
 * last seen and how the friendship was proven, because those two facts are the
 * only ones that matter here and QR is genuinely stronger than six digits.
 *
 * The list is read synchronously from the trust store rather than from the
 * zustand store: it is the table the handshake itself consults, it is a handful
 * of rows, and it is not something that changes while you are staring at it. It
 * is re-read on focus and after every mutation.
 */

/** Which peers are within reach right now, so a row can say "Connected". */
interface Presence {
  readonly connected: boolean;
  readonly nearby: boolean;
}

export function FriendsScreen(): React.JSX.Element {
  const theme = useTheme();
  const client = useClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const peers = useAppStore(selectPeers);

  const [friends, setFriends] = useState<readonly TrustedPeer[]>([]);
  const [blocked, setBlocked] = useState<readonly { peerId: string; displayName: string }[]>([]);
  const [acting, setActing] = useState<TrustedPeer | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    setNow(Date.now());
    try {
      setFriends(client.trustStore.list());
    } catch {
      setFriends([]);
    }
    try {
      // `TrustStore` can block and unblock but cannot enumerate blocked peers,
      // so the blocked section reads the peer table directly. Without this,
      // blocking would be a one-way door.
      setBlocked(
        client.db.peers
          .listAll()
          .filter((peer) => peer.trustState === 'blocked')
          .map((peer) => ({ peerId: peer.peerId, displayName: peer.displayName })),
      );
    } catch {
      setBlocked([]);
    }
  }, [client]);

  useFocusEffect(refresh);

  const presence = useMemo<Map<string, Presence>>(() => {
    const map = new Map<string, Presence>();
    for (const peer of peers) {
      if (!peer.peerId) continue;
      map.set(peer.peerId, {
        connected: peer.connection === ConnectionState.CONNECTED,
        nearby: peer.nearby,
      });
    }
    return map;
  }, [peers]);

  const confirmRemove = useCallback(
    (friend: TrustedPeer) => {
      Alert.alert(local.friends.removeTitle(friend.displayName), local.friends.removeBody, [
        { text: strings.common.cancel, style: 'cancel' },
        {
          text: strings.profile.removeFriend,
          style: 'destructive',
          onPress: () => {
            try {
              client.trustStore.remove(friend.peerId);
              haptic('warning');
            } catch {
              // Naming the friend and saying nothing changed is the whole
              // point: on a screen about who this device trusts, "something
              // went wrong" leaves the user unsure whether it happened.
              Alert.alert(local.friends.removeFailedTitle(friend.displayName), local.friends.actionFailedBody);
            }
            refresh();
          },
        },
      ]);
    },
    [client, refresh],
  );

  const confirmBlock = useCallback(
    (friend: TrustedPeer) => {
      Alert.alert(local.friends.blockTitle(friend.displayName), local.friends.blockBody, [
        { text: strings.common.cancel, style: 'cancel' },
        {
          text: strings.profile.blockDevice,
          style: 'destructive',
          onPress: () => {
            try {
              client.trustStore.block(friend.peerId);
              haptic('warning');
            } catch {
              Alert.alert(local.friends.blockFailedTitle(friend.displayName), local.friends.actionFailedBody);
            }
            refresh();
          },
        },
      ]);
    },
    [client, refresh],
  );

  /**
   * Close the sheet, then act.
   *
   * A system alert or a push started while a modal is still dismissing is
   * silently dropped on iOS, which would turn "Remove friend" into a button
   * that does nothing. Waiting out the dismissal is the whole fix.
   */
  const afterSheet = useCallback(
    (run: () => void) => {
      setActing(null);
      setTimeout(run, theme.motion.quick);
    },
    [theme],
  );

  const unblock = useCallback(
    (peer: { peerId: string; displayName: string }) => {
      try {
        client.trustStore.unblock(peer.peerId);
        haptic('success');
      } catch {
        Alert.alert(local.friends.unblockFailedTitle(peer.displayName), local.friends.actionFailedBody);
      }
      refresh();
    },
    [client, refresh],
  );

  if (friends.length === 0 && blocked.length === 0) {
    return (
      <Screen safeTop={false}>
        {/*
          The only action on an empty screen has to be one this phone can
          finish. Where there is no scanner, "Scan a friend" leads to a page
          whose whole content is an apology - so the invitation is the other
          half of the same handshake instead, which works everywhere.
        */}
        <EmptyState
          icon="👋"
          title={local.friends.emptyTitle}
          body={SCANNING_IS_SUPPORTED ? local.friends.emptyBody : local.friends.emptyBodyNoScanner}
          action={
            SCANNING_IS_SUPPORTED ? (
              <Button title={strings.profile.scanQr} onPress={() => navigation.navigate('ScanCode')} />
            ) : (
              <Button title={strings.profile.showQr} onPress={() => navigation.navigate('MyCode')} />
            )
          }
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Gap size="lg" />

      {friends.length > 0 ? (
        <Group>
          {friends.map((friend) => {
            const here = presence.get(friend.peerId);
            const verification = verificationOf(friend.method);
            const subtitle = here?.connected
              ? strings.home.connected
              : here?.nearby
                ? strings.home.nearby
                : formatSeen(friend.lastSeenAt, now);
            return (
              <NavRow
                key={friend.peerId}
                title={friend.displayName}
                subtitle={subtitle}
                caption={verification.label}
                left={<Avatar name={friend.displayName} peerId={friend.peerId} size={44} />}
                right={
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {here?.connected ? <StatusDot tone="connected" /> : null}
                    <Chevron />
                  </View>
                }
                accessibilityHint={local.friends.manage(friend.displayName)}
                onPress={() => navigation.navigate('Security', { peerId: friend.peerId })}
                onLongPress={() => setActing(friend)}
              />
            );
          })}
        </Group>
      ) : null}

      {friends.length > 0 ? (
        <>
          <Gap size="sm" />
          <Label variant="footnote" tone="tertiary" align="center">
            {local.friends.qrIsStronger}
          </Label>
        </>
      ) : null}

      {blocked.length > 0 ? (
        <>
          <Gap size="xl" />
          <SectionHeading>{local.friends.blocked}</SectionHeading>
          <Group>
            {blocked.map((peer) => (
              <NavRow
                key={peer.peerId}
                title={peer.displayName}
                left={<Avatar name={peer.displayName} peerId={peer.peerId} size={44} />}
                right={
                  <Label variant="footnote" tone="accent">
                    {strings.profile.unblock}
                  </Label>
                }
                accessibilityHint={strings.profile.unblock}
                onPress={() => unblock(peer)}
              />
            ))}
          </Group>
        </>
      ) : null}

      <Sheet
        visible={acting !== null}
        onClose={() => setActing(null)}
        title={acting?.displayName ?? ''}
        subtitle={acting ? verificationOf(acting.method).strength : undefined}
      >
        <NavRow
          title={local.friends.showSafetyNumber}
          right={<Chevron />}
          onPress={() => {
            const friend = acting;
            if (friend) afterSheet(() => navigation.navigate('Security', { peerId: friend.peerId }));
          }}
        />
        <NavRow
          title={strings.profile.removeFriend}
          destructive
          onPress={() => {
            const friend = acting;
            if (friend) afterSheet(() => confirmRemove(friend));
          }}
        />
        <NavRow
          title={strings.profile.blockDevice}
          destructive
          onPress={() => {
            const friend = acting;
            if (friend) afterSheet(() => confirmBlock(friend));
          }}
        />
        <Gap size="sm" />
        <Button title={strings.common.cancel} variant="secondary" onPress={() => setActing(null)} />
      </Sheet>
    </Screen>
  );
}
