/**
 * The unread mark, end to end: database → badge → notification.
 *
 * The behaviour under test is the one the user asked for in a sentence: a
 * message they have not read, or a game they have been invited to, has to show
 * up on the tab bar, and - if they allowed it - on the phone itself.
 *
 * Three things here are deliberate and worth stating, because each of them is a
 * way this feature could go wrong quietly:
 *
 *  1. The count comes from SQLite, never from a counter of its own. So these
 *     tests write real rows through the real repositories and let the centre
 *     read them back, rather than poking a number into the store.
 *  2. A notification must NOT be raised for the conversation on screen. That is
 *     asserted directly, and next to a case that DOES notify, so the assertion
 *     cannot pass by everything being silent.
 *  3. There are no native modules under Jest. Everything must still work, with
 *     badges on the tabs and nothing thrown - which is also the state of a
 *     phone whose owner said no to notifications, and of any older build.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import App from '../App';
import { AirLinkClient } from '../src/client/AirLinkClient.js';
import { notificationCentreFor } from '../src/client/notificationCentre.js';
import { chatCenterFor } from '../src/screens/chat/chatCenter.js';
import { AppPhase, useAppStore } from '../src/state/index.js';
import { local } from '../src/screens/you/localStrings.js';

/** The friend on the other end of every conversation below. */
const GRACE = 'PEERGRACE';
const GRACE_NAME = 'Grace';
/** A second person, so "one conversation unread" cannot mean "all of them". */
const ALAN = 'PEERALAN';
const ALAN_NAME = 'Alan';

async function freshClient(): Promise<AirLinkClient> {
  const client = new AirLinkClient({ appVersion: '0.1.0', platform: 'ios', deviceModel: 'test' });
  await client.load();
  if (!client.profile) await client.createProfile('Ada', null);
  return client;
}

/**
 * A conversation with one unread message in it, written the way the app writes
 * one.
 *
 * `incrementUnread` is the flag `ChatCenter.onIncoming` sets for a message that
 * arrives while its conversation is NOT on screen, so passing it here is the
 * same path a real message takes.
 */
function seedConversation(
  client: AirLinkClient,
  options: { peerId: string; displayName: string; conversationId: string; messageId: string; unread: boolean },
): string {
  const now = Date.now();
  client.db.peers.upsertSeen({
    peerId: options.peerId,
    displayName: options.displayName,
    identityPublic: new Uint8Array(32),
    now,
  });
  const conversation = client.db.conversations.ensureDirect(options.peerId, options.conversationId, now);
  client.db.messages.insert({
    id: options.messageId,
    conversationId: conversation.id,
    senderPeerId: options.peerId,
    kind: 'text',
    body: 'Are you there?',
    sentAt: now,
    receivedAt: now,
    status: 'delivered',
    incrementUnread: options.unread,
  });
  return conversation.id;
}

afterEach(() => {
  useAppStore.getState().reset();
  globalThis.__airlinkNativeTest?.clearCalls();
  globalThis.__airlinkSqliteTest?.clear();
  globalThis.__airlinkKeychainTest?.clear();
});

test('an unread message counts, and reading the conversation stops it counting', async () => {
  const client = await freshClient();
  const centre = notificationCentreFor(client);

  const conversationId = seedConversation(client, {
    peerId: GRACE,
    displayName: GRACE_NAME,
    conversationId: 'conv-grace',
    messageId: 'msg-1',
    unread: true,
  });
  centre.refresh();

  expect(useAppStore.getState().unreadChats).toBe(1);

  // Opening the conversation is what marks it read, and it goes through the
  // chat centre rather than straight to SQLite so that the read receipt the
  // other phone is waiting for is sent too.
  chatCenterFor(client).openConversation(conversationId, GRACE);

  expect(client.db.conversations.get(conversationId)?.unreadCount).toBe(0);
  expect(useAppStore.getState().unreadChats).toBe(0);
});

