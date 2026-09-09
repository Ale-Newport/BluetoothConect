/**
 * File transfer - domain types, wire limits and the rules for untrusted input.
 *
 * The module is split so that every rule below can be tested on its own:
 * `types` (this file) holds the shapes and the bounds, `bitmap` the resume
 * state, `chunks` the sizing and hashing arithmetic, `codec` the pure wire
 * functions, `progress` the throughput maths, `transfer` the two state machines
 * and `protocol` the thin binding to a PeerSession.
 *
 * The module does NO file I/O. It reads and writes through an injected
 * `FileStore`, so the whole protocol runs in memory in a test and the app plugs
 * in react-native-blob-util without a single line here changing.
 */
import type { CborValue } from '../protocol/cbor.js';
import type { IncomingMessage } from '../session/peerSession.js';

// ---------------------------------------------------------------------------
// Limits
//
// Every one of these bounds something a peer controls. As in the chat module,
// they are enforced on both sides: our own encoder throws (our bug, be loud),
// the decoder raises DecodeError (their packet, drop it).
// ---------------------------------------------------------------------------

export const FILE_LIMITS = {
  /**
   * Transfer ids ride in the header of EVERY chunk. On a 180-byte BLE datagram
   * a 32-character id would be a fifth of the payload, so ids are short by
   * construction (13 characters from `newTransferId`) and merely bounded here.
   */
  maxTransferIdChars: 32,
  maxFilenameChars: 255,
  maxMimeTypeChars: 128,
  maxReasonChars: 80,

  /** Default ceiling on an offer we will accept. Apps may lower it. */
  defaultMaxFileBytes: 256 * 1024 * 1024,
  /** Ceiling on what any app may configure, and on what a peer may claim. */
  hardMaxFileBytes: 8 * 1024 * 1024 * 1024,

  minChunkBytes: 256,
  maxChunkBytes: 64 * 1024,
  /**
   * Chunk-count ceiling. It is really a bound on the resume bitmap: 2^17 chunks
   * is a 16 KB bitmap, which is two seconds of a BLE link and the most we are
   * willing to spend to restart a transfer.
   */
  maxChunks: 1 << 17,

  /**
   * Per-chunk digest length. The transport underneath is already
   * AEAD-authenticated, so this digest defends against corruption and against
   * our own bugs, not against a forging adversary - 64 bits is ample for that,
   * and a full 32-byte hash would eat a fifth of a BLE datagram.
   */
  chunkDigestBytes: 8,
  /** The whole-file hash is never truncated. */
  fileHashBytes: 32,

  /** Most grid chunks one FILE_CHUNK message may carry (see `chunks.ts`). */
  maxRunChunks: 64,
  /** Most chunk indices one FILE_CHUNK_ACK may re-request. */
  maxNakEntries: 32,
  /** Bytes of selective-ack bitmap in a FILE_CHUNK_ACK (16 bytes = 128 chunks). */
  maxAckBitmapBytes: 16,

  maxConcurrentIncoming: 3,
  maxConcurrentOutgoing: 3,
  /** Give up on a chunk the peer never acknowledges after this many sends. */
  maxChunkAttempts: 8,
} as const;

// ---------------------------------------------------------------------------
// Errors and states
// ---------------------------------------------------------------------------

/**
 * Why a transfer stopped. Sent in FILE_ERROR and FILE_DECLINE so the other side
 * can say something true to its user instead of "transfer failed".
 */
export const FileErrorCode = {
  UNKNOWN: 0,
  /** The offer was larger than this device is willing to accept. */
  TOO_LARGE: 1,
  /** The filename could not be used to name a file on disk. */
  BAD_FILENAME: 2,
  /** No transfer with that id. Also covers one that has already finished. */
  UNKNOWN_TRANSFER: 3,
  /** Concurrency limit reached. */
  BUSY: 4,
  /** The reassembled file did not match the offered hash. */
  HASH_MISMATCH: 5,
  /** readChunk/writeChunk failed. Local, and not the peer's fault. */
  STORAGE_FAILURE: 6,
  /** The peer sent something the protocol does not allow. */
  PROTOCOL_VIOLATION: 7,
  /** The user said no. */
  REJECTED_BY_USER: 8,
  /** A chunk was resent the maximum number of times without being accepted. */
  TOO_MANY_RETRIES: 9,
} as const;
export type FileErrorCode = (typeof FileErrorCode)[keyof typeof FileErrorCode];

const FILE_ERROR_NAMES = new Map<number, string>(
  Object.entries(FileErrorCode).map(([name, value]) => [value as number, name]),
);

export function fileErrorName(code: number): string {
  return FILE_ERROR_NAMES.get(code) ?? `UNKNOWN(${code})`;
}

export function isFileErrorCode(value: number): value is FileErrorCode {
  return FILE_ERROR_NAMES.has(value);
}

/**
 * Transfer lifecycle. Terminal states are COMPLETED, DECLINED, CANCELLED and
 * FAILED; a transfer never leaves one of those.
 */
