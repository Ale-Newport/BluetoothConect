import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Button, Label, haptic, useTheme } from '../../../ui/index.js';
import { Hint, MIN_TARGET, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import { TAP_RACE_ROUNDS, type TapRaceState } from '../gameTypes.js';

/**
 * Tap Race.
 *
 * NOTHING IS SENT PER TAP. The rules file says why at length; what that means
 * here is that this renderer owns the twenty seconds entirely. It runs its own
 * countdown, keeps the running total in a ref, and dispatches exactly ONE
 * `report` when the window closes. A tap is not a move, and the reducer never
 * hears about one.
 *
 * The count lives in a ref rather than in state because a hand can produce ten
 * taps a second and a state update per tap is a re-render per tap - on the one
 * screen in the app where the main thread is being asked to keep up with a
 * drumming thumb. A single 100 ms interval copies the ref into state, which is
 * faster than the eye reads a changing number and costs a tenth of the work.
 *
 * The clock starts on the FIRST TAP, not on a Ready button and not on the round
 * arriving. A button would be a target you must hit before the target you are
 * timed on, and an automatic start would burn seconds off a player who happened
 * to be reading the result of the last round. Starting on contact means the
 * first tap of the race is also the first tap counted, so nobody loses anything
 * to the interface. The two phones' windows need not line up - the rules are
 * built so that they need not, because each player is only ever measured
 * against their own twenty seconds.
 */

/**
 * The window. It is not read from the rules - the reducer has no clock and does
 * not import one - so the renderer that owns the countdown owns the constant,
 * exactly as `tapRace.ts` describes.
 */
const ROUND_MS = 20_000;
/** Ten frames a second: live to the eye, a tenth of the renders of a live count. */
const TICK_MS = 100;
/** When the bar starts to press. Amber, matching Trivia: a nudge, not a failure. */
const URGENT_MS = 5_000;

/** A round entry nobody has reported. The rules' NOT_REPORTED, read not judged. */
const NOT_REPORTED = -1;
/**
 * The majority of three, and the reason this board cannot just count rounds.
 *
 * The rules stop the match the moment someone is two up, so after a 2-0 the
 * third round is never tapped - see `matchOver` below.
 */
const WINS_TO_TAKE_IT = 2;
/**
 * The ceiling the wire puts on a report.
 *
 * The codec REFUSES anything above it rather than clamping, and `submitLocal`
 * round-trips our own action through that codec, so an over-large count is
 * refused for us exactly as it would be for a lying peer. Clamped here so a
 * runaway digitiser produces a low number rather than a report that can never
 * be sent.
 */
const MAX_TAPS = 2000;

/**
 * The player bar, the round line, its bar, and the footer under the pad.
 *
 * Roughly 50 + 12 + 16 + 7 + 12 + 76 = 173 at the default text size; the rest
 * is headroom for a player who has turned the system type up a notch.
 */
const CHROME_HEIGHT = 196;
/**
 * Beyond this the pad stops being a target and starts being a wall; a tablet
 * does not need a 700pt slab to catch a thumb.
 */
const MAX_PAD = 420;

export function TapRaceBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  disabledReason,
  width,
  height,
}: GameRendererProps<TapRaceState>): React.JSX.Element {
  const theme = useTheme();

  const seat = players.indexOf(local);
  const round = currentRound(state);
  const over = matchOver(state);
  const settled = lastSettledRound(state);
  const mine = countAt(state, round, seat);

  /** When this device's window opened. Null whenever no window is running. */
  const startedAt = useRef<number | null>(null);
  /** The running total. Written on every tap, read ten times a second. */
  const taps = useRef(0);
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState({ count: 0, remainingMs: ROUND_MS });
  /**
   * A finished count the reducer would not take yet.
   *
   * Holding it is the difference between a lost round and a delayed one: the
   * number exists only on this phone, so if the report is refused at the moment
   * the window closes it has to stay somewhere with a control to send it again.
   */
  const [held, setHeld] = useState<number | null>(null);
  /**
   * The round this device has already closed.
   *
   * Held separately from the state because the state arrives a beat later: for
   * the frame between the window ending and the reducer's result reaching this
   * component, `counts` still says nothing was reported, and without this the
   * pad would offer "Tap to start" for a round that has just been sent - and a
   * second window nobody could report.
   */
  const closedRound = useRef(-1);

  // A new round is a clean sheet: no leftover count, no leftover clock. This
  // also runs on mount, which is what rebuilds the pad correctly for a game
  // rejoined halfway through.
  useEffect(() => {
    taps.current = 0;
    startedAt.current = null;
    closedRound.current = -1;
    setRunning(false);
    setShown({ count: 0, remainingMs: ROUND_MS });
    setHeld(null);
  }, [round]);

  const finish = useCallback(() => {
    // Clamped to what the wire will carry. Above MAX_TAPS the codec throws, the
    // runtime turns that into a refusal, and the count lands in `held` with a
    // button that would be refused again every time it is pressed. Reaction
    // clamps its milliseconds before dispatching for exactly this reason.
    const total = Math.min(taps.current, MAX_TAPS);
    // Cleared first, so the interval's next fire cannot finish the same window
    // twice in the gap before its cleanup runs.
    startedAt.current = null;
    closedRound.current = round;
    setRunning(false);
    setShown({ count: total, remainingMs: 0 });
    haptic('impactMedium');
    // Sent even when the link is down: actions travel reliably and the session
    // survives a walk out of range, so a queued report arrives late rather than
    // never. `false` here means the RULES refused it, which is the only case
    // worth holding a count for.
    if (!dispatch('report', { round, count: total })) setHeld(total);
  }, [dispatch, round]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const from = startedAt.current;
      if (from === null) return;
      const left = ROUND_MS - (Date.now() - from);
      if (left <= 0) {
        finish();
        return;
      }
      setShown({ count: taps.current, remainingMs: left });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [finish, running]);

  const sendHeld = useCallback(() => {
    if (held === null) return;
    if (dispatch('report', { round, count: held })) setHeld(null);
  }, [dispatch, held, round]);

  // A held count goes out by itself the moment the link is back. The deps only
  // change on a transition, so a report the rules keep refusing is attempted
  // once per reconnection rather than in a loop - and the button below stays
  // there for the case where it never succeeds.
  useEffect(() => {
    if (held === null || !live) return;
    sendHeld();
  }, [held, live, sendHeld]);

  const tap = useCallback(() => {
    if (startedAt.current === null) {
      // A window that has already closed is never reopened. `finish` records
      // the round before React can redraw the pad dead, and without this a
      // finger landing in that one frame would start a SECOND twenty seconds
      // for a round already reported - a race nobody could ever submit.
      if (closedRound.current === round) return;
      startedAt.current = Date.now();
      taps.current = 1; // The tap that opened the window is the first one counted.
      setShown({ count: 1, remainingMs: ROUND_MS });
      setRunning(true);
      haptic('impactLight');
      return;
    }
    taps.current += 1;
    // Deliberately no haptic and no state write per tap. The taptic engine
    // cannot keep up with ten a second and neither can React; the number
    // updating on the interval is the feedback.
  }, [round]);

  // The floor is one legal target, not two. The room hands a finished game a
  // box a little over half the height it had - the result card takes the rest -
  // and on the shortest phone that leaves under 250pt for chrome that already
  // wants 173. A floor of 88 would put more content in the box than the box
  // holds and slide the footer under the card; 44 still cannot be missed.
  const pad = Math.min(Math.max(height - CHROME_HEIGHT, MIN_TARGET), MAX_PAD);
  const padWidth = Math.min(width, MAX_PAD);
  const countFont = Math.min(Math.round(pad * 0.34), 88);

  const reported = mine !== NOT_REPORTED || held !== null || closedRound.current === round;
  // Starting a window needs a live link: a twenty-second race is not a thing to
  // begin while the screen is showing a reconnect banner. `over` is asked as
  // well, rather than trusting the room to have gone dead first, because two
  // round wins take the match - so after a 2-0 there is a third round the RULES
  // will never accept a report for, and offering it would cost the player
  // twenty seconds and then hold the count for ever.
  //
  // A window ALREADY running is never interrupted - the count is local, the
  // report queues, and stopping someone's race because the radio blinked would
  // be the game losing a round the player did not.
  const canStart = live && !over && !reported;
  const openable = running || canStart;

  const seconds = Math.ceil(shown.remainingMs / 1000);
  // This device's own window is the truth while it is on screen; `counts` is
  // the truth for a game rejoined with a round already played on another run.
  const padCount = running || closedRound.current === round ? shown.count : mine;

  /**
   * The pad's label carries the count and, when it cannot be tapped, the reason.
   *
   * The pad is one accessibility element, so everything drawn inside it - the
   * number, the caption, the sentence explaining a dead pad - is invisible to a
   * screen reader and has to be said here instead. The label
   * changing as the count climbs costs nothing: it is read when the element is
   * focused, not announced on every change.
   */
  const padLabel =
    running || reported
      ? `${playText.tapRace.tapArea}, ${playText.tapRace.tapCount(padCount)}`
      : canStart
      ? playText.tapRace.tapArea
      : `${playText.tapRace.tapArea}, ${disabledReason ?? playText.room.waitingForLink}`;

  return (
    <View style={{ height, width, justifyContent: 'center' }}>
      <PlayerBar
        players={players}
        local={local}
        turn={null}
        nameFor={nameFor}
        scoreFor={(player) => roundsWon(state, players.indexOf(player))}
        // The number itself is withheld until the round closes. Whoever reports
        // second would otherwise be tapping against a figure on their own
        // screen, and "one more than yours" is not a race.
        captionFor={(player) =>
          countAt(state, round, players.indexOf(player)) === NOT_REPORTED ? null : playText.tapRace.countIn
        }
      />

      <View style={{ height: theme.spacing.md }} />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Label variant="caption" tone="tertiary">
          {/* A finished match names the round that DECIDED it, not the one
              after. `currentRound` answers "which round is open", and after a
              2-0 that is round 2 - a round nobody tapped, and "Round 3 of 3"
              over a match that ended in two is simply untrue. */}
          {playText.tapRace.round(over ? settled + 1 : round + 1, TAP_RACE_ROUNDS)}
        </Label>
        {running ? (
          <Label variant="caption" tone={shown.remainingMs < URGENT_MS ? 'accent' : 'tertiary'}>
            {playText.tapRace.secondsLeft(seconds)}
          </Label>
        ) : reported ? (
          <Label variant="caption" tone="tertiary">
            {playText.tapRace.timeUp}
          </Label>
        ) : null}
      </View>

      {/* The same countdown bar Trivia uses, for the same reason: it is readable
          without being read, and it visibly has an end. */}
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
            width: `${running ? (shown.remainingMs / ROUND_MS) * 100 : 0}%`,
            height: 3,
            backgroundColor: shown.remainingMs < URGENT_MS ? theme.colors.warning : theme.colors.accent,
          }}
        />
      </View>

      <View style={{ height: theme.spacing.md }} />

      {/*
        A raw responder rather than a Pressable, and the difference decides the
        game. A Pressable emits one press per GESTURE, and a gesture lasts until
        the last finger lifts: with two thumbs drumming - which is how anyone
        actually plays a tap race - the second thumb landing is not a new press,
        and neither is the first one landing again while the second is still
        down. A whole overlapping burst can come out as a single press, so the
        race would be won by whoever happened to use one finger.

        `onResponderStart` fires once per finger going down, every finger after
        the first included, so what is counted is contacts - which is what the
        game claims to measure.
      */}
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={padLabel}
        accessibilityHint={playText.tapRace.tapHint}
        accessibilityState={{ disabled: !openable }}
        // VoiceOver's double-tap is an activation, not a touch, and never
        // reaches the responder handlers. Without this the pad would be a dead
        // slab to anyone playing with the screen curtain down.
        onAccessibilityTap={openable ? tap : undefined}
        onStartShouldSetResponder={() => openable}
        // Nothing takes the gesture off this pad mid-race. There is no scroll
        // view left in the room to lose it to, and there had better never be.
        onResponderTerminationRequest={() => false}
        // Counted on contact, not on release: a press is only reported once the
        // finger lifts, and a tap that slid a pixel is reported as a drag and
        // not at all. This game counts contact, so it counts on contact.
        //
        // Nothing is submitted here either, so a gesture the system takes
        // anyway - a call arriving, the app pulled away - is simply abandoned:
        // the taps already counted stand, the window keeps running on its own
        // clock, and the single report still goes out when it closes.
        onResponderStart={openable ? tap : undefined}
        style={{
          width: padWidth,
          height: pad,
          // The pad is the one thing on the board that can afford to give way,
          // so it is what shrinks if a large system text size grows the chrome
          // past the headroom CHROME_HEIGHT allows for.
          flexShrink: 1,
          alignSelf: 'center',
          borderRadius: theme.radius.xl,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: theme.spacing.lg,
          backgroundColor: running ? theme.colors.accent : theme.colors.surfaceElevated,
        }}
      >
        {running || reported ? (
          <>
            <Label
              variant="largeTitle"
              tone={running ? 'onAccent' : 'primary'}
              align="center"
              // One line, always. Four digits at 88pt is wider than a narrow
              // phone, and a count that wraps mid-race would push its own
              // caption out of the pad.
              numberOfLines={1}
              // Tabular figures: proportional ones change width as the count
              // climbs, and a number that shuffles sideways ten times a second
              // is the one thing on this screen the eye should not have to
              // track.
              style={{ fontSize: countFont, lineHeight: countFont * 1.1, fontVariant: ['tabular-nums'] }}
            >
              {padCount}
            </Label>
            <Label variant="footnote" tone={running ? 'onAccent' : 'tertiary'} align="center">
              {running
                ? playText.tapRace.taps
                : held === null
                ? playText.tapRace.waitingOther
                : playText.tapRace.countHeld}
            </Label>
          </>
        ) : (
          <Label variant="title2" tone={canStart ? 'primary' : 'secondary'} align="center">
            {/* A dead pad says why on its own face. `disabledReason` is null
                exactly when `live` is true, and a match this board has called
                over is a match the room has too, so the fallback is
                unreachable - it is there because a pad reading "undefined"
                would be worse than one repeating itself. */}
            {canStart ? playText.tapRace.tapToStart : disabledReason ?? playText.room.waitingForLink}
          </Label>
        )}
      </View>

      {/* A fixed footer, so the pad does not move under a thumb that is mid-race
          when a result or a button appears below it. */}
      <View style={{ height: FOOTER_HEIGHT, justifyContent: 'center' }}>
        {held !== null ? (
          <Button
            title={playText.tapRace.sendCount}
            onPress={sendHeld}
            disabled={!live}
            disabledReason={disabledReason ?? playText.tapRace.countHeld}
          />
        ) : running ? (
          <Hint text={playText.tapRace.counting} />
        ) : settled >= 0 ? (
          <RoundResult state={state} round={settled} players={players} local={local} nameFor={nameFor} />
        ) : (
          <Hint text={playText.tapRace.tapHint} />
        )}
      </View>
    </View>
  );
}

