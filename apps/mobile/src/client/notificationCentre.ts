import { useEffect } from 'react';
import { chatCenterFor, isOutgoing, type ChatCenter, type ConversationSummary } from '../screens/chat/chatCenter.js';
import { inviteCentreFor, type GameInviteCentre } from '../screens/play/inviteCentre.js';
import { notifications, type NotificationPermission } from '../native/notifications.js';
import { useAppStore } from '../state/index.js';
import type { AirLinkClient } from './AirLinkClient.js';
import { local } from '../screens/you/localStrings.js';
import { useOptionalClient } from '../screens/play/useOptionalClient.js';

/**
 * What raises a notification, and what puts a badge on a tab.
 *
 * Built in the shape of `chatCenter` and `inviteCentre` next to it: a plain
 * object with a `WeakMap` per client, because the things that produce the state
 * it watches - a radio callback delivering a message, a protocol timer expiring
 * an invitation - happen nowhere near a React render.
 *
 * ONE RULE ABOVE ALL THE OTHERS. A notification is a courtesy; a message is the
 * product. Nothing in here may throw, block, or otherwise sit between an
 * arriving message and SQLite. Every call into the native layer is wrapped, and
 * a native module that is missing entirely - an older build, or Jest, which has
 * no native modules at all - simply means no notifications and a tab bar that
 * still works.
 *
 * WHY IT DERIVES RATHER THAN LISTENS. It would be easy to hang this off the
 * chat protocol's `message` event and count as they arrive. It would also be
 * wrong: the conversations table has counted unread messages since the first
 * migration, and a second counter fed by events drifts the moment one is
 * missed, replayed after a reconnect, or marked read from another screen. So
 * this watches the chat centre's version counter, re-reads the numbers SQLite
 * already holds, and notifies on what CHANGED. The badge cannot disagree with
 * the conversation list, because it is the conversation list.
 */

/** A notification this centre decided to raise. */
export interface Announcement {
  readonly kind: 'message' | 'invite';
  /** Groups notifications on the phone, and is what an opened one names. */
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
  readonly at: number;
  /**
   * False when the decision was made but nothing was shown - permission was
   * never granted, or there is no native module here to show it.
   *
   * The decision is recorded either way, because "should this have notified?"
   * and "did the phone allow it?" are two different questions and only the
   * first one is this file's to answer.
   */
  readonly presented: boolean;
}

/** Where a tapped notification should take the user. */
export interface ChatThreadTarget {
  readonly peerKey: string;
  readonly title: string;
}

/** The prefix that tells an invitation's thread from a conversation's. */
const INVITE_THREAD = 'invite:';

/**
 * How many decisions are remembered.
 *
 * Enough for Developer Mode to show what happened during a session and for a
 * test to assert on it, bounded so a long flight cannot grow it without limit.
 */
const ANNOUNCEMENT_MEMORY = 32;

export class NotificationCentre {
  private readonly chat: ChatCenter;
  private readonly invites: GameInviteCentre;
  private readonly offs: (() => void)[] = [];

  /**
   * conversationId -> the unread count last time we looked.
   *
   * The whole basis of "what is new": a conversation whose count went UP since
   * the last pass has had something arrive in it, and one that is not in this
   * map at all has never been looked at, so whatever is in it is history.
   */
  private readonly marks = new Map<string, number>();
  /** Invitations already announced, so a repeat does not buzz twice. */
  private readonly announcedInvites = new Set<string>();
  private readonly recent: Announcement[] = [];

  /**
   * The conversation on screen, told to us by the navigator.
   *
   * `ChatCenter` knows this too, and keeps it private - reasonably, since it
   * uses it for something else. Asking the navigator is better than reaching
   * into it anyway: this has to be right the instant the screen appears, and
   * the navigator is the thing that knows.
   */
  private activeConversationId: string | null = null;

  /**
   * The last permission the system reported.
   *
   * Cached because it is read on every arriving message and the native call is
   * asynchronous; refreshed when the app asks for permission and whenever the
   * Settings row looks at it. Starting at `notAsked` means the first few
   * messages after launch raise nothing until the real answer arrives, which is
   * the safe way round: a silent notification is a missed courtesy, a
   * notification the user never allowed is a broken promise.
   */
  private permission: NotificationPermission = 'notAsked';

