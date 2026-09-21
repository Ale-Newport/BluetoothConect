import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { ConnectionState } from '@airlink/core';
import { strings } from '@airlink/config';
import type { Message, Reaction } from '@airlink/db';
import { useClient } from '../../client/ClientProvider.js';
import type { AirLinkClient } from '../../client/AirLinkClient.js';
import { selectPeers, useAppStore } from '../../state/index.js';
import {
  chatCenterFor,
  MESSAGE_PAGE_SIZE,
  type AttachmentFile,
  type ChatCenter,
  type ConversationPage,
  type ConversationSummary,
} from './chatCenter.js';
import { attachmentCenterFor, type AttachmentCenter, type OutgoingAttachment } from './attachments.js';

/**
 * Reading the chat centre from React.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect because the
 * centre is written to from outside the React tree - a message arriving on a
 * radio, a receipt landing, a typing timer expiring - and this is the hook that
 * exists so those writes cannot be torn or missed between a render and its
 * effect.
 */

/**
 * The client, or null while it is still coming up.
 *
 * `ClientProvider` moves the app to READY - which mounts the navigator - and
 * only then awaits `client.start()`, so there is a window where these screens
 * are on screen and the context is still null. `useClient()` throws in that
 * window. The hook order is unaffected: it reads its context before it decides
 * to throw, so the `useContext` underneath runs on every render either way.
 *
 * A workaround, not a design. The fix belongs in `ClientProvider`; until then
 * every screen handles null by saying what is missing rather than crashing.
 */
function useOptionalClient(): AirLinkClient | null {
  try {
    return useClient();
  } catch {
    return null;
  }
}

export function useChatCenter(): ChatCenter | null {
  const client = useOptionalClient();
  return useMemo(() => (client ? chatCenterFor(client) : null), [client]);
}

/**
 * The outbox for photos and voice notes.
 *
 * Held for the client's lifetime like the chat centre, so a photo keeps moving
 * while the user is somewhere else in the app, and so a queued one is flushed
 * by the session coming back rather than by this screen being open.
 */
function useAttachmentCenter(): AttachmentCenter | null {
  const client = useOptionalClient();
  return useMemo(() => (client ? attachmentCenterFor(client) : null), [client]);
}

/**
 * Declares the version as a real input to a memo.
 *
 * Everything these hooks read lives in SQLite rather than in React state, so
 * the centre's version counter IS the dependency - but a rule that only looks
 * at identifiers inside the callback cannot see that. Naming it here keeps the
 * dependency honest without an exemption comment on every read.
 */
function dependsOn(_version: number): void {
  /* nothing to do: the value is the dependency */
}

function useCentreSubscription(centre: ChatCenter | null): (listener: () => void) => () => void {
  return useCallback(
    (listener: () => void) => (centre ? centre.subscribe(listener) : () => undefined),
    [centre],
  );
}

