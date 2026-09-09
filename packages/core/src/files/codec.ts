/**
 * File-transfer wire codec.
 *
 * Pure functions: no clock, no session, no state, so every rule can be tested
 * with a hand-written hostile payload. As in the chat codec, encoders throw
 * `Error` (our bug, be loud) and decoders throw `DecodeError` (their packet,
 * drop it).
 *
 * Eight of the nine messages are CBOR maps with one- or two-character keys. The
 * ninth, FILE_CHUNK, is hand-rolled binary: it is the only message sent
 * thousands of times, and CBOR's map framing would cost about twenty bytes of
 * every 180-byte Bluetooth datagram.
 */
import { encodeCbor, type CborValue } from '../protocol/cbor.js';
import { ByteReader, ByteWriter, DecodeError } from '../util/varint.js';
import { utf8Decode, utf8Encode } from '../util/bytes.js';
import {
  FILE_LIMITS,
  FileErrorCode,
  isSafeFilename,
  isValidTransferId,
  type FileOffer,
} from './types.js';
import { totalChunksFor } from './chunks.js';

// ---------------------------------------------------------------------------
// Bounded field readers
// ---------------------------------------------------------------------------

function asMap(value: CborValue | null | undefined, what: string): Record<string, CborValue> {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw new DecodeError(`file: ${what} must be a map`);
  }
  return value as Record<string, CborValue>;
}

function reqInt(value: CborValue | undefined, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new DecodeError(`file: ${what} must be an integer`);
  if (value < min || value > max) throw new DecodeError(`file: ${what} out of range`);
  return value;
}

function optInt(value: CborValue | undefined, what: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return reqInt(value, what, min, max);
}

function reqString(value: CborValue | undefined, what: string, maxChars: number): string {
  if (typeof value !== 'string') throw new DecodeError(`file: ${what} must be a string`);
  if (value.length > maxChars) throw new DecodeError(`file: ${what} exceeds ${maxChars} characters`);
  return value;
}

function optString(value: CborValue | undefined, what: string, maxChars: number): string {
  if (value === undefined || value === null) return '';
  return reqString(value, what, maxChars);
}

function reqBytes(value: CborValue | undefined, what: string, exactLength: number): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new DecodeError(`file: ${what} must be a byte string`);
  if (value.length !== exactLength) throw new DecodeError(`file: ${what} must be ${exactLength} bytes`);
  return value;
}

function optBoundedBytes(value: CborValue | undefined, what: string, maxLength: number): Uint8Array {
  if (value === undefined || value === null) return new Uint8Array(0);
  if (!(value instanceof Uint8Array)) throw new DecodeError(`file: ${what} must be a byte string`);
  if (value.length > maxLength) throw new DecodeError(`file: ${what} exceeds ${maxLength} bytes`);
  return value;
}

function reqTransferId(value: CborValue | undefined): string {
  const id = reqString(value, 'transferId', FILE_LIMITS.maxTransferIdChars);
  if (!isValidTransferId(id)) throw new DecodeError('file: transferId contains an illegal character');
  return id;
}

function reqErrorCode(value: CborValue | undefined): number {
  // Unknown codes are kept rather than rejected: a newer peer may have a reason
  // this build has never heard of, and "some error" still beats a dropped packet.
  return optInt(value, 'error code', 0, 0xffff, FileErrorCode.UNKNOWN);
}

// ---------------------------------------------------------------------------
// FILE_OFFER
// ---------------------------------------------------------------------------

export function encodeFileOffer(offer: FileOffer): CborValue {
  if (!isValidTransferId(offer.transferId)) throw new Error('encodeFileOffer: bad transfer id');
  if (!isSafeFilename(offer.filename)) throw new Error('encodeFileOffer: unusable filename');
  if (offer.fileHash.length !== FILE_LIMITS.fileHashBytes) throw new Error('encodeFileOffer: bad file hash length');
  if (offer.totalChunks !== totalChunksFor(offer.fileBytes, offer.chunkSize)) {
    throw new Error('encodeFileOffer: totalChunks does not match fileBytes/chunkSize');
  }
  return {
    i: offer.transferId,
    n: offer.filename,
    s: offer.fileBytes,
    m: offer.mimeType,
    c: offer.chunkSize,
    k: offer.totalChunks,
    h: offer.fileHash,
  };
}

