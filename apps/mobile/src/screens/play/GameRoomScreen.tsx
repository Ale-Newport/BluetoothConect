import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { GameStatusKind, findGame } from '@airlink/games';
import { strings } from '@airlink/config';
import {
  Button,
  Card,
  EmptyState,
  Gap,
  Label,
  StatusBanner,
  haptic,
  useTheme,
} from '../../ui/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { FaceOff, LiveDot, MIN_TARGET } from './boardKit.js';
import { playText } from './strings.js';
import { RoomPhase, useGameRoom, type GameRoomView } from './useGameRoom.js';
import { rendererFor } from './games/index.js';

/**
 * The room.
 *
 * ONE screen hosts twelve games. Everything that is the same about them lives
 * here - whose turn it is, the score bar, the link, leaving, the result, the
 * rematch - and everything that is different is a renderer that receives a
 * state and a dispatch and returns a view. That division is why chess and pool
 * can share a screen at all, and why adding a thirteenth game is a renderer
 * plus a line in the registry.
 *
 * THE BOARD SURVIVES THE LINK. A dropped connection is the normal condition of
 * a plane, not a failure: a `PeerSession` owns its keys and its reliability
 * state and merely borrows a link, so walking out of range and back resumes the
 * same game. This screen therefore never tears a board down. It disables the
 * inputs, says "Reconnecting…" in the same calm grey as everything else, and
 * leaves the position exactly where it was.
 *
 * NOTHING SPINS FOREVER. Preparing has a deadline, the invite has a window that
 * closes into "No answer", and every dead end offers a way out.
 */

/** How long the room may sit building a session before it admits defeat. */
const PREPARE_LIMIT_MS = 8000;

export function GameRoomScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const { params } = useRoute<RouteProp<RootStackParams, 'GameRoom'>>();
  const { width } = useWindowDimensions();

  const room = useGameRoom(params);
  const entry = room.entry ?? findGame(params.gameId) ?? null;

  const leave = useCallback(() => {
    room.leave();
    navigation.goBack();
  }, [navigation, room]);

  const goToRematch = useCallback(
    (next: { gameSessionId: string; isHost: boolean } | null) => {
      if (!next) return;
      haptic('impactLight');
      // `replace`, not `navigate`: the finished game must not be sitting behind
      // the new one for a back gesture to land on.
      navigation.replace('GameRoom', {
        peerKey: params.peerKey,
        gameId: params.gameId,
        gameSessionId: next.gameSessionId,
        isHost: next.isHost,
      });
    },
    [navigation, params.gameId, params.peerKey],
  );

  const boardWidth = width - theme.spacing.lg * 2;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <Header
        title={entry?.definition.name ?? strings.play.title}
        subtitle={room.opponentName}
        live={room.live}
        onLeave={leave}
      />

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {room.live ? null : (
          <>
            <StatusBanner
              tone="connecting"
              title={strings.connection.reconnecting}
              detail={playText.room.reconnectingDetail}
            />
            <Gap size="md" />
          </>
        )}

        {room.incomingRematch ? (
          <>
            <Card>
              <Label variant="headline">{playText.room.rematchAsked(room.opponentName)}</Label>
              <Gap size="md" />
              <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                <Button
                  title={strings.play.accept}
                  style={{ flex: 1 }}
                  onPress={() => goToRematch(room.acceptRematch())}
                />
                <Button
                  title={strings.play.decline}
                  variant="secondary"
                  style={{ flex: 1 }}
                  onPress={room.declineRematch}
                />
              </View>
            </Card>
            <Gap size="md" />
          </>
        ) : null}

        <Body room={room} width={boardWidth} onLeave={leave} onRematch={() => goToRematch(room.requestRematch())} />
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------

function Header({
  title,
  subtitle,
  live,
  onLeave,
}: {
  title: string;
  subtitle: string;
  live: boolean;
  onLeave: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.sm,
      }}
    >
      <View style={{ flex: 1 }}>
        <Label variant="headline" numberOfLines={1}>
          {title}
        </Label>
        {subtitle ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
            <LiveDot live={live} />
            <Label variant="footnote" tone="secondary" numberOfLines={1}>
              {subtitle}
            </Label>
          </View>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.play.leaveGame}
        onPress={onLeave}
        hitSlop={theme.spacing.md}
        style={({ pressed }) => [
          {
            minHeight: MIN_TARGET,
            justifyContent: 'center',
            paddingHorizontal: theme.spacing.md,
          },
          pressed ? { opacity: 0.6 } : null,
        ]}
      >
        <Label variant="footnote" tone="accent">
          {playText.room.leaveConfirm}
        </Label>
      </Pressable>
    </View>
  );
}

