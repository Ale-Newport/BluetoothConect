import React, { useCallback, useState } from 'react';
import { Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { strings } from '@airlink/config';
import { Button, Gap, Label, StatusBanner, useTheme } from '../../ui/index.js';
import { LiveDot, MIN_TARGET } from './boardKit.js';
import { playText } from './strings.js';

/**
 * The scene a game is played inside.
 *
 * A game is not a page. Everywhere else in AirLink you scroll, you swipe back,
 * you pull to refresh - and every one of those is a hazard in the middle of a
 * rally. The room used to be an ordinary `ScrollView`, so:
 *
 *   - a vertical drag on a paddle scrolled the page instead of moving it, and
 *     the scroll then CANCELLED the touch, which Word Duel and Draw & Guess
 *     read as "finger lifted" and submitted a half-traced word or a half-drawn
 *     stroke to the other phone;
 *   - a drag from the left edge popped the screen, which told the other player
 *     you had quit, mid-game;
 *   - boards were measured against the window's WIDTH and nothing else, so a
 *     tall one ran off the bottom of the screen, which was what made the page
 *     scrollable in the first place.
 *
 * So this is a fixed scene. It occupies exactly the space between the safe-area
 * insets, never scrolls in either direction, and hands the board a width AND a
 * height so a renderer can size itself to fit rather than overflowing. The back
 * gesture is disabled for this route in the navigator; leaving is a decision,
 * so it has a control that says so and asks before telling the other player.
 *
 * Everything a game shares lives here - opponent, link, scores, whose turn,
 * exit, rematch - and everything a game does not share is the board it wraps.
 */

export interface GameShellProps {
  /** The game's own name. */
  readonly title: string;
  /** Who you are playing. Empty while nobody is known. */
  readonly opponentName: string;
  /** Is the link up right now. */
  readonly live: boolean;
  /** "Your turn" / "Maria's turn", or null when it is nobody's. */
  readonly turnLine?: string | null;
  /** Score line, already phrased. */
  readonly scoreLine?: string | null;
  /** Told before the exit is taken, so the peer can be notified. */
  readonly onExit: () => void;
  /** Shown above the board: a rematch offer, a banner, anything transient. */
  readonly banner?: React.ReactNode;
  /**
   * The board.
   *
   * Given the exact box it may occupy. A renderer that respects both numbers
   * cannot make the scene scroll, because there is nowhere for it to overflow
   * to.
   */
  readonly children: (box: { width: number; height: number }) => React.ReactNode;
}

export function GameShell({
  title,
  opponentName,
  live,
  turnLine,
  scoreLine,
  onExit,
  banner,
  children,
}: GameShellProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [confirming, setConfirming] = useState(false);
  const [boardBox, setBoardBox] = useState<{ width: number; height: number } | null>(null);

  const requestExit = useCallback(() => setConfirming(true), []);
  const confirmExit = useCallback(() => {
    setConfirming(false);
    onExit();
  }, [onExit]);

  const fallbackBox = {
    width: width - theme.spacing.lg * 2,
    height: Math.max(240, height - insets.top - insets.bottom - 200),
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.background,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      {/* Header: who, how good the link is, and the one way out. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.sm,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.play.leaveGame}
          onPress={requestExit}
          hitSlop={theme.spacing.md}
          style={({ pressed }) => [
            {
              minHeight: MIN_TARGET,
              minWidth: MIN_TARGET,
              justifyContent: 'center',
            },
            pressed ? { opacity: 0.6 } : null,
          ]}
        >
          <Label variant="headline" tone="accent">
            {playText.room.exit}
          </Label>
        </Pressable>

        <View style={{ flex: 1, alignItems: 'center' }}>
          <Label variant="headline" numberOfLines={1}>
            {title}
          </Label>
          {opponentName ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
              <LiveDot live={live} />
              <Label variant="footnote" tone="secondary" numberOfLines={1}>
                {opponentName}
              </Label>
            </View>
          ) : null}
        </View>

        {/* Balances the exit control so the title sits centred. */}
        <View style={{ minWidth: MIN_TARGET }} />
      </View>

      {(turnLine ?? scoreLine) ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: theme.spacing.lg,
            paddingBottom: theme.spacing.xs,
          }}
        >
          <Label variant="footnote" tone="secondary" numberOfLines={1}>
            {turnLine ?? ''}
          </Label>
          <Label variant="footnote" tone="tertiary" numberOfLines={1}>
            {scoreLine ?? ''}
          </Label>
        </View>
      ) : null}

      {live ? null : (
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
          <StatusBanner
            tone="connecting"
            title={strings.connection.reconnecting}
            detail={playText.room.reconnectingDetail}
          />
        </View>
      )}

      {banner ? <View style={{ paddingHorizontal: theme.spacing.lg }}>{banner}</View> : null}

      {/*
        The board's box, measured rather than assumed.
        `flex: 1` takes whatever the header and the banners left, and onLayout
        reports it - so a renderer sizes itself against the real remaining
        space on THIS phone, in THIS orientation, with THIS banner showing.
      */}
      <View
        style={{ flex: 1, paddingHorizontal: theme.spacing.lg, justifyContent: 'center' }}
        onLayout={(event) => {
          const { width: w, height: h } = event.nativeEvent.layout;
          setBoardBox((held) =>
            held && Math.abs(held.width - w) < 1 && Math.abs(held.height - h) < 1
              ? held
              : { width: Math.round(w), height: Math.round(h) },
          );
        }}
      >
        {children(boardBox ?? fallbackBox)}
      </View>

      {/*
        "Leave game?"
        Asked, because leaving ends the game for the other person too, and
        because the control sits next to a board people are tapping quickly.
      */}
      <Modal visible={confirming} transparent animationType="fade" onRequestClose={() => setConfirming(false)}>
        <View
          style={{
            flex: 1,
            backgroundColor: theme.colors.scrim,
            alignItems: 'center',
            justifyContent: 'center',
            padding: theme.spacing.lg,
          }}
        >
          <View
            style={[
              {
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.xl,
                padding: theme.spacing.lg,
                alignSelf: 'stretch',
              },
              theme.shadows.sheet,
            ]}
          >
            <Label variant="title2">{playText.room.leaveTitle}</Label>
            <Gap size="xs" />
            <Label variant="footnote" tone="secondary">
              {playText.room.leaveBody(opponentName)}
            </Label>
            <Gap size="lg" />
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Button
                title={strings.common.cancel}
                variant="secondary"
                style={{ flex: 1 }}
                onPress={() => setConfirming(false)}
              />
              <Button title={playText.room.leaveConfirm} style={{ flex: 1 }} onPress={confirmExit} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
