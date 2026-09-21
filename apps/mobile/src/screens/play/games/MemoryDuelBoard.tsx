import React from 'react';
import { View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { Label, useTheme } from '../../../ui/index.js';
import { BoardSurface, Cell, Hint, MIN_TARGET, PlayerBar, inkFor, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import { MEMORY_PAIRS, type MemoryDuelState } from '../gameTypes.js';

/**
 * Memory Match Duel.
 *
 * Sixteen cards, and the whole renderer is one question asked of every one of
 * them: is it face down, face up because a turn is under way, face up because
 * the turn that just ended did not match, or taken? Those four states come
 * straight out of the rules - `matchedBy[cell]` and the LENGTH of `revealed` -
 * and none of them is inferred here, because the reducer is the only thing
 * allowed to have an opinion about them.
 *
 * The state that needed the most care is the third. A mismatched pair stays
 * face up until somebody's next flip clears it, deliberately: the rules refuse
 * to hide it on a timer, because a timer is a local decision and the two phones
 * would spend its duration showing different boards. That is right, but it
 * leaves the screen looking like it has frozen with two cards stuck up. So the
 * pair is drawn as something on its way out - dimmed, ringed in the warning
 * ink - and a line under the board says in words what will put them back down.
 *
 * The faces are drawn rather than typed, for the reason ui/Icon.tsx records at
 * length: a symbol character is a bet on the host's font stack that cannot be
 * checked, and the boxed question mark that bet loses would make the game
 * unplayable rather than merely ugly.
 */

const MAX_BOARD = 360;

/**
 * Everything above and below the board: the player bar, the pairs line, the
 * gaps between them and the hint. Subtracted from the height so the board is
 * sized to what is genuinely left, rather than to the width alone and off the
 * bottom of the screen.
 */
const CHROME = 148;

/**
 * Four columns.
 *
 * The rules file calls this `GRID_SIZE` and defines the pair count from it -
 * PAIRS is half of GRID_SIZE squared - so taking the square root of the cards
 * recovers exactly that number rather than guessing at it. Only PAIRS crosses
 * the gameTypes.ts boundary, and a 4 typed out here by hand would be a second
 * source of truth free to drift away from the first.
 */
const GRID = Math.round(Math.sqrt(MEMORY_PAIRS * 2));

export function MemoryDuelBoard({
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
}: GameRendererProps<MemoryDuelState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  const gap = theme.spacing.sm;
  // A floor as well as a ceiling. Sixteen cards ARE the touch targets here, so
  // a board that shrank with the box until they were 30pt would fail the 44pt
  // rule; below this size the cards stop shrinking and the board keeps its
  // dignity instead.
  const smallest = MIN_TARGET * GRID + theme.spacing.sm * 2 + gap * (GRID - 1);
  const board = Math.max(smallest, Math.min(width, height - CHROME, MAX_BOARD));
  const card = (board - theme.spacing.sm * 2 - gap * (GRID - 1)) / GRID;

  // The cards showing at the start of THIS flip. Two face up is a settled
  // mismatch belonging to the turn that is over, so it counts as nothing - the
  // same rule the reducer applies, and the reason turning one of those two
  // cards straight back over is a legal move rather than a mistake.
  const liveTurn = state.revealed.length === 2 ? [] : state.revealed;
  const mismatched = state.revealed.length === 2;
  const found = (state.scores[0] ?? 0) + (state.scores[1] ?? 0);
  const myTurn = turn === local;

  /*
    One line, and it always says the most useful true thing.

    A dead board explains itself before anything else, and it has two reasons to
    be dead, which are answered in order. `disabledReason` comes first because
    it distinguishes a lost link from a finished game, which "Not your turn"
    would quietly get wrong. Then the turn: a mismatch is showing precisely
    BECAUSE a turn just ended, so the player who caused it is the most likely
    person on this board to be looking at sixteen cards they cannot touch. A
    mismatch line that did not also say whose move it is would leave them there.
  */
  const hint = !live
    ? disabledReason ?? playText.room.waitingForLink
    : !myTurn
    ? mismatched
      ? playText.memoryDuel.noMatchTheirs
      : playText.room.notYourTurn
    : mismatched
    ? playText.memoryDuel.noMatchYours
    : liveTurn.length === 1
    ? playText.memoryDuel.findItsPair
    : playText.memoryDuel.tapCard;

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={turn}
        nameFor={nameFor}
        scoreFor={(player) => state.scores[players.indexOf(player)] ?? 0}
      />

      <View style={{ height: theme.spacing.md }} />

      <Label variant="caption" tone="tertiary" align="center">
        {playText.memoryDuel.progress(found, MEMORY_PAIRS)}
      </Label>

      <View style={{ height: theme.spacing.sm }} />

      <BoardSurface size={board}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
          {state.cards.map((face, index) => {
            const owner = state.matchedBy[index] ?? 0;
            const holder = owner === 0 ? null : state.players[owner - 1] ?? null;
            const taken = owner !== 0;
            const faceUp = taken || state.revealed.includes(index);
            const row = Math.floor(index / GRID) + 1;
            const column = (index % GRID) + 1;
            // Courtesy only: the reducer decides. A card is left tappable
            // unless it plainly cannot be played - taken, already up as this
            // turn's first card, or the board is not yours to touch.
            const playable = live && myTurn && !taken && !liveTurn.includes(index);
            const symbol = playText.memoryDuel.symbols[face] ?? '';

            // What has happened to this card, in words. A screen reader gets
            // the same four states the eye does, and the third one has to say
            // that the card is going back down or it reads as a taken pair.
            const condition =
              holder !== null
                ? holder === local
                  ? playText.memoryDuel.takenByYou
                  : playText.memoryDuel.takenBy(nameFor(holder))
                : mismatched && faceUp
                ? playText.memoryDuel.goesBackDown
                : faceUp
                ? playText.memoryDuel.faceUp
                : playText.memoryDuel.faceDown;

            return (
              <Cell
                key={index}
                size={card}
                disabled={!playable}
                onPress={playable ? () => dispatch('flip', { cell: index }) : undefined}
                accessibilityLabel={`${playText.memoryDuel.card(row, column)}, ${
                  faceUp ? `${symbol}, ${condition}` : condition
                }`}
                accessibilityState={{ selected: faceUp }}
                style={{
                  borderRadius: theme.radius.md,
                  borderWidth: 2,
                  // A taken card is filled with its owner's ink and the symbol
                  // is knocked out of it, so who holds what is readable from
                  // across a table without counting anything.
                  backgroundColor: taken
                    ? inkFor(ink, holder, local)
                    : faceUp
                    ? theme.colors.background
                    : theme.colors.surfaceElevated,
                  borderColor: taken
                    ? inkFor(ink, holder, local)
                    : mismatched && faceUp
                    ? theme.colors.warning
                    : faceUp
                    ? inkFor(ink, turn, local)
                    : theme.colors.surfaceElevated,
                  // Dimmed rather than dashed: a dashed border draws solid on
                  // rounded corners on iOS, and half the point of this state is
                  // that it looks unlike every other card on the board.
                  opacity: mismatched && faceUp && !taken ? 0.55 : 1,
                }}
              >
                {faceUp ? (
                  <Animated.View entering={ZoomIn.duration(theme.motion.quick)}>
                    <FaceMark
                      face={face}
                      size={card * 0.52}
                      // Knocked out of the fill in the token that exists for
                      // being drawn on that fill: `onAccent` over the accent,
                      // and the page's own background over the neutral. The
                      // obvious `surface` reads correctly in the light scheme
                      // only because it happens to be white there, and it is
                      // also what the board itself is painted in - so a change
                      // to one colour would have quietly erased every symbol.
                      colour={
                        taken
                          ? holder === local
                            ? theme.colors.onAccent
                            : theme.colors.background
                          : theme.colors.text
                      }
                    />
                  </Animated.View>
                ) : (
                  <CardBack size={card * 0.34} colour={theme.colors.textTertiary} />
                )}
              </Cell>
            );
          })}
        </View>
      </BoardSurface>

      <Hint text={hint} tone={!live || mismatched ? 'secondary' : 'tertiary'} />
    </View>
  );
}

/**
 * The back of a card: a small ring, centred.
 *
 * Something rather than nothing, because sixteen empty rectangles read as a
 * board that has not loaded yet. Quiet, so it never competes with a face, but
 * the separator ink it started in was quieter than that: a hairline colour sat
 * on a raised surface is a shade off it in both schemes, so the ring drawn in
 * it was invisible and the backs were the empty rectangles again.
 */
function CardBack({ size, colour }: { size: number; colour: string }): React.JSX.Element {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: Math.max(2, size * 0.12),
        borderColor: colour,
      }}
    />
  );
}

