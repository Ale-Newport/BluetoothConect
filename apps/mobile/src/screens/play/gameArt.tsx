import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from '../../ui/index.js';

/**
 * A mark for each game.
 *
 * These live in the app rather than in @airlink/games on purpose: the game
 * package holds rules, and rules have no opinion about pixels. It keys off
 * `definition.id`, which is the same identifier the two devices agree on in the
 * handshake, so a game cannot appear in the catalogue without one.
 *
 * They are drawn for the same reason every other icon here is - see
 * ui/Icon.tsx - and each one is a picture of the board rather than a symbol for
 * the idea of it, because a 44pt tile has room for one clear shape and nothing
 * else. They are placeholders for artwork in the sense that a designer would
 * replace them; they are not placeholders in the sense of standing in for
 * something missing.
 */
const BOX = 24;
const STROKE = 1.75;

export function GameArt({
  gameId,
  size = 32,
  color,
}: {
  gameId: string;
  size?: number;
  color?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const tint = color ?? theme.colors.text;
  const stroked = {
    stroke: tint,
    strokeWidth: STROKE,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  const filled = { fill: tint, stroke: 'none' };
  const hollow = { ...stroked, strokeWidth: 1.5 };

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${BOX} ${BOX}`}>
      {gameId === 'tic-tac-toe' ? (
        <>
          {/* A hash, not a full grid: the lines stop short of the edges, which
              is how the board is actually drawn and leaves the two marks room
              to be legible at 28pt. */}
          <Path d="M9.6 4.8v14.4M14.4 4.8v14.4M4.8 9.6h14.4M4.8 14.4h14.4" {...hollow} opacity={0.4} />
          <Path d="M5.6 5.6 8.4 8.4M8.4 5.6 5.6 8.4" {...stroked} strokeWidth={2} />
          <Circle cx={17} cy={17} r={1.9} {...stroked} strokeWidth={2} />
        </>
      ) : null}

      {gameId === 'connect-four' ? (
        <>
          {/* The disc above the board is the whole idea of the game: you drop
              one in from the top. Without it a grid of holes reads as a die. */}
          <Circle cx={8} cy={3.4} r={1.7} {...filled} />
          <Rect x={3.4} y={7.4} width={17.2} height={13.2} rx={2.4} {...hollow} />
          <Circle cx={8} cy={11.2} r={1.7} {...hollow} opacity={0.55} />
          <Circle cx={13} cy={11.2} r={1.7} {...hollow} opacity={0.55} />
          <Circle cx={18} cy={11.2} r={1.7} {...hollow} opacity={0.55} />
          <Circle cx={8} cy={16.6} r={1.7} {...hollow} opacity={0.55} />
          <Circle cx={13} cy={16.6} r={1.7} {...filled} />
          <Circle cx={18} cy={16.6} r={1.7} {...filled} />
        </>
      ) : null}

      {gameId === 'reaction' ? (
        <Path d="M13.4 2.6 6 13.2h4.4L9.6 21.4 17.6 10h-4.6z" {...stroked} />
      ) : null}

      {gameId === 'pong' ? (
        <>
          <Path d="M4 6.4v11.2M20 6.4v11.2" {...stroked} strokeWidth={2.6} />
          <Path d="M12 3.6v3M12 10.6v2.8M12 17.4v3" {...hollow} opacity={0.45} />
          <Circle cx={14.6} cy={9.4} r={1.5} {...filled} />
        </>
      ) : null}

      {gameId === 'air-hockey' ? (
        <>
          <Rect x={4.4} y={3.4} width={15.2} height={17.2} rx={2.4} {...hollow} />
          <Path d="M4.4 12h15.2" {...hollow} opacity={0.45} />
          <Circle cx={12} cy={12} r={2.6} {...hollow} opacity={0.45} />
          <Circle cx={12} cy={7} r={1.9} {...stroked} />
          <Circle cx={12} cy={17} r={1.3} {...filled} />
        </>
      ) : null}

      {gameId === 'draw-and-guess' ? (
        <>
          {/* A pencil, mid-stroke. */}
          <Path d="M15.6 4.4l4 4-9.4 9.4-4.8 1.2 1.2-4.8z" {...stroked} />
          <Path d="M14 6l4 4" {...hollow} />
          <Path d="M4 20.4h6" {...stroked} opacity={0.5} />
        </>
      ) : null}

      {gameId === 'trivia' ? (
        <>
          {/* A lamp: the moment of knowing the answer. */}
          <Path d="M8.4 13.6a4.8 4.8 0 1 1 7.2 0c-.8.9-1.2 1.6-1.3 2.6H9.7c-.1-1-.5-1.7-1.3-2.6z" {...stroked} />
          <Path d="M9.9 18.4h4.2M10.6 20.6h2.8" {...stroked} />
          <Path d="M12 2.6v1.6M4.8 8.2h1.6M17.6 8.2h1.6M6.6 3.8l1.1 1.1M17.4 3.8l-1.1 1.1" {...hollow} opacity={0.5} />
        </>
      ) : null}

      {gameId === 'darts' ? (
        <>
          <Circle cx={12} cy={12} r={8.4} {...hollow} />
          <Circle cx={12} cy={12} r={5} {...hollow} opacity={0.55} />
          <Circle cx={12} cy={12} r={1.7} {...filled} />
          <Path d="M12 12 20.4 3.6" {...stroked} />
          <Path d="M17.6 3.2h3.2v3.2" {...hollow} />
        </>
      ) : null}

      {gameId === 'battleship' ? (
        <>
          {/* A hull on a grid, which is what the board is. */}
          <Path d="M3.4 13.4h17.2l-2.2 4.6a2 2 0 0 1-1.8 1.1H7.4a2 2 0 0 1-1.8-1.1z" {...stroked} />
          <Path d="M12 13.4V5.6M12 7h5.4l-1.6 2.6H12" {...stroked} />
          <Path d="M4.6 9.4h2M7.6 5.8h2" {...hollow} opacity={0.5} />
        </>
      ) : null}

      {gameId === 'pool' ? (
        <>
          {/* A rack, not a single ball. One ball is a circle, and a circle is
              already the radar, the target and the smile; six in a triangle can
              only be one game. */}
          <Circle cx={12} cy={5.4} r={2.1} {...hollow} />
          <Circle cx={9.5} cy={9.7} r={2.1} {...hollow} />
          <Circle cx={14.5} cy={9.7} r={2.1} {...filled} />
          <Circle cx={7} cy={14} r={2.1} {...filled} />
          <Circle cx={12} cy={14} r={2.1} {...hollow} />
          <Circle cx={17} cy={14} r={2.1} {...hollow} />
          <Path d="M4.6 18.6h14.8" {...stroked} opacity={0.45} />
        </>
      ) : null}

      {gameId === 'word-duel' ? (
        <>
          <Rect x={3.4} y={7} width={5.2} height={5.2} rx={1.2} {...hollow} />
          <Rect x={9.4} y={7} width={5.2} height={5.2} rx={1.2} {...filled} />
          <Rect x={15.4} y={7} width={5.2} height={5.2} rx={1.2} {...hollow} />
          <Path d="M4.6 16.4h9M4.6 19.4h14" {...stroked} opacity={0.5} />
        </>
      ) : null}

      {gameId === 'chess' ? (
        <>
          {/* A pawn, the piece everyone recognises at any size. */}
          <Circle cx={12} cy={6.4} r={2.6} {...stroked} />
          <Path d="M9.6 10.4h4.8l-.8 4.2h-3.2z" {...stroked} />
          <Path d="M7.4 20.4c0-2.6 1.6-4.2 2.4-5.8h4.4c.8 1.6 2.4 3.2 2.4 5.8z" {...stroked} />
        </>
      ) : null}
    </Svg>
  );
}

/** Every game the catalogue can draw, so a missing mark is a test failure. */
export const DRAWN_GAME_IDS: readonly string[] = [
  'tic-tac-toe',
  'connect-four',
  'reaction',
  'pong',
  'air-hockey',
  'draw-and-guess',
  'trivia',
  'darts',
  'battleship',
  'pool',
  'word-duel',
  'chess',
];
