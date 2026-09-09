/**
 * What can this device do, right now?
 *
 * A phone's radios are not a static list. Bluetooth gets switched off, the user
 * denies Local Network permission on the first prompt and grants it on the
 * second, Wi-Fi joins a cafe network and leaves it again, and on iOS a
 * peer-to-peer transport that worked in the foreground stops the moment the app
 * is backgrounded. Every one of those is an `availabilityChanged` event, and
 * every one of them changes the answer to "what should we connect over".
 *
 * This class is the single place that holds that answer. It owns no radio and
 * opens no link: it registers transports, tracks their availability, and hands
 * out a ranked list. Negotiation reads from it; the upgrade controller reads
 * from it; the capability record we send to the peer is built from it.
 */
import { TransportKind, isTransportKind } from '../protocol/capabilities.js';
import { TypedEmitter, type Unsubscribe } from '../util/emitter.js';
import { silentLogger, type Logger } from '../util/logger.js';
import {
  TransportUnavailableReason,
  type Transport,
  type TransportAvailability,
  type TransportProfile,
} from './types.js';
import { compareTransportProfiles, transportScore } from './negotiation.js';

/**
 * Availability before anyone has asked the transport. Deliberately negative:
 * offering a radio we have not confirmed is worse than briefly under-reporting
 * one, because a failed connect attempt costs the user seconds of spinner.
 */
const UNPROBED: TransportAvailability = {
  available: false,
  reason: TransportUnavailableReason.UNKNOWN,
  detail: 'not yet probed',
};

export interface TransportSnapshot {
  readonly kind: TransportKind;
  readonly profile: TransportProfile;
  readonly availability: TransportAvailability;
  /** Ranking score; higher is better. Developer Mode renders this. */
  readonly score: number;
}

export interface TransportCapabilityEvents {
  /** One transport changed state. Fires even when the available SET is unchanged. */
  availabilityChanged: {
    readonly kind: TransportKind;
    readonly availability: TransportAvailability;
    readonly wasAvailable: boolean;
  };
  /** The set of usable transports changed. This is the one worth acting on. */
  changed: { readonly available: readonly TransportKind[] };
}

export interface TransportRegistrationOptions {
  /**
   * Override the transport's own profile. A native bridge may know something
   * static the profile cannot express - an entitlement that is missing on this
   * build, say - and expressing it as a preference keeps the ranking logic in
   * one place.
   */
  readonly profile?: TransportProfile;
  /** Skip the initial async probe when the caller already knows the answer. */
  readonly availability?: TransportAvailability;
}

interface Registration {
  readonly transport: Transport;
  readonly profile: TransportProfile;
  availability: TransportAvailability;
  unsubscribe: Unsubscribe;
  /** Bumped on every unregister so a late async probe cannot resurrect a stale entry. */
  generation: number;
}

export class TransportCapabilityManager {
  readonly events = new TypedEmitter<TransportCapabilityEvents>();

  private readonly registrations = new Map<TransportKind, Registration>();
  private readonly log: Logger;
  private generation = 0;
  private disposed = false;

  constructor(options: { logger?: Logger } = {}) {
    this.log = (options.logger ?? silentLogger).child('transports');
  }

  /**
   * Add a transport. One registration per kind: a second BLE stack on the same
   * device is a bug, not a configuration, so it throws rather than silently
   * shadowing the first.
   */
  register(transport: Transport, options: TransportRegistrationOptions = {}): void {
    if (this.disposed) throw new Error('TransportCapabilityManager: disposed');
    const kind = transport.kind;
    if (!isTransportKind(kind)) throw new Error(`TransportCapabilityManager: unknown transport kind ${String(kind)}`);
    if (this.registrations.has(kind)) throw new Error(`TransportCapabilityManager: ${kind} is already registered`);

    const profile = options.profile ?? transport.profile;
    const generation = ++this.generation;
    const registration: Registration = {
      transport,
      profile,
      availability: options.availability ?? UNPROBED,
      unsubscribe: transport.events.on('availabilityChanged', ({ availability }) => {
        this.apply(kind, availability);
      }),
      generation,
    };
    this.registrations.set(kind, registration);

    if (options.availability) {
      this.emitChangedIfNeeded();
      return;
    }
    // Probe in the background so registration stays synchronous. Callers that
    // need a settled answer before deciding anything await refresh().
    void transport
      .availability()
      .then((availability) => {
        const current = this.registrations.get(kind);
        if (!current || current.generation !== generation) return;
        this.apply(kind, availability);
      })
      .catch((err: unknown) => {
        const current = this.registrations.get(kind);
        if (!current || current.generation !== generation) return;
        this.log.warn('availability probe failed', { kind, err: String(err) });
        this.apply(kind, { available: false, reason: TransportUnavailableReason.UNKNOWN, detail: String(err) });
      });
  }

  unregister(kind: TransportKind): void {
    const registration = this.registrations.get(kind);
    if (!registration) return;
    registration.generation = -1;
    registration.unsubscribe();
    this.registrations.delete(kind);
    this.emitChangedIfNeeded();
  }

