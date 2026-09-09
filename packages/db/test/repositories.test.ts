import { beforeEach, describe, expect, it } from 'vitest';
import { openNodeDatabase } from '../src/nodeDriver.js';
import { migrate } from '../src/migrations.js';
import { createRepositories, type Repositories } from '../src/repositories.js';

let repos: Repositories;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  const db = openNodeDatabase();
  migrate(db);
  repos = createRepositories(db);
});

function addPeer(peerId: string, name = peerId, key = new Uint8Array(32).fill(1)) {
  repos.peers.upsertSeen({ peerId, displayName: name, identityPublic: key, now: NOW });
  return peerId;
}

describe('UserRepository', () => {
  it('stores and reads the local identity', () => {
    expect(repos.users.get()).toBeNull();
    const key = new Uint8Array(32).fill(7);
    repos.users.create({
      peerId: 'PEER1', displayName: 'Alejandro', avatarEmoji: '🛫', avatarColor: '#123456',
      identityPublic: key, deviceId: 'dev-1', createdAt: NOW, updatedAt: NOW,
    });
    const user = repos.users.get();
    expect(user?.displayName).toBe('Alejandro');
    expect(user?.identityPublic).toEqual(key);
    repos.users.updateProfile('Alex', '✈️', '#abcdef', NOW + 1);
    expect(repos.users.get()?.displayName).toBe('Alex');
  });
});

describe('PeerRepository', () => {
  it('records a peer as known on first sight', () => {
    addPeer('P1', 'Maria');
    const peer = repos.peers.get('P1');
    expect(peer?.trustState).toBe('known');
    expect(repos.peers.trustedKey('P1')).toBeUndefined();
  });

  it('returns the stored key only once the peer is trusted', () => {
    const key = new Uint8Array(32).fill(9);
    addPeer('P1', 'Maria', key);
    repos.peers.setTrust('P1', 'trusted', 'sas', NOW);
    expect(repos.peers.trustedKey('P1')).toEqual(key);
    expect(repos.peers.get('P1')?.verifiedVia).toBe('sas');
  });

  it('never overwrites a stored identity key on a later sighting', () => {
    const original = new Uint8Array(32).fill(1);
    addPeer('P1', 'Maria', original);
    // An attacker presents a different key under the same peer id.
    repos.peers.upsertSeen({ peerId: 'P1', displayName: 'Maria', identityPublic: new Uint8Array(32).fill(2), now: NOW + 1 });
    expect(repos.peers.get('P1')?.identityPublic).toEqual(original);
  });

  it('reports blocked peers', () => {
    addPeer('P1');
    expect(repos.peers.isBlocked('P1')).toBe(false);
    repos.peers.setTrust('P1', 'blocked', 'none', NOW);
    expect(repos.peers.isBlocked('P1')).toBe(true);
    expect(repos.peers.trustedKey('P1')).toBeUndefined();
  });

  it('lists trusted peers most recently seen first', () => {
    addPeer('P1', 'A');
    addPeer('P2', 'B');
    repos.peers.setTrust('P1', 'trusted', 'qr', NOW);
    repos.peers.setTrust('P2', 'trusted', 'qr', NOW);
    repos.peers.upsertSeen({ peerId: 'P2', displayName: 'B', identityPublic: new Uint8Array(32), now: NOW + 5000 });
    expect(repos.peers.listTrusted().map((p) => p.peerId)).toEqual(['P2', 'P1']);
  });
});

describe('ConversationRepository', () => {
  it('creates exactly one direct conversation per peer', () => {
    addPeer('P1');
    const a = repos.conversations.ensureDirect('P1', 'c1', NOW);
    const b = repos.conversations.ensureDirect('P1', 'c-other', NOW);
    expect(b.id).toBe(a.id);
    expect(repos.conversations.list()).toHaveLength(1);
  });

  it('hides archived conversations by default', () => {
    addPeer('P1');
    repos.conversations.ensureDirect('P1', 'c1', NOW);
    repos.conversations.setArchived('c1', true);
    expect(repos.conversations.list()).toHaveLength(0);
    expect(repos.conversations.list(true)).toHaveLength(1);
  });
});

