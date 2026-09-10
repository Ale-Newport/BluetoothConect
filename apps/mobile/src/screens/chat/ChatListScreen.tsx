import React, { useCallback, useMemo } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useShallow } from 'zustand/react/shallow';
import { ConnectionState } from '@airlink/core';
import { strings } from '@airlink/config';
import {
  Avatar,
  Button,
  Divider,
  EmptyState,
  Gap,
  Label,
  SectionHeading,
  StatusDot,
  haptic,
  useTheme,
} from '../../ui/index.js';
import { selectPeers, useAppStore, type PeerView } from '../../state/index.js';
import type { RootStackParams, TabParams } from '../../navigation/routes.js';
import type { ConversationSummary } from './chatCenter.js';
import { useConversations } from './useChat.js';
import { listTimestamp } from './chatTime.js';
import { chatCopy } from './chatStrings.js';

/**
 * Chat.
 *
 * Every conversation this phone holds, newest first, and above them anyone who
 * is in range but has never been messaged - because on a plane the person you
 * want to write to is usually the one who just appeared, and making them go
 * back to Home to start would be silly.
 *
 * A conversation opens whether or not the other half is in range. Nothing here
 * waits on a radio.
 */

const AVATAR_SIZE = 48;
const ROW_HEIGHT = 76;

type ChatListNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<TabParams, 'Chat'>,
  NativeStackNavigationProp<RootStackParams>
>;

/** One line in the list: a heading, a conversation, or someone new to talk to. */
type Entry =
  | { readonly kind: 'heading'; readonly key: string; readonly title: string }
  | { readonly kind: 'conversation'; readonly key: string; readonly summary: ConversationSummary }
  | { readonly kind: 'peer'; readonly key: string; readonly peer: PeerView };

export function ChatListScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<ChatListNavigation>();
  const { conversations } = useConversations();
  const peers = useAppStore(useShallow(selectPeers));

  const connectedPeerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const peer of peers) {
      if (peer.peerId && peer.connection === ConnectionState.CONNECTED) ids.add(peer.peerId);
    }
    return ids;
  }, [peers]);

  /** People in range who have never been written to. Nothing else belongs here. */
  const newcomers = useMemo(() => {
    const known = new Set(conversations.map((conversation) => conversation.peerId));
    return peers.filter(
      (peer) => peer.peerId !== null && !known.has(peer.peerId) && peer.connection === ConnectionState.CONNECTED,
    );
  }, [peers, conversations]);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    if (newcomers.length > 0) {
      list.push({ kind: 'heading', key: 'heading-start', title: chatCopy.startSection });
      for (const peer of newcomers) list.push({ kind: 'peer', key: `peer-${peer.key}`, peer });
    }
    if (conversations.length > 0) {
      if (newcomers.length > 0) {
        list.push({ kind: 'heading', key: 'heading-conversations', title: chatCopy.conversationsSection });
      }
      for (const conversation of conversations) {
        list.push({ kind: 'conversation', key: conversation.conversationId, summary: conversation });
      }
    }
    return list;
  }, [conversations, newcomers]);

  const open = useCallback(
    (peerKey: string, title: string) => {
      haptic('selection');
      navigation.navigate('Conversation', { peerKey, title });
    },
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: Entry }) => {
      if (item.kind === 'heading') {
        return (
          <View style={{ paddingTop: theme.spacing.lg }}>
            <SectionHeading>{item.title}</SectionHeading>
          </View>
        );
      }
      if (item.kind === 'peer') {
        return (
          <ConversationRow
            name={item.peer.displayName}
            peerId={item.peer.peerId}
            avatarEmoji={item.peer.avatarEmoji}
            preview={chatCopy.sayHello}
            timestamp={null}
            unreadCount={0}
            connected
            onPress={() => open(item.peer.key, item.peer.displayName)}
          />
        );
      }
      const { summary } = item;
      return (
        <ConversationRow
          name={summary.displayName}
          peerId={summary.peerId}
          avatarEmoji={summary.avatarEmoji}
          preview={previewOf(summary)}
          timestamp={summary.lastMessage ? summary.lastActivityAt : null}
          unreadCount={summary.unreadCount}
          connected={connectedPeerIds.has(summary.peerId)}
          onPress={() => open(summary.peerId, summary.displayName)}
        />
      );
    },
    [connectedPeerIds, open, theme.spacing.lg],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <FlatList
        data={entries}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={{
          paddingTop: insets.top + theme.spacing.xl,
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: theme.spacing.xxl,
          flexGrow: 1,
        }}
        ListHeaderComponent={
          <View>
            <Label variant="largeTitle">{strings.home.chat}</Label>
            <Gap size="sm" />
          </View>
        }
        ItemSeparatorComponent={ListSeparator}
        ListEmptyComponent={
          <EmptyState
            icon="✉"
            title={chatCopy.listEmptyTitle}
            body={chatCopy.listEmptyBody}
            action={
              <Button
                title={chatCopy.listEmptyAction}
                variant="secondary"
                // The tab bar is right there, but an empty screen should still
                // point at the thing that fills it.
                onPress={() => navigation.navigate('Home')}
              />
            }
          />
        }
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        windowSize={9}
      />
    </View>
  );
}

