import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Label, haptic, useTheme } from '../../../ui/index.js';
import { BoardSurface, ChipRow, Hint, MIN_TARGET, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  isInCheck,
  legalMovesFrom,
  squareName,
  type ChessMove,
  type ChessState,
  type PromotionPiece,
} from '../gameTypes.js';

/**
 * Chess.
 *
 * The rules are not here and never will be: `legalMovesFrom` comes from
 * @airlink/games and is the same generator that `validateAction` runs on both
 * phones, so what this board highlights is exactly what the reducer will
 * accept. There is no second, approximate move generator in the UI to drift out
 * of step with the real one - which is the single most common way a chess
 * client ends up offering a move it then refuses.
 *
 * Three things a chess board has to get right, and does here:
 *
 *   ORIENTATION. Black plays with the board turned round. Anything else is
 *   unplayable, and it costs one index flip.
 *
 *   LEGAL MOVES, NOT PLAUSIBLE ONES. Tapping a piece shows precisely its legal
 *   destinations, castling and en passant included, with a capture drawn as a
 *   ring round the target rather than a dot on it.
 *
 *   THE LAST MOVE. Coming back to a board after a minute away, the first
 *   question is always "what did they just play?", so the two squares of the
 *   last move stay tinted until the next one replaces them.
 */

const MAX_BOARD = 380;
const FILES = 8;

/**
 * Piece glyphs.
 *
 * The Unicode chess pieces are the one place in this app where a character IS
 * the artwork: they are in every system font, they scale perfectly, and they
 * are what a chess player expects to see. The outline set is used for both
 * colours and tinted with the player's own ink, because the solid glyphs read
 * as muddy blobs at phone sizes and the filled/hollow pair does not survive a
 * dark background.
 */
const GLYPH: readonly string[] = ['', '♙', '♘', '♗', '♖', '♕', '♔', '♟', '♞', '♝', '♜', '♛', '♚'];

/** An absolutely-positioned overlay filling its square. */
const FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

/** Which way up the board is drawn for this player. */
function viewIndex(index: number, flipped: boolean): number {
  return flipped ? 63 - index : index;
}

