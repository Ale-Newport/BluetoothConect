/**
 * The chat protocol: messages, receipts, typing, reactions, deletes and
 * history, bound to one `PeerSession`.
 *
 * Everything that can be decided without a peer lives in `codec.ts` as a pure
 * function. What is left here is the part that genuinely needs state: the
 * outbox, the delivery ladder, and the timers that stop a lost packet from
 * leaving the UI wrong forever.
 *
 * Three properties are worth stating up front, because the rest of the file is
 * in service of them:
 *
 *  1. **The sender names the message.** Ids are generated here, are globally
 *     unique, and travel with every receipt, reaction, reply and delete. Both
 *     devices therefore agree on what "that message" means, and a message
 *     redelivered after a reconnect is recognised rather than duplicated.
 *  2. **Status only ever climbs.** Receipts arrive late, twice, or out of
 *     order on a lossy radio. Every transition goes through
 *     `advanceDeliveryStatus`, so DELIVERED can never overwrite READ.
 *  3. **Nothing here persists anything.** The outbox is exposed as plain
 *     snapshots and restored from them, so an app can keep it in SQLite - or
 *     nowhere at all - without this module importing a database.
 */
import { MessageType } from '../protocol/constants.js';
import { decodeCbor, encodeCbor, type CborValue } from '../protocol/cbor.js';
import type { RandomSource } from '../crypto/random.js';
import type { IncomingMessage, PeerSession } from '../session/peerSession.js';
import { ConnectionState } from '../session/stateMachine.js';
import { TypedEmitter, type Unsubscribe } from '../util/emitter.js';
import { newSortableId } from '../util/ids.js';
import { silentLogger, type Logger } from '../util/logger.js';
import type { Clock, TimerHandle } from '../util/time.js';
import { DecodeError } from '../util/varint.js';
import {
  assertValidId,
  decodeChatMessage,
  decodeDeleteRequest,
  decodeHistoryRequest,
  decodeHistoryResponse,
  decodeReaction,
  decodeReceipt,
  decodeTyping,
  encodeChatMessage,
  encodeDeleteRequest,
  encodeHistoryRequest,
  encodeHistoryResponse,
  encodeReaction,
  encodeReceipt,
  encodeTyping,
  encodedMessageSize,
  normalizeBody,
  normalizeReaction,
  TYPING_TTL_BOUNDS,
} from './codec.js';
import {
  advanceDeliveryStatus,
  BoundedIdQueue,
  BoundedMap,
  CHAT_LIMITS,
  DeliveryStatus,
  isDeliveryStatus,
  type ChatDraft,
  type ChatMessage,
  type HistoryQuery,
  type OutboxEntry,
  type ReactionSignal,
} from './types.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Where to resume a history walk that came back with `more: true`. */
export interface HistoryCursor {
  readonly sinceMs: number;
  readonly afterId: string;
}

/**
 * Supplies the messages a peer asks for. The app owns storage, so it owns this.
 * May return a promise: reading a phone's database is asynchronous.
 *
 * Whatever it returns is bounded again on the way out - a provider that ignores
 * `query.limit` cannot make us send a 10 MB page over Bluetooth.
 */
export type ChatHistoryProvider = (query: HistoryQuery) => readonly ChatMessage[] | Promise<readonly ChatMessage[]>;

export interface ChatProtocolEvents {
  /** A new message from the peer. Duplicates never reach here. */
  message: { readonly message: ChatMessage; readonly receivedAt: number };
  /** A locally composed message entered the outbox. */
  queued: { readonly entry: OutboxEntry };
  /** One of OUR messages moved up the delivery ladder. */
  statusChanged: { readonly messageId: string; readonly status: DeliveryStatus };
  /** The reliability layer gave up on one of our messages. It stays in the outbox. */
  sendFailed: { readonly messageId: string; readonly attempts: number };
  /** The peer started or stopped typing. A stop is synthesised when the TTL runs out. */
  typing: { readonly typing: boolean };
  /** The peer added or removed a reaction on a message we know about. */
  reaction: { readonly signal: ReactionSignal };
  /**
   * The peer asked us to delete messages. It is a REQUEST: this module deletes
   * nothing on its own, and the app decides whether to honour it.
   */
  deleteRequested: { readonly ids: readonly string[] };
  /** The peer asked for history. Served automatically from the provider. */
  historyRequest: { readonly requestId: string; readonly query: HistoryQuery };
  historyResponse: {
    readonly requestId: string;
    readonly messages: readonly ChatMessage[];
    readonly more: boolean;
    /** Non-null exactly when `more` is true and the page was non-empty. */
    readonly nextCursor: HistoryCursor | null;
  };
  historyFailed: { readonly requestId: string; readonly reason: string };
  /** Something from the peer was refused. Developer Mode surfaces these. */
  dropped: { readonly reason: string; readonly detail: string };
}

export interface ChatProtocolOptions {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly logger?: Logger;
  /** Answers a peer's MESSAGE_HISTORY_REQUEST. Absent means "I have nothing". */
  readonly historyProvider?: ChatHistoryProvider;
  /**
   * Decides whether a reaction's target exists. The in-memory fallback only
   * remembers the last {@link CHAT_LIMITS.recentIdMemory} ids, so an app with a
   * database should pass its own lookup or reactions to older messages will be
   * dropped as dangling.
   */
  readonly messageExists?: (messageId: string) => boolean;
  /** How long a typing indicator lives without a refresh. Clamped to the wire bounds. */
  readonly typingTtlMs?: number;
  /** Minimum gap between outbound typing signals. This is the coalescing. */
  readonly typingRepeatMs?: number;
  /** How long delivery receipts are batched before being sent. */
  readonly receiptBatchMs?: number;
  /** Give up on an unanswered history request after this long. */
  readonly historyTimeoutMs?: number;
  readonly maxOutboxEntries?: number;
  readonly maxSendAttempts?: number;
}

