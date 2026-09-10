import React, { useMemo } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ConnectionState } from '@airlink/core';
import { allGames } from '@airlink/games';
import { strings } from '@airlink/config';
import { Avatar, Button, EmptyState, Gap, Label, Row, Screen, useTheme } from '../../ui/index.js';
import { selectPeer, useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { useOptionalClient } from './useOptionalClient.js';
import { GameTile, availabilityFor, newGameSessionId } from './catalogue.js';
import { playText } from './strings.js';

/**
 * Choose a game.
 *
 * The counterpart to the Play tab: that screen starts from a game and asks who,
 * this one starts from a person - it is where the Play button on a connected
 * friend's card leads - and asks what. The route carries a peer, so the
 * question here is only ever "which game", and every tile already knows whether
 * that particular person can play it.
 *
 * A modal, because it interrupts something: the answer opens a room, and the
 * only other useful answer is to back out.
 */
export function GamePickerScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const { params } = useRoute<RouteProp<RootStackParams, 'GamePicker'>>();
  const { width } = useWindowDimensions();
  const client = useOptionalClient();

  const peer = useAppStore(selectPeer(params.peerKey));
  const games = useMemo(() => allGames(), []);

  const handle = client?.peer(params.peerKey);
  const connected = handle?.session.state === ConnectionState.CONNECTED;
  const name = handle?.session.capabilities?.displayName || peer?.displayName || '';

  const columns = width >= 700 ? 3 : 2;
  const gutter = theme.spacing.md;
  const tileWidth = (width - theme.spacing.lg * 2 - gutter * (columns - 1)) / columns;

  if (!connected) {
    return (
      <Screen safeTop={false} scroll>
        <Gap size="xl" />
        <EmptyState
          icon="📡"
          title={playText.tabs.notConnected}
          body={playText.tabs.connectFirst(name)}
          action={<Button title={strings.common.close} variant="secondary" onPress={() => navigation.goBack()} />}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Gap size="lg" />
      <Row gap="md">
        <Avatar name={name} peerId={peer?.peerId ?? null} emoji={peer?.avatarEmoji ?? null} size={44} />
        <View style={{ flex: 1 }}>
          <Label variant="title2" numberOfLines={1}>
            {name}
          </Label>
          <Label variant="footnote" tone="secondary">
            {strings.play.chooseGame}
          </Label>
        </View>
      </Row>

      <Gap size="xl" />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: gutter }}>
        {games.map((entry) => (
          <GameTile
            key={entry.definition.id}
            entry={entry}
            width={tileWidth}
            availability={availabilityFor(client, params.peerKey, entry, name)}
            onPress={() =>
              // `replace`, so backing out of a game lands on whatever opened the
              // picker rather than on the picker itself.
              navigation.replace('GameRoom', {
                peerKey: params.peerKey,
                gameId: entry.definition.id,
                gameSessionId: newGameSessionId(),
                isHost: true,
              })
            }
          />
        ))}
      </View>
    </Screen>
  );
}
