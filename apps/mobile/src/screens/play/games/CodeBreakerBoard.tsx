import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Label, haptic, useTheme, type Theme } from '../../../ui/index.js';
import { BoardSurface, Hint, MIN_TARGET, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import { CODE_COLOURS, type CodeBreakerState } from '../gameTypes.js';

/**
 * Code Breaker.
 *
 * Two people race the same code, so unlike every other board here there is no
 * shared position to look at - there are two private histories that happen to
 * be scored against the same answer. The screen is therefore split: your own
 * attempts at a size you can actually read, and your opponent's beside them,
 * small. Their column is not decoration. How many guesses they have had is the
 * entire tension of the game, and hiding it would leave you racing nobody.
 *
 * Their PEGS are shown too, not just their count. The rules file is explicit
 * that a leader's guess travels in the leader's action and sits on the shared
 * board where the trailing player can read it, so drawing it changes nothing
 * about who can know what - and a column of anonymous rows would imply a
 * secrecy the protocol does not provide.
 *
 * The code itself is in the state from the first frame. It is drawn only once
 * `turn` has gone null, which the room does exactly when the game is no longer
 * in progress.
 */

/**
 * A colour per peg, from the app's own tokens.
 *
 * boardKit's two-ink convention - your accent, their neutral - has nothing to
 * separate here, because neither player owns a peg: both are guessing at the
 * same code and the colours are the alphabet the game is written in, not a
 * claim about whose move it was. Six distinguishable tokens are needed and
 * these are the six the palette has, chosen the same way DrawAndGuessBoard
 * chooses its brushes rather than by inventing hexes this file would then own.
 */
const PEG_KEYS = ['accent', 'connected', 'warning', 'danger', 'text', 'textTertiary'] as const;

/**
 * Guesses each player gets.
 *
 * The rules own this number and gameTypes.js does not re-export it yet, so it
 * is repeated here rather than reached for around the barrel that exists to
 * stop renderers importing out of the app. It is needed before a single guess
 * is played: the ten rows are ruled out in advance, because a history that grew
 * a row at a time would resize itself on every turn, and the empty rows are how
 * the screen says how much rope is left.
 */
const MAX_GUESSES = 10;

/** Widest the board is allowed to get on a tablet, where the box is enormous. */
const MAX_BOARD = 380;
/** A history row never grows past this; past it the pegs just look inflated. */
const MAX_ROW = 30;
/** Below this diameter a letter inside a peg is a smudge, so the peg is colour alone. */
const MIN_LETTERED_PEG = 14;

/**
 * The fixed furniture, measured once so the history can have whatever is left.
 *
 * These are deliberately generous. Being a few points over costs a slightly
 * shorter history row; being a few points under costs an overflow, and an
 * overflowing board is what forced the old game screen to scroll.
 */
const BAR_H = 52;
const CAPTION_H = 22;
const SURFACE_PAD_H = 16;
const LEGEND_H = 20;
const SLOTS_H = 60;
/**
 * The Guess button.
 *
 * Not the 48 its `minHeight` advertises: the button pads by spacing.md + 2 top
 * and bottom around a headline whose line box is 22, so it measures 50 and the
 * minimum never binds. Budgeting the advertised number would have run the
 * history two points long on every phone.
 */
const SUBMIT_H = 50;
/** The line under a disabled button that says why. Its own top margin included. */
const REASON_H = 22;
/** The hint carries its own top margin, so it is the sixth gap as well as a line. */
const HINT_H = 32;

type Attempt = CodeBreakerState['boards'][number][number];

export function CodeBreakerBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  turn,
  live,
  disabledReason,
  width,
  height,
}: GameRendererProps<CodeBreakerState>): React.JSX.Element {
  const theme = useTheme();

  // The code's length is read off the state rather than repeated as a constant,
  // because the state carries it honestly and a second copy could disagree.
  const codeLength = state.secret.length;
  const seat = Math.max(0, players.indexOf(local));
  const other = seat === 0 ? 1 : 0;
  const mine = state.boards[seat] ?? [];
  const theirs = state.boards[other] ?? [];
  const opponent = players[other] ?? null;
  const opponentName = opponent === null ? '' : nameFor(opponent);

  const myTurn = turn === local;
  // `turn` is null exactly when the game is no longer in progress, which is the
  // room's answer rather than a second copy of the rules kept in this file.
  const over = turn === null;
  const spent = mine.length >= MAX_GUESSES;

  const [draft, setDraft] = useState<readonly (number | null)[]>(() =>
    new Array<number | null>(codeLength).fill(null),
  );
  const nextEmpty = draft.indexOf(null);
  const complete = nextEmpty < 0;

  const pegColours = PEG_KEYS.map((key) => theme.colors[key]);

  // -- geometry ------------------------------------------------------------

  const boardW = Math.min(width, MAX_BOARD);
  const inner = boardW - theme.spacing.sm * 2;
  const colGap = theme.spacing.md;
  // A third of the width for the opponent. Enough to read their pegs, not
  // enough to compete with your own history for attention.
  const theirsW = Math.floor((inner - colGap) * 0.34);
  const mineW = inner - colGap - theirsW;

  const chrome =
    BAR_H +
    CAPTION_H +
    SURFACE_PAD_H +
    LEGEND_H +
    SLOTS_H +
    MIN_TARGET +
    SUBMIT_H +
    REASON_H +
    HINT_H +
    theme.spacing.md * 5;
  const historyH = Math.max(0, height - chrome);
  const rowH = Math.max(0, Math.min(MAX_ROW, Math.floor(historyH / MAX_GUESSES)));

  const markSize = Math.max(4, Math.min(9, Math.floor(rowH * 0.36)));
  const markGap = 2;
  const feedbackW = codeLength * markSize + (codeLength - 1) * markGap;
  const numberW = 18;
  const pegGap = 3;
  const minePeg = Math.max(
    6,
    Math.min(
      rowH - 4,
      Math.floor((mineW - numberW - feedbackW - theme.spacing.sm - (codeLength - 1) * pegGap) / codeLength),
    ),
  );
  const theirsPeg = Math.max(
    5,
    Math.min(
      rowH - 6,
      Math.floor((theirsW - feedbackW - theme.spacing.xs - (codeLength - 1) * pegGap) / codeLength),
    ),
  );
  // The composer keeps its size whatever the phone: a slot and a swatch are
  // touch targets, and shrinking those to win back a few points of history
  // would trade something you must hit for something you only read.
  const slotSize = Math.max(MIN_TARGET, Math.min(56, Math.floor((inner - theme.spacing.sm * 3) / codeLength)));

  // -- composing -----------------------------------------------------------

  const fillNext = (colour: number): void => {
    setDraft((held) => {
      const at = held.indexOf(null);
      if (at < 0) return held;
      return held.map((peg, i) => (i === at ? colour : peg));
    });
  };

  const clearSlot = (index: number): void => {
    setDraft((held) => held.map((peg, i) => (i === index ? null : peg)));
  };

  const submit = (): void => {
    // The reducer is the only authority on whether this guess is allowed. A
    // refusal leaves the pegs exactly where they are, so the player can see
    // what was not accepted rather than watching their work vanish.
    if (dispatch('guess', { guess: draft.filter((peg): peg is number => peg !== null) })) {
      setDraft(new Array<number | null>(codeLength).fill(null));
    }
  };

  const submitReason = !live
    ? disabledReason ?? undefined
    : spent
    ? playText.codeBreaker.outOfGuesses(MAX_GUESSES)
    : !myTurn
    ? playText.room.notYourTurn
    : !complete
    ? playText.codeBreaker.pickFour
    : undefined;

  return (
    // Every part of the scene is held to the board's own width, not just the
    // board. MAX_BOARD exists because a history stretched across a tablet is
    // unreadable, but the composer, the palette and the button sat outside that
    // cap and took the whole window - so on anything wider than a phone a
    // 380pt board had a full-width row of swatches sprawling underneath it.
    <View style={{ width: boardW, alignSelf: 'center' }}>
      <PlayerBar
        players={players}
        local={local}
        turn={turn}
        nameFor={nameFor}
        captionFor={(player) =>
          playText.codeBreaker.guessesLeft(
            MAX_GUESSES - (state.boards[players.indexOf(player)] ?? []).length,
          )
        }
      />

      <View style={{ height: theme.spacing.md }} />

      <BoardSurface size={boardW}>
        <View style={{ flexDirection: 'row', gap: colGap }}>
          <History
            attempts={mine}
            who={playText.room.you}
            columnWidth={mineW}
            rowHeight={rowH}
            pegSize={minePeg}
            pegGap={pegGap}
            markSize={markSize}
            markGap={markGap}
            numberWidth={numberW}
            colours={pegColours}
            codeLength={codeLength}
          />
          <History
            attempts={theirs}
            who={opponentName}
            columnWidth={theirsW}
            rowHeight={rowH}
            pegSize={theirsPeg}
            pegGap={pegGap}
            markSize={markSize}
            markGap={markGap}
            numberWidth={0}
            colours={pegColours}
            codeLength={codeLength}
          />
        </View>
      </BoardSurface>

      <View style={{ height: theme.spacing.md }} />

      <Legend />

      <View style={{ height: theme.spacing.md }} />

      {over ? (
        <Reveal secret={state.secret} colours={pegColours} size={slotSize} />
      ) : (
        <View>
          {/* The four slots, filled from the left by the palette below and
              emptied by tapping one. Two ways in - cycle a slot, or pick a
              colour - would each be half-learned; one way is learned once. */}
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm, height: SLOTS_H, alignItems: 'center' }}>
            {draft.map((peg, index) => (
              <Pressable
                key={index}
                accessibilityRole="button"
                accessibilityLabel={playText.codeBreaker.slot(
                  index + 1,
                  peg === null ? null : playText.codeBreaker.peg[peg] ?? null,
                )}
                // An empty slot is not tappable, so it says what does fill it
                // rather than announcing itself as a dead button.
                accessibilityHint={peg === null ? playText.codeBreaker.tapColour : playText.codeBreaker.slotHint}
                accessibilityState={{ disabled: peg === null }}
                disabled={peg === null}
                onPress={() => {
                  haptic('selection');
                  clearSlot(index);
                }}
                style={({ pressed }) => [
                  { flex: 1, alignItems: 'center', justifyContent: 'center' },
                  pressed ? { opacity: 0.6 } : null,
                ]}
              >
                <Peg
                  size={slotSize}
                  colour={peg === null ? null : pegColours[peg] ?? null}
                  letter={peg === null ? null : playText.codeBreaker.peg[peg] ?? null}
                />
              </Pressable>
            ))}
          </View>

          <View style={{ height: theme.spacing.md }} />

          {/* Six swatches, each a full-height target. They stay live while the
              link is down or you are waiting: composing the next guess costs
              nothing and is the only thing there is to do while waiting. They
              go dead only on a full draft, which the hint under the button
              says out loud - a disabled control's accessibilityHint is not
              announced, so it cannot be the only place that is written. */}
          <View style={{ flexDirection: 'row', gap: theme.spacing.xs }}>
            {pegColours.map((colour, index) => (
              <Pressable
                key={index}
                accessibilityRole="button"
                accessibilityLabel={playText.codeBreaker.colour(playText.codeBreaker.peg[index] ?? '')}
                accessibilityHint={complete ? playText.codeBreaker.tapToChange : undefined}
                accessibilityState={{ disabled: complete }}
                disabled={complete}
                hitSlop={theme.spacing.xs}
                onPress={() => {
                  haptic('selection');
                  fillNext(index);
                }}
                style={({ pressed }) => [
                  {
                    flex: 1,
                    height: MIN_TARGET,
                    borderRadius: theme.radius.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: colour,
                    opacity: complete ? 0.35 : 1,
                  },
                  pressed ? { opacity: 0.7 } : null,
                ]}
              >
                <Label
                  variant="caption"
                  style={{ fontWeight: '700', color: inkOn(colour, theme) }}
                >
                  {playText.codeBreaker.peg[index] ?? ''}
                </Label>
              </Pressable>
            ))}
          </View>

          <View style={{ height: theme.spacing.md }} />

          <Button
            title={playText.codeBreaker.submit}
            onPress={submit}
            disabled={!live || !myTurn || !complete || spent}
            disabledReason={submitReason}
          />
        </View>
      )}

      {/*
        The line that says why the palette is dead.

        The six swatches go disabled the moment the fourth peg lands, and the
        only thing that explained that was an accessibilityHint on a disabled
        control - which VoiceOver does not announce - while this line was
        suppressed in exactly the `complete` case that needed it. So a full
        draft greyed out six controls and nothing on screen or in speech said
        what to do about it.

        It is withheld only when there is nothing to compose: the game is over,
        or this player has spent all ten guesses, in which case the Guess
        button one row up is already saying so and a second copy directly
        beneath it would be noise. Note that it is NOT withheld while waiting
        for the opponent - composing the next guess ahead of your turn is the
        one useful thing there is to do then, so it has to be said.
      */}
      {over || spent ? null : (
        <Hint text={complete ? playText.codeBreaker.tapToChange : playText.codeBreaker.tapColour} />
      )}
    </View>
  );
}

