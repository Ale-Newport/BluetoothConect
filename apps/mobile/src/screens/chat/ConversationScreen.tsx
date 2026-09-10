import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Clipboard,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ConnectionState } from '@airlink/core';
import { strings } from '@airlink/config';
import type { Message } from '@airlink/db';
import {
  Avatar,
  Button,
  EmptyState,
  Label,
  StatusBanner,
  StatusDot,
  haptic,
  useTheme,
  type StatusTone,
} from '../../ui/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { isOutgoing, isOwnReaction, type ConversationPage } from './chatCenter.js';
import { useConversation } from './useChat.js';
import { MessageBubble, type AttachmentView, type BubbleRow } from './MessageBubble.js';
import { Composer } from './Composer.js';
import { MessageActions } from './MessageActions.js';
import { RUN_BREAK_MS, daySeparatorLabel, isSameDay } from './chatTime.js';
import { chatCopy } from './chatStrings.js';

/**
 * A conversation.
 *
 * The screen the whole app is judged on, so the rules are strict:
 *
 *  - The composer works whether or not the other phone is in range. A message
 *    written to someone who has stepped away is saved and says so.
 *  - Ticks only ever climb. Waiting, gone, arrived, seen.
 *  - Nothing here is a spinner without an end, and nothing is red unless it is
 *    a real failure the user can do something about. Being offline is neither.
 *
 * The header is drawn here rather than by the navigator so the keyboard has a
 * frame it can measure from the top of the screen - which is what makes the
 * composer sit exactly on the keyboard on iOS instead of a header's height away
 * from it.
 */

const HEADER_AVATAR = 34;
const BACK_TARGET = 44;
/** How long a confirmation such as "Copied" stays on screen. */
const NOTICE_MS = 1600;
/** The status dot in the header, and each dot in the typing indicator. */
const DOT_SIZE = 6;

type ConversationRoute = RouteProp<RootStackParams, 'Conversation'>;

