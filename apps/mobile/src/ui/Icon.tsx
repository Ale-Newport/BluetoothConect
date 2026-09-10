import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { useTheme } from './theme.js';

/**
 * Every icon in the app, drawn.
 *
 * This file replaced two earlier attempts, and the reason is worth recording
 * because it is a constraint rather than a preference.
 *
 * A character is only as reliable as the font behind it. Geometric symbols like
 * U+2709 ENVELOPE and U+25CE BULLSEYE draw as an empty box with a question mark
 * whenever the font in use has no glyph for them, and emoji draw as the same box
 * whenever no colour-emoji font is loaded - which is the case in the iOS
 * simulator this app was built against, where every single one of the twenty-odd
 * emoji the interface used rendered as a placeholder. There is no way to
 * feature-detect a missing glyph at runtime, so a text icon is a bet on the
 * host's font stack that cannot be checked and cannot be recovered from.
 *
 * Paths carry no such bet. They render identically on every device, tint from
 * the theme, scale to any size without a second asset, and stay crisp. Apple
 * ships SF Symbols for exactly these reasons; this is the same idea with no
 * dependency and no licence.
 *
 * All of them are drawn in a 24x24 box with a 1.75 stroke, which matches the
 * weight of the system tab bar, so they sit together without retuning.
 */
const BOX = 24;
const STROKE = 1.75;

/**
 * Every name, as data.
 *
 * The list is the source of truth and `IconName` is derived from it, rather
 * than the other way round. That ordering matters: it means a name cannot exist
 * in the type without existing in this array, so the test that renders every
 * entry genuinely covers the whole set, and the gallery in Developer Mode
 * cannot fall behind.
 */
export const ALL_ICON_NAMES = [
  // Navigation - the five tabs.
  'home',
  'chat',
  'play',
  'share',
  'you',
  // States.
  'radar',
  'signal',
  'qr',
  'camera',
  'lock',
  'wave',
  'dice',
  'puzzle',
  'hourglass',
  'blocked',
  'inbox',
  'smile',
  'upload',
  'download',
  'start',
  'warning',
  // Playback, for Watch Together.
  'chevronLeft',
  'pause',
  'replay',
  'skipBack',
  'skipForward',
  // File kinds.
  'image',
  'video',
  'audio',
  'document',
] as const;

export type IconName = (typeof ALL_ICON_NAMES)[number];