describe('MessageRepository', () => {
  beforeEach(() => {
    addPeer('P1', 'Maria');
    repos.conversations.ensureDirect('P1', 'c1', NOW);
  });

  const insert = (id: string, body: string, sender = 'P1', status: 'pending' | 'sent' | 'delivered' | 'read' = 'sent') =>
    repos.messages.insert({
      id, conversationId: 'c1', senderPeerId: sender, kind: 'text', body,
      sentAt: NOW, receivedAt: NOW, status, incrementUnread: sender !== 'local',
    });

  it('stores messages and orders them newest first', () => {
    insert('m1', 'first');
    insert('m2', 'second');
    insert('m3', 'third');
    expect(repos.messages.list('c1').map((m) => m.body)).toEqual(['third', 'second', 'first']);
  });

  it('is idempotent: the same message received twice yields one row', () => {
    insert('m1', 'hello');
    insert('m1', 'hello');
    expect(repos.messages.list('c1')).toHaveLength(1);
  });

  it('bumps the conversation and its unread count', () => {
    insert('m1', 'hey');
    const c = repos.conversations.get('c1');
    expect(c?.unreadCount).toBe(1);
    expect(c?.lastMessageAt).toBe(NOW);
  });

  it('never walks delivery status backwards', () => {
    insert('m1', 'x', 'local', 'pending');
    repos.messages.setStatus('m1', 'sent');
    repos.messages.setStatus('m1', 'delivered');
    repos.messages.setStatus('m1', 'read');
    // A late 'sent' receipt must not undo the read tick.
    repos.messages.setStatus('m1', 'sent');
    expect(repos.messages.get('m1')?.status).toBe('read');
  });

  it('still allows a message to be marked failed', () => {
    insert('m1', 'x', 'local', 'sent');
    repos.messages.setStatus('m1', 'failed');
    expect(repos.messages.get('m1')?.status).toBe('failed');
  });

  it('marks a conversation read and clears the badge', () => {
    insert('m1', 'a');
    insert('m2', 'b');
    expect(repos.conversations.get('c1')?.unreadCount).toBe(2);
    repos.messages.markConversationRead('c1');
    expect(repos.conversations.get('c1')?.unreadCount).toBe(0);
    expect(repos.messages.list('c1').every((m) => m.status === 'read')).toBe(true);
  });

  it('lists messages queued while offline, oldest first', () => {
    insert('m1', 'queued 1', 'local', 'pending');
    insert('m2', 'sent', 'local', 'sent');
    insert('m3', 'queued 2', 'local', 'pending');
    expect(repos.messages.pendingFor('c1').map((m) => m.body)).toEqual(['queued 1', 'queued 2']);
  });

  it('pages backwards through history', () => {
    for (let i = 0; i < 10; i++) insert(`m${i}`, `msg ${i}`);
    const firstPage = repos.messages.list('c1', 4);
    expect(firstPage.map((m) => m.body)).toEqual(['msg 9', 'msg 8', 'msg 7', 'msg 6']);
    const second = repos.messages.list('c1', 4, firstPage[firstPage.length - 1]?.sortKey);
    expect(second.map((m) => m.body)).toEqual(['msg 5', 'msg 4', 'msg 3', 'msg 2']);
  });

  it('soft-deletes without leaving the body behind', () => {
    insert('m1', 'secret');
    repos.messages.softDelete('m1');
    const m = repos.messages.get('m1');
    expect(m?.deleted).toBe(true);
    expect(m?.body).toBeNull();
  });

  it('stores reactions and de-duplicates them', () => {
    insert('m1', 'x');
    repos.messages.addReaction('m1', 'P1', '😭', NOW);
    repos.messages.addReaction('m1', 'P1', '😭', NOW + 1);
    expect(repos.messages.reactionsFor(['m1'])).toHaveLength(1);
    repos.messages.removeReaction('m1', 'P1', '😭');
    expect(repos.messages.reactionsFor(['m1'])).toHaveLength(0);
  });

  it('clears a conversation completely', () => {
    insert('m1', 'a');
    insert('m2', 'b');
    repos.messages.clearConversation('c1');
    expect(repos.messages.list('c1')).toHaveLength(0);
    expect(repos.conversations.get('c1')?.lastMessageAt).toBeNull();
  });

  it('cascades message deletion when a conversation goes away', () => {
    insert('m1', 'a');
    repos.db.prepare('DELETE FROM conversations WHERE id = ?').run('c1');
    expect(repos.messages.get('m1')).toBeNull();
  });
});

