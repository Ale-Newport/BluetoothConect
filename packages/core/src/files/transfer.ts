/**
 * The two transfer state machines.
 *
 * Neither of them knows what a PeerSession is: they talk to a `TransferWire`
 * and a `Clock`, which is what lets a whole transfer be driven from a unit test
 * with three lines of stub and no handshake.
 *
 * Flow control is a sliding window of in-flight chunk MESSAGES, bounded from
 * both ends. Locally it is capped near the BULK channel's own 16-packet window,
 * so we neither starve that channel nor pile a backlog inside it; remotely the
 * receiver grants credit in FILE_ACCEPT and in every acknowledgement, so a
 * phone whose storage cannot keep up can slow a fast sender down without
 * dropping anything. File traffic rides the BULK channel throughout, which is
 * what keeps a 100 MB video from delaying a chat message on RELIABLE.
 */
import { MessageType } from '../protocol/constants.js';
import type { CborValue } from '../protocol/cbor.js';
import { bytesEqual } from '../util/bytes.js';
import type { Clock } from '../util/time.js';
import { ChunkBitmap } from './bitmap.js';
import {
  chooseRunLength,
  chunkDigest,
  computeFileHash,
  runByteLength,
} from './chunks.js';
import {
  encodeFileAccept,
  encodeFileCancel,
  encodeFileChunk,
  encodeFileChunkAck,
  encodeFileComplete,
  encodeFileDecline,
  encodeFileError,
  encodeFileResume,
  type FileChunkAckMessage,
  type FileChunkMessage,
  type FileResumeMessage,
} from './codec.js';
import { ThroughputEstimator, buildProgress } from './progress.js';
import {
  FILE_LIMITS,
  FileErrorCode,
  TransferDirection,
  TransferState,
  isTerminalState,
  type FileOffer,
  type FileStore,
  type ResumeState,
  type TransferProgress,
} from './types.js';

/** How a transfer reaches the outside world. Implemented by the protocol. */
export interface TransferWire {
  /** CBOR control message on the RELIABLE channel. False when it could not go out. */
  sendControl(messageType: number, value: CborValue): boolean;
  /** Raw chunk on the BULK channel. False when it could not go out. */
  sendChunk(payload: Uint8Array): boolean;
  /** Application payload budget on the link as it is right now. */
  readonly payloadBudget: number;
  /** Largest single datagram the live link carries, before framing. */
  readonly datagramBytes: number;
}

export interface TransferListener {
  onStateChanged(transfer: BaseTransfer): void;
  onProgress(transfer: BaseTransfer): void;
  onCompleted(transfer: BaseTransfer): void;
  onFailed(transfer: BaseTransfer, code: FileErrorCode, message: string): void;
  onCancelled(transfer: BaseTransfer, reason: string, byPeer: boolean): void;
  onDeclined(transfer: BaseTransfer, code: number, reason: string): void;
  /** A chunk arrived and was refused. Counted for Developer Mode. */
  onChunkRejected(transfer: BaseTransfer, index: number, reason: string): void;
}

export interface TransferTuning {
  /** In-flight chunk messages allowed by this side. */
  readonly maxInFlightMessages: number;
  /** Credit this side grants a sender, in chunk messages. */
  readonly receiveWindowMessages: number;
  /** Acknowledge at least this often, in accepted chunk messages. */
  readonly ackEveryMessages: number;
  /** Re-send a chunk message the peer has not acknowledged within this. */
  readonly chunkTimeoutMs: number;
  /** No movement for this long and the UI is told the transfer has stalled. */
  readonly stallAfterMs: number;
  /**
   * How long an offer may sit unanswered before both sides give up on it.
   *
   * Without this a peer that offers files and then says nothing pins one of the
   * (deliberately small) concurrency slots for the lifetime of the process, and
   * keeps the protocol's service timer running on a phone that has nothing to
   * do - which is how an offline app gets noticed by the battery screen and
   * then by the OS.
   */
  readonly offerTimeoutMs: number;
}

