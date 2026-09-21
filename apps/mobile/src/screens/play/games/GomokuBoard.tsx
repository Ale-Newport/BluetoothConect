import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from 'react-native';
import type { PlayerId } from '@airlink/games';
import { Button, haptic, useTheme } from '../../../ui/index.js';
import { BoardSurface, PlayerBar, inkFor, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import { GOMOKU_SIZE, type GomokuState } from '../gameTypes.js';

/**
 * Gomoku: five in a row on 15x15.
 *
 * THE PROBLEM THIS BOARD EXISTS TO SOLVE
 * A fifteen-by-fifteen grid inside a phone's width gives a point about twenty
 * points across - half a fingertip. Every honest option was considered and
 * three of them lost:
 *
 *   - 225 tappable cells with hitSlop, as the small boards use. Slop that wide
 *     overlaps its neighbours on all four sides, so which point you hit near an
 *     edge is decided by view order rather than by where your finger was. On
 *     Tic-Tac-Toe that is invisible; here it plays the wrong stone, and a
 *     wrongly played stone in Gomoku is the game.
 *   - Pinch and pan to zoom in. That needs the scene to move under the finger,
 *     which is exactly the thing the shell refuses to do, and it hides two
 *     thirds of a position that only makes sense whole.
 *   - A loupe under the finger. It magnifies the stones your own hand is
 *     already covering, and it only exists to answer "where did that land?" -
 *     which the crosshair and the point's name answer without covering
 *     anything.
 *
 * So: aiming and playing are two separate, comfortable actions. A touch
 * anywhere on the board snaps the aim to the NEAREST point - drag it around and
 * it follows - and a full-width button plays it, named, so you commit to "Play
 * H8" rather than to a pixel. Nothing is sent until that button is pressed, so
 * a stray touch, a dropped gesture or a cancelled drag costs nothing at all.
 * The aim is also why a small board is merely cramped rather than unplayable:
 * precision comes from the crosshair, not from the size of a point.
 *
 * THE LAST STONE
 * `lastMove` is in the state for this renderer's benefit and is drawn as a hole
 * punched through the newest stone. A coloured halo would be easier to spot,
 * but the palette has exactly two inks and the accent already means "you are
 * aiming here" - a second accent ring on the board would be read as a second
 * cursor. The felt showing through belongs to no player and can be confused
 * with nothing else.
 */

/** Big enough to play on, small enough to leave the button room on a small phone. */
const MAX_BOARD = 380;
/**
 * Vertical space the player bar, the gaps and the play button need. Subtracted
 * from the height BEFORE the board is sized, so the board takes what is left
 * rather than what it would like.
 */
const BOARD_CHROME = 156;

/**
 * Every point on the board.
 *
 * The reducer draws the game when all of them are filled, and a draw is as
 * decided as a win - so this is what tells the crosshair to go away, alongside
 * a winner.
 */
const CELL_COUNT = GOMOKU_SIZE * GOMOKU_SIZE;

/** Where a screen reader starts aiming, which is where a first stone tends to go. */
const CENTRE_POINT = Math.floor(CELL_COUNT / 2);

/**
 * Handicap points, at the 4-4 intersections and the centre.
 *
 * They are not decoration. They are the only fixed landmarks on an otherwise
 * uniform grid, and counting "two left of the centre star" is how a person
 * actually reads a position back to themselves.
 */
const STAR_POINTS: readonly (readonly [number, number])[] = [
  [3, 3],
  [3, 11],
  [11, 3],
  [11, 11],
  [7, 7],
];

function clampToBoard(value: number): number {
  if (value < 0) return 0;
  if (value > GOMOKU_SIZE - 1) return GOMOKU_SIZE - 1;
  return value;
}

export function GomokuBoard({
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
}: GameRendererProps<GomokuState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  /**
   * Whole points per cell, so every one of the fifteen columns is exactly as
   * wide as the others. Rounding down loses at most fourteen points of board
   * and buys a grid whose lines land on the same offsets they were computed
   * from - a fractional cell leaves the fifteenth column a pixel narrow and the
   * whole thing looks bent.
   */
  const cell = Math.max(1, Math.floor(Math.min(width, height - BOARD_CHROME, MAX_BOARD) / GOMOKU_SIZE));
  const board = cell * GOMOKU_SIZE;
  const half = cell / 2;
  const span = cell * (GOMOKU_SIZE - 1);
  const stone = Math.round(cell * 0.86);

  const [aim, setAim] = useState<number | null>(null);
  const [refused, setRefused] = useState(false);
  /** Mirrors `aim` so a drag can tell a new point from the same one it is still on. */
  const aimed = useRef<number | null>(null);

  const myTurn = turn === local;
  const interactive = live && myTurn;

  /** A player as this device should hear them named. "You" is never a name. */
  const who = useCallback(
    (player: PlayerId): string => (player === local ? playText.room.you : nameFor(player)),
    [local, nameFor],
  );

  const winning = useMemo(() => new Set(state.winningLine ?? []), [state.winningLine]);
  // A full board ends the game with nobody winning, and a crosshair over a
  // drawn position is the same lie as one over a won position.
  const finished = state.winner !== null || state.moveCount >= CELL_COUNT;

  const moveAim = useCallback((index: number) => {
    if (aimed.current === index) return;
    aimed.current = index;
    haptic('selection');
    setAim(index);
    setRefused(false);
  }, []);

  /** The nearest point to the finger, which is never ambiguous and never a neighbour's. */
  const aimAtTouch = useCallback(
    (event: GestureResponderEvent) => {
      const { locationX, locationY } = event.nativeEvent;
      const col = clampToBoard(Math.round(locationX / cell - 0.5));
      const row = clampToBoard(Math.round(locationY / cell - 0.5));
      moveAim(row * GOMOKU_SIZE + col);
    },
    [cell, moveAim],
  );

  /**
   * Nudging the aim one point at a time, for VoiceOver.
   *
   * A grid of 225 unlabelled targets is useless to a screen reader however it is
   * built, so the board is a single adjustable control instead: it says what it
   * is aimed at, the four actions walk the aim around, and the button below
   * plays it. Starting from the centre when nothing is aimed matches where a
   * sighted player's first stone tends to go.
   *
   * Refused on a board that is not ours to play, because the board already
   * announces itself as disabled and a control that moves under a finger while
   * calling itself dead is worse than one that does nothing.
   */
  const nudge = useCallback(
    (event: AccessibilityActionEvent) => {
      if (!interactive) return;
      const from = aimed.current ?? CENTRE_POINT;
      const row = Math.floor(from / GOMOKU_SIZE);
      const col = from - row * GOMOKU_SIZE;
      const name = event.nativeEvent.actionName;
      const nextCol = name === 'increment' ? col + 1 : name === 'decrement' ? col - 1 : col;
      const nextRow = name === 'aimDown' ? row + 1 : name === 'aimUp' ? row - 1 : row;
      moveAim(clampToBoard(nextRow) * GOMOKU_SIZE + clampToBoard(nextCol));
    },
    [interactive, moveAim],
  );

  const play = useCallback(() => {
    if (aim === null) return;
    // The reducer is the only thing that decides. A refusal clears the aim,
    // because the one useful thing to do next is pick somewhere else, and the
    // cleared aim is what puts the reason under the button.
    if (dispatch('place', { cell: aim })) {
      aimed.current = null;
      setAim(null);
      setRefused(false);
      return;
    }
    aimed.current = null;
    setAim(null);
    setRefused(true);
  }, [aim, dispatch]);

  const aimRow = aim === null ? -1 : Math.floor(aim / GOMOKU_SIZE);
  const aimCol = aim === null ? -1 : aim - aimRow * GOMOKU_SIZE;
  const aimName = aim === null ? '' : playText.gomoku.point(aimCol, aimRow);
  /** 0 where the aim is on an empty point, and 0 as well where there is no aim. */
  const aimMark = aim === null ? 0 : state.board[aim] ?? 0;
  const aimTaken = aimMark !== 0;
  const aimOwner = aimMark === 0 ? null : state.players[aimMark - 1] ?? null;

  /**
   * Why the button cannot be pressed, most specific first. `disabledReason`
   * comes first among the three because it is the only one that knows whether
   * the board is dead from a dropped link or from a finished game.
   */
  const blocked = !live
    ? disabledReason
    : !myTurn
    ? playText.room.notYourTurn
    : aim === null
    ? refused
      ? playText.gomoku.refused
      : playText.gomoku.aimHint
    : aimTaken
    ? playText.gomoku.taken
    : null;

  const lastOwner =
    state.lastMove < 0 ? null : state.players[(state.board[state.lastMove] ?? 0) - 1] ?? null;

  /**
   * The stones, kept apart from the crosshair on purpose: dragging the aim
   * re-renders on every finger movement, and the 225-cell layer underneath has
   * not changed and must not be rebuilt to find that out.
   */
  const stones = useMemo(
    () =>
      state.board.map((mark, index) => {
        if (mark === 0) return null;
        const owner = state.players[mark - 1] ?? null;
        const row = Math.floor(index / GOMOKU_SIZE);
        const col = index - row * GOMOKU_SIZE;
        // Once there is a line, every stone outside it steps back so the five
        // that won are the only thing left to read.
        const dimmed = winning.size > 0 && !winning.has(index);
        return (
          <View
            key={index}
            style={{
              position: 'absolute',
              left: half + col * cell - stone / 2,
              top: half + row * cell - stone / 2,
              width: stone,
              height: stone,
              borderRadius: stone / 2,
              backgroundColor: inkFor(ink, owner, local),
              opacity: dimmed ? 0.25 : 1,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {index === state.lastMove ? (
              <View
                style={{
                  width: Math.max(3, stone * 0.3),
                  height: Math.max(3, stone * 0.3),
                  borderRadius: stone,
                  backgroundColor: ink.felt,
                }}
              />
            ) : null}
          </View>
        );
      }),
    [cell, half, ink, local, state.board, state.lastMove, state.players, stone, winning],
  );

  /** The stripe behind the winning five. Always straight, so one rotated bar draws it. */
  const winStripe = useMemo(() => {
    const line = state.winningLine;
    if (!line || line.length === 0) return null;
    const first = line[0] ?? 0;
    const last = line[line.length - 1] ?? 0;
    const x0 = half + (first % GOMOKU_SIZE) * cell;
    const y0 = half + Math.floor(first / GOMOKU_SIZE) * cell;
    const x1 = half + (last % GOMOKU_SIZE) * cell;
    const y1 = half + Math.floor(last / GOMOKU_SIZE) * cell;
    const length = Math.hypot(x1 - x0, y1 - y0) + stone;
    const thickness = Math.max(4, stone * 0.55);
    const owner = state.winner;
    return (
      <View
        style={{
          position: 'absolute',
          left: (x0 + x1) / 2 - length / 2,
          top: (y0 + y1) / 2 - thickness / 2,
          width: length,
          height: thickness,
          borderRadius: thickness / 2,
          backgroundColor: inkFor(ink, owner, local),
          opacity: 0.28,
          transform: [{ rotate: `${(Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI}deg` }],
        }}
      />
    );
  }, [cell, half, ink, local, state.winner, state.winningLine, stone]);

  return (
    <View>
      <PlayerBar players={players} local={local} turn={turn} nameFor={nameFor} />

      <View style={{ height: theme.spacing.lg }} />

      <BoardSurface size={board} padded={false}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={
            state.lastMove < 0 || lastOwner === null
              ? playText.gomoku.board
              : playText.gomoku.boardWithLast(
                  playText.gomoku.lastStone(
                    // Spoken rather than written: "H8" is the name on the
                    // button, but a label only a screen reader ever hears wants
                    // the column and the row said out loud.
                    playText.gomoku.spokenPoint(
                      state.lastMove % GOMOKU_SIZE,
                      Math.floor(state.lastMove / GOMOKU_SIZE),
                    ),
                    who(lastOwner),
                  ),
                )
          }
          accessibilityValue={{
            text:
              aim === null
                ? playText.gomoku.aimingNowhere
                : playText.gomoku.aimingAt(
                    playText.gomoku.spokenPoint(aimCol, aimRow),
                    aimOwner === null ? playText.gomoku.emptyPoint : who(aimOwner),
                  ),
          }}
          accessibilityState={{ disabled: !interactive }}
          accessibilityActions={[
            { name: 'decrement', label: playText.gomoku.aimLeft },
            { name: 'increment', label: playText.gomoku.aimRight },
            { name: 'aimUp', label: playText.gomoku.aimUp },
            { name: 'aimDown', label: playText.gomoku.aimDown },
          ]}
          onAccessibilityAction={nudge}
          onStartShouldSetResponder={() => interactive}
          onMoveShouldSetResponder={() => interactive}
          // Nothing may take this gesture away mid-drag. The scene does not
          // scroll, so there is no legitimate claimant - only the bug where a
          // parent steals the touch and the aim freezes half a board away.
          onResponderTerminationRequest={() => false}
          onResponderGrant={aimAtTouch}
          onResponderMove={aimAtTouch}
          // Neither release nor terminate plays anything: lifting a finger
          // leaves the aim where it is, and a cancelled drag leaves it wherever
          // it got to. The only thing that sends a stone is the button.
          style={{ width: board, height: board }}
        >
          {/*
            One untouchable layer holds everything that is drawn.

            A touch reports its position relative to the view it LANDED on, not
            to the view holding the gesture, and every mark below is a real view
            - a stone is seventeen points across. Left touchable, coming down on
            a stone measured the finger inside that stone's own frame and snapped
            the aim to the top-left corner of the board, and the rest of the drag
            stayed in the wrong frame with it. Aiming near a stone is most of
            Gomoku, so this is not an edge case.
          */}
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {/* The grid, drawn through the centres of the cells so stones sit on
                intersections the way they do on a real board. */}
            {Array.from({ length: GOMOKU_SIZE }, (_unused, k) => (
              <View
                key={`h${k}`}
                style={{
                  position: 'absolute',
                  left: half,
                  top: half + k * cell,
                  width: span,
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: ink.rule,
                }}
              />
            ))}
            {Array.from({ length: GOMOKU_SIZE }, (_unused, k) => (
              <View
                key={`v${k}`}
                style={{
                  position: 'absolute',
                  left: half + k * cell,
                  top: half,
                  width: StyleSheet.hairlineWidth,
                  height: span,
                  backgroundColor: ink.rule,
                }}
              />
            ))}

            {STAR_POINTS.map(([row, col]) => {
              const dot = Math.max(3, cell * 0.24);
              return (
                <View
                  key={`s${row}-${col}`}
                  style={{
                    position: 'absolute',
                    left: half + col * cell - dot / 2,
                    top: half + row * cell - dot / 2,
                    width: dot,
                    height: dot,
                    borderRadius: dot / 2,
                    backgroundColor: ink.rule,
                  }}
                />
              );
            })}

            {winStripe}
            {stones}

            {/* The aim. Two lines the full width and height of the board, because
                on fifteen columns the hard question is not "which point is under
                my finger" but "which row and column is that", and a ring on its
                own answers neither. */}
            {/* An aim survives the link going down - the contract is that the
                board is left exactly as it was - but not the end of the game,
                where a crosshair over a decided position is just a lie about
                being able to play there. */}
            {aim === null || finished ? null : (
              <>
                <View
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: half + aimRow * cell,
                    width: board,
                    height: StyleSheet.hairlineWidth,
                    backgroundColor: ink.mine,
                    opacity: 0.6,
                  }}
                />
                <View
                  style={{
                    position: 'absolute',
                    left: half + aimCol * cell,
                    top: 0,
                    width: StyleSheet.hairlineWidth,
                    height: board,
                    backgroundColor: ink.mine,
                    opacity: 0.6,
                  }}
                />
                {aimTaken ? null : (
                  <View
                    style={{
                      position: 'absolute',
                      left: half + aimCol * cell - stone / 2,
                      top: half + aimRow * cell - stone / 2,
                      width: stone,
                      height: stone,
                      borderRadius: stone / 2,
                      backgroundColor: ink.mine,
                      opacity: 0.4,
                    }}
                  />
                )}
                <View
                  style={{
                    position: 'absolute',
                    left: half + aimCol * cell - cell,
                    top: half + aimRow * cell - cell,
                    width: cell * 2,
                    height: cell * 2,
                    borderRadius: cell,
                    borderWidth: 2,
                    borderColor: ink.mine,
                  }}
                />
              </>
            )}
          </View>
        </View>
      </BoardSurface>

      <View style={{ height: theme.spacing.lg }} />

      <Button
        title={aim === null ? playText.gomoku.pick : playText.gomoku.play(aimName)}
        onPress={play}
        disabled={blocked !== null}
        disabledReason={blocked ?? undefined}
      />
    </View>
  );
}
