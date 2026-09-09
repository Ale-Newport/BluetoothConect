/**
 * Chunk arithmetic: how big a chunk is, how many of them ride in one message,
 * and how both sides agree on what the bytes hash to.
 *
 * The central decision of this module lives here, so it is worth stating
 * plainly:
 *
 *   The GRID is fixed for the life of a transfer. The TRANSMISSION UNIT is not.
 *
 * A resume bitmap is only meaningful if both sides cut the file the same way,
 * and a transfer that is resumed after the app was killed - possibly over a
 * different radio - cannot renegotiate that grid without throwing away the
 * partial file. So `chunkSize` is chosen once, at offer time, and carried in
 * the offer.
 *
 * Adapting to the live link therefore happens one level up: a FILE_CHUNK
 * message carries a RUN of adjacent grid chunks, and the run length is
 * recomputed from the session's current payload budget every time a message is
 * built. A transfer that starts on Bluetooth with a 256-byte grid sends one
 * chunk per message; the moment it migrates to Wi-Fi the same transfer starts
 * sending runs of 64, i.e. 16 KB per message, with no restart and no change to
 * the bitmap.
 */
import { hash256 } from '../crypto/primitives.js';
import { ByteWriter } from '../util/varint.js';
import { utf8Encode } from '../util/bytes.js';
import { FILE_LIMITS, type FileStore } from './types.js';

/**
 * What a SECURE frame plus its envelope costs on top of the application
 * payload: an 18-byte secure header, a 16-byte AEAD tag, and roughly 26 bytes
 * of envelope (channel, flags, seq, ack, ackBits, type, timestamp, length).
 * Rounded up, because being wrong in this direction only wastes a few bytes
 * while being wrong in the other direction costs a fragment.
 */
export const DATAGRAM_FRAMING_OVERHEAD = 72;

/** Bytes a FILE_CHUNK header costs for a given transfer-id length. */
export function chunkHeaderBytes(transferIdLength: number): number {
  // 1 id length + id + varint index (<= 3 bytes at 2^17 chunks) + varint run
  // (<= 2 bytes) + the truncated digest.
  return 1 + transferIdLength + 3 + 2 + FILE_LIMITS.chunkDigestBytes;
}

export interface ChunkSizingInput {
  /** Largest application payload the peer will accept (session.maxPayloadBytes). */
  readonly payloadBudget: number;
  /** Largest single datagram the live link carries, before framing. */
  readonly datagramBytes: number;
  readonly isHighBandwidth: boolean;
  readonly fileBytes: number;
  readonly transferIdLength: number;
}

/**
 * Pick the grid size for a new transfer.
 *
 * The starting point is "one chunk per datagram": on BLE that keeps a
 * retransmission cheap and makes progress visible immediately. A link that is
 * genuinely fast gets a much larger grid, but only if its datagrams are also
 * large - a transport that calls itself high-bandwidth while handing us
 * 180-byte datagrams is Bluetooth wearing a hat, and sizing a 16 KB chunk for
 * it would mean 95 fragments riding or dying together.
 */
export function chooseChunkSize(input: ChunkSizingInput): number {
  const header = chunkHeaderBytes(input.transferIdLength);
  const perDatagram = Math.max(0, input.datagramBytes - DATAGRAM_FRAMING_OVERHEAD - header);
  const perMessage = Math.max(0, input.payloadBudget - header);

  let size = clamp(perDatagram, FILE_LIMITS.minChunkBytes, FILE_LIMITS.maxChunkBytes);
  if (input.isHighBandwidth && perDatagram >= 1024) {
    size = clamp(Math.min(perMessage, 16 * 1024), size, FILE_LIMITS.maxChunkBytes);
  }
  size = Math.min(size, Math.max(FILE_LIMITS.minChunkBytes, perMessage));

  // Grow the grid until the bitmap is a size we are willing to send. Doubling
  // keeps chunk boundaries on tidy powers of two for the common cases.
  while (size < FILE_LIMITS.maxChunkBytes && totalChunksFor(input.fileBytes, size) > FILE_LIMITS.maxChunks) {
    size = Math.min(size * 2, FILE_LIMITS.maxChunkBytes);
  }
  if (totalChunksFor(input.fileBytes, size) > FILE_LIMITS.maxChunks) {
    throw new Error(`file transfer: ${input.fileBytes} bytes cannot be cut into at most ${FILE_LIMITS.maxChunks} chunks`);
  }
  return size;
}

