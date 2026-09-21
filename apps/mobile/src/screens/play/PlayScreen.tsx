import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useFocusEffect,
  useNavigation,
  type CompositeNavigationProp,
} from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useShallow } from 'zustand/react/shallow';
import { findGame, needsBetterLink, type GameCatalogueEntry } from '@airlink/games';
import type { GameSessionRow } from '@airlink/db';
import { areaColor, categoryColor, strings } from '@airlink/config';
import {
  Avatar,
  Button,
  Card,
  Divider,
  EmptyState,
  Gap,
  Label,
  ListRow,
  Row,
  Screen,
  SectionHeading,
  StatusDot,
  useTheme,
} from '../../ui/index.js';
import { selectConnected, useAppStore, type PeerView } from '../../state/index.js';
import type { RootStackParams, TabParams } from '../../navigation/routes.js';
import { useOptionalClient } from './useOptionalClient.js';
import {
  GameTile,
  availabilityFor,
  bestAvailabilityFor,
  newGameSessionId,
  peerKeyForPeerId,
} from './catalogue.js';
import { playText } from './strings.js';
import {
  DurationFilter,
  buildShelves,
  catalogueCopy,
  durationOptions,
  randomGame,
  useFavourites,
  useSlowLinkNote,
} from './catalogueModel.js';

/**
 * Play.
 *
 * Games in progress first, then the whole catalogue as a grid of tiles.
 *
 * WITH NOBODY CONNECTED THIS SCREEN IS NOT A GRID OF DEAD BUTTONS. Every game
 * here needs another person, so with nobody nearby the screen says so once and
 * points at Home, rather than showing twelve tiles that all refuse to open. The
 * grid appears when there is somebody to play with.
 *
 * CHOOSING A PERSON HAPPENS AFTER CHOOSING A GAME. With one friend connected -
 * which is the whole of the aeroplane case - tapping a tile starts the game.
 * With several, a sheet asks who, and only then does the room open. The other
 * direction, starting from a person, is `GamePickerScreen`, which is where
 * Home's Play button leads.
 */
/**
 * Play sits in the tab bar but opens screens from the root stack, so its
 * navigation object has to be able to name both - "Home" is a sibling tab and
 * "GameRoom" is a stack screen one level up.
 */
type PlayNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<TabParams, 'Play'>,
  NativeStackNavigationProp<RootStackParams>
>;

