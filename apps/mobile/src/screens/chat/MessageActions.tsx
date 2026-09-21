import React from 'react';
import { Modal, Pressable, View } from 'react-native';
import { strings } from '@airlink/config';
import type { Message } from '@airlink/db';
import { Divider, Label, haptic, useTheme } from '../../ui/index.js';
import { chatCopy } from './chatStrings.js';

/**
 * What you can do to one message.
 *
 * A sheet of our own rather than `ActionSheetIOS`, because half the people on
 * the plane are on Android and a chat that behaves differently on the two is a
 * chat nobody trusts.
 *
 * Reacting is the one action that genuinely needs the other phone: a reaction
 * has no outbox to wait in, unlike a message. So it is disabled with the reason
 * written out, rather than tapping into nothing.
 */

/** Deliberately six, and deliberately the six everyone already uses. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '‼️', '😮', '🙏'] as const;

const ROW_HEIGHT = 52;
const EMOJI_TARGET = 44;

export function MessageActions({
  message,
  peerName,
  canReact,
  onReply,
  onReact,
  onCopy,
  onDelete,
  onReport,
  onClose,
}: {
  message: Message | null;
  peerName: string;
  canReact: boolean;
  onReply: (message: Message) => void;
  onReact: (message: Message, emoji: string) => void;
  onCopy: (message: Message) => void;
  onDelete: (message: Message) => void;
  /**
   * Absent for your own messages: reporting yourself is not a thing, and an
   * inert row would be the reviewer's first tap.
   */
  onReport?: (message: Message) => void;
  onClose: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const visible = message !== null;
  const hasText = (message?.body ?? '').length > 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.common.close}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' }}
      >
        {/* A press inside the sheet must not close it. */}
        <Pressable
          accessible={false}
          onPress={() => undefined}
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.xl,
              borderTopRightRadius: theme.radius.xl,
              paddingHorizontal: theme.spacing.lg,
              paddingTop: theme.spacing.lg,
              paddingBottom: theme.spacing.xxl,
            },
            theme.shadows.sheet,
          ]}
        >
          {message ? (
            <>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  opacity: canReact ? 1 : 0.4,
                }}
              >
                {QUICK_REACTIONS.map((emoji) => (
                  <Pressable
                    key={emoji}
                    accessibilityRole="button"
                    accessibilityLabel={emoji}
                    accessibilityState={{ disabled: !canReact }}
                    disabled={!canReact}
                    onPress={() => {
                      haptic('selection');
                      onReact(message, emoji);
                    }}
                    style={({ pressed }) => [
                      {
                        width: EMOJI_TARGET,
                        height: EMOJI_TARGET,
                        borderRadius: theme.radius.pill,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: theme.colors.surfaceElevated,
                      },
                      pressed ? { opacity: 0.7 } : null,
                    ]}
                  >
                    <Label variant="title2">{emoji}</Label>
                  </Pressable>
                ))}
              </View>

              {!canReact ? (
                <Label variant="footnote" tone="tertiary" align="center" style={{ marginTop: theme.spacing.sm }}>
                  {chatCopy.reactOffline(peerName)}
                </Label>
              ) : null}

              <View style={{ marginTop: theme.spacing.lg }}>
                <ActionRow
                  title={strings.chat.reply}
                  onPress={() => onReply(message)}
                />
                <Divider />
                <ActionRow
                  title={strings.chat.copy}
                  onPress={() => onCopy(message)}
                  disabled={!hasText}
                  // A photo has nothing to put on the clipboard.
                  disabledReason={chatCopy.copyNeedsText}
                />
                <Divider />
                <ActionRow title={strings.chat.deleteForMe} destructive onPress={() => onDelete(message)} />
                {/* Reachable from the offending message in one long press.
                    Blocking used to live three screens away under You →
                    Friends, and only worked on an accepted friend - which is
                    never who you want to block. */}
                {onReport && message ? (
                  <>
                    <Divider />
                    <ActionRow
                      title={strings.chat.report}
                      destructive
                      onPress={() => onReport(message)}
                    />
                  </>
                ) : null}
              </View>

              <View style={{ marginTop: theme.spacing.md }}>
                <ActionRow title={strings.common.cancel} onPress={onClose} centred />
              </View>
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionRow({
  title,
  onPress,
  destructive = false,
  disabled = false,
  disabledReason,
  centred = false,
}: {
  title: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  centred?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled }}
        accessibilityHint={disabled ? disabledReason : undefined}
        disabled={disabled}
        onPress={() => {
          haptic('selection');
          onPress();
        }}
        style={({ pressed }) => [
          {
            minHeight: ROW_HEIGHT,
            justifyContent: 'center',
            alignItems: centred ? 'center' : 'flex-start',
            opacity: disabled ? 0.4 : 1,
          },
          pressed ? { opacity: 0.6 } : null,
        ]}
      >
        <Label variant="body" tone={destructive ? 'danger' : 'primary'}>
          {title}
        </Label>
      </Pressable>
      {disabled && disabledReason ? (
        <Label variant="caption" tone="tertiary" style={{ marginBottom: theme.spacing.sm }}>
          {disabledReason}
        </Label>
      ) : null}
    </View>
  );
}