describe('FileRepository and TransferRepository', () => {
  it('finds a file by content hash, which is what powers Sync matching', () => {
    const hash = new Uint8Array(32).fill(3);
    repos.files.insert({
      id: 'f1', name: 'Interstellar.mp4', mimeType: 'video/mp4', sizeBytes: 4_200_000_000,
      contentHash: hash, localPath: '/movies/i.mp4', width: 1920, height: 1080, durationMs: 10_140_000, createdAt: NOW,
    });
    expect(repos.files.findByHash(hash)?.name).toBe('Interstellar.mp4');
    expect(repos.files.findByHash(new Uint8Array(32).fill(4))).toBeNull();
  });

  it('tracks a resumable transfer', () => {
    addPeer('P1');
    repos.files.insert({
      id: 'f1', name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 4_200_000,
      contentHash: new Uint8Array(32), localPath: null, width: null, height: null, durationMs: null, createdAt: NOW,
    });
    repos.transfers.insert({
      id: 't1', fileId: 'f1', peerId: 'P1', conversationId: null, direction: 'incoming', state: 'transferring',
      chunkSize: 4096, totalChunks: 1025, bytesTransferred: 0, startedAt: NOW, completedAt: null, error: null,
      createdAt: NOW, updatedAt: NOW,
    });
    const bitmap = new Uint8Array(129);
    bitmap[0] = 0b1111_1111;
    repos.transfers.update('t1', { bytesTransferred: 32_768, receivedBitmap: bitmap }, NOW + 1000);
    const t = repos.transfers.get('t1');
    expect(t?.bytesTransferred).toBe(32_768);
    expect(t?.receivedBitmap?.[0]).toBe(0b1111_1111);
    expect(repos.transfers.resumable('P1').map((x) => x.id)).toEqual(['t1']);
    repos.transfers.update('t1', { state: 'complete', completedAt: NOW + 2000 }, NOW + 2000);
    expect(repos.transfers.resumable('P1')).toHaveLength(0);
  });
});

describe('GameRepository', () => {
  it('stores a game, its event log and its result', () => {
    addPeer('P1');
    repos.games.create({
      id: 'g1', gameId: 'chess', gameVersion: 1, conversationId: null, hostPeerId: 'P1',
      seed: 12345, players: ['local', 'P1'], state: 'active', createdAt: NOW, updatedAt: NOW,
    });
    repos.games.appendEvent('g1', 0, 'local', 0, new Uint8Array([1, 2]), NOW);
    repos.games.appendEvent('g1', 1, 'P1', 0, new Uint8Array([3, 4]), NOW);
    expect(repos.games.events('g1').map((e) => e.idx)).toEqual([0, 1]);
    expect(repos.games.resumable().map((g) => g.id)).toEqual(['g1']);
    repos.games.finish('g1', 'local', 'checkmate', NOW + 1);
    expect(repos.games.get('g1')?.winnerPeerId).toBe('local');
    expect(repos.games.resumable()).toHaveLength(0);
  });

  it('round-trips the player list', () => {
    addPeer('P1');
    repos.games.create({
      id: 'g1', gameId: 'pong', gameVersion: 1, conversationId: null, hostPeerId: 'P1',
      seed: 1, players: ['local', 'P1', 'P2'], state: 'active', createdAt: NOW, updatedAt: NOW,
    });
    expect(repos.games.get('g1')?.players).toEqual(['local', 'P1', 'P2']);
  });
});

describe('SettingsRepository', () => {
  it('stores strings and JSON', () => {
    repos.settings.set('theme', 'dark', NOW);
    expect(repos.settings.get('theme')).toBe('dark');
    repos.settings.set('theme', 'light', NOW + 1);
    expect(repos.settings.get('theme')).toBe('light');
    repos.settings.setJson('enabledTransports', ['ble', 'localNetwork'], NOW);
    expect(repos.settings.getJson('enabledTransports', [])).toEqual(['ble', 'localNetwork']);
    expect(repos.settings.getJson('missing', 'fallback')).toBe('fallback');
  });

  it('survives corrupt JSON without throwing', () => {
    repos.settings.set('broken', '{not json', NOW);
    expect(repos.settings.getJson('broken', { ok: true })).toEqual({ ok: true });
  });
});

describe('TripRepository', () => {
  it('stores a trip and its members', () => {
    addPeer('P1');
    repos.trips.create({
      id: 'trip1', name: 'Tokyo 2026', emoji: '🗼', startsOn: '2026-04-01', endsOn: '2026-04-14',
      createdAt: NOW, updatedAt: NOW, archived: false,
    });
    repos.trips.addMember('trip1', 'P1', NOW);
    repos.trips.addMember('trip1', 'P1', NOW);
    expect(repos.trips.members('trip1')).toEqual(['P1']);
    expect(repos.trips.list().map((t) => t.name)).toEqual(['Tokyo 2026']);
  });
});
