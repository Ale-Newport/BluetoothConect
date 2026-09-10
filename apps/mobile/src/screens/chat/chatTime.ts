import { strings } from '@airlink/config';

/**
 * Dates and times, in the user's own conventions.
 *
 * `toLocaleTimeString` is used rather than a hand-rolled formatter so a
 * twelve-hour phone reads "9:41 PM" and a twenty-four-hour phone reads "21:41"
 * without this file knowing which is which. Hermes ships Intl, but a device
 * that somehow lacks it must still show a legible time, so every call has a
 * plain fallback rather than an exception.
 */

const MS_PER_DAY = 86_400_000;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** "9:41 PM" or "21:41". The time under a bubble. */
export function clockTime(timestamp: number): string {
  const date = new Date(timestamp);
  try {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

export function isSameDay(a: number, b: number): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

/** Whole days between two instants, counted by calendar date rather than by hours. */
function daysApart(from: number, to: number): number {
  const start = new Date(from);
  const end = new Date(to);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
}

/** The pill between two days of conversation: "Today", "Yesterday", "Tuesday", "12 March". */
export function daySeparatorLabel(timestamp: number, now: number): string {
  const apart = daysApart(timestamp, now);
  if (apart <= 0) return strings.chat.today;
  if (apart === 1) return strings.chat.yesterday;
  const date = new Date(timestamp);
  try {
    if (apart < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  } catch {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
}

/** The right-hand side of a chat list row: a time today, a day this week, a date before that. */
export function listTimestamp(timestamp: number, now: number): string {
  const apart = daysApart(timestamp, now);
  if (apart <= 0) return clockTime(timestamp);
  if (apart === 1) return strings.chat.yesterday;
  const date = new Date(timestamp);
  try {
    if (apart < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch {
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
  }
}

/**
 * Whether two messages belong to the same run.
 *
 * A run is one person talking without interruption, and a long enough pause
 * ends it even when nobody else spoke - five minutes later is a new thought,
 * and deserves its own timestamp.
 */
export const RUN_BREAK_MS = 5 * 60_000;