export interface ChatStats {
  readonly messagesSent: number;
  readonly messagesReceived: number;
  readonly duplicatesDropped: number;
  readonly malformedDropped: number;
  /** Reactions and receipts naming a message we have never heard of. */
  readonly danglingReferences: number;
  readonly historyServed: number;
  readonly historyThrottled: number;
  /** Receipts owed to the peer that no link has been able to carry yet. */
  readonly pendingReceipts: number;
  /** Receipts discarded because the peer outran every link we had. */
  readonly receiptsDropped: number;
  /** Messages the peer's declared payload budget can never carry. */
  readonly undeliverable: number;
}

const DEFAULTS = {
  typingTtlMs: 6_000,
  typingRepeatMs: 2_000,
  receiptBatchMs: 200,
  historyTimeoutMs: 30_000,
  /** Concurrent history requests we will answer before throttling kicks in. */
  historyBurst: 4,
  /** One history answer earned per this many milliseconds. */
  historyRefillMs: 5_000,
  /** Outstanding history requests WE may have in flight. */
  maxPendingHistoryRequests: 4,
} as const;

// ---------------------------------------------------------------------------

export class ChatProtocol {
  readonly events = new TypedEmitter<ChatProtocolEvents>();

  /**
   * Insertion order IS send order. Entries are only ever appended, and `Map`
   * preserves insertion order across in-place updates, so iterating the map is
   * iterating the queue - no sort, and no way for a re-queued message to jump
   * ahead of one composed before it.
   */
  private readonly outbox = new Map<string, OutboxEntry>();
  /** Ids currently owned by the session's reliability layer. Not re-sent. */
  private readonly inFlight = new Set<string>();
  /** Reliable sequence number -> our message id, for the session's ack events. */
  private readonly seqToMessageId = new BoundedMap<string>(CHAT_LIMITS.maxOutboxEntries);
  /** Monotonic status of every message we have sent, outliving its outbox entry. */
  private readonly sentStatus = new BoundedMap<DeliveryStatus>(CHAT_LIMITS.recentIdMemory);
  /** Ids received from the peer, for deduplication and reaction targeting. */
  private readonly seenIncoming = new BoundedMap<true>(CHAT_LIMITS.recentIdMemory);
  /** Ids we have already sent a read receipt for; stops a chatty UI spamming the radio. */
  private readonly readSent = new BoundedMap<true>(CHAT_LIMITS.recentIdMemory);

  /**
   * Receipts we owe the peer. Bounded, because the peer - not this device -
   * decides how fast messages arrive, and there are states (a link that has
   * just died, a pairing code still on screen) where none of them can be sent.
   */
  private readonly pendingDelivery = new BoundedIdQueue(CHAT_LIMITS.maxPendingReceipts);
  private readonly pendingRead = new BoundedIdQueue(CHAT_LIMITS.maxPendingReceipts);
  private receiptTimer: TimerHandle | undefined;

  /** Request id -> its deadline timer. Only ids in here accept a response. */
  private readonly pendingHistory = new Map<string, TimerHandle>();
  private historyTokens: number = DEFAULTS.historyBurst;
  private historyTokensAt: number;

  private localTyping = false;
  private lastTypingSentAt = Number.NEGATIVE_INFINITY;
  private typingHoldTimer: TimerHandle | undefined;
  private peerTyping = false;
  private peerTypingTimer: TimerHandle | undefined;

  private nextSequence = 1;
  private disposed = false;
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly log: Logger;

  private messagesSent = 0;
  private messagesReceived = 0;
  private duplicatesDropped = 0;
  private malformedDropped = 0;
  private danglingReferences = 0;
  private historyServed = 0;
  private historyThrottled = 0;
  private receiptsDropped = 0;
  private undeliverable = 0;

  constructor(
    private readonly session: PeerSession,
    private readonly options: ChatProtocolOptions,
  ) {
    this.log = (options.logger ?? silentLogger).child(`chat:${session.peerHandle}`);
    this.historyTokensAt = options.clock.now();

    this.unsubscribers.push(
      session.events.on('message', (m) => this.handleIncoming(m)),
      session.events.on('delivered', ({ seq }) => this.handleTransportAck(seq)),
      session.events.on('deliveryFailed', ({ seq, messageType }) => this.handleTransportFailure(seq, messageType)),
      session.events.on('stateChanged', ({ state }) => this.handleStateChange(state)),
      session.events.on('closed', () => this.handleSessionClosed()),
    );
  }

  // -- introspection ---------------------------------------------------------

  get outboxSize(): number {
    return this.outbox.size;
  }

  get isPeerTyping(): boolean {
    return this.peerTyping;
  }

  get stats(): ChatStats {
    return {
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      duplicatesDropped: this.duplicatesDropped,
      malformedDropped: this.malformedDropped,
      danglingReferences: this.danglingReferences,
      historyServed: this.historyServed,
      historyThrottled: this.historyThrottled,
      pendingReceipts: this.pendingDelivery.size + this.pendingRead.size,
      receiptsDropped: this.receiptsDropped,
      undeliverable: this.undeliverable,
    };
  }

