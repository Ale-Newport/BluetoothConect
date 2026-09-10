import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useShallow } from 'zustand/react/shallow';
import { ConnectionState } from '@airlink/core';
import { brand, strings } from '@airlink/config';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Gap,
  Label,
  ListRow,
  Row,
  Screen,
  SectionHeading,
  StatusBanner,
  StatusDot,
  haptic,
  useTheme,
  type StatusTone,
} from '../../ui/index.js';
import {
  selectConnected,
  selectFriends,
  selectNearbyStrangers,
  selectPendingPairings,
  selectRadios,
  useAppStore,
  type PeerView,
} from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { ConnectedPeerCard } from './ConnectedPeerCard.js';
import { ConnectChip, InlineAction, PulsingDot, RowSeparator } from './controls.js';
import { homeCopy, isWorking, statusLine, statusTone } from './peerPresentation.js';

/**
 * Home.
 *
 * The screen people look at most, so it does one thing: tell the truth about
 * who is nearby and what can be done with them. No internet is not an error
 * here - it is the point of the product - so the banner at the top is the same
 * calm grey as everything else, and the only warning it can raise is a radio
 * the user can actually switch on.
 */

/**
 * How long to wait before deciding Bluetooth is off.
 *
 * The transports report their availability a moment after the app comes up, and
 * `RadioStatus` starts out all-false, so reacting immediately would accuse
 * every user of having Bluetooth disabled for the first second of every launch.
 */
const RADIO_SETTLE_MS = 2500;

/**
 * How long "Searching nearby…" stands on its own before we explain.
 *
 * Long enough that a friend who is already advertising appears first, short
 * enough that nobody sits watching a pulse wondering if it is broken.
 */
const SEARCH_HINT_MS = 6000;

const AVATAR_SIZE = 44;

export function HomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const isFocused = useIsFocused();

  // `useShallow` because these selectors build a new array on every store
  // change; without it the snapshot is never equal to itself and the screen
  // re-renders forever.
  const friends = useAppStore(useShallow(selectFriends));
  const strangers = useAppStore(useShallow(selectNearbyStrangers));
  const connected = useAppStore(useShallow(selectConnected));
  const pendingPairings = useAppStore(selectPendingPairings);
  const radios = useAppStore(selectRadios);
  const offline = useAppStore((state) => state.offline);

  const [radiosSettled, setRadiosSettled] = useState(false);
  const [searchHintVisible, setSearchHintVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setRadiosSettled(true), RADIO_SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);

  const sortedFriends = useMemo(() => [...friends].sort(byPresence), [friends]);
  const sortedStrangers = useMemo(() => [...strangers].sort(byPresence), [strangers]);
  const nobodyNearby = sortedFriends.length === 0 && sortedStrangers.length === 0;

  useEffect(() => {
    if (!nobodyNearby) {
      setSearchHintVisible(false);
      return;
    }
    const timer = setTimeout(() => setSearchHintVisible(true), SEARCH_HINT_MS);
    return () => clearTimeout(timer);
  }, [nobodyNearby]);

  /**
   * A first meeting has to be confirmed by hand, so it interrupts.
   *
   * Only while Home is the screen in front: when the connect sheet is open it
   * routes to the same place itself, and two navigations would stack two copies
   * of the most security-critical screen in the app.
   */
  const routedPairing = useRef<string | null>(null);
  useEffect(() => {
    const next = pendingPairings[0];
    if (!next) {
      routedPairing.current = null;
      return;
    }
    if (!isFocused || routedPairing.current === next.peerKey) return;
    routedPairing.current = next.peerKey;
    navigation.navigate('PairingConfirm', { peerKey: next.peerKey });
  }, [pendingPairings, isFocused, navigation]);

  const openSettings = useCallback(() => {
    // Nothing to report if this fails: the banner is still on screen saying
    // what is wrong, and the user can reach Settings themselves.
    void Linking.openSettings().catch(() => undefined);
  }, []);

  const openPeer = useCallback(
    (peer: PeerView) => {
      if (peer.connection === ConnectionState.CONNECTED) {
        navigation.navigate('Conversation', { peerKey: peer.key, title: peer.displayName });
        return;
      }
      navigation.navigate('Connect', { peerKey: peer.key });
    },
    [navigation],
  );

  const bluetoothBlocked = radiosSettled && !radios.bluetoothOn;
  const bannerTone: StatusTone = bluetoothBlocked ? 'warning' : radios.bluetoothOn ? 'connected' : 'connecting';

  return (
    <Screen scroll>
      <Gap size="xxl" />
      {/* `Label` forwards no accessibility props, so the header role lives on a
          wrapper rather than being dropped silently. */}
      <View accessible accessibilityRole="header" accessibilityLabel={brand.wordmark}>
        <Label variant="wordmark" tone="secondary">
          {brand.wordmark}
        </Label>
      </View>
      <Gap size="md" />

      {bluetoothBlocked ? (
        <StatusBanner
          tone="warning"
          title={strings.status.bluetoothOff}
          // Deliberately not `radios.detail`: that line comes from the
          // transport layer and can carry engineering wording.
          detail={strings.status.bluetoothOffDetail}
          action={<InlineAction title={strings.permissions.openSettings} onPress={openSettings} />}
        />
      ) : (
        <StatusBanner
          tone={bannerTone}
          title={offline ? strings.status.offline : strings.status.offlineDetail}
          {...(offline ? { detail: strings.status.offlineDetail } : {})}
        />
      )}

      <Gap size="xl" />

      {sortedFriends.length > 0 ? (
        <>
          <SectionHeading>{strings.home.nearbyFriends}</SectionHeading>
          <PeerGroup peers={sortedFriends} onOpen={openPeer} />
          <Gap size="xl" />
        </>
      ) : null}

      {sortedStrangers.length > 0 ? (
        <>
          <SectionHeading>{strings.home.otherDevices}</SectionHeading>
          <PeerGroup peers={sortedStrangers} onOpen={openPeer} />
          <Gap size="xl" />
        </>
      ) : null}

      {nobodyNearby ? (
        <View>
          {searchHintVisible ? (
            <EmptyState
              icon="◎"
              title={strings.home.nobodyNearby}
              body={strings.home.nobodyNearbyBody}
              action={
                <Button
                  title={strings.profile.showQr}
                  variant="secondary"
                  onPress={() => navigation.navigate('MyCode')}
                />
              }
            />
          ) : (
            <Gap size="xxxl" />
          )}
          {/* Discovery never stops while this screen is open, so say so - even
              under the empty state, which otherwise reads as "gave up". */}
          <Row gap="sm" style={{ justifyContent: 'center' }}>
            <PulsingDot />
            <Label variant="footnote" tone="secondary">
              {strings.home.searching}
            </Label>
          </Row>
        </View>
      ) : null}

      {connected.map((peer) => (
        <View key={peer.key}>
          <ConnectedPeerCard peer={peer} />
          <Gap size="lg" />
        </View>
      ))}

      <Gap size="lg" />
      {/* A backgrounded phone is invisible to the other side. Better said once,
          quietly, than discovered as a mystery disconnection. */}
      <Label variant="caption" tone="tertiary" align="center">
        {strings.connection.keepAppOpen}
      </Label>
      <Gap size="lg" />
    </Screen>
  );
}

