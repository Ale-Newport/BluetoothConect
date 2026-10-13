import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, TextInput, View, type TextStyle } from 'react-native';
import { CHAT_LIMITS } from '@airlink/core';
import { areaColor, areaColorMuted, strings } from '@airlink/config';
import type { Message } from '@airlink/db';
import { Icon, Label, haptic, useTheme, type IconName } from '../../ui/index.js';
import { audio } from '../../native/audio.js';
import { isOutgoing } from './chatCenter.js';
import {
  MIN_VOICE_MS,
  chooseFile,
  choosePhoto,
  clockDuration,
  takePhoto,
  voiceAttachment,
  type AttachmentChoice,
  type OutgoingAttachment,
} from './attachments.js';
import { AttachSheet, type AttachChoice } from './AttachSheet.js';
import { chatCopy } from './chatStrings.js';

/**
 * The composer.
 *
 * It never disables itself because nobody is in range. That is the single most
 * important decision on this screen: AirLink is for the moment your friend has
 * put their phone away, and a text box that refuses to open then would be the
 * worst thing this app could do. What is typed is kept, and it goes when they
 * come back. A photo and a voice note behave the same way.
 *
 * THE BAR, LEFT TO RIGHT: a plus that offers a photo or a file, the text box,
 * and - while the box is empty - the camera and the microphone. The moment
 * something is typed those two give way to Send, in the same place the
 * microphone was, so the thumb that was about to record is already over the
 * button that sends. That is the arrangement everyone already has in their
 * hands from the messaging apps they use every day, and a messenger is the one
 * kind of app where being unfamiliar is a cost.
 *
 * Send exists only when there is something to send, so an empty box has no
 * disabled button to explain; the microphone is what sits there instead.
 *
 * RECORDING IS A TAP, NOT A HOLD. Hold-to-talk is the familiar gesture and it
 * was deliberately not used: it is unusable with VoiceOver, it is unusable for
 * anyone who cannot keep a finger still, and slide-to-cancel is a gesture with
 * nothing on screen to discover it by. Instead the microphone opens a bar that
 * replaces the text row entirely - a red dot, the seconds counting up, a live
 * level, and two labelled controls. There is no state you can be in without
 * being told which one it is.
 */

/** Every control in the bar is this tall, which is also the text box's minimum. */
const SEND_SIZE = 44;
const INPUT_MAX_HEIGHT = 132;
const BAR_ICON_SIZE = 28;
const ROUND_ICON_SIZE = 22;
/** How often the recording bar re-reads the clock. */
const TICK_MS = 250;

/**
 * The longest voice note this app will record.
 *
 * Not a technical limit - it is a kindness to the link. Recorded AAC is roughly
 * 2 KB per second, so two minutes is about 240 KB, which is under ten seconds
 * even on Bluetooth. Past that a voice message stops being a message. The
 * recording stops by itself and is offered, never thrown away.
 */
const MAX_VOICE_MS = 120_000;

type RecordState =
  | { readonly phase: 'idle' }
  /** The permission sheet is up, or the recorder is starting. */
  | { readonly phase: 'arming' }
  | { readonly phase: 'recording'; readonly startedAt: number };

