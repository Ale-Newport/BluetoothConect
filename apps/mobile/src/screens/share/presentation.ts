import {
  TransferDirection,
  TransferState,
  formatBytes,
  formatDuration,
  formatTransferProgress,
  type TransferProgress,
} from '@airlink/core';
import { strings } from '@airlink/config';
import type { StatusTone } from '../../ui/index.js';
import type { TransferRecord } from './transferCenter.js';
import { shareStrings } from './strings.js';

/**
 * A transfer, in words.
 *
 * Everything a person reads about a transfer is decided here rather than in
 * JSX, for two reasons. The screens then contain layout and nothing else, and -
 * more importantly - the rules about what a state is CALLED live in one place.
 * The rule that matters most: a transfer that has stopped moving is "Paused",
 * never "Failed", because the bytes already on disk are still good and it picks
 * up by itself the moment the two phones can see each other again.
 */

/** Where a record sits in the Share tab. */
export const TransferGroup = {
  /** An incoming offer nobody has answered yet. */
  WAITING: 'waiting',
  /** Moving, or paused and waiting for the link to come back. */
  ACTIVE: 'active',
  /** Over, one way or another. */
  FINISHED: 'finished',
} as const;
export type TransferGroup = (typeof TransferGroup)[keyof typeof TransferGroup];

export function groupOf(record: TransferRecord): TransferGroup {
  switch (record.state) {
    case TransferState.OFFERED:
      return record.direction === TransferDirection.INCOMING ? TransferGroup.WAITING : TransferGroup.ACTIVE;
    case TransferState.TRANSFERRING:
    case TransferState.VERIFYING:
      return TransferGroup.ACTIVE;
    default:
      return TransferGroup.FINISHED;
  }
}

export function isIncoming(record: TransferRecord): boolean {
  return record.direction === TransferDirection.INCOMING;
}

/** True while a progress bar is worth showing. */
export function isMoving(record: TransferRecord): boolean {
  return record.state === TransferState.TRANSFERRING || record.state === TransferState.VERIFYING;
}

/**
 * The one line that says what is happening.
 *
 * Note the ordering: `paused` is checked before the state, because a paused
 * transfer is still TRANSFERRING as far as the protocol is concerned and the
 * person holding the phone needs to be told the truth about why nothing is
 * moving before they are told what it is doing.
 */
export function statusLine(record: TransferRecord): string {
  if (record.paused && !isTerminal(record)) return strings.share.paused;
  switch (record.state) {
    case TransferState.OFFERED:
      return isIncoming(record) ? shareStrings.incomingFrom(record.peerName) : shareStrings.waitingForThem(record.peerName);
    case TransferState.TRANSFERRING:
      if (record.transferredBytes === 0) return shareStrings.startingUp;
      return isIncoming(record) ? strings.share.receiving : strings.share.sending;
    case TransferState.VERIFYING:
      return shareStrings.verifying;
    case TransferState.COMPLETED:
      return isIncoming(record) ? shareStrings.received : strings.share.complete;
    case TransferState.DECLINED:
      return record.failure ?? (isIncoming(record) ? shareStrings.declinedByYou : shareStrings.declinedByThem(record.peerName));
    case TransferState.CANCELLED:
      return record.failure ?? shareStrings.stopped;
    case TransferState.FAILED:
    default:
      return record.failure ?? strings.share.failed;
  }
}

/**
 * The dot beside the name.
 *
 * A paused transfer gets the same quiet grey as a peer who has walked out of
 * range, because that is exactly what it is. Amber is only for something a
 * person may want to do about; the app's one red belongs to `Label tone` below
 * and only to a real failure.
 */
export function statusTone(record: TransferRecord): StatusTone {
  if (record.paused && !isTerminal(record)) return 'disconnected';
  switch (record.state) {
    case TransferState.OFFERED:
      return 'connecting';
    case TransferState.TRANSFERRING:
    case TransferState.VERIFYING:
    case TransferState.COMPLETED:
      return 'connected';
    case TransferState.FAILED:
      return 'warning';
    default:
      return 'disconnected';
  }
}

/**
 * Which tone the status line is drawn in.
 *
 * Only FAILED earns danger: a declined or stopped transfer is a decision
 * somebody made, not something that went wrong.
 */
export function statusTextTone(record: TransferRecord): 'primary' | 'secondary' | 'danger' | 'connected' {
  if (record.state === TransferState.FAILED) return 'danger';
  if (record.state === TransferState.COMPLETED) return 'connected';
  return 'secondary';
}

export function isTerminal(record: TransferRecord): boolean {
  return groupOf(record) === TransferGroup.FINISHED;
}

/** "To Maria", "From Maria", or nothing while a name is still unknown. */
export function peerPhrase(record: TransferRecord): string {
  if (record.peerName.length === 0) return '';
  return isIncoming(record) ? shareStrings.fromPerson(record.peerName) : shareStrings.toPerson(record.peerName);
}

