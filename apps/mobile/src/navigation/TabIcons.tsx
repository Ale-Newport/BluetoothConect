import React from 'react';
import { Icon, type IconName } from '../ui/index.js';

/**
 * The tab bar icons.
 *
 * A thin wrapper over the app's one icon set rather than a second set of paths:
 * the tab bar and the empty states used to be drawn by different files, which
 * is how two icon vocabularies start. See ui/Icon.tsx for why none of these are
 * characters.
 */
export type TabIconName = Extract<IconName, 'home' | 'chat' | 'play' | 'share' | 'you'>;

export function TabIcon({
  name,
  color,
  size = 26,
}: {
  name: TabIconName;
  color: string;
  size?: number;
}): React.JSX.Element {
  return <Icon name={name} color={color} size={size} />;
}
