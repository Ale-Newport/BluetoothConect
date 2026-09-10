/**
 * Which pairings this phone has already answered.
 *
 * Tapping "They match" does not end the ceremony: the other phone still has to
 * answer, and until it does the request stays in `pendingPairings`. Anything
 * that routes a pending pairing - Home when it regains focus, the connect sheet
 * - would therefore send a user who left the waiting screen straight back into
 * the same question. That is worse than a loop: `SasPairing` latches the first
 * decision, so the "They match" they would be shown second cannot do anything
 * at all. A button that looks live and is not is the one thing this app must
 * never ship.
 *
 * Module scope rather than store state because it is not something the app
 * displays - it is a fact about this session's navigation - and it has to
 * outlive the screen that recorded it.
 */

const answered = new Set<string>();

/** The user has given their answer. Stop offering them the question. */
export function markPairingAnswered(peerKey: string): void {
  answered.add(peerKey);
}

export function isPairingAnswered(peerKey: string): boolean {
  return answered.has(peerKey);
}

/**
 * Drop answers for pairings that are no longer pending.
 *
 * A later request from the same peer is a new ceremony with new digits, and
 * must be asked again - so the memory lasts exactly as long as the request it
 * belongs to.
 */
export function forgetResolvedPairings(pendingKeys: readonly string[]): void {
  if (answered.size === 0) return;
  for (const key of [...answered]) {
    if (!pendingKeys.includes(key)) answered.delete(key);
  }
}
