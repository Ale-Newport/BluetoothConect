import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ConnectionState } from '@airlink/core';
import type { Message, Reaction } from '@airlink/db';
import { useClient } from '../../client/ClientProvider.js';
import type { AirLinkClient } from '../../client/AirLinkClient.js';
import { selectPeers, useAppStore } from '../../state/index.js';
import {
  chatCenterFor,
  MESSAGE_PAGE_SIZE,
  type ChatCenter,
  type ConversationPage,
  type ConversationSummary,
} from './chatCenter.js';

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

/** Bumped whenever anything the database holds about chat has changed. */
function useChatVersion(centre: ChatCenter | null): number {
  const subscribe = useCallback(
    (listener: () => void) => (centre ? centre.subscribe(listener) : () => undefined),
    [centre],
  );
  const snapshot = useCallback(() => centre?.getVersion() ?? 0, [centre]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Everyone with a conversation, newest first. */
export function useConversations(): {
  readonly centre: ChatCenter | null;
  readonly conversations: readonly ConversationSummary[];
} {
  const centre = useChatCenter();
  const version = useChatVersion(centre);
  const conversations = useMemo(
    // `version` is the dependency that matters: the rows themselves live in
    // SQLite, and this re-reads them whenever the centre says they moved.
    () => centre?.listConversations() ?? [],
    [centre, version],
  );
  return { centre, conversations };
}

export interface ConversationBinding {
  readonly centre: ChatCenter | null;
  /** Null when this device no longer knows who this is. */
  readonly peerId: string | null;
  readonly displayName: string;
  readonly avatarEmoji: string | null;
  readonly conversationId: string | null;
  readonly connection: ConnectionState;
  readonly isConnected: boolean;
  readonly peerTyping: boolean;
  readonly page: ConversationPage;
  readonly loadMore: () => void;
  readonly send: (text: string, replyToRowId: string | null) => boolean;
  readonly retry: (rowId: string) => void;
  readonly react: (rowId: string, emoji: string, add: boolean) => boolean;
  readonly remove: (rowId: string) => void;
  readonly setTyping: (typing: boolean) => void;
  readonly fileFor: (fileId: string) => { name: string; sizeBytes: number; localPath: string | null } | null;
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
  const version = useChatVersion(centre);
  const peers = useAppStore(useShallow(selectPeers));

  const live = useMemo(
    () => peers.find((peer) => peer.key === peerKey) ?? peers.find((peer) => peer.peerId === peerKey),
    [peers, peerKey],
  );

  const stored = useMemo(
    () => {
      void version;
      return centre?.peerRow(peerKey) ?? null;
    },
    [centre, peerKey, version],
  );

  const peerId = live?.peerId ?? (stored ? stored.peerId : null);
  const displayName = live?.displayName ?? stored?.displayName ?? fallbackName;
  const avatarEmoji = live?.avatarEmoji ?? stored?.avatarEmoji ?? null;

  const conversationId = useMemo(
    () => {
      void version;
      return centre && peerId ? centre.conversationFor(peerId, displayName) : null;
    },
    [centre, peerId, displayName, version],
  );

  const connection = useMemo(() => {
    void version;
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
    void version;
    return centre && conversationId ? centre.readPage(conversationId, limit) : EMPTY_PAGE;
  }, [centre, conversationId, limit, version]);

  const loadMore = useCallback(() => {
    if (page.hasMore) setLimit((current) => current + MESSAGE_PAGE_SIZE);
  }, [page.hasMore]);

  /** Open and close, so arriving messages are read rather than unread. */
  useEffect(() => {
    if (!centre || !conversationId || !peerId) return;
    centre.openConversation(conversationId, peerId);
    return () => centre.closeConversation(conversationId);
  }, [centre, conversationId, peerId]);

  const send = useCallback(
    (text: string, replyToRowId: string | null) =>
      centre && peerId ? centre.send(peerId, displayName, text, replyToRowId) : false,
    [centre, peerId, displayName],
  );

  const retry = useCallback(
    (rowId: string) => {
      if (centre && peerId) centre.retry(peerId, rowId);
    },
    [centre, peerId],
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
    avatarEmoji,
    conversationId,
    connection,
    isConnected: connection === ConnectionState.CONNECTED,
    peerTyping: centre?.isPeerTyping(peerId) ?? false,
    page,
    loadMore,
    send,
    retry,
    react,
    remove,
    setTyping,
    fileFor,
  };
}