/** Connected first, then whatever is in progress, then alphabetical. */
function byPresence(a: PeerView, b: PeerView): number {
  const rank = (peer: PeerView): number =>
    peer.connection === ConnectionState.CONNECTED ? 0 : isWorking(peer.connection) ? 1 : 2;
  const difference = rank(a) - rank(b);
  return difference !== 0 ? difference : a.displayName.localeCompare(b.displayName);
}

function PeerGroup({
  peers,
  onOpen,
}: {
  peers: readonly PeerView[];
  onOpen: (peer: PeerView) => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Card style={{ paddingVertical: theme.spacing.xs }}>
      {peers.map((peer, index) => (
        <View key={peer.key}>
          {index > 0 ? <RowSeparator inset={AVATAR_SIZE + theme.spacing.md} /> : null}
          <PeerRow peer={peer} onOpen={onOpen} />
        </View>
      ))}
    </Card>
  );
}

function PeerRow({ peer, onOpen }: { peer: PeerView; onOpen: (peer: PeerView) => void }): React.JSX.Element {
  const theme = useTheme();
  const connected = peer.connection === ConnectionState.CONNECTED;
  const working = isWorking(peer.connection);

  // A friend is tapped; a device nobody has met yet gets an explicit Connect,
  // so the row that starts a first meeting always looks like a decision.
  const rowIsControl = peer.isFriend && !working;

  const right = connected ? (
    <StatusDot tone={statusTone(peer.connection)} />
  ) : working ? (
    <PulsingDot />
  ) : peer.isFriend ? (
    <Label variant="body" tone="tertiary">
      ›
    </Label>
  ) : (
    <ConnectChip
      title={strings.home.connect}
      accessibilityLabel={homeCopy.connectTo(peer.displayName)}
      onPress={() => onOpen(peer)}
    />
  );

  const row = (
    <ListRow
      title={peer.displayName}
      subtitle={statusLine(peer)}
      left={<Avatar name={peer.displayName} peerId={peer.peerId} emoji={peer.avatarEmoji} size={AVATAR_SIZE} />}
      right={right}
    />
  );

  if (!rowIsControl) return row;

  // ListRow takes an `onPress` of its own but forwards no accessibility props,
  // and every control in this app has to announce itself.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${peer.displayName}, ${statusLine(peer)}`}
      accessibilityHint={connected ? homeCopy.openChatWith(peer.displayName) : homeCopy.connectTo(peer.displayName)}
      onPress={() => {
        haptic('selection');
        onOpen(peer);
      }}
      style={({ pressed }) => (pressed ? { opacity: 0.6, backgroundColor: theme.colors.surface } : null)}
    >
      {row}
    </Pressable>
  );
}