export const DEFAULT_TUNING: TransferTuning = {
  maxInFlightMessages: 12,
  receiveWindowMessages: 16,
  ackEveryMessages: 8,
  // Long enough for a person to pick their phone up and look at the prompt,
  // short enough that a peer cannot wedge the feature by walking away.
  offerTimeoutMs: 120_000,
  // Generous on purpose: the BULK channel retransmits lost packets by itself,
  // so this timer exists only for the case where the reliability layer gave up
  // (a link that died mid-flight), and firing it early would double the traffic
  // on precisely the link that can least afford it.
  chunkTimeoutMs: 12_000,
  stallAfterMs: 8_000,
};

// ---------------------------------------------------------------------------
// Shared base
// ---------------------------------------------------------------------------

export abstract class BaseTransfer {
  abstract readonly direction: TransferDirection;
  protected currentState: TransferState = TransferState.OFFERED;
  protected readonly throughput = new ThroughputEstimator();
  /** When the offer was made, for the one timeout the OFFERED state needs. */
  protected readonly offeredAt: number;

  constructor(
    readonly offer: FileOffer,
    protected readonly wire: TransferWire,
    protected readonly clock: Clock,
    protected readonly listener: TransferListener,
    protected readonly tuning: TransferTuning,
  ) {
    this.offeredAt = clock.now();
  }

  get transferId(): string {
    return this.offer.transferId;
  }

  get state(): TransferState {
    return this.currentState;
  }

  get isFinished(): boolean {
    return isTerminalState(this.currentState);
  }

  abstract get transferredBytes(): number;

  progress(): TransferProgress {
    return buildProgress({
      transferId: this.offer.transferId,
      direction: this.direction,
      filename: this.offer.filename,
      state: this.currentState,
      totalBytes: this.offer.fileBytes,
      transferredBytes: this.transferredBytes,
      throughput: this.throughput,
      now: this.clock.now(),
      stallAfterMs: this.tuning.stallAfterMs,
    });
  }

  /** Called on a timer by the protocol. Retransmits, acknowledges, reports. */
  abstract tick(): void;

  /** Called after the session migrates to a new link. */
  abstract onLinkChanged(): void;

  /**
   * OFFERED is the only state in this protocol that nothing else can move on
   * its own: the sender is waiting for an answer that may never come, and the
   * receiver is waiting for a person who may never look. Both sides therefore
   * put a clock on it, and both retire the transfer when it runs out - which is
   * what frees the concurrency slot and lets the protocol stop its timer.
   *
   * Returns true when the offer was expired by this call.
   */
  protected expireOfferIfStale(): boolean {
    if (this.currentState !== TransferState.OFFERED) return false;
    if (this.clock.now() - this.offeredAt < this.tuning.offerTimeoutMs) return false;
    this.onOfferExpired();
    return true;
  }

  /** What this side does when its own offer clock runs out. */
  protected abstract onOfferExpired(): void;

  /** Local cancellation. Tells the peer, then stops. */
  cancel(reason = 'cancelled'): void {
    if (this.isFinished) return;
    this.wire.sendControl(MessageType.FILE_CANCEL, encodeFileCancel({ transferId: this.transferId, reason }));
    this.setState(TransferState.CANCELLED);
    this.listener.onCancelled(this, reason, false);
  }

  /** The peer cancelled. Nothing to send back. */
  cancelledByPeer(reason: string): void {
    if (this.isFinished) return;
    this.setState(TransferState.CANCELLED);
    this.listener.onCancelled(this, reason, true);
  }

  fail(code: FileErrorCode, message: string, notifyPeer = true): void {
    if (this.isFinished) return;
    if (notifyPeer) {
      this.wire.sendControl(MessageType.FILE_ERROR, encodeFileError({ transferId: this.transferId, code, message }));
    }
    this.setState(TransferState.FAILED);
    this.listener.onFailed(this, code, message);
  }

