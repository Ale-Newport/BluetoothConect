/**
 * Reporting somebody, in an app that has nowhere to send a report.
 *
 * App Store guideline 1.2 requires an app carrying user-generated content to
 * give people a way to report offensive material and to block the person
 * responsible. AirLink has the second half already - `TrustStore.block` - but
 * it lived three screens away under You → Friends, and only worked on somebody
 * already accepted as a friend. The person you actually want to block is the
 * one whose message is on screen right now.
 *
 * The first half deserves an honest answer rather than a convincing one. There
 * is no server: every message travelled directly between two phones over
 * Bluetooth or the local network, and we never held a copy, so there is no
 * moderation queue to file anything with and nothing for anybody to take down.
 * A "Report" button that quietly did nothing would be worse than none at all.
 *
 * So this does the two things that genuinely protect somebody, both local and
 * both immediate:
 *
 *   1. BLOCK the peer, which stops them connecting or being connected to.
 *   2. DELETE the conversation from this phone.
 *
 * and then offers - without doing it automatically - to open a mail draft to
 * the developer. Nothing from the conversation is put in that draft: pushing
 * private message contents into a third-party mail app is not ours to do.
 */
import { Linking } from 'react-native';
import { brand, strings } from '@airlink/config';
import type { AirLinkClient } from '../../client/AirLinkClient.js';

export interface ReportOutcome {
  readonly blocked: boolean;
  /** Why it failed, when it did. Never shown raw; the caller picks the copy. */
  readonly failure?: string;
}

/**
 * Block a peer and remove the conversation from this device.
 *
 * `peerId` is the Ed25519 fingerprint, which is the only identifier a block can
 * safely key on: `peerKey` is a UI handle that changes when a session is
 * re-keyed, and a block that forgot who it applied to would silently lapse.
 */
export function reportAndBlock(
  client: AirLinkClient,
  peerId: string | null,
  conversationId: string | null,
): ReportOutcome {
  // Blocking is the part that must not be skipped, so it goes first and its
  // failure aborts the whole thing. Deleting the conversation while leaving the
  // peer able to reconnect would be the worst of both outcomes.
  if (peerId === null) {
    return { blocked: false, failure: 'no peerId: the peer was never authenticated' };
  }

  try {
    client.trustStore.block(peerId);
  } catch (error) {
    return { blocked: false, failure: error instanceof Error ? error.message : String(error) };
  }

  // Close any live session immediately. A block that only takes effect on the
  // next connection attempt leaves the person still able to send.
  try {
    void client.disconnect(peerId);
  } catch {
    // Already gone, or never connected. The block above is what matters.
  }

  if (conversationId !== null) {
    try {
      client.db.messages.clearConversation(conversationId);
    } catch {
      // The peer is blocked either way, which is the protection. A conversation
      // that survives is a tidiness problem, not a safety one, and reporting a
      // failure here would suggest the block had not worked.
    }
  }

  return { blocked: true };
}

/**
 * Open a mail draft to the developer, if there is a real address to open it to.
 *
 * Returns false when the placeholder address is still in place, so the caller
 * can leave the option out rather than sending somebody to a dead mailbox.
 */
export function canContactDeveloper(): boolean {
  return !brand.supportEmail.endsWith('.invalid');
}

export async function contactDeveloper(): Promise<boolean> {
  if (!canContactDeveloper()) return false;
  const url =
    `mailto:${brand.supportEmail}` +
    `?subject=${encodeURIComponent(strings.safety.contactSubject)}` +
    `&body=${encodeURIComponent(strings.safety.contactBody)}`;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    // No mail account configured. Nothing to say that the person cannot see:
    // the address itself is on screen for them to use however they like.
    return false;
  }
}