  has(kind: TransportKind): boolean {
    return this.registrations.has(kind);
  }

  get(kind: TransportKind): Transport | undefined {
    return this.registrations.get(kind)?.transport;
  }

  profileFor(kind: TransportKind): TransportProfile | undefined {
    return this.registrations.get(kind)?.profile;
  }

  availabilityOf(kind: TransportKind): TransportAvailability {
    return this.registrations.get(kind)?.availability ?? { available: false, reason: TransportUnavailableReason.UNKNOWN };
  }

  isAvailable(kind: TransportKind): boolean {
    return this.registrations.get(kind)?.availability.available === true;
  }

  /** Every registered transport, best first, whether usable or not. */
  rankedTransports(): TransportSnapshot[] {
    const out: TransportSnapshot[] = [];
    for (const [kind, registration] of this.registrations) {
      out.push({
        kind,
        profile: registration.profile,
        availability: registration.availability,
        score: transportScore(registration.profile),
      });
    }
    out.sort((a, b) => compareTransportProfiles(a.profile, b.profile));
    return out;
  }

  /** Profiles of the transports usable right now, best first. Feeds negotiation. */
  availableProfiles(): TransportProfile[] {
    return this.rankedTransports()
      .filter((s) => s.availability.available)
      .map((s) => s.profile);
  }

  /**
   * The kinds usable right now, best first. This is what goes into
   * `PeerCapabilities.transports`, so a peer is never told about a radio we
   * cannot currently answer on.
   */
  availableKinds(): TransportKind[] {
    return this.availableProfiles().map((p) => p.kind);
  }

  /** The best usable transport, or null when the device has no radio at all. */
  best(): TransportProfile | null {
    return this.availableProfiles()[0] ?? null;
  }

  /** Re-ask every transport. Cheap, and the only way to notice a silent change. */
  async refresh(): Promise<void> {
    const entries = [...this.registrations.entries()];
    await Promise.all(
      entries.map(async ([kind, registration]) => {
        const generation = registration.generation;
        try {
          const availability = await registration.transport.availability();
          const current = this.registrations.get(kind);
          if (!current || current.generation !== generation) return;
          this.apply(kind, availability);
        } catch (err) {
          this.log.warn('availability probe failed', { kind, err: String(err) });
          this.apply(kind, { available: false, reason: TransportUnavailableReason.UNKNOWN, detail: String(err) });
        }
      }),
    );
  }

  /** Snapshot for Developer Mode. */
  diagnostics(): Record<string, unknown> {
    return {
      registered: this.registrations.size,
      available: this.availableKinds(),
      transports: this.rankedTransports().map((s) => ({
        kind: s.kind,
        score: Math.round(s.score),
        available: s.availability.available,
        reason: s.availability.reason ?? null,
        highBandwidth: s.profile.highBandwidth,
        expectedThroughputBytesPerSecond: s.profile.expectedThroughputBytesPerSecond,
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const registration of this.registrations.values()) {
      registration.generation = -1;
      registration.unsubscribe();
    }
    this.registrations.clear();
    this.events.removeAllListeners();
  }

  // -- internals -------------------------------------------------------------

  /**
   * Availability arrives from a native module, so it is validated like any other
   * foreign input: a malformed record is read as "unavailable, reason unknown"
   * rather than trusted or thrown away.
   */
  private apply(kind: TransportKind, raw: TransportAvailability | undefined): void {
    const registration = this.registrations.get(kind);
    if (!registration || this.disposed) return;

    const availability = sanitizeAvailability(raw);
    const wasAvailable = registration.availability.available;
    const unchanged =
      wasAvailable === availability.available &&
      registration.availability.reason === availability.reason &&
      registration.availability.detail === availability.detail;
    if (unchanged) return;

    registration.availability = availability;
    this.log.info('transport availability changed', { kind, available: availability.available, reason: availability.reason });
    this.events.emit('availabilityChanged', { kind, availability, wasAvailable });
    if (wasAvailable !== availability.available) this.emitChangedIfNeeded();
  }

  private emitChangedIfNeeded(): void {
    if (this.disposed) return;
    this.events.emit('changed', { available: this.availableKinds() });
  }
}

/** Bound and type-check an availability record from a native bridge. */
export function sanitizeAvailability(raw: TransportAvailability | undefined): TransportAvailability {
  if (!raw || typeof raw !== 'object') {
    return { available: false, reason: TransportUnavailableReason.UNKNOWN };
  }
  const available = raw.available === true;
  const reason =
    typeof raw.reason === 'string' &&
    (Object.values(TransportUnavailableReason) as readonly string[]).includes(raw.reason)
      ? raw.reason
      : undefined;
  const detail = typeof raw.detail === 'string' ? raw.detail.slice(0, 200) : undefined;
  if (available) {
    // An "available" record carries no reason: a reason on an available
    // transport is contradictory, and dropping it keeps the UI honest.
    return detail !== undefined ? { available: true, detail } : { available: true };
  }
  return {
    available: false,
    reason: reason ?? TransportUnavailableReason.UNKNOWN,
    ...(detail !== undefined ? { detail } : {}),
  };
}