  /** The peer reported an error. Terminal, and never echoed back. */
  failedByPeer(code: FileErrorCode, message: string): void {
    if (this.isFinished) return;
    this.setState(TransferState.FAILED);
    this.listener.onFailed(this, code, message);
  }

  /**
   * Deliberately a method rather than a comparison against `currentState`: the
   * asynchronous paths below re-check the state after an `await`, and a direct
   * comparison would be narrowed by the control-flow analysis to the value the
   * state had before the await - which is precisely the value that may no
   * longer hold.
   */
  protected isState(state: TransferState): boolean {
    return this.currentState === state;
  }

  protected setState(next: TransferState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.listener.onStateChanged(this);
  }

  protected recordProgress(): void {
    this.throughput.update(this.transferredBytes, this.clock.now());
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

interface InFlightEntry {
  readonly index: number;
  readonly run: number;
  readonly sentAt: number;
}

/**
 * How far above its contiguous prefix a FILE_CHUNK_ACK can describe the
 * receiver's state: the selective-ack bitmap is bounded by the wire limit, so
 * one acknowledgement reaches exactly this many grid chunks.
 *
 * The sender's window is bounded in MESSAGES and each message may carry up to
 * `maxRunChunks` grid chunks, so the window can legitimately reach further than
 * an acknowledgement can - and a chunk out there is not silent because it was
 * lost, it is silent because the receiver has no field to put it in.
 */
const ACK_REACH_CHUNKS = FILE_LIMITS.maxAckBitmapBytes * 8;

export class OutgoingTransfer extends BaseTransfer {
  override readonly direction = TransferDirection.OUTGOING;

  /** Chunks the receiver has confirmed. */
  private readonly acked: ChunkBitmap;
  /** Chunks currently sent or in flight. Cleared again on NAK or timeout. */
  private readonly sent: ChunkBitmap;
  private readonly inFlight = new Map<number, InFlightEntry>();
  private readonly attempts = new Map<number, number>();
  private sendCursor = 0;
  private peerWindow = DEFAULT_TUNING.receiveWindowMessages;
  private pumping = false;

  constructor(
    offer: FileOffer,
    private readonly store: FileStore,
    wire: TransferWire,
    clock: Clock,
    listener: TransferListener,
    tuning: TransferTuning = DEFAULT_TUNING,
  ) {
    super(offer, wire, clock, listener, tuning);
    this.acked = new ChunkBitmap(offer.totalChunks);
    this.sent = new ChunkBitmap(offer.totalChunks);
  }

  override get transferredBytes(): number {
    return Math.min(this.offer.fileBytes, this.acked.receivedCount * this.offer.chunkSize);
  }

  /** Chunks the receiver has confirmed. Exposed for tests and Developer Mode. */
  get ackedChunks(): number {
    return this.acked.receivedCount;
  }

  get inFlightMessages(): number {
    return this.inFlight.size;
  }

  handleAccept(window: number): void {
    if (!this.isState(TransferState.OFFERED)) return;
    this.peerWindow = window;
    this.setState(TransferState.TRANSFERRING);
    this.throughput.reset(0, this.clock.now());
    // A zero-byte file has nothing to send; the receiver verifies and completes.
    void this.pump();
  }

  handleDecline(code: number, reason: string): void {
    if (this.isFinished) return;
    this.setState(TransferState.DECLINED);
    this.listener.onDeclined(this, code, reason);
  }

  /**
   * The receiver told us what it already holds. Used both for a resume after a
   * reconnect and for a resume after the app was killed, where the receiver may
   * have most of the file before a single chunk of this attempt has been sent.
   */
  handleResume(msg: FileResumeMessage): void {
    if (this.isFinished) return;
    let theirs: ChunkBitmap;
    try {
      theirs = ChunkBitmap.decodeResume(msg.prefix, msg.bitmap, this.offer.totalChunks);
    } catch {
      // A resume we cannot parse simply teaches us nothing; the transfer keeps
      // going from what we already believe.
      return;
    }
    this.acked.reset();
    this.sent.reset();
    this.inFlight.clear();
    // The retry budget is deliberately NOT cleared here. `onLinkChanged` clears
    // it because this device knows its own radio went away; a FILE_RESUME is
    // the peer's word, and a peer that repeats it would otherwise be able to
    // make us re-read and re-send the whole file for ever - a few bytes of
    // theirs against every byte of ours, with the one counter that could stop
    // it reset on each pass.
    for (let i = 0; i < this.offer.totalChunks; i++) {
      if (theirs.has(i)) {
        this.acked.set(i);
        this.sent.set(i);
      }
    }
    this.sendCursor = 0;
    if (this.isState(TransferState.OFFERED)) this.setState(TransferState.TRANSFERRING);
    this.throughput.reset(this.transferredBytes, this.clock.now());
    this.recordProgress();
    void this.pump();
  }

  handleAck(msg: FileChunkAckMessage): void {
    if (this.isFinished) return;
    const total = this.offer.totalChunks;

    const prefix = Math.min(msg.prefix, total);
    for (let i = 0; i < prefix; i++) this.acked.set(i);
    for (let bit = 0; bit < msg.bitmap.length * 8; bit++) {
      const index = prefix + bit;
      if (index >= total) break;
      if (((msg.bitmap[bit >> 3] as number) & (1 << (bit & 7))) !== 0) this.acked.set(index);
    }

    // A chunk that failed its digest is not "lost" - it arrived and was
    // rejected - so it must be re-sent even though the reliability layer below
    // considers it delivered. The digest covers a whole run, so a NAK names the
    // run's first index and invalidates every chunk in it: reopening only the
    // named index would strand the rest as "sent but never acknowledged", with
    // nothing left in flight to time them out.
    for (const index of msg.missing) {
      if (index >= total) continue;
      const entry = this.inFlight.get(index);
      this.inFlight.delete(index);
      const run = entry ? entry.run : 1;
      for (let i = index; i < index + run && i < total; i++) {
        this.acked.clear(i);
        this.sent.clear(i);
      }
      if (index < this.sendCursor) this.sendCursor = index;
    }

    this.peerWindow = msg.window;
    this.retireInFlight();
    this.recordProgress();
    void this.pump();
  }

  handleComplete(peerHash: Uint8Array): void {
    if (this.isFinished) return;
    if (!bytesEqual(peerHash, this.offer.fileHash)) {
      this.fail(FileErrorCode.HASH_MISMATCH, 'peer verified a different file');
      return;
    }
    this.acked.fill();
    this.recordProgress();
    this.setState(TransferState.COMPLETED);
    this.listener.onCompleted(this);
  }

  override onLinkChanged(): void {
    if (!this.isState(TransferState.TRANSFERRING)) return;
    // Anything in flight when the link went away has to be assumed lost, and
    // the measured throughput of the OLD radio must not be used to estimate the
    // new one. The attempt counters are cleared too: a chunk that vanished
    // because the phone went into a pocket has not failed on its own merits,
    // and counting it would kill a long transfer after a handful of ordinary
    // reconnections.
    for (const entry of this.inFlight.values()) this.reopen(entry);
    this.inFlight.clear();
    this.attempts.clear();
    this.throughput.reset(this.transferredBytes, this.clock.now());
    void this.pump();
  }

  protected override onOfferExpired(): void {
    this.fail(FileErrorCode.TIMED_OUT, 'the peer never answered the offer');
  }

  override tick(): void {
    if (this.expireOfferIfStale()) return;
    if (!this.isState(TransferState.TRANSFERRING)) return;
    const now = this.clock.now();
    // Everything from here up is out of an acknowledgement's reach, so silence
    // about it carries no information at all.
    const reportableCeiling = this.acked.contiguousPrefix() + ACK_REACH_CHUNKS;
    // The lowest entry is always allowed to time out, whatever its index, so
    // the window can never fill up with entries that are all waiting on each
    // other and nothing is left to make the prefix move.
    let lowestInFlight = Number.POSITIVE_INFINITY;
    for (const index of this.inFlight.keys()) if (index < lowestInFlight) lowestInFlight = index;

    let timedOut = false;
    for (const entry of [...this.inFlight.values()]) {
      if (now - entry.sentAt < this.tuning.chunkTimeoutMs) continue;
      // Treating this as loss would re-send a run the receiver very probably
      // already holds, and would spend a retry the peer never had a chance to
      // save - eventually failing a perfectly healthy transfer for
      // TOO_MANY_RETRIES. Wait for the prefix to advance instead; it advances
      // as soon as the low chunks holding it back are re-sent, which is
      // precisely what this loop is doing to them.
      if (entry.index >= reportableCeiling && entry.index !== lowestInFlight) continue;
      const attempts = this.attempts.get(entry.index) ?? 1;
      if (attempts >= FILE_LIMITS.maxChunkAttempts) {
        this.fail(FileErrorCode.TOO_MANY_RETRIES, `chunk ${entry.index} was never acknowledged`);
        return;
      }
      this.inFlight.delete(entry.index);
      this.reopen(entry);
      timedOut = true;
    }
    this.repairStrandedChunks();
    this.recordProgress();
    this.listener.onProgress(this);
    if (timedOut || this.inFlight.size < this.window()) void this.pump();
  }

  /**
   * A chunk marked sent, never acknowledged, and with nothing in flight to time
   * it out can never be resent: the transfer would sit at 98% forever. Every
   * path that removes an in-flight entry reopens what it did not deliver, so
   * this should find nothing - but a silent permanent stall is a bad enough
   * failure that the O(n) sweep over an idle window is worth paying for.
   */
  private repairStrandedChunks(): void {
    if (this.inFlight.size > 0) return;
    if (this.acked.receivedCount === this.offer.totalChunks) return;
    for (let i = 0; i < this.offer.totalChunks; i++) {
      if (!this.acked.has(i) && this.sent.has(i)) {
        this.sent.clear(i);
        if (i < this.sendCursor) this.sendCursor = i;
      }
    }
  }

  /** Everything the app needs to resume this send later. */
  snapshot(): ResumeState {
    return {
      filename: this.offer.filename,
      fileBytes: this.offer.fileBytes,
      chunkSize: this.offer.chunkSize,
      fileHash: this.offer.fileHash,
      bitmap: this.acked.toBytes(),
    };
  }

  private window(): number {
    return Math.max(1, Math.min(this.tuning.maxInFlightMessages, this.peerWindow || this.tuning.maxInFlightMessages));
  }

  private reopen(entry: InFlightEntry): void {
    for (let i = entry.index; i < entry.index + entry.run; i++) {
      if (!this.acked.has(i)) this.sent.clear(i);
    }
    if (entry.index < this.sendCursor) this.sendCursor = entry.index;
  }

  private retireInFlight(): void {
    for (const [key, entry] of [...this.inFlight]) {
      let complete = true;
      let reopened = false;
      for (let i = entry.index; i < entry.index + entry.run; i++) {
        if (this.acked.has(i)) continue;
        complete = false;
        if (!this.sent.has(i)) reopened = true;
      }
      if (complete) {
        this.inFlight.delete(key);
        this.attempts.delete(entry.index);
      } else if (reopened) {
        // Part of this entry has been reopened; reopen the rest of it too, so
        // no chunk is left marked sent with nothing in flight to resend it.
        this.inFlight.delete(key);
        this.reopen(entry);
      }
    }
  }

  /** First chunk that is neither acknowledged nor in flight, or -1. */
  private nextSendable(): number {
    for (let i = this.sendCursor; i < this.offer.totalChunks; i++) {
      if (!this.acked.has(i) && !this.sent.has(i)) {
        this.sendCursor = i;
        return i;
      }
    }
    for (let i = 0; i < this.sendCursor; i++) {
      if (!this.acked.has(i) && !this.sent.has(i)) {
        this.sendCursor = i;
        return i;
      }
    }
    return -1;
  }

  /**
   * Fill the window. Re-entrancy is guarded rather than queued: `readChunk` is
   * asynchronous, so a second caller arriving while a read is outstanding would
   * otherwise send the same chunk twice.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (!this.isState(TransferState.TRANSFERRING)) return;
        if (this.inFlight.size >= this.window()) return;

        const index = this.nextSendable();
        if (index < 0) return;

        // Recomputed per message: this is the whole of the mid-flight adaptation
        // to a faster (or slower) link.
        const maxRun = chooseRunLength(
          this.offer.chunkSize,
          this.wire.payloadBudget,
          this.wire.datagramBytes,
          this.transferId.length,
        );
        let run = 0;
        while (
          run < maxRun &&
          index + run < this.offer.totalChunks &&
          !this.acked.has(index + run) &&
          !this.sent.has(index + run)
        ) {
          run++;
        }
        if (run === 0) return;

        const offset = index * this.offer.chunkSize;
        const length = runByteLength(this.offer.fileBytes, this.offer.chunkSize, index, run);
        let data: Uint8Array;
        try {
          data = await this.store.readChunk(offset, length);
        } catch (err) {
          this.fail(FileErrorCode.STORAGE_FAILURE, `read failed at ${offset}: ${String(err)}`);
          return;
        }
        // The transfer may have been cancelled while the read was outstanding.
        if (!this.isState(TransferState.TRANSFERRING)) return;
        if (data.length !== length) {
          this.fail(FileErrorCode.STORAGE_FAILURE, `short read at ${offset}`);
          return;
        }

        const digest = chunkDigest(this.transferId, index, run, data);
        const payload = encodeFileChunk(this.transferId, index, run, digest, data);
        if (!this.wire.sendChunk(payload)) {
          // The link is down. Stalling here is the correct behaviour: the
          // transfer resumes from exactly this point when a link returns.
          return;
        }

        for (let i = index; i < index + run; i++) this.sent.set(i);
        this.inFlight.set(index, { index, run, sentAt: this.clock.now() });
        this.attempts.set(index, (this.attempts.get(index) ?? 0) + 1);
      }
    } finally {
      this.pumping = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export class IncomingTransfer extends BaseTransfer {
  override readonly direction = TransferDirection.INCOMING;

  private readonly received: ChunkBitmap;
  private store: FileStore | null = null;
  private sinceLastAck = 0;
  private ackPending = false;
  private readonly nak = new Set<number>();
  private writesInFlight = 0;
  private verifying = false;

  /** Digest failures seen. Surfaced in diagnostics; a rising count means a bug. */
  rejectedChunks = 0;

  constructor(
    offer: FileOffer,
    wire: TransferWire,
    clock: Clock,
    listener: TransferListener,
    tuning: TransferTuning = DEFAULT_TUNING,
  ) {
    super(offer, wire, clock, listener, tuning);
    this.received = new ChunkBitmap(offer.totalChunks);
  }

  override get transferredBytes(): number {
    return Math.min(this.offer.fileBytes, this.received.receivedCount * this.offer.chunkSize);
  }

  get receivedChunks(): number {
    return this.received.receivedCount;
  }

  /**
   * Accept the offer and start receiving.
   *
   * `resume` is the state a previous attempt persisted. It is adopted only when
   * it describes the same bytes cut on the same grid - the file hash, the size
   * and the chunk size must all match - because a bitmap read against a
   * different grid would mark the wrong bytes as present and produce a file
   * that passes every per-chunk check and is still corrupt.
   */
  accept(store: FileStore, resume?: ResumeState): void {
    if (!this.isState(TransferState.OFFERED)) return;
    this.store = store;
    if (resume && this.resumeMatches(resume)) {
      try {
        const restored = ChunkBitmap.fromBytes(resume.bitmap, this.offer.totalChunks);
        for (let i = 0; i < this.offer.totalChunks; i++) if (restored.has(i)) this.received.set(i);
      } catch {
        this.received.reset();
      }
    }
    this.wire.sendControl(
      MessageType.FILE_ACCEPT,
      encodeFileAccept({ transferId: this.transferId, window: this.tuning.receiveWindowMessages }),
    );
    this.setState(TransferState.TRANSFERRING);
    this.throughput.reset(this.transferredBytes, this.clock.now());
    if (this.received.receivedCount > 0) this.sendResume();
    void this.maybeFinish();
  }

  decline(code: FileErrorCode, reason: string): void {
    if (this.isFinished) return;
    this.setState(TransferState.DECLINED);
    this.listener.onDeclined(this, code, reason);
  }

  /** Ask the sender to continue from what we hold. Sent after a link change. */
  sendResume(): void {
    if (!this.isState(TransferState.TRANSFERRING)) return;
    const { prefix, bytes } = this.received.encodeResume();
    this.wire.sendControl(MessageType.FILE_RESUME, encodeFileResume({ transferId: this.transferId, prefix, bitmap: bytes }));
  }

  handleChunk(msg: FileChunkMessage): void {
    if (!this.isState(TransferState.TRANSFERRING)) return;
    const store = this.store;
    if (!store) return;

    // Every field is checked against OUR view of the transfer, not against the
    // message's own claims: a peer that says "run of 64" for a file with three
    // chunks left must be dropped, not believed.
    if (msg.index + msg.run > this.offer.totalChunks) {
      this.reject(msg.index, 'index or run is outside the file');
      return;
    }
    const expected = runByteLength(this.offer.fileBytes, this.offer.chunkSize, msg.index, msg.run);
    if (expected === 0 || msg.data.length !== expected) {
      this.reject(msg.index, 'payload length does not match the run');
      return;
    }
    if (!bytesEqual(chunkDigest(this.transferId, msg.index, msg.run, msg.data), msg.digest)) {
      // Corruption, or a bug on one of the two sides. Re-request rather than
      // accept: a chunk that fails its digest is never written to disk.
      this.reject(msg.index, 'digest mismatch');
      if (this.nak.size < FILE_LIMITS.maxNakEntries) this.nak.add(msg.index);
      this.ackPending = true;
      return;
    }

    // Already have it - the sender is retrying something our ack did not reach.
    let novel = false;
    for (let i = msg.index; i < msg.index + msg.run; i++) {
      if (!this.received.has(i)) {
        novel = true;
        break;
      }
    }
    this.sinceLastAck++;
    this.ackPending = true;
    if (!novel) return;

    this.writesInFlight++;
    void this.writeRun(store, msg);
  }

  /**
   * Generous against the window we advertise, so an honest sender can never
   * reach it, and finite so a dishonest one cannot grow our heap.
   */
  private maxWritesInFlight(): number {
    return Math.max(4, this.tuning.receiveWindowMessages * 2);
  }

  private async writeRun(store: FileStore, msg: FileChunkMessage): Promise<void> {
    const offset = msg.index * this.offer.chunkSize;
    try {
      await store.writeChunk(offset, msg.data);
    } catch (err) {
      this.writesInFlight--;
      this.fail(FileErrorCode.STORAGE_FAILURE, `write failed at ${offset}: ${String(err)}`);
      return;
    }
    this.writesInFlight--;
    if (!this.isState(TransferState.TRANSFERRING)) return;
    // The bit is set only once the bytes are down, so a bitmap persisted at any
    // instant never claims more than the disk actually holds.
    for (let i = msg.index; i < msg.index + msg.run; i++) this.received.set(i);
    this.nak.delete(msg.index);
    this.recordProgress();
    if (this.sinceLastAck >= this.tuning.ackEveryMessages) this.sendAck();
    void this.maybeFinish();
  }

  override onLinkChanged(): void {
    if (!this.isState(TransferState.TRANSFERRING)) return;
    this.throughput.reset(this.transferredBytes, this.clock.now());
    this.sendResume();
  }

  protected override onOfferExpired(): void {
    // Tell the sender before we forget the offer, so its own prompt - and its
    // concurrency slot - go away at the same moment ours do.
    this.wire.sendControl(
      MessageType.FILE_DECLINE,
      encodeFileDecline({ transferId: this.transferId, code: FileErrorCode.TIMED_OUT, reason: 'offer expired' }),
    );
    this.decline(FileErrorCode.TIMED_OUT, 'offer expired');
  }

  override tick(): void {
    if (this.expireOfferIfStale()) return;
    if (!this.isState(TransferState.TRANSFERRING)) return;
    if (this.ackPending || this.nak.size > 0) this.sendAck();
    this.recordProgress();
    this.listener.onProgress(this);
  }

  /** State the app persists so this file survives being killed mid-transfer. */
  snapshot(): ResumeState {
    return {
      filename: this.offer.filename,
      fileBytes: this.offer.fileBytes,
      chunkSize: this.offer.chunkSize,
      fileHash: this.offer.fileHash,
      bitmap: this.received.toBytes(),
    };
  }

  private reject(index: number, reason: string): void {
    this.rejectedChunks++;
    this.listener.onChunkRejected(this, index, reason);
  }

  private resumeMatches(resume: ResumeState): boolean {
    return (
      resume.fileBytes === this.offer.fileBytes &&
      resume.chunkSize === this.offer.chunkSize &&
      bytesEqual(resume.fileHash, this.offer.fileHash)
    );
  }

  private sendAck(): void {
    const prefix = this.received.contiguousPrefix();
    const bitmapBytes = new Uint8Array(
      Math.min(FILE_LIMITS.maxAckBitmapBytes, Math.max(0, (this.offer.totalChunks - prefix + 7) >> 3)),
    );
    for (let bit = 0; bit < bitmapBytes.length * 8; bit++) {
      const index = prefix + bit;
      if (index >= this.offer.totalChunks) break;
      if (this.received.has(index)) bitmapBytes[bit >> 3] = (bitmapBytes[bit >> 3] as number) | (1 << (bit & 7));
    }
    const ack: FileChunkAckMessage = {
      transferId: this.transferId,
      prefix,
      bitmap: bitmapBytes,
      missing: [...this.nak].slice(0, FILE_LIMITS.maxNakEntries),
      window: this.tuning.receiveWindowMessages,
    };
    if (this.wire.sendControl(MessageType.FILE_CHUNK_ACK, encodeFileChunkAck(ack))) {
      this.sinceLastAck = 0;
      this.ackPending = false;
      this.nak.clear();
    }
  }

  /**
   * All chunks in? Read the file back and check it against the offered hash
   * before telling anyone it arrived.
   */
  private async maybeFinish(): Promise<void> {
    if (this.verifying) return;
    if (!this.isState(TransferState.TRANSFERRING)) return;
    if (!this.received.isComplete || this.writesInFlight > 0) return;
    const store = this.store;
    if (!store) return;

    this.verifying = true;
    this.sendAck();
    this.setState(TransferState.VERIFYING);
    let actual: Uint8Array;
    try {
      actual = await computeFileHash(store, this.offer.fileBytes, this.offer.chunkSize);
    } catch (err) {
      this.verifying = false;
      this.fail(FileErrorCode.STORAGE_FAILURE, `verification read failed: ${String(err)}`);
      return;
    }
    this.verifying = false;
    if (!this.isState(TransferState.VERIFYING)) return;
    if (!bytesEqual(actual, this.offer.fileHash)) {
      this.fail(FileErrorCode.HASH_MISMATCH, 'the assembled file does not match the offered hash');
      return;
    }
    this.wire.sendControl(
      MessageType.FILE_COMPLETE,
      encodeFileComplete({ transferId: this.transferId, fileHash: actual }),
    );
    this.setState(TransferState.COMPLETED);
    this.recordProgress();
    this.listener.onCompleted(this);
  }
}
