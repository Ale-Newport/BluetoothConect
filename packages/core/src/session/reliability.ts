/**
 * Reliable delivery on top of an unreliable, interruptible link.
 *
 * Why this exists even though BLE GATT and TCP are themselves reliable: neither
 * survives the link going away. A phone slipping into a pocket, an OS suspending
 * the app, or a transport upgrade from Bluetooth to Wi-Fi all tear the link
 * down mid-flight. This layer sits ABOVE the link and below the app, so a
 * message handed to it is delivered exactly once and in order even if the
 * underlying connection is replaced three times on the way.
 *
 * Design:
 *  - Sender assigns a monotonic per-channel sequence number.
 *  - Receiver acknowledges with a cumulative ack (everything up to and including
 *    N is delivered) plus a 32-bit selective bitfield covering the sequence
 *    numbers it holds ABOVE the gap, so one packet lost out of a burst of forty
 *    costs one retransmission rather than forty.
 *  - Retransmission timeout adapts to measured RTT using the standard
 *    SRTT/RTTVAR estimator from RFC 6298.
 *  - Out-of-order arrivals are buffered and released in order.
 *  - Duplicates are dropped using the delivered-sequence watermark.
 */
import { TIMING } from '../protocol/constants.js';
import type { Clock, TimerHandle } from '../util/time.js';

export interface OutboundRecord {
  readonly seq: number;
  readonly payload: Uint8Array;
  readonly messageType: number;
  /**
   * Envelope flags chosen by the sender, carried through retransmission so a
   * resent packet is byte-identical in meaning to the original. In particular
   * this preserves whether the payload is CBOR or raw bytes.
   */
  readonly flags: number;
  readonly createdAt: number;
  attempts: number;
  lastSentAt: number;
  /** Set when a retransmission makes the RTT sample ambiguous (Karn's algorithm). */
  rttAmbiguous: boolean;
}

export interface ReliabilityCallbacks {
  /** Put a packet on the wire. Called for both first sends and retransmissions. */
  readonly transmit: (record: OutboundRecord, isRetransmit: boolean) => void;
  /** The peer confirmed receipt. */
  readonly onAcknowledged: (seq: number, rttMs: number | null) => void;
  /** Gave up after maxAttempts. The session is presumed dead. */
  readonly onDeliveryFailed: (record: OutboundRecord) => void;
}

export interface ReliabilityOptions {
  readonly maxAttempts?: number;
  /**
   * Milliseconds it takes the link to put one byte on the wire.
   *
   * Without this the retransmission timer is pure round-trip time, which is
   * wrong on a slow link with a small MTU: a 4 KB packet fragmented across a
   * 180-byte Bluetooth MTU spends over a hundred milliseconds simply being
   * TRANSMITTED, and an acknowledgement cannot possibly arrive before that. A
   * timer that ignores it fires while the packet is still going out, floods the
   * link with duplicates, and exhausts the retry budget on a packet that was
   * never lost.
   *
   * The session updates this from the live link, so a transport upgrade widens
   * the timer automatically.
   */
  readonly transmitMsPerByte?: number;
  readonly initialRtoMs?: number;
  readonly minRtoMs?: number;
  readonly maxRtoMs?: number;
  /** Largest number of unacknowledged packets allowed in flight. */
  readonly windowSize?: number;
  /** Largest number of out-of-order packets buffered on receive. */
  readonly reorderBufferSize?: number;
}

/**
 * One direction of one channel. A session owns one of these per reliable
 * channel (RELIABLE and BULK).
 */
/**
 * `ack + 1` is always the packet the receiver is missing, so the selective
 * bitfield starts one past it.
 */
export const SELECTIVE_ACK_BASE_OFFSET = 2;

export class ReliableChannel {
  private nextSeq = 1;
  private readonly unacked = new Map<number, OutboundRecord>();
  private readonly pendingQueue: OutboundRecord[] = [];
  private timer: TimerHandle | undefined;

  // Receive side
  private deliveredThrough = 0;
  /**
   * Packets held behind a sequence gap.
   *
   * Stores the WHOLE item, not just its bytes. Storing only the payload was a
   * real defect: a packet released from behind a gap was then delivered with
   * whichever envelope happened to be arriving at that moment, so a file chunk
   * could surface as a chat message and raw bytes could reach the CBOR decoder.
   * The buffer is generic precisely so the metadata cannot be separated from
   * the payload again.
   */
  private readonly reorderBuffer = new Map<number, unknown>();
  private readonly seenAboveWatermark = new Set<number>();

  // RTT estimation, RFC 6298
  private srtt: number | null = null;
  private rttvar = 0;
  private rto: number;

  private readonly maxAttempts: number;
  private readonly minRto: number;
  private readonly maxRto: number;
  private readonly windowSize: number;
  private readonly reorderBufferSize: number;
  private transmitMsPerByte: number;
  private paused = false;

