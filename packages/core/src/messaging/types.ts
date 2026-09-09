/**
 * Chat protocol - domain types, wire limits and the delivery-status ladder.
 *
 * Everything here is pure data. The chat protocol is deliberately split into
 * three testable layers: these types, the codec (pure functions over CBOR), and
 * the ChatProtocol class that binds them to a PeerSession. Persistence is the
 * app layer's job - this module never imports the database, it only exposes the
 * hooks an app needs to hand state in and get state back out.
 */

// ---------------------------------------------------------------------------
// Limits
//
// Every one of these bounds something a peer controls. They are duplicated on
// the encode side (our own bugs) and the decode side (a hostile peer), because
// the two failures need different treatment: ours throws loudly, theirs drops
// the packet.
// ---------------------------------------------------------------------------

export const CHAT_LIMITS = {
  /**
   * Body cap, in Unicode code points rather than UTF-16 code units. A user who
   * types 4000 emoji has typed 4000 characters as far as they are concerned;
   * counting `String.length` would silently halve that budget.
   */
  maxBodyCodePoints: 4000,
  /**
   * ...and the matching cap on the encoded form, because a code point costs up
   * to four UTF-8 bytes. Without this, "4000 characters" could be 16 KB on a
   * link that moves 8 KB per second. Both limits are enforced; neither implies
   * the other.
   */
  maxBodyBytes: 16_000,
  /** Identifier length, shared by message ids, file ids and request ids. */
  maxIdChars: 64,
  maxAttachmentsPerMessage: 8,
  maxAttachmentNameChars: 255,
  maxMimeTypeChars: 128,
  /** 8 GiB. Far beyond anything a phone will actually send; a sanity bound. */
  maxAttachmentBytes: 8 * 1024 * 1024 * 1024,
  /** Reactions are emoji: a ZWJ sequence with modifiers still fits easily. */
  maxReactionCodePoints: 8,
  maxReactionBytes: 64,
  /** Ids per delivery/read receipt or per delete request. */
  maxIdsPerBatch: 64,
  /**
   * Receipts owed to the peer but not yet sendable, across both ladders.
   *
   * A receipt is only meaningful while a link exists, but messages keep
   * arriving in states where nothing can be sent back - notably while the user
   * is still comparing the six-digit pairing code. Without a ceiling, a peer
   * that floods messages in that window grows this queue for as long as it
   * cares to. Eight full batches is generous for a real conversation and a few
   * kilobytes for a hostile one.
   */
  maxPendingReceipts: 512,
  /** Hard ceiling on a history page, whatever the peer asks for. */
  maxHistoryPageSize: 100,
  /**
   * Byte budget for one history response. Bounded independently of the page
   * size because 100 maximum-length messages would be 1.6 MB - which a peer
   * could ask for over and over on a BLE link.
   */
  maxHistoryResponseBytes: 24 * 1024,
  /** Wall-clock timestamps must be sane: no negatives, nothing past ~2200. */
  maxTimestampMs: 7_258_118_400_000,
  /** Outbox capacity. Beyond this, composing another message is refused. */
  maxOutboxEntries: 512,
  /** Give up resending an unconfirmed message after this many attempts. */
  maxSendAttempts: 16,
  /** How many recently-seen message ids are remembered for deduplication. */
  recentIdMemory: 1024,
} as const;

// ---------------------------------------------------------------------------
// Delivery status
// ---------------------------------------------------------------------------

/**
 * The delivery ladder. Ordered, and it only ever climbs.
 *
 * There is deliberately no FAILED rung. A failed send is not a later stage of
 * delivery - it is an orthogonal fact about the current attempt, and a message
 * that failed once and succeeded on reconnect is still SENT. Folding failure
 * into this enum would either break monotonicity or let FAILED swallow
 * DELIVERED. Failure lives on `OutboxEntry.failed` and the `sendFailed` event.
 */
