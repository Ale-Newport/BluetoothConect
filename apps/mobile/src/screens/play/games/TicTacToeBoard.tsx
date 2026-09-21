import React, { useMemo } from 'react';
import { View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { useTheme } from '../../../ui/index.js';
import { BoardSurface, Cell, Hint, PlayerBar, inkFor, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import type { TicTacToeState } from '../gameTypes.js';

/**
 * Tic-Tac-Toe.
 *
 * The reference renderer, and deliberately the smallest one: it reads the
 * board, draws nine squares, and sends a cell index. Whether a square may be
 * played is not decided here - `dispatch` returns false when the reducer
 * refuses, and the reducer is the same code on both phones and in the tests.
 *
 * The two marks are a ring and a cross drawn from plain views rather than
 * letters, so they scale with the board and never inherit a font's opinion
 * about how round an O should be.
 */

const MAX_BOARD = 340;
const GAP_UNITS = 2;

export function TicTacToeBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  turn,
  live,
  width,
}: GameRendererProps<TicTacToeState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  const board = Math.min(width, MAX_BOARD);
  const gap = theme.spacing.sm;
  /*
   * Floored, because a row that fits EXACTLY does not reliably fit.
   *
   * `BoardSurface` carries its padding inside its own width, so three cells and
   * two gaps come to precisely the inner width - and flexbox wraps on `>`, not
   * on `>=`. One sub-pixel of rounding anywhere in that sum sends the third
   * cell onto its own line, which is how a 3x3 grid became a 2-wide column of
   * nine. The box is measured now rather than computed from the window, so
   * fractional widths are the normal case rather than the exception.
   */
  const cell = Math.floor((board - theme.spacing.sm * 2 - gap * GAP_UNITS) / 3);

  const winning = useMemo(() => new Set(state.winningLine ?? []), [state.winningLine]);
  const myTurn = turn === local;

  return (
    <View>
      <PlayerBar players={players} local={local} turn={turn} nameFor={nameFor} />

      <View style={{ height: theme.spacing.lg }} />

      <BoardSurface size={board}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
          {state.board.map((mark, index) => {
            const owner = mark === 0 ? null : state.players[mark - 1] ?? null;
            const row = Math.floor(index / 3) + 1;
            const column = (index % 3) + 1;
            const playable = mark === 0 && myTurn && live;
            // Once there is a line, everything outside it steps back so the
            // three squares that won are the only thing left to read.
            const dimmed = winning.size > 0 && !winning.has(index);

            return (
              <Cell
                key={index}
                size={cell}
                disabled={!playable}
                onPress={playable ? () => dispatch('place', { cell: index }) : undefined}
                accessibilityLabel={`${playText.ticTacToe.square(row, column)}, ${
                  owner === null ? playText.ticTacToe.empty : nameFor(owner)
                }`}
                style={{
                  backgroundColor: theme.colors.surfaceElevated,
                  borderRadius: theme.radius.md,
                  opacity: dimmed ? 0.35 : 1,
                }}
              >
                {mark === 0 ? null : (
                  <Animated.View entering={ZoomIn.duration(theme.motion.quick)}>
                    <Mark seat={mark} size={cell * 0.5} color={inkFor(ink, owner, local)} />
                  </Animated.View>
                )}
              </Cell>
            );
          })}
        </View>
      </BoardSurface>

      {state.winner === null && state.moveCount < 9 && !myTurn ? <Hint text={playText.room.notYourTurn} /> : null}
    </View>
  );
}

/** Seat 0 plays the ring, seat 1 the cross. Both drawn, never typed. */
function Mark({ seat, size, color }: { seat: number; size: number; color: string }): React.JSX.Element {
  const stroke = Math.max(3, size * 0.14);
  if (seat === 1) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: color }}
      />
    );
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={{
          position: 'absolute',
          width: size,
          height: stroke,
          borderRadius: stroke / 2,
          backgroundColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: size,
          height: stroke,
          borderRadius: stroke / 2,
          backgroundColor: color,
          transform: [{ rotate: '-45deg' }],
        }}
      />
    </View>
  );
}
