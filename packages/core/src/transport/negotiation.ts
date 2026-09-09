/**
 * Transport ranking and negotiation.
 *
 * Two phones almost never have the same set of radios usable at the same
 * moment: an iPhone and an Android have only BLE in common, two iPhones can
 * reach tens of MB/s over AWDL, and either pair can be on the same cafe Wi-Fi
 * with no route to the internet. Negotiation is the small piece of pure logic
 * that turns "what I can do" plus "what you said you can do" into an ORDERED
 * list of things to try.
 *
 * It returns a list rather than a winner on purpose. Opening a radio link fails
 * for reasons no capability record can predict - the peer's Wi-Fi dropped, the
 * OS refused the socket, the user walked into a lift - and a caller that has the
 * runner-up already in hand can fall through to it instead of giving up.
 *
 * Every value that came from the peer is treated as hostile: the kind list is
 * length-bounded, deduplicated and filtered to names this build understands, and
 * numeric fields of a profile are sanitised before they reach a comparison, so a
 * NaN cannot make the sort order non-deterministic.
 */
import { TransportKind, isTransportKind } from '../protocol/capabilities.js';
import type { TransportProfile } from './types.js';

/**
 * Hard cap on how many transports we will consider from one peer. The capability
 * decoder already bounds the list; this bounds it again at the point of use,
 * because the record may also arrive from a cache, a QR code or a future
 * protocol version.
 */
export const MAX_NEGOTIATED_TRANSPORTS = 16;

/**
 * Reference profiles, one per transport kind.
 *
 * The numbers come from docs/TRANSPORTS.md and the measurements in the
 * implementation plan. A real Transport supplies its own profile - these are the
 * fallback used when we must reason about a transport we have not registered
 * (typically the one the session is currently sitting on).
 */
export const DEFAULT_TRANSPORT_PROFILES: Readonly<Record<TransportKind, TransportProfile>> = {
  [TransportKind.MOCK]: {
    kind: TransportKind.MOCK,
    preference: 0,
    expectedThroughputBytesPerSecond: 1_000_000,
    expectedRttMs: 5,
    highBandwidth: true,
    canDiscover: true,
    crossPlatform: true,
    worksInBackground: true,
  },
  [TransportKind.BLE]: {
    kind: TransportKind.BLE,
    // The floor. Never the best choice, always the fallback that works between
    // any two phones, and the only transport that survives backgrounding.
    preference: 10,
    expectedThroughputBytesPerSecond: 20_000,
    expectedRttMs: 60,
    highBandwidth: false,
    canDiscover: true,
    crossPlatform: true,
    worksInBackground: true,
  },
  [TransportKind.WIFI_AWARE]: {
    // Deliberately ranked BELOW BLE: iPhone <-> Android Aware is broken on real
    // handsets in 2026 and the pairing ceremony is user-hostile. The profile
    // exists so an adapter can slot in, but nothing will ever upgrade TO it
    // unless a caller overrides the preference.
    kind: TransportKind.WIFI_AWARE,
    preference: 5,
    expectedThroughputBytesPerSecond: 5_000_000,
    expectedRttMs: 20,
    highBandwidth: true,
    canDiscover: true,
    crossPlatform: false,
    worksInBackground: false,
  },
  [TransportKind.LOCAL_NETWORK]: {
    kind: TransportKind.LOCAL_NETWORK,
    preference: 50,
    expectedThroughputBytesPerSecond: 2_000_000,
    expectedRttMs: 12,
    highBandwidth: true,
    canDiscover: true,
    crossPlatform: true,
    worksInBackground: false,
  },
  [TransportKind.WIFI_DIRECT]: {
    kind: TransportKind.WIFI_DIRECT,
    preference: 60,
    expectedThroughputBytesPerSecond: 4_000_000,
    expectedRttMs: 15,
    highBandwidth: true,
    canDiscover: true,
    crossPlatform: false,
    worksInBackground: false,
  },
  [TransportKind.PEER_TO_PEER_WIFI]: {
    kind: TransportKind.PEER_TO_PEER_WIFI,
    preference: 70,
    expectedThroughputBytesPerSecond: 20_000_000,
    expectedRttMs: 8,
    highBandwidth: true,
    canDiscover: true,
    crossPlatform: false,
    worksInBackground: false,
  },
};

/** The reference profile for a kind. Never throws, so it is safe on a hot path. */
export function defaultProfileFor(kind: TransportKind): TransportProfile {
  return DEFAULT_TRANSPORT_PROFILES[kind];
}