export function decodeFileOffer(value: CborValue | null): FileOffer {
  const m = asMap(value, 'offer');
  const filename = reqString(m.n, 'filename', FILE_LIMITS.maxFilenameChars);
  // The single most dangerous field in the protocol: the app will use it to
  // name a file on disk. Rejected outright, never repaired.
  if (!isSafeFilename(filename)) throw new DecodeError('file: filename is not usable as a file name');

  const fileBytes = reqInt(m.s, 'fileBytes', 0, FILE_LIMITS.hardMaxFileBytes);
  const chunkSize = reqInt(m.c, 'chunkSize', FILE_LIMITS.minChunkBytes, FILE_LIMITS.maxChunkBytes);
  const totalChunks = reqInt(m.k, 'totalChunks', 0, FILE_LIMITS.maxChunks);
  // Recomputed, never trusted: a peer that claims one chunk for a 100 MB file
  // would otherwise steer the receiver into a bitmap that can never complete.
  if (totalChunks !== totalChunksFor(fileBytes, chunkSize)) {
    throw new DecodeError('file: totalChunks is inconsistent with fileBytes and chunkSize');
  }

  return {
    transferId: reqTransferId(m.i),
    filename,
    fileBytes,
    mimeType: optString(m.m, 'mimeType', FILE_LIMITS.maxMimeTypeChars),
    chunkSize,
    totalChunks,
    fileHash: reqBytes(m.h, 'fileHash', FILE_LIMITS.fileHashBytes),
  };
}

/**
 * Look at an offer we have already refused, purely so we can say why.
 *
 * `decodeFileOffer` throws on the first bad field, which leaves the caller with
 * no transfer id to answer. This reads the two fields needed for a decline and
 * returns null for anything it cannot trust - it is a courtesy, not a parser,
 * and nothing it returns is ever used to create a transfer.
 */
export function peekOfferBasics(value: CborValue | null): { transferId: string | null; filename: string | null } {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    return { transferId: null, filename: null };
  }
  const m = value as Record<string, CborValue>;
  const id = m.i;
  const name = m.n;
  return {
    transferId: typeof id === 'string' && isValidTransferId(id) ? id : null,
    filename: typeof name === 'string' && name.length <= FILE_LIMITS.maxFilenameChars ? name : null,
  };
}

// ---------------------------------------------------------------------------
// FILE_ACCEPT / FILE_DECLINE
// ---------------------------------------------------------------------------

export interface FileAcceptMessage {
  readonly transferId: string;
  /** Chunk messages the receiver will absorb before it acknowledges again. */
  readonly window: number;
}

export function encodeFileAccept(msg: FileAcceptMessage): CborValue {
  return { i: msg.transferId, w: msg.window };
}

export function decodeFileAccept(value: CborValue | null): FileAcceptMessage {
  const m = asMap(value, 'accept');
  return { transferId: reqTransferId(m.i), window: optInt(m.w, 'window', 1, 1024, 16) };
}

export interface FileDeclineMessage {
  readonly transferId: string;
  readonly code: number;
  readonly reason: string;
}

export function encodeFileDecline(msg: FileDeclineMessage): CborValue {
  return { i: msg.transferId, c: msg.code, r: msg.reason.slice(0, FILE_LIMITS.maxReasonChars) };
}

export function decodeFileDecline(value: CborValue | null): FileDeclineMessage {
  const m = asMap(value, 'decline');
  return {
    transferId: reqTransferId(m.i),
    code: reqErrorCode(m.c),
    reason: optString(m.r, 'reason', FILE_LIMITS.maxReasonChars),
  };
}

// ---------------------------------------------------------------------------
// FILE_CHUNK  (raw binary)
//
//   u8      transfer-id length (1..32)
//   bytes   transfer id, ASCII
//   varint  index of the first grid chunk
//   varint  run length, in grid chunks
//   8 bytes truncated digest binding id/index/run/length to the data
//   bytes   the data itself
// ---------------------------------------------------------------------------