/**
 * How many adjacent grid chunks to put in one message on the link as it is
 * right now. Recomputed per message, which is what makes a mid-flight transport
 * upgrade free.
 */
export function chooseRunLength(chunkSize: number, payloadBudget: number, transferIdLength: number): number {
  const usable = payloadBudget - chunkHeaderBytes(transferIdLength);
  if (usable < chunkSize) return 1; // one chunk may exceed the budget; fragmentation covers it
  return clamp(Math.floor(usable / chunkSize), 1, FILE_LIMITS.maxRunChunks);
}

export function totalChunksFor(fileBytes: number, chunkSize: number): number {
  if (fileBytes <= 0) return 0;
  return Math.ceil(fileBytes / chunkSize);
}

/** Byte length of the run [index, index + run), clipped to the end of the file. */
export function runByteLength(fileBytes: number, chunkSize: number, index: number, run: number): number {
  const start = index * chunkSize;
  const end = Math.min(fileBytes, (index + run) * chunkSize);
  return Math.max(0, end - start);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const CHUNK_DOMAIN = utf8Encode('airlink/file-chunk/v1');
const FILE_DOMAIN = utf8Encode('airlink/file/v1');

/**
 * Per-message digest, truncated.
 *
 * The transfer id, the index, the run length and the byte length are all bound
 * into the hash, so a chunk that verifies at offset X cannot be replayed at
 * offset Y or spliced into a different transfer. Without that binding a peer
 * could resend chunk 0 as chunk 900 and the digest would still check out.
 */
export function chunkDigest(transferId: string, index: number, run: number, data: Uint8Array): Uint8Array {
  const w = new ByteWriter(64);
  w.bytes(CHUNK_DOMAIN);
  w.lenBytes(utf8Encode(transferId));
  w.varint(index);
  w.varint(run);
  w.varint(data.length);
  return hash256(w.finish(), data).slice(0, FILE_LIMITS.chunkDigestBytes);
}

/**
 * The whole-file hash is a chain over the chunk grid rather than a plain
 * SHA-256 of the file:
 *
 *     acc[0]   = H(domain || fileBytes || chunkSize)
 *     acc[i+1] = H(acc[i] || chunk[i])
 *
 * `hash256` takes whole buffers, and a 120 MB file does not fit in a phone's
 * heap; the chain gives the same collision resistance in constant memory and
 * binds the chunk order as well as the content. It is defined over the grid, so
 * both sides compute the identical value from the same `chunkSize` - which is
 * exactly why `chunkSize` is part of the resume key.
 */
export function fileHashSeed(fileBytes: number, chunkSize: number): Uint8Array {
  const w = new ByteWriter(48);
  w.bytes(FILE_DOMAIN);
  w.u64(fileBytes);
  w.u32(chunkSize);
  return hash256(w.finish());
}

export function foldFileHash(accumulator: Uint8Array, chunkData: Uint8Array): Uint8Array {
  return hash256(accumulator, chunkData);
}

/**
 * Read a whole file through the store and produce its hash. One full pass: the
 * honest price of promising the receiver that what arrived is what was sent.
 * Apps that already know the hash pass it to `offer()` and skip this.
 */
export async function computeFileHash(store: FileStore, fileBytes: number, chunkSize: number): Promise<Uint8Array> {
  let acc = fileHashSeed(fileBytes, chunkSize);
  for (let offset = 0; offset < fileBytes; offset += chunkSize) {
    const length = Math.min(chunkSize, fileBytes - offset);
    const data = await store.readChunk(offset, length);
    if (data.length !== length) {
      throw new Error(`computeFileHash: short read at ${offset} (${data.length} of ${length} bytes)`);
    }
    acc = foldFileHash(acc, data);
  }
  return acc;
}
