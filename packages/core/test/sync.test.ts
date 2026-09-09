import { describe, expect, it } from 'vitest';
import { MessageType, PROTOCOL_VERSION } from '../src/protocol/constants.js';
import { encodeCbor, type CborValue } from '../src/protocol/cbor.js';
import { TransportKind, type PeerCapabilities } from '../src/protocol/capabilities.js';
import { SeededRandom } from '../src/crypto/random.js';
import { createIdentity, type LocalIdentity } from '../src/crypto/identity.js';
import type { HandshakeConfig } from '../src/crypto/handshake.js';
import { PeerSession } from '../src/session/peerSession.js';
import { DEFAULT_DRIFT_POLICY, DriftAction } from '../src/session/clockSync.js';
import {
  BLE_LIKE_CONDITIONS,
  HOSTILE_CONDITIONS,
  MockNetwork,
  WIFI_LIKE_CONDITIONS,
  mockToken,
} from '../src/transport/mock.js';
import type { Link } from '../src/transport/types.js';
import { VirtualClock, type Clock, type TimerHandle } from '../src/util/time.js';
import { DecodeError } from '../src/util/varint.js';
import {
  DEFAULT_START_DELAY_POLICY,
  MAX_CONTENT_DURATION_MS,
  anchorSupersedes,
  computeSyncStartDelayMs,
  hasStarted,
  isValidPlaybackRate,
  isValidPositionMs,
  isValidWallClockMs,
  targetPositionAt,
  type PlaybackAnchor,
} from '../src/sync/anchor.js';
import {
  DEFAULT_SAMPLE_PLAN,
  computeSampledContentHash,
  describeContent,
  sampledWindowLength,
  sampledWindowOffsets,
  type ContentSampleReader,
  type SamplePlan,
} from '../src/sync/contentHash.js';
import {
  decodeCommand,
  decodeContentQuery,
  decodeContentReply,
  decodeFarewell,
  decodeJoin,
  decodeSessionCreate,
  encodeAnchoredCommand,
  encodeCommandRequest,
  encodeContentQuery,
  encodeContentReply,
  encodeFarewell,
  encodeJoin,
  encodeSessionCreate,
} from '../src/sync/codec.js';
import {
  ContentAvailability,
  ContentMatch,
  SyncRejectReason,
  SyncRole,
  WatchState,
  compareContent,
  type ContentDescriptor,
  type MediaController,
} from '../src/sync/types.js';
import { WatchTogetherSession, identityOf, type WatchTogetherEvents } from '../src/sync/watchSession.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Small enough to keep the suite instant, large enough that sampling engages. */
const TEST_PLAN: SamplePlan = { windowCount: 4, windowBytes: 1024 };

/** Deterministic pseudo-random bytes. No Math.random, in tests either. */
function syntheticFile(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

class FakeFile implements ContentSampleReader {
  reads = 0;
  bytesRead = 0;

  constructor(readonly bytes: Uint8Array) {}

  get byteLength(): number {
    return this.bytes.length;
  }

  read(offset: number, length: number): Uint8Array {
    this.reads++;
    this.bytesRead += length;
    return this.bytes.slice(offset, offset + length);
  }
}

/** A file too big to allocate, whose bytes are a pure function of their offset. */
class HugeFile implements ContentSampleReader {
  reads = 0;
  bytesRead = 0;

  constructor(readonly byteLength: number) {}

  read(offset: number, length: number): Uint8Array {
    this.reads++;
    this.bytesRead += length;
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (offset + i) & 0xff;
    return out;
  }
}

const FILM_BYTES = syntheticFile(64 * 1024, 0x51de);
const FILM_DURATION_MS = 90 * 60 * 1000;

async function filmDescriptor(contentId = 'film-local'): Promise<ContentDescriptor> {
  return describeContent(
    new FakeFile(FILM_BYTES),
    { contentId, durationMs: FILM_DURATION_MS, title: 'A Very Long Film', mimeType: 'video/mp4' },
    TEST_PLAN,
  );
}

/**
 * A player that behaves like the real ones in the way that matters: it advances
 * with wall-clock time, and what it REPORTS is noisier than where it actually
 * is.
 */
class FakePlayer implements MediaController {
  private playing = false;
  private rate = 1;
  private basePosition = 0;
  private baseWall: number;
  private jitterStep = 0;

  constructor(
    private readonly clock: Clock,
    private readonly options: { jitterMs?: number; driftPpm?: number } = {},
  ) {
    this.baseWall = clock.wallNow();
  }

  private exact(): number {
    if (!this.playing) return this.basePosition;
    const elapsed = this.clock.wallNow() - this.baseWall;
    const speed = this.rate * (1 + (this.options.driftPpm ?? 0) / 1_000_000);
    return this.basePosition + elapsed * speed;
  }

  private settle(): void {
    this.basePosition = this.exact();
    this.baseWall = this.clock.wallNow();
  }

  play(): void {
    if (this.playing) return;
    this.settle();
    this.playing = true;
  }

  pause(): void {
    this.settle();
    this.playing = false;
  }

  seek(positionMs: number): void {
    this.basePosition = positionMs;
    this.baseWall = this.clock.wallNow();
  }

  setRate(rate: number): void {
    this.settle();
    this.rate = rate;
  }

  getPosition(): number {
    const jitter = this.options.jitterMs ?? 0;
    if (jitter === 0) return this.exact();
    // A deterministic sawtooth stands in for the platforms' reporting noise.
    const offsets = [0, 1, -1, 0.6, -0.6, 0.9, -0.9];
    this.jitterStep = (this.jitterStep + 1) % offsets.length;
    return Math.max(0, this.exact() + (offsets[this.jitterStep] ?? 0) * jitter);
  }

  // -- test-only inspection --------------------------------------------------
  get isPlaying(): boolean {
    return this.playing;
  }

  get appliedRate(): number {
    return this.rate;
  }

  /** Where the player really is, with no reporting noise. */
  get exactPosition(): number {
    return this.exact();
  }

  /** Simulate a buffer stall: real time passed, playback did not. */
  stall(ms: number): void {
    this.settle();
    this.basePosition -= ms;
  }
}

/** A player whose every method throws, to prove the module survives one. */
class BrokenPlayer implements MediaController {
  play(): void {
    throw new Error('player exploded');
  }
  pause(): void {
    throw new Error('player exploded');
  }
  seek(): void {
    throw new Error('player exploded');
  }
  setRate(): void {
    throw new Error('player exploded');
  }
  getPosition(): number {
    throw new Error('player exploded');
  }
}

// ---------------------------------------------------------------------------
// Two-peer harness (connectPair, from test/session.test.ts)
// ---------------------------------------------------------------------------

function caps(name: string, deviceId: string): PeerCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '0.1.0',
    platform: 'node',
    deviceModel: 'simulator',
    displayName: name,
    deviceId,
    transports: [TransportKind.MOCK],
    features: ['chat', 'games', 'files', 'sync'],
    games: [],
    maxPayloadBytes: 65536,
  };
}

interface Device {
  identity: LocalIdentity;
  config: HandshakeConfig;
  trust: Map<string, Uint8Array>;
}