export interface FileChunkMessage {
  readonly transferId: string;
  readonly index: number;
  readonly run: number;
  readonly digest: Uint8Array;
  readonly data: Uint8Array;
}

export function encodeFileChunk(transferId: string, index: number, run: number, digest: Uint8Array, data: Uint8Array): Uint8Array {
  const idBytes = utf8Encode(transferId);
  if (!isValidTransferId(transferId)) throw new Error('encodeFileChunk: bad transfer id');
  if (!Number.isInteger(index) || index < 0 || index >= FILE_LIMITS.maxChunks) {
    throw new Error('encodeFileChunk: index out of range');
  }
  if (!Number.isInteger(run) || run < 1 || run > FILE_LIMITS.maxRunChunks) {
    throw new Error('encodeFileChunk: run out of range');
  }
  if (digest.length !== FILE_LIMITS.chunkDigestBytes) throw new Error('encodeFileChunk: bad digest length');

  const w = new ByteWriter(idBytes.length + digest.length + data.length + 16);
  w.u8(idBytes.length);
  w.bytes(idBytes);
  w.varint(index);
  w.varint(run);
  w.bytes(digest);
  w.bytes(data);
  return w.finish();
}

export function decodeFileChunk(bytes: Uint8Array): FileChunkMessage {
  const r = new ByteReader(bytes);
  const idLength = r.u8();
  if (idLength < 1 || idLength > FILE_LIMITS.maxTransferIdChars) throw new DecodeError('file chunk: bad id length');
  const transferId = utf8Decode(r.bytes(idLength));
  if (!isValidTransferId(transferId)) throw new DecodeError('file chunk: illegal character in transfer id');

  const index = r.varint();
  if (index >= FILE_LIMITS.maxChunks) throw new DecodeError('file chunk: index out of range');
  const run = r.varint();
  if (run < 1 || run > FILE_LIMITS.maxRunChunks) throw new DecodeError('file chunk: run out of range');
  if (index + run > FILE_LIMITS.maxChunks) throw new DecodeError('file chunk: run extends past the chunk limit');

  const digest = r.bytes(FILE_LIMITS.chunkDigestBytes);
  const data = r.rest();
  if (data.length === 0) throw new DecodeError('file chunk: empty payload');
  if (data.length > FILE_LIMITS.maxRunChunks * FILE_LIMITS.maxChunkBytes) {
    throw new DecodeError('file chunk: payload exceeds the largest possible run');
  }
  // `digest` and `data` are subarrays of the received datagram; copying keeps
  // the transfer's state independent of a buffer the transport may recycle.
  return { transferId, index, run, digest: digest.slice(), data: data.slice() };
}

// ---------------------------------------------------------------------------
// FILE_CHUNK_ACK
// ---------------------------------------------------------------------------

export interface FileChunkAckMessage {
  readonly transferId: string;
  /** Number of grid chunks received contiguously from index 0. */
  readonly prefix: number;
  /** Selective ack for the chunks just above the prefix, LSB-first. */
  readonly bitmap: Uint8Array;
  /** Chunks that failed their digest and must be sent again. */
  readonly missing: readonly number[];
  /** How many further chunk messages the receiver will absorb. */
  readonly window: number;
}

export function encodeFileChunkAck(msg: FileChunkAckMessage): CborValue {
  if (msg.bitmap.length > FILE_LIMITS.maxAckBitmapBytes) throw new Error('encodeFileChunkAck: bitmap too long');
  if (msg.missing.length > FILE_LIMITS.maxNakEntries) throw new Error('encodeFileChunkAck: too many NAK entries');
  return {
    i: msg.transferId,
    p: msg.prefix,
    b: msg.bitmap,
    r: msg.missing.map((n) => n as CborValue),
    w: msg.window,
  };
}

