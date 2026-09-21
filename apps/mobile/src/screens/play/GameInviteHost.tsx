import React, { useCallback, useEffect } from 'react';
import { Modal, View } from 'react-native';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { strings } from '@airlink/config';
import { Avatar, Button, Gap, Label, Row, useTheme } from '../../ui/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { useInviteCentre, useNextInvite, type GameInviteRecord } from './inviteCentre.js';
import { useOptionalClient } from './useOptionalClient.js';

/**
 * "Alejandro wants to play Chess."
 *
 * Mounted ONCE, beside the navigator, and deliberately not inside any screen.
 *
 * It used to live in the Play tab, which meant an invitation could only be seen
 * by somebody who was already looking at the Play tab - and, worse, could only
 * be RECEIVED by somebody who had opened that tab at least once since launch,
 * because the listener behind it was built lazily by the same screen. A friend
 * sitting on Home, or reading a message, or looking at their own profile,
 * simply never found out they had been asked. That is the whole of the bug
 * where one phone said "Waiting for your friend…" and the other showed nothing.
 *
 * Sitting above the navigator, it appears over whatever is on screen: a tab, a
 * conversation, a settings page. The one place it deliberately does NOT appear
 * is over a game already in progress - being asked to start chess in the middle
 * of a game of chess is not a question anybody wants - and the room handles a
 * rematch offer itself, in its own words.
 */
export function GameInviteHost(): React.JSX.Element | null {
  const theme = useTheme();
  const navigation = useNavigation<NavigationProp<RootStackParams>>();
  const client = useOptionalClient();
  const centre = useInviteCentre();
  const invite = useNextInvite();

  /**
   * A rematch accepted inside the room is already open, so its invitation is
   * spent even though this centre never saw the answer. Anything whose row has
   * moved past "invited" is therefore forgotten rather than offered again.
   */
  useEffect(() => {
    if (!invite || !client || !centre) return;
    let state: string | null = null;
    try {
      state = client.db.games.get(invite.sessionId)?.state ?? null;
    } catch {
      state = null;
    }
    if (state !== null && state !== 'invited') centre.forget(invite.inviteId);
  }, [client, invite, centre]);

  const accept = useCallback(
    (record: GameInviteRecord) => {
      if (!centre?.accept(record.inviteId)) return;
      navigation.navigate('GameRoom', {
        peerKey: record.peerKey,
        gameId: record.gameId,
        gameSessionId: record.sessionId,
        isHost: record.isHost,
      });
    },
    [centre, navigation],
  );

  const decline = useCallback(
    (record: GameInviteRecord) => {
      centre?.decline(record.inviteId);
    },
    [centre],
  );

  if (!invite) return null;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      // Dismissing with the system back gesture is a decline, not a silence:
      // the other phone gets a real answer either way.
      onRequestClose={() => decline(invite)}
    >
      <View style={{ flex: 1, backgroundColor: theme.colors.scrim }} />
      <View
        style={[
          {
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radius.xl,
            borderTopRightRadius: theme.radius.xl,
            padding: theme.spacing.lg,
            paddingBottom: theme.spacing.xxl,
          },
          theme.shadows.sheet,
        ]}
      >
        <Row gap="md">
          <Avatar name={invite.peerName} peerId={invite.peerId} size={44} />
          <View style={{ flex: 1 }}>
            <Label variant="title2" numberOfLines={2}>
              {strings.play.invitedYou(invite.peerName, invite.gameName)}
            </Label>
          </View>
        </Row>
        <Gap size="lg" />
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          <Button
            title={strings.play.decline}
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() => decline(invite)}
          />
          <Button title={strings.play.accept} style={{ flex: 1 }} onPress={() => accept(invite)} />
        </View>
      </View>
    </Modal>
  );
}