/**
 * The eight faces, drawn in a 24x24 box like every other mark in the app.
 *
 * Shape carries the whole distinction - no two of these share a silhouette -
 * because a memory game that told its pairs apart by colour would be unplayable
 * for the people most likely to notice, and because the two inks in this app
 * are already spoken for by the two players.
 */
function FaceMark({ face, size, colour }: { face: number; size: number; colour: string }): React.JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {face === 0 ? <Circle cx={12} cy={12} r={8} fill={colour} /> : null}
      {face === 1 ? <Rect x={4} y={4} width={16} height={16} rx={2.5} fill={colour} /> : null}
      {face === 2 ? <Path d="M12 3.5 L21 19.5 L3 19.5 Z" fill={colour} /> : null}
      {face === 3 ? <Path d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z" fill={colour} /> : null}
      {face === 4 ? (
        <Path d="M9.5 3 H14.5 V9.5 H21 V14.5 H14.5 V21 H9.5 V14.5 H3 V9.5 H9.5 Z" fill={colour} />
      ) : null}
      {face === 5 ? (
        <Path
          d="M12 2.5 L14.9 8.9 L21.5 9.8 L16.7 14.5 L17.9 21.2 L12 18 L6.1 21.2 L7.3 14.5 L2.5 9.8 L9.1 8.9 Z"
          fill={colour}
        />
      ) : null}
      {face === 6 ? <Path d="M12 2.5 L20.5 7.25 V16.75 L12 21.5 L3.5 16.75 V7.25 Z" fill={colour} /> : null}
      {face === 7 ? <Circle cx={12} cy={12} r={7} stroke={colour} strokeWidth={4} fill="none" /> : null}
    </Svg>
  );
}