function makeDevice(name: string, seed: number): Device {
  const random = new SeededRandom(seed);
  const identity = createIdentity(random, 1000);
  const trust = new Map<string, Uint8Array>();
  const config: HandshakeConfig = {
    identity,
    capabilities: caps(name, `device-${name}`),
    random,
    lookupTrustedKey: (peerId) => trust.get(peerId),
  };
  return { identity, config, trust };
}

/**
 * A clock that shares the virtual timeline but sits `skewMs` off in wall-clock
 * terms - which is the normal state of two phones, and the whole reason
 * ClockSynchronizer exists. Without this the test would prove nothing about the
 * clock conversion, because both devices would already agree on "now".
 */
function skewedClock(base: VirtualClock, skewMs: number): Clock {
  return {
    now: () => base.now(),
    wallNow: () => base.wallNow() + skewMs,
    setTimeout: (fn: () => void, ms: number): TimerHandle => base.setTimeout(fn, ms),
    clearTimeout: (handle: TimerHandle) => base.clearTimeout(handle),
    setInterval: (fn: () => void, ms: number): TimerHandle => base.setInterval(fn, ms),
    clearInterval: (handle: TimerHandle) => base.clearInterval(handle),
  };
}

async function connectPair(
  options: { conditions?: Partial<typeof BLE_LIKE_CONDITIONS>; clockSkewMs?: number } = {},
) {
  const clock = new VirtualClock();
  const clockB = skewedClock(clock, options.clockSkewMs ?? 0);
  const network = new MockNetwork(clock, 0xa11);
  if (options.conditions) network.setConditions(options.conditions);

  const alejandro = makeDevice('Alejandro', 101);
  const maria = makeDevice('Maria', 202);
  alejandro.trust.set(maria.identity.peerId, maria.identity.signing.publicKey);
  maria.trust.set(alejandro.identity.peerId, alejandro.identity.signing.publicKey);

  const transportA = network.createTransport('endpoint-a');
  const transportB = network.createTransport('endpoint-b');

  await transportA.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: mockToken(1), displayName: 'Alejandro' });
  await transportB.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: mockToken(2), displayName: 'Maria' });
  await transportA.startDiscovery();

  const sessionA = new PeerSession('endpoint-b', { clock, handshake: alejandro.config });
  const sessionB = new PeerSession('endpoint-a', { clock: clockB, handshake: maria.config });

  let incoming: Link | undefined;
  transportB.events.on('incomingLink', ({ link }) => {
    incoming = link;
    if (sessionB.isSecure) sessionB.migrateToLink(link);
    else sessionB.startAsResponder(link);
  });

  const connectPromise = transportA.connect('endpoint-b');
  await clock.advanceAsync(200);
  const linkA = await connectPromise;
  await sessionA.startAsInitiator(linkA);
  // A hostile link retransmits the handshake several times, so wait for it
  // rather than assuming a fixed budget.
  for (let i = 0; i < 200 && !(sessionA.isSecure && sessionB.isSecure); i++) {
    await clock.advanceAsync(250, 25);
  }

  return { clock, clockB, network, sessionA, sessionB, linkA, incoming };
}

interface WatchPair {
  clock: VirtualClock;
  clockB: Clock;
  network: MockNetwork;
  sessionA: PeerSession;
  sessionB: PeerSession;
  watchA: WatchTogetherSession;
  watchB: WatchTogetherSession;
  playerA: FakePlayer;
  playerB: FakePlayer;
  content: ContentDescriptor;
  run(ms: number): Promise<void>;
}

async function watchPair(
  options: {
    conditions?: Partial<typeof BLE_LIKE_CONDITIONS>;
    clockSkewMs?: number;
    jitterMs?: number;
    driftPpmB?: number;
    guestContent?: ContentDescriptor | null;
    correctionIntervalMs?: number;
  } = {},
): Promise<WatchPair> {
  const ctx = await connectPair({
    ...(options.conditions ? { conditions: options.conditions } : {}),
    clockSkewMs: options.clockSkewMs ?? 7531,
  });
  const content = await filmDescriptor();
  const playerA = new FakePlayer(ctx.clock, { jitterMs: options.jitterMs ?? 0 });
  const playerB = new FakePlayer(ctx.clockB, {
    jitterMs: options.jitterMs ?? 0,
    ...(options.driftPpmB !== undefined ? { driftPpm: options.driftPpmB } : {}),
  });

  const common = {
    correctionIntervalMs: options.correctionIntervalMs ?? 250,
    heartbeatIntervalMs: 1000,
    clockSyncIntervalMs: 5000,
  };
  const watchA = new WatchTogetherSession({
    session: ctx.sessionA,
    clock: ctx.clock,
    media: playerA,
    random: new SeededRandom(7),
    ...common,
  });
  const watchB = new WatchTogetherSession({
    session: ctx.sessionB,
    clock: ctx.clockB,
    media: playerB,
    random: new SeededRandom(8),
    ...common,
  });
  watchA.setLocalContent(content);
  const guestContent =
    options.guestContent === undefined ? { ...content, contentId: 'film-on-marias-phone' } : options.guestContent;
  watchB.setLocalContent(guestContent);

  return {
    clock: ctx.clock,
    clockB: ctx.clockB,
    network: ctx.network,
    sessionA: ctx.sessionA,
    sessionB: ctx.sessionB,
    watchA,
    watchB,
    playerA,
    playerB,
    content,
    run: (ms: number) => ctx.clock.advanceAsync(ms, 20),
  };
}

/** Query, create and join. Leaves both devices paused on the same frame. */
async function startSession(pair: WatchPair): Promise<void> {
  pair.watchA.queryPeerContent();
  await pair.run(1500);
  pair.watchA.create();
  await pair.run(2500);
}

function collect<K extends keyof WatchTogetherEvents>(
  watch: WatchTogetherSession,
  event: K,
): WatchTogetherEvents[K][] {
  const out: WatchTogetherEvents[K][] = [];
  watch.events.on(event, (payload) => out.push(payload));
  return out;
}

// ---------------------------------------------------------------------------
// Anchor maths
// ---------------------------------------------------------------------------

const BASE_ANCHOR: PlaybackAnchor = {
  epoch: 4,
  positionMs: 60_000,
  hostWallClockMs: 1_700_000_000_000,
  rate: 1,
  playing: true,
};