export function decodeFileChunkAck(value: CborValue | null): FileChunkAckMessage {
  const m = asMap(value, 'chunk ack');
  const missing: number[] = [];
  const raw = m.r;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) throw new DecodeError('file: NAK list must be an array');
    if (raw.length > FILE_LIMITS.maxNakEntries) throw new DecodeError('file: NAK list is too long');
    for (const entry of raw) missing.push(reqInt(entry, 'NAK index', 0, FILE_LIMITS.maxChunks - 1));
  }
  return {
    transferId: reqTransferId(m.i),
    prefix: reqInt(m.p, 'ack prefix', 0, FILE_LIMITS.maxChunks),
    bitmap: optBoundedBytes(m.b, 'ack bitmap', FILE_LIMITS.maxAckBitmapBytes),
    missing,
    window: optInt(m.w, 'window', 0, 1024, 16),
  };
}

// ---------------------------------------------------------------------------
// FILE_RESUME
// ---------------------------------------------------------------------------

export interface FileResumeMessage {
  readonly transferId: string;
  readonly prefix: number;
  readonly bitmap: Uint8Array;
}

/** Bitmap covering every chunk: the widest a resume message may ever be. */
const MAX_RESUME_BITMAP_BYTES = (FILE_LIMITS.maxChunks + 7) >> 3;

export function encodeFileResume(msg: FileResumeMessage): CborValue {
  if (msg.bitmap.length > MAX_RESUME_BITMAP_BYTES) throw new Error('encodeFileResume: bitmap too long');
  return { i: msg.transferId, p: msg.prefix, b: msg.bitmap };
}

export function decodeFileResume(value: CborValue | null): FileResumeMessage {
  const m = asMap(value, 'resume');
  return {
    transferId: reqTransferId(m.i),
    prefix: reqInt(m.p, 'resume prefix', 0, FILE_LIMITS.maxChunks),
    bitmap: optBoundedBytes(m.b, 'resume bitmap', MAX_RESUME_BITMAP_BYTES),
  };
}

// ---------------------------------------------------------------------------
// FILE_COMPLETE / FILE_CANCEL / FILE_ERROR
// ---------------------------------------------------------------------------

export interface FileCompleteMessage {
  readonly transferId: string;
  /** The hash the RECEIVER computed from the bytes it wrote. */
  readonly fileHash: Uint8Array;
}

export function encodeFileComplete(msg: FileCompleteMessage): CborValue {
  if (msg.fileHash.length !== FILE_LIMITS.fileHashBytes) throw new Error('encodeFileComplete: bad hash length');
  return { i: msg.transferId, h: msg.fileHash };
}

export function decodeFileComplete(value: CborValue | null): FileCompleteMessage {
  const m = asMap(value, 'complete');
  return { transferId: reqTransferId(m.i), fileHash: reqBytes(m.h, 'fileHash', FILE_LIMITS.fileHashBytes) };
}

export interface FileCancelMessage {
  readonly transferId: string;
  readonly reason: string;
}

export function encodeFileCancel(msg: FileCancelMessage): CborValue {
  return { i: msg.transferId, r: msg.reason.slice(0, FILE_LIMITS.maxReasonChars) };
}

export function decodeFileCancel(value: CborValue | null): FileCancelMessage {
  const m = asMap(value, 'cancel');
  return { transferId: reqTransferId(m.i), reason: optString(m.r, 'reason', FILE_LIMITS.maxReasonChars) };
}

export interface FileErrorMessage {
  readonly transferId: string;
  readonly code: number;
  readonly message: string;
}

export function encodeFileError(msg: FileErrorMessage): CborValue {
  return { i: msg.transferId, c: msg.code, m: msg.message.slice(0, FILE_LIMITS.maxReasonChars) };
}

export function decodeFileError(value: CborValue | null): FileErrorMessage {
  const m = asMap(value, 'error');
  return {
    transferId: reqTransferId(m.i),
    code: reqErrorCode(m.c),
    message: optString(m.m, 'message', FILE_LIMITS.maxReasonChars),
  };
}

/** Encoded size of a CBOR control message. Used by tests and Developer Mode. */
export function encodedSize(value: CborValue): number {
  return encodeCbor(value).length;
}
