/**
 * Connection quality, as the user sees it.
 *
 * There are exactly four labels, and they are the only connection vocabulary
 * the product has: excellent, good, weak, reconnecting. RSSI, RTT, packet loss
 * and transport names are engineering facts; they belong in Developer Mode, not
 * on a chat screen. Somebody sitting on a plane wants to know whether their
 * message will arrive, not that they are on a -78 dBm GATT link.
 *
 * Two decisions are worth spelling out:
 *
 *  - Bluetooth can never be "excellent". A flawless BLE link still moves about
 *    20 KB/s, so a photo takes minutes. Calling that excellent would set an
 *    expectation the radio cannot meet, so the honest ceiling on a
 *    low-bandwidth transport is "good".
 *  - The label is hysteretic. Raw metrics jitter constantly, and a badge that
 *    flickers between "good" and "weak" reads as broken software rather than as
 *    a busy radio, so a change must be confirmed by consecutive samples.
 *    Dropping to "reconnecting" is exempt: that one the user must see at once.
 */
import type { TransportKind } from '../protocol/capabilities.js';
import type { LinkMetrics } from './types.js';
import { defaultProfileFor } from './negotiation.js';

export const ConnectionQuality = {
  EXCELLENT: 'excellent',
  GOOD: 'good',
  WEAK: 'weak',
  /** No usable link at this instant. The session and its keys survive. */
  RECONNECTING: 'reconnecting',
} as const;
export type ConnectionQuality = (typeof ConnectionQuality)[keyof typeof ConnectionQuality];

const QUALITY_RANK: Record<ConnectionQuality, number> = {
  [ConnectionQuality.RECONNECTING]: 0,
  [ConnectionQuality.WEAK]: 1,
  [ConnectionQuality.GOOD]: 2,
  [ConnectionQuality.EXCELLENT]: 3,
};

/**
 * Fallback English copy. The shipping app localises these from
 * `packages/config`; they live here so a headless build (tests, the network
 * harness, Developer Mode) still has something to print.
 */
export const CONNECTION_QUALITY_LABEL: Record<ConnectionQuality, string> = {
  [ConnectionQuality.EXCELLENT]: 'Excellent',
  [ConnectionQuality.GOOD]: 'Good',
  [ConnectionQuality.WEAK]: 'Weak',
  [ConnectionQuality.RECONNECTING]: 'Reconnecting',
};

/**
 * Thresholds, in one table so they can be tuned against real hardware without
 * hunting through branches. Each row caps the label; the worst cap wins.
 */
export const QUALITY_THRESHOLDS = {
  /** Above this round trip, the link is only "good"; above the second, "weak". */
  rttGoodMs: 250,
  rttWeakMs: 700,
  /** Fraction of datagrams lost. BLE with a wall in the way looks like this. */
  lossGood: 0.02,
  lossWeak: 0.15,
  /** dBm. -80 is roughly "same room, through a body"; -90 is on the edge. */
  rssiGood: -75,
  rssiWeak: -88,
  /** Below this sustained rate a photo is measured in minutes, not seconds. */
  throughputGoodBytesPerSecond: 200_000,
} as const;

export interface QualitySignals {
  /** False whenever there is no link carrying the session right now. */
  readonly connected: boolean;
  readonly transport?: TransportKind;
  readonly rttMs?: number;
  /** Fraction in [0,1]. */
  readonly packetLossRate?: number;
  /** dBm, negative. Only BLE reports it. */
  readonly rssi?: number;
  readonly throughputBytesPerSecond?: number;
}

