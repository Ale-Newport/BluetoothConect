import React, { useMemo, useRef } from 'react';
import { Pressable, View, type GestureResponderEvent } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { haptic, useTheme } from '../../../ui/index.js';
import { BoardSurface, Hint, MIN_TARGET, PlayerBar, inkFor, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import { DAB_BOXES, DAB_DOTS, DabOrientation, type DotsAndBoxesState } from '../gameTypes.js';

/**
 * Dots and Boxes.
 *
 * Six rows of six dots, twenty-five boxes between them, and sixty lines to
 * draw. Three things decide whether this board is any good.
 *
 *   THE INDEXING. The rules file keeps horizontal and vertical lines in two
 *   arrays with DIFFERENT strides - h[r * 5 + c] joins two dots in a row, and
 *   v[r * 6 + c] joins two dots in a column - so a renderer that reuses one
 *   stride for both draws every vertical line one column out of place and only
 *   notices near the right-hand edge. The two families are therefore built and
 *   named separately here, and nothing in this file indexes an edge without
 *   saying which family it belongs to.
 *
 *   THE TARGET. A line is a thin thing, so each one gets a transparent
 *   rectangle at least 44pt in BOTH directions - much wider than the line it
 *   stands for. Those rectangles necessarily overlap near the dots: two
 *   perpendicular 44pt targets whose centres are only 0.7 of a gap apart cannot
 *   avoid each other unless the dots are 88pt apart, which is a board wider than
 *   a phone. Overlap resolved by stacking order gets the ends of every line
 *   wrong - press near the left end of a horizontal line and a vertical one is
 *   drawn instead - so the stack is not what decides it. Whichever rectangle
 *   receives the touch converts it to board coordinates and picks the NEAREST
 *   line of either family, which means every rectangle answers a given point
 *   identically and the line you get is always the line you were closest to.
 *   A press with no coordinates - a screen reader activating a button - falls
 *   back to that button's own line, which is exactly what it asked for.
 *
 *   THE EXTRA GO. Closing a box scores it and the same player draws again.
 *   That single rule is the whole game, and a player who misses it reads the
 *   unchanged turn indicator as a stuck screen, so it is said twice: as a
 *   caption on the player who keeps the move, and as a sentence under the
 *   board naming who closed what.
 *
 * Whether a line may be drawn is never decided here. The board disables lines
 * that are already down and, when it is not this device's turn, all of them -
 * courtesies, not rules - and everything else is asked of the reducer.
 */

/** Past this the dots are just far apart, and the board stops looking like one. */
const MAX_BOARD = 360;

/**
 * Vertical space the player bar, its gap and the hint line take.
 *
 * Reserved rather than measured, for the same reason the other boards reserve
 * it: measuring draws the grid once at the wrong size and then snaps it, and a
 * board that moves under a finger already on its way to a line is worse than a
 * board a few points smaller than it could have been.
 */
const CHROME_HEIGHT = 124;

/**
 * Clear space kept round the outside of the grid.
 *
 * Half a touch target, because the targets on the rim are centred on the outer
 * dots and reach exactly that far past them. Any less and the surface, which
 * clips its children, would cut the top and left lines' targets in half.
 */
const RIM = MIN_TARGET / 2;

/** See the rules file: six rows of five gaps, and five rows of six gaps. */
const H_COUNT = DAB_DOTS * DAB_BOXES;
const V_COUNT = DAB_BOXES * DAB_DOTS;

interface Edge {
  readonly orientation: DabOrientation;
  readonly index: number;
}

/** A line's transparent hit rectangle, in board coordinates. */
interface EdgeTarget extends Edge {
  readonly key: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** How a person hears it: the side of a box, which is how they think of it. */
  readonly name: string;
}

export function DotsAndBoxesBoard({
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
}: GameRendererProps<DotsAndBoxesState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  const myTurn = turn === local;

  // Sized from BOTH numbers, so a short box shrinks the grid instead of pushing
  // it off the bottom of a scene that has nowhere to scroll to. The floor only
  // keeps the arithmetic positive on a box too small to play in at all.
  const board = Math.max(MIN_TARGET * 2, Math.min(width, height - CHROME_HEIGHT, MAX_BOARD));
  const pitch = (board - RIM * 2) / DAB_BOXES;

  const targets = useMemo(() => buildTargets(pitch), [pitch]);

  /**
   * The line the finger that is currently down actually means.
   *
   * A ref rather than state: it is read once, in the press that follows, and
   * re-rendering sixty targets to remember a number nobody draws would be
   * work for nothing.
   *
   * It is stamped with the button it was resolved on AND with the touch that
   * resolved it, because a gesture that is terminated never reaches `onPress`
   * and so leaves its entry behind. The button alone is not enough to make that
   * leftover harmless: the press that spends it can be an activation with no
   * coordinates of its own - a screen reader's - on that very button, and it
   * would then draw whatever line an abandoned finger happened to be nearest
   * to instead of the line the label named. A touch a person has already lifted
   * cannot match the one doing the spending, so the leftover is ignored and the
   * fallback below gives that button its own line, which is what was asked for.
   */
  const aim = useRef<{ readonly from: string; readonly touch: number; readonly edge: Edge } | null>(
    null,
  );

  const lastEdge = useMemo(() => edgeOf(lastAction?.payload), [lastAction]);
  const lastPlayer = lastAction?.player ?? null;

  /**
   * Who closed a box with the move just played, or null.
   *
   * It is whoever is to move, precisely because closing a box does NOT pass the
   * turn - that is the rule this line depends on, and reading the mover out of
   * `lastAction` instead would say the same thing less reliably.
   */
  const claimer = state.lastClaimed.length > 0 ? turn : null;

  const hint = !live
    ? disabledReason
    : claimer === local
    ? playText.dotsAndBoxes.goAgainYou
    : claimer !== null
    ? playText.dotsAndBoxes.goAgainThem(nameFor(claimer))
    : // Every line on this board is disabled while the other phone is thinking,
      // and a board of sixty dead controls has to say why before it says
      // anything else. Teaching the rule to somebody who cannot move yet leaves
      // them looking at a grid that refuses every tap and no sentence that
      // accounts for it.
      !myTurn
    ? playText.room.notYourTurn
    : // The rule that decides the game, said once before anybody has had the
      // chance to be surprised by it.
      state.drawn === 0
    ? playText.dotsAndBoxes.rule
    : playText.dotsAndBoxes.tapLine;

  const drawnLine = Math.max(3, pitch * 0.09);
  const faintLine = Math.max(2, pitch * 0.045);
  const dot = Math.max(4, pitch * 0.1);

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={turn}
        nameFor={nameFor}
        // Indexed by `state.players` rather than by the seat list beside it:
        // the reducer credits a box to whoever `state.turnIndex` points at, so
        // `scores` is counted in the reducer's own player order. That the two
        // lists happen to agree today is a coincidence, not a rule.
        scoreFor={(player) => state.scores[state.players.indexOf(player)] ?? 0}
        captionFor={(player) => (player === claimer ? playText.dotsAndBoxes.anotherGo : null)}
      />

      <View style={{ height: theme.spacing.lg }} />

      <BoardSurface size={board} padded={false}>
        <View style={{ width: board, height: board }}>
          {/* Claimed boxes, underneath everything: the lines are the board's
              structure and must stay legible on top of a filled box. */}
          {state.boxes.map((mark, box) => {
            const owner = mark === 0 ? null : state.players[mark - 1] ?? null;
            const row = Math.floor(box / DAB_BOXES);
            const column = box - row * DAB_BOXES;
            return (
              <View
                key={box}
                // A blind player can hear the score from the bar, but not which
                // half of the board it came from. Claimed boxes are readable for
                // that reason; unclaimed ones stay silent, because twenty-five
                // more "empty" nodes between the sixty lines would bury them.
                accessible={mark !== 0}
                accessibilityLabel={
                  owner === null
                    ? undefined
                    : playText.dotsAndBoxes.boxWon(row + 1, column + 1, nameFor(owner))
                }
                style={{
                  position: 'absolute',
                  left: RIM + column * pitch,
                  top: RIM + row * pitch,
                  width: pitch,
                  height: pitch,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {mark === 0 ? null : (
                  <Animated.View
                    // Keyed by the owner as well as the box, so the fill mounts
                    // - and therefore pops - at the moment it is won.
                    key={`${box}-${mark}`}
                    entering={ZoomIn.duration(theme.motion.quick)}
                    style={{
                      position: 'absolute',
                      left: drawnLine,
                      top: drawnLine,
                      right: drawnLine,
                      bottom: drawnLine,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <View
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                        borderRadius: theme.radius.sm,
                        backgroundColor: inkFor(ink, owner, local),
                        // A wash, not a block: the box says whose it is without
                        // shouting down the lines that closed it.
                        opacity: 0.16,
                      }}
                    />
                    {/* Colour alone would leave a colour-blind player counting
                        boxes by the scoreboard, so the seats also differ in
                        shape: the first plays a disc, the second a ring. */}
                    <View
                      style={{
                        width: pitch * 0.3,
                        height: pitch * 0.3,
                        borderRadius: pitch * 0.15,
                        backgroundColor: mark === 1 ? inkFor(ink, owner, local) : 'transparent',
                        borderWidth: mark === 1 ? 0 : Math.max(2, pitch * 0.06),
                        borderColor: inkFor(ink, owner, local),
                      }}
                    />
                  </Animated.View>
                )}
              </View>
            );
          })}

          {/* The lines, each inside the target that draws it. */}
          {targets.map((target) => {
            const edges = target.orientation === DabOrientation.HORIZONTAL ? state.h : state.v;
            const down = edges[target.index] === true;
            const isLast =
              lastEdge !== null &&
              lastEdge.orientation === target.orientation &&
              lastEdge.index === target.index;
            const playable = live && myTurn && !down;
            const thickness = down ? (isLast ? drawnLine + 1 : drawnLine) : faintLine;
            const horizontal = target.orientation === DabOrientation.HORIZONTAL;

            return (
              <Pressable
                key={target.key}
                accessibilityRole="button"
                accessibilityLabel={[
                  target.name,
                  down ? playText.dotsAndBoxes.drawnLine : playText.dotsAndBoxes.openLine,
                  isLast && lastPlayer !== null ? playText.dotsAndBoxes.justPlayed(nameFor(lastPlayer)) : null,
                ]
                  .filter((part): part is string => part !== null)
                  .join(', ')}
                accessibilityState={{ disabled: !playable }}
                disabled={!playable}
                // Once a rectangle has the touch it keeps it. Nothing above this
                // board scrolls today, so there is nobody to hand it to - but a
                // press that resolves to the nearest line has to live long
                // enough to be released, and an ancestor that quietly took it
                // half way would be indistinguishable from a phone that ignored
                // the tap. A gesture the system takes by force is still taken,
                // and Pressable abandons it rather than pressing: no line is
                // drawn, which is the right answer to a finger interrupted.
                cancelable={false}
                onPressIn={(event: GestureResponderEvent) => {
                  const { locationX: x, locationY: y, identifier } = event.nativeEvent;
                  aim.current = Number.isFinite(x) && Number.isFinite(y)
                    ? {
                        from: target.key,
                        touch: identifier,
                        edge: nearestEdge(target.left + x - RIM, target.top + y - RIM, pitch),
                      }
                    : null;
                }}
                onPress={(event: GestureResponderEvent) => {
                  const aimed = aim.current;
                  aim.current = null;
                  const edge =
                    aimed !== null &&
                    aimed.from === target.key &&
                    aimed.touch === event.nativeEvent.identifier
                      ? aimed.edge
                      : target;
                  // The tick follows the move, not the finger. A rectangle is
                  // wider than the gap it stands in, so a press can perfectly
                  // reasonably resolve to a line that is already down - and a
                  // confirming tap for a move the reducer refused is the board
                  // telling the player something happened when nothing did.
                  if (dispatch('draw', { orientation: edge.orientation, index: edge.index })) {
                    haptic('selection');
                  }
                }}
                // No pressed state, unlike every other board here. A rectangle
                // frequently resolves to its neighbour's line, so dimming the
                // one under the finger would point at the wrong line for as
                // long as the finger was down. The selection tap and the line
                // itself appearing are the feedback instead.
                style={{
                  position: 'absolute',
                  left: target.left,
                  top: target.top,
                  width: target.width,
                  height: target.height,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={{
                    width: horizontal ? pitch : thickness,
                    height: horizontal ? thickness : pitch,
                    borderRadius: thickness / 2,
                    backgroundColor: down
                      ? isLast && lastPlayer !== null
                        ? inkFor(ink, lastPlayer, local)
                        : theme.colors.textSecondary
                      : ink.rule,
                    // An undrawn line is a suggestion of where one could go. Any
                    // stronger and sixty of them read as a finished board.
                    opacity: down ? 1 : 0.5,
                  }}
                />
              </Pressable>
            );
          })}

          {/* The dots, on top so a line never swallows one, and transparent to
              touch so they never take a press meant for a line. */}
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
          >
            {Array.from({ length: DAB_DOTS * DAB_DOTS }, (_unused, index) => {
              const row = Math.floor(index / DAB_DOTS);
              const column = index - row * DAB_DOTS;
              return (
                <View
                  key={index}
                  style={{
                    position: 'absolute',
                    left: RIM + column * pitch - dot / 2,
                    top: RIM + row * pitch - dot / 2,
                    width: dot,
                    height: dot,
                    borderRadius: dot / 2,
                    backgroundColor: theme.colors.textTertiary,
                  }}
                />
              );
            })}
          </View>
        </View>
      </BoardSurface>

      {/* The extra go is the one sentence a player must not miss, so it is the
          one the hint line raises its voice for. */}
      {hint === null ? null : <Hint text={hint} tone={claimer === null ? 'tertiary' : 'secondary'} />}
    </View>
  );
}

/**
 * Every line's hit rectangle, laid out once per board size.
 *
 * The rectangles are at least MIN_TARGET in both directions even when the gap
 * between two dots is smaller than that - on a cramped box it is - which is
 * only safe because `nearestEdge` decides what a press means. Growing a target
 * past its own gap would otherwise steal presses from the line next door.
 */
function buildTargets(pitch: number): readonly EdgeTarget[] {
  const long = Math.max(pitch, MIN_TARGET);
  const targets: EdgeTarget[] = [];

  for (let index = 0; index < H_COUNT; index++) {
    const row = Math.floor(index / DAB_BOXES);
    const column = index - row * DAB_BOXES;
    targets.push({
      orientation: DabOrientation.HORIZONTAL,
      index,
      key: `h${index}`,
      left: RIM + (column + 0.5) * pitch - long / 2,
      top: RIM + row * pitch - MIN_TARGET / 2,
      width: long,
      height: MIN_TARGET,
      name:
        row < DAB_BOXES
          ? playText.dotsAndBoxes.topOf(row + 1, column + 1)
          : playText.dotsAndBoxes.bottomOf(DAB_BOXES, column + 1),
    });
  }

  for (let index = 0; index < V_COUNT; index++) {
    // The stride is six here and five above. That difference is the whole of
    // the indexing scheme, and getting it wrong draws lines a column out.
    const row = Math.floor(index / DAB_DOTS);
    const column = index - row * DAB_DOTS;
    targets.push({
      orientation: DabOrientation.VERTICAL,
      index,
      key: `v${index}`,
      left: RIM + column * pitch - MIN_TARGET / 2,
      top: RIM + (row + 0.5) * pitch - long / 2,
      width: MIN_TARGET,
      height: long,
      name:
        column < DAB_BOXES
          ? playText.dotsAndBoxes.leftOf(row + 1, column + 1)
          : playText.dotsAndBoxes.rightOf(row + 1, DAB_BOXES),
    });
  }

  return targets;
}

/**
 * The line a press at (x, y) means, measured from the top-left dot.
 *
 * One candidate is taken from each family - the nearest horizontal and the
 * nearest vertical - and the closer of the two wins. Ties go to the horizontal
 * one, which happens only on the exact diagonal through a dot and where the two
 * answers are equally defensible.
 *
 * An already-drawn line is a perfectly good answer and is returned like any
 * other: it is what the finger was nearest to, and the reducer refusing it
 * leaves the board alone. Skipping over drawn lines would quietly draw a
 * different line from the one the player aimed at, which is far worse than a
 * press that does nothing.
 */
function nearestEdge(x: number, y: number, pitch: number): Edge {
  const column = clamp(Math.floor(x / pitch), 0, DAB_BOXES - 1);
  const row = clamp(Math.floor(y / pitch), 0, DAB_BOXES - 1);
  const dotRow = clamp(Math.round(y / pitch), 0, DAB_BOXES);
  const dotColumn = clamp(Math.round(x / pitch), 0, DAB_BOXES);

  const hx = x - (column + 0.5) * pitch;
  const hy = y - dotRow * pitch;
  const vx = x - dotColumn * pitch;
  const vy = y - (row + 0.5) * pitch;

  if (hx * hx + hy * hy <= vx * vx + vy * vy) {
    return { orientation: DabOrientation.HORIZONTAL, index: dotRow * DAB_BOXES + column };
  }
  return { orientation: DabOrientation.VERTICAL, index: row * DAB_DOTS + dotColumn };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * The line in the move that was just played.
 *
 * `lastAction` is the generic envelope, so its payload arrives as an opaque
 * CBOR value and is checked here rather than asserted: a peer several versions
 * away can send anything, and the only cost of it being nonsense is that no
 * line is marked as the newest one.
 */
function edgeOf(payload: unknown): Edge | null {
  const move = payload as { orientation?: unknown; index?: unknown } | null | undefined;
  const orientation = move?.orientation;
  const index = move?.index;
  if (orientation !== DabOrientation.HORIZONTAL && orientation !== DabOrientation.VERTICAL) return null;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  if (index >= (orientation === DabOrientation.HORIZONTAL ? H_COUNT : V_COUNT)) return null;
  return { orientation, index };
}
