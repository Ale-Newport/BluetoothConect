import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * The tab bar icons.
 *
 * Drawn rather than typed. Two earlier attempts failed for the same reason: a
 * glyph is only as reliable as the font behind it. Geometric characters like
 * U+2709 ENVELOPE rendered as empty boxes at tab-bar weight, and emoji do not
 * render at all in some environments - the iOS simulator on the machine this
 * was built on shows every one as a missing-glyph box.
 *
 * These are paths, so they render identically everywhere, tint with the active
 * colour like a native tab bar, and scale without a second asset. Apple uses SF
 * Symbols here for exactly the same reasons; this is the same idea with no
 * dependency.
 *
 * A 24x24 box with a 1.75 stroke matches the weight of the system tab bar.
 */
const BOX = 24;
const STROKE = 1.75;

export type TabIconName = 'home' | 'chat' | 'play' | 'share' | 'you';

export function TabIcon({
  name,
  color,
  size = 26,
}: {
  name: TabIconName;
  color: string;
  size?: number;
}): React.JSX.Element {
  const common = {
    stroke: color,
    strokeWidth: STROKE,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${BOX} ${BOX}`}>
      {name === 'home' ? (
        <>
          {/* Concentric arcs: a signal going out, which is what Home does. */}
          <Circle cx={12} cy={12} r={2.2} fill={color} stroke="none" />
          <Path d="M6.8 7.4a7 7 0 0 0 0 9.2" {...common} />
          <Path d="M17.2 7.4a7 7 0 0 1 0 9.2" {...common} />
          <Path d="M3.6 4.6a11 11 0 0 0 0 14.8" {...common} opacity={0.45} />
          <Path d="M20.4 4.6a11 11 0 0 1 0 14.8" {...common} opacity={0.45} />
        </>
      ) : null}

      {name === 'chat' ? (
        <Path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4.6 3.6A.5.5 0 0 1 4.6 19V16A2.5 2.5 0 0 1 4 13.5z" {...common} />
      ) : null}

      {name === 'play' ? (
        <>
          {/* A controller, reduced to its silhouette. */}
          <Rect x={3} y={7.5} width={18} height={9} rx={4.5} {...common} />
          <Path d="M7.4 12h2.4M8.6 10.8v2.4" {...common} />
          <Circle cx={15.4} cy={11.2} r={1.05} fill={color} stroke="none" />
          <Circle cx={17.4} cy={13.2} r={1.05} fill={color} stroke="none" />
        </>
      ) : null}

      {name === 'share' ? (
        <>
          <Path d="M12 16V4.6" {...common} />
          <Path d="M7.8 8.8 12 4.6l4.2 4.2" {...common} />
          <Path d="M4.5 14.5v3A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-3" {...common} />
        </>
      ) : null}

      {name === 'you' ? (
        <>
          <Circle cx={12} cy={8.6} r={3.6} {...common} />
          <Path d="M5.2 19.4a6.8 6.8 0 0 1 13.6 0" {...common} />
        </>
      ) : null}
    </Svg>
  );
}