/** Ignore a metric that is missing, non-numeric or non-finite rather than trusting it. */
function metric(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function worse(a: ConnectionQuality, b: ConnectionQuality): ConnectionQuality {
  return QUALITY_RANK[b] < QUALITY_RANK[a] ? b : a;
}

/**
 * Map raw link metrics onto the label the user sees.
 *
 * Metrics come from a native bridge, so every one of them is optional and every
 * one of them is range-checked. A transport that reports nothing at all still
 * produces a sensible answer from its own profile.
 */
export function classifyConnectionQuality(signals: QualitySignals): ConnectionQuality {
  if (!signals.connected) return ConnectionQuality.RECONNECTING;

  let quality: ConnectionQuality = ConnectionQuality.EXCELLENT;

  const rtt = metric(signals.rttMs);
  if (rtt !== null) {
    if (rtt >= QUALITY_THRESHOLDS.rttWeakMs) quality = worse(quality, ConnectionQuality.WEAK);
    else if (rtt >= QUALITY_THRESHOLDS.rttGoodMs) quality = worse(quality, ConnectionQuality.GOOD);
  }

  const loss = metric(signals.packetLossRate);
  if (loss !== null) {
    const clamped = Math.min(1, Math.max(0, loss));
    if (clamped >= QUALITY_THRESHOLDS.lossWeak) quality = worse(quality, ConnectionQuality.WEAK);
    else if (clamped >= QUALITY_THRESHOLDS.lossGood) quality = worse(quality, ConnectionQuality.GOOD);
  }

  const rssi = metric(signals.rssi);
  // A positive "dBm" is a bridge bug, not a miraculous signal: ignore it.
  if (rssi !== null && rssi < 0) {
    if (rssi <= QUALITY_THRESHOLDS.rssiWeak) quality = worse(quality, ConnectionQuality.WEAK);
    else if (rssi <= QUALITY_THRESHOLDS.rssiGood) quality = worse(quality, ConnectionQuality.GOOD);
  }

  const throughput = metric(signals.throughputBytesPerSecond);
  if (throughput !== null && throughput >= 0 && throughput < QUALITY_THRESHOLDS.throughputGoodBytesPerSecond) {
    quality = worse(quality, ConnectionQuality.GOOD);
  }

  if (signals.transport !== undefined) {
    // The transport itself caps the ceiling: a low-bandwidth radio is never
    // "excellent" no matter how clean its numbers look.
    const profile = defaultProfileFor(signals.transport);
    if (profile && !profile.highBandwidth) quality = worse(quality, ConnectionQuality.GOOD);
  }

  return quality;
}

/** Convenience: classify straight from a Link's metrics. */
export function connectionQualityFromLink(
  metrics: LinkMetrics | null | undefined,
  options: { connected: boolean },
): ConnectionQuality {
  if (!options.connected || !metrics) return ConnectionQuality.RECONNECTING;
  const sent = metrics.packetsSent;
  const dropped = metrics.packetsDropped;
  const lossRate =
    Number.isFinite(sent) && Number.isFinite(dropped) && sent > 0 ? Math.min(1, Math.max(0, dropped / sent)) : undefined;
  return classifyConnectionQuality({
    connected: true,
    transport: metrics.transport,
    ...(metrics.rttMs !== undefined ? { rttMs: metrics.rttMs } : {}),
    ...(metrics.rssi !== undefined ? { rssi: metrics.rssi } : {}),
    ...(lossRate !== undefined ? { packetLossRate: lossRate } : {}),
    ...(metrics.throughputBytesPerSecond !== undefined
      ? { throughputBytesPerSecond: metrics.throughputBytesPerSecond }
      : {}),
  });
}

export function isBetterQuality(a: ConnectionQuality, b: ConnectionQuality): boolean {
  return QUALITY_RANK[a] > QUALITY_RANK[b];
}

/**
 * Smooths the label so the badge does not flicker.
 *
 * A change needs `confirmations` consecutive samples that agree, EXCEPT a drop
 * to `reconnecting`, which is applied at once - the user is entitled to know
 * immediately that their message is not going anywhere.
 */
export class ConnectionQualityTracker {
  private quality: ConnectionQuality;
  private candidate: ConnectionQuality | null = null;
  private candidateCount = 0;
  private readonly confirmations: number;

  constructor(options: { initial?: ConnectionQuality; confirmations?: number } = {}) {
    this.quality = options.initial ?? ConnectionQuality.RECONNECTING;
    // At least one sample, or the label could never change at all.
    this.confirmations = Math.max(1, Math.floor(options.confirmations ?? 2));
  }

  get current(): ConnectionQuality {
    return this.quality;
  }

  /** Feed a sample. Returns the new label when it changed, otherwise null. */
  update(signals: QualitySignals): ConnectionQuality | null {
    return this.observe(classifyConnectionQuality(signals));
  }

  /** Feed an already-classified label. Same contract as `update`. */
  observe(next: ConnectionQuality): ConnectionQuality | null {
    if (next === this.quality) {
      this.candidate = null;
      this.candidateCount = 0;
      return null;
    }
    if (next === ConnectionQuality.RECONNECTING) {
      this.quality = next;
      this.candidate = null;
      this.candidateCount = 0;
      return next;
    }
    if (this.candidate !== next) {
      this.candidate = next;
      this.candidateCount = 1;
    } else {
      this.candidateCount++;
    }
    if (this.candidateCount < this.confirmations) return null;
    this.quality = next;
    this.candidate = null;
    this.candidateCount = 0;
    return next;
  }

  reset(quality: ConnectionQuality = ConnectionQuality.RECONNECTING): void {
    this.quality = quality;
    this.candidate = null;
    this.candidateCount = 0;
  }
}