  /** Current delivery status of a message we sent, or null if it is forgotten. */
  statusOf(messageId: string): DeliveryStatus | null {
    return this.sentStatus.get(messageId) ?? this.outbox.get(messageId)?.status ?? null;
  }

  /** A snapshot the app can persist verbatim and hand back to `restoreOutbox`. */
  outboxSnapshot(): readonly OutboxEntry[] {
    return [...this.outbox.values()];
  }

  /**
   * Reload a persisted outbox after a restart.
   *
   * Entries are re-sent as soon as the session is usable: nothing is in flight
   * in a process that has only just started, whatever the stored status said.
   * Corrupt entries are skipped rather than thrown on - a damaged row in the
   * app's database must not stop the other messages from going out, and a
   * store that has somehow grown past the queue's capacity is truncated to it
   * rather than being allowed in through the back door.
   */
  restoreOutbox(entries: readonly OutboxEntry[]): void {
    this.outbox.clear();
    this.inFlight.clear();
    const capacity = this.options.maxOutboxEntries ?? CHAT_LIMITS.maxOutboxEntries;
    const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
    for (const entry of ordered) {
      if (this.outbox.size >= capacity) {
        this.log.warn('outbox capacity reached while restoring; the rest of the store was skipped', {
          restored: this.outbox.size,
          offered: ordered.length,
        });
        break;
      }
      if (!Number.isInteger(entry.sequence) || entry.sequence < 0) continue;
      if (!isDeliveryStatus(entry.status)) continue;
      try {
        // Round-tripping through the encoder is the cheapest complete
        // validation there is: if it can go on the wire, it can go in the queue.
        encodeChatMessage(entry.message);
      } catch (err) {
        this.log.warn('skipped an unencodable outbox entry', { id: entry.message.id, err: String(err) });
        continue;
      }
      const attempts = Number.isInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : 0;
      this.outbox.set(entry.message.id, {
        message: entry.message,
        sequence: entry.sequence,
        status: entry.status,
        attempts,
        transportAcked: entry.transportAcked === true,
        lastAttemptAt: typeof entry.lastAttemptAt === 'number' ? entry.lastAttemptAt : null,
        failed: entry.failed === true,
      });
      this.sentStatus.set(entry.message.id, entry.status);
      this.nextSequence = Math.max(this.nextSequence, entry.sequence + 1);
    }
    this.flush();
  }

  // -- sending ---------------------------------------------------------------

  /**
   * Compose a message. It is queued immediately and sent when the session can
   * carry it, which is the whole point: typing a message on a plane with the
   * peer's phone in a bag must not fail, it must wait.
   */
  send(draft: ChatDraft): OutboxEntry {
    this.assertLive();
    if (this.outbox.size >= (this.options.maxOutboxEntries ?? CHAT_LIMITS.maxOutboxEntries)) {
      throw new Error('chat: outbox is full - deliver or discard queued messages before composing more');
    }
    // Trimmed at the edges: a bubble containing nothing but spaces and newlines
    // is a blank bubble, and sending one is never what the user meant.
    const text = normalizeBody(draft.text ?? '').trim();
    const attachments = draft.attachments ?? [];
    if (text.length === 0 && attachments.length === 0) {
      throw new Error('chat: a message must carry text or at least one attachment');
    }
    const message: ChatMessage = {
      id: newSortableId(this.options.random, this.options.clock.wallNow()),
      timestamp: this.options.clock.wallNow(),
      text,
      replyToId: draft.replyToId !== undefined ? assertValidId(draft.replyToId, 'replyTo id') : null,
      attachments: [...attachments],
    };
    // Encode now, not at flush time. A draft the app got wrong should throw in
    // the call that created it, where there is a stack trace worth reading.
    encodeChatMessage(message);

    const entry: OutboxEntry = {
      message,
      sequence: this.nextSequence++,
      status: DeliveryStatus.PENDING,
      attempts: 0,
      transportAcked: false,
      lastAttemptAt: null,
      failed: false,
    };
    this.outbox.set(message.id, entry);
    this.sentStatus.set(message.id, DeliveryStatus.PENDING);
    this.events.emit('queued', { entry });
    this.flush();
    return this.outbox.get(message.id) ?? entry;
  }

  /**
   * Hand every eligible queued message to the session, oldest first.
   * Returns how many were handed over.
   */
  flush(): number {
    this.flushReceipts();
    if (!this.canSendMessages()) return 0;
    let handed = 0;
    for (const entry of this.outbox.values()) {
      if (this.inFlight.has(entry.message.id)) continue;
      if (entry.status >= DeliveryStatus.DELIVERED) continue;
      if (entry.attempts >= (this.options.maxSendAttempts ?? CHAT_LIMITS.maxSendAttempts)) continue;
      const outcome = this.transmit(entry);
      if (outcome === 'sent') {
        handed++;
        continue;
      }
      // "Not now" stops the walk: skipping ahead would put a later message on
      // the wire before an earlier one, and ordering is the one thing a chat
      // may never get wrong.
      if (outcome === 'later') break;
      // "Never" must NOT stop it. A message this peer's declared payload budget
      // cannot carry would otherwise wedge the head of the queue forever and
      // take every message composed after it down with it - the whole
      // conversation stuck at PENDING because of one long paragraph.
    }
    return handed;
  }

