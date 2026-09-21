/**
 * Reporting actually blocks, and blocking actually sticks.
 *
 * App Store guideline 1.2 wants a way to report offensive content and block
 * the person who sent it. The dangerous version of this feature is the one
 * that looks right and does nothing - a confirmation dialog over a no-op - so
 * these tests assert the effects rather than the alert.
 *
 * The ordering matters and is asserted: if deleting the conversation succeeded
 * while blocking failed, the person would have lost the evidence AND still be
 * reachable, which is the worst of both.
 */
import { brand } from '@airlink/config';
import { AirLinkClient } from '../src/client/AirLinkClient.js';
import { canContactDeveloper, reportAndBlock } from '../src/screens/chat/reportPeer.js';
import { SqliteTrustStore } from '../src/data/sqliteTrustStore.js';

async function bootClient(): Promise<AirLinkClient> {
  const client = new AirLinkClient({ appVersion: '0.1.0', platform: 'ios', deviceModel: 'test' });
  await client.load();
  await client.createProfile('Ada', null);
  return client;
}

/** A peer id is an Ed25519 fingerprint; any stable hex string will do here. */
const THEM = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';


/**
 * A conversation has a foreign key to a peer row, so the peer must exist -
 * which is also how it works in the app: there is no conversation with
 * somebody who was never seen.
 */
function seePeer(client: AirLinkClient): void {
  client.db.peers.upsertSeen({
    peerId: THEM,
    displayName: 'Mallory',
    identityPublic: new Uint8Array(32).fill(7),
    now: 1,
  });
}

afterEach(() => {
  globalThis.__airlinkNativeTest?.clearCalls();
  globalThis.__airlinkSqliteTest?.clear();
  globalThis.__airlinkKeychainTest?.clear();
});

test('reporting blocks the peer', async () => {
  const client = await bootClient();
  expect(client.trustStore.isBlocked(THEM)).toBe(false);

  const outcome = reportAndBlock(client, THEM, null);

  expect(outcome.blocked).toBe(true);
  expect(client.trustStore.isBlocked(THEM)).toBe(true);
});

/**
 * The bug this found. `SqliteTrustStore.block` updated its in-memory map only
 * when the peer was ALREADY a trusted friend, while `isBlocked` read only that
 * map - so blocking a stranger reported success and changed nothing, and the
 * live session was never refused. A stranger is precisely who gets blocked.
 */
test('a stranger can be blocked - not only an existing friend', async () => {
  const client = await bootClient();
  // Deliberately never paired, never trusted, no friend record at all.
  expect(client.trustStore.record(THEM)).toBeUndefined();

  expect(reportAndBlock(client, THEM, null).blocked).toBe(true);

  expect(client.trustStore.isBlocked(THEM)).toBe(true);
  expect(client.trustStore.get(THEM)).toBeUndefined();
});

test('blocking survives a restart, which is what makes it persist', async () => {
  const client = await bootClient();
  seePeer(client);
  reportAndBlock(client, THEM, null);
  expect(client.trustStore.isBlocked(THEM)).toBe(true);

  // A FRESH store over the same table is what the next launch actually does.
  // `reload` is on the concrete class rather than the TrustStore interface, so
  // this reads the persisted state the same way a cold start would.
  const afterRestart = new SqliteTrustStore(client.db.peers);
  expect(afterRestart.isBlocked(THEM)).toBe(true);
  expect(afterRestart.get(THEM)).toBeUndefined();
});

test('unblocking lifts it again, so the block is not a one-way door', async () => {
  const client = await bootClient();
  seePeer(client);
  reportAndBlock(client, THEM, null);
  client.trustStore.unblock(THEM);
  expect(client.trustStore.isBlocked(THEM)).toBe(false);
});

test('a blocked peer stays blocked, which is what makes it protection', async () => {
  const client = await bootClient();
  reportAndBlock(client, THEM, null);
  // The block is what stops them reconnecting, so it must outlive the screen
  // that set it rather than living in component state.
  expect(client.trustStore.isBlocked(THEM)).toBe(true);
  // `get` hands out the identity key used to authenticate them. A blocked peer
  // must not have one, or the session layer would still accept them.
  expect(client.trustStore.get(THEM)).toBeUndefined();
});

test('reporting deletes the conversation from this phone', async () => {
  const client = await bootClient();
  seePeer(client);
  const conversation = client.db.conversations.ensureDirect(THEM, 'c1', 1);
  client.db.messages.insert({
    id: 'm1',
    conversationId: conversation.id,
    senderPeerId: THEM,
    kind: 'text',
    body: 'something upsetting',
    sentAt: 1,
    receivedAt: 1,
    status: 'delivered',
  });
  expect(client.db.messages.list(conversation.id, 10).length).toBeGreaterThan(0);

  const outcome = reportAndBlock(client, THEM, conversation.id);

  expect(outcome.blocked).toBe(true);
  expect(client.db.messages.list(conversation.id, 10)).toHaveLength(0);
});

test('an unauthenticated peer cannot be blocked, and nothing is deleted', async () => {
  const client = await bootClient();
  seePeer(client);
  const conversation = client.db.conversations.ensureDirect(THEM, 'c1', 1);
  client.db.messages.insert({
    id: 'm1',
    conversationId: conversation.id,
    senderPeerId: THEM,
    kind: 'text',
    body: 'keep me',
    sentAt: 1,
    receivedAt: 1,
    status: 'delivered',
  });

  // No peerId means no authenticated identity to attach a block to. Deleting
  // the conversation anyway would destroy the record while leaving the sender
  // free to come back.
  const outcome = reportAndBlock(client, null, conversation.id);

  expect(outcome.blocked).toBe(false);
  expect(outcome.failure).toContain('peerId');
  expect(client.db.messages.list(conversation.id, 10)).toHaveLength(1);
});

test('the developer contact is hidden while the address is a placeholder', () => {
  // Shipping with the placeholder would send somebody who has just been
  // harassed to a mailbox that does not exist. Better to show nothing.
  expect(brand.supportEmail.endsWith('.invalid')).toBe(true);
  expect(canContactDeveloper()).toBe(false);
});
