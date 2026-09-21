import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
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
import { FaceOff } from './boardKit.js';
import { GameShell } from './GameShell.js';
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
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const { params } = useRoute<RouteProp<RootStackParams, 'GameRoom'>>();

  const room = useGameRoom(params);
  const entry = room.entry ?? findGame(params.gameId) ?? null;

  /**
   * Telling the other phone we have gone happens on the way OUT, whichever way
   * that is.
   *
   * A swipe back is as much a "leave" as the button is, and it never touches
   * the button's handler - so the notice and the row update hang off the
   * navigator's own removal event instead. The ref is what keeps that listener
   * subscribed once: the room view is rebuilt on every render by design.
   */
  const leaveRef = useRef(room.leave);
  leaveRef.current = room.leave;
  /**
   * A rematch replaces this screen with the next game, which is a removal like
   * any other - but telling the peer we left, moments after inviting them to
   * play again, would land as "X left the game" on top of the invitation.
   */
  const rematching = useRef(false);

  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        if (rematching.current) return;
        leaveRef.current();
      }),
    [navigation],
  );

  const leave = useCallback(() => navigation.goBack(), [navigation]);

  const goToRematch = useCallback(
    (next: { gameSessionId: string; isHost: boolean } | null) => {
      if (!next) return;
      haptic('impactLight');
      rematching.current = true;
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

  const rematchBanner = room.incomingRematch ? (
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
  ) : null;

  return (
    <GameShell
      title={entry?.definition.name ?? strings.play.title}
      opponentName={room.opponentName}
      live={room.live}
      turnLine={turnLineFor(room)}
      onExit={leave}
      banner={rematchBanner}
    >
      {(box) => (
        <Body
          room={room}
          width={box.width}
          height={box.height}
          onLeave={leave}
          onRematch={() => goToRematch(room.requestRematch())}
        />
      )}
    </GameShell>
  );
}

/**
 * Whose move it is, in the words a player uses.
 *
 * Null while the game is not being played, so the line does not claim a turn
 * during an invitation or after a result.
 */
function turnLineFor(room: GameRoomView): string | null {
  if (room.phase !== RoomPhase.PLAYING || room.turn === null) return null;
  return room.turn === room.local ? strings.play.yourTurn : strings.play.theirTurn(room.opponentName);
}

// ---------------------------------------------------------------------------

function Body({
  room,
  width,
  height,
  onLeave,
  onRematch,
}: {
  room: GameRoomView;
  /** The exact box the shell has left for the board. Never exceeded. */
  width: number;
  height: number;
  onLeave: () => void;
  onRematch: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const [preparingTooLong, setPreparingTooLong] = useState(false);
  /** What the board is actually left with once the result card has its share. */
  const [boardHeight, setBoardHeight] = useState<number | null>(null);
  const onBoardBox = useCallback((next: number) => {
    setBoardHeight((held) => (held !== null && Math.abs(held - next) < 1 ? held : next));
  }, []);

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
          icon="hourglass"
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
          icon="blocked"
          title={strings.play.unavailableTitle}
          body={room.blockedReason ?? strings.common.error}
          action={<Button title={strings.common.back} variant="secondary" onPress={onLeave} />}
        />
      );

    /*
     * Two states, not one, and the difference is the whole point.
     *
     * INVITING means the question is still going out and nothing has come
     * back. DELIVERED means the other phone acknowledged it - so it is on
     * their screen, and what we are waiting for now is a person, not a radio.
     * The app used to say "Waiting for your friend…" for forty-five seconds in
     * both cases, including the case where the invitation had never arrived at
     * all, which is the single most misleading thing it did.
     */
    case RoomPhase.INVITING:
    case RoomPhase.DELIVERED: {
      const delivered = room.phase === RoomPhase.DELIVERED;
      return (
        <View style={{ paddingVertical: theme.spacing.xxl, gap: theme.spacing.lg }}>
          <FaceOff players={room.players} local={room.local} nameFor={room.nameFor} />
          <View style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <ActivityIndicator color={theme.colors.accent} />
            <Label variant="headline" align="center">
              {delivered ? playText.room.inviteWaiting(room.opponentName) : playText.room.inviteSending}
            </Label>
            <Label variant="footnote" tone="tertiary" align="center">
              {delivered ? playText.room.inviteDelivered : playText.room.waitingDetail}
            </Label>
          </View>
          <Button title={strings.common.cancel} variant="secondary" onPress={onLeave} />
        </View>
      );
    }

    case RoomPhase.UNANSWERED:
      return (
        <EmptyState
          icon="inbox"
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
          icon="smile"
          title={playText.room.declinedTitle(room.opponentName)}
          body={playText.room.declinedBody}
          action={<Button title={strings.common.back} variant="secondary" onPress={onLeave} />}
        />
      );

    case RoomPhase.LEFT:
      return (
        <EmptyState
          icon="wave"
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
      /*
       * A finished game is the board AND the result, and neither may push the
       * other off the screen - the scene does not scroll, so anything that does
       * not fit is simply gone.
       *
       * The result takes its natural height and the board takes what is left,
       * measured rather than guessed at. A fixed fraction was the obvious
       * alternative and is wrong on exactly the phones it matters on: the
       * result card is three buttons and two names, which is nearly half the
       * usable height of a small handset and nowhere near half of a large one.
       */
      return (
        <View style={{ flex: 1 }}>
          <View
            style={{ flex: 1, justifyContent: 'center' }}
            onLayout={(event) => onBoardBox(Math.round(event.nativeEvent.layout.height))}
          >
            <Board room={room} width={width} height={boardHeight ?? height} />
          </View>
          {room.phase === RoomPhase.ENDED ? (
            <>
              <Gap size="lg" />
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
function Board({
  room,
  width,
  height,
}: {
  room: GameRoomView;
  width: number;
  height: number;
}): React.JSX.Element {
  const Renderer = room.entry ? rendererFor(room.entry.definition.id) : null;

  if (!Renderer || room.state === null) {
    return <EmptyState icon="puzzle" title={strings.play.unavailableTitle} body={playText.tabs.noRenderer} />;
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
      // inputs go dead through the same flag that a dropped link uses - and
      // `disabledReason` is what keeps the two apart in words.
      live={room.live && room.phase === RoomPhase.PLAYING}
      disabledReason={room.disabledReason}
      frames={room.frames}
      elapsedMs={room.elapsedMs}
      width={width}
      height={height}
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
