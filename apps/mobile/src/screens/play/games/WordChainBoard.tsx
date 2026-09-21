import React, { useCallback, useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';
import { Button, Label, haptic, useTheme } from '../../../ui/index.js';
import { Hint, MIN_TARGET, PlayerBar, inkFor, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import { MAX_WORD_LENGTH, MIN_WORD_LENGTH, isWord, type WordChainState } from '../gameTypes.js';

/**
 * Word Chain.
 *
 * THE LETTER IS THE BOARD. There is no grid here, so the one thing the screen
 * owes the player is the letter their word has to start with, at a size nobody
 * can miss while typing. Everything else - the chain, the controls - is
 * arranged around it.
 *
 * THE INPUT LIVES IN THE TOP HALF. The scene never scrolls and there is no
 * keyboard avoidance available to a fixed board, so a text field placed
 * anywhere near the bottom would be typed into blind, behind the keyboard. The
 * whole layout is therefore budgeted downwards from `height`: the letter and
 * the field are sized so the field's bottom edge cannot pass the halfway line,
 * and the chain gets whatever is left, in whole rows. That is why this file
 * does arithmetic rather than lean on flexbox - flex would have distributed the
 * overflow instead of refusing it.
 *
 * THE REDUCER IS STILL THE JUDGE. `dispatch` is asked about every word, always,
 * and only once it has said no does this file look at the word itself - and
 * then only to choose a sentence. Re-implementing the rules to grey out the
 * Play button would put a second, drifting copy of them on the phone; a wrong
 * message is a small embarrassment, a wrong refusal is a broken game.
 */

/** One line of footnote plus PlayerBar's own padding. */
const PLAYER_BAR = 46;
const CAPTION_LINE = 16;
const INPUT_ROW = MIN_TARGET + 4;
/**
 * What a Button actually occupies: its two paddings around one headline line,
 * which comes to two points more than the 48 minimum it also declares.
 *
 * Exact only because the controls below do NOT use Button's `disabledReason`,
 * which draws a footnote UNDER the button inside a content-sized wrapper: the
 * row would silently grow by a line - two under the narrow Pass button, where
 * "Waiting for the connection" wraps - and every one of those points comes out
 * of the chain, which is measured from this number.
 */
const BUTTON_ROW = 50;
/** Reserved whether or not there is a note, so the controls never jump. */
const NOTE_ROW = 20;
const CHAIN_HEAD = 24;
const CHAIN_ROW = 30;
/**
 * Six is already more chain than anyone reasons about mid-turn, and the letter
 * they need is the last one played. Older words scroll off the top - which is
 * to say they are simply not drawn, because nothing here scrolls.
 */
const CHAIN_MAX_ROWS = 6;
const HERO_MAX = 108;
/**
 * A few characters past the wire limit. Capping the field at MAX_WORD_LENGTH
 * exactly would make an over-long word unreachable, and a field that silently
 * stops accepting letters explains nothing; letting it overshoot means the
 * player gets told, in words, that the word is too long.
 */
const FIELD_OVERSHOOT = 4;

export function WordChainBoard({
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
}: GameRendererProps<WordChainState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  /*
   * The rules file exports `requiredLetter`, but gameTypes.ts re-exports only
   * the state type and this screen may not reach outside the app for the rest.
   * Recomputing it is safe where duplicating a RULE would not be: it is a
   * projection of shared state, so both phones read the same last word and
   * reach the same letter, and nothing here is ever asked to judge a move.
   */
  const last = state.words[state.words.length - 1] ?? null;
  const letter = last === null || last.length === 0 ? null : (last[last.length - 1] as string);

  const myTurn = turn === local;
  const canAct = live && myTurn;
  /** Never a dead control: either the room's reason, or the turn. */
  const blockedReason = disabledReason ?? (myTurn ? null : playText.room.notYourTurn);

  // -- the vertical budget --------------------------------------------------

  const aboveHero = PLAYER_BAR + theme.spacing.lg + CAPTION_LINE + theme.spacing.sm;
  const heroToInput = theme.spacing.md + INPUT_ROW;
  /*
   * The letter takes what is left of the top half after the caption and the
   * field, capped so it stays a letter rather than a poster. The floor of 44
   * can in principle exceed the budget on an absurdly short box; a letter too
   * small to read at a glance would defeat the entire screen, so on that phone
   * the field slips a little past halfway instead.
   */
  const hero = Math.max(44, Math.min(HERO_MAX, width * 0.32, height / 2 - aboveHero - heroToInput));

  const chainTop =
    aboveHero + hero + heroToInput + theme.spacing.sm + BUTTON_ROW + NOTE_ROW + theme.spacing.lg + CHAIN_HEAD;
  const rows = Math.max(0, Math.min(CHAIN_MAX_ROWS, Math.floor((height - chainTop) / CHAIN_ROW)));

  /*
   * Most recent first, and only what fits. Seat parity gives the author: play
   * strictly alternates from seat 0 and a pass adds no word, which decodeState
   * enforces on every snapshot - so word `i` is `players[i % players.length]`.
   *
   * The `rows === 0` arm is not defensive tidiness. `slice(-0)` is `slice(0)`,
   * which is the WHOLE chain: on a box too short for a single row the one case
   * that must draw nothing would instead have drawn thirty words down the
   * screen, which is the exact overflow the budget above exists to prevent.
   */
  const visible = useMemo(() => {
    if (rows === 0) return [];
    const seats = state.players.length;
    return state.words
      .map((word, index) => ({ word, index, owner: state.players[index % seats] ?? null }))
      .slice(-rows)
      .reverse();
  }, [rows, state.players, state.words]);

  // -- playing --------------------------------------------------------------

  const submit = useCallback(() => {
    // Trimmed and lowercased before it goes anywhere: decodeAction lowercases
    // on both devices anyway, but the message below has to look at the same
    // word the reducer saw or it will explain the wrong thing.
    const word = draft.trim().toLowerCase();
    if (word.length === 0) return;
    if (dispatch('play', { word })) {
      haptic('impactLight');
      setDraft('');
      setMessage(null);
      return;
    }
    haptic('warning');
    setMessage(refusalFor(word, letter, state.words));
  }, [dispatch, draft, letter, state.words]);

  const concede = useCallback(() => {
    // The rules encode a pass with a null payload; there is nothing to say.
    dispatch('pass', null);
  }, [dispatch]);

  const empty = draft.trim().length === 0;

  /*
   * The one line under the controls, and the only place either of them explains
   * itself. It says the most urgent TRUE thing, in this order:
   *
   *   BLOCKED BEATS REFUSED. A complaint about a word, left standing after the
   *   link drops, would tell the player their word was bad when the truth is
   *   the phone cannot reach anybody. `blockedReason` is asked rather than
   *   assumed because `live` is false for a FINISHED game too, and "Waiting for
   *   the connection" over a perfectly good connection is a lie.
   *
   *   REFUSED BEATS ADVICE. Having just been told no, that is what the player
   *   is looking for.
   *
   *   AN EMPTY FIELD IS WHY PLAY IS DEAD. Without this line Play would sit
   *   greyed out on the player's own turn saying nothing at all.
   */
  const note = !canAct
    ? blockedReason
    : (message ?? (empty ? playText.wordChain.typeAWord : playText.wordChain.passWarning));
  const refused = canAct && message !== null;

  return (
    // Both numbers, and a clip. The arithmetic above already keeps the chain
    // inside the box; this is the belt that survives a phone whose text is
    // scaled past anything the constants were measured at.
    <View style={{ width, height, overflow: 'hidden' }}>
      <PlayerBar players={players} local={local} turn={turn} nameFor={nameFor} />

      <View style={{ height: theme.spacing.lg }} />

      <Label variant="caption" tone="tertiary" align="center">
        {letter === null ? playText.wordChain.openingFree : playText.wordChain.startsWith}
      </Label>

      <View style={{ height: theme.spacing.sm }} />

      {/* Collapsed into one node on purpose: a screen reader should hear the
          requirement as a sentence, not a caption followed by a lone letter. */}
      <View
        accessible
        accessibilityLabel={
          letter === null
            ? playText.wordChain.openingFree
            : playText.wordChain.startsWithSpoken(letter.toUpperCase())
        }
        style={{ height: hero, alignItems: 'center', justifyContent: 'center' }}
      >
        <Label
          tone={letter === null ? 'tertiary' : 'accent'}
          style={{ fontSize: hero, lineHeight: hero, fontWeight: '700', letterSpacing: -2 }}
        >
          {letter === null ? playText.wordChain.openLetter : letter.toUpperCase()}
        </Label>
      </View>

      <View style={{ height: theme.spacing.md }} />

      <TextInput
        accessibilityLabel={playText.wordChain.placeholder}
        placeholder={playText.wordChain.placeholder}
        placeholderTextColor={theme.colors.textTertiary}
        value={draft}
        onChangeText={(next) => {
          setDraft(next);
          // The complaint was about the previous word. Keeping it on screen
          // while the player types the next one reads as a second refusal.
          if (message !== null) setMessage(null);
        }}
        onSubmitEditing={submit}
        // The keyboard stays up between words. Letting it dismiss on every
        // submit would close it on a refusal too - so the player would reopen it
        // to fix the same word - and the layout above exists precisely so the
        // field is still visible while it is open.
        submitBehavior="submit"
        editable={canAct}
        // Autocorrect on a word game is actively hostile: it rewrites a word the
        // dictionary would have accepted, and capitalisation would break the
        // lowercase alphabet the validator insists on.
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        maxLength={MAX_WORD_LENGTH + FIELD_OVERSHOOT}
        returnKeyType="go"
        style={{
          height: INPUT_ROW,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: message === null ? theme.colors.separator : theme.colors.danger,
          backgroundColor: theme.colors.surfaceElevated,
          color: theme.colors.text,
          fontSize: theme.typography.title2.fontSize,
          opacity: canAct ? 1 : 0.5,
        }}
      />

      <View style={{ height: theme.spacing.sm }} />

      {/*
        No `disabledReason` on either button: the note below is theirs, shared.
        Two buttons blocked by one fact would otherwise print that fact twice,
        side by side, and each copy would push the chain down by a line it was
        never given - see BUTTON_ROW.
      */}
      <View style={{ height: BUTTON_ROW, flexDirection: 'row', gap: theme.spacing.sm }}>
        <Button
          title={playText.wordChain.play}
          onPress={submit}
          disabled={!canAct || empty}
          style={{ flex: 1 }}
        />
        <Button title={playText.wordChain.pass} variant="secondary" onPress={concede} disabled={!canAct} />
      </View>

      <View style={{ height: NOTE_ROW, justifyContent: 'center' }}>
        {note === null ? null : (
          <Label variant="footnote" tone={refused ? 'danger' : 'tertiary'} align="center" numberOfLines={1}>
            {note}
          </Label>
        )}
      </View>

      <View style={{ height: theme.spacing.lg }} />

      <Label variant="caption" tone="tertiary" style={{ height: CHAIN_HEAD }}>
        {playText.wordChain.chainTitle}
      </Label>

      {/*
        `rows` already keeps this inside the box; the clip is the second belt,
        so a font scaled up by the system cannot push a row out of the scene.
      */}
      <View style={{ flex: 1, overflow: 'hidden' }}>
        {/*
          Asked of the CHAIN, not of `visible`. On a box with room for no rows
          at all the two differ, and "Nothing played yet" under a chain of nine
          words is a statement about the layout dressed up as a statement about
          the game.
        */}
        {state.words.length === 0 ? (
          <Hint text={playText.wordChain.chainEmpty} />
        ) : (
          visible.map(({ word, index, owner }) => {
            const newest = index === state.words.length - 1;
            const name = owner === null ? '' : owner === local ? playText.room.you : nameFor(owner);
            return (
              <View
                key={index}
                accessible
                accessibilityLabel={playText.wordChain.wordBy(word, name)}
                style={{
                  height: CHAIN_ROW,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.sm,
                }}
              >
                <Label variant="caption" tone="tertiary" style={{ width: 22 }}>
                  {index + 1}
                </Label>
                <Label
                  variant="callout"
                  numberOfLines={1}
                  style={{ flex: 1, color: inkFor(ink, owner, local), opacity: newest ? 1 : 0.65 }}
                >
                  {/* The newest word's final letter is where the huge letter
                      above came from, so it is marked as such rather than left
                      for the player to work out. */}
                  {newest ? word.slice(0, -1) : word}
                  {newest ? (
                    <Label variant="callout" style={{ color: theme.colors.accent, fontWeight: '700' }}>
                      {word.slice(-1)}
                    </Label>
                  ) : null}
                </Label>
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

/**
 * A sentence for a word the reducer has ALREADY refused.
 *
 * Reached only after `dispatch` returned false, so nothing here can keep a
 * legal word off the wire. The checks run in the order the validator runs them
 * so the sentence names the first thing wrong, and the last branch is the
 * honest one: the reducer knows a reason this file does not.
 */
function refusalFor(word: string, letter: string | null, played: readonly string[]): string {
  if (word.length < MIN_WORD_LENGTH) return playText.wordChain.tooShort(MIN_WORD_LENGTH);
  if (word.length > MAX_WORD_LENGTH) return playText.wordChain.tooLong(MAX_WORD_LENGTH);
  if (!/^[a-z]+$/.test(word)) return playText.wordChain.lettersOnly;
  // Dictionary, then repetition, then the letter - validateAction's own order.
  // Checking the letter first would name the wrong fault for a word that breaks
  // both: the validator stopped at the dictionary, so the player is told to find
  // a word starting with T, does exactly that, and is refused all over again.
  if (!isWord(word)) return playText.wordChain.notAWord;
  if (played.includes(word)) return playText.wordChain.alreadyPlayed;
  if (letter !== null && word[0] !== letter) return playText.wordChain.wrongLetter(letter.toUpperCase());
  return playText.wordChain.refused;
}
