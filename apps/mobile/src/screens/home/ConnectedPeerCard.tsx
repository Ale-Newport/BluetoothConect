import React, { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { systemRandom, toHex } from '@airlink/core';
import { strings } from '@airlink/config';
import { Avatar, Card, Divider, Gap, Label, Row, StatusDot, haptic, useTheme } from '../../ui/index.js';
import type { PeerView } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { useOptionalClient } from './useOptionalClient.js';
import { homeCopy, statusLine, statusTone } from './peerPresentation.js';

/**
 * What you can do with the person you are connected to.
 *
 * The four actions are not decoration: each one is enabled only if the peer
 * told us during the handshake that it can do that thing. A phone running an
 * older build without the sync feature, or with no games installed, gets a
 * greyed tile and a sentence saying so - never a button that looks live and
 * does nothing when tapped.
 */

/**
 * Component dimensions.
 *
 * Named rather than written into the styles because the design system has no
 * scale for them yet - `Avatar` and `StatusDot` take numbers. The tile height
 * is comfortably past the 44pt minimum target.
 */
const AVATAR_SIZE = 44;
const TILE_MIN_HEIGHT = 64;
const STATUS_DOT_SIZE = 6;

interface ActionSpec {
  readonly key: string;
  /** Matches the placeholder glyph language of the tab bar. */
  readonly glyph: string;
  readonly title: string;
  readonly enabled: boolean;
  /** Shown under the row when the action is unavailable. Plain words only. */
  readonly reason: string;
  readonly onPress: () => void;
}

/**
 * A fresh id for a watch-together session this phone is asking to host.
 *
 * Same shape the sync layer mints for itself, so an id from either side is
 * indistinguishable, and generated here because the launcher owns the identity
 * of the session it starts.
 */
function newSyncSessionId(): string {
  return toHex(systemRandom.randomBytes(8));
}

export function ConnectedPeerCard({ peer }: { peer: PeerView }): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const client = useOptionalClient();

  // What the peer said it could do, fixed at the handshake. Re-read when the
  // connection or the link changes, which is the only time it can appear.
  const capabilities = useMemo(
    () => client?.peer(peer.key)?.session.capabilities ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, peer.key, peer.connection, peer.quality],
  );

  const unknown = capabilities === null;
  const pendingReason = client ? strings.connection.securing : homeCopy.startingUp;
  const has = (feature: string): boolean => capabilities?.features.includes(feature) ?? false;

  const actions: ActionSpec[] = [
    {
      key: 'chat',
      glyph: '✉',
      title: strings.home.chat,
      enabled: has('chat'),
      // Never "Not connected": this card only exists because we are.
      reason: unknown ? pendingReason : homeCopy.noChat(peer.displayName),
      onPress: () => navigation.navigate('Conversation', { peerKey: peer.key, title: peer.displayName }),
    },
    {
      key: 'play',
      glyph: '◆',
      title: strings.home.play,
      // The peer sends the games it actually has, so an invite can never arrive
      // for something the other side cannot open.
      enabled: (capabilities?.games.length ?? 0) > 0,
      reason: unknown ? pendingReason : homeCopy.noGames(peer.displayName),
      onPress: () => navigation.navigate('GamePicker', { peerKey: peer.key }),
    },
    {
      key: 'share',
      glyph: '↑',
      title: strings.home.share,
      enabled: has('files'),
      reason: unknown ? pendingReason : homeCopy.noFiles(peer.displayName),
      onPress: () => navigation.navigate('ShareCompose', { peerKey: peer.key }),
    },
    {
      key: 'sync',
      glyph: '▶',
      title: strings.home.sync,
      enabled: has('sync'),
      reason: unknown ? pendingReason : homeCopy.noWatchTogether(peer.displayName),
      onPress: () =>
        navigation.navigate('WatchTogether', { peerKey: peer.key, syncSessionId: newSyncSessionId() }),
    },
  ];

  // One sentence per reason, not per tile: while the handshake is still
  // settling every tile has the same thing to say, and four identical lines
  // read as a stutter rather than an explanation.
  const reasons = [...new Set(actions.filter((action) => !action.enabled).map((action) => action.reason))];

  return (
    <Card>
      <Row gap="md">
        <Avatar name={peer.displayName} peerId={peer.peerId} emoji={peer.avatarEmoji} size={AVATAR_SIZE} />
        <View style={{ flex: 1 }}>
          <Label variant="headline" numberOfLines={1}>
            {peer.displayName}
          </Label>
          <Row gap="xs">
            <StatusDot tone={statusTone(peer.connection)} size={STATUS_DOT_SIZE} />
            <Label variant="footnote" tone="secondary">
              {statusLine(peer)}
            </Label>
          </Row>
        </View>
      </Row>

      <Gap size="lg" />
      <Divider />
      <Gap size="lg" />

      <Row gap="sm" align="stretch">
        {actions.map((action) => (
          <ActionTile key={action.key} action={action} />
        ))}
      </Row>

      {reasons.length > 0 ? (
        <View style={{ marginTop: theme.spacing.md }}>
          {reasons.map((reason) => (
            <Label key={reason} variant="caption" tone="tertiary">
              {reason}
            </Label>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

function ActionTile({ action }: { action: ActionSpec }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.title}
      accessibilityState={{ disabled: !action.enabled }}
      accessibilityHint={action.enabled ? undefined : action.reason}
      disabled={!action.enabled}
      onPress={() => {
        haptic('impactLight');
        action.onPress();
      }}
      style={({ pressed }) => [
        {
          flex: 1,
          minHeight: TILE_MIN_HEIGHT,
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.xs,
          paddingVertical: theme.spacing.sm,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceElevated,
          opacity: action.enabled ? 1 : 0.4,
        },
        pressed ? { opacity: 0.7 } : null,
      ]}
    >
      <Label variant="callout" tone={action.enabled ? 'accent' : 'tertiary'}>
        {action.glyph}
      </Label>
      <Label variant="caption" tone={action.enabled ? 'primary' : 'tertiary'}>
        {action.title}
      </Label>
    </Pressable>
  );
}
