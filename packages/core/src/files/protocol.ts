/**
 * FileTransferProtocol - the thin binding between the two transfer engines and
 * a live PeerSession.
 *
 * Everything policy-shaped lives here: what we are willing to accept, how many
 * transfers may run at once, which channel a message rides on, and what happens
 * to a packet that names a transfer we have never heard of. The engines below
 * are deliberately free of all of it so they can be unit-tested in isolation.
 *
 * Channel discipline, which is a product decision as much as a protocol one:
 * chunks go on BULK and everything else goes on RELIABLE. That is what stops a
 * 100 MB video from delaying a chat message, and equally what stops the
 * acknowledgements that open the sender's window from queueing behind the very
 * chunks they are meant to acknowledge.
 */
import { MessageType } from '../protocol/constants.js';
import type { CborValue } from '../protocol/cbor.js';
import type { RandomSource } from '../crypto/random.js';
import { TypedEmitter } from '../util/emitter.js';
import { toBase32 } from '../util/bytes.js';
import { DecodeError } from '../util/varint.js';
import { Logger, silentLogger } from '../util/logger.js';
import type { Clock, TimerHandle } from '../util/time.js';
import type { IncomingMessage } from '../session/peerSession.js';
import { chooseChunkSize, computeFileHash, totalChunksFor } from './chunks.js';
import {
  decodeFileAccept,
  decodeFileCancel,
  decodeFileChunk,
  decodeFileChunkAck,
  decodeFileComplete,
  decodeFileDecline,
  decodeFileError,
  decodeFileOffer,
  decodeFileResume,
  encodeFileDecline,
  encodeFileError,
  encodeFileOffer,
  peekOfferBasics,
} from './codec.js';
import {
  BaseTransfer,
  DEFAULT_TUNING,
  IncomingTransfer,
  OutgoingTransfer,
  type TransferListener,
  type TransferTuning,
  type TransferWire,
} from './transfer.js';
import {
  FILE_LIMITS,
  FileErrorCode,
  TransferDirection,
  assertSafeFilename,
  isSafeFilename,
  type FileOffer,
  type FileStore,
  type ResumeState,
  type TransferProgress,
  type TransferSession,
} from './types.js';

export interface FileTransferEvents {
  /** A peer offered a file. Answer with accept() or decline(). */
  offer: { readonly offer: FileOffer };
  /** Emitted on the protocol's timer while a transfer is running. */
  progress: { readonly progress: TransferProgress };
  completed: {
    readonly transferId: string;
    readonly direction: TransferDirection;
    readonly filename: string;
    readonly fileBytes: number;
    readonly fileHash: Uint8Array;
  };
  declined: { readonly transferId: string; readonly code: number; readonly reason: string };
  cancelled: {
    readonly transferId: string;
    readonly direction: TransferDirection;
    readonly reason: string;
    readonly byPeer: boolean;
  };
  failed: {
    readonly transferId: string;
    readonly direction: TransferDirection;
    readonly code: FileErrorCode;
    readonly message: string;
  };
  stateChanged: { readonly transferId: string; readonly progress: TransferProgress };
}

export interface FileTransferOptions {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly logger?: Logger;
  /** Largest offer this device will accept. Bounded by FILE_LIMITS. */
  readonly maxFileBytes?: number;
  readonly maxConcurrentIncoming?: number;
  readonly maxConcurrentOutgoing?: number;
  readonly tuning?: TransferTuning;
  /** How often retransmits, acknowledgements and progress are serviced. */
  readonly tickIntervalMs?: number;
}

export interface OfferInput {
  readonly filename: string;
  readonly fileBytes: number;
  readonly mimeType?: string;
  readonly store: FileStore;
  /** Supply to reuse an id chosen elsewhere; otherwise one is generated. */
  readonly transferId?: string;
  /**
   * A cached whole-file hash. Only valid alongside the `chunkSize` it was
   * computed with - the hash is defined over the chunk grid.
   */
  readonly fileHash?: Uint8Array;
  readonly chunkSize?: number;
}

/** 13 characters of Crockford base32: short enough to ride in every chunk header. */
export function newTransferId(random: RandomSource): string {
  return toBase32(random.randomBytes(8)).slice(0, 13);
}

export class FileTransferProtocol {
  readonly events = new TypedEmitter<FileTransferEvents>();

  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly incoming = new Map<string, IncomingTransfer>();
  /** Ids of transfers that have ended, so late packets are ignored quietly. */
  private readonly finished: string[] = [];
  private readonly wire: TransferWire;
  private readonly listener: TransferListener;
  private readonly unsubscribe: () => void;
  private readonly log: Logger;
  private readonly tuning: TransferTuning;
  private readonly maxFileBytes: number;
  private readonly maxIncoming: number;
  private readonly maxOutgoing: number;
  private readonly tickIntervalMs: number;
  private tickTimer: TimerHandle | undefined;
  private disposed = false;

