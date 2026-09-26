/**
 * Typed data access.
 *
 * Every query in the app goes through one of these repositories. Nothing else
 * writes SQL, so the schema has exactly one set of callers and the whole data
 * layer is covered by tests that run against real SQLite.
 */
import type { SqlValue, SqliteDatabase } from './driver.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type TrustState = 'trusted' | 'known' | 'blocked';
export type VerifiedVia = 'qr' | 'sas' | 'none';
export type MessageKind = 'text' | 'image' | 'file' | 'voice' | 'system' | 'game';
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type TransferState =
  | 'offered' | 'accepted' | 'declined' | 'transferring' | 'paused' | 'complete' | 'failed' | 'cancelled';
export type GameSessionState = 'invited' | 'declined' | 'active' | 'finished' | 'abandoned';
export type SyncState = 'pending' | 'ready' | 'playing' | 'paused' | 'ended';

export interface LocalUser {
  id: string;
  peerId: string;
  displayName: string;
  avatarEmoji: string | null;
  avatarColor: string | null;
  identityPublic: Uint8Array;
  deviceId: string;
  createdAt: number;
  updatedAt: number;
}

export interface Peer {
  peerId: string;
  displayName: string;
  avatarEmoji: string | null;
  avatarColor: string | null;
  identityPublic: Uint8Array;
  platform: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  trustState: TrustState;
  verifiedVia: VerifiedVia | null;
  verifiedAt: number | null;
  /** Their advertisement secret, so we can recognise their rotating token. */
  advertisementKey: Uint8Array | null;
  /** Our advertisement secret for this friendship specifically. */
  selfAdvertisementKey: Uint8Array | null;
  pairedAt: number | null;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  peerId: string | null;
  groupId: string | null;
  tripId: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  unreadCount: number;
  archived: boolean;
  muted: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  senderPeerId: string;
  kind: MessageKind;
  body: string | null;
  sentAt: number;
  receivedAt: number;
  sortKey: number;
  status: MessageStatus;
  replyToId: string | null;
  fileId: string | null;
  deleted: boolean;
  outboundSeq: number | null;
}

export interface Reaction {
  messageId: string;
  peerId: string;
  emoji: string;
  createdAt: number;
}

export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: Uint8Array;
  localPath: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: number;
}