  constructor(private readonly client: AirLinkClient) {
    this.chat = chatCenterFor(client);
    this.invites = inviteCentreFor(client);

    this.offs.push(this.chat.subscribe(() => this.refresh()));
    this.offs.push(this.invites.subscribe(() => this.refresh()));

    // The first pass takes a reading and announces nothing. A phone launched
    // with three unread messages already in it should show three badges, not
    // buzz three times about conversations from yesterday.
    //
    // It deliberately writes nothing to the store either. A centre is built
    // from a hook, which means DURING a React render, and a store write there
    // updates one component while another is rendering - which React rightly
    // complains about. `useNotificationBadges` publishes the first real counts
    // from an effect a moment later.
    this.scan(false);
    void this.refreshPermission();
  }

  // -- permission ------------------------------------------------------------

  /** The last known answer, without asking the system again. */
  permissionNow(): NotificationPermission {
    return this.permission;
  }

  /** True when this build has a notifications module at all. */
  isAvailable(): boolean {
    try {
      return notifications.isAvailable();
    } catch {
      return false;
    }
  }

  /** Re-read the system's answer. Never throws; an error means "not granted". */
  async refreshPermission(): Promise<NotificationPermission> {
    try {
      this.permission = await notifications.getPermission();
    } catch {
      this.permission = 'unsupported';
    }
    // A permission that has just been granted should put the badge on the app
    // icon immediately rather than at the next arriving message.
    this.refresh();
    return this.permission;
  }

  /** Ask the system. The answer is cached, so the row can show what happened. */
  async requestPermission(): Promise<NotificationPermission> {
    try {
      this.permission = await notifications.requestPermission();
    } catch {
      this.permission = 'unsupported';
    }
    this.refresh();
    return this.permission;
  }

  // -- what the navigator tells us -------------------------------------------

  /**
   * The conversation the user is looking at, or null for anywhere else.
   *
   * Opening a conversation also wipes whatever that thread has left on the lock
   * screen: they are looking at the messages, so notifications about them are
   * already read by any sensible definition.
   */
  setActiveConversation(peerKey: string | null): void {
    if (peerKey === null) {
      this.activeConversationId = null;
      return;
    }
    const conversationId = this.conversationForPeerKey(peerKey);
    this.activeConversationId = conversationId;
    if (conversationId) this.clearThread(conversationId);
    this.refresh();
  }

  /**
   * Where a tapped notification leads, or null if it leads nowhere useful.
   *
   * An invitation deliberately returns null: `GameInviteHost` asks the question
   * wherever the user happens to be, so opening the app is the whole job and
   * navigating somewhere would take them away from the question.
   */
  threadTarget(threadId: string): ChatThreadTarget | null {
    if (threadId.startsWith(INVITE_THREAD)) return null;
    const summary = this.summaries().find((row) => row.conversationId === threadId);
    if (!summary) return null;
    return { peerKey: summary.peerId, title: summary.displayName };
  }

  /**
   * A tap on a notification, already resolved to somewhere the app can go.
   *
   * Wrapped here rather than subscribed to from the navigator so that every
   * call into the native module lives in this one file, guards included. The
   * handler is given null when the notification leads nowhere - an invitation,
   * or a conversation since cleared - and the navigator does nothing with it.
   */
  onOpened(handler: (target: ChatThreadTarget | null) => void): () => void {
    try {
      return notifications.onOpened((event) => {
        // They have answered it by tapping it, whatever it was.
        this.clearThread(event.threadId);
        try {
          handler(this.threadTarget(event.threadId));
        } catch {
          // A navigation that fails is not worth taking the app down for.
        }
      });
    } catch {
      return () => undefined;
    }
  }

  /** Every decision this session, newest last. For tests and Developer Mode. */
  announcements(): readonly Announcement[] {
    return this.recent;
  }

  // -- the work --------------------------------------------------------------

  /**
   * Re-read the counts, notify about what is new, and keep the badges in step.
   *
   * Cheap enough to run on every chat publish: it is a handful of SQLite reads
   * that the chat list makes anyway.
   */
  refresh(): void {
    this.scan(true);
  }