describe('playback anchor', () => {
  it('projects position along the line at the anchor rate', () => {
    expect(targetPositionAt(BASE_ANCHOR, BASE_ANCHOR.hostWallClockMs)).toBe(60_000);
    expect(targetPositionAt(BASE_ANCHOR, BASE_ANCHOR.hostWallClockMs + 5_000)).toBe(65_000);
    expect(targetPositionAt({ ...BASE_ANCHOR, rate: 2 }, BASE_ANCHOR.hostWallClockMs + 5_000)).toBe(70_000);
  });

  it('never advances a paused anchor', () => {
    const paused = { ...BASE_ANCHOR, playing: false };
    expect(targetPositionAt(paused, paused.hostWallClockMs + 3_600_000)).toBe(60_000);
  });

  it('holds a scheduled start on its own frame until the instant arrives', () => {
    const scheduled = { ...BASE_ANCHOR, hostWallClockMs: BASE_ANCHOR.hostWallClockMs + 300 };
    expect(hasStarted(scheduled, BASE_ANCHOR.hostWallClockMs)).toBe(false);
    expect(targetPositionAt(scheduled, BASE_ANCHOR.hostWallClockMs)).toBe(60_000);
    expect(targetPositionAt(scheduled, BASE_ANCHOR.hostWallClockMs + 299)).toBe(60_000);
    expect(hasStarted(scheduled, scheduled.hostWallClockMs)).toBe(true);
    expect(targetPositionAt(scheduled, scheduled.hostWallClockMs + 1_000)).toBe(61_000);
  });

  it('clamps a projection to the duration and to zero', () => {
    expect(targetPositionAt(BASE_ANCHOR, BASE_ANCHOR.hostWallClockMs + 1_000_000, 70_000)).toBe(70_000);
    const backwards = { ...BASE_ANCHOR, positionMs: 0 };
    expect(targetPositionAt(backwards, backwards.hostWallClockMs - 10_000)).toBe(0);
  });

  it('only lets an anchor move forward', () => {
    expect(anchorSupersedes(BASE_ANCHOR, null)).toBe(true);
    expect(anchorSupersedes({ ...BASE_ANCHOR, epoch: 5 }, BASE_ANCHOR)).toBe(true);
    expect(anchorSupersedes({ ...BASE_ANCHOR, epoch: 3 }, BASE_ANCHOR)).toBe(false);
    // A duplicate of the anchor we already hold changes nothing.
    expect(anchorSupersedes(BASE_ANCHOR, BASE_ANCHOR)).toBe(false);
    // A heartbeat inside the same epoch wins only when it is strictly later.
    const heartbeat = { ...BASE_ANCHOR, hostWallClockMs: BASE_ANCHOR.hostWallClockMs + 2_000, positionMs: 62_000 };
    expect(anchorSupersedes(heartbeat, BASE_ANCHOR)).toBe(true);
    expect(anchorSupersedes(BASE_ANCHOR, heartbeat)).toBe(false);
  });

  it('derives the shared start delay from the measured round trip', () => {
    const policy = DEFAULT_START_DELAY_POLICY;
    // No measurement yet: the floor, which still beats "now".
    expect(computeSyncStartDelayMs(null)).toBe(policy.minMs);
    expect(computeSyncStartDelayMs(20)).toBe(policy.minMs);
    expect(computeSyncStartDelayMs(400)).toBe(Math.round(400 * policy.rttMultiplier + policy.guardMs));
    // However bad the link, the user is not made to wait for ever.
    expect(computeSyncStartDelayMs(60_000)).toBe(policy.maxMs);
    expect(computeSyncStartDelayMs(Number.NaN)).toBe(policy.minMs);
    expect(computeSyncStartDelayMs(-5)).toBe(policy.minMs);
  });

  it('validates every number that can arrive from a peer', () => {
    expect(isValidPlaybackRate(1)).toBe(true);
    expect(isValidPlaybackRate(-1)).toBe(false);
    expect(isValidPlaybackRate(0)).toBe(false);
    expect(isValidPlaybackRate(1e9)).toBe(false);
    expect(isValidPlaybackRate(Number.NaN)).toBe(false);
    expect(isValidPlaybackRate('1')).toBe(false);
    expect(isValidPositionMs(0)).toBe(true);
    expect(isValidPositionMs(-1)).toBe(false);
    expect(isValidPositionMs(MAX_CONTENT_DURATION_MS + 1)).toBe(false);
    expect(isValidPositionMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidWallClockMs(1_700_000_000_000)).toBe(true);
    expect(isValidWallClockMs(-1)).toBe(false);
    expect(isValidWallClockMs(9e15)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sampled content hash
// ---------------------------------------------------------------------------

describe('sampled content hash', () => {
  it('spreads windows from byte zero to exactly EOF', () => {
    const offsets = sampledWindowOffsets(64 * 1024, TEST_PLAN);
    expect(offsets.length).toBe(TEST_PLAN.windowCount);
    expect(offsets[0]).toBe(0);
    const last = offsets[offsets.length - 1] as number;
    expect(last + sampledWindowLength(64 * 1024, last, TEST_PLAN)).toBe(64 * 1024);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i] as number).toBeGreaterThan(offsets[i - 1] as number);
  });

  it('hashes a small file whole rather than sampling it', () => {
    expect(sampledWindowOffsets(2000, TEST_PLAN)).toEqual([0]);
    expect(sampledWindowLength(2000, 0, TEST_PLAN)).toBe(2000);
    expect(sampledWindowOffsets(0, TEST_PLAN)).toEqual([]);
  });

  it('reads a bounded number of bytes however large the file is', async () => {
    const huge = new HugeFile(4 * 1024 * 1024 * 1024);
    await computeSampledContentHash(huge, DEFAULT_SAMPLE_PLAN);
    expect(huge.reads).toBe(DEFAULT_SAMPLE_PLAN.windowCount);
    expect(huge.bytesRead).toBe(DEFAULT_SAMPLE_PLAN.windowCount * DEFAULT_SAMPLE_PLAN.windowBytes);
  });

  it('is stable for the same bytes and different for a changed sampled byte', async () => {
    const a = await computeSampledContentHash(new FakeFile(FILM_BYTES), TEST_PLAN);
    const b = await computeSampledContentHash(new FakeFile(FILM_BYTES), TEST_PLAN);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(32);

    const tampered = FILM_BYTES.slice();
    tampered[10] = (tampered[10] as number) ^ 0xff; // inside the first window
    const c = await computeSampledContentHash(new FakeFile(tampered), TEST_PLAN);
    expect(Array.from(c)).not.toEqual(Array.from(a));
  });

  it('does NOT notice a byte outside every window - the documented trade-off', async () => {
    const offsets = sampledWindowOffsets(FILM_BYTES.length, TEST_PLAN);
    // Find a byte that no window covers: just past the end of the first one.
    const gap = (offsets[0] as number) + TEST_PLAN.windowBytes + 1;
    expect(gap).toBeLessThan(offsets[1] as number);

    const edited = FILM_BYTES.slice();
    edited[gap] = (edited[gap] as number) ^ 0xff;
    const a = await computeSampledContentHash(new FakeFile(FILM_BYTES), TEST_PLAN);
    const b = await computeSampledContentHash(new FakeFile(edited), TEST_PLAN);
    // This is a strong integrity check, not a cryptographic commitment, and the
    // module says so. Asserting it keeps the claim honest.
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('separates two files of different length even when the windows agree', async () => {
    const shorter = FILM_BYTES.slice(0, FILM_BYTES.length - 1);
    const a = await computeSampledContentHash(new FakeFile(FILM_BYTES), TEST_PLAN);
    const b = await computeSampledContentHash(new FakeFile(shorter), TEST_PLAN);
    expect(Array.from(b)).not.toEqual(Array.from(a));
  });

  it('separates two plans, so a version skew reports a mismatch not a match', async () => {
    const a = await computeSampledContentHash(new FakeFile(FILM_BYTES), TEST_PLAN);
    const b = await computeSampledContentHash(new FakeFile(FILM_BYTES), { windowCount: 8, windowBytes: 1024 });
    expect(Array.from(b)).not.toEqual(Array.from(a));
  });

  it('refuses a short read rather than producing a plausible digest', async () => {
    const truncating: ContentSampleReader = {
      byteLength: 64 * 1024,
      read: (_offset, length) => new Uint8Array(Math.max(0, length - 1)),
    };
    await expect(computeSampledContentHash(truncating, TEST_PLAN)).rejects.toThrow(/short read/);
  });

  it('rejects an absurd file size', () => {
    expect(() => sampledWindowOffsets(-1, TEST_PLAN)).toThrow();
    expect(() => sampledWindowOffsets(Number.MAX_SAFE_INTEGER, TEST_PLAN)).toThrow();
    expect(() => sampledWindowOffsets(1024, { windowCount: 1, windowBytes: 16 })).toThrow();
  });
});

describe('content matching', () => {
  it('matches identical descriptors and explains every mismatch', async () => {
    const local = await filmDescriptor('a');
    const remote = await filmDescriptor('b');
    expect(compareContent(local, remote)).toBe(ContentMatch.MATCH);
    expect(compareContent(local, { ...remote, byteLength: remote.byteLength + 1 })).toBe(ContentMatch.SIZE_MISMATCH);
    expect(compareContent(local, { ...remote, sampledHash: new Uint8Array(32) })).toBe(ContentMatch.HASH_MISMATCH);
    expect(compareContent(local, { ...remote, durationMs: remote.durationMs + 60_000 })).toBe(
      ContentMatch.DURATION_MISMATCH,
    );
  });

  it('tolerates the frame or two two decoders disagree about', async () => {
    const local = await filmDescriptor('a');
    expect(compareContent(local, { ...local, durationMs: local.durationMs + 40 })).toBe(ContentMatch.MATCH);
  });
});

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

describe('sync codec', () => {
  it('round-trips a content query and reply', async () => {
    const content = identityOf(await filmDescriptor());
    const query = { queryId: 'q1', content };
    const decoded = decodeContentQuery(encodeCbor(encodeContentQuery(query)));
    expect(decoded.queryId).toBe('q1');
    expect(decoded.content.byteLength).toBe(content.byteLength);
    expect(decoded.content.durationMs).toBe(content.durationMs);
    expect(Array.from(decoded.content.sampledHash)).toEqual(Array.from(content.sampledHash));
    expect(decoded.content.title).toBe('A Very Long Film');

    const reply = decodeContentReply(
      encodeCbor(encodeContentReply({ queryId: 'q1', availability: ContentAvailability.HAVE, content })),
    );
    expect(reply.availability).toBe(ContentAvailability.HAVE);
    expect(reply.content?.byteLength).toBe(content.byteLength);

    const bare = decodeContentReply(
      encodeCbor(encodeContentReply({ queryId: 'q1', availability: ContentAvailability.MISSING })),
    );
    expect(bare.content).toBeUndefined();
  });

  it('round-trips create, join and farewell', async () => {
    const content = identityOf(await filmDescriptor());
    const create = decodeSessionCreate(
      encodeCbor(encodeSessionCreate({ sessionId: 'abc', content, anchor: BASE_ANCHOR })),
    );
    expect(create.sessionId).toBe('abc');
    expect(create.anchor).toEqual(BASE_ANCHOR);
    expect(create.content.byteLength).toBe(content.byteLength);

    expect(decodeJoin(encodeCbor(encodeJoin({ sessionId: 'abc', contentConfirmed: true })))).toEqual({
      sessionId: 'abc',
      contentConfirmed: true,
    });
    expect(decodeFarewell(encodeCbor(encodeFarewell({ sessionId: 'abc', reason: 'bye' })))).toEqual({
      sessionId: 'abc',
      reason: 'bye',
    });
    expect(decodeFarewell(encodeCbor(encodeFarewell({ sessionId: 'abc' })))).toEqual({ sessionId: 'abc' });
  });

  it('distinguishes a host anchor from a guest request', () => {
    const anchored = decodeCommand(encodeCbor(encodeAnchoredCommand('abc', BASE_ANCHOR)));
    expect(anchored.anchor).toEqual(BASE_ANCHOR);

    const request = decodeCommand(encodeCbor(encodeCommandRequest('abc', { positionMs: 1234 })));
    expect(request.anchor).toBeNull();
    expect(request.positionMs).toBe(1234);

    const bare = decodeCommand(encodeCbor(encodeCommandRequest('abc')));
    expect(bare.anchor).toBeNull();
    expect(bare.positionMs).toBeUndefined();
    expect(bare.rate).toBeUndefined();
  });

  it('rejects a partial anchor rather than guessing the missing half', () => {
    const partial = encodeCbor({ s: 'abc', e: 3, p: 100, r: 1 } as CborValue);
    expect(() => decodeCommand(partial)).toThrow(DecodeError);
  });
});

describe('sync codec: hostile input', () => {
  const cases: Array<[string, CborValue]> = [
    ['a negative rate', { s: 'abc', e: 1, p: 0, w: 1, r: -1, y: true }],
    ['a zero rate', { s: 'abc', e: 1, p: 0, w: 1, r: 0, y: true }],
    ['an absurd rate', { s: 'abc', e: 1, p: 0, w: 1, r: 1e6, y: true }],
    ['a negative position', { s: 'abc', e: 1, p: -5000, w: 1, r: 1, y: true }],
    ['a position past any film', { s: 'abc', e: 1, p: MAX_CONTENT_DURATION_MS + 1, w: 1, r: 1, y: true }],
    ['an infinite position', { s: 'abc', e: 1, p: Number.POSITIVE_INFINITY, w: 1, r: 1, y: true }],
    ['a NaN wall clock', { s: 'abc', e: 1, p: 0, w: Number.NaN, r: 1, y: true }],
    ['a wall clock past the year 2100', { s: 'abc', e: 1, p: 0, w: 9e15, r: 1, y: true }],
    ['a negative epoch', { s: 'abc', e: -1, p: 0, w: 1, r: 1, y: true }],
    ['an out-of-range epoch', { s: 'abc', e: 2 ** 40, p: 0, w: 1, r: 1, y: true }],
    ['a fractional epoch', { s: 'abc', e: 1.5, p: 0, w: 1, r: 1, y: true }],
    ['a playing flag that is not a boolean', { s: 'abc', e: 1, p: 0, w: 1, r: 1, y: 1 }],
    ['a missing session id', { e: 1, p: 0, w: 1, r: 1, y: true }],
    ['a session id that is not a string', { s: 42, e: 1, p: 0, w: 1, r: 1, y: true }],
    ['an empty session id', { s: '', e: 1, p: 0, w: 1, r: 1, y: true }],
    ['an oversized session id', { s: 'x'.repeat(65), e: 1, p: 0, w: 1, r: 1, y: true }],
    ['an oversized array where a session id belongs', { s: new Array(4000).fill(1) as CborValue }],
  ];

  for (const [name, payload] of cases) {
    it(`drops ${name}`, () => {
      expect(() => decodeCommand(encodeCbor(payload))).toThrow(DecodeError);
    });
  }

  it('drops an array too large for the bounded CBOR decoder', () => {
    // 5000 elements is past DEFAULT_CBOR_LIMITS.maxCollectionSize, so this never
    // even reaches the sync decoder.
    expect(() => decodeCommand(encodeCbor(new Array(5000).fill(0) as CborValue))).toThrow(DecodeError);
  });

  it('drops a top-level item that is not a map', () => {
    expect(() => decodeCommand(encodeCbor(['abc', 1]))).toThrow(DecodeError);
    expect(() => decodeCommand(encodeCbor(7))).toThrow(DecodeError);
    expect(() => decodeCommand(new Uint8Array([0xff, 0xff]))).toThrow(DecodeError);
    expect(() => decodeCommand(new Uint8Array(0))).toThrow(DecodeError);
  });

  it('bounds every string and byte string in a content query', async () => {
    const content = identityOf(await filmDescriptor());
    const base = { q: 'q1', n: content.byteLength, d: content.durationMs, h: content.sampledHash };
    expect(() => decodeContentQuery(encodeCbor({ ...base, t: 'x'.repeat(201) }))).toThrow(DecodeError);
    expect(() => decodeContentQuery(encodeCbor({ ...base, m: 'x'.repeat(129) }))).toThrow(DecodeError);
    expect(() => decodeContentQuery(encodeCbor({ ...base, h: new Uint8Array(31) }))).toThrow(DecodeError);
    expect(() => decodeContentQuery(encodeCbor({ ...base, h: new Uint8Array(100_000) }))).toThrow(DecodeError);
    expect(() => decodeContentQuery(encodeCbor({ ...base, h: 'not bytes' }))).toThrow(DecodeError);
    expect(() => decodeContentQuery(encodeCbor({ ...base, n: -1 }))).toThrow(DecodeError);
    expect(() => decodeContentQuery(encodeCbor({ ...base, n: 2 ** 50 }))).toThrow(DecodeError);
    expect(() => decodeContentQuery(encodeCbor({ ...base, d: MAX_CONTENT_DURATION_MS + 1 }))).toThrow(DecodeError);
    expect(() => decodeContentQuery(encodeCbor({ ...base, d: 1.5 }))).toThrow(DecodeError);
  });

  it('rejects an unknown availability code', () => {
    expect(() => decodeContentReply(encodeCbor({ q: 'q1', a: 9 }))).toThrow(DecodeError);
    expect(() => decodeContentReply(encodeCbor({ q: 'q1', a: 'have' }))).toThrow(DecodeError);
  });

  it('refuses to ENCODE our own bad values, loudly', () => {
    expect(() => encodeAnchoredCommand('abc', { ...BASE_ANCHOR, rate: -1 })).toThrow(Error);
    expect(() => encodeAnchoredCommand('abc', { ...BASE_ANCHOR, epoch: -1 })).toThrow(Error);
    expect(() => encodeCommandRequest('abc', { positionMs: -1 })).toThrow(Error);
    expect(() => encodeCommandRequest('abc', { rate: 99 })).toThrow(Error);
  });
});

// ---------------------------------------------------------------------------
// Two real PeerSessions, two fake players
// ---------------------------------------------------------------------------

describe('watch together: end to end', () => {
  it('matches content, creates, joins and converges within the ignore threshold', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    const answered = collect(pair.watchA, 'contentAnswered');
    const joined = collect(pair.watchA, 'peerJoined');

    pair.watchA.queryPeerContent();
    await pair.run(1500);
    expect(answered.length).toBe(1);
    expect(answered[0]?.reply.availability).toBe(ContentAvailability.HAVE);
    expect(answered[0]?.match).toBe(ContentMatch.MATCH);
    expect(pair.watchA.currentState).toBe(WatchState.READY);

    pair.watchA.create({ startPositionMs: 30_000 });
    await pair.run(2500);
    expect(pair.watchA.currentRole).toBe(SyncRole.HOST);
    expect(pair.watchB.currentRole).toBe(SyncRole.GUEST);
    expect(pair.watchB.currentState).toBe(WatchState.FOLLOWING);
    expect(joined.length).toBe(1);
    expect(joined[0]?.contentConfirmed).toBe(true);
    // Both parked on the same frame, nothing playing yet.
    expect(pair.playerA.isPlaying).toBe(false);
    expect(pair.playerB.isPlaying).toBe(false);
    expect(pair.playerB.exactPosition).toBe(30_000);

    // The clock offset really was measured, and really is the skew we injected.
    expect(pair.sessionB.clockSync.offsetMs).not.toBeNull();
    expect(pair.sessionB.clockSync.offsetMs as number).toBeCloseTo(-7531, -1);

    pair.watchA.play();
    await pair.run(30_000);

    expect(pair.playerA.isPlaying).toBe(true);
    expect(pair.playerB.isPlaying).toBe(true);
    const drift = Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition);
    expect(drift).toBeLessThan(DEFAULT_DRIFT_POLICY.ignoreThresholdMs);
    expect(pair.playerA.exactPosition).toBeGreaterThan(30_000 + 25_000);
  });

  it('starts both players at the same shared instant, not a round trip apart', async () => {
    const pair = await watchPair({ conditions: BLE_LIKE_CONDITIONS });
    await startSession(pair);

    const startedA: number[] = [];
    const startedB: number[] = [];
    pair.watchA.events.on('playbackStarted', () => startedA.push(pair.clock.now()));
    pair.watchB.events.on('playbackStarted', () => startedB.push(pair.clock.now()));

    pair.watchA.play();
    await pair.run(4000);

    expect(startedA.length).toBe(1);
    expect(startedB.length).toBe(1);
    // Both fired on the shared instant. Without latency compensation the host
    // would have started a full one-way trip (30 ms of BLE) earlier.
    expect(Math.abs((startedA[0] as number) - (startedB[0] as number))).toBeLessThan(5);
    // ...and the instant really was scheduled into the future.
    const anchor = pair.watchA.currentAnchor as PlaybackAnchor;
    expect(anchor.playing).toBe(true);
    expect(anchor.hostWallClockMs).toBeGreaterThan(pair.clock.wallNow() - 4000 + DEFAULT_START_DELAY_POLICY.minMs - 1);
  });

  it('propagates a seek to the follower', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(5000);

    pair.watchA.seekTo(600_000);
    await pair.run(3000);

    expect(pair.playerB.exactPosition).toBeGreaterThan(600_000);
    expect(pair.playerB.exactPosition).toBeLessThan(600_000 + 3_500);
    expect(Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition)).toBeLessThan(
      DEFAULT_DRIFT_POLICY.ignoreThresholdMs,
    );
    // Both devices are on the host's new line. (The anchor POINT slides forward
    // with every heartbeat - same line, fresher point - so it is the epoch and
    // the projected target that are compared, not the raw position field.)
    expect(pair.watchB.currentAnchor?.epoch).toBe(pair.watchA.currentAnchor?.epoch);
    expect(pair.watchB.targetPositionMs as number).toBeGreaterThan(600_000);
  });

  it('lets a guest request a pause, and only the host publishes the anchor', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(4000);

    const epochBefore = pair.watchA.currentAnchor?.epoch as number;
    pair.watchB.pause();
    await pair.run(2000);

    expect(pair.playerA.isPlaying).toBe(false);
    expect(pair.playerB.isPlaying).toBe(false);
    // The guest's request produced exactly one new host anchor.
    expect(pair.watchA.currentAnchor?.epoch).toBe(epochBefore + 1);
    expect(pair.watchB.currentAnchor?.epoch).toBe(epochBefore + 1);
    expect(pair.watchA.currentAnchor?.playing).toBe(false);
  });

  it('parks a paused follower on a seek and catches it up on resume', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(6000);
    pair.watchA.pause();
    await pair.run(1500);
    expect(pair.playerB.isPlaying).toBe(false);

    // Scrub a long way while paused. A paused player cannot be nudged, so the
    // follower has to be seeked onto the frame.
    pair.watchA.seekTo(1_200_000);
    await pair.run(2000);
    expect(pair.playerB.exactPosition).toBe(1_200_000);
    expect(pair.playerB.isPlaying).toBe(false);

    pair.watchA.play();
    await pair.run(10_000);

    expect(pair.playerB.isPlaying).toBe(true);
    expect(pair.playerB.exactPosition).toBeGreaterThan(1_200_000 + 9_000);
    expect(Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition)).toBeLessThan(
      DEFAULT_DRIFT_POLICY.ignoreThresholdMs,
    );
  });

  it('nudges the rate for moderate drift and never seeks for it', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(4000);

    const seeksBefore = pair.watchB.seekCount;
    pair.playerB.stall(150); // inside the rate band: 50 ms < 150 ms < 300 ms
    await pair.run(500);
    const driftAfterStall = pair.playerB.exactPosition - pair.playerA.exactPosition;
    expect(driftAfterStall).toBeLessThan(-100);
    expect(pair.playerB.appliedRate).toBeGreaterThan(1);

    await pair.run(20_000);
    const drift = Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition);
    expect(drift).toBeLessThan(Math.abs(driftAfterStall));
    expect(pair.watchB.rateAdjustCount).toBeGreaterThan(0);
    // The whole point: audible seeking is not how moderate drift is repaired.
    expect(pair.watchB.seekCount).toBe(seeksBefore);
  });

  it('seeks a badly drifted device instead of nudging it for ever', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(20_000);

    const seeksBefore = pair.watchB.seekCount;
    const corrections = collect(pair.watchB, 'correction');
    pair.playerB.stall(9_000); // a long buffer stall: far past the rate band
    await pair.run(1000);

    expect(pair.watchB.seekCount).toBe(seeksBefore + 1);
    expect(corrections.some((c) => c.correction.action === DriftAction.SEEK)).toBe(true);
    // One seek, then straight back to doing nothing.
    const drift = Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition);
    expect(drift).toBeLessThan(DEFAULT_DRIFT_POLICY.ignoreThresholdMs);
    expect(pair.playerB.appliedRate).toBe(1);
  });

  it('holds sync despite a player whose reported position is pure noise', async () => {
    // 40 ms of reporting jitter - the platform limit this design exists for.
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS, jitterMs: 40 });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(40_000);

    // Both players are where the LINE says, not where their readings wandered.
    const drift = Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition);
    expect(drift).toBeLessThan(DEFAULT_DRIFT_POLICY.ignoreThresholdMs);
    expect(pair.watchB.seekCount).toBe(0);
  });

  it('pulls a follower whose clock runs slow back onto the line', async () => {
    // 1500 ppm is a phone with a genuinely poor crystal: 1.5 ms lost per second.
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS, driftPpmB: -1500 });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(60_000);

    const drift = Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition);
    // Left alone it would be 90 ms adrift after a minute and growing.
    expect(drift).toBeLessThan(DEFAULT_DRIFT_POLICY.rateThresholdMs);
    expect(pair.watchB.rateAdjustCount).toBeGreaterThan(0);
  });

  it('changes rate on both devices without moving the picture', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(5000);

    const before = pair.playerA.exactPosition;
    pair.watchA.setRate(2);
    await pair.run(1500);
    expect(pair.watchB.currentAnchor?.rate).toBe(2);

    await pair.run(10_000);
    // ~10 s of content per 5 s of wall clock once the rate doubled.
    expect(pair.playerA.exactPosition).toBeGreaterThan(before + 18_000);
    expect(Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition)).toBeLessThan(
      DEFAULT_DRIFT_POLICY.ignoreThresholdMs * 2,
    );
  });

  it('ends the session on both sides without touching either player', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(5000);

    const endedB = collect(pair.watchB, 'ended');
    const positionB = pair.playerB.exactPosition;
    pair.watchA.end('done for tonight');
    await pair.run(1500);

    expect(pair.watchA.currentState).toBe(WatchState.ENDED);
    expect(pair.watchB.currentState).toBe(WatchState.ENDED);
    expect(endedB[0]?.reason).toBe('done for tonight');
    // Leaving a watch party does not stop your film.
    expect(pair.playerB.isPlaying).toBe(true);
    expect(pair.playerB.exactPosition).toBeGreaterThanOrEqual(positionB);
  });

  it('lets the guest leave, and the host hears about it', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(3000);

    const endedA = collect(pair.watchA, 'ended');
    pair.watchB.leave('going to bed');
    await pair.run(1500);

    expect(pair.watchB.currentState).toBe(WatchState.ENDED);
    expect(pair.watchA.currentState).toBe(WatchState.ENDED);
    expect(endedA[0]?.reason).toBe('going to bed');
    expect(pair.playerA.isPlaying).toBe(true);
  });

  it('republishes the same line as a heartbeat, without disturbing the player', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    let heartbeats = 0;
    pair.sessionB.events.on('message', (m) => {
      if (m.type === MessageType.SYNC_HEARTBEAT) heartbeats++;
    });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(2000);

    const epoch = pair.watchB.currentAnchor?.epoch as number;
    const anchorPoint = pair.watchB.currentAnchor?.hostWallClockMs as number;
    const seeksBefore = pair.watchB.seekCount;
    await pair.run(8000);

    expect(heartbeats).toBeGreaterThan(3);
    // Same line - same epoch - with a fresher anchor point...
    expect(pair.watchB.currentAnchor?.epoch).toBe(epoch);
    expect(pair.watchB.currentAnchor?.hostWallClockMs as number).toBeGreaterThan(anchorPoint);
    // ...and the player was never touched because of one.
    expect(pair.watchB.seekCount).toBe(seeksBefore);
    expect(pair.playerB.appliedRate).toBe(1);
  });

  it('tells the app when the peer has no copy of the file', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS, guestContent: null });
    const unavailable = collect(pair.watchA, 'contentUnavailable');

    pair.watchA.queryPeerContent();
    await pair.run(1500);

    expect(unavailable.length).toBe(1);
    expect(unavailable[0]?.availability).toBe(ContentAvailability.MISSING);
    expect(pair.watchA.currentState).toBe(WatchState.IDLE);
  });

  it('reports a peer holding a different cut of the same film', async () => {
    const other = await filmDescriptor('other');
    const pair = await watchPair({
      conditions: WIFI_LIKE_CONDITIONS,
      guestContent: { ...other, byteLength: other.byteLength + 4096 },
    });
    const answered = collect(pair.watchA, 'contentAnswered');

    pair.watchA.queryPeerContent();
    await pair.run(1500);

    expect(answered[0]?.reply.availability).toBe(ContentAvailability.MISMATCH);
    expect(answered[0]?.match).toBe(ContentMatch.SIZE_MISMATCH);
    expect(pair.watchA.currentState).toBe(WatchState.IDLE);
  });

  it('surfaces an invitation instead of joining when autoJoin is off', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    // Rebuild the guest with autoJoin disabled.
    pair.watchB.dispose();
    const manual = new WatchTogetherSession({
      session: pair.sessionB,
      clock: pair.clockB,
      media: pair.playerB,
      random: new SeededRandom(9),
      autoJoin: false,
      correctionIntervalMs: 250,
    });
    manual.setLocalContent({ ...pair.content, contentId: 'guest' });
    const invited = collect(manual, 'invited');

    pair.watchA.create();
    await pair.run(1500);
    expect(invited.length).toBe(1);
    expect(invited[0]?.match).toBe(ContentMatch.MATCH);
    expect(manual.currentState).toBe(WatchState.INVITED);

    manual.join();
    await pair.run(1500);
    expect(manual.currentState).toBe(WatchState.FOLLOWING);
    manual.dispose();
  });

  it('declines an invitation without joining', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    pair.watchB.dispose();
    const manual = new WatchTogetherSession({
      session: pair.sessionB,
      clock: pair.clockB,
      media: pair.playerB,
      random: new SeededRandom(12),
      autoJoin: false,
      correctionIntervalMs: 250,
    });
    manual.setLocalContent({ ...pair.content, contentId: 'guest' });
    const endedA = collect(pair.watchA, 'ended');

    pair.watchA.create();
    await pair.run(1500);
    manual.decline('not tonight');
    await pair.run(1500);

    expect(manual.currentState).toBe(WatchState.IDLE);
    expect(manual.currentRole).toBeNull();
    expect(endedA[0]?.reason).toBe('not tonight');
    manual.dispose();
  });

  it('survives a player that throws from every method', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    pair.watchB.dispose();
    const broken = new WatchTogetherSession({
      session: pair.sessionB,
      clock: pair.clockB,
      media: new BrokenPlayer(),
      random: new SeededRandom(11),
      correctionIntervalMs: 250,
    });
    broken.setLocalContent({ ...pair.content, contentId: 'guest' });

    pair.watchA.create();
    await pair.run(1500);
    pair.watchA.play();
    await pair.run(5000);

    expect(broken.currentState).toBe(WatchState.FOLLOWING);
    expect(broken.currentAnchor?.playing).toBe(true);
    broken.dispose();
  });
});

