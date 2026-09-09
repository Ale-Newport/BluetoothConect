/**
 * The pairing flow, end to end, over one live session.
 *
 * Everything above this file is a piece: the QR codec, the six-digit state
 * machine, the friend list, the rotating tokens. This is what a screen actually
 * talks to. Attach one to a `PeerSession` and it will, without further help:
 *
 *   - refuse a blocked peer the instant the handshake reveals who they are;
 *   - recognise a friend and let the session through with no user interaction;
 *   - run the six-digit ceremony for a first meeting and surface it as one
 *     event and two methods, `confirm()` and `decline()`;
 *   - exchange advertisement keys so the two devices can spot each other in a
 *     Bluetooth advertisement from then on;
 *   - write the friend row exactly once, only when both sides have agreed.
 *
 * WHY THE CONTROL CHANNEL. `PeerSession` refuses application traffic while a
 * pairing is pending - that refusal is the point of the ceremony - so the
 * confirmation exchange goes out on the control channel, which stays open. It
 * therefore carries its own retransmission; see sasPairing.ts.
 */
import { Channel } from '../protocol/constants.js';
import type { CborValue } from '../protocol/cbor.js';
import type { LocalIdentity } from '../crypto/identity.js';
import type { RandomSource } from '../crypto/random.js';
import { TypedEmitter } from '../util/emitter.js';
import type { Clock } from '../util/time.js';
import { silentLogger, type Logger } from '../util/logger.js';
import type { PeerSession } from '../session/peerSession.js';
import { generateAdvertisementKey } from './advertisementTokens.js';
import {
  PAIRING_CONFIRM,
  PAIRING_CONFIRM_ACK,
  SasPairing,
  SasPairingState,
  type PairingDecision,
} from './sasPairing.js';
import {
  PairingMethod,
  sanitiseDisplayName,
  strongerPairingMethod,
  type TrustStore,
  type TrustedPeer,
} from './trustStore.js';

export interface PairingControllerEvents {
  /**
   * A first meeting. Show the six digits and wait for the user. Until
   * `confirm()` or `decline()` is called the session carries no traffic at all.
   */
  confirmationRequired: {
    readonly peerId: string;
    readonly displayName: string;
    readonly sasCode: string;
    readonly identityKey: Uint8Array;
  };
  /** The friendship is now recorded. Fires for a new friend and for a re-pair. */
  paired: { readonly peer: TrustedPeer; readonly firstTime: boolean };
  /** No friendship: blocked, declined by either side, or nobody answered in time. */
  refused: { readonly peerId: string | null; readonly reason: string };
  stateChanged: { readonly state: SasPairingState };
}

export interface PairingControllerOptions {
  readonly clock: Clock;
  readonly trustStore: TrustStore;
  /** Our own identity - needed to bind the confirmation to this pair. */
  readonly identity: LocalIdentity;
  /** Source for the per-friendship advertisement key. */
  readonly random: RandomSource;
  readonly timeoutMs?: number;
  readonly resendIntervalMs?: number;
  readonly logger?: Logger;
}

export class PairingController {
  readonly events = new TypedEmitter<PairingControllerEvents>();

  private sas: SasPairing | null = null;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly log: Logger;

  private peerId: string | null = null;
  private peerIdentityKey: Uint8Array | null = null;
  private peerDisplayName = '';
  /** True when this session needed the user; false when the trust store recognised the peer. */
  private neededConfirmation = false;
  private localAdvertisementKey: Uint8Array | null = null;
  private disposed = false;
  private settled = false;

  constructor(
    private readonly session: PeerSession,
    private readonly options: PairingControllerOptions,
  ) {
    this.log = (options.logger ?? silentLogger).child('pairing');

    this.unsubscribers.push(
      session.events.on('authenticated', (event) => {
        this.onAuthenticated(event.peerId, event.identityKey, event.capabilities.displayName, event.requiresConfirmation);
      }),
      session.events.on('message', (message) => {
        if (message.channel !== Channel.CONTROL) return;
        if (message.type !== PAIRING_CONFIRM && message.type !== PAIRING_CONFIRM_ACK) return;
        this.sas?.handlePeerMessage(message.type, message.value);
      }),
      session.events.on('closed', () => this.dispose()),
    );

    // A controller attached after the handshake already finished must not sit
    // there waiting for an event that has been and gone.
    const alreadyAuthenticated = session.peerId;
    if (alreadyAuthenticated !== null && session.identityKey && session.sasCode) {
      this.onAuthenticated(
        alreadyAuthenticated,
        session.identityKey,
        session.capabilities?.displayName ?? '',
        session.awaitingUserConfirmation,
      );
    }
  }

  // -- public surface --------------------------------------------------------

  get state(): SasPairingState | null {
    return this.sas?.current ?? null;
  }

  /** The six digits to display, or null when no ceremony is running. */
  get sasCode(): string | null {
    return this.sas?.code ?? null;
  }

  get remoteDecision(): PairingDecision | null {
    return this.sas?.remoteDecision ?? null;
  }

  /** The user compared the digits and they match. */
  confirm(): void {
    this.sas?.confirm();
  }

  /** The user says no - the digits differ, or they changed their mind. */
  decline(): void {
    this.sas?.decline();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.sas?.dispose();
    this.events.removeAllListeners();
  }

  // -- flow ------------------------------------------------------------------