test('two people waiting are two, and one of them reading is one', async () => {
  const client = await freshClient();
  const centre = notificationCentreFor(client);

  seedConversation(client, {
    peerId: GRACE,
    displayName: GRACE_NAME,
    conversationId: 'conv-grace',
    messageId: 'msg-1',
    unread: true,
  });
  const alanConversation = seedConversation(client, {
    peerId: ALAN,
    displayName: ALAN_NAME,
    conversationId: 'conv-alan',
    messageId: 'msg-2',
    unread: true,
  });
  centre.refresh();
  expect(useAppStore.getState().unreadChats).toBe(2);

  chatCenterFor(client).openConversation(alanConversation, ALAN);
  expect(useAppStore.getState().unreadChats).toBe(1);
});

test('the conversation on screen is not announced, and another one still is', async () => {
  const client = await freshClient();
  const centre = notificationCentreFor(client);

  const graceConversation = seedConversation(client, {
    peerId: GRACE,
    displayName: GRACE_NAME,
    conversationId: 'conv-grace',
    messageId: 'msg-1',
    unread: false,
  });
  seedConversation(client, {
    peerId: ALAN,
    displayName: ALAN_NAME,
    conversationId: 'conv-alan',
    messageId: 'msg-2',
    unread: false,
  });
  // A first reading, so that what follows counts as news rather than as history
  // that was already on the phone when the app started.
  centre.refresh();
  expect(centre.announcements()).toHaveLength(0);

  // Grace's conversation is the one being looked at.
  centre.setActiveConversation(GRACE);

  client.db.messages.insert({
    id: 'msg-3',
    conversationId: graceConversation,
    senderPeerId: GRACE,
    kind: 'text',
    body: 'Still here?',
    sentAt: Date.now(),
    receivedAt: Date.now(),
    status: 'delivered',
    // Forced on, although the real path would not increment it for a
    // conversation on screen. The point is to prove the centre's OWN guard,
    // rather than relying on the chat centre to make this case impossible.
    incrementUnread: true,
  });
  centre.refresh();

  expect(centre.announcements()).toHaveLength(0);

  // The same event in a conversation that is NOT on screen does announce, so
  // the assertion above cannot be passing because nothing ever announces.
  client.db.messages.insert({
    id: 'msg-4',
    conversationId: 'conv-alan',
    senderPeerId: ALAN,
    kind: 'text',
    body: 'Your move.',
    sentAt: Date.now(),
    receivedAt: Date.now(),
    status: 'delivered',
    incrementUnread: true,
  });
  centre.refresh();

  const announcements = centre.announcements();
  expect(announcements).toHaveLength(1);
  expect(announcements[0]?.threadId).toBe('conv-alan');
  expect(announcements[0]?.title).toBe(ALAN_NAME);
  expect(announcements[0]?.body).toBe('Your move.');
});

test('our own messages never announce themselves', async () => {
  const client = await freshClient();
  const centre = notificationCentreFor(client);
  const conversationId = seedConversation(client, {
    peerId: GRACE,
    displayName: GRACE_NAME,
    conversationId: 'conv-grace',
    messageId: 'msg-1',
    unread: false,
  });
  centre.refresh();

  // 'local' is how `ChatCenter` files our own messages; `insert` never raises
  // the unread count for one, and this asserts that the badge agrees.
  client.db.messages.insert({
    id: 'msg-mine',
    conversationId,
    senderPeerId: 'local',
    kind: 'text',
    body: 'On my way.',
    sentAt: Date.now(),
    receivedAt: Date.now(),
    status: 'sent',
  });
  centre.refresh();

  expect(centre.announcements()).toHaveLength(0);
  expect(useAppStore.getState().unreadChats).toBe(0);
});

