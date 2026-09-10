import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button, Label, haptic, useTheme } from '../../../ui/index.js';
import { Hint, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  MAX_TAP_MS,
  NOT_TAPPED,
  NO_TIME,
  REACTION_NOBODY,
  REACTION_NO_ROUND,
  ROUNDS_TO_PLAY,
  ReactionPhase,
  isFalseStart,
  reactionPhase,
  type ReactionState,
} from '../gameTypes.js';

/**
 * Reaction.
 *
 * The one game whose whole point is a number this device measures itself.
 *
 * A turn-based reducer has no clock - `context.elapsedMs` is always zero - so
 * the countdown to green cannot live in the state, and does not: the state
 * carries `greenAtMs`, an offset drawn from the shared seed, and each device
 * starts its own stopwatch the moment it sees the round arm. Both phones
 * therefore turn green at the same offset from their own start, and each
 * reports a time measured entirely on the finger that made it. The link's
 * latency never enters the measurement, which is exactly why the rules compare
 * REPORTED times and refuse to decide the round on which packet landed first.
 *
 * The screen is the button. A target smaller than the whole panel would measure
 * how well someone can aim rather than how fast they can move.
 */

export function ReactionBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
}: GameRendererProps<ReactionState>): React.JSX.Element {
  const theme = useTheme();

  const seat = players.indexOf(local);
  const phase = reactionPhase(state);
  const armed = state.greenAtMs > 0;

  /** When THIS device saw the round arm. The origin of every time it reports. */
  const armedAt = useRef<number | null>(null);
  const [green, setGreen] = useState(false);

  useEffect(() => {
    if (!armed) {
      armedAt.current = null;
      setGreen(false);
      return;
    }
    const startedAt = Date.now();
    armedAt.current = startedAt;
    setGreen(false);
    const timer = setTimeout(() => {
      setGreen(true);
      haptic('impactMedium');
    }, state.greenAtMs);
    return () => clearTimeout(timer);
    // `round` is in the list so a second round with an identical wait still
    // restarts the stopwatch rather than reusing the first round's.
  }, [armed, state.greenAtMs, state.round]);

  const myTap = state.taps[seat] ?? NOT_TAPPED;
  const iAmReady = state.ready[seat] === true;
  const waiting = armed && myTap !== NOT_TAPPED;

  const tap = (): void => {
    const startedAt = armedAt.current;
    if (startedAt === null || myTap !== NOT_TAPPED || !live) return;
    const atMs = Math.min(MAX_TAP_MS, Math.max(0, Math.round(Date.now() - startedAt)));
    haptic(isFalseStart(state.greenAtMs, atMs) ? 'error' : 'success');
    dispatch('tap', { atMs });
  };

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={null}
        nameFor={nameFor}
        scoreFor={(player) => state.wins[players.indexOf(player)] ?? 0}
        captionFor={(player) => {
          const index = players.indexOf(player);
          const best = state.best[index] ?? NO_TIME;
          return best === NO_TIME ? null : `${playText.reaction.best} ${playText.reaction.yourTime(best)}`;
        }}
      />

      <View style={{ height: theme.spacing.md }} />

      <Label variant="footnote" tone="tertiary" align="center">
        {playText.reaction.round(Math.min(state.round + 1, ROUNDS_TO_PLAY), ROUNDS_TO_PLAY)}
      </Label>

      <View style={{ height: theme.spacing.md }} />

      {phase === ReactionPhase.ARMING ? (
        <View style={{ gap: theme.spacing.md }}>
          <Panel tone="idle" label={playText.reaction.holdOn} />
          {iAmReady ? (
            <Hint text={playText.reaction.waitingOthers} />
          ) : (
            <Button
              title={playText.reaction.ready}
              onPress={() => dispatch('ready', null)}
              disabled={!live}
              disabledReason={live ? undefined : playText.room.waitingForLink}
            />
          )}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playText.reaction.tapTarget}
          accessibilityHint={green ? playText.reaction.tapNow : playText.reaction.holdOn}
          accessibilityState={{ disabled: waiting || !live }}
          disabled={waiting || !live}
          onPress={tap}
        >
          <Panel
            tone={waiting ? 'idle' : green ? 'go' : 'wait'}
            label={waiting ? playText.reaction.reported : green ? playText.reaction.tapNow : playText.reaction.holdOn}
          />
        </Pressable>
      )}

      <View style={{ height: theme.spacing.lg }} />

      <RoundResult state={state} players={players} local={local} nameFor={nameFor} />
    </View>
  );
}

/**
 * The panel.
 *
 * Green is the app's `connected` token and red is `danger` - the only two
 * colours in the palette that already mean "go" and "stop", so the game borrows
 * the app's vocabulary instead of introducing traffic lights of its own. This
 * is the one screen where `danger` is not an error: it is an instruction not to
 * move yet, and the words on it say so.
 */
function Panel({ tone, label }: { tone: 'idle' | 'wait' | 'go'; label: string }): React.JSX.Element {
  const theme = useTheme();
  const background =
    tone === 'go' ? theme.colors.connected : tone === 'wait' ? theme.colors.danger : theme.colors.surfaceElevated;
  return (
    <View
      style={{
        height: 240,
        borderRadius: theme.radius.xl,
        backgroundColor: background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Label variant="title" tone={tone === 'idle' ? 'secondary' : 'onAccent'}>
        {label}
      </Label>
    </View>
  );
}

/** Last round's times, once there is a last round. */
function RoundResult({
  state,
  players,
  local,
  nameFor,
}: {
  state: ReactionState;
  players: readonly string[];
  local: string;
  nameFor: (player: string) => string;
}): React.JSX.Element | null {
  const theme = useTheme();
  if (state.lastWinner === REACTION_NO_ROUND) return null;

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Label variant="footnote" tone="secondary" align="center">
        {state.lastWinner === REACTION_NOBODY
          ? playText.reaction.roundToNobody
          : nameOf(players[state.lastWinner] ?? '', local, nameFor)}
      </Label>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: theme.spacing.lg }}>
        {players.map((player, index) => {
          const time = state.lastReactions[index] ?? NO_TIME;
          return (
            <Label key={player} variant="caption" tone="tertiary">
              {`${nameOf(player, local, nameFor)} ${
                time === NO_TIME ? playText.reaction.falseStart : playText.reaction.yourTime(time)
              }`}
            </Label>
          );
        })}
      </View>
    </View>
  );
}

function nameOf(player: string, local: string, nameFor: (player: string) => string): string {
  return player === local ? playText.room.you : nameFor(player);
}
