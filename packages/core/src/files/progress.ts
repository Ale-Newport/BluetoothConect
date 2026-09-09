/**
 * Progress, measured throughput and the strings the UI shows.
 *
 * The ETA is computed from what the link is ACTUALLY doing, never from the
 * transport's nominal rate. A BLE profile advertises 40 KB/s; a phone in a
 * pocket, behind a body, sharing the 2.4 GHz band with a microwave, delivers a
 * fraction of that. Quoting the nominal figure produces the single most
 * infuriating bug in file-transfer UI - a countdown that never counts down.
 */
import { TransferState, type TransferDirection, type TransferProgress } from './types.js';

/**
 * Exponentially weighted throughput estimate.
 *
 * A half-life rather than a fixed window: samples arrive at whatever rate
 * chunks are acknowledged, which on a BLE link is irregular, and weighting them
 * by elapsed time rather than by count keeps a burst of eight tiny chunks from
 * outvoting the ten seconds of silence before it.
 */
export class ThroughputEstimator {
  private lastBytes = 0;
  private lastAt = 0;
  private started = false;
  private ewma: number | null = null;

  constructor(private readonly halfLifeMs = 3000) {}

  /** Restart the estimate. Called when a transfer resumes on a new link. */
  reset(bytes: number, now: number): void {
    this.started = true;
    this.lastBytes = bytes;
    this.lastAt = now;
    this.ewma = null;
  }

  /** Feed the running total. Non-monotonic or zero-duration updates are ignored. */
  update(totalBytes: number, now: number): void {
    if (!this.started) {
      this.reset(totalBytes, now);
      return;
    }
    const elapsed = now - this.lastAt;
    const moved = totalBytes - this.lastBytes;
    if (elapsed <= 0 || moved <= 0) return;

    const sample = (moved / elapsed) * 1000;
    // alpha rises towards 1 as the gap approaches the half-life, so a long
    // silence weighs more heavily than a rapid succession of small samples.
    const alpha = 1 - Math.exp(-elapsed / this.halfLifeMs);
    this.ewma = this.ewma === null ? sample : this.ewma + alpha * (sample - this.ewma);
    this.lastBytes = totalBytes;
    this.lastAt = now;
  }

  /** Bytes per second, or null before the first usable sample. */
  get bytesPerSecond(): number | null {
    return this.ewma;
  }

  /** Milliseconds since the last time the byte count moved. */
  idleMs(now: number): number {
    return this.started ? Math.max(0, now - this.lastAt) : 0;
  }

  etaMs(remainingBytes: number): number | null {
    if (this.ewma === null || this.ewma <= 0) return null;
    if (remainingBytes <= 0) return 0;
    return Math.round((remainingBytes / this.ewma) * 1000);
  }
}

export interface ProgressInput {
  readonly transferId: string;
  readonly direction: TransferDirection;
  readonly filename: string;
  readonly state: TransferState;
  readonly totalBytes: number;
  readonly transferredBytes: number;
  readonly throughput: ThroughputEstimator;
  readonly now: number;
  readonly stallAfterMs: number;
}

export function buildProgress(input: ProgressInput): TransferProgress {
  const total = Math.max(0, input.totalBytes);
  const done = Math.max(0, Math.min(total, input.transferredBytes));
  const complete = input.state === TransferState.COMPLETED;
  return {
    transferId: input.transferId,
    direction: input.direction,
    filename: input.filename,
    state: input.state,
    totalBytes: total,
    transferredBytes: done,
    percent: percentOf(done, total, complete),
    bytesPerSecond: input.throughput.bytesPerSecond,
    etaMs: complete ? 0 : input.throughput.etaMs(total - done),
    stalled:
      input.state === TransferState.TRANSFERRING &&
      done < total &&
      input.throughput.idleMs(input.now) >= input.stallAfterMs,
  };
}

/**
 * Percentage for display. It never reads 100 until the transfer really is
 * finished - a progress bar that sits at "100%" while the receiver is still
 * verifying the file is a bug report waiting to happen.
 */
export function percentOf(transferred: number, total: number, complete: boolean): number {
  if (complete) return 100;
  if (total <= 0) return 0;
  return Math.min(99, Math.round((transferred / total) * 100));
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Decimal (1000-based) units, matching what iOS Files and Android show for the
 * same file. Binary units would render a photo the OS calls 4.2 MB as 4.0 MB,
 * and the user would be right to trust the OS over us.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const rendered = value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  return `${rendered} ${SIZE_UNITS[unit]}`;
}

/** Short, human duration: "45s", "3m 20s", "1h 04m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The line the UI shows: "42.8 MB / 120 MB - 36%". */
export function formatTransferProgress(progress: TransferProgress): string {
  return `${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)} - ${progress.percent}%`;
}

/** The second line: "1.2 MB/s - 3m 20s left", or an honest "stalled". */
export function formatTransferRate(progress: TransferProgress): string {
  if (progress.stalled) return 'stalled';
  if (progress.bytesPerSecond === null) return 'estimating...';
  const rate = `${formatBytes(progress.bytesPerSecond)}/s`;
  return progress.etaMs === null ? rate : `${rate} - ${formatDuration(progress.etaMs)} left`;
}
