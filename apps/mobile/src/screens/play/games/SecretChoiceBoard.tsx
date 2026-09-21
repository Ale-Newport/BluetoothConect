import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { strings } from '@airlink/config';
import type { PlayerId } from '@airlink/games';
import { Button, EmptyState, Label, haptic, useTheme } from '../../../ui/index.js';
import type { RootStackParams } from '../../../navigation/routes.js';
import { FaceOff, Hint, MIN_TARGET, PlayerBar, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  SECRET_CHOICE_BANKS,
  SECRET_CHOICE_PROMPTS as PROMPTS_PER_GAME,
  SECRET_CHOICE_UNCHOSEN as UNCHOSEN,
  secretChoiceCurrentRound as currentRound,
  secretChoicePickAt as pickAt,
  secretChoiceRoundView as roundView,
  type SecretChoiceState,
} from '../gameTypes.js';

/**
 * The "together" family: Would You Rather, Most Likely To and This or That.
 *
 * One renderer for three games, because they are one game with three prompt
 * banks. A prompt, two options, both people choose in secret, and the two
 * answers open at the same instant.
 *
 * ---------------------------------------------------------------------------
 * THE PAUSE, AND WHY IT IS DRAWN HERE RATHER THAN STORED
 * ---------------------------------------------------------------------------
 * The reducer opens a round the moment the second choice lands, and in the same
 * step `currentRound` moves on. So the state has no "look at what you both
 * said" moment in it at all: the instant your friend answers, the next prompt
 * is technically in play. Rendering the state literally would flash the reveal
 * for one frame and then ask the next question, which is the one thing these
 * games are not for.
 *
 * So the hold is a UI object, exactly as Trivia's countdown is: `seen` is the
 * round this device has agreed to move past, and while the state has opened a
 * round the player has not moved past, the board shows that round's reveal and
 * nothing else. It is per-device on purpose - the pair are looking at two
 * phones, and making one of them wait for the other to press Next would put the
 * slower reader under a clock. It also cannot skip a reveal: the options for
 * the next prompt are not on screen while a reveal is held, so this device
 * cannot answer, so no further round can open behind it.
 *
 * `seen` starts at the current round rather than at zero, so a game resumed
 * from a snapshot opens on the prompt in play instead of replaying every reveal
 * the pair have already talked about.
 *
 * ---------------------------------------------------------------------------
 * WHICH OF THE THREE GAMES THIS IS
 * ---------------------------------------------------------------------------
 * The bank - the prompts, and where the two option labels come from - is the
 * only difference between the three, and `GameRendererProps` has no game id on
 * it. The two alternatives both lost: adding an id to the contract means
 * editing a file that twelve other renderers share for the benefit of one, and
 * three near-identical wrapper components means three files to keep in step
 * over one constant each. So the id is read from the route this renderer is
 * always mounted inside, which is where the room itself reads it from.
 *
 * ---------------------------------------------------------------------------
 * NOBODY LOSES
 * ---------------------------------------------------------------------------
 * There is no score line anywhere on this board and the player bar is passed no
 * `scoreFor`. The rules file explains why in full: agreement is symmetric, both
 * players hold exactly the same number of matches by definition, and there is
 * no quantity here one of them can have more of. A running total drawn beside
 * two names reads as a scoreboard whatever it counts, and a scoreboard would
 * quietly turn an honest answer into a strategic one. The tally is drawn ONCE,
 * at the end, as a thing the two of them did together.
 *
 * ---------------------------------------------------------------------------
 * TWO ARRANGEMENTS, AND WHY THE PLAYER BAR IS ONE OF THE THINGS THAT GOES
 * ---------------------------------------------------------------------------
 * This board has more fixed furniture than most - a bar, ten marks, a question,
 * two options and a footer holding a verdict and a button - and the room can
 * hand it a box about 375 by 257, which is an iPhone SE once a result card is
 * sharing the scene. The full arrangement does not fit that in the fixed rows
 * alone, so the compact one drops the marks AND the bar, and every remaining
 * row is measured from the type inside it so that what is left over genuinely
 * belongs to the options. Nothing here scrolls or flexes: the two options are
 * what the box is spent on, and they never fall below a 44pt target.
 */

