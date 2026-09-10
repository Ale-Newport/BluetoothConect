/**
 * Strings this screen needs that `@airlink/config` does not have yet.
 *
 * They live here ONLY because another agent is currently in
 * `packages/config/src/strings.ts` and two writers in one file is how a merge
 * eats a translation. Every entry below belongs under `strings.share` and
 * should be moved there verbatim; nothing here is meant to survive as a
 * second, competing string table.
 *
 * Tone matches the rest of the app: plain, calm, and never technical. A
 * transfer that stops is "Paused", not "Failed", because it will pick up again
 * the moment the two phones can see each other.
 */
import { FileErrorCode } from '@airlink/core';

export const shareStrings = {
  /** Section headings on the Share tab. */
  waitingForYou: 'WAITING FOR YOU',
  inProgress: 'IN PROGRESS',
  recent: 'RECENT',

  /** The one prominent action on the Share tab. */
  sendSomething: 'Send a photo or file',

  emptyTitle: 'Nothing shared yet',
  emptyBody: 'Photos and files you send or receive appear here.',

  /** Nobody is connected, so there is nothing to send to. */
  noRecipientsTitle: 'Nobody to send to yet',
  noRecipientsBody: 'Connect to a friend nearby and they will show up here.',
  notConnected: 'Not connected yet',
  connectFirst: 'Connect to your friend first.',

  /** Compose. */
  chooseSomething: 'Choose something to send',
  chooseSomethingBody: 'A photo from your library, or any file on this device.',
  sendTo: 'SEND TO',
  file: 'FILE',
  change: 'Change',
  preparing: 'Getting the file ready…',
  couldNotReadFile: "That file couldn't be opened.",
  couldNotSend: "That couldn't be sent. Try again.",
  nothingChosen: 'Choose a photo or a file first.',
  tooLarge: 'That file is too big to send.',
  tooManyAtOnce: 'Finish one of the other transfers first.',
  choosePhotoLabel: 'Choose a photo or video from your library',
  chooseFileLabel: 'Choose a file on this device',
  previewLabel: (filename: string): string => `Preview of ${filename}`,
  recipientLabel: (name: string): string => `Send to ${name}`,

  /** The honest warning before a long transfer. */
  aboutHowLong: (duration: string): string => `About ${duration} at the current speed.`,
  estimating: 'Working out how long this will take…',

  /** Progress lines. `formatTransferProgress` from core supplies the first one. */
  rateAndEta: (rate: string, duration: string): string => `${rate} · ${duration} left`,
  rateOnly: (rate: string): string => rate,
  perSecond: (size: string): string => `${size}/s`,
  startingUp: 'Starting…',
  verifying: 'Checking the file…',
  waitingForThem: (name: string): string => `Waiting for ${name} to accept…`,
  offerExpired: 'They never answered.',

  /** A name that was nothing but invisible characters. See `safeDisplayName`. */
  unnamedFile: 'Unnamed file',

  /** Who a file is going to or came from, under its name. */
  toPerson: (name: string): string => `To ${name}`,
  fromPerson: (name: string): string => `From ${name}`,

  /** Paused is a state, not a failure. */
  pausedDetail: "This will continue by itself when you're back in range.",

  /** Row and detail actions. */
  stop: 'Stop',
  open: 'Open',
  tryAgain: 'Try again',
  removeFromList: 'Remove from list',
  clearFinished: 'Clear',
  clearFinishedLabel: 'Clear the list of finished transfers',
  couldNotOpen: 'This device has nothing that can open that file.',
  savedToPhotos: 'Saved to Photos',
  couldNotSave: "That couldn't be saved to Photos.",

  /** Accessibility. Every control says what it does to what. */
  reviewLabel: (name: string, filename: string): string => `${name} is offering ${filename}. Open to answer.`,
  stopLabel: (filename: string): string => `Stop transferring ${filename}`,
  openLabel: (filename: string): string => `Open ${filename}`,
  saveLabel: (filename: string): string => `Save ${filename} to Photos`,
  tryAgainLabel: (filename: string): string => `Send ${filename} again`,
  progressLabel: (filename: string, status: string): string => `${filename}, ${status}`,

  /** Terminal states, as a person would say them. */
  stopped: 'Stopped',
  stoppedByThem: (name: string): string => `${name} stopped it`,
  declinedByThem: (name: string): string => `${name} said no`,
  declinedByYou: 'You said no',
  received: 'Received',

  /** Incoming. */
  incomingFrom: (name: string): string => `${name} wants to send you a file`,
  incomingGone: 'That file is no longer on offer.',
  acceptedNowReceiving: 'Receiving…',
} as const;

/**
 * A protocol error code turned into something a person can act on.
 *
 * The wire also carries a free-text reason, but that string was written by the
 * peer's build for a log, not for this user - so it is never shown. The code is
 * the only part we trust to say something.
 */
export function failureText(code: number, peerName: string): string {
  switch (code) {
    case FileErrorCode.TOO_LARGE:
      return `That file is too big for ${peerName}'s phone.`;
    case FileErrorCode.BAD_FILENAME:
      return "That file's name can't be used on the other phone.";
    case FileErrorCode.BUSY:
      return `${peerName} is already receiving something else.`;
    case FileErrorCode.HASH_MISMATCH:
      return "The file didn't arrive intact. Try sending it again.";
    case FileErrorCode.STORAGE_FAILURE:
      return 'There was no room to save the file.';
    case FileErrorCode.REJECTED_BY_USER:
      return `${peerName} said no`;
    case FileErrorCode.TIMED_OUT:
      return shareStrings.offerExpired;
    case FileErrorCode.TOO_MANY_RETRIES:
      return 'The connection was too weak to finish. Try again when you are closer.';
    case FileErrorCode.UNKNOWN_TRANSFER:
    case FileErrorCode.PROTOCOL_VIOLATION:
    case FileErrorCode.UNKNOWN:
    default:
      return "That transfer couldn't be finished.";
  }
}