  constructor(
    private readonly clock: Clock,
    private readonly callbacks: ReliabilityCallbacks,
    options: ReliabilityOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? TIMING.maxRetransmitAttempts;
    this.rto = options.initialRtoMs ?? TIMING.initialRetransmitMs;
    this.minRto = options.minRtoMs ?? TIMING.minRetransmitMs;
    this.maxRto = options.maxRtoMs ?? TIMING.maxRetransmitMs;
    this.windowSize = options.windowSize ?? 64;
    this.reorderBufferSize = options.reorderBufferSize ?? 256;
    this.transmitMsPerByte = options.transmitMsPerByte ?? 0;
  }

  get currentRtoMs(): number {
    return this.rto;
  }

  /**
   * Tell the channel how fast the link is. Called whenever the link changes -
   * a Bluetooth-to-Wi-Fi upgrade cuts this by two orders of magnitude, and the
   * retransmission timer must follow it down or the session stays sluggish long
   * after the link got fast.
   */
  setLinkThroughput(bytesPerSecond: number | undefined): void {
    this.transmitMsPerByte =
      bytesPerSecond !== undefined && Number.isFinite(bytesPerSecond) && bytesPerSecond > 0
        ? 1000 / bytesPerSecond
        : 0;
  }

  /**
   * How long to wait before assuming a packet was lost.
   *
   * Round-trip time, backed off per attempt, PLUS the time the link needs to
   * transmit the packet at all. The second term is what makes a large payload
   * survive a slow Bluetooth link.
   */
  private deadlineFor(record: OutboundRecord): number {
    const backoff = Math.min(this.maxRto, this.rto * 2 ** (record.attempts - 1));
    const transmit = record.payload.length * this.transmitMsPerByte;
    return record.lastSentAt + backoff + transmit;
  }

  get smoothedRttMs(): number | null {
    return this.srtt;
  }

  get inFlightCount(): number {
    return this.unacked.size;
  }

  get queuedCount(): number {
    return this.pendingQueue.length;
  }

  /** Highest sequence number delivered in order to the application. */
  get deliveredWatermark(): number {
    return this.deliveredThrough;
  }

  /**
   * Queue a payload for reliable delivery. Returns the sequence number assigned,
   * which the caller uses to correlate the eventual acknowledgement.
   */
  send(messageType: number, payload: Uint8Array, flags = 0): number {
    const seq = this.nextSeq++;
    const record: OutboundRecord = {
      seq,
      payload,
      messageType,
      flags,
      createdAt: this.clock.now(),
      attempts: 0,
      lastSentAt: 0,
      rttAmbiguous: false,
    };
    this.pendingQueue.push(record);
    this.pump();
    return seq;
  }

  /** Stop transmitting (link is down). Nothing is lost; the queue is retained. */
  pause(): void {
    this.paused = true;
    this.stopTimer();
  }

  /**
   * Resume after a link change. Everything unacknowledged is retransmitted
   * immediately, which is what makes a transport upgrade invisible to the user.
   */
  resume(): void {
    this.paused = false;
    for (const record of this.unacked.values()) {
      record.rttAmbiguous = true;
      record.lastSentAt = this.clock.now();
      record.attempts += 1;
      this.callbacks.transmit(record, true);
    }
    this.pump();
    this.scheduleTimer();
  }

  private pump(): void {
    if (this.paused) return;
    while (this.pendingQueue.length > 0 && this.unacked.size < this.windowSize) {
      const record = this.pendingQueue.shift() as OutboundRecord;
      record.attempts = 1;
      record.lastSentAt = this.clock.now();
      this.unacked.set(record.seq, record);
      this.callbacks.transmit(record, false);
    }
    this.scheduleTimer();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleTimer(): void {
    this.stopTimer();
    if (this.paused || this.unacked.size === 0) return;
    let earliestDeadline = Infinity;
    for (const record of this.unacked.values()) {
      earliestDeadline = Math.min(earliestDeadline, this.deadlineFor(record));
    }
    const delay = Math.max(1, earliestDeadline - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.onTimeout();
    }, delay);
  }

  private onTimeout(): void {
    if (this.paused) return;
    const now = this.clock.now();
    const failed: OutboundRecord[] = [];

    for (const record of this.unacked.values()) {
      if (this.deadlineFor(record) > now) continue;

      if (record.attempts >= this.maxAttempts) {
        failed.push(record);
        continue;
      }
      record.attempts += 1;
      record.lastSentAt = now;
      // Karn's algorithm: a retransmitted packet yields no usable RTT sample.
      record.rttAmbiguous = true;
      this.callbacks.transmit(record, true);
    }

    for (const record of failed) {
      this.unacked.delete(record.seq);
      this.callbacks.onDeliveryFailed(record);
    }
    this.scheduleTimer();
  }

