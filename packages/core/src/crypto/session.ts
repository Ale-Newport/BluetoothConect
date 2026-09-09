/**
 * A live secure session: directional AEAD keys, monotonic nonces and replay
 * protection.
 *
 * Nonce construction (RFC 8439 section 3, and the same shape TLS 1.3 uses):
 *
 *     nonce[0..4)  = per-direction prefix from the key schedule
 *     nonce[4..12) = the 64-bit big-endian packet counter
 *
 * Send and receive use SEPARATE keys and SEPARATE prefixes, so a counter value
 * is never reused with the same key, and a packet cannot be reflected back at
 * its sender.
 */
import {
  AEAD_KEY_LENGTH,
  AEAD_NONCE_LENGTH,
  NONCE_PREFIX_LENGTH,
  SESSION_ID_LENGTH,
  TIMING,
} from '../protocol/constants.js';
import { aeadOpen, aeadSeal, wipe, type AeadAlgorithm } from './primitives.js';
import { ReplayWindow } from './replay.js';

/** The material a completed handshake hands to the transport layer. */
export interface SessionKeys {
  readonly sessionId: Uint8Array;
  readonly sendKey: Uint8Array;
  readonly sendNoncePrefix: Uint8Array;
  readonly recvKey: Uint8Array;
  readonly recvNoncePrefix: Uint8Array;
  readonly algorithm: AeadAlgorithm;
}

/**
 * A 64-bit counter would take longer than the age of the universe to exhaust at
 * any real packet rate, but rekeying pressure is still worth signalling. We
 * refuse to send past this and surface it as a session-expired error.
 */
const MAX_COUNTER = Number.MAX_SAFE_INTEGER - 1;
/** Counter value at which the session asks the layer above to rekey. */
export const REKEY_THRESHOLD = 2 ** 40;

export class SecureSession {
  readonly sessionId: Uint8Array;
  readonly algorithm: AeadAlgorithm;

  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;
  private readonly sendNonce: Uint8Array;
  private readonly recvNonce: Uint8Array;
  private readonly replay: ReplayWindow;

  private sendCounter = 0;
  private destroyed = false;

  /** Counters for Developer Mode. */
  packetsSent = 0;
  packetsReceived = 0;
  packetsRejected = 0;
  bytesSent = 0;
  bytesReceived = 0;

  constructor(keys: SessionKeys, replayWindowSize = TIMING.replayWindowSize) {
    if (keys.sessionId.length !== SESSION_ID_LENGTH) throw new Error('SecureSession: bad session id length');
    if (keys.sendKey.length !== AEAD_KEY_LENGTH || keys.recvKey.length !== AEAD_KEY_LENGTH) {
      throw new Error('SecureSession: bad key length');
    }
    if (keys.sendNoncePrefix.length !== NONCE_PREFIX_LENGTH || keys.recvNoncePrefix.length !== NONCE_PREFIX_LENGTH) {
      throw new Error('SecureSession: bad nonce prefix length');
    }
    this.sessionId = keys.sessionId;
    this.algorithm = keys.algorithm;
    this.sendKey = keys.sendKey;
    this.recvKey = keys.recvKey;

    this.sendNonce = new Uint8Array(AEAD_NONCE_LENGTH);
    this.sendNonce.set(keys.sendNoncePrefix, 0);
    this.recvNonce = new Uint8Array(AEAD_NONCE_LENGTH);
    this.recvNonce.set(keys.recvNoncePrefix, 0);

    this.replay = new ReplayWindow(replayWindowSize);
  }

  /** Counter that will be used by the next seal(). */
  get nextSendCounter(): number {
    return this.sendCounter;
  }

  get needsRekey(): boolean {
    return this.sendCounter >= REKEY_THRESHOLD;
  }

  private static writeCounter(nonce: Uint8Array, counter: number): void {
    const hi = Math.floor(counter / 0x1_0000_0000);
    const lo = counter >>> 0;
    nonce[4] = (hi >>> 24) & 0xff;
    nonce[5] = (hi >>> 16) & 0xff;
    nonce[6] = (hi >>> 8) & 0xff;
    nonce[7] = hi & 0xff;
    nonce[8] = (lo >>> 24) & 0xff;
    nonce[9] = (lo >>> 16) & 0xff;
    nonce[10] = (lo >>> 8) & 0xff;
    nonce[11] = lo & 0xff;
  }

  /** Encrypt one frame body. Returns the ciphertext and the counter it used. */
  seal(plaintext: Uint8Array, associatedData: Uint8Array): { ciphertext: Uint8Array; counter: number } {
    if (this.destroyed) throw new Error('SecureSession: session destroyed');
    if (this.sendCounter >= MAX_COUNTER) throw new Error('SecureSession: send counter exhausted');
    const counter = this.sendCounter++;
    SecureSession.writeCounter(this.sendNonce, counter);
    const ciphertext = aeadSeal(this.algorithm, this.sendKey, this.sendNonce, plaintext, associatedData);
    this.packetsSent++;
    this.bytesSent += ciphertext.length;
    return { ciphertext, counter };
  }

  /**
   * Decrypt one frame body.
   *
   * Returns null when the packet is a replay, is outside the window, or fails
   * authentication - the three cases are deliberately indistinguishable to the
   * caller so nothing leaks through error handling. The replay window is only
   * advanced AFTER the tag verifies, so a forged packet cannot poison it.
   */
  open(ciphertext: Uint8Array, associatedData: Uint8Array, counter: number): Uint8Array | null {
    if (this.destroyed) return null;
    if (!Number.isSafeInteger(counter) || counter < 0) {
      this.packetsRejected++;
      return null;
    }
    if (this.replay.isReplay(counter)) {
      this.packetsRejected++;
      return null;
    }
    SecureSession.writeCounter(this.recvNonce, counter);
    const plaintext = aeadOpen(this.algorithm, this.recvKey, this.recvNonce, ciphertext, associatedData);
    if (plaintext === null) {
      this.packetsRejected++;
      return null;
    }
    this.replay.accept(counter);
    this.packetsReceived++;
    this.bytesReceived += ciphertext.length;
    return plaintext;
  }

  /** Wipe key material. The session cannot be used afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    wipe(this.sendKey);
    wipe(this.recvKey);
    wipe(this.sendNonce);
    wipe(this.recvNonce);
    this.replay.reset();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }
}
