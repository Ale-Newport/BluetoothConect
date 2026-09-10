/**
 * Turning a peer into words.
 *
 * The user sees a person and a status - never a radio. No RSSI, no transport
 * name, no connection-state enum leaks past this file, which is the single
 * place those translations happen so that Home, the connect sheet and the
 * pairing screen all say the same thing about the same peer.
 */
import { ConnectionQuality, ConnectionState } from '@airlink/core';
import { brand, strings } from '@airlink/config';
import type { StatusTone } from '../../ui/index.js';
import type { PeerView } from '../../state/index.js';

/**
 * Copy these screens need that `@airlink/config` does not carry yet.
 *
 * It lives in one object rather than inline at the call sites so that moving it
 * into `strings` later is a copy-paste, not a hunt. Everything the user can
 * read is either here or in `strings` - nothing is written into JSX.
 */
export const homeCopy = {
  /** Screen-reader label for the control that opens the connect sheet. */
  connectTo: (name: string): string => `Connect to ${name}`,
  /** Screen-reader label for a connected row, which opens the conversation. */
  openChatWith: (name: string): string => `Open your chat with ${name}`,
  /** The radios are not up yet, so nothing can be started. */
  startingUp: `${brand.name} is still starting up.`,
  noGames: (name: string): string => `${name} doesn't have any games yet.`,
  noFiles: (name: string): string => `${name} can't receive files.`,
  noWatchTogether: (name: string): string => `${name} can't watch together.`,
  /** Why a connection attempt ended, in plain words and with no error code. */
  connectFailedBody: 'They may have moved out of range, or closed the app.',
  goneTitle: 'No longer nearby',
  goneBody: "This device stopped advertising. It will reappear here when it's back.",
  firstMeeting: 'This is the first time these two phones have met.',
  /** After the user has answered, while the other phone answers too. */
  pairingWaiting: 'Waiting for your friend to confirm too…',
  pairingGoneTitle: 'Nothing to confirm',
  pairingGoneBody: 'This request is no longer waiting. You can start it again from Home.',
  /**
   * Why "They match" cannot be tapped for the first moment.
   *
   * The confirm button is the one control in the app that can hand a stranger a
   * trusted place on this phone, so it refuses the tap that was already on its
   * way when the screen appeared.
   */
  compareFirst: 'Take a moment to compare the numbers.',
  /** Screen-reader label for the six digits: read one at a time, not as a number. */
  spellCode: (code: string): string => [...code].join(' '),
  connectTitle: (name: string): string => `Connect to ${name}?`,
  /** The sheet is waiting on a radio that is not up yet. */
  notReadyToConnect: 'Still getting ready.',
  cancelAttempt: 'Stop trying',
} as const;

/**
 * The four quality words, and nothing else.
 *
 * An unrecognised value returns null rather than being shown: a raw token on
 * screen would be exactly the kind of engineering detail this app keeps out of
 * the user's way.
 */
export function qualityWord(quality: string | null): string | null {
  switch (quality) {
    case ConnectionQuality.EXCELLENT:
      return strings.status.excellent;
    case ConnectionQuality.GOOD:
      return strings.status.good;
    case ConnectionQuality.WEAK:
      return strings.status.weak;
    case ConnectionQuality.RECONNECTING:
      return strings.status.reconnecting;
    default:
      return null;
  }
}

/** The one-line status under a name: "Connected · Excellent", "Nearby". */
export function statusLine(peer: PeerView): string {
  switch (peer.connection) {
    case ConnectionState.CONNECTED: {
      const word = qualityWord(peer.quality);
      return word ? `${strings.home.connected} · ${word}` : strings.home.connected;
    }
    case ConnectionState.CONNECTING:
      return strings.connection.connecting;
    // Authenticating, choosing a transport and comparing six digits are all
    // "securing" as far as the user is concerned; the difference is ours.
    case ConnectionState.AUTHENTICATING:
    case ConnectionState.NEGOTIATING_TRANSPORT:
    case ConnectionState.PAIRING:
      return strings.connection.securing;
    case ConnectionState.RECONNECTING:
      return strings.connection.reconnecting;
    case ConnectionState.FAILED:
      return strings.connection.failed;
    default:
      return peer.isFriend ? strings.home.nearby : strings.home.newDevice;
  }
}

/** The dot beside the name. Four tones is the whole vocabulary. */
export function statusTone(state: ConnectionState): StatusTone {
  switch (state) {
    case ConnectionState.CONNECTED:
      return 'connected';
    case ConnectionState.CONNECTING:
    case ConnectionState.AUTHENTICATING:
    case ConnectionState.NEGOTIATING_TRANSPORT:
    case ConnectionState.PAIRING:
    case ConnectionState.RECONNECTING:
      return 'connecting';
    case ConnectionState.FAILED:
      return 'warning';
    default:
      return 'disconnected';
  }
}

/** True while something is happening that the user should wait through. */
export function isWorking(state: ConnectionState): boolean {
  return (
    state === ConnectionState.CONNECTING ||
    state === ConnectionState.AUTHENTICATING ||
    state === ConnectionState.NEGOTIATING_TRANSPORT ||
    state === ConnectionState.PAIRING
  );
}
