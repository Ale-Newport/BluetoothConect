import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Label, useTheme } from '../../../ui/index.js';
import { BoardSurface, Cell, Hint, PlayerBar, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import type { SlidingPuzzleState } from '../gameTypes.js';

/**
 * Sliding Puzzle Race.
 *
 * Two identical fifteen-puzzles live in the one state, one per player, and
 * nobody is ever "to move" - the rules' `currentTurn` returns null for this
 * game - so no tile is ever disabled for being out of turn and the player bar
 * is handed a null turn rather than the prop. The only thing that closes the
 * board is `live` going false, which happens when the link drops OR when
 * somebody has finished. `disabledReason` says which, and it is the only thing
 * allowed to say it.
 *
 * The opponent's board is drawn small, above, and untouchable. It is the whole
 * drama of the game: you cannot affect it, you can only watch it fill up while
 * you work. Drawing it as unnumbered blocks rather than shrunken tiles is
 * deliberate - at a third of the size the numbers would be unreadable, and what
 * you actually want to read from across the table is how much of their puzzle
 * is home, which the blocks say at a glance.
 *
 * Tapping a tile that cannot move is not caught here. Adjacency is a rule, the
 * reducer owns the rules, and a second copy of them in a renderer is a second
 * copy to get wrong - so every tile dispatches and a refused slide shakes the
 * board back. The hint under the board teaches the rule instead of the code
 * enforcing it twice.
 */

/**
 * The shape of the puzzle, restated.
 *
 * `gameTypes.ts` re-exports the state type for this game and no constants, so
 * the four numbers needed to lay squares out are written here. They are
 * geometry rather than rules - how many squares to draw, and which value means
 * "no tile" - and nothing below them decides whether a slide is legal or who
 * has won, so this copy cannot quietly become a second rulebook.
 */
const GRID = 4;
const CELL_COUNT = GRID * GRID;
const TILES = CELL_COUNT - 1;
const GAP_TILE = 0;

const MAX_BOARD = 340;
/** The opponent's board, at its largest. Big enough to count blocks in, no more. */
const MINI_MAX = 96;
/** How much of a short screen the opponent's board may take before it shrinks. */
const MINI_SHARE = 0.16;
/**
 * The two lines of type beside the opponent's board.
 *
 * A footnote over a caption, which on a short box is TALLER than the little
 * board they annotate - so the row costs the greater of the two, and budgeting
 * only the board would hand the puzzle a few points that the labels have
 * already spent.
 */
const MINI_LABEL_HEIGHT = 34;

/**
 * The heights of the chrome above and below the board, from boardKit.
 *
 * Measured once rather than laid out and re-measured: the board has to be the
 * right size on its first frame, not after a layout pass, or it appears at one
 * size and snaps to another. Both numbers round up, so the cost of being wrong
 * is a few points of board rather than a scene that overflows.
 */
const PLAYER_BAR_HEIGHT = 60;
const HINT_HEIGHT = 30;

/**
 * The smallest square this will draw.
 *
 * Not a minimum size anyone would want to play on. The room does not scroll, so
 * a board that refused to fit the box it was handed would push the result card
 * off the bottom of the screen instead of getting a bigger box - shrinking is
 * the rule. This floor exists only to keep the arithmetic positive: the ended
 * game hands the board a little over half the height it had, and a box smaller
 * than its own chrome would otherwise feed a negative width to every tile.
 */
const SMALLEST_SQUARE = 1;

/** A slide, in milliseconds. Long enough to follow the tile, short enough to spam. */
const SLIDE_MS = 110;
/** How far a refused slide throws the board. */
const SHAKE_POINTS = 7;
const SHAKE_MS = 45;

export function SlidingPuzzleBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  live,
  disabledReason,
  width,
  height,
}: GameRendererProps<SlidingPuzzleState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  // Boards are indexed by seat in `state.players`, which is the game's own
  // ordering; the `players` prop is the room's. They agree today, and reading
  // the seat out of the state means they do not have to.
  const seat = Math.max(0, state.players.indexOf(local));
  const theirSeat = seat === 0 ? 1 : 0;
  const myBoard = state.boards[seat] ?? [];
  const theirBoard = state.boards[theirSeat] ?? [];
  const theirPlayer = state.players[theirSeat] ?? null;
  const theirName = theirPlayer === null ? '' : nameFor(theirPlayer);

  const mini = Math.round(Math.min(MINI_MAX, height * MINI_SHARE));
  const miniRow = Math.max(mini, MINI_LABEL_HEIGHT);
  const chrome = PLAYER_BAR_HEIGHT + theme.spacing.lg + miniRow + theme.spacing.lg + HINT_HEIGHT;
  // Sized from BOTH numbers, so a short screen gets a small board instead of a
  // board that runs off the bottom and makes the scene scroll.
  const box = Math.min(width, height - chrome, MAX_BOARD);

  // The squares are floored and the surface sized back up from them, rather
  // than the surface being floored and divided: it is the square that has to
  // stay a positive number of points, because it is the square that becomes a
  // view's width.
  const step = Math.max(SMALLEST_SQUARE, (box - theme.spacing.sm * 2) / GRID);
  const inner = step * GRID;
  const board = inner + theme.spacing.sm * 2;
  const tileGap = theme.spacing.xs;
  // The drawn face is inset inside its square. The SQUARE is what accepts the
  // touch, so the gutter between two tiles belongs to one of them rather than
  // to nobody - a four-point dead stripe between every pair of tiles is a
  // miss on a board people jab at quickly.
  const face = Math.max(SMALLEST_SQUARE, step - tileGap);

  // A refused slide travels through this rather than through a message: the
  // board already shows where the gap is, so being pushed back is the whole
  // explanation. `Cell` has buzzed on the press, so there is no second haptic.
  const shake = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  const slide = (moved: number): void => {
    if (dispatch('slide', { tile: moved })) return;
    shake.value = withSequence(
      withTiming(-SHAKE_POINTS, { duration: SHAKE_MS }),
      withTiming(SHAKE_POINTS, { duration: SHAKE_MS }),
      withTiming(0, { duration: SHAKE_MS }),
    );
  };

  return (
    <View>
      {/* Nobody is ever to move in a race, so the bar carries move counts
          instead of a turn dot. Fewer moves is the better run, which is why
          they are a caption and not the score slot's big number. */}
      <PlayerBar
        players={players}
        local={local}
        turn={null}
        nameFor={nameFor}
        captionFor={(player) => {
          const index = state.players.indexOf(player);
          const theirs = state.boards[index] ?? [];
          return homeCount(theirs) === TILES
            ? playText.slidingPuzzle.solved
            : playText.slidingPuzzle.moves(state.moves[index] ?? 0);
        }}
      />

      <View style={{ height: theme.spacing.lg }} />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
        <MiniBoard board={theirBoard} size={mini} colour={ink.theirs} name={theirName} />
        <View style={{ flex: 1 }}>
          <Label variant="footnote" numberOfLines={1}>
            {playText.slidingPuzzle.theirPuzzle(theirName)}
          </Label>
          <Label variant="caption" tone="tertiary" numberOfLines={1}>
            {playText.slidingPuzzle.inPlace(homeCount(theirBoard), TILES)}
          </Label>
        </View>
      </View>

      <View style={{ height: theme.spacing.lg }} />

      <Animated.View style={shakeStyle}>
        <BoardSurface size={board}>
          <View style={{ width: inner, height: inner }}>
            {myBoard.map((value, index) => {
              const row = Math.floor(index / GRID);
              const column = index - row * GRID;
              if (value === GAP_TILE) {
                // The gap is drawn as nothing, and nothing is exactly what a
                // screen reader finds there: fifteen buttons and a hole where
                // the one square that matters ought to be. So the hole says
                // where it is, and it is announced in board order because the
                // tiles around it are laid out in that order too.
                return (
                  <View
                    key="gap"
                    accessible
                    accessibilityLabel={playText.slidingPuzzle.gap(row + 1, column + 1)}
                    style={{ position: 'absolute', left: column * step, top: row * step, width: step, height: step }}
                  />
                );
              }
              return (
                // Keyed by the tile rather than the square, so React moves the
                // same view when a tile slides instead of swapping two views
                // and animating neither.
                <Tile
                  key={value}
                  tile={value}
                  x={column * step}
                  y={row * step}
                  square={step}
                  face={face}
                  home={isHome(myBoard, index)}
                  disabled={!live}
                  onPress={() => slide(value)}
                  accessibilityLabel={playText.slidingPuzzle.tile(value, row + 1, column + 1)}
                />
              );
            })}
          </View>
        </BoardSurface>
      </Animated.View>

      {/* `disabledReason` is null exactly when the board is playable, so this
          one line is both the instruction and the explanation for every dead
          tile above it - and it never has to guess which of the two reasons
          for a dead board is the true one. */}
      <Hint text={disabledReason ?? playText.slidingPuzzle.tapHint} />
    </View>
  );
}