function clampFinite(value: number, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Log2 of 16 MB/s - the point beyond which more throughput stops mattering. */
const MAX_THROUGHPUT_SCORE = 24;

/**
 * A single number expressing "how good is this transport", for ranking and for
 * Developer Mode.
 *
 * `preference` dominates because it is the field a platform integrator uses to
 * express knowledge the numbers cannot carry (an entitlement, a battery cost, a
 * flaky vendor stack). Throughput breaks ties inside one preference band, on a
 * log scale so 4 MB/s does not swamp 2 MB/s, and latency breaks ties inside one
 * throughput band. The three bands cannot overflow into one another.
 */
export function transportScore(profile: TransportProfile): number {
  const preference = clampFinite(profile.preference, 0, -1000, 1000);
  const throughput = clampFinite(profile.expectedThroughputBytesPerSecond, 0, 0, 1e12);
  const rttMs = clampFinite(profile.expectedRttMs, 1000, 0, 600_000);
  const throughputScore = Math.min(MAX_THROUGHPUT_SCORE, Math.log2(Math.max(1, throughput)));
  const latencyScore = 1 / (1 + rttMs);
  return preference * 1000 + throughputScore * 10 + latencyScore;
}

/** Sort comparator, best first. Ties break on the kind name so sorts are stable. */
export function compareTransportProfiles(a: TransportProfile, b: TransportProfile): number {
  const delta = transportScore(b) - transportScore(a);
  if (delta !== 0) return delta;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/** True when moving from `from` to `to` is genuinely an improvement. */
export function isTransportUpgrade(from: TransportProfile, to: TransportProfile): boolean {
  return transportScore(to) > transportScore(from);
}

/**
 * Turn a peer-supplied transport list into something safe to iterate.
 * Unknown names are dropped (a newer peer may advertise a radio this build has
 * never heard of), duplicates collapse, and the list is truncated.
 */
export function sanitizeTransportKinds(values: readonly unknown[] | undefined): TransportKind[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<TransportKind>();
  const out: TransportKind[] = [];
  for (const value of values) {
    if (out.length >= MAX_NEGOTIATED_TRANSPORTS) break;
    if (!isTransportKind(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export interface TransportCandidate {
  readonly kind: TransportKind;
  readonly profile: TransportProfile;
  readonly score: number;
}

export interface TransportNegotiationOptions {
  /** Kinds to leave out, e.g. one that has already failed this session. */
  readonly exclude?: readonly TransportKind[];
  /** Only return candidates that beat this profile. Used for upgrade decisions. */
  readonly betterThan?: TransportProfile;
  /** Drop transports that cannot move a photo at a tolerable rate. */
  readonly requireHighBandwidth?: boolean;
  /** Drop transports that only work between two devices of the same platform. */
  readonly requireCrossPlatform?: boolean;
}

/**
 * The ordered list of transports both sides can use, best first.
 *
 * @param local profiles this device can actually use RIGHT NOW - the caller is
 *   expected to have filtered out radios that are off or lack permission.
 * @param peerTransports the peer's `PeerCapabilities.transports`. Untrusted.
 */
export function negotiateTransports(
  local: readonly TransportProfile[],
  peerTransports: readonly TransportKind[] | undefined,
  options: TransportNegotiationOptions = {},
): TransportCandidate[] {
  const peerSet = new Set(sanitizeTransportKinds(peerTransports));
  if (peerSet.size === 0) return [];
  const excluded = new Set(options.exclude ?? []);
  const floor = options.betterThan ? transportScore(options.betterThan) : Number.NEGATIVE_INFINITY;

  const seen = new Set<TransportKind>();
  const candidates: TransportCandidate[] = [];
  for (const profile of local) {
    // A local list is our own code, but it can still be built from a native
    // bridge, so bad entries are skipped rather than trusted.
    if (!profile || !isTransportKind(profile.kind)) continue;
    if (seen.has(profile.kind) || !peerSet.has(profile.kind) || excluded.has(profile.kind)) continue;
    if (options.requireHighBandwidth && !profile.highBandwidth) continue;
    if (options.requireCrossPlatform && !profile.crossPlatform) continue;
    const score = transportScore(profile);
    if (score <= floor) continue;
    seen.add(profile.kind);
    candidates.push({ kind: profile.kind, profile, score });
  }

  candidates.sort((a, b) => compareTransportProfiles(a.profile, b.profile));
  return candidates;
}

/** The single best transport both sides support, or null when there is none. */
export function bestCommonTransport(
  local: readonly TransportProfile[],
  peerTransports: readonly TransportKind[] | undefined,
  options: TransportNegotiationOptions = {},
): TransportCandidate | null {
  return negotiateTransports(local, peerTransports, options)[0] ?? null;
}
