import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { systemRandom, toHex } from '@airlink/core';
import { useClient } from '../../../client/ClientProvider.js';
import { Label, haptic, useTheme } from '../../../ui/index.js';
import { Hint, MIN_TARGET, PlayerBar, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  PAPER,
  ROCK,
  type RockPaperScissorsState,
  RPS_MAX_NONCE as MAX_NONCE,
  RPS_MIN_NONCE as MIN_NONCE,
  RPS_ROUNDS,
  RPS_WINS_NEEDED as WINS_NEEDED,
  type RpsChoice as Choice,
  rpsCommitment as commitment,
  rpsRoundWinner as roundWinner,
  rpsUnpackOutcome as unpackOutcome,
  SCISSORS,
} from '../gameTypes.js';

/**
 * Rock Paper Scissors.
 *
 * The one game here that is SIMULTANEOUS on top of a turn-based reducer, and
 * the rules solve that with commit-then-reveal: a round is H(choice||nonce)
 * from each player, and only once both commitments are in may either choice be
 * opened. That protocol decides everything about this screen.
 *
 *   ONE TAP, TWO ACTIONS. The player picks once. This renderer sends the
 *   `commit`, and then sends the `reveal` itself the moment the opponent's
 *   commitment lands. Asking the user to press a second "reveal" button was the
 *   alternative and it lost twice over: they have nothing left to decide, and a
 *   player who wandered off between the two presses would stall a round that
 *   the reducer has no way to time out.
 *
 *   THE WAIT IS NARRATED. Between the two actions the board genuinely cannot
 *   move, and a one-tap game that sits still for two seconds reads as frozen.
 *   So the line under the choices always names what is being waited for and
 *   who is being waited on.
 *
 *   THE CHOICE OUTLIVES THE APP. The nonce is the whole secret, and it is only
 *   ever on this phone. If it is lost between the commit and the reveal the
 *   commitment can never be opened and the round is dead - so it is written to
 *   the settings table exactly as Battleship writes its fleet, rather than held
 *   in a ref that a backgrounded app can lose. When it IS gone the board says
 *   so; a round that quietly never resolves is the worse failure.
 *
 * The marks are drawn from plain views rather than typed as emoji: a hand
 * glyph renders differently on every platform and font, and this board needs
 * the three shapes to be told apart at a glance and at any size.
 */

/** The row of three never grows past this, however wide the phone is. */
const MAX_ROW = 420;
/** The strip of round pips. Named because the height reserve has to know it. */
const PIP_HEIGHT = 26;
/**
 * Floor under the status area, so the three targets do not shift up and down as
 * the wording between the two steps of a round changes. Every line that can
 * appear down there fits inside it; a longer one grows the box rather than
 * being clipped, because the reserve below has slack for exactly that.
 */
const STATUS_FLOOR = 96;
/** 24 hex characters, comfortably inside the reducer's MIN_NONCE..MAX_NONCE. */
const NONCE_BYTES = 12;

const CHOICES: readonly Choice[] = [ROCK, PAPER, SCISSORS];

