import { colors } from '@airlink/config';

/**
 * The player's palette.
 *
 * Everywhere else in the app colour comes from `useTheme()`, which follows the
 * system scheme. The player deliberately does not: a film letterboxed against a
 * white surround is wrong in a way no amount of consistency excuses, so the
 * cinema surface is the dark palette in BOTH schemes.
 *
 * These are still tokens, not hex values - the same tokens dark mode uses. What
 * is missing from the design system is a way to force a subtree dark (a `scheme`
 * override on `ThemeProvider`, or a `cinema` group in the token file); until one
 * exists this is the honest way to say "always dark".
 */
export const cinema = colors.dark;

/**
 * A running time as people write it: 4:07 under an hour, 1:04:07 over it.
 * Never a bare millisecond count, and never negative.
 */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The speeds the rate control cycles through.
 *
 * Well inside the protocol's own [0.25, 4] bounds, and chosen so every step is
 * one a person would actually pick rather than a continuous slider nobody can
 * hit twice the same way.
 */
export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

/** "1×", "1.25×" - the value, not a sentence, so it needs no translation. */
export function formatSpeed(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}
