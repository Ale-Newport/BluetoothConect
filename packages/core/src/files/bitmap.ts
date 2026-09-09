/**
 * The received-chunk bitmap: one bit per grid chunk, LSB-first.
 *
 * This is the whole of resume. A transfer interrupted at 80% resumes at 80%
 * because this structure - and nothing else - says which of the chunks are
 * already on disk. The app persists `toBytes()` alongside the file and hands it
 * back after a restart.
 *
 * Two encodings exist for a reason. `toBytes` is the durable one and covers
 * every chunk. `encodeResume` is the wire one and skips the contiguous prefix,
 * because the interesting case - "I have the first 80%, send me the rest" -
 * would otherwise spend 13 KB of a 40 KB/s link restating what both sides can
 * already infer from a single number.
 */
import { DecodeError } from '../util/varint.js';
import { FILE_LIMITS } from './types.js';

function byteLengthFor(chunkCount: number): number {
  return (chunkCount + 7) >> 3;
}

/** Reject padding bits above `chunkCount`: a peer must not set bits off the end. */
function assertNoPadding(bytes: Uint8Array, chunkCount: number): void {
  const spare = (byteLengthFor(chunkCount) << 3) - chunkCount;
  if (spare === 0) return;
  const last = bytes.length === 0 ? 0 : (bytes[bytes.length - 1] as number);
  const mask = 0xff << (8 - spare);
  if ((last & mask & 0xff) !== 0) throw new DecodeError('file bitmap: padding bits are set');
}

export class ChunkBitmap {
  private readonly bits: Uint8Array;
  private count = 0;

  constructor(readonly chunkCount: number) {
    if (!Number.isInteger(chunkCount) || chunkCount < 0 || chunkCount > FILE_LIMITS.maxChunks) {
      throw new Error(`ChunkBitmap: chunkCount ${chunkCount} out of range`);
    }
    this.bits = new Uint8Array(byteLengthFor(chunkCount));
  }

  get receivedCount(): number {
    return this.count;
  }

  get isComplete(): boolean {
    return this.count === this.chunkCount;
  }

  /** Out-of-range indices answer false rather than throwing: callers ask freely. */
  has(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.chunkCount) return false;
    return ((this.bits[index >> 3] as number) & (1 << (index & 7))) !== 0;
  }

  /** Returns true when the bit was not already set. */
  set(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.chunkCount) return false;
    const byte = index >> 3;
    const mask = 1 << (index & 7);
    if (((this.bits[byte] as number) & mask) !== 0) return false;
    this.bits[byte] = (this.bits[byte] as number) | mask;
    this.count++;
    return true;
  }

  clear(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.chunkCount) return;
    const byte = index >> 3;
    const mask = 1 << (index & 7);
    if (((this.bits[byte] as number) & mask) === 0) return;
    this.bits[byte] = (this.bits[byte] as number) & ~mask & 0xff;
    this.count--;
  }

  fill(): void {
    this.bits.fill(0xff);
    const spare = (this.bits.length << 3) - this.chunkCount;
    if (spare > 0 && this.bits.length > 0) {
      this.bits[this.bits.length - 1] = (0xff >>> spare) & 0xff;
    }
    this.count = this.chunkCount;
  }

  reset(): void {
    this.bits.fill(0);
    this.count = 0;
  }

  /** Index of the first unset bit at or after `from`, or -1 when there is none. */
  nextMissing(from = 0): number {
    for (let i = Math.max(0, from); i < this.chunkCount; i++) {
      if (!this.has(i)) return i;
    }
    return -1;
  }

  /** How many consecutive bits from index 0 are set. The cheap resume hint. */
  contiguousPrefix(): number {
    const missing = this.nextMissing(0);
    return missing < 0 ? this.chunkCount : missing;
  }

  /** Length of the run of set (or unset) bits starting at `index`, capped. */
  runLength(index: number, present: boolean, cap: number): number {
    let n = 0;
    while (n < cap && index + n < this.chunkCount && this.has(index + n) === present) n++;
    return n;
  }

  /** Up to `limit` missing indices at or after `from`. Used to build NAK lists. */
  missingIndices(from: number, limit: number): number[] {
    const out: number[] = [];
    for (let i = Math.max(0, from); i < this.chunkCount && out.length < limit; i++) {
      if (!this.has(i)) out.push(i);
    }
    return out;
  }

  /** A copy, so a caller cannot mutate our state by holding the buffer. */
  toBytes(): Uint8Array {
    return this.bits.slice();
  }

  clone(): ChunkBitmap {
    const copy = new ChunkBitmap(this.chunkCount);
    copy.bits.set(this.bits);
    copy.count = this.count;
    return copy;
  }

  /**
   * Rebuild from persisted bytes. Anything that does not describe exactly
   * `chunkCount` chunks is rejected - this input may have come from a peer, or
   * from a database written by an older build.
   */
  static fromBytes(bytes: Uint8Array, chunkCount: number): ChunkBitmap {
    if (!Number.isInteger(chunkCount) || chunkCount < 0 || chunkCount > FILE_LIMITS.maxChunks) {
      throw new DecodeError('file bitmap: chunk count out of range');
    }
    if (bytes.length !== byteLengthFor(chunkCount)) {
      throw new DecodeError(`file bitmap: expected ${byteLengthFor(chunkCount)} bytes, got ${bytes.length}`);
    }
    assertNoPadding(bytes, chunkCount);
    const map = new ChunkBitmap(chunkCount);
    map.bits.set(bytes);
    let count = 0;
    for (let i = 0; i < bytes.length; i++) {
      let b = bytes[i] as number;
      while (b !== 0) {
        count += b & 1;
        b >>>= 1;
      }
    }
    map.count = count;
    return map;
  }

  /**
   * Wire form: the length of the leading all-present run, plus a bitmap for
   * everything above it.
   */
  encodeResume(): { prefix: number; bytes: Uint8Array } {
    const prefix = this.contiguousPrefix();
    const remaining = this.chunkCount - prefix;
    const out = new Uint8Array(byteLengthFor(remaining));
    for (let i = 0; i < remaining; i++) {
      if (this.has(prefix + i)) out[i >> 3] = (out[i >> 3] as number) | (1 << (i & 7));
    }
    return { prefix, bytes: out };
  }

  /** Inverse of `encodeResume`. Every field is bounded; this came from a peer. */
  static decodeResume(prefix: number, bytes: Uint8Array, chunkCount: number): ChunkBitmap {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > chunkCount) {
      throw new DecodeError('file bitmap: resume prefix out of range');
    }
    const remaining = chunkCount - prefix;
    if (bytes.length !== byteLengthFor(remaining)) {
      throw new DecodeError('file bitmap: resume bitmap has the wrong length');
    }
    assertNoPadding(bytes, remaining);
    const map = new ChunkBitmap(chunkCount);
    for (let i = 0; i < prefix; i++) map.set(i);
    for (let i = 0; i < remaining; i++) {
      if (((bytes[i >> 3] as number) & (1 << (i & 7))) !== 0) map.set(prefix + i);
    }
    return map;
  }
}