  /**
   * Clear the failure flag and try again. For a "retry" button.
   * Returns whether THIS message is now on its way, not merely whether the
   * flush did something.
   */
  retry(messageId: string): boolean {
    const entry = this.outbox.get(messageId);
    if (!entry) return false;
    this.outbox.set(messageId, { ...entry, attempts: 0, failed: false });
    this.flush();
    return this.inFlight.has(messageId);
  }

  /**
   * One attempt at one entry.
   *
   *  'sent'  - handed to the reliability layer
   *  'later' - the link cannot take it right now; try again on reconnect
   *  'never' - this message can never go to this peer; the queue must step over it
   */
  private transmit(entry: OutboxEntry): 'sent' | 'later' | 'never' {
    let payload: CborValue;
    try {
      payload = encodeChatMessage(entry.message);
    } catch (err) {
      // Only reachable for an entry restored from a corrupted store; it can
      // never be sent, so it must not block the queue behind it.
      this.log.error('dropping an unencodable outbox entry', { id: entry.message.id, err: String(err) });
      this.outbox.delete(entry.message.id);
      this.inFlight.delete(entry.message.id);
      this.undeliverable++;
      this.events.emit('sendFailed', { messageId: entry.message.id, attempts: entry.attempts });
      return 'never';
    }
    const seq = this.trySendReliable(MessageType.MESSAGE, payload);
    if (seq === null) return this.classifyRefusal(entry, payload);

    this.inFlight.add(entry.message.id);
    this.seqToMessageId.set(String(seq), entry.message.id);
    this.outbox.set(entry.message.id, {
      ...entry,
      attempts: entry.attempts + 1,
      failed: false,
      lastAttemptAt: this.options.clock.wallNow(),
    });
    this.messagesSent++;
    this.advanceStatus(entry.message.id, DeliveryStatus.SENT);
    return 'sent';
  }

  /**
   * Work out whether a refusal was "not now" or "not ever".
   *
   * A peer may declare a payload budget as small as 256 bytes, and every link
   * it is reached over is bound by it - so a message larger than that budget is
   * refused now and will be refused after every reconnect. Treating that as a
   * temporary failure is what turns one long paragraph into a conversation
   * that never sends anything again.
   */
  private classifyRefusal(entry: OutboxEntry, payload: CborValue): 'later' | 'never' {
    if (!this.canSendMessages()) return 'later';
    let size: number;
    try {
      size = encodeCbor(payload).length;
    } catch {
      return 'later';
    }
    if (size <= this.session.maxPayloadBytes) return 'later';
    this.undeliverable++;
    this.log.warn('a queued message exceeds the payload budget this peer declared', {
      id: entry.message.id,
      size,
      limit: this.session.maxPayloadBytes,
    });
    // It stays in the outbox, flagged, so the app can show it and offer to
    // shorten or resend it - but it no longer holds up anything behind it.
    this.outbox.set(entry.message.id, { ...entry, failed: true, attempts: entry.attempts + 1 });
    if (!entry.failed) this.events.emit('sendFailed', { messageId: entry.message.id, attempts: entry.attempts });
    return 'never';
  }

  // -- typing ----------------------------------------------------------------

  /**
   * Publish this device's typing state.
   *
   * Call it on every keystroke: repeated `true` inside the coalescing window
   * costs nothing, and the REALTIME channel supersedes an undelivered signal
   * with the next one rather than queueing both.
   */
  setTyping(typing: boolean): void {
    if (this.disposed) return;
    const now = this.options.clock.now();
    const ttlMs = this.typingTtl();

    if (!typing) {
      if (!this.localTyping) return;
      this.localTyping = false;
      this.clearTypingHold();
      this.sendTyping(false, ttlMs);
      return;
    }

    // Refresh well before the peer's indicator expires, but no more often than
    // the coalescing interval - on a 40 KB/s radio, per-keystroke packets are a
    // real cost.
    const due = !this.localTyping || now - this.lastTypingSentAt >= (this.options.typingRepeatMs ?? DEFAULTS.typingRepeatMs);
    this.localTyping = true;
    if (due) {
      this.lastTypingSentAt = now;
      this.sendTyping(true, ttlMs);
    }
    // Belt and braces for an app that forgets to say "stopped": our own state
    // expires too, so the next keystroke after a long pause sends a fresh
    // signal instead of assuming the peer is still lit up.
    this.clearTypingHold();
    this.typingHoldTimer = this.options.clock.setTimeout(() => {
      this.typingHoldTimer = undefined;
      this.localTyping = false;
    }, ttlMs);
  }

  private typingTtl(): number {
    const requested = this.options.typingTtlMs ?? DEFAULTS.typingTtlMs;
    return Math.max(TYPING_TTL_BOUNDS.minMs, Math.min(TYPING_TTL_BOUNDS.maxMs, Math.floor(requested)));
  }

  private sendTyping(typing: boolean, ttlMs: number): void {
    if (!this.canSignal()) return;
    try {
      // REALTIME with a coalesce key: a typing signal that has not left the
      // device yet is REPLACED by the next one, so a slow link shows the
      // current state instead of a backlog of stale ones.
      this.session.sendRealtime(MessageType.TYPING, encodeCbor(encodeTyping({ typing, ttlMs })), 'chat.typing');
    } catch (err) {
      this.log.debug('typing signal not sent', { err: String(err) });
    }
  }

  private clearTypingHold(): void {
    if (this.typingHoldTimer === undefined) return;
    this.options.clock.clearTimeout(this.typingHoldTimer);
    this.typingHoldTimer = undefined;
  }