export interface Transfer {
  id: string;
  fileId: string;
  peerId: string;
  conversationId: string | null;
  direction: 'outgoing' | 'incoming';
  state: TransferState;
  chunkSize: number;
  totalChunks: number;
  receivedBitmap: Uint8Array | null;
  bytesTransferred: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GameSessionRow {
  id: string;
  gameId: string;
  gameVersion: number;
  conversationId: string | null;
  hostPeerId: string;
  seed: number;
  players: string[];
  state: GameSessionState;
  snapshot: Uint8Array | null;
  winnerPeerId: string | null;
  result: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SyncSessionRow {
  id: string;
  conversationId: string | null;
  hostPeerId: string;
  fileId: string | null;
  contentHash: Uint8Array;
  contentName: string;
  durationMs: number | null;
  state: SyncState;
  positionMs: number;
  playbackRate: number;
  anchorWallMs: number | null;
  participants: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Trip {
  id: string;
  name: string;
  emoji: string | null;
  startsOn: string | null;
  endsOn: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

/**
 * SQLite hands back loosely typed values, and a column may be absent entirely.
 * These narrow every read exactly once, so no repository ever has to guess.
 */
type Cell = SqlValue | ArrayBuffer | undefined;

const bool = (v: Cell): boolean => v === 1 || v === '1';
const num = (v: Cell): number => (typeof v === 'number' ? v : Number(v ?? 0));
const str = (v: Cell): string => (typeof v === 'string' ? v : String(v ?? ''));
const strOrNull = (v: Cell): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: Cell): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Read a BLOB column.
 *
 * Accepts ArrayBuffer as well as Uint8Array: drivers differ - op-sqlite returns
 * the former, node:sqlite the latter. The app's driver normalises at its own
 * boundary, and this tolerates both so a future driver cannot reintroduce a
 * failure that only appears on a device.
 */
function blob(v: Cell): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v === null || v === undefined) return new Uint8Array(0);
  throw new Error('expected a BLOB column');
}

function blobOrNull(v: Cell): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

function parseJsonArray(v: Cell): string[] {
  try {
    const parsed: unknown = JSON.parse(str(v));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export class UserRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(): LocalUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get("local");
    if (!row) return null;
    return {
      id: str(row.id),
      peerId: str(row.peer_id),
      displayName: str(row.display_name),
      avatarEmoji: strOrNull(row.avatar_emoji),
      avatarColor: strOrNull(row.avatar_color),
      identityPublic: blob(row.identity_public),
      deviceId: str(row.device_id),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    };
  }

  create(user: Omit<LocalUser, 'id'>): LocalUser {
    this.db
      .prepare(
        `INSERT INTO users (id, peer_id, display_name, avatar_emoji, avatar_color, identity_public, device_id, created_at, updated_at)
         VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.peerId,
        user.displayName,
        user.avatarEmoji,
        user.avatarColor,
        user.identityPublic,
        user.deviceId,
        user.createdAt,
        user.updatedAt,
      );
    return { ...user, id: 'local' };
  }

  updateProfile(displayName: string, avatarEmoji: string | null, avatarColor: string | null, now: number): void {
    this.db
      .prepare('UPDATE users SET display_name = ?, avatar_emoji = ?, avatar_color = ?, updated_at = ? WHERE id = ?')
      .run(displayName, avatarEmoji, avatarColor, now, 'local');
  }

  /**
   * Point the profile at a different identity key.
   *
   * The two halves of an identity live in different places - the key in the
   * platform keystore, the profile row here - and they can come apart: a
   * restore, a reinstall over an existing database, a keystore that would not
   * open on one launch. When they do, this row keeps a peer id that is no
   * longer ours, and everything that asks "is this message for me?" quietly
   * says no. A game invitation naming our real peer id was discarded in silence
   * because the profile disagreed about who we were.
   */
  adoptIdentity(peerId: string, identityPublic: Uint8Array, deviceId: string, now: number): void {
    this.db
      .prepare('UPDATE users SET peer_id = ?, identity_public = ?, device_id = ?, updated_at = ? WHERE id = ?')
      .run(peerId, identityPublic, deviceId, now, 'local');
  }
}

export class PeerRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private map(row: Record<string, SqlValue>): Peer {
    return {
      peerId: str(row.peer_id),
      displayName: str(row.display_name),
      avatarEmoji: strOrNull(row.avatar_emoji),
      avatarColor: strOrNull(row.avatar_color),
      identityPublic: blob(row.identity_public),
      platform: strOrNull(row.platform),
      firstSeenAt: num(row.first_seen_at),
      lastSeenAt: num(row.last_seen_at),
      trustState: str(row.trust_state) as TrustState,
      verifiedVia: strOrNull(row.verified_via) as VerifiedVia | null,
      verifiedAt: numOrNull(row.verified_at),
      advertisementKey: blobOrNull(row.advertisement_key),
      selfAdvertisementKey: blobOrNull(row.self_advertisement_key),
      pairedAt: numOrNull(row.paired_at),
    };
  }

  /** Store the advertisement secrets exchanged during pairing. */
  setAdvertisementKeys(
    peerId: string,
    theirs: Uint8Array | null,
    ours: Uint8Array | null,
    pairedAt: number,
  ): void {
    this.db
      .prepare('UPDATE peers SET advertisement_key = ?, self_advertisement_key = ?, paired_at = ? WHERE peer_id = ?')
      .run(theirs, ours, pairedAt, peerId);
  }

  get(peerId: string): Peer | null {
    const row = this.db.prepare('SELECT * FROM peers WHERE peer_id = ?').get(peerId);
    return row ? this.map(row) : null;
  }

  /** The identity key we have on file, used to recognise a peer offline. */
  trustedKey(peerId: string): Uint8Array | undefined {
    const row = this.db
      .prepare("SELECT identity_public FROM peers WHERE peer_id = ? AND trust_state = 'trusted'")
      .get(peerId);
    return row ? blob(row.identity_public) : undefined;
  }

  isBlocked(peerId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS x FROM peers WHERE peer_id = ? AND trust_state = 'blocked'").get(peerId);
    return row !== undefined;
  }

  listTrusted(): Peer[] {
    return this.db
      .prepare("SELECT * FROM peers WHERE trust_state = 'trusted' ORDER BY last_seen_at DESC")
      .all()
      .map((r) => this.map(r));
  }

  listAll(): Peer[] {
    return this.db.prepare('SELECT * FROM peers ORDER BY last_seen_at DESC').all().map((r) => this.map(r));
  }

  /**
   * Record a peer we have just seen.
   *
   * The identity key is written only on first insert. A later handshake that
   * presents a DIFFERENT key for the same peer id is rejected upstream by the
   * handshake itself; silently overwriting here would undo that protection.
   */
  upsertSeen(input: {
    peerId: string;
    displayName: string;
    identityPublic: Uint8Array;
    platform?: string | null;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO peers (peer_id, display_name, identity_public, platform, first_seen_at, last_seen_at, trust_state)
         VALUES (?, ?, ?, ?, ?, ?, 'known')
         ON CONFLICT(peer_id) DO UPDATE SET
           display_name = excluded.display_name,
           platform     = COALESCE(excluded.platform, peers.platform),
           last_seen_at = excluded.last_seen_at`,
      )
      .run(input.peerId, input.displayName, input.identityPublic, input.platform ?? null, input.now, input.now);
  }

  setTrust(peerId: string, state: TrustState, via: VerifiedVia, now: number): void {
    this.db
      .prepare('UPDATE peers SET trust_state = ?, verified_via = ?, verified_at = ? WHERE peer_id = ?')
      .run(state, via, state === 'trusted' ? now : null, peerId);
  }

  /** Remove a friend and everything tied to them. */
  remove(peerId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM peers WHERE peer_id = ?').run(peerId);
    });
  }

  setAvatar(peerId: string, emoji: string | null, color: string | null): void {
    this.db.prepare('UPDATE peers SET avatar_emoji = ?, avatar_color = ? WHERE peer_id = ?').run(emoji, color, peerId);
  }
}

