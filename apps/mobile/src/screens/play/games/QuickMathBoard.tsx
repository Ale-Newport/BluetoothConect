import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { Button, Label, useTheme } from '../../../ui/index.js';
import { Cell, Hint, MIN_TARGET, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  QUICK_MATH_MAX_ANSWER_MS as MAX_ANSWER_MS,
  QUICK_MATH_MAX_ANSWER_VALUE as MAX_ANSWER_VALUE,
  QUICK_MATH_ROUNDS,
  quickMathCurrentProblem as currentProblem,
  type QuickMathProblem,
  quickMathProblemText as problemText,
  type QuickMathState,
} from '../gameTypes.js';

/**
 * Quick Math.
 *
 * Ten mental arithmetic problems. Both phones show the same problem at the same
 * moment, both players answer whenever they can, and the round resolves once the
 * second answer lands - so there is no turn to wait for and the keypad is live
 * from the instant the problem appears.
 *
 * ---------------------------------------------------------------------------
 * The clock
 * ---------------------------------------------------------------------------
 * The answer carries a number of milliseconds, and that number is measured HERE,
 * from the moment this device put the problem on screen. Nothing about it is
 * network-derived: not the version bump that delivered the round, not the
 * arrival of the peer's answer, not `elapsedMs` from the room. The rules file
 * explains at length why - two answers cross a Bluetooth link with tens of
 * milliseconds of real, variable latency, so any figure touched by the radio is
 * a measurement of the radio rather than of the player, and the two devices
 * would not even agree on it. A self-reported number is the only one they can.
 *
 * The reported time is clamped to the wire limit rather than sent raw. The
 * reducer REFUSES anything above it, which is right for a packet arriving from a
 * peer, but on the sending side a refusal means the answer is silently lost and
 * the player is left still owing one with no way to send it. That happens for a
 * mundane reason - the link dropped for a minute with the problem on screen - so
 * the honest local behaviour is to submit the answer as maximally slow. Trivia
 * clamps for the same reason.
 *
 * ---------------------------------------------------------------------------
 * How the column is budgeted
 * ---------------------------------------------------------------------------
 * Everything below the problem has a height that is known before layout runs:
 * the player bar, the answer line, the keypad, Submit with its reason, and one
 * reserved line for the hint. `chrome` adds those up FROM THE THEME rather than
 * from a hand-counted constant, because a hand-counted constant is right on the
 * day it is written and wrong the first time a type size moves - and being wrong
 * by ten points here means the bottom row of keys sits under the edge of a small
 * screen where nobody can reach it.
 *
 * The budget is computed for the TALLEST arrangement, with both Submit's reason
 * and the hint line showing. When one of them is absent the slack falls to the
 * problem, which is flexible; it can never fall the other way.
 *
 * What gives way first, when there is not enough room for everything, is the
 * KEYPAD - down to the smallest key whose touch target is still honest - and
 * only then the problem's type size, which is derived from the space actually
 * left rather than from a fraction of the screen. Sizing the sum from a fraction
 * of the screen is what put a 45pt number in a 27pt box on an iPhone SE and
 * clipped the very thing the player is trying to read.
 *
 * ---------------------------------------------------------------------------
 * Why the problem is imported from the rules rather than derived here
 * ---------------------------------------------------------------------------
 * The sum on screen must be the sum the reducer scores, to the digit. It is
 * derived from the seed by a seeded generator, so a second copy of that
 * generator living in this file would be one refactor away from showing one
 * player a problem the reducer marks against a different answer. `gameTypes.ts`
 * is the app's sanctioned door to the rules package and publishes the state type
 * and the round count, but not the problem generator; that file belongs to
 * another agent this pass, so this renderer reaches for the one remaining piece
 * directly, by the same relative path `gameTypes.ts` itself uses. Those imports
 * should move into `gameTypes.ts` the moment it is safe to edit.
 */

/** Widest the keypad is allowed to grow. Beyond this the keys stop being keys. */
const MAX_KEYPAD = 300;
/** Height the problem asks for before the keypad takes its share of what is left. */
const PROBLEM_IDEAL = 96;
/** Largest and smallest the sum is ever drawn. Below the floor it stops leading. */
const MAX_PROBLEM_SIZE = 56;
const MIN_PROBLEM_SIZE = 22;

/** The keypad, in reading order. The two non-digits are named, not typed. */
const SIGN = 'sign';
const DELETE = 'delete';
const KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', SIGN, '0', DELETE];

/** Digits an answer may have. Taken from the bound rather than assumed to be 4. */
const MAX_DIGITS = String(MAX_ANSWER_VALUE).length;