  /** Developer-mode counters. */
  droppedPackets = 0;
  malformedPackets = 0;
  sendFailures = 0;

  constructor(
    private readonly session: TransferSession,
    private readonly options: FileTransferOptions,
  ) {
    this.log = (options.logger ?? silentLogger).child('files');
    this.tuning = options.tuning ?? DEFAULT_TUNING;
    this.maxFileBytes = Math.min(
      options.maxFileBytes ?? FILE_LIMITS.defaultMaxFileBytes,
      FILE_LIMITS.hardMaxFileBytes,
    );
    this.maxIncoming = options.maxConcurrentIncoming ?? FILE_LIMITS.maxConcurrentIncoming;
    this.maxOutgoing = options.maxConcurrentOutgoing ?? FILE_LIMITS.maxConcurrentOutgoing;
    this.tickIntervalMs = Math.max(50, options.tickIntervalMs ?? 250);

    // `session` is captured rather than reached through `this`, so the getter
    // below reads the live budget without binding surprises.
    const session_ = session;
    this.wire = {
      sendControl: (messageType: number, value: CborValue): boolean => {
        try {
          session_.sendReliable(messageType, value);
          return true;
        } catch (err) {
          this.sendFailures++;
          this.log.debug('control send failed', { err: String(err) });
          return false;
        }
      },
      sendChunk: (payload: Uint8Array): boolean => {
        try {
          session_.sendReliableRaw(MessageType.FILE_CHUNK, payload, { bulk: true });
          return true;
        } catch (err) {
          this.sendFailures++;
          this.log.debug('chunk send failed', { err: String(err) });
          return false;
        }
      },
      get payloadBudget(): number {
        return session_.maxPayloadBytes;
      },
    };

    this.listener = {
      onStateChanged: (t) => this.events.emit('stateChanged', { transferId: t.transferId, progress: t.progress() }),
      onProgress: (t) => this.events.emit('progress', { progress: t.progress() }),
      onCompleted: (t) => {
        this.retire(t);
        this.events.emit('progress', { progress: t.progress() });
        this.events.emit('completed', {
          transferId: t.transferId,
          direction: t.direction,
          filename: t.offer.filename,
          fileBytes: t.offer.fileBytes,
          fileHash: t.offer.fileHash,
        });
      },
      onFailed: (t, code, message) => {
        this.retire(t);
        this.events.emit('failed', { transferId: t.transferId, direction: t.direction, code, message });
      },
      onCancelled: (t, reason, byPeer) => {
        this.retire(t);
        this.events.emit('cancelled', { transferId: t.transferId, direction: t.direction, reason, byPeer });
      },
      onDeclined: (t, code, reason) => {
        this.retire(t);
        this.events.emit('declined', { transferId: t.transferId, code, reason });
      },
    };

    this.unsubscribe = session.events.on('message', (message) => this.handleMessage(message));
  }

  // -- public surface --------------------------------------------------------

  /**
   * Offer a file. Resolves once the offer is on its way, which is after one
   * full pass over the file to hash it - the honest price of promising the
   * receiver that what arrives is what was sent.
   */
  async offer(input: OfferInput): Promise<string> {
    if (this.disposed) throw new Error('FileTransferProtocol: disposed');
    assertSafeFilename(input.filename);
    if (!Number.isInteger(input.fileBytes) || input.fileBytes < 0 || input.fileBytes > this.maxFileBytes) {
      throw new Error(`FileTransferProtocol: ${input.fileBytes} bytes is outside the configured limit`);
    }
    if (this.outgoing.size >= this.maxOutgoing) {
      throw new Error(`FileTransferProtocol: already sending ${this.outgoing.size} files`);
    }

    const transferId = input.transferId ?? newTransferId(this.options.random);
    if (this.outgoing.has(transferId) || this.incoming.has(transferId)) {
      throw new Error(`FileTransferProtocol: duplicate transfer id ${transferId}`);
    }

    const chunkSize =
      input.chunkSize ??
      chooseChunkSize({
        payloadBudget: this.session.maxPayloadBytes,
        datagramBytes: this.session.currentLink?.maxDatagramSize ?? 180,
        isHighBandwidth: this.session.isHighBandwidth,
        fileBytes: input.fileBytes,
        transferIdLength: transferId.length,
      });
    const fileHash = input.fileHash ?? (await computeFileHash(input.store, input.fileBytes, chunkSize));

    const offer: FileOffer = {
      transferId,
      filename: input.filename,
      fileBytes: input.fileBytes,
      mimeType: input.mimeType ?? '',
      chunkSize,
      totalChunks: totalChunksFor(input.fileBytes, chunkSize),
      fileHash,
    };

    const transfer = new OutgoingTransfer(offer, input.store, this.wire, this.options.clock, this.listener, this.tuning);
    this.outgoing.set(transferId, transfer);
    this.ensureTicking();
    this.wire.sendControl(MessageType.FILE_OFFER, encodeFileOffer(offer));
    return transferId;
  }