export function PlayScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<PlayNavigation>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const client = useOptionalClient();

  const connected = useAppStore(useShallow(selectConnected));
  const profile = useAppStore((state) => state.profile);

  const [resumable, setResumable] = useState<readonly GameSessionRow[]>([]);
  const [pendingGame, setPendingGame] = useState<GameCatalogueEntry | null>(null);

  /**
   * Nothing here asks about an invitation any more.
   *
   * `GameInviteHost`, mounted beside the navigator, does - so the question
   * reaches the user wherever they are in the app rather than only on this
   * tab, and, more importantly, the listener behind it exists from launch
   * rather than from the first time somebody happened to open Play.
   */

  /**
   * The saved-games shelf is read on focus rather than subscribed to.
   *
   * A game row changes on every move, and this screen is not on top while that
   * is happening. Reading it when the tab comes forward is both cheaper and
   * always current.
   */
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      try {
        setResumable(client.db.games.resumable());
      } catch {
        // A history table that will not read costs the shelf, not the screen.
        setResumable([]);
      }
    }, [client]),
  );

  /**
   * Whether the link with the person we would actually play is a fast one.
   *
   * With one friend connected that is simply their link. With several, the best
   * of them - the catalogue is a shelf, not a promise about a particular peer,
   * and the per-peer answer is given by `bestAvailabilityFor` on each tile.
   */
  const highBandwidth = connected.some((peer) => peer.highBandwidth);
  const { toggle: toggleFavourite, isFavourite, ids: favourites } = useFavourites(client);
  const [duration, setDuration] = useState<DurationFilter>(DurationFilter.ANY);
  const shelves = useMemo(
    () => buildShelves({ favourites, duration, highBandwidth }),
    [favourites, duration, highBandwidth],
  );
  const slowLinkNote = useSlowLinkNote(highBandwidth);

  const columns = width >= 700 ? 3 : 2;
  const gutter = theme.spacing.md;
  const tileWidth = (width - theme.spacing.lg * 2 - gutter * (columns - 1)) / columns;

  const soloPeer = connected.length === 1 ? connected[0] ?? null : null;

  /**
   * The tab's own hue, for the things on this screen that are not about a
   * single category: the "in progress" shelf, the favourites shelf, the empty
   * state, and the selected length chip.
   */
  const playHue = areaColor(theme.colors, 'Play');

  const open = useCallback(
    (entry: GameCatalogueEntry, peer: PeerView) => {
      navigation.navigate('GameRoom', {
        peerKey: peer.key,
        gameId: entry.definition.id,
        gameSessionId: newGameSessionId(),
        isHost: true,
      });
    },
    [navigation],
  );

  const choose = useCallback(
    (entry: GameCatalogueEntry) => {
      if (soloPeer) open(entry, soloPeer);
      else setPendingGame(entry);
    },
    [open, soloPeer],
  );

  const resume = useCallback(
    (row: GameSessionRow, peerKey: string) => {
      navigation.navigate('GameRoom', {
        peerKey,
        gameId: row.gameId,
        gameSessionId: row.id,
        isHost: row.hostPeerId === profile?.peerId,
      });
    },
    [navigation, profile?.peerId],
  );

  // The tab has no navigation header, so the title has to clear the notch itself.
  const topPadding = { paddingTop: insets.top + theme.spacing.xl };

  const inviteSheet = null;

  if (connected.length === 0) {
    return (
      <>
        <Screen scroll style={topPadding}>
          <Label variant="largeTitle">{strings.play.title}</Label>
          <Gap size="lg" />
          {/* Half-played games belong here MORE than anywhere else: a friend
              who just walked out of range is exactly when "you have a chess
              game going with Maria" is worth seeing. The rows say they are not
              connected and do not open. */}
          <ResumeShelf
            rows={resumable}
            myPeerId={profile?.peerId ?? null}
            client={client}
            onResume={resume}
          />
          <EmptyState
            icon="dice"
            area="Play"
            title={playText.tabs.nobodyTitle}
            body={playText.tabs.nobodyBody}
            action={
              <Button title={playText.tabs.goHome} onPress={() => navigation.navigate('Home')} />
            }
          />
        </Screen>
        {inviteSheet}
      </>
    );
  }

  return (
    <>
      <Screen scroll style={topPadding}>
        <Label variant="largeTitle">{strings.play.title}</Label>
        <Gap size="lg" />

        <ResumeShelf
          rows={resumable}
          myPeerId={profile?.peerId ?? null}
          client={client}
          onResume={resume}
        />

        {/*
          "Surprise us", and how long you have.
          Both are for the same moment: two people who want to play something
          and do not want to read thirty names to decide what.
        */}
        <Row gap="sm">
          <Button
            title={catalogueCopy.random}
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() => {
              const entry = randomGame(highBandwidth, Math.random());
              if (entry) choose(entry);
            }}
          />
        </Row>
        <Gap size="sm" />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.spacing.xs }}
        >
          {durationOptions().map((option) => (
            <Pressable
              key={String(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: duration === option.value }}
              onPress={() => setDuration(option.value)}
              style={{
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.xs,
                borderRadius: theme.radius.pill,
                /*
                  The chosen length is marked in the Play hue rather than in
                  `accent`, which belongs to primary actions and to nothing
                  else - a filter chip that looks like the app's one blue
                  button teaches people the wrong thing about the button.

                  The tint is the ground and the label stays full-strength
                  text, rather than white on the hue: several of these hues sit
                  near 3:1 against white, which is not enough for type this
                  small in either scheme.
                */
                backgroundColor:
                  duration === option.value ? theme.colors.areaPlayMuted : theme.colors.surface,
                // Both states carry a border so selecting one does not move the
                // row by a hairline.
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: duration === option.value ? playHue : theme.colors.separator,
              }}
            >
              <Label
                variant="footnote"
                tone={duration === option.value ? 'primary' : 'secondary'}
              >
                {option.label}
              </Label>
            </Pressable>
          ))}
        </ScrollView>

        {slowLinkNote ? (
          <>
            <Gap size="sm" />
            <Label variant="caption" tone="tertiary">
              {slowLinkNote}
            </Label>
          </>
        ) : null}

        {shelves.map((shelf) => (
          <View key={shelf.key}>
            <Gap size="lg" />
            {/*
              A shelf's key IS its category, which is what makes the rule above
              it the same colour as the marks on the tiles below it. Favourites
              is the one shelf that is not a category - it mixes them - so it
              takes the tab's own hue instead.
            */}
            <SectionHeading hue={shelf.key === 'favourites' ? playHue : categoryColor(theme.colors, shelf.key)}>
              {shelf.title}
            </SectionHeading>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: gutter }}>
              {shelf.entries.map((entry) => (
                <GameTile
                  key={`${shelf.key}:${entry.definition.id}`}
                  entry={entry}
                  width={tileWidth}
                  availability={bestAvailabilityFor(client, connected, entry)}
                  favourite={isFavourite(entry.definition.id)}
                  onToggleFavourite={() => toggleFavourite(entry.definition.id)}
                  note={needsBetterLink(entry, highBandwidth) ? catalogueCopy.needsBetterLink : null}
                  onPress={() => choose(entry)}
                />
              ))}
            </View>
          </View>
        ))}
      </Screen>

      <PeerSheet
        entry={pendingGame}
        peers={connected}
        client={client}
        onClose={() => setPendingGame(null)}
        onPick={(peer) => {
          const entry = pendingGame;
          setPendingGame(null);
          if (entry) open(entry, peer);
        }}
      />

      {inviteSheet}
    </>
  );
}

