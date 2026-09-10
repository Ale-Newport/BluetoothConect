import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ConnectionState, newUuidLike, systemRandom } from '@airlink/core';
import { strings } from '@airlink/config';
import type { GameCatalogueEntry } from '@airlink/games';
import { Label, haptic, useTheme } from '../../ui/index.js';
import type { AirLinkClient } from '../../client/AirLinkClient.js';
import { MIN_TARGET } from './boardKit.js';
import { playText } from './strings.js';
import { hasRenderer } from './games/index.js';
import { GameArt } from './gameArt.js';

/**
 * What can actually be played, and the tile that says so.
 *
 * A tile is only live when THREE things are true at once, and the reason it is
 * not is always a sentence a person can act on:
 *
 *   1. somebody is connected;
 *   2. their build has the game - the capability list exchanged in the
 *      handshake comes from their own registry, so it is a fact rather than an
 *      assumption; and
 *   3. this build can draw it.
 *
 * That third check is the one that stops the worst kind of bug in an app like
 * this: a tile that looks live, opens, and puts up an empty frame. If the
 * renderer is missing, the tile is dead and says so.
 */

export interface Availability {
  readonly playable: boolean;
  /** Why not, in plain words. Null when it is playable. */
  readonly reason: string | null;
}

const AVAILABLE: Availability = { playable: true, reason: null };

/**
 * Can this peer play this game right now?
 *
 * `peerHandle` is the live session, which is where the peer's capability list
 * lives. A peer we can see but have not connected to has no capability list at
 * all, which is exactly why "not connected" is its own answer rather than
 * "they don't have it".
 */
export function availabilityFor(
  client: AirLinkClient | null,
  peerKey: string | null,
  entry: GameCatalogueEntry,
  peerName: string,
): Availability {
  if (!hasRenderer(entry.definition.id)) {
    return { playable: false, reason: playText.tabs.noRenderer };
  }
  if (!client || !peerKey) return { playable: false, reason: playText.tabs.notConnected };

  const handle = client.peer(peerKey);
  if (!handle || handle.session.state !== ConnectionState.CONNECTED) {
    return { playable: false, reason: playText.tabs.notConnected };
  }

  const capabilities = handle.session.capabilities;
  // Before the handshake completes there is no list to check. Treating that as
  // "they don't have it" would flash a wall of disabled tiles for a second on
  // every connection, so an unknown list is optimistic and the invite settles it.
  if (!capabilities) return AVAILABLE;

  const theirs = capabilities.games.find((game) => game.id === entry.definition.id);
  if (!theirs) return { playable: false, reason: strings.play.unavailableBody(peerName) };
  if (theirs.version !== entry.definition.protocolVersion) {
    return { playable: false, reason: playText.tabs.differentVersion(peerName) };
  }
  return AVAILABLE;
}

/**
 * Can ANYBODY here play this game?
 *
 * With several friends connected the tile is live if any one of them can play
 * it, and the sheet that asks who then says which of them cannot. Judging the
 * whole grid against whoever happens to be first in the list would grey out a
 * game two of the three people present could play perfectly well.
 */
export function bestAvailabilityFor(
  client: AirLinkClient | null,
  peers: readonly { readonly key: string; readonly displayName: string }[],
  entry: GameCatalogueEntry,
): Availability {
  if (peers.length === 0) return { playable: false, reason: playText.tabs.notConnected };
  let best: Availability | null = null;
  for (const peer of peers) {
    const availability = availabilityFor(client, peer.key, entry, peer.displayName);
    if (availability.playable) return availability;
    best = best ?? availability;
  }
  return best ?? { playable: false, reason: playText.tabs.notConnected };
}

/** A fresh id for a game about to start. */
export function newGameSessionId(): string {
  return newUuidLike(systemRandom);
}

/**
 * The nearby-peer key for a peer id.
 *
 * A saved game records WHO it was against - a peer id - while navigation talks
 * in the registry's own key for a device that is nearby right now. They are
 * deliberately different things: a friend has one peer id forever and a new key
 * every time they come back into range. Null means "not in range", which is why
 * a resumable game can be listed and still not be resumable this minute.
 */
export function peerKeyForPeerId(client: AirLinkClient | null, peerId: string | null): string | null {
  if (!client || !peerId) return null;
  for (const handle of client.connectedPeers()) {
    if (handle.session.peerId === peerId) return handle.key;
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * One game.
 *
 * Mark, name, blurb, length. The mark is drawn from the game's id rather than
 * carried by the game package, which holds rules and has no opinion about
 * pixels.
 */
export function GameTile({
  entry,
  availability,
  width,
  onPress,
}: {
  entry: GameCatalogueEntry;
  availability: Availability;
  width: number;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { playable, reason } = availability;

  return (
    <View style={{ width }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={entry.definition.name}
        accessibilityHint={playable ? entry.blurb : reason ?? undefined}
        accessibilityState={{ disabled: !playable }}
        disabled={!playable}
        onPress={() => {
          haptic('selection');
          onPress();
        }}
        style={({ pressed }) => [
          {
            minHeight: MIN_TARGET * 2.6,
            padding: theme.spacing.md,
            borderRadius: theme.radius.lg,
            backgroundColor: theme.colors.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.separator,
            opacity: playable ? 1 : 0.5,
          },
          pressed ? { opacity: 0.75, transform: [{ scale: 0.98 }] } : null,
        ]}
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ marginBottom: theme.spacing.xs }}
        >
          {/* Decorative - the game's name is right underneath - and drawn
              rather than typed, because a character is only as reliable as the
              font behind it. See ui/Icon.tsx. */}
          <GameArt gameId={entry.definition.id} size={theme.typography.title.fontSize} />
        </View>
        <Label variant="headline" numberOfLines={1}>
          {entry.definition.name}
        </Label>
        <Label variant="footnote" tone="secondary" numberOfLines={2}>
          {entry.blurb}
        </Label>
        <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.xs }}>
          {playText.tabs.minutes(entry.typicalMinutes)}
        </Label>
      </Pressable>

      {/* The reason lives under the tile, never inside it: a disabled control
          that does not say why is the thing this app refuses to ship. */}
      {playable || !reason ? null : (
        <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.xs }}>
          {reason}
        </Label>
      )}
    </View>
  );
}