/** Room for a two-line result, or a button with its reason underneath. */
const FOOTER_HEIGHT = 76;

/** The last finished round: who took it, and both numbers, now that both exist. */
function RoundResult({
  state,
  round,
  players,
  local,
  nameFor,
}: {
  state: TapRaceState;
  round: number;
  players: readonly string[];
  local: string;
  nameFor: (player: string) => string;
}): React.JSX.Element | null {
  const theme = useTheme();
  const first = countAt(state, round, 0);
  const second = countAt(state, round, 1);
  if (first === NOT_REPORTED || second === NOT_REPORTED) return null;

  const winner = first === second ? null : players[first > second ? 0 : 1] ?? null;

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Label variant="footnote" tone="secondary" align="center">
        {winner === null ? playText.tapRace.roundTied : playText.tapRace.roundTo(nameOf(winner, local, nameFor))}
      </Label>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: theme.spacing.lg }}>
        {players.map((player, index) => (
          <Label key={player} variant="caption" tone="tertiary">
            {playText.tapRace.tapsFor(nameOf(player, local, nameFor), countAt(state, round, index))}
          </Label>
        ))}
      </View>
    </View>
  );
}

function nameOf(player: string, local: string, nameFor: (player: string) => string): string {
  return player === local ? playText.room.you : nameFor(player);
}

