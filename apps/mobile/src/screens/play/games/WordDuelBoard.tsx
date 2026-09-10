import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import { Button, Label, haptic, useTheme } from '../../../ui/index.js';
import { BoardSurface, Hint, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  MIN_WORD_LENGTH,
  WORD_GRID_SIZE,
  neighbours,
  scoreForLength,
  wordDuelScores,
  type WordDuelState,
} from '../gameTypes.js';

/**
 * Word Duel.
 *
 * Sixteen letters, both players hunting the same grid at the same time, and a
 * word both of them find cancels out - so the game is not about finding words,
 * it is about finding the ones they missed.
 *
 * THE TRACE. A finger dragged across the grid is turned into a path of cell
 * indices by hit-testing against a fixed pitch rather than by measuring
 * anything, so it works on the very first touch. A cell joins the path only if
 * `neighbours` says it touches the previous one - the same adjacency the
 * reducer checks, imported from the game rather than re-derived here, so the
 * trace can never draw a word the rules would refuse.
 *
 * A word already found is left visibly on the board's list rather than hidden,
 * because the interesting information at the end of a round is which words were
 * shared and therefore cancelled.
 */

const MAX_BOARD = 340;

interface Feedback {
  readonly text: string;
  readonly at: number;
}

/** How long a word - or a refusal - stays under the grid. */
const FEEDBACK_MS = 1600;

