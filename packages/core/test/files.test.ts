import { describe, expect, it } from 'vitest';
import { MessageType, PROTOCOL_VERSION } from '../src/protocol/constants.js';
import { TransportKind, type PeerCapabilities } from '../src/protocol/capabilities.js';
import { SeededRandom } from '../src/crypto/random.js';
import { createIdentity, type LocalIdentity } from '../src/crypto/identity.js';
import type { HandshakeConfig } from '../src/crypto/handshake.js';
import { PeerSession } from '../src/session/peerSession.js';
import {
  BLE_LIKE_CONDITIONS,
  HOSTILE_CONDITIONS,
  MockNetwork,
  WIFI_LIKE_CONDITIONS,
  mockToken,
} from '../src/transport/mock.js';
import { VirtualClock } from '../src/util/time.js';
import type { CborValue } from '../src/protocol/cbor.js';
import { DecodeError } from '../src/util/varint.js';
import { bytesEqual } from '../src/util/bytes.js';
import type { Link } from '../src/transport/types.js';
import { ChunkBitmap } from '../src/files/bitmap.js';
import {
  chooseChunkSize,
  chooseRunLength,
  chunkDigest,
  chunkHeaderBytes,
  computeFileHash,
  runByteLength,
  totalChunksFor,
} from '../src/files/chunks.js';
import {
  decodeFileAccept,
  decodeFileChunk,
  decodeFileChunkAck,
  decodeFileDecline,
  decodeFileOffer,
  decodeFileResume,
  encodeFileChunk,
  encodeFileOffer,
  peekOfferBasics,
  type FileDeclineMessage,
} from '../src/files/codec.js';
import {
  ThroughputEstimator,
  formatBytes,
  formatDuration,
  formatTransferProgress,
  percentOf,
} from '../src/files/progress.js';
import { MemoryFileStore } from '../src/files/memoryStore.js';
import { FileTransferProtocol } from '../src/files/protocol.js';
import {
  DEFAULT_TUNING,
  IncomingTransfer,
  OutgoingTransfer,
  type TransferListener,
  type TransferTuning,
  type TransferWire,
} from '../src/files/transfer.js';
import {
  FILE_LIMITS,
  FileErrorCode,
  TransferDirection,
  TransferState,
  isSafeFilename,
  type FileOffer,
  type FileStore,
  type ResumeState,
  type TransferProgress,
} from '../src/files/types.js';

// ---------------------------------------------------------------------------
// Harness
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
    games: [{ id: 'tic-tac-toe', version: 1 }],
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

/** Copied from session.test.ts: two real PeerSessions over one MockNetwork. */
async function connectPair(
  options: {
    conditions?: Partial<typeof BLE_LIKE_CONDITIONS>;
    preTrusted?: boolean;
    seedA?: number;
    seedB?: number;
  } = {},
) {
  const clock = new VirtualClock();
  const network = new MockNetwork(clock, 0xa11);
  if (options.conditions) network.setConditions(options.conditions);

  const alejandro = makeDevice('Alejandro', options.seedA ?? 101);
  const maria = makeDevice('Maria', options.seedB ?? 202);

  if (options.preTrusted) {
    alejandro.trust.set(maria.identity.peerId, maria.identity.signing.publicKey);
    maria.trust.set(alejandro.identity.peerId, alejandro.identity.signing.publicKey);
  }

  const transportA = network.createTransport('endpoint-a');
  const transportB = network.createTransport('endpoint-b');

  await transportA.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: mockToken(1), displayName: 'Alejandro' });
  await transportB.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: mockToken(2), displayName: 'Maria' });

  await transportA.startDiscovery();

  const sessionA = new PeerSession('endpoint-b', { clock, handshake: alejandro.config });
  const sessionB = new PeerSession('endpoint-a', { clock, handshake: maria.config });

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
  await clock.advanceAsync(2000);

  return {
    clock,
    network,
    transportA,
    transportB,
    sessionA,
    sessionB,
    linkA,
    get linkB(): Link {
      if (!incoming) throw new Error('no incoming link');
      return incoming;
    },
  };
}

type Pair = Awaited<ReturnType<typeof connectPair>>;

interface FilePair {
  ctx: Pair;
  protoA: FileTransferProtocol;
  protoB: FileTransferProtocol;
}

async function connectFilePair(
  options: (Parameters<typeof connectPair>[0] & { idSeed?: number }) = {},
  protocolOptions: {
    maxFileBytes?: number;
    maxConcurrentIncoming?: number;
    maxConcurrentOutgoing?: number;
    tuning?: TransferTuning;
  } = {},
): Promise<FilePair> {
  const ctx = await connectPair({ preTrusted: true, ...options });
  const idSeed = options.idSeed ?? 7;
  // PeerSession is passed straight in: the fact that this compiles is the proof
  // that `TransferSession` really is a slice of the real thing.
  const protoA = new FileTransferProtocol(ctx.sessionA, {
    clock: ctx.clock,
    random: new SeededRandom(idSeed),
    ...protocolOptions,
  });
  const protoB = new FileTransferProtocol(ctx.sessionB, {
    clock: ctx.clock,
    random: new SeededRandom(idSeed + 1),
    ...protocolOptions,
  });
  return { ctx, protoA, protoB };
}

/** Advance virtual time in slices, stopping as soon as the condition holds. */
async function runUntil(clock: VirtualClock, done: () => boolean, budgetMs: number): Promise<boolean> {
  let elapsed = 0;
  while (elapsed < budgetMs) {
    if (done()) return true;
    await clock.advanceAsync(25, 5);
    elapsed += 25;
  }
  return done();
}

function pattern(size: number, salt = 0): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >> 8) * 17 + salt) & 0xff;
  return out;
}

interface Completion {
  transferId: string;
  direction: TransferDirection;
  fileBytes: number;
}

function collectCompletions(proto: FileTransferProtocol): Completion[] {
  const out: Completion[] = [];
  proto.events.on('completed', (e) => out.push({ transferId: e.transferId, direction: e.direction, fileBytes: e.fileBytes }));
  return out;
}

/**
 * Every FILE_DECLINE that reaches this session, read straight off the wire.
 *
 * Needed wherever the offer was hand-built rather than made through the
 * protocol: there is no local transfer for the answer to land on, so watching
 * the protocol's own `declined` event would watch something that can never
 * fire - and a test built on that watches nothing at all.
 */