  private setPeerTyping(typing: boolean, ttlMs: number): void {
    if (this.peerTypingTimer !== undefined) {
      this.options.clock.clearTimeout(this.peerTypingTimer);
      this.peerTypingTimer = undefined;
    }
    if (typing) {
      // The indicator is armed to switch itself off. A "stopped typing" lost by
      // the best-effort channel - or a peer that walked out of range mid-word -
      // must not leave three dots bouncing for the rest of the conversation.
      this.peerTypingTimer = this.options.clock.setTimeout(() => {
        this.peerTypingTimer = undefined;
        if (!this.peerTyping) return;
        this.peerTyping = false;
        this.events.emit('typing', { typing: false });
      }, ttlMs);
    }
    if (this.peerTyping === typing) return;
    this.peerTyping = typing;
    this.events.emit('typing', { typing });
  }

  // -- receipts --------------------------------------------------------------

  /**
   * Tell the peer their messages have been read. Ids we have already
   * acknowledged are skipped, so calling this on every scroll is safe.
   */
  markRead(ids: readonly string[]): void {
    if (this.disposed) return;
    for (const id of ids) {
      if (this.readSent.has(id) || this.pendingRead.has(id)) continue;
      try {
        assertValidId(id, 'read receipt id');
      } catch {
        continue;
      }
      // Queued, not sent. Recording an id as acknowledged before the bytes have
      // been accepted anywhere would lose the receipt for good: the peer's
      // message would sit at DELIVERED forever, and no amount of scrolling
      // would ever produce another chance to say otherwise.
      this.pendingRead.push(id);
    }
    this.flushReceipts();
  }

  private queueDeliveryReceipt(id: string): void {
    const evicted = this.pendingDelivery.push(id);
    if (evicted !== null) {
      this.receiptsDropped++;
      this.log.debug('dropped the oldest unsent delivery receipt', { evicted });
    }
    // A full batch goes immediately; anything else waits, because one receipt
    // per message would double the packet count of a busy conversation.
    if (this.pendingDelivery.size >= CHAT_LIMITS.maxIdsPerBatch) {
      this.flushReceipts();
      return;
    }
    if (this.receiptTimer !== undefined) return;
    this.receiptTimer = this.options.clock.setTimeout(() => {
      this.receiptTimer = undefined;
      this.flushReceipts();
    }, this.options.receiptBatchMs ?? DEFAULTS.receiptBatchMs);
  }

  private flushReceipts(): void {
    if (!this.canSignal()) return;
    if (this.pendingDelivery.size === 0 && this.pendingRead.size === 0) return;
    if (this.receiptTimer !== undefined) {
      this.options.clock.clearTimeout(this.receiptTimer);
      this.receiptTimer = undefined;
    }
    this.flushReceiptQueue(this.pendingDelivery, MessageType.DELIVERY_RECEIPT);
    this.flushReceiptQueue(this.pendingRead, MessageType.READ_RECEIPT);
  }

  private flushReceiptQueue(queue: BoundedIdQueue, type: number): void {
    const at = this.options.clock.wallNow();
    let batchSize: number = CHAT_LIMITS.maxIdsPerBatch;
    while (queue.size > 0) {
      const batch = queue.take(Math.min(batchSize, queue.size));
      if (this.trySendReliable(type, encodeReceipt({ ids: batch, at })) !== null) {
        if (type === MessageType.READ_RECEIPT) for (const id of batch) this.readSent.set(id, true);
        continue;
      }
      // Refused. Put the batch back at the front, in order. A peer that
      // declared a small payload budget cannot take sixty-four ids at once, so
      // halve and try again rather than deciding the link is dead: a receipt
      // ladder that can never send a full batch would otherwise never send
      // anything at all.
      queue.requeue(batch);
      if (batch.length <= 1) return;
      batchSize = Math.floor(batch.length / 2);
    }
  }

  // -- reactions, deletes ----------------------------------------------------

  /** Add an emoji reaction to a message. */
  addReaction(messageId: string, emoji: string): boolean {
    return this.sendReaction(messageId, emoji, false);
  }

  /** Take one back. Same wire message, with the removal flag set. */
  removeReaction(messageId: string, emoji: string): boolean {
    return this.sendReaction(messageId, emoji, true);
  }

  private sendReaction(messageId: string, emoji: string, removed: boolean): boolean {
    this.assertLive();
    const signal: ReactionSignal = {
      messageId: assertValidId(messageId, 'reaction target id'),
      emoji: normalizeReaction(emoji),
      removed,
      at: this.options.clock.wallNow(),
    };
    return this.trySendReliable(MessageType.REACTION, encodeReaction(signal)) !== null;
  }

  /**
   * Delete locally. Anything still queued is cancelled so it is never sent;
   * anything already gone is the app's to forget. Returns the ids that were
   * still in the outbox, which are the ones the peer will now never see.
   */
  deleteForMe(ids: readonly string[]): readonly string[] {
    const cancelled: string[] = [];
    for (const id of ids) {
      const entry = this.outbox.get(id);
      // A message already handed to the reliability layer cannot be recalled:
      // the bytes may be on the radio. Cancel only what has not left.
      if (!entry || this.inFlight.has(id)) continue;
      this.outbox.delete(id);
      // It never existed as far as this device is concerned, so it has no
      // delivery status either.
      this.sentStatus.delete(id);
      cancelled.push(id);
    }
    return cancelled;
  }