export function ConversationScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<ConversationRoute>();
  const { peerKey, title } = route.params;

  const conversation = useConversation(peerKey, title);
  const {
    centre,
    peerId,
    displayName,
    avatarEmoji,
    connection,
    isConnected,
    nearby,
    liveKey,
    peerTyping,
    page,
    loadMore,
    send,
    retry,
    react,
    remove,
    setTyping,
    fileFor,
  } = conversation;

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [actionTarget, setActionTarget] = useState<Message | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<FlatList<BubbleRow>>(null);
  const keyboardUp = useKeyboardVisible();

  // The header lives inside the screen, so the navigator's one is turned off.
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  // Leaving mid-word must not leave the other phone showing three dots.
  useEffect(() => () => setTyping(false), [setTyping]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Attachments are resolved here rather than inside the row so a bubble's
  // props are stable between renders: `MessageBubble` is memoised, and an
  // object minted in `renderItem` would defeat that on every receipt.
  const rows = useMemo(() => buildRows(page, fileFor), [page, fileFor]);

  const onChangeDraft = useCallback(
    (text: string) => {
      setDraft(text);
      // Repeated `true` inside the protocol's coalescing window costs nothing,
      // so this can safely run on every keystroke.
      setTyping(text.trim().length > 0);
    },
    [setTyping],
  );

  const onSend = useCallback(() => {
    if (!send(draft, replyTo?.id ?? null)) {
      // Being out of range never lands here - that message is stored and
      // queued. The only way a composed message is not kept is a person this
      // device has never authenticated, and a tap that does nothing at all
      // would leave the user retyping it.
      if (draft.trim().length > 0) setNotice(chatCopy.needsFirstConnection(displayName));
      return;
    }
    setDraft('');
    setReplyTo(null);
    haptic('impactLight');
    // The list is inverted, so the newest message is at offset zero.
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [draft, replyTo, send, displayName]);

  const onToggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      const existing = page.reactions.get(messageId) ?? [];
      const own = existing.some((reaction) => isOwnReaction(reaction) && reaction.emoji === emoji);
      if (!react(messageId, emoji, !own)) setNotice(chatCopy.reactOffline(displayName));
    },
    [page.reactions, react, displayName],
  );

  const onCopy = useCallback((message: Message) => {
    // `Clipboard` is deprecated in React Native core but still shipped; moving
    // to @react-native-clipboard/clipboard is a dependency change, not a code
    // change, and belongs in one commit for the whole app.
    Clipboard.setString(message.body ?? '');
    setActionTarget(null);
    setNotice(chatCopy.copied);
    haptic('success');
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: BubbleRow }) => (
      <MessageBubble
        row={item}
        peerName={displayName}
        onLongPress={setActionTarget}
        onRetry={retry}
        onToggleReaction={onToggleReaction}
      />
    ),
    [displayName, retry, onToggleReaction],
  );

  const status = headerStatus(connection, isConnected);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Header
        name={displayName}
        peerId={peerId}
        avatarEmoji={avatarEmoji}
        statusText={status.text}
        statusTone={status.tone}
        topInset={insets.top}
        onBack={() => navigation.goBack()}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        // The header above is part of this screen rather than the navigator's,
        // so the keyboard's overlap needs no correction for it.
        keyboardVerticalOffset={0}
      >
        {/* Nearby but not connected is worth an offer, not a warning: they are
            right there, and the alternative is walking back to Home. Being out
            of range entirely gets no banner at all - the header already says
            so, and there would be nothing to tap. */}
        {peerId !== null && !isConnected && nearby ? (
          <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm }}>
            <StatusBanner
              tone="disconnected"
              title={chatCopy.nearbyNow(displayName)}
              action={
                <BannerAction
                  title={strings.home.connect}
                  accessibilityLabel={chatCopy.connectTo(displayName)}
                  onPress={() => navigation.navigate('Connect', { peerKey: liveKey })}
                />
              }
            />
          </View>
        ) : null}

        {peerId === null ? (
          // With no centre yet this device has not looked in its own database,
          // so it does not know whether it knows this person. Saying they are
          // gone would be a guess, and the wrong one to make about someone's
          // conversation - so the screen simply waits, for the moment it takes.
          <View style={{ flex: 1, justifyContent: 'center' }}>
            {centre ? (
              <EmptyState
                icon="✉"
                title={chatCopy.unknownTitle}
                body={chatCopy.unknownBody}
                action={
                  <Button
                    title={chatCopy.connectAction}
                    variant="secondary"
                    onPress={() => navigation.navigate('Connect', { peerKey })}
                  />
                }
              />
            ) : null}
          </View>
        ) : rows.length === 0 ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState icon="✉" title={strings.chat.emptyTitle} body={strings.chat.emptyBody} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(row) => row.message.id}
            renderItem={renderItem}
            inverted
            contentContainerStyle={{
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: theme.spacing.md,
            }}
            // Inverted: the end of the list is the oldest message, so this is
            // where an older page is fetched from the repository.
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            initialNumToRender={20}
            maxToRenderPerBatch={20}
            windowSize={11}
            removeClippedSubviews={Platform.OS === 'android'}
          />
        )}

        {peerTyping ? <TypingIndicator name={displayName} /> : null}

        {notice ? (
          <View style={{ alignItems: 'center', paddingBottom: theme.spacing.sm }}>
            <View
              style={{
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.xs,
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.surfaceElevated,
              }}
            >
              <Label variant="caption" tone="secondary">
                {notice}
              </Label>
            </View>
          </View>
        ) : null}

        {peerId !== null ? (
          // The home indicator needs clearing when the keyboard is down and
          // must NOT be cleared when it is up: `KeyboardAvoidingView` already
          // pads by the keyboard's full height, and adding the inset on top of
          // that leaves a strip of surface floating above the keys.
          <View style={{ paddingBottom: keyboardUp ? 0 : insets.bottom }}>
            <Composer
              value={draft}
              onChangeText={onChangeDraft}
              onSend={onSend}
              replyTo={replyTo}
              peerName={displayName}
              onCancelReply={() => setReplyTo(null)}
            />
          </View>
        ) : null}
      </KeyboardAvoidingView>

      <MessageActions
        message={actionTarget}
        peerName={displayName}
        canReact={isConnected}
        onReply={(message) => {
          setReplyTo(message);
          setActionTarget(null);
        }}
        onReact={(message, emoji) => {
          setActionTarget(null);
          onToggleReaction(message.id, emoji);
        }}
        onCopy={onCopy}
        onDelete={(message) => {
          setActionTarget(null);
          remove(message.id);
          haptic('warning');
        }}
        onClose={() => setActionTarget(null)}
      />
    </View>
  );
}

/**
 * A text action inside the banner.
 *
 * `Button` is the right weight for a decision at the foot of a screen and far
 * too heavy for a line under a header.
 */
