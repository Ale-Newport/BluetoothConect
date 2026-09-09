/**
 * Local clock synchronisation, NTP-style.
 *
 * Two phones watching the same film need to agree on "now" to within a few tens
 * of milliseconds, and their wall clocks routinely differ by seconds. There is
 * no time server available offline, so the peers measure the offset between
 * themselves directly.
 *
 * For each probe:
 *
 *   t1  requester's clock when the request was sent
 *   t2  responder's clock when the request arrived
 *   t3  responder's clock when the response was sent
 *   t4  requester's clock when the response arrived
 *
 *   roundTrip = (t4 - t1) - (t3 - t2)
 *   offset    = ((t2 - t1) + (t3 - t4)) / 2
 *
 * The estimate keeps the sample with the LOWEST round-trip time from each round,
 * which is standard NTP practice: the shortest round trip is the one least
 * distorted by queueing, and on a Bluetooth link queueing delay is the dominant
 * source of error.
 */
import { decodeCbor, encodeCbor, type CborValue } from '../protocol/cbor.js';
import { TIMING } from '../protocol/constants.js';
import type { Clock, TimerHandle } from '../util/time.js';

export interface ClockSample {
  readonly offsetMs: number;
  readonly roundTripMs: number;
  readonly at: number;
}

interface PendingProbe {
  readonly id: number;
  readonly t1: number;
}

export class ClockSynchronizer {
  private nextId = 1;
  private readonly pending = new Map<number, PendingProbe>();
  private readonly samples: ClockSample[] = [];
  private best: ClockSample | null = null;
  private timer: TimerHandle | undefined;
  private roundRemaining = 0;

  constructor(
    private readonly clock: Clock,
    private readonly sendRequest: (payload: CborValue) => void,
    private readonly historyLimit = 32,
  ) {}

  /**
   * Best estimate of `peerClock - localClock`, in milliseconds.
   * Null until at least one probe has completed.
   */
  get offsetMs(): number | null {
    return this.best?.offsetMs ?? null;
  }