export function QuickMathBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  disabledReason,
  width,
  height,
}: GameRendererProps<QuickMathState>): React.JSX.Element {
  const theme = useTheme();

  const problem = useMemo(() => currentProblem(state), [state]);
  const seat = players.indexOf(local);
  const mine = state.answers[seat] ?? null;

  /**
   * When this device put the problem on screen. The origin of its own clock,
   * and the only origin the answer's milliseconds may ever be measured from.
   */
  const shownAt = useRef(Date.now());
  const [digits, setDigits] = useState('');
  const [negative, setNegative] = useState(false);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    // A new problem is a new clock and an empty entry. The round number is what
    // identifies a problem - the sum itself is derived from it - so it is the
    // only thing this needs to watch.
    shownAt.current = Date.now();
    setDigits('');
    setNegative(false);
    setRefused(false);
  }, [state.round]);

  const answered = mine !== null;
  const closed = answered || !live || problem === null;

  // The board is sized from BOTH numbers. Width alone gave the old game screen
  // boards that ran off the bottom, and the scroll view that existed to cope
  // with that is what stole the touches from every drag game.
  const gap = theme.spacing.sm;
  const font = theme.typography;

  // Each block below the problem, at the height it takes when it is at its
  // tallest. `Button` puts its reason inside its own frame, so Submit's slot has
  // to hold both; the two are added here and the slot is pinned to that height
  // in the JSX, so a reason coming and going as the player types does not shunt
  // the keypad up and down under their finger.
  const barHeight = theme.spacing.sm * 2 + font.footnote.lineHeight + font.caption.lineHeight;
  const submitBlock = theme.spacing.md * 2 + 4 + font.headline.lineHeight + theme.spacing.xs + font.footnote.lineHeight;
  const hintHeight = theme.spacing.md + font.footnote.lineHeight;
  const chrome = barHeight + MIN_TARGET + theme.spacing.md * 2 + submitBlock + hintHeight;

  /** All that the problem and the keypad have to share. */
  const spare = Math.max(0, height - chrome);

  /**
   * The smallest a key may be DRAWN. Not MIN_TARGET: `Cell` pads a small key out
   * to 44pt with hitSlop, so what has to stay 44 is the hit area rather than the
   * ink. That slop is (44 - size) / 2 per edge, which stays inside the gap
   * between two keys - and so stays unambiguous about which key a touch belongs
   * to - only while a key is no smaller than 44 less that gap. Any smaller and
   * two slops overlap, so a touch in the seam types whichever digit the hit test
   * reached first, which is worse than a slightly small key.
   */
  const minKey = MIN_TARGET - gap;
  const keypadWidth = Math.min(width, MAX_KEYPAD);
  const byWidth = (keypadWidth - gap * 2) / 3;
  const byHeight = (spare - PROBLEM_IDEAL - gap * 3) / 4;
  const key = Math.max(minKey, Math.min(byWidth, byHeight));

  // What the problem actually gets, once the keypad has taken its share - which
  // is the number the sum is sized against, so it cannot be drawn too big to fit.
  const problemBox = Math.max(0, spare - (key * 4 + gap * 3));
  const captionBlock = font.caption.lineHeight + theme.spacing.sm;
  const problemSize = Math.max(
    MIN_PROBLEM_SIZE,
    Math.min(width * 0.16, (problemBox - captionBlock) / 1.2, MAX_PROBLEM_SIZE),
  );
  const entrySize = Math.min(problemSize * 0.72, 34);

  const press = (label: string): void => {
    setRefused(false);
    if (label === DELETE) {
      setDigits((current) => current.slice(0, -1));
      return;
    }
    if (label === SIGN) {
      setNegative((current) => !current);
      return;
    }
    setDigits((current) => {
      if (current.length >= MAX_DIGITS) return current;
      // A leading zero would type as "05" and submit as 5 anyway. Replacing it
      // keeps the line the player reads the same as the number they send.
      return current === '0' ? label : current + label;
    });
  };

  const submit = (): void => {
    if (digits.length === 0 || problem === null) return;
    const ms = Math.min(MAX_ANSWER_MS, Math.max(0, Math.round(Date.now() - shownAt.current)));
    const value = (negative ? -1 : 1) * Number(digits);
    // The reducer is asked, never second-guessed: a stale round or an answer
    // already in flight is its call to make, and a refusal is shown rather than
    // swallowed.
    if (!dispatch('answer', { round: state.round, value, ms })) setRefused(true);
  };

  const typed = digits.length === 0 ? null : (negative ? -1 : 1) * Number(digits);
  const shown = mine !== null ? mine.value : typed;

  /**
   * Why Submit is dead, in words, whichever reason applies. `disabledReason`
   * comes first because only it can tell a dropped link from a finished match -
   * a renderer that guesses at that ends up saying "waiting for the connection"
   * over a perfectly good connection. A finished match is second because the
   * room may not have marked the board dead yet on the frame the tenth answer
   * resolves, and a Submit that is alive but does nothing is worse than one that
   * says why it is not.
   */
  const blocked = !live
    ? disabledReason
    : problem === null
    ? playText.quickMath.finished(QUICK_MATH_ROUNDS)
    : answered
    ? playText.quickMath.answered
    : digits.length === 0
    ? playText.quickMath.typeAnswer
    : null;

  return (
    <View style={{ width, height }}>
      <PlayerBar
        players={players}
        local={local}
        turn={null}
        nameFor={nameFor}
        scoreFor={(player) => state.scores[players.indexOf(player)] ?? 0}
        captionFor={(player) => playText.quickMath.gotRight(state.correct[players.indexOf(player)] ?? 0)}
      />

      {/* The problem. The flexible block: it takes whatever the fixed furniture
          below leaves, and its type size was computed against exactly that. */}
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
        {problem === null ? (
          <Label variant="title2" align="center">
            {playText.quickMath.finished(QUICK_MATH_ROUNDS)}
          </Label>
        ) : (
          <>
            <Label variant="caption" tone="tertiary">
              {playText.quickMath.problem(state.round + 1, QUICK_MATH_ROUNDS)}
            </Label>
            <Label
              accessibilityRole="text"
              accessibilityLabel={spoken(problem)}
              numberOfLines={1}
              style={{
                marginTop: theme.spacing.sm,
                fontSize: problemSize,
                lineHeight: problemSize * 1.2,
                fontWeight: '700',
                letterSpacing: -0.5,
                color: theme.colors.text,
              }}
            >
              {problemText(problem)}
            </Label>
          </>
        )}
      </View>

      {/* The answer so far, or the answer given. Once it is given it is the
          record of what went to the other phone, so it stops being editable. */}
      <View
        accessible
        accessibilityLabel={playText.quickMath.answerLabel(
          shown === null ? playText.quickMath.noAnswerYet : String(shown),
        )}
        style={{
          height: MIN_TARGET,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: theme.radius.md,
          backgroundColor: answered ? theme.colors.accentMuted : theme.colors.surfaceElevated,
        }}
      >
        <Animated.View key={String(shown)} entering={ZoomIn.duration(theme.motion.instant)}>
          <Label
            style={{
              fontSize: entrySize,
              lineHeight: entrySize * 1.2,
              fontWeight: '600',
              color: shown === null ? theme.colors.textTertiary : theme.colors.text,
            }}
          >
            {shown === null ? playText.quickMath.noAnswerYet : String(shown)}
          </Label>
        </Animated.View>
      </View>

      <View style={{ height: theme.spacing.md }} />

      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap,
          width: key * 3 + gap * 2,
          alignSelf: 'center',
        }}
      >
        {KEYS.map((label) => {
          // Disabling a key that can do nothing is a courtesy, not a rule check:
          // the reason the whole keypad is dead is printed under Submit, which is
          // the only control here that talks to the reducer. Delete is the one
          // key that can go dead on its own, so it carries its own reason - a
          // screen reader would otherwise announce it as simply unavailable.
          const nothingToDelete = label === DELETE && digits.length === 0;
          const dead = closed || nothingToDelete;
          return (
            <Cell
              key={label}
              size={key}
              disabled={dead}
              onPress={dead ? undefined : () => press(label)}
              accessibilityLabel={nothingToDelete ? playText.quickMath.nothingToDelete : labelFor(label)}
              accessibilityState={{ disabled: dead, selected: label === SIGN ? negative : false }}
              style={{
                borderRadius: theme.radius.md,
                backgroundColor:
                  label === SIGN && negative ? theme.colors.accentMuted : theme.colors.surfaceElevated,
                opacity: dead ? 0.45 : 1,
              }}
            >
              <Label variant="title2" tone={label === SIGN && negative ? 'accent' : 'primary'}>
                {faceFor(label)}
              </Label>
            </Cell>
          );
        })}
      </View>

      <View style={{ height: theme.spacing.md }} />

      <Button
        title={playText.quickMath.submit}
        onPress={submit}
        disabled={blocked !== null}
        disabledReason={blocked ?? undefined}
        style={{ height: submitBlock }}
      />

      {/* One line, always reserved. A refusal appearing must not shove the
          keypad upwards under a finger already on its way down. */}
      <View style={{ height: hintHeight, overflow: 'hidden' }}>
        {refused ? <Hint text={playText.quickMath.refused} tone="secondary" /> : null}
      </View>
    </View>
  );
}

/** The face of a key. Digits are themselves; the other two are symbols. */
function faceFor(label: string): string {
  if (label === SIGN) return playText.quickMath.signKey;
  if (label === DELETE) return playText.quickMath.deleteKey;
  return label;
}

function labelFor(label: string): string {
  if (label === SIGN) return playText.quickMath.signLabel;
  if (label === DELETE) return playText.quickMath.deleteLabel;
  return playText.quickMath.digit(label);
}

/** The sum in words, because a voice cannot be trusted to read '×'. */
function spoken(problem: QuickMathProblem): string {
  const operator =
    problem.op === '+'
      ? playText.quickMath.plus
      : problem.op === '-'
      ? playText.quickMath.minus
      : playText.quickMath.times;
  return playText.quickMath.spokenProblem(problem.left, operator, problem.right);
}
