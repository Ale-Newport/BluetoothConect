import React, { useCallback, useMemo } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { strings } from '@airlink/config';
import type { Message, MessageStatus, Reaction } from '@airlink/db';
import { Label, haptic, useTheme } from '../../ui/index.js';
import { isOutgoing, isOwnReaction } from './chatCenter.js';
import { clockTime } from './chatTime.js';
import { chatCopy } from './chatStrings.js';

/**
 * One message.
 *
 * Outgoing on the right in the accent, incoming on the left on a neutral
 * surface, and consecutive messages from the same person grouped into a run
 * with a single timestamp at the end of it - which is what makes a long
 * conversation readable rather than a wall of metadata.
 *
 * The corner facing a neighbour in the same run is tightened; every other
 * corner stays full. That, and nothing else, is the grouping treatment: no
 * tails, no gradients.
 */

/** Everything the list has worked out about one row. */
export interface BubbleRow {
  readonly message: Message;
  readonly mine: boolean;
  /** There is a bubble from the same person directly above. */
  readonly continuesAbove: boolean;
  /** There is a bubble from the same person directly below. */
  readonly continuesBelow: boolean;
  /** The day this message starts, when it is the first of that day. */
  readonly daySeparator: string | null;
  readonly reactions: readonly Reaction[];
  readonly replyTo: Message | null;
  /** The newest thing this device said, which is where "Delivered" belongs. */
  readonly isNewestOutgoing: boolean;
  /** The file this message carries, once the database knows anything about it. */
  readonly attachment: AttachmentView | null;
}

export interface AttachmentView {
  readonly name: string;
  readonly sizeBytes: number;
  readonly localPath: string | null;
}

const MAX_BUBBLE_WIDTH = '78%';
const IMAGE_WIDTH = 220;
/** The square that stands in for a file until the bytes are here. */
const FILE_ICON_SIZE = 36;
/** How wide the "Saved" note under a queued message is allowed to run. */
const STATUS_LINE_WIDTH = 260;

/**
 * Memoised on purpose.
 *
 * A conversation re-reads its page whenever a receipt lands, and a long thread
 * is a hundred mounted bubbles; without this, one tick climbing re-renders
 * every one of them. The rows are rebuilt only when the page itself changes, so
 * this comparison is the cheap one - reference equality on a stable object.
 */
export const MessageBubble = React.memo(MessageBubbleView);