// ---------------------------------------------------------------------------
// Degraded links
// ---------------------------------------------------------------------------

describe('watch together: degraded links', () => {
  it('completes the whole protocol over a BLE-like link and still converges', async () => {
    const pair = await watchPair({ conditions: BLE_LIKE_CONDITIONS });
    await startSession(pair);
    expect(pair.watchB.currentState).toBe(WatchState.FOLLOWING);

    pair.watchA.play();
    await pair.run(30_000);
    pair.watchA.seekTo(900_000);
    await pair.run(20_000);

    expect(pair.playerB.isPlaying).toBe(true);
    expect(pair.watchB.currentAnchor?.epoch).toBe(pair.watchA.currentAnchor?.epoch);
    expect(pair.playerB.exactPosition).toBeGreaterThan(900_000);
    expect(pair.playerB.exactPosition).toBeLessThan(900_000 + 21_000);
    expect(Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition)).toBeLessThan(
      DEFAULT_DRIFT_POLICY.ignoreThresholdMs,
    );
  });

  it('completes over a hostile link that loses, reorders and duplicates', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    // Degrade the link only after the handshake, which has no retry of its own
    // (the same caveat test/session.test.ts documents). From here on: 15%
    // reliable loss, 25% realtime loss, 20% reordering, 10% duplication, 120 ms
    // latency with 180 ms of jitter, 8 KB/s and a 160-byte MTU.
    pair.network.setConditions(HOSTILE_CONDITIONS);

    pair.watchA.queryPeerContent();
    await pair.run(20_000);
    expect(pair.watchA.currentState).toBe(WatchState.READY);

    pair.watchA.create({ startPositionMs: 10_000 });
    await pair.run(30_000);
    expect(pair.watchB.currentState).toBe(WatchState.FOLLOWING);
    expect(pair.watchB.currentRole).toBe(SyncRole.GUEST);

    pair.watchA.play();
    await pair.run(60_000);
    expect(pair.playerB.isPlaying).toBe(true);

    pair.watchA.seekTo(400_000);
    await pair.run(60_000);

    // Commands are reliable, so every one of them landed exactly once...
    expect(pair.watchB.currentAnchor?.epoch).toBe(pair.watchA.currentAnchor?.epoch);
    expect(pair.playerB.exactPosition).toBeGreaterThan(400_000);
    // ...and the two players agree to well inside a seek, on a link this bad.
    expect(Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition)).toBeLessThan(
      DEFAULT_DRIFT_POLICY.rateThresholdMs,
    );
  });
});