function collectDeclineMessages(session: PeerSession): FileDeclineMessage[] {
  const out: FileDeclineMessage[] = [];
  session.events.on('message', (message) => {
    if (message.type === MessageType.FILE_DECLINE) out.push(decodeFileDecline(message.value));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

describe('filename safety', () => {
  it('accepts ordinary names, including unicode and spaces', () => {
    for (const name of ['photo.jpg', 'Mi Foto 😀.heic', 'notes-2026_final.pdf', '.hidden']) {
      expect(isSafeFilename(name)).toBe(true);
    }
  });

  it('refuses anything that could escape a directory or truncate a path', () => {
    for (const name of [
      '../../etc/passwd',
      '..\\..\\windows\\system32',
      '/absolute/path',
      'sub/dir.txt',
      'back\\slash.txt',
      'nul\u0000.txt',
      'bell\u0007.txt',
      'del\u007f.txt',
      '.',
      '..',
      '',
      'x'.repeat(FILE_LIMITS.maxFilenameChars + 1),
    ]) {
      expect(isSafeFilename(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Bitmap
// ---------------------------------------------------------------------------

describe('ChunkBitmap', () => {
  it('tracks membership, count and completeness', () => {
    const map = new ChunkBitmap(20);
    expect(map.isComplete).toBe(false);
    expect(map.set(3)).toBe(true);
    expect(map.set(3)).toBe(false); // already present
    expect(map.has(3)).toBe(true);
    expect(map.receivedCount).toBe(1);
    map.clear(3);
    expect(map.receivedCount).toBe(0);
    map.fill();
    expect(map.isComplete).toBe(true);
    expect(map.receivedCount).toBe(20);
  });

  it('answers out-of-range questions without throwing', () => {
    const map = new ChunkBitmap(8);
    expect(map.has(-1)).toBe(false);
    expect(map.has(8)).toBe(false);
    expect(map.has(1.5)).toBe(false);
    expect(map.set(99)).toBe(false);
    map.clear(99);
    expect(map.receivedCount).toBe(0);
  });

  it('reports the contiguous prefix and the next hole', () => {
    const map = new ChunkBitmap(10);
    for (const i of [0, 1, 2, 5, 6]) map.set(i);
    expect(map.contiguousPrefix()).toBe(3);
    expect(map.nextMissing(0)).toBe(3);
    expect(map.nextMissing(4)).toBe(4);
    expect(map.missingIndices(0, 3)).toEqual([3, 4, 7]);
    expect(map.runLength(0, true, 10)).toBe(3);
  });

  it('round-trips through the durable encoding', () => {
    const map = new ChunkBitmap(1000);
    for (let i = 0; i < 1000; i += 3) map.set(i);
    const restored = ChunkBitmap.fromBytes(map.toBytes(), 1000);
    expect(restored.receivedCount).toBe(map.receivedCount);
    for (let i = 0; i < 1000; i++) expect(restored.has(i)).toBe(map.has(i));
  });

  it('round-trips through the wire encoding, which skips the prefix', () => {
    const map = new ChunkBitmap(800);
    for (let i = 0; i < 640; i++) map.set(i); // 80% done, contiguous
    map.set(700);
    const { prefix, bytes } = map.encodeResume();
    expect(prefix).toBe(640);
    // The 80% prefix costs one integer instead of 80 bytes of bitmap.
    expect(bytes.length).toBe(20);
    const restored = ChunkBitmap.decodeResume(prefix, bytes, 800);
    expect(restored.receivedCount).toBe(641);
    expect(restored.has(639)).toBe(true);
    expect(restored.has(640)).toBe(false);
    expect(restored.has(700)).toBe(true);
  });

  it('rejects a bitmap of the wrong length or with padding bits set', () => {
    expect(() => ChunkBitmap.fromBytes(new Uint8Array(3), 10)).toThrow(DecodeError);
    // 10 chunks occupy 2 bytes; bits 10..15 are padding and must be zero.
    expect(() => ChunkBitmap.fromBytes(new Uint8Array([0xff, 0xff]), 10)).toThrow(/padding/);
    expect(() => ChunkBitmap.decodeResume(11, new Uint8Array(0), 10)).toThrow(DecodeError);
    expect(() => ChunkBitmap.decodeResume(-1, new Uint8Array(0), 10)).toThrow(DecodeError);
    expect(() => ChunkBitmap.decodeResume(0, new Uint8Array(9), 10)).toThrow(DecodeError);
    expect(() => new ChunkBitmap(FILE_LIMITS.maxChunks + 1)).toThrow(/out of range/);
  });
});

// ---------------------------------------------------------------------------
// Chunk sizing and hashing
// ---------------------------------------------------------------------------

describe('chunk sizing', () => {
  const bleInput = {
    payloadBudget: 65536,
    datagramBytes: 180,
    isHighBandwidth: true, // the MockTransport claims this even at 180 bytes
    fileBytes: 500_000,
    transferIdLength: 13,
  };

  it('sizes a chunk to a Bluetooth datagram, ignoring a bogus high-bandwidth claim', () => {
    const size = chooseChunkSize(bleInput);
    expect(size).toBe(FILE_LIMITS.minChunkBytes);
  });

  it('sizes a much larger chunk on a link whose datagrams are actually large', () => {
    const size = chooseChunkSize({ ...bleInput, datagramBytes: 16 * 1024 });
    expect(size).toBe(16 * 1024);
  });

  it('grows the grid so the resume bitmap can never exceed the limit', () => {
    const size = chooseChunkSize({ ...bleInput, fileBytes: 256 * 1024 * 1024 });
    expect(totalChunksFor(256 * 1024 * 1024, size)).toBeLessThanOrEqual(FILE_LIMITS.maxChunks);
  });

  it('coalesces adjacent chunks when the link gets faster, without changing the grid', () => {
    const grid = 256;
    // On Bluetooth one chunk fills the datagram, so a message carries one.
    expect(chooseRunLength(grid, 65536, 180, 13)).toBe(1);
    // On Wi-Fi the same grid ships dozens of chunks in one datagram-sized message.
    const wifi = chooseRunLength(grid, 65536, 16 * 1024, 13);
    expect(wifi).toBeGreaterThan(32);
    expect(wifi * grid + chunkHeaderBytes(13)).toBeLessThanOrEqual(16 * 1024 - 72);
    // A message never grows past the payload budget either.
    expect(chooseRunLength(grid, 1024, 64 * 1024, 13)).toBe(3);
  });

  it('computes run byte lengths that stop at the end of the file', () => {
    expect(runByteLength(1000, 256, 0, 1)).toBe(256);
    expect(runByteLength(1000, 256, 3, 1)).toBe(232);
    expect(runByteLength(1000, 256, 2, 8)).toBe(488);
    expect(runByteLength(1000, 256, 4, 1)).toBe(0);
  });
});

describe('hashing', () => {
  it('binds a chunk digest to its position, its run and its transfer', () => {
    const data = pattern(256);
    const base = chunkDigest('T1', 4, 1, data);
    expect(base.length).toBe(FILE_LIMITS.chunkDigestBytes);
    expect(bytesEqual(base, chunkDigest('T1', 4, 1, data))).toBe(true);
    // A chunk that verifies at index 4 must not verify anywhere else.
    expect(bytesEqual(base, chunkDigest('T1', 5, 1, data))).toBe(false);
    expect(bytesEqual(base, chunkDigest('T1', 4, 2, data))).toBe(false);
    expect(bytesEqual(base, chunkDigest('T2', 4, 1, data))).toBe(false);
  });

  it('hashes a whole file in constant memory, and notices a single flipped bit', async () => {
    const contents = pattern(5000);
    const hash = await computeFileHash(new MemoryFileStore(contents), 5000, 256);
    expect(hash.length).toBe(FILE_LIMITS.fileHashBytes);

    const tampered = contents.slice();
    tampered[4999] = (tampered[4999] as number) ^ 0x01;
    const other = await computeFileHash(new MemoryFileStore(tampered), 5000, 256);
    expect(bytesEqual(hash, other)).toBe(false);
  });

  it('is defined over the grid, so a different chunk size is a different hash', async () => {
    const contents = pattern(5000);
    const a = await computeFileHash(new MemoryFileStore(contents), 5000, 256);
    const b = await computeFileHash(new MemoryFileStore(contents), 5000, 512);
    expect(bytesEqual(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codec, including hostile input
// ---------------------------------------------------------------------------

const sampleOffer: FileOffer = {
  transferId: 'ABC123',
  filename: 'holiday.jpg',
  fileBytes: 5000,
  mimeType: 'image/jpeg',
  chunkSize: 256,
  totalChunks: totalChunksFor(5000, 256),
  fileHash: new Uint8Array(32).fill(9),
};

describe('file codec', () => {
  it('round-trips an offer', () => {
    const decoded = decodeFileOffer(encodeFileOffer(sampleOffer));
    expect(decoded).toEqual(sampleOffer);
  });

  it('round-trips a chunk, copying the payload out of the datagram', () => {
    const data = pattern(256);
    const digest = chunkDigest('ABC123', 2, 1, data);
    const decoded = decodeFileChunk(encodeFileChunk('ABC123', 2, 1, digest, data));
    expect(decoded.transferId).toBe('ABC123');
    expect(decoded.index).toBe(2);
    expect(decoded.run).toBe(1);
    expect(bytesEqual(decoded.digest, digest)).toBe(true);
    expect(bytesEqual(decoded.data, data)).toBe(true);
  });

  it('refuses a filename with a path separator or a NUL', () => {
    for (const filename of ['../../etc/passwd', 'a\\b.txt', 'x\u0000.txt', '..']) {
      const wire = { ...encodeFileOffer({ ...sampleOffer, filename: 'ok.txt' }) as Record<string, unknown>, n: filename };
      expect(() => decodeFileOffer(wire as never)).toThrow(DecodeError);
    }
  });

  it('recomputes totalChunks instead of believing the sender', () => {
    const wire = encodeFileOffer(sampleOffer) as Record<string, unknown>;
    expect(() => decodeFileOffer({ ...wire, k: 1 } as never)).toThrow(/inconsistent/);
  });

  it('rejects out-of-range and wrong-typed offer fields', () => {
    const wire = encodeFileOffer(sampleOffer) as Record<string, unknown>;
    expect(() => decodeFileOffer({ ...wire, s: -1 } as never)).toThrow(DecodeError);
    expect(() => decodeFileOffer({ ...wire, s: FILE_LIMITS.hardMaxFileBytes + 1 } as never)).toThrow(DecodeError);
    expect(() => decodeFileOffer({ ...wire, c: 1 } as never)).toThrow(DecodeError);
    expect(() => decodeFileOffer({ ...wire, c: FILE_LIMITS.maxChunkBytes * 2 } as never)).toThrow(DecodeError);
    expect(() => decodeFileOffer({ ...wire, h: new Uint8Array(16) } as never)).toThrow(DecodeError);
    expect(() => decodeFileOffer({ ...wire, h: 'not bytes' } as never)).toThrow(DecodeError);
    expect(() => decodeFileOffer({ ...wire, i: 'has spaces' } as never)).toThrow(DecodeError);
    expect(() => decodeFileOffer({ ...wire, i: 'x'.repeat(64) } as never)).toThrow(DecodeError);
    expect(() => decodeFileOffer(null)).toThrow(DecodeError);
    expect(() => decodeFileOffer([1, 2, 3] as never)).toThrow(DecodeError);
    expect(() => decodeFileOffer(42 as never)).toThrow(DecodeError);
  });

  it('rejects a malformed chunk header', () => {
    const data = pattern(64);
    const digest = chunkDigest('ABC123', 0, 1, data);
    const good = encodeFileChunk('ABC123', 0, 1, digest, data);

    expect(() => decodeFileChunk(new Uint8Array(0))).toThrow(DecodeError);
    expect(() => decodeFileChunk(good.subarray(0, 4))).toThrow(DecodeError);
    // Zero-length id.
    const zeroId = good.slice();
    zeroId[0] = 0;
    expect(() => decodeFileChunk(zeroId)).toThrow(DecodeError);
    // A run of zero, and a run past the coalescing limit.
    const runByte = 1 + 6 + 1; // idLen + id + varint index
    const zeroRun = good.slice();
    zeroRun[runByte] = 0;
    expect(() => decodeFileChunk(zeroRun)).toThrow(/run out of range/);
    const hugeRun = good.slice();
    hugeRun[runByte] = FILE_LIMITS.maxRunChunks + 1;
    expect(() => decodeFileChunk(hugeRun)).toThrow(/run out of range/);
    // Header but no data at all.
    expect(() => decodeFileChunk(good.subarray(0, runByte + 1 + FILE_LIMITS.chunkDigestBytes))).toThrow(/empty payload/);
  });

  it('bounds every array a peer controls', () => {
    const tooManyNaks = { i: 'ABC123', p: 0, b: new Uint8Array(0), r: Array.from({ length: 200 }, (_, i) => i), w: 8 };
    expect(() => decodeFileChunkAck(tooManyNaks as never)).toThrow(/too long/);

    const hugeAckBitmap = { i: 'ABC123', p: 0, b: new Uint8Array(4096), r: [], w: 8 };
    expect(() => decodeFileChunkAck(hugeAckBitmap as never)).toThrow(/exceeds/);

    const hugeResume = { i: 'ABC123', p: 0, b: new Uint8Array(1 << 20) };
    expect(() => decodeFileResume(hugeResume as never)).toThrow(/exceeds/);

    const negativeNak = { i: 'ABC123', p: 0, b: new Uint8Array(0), r: [-1], w: 8 };
    expect(() => decodeFileChunkAck(negativeNak as never)).toThrow(/out of range/);

    const nakNotAnArray = { i: 'ABC123', p: 0, b: new Uint8Array(0), r: 'nope', w: 8 };
    expect(() => decodeFileChunkAck(nakNotAnArray as never)).toThrow(/must be an array/);
  });

  it('defaults a missing accept window instead of trusting an absent field', () => {
    expect(decodeFileAccept({ i: 'ABC123' })).toEqual({ transferId: 'ABC123', window: 16 });
    expect(() => decodeFileAccept({ i: 'ABC123', w: 0 })).toThrow(DecodeError);
  });

  it('peeks just enough of a rejected offer to explain the rejection', () => {
    expect(peekOfferBasics({ i: 'ABC123', n: '../../etc/passwd' })).toEqual({
      transferId: 'ABC123',
      filename: '../../etc/passwd',
    });
    expect(peekOfferBasics({ i: 'bad id!', n: 'x' }).transferId).toBeNull();
    expect(peekOfferBasics(null)).toEqual({ transferId: null, filename: null });
  });

  it('refuses to encode something this device got wrong', () => {
    expect(() => encodeFileOffer({ ...sampleOffer, filename: '../x' })).toThrow(/filename/);
    expect(() => encodeFileOffer({ ...sampleOffer, totalChunks: 3 })).toThrow(/totalChunks/);
    expect(() => encodeFileOffer({ ...sampleOffer, fileHash: new Uint8Array(4) })).toThrow(/hash/);
    expect(() => encodeFileChunk('ABC123', 0, 0, new Uint8Array(8), pattern(4))).toThrow(/run/);
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('progress reporting', () => {
  it('formats sizes the way the phone does', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(42_800_000)).toBe('42.8 MB');
    expect(formatBytes(120_000_000)).toBe('120 MB');
    expect(formatBytes(1_500)).toBe('1.5 KB');
  });

  it('produces the line the UI shows', () => {
    const progress: TransferProgress = {
      transferId: 'T',
      direction: TransferDirection.INCOMING,
      filename: 'video.mov',
      state: TransferState.TRANSFERRING,
      totalBytes: 120_000_000,
      transferredBytes: 42_800_000,
      percent: percentOf(42_800_000, 120_000_000, false),
      bytesPerSecond: 40_000,
      etaMs: 1_930_000,
      stalled: false,
    };
    expect(formatTransferProgress(progress)).toBe('42.8 MB / 120 MB - 36%');
  });

  it('never shows 100% before the transfer is actually finished', () => {
    expect(percentOf(999_999, 1_000_000, false)).toBe(99);
    expect(percentOf(1_000_000, 1_000_000, true)).toBe(100);
    expect(percentOf(0, 0, false)).toBe(0);
  });

  it('estimates the ETA from measured throughput, not a nominal rate', () => {
    const estimator = new ThroughputEstimator(1000);
    estimator.reset(0, 0);
    // 10 KB per second, measured.
    for (let i = 1; i <= 10; i++) estimator.update(i * 10_000, i * 1000);
    const bps = estimator.bytesPerSecond ?? 0;
    expect(bps).toBeGreaterThan(9_000);
    expect(bps).toBeLessThan(11_000);
    const eta = estimator.etaMs(100_000) ?? 0;
    expect(eta).toBeGreaterThan(9_000);
    expect(eta).toBeLessThan(11_000);
  });

  it('has no estimate before the first sample, and ignores non-monotonic ones', () => {
    const estimator = new ThroughputEstimator();
    estimator.reset(0, 0);
    expect(estimator.bytesPerSecond).toBeNull();
    expect(estimator.etaMs(1000)).toBeNull();
    estimator.update(0, 500); // nothing moved
    expect(estimator.bytesPerSecond).toBeNull();
    expect(estimator.idleMs(1500)).toBe(1500);
  });

  it('formats durations for the ETA line', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(200_000)).toBe('3m 20s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(formatDuration(-1)).toBe('--');
  });
});

// ---------------------------------------------------------------------------
// The sender engine, driven directly through a stub wire
// ---------------------------------------------------------------------------

const NOOP_LISTENER: TransferListener = {
  onStateChanged: () => undefined,
  onProgress: () => undefined,
  onCompleted: () => undefined,
  onFailed: () => undefined,
  onCancelled: () => undefined,
  onDeclined: () => undefined,
  onChunkRejected: () => undefined,
};

function stubWire(datagramBytes: number, payloadBudget = 65536) {
  const controls: { type: number; value: CborValue }[] = [];
  const chunks: Uint8Array[] = [];
  const wire: TransferWire = {
    sendControl: (type, value) => {
      controls.push({ type, value });
      return true;
    },
    sendChunk: (payload) => {
      chunks.push(payload);
      return true;
    },
    get payloadBudget() {
      return payloadBudget;
    },
    get datagramBytes() {
      return datagramBytes;
    },
  };
  return { wire, controls, chunks };
}

/** Let every already-resolved store promise settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * The same, but deep enough for a whole send window: `pump` awaits the store
 * once per message, so filling a twelve-message window costs several times as
 * many microtask turns as sending one.
 */
async function settleWindow(): Promise<void> {
  for (let i = 0; i < 128; i++) await Promise.resolve();
}

async function makeOffer(contents: Uint8Array, chunkSize: number): Promise<FileOffer> {
  return {
    transferId: 'T1',
    filename: 'unit.bin',
    fileBytes: contents.length,
    mimeType: '',
    chunkSize,
    totalChunks: totalChunksFor(contents.length, chunkSize),
    fileHash: await computeFileHash(new MemoryFileStore(contents), contents.length, chunkSize),
  };
}

describe('OutgoingTransfer in isolation', () => {
  it('keeps a bounded number of messages in flight', async () => {
    const contents = pattern(256 * 200);
    const offer = await makeOffer(contents, 256);
    const { wire, chunks } = stubWire(180); // Bluetooth: one chunk per message
    const transfer = new OutgoingTransfer(offer, new MemoryFileStore(contents), wire, new VirtualClock(), NOOP_LISTENER);

    transfer.handleAccept(4);
    await settle();
    // The peer granted four; our own cap is higher, so four is what goes out.
    expect(chunks).toHaveLength(4);
    expect(transfer.inFlightMessages).toBe(4);
    expect(decodeFileChunk(chunks[0] as Uint8Array).run).toBe(1);
  });

  it('re-sends the whole run when a chunk in it is NAKed, not just the named index', async () => {
    const contents = pattern(256 * 16);
    const offer = await makeOffer(contents, 256);
    // A datagram budget that fits exactly four grid chunks in one message.
    const { wire, chunks } = stubWire(1024 + 72 + chunkHeaderBytes(2));
    const transfer = new OutgoingTransfer(offer, new MemoryFileStore(contents), wire, new VirtualClock(), NOOP_LISTENER);

    transfer.handleAccept(16);
    await settle();
    const sent = chunks.map((c) => decodeFileChunk(c));
    expect(sent).toHaveLength(4);
    expect(sent.map((c) => c.run)).toEqual([4, 4, 4, 4]);
    expect(sent.map((c) => c.index)).toEqual([0, 4, 8, 12]);

    chunks.length = 0;
    transfer.handleAck({
      transferId: 'T1',
      prefix: 4, // 0..3 landed
      bitmap: new Uint8Array(0),
      missing: [4], // 4..7 failed their digest
      window: 16,
    });
    await settle();

    const resent = chunks.map((c) => decodeFileChunk(c));
    expect(resent.some((c) => c.index === 4 && c.run === 4)).toBe(true);
    expect(transfer.ackedChunks).toBe(4);
  });

  it('applies a selective acknowledgement above the contiguous prefix', async () => {
    const contents = pattern(256 * 16);
    const offer = await makeOffer(contents, 256);
    const { wire } = stubWire(180);
    const transfer = new OutgoingTransfer(offer, new MemoryFileStore(contents), wire, new VirtualClock(), NOOP_LISTENER);
    transfer.handleAccept(16);
    await settle();

    // Prefix of two, plus chunks 3 and 5 held above the gap.
    transfer.handleAck({
      transferId: 'T1',
      prefix: 2,
      bitmap: new Uint8Array([0b0000_1010]),
      missing: [],
      window: 16,
    });
    expect(transfer.ackedChunks).toBe(4);
  });

  it('ignores a resume message it cannot parse rather than losing its place', async () => {
    const contents = pattern(256 * 16);
    const offer = await makeOffer(contents, 256);
    const { wire } = stubWire(180);
    const transfer = new OutgoingTransfer(offer, new MemoryFileStore(contents), wire, new VirtualClock(), NOOP_LISTENER);
    transfer.handleAccept(16);
    transfer.handleAck({ transferId: 'T1', prefix: 8, bitmap: new Uint8Array(0), missing: [], window: 16 });
    expect(transfer.ackedChunks).toBe(8);

    transfer.handleResume({ transferId: 'T1', prefix: 0, bitmap: new Uint8Array(99) });
    expect(transfer.ackedChunks).toBe(8);
    expect(transfer.state).toBe(TransferState.TRANSFERRING);
  });

  it('adopts the peer view of the world when a resume does parse', async () => {
    const contents = pattern(256 * 16);
    const offer = await makeOffer(contents, 256);
    const { wire } = stubWire(180);
    const transfer = new OutgoingTransfer(offer, new MemoryFileStore(contents), wire, new VirtualClock(), NOOP_LISTENER);
    transfer.handleAccept(16);
    transfer.handleAck({ transferId: 'T1', prefix: 12, bitmap: new Uint8Array(0), missing: [], window: 16 });

    // The receiver actually only has the first three chunks.
    const theirs = new ChunkBitmap(16);
    for (let i = 0; i < 3; i++) theirs.set(i);
    const encoded = theirs.encodeResume();
    transfer.handleResume({ transferId: 'T1', prefix: encoded.prefix, bitmap: encoded.bytes });
    expect(transfer.ackedChunks).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe('file transfer end to end', () => {
  it('moves a 500 KB file over a BLE-like link with a 180-byte MTU', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS });
    const contents = pattern(500 * 1024);
    const source = new MemoryFileStore(contents);
    const sink = new MemoryFileStore(500 * 1024);

    let offered: FileOffer | undefined;
    protoB.events.on('offer', ({ offer }) => {
      offered = offer;
      protoB.accept(offer.transferId, sink);
    });
    const doneA = collectCompletions(protoA);
    const doneB = collectCompletions(protoB);

    const id = await protoA.offer({ filename: 'sunset.jpg', fileBytes: contents.length, mimeType: 'image/jpeg', store: source });
    const finished = await runUntil(ctx.clock, () => doneA.length > 0 && doneB.length > 0, 240_000);

    expect(finished).toBe(true);
    expect(ctx.linkA.maxDatagramSize).toBe(180);
    // One chunk per Bluetooth datagram: the grid is the floor size, not 16 KB.
    expect(offered?.chunkSize).toBe(FILE_LIMITS.minChunkBytes);
    expect(offered?.totalChunks).toBe(2000);
    expect(doneB[0]?.transferId).toBe(id);
    expect(bytesEqual(sink.bytes, contents)).toBe(true);
    expect(protoB.rejectedChunks).toBe(0);
    // Both sides are back to idle, with no timers left running.
    expect(protoA.activeTransfers).toHaveLength(0);
    expect(protoB.activeTransfers).toHaveLength(0);
  }, 120_000);

  it('reports progress with a measured rate and a shrinking ETA', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS });
    const contents = pattern(64 * 1024);
    const sink = new MemoryFileStore(contents.length);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));

    const samples: TransferProgress[] = [];
    protoB.events.on('progress', ({ progress }) => samples.push(progress));
    const doneB = collectCompletions(protoB);

    await protoA.offer({ filename: 'clip.mp4', fileBytes: contents.length, store: new MemoryFileStore(contents) });
    await runUntil(ctx.clock, () => doneB.length > 0, 120_000);

    const measured = samples.filter((s) => s.bytesPerSecond !== null && s.percent > 5 && s.percent < 95);
    expect(measured.length).toBeGreaterThan(0);
    const mid = measured[Math.floor(measured.length / 2)] as TransferProgress;
    // A BLE-like link is capped at 40 KB/s; a plausible measurement lands under it.
    expect(mid.bytesPerSecond ?? 0).toBeGreaterThan(0);
    expect(mid.bytesPerSecond ?? 0).toBeLessThan(BLE_LIKE_CONDITIONS.bandwidthBytesPerSecond * 1.5);
    expect(mid.etaMs ?? -1).toBeGreaterThan(0);
    expect(mid.stalled).toBe(false);
    expect(formatTransferProgress(mid)).toMatch(/^[\d.]+ [A-Z]*B? ?\/ .* - \d+%$/);
  }, 60_000);

  it('completes a zero-byte file without sending a single chunk', async () => {
    const { ctx, protoA, protoB } = await connectFilePair();
    const sink = new MemoryFileStore(0);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const doneA = collectCompletions(protoA);

    await protoA.offer({ filename: 'empty.txt', fileBytes: 0, store: new MemoryFileStore(0) });
    expect(await runUntil(ctx.clock, () => doneA.length > 0, 10_000)).toBe(true);
    expect(sink.writes).toHaveLength(0);
  });

  it('ignores the tail of a transfer that has already finished', async () => {
    const { ctx, protoA, protoB } = await connectFilePair();
    const contents = pattern(2048);
    const sink = new MemoryFileStore(contents.length);
    let id = '';
    protoB.events.on('offer', ({ offer }) => {
      id = offer.transferId;
      protoB.accept(offer.transferId, sink);
    });
    const doneB = collectCompletions(protoB);
    await protoA.offer({ filename: 'done.bin', fileBytes: contents.length, store: new MemoryFileStore(contents) });
    expect(await runUntil(ctx.clock, () => doneB.length > 0, 20_000)).toBe(true);

    // A chunk still in flight when the receiver declared the file complete is
    // expected, not suspicious, and must not show up in the diagnostics.
    expect(protoB.hasRecentlyFinished(id)).toBe(true);
    const before = protoB.droppedPackets;
    const data = pattern(256, 4);
    ctx.sessionA.sendReliableRaw(
      MessageType.FILE_CHUNK,
      encodeFileChunk(id, 0, 1, chunkDigest(id, 0, 1, data), data),
      { bulk: true },
    );
    await ctx.clock.advanceAsync(1000);
    expect(protoB.droppedPackets).toBe(before);
  });

  it('carries a declined offer back to the sender with a reason', async () => {
    const { ctx, protoA, protoB } = await connectFilePair();
    protoB.events.on('offer', ({ offer }) => protoB.decline(offer.transferId, 'not now'));
    const declines: { transferId: string; code: number; reason: string }[] = [];
    protoA.events.on('declined', (e) => declines.push(e));

    const id = await protoA.offer({ filename: 'big.zip', fileBytes: 4096, store: new MemoryFileStore(pattern(4096)) });
    await runUntil(ctx.clock, () => declines.length > 0, 10_000);

    expect(declines[0]?.transferId).toBe(id);
    expect(declines[0]?.code).toBe(FileErrorCode.REJECTED_BY_USER);
    expect(declines[0]?.reason).toBe('not now');
    expect(protoA.activeTransfers).toHaveLength(0);
  });

  it('cancels cleanly from the sending side', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS });
    const contents = pattern(200 * 1024);
    const sink = new MemoryFileStore(contents.length);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const cancelledB: { byPeer: boolean; reason: string }[] = [];
    protoB.events.on('cancelled', (e) => cancelledB.push({ byPeer: e.byPeer, reason: e.reason }));

    const id = await protoA.offer({ filename: 'long.bin', fileBytes: contents.length, store: new MemoryFileStore(contents) });
    await runUntil(ctx.clock, () => (protoB.progressOf(id)?.transferredBytes ?? 0) > 4096, 60_000);

    protoA.cancel(id, 'changed my mind');
    await runUntil(ctx.clock, () => cancelledB.length > 0, 10_000);

    expect(cancelledB[0]).toEqual({ byPeer: true, reason: 'changed my mind' });
    expect(protoA.activeTransfers).toHaveLength(0);
    expect(protoB.activeTransfers).toHaveLength(0);
    // The session itself is untouched and still carries messages.
    expect(ctx.sessionA.isSecure).toBe(true);
  }, 60_000);

  it('cancels cleanly from the receiving side', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS });
    const contents = pattern(200 * 1024);
    const sink = new MemoryFileStore(contents.length);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const cancelledA: { byPeer: boolean; reason: string }[] = [];
    protoA.events.on('cancelled', (e) => cancelledA.push({ byPeer: e.byPeer, reason: e.reason }));

    const id = await protoA.offer({ filename: 'long.bin', fileBytes: contents.length, store: new MemoryFileStore(contents) });
    await runUntil(ctx.clock, () => (protoB.progressOf(id)?.transferredBytes ?? 0) > 4096, 60_000);

    protoB.cancel(id, 'out of space');
    await runUntil(ctx.clock, () => cancelledA.length > 0, 10_000);

    expect(cancelledA[0]).toEqual({ byPeer: true, reason: 'out of space' });
    expect(protoA.activeTransfers).toHaveLength(0);
  }, 60_000);

  it('adapts its chunk size mid-flight when the session upgrades to Wi-Fi', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS });
    const contents = pattern(400 * 1024);
    const sink = new MemoryFileStore(contents.length);
    let offered: FileOffer | undefined;
    protoB.events.on('offer', ({ offer }) => {
      offered = offer;
      protoB.accept(offer.transferId, sink);
    });
    const doneB = collectCompletions(protoB);

    const id = await protoA.offer({ filename: 'movie.mov', fileBytes: contents.length, store: new MemoryFileStore(contents) });
    await runUntil(ctx.clock, () => (protoB.progressOf(id)?.transferredBytes ?? 0) > 16 * 1024, 60_000);

    const bleWrites = sink.writes.length;
    const bleBytes = protoB.progressOf(id)?.transferredBytes ?? 0;
    // Every write so far has been a single 256-byte grid chunk.
    expect(Math.max(...sink.writes.map((w) => w.length))).toBe(FILE_LIMITS.minChunkBytes);

    // A faster transport appears. Same peers, same keys, same transfer.
    ctx.network.setConditions(WIFI_LIKE_CONDITIONS);
    const pending = ctx.transportA.connect('endpoint-b');
    await ctx.clock.advanceAsync(300);
    ctx.sessionA.migrateToLink(await pending);
    protoA.notifyLinkChanged();
    protoB.notifyLinkChanged();

    expect(await runUntil(ctx.clock, () => doneB.length > 0, 120_000)).toBe(true);
    expect(bytesEqual(sink.bytes, contents)).toBe(true);
    // The grid never changed...
    expect(offered?.chunkSize).toBe(FILE_LIMITS.minChunkBytes);
    // ...but the transmission unit did: runs of many grid chunks per message.
    const laterWrites = sink.writes.slice(bleWrites);
    expect(Math.max(...laterWrites.map((w) => w.length))).toBeGreaterThan(FILE_LIMITS.minChunkBytes * 8);
    expect(bleBytes).toBeGreaterThan(0);
  }, 120_000);

  it('resumes over a brand new link after the radio drops mid-transfer', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS });
    const contents = pattern(120 * 1024);
    const sink = new MemoryFileStore(contents.length);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const doneB = collectCompletions(protoB);

    const id = await protoA.offer({ filename: 'album.zip', fileBytes: contents.length, store: new MemoryFileStore(contents) });
    await runUntil(ctx.clock, () => (protoB.progressOf(id)?.transferredBytes ?? 0) > 20 * 1024, 60_000);
    const before = protoB.progressOf(id)?.transferredBytes ?? 0;

    // The phone goes into a pocket.
    ctx.network.partition('endpoint-a', 'endpoint-b');
    await ctx.clock.advanceAsync(500);
    expect(protoA.progressOf(id)).not.toBeNull();

    // ...and comes back out. A fresh link, the same session, the same transfer.
    ctx.network.heal('endpoint-a', 'endpoint-b');
    const pending = ctx.transportA.connect('endpoint-b');
    await ctx.clock.advanceAsync(300);
    ctx.sessionA.migrateToLink(await pending);
    protoA.notifyLinkChanged();
    protoB.notifyLinkChanged();

    expect(await runUntil(ctx.clock, () => doneB.length > 0, 180_000)).toBe(true);
    expect(bytesEqual(sink.bytes, contents)).toBe(true);
    expect(before).toBeGreaterThan(0);
  }, 120_000);

  it('resumes at 80% in a new process, transferring only what is missing', async () => {
    const contents = pattern(120 * 1024);

    // --- first attempt: interrupted part way through -------------------------
    const first = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS });
    const sink = new MemoryFileStore(contents.length);
    let firstId = '';
    first.protoB.events.on('offer', ({ offer }) => first.protoB.accept(offer.transferId, sink));
    firstId = await first.protoA.offer({
      filename: 'album.zip',
      fileBytes: contents.length,
      store: new MemoryFileStore(contents),
    });
    await runUntil(
      first.ctx.clock,
      () => (first.protoB.progressOf(firstId)?.transferredBytes ?? 0) > contents.length * 0.5,
      120_000,
    );

    // What the app persists to its database before being killed.
    const saved = first.protoB.snapshot(firstId) as ResumeState;
    expect(saved).not.toBeNull();
    const savedChunks = ChunkBitmap.fromBytes(saved.bitmap, totalChunksFor(contents.length, saved.chunkSize));
    expect(savedChunks.receivedCount).toBeGreaterThan(savedChunks.chunkCount * 0.4);
    expect(savedChunks.isComplete).toBe(false);
    first.protoA.dispose();
    first.protoB.dispose();

    // --- second attempt: brand new sessions, brand new transfer id -----------
    const second = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS, idSeed: 900 });
    const writesBefore = sink.writes.length;
    second.protoB.events.on('offer', ({ offer }) => {
      expect(offer.transferId).not.toBe(firstId);
      // The persisted state is keyed on the content, not on the transfer id.
      expect(offer.chunkSize).toBe(saved.chunkSize);
      second.protoB.accept(offer.transferId, sink, saved);
    });
    const doneB = collectCompletions(second.protoB);

    const secondId = await second.protoA.offer({
      filename: 'album.zip',
      fileBytes: contents.length,
      store: new MemoryFileStore(contents),
    });
    expect(await runUntil(second.ctx.clock, () => doneB.length > 0, 180_000)).toBe(true);

    expect(secondId).not.toBe(firstId);
    expect(bytesEqual(sink.bytes, contents)).toBe(true);
    // Only the missing chunks crossed the link the second time.
    const rewritten = sink.writes.slice(writesBefore).reduce((n, w) => n + w.length, 0);
    const missingBytes = (savedChunks.chunkCount - savedChunks.receivedCount) * saved.chunkSize;
    expect(rewritten).toBeLessThanOrEqual(missingBytes + saved.chunkSize);
  }, 180_000);

  it('completes over a hostile link that loses, reorders and duplicates packets', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({ conditions: WIFI_LIKE_CONDITIONS });
    const contents = pattern(24 * 1024, 5);
    const sink = new MemoryFileStore(contents.length);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const doneB = collectCompletions(protoB);

    // Degrade only after the handshake, which has no retry of its own.
    ctx.network.setConditions(HOSTILE_CONDITIONS);
    await protoA.offer({ filename: 'notes.pdf', fileBytes: contents.length, store: new MemoryFileStore(contents) });

    expect(await runUntil(ctx.clock, () => doneB.length > 0, 400_000)).toBe(true);
    expect(bytesEqual(sink.bytes, contents)).toBe(true);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Hostile peers
// ---------------------------------------------------------------------------

describe('a hostile peer', () => {
  it('cannot make us name a file "../../etc/passwd"', async () => {
    const { ctx, protoA, protoB } = await connectFilePair();
    const offers: FileOffer[] = [];
    protoB.events.on('offer', ({ offer }) => offers.push(offer));
    // Read off the wire, not off protoA's events: the offer below is hand-built
    // and protoA has no transfer for it, so nothing local would ever fire.
    const declines = collectDeclineMessages(ctx.sessionA);

    // Hand-built offer, bypassing our own encoder's checks.
    ctx.sessionA.sendReliable(MessageType.FILE_OFFER, {
      i: 'EVIL01',
      n: '../../etc/passwd',
      s: 1024,
      m: 'text/plain',
      c: 256,
      k: 4,
      h: new Uint8Array(32),
    });
    await ctx.clock.advanceAsync(2000);

    expect(offers).toHaveLength(0);
    expect(protoB.activeTransfers).toHaveLength(0);
    expect(protoB.malformedPackets).toBe(1);
    // The sender is told why rather than left waiting for a timeout, and the
    // reason names the filename specifically.
    expect(await runUntil(ctx.clock, () => declines.length > 0, 5000)).toBe(true);
    expect(declines[0]?.transferId).toBe('EVIL01');
    expect(declines[0]?.code).toBe(FileErrorCode.BAD_FILENAME);
    expect(protoB.diagnostics().incoming).toBe(0);
    // ...and the session is still perfectly healthy afterwards.
    const sink = new MemoryFileStore(1024);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const doneA = collectCompletions(protoA);
    await protoA.offer({ filename: 'fine.bin', fileBytes: 1024, store: new MemoryFileStore(pattern(1024)) });
    expect(await runUntil(ctx.clock, () => doneA.length > 0, 20_000)).toBe(true);
  });

  it('cannot write outside the file with an out-of-range chunk index', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS });
    const contents = pattern(4096);
    const sink = new MemoryFileStore(contents.length);
    let offer: FileOffer | undefined;
    protoB.events.on('offer', (e) => {
      offer = e.offer;
      protoB.accept(e.offer.transferId, sink);
    });
    const doneB = collectCompletions(protoB);
    await protoA.offer({ filename: 'ok.bin', fileBytes: contents.length, store: new MemoryFileStore(contents) });
    await runUntil(ctx.clock, () => offer !== undefined, 5000);
    const live = offer as FileOffer;

    const data = pattern(live.chunkSize, 3);
    for (const index of [live.totalChunks, live.totalChunks + 5000, FILE_LIMITS.maxChunks - 1]) {
      const payload = encodeFileChunk(live.transferId, index, 1, chunkDigest(live.transferId, index, 1, data), data);
      ctx.sessionA.sendReliableRaw(MessageType.FILE_CHUNK, payload, { bulk: true });
    }
    // A run that starts inside the file but reaches past its end.
    const straddle = pattern(live.chunkSize * 4, 4);
    const straddleIndex = live.totalChunks - 2;
    ctx.sessionA.sendReliableRaw(
      MessageType.FILE_CHUNK,
      encodeFileChunk(
        live.transferId,
        straddleIndex,
        4,
        chunkDigest(live.transferId, straddleIndex, 4, straddle),
        straddle,
      ),
      { bulk: true },
    );
    await ctx.clock.advanceAsync(2000);

    expect(protoB.rejectedChunks).toBeGreaterThanOrEqual(4);
    // The real transfer is unharmed and still finishes with the right bytes.
    expect(await runUntil(ctx.clock, () => doneB.length > 0, 30_000)).toBe(true);
    expect(bytesEqual(sink.bytes, contents)).toBe(true);
  }, 60_000);

  it('cannot start a transfer by sending chunks for an id we never accepted', async () => {
    const { ctx, protoA, protoB } = await connectFilePair();
    const before = protoB.droppedPackets;
    const data = pattern(256, 9);
    for (let i = 0; i < 5; i++) {
      const payload = encodeFileChunk('GHOST00', i, 1, chunkDigest('GHOST00', i, 1, data), data);
      ctx.sessionA.sendReliableRaw(MessageType.FILE_CHUNK, payload, { bulk: true });
    }
    // ...and a stray acknowledgement, cancel and error for good measure.
    ctx.sessionA.sendReliable(MessageType.FILE_CHUNK_ACK, { i: 'GHOST00', p: 3, b: new Uint8Array(1), r: [], w: 8 });
    ctx.sessionA.sendReliable(MessageType.FILE_CANCEL, { i: 'GHOST00', r: 'stop' });
    ctx.sessionA.sendReliable(MessageType.FILE_ERROR, { i: 'GHOST00', c: 1, m: 'boom' });
    await ctx.clock.advanceAsync(2000);

    expect(protoB.droppedPackets).toBeGreaterThanOrEqual(before + 5);
    expect(protoB.activeTransfers).toHaveLength(0);
    expect(protoB.hasRecentlyFinished('GHOST00')).toBe(false);
    // Still healthy.
    const sink = new MemoryFileStore(2048);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const doneA = collectCompletions(protoA);
    await protoA.offer({ filename: 'after.bin', fileBytes: 2048, store: new MemoryFileStore(pattern(2048)) });
    expect(await runUntil(ctx.clock, () => doneA.length > 0, 20_000)).toBe(true);
  });

  it('re-requests a chunk that fails its digest instead of writing it', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({ conditions: BLE_LIKE_CONDITIONS });
    const contents = pattern(32 * 1024, 11);
    const sink = new MemoryFileStore(contents.length);
    let corruptedIndex = -1;
    // Injected from inside the accept, so it is certain to land while the
    // transfer is still running.
    protoB.events.on('offer', ({ offer }) => {
      protoB.accept(offer.transferId, sink);
      corruptedIndex = offer.totalChunks - 1;
      const length = runByteLength(offer.fileBytes, offer.chunkSize, corruptedIndex, 1);
      // A chunk of exactly the right shape whose bytes do not match its digest.
      const corrupted = pattern(length, 200);
      const wrongDigest = chunkDigest(offer.transferId, corruptedIndex, 1, pattern(length, 201));
      ctx.sessionA.sendReliableRaw(
        MessageType.FILE_CHUNK,
        encodeFileChunk(offer.transferId, corruptedIndex, 1, wrongDigest, corrupted),
        { bulk: true },
      );
    });
    const doneB = collectCompletions(protoB);
    await protoA.offer({ filename: 'photo.raw', fileBytes: contents.length, store: new MemoryFileStore(contents) });

    expect(await runUntil(ctx.clock, () => doneB.length > 0, 120_000)).toBe(true);
    expect(corruptedIndex).toBeGreaterThan(0);
    expect(protoB.rejectedChunks).toBeGreaterThanOrEqual(1);
    // The corrupted bytes were never written, and the file verifies.
    expect(bytesEqual(sink.bytes, contents)).toBe(true);
  }, 120_000);

  it('refuses an offer above the configured size limit', async () => {
    const { ctx, protoA, protoB } = await connectFilePair({}, { maxFileBytes: 4096 });
    const offers: FileOffer[] = [];
    protoB.events.on('offer', ({ offer }) => offers.push(offer));
    const declines = collectDeclineMessages(ctx.sessionA);

    // Straight from the wire, so our own outbound limit is not what is tested.
    ctx.sessionA.sendReliable(
      MessageType.FILE_OFFER,
      encodeFileOffer({
        transferId: 'HUGE01',
        filename: 'enormous.iso',
        fileBytes: 64 * 1024 * 1024,
        mimeType: '',
        chunkSize: 4096,
        totalChunks: totalChunksFor(64 * 1024 * 1024, 4096),
        fileHash: new Uint8Array(32),
      }),
    );
    await ctx.clock.advanceAsync(2000);

    expect(offers).toHaveLength(0);
    expect(protoB.activeTransfers).toHaveLength(0);
    // The peer is told the size is the problem, so its UI can say so.
    expect(await runUntil(ctx.clock, () => declines.length > 0, 5000)).toBe(true);
    expect(declines[0]?.transferId).toBe('HUGE01');
    expect(declines[0]?.code).toBe(FileErrorCode.TOO_LARGE);
    // Our own side refuses to even start such a transfer.
    await expect(
      protoA.offer({ filename: 'enormous.iso', fileBytes: 64 * 1024 * 1024, store: new MemoryFileStore(16) }),
    ).rejects.toThrow(/limit/);
  });

  it('bounds the number of concurrent incoming transfers', async () => {
    const { ctx, protoA, protoB } = await connectFilePair(
      { conditions: BLE_LIKE_CONDITIONS },
      { maxConcurrentIncoming: 1 },
    );
    const offers: FileOffer[] = [];
    const declined: { code: number }[] = [];
    protoA.events.on('declined', (e) => declined.push(e));
    protoB.events.on('offer', ({ offer }) => {
      offers.push(offer);
      protoB.accept(offer.transferId, new MemoryFileStore(offer.fileBytes));
    });

    await protoA.offer({ filename: 'one.bin', fileBytes: 200_000, store: new MemoryFileStore(pattern(200_000)) });
    await ctx.clock.advanceAsync(200);
    await protoA.offer({ filename: 'two.bin', fileBytes: 200_000, store: new MemoryFileStore(pattern(200_000, 2)) });
    await runUntil(ctx.clock, () => declined.length > 0, 20_000);

    expect(offers).toHaveLength(1);
    expect(declined[0]?.code).toBe(FileErrorCode.BUSY);
  }, 60_000);

  it('drops garbage payloads for every file message type without disturbing the session', async () => {
    const { ctx, protoA, protoB } = await connectFilePair();
    const before = protoB.malformedPackets;

    for (const type of [
      MessageType.FILE_OFFER,
      MessageType.FILE_ACCEPT,
      MessageType.FILE_DECLINE,
      MessageType.FILE_CHUNK_ACK,
      MessageType.FILE_RESUME,
      MessageType.FILE_COMPLETE,
      MessageType.FILE_CANCEL,
      MessageType.FILE_ERROR,
    ]) {
      ctx.sessionA.sendReliable(type, [1, 2, 3]);
      ctx.sessionA.sendReliable(type, { i: 42 });
      ctx.sessionA.sendReliable(type, { i: 'OK1', p: -5 });
    }
    // A chunk that is not even a valid header.
    ctx.sessionA.sendReliableRaw(MessageType.FILE_CHUNK, new Uint8Array([0xff, 0x00, 0x01]), { bulk: true });
    await ctx.clock.advanceAsync(3000);

    expect(protoB.malformedPackets).toBeGreaterThan(before);
    expect(protoB.activeTransfers).toHaveLength(0);

    const sink = new MemoryFileStore(1024);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const doneA = collectCompletions(protoA);
    await protoA.offer({ filename: 'still-fine.bin', fileBytes: 1024, store: new MemoryFileStore(pattern(1024)) });
    expect(await runUntil(ctx.clock, () => doneA.length > 0, 20_000)).toBe(true);
  });

  it('fails a transfer whose bytes changed under it rather than claiming success', async () => {
    const { ctx, protoA, protoB } = await connectFilePair();
    const contents = pattern(4096, 21);
    const source = new MemoryFileStore(contents.slice());
    const sink = new MemoryFileStore(contents.length);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const failures: { code: FileErrorCode }[] = [];
    protoB.events.on('failed', (e) => failures.push(e));

    const id = await protoA.offer({ filename: 'shifting.bin', fileBytes: contents.length, store: source });
    // The file is edited on disk after it was hashed and offered. Every chunk
    // still passes its own digest; only the whole-file hash can catch this.
    source.bytes[10] = (source.bytes[10] as number) ^ 0xff;

    expect(await runUntil(ctx.clock, () => failures.length > 0, 30_000)).toBe(true);
    expect(failures[0]?.code).toBe(FileErrorCode.HASH_MISMATCH);
    expect(protoB.progressOf(id)).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Resources a peer would otherwise control
// ---------------------------------------------------------------------------

describe('bounded resources', () => {
  it('does not buffer an unbounded number of chunk payloads when the store is slow', async () => {
    const chunkSize = 256;
    const totalChunks = 400;
    const contents = pattern(chunkSize * totalChunks);
    const offer = await makeOffer(contents, chunkSize);
    const { wire } = stubWire(180);

    // A store that accepts writes and never finishes them - a phone whose flash
    // is busy, which is the ordinary case, not the exotic one.
    const pending: (() => void)[] = [];
    const store: FileStore = {
      readChunk: async () => new Uint8Array(0),
      writeChunk: () => new Promise<void>((resolve) => pending.push(resolve)),
    };

    const transfer = new IncomingTransfer(offer, wire, new VirtualClock(), NOOP_LISTENER);
    transfer.accept(store);

    // A peer that ignores the window it was granted and sends the whole file.
    for (let index = 0; index < totalChunks; index++) {
      const data = contents.slice(index * chunkSize, (index + 1) * chunkSize);
      transfer.handleChunk({
        transferId: offer.transferId,
        index,
        run: 1,
        digest: chunkDigest(offer.transferId, index, 1, data),
        data,
      });
    }
    await settle();

    // Each accepted chunk pins its payload until the write lands, so the number
    // of outstanding writes IS the memory this peer can make us hold.
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThanOrEqual(DEFAULT_TUNING.receiveWindowMessages * 2);
    // Nothing was written twice, and nothing was silently accepted: the chunks
    // that were refused are counted.
    expect(transfer.rejectedChunks).toBe(totalChunks - pending.length);
    expect(transfer.receivedChunks).toBe(0);
  });

  it('gives up on an offer nobody answers, freeing the slot it was holding', async () => {
    const { ctx, protoA, protoB } = await connectFilePair(
      {},
      { maxConcurrentIncoming: 1, tuning: { ...DEFAULT_TUNING, offerTimeoutMs: 5_000 } },
    );
    const declines = collectDeclineMessages(ctx.sessionA);
    const offers: FileOffer[] = [];
    // Deliberately never accepted or declined: the phone is in a pocket.
    protoB.events.on('offer', ({ offer }) => offers.push(offer));

    // Straight from the wire, so only the RECEIVER's clock is under test.
    ctx.sessionA.sendReliable(
      MessageType.FILE_OFFER,
      encodeFileOffer({
        transferId: 'IGNORED1',
        filename: 'ignored.bin',
        fileBytes: 4096,
        mimeType: '',
        chunkSize: 256,
        totalChunks: totalChunksFor(4096, 256),
        fileHash: new Uint8Array(32),
      }),
    );
    expect(await runUntil(ctx.clock, () => offers.length > 0, 5_000)).toBe(true);
    expect(protoB.diagnostics().incoming).toBe(1);

    // The offer expires, and the peer is told so its own prompt can go away.
    expect(await runUntil(ctx.clock, () => declines.length > 0, 30_000)).toBe(true);
    expect(declines[0]?.transferId).toBe('IGNORED1');
    expect(declines[0]?.code).toBe(FileErrorCode.TIMED_OUT);
    expect(protoB.activeTransfers).toHaveLength(0);

    // ...and the single incoming slot it was holding is genuinely free again,
    // which is the whole point: one silent peer must not end file transfer.
    const sink = new MemoryFileStore(2048);
    protoB.events.on('offer', ({ offer }) => protoB.accept(offer.transferId, sink));
    const doneA = collectCompletions(protoA);
    await protoA.offer({ filename: 'after.bin', fileBytes: 2048, store: new MemoryFileStore(pattern(2048)) });
    expect(await runUntil(ctx.clock, () => doneA.length > 0, 30_000)).toBe(true);
  }, 60_000);

  it('gives up on an offer the peer never answers', async () => {
    const { ctx, protoA, protoB } = await connectFilePair(
      {},
      { maxConcurrentOutgoing: 1, tuning: { ...DEFAULT_TUNING, offerTimeoutMs: 5_000 } },
    );
    // Nothing on the far side is listening for files any more.
    protoB.dispose();
    const failures: { transferId: string; code: FileErrorCode }[] = [];
    protoA.events.on('failed', (e) => failures.push({ transferId: e.transferId, code: e.code }));

    const id = await protoA.offer({
      filename: 'into-the-void.bin',
      fileBytes: 4096,
      store: new MemoryFileStore(pattern(4096)),
    });
    expect(protoA.activeTransfers).toHaveLength(1);

    expect(await runUntil(ctx.clock, () => failures.length > 0, 30_000)).toBe(true);
    expect(failures[0]?.transferId).toBe(id);
    expect(failures[0]?.code).toBe(FileErrorCode.TIMED_OUT);
    // The outgoing slot is free, so the user can try again.
    expect(protoA.activeTransfers).toHaveLength(0);
    expect(protoA.progressOf(id)).toBeNull();
    await expect(
      protoA.offer({ filename: 'retry.bin', fileBytes: 16, store: new MemoryFileStore(pattern(16)) }),
    ).resolves.toBeTypeOf('string');
  }, 60_000);

  it('does not re-send chunks the receiver has no way to acknowledge', async () => {
    const chunkSize = 256;
    const contents = pattern(chunkSize * 1000);
    const offer = await makeOffer(contents, chunkSize);
    // A Wi-Fi sized datagram: 64 grid chunks per message, and a window of 12
    // messages reaches 768 chunks - six times what one ack bitmap can describe.
    const { wire, chunks } = stubWire(64 * chunkSize + 72 + chunkHeaderBytes(offer.transferId.length));
    const clock = new VirtualClock();
    const transfer = new OutgoingTransfer(offer, new MemoryFileStore(contents), wire, clock, NOOP_LISTENER);

    transfer.handleAccept(16);
    await settleWindow();
    expect(chunks).toHaveLength(DEFAULT_TUNING.maxInFlightMessages);
    expect(decodeFileChunk(chunks[0] as Uint8Array).run).toBe(FILE_LIMITS.maxRunChunks);

    // The receiver holds chunks 64..127 but is still missing the very first
    // run, so its contiguous prefix is stuck at 0 and its 16-byte selective
    // bitmap cannot describe anything at or above chunk 128.
    const bitmap = new Uint8Array(FILE_LIMITS.maxAckBitmapBytes);
    for (let bit = 64; bit < 128; bit++) bitmap[bit >> 3] = (bitmap[bit >> 3] as number) | (1 << (bit & 7));
    transfer.handleAck({ transferId: offer.transferId, prefix: 0, bitmap, missing: [], window: 16 });
    await settleWindow();

    chunks.length = 0;
    clock.advance(DEFAULT_TUNING.chunkTimeoutMs + 1);
    transfer.tick();
    await settleWindow();

    const resent = chunks.map((c) => decodeFileChunk(c));
    // The run that really is missing goes again...
    expect(resent.some((c) => c.index === 0)).toBe(true);
    // ...and the 640 chunks the receiver was never able to mention do not. Silence
    // above the ack window is not evidence of loss.
    expect(resent.filter((c) => c.index >= FILE_LIMITS.maxAckBitmapBytes * 8)).toHaveLength(0);
  });

  it('does not let a peer reset the retry budget by repeating FILE_RESUME', async () => {
    const chunkSize = 256;
    const contents = pattern(chunkSize * 8);
    const offer = await makeOffer(contents, chunkSize);
    const { wire } = stubWire(180);
    const clock = new VirtualClock();
    const failures: { code: FileErrorCode }[] = [];
    const listener: TransferListener = { ...NOOP_LISTENER, onFailed: (_t, code) => failures.push({ code }) };
    const transfer = new OutgoingTransfer(offer, new MemoryFileStore(contents), wire, clock, listener);

    transfer.handleAccept(16);
    await settle();

    // "I have nothing, start again" - over and over, acknowledging nothing. A
    // few bytes of theirs must not buy an unbounded number of ours.
    const nothing = new ChunkBitmap(offer.totalChunks).encodeResume();
    for (let round = 0; round < 20 && !transfer.isFinished; round++) {
      transfer.handleResume({ transferId: offer.transferId, prefix: nothing.prefix, bitmap: nothing.bytes });
      await settle();
      clock.advance(DEFAULT_TUNING.chunkTimeoutMs + 1);
      transfer.tick();
      await settle();
    }

    expect(transfer.state).toBe(TransferState.FAILED);
    expect(failures[0]?.code).toBe(FileErrorCode.TOO_MANY_RETRIES);
  });
});