function MessageBubbleView({
  row,
  peerName,
  onLongPress,
  onRetry,
  onToggleReaction,
}: {
  row: BubbleRow;
  peerName: string;
  onLongPress: (message: Message) => void;
  onRetry: (messageId: string) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { message, mine, attachment } = row;
  const time = clockTime(mine ? message.sentAt : message.receivedAt);
  const showMeta = !row.continuesBelow;

  const corners = useMemo(() => {
    const full = theme.radius.lg;
    const tight = theme.radius.sm;
    return {
      borderTopLeftRadius: !mine && row.continuesAbove ? tight : full,
      borderBottomLeftRadius: !mine && row.continuesBelow ? tight : full,
      borderTopRightRadius: mine && row.continuesAbove ? tight : full,
      borderBottomRightRadius: mine && row.continuesBelow ? tight : full,
    };
  }, [mine, row.continuesAbove, row.continuesBelow, theme.radius.lg, theme.radius.sm]);

  const textColor = mine ? theme.colors.bubbleOutgoingText : theme.colors.bubbleIncomingText;

  const handleLongPress = useCallback(() => {
    haptic('impactLight');
    onLongPress(message);
  }, [message, onLongPress]);

  const label = [
    mine ? chatCopy.messageFromYou : chatCopy.messageFrom(peerName),
    message.body ?? (message.kind === 'image' ? chatCopy.photoPreview : attachment?.name ?? chatCopy.filePreview),
    time,
    mine ? statusWord(message.status) : null,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(', ');

  return (
    <View>
      {row.daySeparator ? (
        <View style={{ paddingVertical: theme.spacing.lg, alignItems: 'center' }}>
          <Label variant="caption" tone="tertiary">
            {row.daySeparator}
          </Label>
        </View>
      ) : null}

      <View
        style={{
          alignItems: mine ? 'flex-end' : 'flex-start',
          // A run breathes as one block: tight inside, open between runs.
          marginTop: row.continuesAbove ? theme.spacing.xs / 2 : theme.spacing.md,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={chatCopy.actionsHint}
          onLongPress={handleLongPress}
          delayLongPress={280}
          style={({ pressed }) => [
            {
              maxWidth: MAX_BUBBLE_WIDTH,
              backgroundColor: mine ? theme.colors.bubbleOutgoing : theme.colors.bubbleIncoming,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.sm + 2,
            },
            corners,
            pressed ? { opacity: 0.8 } : null,
          ]}
        >
          {row.replyTo ? (
            <ReplyQuote message={row.replyTo} peerName={peerName} onAccent={mine} />
          ) : null}

          {attachment ? (
            <Attachment view={attachment} isImage={message.kind === 'image'} onAccent={mine} />
          ) : null}

          {message.body ? (
            <Label variant="body" style={{ color: textColor }}>
              {message.body}
            </Label>
          ) : null}

          {showMeta ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                alignSelf: 'flex-end',
                gap: theme.spacing.xs,
                marginTop: theme.spacing.xs / 2,
                opacity: 0.7,
              }}
            >
              <Label variant="caption" style={{ color: textColor }}>
                {time}
              </Label>
              {mine ? <Tick status={message.status} color={textColor} /> : null}
            </View>
          ) : null}
        </Pressable>

        {row.reactions.length > 0 ? (
          <Reactions
            reactions={row.reactions}
            mine={mine}
            onToggle={(emoji) => onToggleReaction(message.id, emoji)}
          />
        ) : null}

        <StatusLine row={row} onRetry={onRetry} />
      </View>
    </View>
  );
}

/**
 * The tick.
 *
 * Four rungs and no more: waiting, gone, arrived, seen. The ladder only ever
 * climbs - the protocol refuses to move a message down one, and so does the
 * database - so a tick the user has already seen never takes anything back.
 */
function Tick({ status, color }: { status: MessageStatus; color: string }): React.JSX.Element {
  const glyph = status === 'pending' ? '◷' : status === 'sent' ? '✓' : status === 'failed' ? '!' : '✓✓';
  return (
    // The glyph alone would be read out as punctuation, so the word travels
    // with it for anyone listening rather than looking.
    <View accessible accessibilityLabel={statusWord(status)}>
      <Label variant="caption" style={{ color, opacity: status === 'read' ? 1 : 0.85 }}>
        {glyph}
      </Label>
    </View>
  );
}

function statusWord(status: MessageStatus): string {
  switch (status) {
    case 'pending':
      return chatCopy.statusQueued;
    case 'sent':
      return chatCopy.statusSent;
    case 'delivered':
      return chatCopy.statusDelivered;
    case 'read':
      return chatCopy.statusRead;
    default:
      return chatCopy.statusFailed;
  }
}

/**
 * The line under the last bubble.
 *
 * "Saved" is the important one: composing with nobody in range is the normal
 * way to use this app, not a failure, so the message says where it went rather
 * than warning about where it did not.
 */
function StatusLine({ row, onRetry }: { row: BubbleRow; onRetry: (messageId: string) => void }): React.JSX.Element | null {
  const theme = useTheme();
  const { message, mine } = row;
  if (!mine) return null;

  if (message.status === 'failed') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, marginTop: theme.spacing.xs }}>
        <Label variant="caption" tone="danger">
          {strings.chat.failed}
        </Label>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.chat.retry}
          onPress={() => {
            haptic('selection');
            onRetry(message.id);
          }}
          hitSlop={theme.spacing.md}
          style={({ pressed }) => [{ minHeight: 22, justifyContent: 'center' }, pressed ? { opacity: 0.6 } : null]}
        >
          <Label variant="caption" tone="accent">
            {strings.chat.retry}
          </Label>
        </Pressable>
      </View>
    );
  }

  if (message.status === 'pending') {
    return (
      <Label variant="caption" tone="tertiary" align="right" style={{ marginTop: theme.spacing.xs, maxWidth: STATUS_LINE_WIDTH }}>
        {strings.chat.willSendWhenConnected}
      </Label>
    );
  }

  if (!row.isNewestOutgoing) return null;
  if (message.status === 'read') {
    return (
      <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.xs }}>
        {strings.chat.read}
      </Label>
    );
  }
  if (message.status === 'delivered') {
    return (
      <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.xs }}>
        {strings.chat.delivered}
      </Label>
    );
  }
  return null;
}

