import {
  ConnectionState,
  DeliveryStatus,
  newSortableId,
  systemRandom,
  type ChatMessage,
  type OutboxEntry,
  type ReactionSignal,
} from '@airlink/core';
import type { Message, MessageKind, MessageStatus, Reaction } from '@airlink/db';
import type { AirLinkClient, PeerHandle } from '../../client/AirLinkClient.js';

/**
 * The bridge between `ChatProtocol` and SQLite.
 *
 * `ChatProtocol` deliberately persists nothing - it exposes an outbox and a set
 * of events and leaves storage to the app. This is that app half, and it is a
 * plain object rather than a hook for the same reason the zustand store is:
 * messages arrive from radio callbacks and protocol timers, which are nowhere
 * near a React render.
 *
 * Two properties are worth stating, because everything below serves them:
 *
 *  1. **A conversation is usable with nobody in range.** Composing while the
 *     other phone is in a bag writes a row at `pending` and returns. When a
 *     session comes back, every pending row is handed to the protocol in order.
 *     Refusing to let someone type is the one thing this screen may never do.
 *  2. **A tick never goes backwards.** The protocol's ladder only climbs, and
 *     `MessageRepository.setStatus` refuses to move a message down a rung, so a
 *     late delivery receipt cannot undo a read one.
 */

/**
 * Who a message came from, for our own messages.
 *
 * Not this device's real peer id: `MessageRepository.markConversationRead`
 * identifies inbound messages as `sender_peer_id != 'local'`, so storing our
 * own peer id here would mark our own messages read the moment the conversation
 * opened and fake a read receipt we never received.
 */
const LOCAL_SENDER = 'local';

/** Where a peer's undelivered queue is kept between launches. */
const OUTBOX_KEY_PREFIX = 'chat.outbox.';

/**
 * Belt and braces on the typing indicator.
 *
 * The protocol expires it by itself - the TTL travels on the wire precisely so
 * a dropped "stopped typing" cannot leave the dots bouncing - but a session
 * that dies mid-word is our problem, not its, so the UI arms its own timer too.
 */
const TYPING_SAFETY_MS = 8_000;

/** How many messages a page of history is worth. */
export const MESSAGE_PAGE_SIZE = 40;

export interface ConversationSummary {
  readonly conversationId: string;
  readonly peerId: string;
  readonly displayName: string;
  readonly avatarEmoji: string | null;
  /** The newest message that has not been deleted, for the row preview. */
  readonly lastMessage: Message | null;
  readonly lastActivityAt: number;
  readonly unreadCount: number;
}

/** What one conversation screen needs, read in one pass. */
export interface ConversationPage {
  readonly messages: readonly Message[];
  readonly reactions: ReadonlyMap<string, readonly Reaction[]>;
  /** Bodies of the messages being replied to, keyed by the reply's id. */
  readonly replies: ReadonlyMap<string, Message>;
  readonly hasMore: boolean;
}

interface PersistedOutbox {
  readonly entries: readonly OutboxEntry[];
  /** Pairs of [wire id, local row id]. See `aliases` below. */
  readonly aliases: readonly (readonly [string, string])[];
}

interface Attachment {
  readonly peerKey: string;
  readonly handle: PeerHandle;
  /** Known only once the handshake has finished. */
  peerId: string | null;
  /** The persisted queue has been replayed into this protocol instance. */
  restored: boolean;
  lastPersistedSize: number;
  readonly off: (() => void)[];
}

type Listener = () => void;

export class ChatCenter {
  private readonly listeners = new Set<Listener>();
  private version = 0;

  private readonly attachments = new Map<string, Attachment>();
  private readonly clientOff: (() => void)[] = [];

  /**
   * Wire id -> local row id.
   *
   * `ChatProtocol.send` names the message itself, and a message composed with
   * nobody in range has no protocol instance to name it - so it gets a local id
   * and picks up a wire id later. Everything that arrives from the peer
   * (receipts, reactions, replies) speaks the wire id, and everything in SQLite
   * speaks the row id; this is the only place the two meet.
   *
   * It is persisted alongside the outbox, so a queue that survives a restart
   * still lands its receipts on the right bubbles.
   */
  private readonly aliases = new Map<string, string>();
  private readonly wireIds = new Map<string, string>();

