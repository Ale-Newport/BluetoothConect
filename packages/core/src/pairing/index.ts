/**
 * Pairing and the friend system.
 *
 * How two people become trusted friends offline, and how their phones recognise
 * each other forever afterwards without a server, an account or a lookup.
 *
 *   qrPairing            the scanned code - identity out of band, the strongest path
 *   sasPairing           the six-digit ceremony, as an explicit state machine
 *   trustStore           the friend list, and the handshake's trust anchor
 *   advertisementTokens  rotating tokens that only a friend can recognise
 *   friends              recognition, blocking, and the gate before the handshake
 *   pairingController    all of the above, wired to one live PeerSession
 */
export * from './trustStore.js';
export * from './advertisementTokens.js';
export * from './qrPairing.js';
export * from './sasPairing.js';
export * from './friends.js';
export * from './pairingController.js';