/** The message being replied to, quoted inside the reply. */
function ReplyQuote({
  message,
  peerName,
  onAccent,
}: {
  message: Message;
  peerName: string;
  onAccent: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const color = onAccent ? theme.colors.bubbleOutgoingText : theme.colors.bubbleIncomingText;
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: theme.spacing.sm,
        marginBottom: theme.spacing.xs,
        opacity: 0.75,
      }}
    >
      <View style={{ width: theme.spacing.xs / 2, borderRadius: theme.radius.pill, backgroundColor: color }} />
      <View style={{ flex: 1 }}>
        <Label variant="caption" style={{ color }}>
          {isOutgoing(message) ? chatCopy.you : peerName}
        </Label>
        <Label variant="caption" numberOfLines={1} style={{ color }}>
          {message.body ?? (message.kind === 'image' ? chatCopy.photoPreview : chatCopy.filePreview)}
        </Label>
      </View>
    </View>
  );
}

/**
 * A photo, or a file.
 *
 * The bytes travel on their own channel and can take minutes over Bluetooth, so
 * a file is drawn from its description the moment the message arrives and only
 * becomes a picture once it is actually here. Nothing pretends to be further
 * along than it is.
 */
function Attachment({
  view,
  isImage,
  onAccent,
}: {
  view: AttachmentView;
  isImage: boolean;
  onAccent: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const color = onAccent ? theme.colors.bubbleOutgoingText : theme.colors.bubbleIncomingText;

  if (isImage && view.localPath) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        accessibilityLabel={view.name}
        source={{ uri: toFileUri(view.localPath) }}
        style={{
          width: IMAGE_WIDTH,
          height: IMAGE_WIDTH,
          borderRadius: theme.radius.md,
          marginBottom: theme.spacing.xs,
          backgroundColor: theme.colors.surfaceElevated,
        }}
        resizeMode="cover"
      />
    );
  }

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        marginBottom: theme.spacing.xs,
        paddingVertical: theme.spacing.xs,
      }}
    >
      <View
        style={{
          width: FILE_ICON_SIZE,
          height: FILE_ICON_SIZE,
          borderRadius: theme.radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: color,
          opacity: 0.8,
        }}
      >
        <Label variant="footnote" style={{ color }}>
          {isImage ? '▣' : '◫'}
        </Label>
      </View>
      <View style={{ flex: 1 }}>
        <Label variant="footnote" numberOfLines={1} style={{ color }}>
          {view.name}
        </Label>
        <Label variant="caption" numberOfLines={1} style={{ color, opacity: 0.75 }}>
          {view.localPath ? fileSize(view.sizeBytes) : strings.share.receiving}
        </Label>
      </View>
    </View>
  );
}

/** Reactions sit under the bubble they belong to, on the same side. */
function Reactions({
  reactions,
  mine,
  onToggle,
}: {
  reactions: readonly Reaction[];
  mine: boolean;
  onToggle: (emoji: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const grouped = useMemo(() => {
    const counts = new Map<string, { count: number; own: boolean }>();
    for (const reaction of reactions) {
      const existing = counts.get(reaction.emoji);
      if (existing) {
        existing.count += 1;
        existing.own = existing.own || isOwnReaction(reaction);
      } else {
        counts.set(reaction.emoji, { count: 1, own: isOwnReaction(reaction) });
      }
    }
    return [...counts.entries()];
  }, [reactions]);

  return (
    <View
      style={{
        flexDirection: 'row',
        gap: theme.spacing.xs,
        marginTop: -theme.spacing.xs,
        marginHorizontal: theme.spacing.sm,
        alignSelf: mine ? 'flex-end' : 'flex-start',
      }}
    >
      {grouped.map(([emoji, { count, own }]) => (
        <Pressable
          key={emoji}
          accessibilityRole="button"
          accessibilityLabel={chatCopy.reactionCount(emoji, count)}
          accessibilityState={{ selected: own }}
          onPress={() => onToggle(emoji)}
          // A pill is 20pt tall; the target around it has to reach 44.
          hitSlop={theme.spacing.md}
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs / 2,
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.xs / 2,
              borderRadius: theme.radius.pill,
              backgroundColor: own ? theme.colors.accentMuted : theme.colors.surfaceElevated,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.colors.separator,
            },
            pressed ? { opacity: 0.7 } : null,
          ]}
        >
          <Label variant="caption">{emoji}</Label>
          {count > 1 ? (
            <Label variant="caption" tone="secondary">
              {String(count)}
            </Label>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

/** Kilobytes and megabytes, never bytes: nobody needs six digits in a bubble. */
function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

function toFileUri(path: string): string {
  return path.startsWith('file://') || path.startsWith('content://') ? path : `file://${path}`;
}
