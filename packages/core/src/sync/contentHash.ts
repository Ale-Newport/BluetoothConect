/**
 * Sampled content hash - "are we holding the same file?" without reading 4 GB.
 *
 * THE TRADE-OFF, STATED HONESTLY
 *
 * Hashing a whole film is not an option. A 4 GB file at the ~200 MB/s a phone's
 * flash and JS bridge will actually sustain is twenty seconds of spinner before
 * anybody can press play, and it burns battery on both devices. So we hash a
 * SAMPLE: the exact byte length, plus SHA-256 over a handful of fixed-offset
 * windows - by default eight windows of 64 KiB, evenly spaced, the first
 * starting at byte 0 and the last ending exactly at EOF.
 *
 * What that buys, and what it does not:
 *
 *  - Against ACCIDENT it is very strong. Two different encodes of the same film
 *    differ in size almost always, and when they do not they differ in the
 *    container header - which is inside the very first window. A truncated or
 *    half-downloaded copy fails on size. A single flipped bit anywhere in the
 *    512 KiB we read fails on the digest. This is the failure mode that
 *    actually happens, and it is caught.
 *  - Against an ADVERSARY it is not a commitment. Someone who controls a file
 *    can trivially make two files that agree on size and on all eight windows
 *    and differ everywhere else, because they know exactly which bytes are read.
 *    A second-preimage claim would need the whole file.
 *
 * We accept that, deliberately, and the reason is that the threat model does not
 * need it. The peer sending this hash is already an authenticated, previously
 * paired friend on an end-to-end encrypted session; the worst a malicious one
 * achieves is that the two phones play different videos in step, which is a
 * prank and not a compromise. Nothing security-relevant is derived from this
 * value: it gates a playback session, never a key, a permission or a file write.
 *
 * If a caller ever needs a real commitment - say, verifying a file that arrived
 * over the file-transfer module - that is a full hash of the received bytes, and
 * it belongs in that module, not here.
 */
import { hash256 } from '../crypto/primitives.js';
import { utf8Encode, writeUint64BE } from '../util/bytes.js';
import { SYNC_LIMITS, type ContentDescriptor } from './types.js';

/** Domain separator. Keeps this digest from ever colliding with another one. */
const HASH_DOMAIN = utf8Encode('airlink/sync/content-hash/v1');

export interface SamplePlan {
  /** How many windows to read. */
  readonly windowCount: number;
  /** Bytes per window. */
  readonly windowBytes: number;
}

export const DEFAULT_SAMPLE_PLAN: SamplePlan = {
  windowCount: 8,
  windowBytes: 64 * 1024,
};

/**
 * Where the file must be read from, given its size.
 *
 * A file small enough to be covered entirely by the plan is hashed whole - the
 * sampling is an optimisation for large files, not a weakening we apply to
 * small ones for its own sake.
 *
 * Otherwise the windows are spread so that the first starts at 0 and the last
 * ends at EOF, which is where the two most discriminating regions of a media
 * file live: the container header, and (for MP4s written by a phone) the moov
 * atom at the tail.
 */
export function sampledWindowOffsets(byteLength: number, plan: SamplePlan = DEFAULT_SAMPLE_PLAN): readonly number[] {
  assertPlan(plan);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > SYNC_LIMITS.maxContentBytes) {
    throw new Error(`sync: byteLength ${byteLength} is out of range`);
  }
  if (byteLength === 0) return [];
  if (byteLength <= plan.windowCount * plan.windowBytes) return [0];

  const span = byteLength - plan.windowBytes;
  const out: number[] = [];
  for (let i = 0; i < plan.windowCount; i++) {
    out.push(Math.floor((i * span) / (plan.windowCount - 1)));
  }
  return out;
}

/**
 * How many bytes the window at `offset` covers. Only the whole-file case and
 * the final window can be short.
 */