  /** Ask the peer to delete messages. They may decline; we are never told. */
  requestDelete(ids: readonly string[]): boolean {
    this.assertLive();
    if (ids.length === 0) return false;
    let sent = false;
    for (let i = 0; i < ids.length; i += CHAT_LIMITS.maxIdsPerBatch) {
      const batch = ids.slice(i, i + CHAT_LIMITS.maxIdsPerBatch);
      if (this.trySendReliable(MessageType.MESSAGE_DELETE, encodeDeleteRequest({ ids: batch })) !== null) sent = true;
    }
    return sent;
  }

  // -- history ---------------------------------------------------------------

  /**
   * Ask the peer for what we missed. Returns the request id, or null if the
   * request could not be sent or too many are already outstanding.
   */
  requestHistory(options: { sinceMs: number; limit?: number; afterId?: string | null }): string | null {
    this.assertLive();
    if (this.pendingHistory.size >= DEFAULTS.maxPendingHistoryRequests) return null;

    const requestId = newSortableId(this.options.random, this.options.clock.wallNow());
    const query: HistoryQuery = {
      sinceMs: Math.max(0, Math.min(CHAT_LIMITS.maxTimestampMs, Math.floor(options.sinceMs))),
      afterId: options.afterId != null ? assertValidId(options.afterId, 'history cursor id') : null,
      limit: Math.max(1, Math.min(CHAT_LIMITS.maxHistoryPageSize, Math.floor(options.limit ?? CHAT_LIMITS.maxHistoryPageSize))),
    };
    if (this.trySendReliable(MessageType.MESSAGE_HISTORY_REQUEST, encodeHistoryRequest({ ...query, requestId })) === null) {
      return null;
    }
    // Every outstanding request carries its own deadline, so a peer that simply
    // never answers cannot leak an entry per attempt.
    const timer = this.options.clock.setTimeout(() => {
      if (!this.pendingHistory.delete(requestId)) return;
      this.events.emit('historyFailed', { requestId, reason: 'timed out' });
    }, this.options.historyTimeoutMs ?? DEFAULTS.historyTimeoutMs);
    this.pendingHistory.set(requestId, timer);
    return requestId;
  }

  /**
   * A token bucket over the peer's history requests. A full page is 24 KB,
   * which is six seconds of BLE airtime; without this, "ask for everything" is
   * a denial-of-service primitive that costs the attacker one small packet.
   */
  private takeHistoryToken(): boolean {
    const now = this.options.clock.now();
    const earned = Math.floor((now - this.historyTokensAt) / DEFAULTS.historyRefillMs);
    if (earned > 0) {
      this.historyTokens = Math.min(DEFAULTS.historyBurst, this.historyTokens + earned);
      this.historyTokensAt += earned * DEFAULTS.historyRefillMs;
    }
    if (this.historyTokens <= 0) return false;
    this.historyTokens--;
    return true;
  }

  private serveHistory(requestId: string, query: HistoryQuery): void {
    const provider = this.options.historyProvider;
    if (!provider) {
      // Answer anyway. Silence is indistinguishable from a dead link, and would
      // leave the peer's spinner turning until its own timeout.
      this.trySendReliable(
        MessageType.MESSAGE_HISTORY_RESPONSE,
        encodeHistoryResponse({ requestId, messages: [], more: false }),
      );
      return;
    }
    let result: readonly ChatMessage[] | Promise<readonly ChatMessage[]>;
    try {
      result = provider(query);
    } catch (err) {
      this.log.warn('history provider threw', { err: String(err) });
      return;
    }
    void Promise.resolve(result)
      .then((messages) => {
        if (this.disposed) return;
        this.sendHistoryPage(requestId, query, messages);
      })
      .catch((err: unknown) => {
        this.log.warn('history provider rejected', { err: String(err) });
      });
  }

  private sendHistoryPage(requestId: string, query: HistoryQuery, messages: readonly ChatMessage[]): void {
    const page: ChatMessage[] = [];
    let bytes = 0;
    let more = messages.length > query.limit;
    for (const message of messages.slice(0, query.limit)) {
      let size: number;
      try {
        size = encodedMessageSize(message);
      } catch (err) {
        // Our own store handed us something unsendable. Skip it rather than
        // failing the page - the peer would have no way to make progress.
        this.log.warn('history entry could not be encoded', { err: String(err) });
        continue;
      }
      // The first message goes in whatever it costs, or a single oversized
      // message would stall the walk forever at the same cursor.
      if (page.length > 0 && bytes + size > CHAT_LIMITS.maxHistoryResponseBytes) {
        more = true;
        break;
      }
      page.push(message);
      bytes += size;
    }
    if (this.trySendReliable(MessageType.MESSAGE_HISTORY_RESPONSE, encodeHistoryResponse({ requestId, messages: page, more })) !== null) {
      this.historyServed++;
    }
  }

  // -- inbound ---------------------------------------------------------------

