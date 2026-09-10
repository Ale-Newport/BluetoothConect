import { avatarPalette } from '@airlink/config';

/**
 * The avatar options.
 *
 * COLOURS, not emoji, and the reason is worth recording. An emoji avatar is only
 * as reliable as the font behind it: the first version offered two dozen
 * well-supported emoji and every single one rendered as an empty box in the
 * environment this was built in. An avatar the user cannot see is worse than no
 * choice at all, and there is no way to feature-detect a missing glyph at
 * runtime.
 *
 * Initials on a colour need no font beyond the one already drawing the app's
 * text. It is also what the product already does for a friend who has chosen
 * nothing - `avatarColorFor` derives a stable colour from the peer id - so
 * picking a colour makes the deliberate choice and the automatic one the same
 * shape, rather than two systems that look different.
 */
export const AVATAR_COLORS: readonly string[] = avatarPalette;

/** Human-readable names, so the swatches are not colour-only. */
export const AVATAR_COLOR_NAMES: Readonly<Record<string, string>> = {
  '#0A6CFF': 'Blue',
  '#12A150': 'Green',
  '#E5A100': 'Amber',
  '#E5484D': 'Red',
  '#8E4EC6': 'Purple',
  '#0BA5A5': 'Teal',
  '#F76808': 'Orange',
  '#D6409F': 'Pink',
  '#3E63DD': 'Indigo',
  '#46A758': 'Moss',
};

export function colorName(color: string): string {
  return AVATAR_COLOR_NAMES[color] ?? 'Colour';
}