/**
 * One player's ten rows.
 *
 * Every row is drawn, played or not, so the ten guesses are a shape on the
 * screen from the first frame rather than a number somebody has to remember.
 */
function History({
  attempts,
  who,
  columnWidth,
  rowHeight,
  pegSize,
  pegGap,
  markSize,
  markGap,
  numberWidth,
  colours,
  codeLength,
}: {
  attempts: readonly Attempt[];
  who: string;
  columnWidth: number;
  rowHeight: number;
  pegSize: number;
  pegGap: number;
  markSize: number;
  markGap: number;
  /** Width of the guess number, or 0 in the narrow column where it does not fit. */
  numberWidth: number;
  colours: readonly string[];
  codeLength: number;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    // Hidden overflow rather than a scroll view: a rounding error must be
    // clipped, never allowed to push the scene into scrolling.
    <View style={{ width: columnWidth, overflow: 'hidden' }}>
      <Label variant="caption" tone="tertiary" numberOfLines={1}>
        {who}
      </Label>
      {Array.from({ length: MAX_GUESSES }, (_unused, index) => {
        const attempt = attempts[index] ?? null;
        const letters = attempt === null ? [] : attempt.guess.map((peg) => playText.codeBreaker.peg[peg] ?? '');
        return (
          <View
            key={index}
            // An unplayed row has nothing to say, and ten of them in each column
            // would bury the rows that do. The player bar already reads out how
            // many guesses are left.
            accessible={attempt !== null}
            accessibilityElementsHidden={attempt === null}
            importantForAccessibility={attempt === null ? 'no-hide-descendants' : 'yes'}
            accessibilityLabel={
              attempt === null
                ? undefined
                : playText.codeBreaker.attempt(
                    who,
                    index + 1,
                    playText.codeBreaker.pegList(letters),
                    attempt.exact,
                    attempt.colour,
                  )
            }
            style={{ height: rowHeight, flexDirection: 'row', alignItems: 'center' }}
          >
            {numberWidth > 0 ? (
              <Label variant="caption" tone="tertiary" style={{ width: numberWidth }}>
                {playText.codeBreaker.guessNumber(index + 1)}
              </Label>
            ) : null}
            <View style={{ flexDirection: 'row', gap: pegGap, flex: 1 }}>
              {Array.from({ length: codeLength }, (_unusedPeg, slot) => {
                const peg = attempt === null ? null : attempt.guess[slot] ?? null;
                return (
                  <Peg
                    key={slot}
                    size={pegSize}
                    colour={peg === null ? null : colours[peg] ?? null}
                    letter={peg === null ? null : playText.codeBreaker.peg[peg] ?? null}
                  />
                );
              })}
            </View>
            <Feedback
              exact={attempt?.exact ?? 0}
              colour={attempt?.colour ?? 0}
              total={codeLength}
              size={markSize}
              gap={markGap}
              faded={attempt === null}
            />
          </View>
        );
      })}
      <View style={{ height: theme.spacing.xs }} />
    </View>
  );
}