test('with no native module at all, nothing throws and the badges still work', async () => {
  const client = await freshClient();
  const centre = notificationCentreFor(client);

  // Jest has no native side, which is also the state of an older build and of
  // a phone whose owner has never been asked. Asking for permission in that
  // state has to answer honestly rather than throw, and the answer can never
  // be yes - nothing can grant a permission that has nowhere to come from.
  await expect(centre.refreshPermission()).resolves.not.toBe('granted');
  await expect(centre.requestPermission()).resolves.not.toBe('granted');

  seedConversation(client, {
    peerId: GRACE,
    displayName: GRACE_NAME,
    conversationId: 'conv-grace',
    messageId: 'msg-1',
    unread: false,
  });
  centre.refresh();
  client.db.messages.insert({
    id: 'msg-2',
    conversationId: 'conv-grace',
    senderPeerId: GRACE,
    kind: 'text',
    body: 'Knock knock.',
    sentAt: Date.now(),
    receivedAt: Date.now(),
    status: 'delivered',
    incrementUnread: true,
  });

  expect(() => centre.refresh()).not.toThrow();
  expect(() => centre.setActiveConversation(GRACE)).not.toThrow();
  expect(() => centre.setActiveConversation(null)).not.toThrow();
  expect(() => centre.onOpened(() => undefined)()).not.toThrow();

  // The decision was still made and recorded - it simply could not be shown.
  const announced = centre.announcements().find((entry) => entry.threadId === 'conv-grace');
  expect(announced?.presented).toBe(false);
  // And the part that does not need a phone still works: the badge is there
  // even though nothing could be shown on the lock screen.
  expect(useAppStore.getState().unreadChats).toBe(1);
});

test('a photo with no words still says something worth reading', async () => {
  const client = await freshClient();
  const centre = notificationCentreFor(client);
  seedConversation(client, {
    peerId: GRACE,
    displayName: GRACE_NAME,
    conversationId: 'conv-grace',
    messageId: 'msg-1',
    unread: false,
  });
  centre.refresh();

  client.db.messages.insert({
    id: 'msg-photo',
    conversationId: 'conv-grace',
    senderPeerId: GRACE,
    kind: 'image',
    body: null,
    sentAt: Date.now(),
    receivedAt: Date.now(),
    status: 'delivered',
    incrementUnread: true,
  });
  centre.refresh();

  expect(centre.announcements()[0]?.body).toBe(local.notify.photo);
});

test('an unread message reaches the tab bar, where a screen reader can find it', async () => {
  // Seeded BEFORE the app starts, so this is the phone being opened with
  // something already waiting on it - the case that has to badge without
  // buzzing about messages from yesterday.
  const seeder = await freshClient();
  seedConversation(seeder, {
    peerId: GRACE,
    displayName: GRACE_NAME,
    conversationId: 'conv-grace',
    messageId: 'msg-1',
    unread: true,
  });

  await render(<App />);
  await waitFor(() => expect(useAppStore.getState().phase).toBe(AppPhase.READY));
  await act(async () => undefined);

  await waitFor(() => expect(useAppStore.getState().unreadChats).toBe(1));

  // The number on the icon, and the sentence that stands in for it when the
  // icon cannot be seen.
  expect(screen.getByLabelText(new RegExp(local.notify.badgeChats(1), 'i'))).toBeTruthy();
}, 30000);

test('a game invitation badges the Play tab', async () => {
  const seeder = await freshClient();
  expect(seeder.profile).not.toBeNull();

  await render(<App />);
  await waitFor(() => expect(useAppStore.getState().phase).toBe(AppPhase.READY));
  await act(async () => undefined);

  // Written straight into the store rather than driven through a real
  // invitation: the wire half of that is covered end to end in
  // invites.test.tsx, and what is under test here is that the navigator draws
  // what the centre tells it.
  await act(async () => {
    useAppStore.getState().setWaiting({ unreadChats: 0, pendingInvites: 2 });
  });

  expect(screen.getByLabelText(new RegExp(local.notify.badgeInvites(2), 'i'))).toBeTruthy();
  // And nothing claims the Chat tab has anything waiting on it.
  expect(screen.queryByLabelText(new RegExp(local.notify.badgeChats(1), 'i'))).toBeNull();
}, 30000);
