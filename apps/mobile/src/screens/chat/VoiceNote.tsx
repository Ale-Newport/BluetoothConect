import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, View } from 'react-native';
import { areaColor } from '@airlink/config';
import { Icon, Label, haptic, useTheme } from '../../ui/index.js';
import { audio } from '../../native/audio.js';
import { clockDuration } from './attachments.js';
import { chatCopy } from './chatStrings.js';

/**
 * A voice message, played.
 *
 * There is one recorder and one speaker on a phone, so there is one player in
 * this app: starting a note stops whichever one was going. That is enforced
 * here, in a module-level register, rather than by each bubble minding its own
 * business - a list of twenty notes all holding their own idea of "playing" is
 * how two of them end up talking over each other.
 *
 * The bars are not a waveform. Drawing a real one means decoding the file for
 * every bubble on screen, which over a Bluetooth link is a file that may not
 * even be here yet; these are derived from the message id, so they are stable
 * across renders, different between messages, and honest about being decoration
 * - the progress they fill is real.
 */

const BAR_COUNT = 26;
const BAR_WIDTH = 3;
const BAR_MIN = 4;
const BAR_MAX = 22;
const CONTROL_SIZE = 36;
/** The bubble is narrower than a photo: a voice note is a line, not a picture. */
const NOTE_WIDTH = 190;

// -- who is playing ---------------------------------------------------------

let playingId: string | null = null;
const playingListeners = new Set<() => void>();

function setPlayingId(id: string | null): void {
  if (playingId === id) return;
  playingId = id;
  for (const listener of [...playingListeners]) listener();
}

function subscribePlaying(listener: () => void): () => void {
  playingListeners.add(listener);
  return () => {
    playingListeners.delete(listener);
  };
}

function readPlaying(): string | null {
  return playingId;
}

/**
 * Bar heights from an id.
 *
 * A small deterministic hash, walked one character at a time. Nothing here is
 * cryptographic and nothing depends on the distribution being good - it only
 * has to be the same every time the same message is drawn.
 */
function barsFor(id: string): readonly number[] {
  // A Lehmer generator, deliberately in plain arithmetic: every intermediate
  // stays well inside a double's exact integer range, so this produces the same
  // bars on every engine rather than depending on 32-bit wrapping.
  const MODULUS = 2147483647;
  let seed = 1;
  for (let index = 0; index < id.length; index++) {
    seed = (seed * 31 + id.charCodeAt(index)) % MODULUS;
  }
  const bars: number[] = [];
  const span = BAR_MAX - BAR_MIN + 1;
  for (let index = 0; index < BAR_COUNT; index++) {
    seed = (seed * 48271) % MODULUS;
    bars.push(BAR_MIN + (seed % span));
  }
  return bars;
}

export function VoiceNote({
  messageId,
  durationMs,
  path,
  onAccent,
}: {
  messageId: string;
  /** What the sender's recorder measured. Null for a note still on its way. */
  durationMs: number | null;
  /** Null until the bytes are on this phone; the control waits rather than lying. */
  path: string | null;
  onAccent: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const current = useSyncExternalStore(subscribePlaying, readPlaying);
  const playing = current === messageId;
  const [positionMs, setPositionMs] = useState(0);

  const bars = useMemo(() => barsFor(messageId), [messageId]);
  const available = audio.isAvailable() && path !== null;

  // Progress follows the player while this note is the one playing, and resets
  // the moment another takes over - a half-filled bar on a note that stopped
  // being the one you are listening to is a small lie the list tells twenty
  // times over.
  useEffect(() => {
    if (!playing) {
      setPositionMs(0);
      return;
    }
    const offProgress = audio.onPlaybackProgress(({ positionMs: at }) => setPositionMs(at));
    const offFinished = audio.onPlaybackFinished(() => {
      setPlayingId(null);
      setPositionMs(0);
    });
    return () => {
      offProgress();
      offFinished();
    };
  }, [playing]);

  // Leaving the conversation with a note playing must not leave it playing.
  useEffect(
    () => () => {
      if (playingId === messageId) {
        setPlayingId(null);
        void audio.stopPlayback();
      }
    },
    [messageId],
  );

  const onToggle = useCallback(() => {
    haptic('selection');
    if (playing) {
      setPlayingId(null);
      void audio.stopPlayback();
      return;
    }
    if (!available || path === null) return;
    // Claim the register first, which stops whatever else was going through its
    // own effect, and only then ask the player to switch.
    setPlayingId(messageId);
    void (async () => {
      try {
        await audio.stopPlayback();
        await audio.play(path);
      } catch {
        // A file that will not open is not worth an alert in a bubble; the
        // control simply comes back to rest.
        setPlayingId(null);
      }
    })();
  }, [available, messageId, path, playing]);

  const total = durationMs ?? 0;
  const played = total > 0 ? Math.min(1, positionMs / total) : 0;
  const spoken = clockDuration(playing && positionMs > 0 ? positionMs : durationMs);

  const tint = onAccent ? theme.colors.bubbleOutgoingText : areaColor(theme.colors, 'Chat');
  const rest = onAccent ? theme.colors.bubbleOutgoingText : theme.colors.textTertiary;

  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={chatCopy.voiceOf(clockDuration(durationMs))}
      accessibilityState={{ disabled: !available }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        width: NOTE_WIDTH,
        marginBottom: theme.spacing.xs,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? chatCopy.pauseVoice : chatCopy.playVoice}
        accessibilityState={{ disabled: !available }}
        disabled={!available}
        onPress={onToggle}
        hitSlop={theme.spacing.sm}
        style={({ pressed }) => [
          {
            width: CONTROL_SIZE,
            height: CONTROL_SIZE,
            borderRadius: theme.radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: onAccent ? theme.colors.bubbleOutgoingText : areaColor(theme.colors, 'Chat'),
            opacity: available ? 1 : 0.4,
          },
          pressed ? { opacity: 0.7 } : null,
        ]}
      >
        <Icon
          name={playing ? 'pause' : 'start'}
          size={CONTROL_SIZE * 0.55}
          color={onAccent ? theme.colors.bubbleOutgoing : theme.colors.onAccent}
        />
      </Pressable>

      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: BAR_MAX }}>
          {bars.map((height, index) => (
            <View
              key={index}
              style={{
                width: BAR_WIDTH,
                height,
                borderRadius: BAR_WIDTH / 2,
                backgroundColor: index / BAR_COUNT <= played ? tint : rest,
                opacity: index / BAR_COUNT <= played ? 1 : 0.35,
              }}
            />
          ))}
        </View>
        <Label
          variant="caption"
          style={{
            color: onAccent ? theme.colors.bubbleOutgoingText : theme.colors.textSecondary,
            marginTop: theme.spacing.xs / 2,
          }}
        >
          {spoken}
        </Label>
      </View>
    </View>
  );
}