function BannerAction({
  title,
  accessibilityLabel,
  onPress,
}: {
  title: string;
  accessibilityLabel: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      hitSlop={theme.spacing.md}
      style={({ pressed }) => [
        { minHeight: BACK_TARGET, justifyContent: 'center', paddingHorizontal: theme.spacing.xs },
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      <Label variant="footnote" tone="accent">
        {title}
      </Label>
    </Pressable>
  );
}

/**
 * Whether the keyboard is on screen.
 *
 * iOS gets the "will" events so the composer moves with the keyboard rather
 * than after it; Android only fires the "did" pair.
 */
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/**
 * Grouping, day separators and where the metadata goes.
 *
 * The page arrives newest first, which is the order an inverted list wants, so
 * index + 1 is the message ABOVE and index - 1 is the one below.
 */
function buildRows(
  page: ConversationPage,
  fileFor: (fileId: string) => AttachmentView | null,
): BubbleRow[] {
  const now = Date.now();
  const messages = page.messages;
  const newestOutgoingId = messages.find((message) => isOutgoing(message))?.id ?? null;

  return messages.map((message, index) => {
    const above = messages[index + 1];
    const below = messages[index - 1];
    const mine = isOutgoing(message);
    const at = displayTimeOf(message);

    return {
      message,
      mine,
      continuesAbove: above !== undefined && sameRun(above, message),
      continuesBelow: below !== undefined && sameRun(message, below),
      // The separator belongs above the first message of a day, which - reading
      // upwards - is the one whose neighbour above is another day, or nothing.
      daySeparator:
        above === undefined || !isSameDay(displayTimeOf(above), at) ? daySeparatorLabel(at, now) : null,
      reactions: page.reactions.get(message.id) ?? [],
      replyTo: page.replies.get(message.id) ?? null,
      isNewestOutgoing: message.id === newestOutgoingId,
      attachment: message.fileId ? fileFor(message.fileId) : null,
    };
  });
}

/** Our clock for what we said, and our clock for when theirs arrived. */
function displayTimeOf(message: Message): number {
  return isOutgoing(message) ? message.sentAt : message.receivedAt;
}

/** One person talking without interruption, and without a long pause. */
function sameRun(older: Message, newer: Message): boolean {
  if (older.senderPeerId !== newer.senderPeerId) return false;
  return displayTimeOf(newer) - displayTimeOf(older) < RUN_BREAK_MS;
}

function headerStatus(connection: ConnectionState, isConnected: boolean): { text: string; tone: StatusTone } {
  if (isConnected) return { text: strings.chat.connectedLocally, tone: 'connected' };
  switch (connection) {
    case ConnectionState.CONNECTING:
    case ConnectionState.AUTHENTICATING:
    case ConnectionState.NEGOTIATING_TRANSPORT:
    case ConnectionState.PAIRING:
      return { text: strings.connection.securing, tone: 'connecting' };
    case ConnectionState.RECONNECTING:
      return { text: strings.connection.reconnecting, tone: 'connecting' };
    default:
      // Not connected is not a failure. It is most of a flight.
      return { text: strings.chat.notConnected, tone: 'disconnected' };
  }
}

function Header({
  name,
  peerId,
  avatarEmoji,
  statusText,
  statusTone,
  topInset,
  onBack,
}: {
  name: string;
  peerId: string | null;
  avatarEmoji: string | null;
  statusText: string;
  statusTone: StatusTone;
  topInset: number;
  onBack: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingTop: topInset,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.separator,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          paddingRight: theme.spacing.lg,
          paddingVertical: theme.spacing.sm,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.common.back}
          onPress={onBack}
          style={({ pressed }) => [
            { width: BACK_TARGET, height: BACK_TARGET, alignItems: 'center', justifyContent: 'center' },
            pressed ? { opacity: 0.5 } : null,
          ]}
        >
          <Label variant="title2" tone="accent">
            ‹
          </Label>
        </Pressable>

        <Avatar name={name} peerId={peerId} emoji={avatarEmoji} size={HEADER_AVATAR} />

        <View style={{ flex: 1 }}>
          <Label variant="headline" numberOfLines={1}>
            {name}
          </Label>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
            <StatusDot tone={statusTone} size={DOT_SIZE} />
            <Label variant="caption" tone="secondary" numberOfLines={1}>
              {statusText}
            </Label>
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * Three dots that expire.
 *
 * The protocol carries a time-to-live with every typing signal precisely so a
 * dropped "stopped typing" cannot leave this bouncing forever, and the chat
 * centre arms a second timer on top of that. Nothing here spins without end.
 */
function TypingIndicator({ name }: { name: string }): React.JSX.Element {
  const theme = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: theme.motion.slow, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: theme.motion.slow, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, theme.motion.slow]);

  return (
    <View
      accessible
      accessibilityLabel={chatCopy.typingBy(name)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingBottom: theme.spacing.sm,
      }}
    >
      <Animated.View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.xs / 2,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.bubbleIncoming,
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
        }}
      >
        <Dot />
        <Dot />
        <Dot />
      </Animated.View>
      <Label variant="caption" tone="tertiary">
        {strings.chat.typing}
      </Label>
    </View>
  );
}

function Dot(): React.JSX.Element {
  return <StatusDot tone="disconnected" size={DOT_SIZE} />;
}
