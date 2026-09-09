/**
 * An in-memory `FileStore`.
 *
 * Not a toy: it is what the whole file-transfer test suite runs against, and
 * Developer Mode uses it to send a synthetic file without touching the photo
 * library. The real app supplies a store backed by react-native-blob-util - the
 * protocol cannot tell the difference, which is exactly the point of the
 * interface.
 */
import type { FileStore } from './types.js';

export class MemoryFileStore implements FileStore {
  readonly bytes: Uint8Array;
  /** Ranges actually written, in call order. Lets a test assert write patterns. */
  readonly writes: { offset: number; length: number }[] = [];
  reads = 0;

  constructor(sizeOrContents: number | Uint8Array) {
    this.bytes = typeof sizeOrContents === 'number' ? new Uint8Array(sizeOrContents) : sizeOrContents;
  }

  async readChunk(offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new Error('MemoryFileStore: bad read range');
    }
    if (offset + length > this.bytes.length) throw new Error('MemoryFileStore: read past the end of the file');
    this.reads++;
    return this.bytes.slice(offset, offset + length);
  }

  async writeChunk(offset: number, data: Uint8Array): Promise<void> {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('MemoryFileStore: bad write offset');
    if (offset + data.length > this.bytes.length) throw new Error('MemoryFileStore: write past the end of the file');
    this.bytes.set(data, offset);
    this.writes.push({ offset, length: data.length });
  }
}