  /** Peer ids currently typing, with the timer that will give up on them. */
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly typingPeers = new Set<string>();

  /** The conversation on screen, so its messages are read rather than unread. */
  private activeConversationId: string | null = null;

  constructor(private readonly client: AirLinkClient) {
    this.clientOff.push(
      // Every session change is a chance to notice a protocol instance we are
      // not yet listening to: `AirLinkClient` creates one per peer and has no
      // event of its own for it.
      this.client.events.on('connectionChanged', ({ peerKey }) => {
        this.ensureAttached(peerKey);
        this.publish();
      }),
      this.client.events.on('pairingResolved', ({ peerKey }) => this.ensureAttached(peerKey)),
    );
    // The centre is built by the first screen that asks for it, which may be
    // long after a session came up.
    for (const handle of this.safe(() => this.client.connectedPeers()) ?? []) this.ensureAttached(handle.key);
  }

  // -- subscription ----------------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * A counter rather than a snapshot object.
   *
   * Screens re-read what they need from SQLite when it changes, which keeps one
   * source of truth instead of a cache that can disagree with the database.
   */
  getVersion = (): number => this.version;

  private publish(): void {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }

  // -- reading ---------------------------------------------------------------

  listConversations(): readonly ConversationSummary[] {
    const rows = this.safe(() => this.client.db.conversations.list()) ?? [];
    const summaries: ConversationSummary[] = [];
    for (const row of rows) {
      // Groups are a separate screen and a separate protocol; a direct
      // conversation always names its peer.
      const peerId = row.peerId;
      if (!peerId) continue;
      const peer = this.safe(() => this.client.db.peers.get(peerId));
      const recent = this.safe(() => this.client.db.messages.list(row.id, 5)) ?? [];
      const lastMessage = recent.find((message) => !message.deleted) ?? null;
      summaries.push({
        conversationId: row.id,
        peerId,
        displayName: peer?.displayName ?? row.title ?? '',
        avatarEmoji: peer?.avatarEmoji ?? null,
        lastMessage,
        lastActivityAt: lastMessage?.receivedAt ?? row.lastMessageAt ?? row.createdAt,
        unreadCount: row.unreadCount,
      });
    }
    return summaries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** One page of a conversation, newest first - the order an inverted list wants. */
  readPage(conversationId: string, limit: number): ConversationPage {
    const all = this.safe(() => this.client.db.messages.list(conversationId, limit)) ?? [];
    // A deleted message leaves a row behind so its id stays valid for replies
    // and reactions, but it is gone as far as the conversation is concerned.
    const messages = all.filter((message) => !message.deleted);
    const reactions = new Map<string, Reaction[]>();
    for (const reaction of this.safe(() => this.client.db.messages.reactionsFor(messages.map((m) => m.id))) ?? []) {
      const list = reactions.get(reaction.messageId);
      if (list) list.push(reaction);
      else reactions.set(reaction.messageId, [reaction]);
    }
    const replies = new Map<string, Message>();
    for (const message of messages) {
      const replyToId = message.replyToId;
      if (!replyToId) continue;
      const target = this.safe(() => this.client.db.messages.get(replyToId));
      if (target) replies.set(message.id, target);
    }
    return { messages, reactions, replies, hasMore: all.length >= limit };
  }

  fileFor(fileId: string): { name: string; sizeBytes: number; localPath: string | null } | null {
    const file = this.safe(() => this.client.db.files.get(fileId));
    if (!file) return null;
    return { name: file.name, sizeBytes: file.sizeBytes, localPath: file.localPath };
  }

  /**
   * What this device remembers about someone, whether or not they are in range.
   *
   * This is what lets a conversation open from the chat list with the other
   * phone switched off: the name and the face come from the peer table, not
   * from a radio.
   */
  peerRow(peerId: string): { peerId: string; displayName: string; avatarEmoji: string | null } | null {
    const row = this.safe(() => this.client.db.peers.get(peerId));
    if (!row) return null;
    return { peerId: row.peerId, displayName: row.displayName, avatarEmoji: row.avatarEmoji };
  }

  isPeerTyping(peerId: string | null): boolean {
    return peerId !== null && this.typingPeers.has(peerId);
  }

  /** The live session for a peer, if there is one right now. */
  handleFor(peerId: string): PeerHandle | undefined {
    // The nearby registry keys a recognised friend by their peer id, so this is
    // the common case; an inbound session opened before the handshake is keyed
    // by its endpoint instead, and is found through the attachments.
    const direct = this.safe(() => this.client.peer(peerId));
    if (direct) return direct;
    for (const attachment of this.attachments.values()) {
      if (attachment.peerId === peerId) return attachment.handle;
    }
    return undefined;
  }

  connectionFor(peerId: string): ConnectionState {
    return this.handleFor(peerId)?.session.state ?? ConnectionState.DISCONNECTED;
  }

  // -- conversations ---------------------------------------------------------

  /** The id of the one direct conversation with a peer, creating it if needed. */
  conversationFor(peerId: string, displayName: string): string | null {
    const id = `direct:${peerId}`;
    const existing = this.safe(() => this.client.db.conversations.get(id));
    if (existing) return existing.id;
    // `conversations.peer_id` is a foreign key into `peers`, so a conversation
    // cannot exist for someone this device has never authenticated.
    if (!this.ensurePeerRow(peerId, displayName)) return null;
    const created = this.safe(() => this.client.db.conversations.ensureDirect(peerId, id, Date.now()));
    return created?.id ?? null;
  }

  private ensurePeerRow(peerId: string, displayName: string): boolean {
    const existing = this.safe(() => this.client.db.peers.get(peerId));
    if (existing) return true;
    // The identity key is what makes a peer row; it exists only once a session
    // has authenticated. Without one there is nothing to hang a conversation on.
    const handle = this.handleFor(peerId);
    const identityPublic = handle?.session.identityKey;
    if (!identityPublic) return false;
    return (
      this.safe(() => {
        this.client.db.peers.upsertSeen({
          peerId,
          displayName: handle?.session.capabilities?.displayName ?? displayName,
          identityPublic,
          now: Date.now(),
        });
        return true;
      }) ?? false
    );
  }

  // -- sending ---------------------------------------------------------------

  /**
   * Compose a message.
   *
   * Returns false only when there is nothing to send or no conversation to send
   * it in - never because the peer is out of range, which is the normal state
   * this whole app is built around.
   */
  send(peerId: string, displayName: string, text: string, replyToRowId: string | null): boolean {
    const body = text.trim();
    if (body.length === 0) return false;
    const conversationId = this.conversationFor(peerId, displayName);
    if (!conversationId) return false;

    const now = Date.now();
    const handle = this.handleFor(peerId);
    let id: string | null = null;
    let status: MessageStatus = 'pending';

    if (handle) {
      const entry = this.safe(() =>
        handle.chat.send({
          text: body,
          ...(replyToRowId ? { replyToId: this.wireIdOf(replyToRowId) } : {}),
        }),
      );
      if (entry) {
        // The protocol names the message, so the row and the wire agree and no
        // alias is needed. The status is whatever the flush achieved: SENT if a
        // link took it, PENDING if the session is down.
        id = entry.message.id;
        status = statusName(entry.status);
      }
    }

    if (!id) {
      // Nobody in range - or a protocol that refused. Either way the message is
      // kept, and the queue is drained the next time a session comes up.
      id = newSortableId(systemRandom, now);
      status = 'pending';
    }

    const stored = this.safe(() =>
      this.client.db.messages.insert({
        id: id as string,
        conversationId,
        senderPeerId: LOCAL_SENDER,
        kind: 'text',
        body,
        sentAt: now,
        receivedAt: now,
        status,
        replyToId: replyToRowId,
      }),
    );
    if (!stored) return false;
    this.setTyping(peerId, false);
    this.publish();
    return true;
  }

  /** The retry under a message that could not be sent. */
  retry(peerId: string, rowId: string): void {
    const row = this.safe(() => this.client.db.messages.get(rowId));
    if (!row) return;
    const handle = this.handleFor(peerId);
    if (!handle) {
      // Nothing to retry against yet. Back to the queue, where the next session
      // to come up will pick it up.
      this.safe(() => this.client.db.messages.setStatus(rowId, 'pending'));
      this.publish();
      return;
    }
    // A message the protocol still holds is re-armed rather than re-composed:
    // sending it again under a new id would arrive as a second bubble.
    if (this.safe(() => handle.chat.retry(this.wireIdOf(rowId))) === true) {
      this.safe(() => this.client.db.messages.setStatus(rowId, 'sent'));
    } else {
      this.handToProtocol(handle, row);
    }
    this.publish();
  }

  // -- reactions, deletes, typing, reads --------------------------------------

  /**
   * Add or remove one of our reactions.
   *
   * Returns false when it could not be delivered. Reactions are not queued by
   * the protocol - unlike a message, there is no outbox for them - so the UI
   * disables the control rather than pretending it worked.
   */
  react(peerId: string, rowId: string, emoji: string, add: boolean): boolean {
    const handle = this.handleFor(peerId);
    if (!handle) return false;
    const wireId = this.wireIdOf(rowId);
    const sent = this.safe(() =>
      add ? handle.chat.addReaction(wireId, emoji) : handle.chat.removeReaction(wireId, emoji),
    );
    if (sent !== true) return false;
    this.safe(() =>
      add
        ? this.client.db.messages.addReaction(rowId, LOCAL_SENDER, emoji, Date.now())
        : this.client.db.messages.removeReaction(rowId, LOCAL_SENDER, emoji),
    );
    this.publish();
    return true;
  }

  /** Remove a message from this device. Anything still queued is cancelled. */
  deleteForMe(peerId: string, rowId: string): void {
    const handle = this.handleFor(peerId);
    if (handle) this.safe(() => handle.chat.deleteForMe([this.wireIdOf(rowId)]));
    this.safe(() => this.client.db.messages.softDelete(rowId));
    this.publish();
  }

  setTyping(peerId: string, typing: boolean): void {
    const handle = this.handleFor(peerId);
    if (!handle) return;
    this.safe(() => handle.chat.setTyping(typing));
  }

  /**
   * The conversation is on screen: its messages are read, and stay read as more
   * arrive.
   */
  openConversation(conversationId: string, peerId: string): void {
    this.activeConversationId = conversationId;
    this.markRead(conversationId, peerId);
  }

  closeConversation(conversationId: string): void {
    if (this.activeConversationId === conversationId) this.activeConversationId = null;
  }

  markRead(conversationId: string, peerId: string): void {
    this.safe(() => this.client.db.messages.markConversationRead(conversationId));
    this.safe(() => this.client.db.conversations.markRead(conversationId));
    const handle = this.handleFor(peerId);
    if (handle) {
      // Tell them, in wire ids, about everything of theirs we hold. `markRead`
      // skips ids it has already acknowledged, so this is cheap to repeat.
      const inbound = (this.safe(() => this.client.db.messages.list(conversationId, MESSAGE_PAGE_SIZE)) ?? [])
        .filter((message) => message.senderPeerId !== LOCAL_SENDER)
        .map((message) => this.wireIdOf(message.id));
      if (inbound.length > 0) this.safe(() => handle.chat.markRead(inbound));
    }
    this.publish();
  }

  // -- wiring ----------------------------------------------------------------

  private ensureAttached(peerKey: string): void {
    const handle = this.safe(() => this.client.peer(peerKey));
    if (!handle) {
      this.detach(peerKey);
      return;
    }
    const attachment = this.attachments.get(peerKey) ?? this.attach(handle);
    // The peer id arrives with the handshake, not with the session, so the
    // parts that need one - the conversation row, the persisted queue - happen
    // on whichever later state change brings it.
    const peerId = handle.session.peerId;
    if (peerId && attachment.peerId === null) {
      attachment.peerId = peerId;
      this.onIdentified(attachment);
    }
  }

  private attach(handle: PeerHandle): Attachment {
    const attachment: Attachment = {
      peerKey: handle.key,
      handle,
      peerId: handle.session.peerId,
      restored: false,
      lastPersistedSize: 0,
      off: [],
    };
    this.attachments.set(handle.key, attachment);

    const { chat } = handle;
    attachment.off.push(
      chat.events.on('message', ({ message, receivedAt }) => this.onIncoming(attachment, message, receivedAt)),
      chat.events.on('statusChanged', ({ messageId, status }) => {
        const rowId = this.aliases.get(messageId) ?? messageId;
        this.safe(() => this.client.db.messages.setStatus(rowId, statusName(status)));
        this.persistOutbox(attachment);
        this.publish();
      }),
      chat.events.on('queued', () => this.persistOutbox(attachment)),
      chat.events.on('sendFailed', ({ messageId }) => {
        const rowId = this.aliases.get(messageId) ?? messageId;
        this.safe(() => this.client.db.messages.setStatus(rowId, 'failed'));
        this.persistOutbox(attachment);
        this.publish();
      }),
      chat.events.on('typing', ({ typing }) => this.onTyping(attachment, typing)),
      chat.events.on('reaction', ({ signal }) => this.onReaction(attachment, signal)),
      chat.events.on('deleteRequested', ({ ids }) => this.onDeleteRequested(attachment, ids)),
      handle.session.events.on('closed', () => {
        this.onTyping(attachment, false);
        this.detach(handle.key);
        this.publish();
      }),
    );

    if (attachment.peerId) this.onIdentified(attachment);
    return attachment;
  }

  private detach(peerKey: string): void {
    const attachment = this.attachments.get(peerKey);
    if (!attachment) return;
    for (const off of attachment.off) off();
    attachment.off.length = 0;
    this.attachments.delete(peerKey);
  }

  /**
   * The handshake finished, so this peer now has a name, a conversation and
   * possibly a queue left over from last time.
   */
  private onIdentified(attachment: Attachment): void {
    const peerId = attachment.peerId;
    if (!peerId) return;
    const displayName = attachment.handle.session.capabilities?.displayName ?? '';
    const conversationId = this.conversationFor(peerId, displayName);
    if (!conversationId) return;

    if (!attachment.restored) {
      attachment.restored = true;
      this.restoreOutbox(attachment, peerId);
    }
    this.flushPending(attachment, conversationId);
    this.publish();
  }

  /**
   * Replay the queue this peer's protocol held when the app last stopped.
   *
   * Without it, a message handed to the reliability layer moments before the
   * process died would sit on one tick forever: the bytes may never have
   * arrived, and re-composing it would arrive as a duplicate. Restored entries
   * keep their original ids, so the peer recognises anything it already has.
   */
  private restoreOutbox(attachment: Attachment, peerId: string): void {
    const stored = this.safe(() =>
      this.client.db.settings.getJson<PersistedOutbox | null>(`${OUTBOX_KEY_PREFIX}${peerId}`, null),
    );
    if (!stored || !Array.isArray(stored.entries) || stored.entries.length === 0) return;
    for (const pair of stored.aliases ?? []) {
      const [wireId, rowId] = pair;
      if (typeof wireId !== 'string' || typeof rowId !== 'string') continue;
      this.aliases.set(wireId, rowId);
      this.wireIds.set(rowId, wireId);
    }
    // `restoreOutbox` validates every entry and skips what it cannot encode, so
    // a damaged store costs one message rather than the conversation.
    this.safe(() => attachment.handle.chat.restoreOutbox(stored.entries));
  }

  private persistOutbox(attachment: Attachment): void {
    const peerId = attachment.peerId;
    if (!peerId) return;
    const entries = this.safe(() => attachment.handle.chat.outboxSnapshot()) ?? [];
    // Nothing queued and nothing was queued last time: no write.
    if (entries.length === 0 && attachment.lastPersistedSize === 0) return;
    attachment.lastPersistedSize = entries.length;
    const wireIds = new Set(entries.map((entry) => entry.message.id));
    const aliases = [...this.aliases].filter(([wireId]) => wireIds.has(wireId));
    this.safe(() =>
      this.client.db.settings.setJson(`${OUTBOX_KEY_PREFIX}${peerId}`, { entries, aliases }, Date.now()),
    );
  }

  /** Hand every message composed with nobody in range to a live protocol. */
  private flushPending(attachment: Attachment, conversationId: string): void {
    const covered = new Set(
      (this.safe(() => attachment.handle.chat.outboxSnapshot()) ?? []).map(
        (entry) => this.aliases.get(entry.message.id) ?? entry.message.id,
      ),
    );
    for (const row of this.safe(() => this.client.db.messages.pendingFor(conversationId)) ?? []) {
      if (row.senderPeerId !== LOCAL_SENDER || row.deleted) continue;
      if (covered.has(row.id)) continue;
      this.handToProtocol(attachment.handle, row);
    }
  }

  private handToProtocol(handle: PeerHandle, row: Message): void {
    const body = row.body ?? '';
    // A row with no text is an attachment the file module owns; there is
    // nothing for the chat protocol to carry.
    if (body.trim().length === 0) return;
    const replyToWireId = row.replyToId ? this.wireIdOf(row.replyToId) : null;
    const entry = this.safe(() =>
      handle.chat.send({ text: body, ...(replyToWireId ? { replyToId: replyToWireId } : {}) }),
    );
    if (!entry) return;
    if (entry.message.id !== row.id) {
      this.aliases.set(entry.message.id, row.id);
      this.wireIds.set(row.id, entry.message.id);
    }
    this.safe(() => this.client.db.messages.setStatus(row.id, statusName(entry.status)));
  }

  // -- inbound ---------------------------------------------------------------

  private onIncoming(attachment: Attachment, message: ChatMessage, receivedAt: number): void {
    const peerId = attachment.peerId ?? attachment.handle.session.peerId;
    if (!peerId) return;
    const displayName = attachment.handle.session.capabilities?.displayName ?? '';
    const conversationId = this.conversationFor(peerId, displayName);
    if (!conversationId) return;

    const attached = message.attachments[0] ?? null;
    if (attached) {
      // Enough for a file row to draw itself while the bytes are still moving.
      // Never overwrites: the transfer module owns a file it already knows.
      const known = this.safe(() => this.client.db.files.get(attached.fileId));
      if (!known) {
        this.safe(() =>
          this.client.db.files.insert({
            id: attached.fileId,
            name: attached.name,
            mimeType: attached.mimeType,
            sizeBytes: attached.byteLength,
            contentHash: new Uint8Array(0),
            localPath: null,
            width: attached.width ?? null,
            height: attached.height ?? null,
            durationMs: attached.durationMs ?? null,
            createdAt: receivedAt,
          }),
        );
      }
    }

    // A reply names its target in wire ids, and the target may be one of ours
    // that was composed offline. It may also be a message we never had, in
    // which case the link is simply dropped - the row is a foreign key.
    const replyRowId = message.replyToId ? this.aliases.get(message.replyToId) ?? message.replyToId : null;
    const replyExists = replyRowId ? this.safe(() => this.client.db.messages.get(replyRowId)) : null;

    const isActive = this.activeConversationId === conversationId;
    const kind: MessageKind = attached ? (attached.mimeType.startsWith('image/') ? 'image' : 'file') : 'text';

    this.safe(() =>
      this.client.db.messages.insert({
        id: message.id,
        conversationId,
        senderPeerId: peerId,
        kind,
        body: message.text.length > 0 ? message.text : null,
        // The sender's clock is advisory. `receivedAt` is ours, and it is what
        // the conversation is ordered and dated by.
        sentAt: message.timestamp,
        receivedAt,
        status: 'delivered',
        replyToId: replyExists ? replyRowId : null,
        fileId: attached?.fileId ?? null,
        incrementUnread: !isActive,
      }),
    );

    if (isActive) this.markRead(conversationId, peerId);
    this.publish();
  }

  private onTyping(attachment: Attachment, typing: boolean): void {
    const peerId = attachment.peerId;
    if (!peerId) return;
    const existing = this.typingTimers.get(peerId);
    if (existing) {
      clearTimeout(existing);
      this.typingTimers.delete(peerId);
    }
    if (typing) {
      this.typingPeers.add(peerId);
      this.typingTimers.set(
        peerId,
        setTimeout(() => {
          this.typingTimers.delete(peerId);
          this.typingPeers.delete(peerId);
          this.publish();
        }, TYPING_SAFETY_MS),
      );
    } else {
      this.typingPeers.delete(peerId);
    }
    this.publish();
  }

  private onReaction(attachment: Attachment, signal: ReactionSignal): void {
    const peerId = attachment.peerId;
    if (!peerId) return;
    const rowId = this.aliases.get(signal.messageId) ?? signal.messageId;
    if (!this.safe(() => this.client.db.messages.get(rowId))) return;
    this.safe(() =>
      signal.removed
        ? this.client.db.messages.removeReaction(rowId, peerId, signal.emoji)
        : this.client.db.messages.addReaction(rowId, peerId, signal.emoji, signal.at),
    );
    this.publish();
  }

  /**
   * The peer asked us to forget messages.
   *
   * Honoured only for messages they sent. A delete request naming one of ours
   * would let the other phone erase what this one said, which is not a power a
   * peer gets over this device.
   */
  private onDeleteRequested(attachment: Attachment, ids: readonly string[]): void {
    const peerId = attachment.peerId;
    if (!peerId) return;
    let changed = false;
    for (const id of ids) {
      const rowId = this.aliases.get(id) ?? id;
      const row = this.safe(() => this.client.db.messages.get(rowId));
      if (!row || row.senderPeerId !== peerId) continue;
      this.safe(() => this.client.db.messages.softDelete(rowId));
      changed = true;
    }
    if (changed) this.publish();
  }

  // -- helpers ---------------------------------------------------------------

  /** The id the peer knows a message by. Identical to the row id unless it was composed offline. */
  private wireIdOf(rowId: string): string {
    return this.wireIds.get(rowId) ?? rowId;
  }

  /**
   * Run a database or protocol call, and swallow what it throws.
   *
   * A conversation that cannot write one row must not take the screen down
   * with it - the user is on a plane, and a crash here would look like the app
   * losing their messages.
   */
  private safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    for (const off of this.clientOff) off();
    this.clientOff.length = 0;
    for (const peerKey of [...this.attachments.keys()]) this.detach(peerKey);
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
    this.typingPeers.clear();
    this.listeners.clear();
  }
}

/** The protocol's ladder, in the words the database stores. */
function statusName(status: DeliveryStatus): MessageStatus {
  switch (status) {
    case DeliveryStatus.READ:
      return 'read';
    case DeliveryStatus.DELIVERED:
      return 'delivered';
    case DeliveryStatus.SENT:
      return 'sent';
    default:
      return 'pending';
  }
}

export function isOutgoing(message: Message): boolean {
  return message.senderPeerId === LOCAL_SENDER;
}

/** Our own reactions, told apart from theirs without knowing our peer id. */
export function isOwnReaction(reaction: Reaction): boolean {
  return reaction.peerId === LOCAL_SENDER;
}

/**
 * One centre per client, for the life of the app.
 *
 * A `WeakMap` rather than a module-level singleton so a test - or a future
 * second identity - gets its own, and so nothing keeps a dead client alive.
 */
const centres = new WeakMap<AirLinkClient, ChatCenter>();

export function chatCenterFor(client: AirLinkClient): ChatCenter {
  const existing = centres.get(client);
  if (existing) return existing;
  const created = new ChatCenter(client);
  centres.set(client, created);
  return created;
}