function Body({
  room,
  width,
  onLeave,
  onRematch,
}: {
  room: GameRoomView;
  width: number;
  onLeave: () => void;
  onRematch: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const [preparingTooLong, setPreparingTooLong] = useState(false);

  useEffect(() => {
    if (room.phase !== RoomPhase.PREPARING) {
      setPreparingTooLong(false);
      return;
    }
    const timer = setTimeout(() => setPreparingTooLong(true), PREPARE_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [room.phase]);

  switch (room.phase) {
    case RoomPhase.PREPARING:
      // A loading state with an end: if the session has not been built inside
      // the window, the room says so and offers the way out.
      return preparingTooLong ? (
        <EmptyState
          icon="⌛"
          title={playText.room.slowStartTitle}
          body={playText.room.slowStartBody}
          action={<Button title={strings.play.leaveGame} variant="secondary" onPress={onLeave} />}
        />
      ) : (
        <View style={{ paddingVertical: theme.spacing.xxxl, alignItems: 'center', gap: theme.spacing.md }}>
          <ActivityIndicator color={theme.colors.accent} />
          <Label variant="footnote" tone="tertiary">
            {strings.play.creatingGame}
          </Label>
        </View>
      );

    case RoomPhase.UNAVAILABLE:
      return (
        <EmptyState
          icon="🚫"
          title={strings.play.unavailableTitle}
          body={room.blockedReason ?? strings.common.error}
          action={<Button title={strings.common.back} variant="secondary" onPress={onLeave} />}
        />
      );

    case RoomPhase.INVITING:
      return (
        <View style={{ paddingVertical: theme.spacing.xxl, gap: theme.spacing.lg }}>
          <FaceOff players={room.players} local={room.local} nameFor={room.nameFor} />
          <View style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <ActivityIndicator color={theme.colors.accent} />
            <Label variant="headline" align="center">
              {strings.play.waitingForOpponent}
            </Label>
            <Label variant="footnote" tone="tertiary" align="center">
              {playText.room.waitingDetail}
            </Label>
          </View>
          <Button title={strings.common.cancel} variant="secondary" onPress={onLeave} />
        </View>
      );

    case RoomPhase.UNANSWERED:
      return (
        <EmptyState
          icon="📭"
          title={playText.room.noAnswerTitle}
          body={playText.room.noAnswerBody(room.opponentName)}
          action={
            <View style={{ gap: theme.spacing.sm, alignSelf: 'stretch' }}>
              <Button title={strings.connection.tryAgain} onPress={room.retryInvite} />
              <Button title={strings.play.leaveGame} variant="secondary" onPress={onLeave} />
            </View>
          }
        />
      );

    case RoomPhase.DECLINED:
      return (
        <EmptyState
          icon="🙂"
          title={playText.room.declinedTitle(room.opponentName)}
          body={playText.room.declinedBody}
          action={<Button title={strings.common.back} variant="secondary" onPress={onLeave} />}
        />
      );

    case RoomPhase.LEFT:
      return (
        <EmptyState
          icon="👋"
          title={playText.room.leftTitle(room.opponentName)}
          body={playText.room.declinedBody}
          action={
            <View style={{ gap: theme.spacing.sm, alignSelf: 'stretch' }}>
              <Button title={strings.play.rematch} onPress={onRematch} />
              <Button title={strings.play.leaveGame} variant="secondary" onPress={onLeave} />
            </View>
          }
        />
      );

    default:
      return (
        <View>
          <Board room={room} width={width} />
          {room.phase === RoomPhase.ENDED ? (
            <>
              <Gap size="xl" />
              <Result room={room} onLeave={onLeave} onRematch={onRematch} />
            </>
          ) : null}
        </View>
      );
  }
}

/**
 * The game itself.
 *
 * The renderer is looked up by id and handed the whole contract. If there is no
 * renderer the room says so plainly rather than showing an empty frame - but
 * the Play tab checks the same registry before it offers the tile, so in
 * practice this branch is reachable only through an invite from a build that
 * has a game this one does not.
 */
function Board({ room, width }: { room: GameRoomView; width: number }): React.JSX.Element {
  const Renderer = room.entry ? rendererFor(room.entry.definition.id) : null;

  if (!Renderer || room.state === null) {
    return <EmptyState icon="🧩" title={strings.play.unavailableTitle} body={playText.tabs.noRenderer} />;
  }

  return (
    <Renderer
      state={room.state}
      dispatch={room.dispatch}
      local={room.local}
      players={room.players}
      isHost={room.isHost}
      nameFor={room.nameFor}
      turn={room.turn}
      lastAction={room.lastAction}
      // A finished game is a board to look at, not to play: the renderer's own
      // inputs go dead through the same flag that a dropped link uses.
      live={room.live && room.phase === RoomPhase.PLAYING}
      frames={room.frames}
      elapsedMs={room.elapsedMs}
      width={width}
      sessionKey={room.sessionKey}
    />
  );
}

/** The end of a game: what happened, and the only two things worth doing next. */
function Result({
  room,
  onLeave,
  onRematch,
}: {
  room: GameRoomView;
  onLeave: () => void;
  onRematch: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const status = room.status;

  const headline =
    status?.kind === GameStatusKind.WON
      ? status.winners.includes(room.local)
        ? strings.play.youWon
        : strings.play.youLost
      : status?.kind === GameStatusKind.DRAW
      ? strings.play.draw
      : playText.room.gameOver;

  return (
    <Card>
      <Label variant="title" align="center">
        {headline}
      </Label>
      <Gap size="lg" />
      <View style={{ gap: theme.spacing.sm }}>
        <Button title={strings.play.rematch} onPress={onRematch} disabled={!room.live} disabledReason={room.live ? undefined : playText.room.waitingForLink} />
        <Button title={strings.play.leaveGame} variant="secondary" onPress={onLeave} />
      </View>
    </Card>
  );
}