  /**
   * One pass over the conversations and invitations.
   *
   * `publish` is false for the very first pass, which exists only to record
   * where everything stood so that the SECOND pass can tell what is new.
   */
  private scan(publish: boolean): void {
    const summaries = this.summaries();
    const seen = new Set<string>();
    let unreadChats = 0;

    for (const summary of summaries) {
      seen.add(summary.conversationId);
      if (summary.unreadCount > 0) unreadChats++;

      const previous = this.marks.get(summary.conversationId);
      this.marks.set(summary.conversationId, summary.unreadCount);

      // No previous reading means this is the first look at a conversation that
      // was already on the phone. Nothing to announce: it is history, not news.
      if (previous === undefined) continue;

      if (summary.unreadCount === 0 && previous > 0) {
        this.clearThread(summary.conversationId);
        continue;
      }
      if (summary.unreadCount <= previous) continue;
      // Our own messages never move this counter - `MessageRepository.insert`
      // only increments it for inbound rows - but it costs one comparison to
      // be certain, and notifying somebody about their own message is the
      // single most embarrassing thing this file could do.
      const message = summary.lastMessage;
      if (!message || isOutgoing(message)) continue;
      // They are reading it right now.
      if (summary.conversationId === this.activeConversationId) continue;

      this.announce({
        kind: 'message',
        threadId: summary.conversationId,
        title: summary.displayName || local.notify.someone,
        body: bodyFor(message.kind, message.body),
        data: { peerKey: summary.peerId },
      });
    }

    // A conversation that has been cleared away takes its notifications with it.
    for (const conversationId of [...this.marks.keys()]) {
      if (!seen.has(conversationId)) this.marks.delete(conversationId);
    }

    const pendingInvites = this.announceInvites();

    if (!publish) return;
    useAppStore.getState().setWaiting({ unreadChats, pendingInvites });
    // The app icon carries the same figure as the tab bar, plus anyone waiting
    // for an answer about a game. A badge that disagrees with what is inside
    // the app is worse than no badge.
    this.setBadge(unreadChats + pendingInvites);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.marks.clear();
    this.announcedInvites.clear();
    this.recent.length = 0;
    this.safe(() => void notifications.clearAll().catch(() => undefined));
  }

  // -- invitations -----------------------------------------------------------

  /**
   * Announce anything new, forget anything answered, and return the count.
   *
   * Unlike a conversation, an invitation open on the very first pass IS
   * announced. There is no such thing as a stale one waiting on the phone:
   * invitations live in memory and expire in under a minute, so one that is
   * here at all arrived while the app was running and has not been answered.
   */
  private announceInvites(): number {
    const now = Date.now();
    // An invitation the other phone has already given up on is not worth
    // waking anybody for, and must not sit on the Play tab as a badge that
    // leads to nothing.
    const open = (this.safe(() => this.invites.list()) ?? []).filter((record) => record.expiresAt > now);
    const live = new Set(open.map((record) => record.inviteId));

    for (const record of open) {
      if (this.announcedInvites.has(record.inviteId)) continue;
      this.announcedInvites.add(record.inviteId);
      this.announce({
        kind: 'invite',
        threadId: `${INVITE_THREAD}${record.inviteId}`,
        title: record.peerName || local.notify.someone,
        body: local.notify.invite(record.gameName),
        data: { peerKey: record.peerKey, gameId: record.gameId },
      });
    }

    for (const inviteId of [...this.announcedInvites]) {
      if (live.has(inviteId)) continue;
      // Answered, expired or withdrawn. Either way the question is over, so the
      // notification asking it has to go.
      this.announcedInvites.delete(inviteId);
      this.clearThread(`${INVITE_THREAD}${inviteId}`);
    }

    return open.length;
  }

  // -- the native edge -------------------------------------------------------