  /**
   * Process an acknowledgement from the peer.
   * `ack` is the highest contiguous sequence number they have received;
   * `ackBits` acknowledges the 32 sequence numbers below it.
   */
  handleAck(ack: number, ackBits: number): void {
    const now = this.clock.now();
    const acknowledge = (seq: number): void => {
      const record = this.unacked.get(seq);
      if (!record) return;
      this.unacked.delete(seq);
      const rtt = record.rttAmbiguous ? null : now - record.lastSentAt;
      if (rtt !== null) this.updateRtt(rtt);
      this.callbacks.onAcknowledged(seq, rtt);
    };

    // Cumulative: everything up to and including `ack` is confirmed.
    for (const seq of [...this.unacked.keys()]) {
      if (seq <= ack) acknowledge(seq);
    }
    // Selective: bit i confirms the packet at SELECTIVE_ACK_BASE_OFFSET + i past
    // the cumulative watermark. `ack + 1` is by definition the missing one, so
    // the window starts at `ack + 2`.
    for (let i = 0; i < 32; i++) {
      if ((ackBits & (1 << i)) === 0) continue;
      acknowledge(ack + SELECTIVE_ACK_BASE_OFFSET + i);
    }
    this.pump();
  }

  private updateRtt(sample: number): void {
    if (this.srtt === null) {
      this.srtt = sample;
      this.rttvar = sample / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - sample);
      this.srtt = 0.875 * this.srtt + 0.125 * sample;
    }
    this.rto = Math.min(this.maxRto, Math.max(this.minRto, this.srtt + 4 * this.rttvar));
  }

  // -- receive side ----------------------------------------------------------

  /**
   * Register a received sequence number.
   *
   * `item` is whatever the caller needs back later - in practice the entire
   * decoded envelope, so the message type, flags and timestamp travel with the
   * payload rather than being re-derived from whatever arrives next.
   *
   * Returns the items that are now deliverable, in order. An empty array means
   * the packet was a duplicate or is waiting on an earlier one.
   */
  receive<T>(seq: number, item: T): T[] {
    if (seq <= this.deliveredThrough) return []; // duplicate, already delivered
    if (this.reorderBuffer.has(seq)) return []; // duplicate, already buffered

    if (this.reorderBuffer.size >= this.reorderBufferSize) {
      // The peer is far ahead of a gap we cannot close. Dropping here is
      // correct: their retransmit timer will resend once the gap clears.
      return [];
    }

    this.reorderBuffer.set(seq, item);
    this.seenAboveWatermark.add(seq);

    const ready: T[] = [];
    for (;;) {
      const next = this.deliveredThrough + 1;
      if (!this.reorderBuffer.has(next)) break;
      const buffered = this.reorderBuffer.get(next) as T;
      this.reorderBuffer.delete(next);
      this.seenAboveWatermark.delete(next);
      this.deliveredThrough = next;
      ready.push(buffered);
    }
    return ready;
  }

  /**
   * The acknowledgement pair to attach to the next outgoing packet.
   *
   * `ack` is the cumulative watermark. `ackBits` bit i marks sequence number
   * `ack + SELECTIVE_ACK_BASE_OFFSET + i` as already held, so the sender can
   * retransmit only the genuine gap.
   */
  ackState(): { ack: number; ackBits: number } {
    let ackBits = 0;
    for (const seq of this.seenAboveWatermark) {
      const bit = seq - this.deliveredThrough - SELECTIVE_ACK_BASE_OFFSET;
      if (bit >= 0 && bit < 32) ackBits |= 1 << bit;
    }
    return { ack: this.deliveredThrough, ackBits: ackBits >>> 0 };
  }

  /** Number of packets buffered awaiting an earlier one. */
  get reorderDepth(): number {
    return this.reorderBuffer.size;
  }

  reset(): void {
    this.stopTimer();
    this.unacked.clear();
    this.pendingQueue.length = 0;
    this.reorderBuffer.clear();
    this.seenAboveWatermark.clear();
    this.deliveredThrough = 0;
    this.nextSeq = 1;
    this.srtt = null;
    this.rttvar = 0;
    this.paused = false;
  }

  dispose(): void {
    this.stopTimer();
  }
}

/**
 * Best-effort channel for game state and other data where the newest value
 * makes every older one irrelevant.
 *
 * Rather than queueing, it COALESCES: if the link is busy, a newer snapshot
 * replaces the one waiting, so a congested Bluetooth link shows the current
 * paddle position rather than a backlog of stale ones.
 */
export class RealtimeChannel {
  private queue: { key: string; payload: Uint8Array; messageType: number }[] = [];

  constructor(
    private readonly transmit: (messageType: number, payload: Uint8Array) => void,
    private readonly maxQueued = TIMING.realtimeMaxQueued,
  ) {}

  /**
   * Send a payload. `coalesceKey` groups messages that supersede one another -
   * two updates with the same key collapse into the newer one.
   */
  send(messageType: number, payload: Uint8Array, coalesceKey?: string): void {
    const key = coalesceKey ?? `${messageType}`;
    const existing = this.queue.findIndex((q) => q.key === key);
    if (existing >= 0) {
      this.queue[existing] = { key, payload, messageType };
    } else {
      this.queue.push({ key, payload, messageType });
      if (this.queue.length > this.maxQueued) this.queue.shift();
    }
    this.flush();
  }

  flush(): void {
    const batch = this.queue;
    this.queue = [];
    for (const item of batch) this.transmit(item.messageType, item.payload);
  }

  get pending(): number {
    return this.queue.length;
  }

  reset(): void {
    this.queue = [];
  }
}
