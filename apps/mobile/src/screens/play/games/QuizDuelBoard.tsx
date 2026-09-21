import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import type { PlayerId } from '@airlink/games';
import { Label, haptic, useTheme } from '../../../ui/index.js';
import { MIN_TARGET, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  QUIZ_MAX_ANSWER_MS as MAX_ANSWER_MS,
  QUIZ_OPTIONS,
  QUIZ_ROUNDS,
  QUIZ_SEATS as SEATS,
  QUIZ_UNANSWERED as UNANSWERED,
  type QuizDuelState,
  quizHasAnswered as hasAnswered,
} from '../gameTypes.js';

/**
 * Flag Duel, Capital Duel and Geography Duel - one board for three games.
 *
 * They share a state type because they share every rule; all that differs is
 * what a prompt looks like. So this renderer never asks which of the three it is
 * drawing. It is handed a string and shows it: a flag emoji at the size of a
 * card, a sentence at the size of a sentence, and the four options below it
 * either way. A switch on the game id here would be three near-identical
 * branches and a fourth game away from being wrong.
 *
 * ---------------------------------------------------------------------------
 * The clock
 * ---------------------------------------------------------------------------
 * An answer carries the number of milliseconds it took, and that number is
 * measured HERE, from the moment THIS device put the question on screen.
 *
 * Nothing the network provides could stand in for it. The two phones share no
 * clock, so a timestamp from one is meaningless to the other and synchronising
 * them would need a protocol that is exactly as forgeable as the self-report.
 * `elapsedMs` from the room is the simulation clock, which for a turn-based game
 * is zero. And the tempting one - the order the two answers arrive in - is a
 * fact about radios: which phone woke its link more recently, how the packets
 * were buffered, whether one of them was in a pocket. Scoring by arrival would
 * hand the bonus point to the better antenna. The rules file makes the same
 * argument at length, and the reducer compares the two self-reported figures by
 * SEAT rather than by arrival, so both devices reach the same verdict from the
 * same two numbers whichever order they landed in.
 *
 * The figure is clamped to the wire limit rather than sent raw. Above it the
 * reducer refuses the action, which is right for a packet from a peer but wrong
 * here: a refusal on this side means the answer is silently lost and the player
 * still owes one with no way to send it. The mundane cause is a link that
 * dropped with the question on screen, so the honest local behaviour is to
 * report the answer as maximally slow rather than not at all.
 *
 * ---------------------------------------------------------------------------
 * Why the reveal is held on this device
 * ---------------------------------------------------------------------------
 * The reducer has no reveal phase: the second answer resolves the round and
 * `state.round` moves on in the same step, so the state never contains "the
 * round that has just finished". Without a hold, the right answer would appear
 * and vanish inside one frame and a player would never learn what it was.
 *
 * So the board keeps the resolved question up for a beat before following the
 * state forwards. The alternative was a reveal round in the rules, which would
 * mean a second action type, a state that can deadlock if the advancing action
 * is lost, and a shared timer neither phone can own. This costs nothing on the
 * wire and cannot desynchronise anything, because the hold only delays what this
 * screen draws; each device starts its own clock when it displays the next
 * question, which is the only origin that clock was ever allowed to have.
 *
 * Everything drawn is therefore read for the DISPLAYED round rather than for
 * `state.round`: the picks, the round line and the captions in the player bar.
 * Mixing the two would have the bar narrating a question that is not on screen.
 *
 * ---------------------------------------------------------------------------
 * Why the correct answer may be shown before the round resolves
 * ---------------------------------------------------------------------------
 * `state.questions[n].answer` is present on both phones from the first frame -
 * the questions are regenerated from the shared seed, key included - so marking
 * your own answer right or wrong the instant you give it reveals nothing that
 * was ever hidden, and it tells you nothing about your opponent. The one thing
 * genuinely worth withholding is what THEY chose, and that is not drawn until
 * the round has resolved for both of them - at which point it IS drawn, on the
 * option they took. A duel whose ending you cannot see is only half a duel.
 *
 * ---------------------------------------------------------------------------
 * The box
 * ---------------------------------------------------------------------------
 * The scene does not scroll, so the arrangement is spent from `height` rather
 * than left to flex: the named rows come off the top, the four options take
 * their share, and the prompt is handed what is left - which on the tightest box
 * this board is ever given is nothing at all. That box is not hypothetical. It
 * is the one the room hands back once a result card is sharing the scene, a
 * little over half the screen, and it arrives at the exact moment the duel ends.
 */