  private announce(input: {
    kind: 'message' | 'invite';
    threadId: string;
    title: string;
    body: string;
    data: Record<string, string>;
  }): void {
    const presented = this.permission === 'granted' && this.isAvailable();
    this.remember({
      kind: input.kind,
      threadId: input.threadId,
      title: input.title,
      body: input.body,
      at: Date.now(),
      presented,
    });
    if (!presented) return;
    this.safe(() =>
      // Deliberately not awaited. Whatever the phone does with this, the
      // message is already in the database and the badge is already right.
      void notifications
        .present({
          // Unique per notification so two messages in the same conversation
          // do not overwrite each other, while `threadId` still groups them.
          id: `${input.threadId}:${Date.now()}`,
          title: input.title,
          body: input.body,
          threadId: input.threadId,
          data: input.data,
        })
        .catch(() => undefined),
    );
  }

  private remember(announcement: Announcement): void {
    this.recent.push(announcement);
    while (this.recent.length > ANNOUNCEMENT_MEMORY) this.recent.shift();
  }

  private clearThread(threadId: string): void {
    this.safe(() => void notifications.clearThread(threadId).catch(() => undefined));
  }

  private setBadge(count: number): void {
    this.safe(() => void notifications.setBadgeCount(count).catch(() => undefined));
  }

  // -- reading ---------------------------------------------------------------

  private summaries(): readonly ConversationSummary[] {
    return this.safe(() => this.chat.listConversations()) ?? [];
  }

  /**
   * The conversation a route's `peerKey` belongs to.
   *
   * A route carries whatever key the screen that opened it had, which is the
   * peer id for a friend and a discovery-row key for somebody met a minute ago.
   * The live handle knows which is which; where there is no live handle - the
   * conversation was opened from the list with the other phone switched off -
   * the key is the peer id already.
   */
  private conversationForPeerKey(peerKey: string): string | null {
    const peerId = this.safe(() => this.client.peer(peerKey)?.peerId) ?? peerKey;
    const match = this.summaries().find((row) => row.peerId === peerId || row.peerId === peerKey);
    return match?.conversationId ?? null;
  }

  /**
   * Anything that touches SQLite or the native layer goes through here.
   *
   * Same guard as `ChatCenter.safe`, and for a stronger reason: this module is
   * a nicety, and a nicety that throws inside a message listener would take the
   * message with it.
   */
  private safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }
}

/** What a notification says when the message itself is not words. */
function bodyFor(kind: string, body: string | null): string {
  switch (kind) {
    case 'image':
      return local.notify.photo;
    case 'voice':
      return local.notify.voice;
    case 'file':
      return local.notify.file;
    default:
      return body && body.length > 0 ? body : local.notify.message;
  }
}

/**
 * One centre per client, for the life of the app.
 *
 * A `WeakMap` rather than a module singleton, exactly as the chat and invite
 * centres do it: a test - or a second identity one day - gets its own, and
 * nothing here keeps a dead client alive.
 */
const centres = new WeakMap<AirLinkClient, NotificationCentre>();

export function notificationCentreFor(client: AirLinkClient): NotificationCentre {
  const existing = centres.get(client);
  if (existing) return existing;
  const created = new NotificationCentre(client);
  centres.set(client, created);
  return created;
}

/**
 * The centre, or null while the client is still coming up.
 *
 * Built from the navigator rather than from `ClientProvider`, where the chat
 * and invite centres are built. That is on purpose and not an oversight: unlike
 * those two it listens to nothing on the wire, so nothing is lost by it
 * existing a moment later - and it needs the navigator anyway, to know which
 * conversation is on screen.
 */
export function useNotificationCentre(): NotificationCentre | null {
  const client = useOptionalClient();
  return client ? notificationCentreFor(client) : null;
}

/**
 * Keep the badges and the notifications alive for as long as the app is.
 *
 * The centre outlives the component - it belongs to the client - so this does
 * not dispose of it on unmount. The tab bar unmounts every time a modal takes
 * the screen, and a centre torn down there would miss whatever arrived while
 * the user was looking at a QR code.
 */
export function useNotificationBadges(): NotificationCentre | null {
  const centre = useNotificationCentre();
  useEffect(() => {
    // Re-reading on mount covers the window between the client coming up and
    // this hook first seeing it, during which messages can already have landed.
    centre?.refresh();
  }, [centre]);
  return centre;
}
