/**
 * Recording and playing voice messages.
 *
 * A separate spec from the transport and from notifications for the same reason
 * those two are separate from each other: one spec is one generated method map,
 * and a shared map is what once let an argument-count mismatch compile cleanly
 * and then crash on the first call. Recording a voice note has nothing to do
 * with a radio.
 *
 * SIZE IS THE WHOLE DESIGN. A voice message here does not go to a server; it
 * goes down a Bluetooth link that moves roughly 40 KB a second on a good day.
 * A one-minute note encoded the way a phone normally encodes one would be
 * several megabytes and would take minutes to arrive, which is not a feature,
 * it is a hang. The native side therefore records mono AAC at a low bitrate -
 * see AudioRecorder.swift for the exact numbers and the reasoning - and this
 * spec deliberately offers no way to ask for anything better. Speech at that
 * rate is perfectly intelligible; music would not be, and this is not a music
 * app.
 *
 * The file is written to the app's own directory and never leaves it except by
 * the chat layer explicitly sending it.
 */
import type { TurboModule, CodegenTypes } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface NativeRecording {
  /** Absolute path to the finished m4a file in the app's own container. */
  path: string;
  durationMs: CodegenTypes.Double;
  sizeBytes: CodegenTypes.Double;
}

/**
 * Microphone level while recording, for the waveform.
 *
 * Emitted about ten times a second rather than per audio frame: the waveform
 * is a drawing, and a drawing does not need 86 updates a second crossing the
 * bridge and re-rendering a React tree.
 */
export interface NativeAudioLevelEvent {
  /** 0 is silence, 1 is as loud as the microphone reports. Already smoothed. */
  level: CodegenTypes.Double;
}

export interface NativeAudioProgressEvent {
  positionMs: CodegenTypes.Double;
  durationMs: CodegenTypes.Double;
}

export interface NativeAudioFinishedEvent {
  /** The file that finished, so a list of bubbles knows which one to reset. */
  path: string;
  /**
   * False when playback stopped because something went wrong rather than
   * because the file ended. The UI treats both the same way - the bubble stops
   * animating - but a failure is worth a log line.
   */
  completed: boolean;
}

export interface Spec extends TurboModule {
  /** 'granted' | 'denied' | 'notAsked'. Never prompts. */
  getPermission(): Promise<string>;

  /** Shows the system microphone prompt. Resolves true when recording is allowed. */
  requestPermission(): Promise<boolean>;

  /**
   * Begin recording. Rejects if the microphone was refused or a recording is
   * already running; it never silently replaces one, because a caller that
   * thought it was still recording the first note would then send the second.
   */
  startRecording(): Promise<void>;

  /**
   * Finish and resolve with the file. Rejects if nothing was being recorded, or
   * if the recording was cut short by something outside the app - a phone call,
   * most often - because a half-written file is not a voice message and the
   * chat layer must not be handed one to send.
   */
  stopRecording(): Promise<NativeRecording>;

  /** Abandon the recording and delete the file. Never rejects. */
  cancelRecording(): Promise<void>;

  /** Play a file recorded by this module. Resolves once playback has started. */
  play(path: string): Promise<void>;

  /** Stop playback if anything is playing. Never rejects. */
  stopPlayback(): Promise<void>;

  readonly onLevel: CodegenTypes.EventEmitter<NativeAudioLevelEvent>;
  readonly onPlaybackProgress: CodegenTypes.EventEmitter<NativeAudioProgressEvent>;
  readonly onPlaybackFinished: CodegenTypes.EventEmitter<NativeAudioFinishedEvent>;
}

/**
 * `get`, not `getEnforcing`: a build without this module, or a Jest run with no
 * native side at all, must end up with a chat that cannot record voice notes,
 * not with a chat that crashes. The wrapper in the app turns this null into
 * no-ops and an `isAvailable()` of false.
 */
export default TurboModuleRegistry.get<Spec>('NativeAirLinkAudio');