export class ConversationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private map(row: Record<string, SqlValue>): Conversation {
    return {
      id: str(row.id),
      kind: str(row.kind) as 'direct' | 'group',
      title: strOrNull(row.title),
      peerId: strOrNull(row.peer_id),
      groupId: strOrNull(row.group_id),
      tripId: strOrNull(row.trip_id),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
      lastMessageAt: numOrNull(row.last_message_at),
      unreadCount: num(row.unread_count),
      archived: bool(row.archived),
      muted: bool(row.muted),
    };
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return row ? this.map(row) : null;
  }

  /** Find or create the single direct conversation with a peer. */
  ensureDirect(peerId: string, id: string, now: number): Conversation {
    const existing = this.db.prepare('SELECT * FROM conversations WHERE peer_id = ?').get(peerId);
    if (existing) return this.map(existing);
    this.db
      .prepare(
        `INSERT INTO conversations (id, kind, peer_id, created_at, updated_at) VALUES (?, 'direct', ?, ?, ?)`,
      )
      .run(id, peerId, now, now);
    return this.map(this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, SqlValue>);
  }

  createGroup(id: string, groupId: string, title: string, now: number): Conversation {
    this.db
      .prepare(
        `INSERT INTO conversations (id, kind, title, group_id, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?)`,
      )
      .run(id, title, groupId, now, now);
    return this.map(this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, SqlValue>);
  }

  list(includeArchived = false): Conversation[] {
    const sql = includeArchived
      ? 'SELECT * FROM conversations ORDER BY last_message_at DESC NULLS LAST, created_at DESC'
      : 'SELECT * FROM conversations WHERE archived = 0 ORDER BY last_message_at DESC NULLS LAST, created_at DESC';
    return this.db.prepare(sql).all().map((r) => this.map(r));
  }

  markRead(id: string): void {
    this.db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(id);
  }

  setArchived(id: string, archived: boolean): void {
    this.db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  }

  setMuted(id: string, muted: boolean): void {
    this.db.prepare('UPDATE conversations SET muted = ? WHERE id = ?').run(muted ? 1 : 0, id);
  }
}