export function Composer({
  value,
  onChangeText,
  onSend,
  onAttach,
  onNotice,
  replyTo,
  peerName,
  onCancelReply,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  /** A photo or a recording, ready to become a message. */
  onAttach: (attachment: OutgoingAttachment) => void;
  /** Anything the person needs told: a denied permission, a failed picker. */
  onNotice: (message: string) => void;
  replyTo: Message | null;
  peerName: string;
  onCancelReply: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const canSend = value.trim().length > 0;

  const [picking, setPicking] = useState<PickKind | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** What the sheet was asked for, started once the sheet has left the screen. */
  const chosen = useRef<AttachChoice | null>(null);
  const [record, setRecord] = useState<RecordState>({ phase: 'idle' });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const recording = record.phase === 'recording';

  // A ref as well as state because the unmount cleanup below runs with the
  // state it closed over, and a recording left running on the native side would
  // hold the microphone - and the red status bar - after the screen has gone.
  const recordingRef = useRef(false);
  recordingRef.current = recording;

  useEffect(() => {
    if (record.phase !== 'recording') return;
    const startedAt = record.startedAt;
    const offLevel = audio.onLevel(setLevel);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), TICK_MS);
    return () => {
      offLevel();
      clearInterval(timer);
    };
  }, [record]);

  useEffect(
    () => () => {
      if (recordingRef.current) void audio.cancelRecording();
    },
    [],
  );

  const stopRecording = useCallback(
    async (keep: boolean) => {
      setRecord({ phase: 'idle' });
      setElapsedMs(0);
      setLevel(0);
      if (!keep) {
        void audio.cancelRecording();
        return;
      }
      try {
        const recorded = await audio.stopRecording();
        // A mis-tap on the microphone produces a file of silence; sending it
        // would be worse than saying nothing happened.
        if (recorded.durationMs < MIN_VOICE_MS || recorded.sizeBytes <= 0) {
          onNotice(chatCopy.voiceTooShort);
          return;
        }
        haptic('impactLight');
        onAttach(voiceAttachment(recorded));
      } catch {
        onNotice(chatCopy.voiceFailed);
      }
    },
    [onAttach, onNotice],
  );

  // Two minutes in, the bar sends what it has rather than recording into the
  // night. Stopping without sending would throw away what the user just said.
  useEffect(() => {
    if (!recording || elapsedMs < MAX_VOICE_MS) return;
    void stopRecording(true);
  }, [recording, elapsedMs, stopRecording]);

  const startPicker = useCallback(
    (kind: PickKind) => {
      if (picking) return;
      setPicking(kind);
      void (async () => {
        const choice: AttachmentChoice =
          kind === 'camera' ? await takePhoto() : kind === 'file' ? await chooseFile() : await choosePhoto();
        setPicking(null);
        if (choice.status === 'picked') {
          haptic('impactLight');
          onAttach(choice.attachment);
        } else if (choice.status === 'failed') {
          onNotice(choice.message);
        }
      })();
    },
    [onAttach, onNotice, picking],
  );

  const startChosen = useCallback(() => {
    const kind = chosen.current;
    chosen.current = null;
    if (kind) startPicker(kind);
  }, [startPicker]);

  const onChoose = useCallback(
    (kind: AttachChoice) => {
      chosen.current = kind;
      setSheetOpen(false);
      // Android's modal has no "finished leaving" callback; a beat is the
      // closest thing it offers. iOS starts the picker from `onDismiss`.
      if (Platform.OS !== 'ios') setTimeout(startChosen, 250);
    },
    [startChosen],
  );

  const onMicrophone = useCallback(() => {
    if (record.phase !== 'idle') return;
    if (!audio.isAvailable()) {
      // An older build, or a test. Saying so is the whole of the degradation:
      // nothing below this line can work without the recorder.
      onNotice(chatCopy.voiceUnavailable);
      return;
    }
    setRecord({ phase: 'arming' });
    void (async () => {
      const permission = await audio.getPermission();
      const granted =
        permission === 'granted' ? true : permission === 'denied' ? false : await audio.requestPermission();
      if (!granted) {
        setRecord({ phase: 'idle' });
        // Denied is not silence: iOS asks once, and after that the only way
        // back is Settings, which the message names.
        onNotice(chatCopy.micDenied);
        return;
      }
      try {
        await audio.startRecording();
      } catch {
        setRecord({ phase: 'idle' });
        onNotice(chatCopy.voiceFailed);
        return;
      }
      haptic('impactLight');
      setElapsedMs(0);
      setRecord({ phase: 'recording', startedAt: Date.now() });
    })();
  }, [onNotice, record.phase]);

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
      {replyTo && !recording ? (
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
              {replyTo.body ?? previewOf(replyTo)}
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

      {recording ? (
        <RecordingBar
          elapsedMs={elapsedMs}
          level={level}
          onCancel={() => {
            haptic('warning');
            void stopRecording(false);
          }}
          onSend={() => void stopRecording(true)}
        />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.xs }}>
          <BarIconButton
            icon="plus"
            label={chatCopy.attachLabel}
            hint={chatCopy.attachHint}
            busy={picking === 'library' || picking === 'file'}
            onPress={() => setSheetOpen(true)}
          />

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
                marginHorizontal: theme.spacing.xs,
                minHeight: SEND_SIZE,
                maxHeight: INPUT_MAX_HEIGHT,
              },
            ]}
          />

          {canSend ? (
            <RoundButton
              icon="send"
              label={chatCopy.sendLabel}
              background={theme.colors.accent}
              color={theme.colors.onAccent}
              onPress={() => {
                haptic('impactLight');
                onSend();
              }}
            />
          ) : (
            <>
              <BarIconButton
                icon="photoCamera"
                label={chatCopy.cameraLabel}
                hint={chatCopy.cameraHint}
                busy={picking === 'camera'}
                onPress={() => startPicker('camera')}
              />
              <RoundButton
                icon="microphone"
                label={chatCopy.recordLabel}
                hint={chatCopy.recordingHint}
                busy={record.phase === 'arming'}
                background={theme.colors.accent}
                color={theme.colors.onAccent}
                onPress={onMicrophone}
              />
            </>
          )}
        </View>
      )}

      <AttachSheet
        visible={sheetOpen}
        onChoose={onChoose}
        onClose={() => {
          chosen.current = null;
          setSheetOpen(false);
        }}
        onDismiss={startChosen}
      />
    </View>
  );
}