export function WordDuelBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  width,
}: GameRendererProps<WordDuelState>): React.JSX.Element {
  const theme = useTheme();

  const board = Math.min(width, MAX_BOARD);
  const inner = board - theme.spacing.sm * 2;
  const pitch = inner / WORD_GRID_SIZE;

  const [path, setPath] = useState<readonly number[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Mirrors `path` for the responder callbacks, which fire far faster than
  // React re-renders and must not read a stale closure.
  const pathRef = useRef<readonly number[]>([]);

  const iAmDone = state.finishedBy.includes(local);
  const canPlay = live && !iAmDone;

  // A refusal that never leaves reads as a permanent state rather than an
  // answer to what was just traced.
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  const totals = useMemo(() => wordDuelScores(state), [state]);
  const mine = useMemo(
    () => state.submissions.filter((s) => s.player === local),
    [state.submissions, local],
  );
  const sharedWords = useMemo(() => {
    const byWord = new Map<string, number>();
    for (const s of state.submissions) byWord.set(s.word, (byWord.get(s.word) ?? 0) + 1);
    return byWord;
  }, [state.submissions]);

  const cellAt = useCallback(
    (event: GestureResponderEvent): number | null => {
      const { locationX, locationY } = event.nativeEvent;
      const col = Math.floor(locationX / pitch);
      const row = Math.floor(locationY / pitch);
      if (col < 0 || row < 0 || col >= WORD_GRID_SIZE || row >= WORD_GRID_SIZE) return null;
      return row * WORD_GRID_SIZE + col;
    },
    [pitch],
  );

  const extend = useCallback((cell: number | null) => {
    if (cell === null) return;
    const current = pathRef.current;
    const last = current[current.length - 1];
    if (last === cell) return;
    // Backing up over the previous letter undoes it, which is how every word
    // game of this shape behaves and what people try first when they misdraw.
    if (current.length >= 2 && current[current.length - 2] === cell) {
      const shorter = current.slice(0, current.length - 1);
      pathRef.current = shorter;
      setPath(shorter);
      return;
    }
    if (current.includes(cell)) return;
    if (last !== undefined && !neighbours(last).includes(cell)) return;
    const next = [...current, cell];
    pathRef.current = next;
    setPath(next);
    haptic('selection');
  }, []);

  const finishTrace = useCallback(() => {
    const traced = pathRef.current;
    pathRef.current = [];
    setPath([]);
    if (traced.length === 0) return;
    const word = traced.map((cell) => state.grid[cell] ?? '').join('');
    if (word.length < MIN_WORD_LENGTH) {
      setFeedback({ text: playText.wordDuel.tooShort, at: Date.now() });
      return;
    }
    if (mine.some((s) => s.word === word)) {
      setFeedback({ text: playText.wordDuel.alreadyFound, at: Date.now() });
      return;
    }
    // The reducer is the dictionary. It refuses anything that is not a word, so
    // there is no second word list here to disagree with it.
    const accepted = dispatch('submit', { word, path: [...traced] });
    if (accepted) haptic('success');
    setFeedback({ text: accepted ? word.toUpperCase() : playText.wordDuel.notAWord, at: Date.now() });
  }, [dispatch, mine, state.grid]);

  const traced = useMemo(() => new Set(path), [path]);
  const tracedWord = path.map((cell) => state.grid[cell] ?? '').join('');

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={null}
        nameFor={nameFor}
        scoreFor={(player) => totals.get(player) ?? 0}
        captionFor={(player) =>
          state.finishedBy.includes(player) ? playText.wordDuel.finished : null
        }
      />

      <View style={{ height: theme.spacing.md }} />

      <Label variant="title2" align="center" tone={path.length > 0 ? 'accent' : 'tertiary'}>
        {path.length > 0 ? tracedWord.toUpperCase() : feedback?.text ?? ' '}
      </Label>

      <View style={{ height: theme.spacing.md }} />

      <BoardSurface size={board}>
        <View
          accessible={false}
          style={{ width: inner, height: inner, flexDirection: 'row', flexWrap: 'wrap' }}
          onStartShouldSetResponder={() => canPlay}
          onMoveShouldSetResponder={() => canPlay}
          onResponderGrant={(event) => extend(cellAt(event))}
          onResponderMove={(event) => extend(cellAt(event))}
          onResponderRelease={finishTrace}
          onResponderTerminate={finishTrace}
        >
          {state.grid.map((letter, index) => {
            const inPath = traced.has(index);
            return (
              <View
                key={index}
                // The grid is one control, not sixteen: a screen reader cannot
                // trace a path, so each letter is read as text and the words
                // found are the part that is navigable.
                accessible
                accessibilityLabel={letter.toUpperCase()}
                style={{
                  width: pitch,
                  height: pitch,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View
                  style={{
                    width: pitch - theme.spacing.xs,
                    height: pitch - theme.spacing.xs,
                    borderRadius: theme.radius.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: inPath ? theme.colors.accent : theme.colors.surfaceElevated,
                  }}
                >
                  <Label variant="title2" tone={inPath ? 'onAccent' : 'primary'}>
                    {letter.toUpperCase()}
                  </Label>
                </View>
              </View>
            );
          })}
        </View>
      </BoardSurface>

      <Hint text={iAmDone ? playText.wordDuel.waitingOther : playText.wordDuel.hint} />

      <View style={{ height: theme.spacing.lg }} />

      <Label variant="caption" tone="tertiary">
        {playText.wordDuel.yourWords.toUpperCase()}
      </Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
        {mine.length === 0 ? (
          <Label variant="footnote" tone="tertiary">
            {playText.wordDuel.nothingYet}
          </Label>
        ) : (
          mine.map((submission) => {
            const shared = (sharedWords.get(submission.word) ?? 1) > 1;
            return (
              <View
                key={submission.word}
                accessible
                accessibilityLabel={`${submission.word}, ${
                  shared ? playText.wordDuel.shared : playText.wordDuel.points(scoreForLength(submission.word.length))
                }`}
                style={{
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.xs,
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.colors.surfaceElevated,
                  opacity: shared ? 0.5 : 1,
                }}
              >
                <Label variant="footnote" tone={shared ? 'tertiary' : 'primary'}>
                  {submission.word.toUpperCase()}
                </Label>
              </View>
            );
          })
        )}
      </View>

      <View style={{ height: theme.spacing.lg }} />

      {iAmDone ? null : (
        <Button
          title={playText.wordDuel.finish}
          variant="secondary"
          onPress={() => dispatch('finish', null)}
          disabled={!live}
          disabledReason={live ? undefined : playText.room.waitingForLink}
        />
      )}
    </View>
  );
}
