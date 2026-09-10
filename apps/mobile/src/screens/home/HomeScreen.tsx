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
import { forgetResolvedPairings, isPairingAnswered } from './pairingRouting.js';
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

  const [radiosSettled, setRadiosSettled] = useState(false);
  const [searchHintVisible, setSearchHintVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setRadiosSettled(true), RADIO_SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);

  // A connected peer has its own card above, which says everything a row says
  // and more; listing them twice on one screen makes the same person look like
  // two.
  const sortedFriends = useMemo(() => friends.filter(notConnected).sort(byPresence), [friends]);
  const sortedStrangers = useMemo(() => strangers.filter(notConnected).sort(byPresence), [strangers]);
  const nobodyNearby = sortedFriends.length === 0 && sortedStrangers.length === 0 && connected.length === 0;

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
   *
   * And only a question the user has not already answered. A confirmed pairing
   * stays pending until the other phone answers too, so without this a user who
   * closed the waiting screen would be sent straight back into a question whose
   * answer has already been sent - where the confirm button is inert.
   */
  const routedPairing = useRef<string | null>(null);
  useEffect(() => {
    forgetResolvedPairings(pendingPairings.map((p) => p.peerKey));
    const next = pendingPairings.find((p) => !isPairingAnswered(p.peerKey));
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
  /**
   * Grey, not amber, before the radios have answered.
   *
   * `connecting` and `warning` are the same colour, so the old tone opened the
   * app on a caution-coloured dot every single launch. Not knowing yet is not a
   * problem, and it should not look like one.
   */
  const bannerTone: StatusTone = radios.bluetoothOn ? 'connected' : 'disconnected';

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
        // Deliberately not `state.offline`: nothing in the app ever writes it,
        // so rendering it would tell a user on full signal that they are
        // offline - a hard-coded value wearing the clothes of a fact. What we
        // do know is the radio, which is event-driven and true, and being
        // offline is the point of this product rather than news anyway.
        <StatusBanner tone={bannerTone} title={strings.status.offlineDetail} />
      )}

      <Gap size="xl" />

      {/* The person you are already talking to comes first. Below the two
          lists, on a phone in a room with a few devices in it, the card you
          need most was the one you had to scroll for. */}
      {connected.length > 0 ? (
        <>
          <SectionHeading>{strings.home.connected}</SectionHeading>
          {connected.map((peer, index) => (
            <View key={peer.key}>
              {index > 0 ? <Gap size="md" /> : null}
              <ConnectedPeerCard peer={peer} />
            </View>
          ))}
          <Gap size="xl" />
        </>
      ) : null}

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
              icon="radar"
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

function notConnected(peer: PeerView): boolean {
  return peer.connection !== ConnectionState.CONNECTED;
}

/** Whatever is in progress first, then alphabetical. */
function byPresence(a: PeerView, b: PeerView): number {
  const rank = (peer: PeerView): number => (isWorking(peer.connection) ? 0 : 1);
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

  // A device nobody has met yet, sitting idle, gets an explicit Connect: the
  // row that starts a first meeting should look like a decision. Every other
  // row opens - including one mid-attempt, which is the only way back into the
  // sheet for a user who dismissed it while it was still working.
  const rowIsControl = connected || working || peer.isFriend;

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

  // A row mid-attempt needs no hint: its own subtitle already says
  // "Connecting…", and the sheet it opens says the rest.
  const hint = connected
    ? homeCopy.openChatWith(peer.displayName)
    : working
      ? undefined
      : homeCopy.connectTo(peer.displayName);

  const row = (
    <ListRow
      title={peer.displayName}
      subtitle={statusLine(peer)}
      left={<Avatar name={peer.displayName} peerId={peer.peerId} color={peer.avatarColor} size={AVATAR_SIZE} />}
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
      accessibilityHint={hint}
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
