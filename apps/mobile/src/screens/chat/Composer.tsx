import React from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextStyle } from 'react-native';
import { CHAT_LIMITS } from '@airlink/core';
import { strings } from '@airlink/config';
import type { Message } from '@airlink/db';
import { Label, haptic, useTheme } from '../../ui/index.js';
import { isOutgoing } from './chatCenter.js';
import { chatCopy } from './chatStrings.js';

/**
 * The composer.
 *
 * It never disables itself because nobody is in range. That is the single most
 * important decision on this screen: AirLink is for the moment your friend has
 * put their phone away, and a text box that refuses to open then would be the
 * worst thing this app could do. What is typed is kept, and it goes when they
 * come back.
 *
 * The only thing that can disable Send is an empty box.
 */

const SEND_SIZE = 44;
const INPUT_MAX_HEIGHT = 132;

export function Composer({
  value,
  onChangeText,
  onSend,
  replyTo,
  peerName,
  onCancelReply,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  replyTo: Message | null;
  peerName: string;
  onCancelReply: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const canSend = value.trim().length > 0;

  return (
    <View
      style={{
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.separator,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: theme.spacing.md,
        paddingTop: theme.spacing.sm,
        paddingBottom: theme.spacing.sm,
      }}
    >
      {replyTo ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            paddingBottom: theme.spacing.sm,
          }}
        >
          <View
            style={{
              width: theme.spacing.xs / 2,
              alignSelf: 'stretch',
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.accent,
            }}
          />
          <View style={{ flex: 1 }}>
            <Label variant="caption" tone="accent">
              {chatCopy.replyingTo(isOutgoing(replyTo) ? chatCopy.you : peerName)}
            </Label>
            <Label variant="footnote" tone="secondary" numberOfLines={1}>
              {replyTo.body ?? (replyTo.kind === 'image' ? chatCopy.photoPreview : chatCopy.filePreview)}
            </Label>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={chatCopy.cancelReply}
            onPress={onCancelReply}
            hitSlop={theme.spacing.sm}
            style={({ pressed }) => [
              { width: SEND_SIZE, height: SEND_SIZE, alignItems: 'center', justifyContent: 'center' },
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <Label variant="body" tone="tertiary">
              ✕
            </Label>
          </Pressable>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm }}>
        <TextInput
          accessibilityLabel={chatCopy.composerLabel}
          value={value}
          onChangeText={onChangeText}
          placeholder={strings.chat.placeholder}
          placeholderTextColor={theme.colors.textTertiary}
          multiline
          // `maxLength` counts UTF-16 units where the wire limit counts code
          // points, so this stops slightly short of the protocol's ceiling for
          // text full of emoji. Erring that way is the safe one: the box can
          // never accept a message the encoder would then refuse.
          maxLength={CHAT_LIMITS.maxBodyCodePoints}
          style={[
            theme.typography.body as TextStyle,
            {
              flex: 1,
              color: theme.colors.text,
              backgroundColor: theme.colors.surfaceElevated,
              borderRadius: theme.radius.xl,
              paddingHorizontal: theme.spacing.md,
              paddingTop: theme.spacing.sm,
              paddingBottom: theme.spacing.sm,
              minHeight: SEND_SIZE,
              maxHeight: INPUT_MAX_HEIGHT,
            },
          ]}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={chatCopy.sendLabel}
          accessibilityState={{ disabled: !canSend }}
          accessibilityHint={canSend ? undefined : chatCopy.sendHintEmpty}
          disabled={!canSend}
          onPress={() => {
            haptic('impactLight');
            onSend();
          }}
          style={({ pressed }) => [
            {
              width: SEND_SIZE,
              height: SEND_SIZE,
              borderRadius: theme.radius.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: canSend ? theme.colors.accent : theme.colors.surfaceElevated,
            },
            pressed ? { opacity: 0.75 } : null,
          ]}
        >
          <Label variant="headline" tone={canSend ? 'onAccent' : 'tertiary'}>
            ↑
          </Label>
        </Pressable>
      </View>
    </View>
  );
}