  private onAuthenticated(
    peerId: string,
    identityKey: Uint8Array,
    displayName: string,
    requiresConfirmation: boolean,
  ): void {
    if (this.disposed || this.sas !== null) return;
    this.peerId = peerId;
    this.peerIdentityKey = identityKey.slice();
    this.peerDisplayName = sanitiseDisplayName(displayName);
    this.neededConfirmation = requiresConfirmation;

    // The gate before the handshake works off a token a peer chooses to
    // broadcast, so it can be walked around. This one cannot: the handshake has
    // just proven who this is.
    const store = this.options.trustStore;
    if (store.isBlocked(peerId) || store.record(peerId)?.blocked === true) {
      this.log.info('refusing a blocked peer after authentication', { peerId });
      this.refuse('peer is blocked');
      return;
    }

    const sasCode = this.session.sasCode;
    if (sasCode === null) {
      this.refuse('no pairing code available');
      return;
    }

    const existing = store.record(peerId);
    // Reuse the key this friend already knows us by. Rotating it on every
    // meeting would break recognition for as long as it took the peer to hear
    // about the change - and would gain nothing, since the key is per
    // friendship already.
    this.localAdvertisementKey = existing?.selfAdvertisementKey
      ? existing.selfAdvertisementKey.slice()
      : generateAdvertisementKey(this.options.random);

    this.sas = new SasPairing({
      clock: this.options.clock,
      sasCode,
      localIdentityKey: this.options.identity.signing.publicKey,
      remoteIdentityKey: identityKey,
      send: (messageType: number, value: CborValue) => this.session.sendControl(messageType, value),
      localAdvertisementKey: this.localAdvertisementKey,
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(this.options.resendIntervalMs !== undefined ? { resendIntervalMs: this.options.resendIntervalMs } : {}),
    });

    this.sas.events.on('stateChanged', ({ state }) => this.events.emit('stateChanged', { state }));
    this.sas.events.on('settled', ({ state }) => this.onSettled(state));

    if (requiresConfirmation) {
      this.events.emit('confirmationRequired', {
        peerId,
        displayName: this.peerDisplayName,
        sasCode,
        identityKey: this.peerIdentityKey,
      });
      return;
    }

    // The trust store recognised them, which means the handshake demanded the
    // stored identity key and got it - a proof strictly stronger than six digits
    // read aloud. Confirming on the user's behalf is not a shortcut; asking
    // again would be the bug. It also completes the ceremony for a peer who has
    // us in their list but is not yet in ours, and refreshes an advertisement
    // key that a QR-only friendship never had a chance to exchange.
    this.sas.confirm();
  }

  private onSettled(state: SasPairingState): void {
    if (this.settled) return;
    this.settled = true;
    if (state === SasPairingState.BOTH_CONFIRMED) {
      this.recordFriendship();
      return;
    }
    if (state === SasPairingState.TIMED_OUT) {
      // A timeout only means "hang up" when the session was waiting on this
      // ceremony to become usable. On an already-authenticated session it means
      // the peer never answered our key exchange - an older build, or one with
      // no pairing controller attached. That is a reason to stop repeating
      // ourselves, not a reason to drop a working conversation.
      this.refuse('pairing timed out', { tearDown: this.neededConfirmation });
      return;
    }
    this.refuse('pairing declined', { tearDown: true });
  }

  private recordFriendship(): void {
    const peerId = this.peerId;
    const identityKey = this.peerIdentityKey;
    const sas = this.sas;
    if (!peerId || !identityKey || !sas) return;

    const store = this.options.trustStore;
    // Between the handshake and this moment the user may have hit Block on a
    // stale row. Check again rather than resurrecting a friendship they ended.
    if (store.isBlocked(peerId)) {
      this.refuse('peer is blocked');
      return;
    }

    const existing = store.record(peerId);
    const wallNow = this.options.clock.wallNow();
    const method = this.neededConfirmation ? PairingMethod.SAS : (existing?.method ?? PairingMethod.SAS);
    const remoteKey = sas.remoteAdvertisementKey ?? existing?.advertisementKey;

    const peer: TrustedPeer = {
      peerId,
      identityKey,
      // A peer that sends an empty name has not renamed themselves to nothing -
      // they are an older build or a stripped capability record. Keep the name
      // the user already knows them by.
      displayName: this.peerDisplayName || existing?.displayName || '',
      method: existing ? strongerPairingMethod(existing.method, method) : method,
      pairedAt: existing?.pairedAt ?? wallNow,
      lastSeenAt: wallNow,
      ...(remoteKey ? { advertisementKey: remoteKey } : {}),
      ...(this.localAdvertisementKey ? { selfAdvertisementKey: this.localAdvertisementKey } : {}),
      blocked: false,
    };

    try {
      store.set(peer);
    } catch (err) {
      // The only way this throws is a row that fails validation - a peer id that
      // does not hash from its key, say. Refusing is the only safe answer.
      this.log.error('refusing to store an inconsistent friend row', { peerId, err: String(err) });
      this.refuse('could not record the friendship');
      return;
    }

    // Only now does the session start carrying traffic.
    this.session.confirmPairing(true);
    const stored = store.record(peerId) ?? peer;
    this.events.emit('paired', { peer: stored, firstTime: existing === undefined });
    this.log.info('paired', { peerId, method: stored.method, firstTime: existing === undefined });
  }

  private refuse(reason: string, options: { tearDown: boolean } = { tearDown: true }): void {
    this.settled = true;
    if (options.tearDown) {
      // confirmPairing(false) tears the session down; on a session that was never
      // waiting for confirmation it is a no-op, so close explicitly.
      if (this.session.awaitingUserConfirmation) this.session.confirmPairing(false);
      else void this.session.close(reason);
    }
    this.events.emit('refused', { peerId: this.peerId, reason });
  }
}