/**
 * "Maria invited you to play Chess."
 *
 * The one thing on this screen that interrupts, because it is a question with a
 * deadline: the other phone stops asking after forty-five seconds. Declining
 * says so out loud, so their screen stops waiting instead of timing out.
 *
 * There is no way to dismiss this without answering it, deliberately - both
 * answers are one tap, and both tell the other person something.
 */
/**
 * Games left half-played.
 *
 * A row is listed whether or not the friend is in range, because "you have a
 * chess game going with Maria" is worth knowing either way - but it only opens
 * when they are actually here, and says which of the two it is.
 */
function ResumeShelf({
  rows,
  myPeerId,
  client,
  onResume,
}: {
  rows: readonly GameSessionRow[];
  myPeerId: string | null;
  client: ReturnType<typeof useOptionalClient>;
  onResume: (row: GameSessionRow, peerKey: string) => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  if (rows.length === 0) return null;

  const playable = rows.filter((row) => findGame(row.gameId) !== undefined);
  if (playable.length === 0) return null;

  return (
    <View style={{ marginBottom: theme.spacing.xl }}>
      <SectionHeading hue={areaColor(theme.colors, 'Play')}>{playText.tabs.inProgress}</SectionHeading>
      <Card style={{ paddingVertical: theme.spacing.xs }}>
        {playable.map((row, index) => {
          const entry = findGame(row.gameId);
          const opponentId = row.players.find((player) => player !== myPeerId) ?? null;
          const peerKey = peerKeyForPeerId(client, opponentId);
          const handle = peerKey && client ? client.peer(peerKey) : null;
          const name = handle?.session.capabilities?.displayName ?? '';

          return (
            <View key={row.id}>
              {index === 0 ? null : <Divider />}
              <ListRow
                title={entry?.definition.name ?? ''}
                subtitle={peerKey ? playText.tabs.withPerson(name) : playText.tabs.notConnected}
                left={<Avatar name={name} peerId={opponentId} size={36} />}
                right={
                  peerKey ? (
                    <Label variant="footnote" tone="accent">
                      {strings.play.resume}
                    </Label>
                  ) : (
                    <StatusDot tone="disconnected" />
                  )
                }
                onPress={peerKey ? () => onResume(row, peerKey) : undefined}
              />
            </View>
          );
        })}
      </Card>
    </View>
  );
}

/** Who are you playing? Only ever shown when there is a real choice to make. */
function PeerSheet({
  entry,
  peers,
  client,
  onClose,
  onPick,
}: {
  entry: GameCatalogueEntry | null;
  peers: readonly PeerView[];
  client: ReturnType<typeof useOptionalClient>;
  onClose: () => void;
  onPick: (peer: PeerView) => void;
}): React.JSX.Element {
  const theme = useTheme();

  return (
    <Modal visible={entry !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.common.close}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: theme.colors.scrim }}
      />
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
        <Label variant="title2">{playText.tabs.chooseOpponent}</Label>
        <Gap size="md" />
        {peers.map((peer, index) => {
          const availability = entry
            ? availabilityFor(client, peer.key, entry, peer.displayName)
            : { playable: false, reason: null };
          return (
            <View key={peer.key}>
              {index === 0 ? null : <Divider />}
              <ListRow
                title={peer.displayName}
                subtitle={availability.playable ? strings.home.connected : availability.reason ?? undefined}
                left={<Avatar name={peer.displayName} peerId={peer.peerId} color={peer.avatarColor} size={40} />}
                onPress={availability.playable ? () => onPick(peer) : undefined}
              />
            </View>
          );
        })}
        <Gap size="md" />
        <Button title={strings.common.cancel} variant="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}
