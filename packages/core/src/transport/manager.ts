/**
 * The transport manager: public surface.
 *
 * Three pieces, deliberately kept apart because they answer three different
 * questions and are useful on their own:
 *
 *  - `TransportCapabilityManager` - what can THIS device do right now
 *    (`capabilityManager.ts`)
 *  - negotiation - what can BOTH devices do, ranked best first
 *    (`negotiation.ts`)
 *  - `TransportUpgradeController` - move a live session onto something better,
 *    and back again when it dies (`upgrade.ts`)
 *
 * plus `ConnectionQuality` (`quality.ts`), which turns link metrics into the
 * only four words the product ever shows a user.
 *
 * Nothing here opens a radio. Every one of these takes `Transport`
 * implementations from outside, which is why the whole feature is testable
 * against MockNetwork with no hardware at all.
 */
export {
  TransportCapabilityManager,
  sanitizeAvailability,
  type TransportCapabilityEvents,
  type TransportRegistrationOptions,
  type TransportSnapshot,
} from './capabilityManager.js';

export {
  DEFAULT_TRANSPORT_PROFILES,
  MAX_NEGOTIATED_TRANSPORTS,
  bestCommonTransport,
  compareTransportProfiles,
  defaultProfileFor,
  isTransportUpgrade,
  negotiateTransports,
  sanitizeTransportKinds,
  transportScore,
  type TransportCandidate,
  type TransportNegotiationOptions,
} from './negotiation.js';

export {
  CONNECTION_QUALITY_LABEL,
  ConnectionQuality,
  ConnectionQualityTracker,
  QUALITY_THRESHOLDS,
  classifyConnectionQuality,
  connectionQualityFromLink,
  isBetterQuality,
  type QualitySignals,
} from './quality.js';

export {
  DEFAULT_UPGRADE_TIMINGS,
  TransportUpgradeController,
  UpgradeFailureReason,
  UpgradeState,
  decodeProbeDatagram,
  encodeProbeDatagram,
  isUpgradeInitiator,
  type TransportUpgradeEvents,
  type TransportUpgradeOptions,
  type UpgradeOutcome,
  type UpgradeTimings,
} from './upgrade.js';