export function Icon({
  name,
  color,
  size = 26,
  opacity,
}: {
  name: IconName;
  /** Defaults to the current text colour, which is right for most placements. */
  color?: string;
  size?: number;
  opacity?: number;
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

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${BOX} ${BOX}`} opacity={opacity}>
      {name === 'home' ? (
        <>
          {/* Concentric arcs: a signal going out, which is what Home does. */}
          <Circle cx={12} cy={12} r={2.2} {...filled} />
          <Path d="M6.8 7.4a7 7 0 0 0 0 9.2" {...stroked} />
          <Path d="M17.2 7.4a7 7 0 0 1 0 9.2" {...stroked} />
          <Path d="M3.6 4.6a11 11 0 0 0 0 14.8" {...stroked} opacity={0.45} />
          <Path d="M20.4 4.6a11 11 0 0 1 0 14.8" {...stroked} opacity={0.45} />
        </>
      ) : null}

      {name === 'chat' ? (
        <Path
          d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4.6 3.6A.5.5 0 0 1 4.6 19V16A2.5 2.5 0 0 1 4 13.5z"
          {...stroked}
        />
      ) : null}

      {name === 'play' ? (
        <>
          {/* A controller, reduced to its silhouette. */}
          <Rect x={3} y={7.5} width={18} height={9} rx={4.5} {...stroked} />
          <Path d="M7.4 12h2.4M8.6 10.8v2.4" {...stroked} />
          <Circle cx={15.4} cy={11.2} r={1.05} {...filled} />
          <Circle cx={17.4} cy={13.2} r={1.05} {...filled} />
        </>
      ) : null}

      {name === 'share' || name === 'upload' ? (
        <>
          <Path d="M12 16V4.6" {...stroked} />
          <Path d="M7.8 8.8 12 4.6l4.2 4.2" {...stroked} />
          <Path d="M4.5 14.5v3A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-3" {...stroked} />
        </>
      ) : null}

      {name === 'download' ? (
        <>
          {/* The same shape as upload, turned over, so a file arriving and a
              file leaving read as one pair rather than two ideas. */}
          <Path d="M12 4.6V16" {...stroked} />
          <Path d="M7.8 11.8 12 16l4.2-4.2" {...stroked} />
          <Path d="M4.5 14.5v3A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-3" {...stroked} />
        </>
      ) : null}

      {name === 'you' ? (
        <>
          <Circle cx={12} cy={8.6} r={3.6} {...stroked} />
          <Path d="M5.2 19.4a6.8 6.8 0 0 1 13.6 0" {...stroked} />
        </>
      ) : null}

      {name === 'radar' ? (
        <>
          {/* A sweep looking for someone: rings, and a mark that has not been
              found yet. Used wherever the app is between states. */}
          <Circle cx={12} cy={12} r={2} {...filled} />
          <Circle cx={12} cy={12} r={5.4} {...stroked} opacity={0.7} />
          <Circle cx={12} cy={12} r={9} {...stroked} opacity={0.35} />
          <Path d="M12 12 18 6" {...stroked} />
        </>
      ) : null}

      {name === 'signal' ? (
        <>
          {/* Bars, so "nobody is connected" and "the link is weak" share a
              vocabulary rather than each inventing one. */}
          <Path d="M4.5 15.5v3.2" {...stroked} />
          <Path d="M9.5 12.5v6.2" {...stroked} opacity={0.75} />
          <Path d="M14.5 9v9.7" {...stroked} opacity={0.5} />
          <Path d="M19.5 5.4v13.3" {...stroked} opacity={0.3} />
        </>
      ) : null}

      {name === 'qr' ? (
        <>
          <Rect x={4} y={4} width={6} height={6} rx={1.4} {...stroked} />
          <Rect x={14} y={4} width={6} height={6} rx={1.4} {...stroked} />
          <Rect x={4} y={14} width={6} height={6} rx={1.4} {...stroked} />
          <Path d="M14 14h2.6v2.6H14zM19 17.4v2.6h-2.6" {...stroked} />
        </>
      ) : null}

      {name === 'camera' ? (
        <>
          <Path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h7A2.5 2.5 0 0 1 16 8.5v7A2.5 2.5 0 0 1 13.5 18h-7A2.5 2.5 0 0 1 4 15.5z" {...stroked} />
          <Path d="M16 11l4-2.4v6.8L16 13z" {...stroked} />
        </>
      ) : null}

      {name === 'lock' ? (
        <>
          <Rect x={5} y={10.5} width={14} height={9.5} rx={2.4} {...stroked} />
          <Path d="M8.4 10.5V8a3.6 3.6 0 0 1 7.2 0v2.5" {...stroked} />
          <Circle cx={12} cy={15.2} r={1.15} {...filled} />
        </>
      ) : null}

      {name === 'wave' ? (
        <>
          {/* A hand raised - hello and goodbye, which is what it is used for.
              Four fingers and a thumb, because a hand without a thumb reads as
              a comb; the thumb is the outer curve on the left. */}
          <Path d="M9.4 11.8V6.4a1.45 1.45 0 0 1 2.9 0v5" {...stroked} />
          <Path d="M12.3 11.4V5.2a1.45 1.45 0 0 1 2.9 0v6.2" {...stroked} />
          <Path d="M15.2 11.8V7.4a1.45 1.45 0 0 1 2.9 0v6.9a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6V9.9a1.45 1.45 0 0 1 2.9 0v2.2" {...stroked} />
        </>
      ) : null}

      {name === 'dice' ? (
        <>
          <Rect x={4.5} y={4.5} width={15} height={15} rx={3.4} {...stroked} />
          <Circle cx={9} cy={9} r={1.15} {...filled} />
          <Circle cx={15} cy={9} r={1.15} {...filled} />
          <Circle cx={12} cy={12} r={1.15} {...filled} />
          <Circle cx={9} cy={15} r={1.15} {...filled} />
          <Circle cx={15} cy={15} r={1.15} {...filled} />
        </>
      ) : null}

      {name === 'puzzle' ? (
        <Path
          d="M10 4.8a1.9 1.9 0 0 1 3.8 0c0 .5.4.9.9.9h2.1a1.2 1.2 0 0 1 1.2 1.2v2.6c0 .5.4.9.9.9a1.9 1.9 0 0 1 0 3.8c-.5 0-.9.4-.9.9V17a1.2 1.2 0 0 1-1.2 1.2h-2.6c-.5 0-.9.4-.9.9a1.9 1.9 0 0 1-3.8 0c0-.5-.4-.9-.9-.9H6.2A1.2 1.2 0 0 1 5 17V6.9a1.2 1.2 0 0 1 1.2-1.2h2.9c.5 0 .9-.4.9-.9z"
          {...stroked}
        />
      ) : null}

      {name === 'hourglass' ? (
        <>
          <Path d="M7 4h10M7 20h10" {...stroked} />
          <Path d="M8 4v3.2L12 12l4-4.8V4" {...stroked} />
          <Path d="M8 20v-3.2L12 12l4 4.8V20" {...stroked} />
        </>
      ) : null}

      {name === 'blocked' ? (
        <>
          <Circle cx={12} cy={12} r={8.2} {...stroked} />
          <Line x1={6.5} y1={17.5} x2={17.5} y2={6.5} {...stroked} />
        </>
      ) : null}

      {name === 'inbox' ? (
        <>
          {/* An open tray, which is what "no answer" and "nothing here" mean. */}
          <Path d="M4 13.5 6.4 5.8A1.6 1.6 0 0 1 8 4.6h8a1.6 1.6 0 0 1 1.6 1.2L20 13.5" {...stroked} />
          <Path d="M4 13.5h4.2l1 2.2h5.6l1-2.2H20v3.9A2 2 0 0 1 18 19.4H6a2 2 0 0 1-2-2z" {...stroked} />
        </>
      ) : null}

      {name === 'smile' ? (
        <>
          <Circle cx={12} cy={12} r={8.2} {...stroked} />
          <Circle cx={9.4} cy={10.2} r={1.05} {...filled} />
          <Circle cx={14.6} cy={10.2} r={1.05} {...filled} />
          <Path d="M8.6 14.4a4.4 4.4 0 0 0 6.8 0" {...stroked} />
        </>
      ) : null}

      {name === 'start' ? (
        <>
          <Circle cx={12} cy={12} r={8.2} {...stroked} />
          <Path d="M10.2 8.8 15.4 12l-5.2 3.2z" {...filled} />
        </>
      ) : null}

      {name === 'warning' ? (
        <>
          <Path d="M12 4.8 20.4 19a1 1 0 0 1-.9 1.5H4.5a1 1 0 0 1-.9-1.5z" {...stroked} />
          <Path d="M12 10v4.4" {...stroked} />
          <Circle cx={12} cy={17.4} r={1.1} {...filled} />
        </>
      ) : null}

      {name === 'chevronLeft' ? <Path d="M15 5 8 12l7 7" {...stroked} strokeWidth={2.1} /> : null}

      {name === 'pause' ? (
        <>
          <Rect x={7.6} y={5.4} width={3.2} height={13.2} rx={1.4} {...filled} />
          <Rect x={13.2} y={5.4} width={3.2} height={13.2} rx={1.4} {...filled} />
        </>
      ) : null}

      {name === 'replay' ? (
        <>
          {/* A full circle back to the beginning, which is what replay means -
              as opposed to the partial arcs used for the ten-second skips. */}
          <Path d="M20 12a8 8 0 1 1-3.3-6.5" {...stroked} />
          <Path d="M20.4 4.2v4.4H16" {...stroked} />
        </>
      ) : null}

      {name === 'skipBack' ? (
        <>
          <Path d="M4 12a8 8 0 1 0 3.3-6.5" {...stroked} />
          <Path d="M3.6 4.2v4.4H8" {...stroked} />
          {/* The number is the point: these are ten-second jumps, not seeks. */}
          <Path d="M10.4 14.6v3.4M13.4 14.6h1.8v3.4h-1.8z" {...stroked} strokeWidth={1.4} />
        </>
      ) : null}

      {name === 'skipForward' ? (
        <>
          <Path d="M20 12a8 8 0 1 1-3.3-6.5" {...stroked} />
          <Path d="M20.4 4.2v4.4H16" {...stroked} />
          <Path d="M10.4 14.6v3.4M13.4 14.6h1.8v3.4h-1.8z" {...stroked} strokeWidth={1.4} />
        </>
      ) : null}

      {name === 'image' ? (
        <>
          <Rect x={3.6} y={5} width={16.8} height={14} rx={2.4} {...stroked} />
          <Circle cx={9} cy={10} r={1.6} {...stroked} />
          <Path d="M4.4 17 9.6 12.4l3.2 2.8 3-2.4 4 3.6" {...stroked} />
        </>
      ) : null}

      {name === 'video' ? (
        <>
          <Rect x={3.6} y={5.4} width={16.8} height={13.2} rx={2.4} {...stroked} />
          <Path d="M3.6 9.4h16.8M3.6 14.6h16.8" {...stroked} opacity={0.4} />
          <Path d="M7.4 5.4v13.2M16.6 5.4v13.2" {...stroked} opacity={0.4} />
        </>
      ) : null}

      {name === 'audio' ? (
        <>
          <Path d="M9.4 15.4V6.2l8-1.6v9.2" {...stroked} />
          <Circle cx={7.2} cy={16.4} r={2.6} {...stroked} />
          <Circle cx={15.2} cy={14.6} r={2.4} {...stroked} />
        </>
      ) : null}

      {name === 'document' ? (
        <>
          <Path d="M6 4.6h7L18 9.6v9.8a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4V6a1.4 1.4 0 0 1 1.4-1.4z" {...stroked} />
          <Path d="M13 4.6v5h5" {...stroked} />
          <Path d="M7.8 13.4h6.4M7.8 16.4h4.4" {...stroked} opacity={0.55} />
        </>
      ) : null}
    </Svg>
  );
}