  private handleIncoming(incoming: IncomingMessage): void {
    if (this.disposed) return;
    try {
      switch (incoming.type) {
        case MessageType.MESSAGE:
          this.onMessage(incoming);
          return;
        case MessageType.TYPING:
          this.onTyping(incoming);
          return;
        case MessageType.DELIVERY_RECEIPT:
          this.onReceipt(incoming, DeliveryStatus.DELIVERED);
          return;
        case MessageType.READ_RECEIPT:
          this.onReceipt(incoming, DeliveryStatus.READ);
          return;
        case MessageType.REACTION:
          this.onReaction(incoming);
          return;
        case MessageType.MESSAGE_DELETE:
          this.onDeleteRequest(incoming);
          return;
        case MessageType.MESSAGE_HISTORY_REQUEST:
          this.onHistoryRequest(incoming);
          return;
        case MessageType.MESSAGE_HISTORY_RESPONSE:
          this.onHistoryResponse(incoming);
          return;
        default:
          // Games, files and sync share this session and this event.
          return;
      }
    } catch (err) {
      // The only exception that may escape a decoder is DecodeError, and it
      // means one packet was rubbish - not that the conversation is broken.
      if (err instanceof DecodeError) {
        this.malformedDropped++;
        this.drop('malformed', err.message);
        return;
      }
      // Anything else is a bug on THIS side, not a hostile peer. It is logged
      // loudly, and the conversation carries on regardless.
      this.log.error('a chat handler threw', { type: incoming.type, err: String(err) });
      this.drop('handler error', String(err));
    }
  }

  /**
   * Payloads arrive already-decoded on the reliable channels and raw on the
   * realtime one (which sets RAW_PAYLOAD). Decoding the raw case here is where
   * a hostile realtime packet meets a bounded decoder.
   */
  private payloadOf(incoming: IncomingMessage): CborValue {
    if (incoming.value !== null) return incoming.value;
    return decodeCbor(incoming.raw);
  }

  private onMessage(incoming: IncomingMessage): void {
    const message = decodeChatMessage(this.payloadOf(incoming));
    // Acknowledge a duplicate as well: the peer resent it precisely because our
    // first receipt did not make it back.
    this.queueDeliveryReceipt(message.id);
    if (this.seenIncoming.has(message.id)) {
      this.duplicatesDropped++;
      return;
    }
    this.seenIncoming.set(message.id, true);
    this.messagesReceived++;
    this.events.emit('message', { message, receivedAt: incoming.receivedAt });
  }

  private onTyping(incoming: IncomingMessage): void {
    const signal = decodeTyping(this.payloadOf(incoming));
    this.setPeerTyping(signal.typing, signal.ttlMs);
  }

  private onReceipt(incoming: IncomingMessage, status: DeliveryStatus): void {
    const receipt = decodeReceipt(this.payloadOf(incoming));
    for (const id of receipt.ids) {
      // A peer can only move OUR messages: an id we never sent has no status to
      // advance, so a fabricated receipt is inert rather than confusing.
      if (this.sentStatus.get(id) === undefined && !this.outbox.has(id)) {
        this.danglingReferences++;
        continue;
      }
      this.advanceStatus(id, status);
    }
  }

  private onReaction(incoming: IncomingMessage): void {
    const signal = decodeReaction(this.payloadOf(incoming));
    if (!this.knowsMessage(signal.messageId)) {
      // A reaction to a message that does not exist has nothing to attach to.
      // Dropping it keeps the UI from inventing a bubble out of a stray id.
      this.danglingReferences++;
      this.drop('dangling reaction', signal.messageId);
      return;
    }
    this.events.emit('reaction', { signal });
  }

  private onDeleteRequest(incoming: IncomingMessage): void {
    const request = decodeDeleteRequest(this.payloadOf(incoming));
    this.events.emit('deleteRequested', { ids: request.ids });
  }

  private onHistoryRequest(incoming: IncomingMessage): void {
    const request = decodeHistoryRequest(this.payloadOf(incoming));
    const query: HistoryQuery = { sinceMs: request.sinceMs, afterId: request.afterId, limit: request.limit };
    if (!this.takeHistoryToken()) {
      this.historyThrottled++;
      this.drop('history rate limit', request.requestId);
      return;
    }
    this.events.emit('historyRequest', { requestId: request.requestId, query });
    this.serveHistory(request.requestId, query);
  }

  private onHistoryResponse(incoming: IncomingMessage): void {
    const response = decodeHistoryResponse(this.payloadOf(incoming));
    if (!this.pendingHistory.has(response.requestId)) {
      // Unsolicited history is a way to push arbitrary content into a
      // conversation. Only an answer to a question we asked is accepted, and
      // only once - a request id is spent the moment it is answered.
      this.drop('unsolicited history response', response.requestId);
      return;
    }
    const timer = this.pendingHistory.get(response.requestId);
    if (timer !== undefined) this.options.clock.clearTimeout(timer);
    this.pendingHistory.delete(response.requestId);

    // Historical messages become valid reaction targets, but they are NOT
    // receipted: the peer already knows we had them once.
    for (const message of response.messages) this.seenIncoming.set(message.id, true);

    const last = response.messages[response.messages.length - 1];
    this.events.emit('historyResponse', {
      requestId: response.requestId,
      messages: response.messages,
      more: response.more,
      nextCursor: response.more && last ? { sinceMs: last.timestamp, afterId: last.id } : null,
    });
  }

  // -- session plumbing ------------------------------------------------------

  /**
   * A sequence number is only unique WITHIN a channel, and this session is
   * shared: the file-transfer module's BULK channel numbers its chunks from 1
   * exactly as the RELIABLE channel numbers our messages. The session's
   * `delivered` event does not say which channel it came from, so seq 1 of a
   * file chunk is indistinguishable here from seq 1 of a chat message.
   *
   * That makes this handler advisory only. It sets a flag and nothing else, and
   * it deliberately KEEPS the sequence mapping: dropping it on a foreign ack
   * would leave a genuine later failure of our own message unrecognised, and
   * the message stuck in flight forever with no retry and no error.
   */
  private handleTransportAck(seq: number): void {
    const id = this.seqToMessageId.get(String(seq));
    if (id === undefined) return;
    const entry = this.outbox.get(id);
    // The bytes reached the peer's session. That is NOT delivery: the chat
    // protocol on the other side has not said it accepted them yet, and the
    // ladder must not skip a rung on the strength of a transport ack.
    //
    // The id deliberately STAYS in `inFlight`. A transport ack means the peer
    // holds the bytes, so re-sending would put a duplicate on a radio that has
    // seconds to spare; the delivery receipt travels reliably and will arrive.
    // Only an outright failure, or the session ending, makes it eligible again.
    if (entry) this.outbox.set(id, { ...entry, transportAcked: true });
  }