/** Where a photo or a file is coming from. */
type PickKind = 'library' | 'file' | 'camera';

/**
 * A plain icon in the bar - the plus and the camera.
 *
 * No background: they are quiet offers beside the text box, and the one thing
 * on this bar that gets a coloured disc is the action the thumb is about to
 * take (record, or send).
 */
function BarIconButton({
  icon,
  label,
  hint,
  busy,
  onPress,
}: {
  icon: IconName;
  label: string;
  hint: string;
  busy: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ busy }}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => [
        { width: SEND_SIZE, height: SEND_SIZE, alignItems: 'center', justifyContent: 'center' },
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={theme.colors.text} />
      ) : (
        <Icon name={icon} size={BAR_ICON_SIZE} color={theme.colors.text} />
      )}
    </Pressable>
  );
}

/** The filled disc at the right-hand end: the microphone, or Send. */
function RoundButton({
  icon,
  label,
  hint,
  busy = false,
  background,
  color,
  onPress,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  busy?: boolean;
  background: string;
  color: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ busy }}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: SEND_SIZE,
          height: SEND_SIZE,
          borderRadius: theme.radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: background,
        },
        pressed ? { opacity: 0.75 } : null,
      ]}
    >
      {busy ? <ActivityIndicator color={color} /> : <Icon name={icon} size={ROUND_ICON_SIZE} color={color} />}
    </Pressable>
  );
}

/**
 * What the composer becomes while the microphone is open.
 *
 * It replaces the text row rather than sitting beside it, because the one thing
 * a person needs to be certain of here is whether they are being recorded. A
 * counter that only ever climbs, a meter that moves with their voice, and the
 * word Cancel in full.
 */
function RecordingBar({
  elapsedMs,
  level,
  onCancel,
  onSend,
}: {
  elapsedMs: number;
  /** 0..1 from the recorder. */
  level: number;
  onCancel: () => void;
  onSend: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const remaining = Math.max(0, MAX_VOICE_MS - elapsedMs);
  return (
    <View
      accessible
      accessibilityLabel={chatCopy.recordingNow}
      accessibilityHint={chatCopy.recordingHint}
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}
    >
      <View
        style={{
          width: theme.spacing.sm,
          height: theme.spacing.sm,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.danger,
          // The dot follows the voice, so silence looks like silence.
          opacity: 0.55 + Math.min(1, Math.max(0, level)) * 0.45,
        }}
      />
      <Label variant="footnote" tone="danger">
        {clockDuration(elapsedMs)}
      </Label>

      <View
        style={{
          flex: 1,
          height: theme.spacing.xs,
          borderRadius: theme.radius.pill,
          backgroundColor: areaColorMuted(theme.colors, 'Chat'),
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`,
            height: '100%',
            borderRadius: theme.radius.pill,
            backgroundColor: areaColor(theme.colors, 'Chat'),
          }}
        />
      </View>

      {/* The last ten seconds get a countdown rather than a surprise. */}
      {remaining <= 10_000 ? (
        <Label variant="caption" tone="tertiary">
          {clockDuration(remaining)}
        </Label>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={chatCopy.discardVoiceLabel}
        onPress={onCancel}
        hitSlop={theme.spacing.sm}
        style={({ pressed }) => [
          { minHeight: SEND_SIZE, justifyContent: 'center', paddingHorizontal: theme.spacing.xs },
          pressed ? { opacity: 0.6 } : null,
        ]}
      >
        <Label variant="footnote" tone="danger">
          {chatCopy.discardVoice}
        </Label>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={chatCopy.sendVoiceLabel}
        onPress={onSend}
        style={({ pressed }) => [
          {
            width: SEND_SIZE,
            height: SEND_SIZE,
            borderRadius: theme.radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.accent,
          },
          pressed ? { opacity: 0.75 } : null,
        ]}
      >
        <Label variant="headline" tone="onAccent">
          ↑
        </Label>
      </Pressable>
    </View>
  );
}

/** What a quoted message says when it has no words of its own. */
function previewOf(message: Message): string {
  if (message.kind === 'image') return chatCopy.photoPreview;
  if (message.kind === 'voice') return chatCopy.voicePreview;
  return chatCopy.filePreview;
}
