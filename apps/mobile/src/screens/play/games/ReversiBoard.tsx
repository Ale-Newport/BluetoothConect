import React, { useMemo } from 'react';
import { View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { useTheme } from '../../../ui/index.js';
import { BoardSurface, Cell, Hint, PlayerBar, inkFor, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import { REVERSI_SIZE, reversiLegalMoves, type ReversiState } from '../gameTypes.js';

/**
 * Reversi.
 *
 * Two things make or break this board, and neither is the stones.
 *
 *   THE LEGAL MOVES. A Reversi move is legal precisely when it brackets
 *   something, which is invisible to anyone who has not played the game
 *   before - so the squares the local player may take are marked with a faint
 *   dot. They come from `reversiLegalMoves`, which is built on the same
 *   `capturesFor` that `validateAction` refuses a move with, so a dot and the
 *   reducer can never disagree about what is playable. Working them out here
 *   from the board would have been a second copy of the rules, and a second
 *   copy is a copy that goes wrong.
 *
 *   THE SKIP. A player with no capture is passed over silently by the reducer,
 *   which means the same person plays twice and the board appears to have
 *   stopped responding to the other phone. `state.skipped` says that happened,
 *   and this board says it out loud in the hint line. Without that sentence
 *   the commonest late-game position looks exactly like a dropped link.
 *
 * A flipped stone re-mounts and zooms rather than rotating: a true flip would
 * need eight rays animated in their capture order to read as anything other
 * than noise, and by then the turn has moved on. The pop is enough to draw the
 * eye to what changed.
 */

/** Comfortable on a large phone, and the point past which stones just look big. */
const MAX_BOARD = 360;

/**
 * Vertical space the player bar, its gap and the hint line take.
 *
 * Reserved rather than measured on purpose. Measuring would draw the board once
 * at the wrong size and then snap it, and a grid that resizes under a finger
 * already on its way to a square is worse than a grid a few points smaller than
 * it could have been. The figure is deliberately a little generous, because the
 * three lines it stands for all grow with the system type size.
 */
const CHROME_HEIGHT = 116;

/**
 * The smallest square this will draw.
 *
 * The floor belongs on the SQUARE and not on the box. A floor on the box reads
 * as a kindness - "never draw a board smaller than this" - but the room does
 * not scroll, so a board that refuses to fit the box it was given does not get
 * a bigger box, it gets a result card pushed off the bottom of a screen with no
 * way to reach it. Shrinking is the rule here; overflowing the box the room
 * measured is never an option. One point is simply the smallest positive number
 * of them, which is all this guard is for.
 */
const SMALLEST_SQUARE = 1;

export function ReversiBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  turn,
  lastAction,
  live,
  disabledReason,
  width,
  height,
}: GameRendererProps<ReversiState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  const myTurn = turn === local;

  // Sized from BOTH numbers, so the board cannot run off the bottom of a short
  // box and force the scene to scroll.
  const box = Math.min(width, height - CHROME_HEIGHT, MAX_BOARD);
  const gap = theme.spacing.xs;
  // The square is floored to whole points and the surface sized back up from
  // it, rather than the other way round. Eight fractional widths and seven gaps
  // can total a hair more than the row they sit in, and a row one ten-thousandth
  // of a point too wide wraps its last column onto a ninth line.
  const square = Math.max(
    SMALLEST_SQUARE,
    Math.floor((box - theme.spacing.sm * 2 - gap * (REVERSI_SIZE - 1)) / REVERSI_SIZE),
  );
  const board = square * REVERSI_SIZE + gap * (REVERSI_SIZE - 1) + theme.spacing.sm * 2;

  /**
   * Where this device may play, right now.
   *
   * Empty when it is not our turn: the moves a player holds while waiting are
   * real, but tapping one would be refused, and a dot that does nothing is a
   * worse lie than no dot at all.
   */
  const playable = useMemo(
    () => (myTurn && live ? new Set(reversiLegalMoves(state, local)) : new Set<number>()),
    [live, local, myTurn, state],
  );

  const lastCell = useMemo(() => {
    const payload = lastAction?.payload as { cell?: unknown } | null | undefined;
    return typeof payload?.cell === 'number' ? payload.cell : null;
  }, [lastAction]);

  // The player who was passed over is the one NOT to move - the reducer leaves
  // the turn with whoever just played when their opponent has no capture. With
  // nobody to move there is no "other one" to name, so no skip is claimed: that
  // is a finished game, and `disabledReason` has the only true thing to say.
  const skippedPlayer =
    state.skipped && turn !== null ? players.find((player) => player !== turn) ?? null : null;
  const opponent = players.find((player) => player !== local) ?? null;
  // May be empty - a peer that has not sent a profile yet has no name to use.
  // The two lines below are written to survive that; see strings.ts.
  const opponentName = opponent === null ? '' : nameFor(opponent);

  const hint = !live
    ? disabledReason
    : skippedPlayer === null
    ? myTurn
      ? playText.reversi.tapDot
      : playText.room.notYourTurn
    : skippedPlayer === local
    ? playText.reversi.youHadNoMove(opponentName)
    : playText.reversi.theyHadNoMove(opponentName);

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={turn}
        nameFor={nameFor}
        // Indexed by `state.players` rather than by the seat list beside it:
        // `scores` is counted in the reducer's own player order, and taking the
        // index from anywhere else is a coincidence rather than a rule.
        scoreFor={(player) => state.scores[state.players.indexOf(player)] ?? 0}
      />

      <View style={{ height: theme.spacing.lg }} />

      <BoardSurface size={board}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
          {state.board.map((mark, index) => {
            const owner = mark === 0 ? null : state.players[mark - 1] ?? null;
            const row = Math.floor(index / REVERSI_SIZE) + 1;
            const column = (index % REVERSI_SIZE) + 1;
            const open = playable.has(index);

            return (
              <Cell
                key={index}
                size={square}
                disabled={!open}
                onPress={open ? () => dispatch('play', { cell: index }) : undefined}
                accessibilityState={{ disabled: !open }}
                accessibilityLabel={[
                  playText.reversi.square(row, column),
                  // "You" rather than your own name, the same way the player
                  // bar says it. `nameFor(local)` is the profile's display
                  // name, which is not what a person calls themselves - and is
                  // empty until a profile exists, which would leave sixty-four
                  // squares announcing their coordinates and then nothing.
                  owner === null
                    ? playText.reversi.empty
                    : owner === local
                    ? playText.reversi.yourStone
                    : playText.reversi.stoneOf(nameFor(owner)),
                  open ? playText.reversi.playable : null,
                  index === lastCell ? playText.reversi.lastMove : null,
                ]
                  .filter((part): part is string => part !== null)
                  .join(', ')}
                style={{
                  backgroundColor: theme.colors.surfaceElevated,
                  borderRadius: theme.radius.sm,
                }}
              >
                {mark === 0 ? (
                  open ? (
                    <View
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                      style={{
                        width: square * 0.26,
                        height: square * 0.26,
                        borderRadius: square * 0.13,
                        backgroundColor: ink.mine,
                        // Faint on purpose: an invitation sitting under the
                        // stones, not a stone of its own.
                        opacity: 0.4,
                      }}
                    />
                  ) : null
                ) : (
                  <Animated.View
                    // Keyed by the mark as well as the square, so a stone that
                    // changes hands re-mounts and plays the entrance again.
                    key={`${index}-${mark}`}
                    entering={ZoomIn.duration(theme.motion.quick)}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={{
                      width: square * 0.78,
                      height: square * 0.78,
                      borderRadius: square * 0.39,
                      backgroundColor: inkFor(ink, owner, local),
                    }}
                  >
                    {index === lastCell ? (
                      // "What did they just play?" is the first question on
                      // coming back to a board, and on a board where a single
                      // move recolours a dozen stones it is the hardest one to
                      // answer by eye. A ring inside the newest stone answers it.
                      <View
                        style={{
                          position: 'absolute',
                          top: square * 0.22,
                          left: square * 0.22,
                          width: square * 0.34,
                          height: square * 0.34,
                          borderRadius: square * 0.17,
                          borderWidth: Math.max(1, square * 0.05),
                          borderColor: theme.colors.background,
                        }}
                      />
                    ) : null}
                  </Animated.View>
                )}
              </Cell>
            );
          })}
        </View>
      </BoardSurface>

      {hint === null ? null : <Hint text={hint} />}
    </View>
  );
}
