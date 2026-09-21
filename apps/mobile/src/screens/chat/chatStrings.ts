/**
 * Strings this folder needs that `@airlink/config` does not carry yet.
 *
 * Everything the user can read in Chat is either in `strings.chat` or here.
 * These live locally only because another agent owns `packages/config` right
 * now; moving them across is a copy-paste and a find-replace of `chatCopy.` for
 * `strings.chat.`.
 *
 * The voice matches the shared table: plain, calm, and never technical. Nothing
 * here names a radio, a transport or an id.
 */

export const chatCopy = {
  /** The Chat tab, before anyone has said anything. */
  listEmptyTitle: 'No conversations yet',
  listEmptyBody: 'Connect to someone nearby and say hello.',
  listEmptyAction: 'Find someone nearby',
  /** Section above people who are here now but have never been messaged. */
  startSection: 'START A CHAT',
  conversationsSection: 'CONVERSATIONS',

  /** Row previews for messages that are not text. */
  photoPreview: 'Photo',
  filePreview: 'File',
  voicePreview: 'Voice message',

  /** Opening a conversation with someone this device no longer knows. */
  unknownTitle: 'Conversation unavailable',
  unknownBody: 'This person is no longer on this phone. Connect to them again to start over.',
  connectAction: 'Connect',

  /** Screen-reader wording for the delivery ticks. Never shown as text. */
  statusQueued: 'Waiting to send',
  statusSent: 'Sent',
  statusDelivered: 'Delivered',
  statusRead: 'Read',
  statusFailed: 'Not sent',

  /** Screen-reader wording for a chat list row. */
  openChat: (name: string): string => `Open your chat with ${name}`,
  unreadCount: (count: number): string => (count === 1 ? '1 unread message' : `${count} unread messages`),

  /** How this device refers to its own owner in a quoted reply. */
  you: 'You',

  /** Screen-reader labels around a bubble. */
  messageFrom: (name: string): string => `${name} said`,
  messageFromYou: 'You said',
  replyingTo: (name: string): string => `Replying to ${name}`,
  reactionCount: (emoji: string, count: number): string =>
    count === 1 ? `${emoji} from 1 person` : `${emoji} from ${count} people`,

  /** The composer. */
  sendLabel: 'Send',
  sendHintEmpty: 'Write a message first',
  composerLabel: 'Message',
  cancelReply: 'Stop replying',

  /** The photo button, and everything that can come back from the picker. */
  photoLabel: 'Send a photo',
  photoHint: 'Choose a photo from your library',
  /**
   * Photos denied.
   *
   * The path is spelled out because there is nothing this app can do about it
   * from here: iOS only shows its own prompt once, and after that the switch
   * lives in Settings.
   */
  photoDenied: 'AirLink cannot see your photos. Turn Photos on for AirLink in Settings.',
  photoFailed: 'That photo could not be read. Try another one.',

  /** The microphone button and the bar that replaces the composer while recording. */
  recordLabel: 'Record a voice message',
  recordingNow: 'Recording',
  recordingHint: 'Tap the arrow to send it, or Cancel to throw it away',
  sendVoiceLabel: 'Send voice message',
  discardVoiceLabel: 'Delete this recording',
  discardVoice: 'Cancel',
  micDenied: 'AirLink cannot hear the microphone. Turn Microphone on for AirLink in Settings.',
  /** An older build of the app, where the recorder is simply not there. */
  voiceUnavailable: 'This version of AirLink cannot record voice messages.',
  voiceFailed: 'The recording did not work. Try again.',
  voiceTooShort: 'Hold on a little longer - that was too short to send.',

  /** The playback bubble. */
  playVoice: 'Play voice message',
  pauseVoice: 'Stop playing',
  voiceOf: (duration: string): string => `Voice message, ${duration}`,

  /** What a photo or a voice message is doing while its bytes move. */
  attachmentSending: (percent: number): string => `Sending ${percent}%`,
  attachmentWaiting: 'Will send when you are both in range',

  /** The long-press menu. */
  actionsHint: 'Long press a message for reply, react, copy and delete',
  reactOffline: (name: string): string => `${name} has to be in range to see a reaction.`,
  copyNeedsText: 'There is no text to copy.',
  copied: 'Copied',

  /**
   * The one reason a composed message is not kept.
   *
   * Never shown for being out of range - that message is saved and queued.
   * This is for a person this phone has no record of having met.
   */
  needsFirstConnection: (name: string): string => `Connect to ${name} once before writing to them.`,

  /** The header, and what the two of you are doing right now. */
  typingBy: (name: string): string => `${name} is typing`,
  /** They are in range but there is no session yet. An offer, not a warning. */
  nearbyNow: (name: string): string => `${name} is nearby`,
  connectTo: (name: string): string => `Connect to ${name}`,

  /** Someone is here but has never been messaged. */
  sayHello: 'Say hello',
} as const;