export const DeliveryStatus = {
  /** Composed and queued locally. Not yet handed to the session. */
  PENDING: 0,
  /** Handed to the reliability layer. The bytes are on their way. */
  SENT: 1,
  /** The peer's chat protocol confirmed receipt. */
  DELIVERED: 2,
  /** The peer's user opened the conversation. */
  READ: 3,
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/**
 * Monotonic status transition. Receipts can arrive out of order, twice, or
 * after a reconnect has already resent the message - so every status update in
 * this module goes through here rather than assigning directly.
 */
export function advanceDeliveryStatus(current: DeliveryStatus, next: DeliveryStatus): DeliveryStatus {
  return next > current ? next : current;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * A file riding along with a message.
 *
 * The bytes are NOT here: the file transfer runs separately over the BULK
 * channel and can take minutes over Bluetooth. This descriptor is what lets the
 * UI draw an image or file bubble - with a name, a size and a progress bar -
 * from the moment the message arrives.
 */
export interface ChatAttachment {
  /** Matches the id the file-transfer module uses for the actual bytes. */
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  /** Pixel dimensions, when the sender knows them. Lets the UI reserve space. */
  readonly width?: number;
  readonly height?: number;
  /** Audio/video duration, when known. */
  readonly durationMs?: number;
}

/**
 * One chat message, as it exists on both devices.
 *
 * `id` is generated by the SENDER and is globally unique, which is the property
 * the whole protocol rests on: receipts, reactions, replies and deletes all
 * address a message by id, and a message redelivered after a reconnect is
 * recognised rather than duplicated.
 */
export interface ChatMessage {
  readonly id: string;
  /** Sender wall clock at composition. Advisory - never trusted for ordering. */
  readonly timestamp: number;
  /** May be empty when the message is an attachment with no caption. */
  readonly text: string;
  /** The message this one replies to, or null. */
  readonly replyToId: string | null;
  readonly attachments: readonly ChatAttachment[];
}

/** What the app hands to `ChatProtocol.send`. */
export interface ChatDraft {
  readonly text?: string;
  readonly replyToId?: string;
  readonly attachments?: readonly ChatAttachment[];
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface TypingSignal {
  readonly typing: boolean;
  /**
   * How long the receiver should keep the indicator lit without hearing again.
   * Carried on the wire so the indicator expires by itself: a "stopped typing"
   * that is dropped by a lossy realtime channel must not leave the three dots
   * bouncing forever.
   */
  readonly ttlMs: number;
}

export interface ReceiptSignal {
  readonly ids: readonly string[];
  readonly at: number;
}

export interface ReactionSignal {
  readonly messageId: string;
  readonly emoji: string;
  readonly removed: boolean;
  readonly at: number;
}

export interface DeleteRequestSignal {
  readonly ids: readonly string[];
}

/** What one side asks for when it has been away. */
export interface HistoryQuery {
  /** Inclusive lower bound on the sender's wall clock, in milliseconds. */
  readonly sinceMs: number;
  /**
   * Tiebreaker cursor: resume strictly after this message id among those
   * sharing `sinceMs`. Without it, a page boundary that lands on two messages
   * with the same millisecond either loops forever or skips one.
   */
  readonly afterId: string | null;
  readonly limit: number;
}

export interface HistoryRequestSignal extends HistoryQuery {
  readonly requestId: string;
}

export interface HistoryResponseSignal {
  readonly requestId: string;
  readonly messages: readonly ChatMessage[];
  /** True when the responder had more to give than fitted in this page. */
  readonly more: boolean;
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

/**
 * A message the app composed, in the queue until the peer confirms it.
 *
 * This is also the persistence contract: an app that stores these snapshots and
 * replays them into `ChatProtocol.restoreOutbox` on launch keeps a queue that
 * survives the process dying, with no database code in this package.
 */
export interface OutboxEntry {
  readonly message: ChatMessage;
  /**
   * Local, strictly increasing. This - not the wall clock - is the send order,
   * because the wall clock can jump backwards and two messages composed in the
   * same millisecond must still have an order.
   */
  readonly sequence: number;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  /**
   * The reliability layer confirmed the bytes reached the peer's session. Not
   * the same as DELIVERED, which means the peer's chat protocol accepted them.
   */
  readonly transportAcked: boolean;
  readonly lastAttemptAt: number | null;
  /** The last attempt exhausted its retries. Cleared when a retry succeeds. */
  readonly failed: boolean;
}

// ---------------------------------------------------------------------------
// A small bounded map, used for dedup and status memory
// ---------------------------------------------------------------------------

/**
 * Insertion-ordered map with a hard capacity, evicting oldest first.
 *
 * Every per-peer set in this module is bounded by one of these. A peer that
 * sends a million distinct message ids must cost us a fixed amount of memory,
 * not a million entries.
 */
export class BoundedMap<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('BoundedMap: capacity must be at least 1');
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): V | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: V): void {
    // Re-inserting must not renew the eviction order for a key that is merely
    // being updated; delete-then-set would make a chatty peer immortal.
    if (this.entries.has(key)) {
      this.entries.set(key, value);
      return;
    }
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * A de-duplicating FIFO of identifiers with a hard capacity.
 *
 * The queue of receipts we owe the peer is the one place in this module where
 * a peer's send rate, rather than our own behaviour, decides how much is
 * outstanding - so it is bounded like every other per-peer collection, and the
 * membership test is a `Set` rather than a scan, or a peer could make each of
 * its messages cost us a walk of everything queued before it.
 *
 * Overflow drops the OLDEST id. The consequence of dropping one is that the
 * peer's message stays at SENT rather than climbing to DELIVERED, which is a
 * far better failure than an unbounded array on a phone.
 */
export class BoundedIdQueue {
  private order: string[] = [];
  private readonly index = new Set<string>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('BoundedIdQueue: capacity must be at least 1');
  }

  get size(): number {
    return this.order.length;
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** Append an id. Returns the id evicted to make room, if any. */
  push(id: string): string | null {
    if (this.index.has(id)) return null;
    this.order.push(id);
    this.index.add(id);
    if (this.order.length <= this.capacity) return null;
    const evicted = this.order.shift() as string;
    this.index.delete(evicted);
    return evicted;
  }

  /** Remove and return up to `count` ids from the front, in order. */
  take(count: number): string[] {
    const batch = this.order.splice(0, Math.max(0, count));
    for (const id of batch) this.index.delete(id);
    return batch;
  }

  /** Return a batch to the front, preserving order. Overflow is discarded. */
  requeue(ids: readonly string[]): void {
    const restored = [...ids.filter((id) => !this.index.has(id)), ...this.order];
    this.order = restored.slice(Math.max(0, restored.length - this.capacity));
    this.index.clear();
    for (const id of this.order) this.index.add(id);
  }

  clear(): void {
    this.order = [];
    this.index.clear();
  }
}