export function sampledWindowLength(
  byteLength: number,
  offset: number,
  plan: SamplePlan = DEFAULT_SAMPLE_PLAN,
): number {
  if (byteLength <= plan.windowCount * plan.windowBytes) return byteLength;
  return Math.min(plan.windowBytes, byteLength - offset);
}

/**
 * Random access to the file's bytes.
 *
 * Async because every real implementation is (RNFS, a content:// stream, a
 * SAF descriptor), and sync in the fake used by tests - hence the union return.
 */
export interface ContentSampleReader {
  readonly byteLength: number;
  /**
   * Return exactly `length` bytes starting at `offset`. Returning fewer is an
   * error, not something to be papered over: a short read would otherwise
   * produce a digest that looks perfectly valid and matches nothing.
   */
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}

/**
 * SHA-256 over the sampled windows.
 *
 * The plan parameters are hashed in alongside the data. Two builds that disagree
 * about how many windows to read must produce different digests and report an
 * honest mismatch, rather than compare two numbers computed different ways and
 * declare a match that is not one.
 */
export async function computeSampledContentHash(
  reader: ContentSampleReader,
  plan: SamplePlan = DEFAULT_SAMPLE_PLAN,
): Promise<Uint8Array> {
  const byteLength = reader.byteLength;
  const offsets = sampledWindowOffsets(byteLength, plan);

  const parts: Uint8Array[] = [HASH_DOMAIN, headerBytes(byteLength, plan, offsets.length)];
  for (const offset of offsets) {
    const length = sampledWindowLength(byteLength, offset, plan);
    const chunk = await reader.read(offset, length);
    if (!(chunk instanceof Uint8Array)) throw new Error('sync: content reader returned a non-Uint8Array');
    if (chunk.length !== length) {
      throw new Error(`sync: short read at offset ${offset}: wanted ${length}, got ${chunk.length}`);
    }
    parts.push(windowHeaderBytes(offset, length), chunk);
  }
  return hash256(...parts);
}

/** Build the full descriptor a peer will be asked to match against. */
export async function describeContent(
  reader: ContentSampleReader,
  meta: { contentId: string; durationMs: number; title?: string; mimeType?: string },
  plan: SamplePlan = DEFAULT_SAMPLE_PLAN,
): Promise<ContentDescriptor> {
  if (!Number.isFinite(meta.durationMs) || meta.durationMs < 0) {
    throw new Error('sync: durationMs must be a non-negative finite number');
  }
  const sampledHash = await computeSampledContentHash(reader, plan);
  return {
    contentId: meta.contentId,
    byteLength: reader.byteLength,
    durationMs: Math.round(meta.durationMs),
    sampledHash,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.mimeType !== undefined ? { mimeType: meta.mimeType } : {}),
  };
}

function headerBytes(byteLength: number, plan: SamplePlan, windowCount: number): Uint8Array {
  const out = new Uint8Array(8 + 4 + 4 + 4);
  const view = new DataView(out.buffer);
  writeUint64BE(view, 0, byteLength);
  view.setUint32(8, plan.windowCount, false);
  view.setUint32(12, plan.windowBytes, false);
  // The realised window count differs from the planned one for a small file.
  view.setUint32(16, windowCount, false);
  return out;
}

function windowHeaderBytes(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(8 + 4);
  const view = new DataView(out.buffer);
  writeUint64BE(view, 0, offset);
  view.setUint32(8, length, false);
  return out;
}

function assertPlan(plan: SamplePlan): void {
  if (!Number.isSafeInteger(plan.windowCount) || plan.windowCount < 2 || plan.windowCount > 256) {
    throw new Error('sync: windowCount must be an integer in [2, 256]');
  }
  if (!Number.isSafeInteger(plan.windowBytes) || plan.windowBytes < 1 || plan.windowBytes > 1 << 22) {
    throw new Error('sync: windowBytes must be an integer in [1, 4 MiB]');
  }
}