/** Bumped whenever anything the database holds about chat has changed. */
function useChatVersion(centre: ChatCenter | null): number {
  const subscribe = useCentreSubscription(centre);
  const snapshot = useCallback(() => centre?.getVersion() ?? 0, [centre]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Bumped when someone starts or stops typing, and by nothing else.
 *
 * Read separately from the data version so three bouncing dots re-render the
 * indicator without re-reading a page of messages out of SQLite.
 */
function useChatPresence(centre: ChatCenter | null): number {
  const subscribe = useCentreSubscription(centre);
  const snapshot = useCallback(() => centre?.getPresenceVersion() ?? 0, [centre]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * The first of these that is a real name; a blank one is not a name.
 *
 * A row with an empty headline, or a sheet saying " has to be in range", is
 * what an unnamed peer looks like without this.
 */
export function firstNamed(...candidates: readonly (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return strings.home.newDevice;
}

/**
 * Whether the person is actually looking at the screen.
 *
 * A conversation left open in a pocket is still mounted, and marking its
 * arrivals read there would send this device's friend a read receipt for a
 * message nobody has seen. `unknown` and `inactive` are transitional states on
 * iOS - the app is on screen during both - so only a genuine background counts.
 */
function isWatching(state: AppStateStatus | string | null | undefined): boolean {
  return state !== 'background' && state !== 'extension';
}

/** Everyone with a conversation, newest first. */
export function useConversations(): {
  readonly centre: ChatCenter | null;
  readonly conversations: readonly ConversationSummary[];
} {
  const centre = useChatCenter();
  const version = useChatVersion(centre);
  const conversations = useMemo(() => {
    dependsOn(version);
    return centre?.listConversations() ?? [];
  }, [centre, version]);
  return { centre, conversations };
}

export interface ConversationBinding {
  readonly centre: ChatCenter | null;
  /** Null when this device no longer knows who this is. */
  readonly peerId: string | null;
  readonly displayName: string;
  readonly avatarColor: string | null;
  readonly conversationId: string | null;
  readonly connection: ConnectionState;
  readonly isConnected: boolean;
  /** They are advertising right now, so connecting is something we can offer. */
  readonly nearby: boolean;
  /** The key the connect sheet needs, which is not always the peer id. */
  readonly liveKey: string;
  readonly peerTyping: boolean;
  readonly page: ConversationPage;
  readonly loadMore: () => void;
  readonly send: (text: string, replyToRowId: string | null) => boolean;
  /** A photo or a voice note. Same contract as `send`: false only means no conversation. */
  readonly sendAttachment: (attachment: OutgoingAttachment, replyToRowId: string | null) => boolean;
  readonly retry: (rowId: string) => void;
  /** How far a message's file has got, 0-100, or null when nothing is moving. */
  readonly progressFor: (rowId: string) => number | null;
  readonly react: (rowId: string, emoji: string, add: boolean) => boolean;
  readonly remove: (rowId: string) => void;
  readonly setTyping: (typing: boolean) => void;
  readonly fileFor: (fileId: string) => AttachmentFile | null;
}

const EMPTY_PAGE: ConversationPage = {
  messages: [],
  reactions: new Map<string, readonly Reaction[]>(),
  replies: new Map<string, Message>(),
  hasMore: false,
};

/**
 * One conversation, wired to the peer it belongs to.
 *
 * `peerKey` is whatever the route was given: the nearby registry's key when the
 * conversation was opened from Home, and a peer id when it was opened from the
 * chat list. Both resolve to the same person, which is the point - a
 * conversation must open whether or not its other half is in range.
 */
export function useConversation(peerKey: string, fallbackName: string): ConversationBinding {
  const centre = useChatCenter();
  const attachments = useAttachmentCenter();
  const version = useChatVersion(centre);
  // Read so a typing signal re-renders this screen. Deliberately not a memo
  // dependency anywhere: nothing it changes lives in the database.
  useChatPresence(centre);
  const peers = useAppStore(useShallow(selectPeers));

  const live = useMemo(
    () => peers.find((peer) => peer.key === peerKey) ?? peers.find((peer) => peer.peerId === peerKey),
    [peers, peerKey],
  );

  const stored = useMemo(() => {
    dependsOn(version);
    return centre?.peerRow(peerKey) ?? null;
  }, [centre, peerKey, version]);

  const peerId = live?.peerId ?? (stored ? stored.peerId : null);
  // The stored name first: it was written from an authenticated handshake,
  // where the nearby list's copy can be an unauthenticated advertisement - or
  // a placeholder standing in for an advertisement that carried no name at all.
  const displayName = firstNamed(stored?.displayName, live?.displayName, fallbackName);
  const avatarColor = live?.avatarColor ?? stored?.avatarColor ?? null;

  // Resolved during render rather than in an effect so the first paint already
  // has the messages: a two-pass render would flash an empty conversation at
  // someone who has hundreds of them. It is safe to do here because it is
  // idempotent - the row is looked up first and only created when a
  // conversation with this person genuinely does not exist yet.
  const conversationId = useMemo(() => {
    dependsOn(version);
    return centre && peerId ? centre.conversationFor(peerId, displayName) : null;
  }, [centre, peerId, displayName, version]);

  const connection = useMemo(() => {
    dependsOn(version);
    if (!centre || !peerId) return live?.connection ?? ConnectionState.DISCONNECTED;
    const fromSession = centre.connectionFor(peerId);
    // The session is the truth while one exists; the nearby list is what is
    // left to say when there is none.
    return fromSession === ConnectionState.DISCONNECTED ? live?.connection ?? fromSession : fromSession;
  }, [centre, peerId, live, version]);

  const [limit, setLimit] = useState(MESSAGE_PAGE_SIZE);
  // A different conversation starts at the first page again.
  useEffect(() => setLimit(MESSAGE_PAGE_SIZE), [conversationId]);

  const page = useMemo(() => {
    dependsOn(version);
    return centre && conversationId ? centre.readPage(conversationId, limit) : EMPTY_PAGE;
  }, [centre, conversationId, limit, version]);

  const loadMore = useCallback(() => {
    if (page.hasMore) setLimit((current) => current + MESSAGE_PAGE_SIZE);
  }, [page.hasMore]);

  /** Open and close, so arriving messages are read rather than unread. */
  useEffect(() => {
    if (!centre || !conversationId || !peerId) return;
    const open = (): void => centre.openConversation(conversationId, peerId);
    const close = (): void => centre.closeConversation(conversationId);
    // Mounted is not the same as watched. The screen stays mounted when the
    // phone goes into a pocket, and everything arriving there would otherwise
    // be marked read - no unread badge on the way back, and a read receipt
    // sent for a message nobody has seen.
    if (isWatching(AppState.currentState)) open();
    const subscription = AppState.addEventListener('change', (next) => {
      if (isWatching(next)) open();
      else close();
    });
    return () => {
      subscription.remove();
      close();
    };
  }, [centre, conversationId, peerId]);

  const send = useCallback(
    (text: string, replyToRowId: string | null) =>
      centre && peerId ? centre.send(peerId, displayName, text, replyToRowId) : false,
    [centre, peerId, displayName],
  );

  const sendAttachment = useCallback(
    (attachment: OutgoingAttachment, replyToRowId: string | null) =>
      attachments && peerId
        ? attachments.send({ peerId, displayName, attachment, replyToRowId }) !== null
        : false,
    [attachments, peerId, displayName],
  );

  /**
   * One Retry control, two outboxes behind it.
   *
   * A text message is re-armed inside the chat protocol's queue; a photo is
   * re-offered to the transfer layer. The bubble should not have to know which
   * it is, so the routing happens here, off the row's own `fileId`.
   */
  const retry = useCallback(
    (rowId: string) => {
      if (!centre || !peerId) return;
      const row = centre.messageRow(rowId);
      if (row?.fileId && attachments) attachments.retry(peerId, rowId);
      else centre.retry(peerId, rowId);
    },
    [centre, attachments, peerId],
  );

  /**
   * How far a photo's bytes have got.
   *
   * The version is a real dependency, and naming it is what makes the function
   * change identity as the transfer moves - which is the only way the number
   * reaches a memoised bubble. Without it the progress line would read once and
   * then sit still for the whole transfer.
   */
  const progressFor = useCallback(
    (rowId: string) => {
      dependsOn(version);
      return attachments?.percentFor(rowId) ?? null;
    },
    [attachments, version],
  );

  const react = useCallback(
    (rowId: string, emoji: string, add: boolean) =>
      centre && peerId ? centre.react(peerId, rowId, emoji, add) : false,
    [centre, peerId],
  );

  const remove = useCallback(
    (rowId: string) => {
      if (centre && peerId) centre.deleteForMe(peerId, rowId);
    },
    [centre, peerId],
  );

  const setTyping = useCallback(
    (typing: boolean) => {
      if (centre && peerId) centre.setTyping(peerId, typing);
    },
    [centre, peerId],
  );

  const fileFor = useCallback(
    (fileId: string) => centre?.fileFor(fileId) ?? null,
    [centre],
  );

  return {
    centre,
    peerId,
    displayName,
    avatarColor,
    conversationId,
    connection,
    isConnected: connection === ConnectionState.CONNECTED,
    nearby: live?.nearby ?? false,
    liveKey: live?.key ?? peerKey,
    peerTyping: centre?.isPeerTyping(peerId) ?? false,
    page,
    loadMore,
    send,
    sendAttachment,
    retry,
    progressFor,
    react,
    remove,
    setTyping,
    fileFor,
  };
}