  /** Round-trip time of the sample the current offset came from. */
  get roundTripMs(): number | null {
    return this.best?.roundTripMs ?? null;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Convert a local wall-clock instant into the peer's frame of reference. */
  toPeerTime(localWallMs: number): number {
    return localWallMs + (this.best?.offsetMs ?? 0);
  }

  /** Convert an instant expressed in the peer's clock into ours. */
  toLocalTime(peerWallMs: number): number {
    return peerWallMs - (this.best?.offsetMs ?? 0);
  }

  /** Run one round of probes and keep the best sample. */
  startRound(samples: number = TIMING.clockSyncSamples): void {
    this.roundRemaining = samples;
    this.probe();
  }

  /** Probe periodically for as long as a sync session is running. */
  startPeriodic(intervalMs: number = TIMING.clockSyncIntervalMs): void {
    this.stopPeriodic();
    this.startRound();
    this.timer = this.clock.setInterval(() => this.startRound(), intervalMs);
  }

  stopPeriodic(): void {
    if (this.timer !== undefined) {
      this.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private probe(): void {
    if (this.roundRemaining <= 0) return;
    this.roundRemaining -= 1;
    const id = this.nextId++;
    const t1 = this.clock.wallNow();
    this.pending.set(id, { id, t1 });
    // Bound the outstanding-probe map: a peer that never answers cannot grow it.
    if (this.pending.size > 64) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.sendRequest({ i: id, a: t1 });
  }

  /** Responder side: turn a request into a response. */
  buildResponse(payload: Uint8Array): CborValue | null {
    let value: CborValue;
    try {
      value = decodeCbor(payload);
    } catch {
      return null;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return null;
    const m = value as Record<string, CborValue>;
    if (typeof m.i !== 'number' || typeof m.a !== 'number') return null;
    const t2 = this.clock.wallNow();
    return { i: m.i, a: m.a, b: t2, c: this.clock.wallNow() };
  }

  /** Requester side: fold a response into the estimate. */
  handleResponse(payload: Uint8Array): ClockSample | null {
    const t4 = this.clock.wallNow();
    let value: CborValue;
    try {
      value = decodeCbor(payload);
    } catch {
      return null;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return null;
    const m = value as Record<string, CborValue>;
    const id = m.i;
    if (typeof id !== 'number') return null;
    const probe = this.pending.get(id);
    if (!probe) return null;
    this.pending.delete(id);

    const t1 = probe.t1;
    const t2 = m.b;
    const t3 = m.c;
    if (typeof t2 !== 'number' || typeof t3 !== 'number') return null;
    if (!Number.isFinite(t2) || !Number.isFinite(t3)) return null;

    const roundTripMs = t4 - t1 - (t3 - t2);
    // A negative round trip means the peer sent nonsense timestamps.
    if (roundTripMs < 0 || roundTripMs > 60_000) return null;

    const offsetMs = (t2 - t1 + (t3 - t4)) / 2;
    if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 365 * 24 * 3600 * 1000) return null;

    const sample: ClockSample = { offsetMs, roundTripMs, at: t4 };
    this.samples.push(sample);
    if (this.samples.length > this.historyLimit) this.samples.shift();

    // Keep the lowest-latency sample: it is the least distorted.
    if (!this.best || roundTripMs < this.best.roundTripMs) this.best = sample;

    if (this.roundRemaining > 0) this.probe();
    return sample;
  }

  /** Median offset across the retained samples - useful for diagnostics. */
  medianOffsetMs(): number | null {
    if (this.samples.length === 0) return null;
    const sorted = this.samples.map((s) => s.offsetMs).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
  }

  reset(): void {
    this.pending.clear();
    this.samples.length = 0;
    this.best = null;
    this.roundRemaining = 0;
  }

  dispose(): void {
    this.stopPeriodic();
    this.reset();
  }
}

/**
 * Playback drift correction policy for the watch-together feature.
 *
 * Seeking is jarring, so it is the last resort: small drift is ignored, moderate
 * drift is absorbed by nudging the playback rate a fraction of a percent (which
 * nobody can hear), and only a large gap justifies a visible jump.
 */
export const DriftAction = {
  IGNORE: 'ignore',
  ADJUST_RATE: 'adjustRate',
  SEEK: 'seek',
} as const;
export type DriftAction = (typeof DriftAction)[keyof typeof DriftAction];

export interface DriftPolicy {
  /** Below this, do nothing at all. */
  readonly ignoreThresholdMs: number;
  /** Below this, correct by nudging the playback rate. */
  readonly rateThresholdMs: number;
  /** Largest rate deviation used for correction, as a fraction (0.02 = 2%). */
  readonly maxRateAdjustment: number;
}

export const DEFAULT_DRIFT_POLICY: DriftPolicy = {
  ignoreThresholdMs: 50,
  rateThresholdMs: 300,
  maxRateAdjustment: 0.02,
};

export interface DriftCorrection {
  readonly action: DriftAction;
  /** Playback rate to apply (1 = normal). Only meaningful for ADJUST_RATE. */
  readonly rate: number;
  /** Position to seek to, in milliseconds. Only meaningful for SEEK. */
  readonly seekToMs: number | null;
  readonly driftMs: number;
}

/**
 * @param localPositionMs where this device currently is
 * @param targetPositionMs where it should be, per the host's clock
 */
export function computeDriftCorrection(
  localPositionMs: number,
  targetPositionMs: number,
  baseRate = 1,
  policy: DriftPolicy = DEFAULT_DRIFT_POLICY,
): DriftCorrection {
  const driftMs = localPositionMs - targetPositionMs; // positive: we are ahead
  const magnitude = Math.abs(driftMs);

  if (magnitude < policy.ignoreThresholdMs) {
    return { action: DriftAction.IGNORE, rate: baseRate, seekToMs: null, driftMs };
  }
  if (magnitude < policy.rateThresholdMs) {
    // Ahead: slow down slightly. Behind: speed up slightly. Scale the nudge with
    // the drift so correction is gentle when the gap is small.
    const scale = (magnitude - policy.ignoreThresholdMs) / (policy.rateThresholdMs - policy.ignoreThresholdMs);
    const adjustment = policy.maxRateAdjustment * scale * (driftMs > 0 ? -1 : 1);
    return {
      action: DriftAction.ADJUST_RATE,
      rate: Number((baseRate * (1 + adjustment)).toFixed(4)),
      seekToMs: null,
      driftMs,
    };
  }
  return { action: DriftAction.SEEK, rate: baseRate, seekToMs: targetPositionMs, driftMs };
}
