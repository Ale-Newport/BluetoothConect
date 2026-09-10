import React, { useMemo } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { safetyNumber, type TrustedPeer } from '@airlink/core';
import { strings } from '@airlink/config';
import { Avatar, Button, Card, EmptyState, Gap, Label, Screen, SectionHeading, useTheme } from '../../ui/index.js';
import { useClient } from '../../client/ClientProvider.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { local } from './localStrings.js';
import { Chevron, Group, NavRow, formatDate, verificationOf } from './shared.js';

/**
 * Security.
 *
 * One friendship, one number. The safety number is a hash of the two identity
 * keys, so it is identical on both phones and different for every pair - which
 * is exactly what makes reading it out loud a proof that the key this device
 * holds for them is the key their device is actually using. If a third party
 * had wedged themselves into the middle, the two phones would be hashing
 * different keys and the numbers would not match.
 *
 * Deliberately NOT shown: the keys themselves, the peer id, or anything about
 * the radio. The number is the whole interface.
 */

/** Two columns reads better than five when two people are comparing out loud. */
const COLUMNS = 2;

function SafetyNumberGrid({ value }: { value: string }): React.JSX.Element {
  const theme = useTheme();
  const groups = value.split(' ').filter(Boolean);
  return (
    <View
      accessibilityRole="text"
      // Read as one string, with pauses, rather than ten separate labels.
      accessibilityLabel={`${strings.profile.safetyNumber}: ${groups.join(', ')}`}
      style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: theme.spacing.sm }}
    >
      {groups.map((group, index) => (
        <View key={`${group}-${index}`} style={{ width: `${100 / COLUMNS}%` }}>
          <Label variant="title2" align="center">
            {group}
          </Label>
        </View>
      ))}
    </View>
  );
}

export function SecurityScreen({ route }: NativeStackScreenProps<RootStackParams, 'Security'>): React.JSX.Element {
  const theme = useTheme();
  const client = useClient();
  const { peerId } = route.params;

  const friend = useMemo<TrustedPeer | undefined>(() => {
    try {
      return client.trustStore.record(peerId);
    } catch {
      return undefined;
    }
  }, [client, peerId]);

  const number = useMemo<string | null>(() => {
    if (!friend) return null;
    try {
      return safetyNumber(client.localIdentity.signing.publicKey, friend.identityKey);
    } catch {
      // A record whose key is unreadable is a data problem, not a security
      // verdict - say nothing rather than say something reassuring.
      return null;
    }
  }, [client, friend]);

  if (!friend || !number) {
    return (
      <Screen>
        <EmptyState
          icon="🔒"
          title={local.security.unknownFriendTitle}
          body={local.security.unknownFriendBody}
        />
      </Screen>
    );
  }

  const verification = verificationOf(friend.method);

  return (
    <Screen scroll>
      <Gap size="lg" />
      <View style={{ alignItems: 'center' }}>
        <Avatar name={friend.displayName} peerId={friend.peerId} size={64} />
        <Gap size="sm" />
        <Label variant="title2" align="center" numberOfLines={1}>
          {friend.displayName}
        </Label>
        <Label variant="footnote" tone="tertiary">
          {local.security.pairedOn(formatDate(friend.pairedAt))}
        </Label>
      </View>

      <Gap size="xl" />
      <SectionHeading>{strings.profile.safetyNumber}</SectionHeading>
      <Card>
        <SafetyNumberGrid value={number} />
      </Card>

      <Gap size="md" />
      <Label variant="subheadline" tone="secondary" align="center" style={{ paddingHorizontal: theme.spacing.md }}>
        {strings.profile.safetyNumberBody}
      </Label>
      <Gap size="xs" />
      <Label variant="footnote" tone="tertiary" align="center">
        {local.security.compareHint}
      </Label>

      <Gap size="xl" />
      <Group>
        <NavRow title={verification.label} subtitle={verification.strength} />
      </Group>
    </Screen>
  );
}

/**
 * The security overview, presented from the You screen.
 *
 * "Security" at the top level cannot open the `Security` route directly - that
 * route needs a peer id, because a safety number belongs to a pair of people,
 * not to a device. So this explains the guarantee once and then asks which
 * friendship to check.
 */
export function SecurityOverviewPanel({
  onPickFriend,
  onAddFriend,
}: {
  onPickFriend: (peerId: string) => void;
  onAddFriend: () => void;
}): React.JSX.Element {
  const client = useClient();
  const friends = useMemo<readonly TrustedPeer[]>(() => {
    try {
      return client.trustStore.list();
    } catch {
      return [];
    }
  }, [client]);

  return (
    <View>
      <Label variant="body" tone="secondary">
        {local.security.overviewLead}
      </Label>

      <Gap size="xl" />

      {friends.length === 0 ? (
        <EmptyState
          icon="🔒"
          title={local.security.noFriendsTitle}
          body={local.security.noFriendsBody}
          action={<Button title={strings.profile.scanQr} onPress={onAddFriend} />}
        />
      ) : (
        <>
          <SectionHeading>{local.security.overviewPickFriend}</SectionHeading>
          <Group>
            {friends.map((friend) => (
              <NavRow
                key={friend.peerId}
                title={friend.displayName}
                subtitle={verificationOf(friend.method).label}
                left={<Avatar name={friend.displayName} peerId={friend.peerId} size={36} />}
                right={<Chevron />}
                accessibilityHint={strings.profile.safetyNumber}
                onPress={() => onPickFriend(friend.peerId)}
              />
            ))}
          </Group>
        </>
      )}
    </View>
  );
}