export class MessageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private map(row: Record<string, SqlValue>): Message {
    return {
      id: str(row.id),
      conversationId: str(row.conversation_id),
      senderPeerId: str(row.sender_peer_id),
      kind: str(row.kind) as MessageKind,
      body: strOrNull(row.body),
      sentAt: num(row.sent_at),
      receivedAt: num(row.received_at),
      sortKey: num(row.sort_key),
      status: str(row.status) as MessageStatus,
      replyToId: strOrNull(row.reply_to_id),
      fileId: strOrNull(row.file_id),
      deleted: bool(row.deleted),
      outboundSeq: numOrNull(row.outbound_seq),
    };
  }

  private nextSortKey(conversationId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sort_key), 0) AS k FROM messages WHERE conversation_id = ?')
      .get<{ k: number }>(conversationId);
    return num(row?.k ?? 0) + 1;
  }

  /**
   * Insert a message. Returns the stored row.
   *
   * Idempotent on message id: receiving the same message twice (which the
   * reliability layer can do after a reconnect) leaves exactly one row.
   */
  insert(input: {
    id: string;
    conversationId: string;
    senderPeerId: string;
    kind: MessageKind;
    body?: string | null;
    sentAt: number;
    receivedAt: number;
    status: MessageStatus;
    replyToId?: string | null;
    fileId?: string | null;
    outboundSeq?: number | null;
    incrementUnread?: boolean;
  }): Message {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(input.id);
      if (existing) return this.map(existing);

      const sortKey = this.nextSortKey(input.conversationId);
      this.db
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, sender_peer_id, kind, body, sent_at, received_at, sort_key, status, reply_to_id, file_id, outbound_seq)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.conversationId,
          input.senderPeerId,
          input.kind,
          input.body ?? null,
          input.sentAt,
          input.receivedAt,
          sortKey,
          input.status,
          input.replyToId ?? null,
          input.fileId ?? null,
          input.outboundSeq ?? null,
        );

      this.db
        .prepare(
          `UPDATE conversations
              SET last_message_at = ?, updated_at = ?, unread_count = unread_count + ?
            WHERE id = ?`,
        )
        .run(input.receivedAt, input.receivedAt, input.incrementUnread ? 1 : 0, input.conversationId);

      return this.map(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(input.id) as Record<string, SqlValue>);
    });
  }

  get(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? this.map(row) : null;
  }

  /** Newest-first page of a conversation. */
  list(conversationId: string, limit = 50, beforeSortKey?: number): Message[] {
    const sql = beforeSortKey
      ? 'SELECT * FROM messages WHERE conversation_id = ? AND sort_key < ? ORDER BY sort_key DESC LIMIT ?'
      : 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY sort_key DESC LIMIT ?';
    const params: SqlValue[] = beforeSortKey ? [conversationId, beforeSortKey, limit] : [conversationId, limit];
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => this.map(r));
  }

  /**
   * Advance a message's delivery status.
   *
   * Status only ever moves forward: a late 'sent' receipt arriving after 'read'
   * must not walk the tick marks backwards.
   */
  setStatus(id: string, status: MessageStatus): void {
    const RANK: Record<MessageStatus, number> = { failed: 0, pending: 1, sent: 2, delivered: 3, read: 4 };
    const current = this.db.prepare('SELECT status FROM messages WHERE id = ?').get<{ status: string }>(id);
    if (!current) return;
    const currentStatus = current.status as MessageStatus;
    if (status !== 'failed' && RANK[status] <= RANK[currentStatus]) return;
    this.db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, id);
  }

  /** Mark every inbound message in a conversation as read. */
  markConversationRead(conversationId: string): number {
    const result = this.db
      .prepare(
        `UPDATE messages SET status = 'read'
          WHERE conversation_id = ? AND status IN ('sent','delivered') AND sender_peer_id != 'local'`,
      )
      .run(conversationId);
    this.db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conversationId);
    return result.changes;
  }

  /** Messages queued while offline, oldest first, for retry on reconnect. */
  pendingFor(conversationId: string): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND status = 'pending' ORDER BY sort_key ASC")
      .all(conversationId)
      .map((r) => this.map(r));
  }

  softDelete(id: string): void {
    this.db.prepare('UPDATE messages SET deleted = 1, body = NULL WHERE id = ?').run(id);
  }

  clearConversation(conversationId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
      this.db
        .prepare('UPDATE conversations SET last_message_at = NULL, unread_count = 0 WHERE id = ?')
        .run(conversationId);
    });
  }

  addReaction(messageId: string, peerId: string, emoji: string, now: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO reactions (message_id, peer_id, emoji, created_at) VALUES (?,?,?,?)')
      .run(messageId, peerId, emoji, now);
  }

  removeReaction(messageId: string, peerId: string, emoji: string): void {
    this.db
      .prepare('DELETE FROM reactions WHERE message_id = ? AND peer_id = ? AND emoji = ?')
      .run(messageId, peerId, emoji);
  }

  reactionsFor(messageIds: readonly string[]): Reaction[] {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM reactions WHERE message_id IN (${placeholders})`)
      .all(...(messageIds as SqlValue[]))
      .map((r) => ({
        messageId: str(r.message_id),
        peerId: str(r.peer_id),
        emoji: str(r.emoji),
        createdAt: num(r.created_at),
      }));
  }
}

export class FileRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private map(row: Record<string, SqlValue>): StoredFile {
    return {
      id: str(row.id),
      name: str(row.name),
      mimeType: str(row.mime_type),
      sizeBytes: num(row.size_bytes),
      contentHash: blob(row.content_hash),
      localPath: strOrNull(row.local_path),
      width: numOrNull(row.width),
      height: numOrNull(row.height),
      durationMs: numOrNull(row.duration_ms),
      createdAt: num(row.created_at),
    };
  }

  insert(file: StoredFile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files (id, name, mime_type, size_bytes, content_hash, local_path, width, height, duration_ms, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        file.id,
        file.name,
        file.mimeType,
        file.sizeBytes,
        file.contentHash,
        file.localPath,
        file.width,
        file.height,
        file.durationMs,
        file.createdAt,
      );
  }

  get(id: string): StoredFile | null {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    return row ? this.map(row) : null;
  }

  /** Content matching for Sync: do we already hold this exact file? */
  findByHash(hash: Uint8Array): StoredFile | null {
    const row = this.db.prepare('SELECT * FROM files WHERE content_hash = ? LIMIT 1').get(hash);
    return row ? this.map(row) : null;
  }

  setLocalPath(id: string, path: string): void {
    this.db.prepare('UPDATE files SET local_path = ? WHERE id = ?').run(path, id);
  }

  /**
   * Fill in media metadata that is still missing, and only that.
   *
   * Two writers describe the same file from different directions: the transfer
   * layer knows its name, size and bytes but nothing about what is inside it,
   * and the chat message that announces it knows the duration of a voice note
   * or the dimensions of a photo. They arrive in either order, and `insert` is
   * INSERT OR REPLACE, so whichever wrote second used to erase what the other
   * had learned - which is why a received voice note drew as 0:00 with a bar
   * that never moved.
   *
   * COALESCE keeps the older rule intact: a value already established is never
   * overwritten, a hole is filled.
   */
  fillMedia(id: string, media: { width: number | null; height: number | null; durationMs: number | null }): void {
    this.db
      .prepare(
        `UPDATE files
            SET width = COALESCE(width, ?), height = COALESCE(height, ?), duration_ms = COALESCE(duration_ms, ?)
          WHERE id = ?`,
      )
      .run(media.width, media.height, media.durationMs, id);
  }
}

export class TransferRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private map(row: Record<string, SqlValue>): Transfer {
    return {
      id: str(row.id),
      fileId: str(row.file_id),
      peerId: str(row.peer_id),
      conversationId: strOrNull(row.conversation_id),
      direction: str(row.direction) as 'outgoing' | 'incoming',
      state: str(row.state) as TransferState,
      chunkSize: num(row.chunk_size),
      totalChunks: num(row.total_chunks),
      receivedBitmap: blobOrNull(row.received_bitmap),
      bytesTransferred: num(row.bytes_transferred),
      startedAt: numOrNull(row.started_at),
      completedAt: numOrNull(row.completed_at),
      error: strOrNull(row.error),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    };
  }

  insert(t: Omit<Transfer, 'receivedBitmap'> & { receivedBitmap?: Uint8Array | null }): void {
    this.db
      .prepare(
        `INSERT INTO transfers (id, file_id, peer_id, conversation_id, direction, state, chunk_size, total_chunks,
                                received_bitmap, bytes_transferred, started_at, completed_at, error, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.id, t.fileId, t.peerId, t.conversationId, t.direction, t.state, t.chunkSize, t.totalChunks,
        t.receivedBitmap ?? null, t.bytesTransferred, t.startedAt, t.completedAt, t.error, t.createdAt, t.updatedAt,
      );
  }

  get(id: string): Transfer | null {
    const row = this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
    return row ? this.map(row) : null;
  }

  update(id: string, patch: Partial<Pick<Transfer, 'state' | 'receivedBitmap' | 'bytesTransferred' | 'startedAt' | 'completedAt' | 'error'>>, now: number): void {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const columns: Record<string, string> = {
      state: 'state',
      receivedBitmap: 'received_bitmap',
      bytesTransferred: 'bytes_transferred',
      startedAt: 'started_at',
      completedAt: 'completed_at',
      error: 'error',
    };
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      params.push((patch as Record<string, SqlValue | undefined>)[key] ?? null);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(now, id);
    this.db.prepare(`UPDATE transfers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** Transfers that were interrupted and can be resumed. */
  resumable(peerId: string): Transfer[] {
    return this.db
      .prepare("SELECT * FROM transfers WHERE peer_id = ? AND state IN ('transferring','paused','accepted') ORDER BY updated_at DESC")
      .all(peerId)
      .map((r) => this.map(r));
  }

  active(): Transfer[] {
    return this.db
      .prepare("SELECT * FROM transfers WHERE state IN ('offered','accepted','transferring','paused') ORDER BY updated_at DESC")
      .all()
      .map((r) => this.map(r));
  }
}

export class GameRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private map(row: Record<string, SqlValue>): GameSessionRow {
    return {
      id: str(row.id),
      gameId: str(row.game_id),
      gameVersion: num(row.game_version),
      conversationId: strOrNull(row.conversation_id),
      hostPeerId: str(row.host_peer_id),
      seed: num(row.seed),
      players: parseJsonArray(row.players_json),
      state: str(row.state) as GameSessionState,
      snapshot: blobOrNull(row.snapshot),
      winnerPeerId: strOrNull(row.winner_peer_id),
      result: strOrNull(row.result),
      startedAt: numOrNull(row.started_at),
      finishedAt: numOrNull(row.finished_at),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    };
  }

  create(input: Omit<GameSessionRow, 'snapshot' | 'winnerPeerId' | 'result' | 'startedAt' | 'finishedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO game_sessions (id, game_id, game_version, conversation_id, host_peer_id, seed, players_json, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id, input.gameId, input.gameVersion, input.conversationId, input.hostPeerId, input.seed,
        JSON.stringify(input.players), input.state, input.createdAt, input.updatedAt,
      );
  }

  get(id: string): GameSessionRow | null {
    const row = this.db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(id);
    return row ? this.map(row) : null;
  }

  setState(id: string, state: GameSessionState, now: number): void {
    this.db.prepare('UPDATE game_sessions SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id);
  }

  saveSnapshot(id: string, snapshot: Uint8Array, now: number): void {
    this.db.prepare('UPDATE game_sessions SET snapshot = ?, updated_at = ? WHERE id = ?').run(snapshot, now, id);
  }

  finish(id: string, winnerPeerId: string | null, result: string, now: number): void {
    this.db
      .prepare("UPDATE game_sessions SET state = 'finished', winner_peer_id = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(winnerPeerId, result, now, now, id);
  }

  /**
   * The game ended because somebody left, not because it was played out.
   *
   * The schema has allowed this state since the first migration and nothing
   * ever set it: `finish` hardcodes 'finished'. So a game its opponent walked
   * out of stayed 'active' for ever and kept appearing on the resume shelf,
   * offering to pick up something the other person had already closed.
   */
  abandon(id: string, leftBy: string, now: number): void {
    this.db
      .prepare(
        "UPDATE game_sessions SET state = 'abandoned', result = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(`abandoned by ${leftBy}`, now, now, id);
  }

  appendEvent(gameSessionId: string, idx: number, playerPeerId: string, actionSeq: number, payload: Uint8Array, now: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO game_events (game_session_id, idx, player_peer_id, action_seq, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(gameSessionId, idx, playerPeerId, actionSeq, payload, now);
  }

  events(gameSessionId: string): { idx: number; playerPeerId: string; actionSeq: number; payload: Uint8Array }[] {
    return this.db
      .prepare('SELECT * FROM game_events WHERE game_session_id = ? ORDER BY idx ASC')
      .all(gameSessionId)
      .map((r) => ({
        idx: num(r.idx),
        playerPeerId: str(r.player_peer_id),
        actionSeq: num(r.action_seq),
        payload: blob(r.payload),
      }));
  }

  /** Games that can be picked up where they left off. */
  resumable(): GameSessionRow[] {
    return this.db
      .prepare("SELECT * FROM game_sessions WHERE state = 'active' ORDER BY updated_at DESC")
      .all()
      .map((r) => this.map(r));
  }

  recent(limit = 20): GameSessionRow[] {
    return this.db.prepare('SELECT * FROM game_sessions ORDER BY updated_at DESC LIMIT ?').all(limit).map((r) => this.map(r));
  }
}

export class SyncRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private map(row: Record<string, SqlValue>): SyncSessionRow {
    return {
      id: str(row.id),
      conversationId: strOrNull(row.conversation_id),
      hostPeerId: str(row.host_peer_id),
      fileId: strOrNull(row.file_id),
      contentHash: blob(row.content_hash),
      contentName: str(row.content_name),
      durationMs: numOrNull(row.duration_ms),
      state: str(row.state) as SyncState,
      positionMs: num(row.position_ms),
      playbackRate: num(row.playback_rate),
      anchorWallMs: numOrNull(row.anchor_wall_ms),
      participants: parseJsonArray(row.participants_json),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    };
  }

  create(input: Omit<SyncSessionRow, 'positionMs' | 'playbackRate' | 'anchorWallMs'> & { positionMs?: number }): void {
    this.db
      .prepare(
        `INSERT INTO sync_sessions (id, conversation_id, host_peer_id, file_id, content_hash, content_name, duration_ms,
                                    state, position_ms, playback_rate, participants_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1.0,?,?,?)`,
      )
      .run(
        input.id, input.conversationId, input.hostPeerId, input.fileId, input.contentHash, input.contentName,
        input.durationMs, input.state, input.positionMs ?? 0, JSON.stringify(input.participants),
        input.createdAt, input.updatedAt,
      );
  }

  get(id: string): SyncSessionRow | null {
    const row = this.db.prepare('SELECT * FROM sync_sessions WHERE id = ?').get(id);
    return row ? this.map(row) : null;
  }

  updatePlayback(id: string, state: SyncState, positionMs: number, rate: number, anchorWallMs: number, now: number): void {
    this.db
      .prepare('UPDATE sync_sessions SET state = ?, position_ms = ?, playback_rate = ?, anchor_wall_ms = ?, updated_at = ? WHERE id = ?')
      .run(state, positionMs, rate, anchorWallMs, now, id);
  }

  end(id: string, now: number): void {
    this.db.prepare("UPDATE sync_sessions SET state = 'ended', updated_at = ? WHERE id = ?").run(now, id);
  }
}

export class TripRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private map(row: Record<string, SqlValue>): Trip {
    return {
      id: str(row.id),
      name: str(row.name),
      emoji: strOrNull(row.emoji),
      startsOn: strOrNull(row.starts_on),
      endsOn: strOrNull(row.ends_on),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
      archived: bool(row.archived),
    };
  }

  create(trip: Trip): void {
    this.db
      .prepare('INSERT INTO trips (id, name, emoji, starts_on, ends_on, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,?)')
      .run(trip.id, trip.name, trip.emoji, trip.startsOn, trip.endsOn, trip.createdAt, trip.updatedAt, trip.archived ? 1 : 0);
  }

  get(id: string): Trip | null {
    const row = this.db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
    return row ? this.map(row) : null;
  }

  list(includeArchived = false): Trip[] {
    const sql = includeArchived
      ? 'SELECT * FROM trips ORDER BY updated_at DESC'
      : 'SELECT * FROM trips WHERE archived = 0 ORDER BY updated_at DESC';
    return this.db.prepare(sql).all().map((r) => this.map(r));
  }

  addMember(tripId: string, peerId: string, now: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO trip_members (trip_id, peer_id, joined_at) VALUES (?,?,?)')
      .run(tripId, peerId, now);
  }

  members(tripId: string): string[] {
    return this.db
      .prepare('SELECT peer_id FROM trip_members WHERE trip_id = ? ORDER BY joined_at ASC')
      .all(tripId)
      .map((r) => str(r.peer_id));
  }
}

export class SettingsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? str(row.value) : null;
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: string, now: number): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, now);
  }

  setJson(key: string, value: unknown, now: number): void {
    this.set(key, JSON.stringify(value), now);
  }

  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) out[str(row.key)] = str(row.value);
    return out;
  }
}

/** Everything the app needs, constructed once and passed around. */
export interface Repositories {
  readonly db: SqliteDatabase;
  readonly users: UserRepository;
  readonly peers: PeerRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly files: FileRepository;
  readonly transfers: TransferRepository;
  readonly games: GameRepository;
  readonly sync: SyncRepository;
  readonly trips: TripRepository;
  readonly settings: SettingsRepository;
}

export function createRepositories(db: SqliteDatabase): Repositories {
  return {
    db,
    users: new UserRepository(db),
    peers: new PeerRepository(db),
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    files: new FileRepository(db),
    transfers: new TransferRepository(db),
    games: new GameRepository(db),
    sync: new SyncRepository(db),
    trips: new TripRepository(db),
    settings: new SettingsRepository(db),
  };
}
