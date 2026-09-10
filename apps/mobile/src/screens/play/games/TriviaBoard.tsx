import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button, Label, useTheme } from '../../../ui/index.js';
import { Hint, MIN_TARGET, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  MAX_ANSWER_MS,
  UNANSWERED,
  currentQuestion,
  hasAnswered,
  revealedCorrect,
  type TriviaState,
} from '../gameTypes.js';

/**
 * Trivia.
 *
 * The timer is a UI object, not a state one - a turn-based reducer has no
 * clock, so "twenty seconds" cannot be stored anywhere both devices would agree
 * on. Each device counts its own question down and reports how long it took;
 * the reducer scores the reported time and the HOST decides when a question is
 * closed. That is why the "time is up" action only exists on the host's screen:
 * a guest whose timer runs out has simply run out of time to answer.
 *
 * The answer key never leaves the question generator until the reveal.
 * `revealedCorrect` returns null while the question is open, so there is no
 * moment where the right answer is sitting in a variable on the screen that
 * shows the question.
 */

/** How long a question is allowed to stay open. Well inside the wire limit. */
const QUESTION_WINDOW_MS = 20_000;
const TICK_MS = 100;
/**
 * When the bar starts to press. Amber rather than red on purpose: running low
 * on time is a nudge, not the failure the danger colour is reserved for.
 */
const URGENT_MS = 5_000;

export function TriviaBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  disabledReason,
}: GameRendererProps<TriviaState>): React.JSX.Element {
  const theme = useTheme();

  const question = useMemo(() => currentQuestion(state), [state]);
  const correct = revealedCorrect(state);
  const answered = hasAnswered(state, local);
  const seat = players.indexOf(local);
  const isHost = players[0] === local;
  const myChoice = state.choices[seat] ?? UNANSWERED;

  /** When this device put the question on screen. The origin of its own clock. */
  const shownAt = useRef(Date.now());
  const [remainingMs, setRemainingMs] = useState(QUESTION_WINDOW_MS);

  useEffect(() => {
    shownAt.current = Date.now();
    setRemainingMs(QUESTION_WINDOW_MS);
    if (state.revealed) return;
    const timer = setInterval(() => {
      const left = QUESTION_WINDOW_MS - (Date.now() - shownAt.current);
      setRemainingMs(left > 0 ? left : 0);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [state.position, state.revealed]);

  const expired = remainingMs <= 0;
  // Once the countdown has run out the screen has told the user their time is
  // up, so the options go with it. Leaving them tappable would score an answer
  // the screen had already refused to accept.
  const closed = answered || state.revealed || expired || !live;

  const answer = (choice: number): void => {
    if (closed) return;
    const elapsedMs = Math.min(MAX_ANSWER_MS, Math.max(0, Math.round(Date.now() - shownAt.current)));
    dispatch('answer', { choice, elapsedMs });
  };

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={null}
        nameFor={nameFor}
        scoreFor={(player) => state.scores[players.indexOf(player)] ?? 0}
      />

      <View style={{ height: theme.spacing.lg }} />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Label variant="caption" tone="tertiary">
          {playText.trivia.question(state.position + 1, state.total)}
        </Label>
        {state.revealed ? null : (
          <Label variant="caption" tone={remainingMs < URGENT_MS ? 'accent' : 'tertiary'}>
            {playText.trivia.secondsLeft(Math.ceil(remainingMs / 1000))}
          </Label>
        )}
      </View>

      {/* A bar rather than a spinning number: it is readable at a glance and it
          has an end, which is the whole promise of a countdown. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          height: 3,
          marginTop: theme.spacing.xs,
          borderRadius: theme.radius.sm,
          backgroundColor: theme.colors.surfaceElevated,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${state.revealed ? 100 : (remainingMs / QUESTION_WINDOW_MS) * 100}%`,
            height: 3,
            backgroundColor:
              remainingMs < URGENT_MS && !state.revealed ? theme.colors.warning : theme.colors.accent,
          }}
        />
      </View>

      <View style={{ height: theme.spacing.lg }} />

      <Label variant="caption" tone="tertiary">
        {question.category.toUpperCase()}
      </Label>
      <Label variant="title2" style={{ marginTop: theme.spacing.xs }}>
        {question.prompt}
      </Label>

      <View style={{ height: theme.spacing.lg }} />

      <View style={{ gap: theme.spacing.sm }}>
        {question.options.map((option, index) => {
          const chosen = myChoice === index;
          const isKey = correct !== null && correct === index;
          const wrongPick = correct !== null && chosen && correct !== index;
          return (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={option}
              accessibilityState={{ selected: chosen, disabled: closed }}
              disabled={closed}
              onPress={() => answer(index)}
              style={({ pressed }) => [
                {
                  minHeight: MIN_TARGET + 8,
                  justifyContent: 'center',
                  paddingHorizontal: theme.spacing.lg,
                  paddingVertical: theme.spacing.md,
                  borderRadius: theme.radius.md,
                  borderWidth: 1,
                  borderColor: isKey
                    ? theme.colors.connected
                    : wrongPick
                    ? theme.colors.danger
                    : chosen
                    ? theme.colors.accent
                    : theme.colors.separator,
                  backgroundColor: chosen ? theme.colors.accentMuted : theme.colors.surface,
                  opacity: answered && !chosen && correct === null ? 0.6 : 1,
                },
                pressed ? { opacity: 0.7 } : null,
              ]}
            >
              <Label variant="callout" numberOfLines={3}>
                {option}
              </Label>
            </Pressable>
          );
        })}
      </View>

      <View style={{ height: theme.spacing.lg }} />

      {state.revealed ? (
        isHost ? (
          <Button
            title={playText.trivia.nextQuestion}
            onPress={() => dispatch('next', {})}
            disabled={!live}
            disabledReason={disabledReason ?? undefined}
          />
        ) : (
          <Hint text={playText.trivia.hostAdvances} />
        )
      ) : answered ? (
        <Hint text={playText.trivia.answered} />
      ) : expired && isHost ? (
        <Button
          title={playText.trivia.closeQuestion}
          onPress={() => dispatch('next', {})}
          disabled={!live}
          disabledReason={disabledReason ?? undefined}
        />
      ) : expired ? (
        <Hint text={playText.trivia.timeUp} />
      ) : null}
    </View>
  );
}