/**
 * The score of one guess: filled marks for pegs in the right place, rings for
 * the right colour somewhere else.
 *
 * Shape rather than colour carries the difference, so the two are still apart
 * for a colour-blind player and in the dark scheme, where the pegs themselves
 * have already spent every hue the palette has.
 */
function Feedback({
  exact,
  colour,
  total,
  size,
  gap,
  faded,
}: {
  exact: number;
  colour: number;
  total: number;
  size: number;
  gap: number;
  faded: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const ring = Math.max(1, Math.floor(size / 4));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', gap, marginLeft: gap }}
    >
      {Array.from({ length: total }, (_unused, index) => {
        const solid = !faded && index < exact;
        const hollow = !faded && index >= exact && index < exact + colour;
        if (solid) {
          return (
            <View
              key={index}
              style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.text }}
            />
          );
        }
        if (hollow) {
          return (
            <View
              key={index}
              style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                borderWidth: ring,
                borderColor: theme.colors.text,
              }}
            />
          );
        }
        // Nothing to report at this position. A small faint dot rather than a
        // gap, so the four places always line up down the column, and solid
        // rather than another ring so it cannot be mistaken for a colour match.
        return (
          <View key={index} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <View
              style={{
                width: Math.max(2, size * 0.34),
                height: Math.max(2, size * 0.34),
                borderRadius: size,
                backgroundColor: theme.colors.separator,
              }}
            />
          </View>
        );
      })}
    </View>
  );
}