export function RockPaperScissorsBoard({
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
  sessionKey,
}: GameRendererProps<RockPaperScissorsState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  /*
   * `state.players` rather than the `players` prop, and deliberately so: a
   * commitment is bound to the index the REDUCER knows this device by, so a
   * seat derived from any other list would produce a digest that this player's
   * own reveal could not open.
   */
  const seat = state.players.indexOf(local) === 1 ? 1 : 0;
  const foe = seat === 1 ? 0 : 1;
  const foeName = nameFor(state.players[foe] ?? players[foe] ?? local);

  const myCommit = state.commits[seat] ?? null;
  const theirCommit = state.commits[foe] ?? null;
  const myReveal = state.reveals[seat] ?? 0;

  const { pick, loading, seal, forget } = useSealedPick(sessionKey);

  /*
   * Everything on this board that is not one of the three targets, ADDED UP
   * from the tokens that draw it: the player bar and its caption, the gap under
   * it, the round line, the pips and their gap, and the floor under the status
   * area. It was one hand-counted constant, and a hand-counted constant is
   * wrong silently the first time a line is added above the row - too small and
   * the targets push the scene off the bottom, too large and they shrink for no
   * reason. A sum can only be wrong in one place.
   */
  const chrome =
    theme.spacing.sm * 2 +
    theme.typography.footnote.lineHeight +
    theme.typography.caption.lineHeight +
    theme.spacing.lg +
    theme.typography.caption.lineHeight +
    theme.spacing.xs +
    PIP_HEIGHT +
    theme.spacing.md +
    STATUS_FLOOR;

  const gap = theme.spacing.md;
  const row = Math.min(width, MAX_ROW);
  const targetWidth = Math.max(MIN_TARGET, (row - gap * 2) / 3);
  // Slightly taller than wide so the mark and its name both have room, but
  // never taller than the space actually left below the chrome. The 44pt floor
  // wins over the box if it ever comes to that: a target too small to hit is a
  // worse board than one that is a few points too tall.
  const targetHeight = Math.max(MIN_TARGET, Math.min(targetWidth * 1.15, height - chrome));

  /*
   * The second half of the protocol, sent without asking.
   *
   * In an effect rather than in the tap handler because the opponent's
   * commitment usually arrives long after the tap, and guarded on our own
   * reveal slot so a re-render cannot send the same reveal twice - the reducer
   * would refuse the duplicate, but a refused action is still a packet on a
   * Bluetooth link.
   */
  useEffect(() => {
    if (!live || myCommit === null || theirCommit === null || myReveal !== 0) return;
    // A pick filed against an earlier round is not ours to open: the round
    // counter moves the moment both reveals land, and the preimage carries it.
    if (!pick || pick.round !== state.round) return;
    dispatch('reveal', { choice: pick.choice, nonce: pick.nonce });
  }, [dispatch, live, myCommit, myReveal, pick, state.round, theirCommit]);

  /*
   * The round this device has already sent a commitment for.
   *
   * A ref, and read before anything else in `choose`, because `state.commits`
   * cannot close this window: two fingers landing on two different choices in
   * the same frame both run against the SAME render, so both see an empty
   * commitment slot and both go through. The first files its nonce and commits;
   * the second overwrites that nonce with one for a choice the reducer will
   * refuse - and the round is then unopenable, because the only preimage that
   * matches the commitment on the board has just been thrown away. It is a
   * plausible tap in a game about being quick, and it costs the round.
   */
  const committedRound = useRef<number | null>(null);

  const choose = useCallback(
    (choice: Choice) => {
      if (committedRound.current === state.round) return;
      committedRound.current = state.round;

      const nonce = toHex(systemRandom.randomBytes(NONCE_BYTES));
      // Filed BEFORE the commitment goes out. A commitment whose nonce was
      // never written down is a round nobody can finish, so the write that can
      // fail happens first and the commit is what gets abandoned if it does.
      seal({ round: state.round, choice, nonce });
      haptic('selection');
      if (dispatch('commit', { hash: commitment(seat, state.round, choice, nonce) })) return;

      // Nothing reached the board, so the nonce is worth nothing and the round
      // is still there to be played: drop both and let the player tap again.
      committedRound.current = null;
      forget();
    },
    [dispatch, forget, seal, seat, state.round],
  );

  const played = state.outcomes.length;
  const lastPacked = played > 0 ? state.outcomes[played - 1] : undefined;
  const last = lastPacked === undefined ? null : readRound(lastPacked, seat);
  /*
   * Read from the state rather than from `live`, which is also false while the
   * link is merely down. A match can end two rounds early on a third win, and
   * then the empty commitment slots would otherwise be captioned "Choosing…" -
   * a board inviting a choice that no longer exists.
   */
  const finished =
    state.round >= RPS_ROUNDS ||
    (state.scores[0] ?? 0) >= WINS_NEEDED ||
    (state.scores[1] ?? 0) >= WINS_NEEDED;

  /*
   * A round opens itself while nobody is touching the screen, so a small tap is
   * the only thing that says it happened to a player who looked away. Seeded
   * from the current count so rejoining a match in progress does not replay
   * every round that was decided before this board existed.
   */
  const settled = useRef(played);
  useEffect(() => {
    if (played === settled.current) return;
    settled.current = played;
    haptic(last?.outcome === 'mine' ? 'success' : 'impactLight');
  }, [last, played]);

  // Both committed, neither our reveal nor the nonce that would produce it: the
  // only state in this game that cannot resolve itself, and it has to be said.
  const secretLost =
    !loading && myCommit !== null && theirCommit !== null && myReveal === 0 && pick?.round !== state.round;

  const chosen = myCommit !== null;
  const myPick = pick?.round === state.round ? pick.choice : null;
  const pickable = live && !chosen;

  const status = !live
    ? disabledReason ?? ''
    : !chosen
    ? playText.rockPaperScissors.choose
    : theirCommit === null
    ? playText.rockPaperScissors.waitingChoice(foeName)
    : myReveal === 0
    ? playText.rockPaperScissors.opening
    : playText.rockPaperScissors.waitingShow(foeName);

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={turn}
        nameFor={nameFor}
        scoreFor={(player) => state.scores[state.players.indexOf(player)] ?? 0}
        captionFor={(player) => (finished ? null : captionFor(state, state.players.indexOf(player)))}
      />

      <View style={{ height: theme.spacing.lg }} />

      <Label variant="caption" tone="tertiary">
        {playText.rockPaperScissors.round(
          finished ? Math.max(1, played) : Math.min(state.round + 1, RPS_ROUNDS),
          RPS_ROUNDS,
        )}
      </Label>

      {/* One pip per round of the match, so the shape of the whole best-of-five
          is readable without counting the scores back. */}
      <View style={{ flexDirection: 'row', gap: theme.spacing.xs, marginTop: theme.spacing.xs }}>
        {Array.from({ length: RPS_ROUNDS }, (_unused, index) => {
          const packed = state.outcomes[index];
          const done = packed === undefined ? null : readRound(packed, seat);
          return (
            <View
              key={index}
              accessible
              accessibilityLabel={
                done === null
                  ? playText.rockPaperScissors.roundUnplayed(index + 1)
                  : `${playText.rockPaperScissors.roundPlayed(
                      index + 1,
                      choiceName(done.mine),
                      choiceName(done.theirs),
                    )}, ${verdictLine(done.outcome, foeName)}`
              }
              style={{
                flex: 1,
                height: PIP_HEIGHT,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: theme.radius.sm,
                borderWidth: done === null ? 1 : 0,
                borderColor: ink.rule,
                backgroundColor:
                  done === null
                    ? 'transparent'
                    : done.outcome === 'mine'
                    ? ink.mine
                    : done.outcome === 'theirs'
                    ? ink.theirs
                    : ink.empty,
              }}
            >
              {/*
                A played pip carries its number only for the screen reader. The
                obvious version printed it in `onAccent` on the winner's ink,
                which is white on white in the dark scheme, because the
                opponent's ink IS the text colour. The colour already says who
                took the round; the digit is only needed while it is a promise.
              */}
              {done === null ? (
                <Label variant="caption" tone="tertiary">
                  {index + 1}
                </Label>
              ) : done.outcome === 'draw' ? (
                <View
                  style={{
                    width: 10,
                    height: 2,
                    borderRadius: 1,
                    backgroundColor: theme.colors.textTertiary,
                  }}
                />
              ) : null}
            </View>
          );
        })}
      </View>

      <View style={{ height: theme.spacing.md }} />

      <View style={{ flexDirection: 'row', gap, alignSelf: 'center' }}>
        {CHOICES.map((choice) => {
          const selected = myPick === choice;
          return (
            <Pressable
              key={choice}
              accessibilityRole="button"
              accessibilityLabel={choiceName(choice)}
              accessibilityState={{ disabled: !pickable, selected }}
              disabled={!pickable}
              onPress={() => choose(choice)}
              style={({ pressed }) => [
                {
                  width: targetWidth,
                  height: targetHeight,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: theme.spacing.sm,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: selected ? theme.colors.accent : theme.colors.separator,
                  backgroundColor: selected ? theme.colors.accentMuted : theme.colors.surface,
                  // Dimmed rather than hidden once the choice is sealed: the
                  // player can still see what they picked while they wait.
                  opacity: !pickable && !selected ? 0.45 : 1,
                },
                pressed ? { opacity: 0.7 } : null,
              ]}
            >
              <Sign
                choice={choice}
                size={Math.min(targetWidth, targetHeight) * 0.42}
                color={selected ? ink.mine : ink.theirs}
              />
              <Label variant="footnote" tone={selected ? 'accent' : 'secondary'}>
                {choiceName(choice)}
              </Label>
            </Pressable>
          );
        })}
      </View>

      {/* The floor the height reserve above accounts for, so the three targets
          do not shift as the wording between the two steps changes. */}
      <View style={{ minHeight: STATUS_FLOOR, justifyContent: 'flex-start' }}>
        {secretLost ? (
          <>
            <Hint text={playText.rockPaperScissors.lostTitle} tone="secondary" />
            <Label variant="caption" tone="tertiary" align="center" style={{ marginTop: theme.spacing.xs }}>
              {playText.rockPaperScissors.lostBody}
            </Label>
          </>
        ) : (
          <>
            {last !== null && !chosen ? (
              <Animated.View
                key={played}
                entering={ZoomIn.duration(theme.motion.quick)}
                style={{ marginTop: theme.spacing.lg, alignItems: 'center', gap: theme.spacing.xs }}
              >
                <Label variant="headline">{headline(last)}</Label>
                <Label
                  variant="footnote"
                  tone={last.outcome === 'mine' ? 'accent' : 'secondary'}
                  align="center"
                >
                  {verdictLine(last.outcome, foeName)}
                </Label>
              </Animated.View>
            ) : null}
            {status ? <Hint text={status} tone={chosen ? 'secondary' : 'tertiary'} /> : null}
            {pickable && played === 0 ? <Hint text={playText.rockPaperScissors.sealed} /> : null}
          </>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Reading a round
// ---------------------------------------------------------------------------

interface RoundView {
  readonly mine: Choice;
  readonly theirs: Choice;
  readonly outcome: 'mine' | 'theirs' | 'draw';
}

/** A packed outcome, turned round so it is told from this device's seat. */
function readRound(packed: number, seat: number): RoundView {
  const { first, second } = unpackOutcome(packed);
  const winner = roundWinner(first, second);
  return {
    mine: seat === 0 ? first : second,
    theirs: seat === 0 ? second : first,
    outcome: winner === 0 ? 'draw' : winner - 1 === seat ? 'mine' : 'theirs',
  };
}

function choiceName(choice: Choice): string {
  if (choice === ROCK) return playText.rockPaperScissors.rock;
  if (choice === PAPER) return playText.rockPaperScissors.paper;
  return playText.rockPaperScissors.scissors;
}

/** "Paper beats Rock", or "Rock against Rock" when the round was drawn. */
function headline(round: RoundView): string {
  if (round.outcome === 'draw') return playText.rockPaperScissors.tied(choiceName(round.mine));
  const winner = round.outcome === 'mine' ? round.mine : round.theirs;
  const loser = round.outcome === 'mine' ? round.theirs : round.mine;
  return playText.rockPaperScissors.beats(choiceName(winner), choiceName(loser));
}

function verdictLine(outcome: RoundView['outcome'], foeName: string): string {
  if (outcome === 'draw') return playText.rockPaperScissors.drawnRound;
  return outcome === 'mine'
    ? playText.rockPaperScissors.youWon
    : playText.rockPaperScissors.theyWon(foeName);
}

/**
 * What each player is doing right now, under their name.
 *
 * Says nothing about WHAT was chosen, only that a choice exists - which is the
 * whole point of the commit phase and the only honest thing this device knows
 * about the other player before the reveal.
 */
function captionFor(state: RockPaperScissorsState, index: number): string | null {
  if (index < 0 || state.round >= RPS_ROUNDS) return null;
  if ((state.reveals[index] ?? 0) !== 0) return playText.rockPaperScissors.shown;
  if ((state.commits[index] ?? null) !== null) return playText.rockPaperScissors.locked;
  return playText.rockPaperScissors.choosing;
}

// ---------------------------------------------------------------------------
// The three marks
// ---------------------------------------------------------------------------

/**
 * Rock is a disc, paper is a sheet, scissors are two crossed blades.
 *
 * Drawn from views rather than set as text for the same reason Tic-Tac-Toe
 * draws its ring and cross: they scale with the target and never inherit a
 * font's - or a platform's - opinion about what a hand looks like.
 */
function Sign({ choice, size, color }: { choice: Choice; size: number; color: string }): React.JSX.Element {
  const stroke = Math.max(2, size * 0.12);

  if (choice === ROCK) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
      />
    );
  }

  if (choice === PAPER) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: size * 0.86,
          height: size,
          borderRadius: size * 0.14,
          borderWidth: stroke,
          borderColor: color,
        }}
      />
    );
  }

  const blade = size * 0.9;
  const ring = size * 0.3;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      {[22, -22].map((angle) => (
        <View
          key={angle}
          style={{
            position: 'absolute',
            width: stroke,
            height: blade,
            borderRadius: stroke / 2,
            backgroundColor: color,
            transform: [{ translateY: -size * 0.08 }, { rotate: `${angle}deg` }],
          }}
        />
      ))}
      {[-1, 1].map((side) => (
        <View
          key={side}
          style={{
            position: 'absolute',
            width: ring,
            height: ring,
            borderRadius: ring / 2,
            borderWidth: Math.max(1.5, stroke * 0.6),
            borderColor: color,
            transform: [{ translateX: side * size * 0.24 }, { translateY: size * 0.36 }],
          }}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The sealed choice
// ---------------------------------------------------------------------------

interface SealedPick {
  readonly round: number;
  readonly choice: Choice;
  readonly nonce: string;
}

const PICK_KEY_PREFIX = 'play.rps.pick.';

interface SealedPickHandle {
  readonly pick: SealedPick | null;
  /** True until the stored pick has been looked for. Never spins forever. */
  readonly loading: boolean;
  seal(next: SealedPick): void;
  forget(): void;
}

/**
 * The choice behind the commitment, kept where the app being killed cannot take
 * it - filed under this game's own id, so a rematch cannot inherit a pick made
 * against a round of the previous match.
 *
 * A ref was the obvious alternative and it is wrong for a protocol with no
 * clock: the opponent may take a minute to commit, the phone may be locked and
 * the app dropped in that minute, and a lost nonce is a round that can never be
 * opened by anybody.
 */
function useSealedPick(gameSessionId: string): SealedPickHandle {
  const client = useClient();
  const [pick, setPick] = useState<SealedPick | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stored: SealedPick | null = null;
    try {
      stored = client.db.settings.getJson<SealedPick | null>(PICK_KEY_PREFIX + gameSessionId, null);
    } catch {
      stored = null;
    }
    setPick(isUsable(stored) ? stored : null);
    setLoading(false);
  }, [client, gameSessionId]);

  const write = useCallback(
    (next: SealedPick | null) => {
      setPick(next);
      try {
        client.db.settings.setJson(PICK_KEY_PREFIX + gameSessionId, next, Date.now());
      } catch {
        // Still playable for this sitting; the board says so if the pick is
        // ever needed after a restart and is not there.
      }
    },
    [client, gameSessionId],
  );

  const seal = useCallback((next: SealedPick) => write(next), [write]);
  const forget = useCallback(() => write(null), [write]);

  return { pick, loading, seal, forget };
}

/** A stored pick this build could still open a commitment with. */
function isUsable(value: SealedPick | null): value is SealedPick {
  if (!value || typeof value !== 'object') return false;
  if (!Number.isInteger(value.round) || value.round < 0 || value.round >= RPS_ROUNDS) return false;
  if (value.choice !== ROCK && value.choice !== PAPER && value.choice !== SCISSORS) return false;
  return typeof value.nonce === 'string' && value.nonce.length >= MIN_NONCE && value.nonce.length <= MAX_NONCE;
}