// ---------------------------------------------------------------------------
// Reads of the state. Not rules - the reducer decides what may happen, and
// these only say what has already happened, which is what a board draws.
// ---------------------------------------------------------------------------

function countAt(state: TapRaceState, round: number, seat: number): number {
  return state.counts[round]?.[seat] ?? NOT_REPORTED;
}

/** The round being tapped now, or TAP_RACE_ROUNDS once every one is settled. */
function currentRound(state: TapRaceState): number {
  for (let round = 0; round < TAP_RACE_ROUNDS; round++) {
    if (countAt(state, round, 0) === NOT_REPORTED || countAt(state, round, 1) === NOT_REPORTED) return round;
  }
  return TAP_RACE_ROUNDS;
}

/**
 * The last round both players settled, or -1 before the first one closes.
 *
 * Not `currentRound - 1`: those agree while a match is running, and disagree
 * the moment it is decided early, which is precisely when the footer is being
 * asked to show the round that finished it.
 */
function lastSettledRound(state: TapRaceState): number {
  for (let round = TAP_RACE_ROUNDS - 1; round >= 0; round--) {
    if (countAt(state, round, 0) !== NOT_REPORTED && countAt(state, round, 1) !== NOT_REPORTED) return round;
  }
  return -1;
}

/**
 * Is the match settled? The rules' own test, read the same way here.
 *
 * Two wins take it, so this is NOT "all three rounds played": after a 2-0 the
 * reducer refuses every further report, and a board that counted rounds instead
 * would open a twenty-second window for a round that cannot be reported.
 */
function matchOver(state: TapRaceState): boolean {
  if (roundsWon(state, 0) >= WINS_TO_TAKE_IT || roundsWon(state, 1) >= WINS_TO_TAKE_IT) return true;
  return currentRound(state) >= TAP_RACE_ROUNDS;
}

/** Rounds a seat has taken. Ties go to nobody, exactly as the rules score them. */
function roundsWon(state: TapRaceState, seat: number): number {
  if (seat < 0) return 0;
  let won = 0;
  for (let round = 0; round < TAP_RACE_ROUNDS; round++) {
    const first = countAt(state, round, 0);
    const second = countAt(state, round, 1);
    if (first === NOT_REPORTED || second === NOT_REPORTED || first === second) continue;
    if ((first > second ? 0 : 1) === seat) won += 1;
  }
  return won;
}