/** A phone is wider than a sentence wants to be. Two options, comfortably read. */
const MAX_COLUMN = 420;
/** The fixed rows, measured from the type they hold rather than guessed. */
const BAR_H = 52;
const MARKS_H = 22;
/** Two lines of the prompt in either arrangement: a question is not a caption. */
const PROMPT_FULL_H = 64;
const PROMPT_COMPACT_H = 40;
/**
 * The footer is as tall as the three things stacked in it - the verdict, the
 * sentence under it and the button - and the compact one as tall as the two
 * that survive. Measured rather than eyeballed, because the row is centred:
 * a footer shorter than its contents does not clip them, it spreads them over
 * the option above and over the bottom edge of the box.
 */
const FOOTER_FULL_H = 126;
const FOOTER_COMPACT_H = 86;
/** The markers under an opened option: one caption line and the gap above it. */
const MARKER_H = 20;
/** An option stops growing here: past it the two boxes read as two posters. */
const MAX_OPTION_H = 132;
/**
 * An option worth tapping: one line of the option type, its padding, and room
 * for the two markers. When the full arrangement cannot leave this much, rows
 * come off the board rather than height coming off the options - the options
 * are the only thing here a finger has to hit.
 */
const OPTION_COMFORT = 64;

export function SecretChoiceBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  disabledReason,
  width,
  height,
}: GameRendererProps<SecretChoiceState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();
  const { params } = useRoute<RouteProp<RootStackParams, 'GameRoom'>>();
  const bank = SECRET_CHOICE_BANKS[params.gameId] ?? null;

  const round = currentRound(state);
  const [seen, setSeen] = useState(round);
  /** A round has opened that this device has not moved past yet. */
  const holding = seen < round;
  const shown = holding ? round - 1 : round;
  const ended = shown >= PROMPTS_PER_GAME;

  const view = useMemo(
    () => (bank === null || ended ? null : roundView(bank, state, shown, local)),
    [bank, ended, local, shown, state],
  );

  /**
   * One mark per prompt: agreed, differed, or not reached. Derived through
   * `roundView` like everything else, so a round that has not opened cannot
   * contribute a mark even by accident.
   */
  const marks = useMemo<readonly (boolean | null)[]>(() => {
    if (bank === null) return [];
    return Array.from({ length: PROMPTS_PER_GAME }, (_unused, index) => {
      const past = roundView(bank, state, index, local);
      return past.revealed ? past.yours === past.theirs : null;
    });
  }, [bank, local, state]);

  const played = marks.filter((mark) => mark !== null).length;

  const other = state.players.find((player) => player !== local) ?? local;
  /**
   * A person, never an id, and never blank. `nameFor` returns an empty string
   * before a profile has been read, and an unnamed button is worse than a
   * generic one - especially in Most Likely To, where the options ARE the two
   * of them and a blank option is an unanswerable question.
   */
  const personName = useCallback(
    (player: PlayerId): string =>
      nameFor(player) || (player === local ? playText.room.you : playText.secretChoice.friend),
    [local, nameFor],
  );

  const choose = useCallback(
    (option: number): void => {
      // The round comes from the state, not from what is on screen: they are
      // the same whenever an option is tappable, and naming the live one is
      // what the reducer checks against. It refuses anything else, and a
      // refusal is answered with a knock rather than an explanation - the
      // screen already says whose choice is outstanding.
      haptic(dispatch('choose', { round, option }) ? 'impactLight' : 'warning');
    },
    [dispatch, round],
  );

  const advance = useCallback(() => setSeen(round), [round]);

  /*
   * The box is spent from the top: every fixed row comes off first and the two
   * options divide what is left. Sized from `height` rather than left to flex,
   * because the scene does not scroll and a board that guesses its own height
   * on a small phone has nowhere to overflow to.
   *
   * Which arrangement is used is decided by what the box can actually hold
   * rather than by a height chosen in advance, because the tightest scene there
   * is - an iPhone SE with the result card sharing the screen, so about 375 by
   * 257 - cannot hold the full one at all: its fixed rows come to more than that
   * box before a single option is drawn. So the compact arrangement drops the
   * player bar and the marks together. The bar is the one that hurts, and it is
   * still the right thing to lose: the shell above already names the opponent,
   * its captions are blank during a reveal (which is the whole of the scene the
   * result card shares), and the one fact they carry when a round is open moves
   * into the hint under the options.
   */
  const column = Math.min(width, MAX_COLUMN);
  const promptText = view?.prompt ?? '';

  /** What the fixed rows cost in one of the two arrangements. */
  const rowsFor = (tight: boolean): number => {
    const rowGap = tight ? theme.spacing.sm : theme.spacing.md;
    const chrome = tight ? 0 : BAR_H + rowGap + MARKS_H + rowGap;
    const prompt = promptText ? (tight ? PROMPT_COMPACT_H : PROMPT_FULL_H) + rowGap : 0;
    return chrome + prompt + rowGap + (tight ? FOOTER_COMPACT_H : FOOTER_FULL_H);
  };
  /** What one option would get in that arrangement, before it is clamped. */
  const optionRoom = (tight: boolean): number => (height - rowsFor(tight) - theme.spacing.sm) / 2;

  const compact = optionRoom(false) < OPTION_COMFORT;
  const gap = compact ? theme.spacing.sm : theme.spacing.md;
  const footerH = compact ? FOOTER_COMPACT_H : FOOTER_FULL_H;
  // The touch target is the floor and the last thing to give: an option too
  // short to read is a nuisance, an option too short to hit is a bug.
  const optionH = Math.max(MIN_TARGET, Math.min(MAX_OPTION_H, optionRoom(compact)));

  if (bank === null) {
    // Unreachable through the registry, which pairs this renderer with exactly
    // the three ids that have a bank. It is drawn rather than thrown because a
    // wrong id would otherwise take the whole room down mid-flight, and an
    // honest dead end is something a player can walk out of.
    return <EmptyState icon="puzzle" title={strings.play.unavailableTitle} body={playText.tabs.noRenderer} />;
  }

  if (view === null) {
    return (
      <Ending
        agreed={state.agreed}
        marks={marks}
        players={players}
        local={local}
        nameFor={nameFor}
        column={column}
      />
    );
  }

  const open = view.revealed;
  const together = open && view.yours === view.theirs;
  const lastReveal = holding && round >= PROMPTS_PER_GAME;
  /**
   * That a choice has landed, never which one - `roundView` is still the only
   * thing that hands out an answer. Read for the hint, which is where the
   * player bar's caption goes when the bar itself cannot be drawn.
   */
  const theirsIn = pickAt(state, round, state.players.indexOf(other)) !== UNCHOSEN;

  /*
   * The label is sized to the box rather than the box to the label. The markers
   * take a row out of an option the moment the round opens, and type that
   * ignored that would be cropped by the very `overflow: hidden` that keeps the
   * option the height it was measured at.
   *
   * The padding is what is left after a line of type has been fitted, never
   * more than the design value: on the smallest box the board is ever handed,
   * eight points of air above an option's only line is eight points the line
   * itself needed.
   */
  const optionPad = Math.max(
    0,
    Math.min(
      compact ? theme.spacing.xs : theme.spacing.sm,
      Math.floor((optionH - (open ? MARKER_H : 0) - theme.typography.title2.lineHeight) / 2),
    ),
  );
  const optionRoomForText = optionH - optionPad * 2 - (open ? MARKER_H : 0);
  const optionType = optionRoomForText >= theme.typography.title2.lineHeight ? 'title2' : 'headline';
  const optionLines = optionRoomForText >= theme.typography.title2.lineHeight * 2 ? 2 : 1;

  /** What a button says. In Most Likely To the two options are the two people. */
  const optionLabel = (index: number): string =>
    bank.kind === 'players' ? personName(state.players[index] ?? local) : view.options[index] ?? '';

  return (
    <View style={{ width: column, alignSelf: 'center' }}>
      {compact ? null : (
        <>
          <PlayerBar
            players={players}
            local={local}
            /*
             * No turn, and no score.
             *
             * Both players may answer at once - the rules file is explicit that
             * the runtime's `currentTurn` is an ordering for a prompt line, not
             * a rule - so lighting one of the two names would tell the other to
             * wait when they need not. The caption says only THAT somebody has
             * answered, which is what makes the pause a shared one; what they
             * answered comes from `roundView` and from nowhere else.
             */
            turn={null}
            nameFor={nameFor}
            captionFor={(player) => {
              if (open) return null;
              const index = state.players.indexOf(player);
              if (index < 0) return null;
              return pickAt(state, round, index) === UNCHOSEN
                ? playText.secretChoice.thinking
                : playText.secretChoice.answered;
            }}
          />

          <View style={{ height: gap }} />

          <RoundMarks marks={marks} agreed={state.agreed} played={played} ink={ink} height={MARKS_H} />

          <View style={{ height: gap }} />
        </>
      )}

      {/*
        This or That asks its question entirely through the two options, so its
        bank carries no lead line and the row is not drawn at all rather than
        being drawn empty - the space goes to the options instead.
      */}
      {promptText ? (
        <>
          <View
            style={{ height: compact ? PROMPT_COMPACT_H : PROMPT_FULL_H, justifyContent: 'center' }}
          >
            {/*
              Two lines in either arrangement - the compact one drops to smaller
              type instead. "Who is most likely to leave the washing up until
              morning" does not survive being cut to one line, and a prompt with
              its end missing is not a question any more.

              Spoken with the round in front of it when the marks are not drawn,
              so a screen reader is not the one thing on the board that loses
              track of where the pair have got to.
            */}
            <Label
              variant={compact ? 'subheadline' : 'title2'}
              align="center"
              numberOfLines={2}
              accessibilityLabel={
                compact
                  ? `${playText.secretChoice.round(shown + 1, PROMPTS_PER_GAME)}. ${promptText}`
                  : undefined
              }
            >
              {promptText}
            </Label>
          </View>
          <View style={{ height: gap }} />
        </>
      ) : null}

      <View style={{ gap: theme.spacing.sm }}>
        {[0, 1].map((option) => {
          const yours = view.yours === option;
          const theirs = view.theirs === option;
          const playable = !open && view.yours === null && live;
          const label = optionLabel(option);

          return (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityLabel={[
                label,
                yours ? playText.secretChoice.yoursSpoken : null,
                theirs ? playText.secretChoice.theirsSpoken(personName(other)) : null,
                open && !yours && !theirs ? playText.secretChoice.unchosenSpoken : null,
              ]
                .filter((part): part is string => typeof part === 'string')
                .join(', ')}
              accessibilityState={{ selected: yours, disabled: !playable }}
              disabled={!playable}
              onPress={() => choose(option)}
              style={({ pressed }) => [
                {
                  height: optionH,
                  justifyContent: 'center',
                  paddingHorizontal: theme.spacing.lg,
                  paddingVertical: optionPad,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: yours ? ink.mine : theirs ? ink.theirs : theme.colors.separator,
                  backgroundColor: yours ? theme.colors.accentMuted : theme.colors.surface,
                  // Once both answers are out, the option nobody took steps
                  // back so that what the two of them said is what is left to
                  // read.
                  opacity: open && !yours && !theirs ? 0.4 : 1,
                  overflow: 'hidden',
                },
                pressed ? { opacity: 0.7 } : null,
              ]}
            >
              <Label variant={optionType} align="center" numberOfLines={optionLines}>
                {label}
              </Label>

              {yours || theirs ? (
                <Animated.View
                  key={`${shown}-${option}`}
                  entering={FadeIn.duration(theme.motion.standard)}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: theme.spacing.md,
                    marginTop: theme.spacing.xs,
                  }}
                >
                  {yours ? <Marker colour={ink.mine} name={playText.secretChoice.you} /> : null}
                  {theirs ? <Marker colour={ink.theirs} name={personName(other)} /> : null}
                </Animated.View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={{ height: gap }} />

      <View style={{ height: footerH, justifyContent: 'center' }}>
        {open ? (
          <Animated.View key={shown} entering={FadeIn.duration(theme.motion.standard)}>
            {/* One line, because the footer's height was measured as one. */}
            <Label
              variant="title2"
              align="center"
              numberOfLines={1}
              tone={together ? 'accent' : 'primary'}
            >
              {together ? playText.secretChoice.agreed : playText.secretChoice.differed}
            </Label>
            {compact ? null : (
              <Label
                variant="footnote"
                tone="secondary"
                align="center"
                numberOfLines={2}
                style={{ marginTop: theme.spacing.xs }}
              >
                {together
                  ? playText.secretChoice.bothSaid(optionLabel(view.yours ?? 0))
                  : playText.secretChoice.eachSaid(
                      optionLabel(view.yours ?? 0),
                      personName(other),
                      optionLabel(view.theirs ?? 0),
                    )}
              </Label>
            )}
            {/*
              Local, so it needs no link and is never disabled: moving on from a
              reveal changes nothing the other phone has to agree with.
            */}
            <Button
              title={lastReveal ? playText.secretChoice.lastReveal : playText.secretChoice.next}
              onPress={advance}
              style={{ marginTop: theme.spacing.sm }}
            />
          </Animated.View>
        ) : !live ? (
          <Hint text={disabledReason ?? playText.room.waitingForLink} />
        ) : view.yours === null ? (
          // With no player bar to say it, the hint carries the fact that a
          // choice is already in - and only in that arrangement, so the two are
          // never both saying it at once.
          <Hint
            text={
              compact && theirsIn
                ? playText.secretChoice.chooseHintAfter(personName(other))
                : playText.secretChoice.chooseHint
            }
          />
        ) : (
          <Hint text={playText.secretChoice.waitingFor(personName(other))} tone="secondary" />
        )}
      </View>
    </View>
  );
}

/** Whose answer this is. The dot carries the player bar's ink, so it is read once. */
function Marker({ colour, name }: { colour: string; name: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }} />
      <Label variant="caption" tone="secondary" numberOfLines={1}>
        {name}
      </Label>
    </View>
  );
}

/**
 * Ten marks: agreed, differed, not reached yet.
 *
 * Not a score, and it cannot become one - it counts rounds the two of them
 * matched on, which is a single number they share rather than two numbers to
 * compare. One accessible label for the row, because ten unlabelled dots read
 * out one at a time say nothing at all.
 */
function RoundMarks({
  marks,
  agreed,
  played,
  ink,
  height,
}: {
  marks: readonly (boolean | null)[];
  agreed: number;
  played: number;
  ink: { mine: string; theirs: string; empty: string };
  height: number;
}): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={playText.secretChoice.progress(agreed, played)}
      style={{ flexDirection: 'row', gap: 6, height, alignItems: 'center', justifyContent: 'center' }}
    >
      {marks.map((mark, index) => (
        <View
          key={index}
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: mark === true ? ink.mine : mark === null ? ink.empty : 'transparent',
            borderWidth: mark === false ? 1.5 : 0,
            borderColor: ink.theirs,
          }}
        />
      ))}
    </View>
  );
}

