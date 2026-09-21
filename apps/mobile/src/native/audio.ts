/**
 * The seam between the app and the microphone.
 *
 * Recording a voice message, playing one back, and the waveform in between.
 * Nothing here knows what a conversation is; it hands back a file path and the
 * chat layer decides what to do with it.
 *
 * WHY THE FILES ARE SO SMALL. A voice note does not go to a server - there is
 * no server - it goes down a Bluetooth link at roughly 40 KB a second. The
 * native side records mono AAC at 24 kbps, so a minute of speech is about
 * 180 KB and arrives in a few seconds; the settings a phone would normally
 * reach for would make the same minute close to a megabyte, which the user
 * would experience not as a large file but as an app that had frozen. See
 * AudioRecorder.swift for the full reasoning.
 *
 * DEGRADATION. When the native module is missing - an older build, or a Jest
 * run, where there is no native side at all - `isAvailable()` is false and
 * every method resolves to a harmless default instead of throwing. When the
 * module IS present, a real failure is passed on rather than swallowed:
 * "your recording was interrupted by a phone call" is something the person
 * holding the phone needs to be told, and a wrapper that quietly resolved would
 * hand the chat layer a voice message that does not exist.
 */
import {
  NativeAirLinkAudio,
  type NativeAirLinkAudioSpec,
  type NativeAudioFinishedEvent,
  type NativeAudioLevelEvent,
  type NativeAudioProgressEvent,
} from '@airlink/native-transport';

/**
 * One narrowed handle to the module, because `TurboModuleRegistry.get` is typed
 * as `Spec | null | undefined` and checking for both at eleven call sites reads
 * like the absence is an edge case rather than the ordinary state of a Jest
 * run. Binding it to a `const` is also what lets TypeScript keep the narrowing
 * inside the closures below.
 */
const native: NativeAirLinkAudioSpec | null = NativeAirLinkAudio ?? null;

export type AudioPermission = 'granted' | 'denied' | 'notAsked' | 'unsupported';

export interface Recording {
  /**
   * Absolute path to the m4a file. EMPTY when there is no native module: an
   * empty path is not a recording and must never be sent.
   */
  readonly path: string;
  readonly durationMs: number;
  readonly sizeBytes: number;
}

export interface PlaybackProgress {
  readonly positionMs: number;
  readonly durationMs: number;
}

/** What `stopRecording` resolves with when there is no native module at all. */
const NO_RECORDING: Recording = { path: '', durationMs: 0, sizeBytes: 0 };

function toPermission(value: string): AudioPermission {
  switch (value) {
    case 'granted':
    case 'denied':
    case 'notAsked':
      return value;
    default:
      // Never guess. Reporting a permission the OS did not give would put a
      // record button in front of somebody whose microphone is off.
      return 'unsupported';
  }
}

/**
 * One native subscription per event, shared by every caller.
 *
 * The waveform subscribes and unsubscribes every time the record button is
 * held, and a chat full of voice messages can have a dozen bubbles listening
 * for progress. One bridge listener each, torn down when the last caller goes,
 * is what keeps that from accumulating.
 */
function createFanOut<TNative, TPublic>(
  subscribe: ((handler: (event: TNative) => void) => { remove: () => void }) | null,
  translate: (event: TNative) => TPublic,
): (callback: (event: TPublic) => void) => () => void {
  const listeners = new Set<(event: TPublic) => void>();
  let subscription: { remove: () => void } | null = null;

  return (callback) => {
    listeners.add(callback);
    if (subscription === null && subscribe !== null) {
      subscription = subscribe((event) => {
        const translated = translate(event);
        // A copy, because a listener that unsubscribes itself while being
        // called - which is what a bubble does when playback finishes - would
        // otherwise mutate the set mid-iteration.
        for (const listener of [...listeners]) listener(translated);
      });
    }
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0 && subscription !== null) {
        subscription.remove();
        subscription = null;
      }
    };
  };
}

const onLevel = createFanOut<NativeAudioLevelEvent, number>(
  native === null ? null : (handler) => native.onLevel(handler),
  (event) => event.level,
);

const onPlaybackProgress = createFanOut<NativeAudioProgressEvent, PlaybackProgress>(
  native === null ? null : (handler) => native.onPlaybackProgress(handler),
  (event) => ({ positionMs: event.positionMs, durationMs: event.durationMs }),
);

const onPlaybackFinished = createFanOut<NativeAudioFinishedEvent, void>(
  native === null ? null : (handler) => native.onPlaybackFinished(handler),
  // The native event carries which file finished and whether it got to the end.
  // Neither is in the contract callers were given: a bubble only needs to know
  // that it should stop animating, and it already knows which file it is.
  () => undefined,
);

export const audio = {
  isAvailable(): boolean {
    return native !== null;
  },

  async getPermission(): Promise<AudioPermission> {
    if (native === null) return 'unsupported';
    try {
      return toPermission(await native.getPermission());
    } catch {
      return 'unsupported';
    }
  },

  async requestPermission(): Promise<boolean> {
    if (native === null) return false;
    try {
      return await native.requestPermission();
    } catch {
      return false;
    }
  },

  /**
   * Begin recording.
   *
   * Rejects when the microphone was refused, or when a recording is already
   * running - never silently replaces one, because a caller that thought it was
   * still recording the first note would go on to send the second in its place.
   */
  async startRecording(): Promise<void> {
    if (native === null) return;
    await native.startRecording();
  },

  /**
   * Finish and hand back the file.
   *
   * Rejects when the recording was cut short by something outside the app - a
   * phone call, most often. That is deliberately not swallowed: the file has
   * already been deleted by then, and resolving would hand the chat layer a
   * voice message that is not there.
   */
  async stopRecording(): Promise<Recording> {
    if (native === null) return NO_RECORDING;
    const recording = await native.stopRecording();
    return {
      path: recording.path,
      durationMs: recording.durationMs,
      sizeBytes: recording.sizeBytes,
    };
  },

  /** Abandon the recording and delete the file. Never rejects. */
  async cancelRecording(): Promise<void> {
    if (native === null) return;
    try {
      await native.cancelRecording();
    } catch {
      // There is nothing a caller could do about a failed cancel, and it is
      // usually called from a gesture handler that has already moved on.
    }
  },

  /** Play a recorded file. Rejects when the file cannot be opened. */
  async play(path: string): Promise<void> {
    if (native === null) return;
    await native.play(path);
  },

  /** Stop playback if anything is playing. Never rejects. */
  async stopPlayback(): Promise<void> {
    if (native === null) return;
    try {
      await native.stopPlayback();
    } catch {
      // As with cancel: nothing useful to do, and it is called on unmount.
    }
  },

  /** Microphone level, 0 to 1, about ten times a second while recording. */
  onLevel(callback: (level: number) => void): () => void {
    return onLevel(callback);
  },

  onPlaybackProgress(callback: (event: PlaybackProgress) => void): () => void {
    return onPlaybackProgress(callback);
  },

  onPlaybackFinished(callback: () => void): () => void {
    return onPlaybackFinished(callback);
  },
};