export function ChessBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  turn,
  lastAction,
  live,
  width,
}: GameRendererProps<ChessState>): React.JSX.Element {
  const theme = useTheme();

  const seat = players.indexOf(local);
  const flipped = seat === 1;
  const myTurn = turn === local;

  const [selected, setSelected] = useState<number | null>(null);
  const [promotion, setPromotion] = useState<{ from: number; to: number; choices: PromotionPiece[] } | null>(null);

  // A move landing - ours or theirs - invalidates whatever was picked up.
  useEffect(() => {
    setSelected(null);
    setPromotion(null);
  }, [state.board, state.turn]);

  const board = Math.min(width, MAX_BOARD);
  const square = board / FILES;

  const moves = useMemo<ChessMove[]>(
    () => (selected === null ? [] : legalMovesFrom(state, selected)),
    [selected, state],
  );
  const targets = useMemo(() => {
    const map = new Map<number, ChessMove[]>();
    for (const move of moves) {
      const existing = map.get(move.to);
      if (existing) existing.push(move);
      else map.set(move.to, [move]);
    }
    return map;
  }, [moves]);

  const lastMove = useMemo<{ from: number; to: number } | null>(() => {
    const payload = lastAction?.payload as { from?: unknown; to?: unknown } | null | undefined;
    if (!payload || typeof payload.from !== 'number' || typeof payload.to !== 'number') return null;
    return { from: payload.from, to: payload.to };
  }, [lastAction]);

  const inCheck = state.result.kind === 'inProgress' && isInCheck(state, state.turn);

  const press = useCallback(
    (index: number) => {
      if (!live || !myTurn) return;
      const candidates = targets.get(index);
      if (candidates && candidates.length > 0) {
        const first = candidates[0] as ChessMove;
        // A promoting move arrives as four candidates for one square, so the
        // piece has to be chosen before anything is sent.
        if (first.promotion !== undefined && candidates.length > 1) {
          setPromotion({
            from: first.from,
            to: index,
            choices: candidates
              .map((m) => m.promotion)
              .filter((p): p is PromotionPiece => p !== undefined),
          });
          return;
        }
        haptic('impactLight');
        dispatch(
          'move',
          first.promotion === undefined
            ? { from: first.from, to: index }
            : { from: first.from, to: index, promotion: first.promotion },
        );
        setSelected(null);
        return;
      }

      const piece = state.board[index] ?? 0;
      const mine = piece !== 0 && (piece <= 6 ? 0 : 1) === state.turn;
      setSelected(mine ? (selected === index ? null : index) : null);
    },
    [dispatch, live, myTurn, selected, state, targets],
  );

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={turn}
        nameFor={nameFor}
        captionFor={(player) =>
          players.indexOf(player) === 0 ? playText.chess.white : playText.chess.black
        }
      />

      <View style={{ height: theme.spacing.lg }} />

      <BoardSurface size={board} padded={false}>
        <View style={{ width: board, height: board, flexDirection: 'row', flexWrap: 'wrap' }}>
          {Array.from({ length: 64 }, (_, drawn) => {
            const index = viewIndex(drawn, flipped);
            const piece = state.board[index] ?? 0;
            const file = index & 7;
            const rank = index >> 3;
            const dark = ((file + rank) & 1) === 0;
            const isTarget = targets.has(index);
            const isCapture = isTarget && piece !== 0;
            const isSelected = selected === index;
            const isLast = lastMove !== null && (lastMove.from === index || lastMove.to === index);
            const owner = piece === 0 ? null : players[piece <= 6 ? 0 : 1] ?? null;
            const checked = inCheck && (piece === 6 || piece === 12) && (piece <= 6 ? 0 : 1) === state.turn;

            return (
              <Pressable
                key={drawn}
                accessibilityRole="button"
                accessibilityLabel={describeSquare(index, piece, owner, local, nameFor)}
                accessibilityState={{ selected: isSelected, disabled: !live || !myTurn }}
                disabled={!live || !myTurn}
                onPress={() => press(index)}
                style={{
                  width: square,
                  height: square,
                  alignItems: 'center',
                  justifyContent: 'center',
                  // The board's own two tones are the surface and the elevated
                  // surface, so it belongs to the app rather than arriving from
                  // some other chess program's palette.
                  backgroundColor: dark ? theme.colors.surfaceElevated : theme.colors.surface,
                }}
              >
                {isLast ? (
                  <View style={[FILL, { backgroundColor: theme.colors.accentMuted }]} />
                ) : null}
                {isSelected ? <View style={[FILL, { borderWidth: 2, borderColor: theme.colors.accent }]} /> : null}
                {checked ? <View style={[FILL, { borderWidth: 2, borderColor: theme.colors.danger }]} /> : null}

                {piece === 0 ? null : (
                  <Text
                    // The label on the Pressable already says the piece and its
                    // owner; the glyph itself would be read out as a symbol.
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={{
                      fontSize: square * 0.72,
                      lineHeight: square,
                      color: owner === local ? theme.colors.accent : theme.colors.text,
                    }}
                  >
                    {GLYPH[piece]}
                  </Text>
                )}

                {isTarget && !isCapture ? (
                  <View
                    style={{
                      position: 'absolute',
                      width: square * 0.24,
                      height: square * 0.24,
                      borderRadius: square * 0.12,
                      backgroundColor: theme.colors.accent,
                      opacity: 0.55,
                    }}
                  />
                ) : null}
                {isCapture ? (
                  <View
                    style={{
                      position: 'absolute',
                      width: square * 0.86,
                      height: square * 0.86,
                      borderRadius: square * 0.43,
                      borderWidth: 3,
                      borderColor: theme.colors.accent,
                      opacity: 0.7,
                    }}
                  />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </BoardSurface>

      {promotion ? (
        <View style={{ marginTop: theme.spacing.lg, alignItems: 'center', gap: theme.spacing.sm }}>
          <Label variant="footnote" tone="secondary">
            {playText.chess.promotionTitle}
          </Label>
          <ChipRow
            options={promotion.choices}
            value={null}
            labelFor={(choice) => playText.chess.promotion[choice]}
            onChange={(choice) => {
              dispatch('move', { from: promotion.from, to: promotion.to, promotion: choice });
              setPromotion(null);
              setSelected(null);
            }}
          />
        </View>
      ) : null}

      {state.result.kind === 'inProgress' ? (
        <Hint
          text={inCheck ? playText.chess.check : myTurn ? playText.chess.tapPiece : playText.room.notYourTurn}
          tone={inCheck ? 'secondary' : 'tertiary'}
        />
      ) : null}

      <Captured state={state} local={local} players={players} square={Math.max(MIN_TARGET / 2, square * 0.5)} />
    </View>
  );
}

/**
 * What is off the board.
 *
 * Derived from the position rather than stored, because the state does not keep
 * a capture list - and does not need to: the pieces that are missing from the
 * board are exactly the pieces that have been taken.
 */
function Captured({
  state,
  local,
  players,
  square,
}: {
  state: ChessState;
  local: string;
  players: readonly string[];
  square: number;
}): React.JSX.Element | null {
  const theme = useTheme();
  const START: readonly number[] = [0, 8, 2, 2, 2, 1, 1];

  const counts = new Array<number>(13).fill(0);
  for (const piece of state.board) counts[piece] = (counts[piece] ?? 0) + 1;

  const missing = (color: 0 | 1): string[] => {
    const out: string[] = [];
    for (let type = 1; type <= 6; type++) {
      const code = color === 0 ? type : type + 6;
      const gone = (START[type] ?? 0) - (counts[code] ?? 0);
      for (let i = 0; i < gone; i++) out.push(GLYPH[code] as string);
    }
    return out;
  };

  const whiteGone = missing(0);
  const blackGone = missing(1);
  if (whiteGone.length === 0 && blackGone.length === 0) return null;

  const row = (glyphs: string[], color: 0 | 1): React.JSX.Element | null => {
    if (glyphs.length === 0) return null;
    const owner = players[color];
    return (
      <View
        accessible
        accessibilityLabel={`${playText.chess.captured}: ${glyphs.length}`}
        style={{ flexDirection: 'row', flexWrap: 'wrap' }}
      >
        {glyphs.map((glyph, i) => (
          <Text
            key={`${glyph}-${i}`}
            style={{
              fontSize: square,
              lineHeight: square * 1.2,
              opacity: 0.5,
              color: owner === local ? theme.colors.accent : theme.colors.text,
            }}
          >
            {glyph}
          </Text>
        ))}
      </View>
    );
  };

  return (
    <View style={{ marginTop: theme.spacing.md, gap: theme.spacing.xs }}>
      {row(blackGone, 1)}
      {row(whiteGone, 0)}
    </View>
  );
}

function describeSquare(
  index: number,
  piece: number,
  owner: string | null,
  local: string,
  nameFor: (player: string) => string,
): string {
  const where = playText.chess.square(squareName(index));
  if (piece === 0 || owner === null) return `${where}, ${playText.chess.emptySquare}`;
  const who = owner === local ? playText.room.you : nameFor(owner);
  const type = piece <= 6 ? piece : piece - 6;
  return `${where}, ${who}, ${playText.chess.piece[type] ?? ''}`;
}