  private handleTransportFailure(seq: number, messageType: number): void {
    // Unlike `delivered`, this event names the message type - which is the only
    // way to tell our seq 3 from the file module's seq 3 on the BULK channel.
    // Without the check, a failed file chunk would mark a perfectly healthy
    // chat message as failed, light up an error in the UI, and put a duplicate
    // of it back on the radio.
    if (messageType !== MessageType.MESSAGE) return;
    const id = this.seqToMessageId.get(String(seq));
    if (id === undefined) return;
    this.seqToMessageId.delete(String(seq));
    this.inFlight.delete(id);
    const entry = this.outbox.get(id);
    if (!entry) return;
    // Stays in the outbox at its current rung: a failed attempt is not a step
    // backwards, it is a reason to try again when a link returns.
    this.outbox.set(id, { ...entry, failed: true });
    this.events.emit('sendFailed', { messageId: id, attempts: entry.attempts });
  }

  private handleStateChange(state: ConnectionState): void {
    if (state === ConnectionState.CONNECTED) {
      this.flush();
      return;
    }
    // The peer cannot still be typing on a link that is gone.
    this.setPeerTyping(false, 0);
    this.localTyping = false;
    this.clearTypingHold();
  }

  private handleSessionClosed(): void {
    // Nothing is on the radio any more, whatever the reliability layer thought.
    // Entries go back to being eligible so a fresh session re-sends them.
    this.inFlight.clear();
    this.seqToMessageId.clear();
    // Receipts are only meaningful inside a session. Holding them for one that
    // has ended is memory kept for a packet that will never be sent.
    this.pendingDelivery.clear();
    this.pendingRead.clear();
    if (this.receiptTimer !== undefined) {
      this.options.clock.clearTimeout(this.receiptTimer);
      this.receiptTimer = undefined;
    }
  }

  // -- helpers ---------------------------------------------------------------

  private advanceStatus(id: string, next: DeliveryStatus): void {
    const entry = this.outbox.get(id);
    const current = this.sentStatus.get(id) ?? entry?.status ?? DeliveryStatus.PENDING;
    const advanced = advanceDeliveryStatus(current, next);
    if (advanced === current) return;
    this.sentStatus.set(id, advanced);
    if (entry) {
      if (advanced >= DeliveryStatus.DELIVERED) {
        // The peer has it. Retrying is now the peer's problem, not the queue's.
        this.outbox.delete(id);
        this.inFlight.delete(id);
      } else {
        this.outbox.set(id, { ...entry, status: advanced });
      }
    }
    this.events.emit('statusChanged', { messageId: id, status: advanced });
  }

  private knowsMessage(id: string): boolean {
    if (this.options.messageExists) return this.options.messageExists(id);
    return this.seenIncoming.has(id) || this.sentStatus.has(id) || this.outbox.has(id);
  }

  /**
   * Signals may be queued inside the session while it reconnects - the
   * reliability layer holds them and retransmits when a link returns.
   */
  private canSignal(): boolean {
    return !this.disposed && this.session.isSecure && !this.session.awaitingUserConfirmation;
  }

  /**
   * Messages, unlike signals, are only handed over on a live link. The outbox -
   * not the session's queue - is the durable one: it survives the session, and
   * the app can persist it.
   */
  private canSendMessages(): boolean {
    return this.canSignal() && this.session.state === ConnectionState.CONNECTED;
  }

  /**
   * Returns the reliable sequence number, or null if the session refused it.
   * `sendReliable` throws for a session that is closed, unauthenticated or
   * awaiting confirmation; all three mean "not now", never "lose this".
   */
  private trySendReliable(type: number, value: CborValue): number | null {
    if (!this.canSignal()) return null;
    try {
      return this.session.sendReliable(type, value);
    } catch (err) {
      this.log.debug('session refused a chat frame', { type, err: String(err) });
      return null;
    }
  }

  /**
   * Refuse one frame. Never throws, never changes any other state: the
   * conversation must be exactly as it was a moment ago, minus one bad packet.
   */
  private drop(reason: string, detail: string): void {
    this.log.debug('dropped a chat frame', { reason, detail });
    this.events.emit('dropped', { reason, detail });
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('ChatProtocol: disposed');
  }

  /** Detach from the session and cancel every timer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.clearTypingHold();
    if (this.peerTypingTimer !== undefined) this.options.clock.clearTimeout(this.peerTypingTimer);
    this.peerTypingTimer = undefined;
    if (this.receiptTimer !== undefined) this.options.clock.clearTimeout(this.receiptTimer);
    this.receiptTimer = undefined;
    this.pendingDelivery.clear();
    this.pendingRead.clear();
    for (const timer of this.pendingHistory.values()) this.options.clock.clearTimeout(timer);
    this.pendingHistory.clear();
    this.events.removeAllListeners();
  }
}