export const TransferState = {
  /** Offered, awaiting the other side's answer. */
  OFFERED: 'offered',
  /** Accepted; chunks are moving. */
  TRANSFERRING: 'transferring',
  /** Every chunk is in. The receiver is re-reading what it wrote to verify it. */
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;
export type TransferState = (typeof TransferState)[keyof typeof TransferState];

export function isTerminalState(state: TransferState): boolean {
  return (
    state === TransferState.COMPLETED ||
    state === TransferState.DECLINED ||
    state === TransferState.CANCELLED ||
    state === TransferState.FAILED
  );
}

export const TransferDirection = {
  OUTGOING: 'outgoing',
  INCOMING: 'incoming',
} as const;
export type TransferDirection = (typeof TransferDirection)[keyof typeof TransferDirection];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * The only way this module touches bytes at rest.
 *
 * Both halves live on one interface because both are needed on both sides: the
 * sender reads the file it is sending, and the receiver reads back what it has
 * written in order to verify the whole-file hash. Verifying the bytes that
 * reached the disk - rather than the bytes that happened to pass through
 * memory - is what catches a truncated write, and it is the only check that
 * still works when a transfer is resumed in a new process.
 *
 * Implementations may resolve asynchronously; nothing here assumes otherwise.
 */
export interface FileStore {
  /** Read exactly `length` bytes at `offset`. Returning fewer is an error. */
  readChunk(offset: number, length: number): Promise<Uint8Array>;
  /** Write `bytes` at `offset`. Must be durable enough to be read back. */
  writeChunk(offset: number, bytes: Uint8Array): Promise<void>;
}

// ---------------------------------------------------------------------------
// Offers and resume
// ---------------------------------------------------------------------------

/**
 * What one side proposes to send. Every field of an inbound offer has been
 * validated by `decodeFileOffer` before it reaches an app.
 */
export interface FileOffer {
  readonly transferId: string;
  /**
   * The name the app will use on disk. Guaranteed by the decoder to contain no
   * path separator, no NUL and no other control character, and to be neither
   * "." nor "..".
   */
  readonly filename: string;
  readonly fileBytes: number;
  readonly mimeType: string;
  /** Size of one grid chunk. Fixed for the life of the transfer. */
  readonly chunkSize: number;
  /** ceil(fileBytes / chunkSize). Recomputed, never trusted. */
  readonly totalChunks: number;
  /** Hash chain over the chunk grid - see `computeFileHash`. */
  readonly fileHash: Uint8Array;
}

/**
 * Everything an app must persist to resume a half-received file after being
 * killed. Deliberately keyed on the CONTENT, not on the transfer id: an id
 * belongs to one attempt, whereas what makes a partial file resumable is that
 * the next offer describes the same bytes cut on the same grid.
 */
export interface ResumeState {
  readonly filename: string;
  readonly fileBytes: number;
  readonly chunkSize: number;
  readonly fileHash: Uint8Array;
  /** Packed received-chunk bitmap, LSB-first. Persist verbatim. */
  readonly bitmap: Uint8Array;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface TransferProgress {
  readonly transferId: string;
  readonly direction: TransferDirection;
  readonly filename: string;
  readonly state: TransferState;
  readonly totalBytes: number;
  readonly transferredBytes: number;
  /** 0..100, and never 100 until the transfer really is finished. */
  readonly percent: number;
  /** Measured, not the transport's nominal rate. Null until a sample exists. */
  readonly bytesPerSecond: number | null;
  /** Null when there is no throughput estimate yet. */
  readonly etaMs: number | null;
  /** True when nothing has moved for a while - usually a dropped link. */
  readonly stalled: boolean;
}

// ---------------------------------------------------------------------------
// The slice of PeerSession this module needs
// ---------------------------------------------------------------------------

/**
 * Structural, not nominal: a real `PeerSession` satisfies this, and so does a
 * three-line stub in a unit test. Keeping the surface this narrow is what lets
 * the transfer engines be tested without a handshake.
 */
export interface TransferSession {
  /** Largest application payload the peer will accept right now. */
  readonly maxPayloadBytes: number;
  readonly isHighBandwidth: boolean;
  /** Null while the session is reconnecting. */
  readonly currentLink: { readonly maxDatagramSize: number } | null;
  sendReliable(messageType: number, value: CborValue, options?: { bulk?: boolean }): number;
  sendReliableRaw(messageType: number, payload: Uint8Array, options?: { bulk?: boolean }): number;
  readonly events: {
    on(event: 'message', listener: (message: IncomingMessage) => void): () => void;
  };
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

/**
 * A peer chooses this string and the app uses it to name a file on disk, so it
 * is the single most dangerous field in the protocol.
 *
 * Rejected rather than sanitised: a name is an identifier both sides must agree
 * on, and quietly rewriting "../../etc/passwd" into "etcpasswd" would hand the
 * app a name the sender never sent. The rules are deliberately blunt -
 *
 *  - empty, or longer than 255 characters (the POSIX and NTFS component limit);
 *  - "." or "..", which name directories rather than files;
 *  - contains "/" or "\", the separators on every platform we ship to;
 *  - contains NUL or any other C0 control or DEL. NUL truncates a path in every
 *    C API underneath both platforms, so "safe.txt\0.exe" is two names.
 *
 * Everything else is allowed: the app is responsible for placing the file in a
 * sandboxed directory, which this check cannot do for it.
 */
export function isSafeFilename(name: string): boolean {
  if (name.length === 0 || name.length > FILE_LIMITS.maxFilenameChars) return false;
  if (name === '.' || name === '..') return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
    if (code === 0x2f /* / */ || code === 0x5c /* \ */) return false;
  }
  return true;
}

/** Throwing form, for names this device chose. Our bug, so it is loud. */
export function assertSafeFilename(name: string): string {
  if (!isSafeFilename(name)) throw new Error(`file transfer: unusable filename ${JSON.stringify(name)}`);
  return name;
}

/** Transfer ids travel in every chunk header, so the alphabet is restricted. */
export function isValidTransferId(id: string): boolean {
  if (id.length === 0 || id.length > FILE_LIMITS.maxTransferIdChars) return false;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;
    if (!ok) return false;
  }
  return true;
}