/** How long a resolved question stays up before the next one replaces it. */
const REVEAL_MS = 1_800;
/** Wide enough for a country name at a readable size, narrow enough to aim at. */
const MAX_WIDTH = 420;
/** An option never grows past this: past it a button stops reading as a button. */
const MAX_OPTION = 72;
/**
 * The player bar, from the type it holds: a name over a caption, or a name alone
 * once the duel is over and there is nobody left to be waiting for.
 */
const BAR_H = 52;
const BAR_FINISHED_H = 40;
/** The "Round 3 of 8" line. */
const ROUND_H = 16;
/**
 * The reveal line and the status line under the options. Reserved rather than
 * conditional, so the options do not shift under a finger when a round resolves.
 */
const STATUS_H = 42;
/** What the prompt would like before the options take their share. */
const PROMPT_IDEAL = 108;
/**
 * Below this the box cannot hold the whole arrangement, and the round line is
 * the first thing off: a result card sitting under the board already says where
 * the duel got to. This is that box on a small phone.
 */
const COMPACT_HEIGHT = 340;
/**
 * An option once the duel is finished.
 *
 * Under the touch minimum deliberately, and reachable only in the one state
 * where nothing on this board can be tapped again: the room halves the height
 * to make room for the result card at exactly the moment the last question is
 * scored, and four 44pt targets plus the chrome do not fit in what is left. A
 * board that keeps targets nobody can press by clipping its own answer line is
 * keeping the wrong promise. While a single option is still live, the floor is
 * MIN_TARGET and nothing else.
 */
const REVIEW_OPTION = 32;
/** Under this the prompt is not drawn at all: a sliver of a flag is not a flag. */
const MIN_PROMPT = 28;

