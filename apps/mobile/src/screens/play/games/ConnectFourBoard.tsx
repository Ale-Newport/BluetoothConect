import React, { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { haptic, useTheme } from '../../../ui/index.js';
import { BoardSurface, Hint, MIN_TARGET, PlayerBar, inkFor, useInk } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import { CONNECT_FOUR_COLS, CONNECT_FOUR_ROWS, landingRow, type ConnectFourState } from '../gameTypes.js';

/**
 * Connect Four.
 *
 * Seven columns, and a column is the only thing you can press - which is both
 * how the game works and what makes it usable one-handed on a phone, where
 * forty-two individual targets would be far too small.
 *
 * A disc arrives with `FadeInDown`, so it reads as having fallen rather than
 * appeared. The drop distance is deliberately not the real one: sliding a disc
 * through six rows takes long enough to feel like waiting, and this is a game
 * of quick exchanges.
 */

const MAX_BOARD = 360;

export function ConnectFourBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  turn,
  live,
  width,
}: GameRendererProps<ConnectFourState>): React.JSX.Element {
  const theme = useTheme();
  const ink = useInk();

  const board = Math.min(width, MAX_BOARD);
  const gap = theme.spacing.xs;
  const cell = (board - theme.spacing.sm * 2 - gap * (CONNECT_FOUR_COLS - 1)) / CONNECT_FOUR_COLS;

  const winning = useMemo(() => new Set(state.winningLine ?? []), [state.winningLine]);
  const myTurn = turn === local;
  const finished = state.winner !== null || winning.size > 0;

  return (
    <View>
      <PlayerBar players={players} local={local} turn={turn} nameFor={nameFor} />

      <View style={{ height: theme.spacing.lg }} />

      <BoardSurface size={board}>
        <View style={{ flexDirection: 'row', gap }}>
          {Array.from({ length: CONNECT_FOUR_COLS }, (_unusedColumn, column) => {
            const free = landingRow(state.board, column);
            const playable = free >= 0 && myTurn && live && !finished;
            return (
              <Pressable
                key={column}
                accessibilityRole="button"
                accessibilityLabel={playText.connectFour.column(column + 1)}
                accessibilityHint={free < 0 ? playText.connectFour.columnFull : undefined}
                accessibilityState={{ disabled: !playable }}
                disabled={!playable}
                onPress={() => {
                  haptic('impactLight');
                  dispatch('drop', { column });
                }}
                style={({ pressed }) => [
                  { width: cell, gap, minHeight: MIN_TARGET },
                  pressed ? { opacity: 0.7 } : null,
                ]}
              >
                {Array.from({ length: CONNECT_FOUR_ROWS }, (_unusedRow, row) => {
                  const index = row * CONNECT_FOUR_COLS + column;
                  const mark = state.board[index] ?? 0;
                  const owner = mark === 0 ? null : state.players[mark - 1] ?? null;
                  const dimmed = winning.size > 0 && !winning.has(index);
                  return (
                    <View
                      key={row}
                      style={{
                        width: cell,
                        height: cell,
                        borderRadius: cell / 2,
                        backgroundColor: theme.colors.surfaceElevated,
                        overflow: 'hidden',
                      }}
                    >
                      {mark === 0 ? null : (
                        <Animated.View
                          entering={FadeInDown.duration(theme.motion.quick)}
                          style={{
                            width: cell,
                            height: cell,
                            borderRadius: cell / 2,
                            backgroundColor: inkFor(ink, owner, local),
                            opacity: dimmed ? 0.3 : 1,
                          }}
                        />
                      )}
                    </View>
                  );
                })}
              </Pressable>
            );
          })}
        </View>
      </BoardSurface>

      {finished ? null : (
        <Hint text={myTurn ? playText.connectFour.tapColumn : playText.room.notYourTurn} />
      )}
    </View>
  );
}