  /** Accept an offer. `resume` is the state a previous attempt persisted. */
  accept(transferId: string, store: FileStore, resume?: ResumeState): void {
    const transfer = this.incoming.get(transferId);
    if (!transfer) throw new Error(`FileTransferProtocol: no pending offer ${transferId}`);
    transfer.accept(store, resume);
    this.ensureTicking();
  }

  decline(transferId: string, reason = 'declined'): void {
    const transfer = this.incoming.get(transferId);
    if (!transfer) return;
    this.wire.sendControl(
      MessageType.FILE_DECLINE,
      encodeFileDecline({ transferId, code: FileErrorCode.REJECTED_BY_USER, reason }),
    );
    transfer.decline(FileErrorCode.REJECTED_BY_USER, reason);
  }

  /** Cancel from either side, at any point. */
  cancel(transferId: string, reason = 'cancelled'): void {
    const transfer = this.outgoing.get(transferId) ?? this.incoming.get(transferId);
    if (!transfer) return;
    transfer.cancel(reason);
  }

  /**
   * Tell every running transfer that the session moved to a different link.
   * Receivers re-advertise what they hold, senders re-open whatever was in
   * flight, and chunk sizing picks up the new link's budget on the next message.
   */
  notifyLinkChanged(): void {
    for (const transfer of [...this.outgoing.values(), ...this.incoming.values()]) transfer.onLinkChanged();
  }

  progressOf(transferId: string): TransferProgress | null {
    const transfer = this.outgoing.get(transferId) ?? this.incoming.get(transferId);
    return transfer ? transfer.progress() : null;
  }

  /** Persistable resume state, so a half-received file survives being killed. */
  snapshot(transferId: string): ResumeState | null {
    return this.incoming.get(transferId)?.snapshot() ?? this.outgoing.get(transferId)?.snapshot() ?? null;
  }

  get activeTransfers(): readonly BaseTransfer[] {
    return [...this.outgoing.values(), ...this.incoming.values()];
  }

  diagnostics(): Record<string, unknown> {
    return {
      outgoing: this.outgoing.size,
      incoming: this.incoming.size,
      droppedPackets: this.droppedPackets,
      malformedPackets: this.malformedPackets,
      sendFailures: this.sendFailures,
      rejectedChunks: [...this.incoming.values()].reduce((n, t) => n + t.rejectedChunks, 0),
      payloadBudget: this.session.maxPayloadBytes,
    };
  }