/**
 * What the two marks mean, said once in words.
 *
 * Hidden from screen readers on purpose: every row already spells its own score
 * out, so spoken aloud this line would be two adjectives with nothing to attach
 * them to.
 */
function Legend(): React.JSX.Element {
  const theme = useTheme();
  const size = 9;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.spacing.sm }}
    >
      <View
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.text }}
      />
      <Label variant="caption" tone="tertiary">
        {playText.codeBreaker.exactLegend}
      </Label>
      <View style={{ width: theme.spacing.xs }} />
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 2,
          borderColor: theme.colors.text,
        }}
      />
      <Label variant="caption" tone="tertiary">
        {playText.codeBreaker.colourLegend}
      </Label>
    </View>
  );
}

/** The answer, once the game is over and there is nothing left to spoil. */
function Reveal({
  secret,
  colours,
  size,
}: {
  secret: readonly number[];
  colours: readonly string[];
  size: number;
}): React.JSX.Element {
  const theme = useTheme();
  const letters = secret.map((peg) => playText.codeBreaker.peg[peg] ?? '');
  return (
    <View
      accessible
      accessibilityLabel={playText.codeBreaker.codeIs(playText.codeBreaker.pegList(letters))}
      style={{ alignItems: 'center', gap: theme.spacing.sm }}
    >
      <Label variant="caption" tone="tertiary">
        {playText.codeBreaker.theCode}
      </Label>
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        {secret.map((peg, index) => (
          <Peg key={index} size={size} colour={colours[peg] ?? null} letter={letters[index] ?? null} />
        ))}
      </View>
    </View>
  );
}

