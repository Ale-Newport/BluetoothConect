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
import { FileErrorCode, TransferDirection } from '@airlink/core';

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
  tooManyAtOnce: (name: string): string => `Finish one of the files you are already sending to ${name} first.`,
  /** The radios are still coming up, so nothing can be sent yet. */
  notReadyYet: 'Still getting ready.',
  choosePhotoLabel: 'Choose a photo or video from your library',
  chooseFileLabel: 'Choose a file on this device',
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
  /** An offer WE made that the other side never answered. */
  offerExpired: 'They never answered.',
  /** An offer THEY made that we never answered. */
  offerLapsed: 'That offer expired before it was answered.',

  /** A name that was nothing but invisible characters. See `safeDisplayName`. */
  unnamedFile: 'Unnamed file',

  /** Who a file is going to or came from, under its name. */
  toPerson: (name: string): string => `To ${name}`,
  fromPerson: (name: string): string => `From ${name}`,

  /** Paused is a state, not a failure. */
  pausedDetail: "This will continue by itself when you're back in range.",
  /**
   * A send that was still running when the app was last closed. The copy we
   * were reading from is not held any more, so this one cannot pick itself up -
   * and saying it will would be a promise the app cannot keep.
   */
  stoppedWhenClosed: 'This stopped when the app was closed.',

  /** Row and detail actions. */
  stop: 'Stop',
  open: 'Open',
  tryAgain: 'Try again',
  clearFinished: 'Clear',
  clearFinishedLabel: 'Clear the list of finished transfers',
  couldNotOpen: 'This device has nothing that can open that file.',
  savedToPhotos: 'Saved to Photos',
  couldNotSave: "That couldn't be saved to Photos.",

  /** Accessibility. Every control says what it does to what. */
  reviewLabel: (name: string, filename: string): string => `${name} is offering ${filename}. Open to answer.`,
  stopLabel: (filename: string): string => `Stop transferring ${filename}`,
  openLabel: (filename: string): string => `Open ${filename}`,
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
  /** The sheet's heading once the offer has been answered - it is a file now. */
  fileFrom: (name: string): string => `From ${name}`,
} as const;

/**
 * A protocol error code turned into something a person can act on.
 *
 * The wire also carries a free-text reason, but that string was written by the
 * peer's build for a log, not for this user - so it is never shown. The code is
 * the only part we trust to say something.
 *
 * The DIRECTION matters as much as the code, because the same code means
 * opposite things on the two sides. The protocol reports our own decline of an
 * incoming offer with exactly the code the peer would have sent for theirs, and
 * the same is true of an offer running out of time: on a send it is "they never
 * answered", on a receive it is the user who did not. Attributing either of
 * those to the wrong person is worse than saying nothing at all.
 */
export function failureText(code: number, peerName: string, direction: TransferDirection): string {
  const incoming = direction === TransferDirection.INCOMING;
  switch (code) {
    case FileErrorCode.TOO_LARGE:
      return incoming ? 'That file is too big to receive.' : `That file is too big for ${peerName}'s phone.`;
    case FileErrorCode.BAD_FILENAME:
      return "That file's name can't be used on the other phone.";
    case FileErrorCode.BUSY:
      return incoming
        ? 'There were already too many files coming in.'
        : `${peerName} is already receiving something else.`;
    case FileErrorCode.HASH_MISMATCH:
      return incoming
        ? "The file didn't arrive intact. Ask them to send it again."
        : "The file didn't arrive intact. Try sending it again.";
    case FileErrorCode.STORAGE_FAILURE:
      return 'There was no room to save the file.';
    case FileErrorCode.REJECTED_BY_USER:
      // On an incoming transfer this code is OUR OWN decline coming back
      // through the protocol. Saying the other person refused their own file
      // would be a small lie about which of the two of you said no.
      return incoming ? shareStrings.declinedByYou : shareStrings.declinedByThem(peerName);
    case FileErrorCode.TIMED_OUT:
      return incoming ? shareStrings.offerLapsed : shareStrings.offerExpired;
    case FileErrorCode.TOO_MANY_RETRIES:
      return 'The connection was too weak to finish. Try again when you are closer.';
    case FileErrorCode.UNKNOWN_TRANSFER:
    case FileErrorCode.PROTOCOL_VIOLATION:
    case FileErrorCode.UNKNOWN:
    default:
      return "That transfer couldn't be finished.";
  }
}