export function QuizDuelBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  disabledReason,
  width,
  height,
}: GameRendererProps<QuizDuelState>): React.JSX.Element {
  const theme = useTheme();

  /**
   * The round this screen is showing, which trails `state.round` by one during a
   * reveal. It can never trail by more: the next round cannot resolve until this
   * device has answered it, and it cannot answer a question it has not displayed.
   */
  const [shownRound, setShownRound] = useState(state.round);
  /** When this device put the displayed question on screen. See the header. */
  const shownAt = useRef(Date.now());

  useEffect(() => {
    if (state.round === shownRound) return;
    const timer = setTimeout(() => setShownRound(state.round), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [state.round, shownRound]);

  useEffect(() => {
    // A newly displayed question is a new clock, and this is the only place the
    // origin is ever set.
    shownAt.current = Date.now();
  }, [shownRound]);

  // The finished duel keeps its last question up rather than emptying the board:
  // `state.round` is ROUNDS by then and indexes nothing, and a blank screen under
  // a final score tells the player nothing about the question they just lost.
  const finished = state.round >= QUIZ_ROUNDS;
  const displayed = Math.min(shownRound, QUIZ_ROUNDS - 1);
  const question = state.questions[displayed];
  const seat = state.players.indexOf(local);
  const base = displayed * SEATS;
  const mine = state.picks[base + seat] ?? UNANSWERED;
  const theirs = state.picks[base + (SEATS - 1 - seat)] ?? UNANSWERED;
  const answered = mine !== UNANSWERED;
  /** The displayed round is behind the state, so both answers are in and scored. */
  const resolved = state.round > displayed;
  const opponent = players.find((player) => player !== local) ?? local;

  /**
   * A person, never an id, and never blank. `nameFor` returns an empty string
   * until the peer's profile has been read, and "waiting for …" with a hole in
   * it reads as a bug rather than as a pause.
   */
  const personName = (player: PlayerId): string =>
    nameFor(player) || (player === local ? playText.room.you : playText.quizDuel.friend);

  /*
   * The box, spent from the top.
   *
   * Sized from BOTH numbers: width alone is what used to push a board off the
   * bottom of the screen, and the scroll view that coped with that is what stole
   * the touches from every drag game. The rows are named and subtracted one at a
   * time rather than rolled into a single guess at "the chrome", because a guess
   * is the thing that quietly stops matching the type it was measured from.
   */
  const gap = theme.spacing.sm;
  const column = Math.min(width, MAX_WIDTH);
  const compact = height < COMPACT_HEIGHT;
  const chrome =
    (finished ? BAR_FINISHED_H : BAR_H) + theme.spacing.md + (compact ? 0 : ROUND_H) + STATUS_H;
  const available = Math.max(0, height - chrome);
  const gaps = gap * (QUIZ_OPTIONS - 1);
  const floor = finished ? REVIEW_OPTION : MIN_TARGET;
  const option = Math.max(floor, Math.min(MAX_OPTION, (available - PROMPT_IDEAL - gaps) / QUIZ_OPTIONS));
  /** Whatever the options left. The prompt is the one block allowed to go hungry. */
  const slot = Math.max(0, available - (option * QUIZ_OPTIONS + gaps));

  // A flag is one glyph and wants to fill the board; a question is a sentence and
  // must not. The test is the prompt's own length in code points rather than the
  // game's id, because length is the property that actually decides the size.
  const glyph = question !== undefined && Array.from(question.prompt).length <= 2;
  // Sized to the slot it was given rather than to the whole screen, so the prompt
  // shrinks with the box instead of being drawn through the bottom of it: a
  // glyph on one line, or four lines of a sentence at 1.35.
  const promptSize = glyph
    ? Math.min(column * 0.44, slot * 0.85, 128)
    : Math.min(column * 0.072, slot * 0.185, 24);
  const showPrompt = question !== undefined && slot >= MIN_PROMPT;

  const answer = question?.answer ?? UNANSWERED;
  const closed = answered || resolved || !live;

  const choose = (index: number): void => {
    const ms = Math.min(MAX_ANSWER_MS, Math.max(0, Math.round(Date.now() - shownAt.current)));
    // The round named is the one on SCREEN, not `state.round`. They are the same
    // whenever an option is live, and where they are not - a tap racing the
    // reveal - the reducer refuses the answer rather than crediting it to a
    // question this player has never seen.
    //
    // A refusal is answered with a knock rather than an explanation: the lines
    // under the options already say what the board is waiting for.
    haptic(dispatch('answer', { round: displayed, option: index, ms }) ? 'impactLight' : 'warning');
  };

  /**
   * What the resolved round is worth saying about speed.
   *
   * Only a comparison of the two recorded measurements: the points themselves
   * are the reducer's to award and are already in the player bar. Reimplementing
   * the scoring here would put a second copy of it in the app, which is the one
   * thing the rules file asks nobody to do.
   */
  const speedLine = ((): string | null => {
    if (!resolved || mine !== answer || theirs !== answer) return null;
    const msMine = state.times[base + seat] ?? 0;
    const msTheirs = state.times[base + (SEATS - 1 - seat)] ?? 0;
    if (msMine === msTheirs) return playText.quizDuel.deadHeat;
    return msMine < msTheirs
      ? playText.quizDuel.youWereFaster
      : playText.quizDuel.theyWereFaster(personName(opponent));
  })();

  // Guarded rather than defaulted: a missing key is impossible - the generator's
  // four-option invariant is checked in the rules package - and "The answer was"
  // with nothing after it would be a worse way to find out that it was not.
  const keyText = question?.options[answer];
  const revealLine = resolved && keyText !== undefined ? playText.quizDuel.answerWas(keyText) : null;

  /**
   * Why the options cannot be tapped, in words, whichever reason applies.
   *
   * `disabledReason` comes first because it is the only thing that can tell a
   * dropped link from a finished duel, and a board that guesses at that ends up
   * saying "waiting for the connection" over a perfectly good connection. Every
   * other branch is a state this screen does know how to describe - and the one
   * branch that leaves this line empty, a resolved round the two of you did not
   * both get right, is the branch where the reveal line above it is already
   * standing there saying the round is over.
   */
  const statusLine = !live
    ? disabledReason
    : resolved
    ? speedLine
    : answered
    ? mine === answer
      ? playText.quizDuel.rightWaiting(personName(opponent))
      : playText.quizDuel.wrongWaiting(personName(opponent))
    : theirs !== UNANSWERED
    ? playText.quizDuel.theyAnswered(personName(opponent))
    : playText.quizDuel.tapAnswer;

  return (
    // The box, and never a pixel more. `overflow` is the last guard rather than
    // the plan: on a box too short for even four review-sized options and the
    // rows around them - a phone held sideways, say - something has to give, and
    // clipped here is still better than spilling into a scene that has
    // deliberately nowhere to scroll to.
    <View style={{ width, height, alignSelf: 'center', overflow: 'hidden' }}>
      <PlayerBar
        players={players}
        local={local}
        turn={null}
        nameFor={nameFor}
        scoreFor={(player) => state.scores[state.players.indexOf(player)] ?? 0}
        captionFor={(player) => {
          // Who the DISPLAYED round is waiting on, so the bar and the board are
          // never describing two different questions. Both seats carry a caption
          // while a question is open - the bar keeps its height that way, and
          // one appearing the moment somebody answers would push the options
          // down under the other player's finger. Neither caption says WHAT was
          // answered.
          if (finished) return null;
          const index = state.players.indexOf(player);
          if (index < 0) return null;
          return hasAnswered(state, index, displayed)
            ? playText.quizDuel.answered
            : playText.quizDuel.thinking;
        }}
      />

      <View style={{ height: theme.spacing.md }} />

      {compact ? null : (
        <View style={{ height: ROUND_H }}>
          <Label variant="caption" tone="tertiary" align="center" numberOfLines={1}>
            {finished
              ? playText.quizDuel.finished(QUIZ_ROUNDS)
              : playText.quizDuel.round(displayed + 1, QUIZ_ROUNDS)}
          </Label>
        </View>
      )}

      {/* The prompt. Whatever it is - a flag, a country, a comparison - and the
          one block that yields its space on a short screen. */}
      <View style={{ height: slot, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {showPrompt && question !== undefined ? (
          <Animated.View key={displayed} entering={FadeIn.duration(theme.motion.quick)}>
            <Label
              accessibilityRole="text"
              // A lone flag has no words in it, so the question is spoken here
              // instead of being printed beside four country names that already
              // say what is being asked.
              accessibilityLabel={glyph ? playText.quizDuel.whichFlag : question.prompt}
              align="center"
              numberOfLines={glyph ? 1 : 4}
              style={{
                fontSize: promptSize,
                lineHeight: promptSize * (glyph ? 1.15 : 1.35),
                fontWeight: glyph ? '400' : '600',
                letterSpacing: glyph ? 0 : -0.3,
                color: theme.colors.text,
              }}
            >
              {question.prompt}
            </Label>
          </Animated.View>
        ) : null}
      </View>

      <View style={{ gap, width: column, alignSelf: 'center' }}>
        {(question?.options ?? []).map((text, index) => {
          const chosen = mine === index;
          // Neither the key nor their pick is drawn before the round belongs to
          // both players.
          const isKey = resolved && index === answer;
          const theirPick = resolved && theirs === index;
          const wrongPick = chosen && mine !== answer;
          const border = isKey
            ? theme.colors.connected
            : wrongPick
            ? theme.colors.danger
            : chosen
            ? theme.colors.accent
            : theme.colors.separator;
          return (
            <Pressable
              key={index}
              accessible
              accessibilityRole="button"
              accessibilityLabel={[text, theirPick ? playText.quizDuel.theirAnswer(personName(opponent)) : null]
                .filter((part): part is string => part !== null)
                .join(', ')}
              accessibilityHint={
                isKey
                  ? playText.quizDuel.correctAnswer
                  : chosen && answered
                  ? mine === answer
                    ? playText.quizDuel.yourAnswerRight
                    : playText.quizDuel.yourAnswerWrong
                  : undefined
              }
              accessibilityState={{ selected: chosen, disabled: closed }}
              disabled={closed}
              onPress={() => choose(index)}
              style={({ pressed }) => [
                {
                  height: option,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.sm,
                  paddingHorizontal: theme.spacing.lg,
                  borderRadius: theme.radius.md,
                  borderWidth: isKey || chosen ? 2 : 1,
                  borderColor: border,
                  backgroundColor: chosen ? theme.colors.accentMuted : theme.colors.surface,
                  // Everything that is neither your answer, nor theirs, nor the
                  // key steps back once the round is decided, so what is left to
                  // read is the three things that decided it.
                  opacity: (resolved || answered) && !chosen && !isKey && !theirPick ? 0.45 : 1,
                  overflow: 'hidden',
                },
                pressed ? { opacity: 0.7 } : null,
              ]}
            >
              <Label
                variant="callout"
                numberOfLines={option >= MIN_TARGET ? 2 : 1}
                align="center"
                style={{ flex: 1 }}
              >
                {text}
              </Label>
              {theirPick ? (
                // Their name rather than a second colour. The one accent this
                // app has is already spoken for by your own answer, and a new
                // hue would have to mean the same thing in both schemes and to
                // someone who cannot tell it from the border beside it.
                <Label variant="caption" tone="secondary" numberOfLines={1} style={{ maxWidth: '34%' }}>
                  {personName(opponent)}
                </Label>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {/* One line each, kept to one line: a long country name or a long friend
          cannot then push this block past the height reserved for it, and the
          height is reserved so the options do not move as the lines change. */}
      <View style={{ height: STATUS_H, justifyContent: 'center' }}>
        {revealLine === null ? null : (
          <Label variant="footnote" tone="secondary" align="center" numberOfLines={1}>
            {revealLine}
          </Label>
        )}
        {statusLine === null ? null : (
          <Label variant="caption" tone="tertiary" align="center" numberOfLines={1}>
            {statusLine}
          </Label>
        )}
      </View>
    </View>
  );
}