// ---------------------------------------------------------------------------
// A hostile peer, over a real session
// ---------------------------------------------------------------------------

describe('watch together: a hostile peer', () => {
  async function hostileSetup() {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    await startSession(pair);
    pair.watchA.play();
    await pair.run(5000);
    const rejects = collect(pair.watchB, 'rejected');
    const sessionId = pair.watchA.id as string;
    return { pair, rejects, sessionId };
  }

  /** Send a raw map from the host's PeerSession, bypassing our own encoders. */
  function inject(pair: WatchPair, messageType: number, payload: Record<string, CborValue>): void {
    pair.sessionA.sendReliable(messageType, payload);
  }

  it('drops an absurd position instead of hurling the player at it', async () => {
    const { pair, rejects, sessionId } = await hostileSetup();
    const positionBefore = pair.playerB.exactPosition;
    const epochBefore = pair.watchB.currentAnchor?.epoch as number;

    inject(pair, MessageType.SYNC_SEEK, {
      s: sessionId,
      e: 9_999,
      p: 20 * 60 * 60 * 1000, // 20 hours into a 90-minute film
      w: pair.clock.wallNow(),
      r: 1,
      y: true,
    });
    await pair.run(2000);

    expect(rejects.some((r) => r.reason === SyncRejectReason.ABSURD_POSITION)).toBe(true);
    expect(pair.watchB.currentAnchor?.epoch).toBe(epochBefore);
    expect(pair.playerB.exactPosition).toBeGreaterThan(positionBefore);
    expect(pair.playerB.exactPosition).toBeLessThan(positionBefore + 5_000);

    // ...and the session is still perfectly usable afterwards.
    pair.watchA.seekTo(300_000);
    await pair.run(3000);
    expect(pair.playerB.exactPosition).toBeGreaterThan(300_000);
    expect(pair.playerB.exactPosition).toBeLessThan(300_000 + 3_500);
    expect(Math.abs(pair.playerA.exactPosition - pair.playerB.exactPosition)).toBeLessThan(
      DEFAULT_DRIFT_POLICY.ignoreThresholdMs,
    );
  });

  it('drops a negative playback rate as malformed', async () => {
    const { pair, rejects, sessionId } = await hostileSetup();
    inject(pair, MessageType.SYNC_RATE, {
      s: sessionId,
      e: 9_999,
      p: 1000,
      w: pair.clock.wallNow(),
      r: -2,
      y: true,
    });
    await pair.run(2000);

    expect(rejects.some((r) => r.reason === SyncRejectReason.MALFORMED)).toBe(true);
    expect(pair.playerB.appliedRate).toBeGreaterThan(0);
    expect(pair.watchB.currentAnchor?.rate).toBe(1);
  });

  it('drops an anchor scheduled absurdly far into the future', async () => {
    const { pair, rejects, sessionId } = await hostileSetup();
    inject(pair, MessageType.SYNC_PLAY, {
      s: sessionId,
      e: 9_999,
      p: 1000,
      w: pair.clock.wallNow() + 3_600_000, // "start in an hour"
      r: 1,
      y: true,
    });
    await pair.run(2000);

    expect(rejects.some((r) => r.reason === SyncRejectReason.ABSURD_SCHEDULE)).toBe(true);
    expect(pair.playerB.isPlaying).toBe(true);
  });

  it('drops a stale or replayed anchor', async () => {
    const { pair, rejects, sessionId } = await hostileSetup();
    const current = pair.watchB.currentAnchor as PlaybackAnchor;

    inject(pair, MessageType.SYNC_SEEK, {
      s: sessionId,
      e: Math.max(1, current.epoch - 1),
      p: 5_000,
      w: pair.clock.wallNow(),
      r: 1,
      y: true,
    });
    await pair.run(1500);

    expect(rejects.some((r) => r.reason === SyncRejectReason.STALE_ANCHOR)).toBe(true);
    expect(pair.watchB.currentAnchor?.epoch).toBe(current.epoch);
  });

  it('drops a command aimed at a different session', async () => {
    const { pair, rejects } = await hostileSetup();
    inject(pair, MessageType.SYNC_PAUSE, {
      s: 'some-other-session',
      e: 9_999,
      p: 0,
      w: pair.clock.wallNow(),
      r: 1,
      y: false,
    });
    await pair.run(1500);

    expect(rejects.some((r) => r.reason === SyncRejectReason.WRONG_SESSION)).toBe(true);
    expect(pair.playerB.isPlaying).toBe(true);
  });

  it('drops a host command that carries no anchor at all', async () => {
    const { pair, rejects, sessionId } = await hostileSetup();
    inject(pair, MessageType.SYNC_PAUSE, { s: sessionId });
    await pair.run(1500);

    expect(rejects.some((r) => r.reason === SyncRejectReason.MISSING_ANCHOR)).toBe(true);
    expect(pair.playerB.isPlaying).toBe(true);
  });

  it('drops a truncated or nonsense payload without disturbing the session', async () => {
    const { pair, rejects } = await hostileSetup();
    const epochBefore = pair.watchB.currentAnchor?.epoch as number;
    pair.sessionA.sendReliableRaw(MessageType.SYNC_SEEK, new Uint8Array([0xa1, 0x61]));
    pair.sessionA.sendReliableRaw(MessageType.SYNC_CREATE, new Uint8Array(64).fill(0xff));
    await pair.run(2000);

    expect(rejects.filter((r) => r.reason === SyncRejectReason.MALFORMED).length).toBeGreaterThanOrEqual(1);
    expect(pair.watchB.currentState).toBe(WatchState.FOLLOWING);
    expect(pair.watchB.currentAnchor?.epoch).toBe(epochBefore);
    expect(pair.playerB.isPlaying).toBe(true);
  });

  it('ignores an epoch a guest tries to dictate', async () => {
    const { pair, sessionId } = await hostileSetup();
    const hostEpochBefore = pair.watchA.currentAnchor?.epoch as number;

    // A modified guest sends a fully-formed anchor with a huge epoch. The host
    // reads it as a plain "please pause" request and publishes its OWN anchor.
    pair.sessionB.sendReliable(MessageType.SYNC_PAUSE, {
      s: sessionId,
      e: 2_000_000,
      p: 0,
      w: pair.clockB.wallNow(),
      r: 4,
      y: false,
    });
    await pair.run(3000);

    expect(pair.watchA.currentAnchor?.epoch).toBe(hostEpochBefore + 1);
    expect(pair.watchA.currentAnchor?.rate).toBe(1);
    expect(pair.playerA.isPlaying).toBe(false);
  });

  it('throttles a guest that floods requests', async () => {
    const { pair, sessionId } = await hostileSetup();
    const epochBefore = pair.watchA.currentAnchor?.epoch as number;
    for (let i = 0; i < 20; i++) {
      pair.sessionB.sendReliable(MessageType.SYNC_PAUSE, { s: sessionId });
    }
    await pair.run(2000);

    // One honoured, the rest thrown away: a flood cannot make the host burn a
    // reliable packet per request on a 40 KB/s link.
    expect(pair.watchA.currentAnchor?.epoch).toBe(epochBefore + 1);
    expect(pair.watchA.throttledRequests).toBeGreaterThan(10);
  });

  it('rejects a heartbeat sent by a guest', async () => {
    const { pair, sessionId } = await hostileSetup();
    const rejectsA = collect(pair.watchA, 'rejected');
    pair.sessionB.sendReliable(MessageType.SYNC_HEARTBEAT, {
      s: sessionId,
      e: 500,
      p: 0,
      w: pair.clockB.wallNow(),
      r: 1,
      y: true,
    });
    await pair.run(1500);

    expect(rejectsA.some((r) => r.reason === SyncRejectReason.UNEXPECTED_ROLE)).toBe(true);
  });

  it('resolves a simultaneous create with a deterministic tie-break', async () => {
    const pair = await watchPair({ conditions: WIFI_LIKE_CONDITIONS });
    const idA = pair.watchA.create();
    const idB = pair.watchB.create();
    await pair.run(4000);

    const winner = idA < idB ? 'A' : 'B';
    // Both devices reached the same answer, with no extra negotiation.
    if (winner === 'A') {
      expect(pair.watchA.currentRole).toBe(SyncRole.HOST);
      expect(pair.watchB.currentRole).toBe(SyncRole.GUEST);
    } else {
      expect(pair.watchB.currentRole).toBe(SyncRole.HOST);
      expect(pair.watchA.currentRole).toBe(SyncRole.GUEST);
    }
    expect(pair.watchA.id).toBe(pair.watchB.id);
  });
});