/**
 * One numbered tile.
 *
 * Its own component because the slide is a hook: a tile has to animate from
 * wherever it was to wherever it now is, and a hook cannot live inside the map
 * that draws the other fourteen.
 *
 * The pressable is the whole `square` and the coloured `face` is a child of it,
 * so the target is as big as the geometry allows and any hit slop boardKit adds
 * on a small board falls inside the wrapper rather than outside it, where
 * Android drops it.
 */
function Tile({
  tile,
  x,
  y,
  square,
  face,
  home,
  disabled,
  onPress,
  accessibilityLabel,
}: {
  tile: number;
  x: number;
  y: number;
  square: number;
  face: number;
  home: boolean;
  disabled: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}): React.JSX.Element {
  const theme = useTheme();

  // Seeded at the tile's current square rather than at the origin, or every
  // tile would fly in from the top-left corner on the very first frame.
  const left = useSharedValue(x);
  const top = useSharedValue(y);

  useEffect(() => {
    left.value = withTiming(x, { duration: SLIDE_MS });
    top.value = withTiming(y, { duration: SLIDE_MS });
  }, [left, top, x, y]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: left.value }, { translateY: top.value }],
  }));

  return (
    <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: square, height: square }, style]}>
      <Cell
        size={square}
        disabled={disabled}
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled, selected: home }}
      >
        <View
          style={{
            width: face,
            height: face,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radius.md,
            backgroundColor: home ? theme.colors.accentMuted : theme.colors.surfaceElevated,
          }}
        >
          <Label variant={numberVariant(face)} tone={home ? 'accent' : 'primary'} numberOfLines={1}>
            {tile}
          </Label>
        </View>
      </Cell>
    </Animated.View>
  );
}