/** One peg. A colour, and the letter that names it when there is room for it. */
function Peg({
  size,
  colour,
  letter,
}: {
  size: number;
  /** Null for a place that has not been filled yet. */
  colour: string | null;
  letter: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  const fontSize = Math.max(8, Math.round(size * 0.46));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colour ?? theme.colors.surfaceElevated,
        borderWidth: colour === null ? StyleSheet.hairlineWidth : 0,
        borderColor: theme.colors.separator,
      }}
    >
      {colour === null || letter === null || size < MIN_LETTERED_PEG ? null : (
        <Label
          variant="caption"
          style={{ fontSize, lineHeight: fontSize + 2, fontWeight: '700', color: inkOn(colour, theme) }}
        >
          {letter}
        </Label>
      )}
    </View>
  );
}

/**
 * An ink that can be read on top of a given peg.
 *
 * No single ink works: white disappears on the yellow peg and near-black
 * disappears on the ink one, and which of the six is which swaps over between
 * the two schemes. So the peg's own brightness picks. The dark ink is whichever
 * token the current scheme keeps dark - `text` in light, `background` in dark -
 * because nothing here may name a hex of its own.
 */
function inkOn(colour: string, theme: Theme): string {
  const light = theme.colors.onAccent;
  const dark = theme.scheme === 'dark' ? theme.colors.background : theme.colors.text;
  if (colour.length !== 7 || !colour.startsWith('#')) return light;
  const r = Number.parseInt(colour.slice(1, 3), 16);
  const g = Number.parseInt(colour.slice(3, 5), 16);
  const b = Number.parseInt(colour.slice(5, 7), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return light;
  return (r * 0.299 + g * 0.587 + b * 0.114) / 255 > 0.5 ? dark : light;
}

/**
 * Six colours, six swatches. A palette that had fewer entries than the rules
 * have colours would silently draw two different pegs the same, which is the
 * one mistake this board cannot survive - so it fails at load in development.
 */
if (__DEV__ && PEG_KEYS.length !== CODE_COLOURS) {
  throw new Error(`CodeBreakerBoard: ${PEG_KEYS.length} peg colours for ${CODE_COLOURS} code colours`);
}