  /** Detach from the session. Running transfers are dropped, not cancelled. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.stopTicking();
    this.outgoing.clear();
    this.incoming.clear();
    this.events.removeAllListeners();
  }

  // -- inbound ---------------------------------------------------------------

  private handleMessage(message: IncomingMessage): void {
    if (this.disposed) return;
    try {
      switch (message.type) {
        case MessageType.FILE_OFFER:
          this.handleOffer(message.value);
          return;
        case MessageType.FILE_ACCEPT: {
          const msg = decodeFileAccept(message.value);
          this.outgoingFor(msg.transferId)?.handleAccept(msg.window);
          return;
        }
        case MessageType.FILE_DECLINE: {
          const msg = decodeFileDecline(message.value);
          this.outgoingFor(msg.transferId)?.handleDecline(msg.code, msg.reason);
          return;
        }
        case MessageType.FILE_CHUNK: {
          const msg = decodeFileChunk(message.raw);
          const transfer = this.incoming.get(msg.transferId);
          // A chunk naming a transfer we do not have is dropped in silence: an
          // error per chunk would turn one confused peer into a packet storm on
          // a link that carries 40 KB a second.
          if (!transfer) {
            this.droppedPackets++;
            return;
          }
          transfer.handleChunk(msg);
          return;
        }
        case MessageType.FILE_CHUNK_ACK: {
          const msg = decodeFileChunkAck(message.value);
          this.outgoingFor(msg.transferId)?.handleAck(msg);
          return;
        }
        case MessageType.FILE_RESUME: {
          const msg = decodeFileResume(message.value);
          this.outgoingFor(msg.transferId)?.handleResume(msg);
          return;
        }
        case MessageType.FILE_COMPLETE: {
          const msg = decodeFileComplete(message.value);
          this.outgoingFor(msg.transferId)?.handleComplete(msg.fileHash);
          return;
        }
        case MessageType.FILE_CANCEL: {
          const msg = decodeFileCancel(message.value);
          const transfer = this.outgoing.get(msg.transferId) ?? this.incoming.get(msg.transferId);
          if (!transfer) {
            this.droppedPackets++;
            return;
          }
          transfer.cancelledByPeer(msg.reason);
          return;
        }
        case MessageType.FILE_ERROR: {
          const msg = decodeFileError(message.value);
          const transfer = this.outgoing.get(msg.transferId) ?? this.incoming.get(msg.transferId);
          if (!transfer) {
            this.droppedPackets++;
            return;
          }
          transfer.failedByPeer(
            (msg.code as FileErrorCode) ?? FileErrorCode.UNKNOWN,
            msg.message || 'peer reported a transfer error',
          );
          return;
        }
        default:
          return;
      }
    } catch (err) {
      if (err instanceof DecodeError) {
        // Malformed input from a peer is dropped. It never reaches a transfer,
        // so no state can be left half-updated by it.
        this.malformedPackets++;
        this.log.debug('dropped a malformed file packet', { type: message.typeName, err: err.message });
        return;
      }
      this.log.error('unexpected error handling a file packet', { type: message.typeName, err: String(err) });
    }
  }

  private outgoingFor(transferId: string): OutgoingTransfer | undefined {
    const transfer = this.outgoing.get(transferId);
    if (!transfer) this.droppedPackets++;
    return transfer;
  }

  private handleOffer(value: CborValue | null): void {
    let offer: FileOffer;
    try {
      offer = decodeFileOffer(value);
    } catch (err) {
      if (!(err instanceof DecodeError)) throw err;
      // Tell the sender why, if we can work out which transfer it meant. A
      // filename with a path separator in it is the case worth naming
      // explicitly - the peer may simply have a bug, and silence would look
      // like a dead link.
      const basics = peekOfferBasics(value);
      if (basics.transferId !== null) {
        const badName = basics.filename !== null && !isSafeFilename(basics.filename);
        this.wire.sendControl(
          MessageType.FILE_DECLINE,
          encodeFileDecline({
            transferId: basics.transferId,
            code: badName ? FileErrorCode.BAD_FILENAME : FileErrorCode.PROTOCOL_VIOLATION,
            reason: badName ? 'filename is not usable on this device' : 'malformed offer',
          }),
        );
      }
      this.malformedPackets++;
      this.log.debug('rejected a malformed offer', { err: err.message });
      return;
    }

    if (this.incoming.has(offer.transferId) || this.outgoing.has(offer.transferId)) {
      this.sendError(offer.transferId, FileErrorCode.PROTOCOL_VIOLATION, 'transfer id already in use');
      return;
    }
    if (offer.fileBytes > this.maxFileBytes) {
      this.sendDecline(offer.transferId, FileErrorCode.TOO_LARGE, `larger than the ${this.maxFileBytes} byte limit`);
      return;
    }
    if (this.incoming.size >= this.maxIncoming) {
      this.sendDecline(offer.transferId, FileErrorCode.BUSY, 'too many transfers already in progress');
      return;
    }

    const transfer = new IncomingTransfer(offer, this.wire, this.options.clock, this.listener, this.tuning);
    this.incoming.set(offer.transferId, transfer);
    this.ensureTicking();
    this.events.emit('offer', { offer });
  }

  private sendDecline(transferId: string, code: FileErrorCode, reason: string): void {
    this.wire.sendControl(MessageType.FILE_DECLINE, encodeFileDecline({ transferId, code, reason }));
  }

  private sendError(transferId: string, code: FileErrorCode, message: string): void {
    this.wire.sendControl(MessageType.FILE_ERROR, encodeFileError({ transferId, code, message }));
  }

  // -- bookkeeping -----------------------------------------------------------

  private retire(transfer: BaseTransfer): void {
    this.outgoing.delete(transfer.transferId);
    this.incoming.delete(transfer.transferId);
    this.finished.push(transfer.transferId);
    if (this.finished.length > 32) this.finished.shift();
    if (this.outgoing.size === 0 && this.incoming.size === 0) this.stopTicking();
  }

  /** True when this id belonged to a transfer that has already ended. */
  hasRecentlyFinished(transferId: string): boolean {
    return this.finished.includes(transferId);
  }

  private ensureTicking(): void {
    if (this.tickTimer !== undefined || this.disposed) return;
    this.tickTimer = this.options.clock.setInterval(() => this.tick(), this.tickIntervalMs);
  }

  private stopTicking(): void {
    if (this.tickTimer === undefined) return;
    this.options.clock.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }

  private tick(): void {
    for (const transfer of [...this.outgoing.values(), ...this.incoming.values()]) {
      if (transfer.isFinished) {
        this.retire(transfer);
        continue;
      }
      transfer.tick();
    }
    if (this.outgoing.size === 0 && this.incoming.size === 0) this.stopTicking();
  }
}