/**
 * The largest type a two-digit number still fits a tile in.
 *
 * A board is not always a board someone is playing on: a finished game keeps
 * its puzzle on screen at about half the height, which is a thumbnail, and a
 * seventeen-point "14" in a fifteen-point square spills over the tile below it.
 * Stepping the type down with the square keeps the number inside its own tile
 * all the way to the bottom.
 */
function numberVariant(face: number): 'title2' | 'headline' | 'footnote' | 'caption' {
  if (face >= 56) return 'title2';
  if (face >= 34) return 'headline';
  if (face >= 26) return 'footnote';
  return 'caption';
}

/**
 * The opponent's puzzle: sixteen blocks, no numbers, nothing to press.
 *
 * A tile that is home is solid and one that is not is faint, so the board reads
 * as a bar chart of how close they are without anyone having to count.
 */
function MiniBoard({
  board,
  size,
  colour,
  name,
}: {
  board: readonly number[];
  size: number;
  colour: string;
  name: string;
}): React.JSX.Element {
  const theme = useTheme();
  const step = size / GRID;

  return (
    <View
      accessible
      accessibilityLabel={playText.slidingPuzzle.theirBoard(name, homeCount(board), TILES)}
      style={{
        width: size,
        height: size,
        flexDirection: 'row',
        flexWrap: 'wrap',
        borderRadius: theme.radius.sm,
        backgroundColor: theme.colors.surface,
      }}
    >
      {Array.from({ length: CELL_COUNT }, (_unused, index) => {
        const value = board[index] ?? GAP_TILE;
        return (
          <View key={index} style={{ width: step, height: step, padding: 1 }}>
            {value === GAP_TILE ? null : (
              <View
                style={{
                  flex: 1,
                  borderRadius: 2,
                  backgroundColor: colour,
                  opacity: isHome(board, index) ? 1 : 0.25,
                }}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

/**
 * Whether the square at `index` holds what the solved board holds.
 *
 * Presentation only. The reducer decides who has actually finished; this just
 * decides which blocks are drawn solid, and being wrong would tint a tile, not
 * award a race.
 */
function isHome(board: readonly number[], index: number): boolean {
  const value = board[index] ?? GAP_TILE;
  return index === TILES ? value === GAP_TILE : value === index + 1;
}

/** How many of the fifteen tiles are where they belong. */
function homeCount(board: readonly number[]): number {
  let count = 0;
  for (let index = 0; index < TILES; index++) {
    if (isHome(board, index)) count += 1;
  }
  return count;
}