/**
 * The end.
 *
 * The two of them, the ten marks, and the one number the game keeps. The room
 * draws its own result card under this one and calls the status a draw, which
 * is the honest word for it in a catalogue of games that have winners - so this
 * panel is where the ending is actually said, in the words the game deserves.
 */
function Ending({
  agreed,
  marks,
  players,
  local,
  nameFor,
  column,
}: {
  agreed: number;
  marks: readonly (boolean | null)[];
  players: readonly PlayerId[];
  local: PlayerId;
  nameFor: (player: PlayerId) => string;
  column: number;
}): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  return (
    <View style={{ width: column, alignSelf: 'center' }}>
      <FaceOff players={players} local={local} nameFor={nameFor} />

      <View style={{ height: theme.spacing.lg }} />

      <RoundMarks marks={marks} agreed={agreed} played={PROMPTS_PER_GAME} ink={ink} height={MARKS_H} />

      <View style={{ height: theme.spacing.lg }} />

      <Label variant="title" align="center">
        {playText.secretChoice.tally(agreed, PROMPTS_PER_GAME)}
      </Label>
      <Label variant="footnote" tone="secondary" align="center" style={{ marginTop: theme.spacing.xs }}>
        {playText.secretChoice.tallyNote(agreed, PROMPTS_PER_GAME)}
      </Label>
    </View>
  );
}