/**
 * The one line under a filename: "Sending · To Maria", "Received · From Maria ·
 * 4.2 MB", or a failure in its own words.
 *
 * Assembled here rather than in the row so that the three things it refuses to
 * do are decided once. It never repeats a name the status has already used, it
 * never prints the total size next to a progress line that is already showing
 * it, and it never dilutes a failure sentence by appending a recipient to it.
 */
export function summaryLine(record: TransferRecord): string {
  const status = statusLine(record);
  if (record.failure !== null && isTerminal(record)) return status;

  const parts = [status];
  // OFFERED already reads "Waiting for Maria to accept…" either way round.
  if (record.state !== TransferState.OFFERED) {
    const who = peerPhrase(record);
    if (who.length > 0) parts.push(who);
  }
  if (!isMoving(record) && !record.paused) parts.push(formatBytes(record.totalBytes));
  return parts.join(' · ');
}

/**
 * "42.8 MB / 120 MB - 36%".
 *
 * Built by core's own formatter rather than a second copy of the arithmetic, so
 * the percentage the user sees is the one the protocol tested: it never reads
 * 100 until the file really has been verified.
 */
export function progressLine(record: TransferRecord): string {
  return formatTransferProgress(asProgress(record));
}

/**
 * "1.2 MB/s · 3m 20s left".
 *
 * Null while there is nothing honest to say - a paused transfer has no rate,
 * and quoting the last one it managed would be a countdown that never counts
 * down. The rate itself is MEASURED throughput from the protocol, never the
 * transport's nominal figure.
 */
export function rateLine(record: TransferRecord): string | null {
  if (record.paused || !isMoving(record)) return null;
  if (record.bytesPerSecond === null || record.bytesPerSecond <= 0) return shareStrings.estimating;
  const rate = shareStrings.perSecond(formatBytes(record.bytesPerSecond));
  return record.etaMs === null ? shareStrings.rateOnly(rate) : shareStrings.rateAndEta(rate, formatDuration(record.etaMs));
}

/** A `TransferProgress` shaped from a record, so core's formatters can be reused. */
function asProgress(record: TransferRecord): TransferProgress {
  return {
    transferId: record.id,
    direction: record.direction,
    filename: record.filename,
    state: record.state,
    totalBytes: record.totalBytes,
    transferredBytes: record.transferredBytes,
    percent: record.percent,
    bytesPerSecond: record.bytesPerSecond,
    etaMs: record.etaMs,
    stalled: record.paused,
  };
}

// ---------------------------------------------------------------------------
// Showing a name a stranger chose
// ---------------------------------------------------------------------------

/**
 * Bidirectional and invisible formatting characters, stripped before display.
 *
 * The protocol already refuses separators, NUL and the C0 controls, so an
 * incoming filename cannot escape a directory or truncate a path. What it
 * cannot refuse is a name that is legal everywhere and still lies to the eye: a
 * RIGHT-TO-LEFT OVERRIDE (U+202E) placed before "gnp.exe" renders as
 * "exe.png" in every text engine on both platforms, and that is the whole of
 * the attack. Rendering order is a display concern, so it is fixed here, at the
 * one point where a peer's string becomes something a person reads.
 *
 * Note this is for DISPLAY only. The name never becomes a path: `diskNameFor`
 * derives a fresh one, and the file lands in a directory named by transfer id.
 */
const UNSAFE_DISPLAY = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u00AD\uFEFF]/g;

export function safeDisplayName(filename: string): string {
  const cleaned = filename.replace(UNSAFE_DISPLAY, '').trim();
  return cleaned.length > 0 ? cleaned : shareStrings.unnamedFile;
}

// ---------------------------------------------------------------------------
// What kind of thing it is
// ---------------------------------------------------------------------------

export const FileKind = {
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
} as const;
export type FileKind = (typeof FileKind)[keyof typeof FileKind];

export function kindOf(mimeType: string, filename: string): FileKind {
  if (mimeType.startsWith('image/')) return FileKind.IMAGE;
  if (mimeType.startsWith('video/')) return FileKind.VIDEO;
  if (mimeType.startsWith('audio/')) return FileKind.AUDIO;
  // A peer may send an empty mime type; the extension is the only other clue,
  // and it decides an icon rather than anything that touches the file.
  const dot = filename.lastIndexOf('.');
  const extension = dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
  if (['jpg', 'jpeg', 'png', 'heic', 'gif', 'webp'].includes(extension)) return FileKind.IMAGE;
  if (['mp4', 'mov', 'm4v', 'avi', 'mkv'].includes(extension)) return FileKind.VIDEO;
  if (['mp3', 'm4a', 'wav', 'aac'].includes(extension)) return FileKind.AUDIO;
  return FileKind.DOCUMENT;
}

/**
 * Typographic marks rather than emoji.
 *
 * The tab bar already sets this vocabulary (◎ ✉ ◆ ↑ ●) and it is the difference
 * between an app and a toy. They are also the one thing on the row that carries
 * no meaning a blind user needs, so they are hidden from the screen reader.
 */
export const KIND_GLYPH: Record<FileKind, string> = {
  [FileKind.IMAGE]: '▣',
  [FileKind.VIDEO]: '▶',
  [FileKind.AUDIO]: '♪',
  [FileKind.DOCUMENT]: '▤',
};