/** A hairline between rows, inset past the avatar so the list reads as one group. */
function ListSeparator(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ paddingLeft: AVATAR_SIZE + theme.spacing.md }}>
      <Divider />
    </View>
  );
}

function previewOf(summary: ConversationSummary): string {
  const message = summary.lastMessage;
  if (!message) return chatCopy.sayHello;
  if (message.body && message.body.length > 0) return message.body;
  if (message.kind === 'image') return chatCopy.photoPreview;
  if (message.kind === 'file') return chatCopy.filePreview;
  return chatCopy.sayHello;
}

function ConversationRow({
  name,
  peerId,
  avatarEmoji,
  preview,
  timestamp,
  unreadCount,
  connected,
  onPress,
}: {
  name: string;
  peerId: string | null;
  avatarEmoji: string | null;
  preview: string;
  timestamp: number | null;
  unreadCount: number;
  connected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const now = Date.now();
  const unread = unreadCount > 0;

  const label = [
    name,
    connected ? strings.chat.connectedLocally : null,
    preview,
    unread ? chatCopy.unreadCount(unreadCount) : null,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(', ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={chatCopy.openChat(name)}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          minHeight: ROW_HEIGHT,
          paddingVertical: theme.spacing.md,
        },
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      <View>
        <Avatar name={name} peerId={peerId} emoji={avatarEmoji} size={AVATAR_SIZE} />
        {connected ? (
          // A presence dot on the face rather than a word in the row: the list
          // is scanned, not read.
          <View
            style={{
              position: 'absolute',
              right: -1,
              bottom: -1,
              padding: 2,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.background,
            }}
          >
            <StatusDot tone="connected" size={10} />
          </View>
        ) : null}
      </View>

      <View style={{ flex: 1 }}>
        <Label variant="headline" numberOfLines={1}>
          {name}
        </Label>
        <Label variant="subheadline" tone={unread ? 'primary' : 'secondary'} numberOfLines={1}>
          {preview}
        </Label>
      </View>

      <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs, minWidth: 44 }}>
        {timestamp !== null ? (
          <Label variant="caption" tone="tertiary">
            {listTimestamp(timestamp, now)}
          </Label>
        ) : null}
        {unread ? <UnreadBadge count={unreadCount} /> : null}
      </View>
    </Pressable>
  );
}

function UnreadBadge({ count }: { count: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        paddingHorizontal: theme.spacing.xs + 2,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.accent,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Label variant="caption" tone="onAccent">
        {count > 99 ? '99+' : String(count)}
      </Label>
    </View>
  );
}
