/**
 * AirLink v1 authenticated key exchange.
 *
 * A SIGMA-I handshake: an unauthenticated X25519 exchange establishes a shared
 * secret, then each side proves its long-term identity by signing the handshake
 * transcript *inside* the resulting encrypted channel. This is the same
 * structure used by IKEv2 and (in spirit) TLS 1.3, and it is composed entirely
 * from standard primitives - AirLink invents no cryptography.
 *
 *     I -> R   INIT   { version, ephemeralPublicKey_I, nonce_I }
 *     R -> I   RESP   { version, ephemeralPublicKey_R, nonce_R }
 *              -- both derive keys from ECDH(e_I, e_R) bound to the transcript --
 *     R -> I   AUTH_R  AEAD{ identityKey_R, sign_R(transcript), capabilities_R }
 *     I -> R   AUTH_I  AEAD{ identityKey_I, sign_I(transcript), capabilities_I }
 *
 * Properties this gives us:
 *
 *  - Mutual authentication. A peer cannot claim an identity it has no key for.
 *  - Forward secrecy. Ephemeral keys are discarded; a later identity-key
 *    compromise does not decrypt yesterday's chat.
 *  - Identity hiding from passive observers: identity keys travel encrypted.
 *  - MITM detection. An attacker relaying the exchange necessarily produces two
 *    different transcripts, so either the signature check fails (known peer) or
 *    the six-digit SAS differs (first meeting).
 *  - Replay resistance. Fresh ephemerals and nonces on every attempt mean a
 *    recorded handshake cannot be replayed into a live session.
 *
 * What it deliberately does NOT do: protect a first meeting from an active
 * attacker without user involvement. That is impossible without a prior shared
 * secret, which is exactly why first contact requires either a scanned QR code
 * or both users confirming the same six digits.
 */
import {
  AEAD_KEY_LENGTH,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  NONCE_PREFIX_LENGTH,
  PROTOCOL_VERSION,
  SESSION_ID_LENGTH,
} from '../protocol/constants.js';
import {
  decodeCapabilities,
  encodeCapabilities,
  type PeerCapabilities,
} from '../protocol/capabilities.js';
import { decodeCbor, encodeCbor, type CborValue } from '../protocol/cbor.js';
import { DecodeError } from '../util/varint.js';
import { concatBytes, timingSafeEqual, utf8Encode } from '../util/bytes.js';
import {
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SIGNATURE_LENGTH,
  X25519_KEY_LENGTH,
  agree,
  aeadOpen,
  aeadSeal,
  deriveKey,
  generateAgreementKeyPair,
  hash256,
  sign,
  verifySignature,
  wipe,
  type AeadAlgorithm,
} from './primitives.js';
import { peerIdFromIdentityKey, type LocalIdentity } from './identity.js';
import type { SessionKeys } from './session.js';
import type { RandomSource } from './random.js';

const PROLOGUE = utf8Encode('AirLink-v1-handshake');
const SIG_CONTEXT_INITIATOR = utf8Encode('AirLink-v1-auth-initiator');
const SIG_CONTEXT_RESPONDER = utf8Encode('AirLink-v1-auth-responder');
const KDF_INFO = 'AirLink v1 traffic keys';

const HANDSHAKE_NONCE_LENGTH = 16;

/** Handshake message discriminators, carried as the first byte of the body. */
export const HandshakeMessage = {
  INIT: 0x01,
  RESPONSE: 0x02,
  AUTH_RESPONDER: 0x03,
  AUTH_INITIATOR: 0x04,
  REJECT: 0x05,
} as const;
export type HandshakeMessage = (typeof HandshakeMessage)[keyof typeof HandshakeMessage];

export const HandshakeRole = { INITIATOR: 'initiator', RESPONDER: 'responder' } as const;
export type HandshakeRole = (typeof HandshakeRole)[keyof typeof HandshakeRole];

export const HandshakePhase = {
  IDLE: 'idle',
  SENT_INIT: 'sentInit',
  SENT_RESPONSE: 'sentResponse',
  SENT_AUTH: 'sentAuth',
  AWAITING_CONFIRMATION: 'awaitingConfirmation',
  COMPLETE: 'complete',
  FAILED: 'failed',
} as const;
export type HandshakePhase = (typeof HandshakePhase)[keyof typeof HandshakePhase];

export class HandshakeError extends Error {
  override readonly name = 'HandshakeError';
  constructor(
    message: string,
    readonly fatal = true,
  ) {
    super(message);
  }
}

/** The completed, authenticated result of a handshake. */
export interface HandshakeResult {
  readonly keys: SessionKeys;
  /** The peer's long-term Ed25519 public key, cryptographically proven. */
  readonly peerIdentityKey: Uint8Array;
  /** Peer id derived from that key. */
  readonly peerId: string;
  readonly peerCapabilities: PeerCapabilities;
  /** Six-digit code both users compare on a first meeting. */
  readonly sasCodeSeed: Uint8Array;
  /** Transcript hash, retained so the session can be bound to it later. */
  readonly transcriptHash: Uint8Array;
  /** True when the peer's identity key matched the one we had stored. */
  readonly recognisedFromTrustStore: boolean;
  readonly negotiatedProtocolVersion: number;
}

export interface HandshakeConfig {
  readonly identity: LocalIdentity;
  readonly capabilities: PeerCapabilities;
  readonly random: RandomSource;
  /**
   * Resolve a previously trusted identity key for a peer id. Returning a key
   * means "I have met this peer before"; the handshake then requires the
   * presented key to match exactly, which defeats an active attacker with no
   * user interaction at all.
   */
  readonly lookupTrustedKey?: (peerId: string) => Uint8Array | undefined;
  /** AEAD to use. ChaCha20-Poly1305 unless a peer negotiates otherwise. */
  readonly algorithm?: AeadAlgorithm;
}

interface DerivedKeys {
  initiatorToResponderKey: Uint8Array;
  initiatorToResponderPrefix: Uint8Array;
  responderToInitiatorKey: Uint8Array;
  responderToInitiatorPrefix: Uint8Array;
  sessionId: Uint8Array;
  sasSeed: Uint8Array;
}

const DERIVED_LENGTH =
  AEAD_KEY_LENGTH + NONCE_PREFIX_LENGTH + AEAD_KEY_LENGTH + NONCE_PREFIX_LENGTH + SESSION_ID_LENGTH + 32;

function deriveAll(sharedSecret: Uint8Array, transcriptHash: Uint8Array): DerivedKeys {
  const okm = deriveKey(sharedSecret, transcriptHash, KDF_INFO, DERIVED_LENGTH);
  let off = 0;
  const take = (n: number): Uint8Array => okm.slice(off, (off += n));
  return {
    initiatorToResponderKey: take(AEAD_KEY_LENGTH),
    initiatorToResponderPrefix: take(NONCE_PREFIX_LENGTH),
    responderToInitiatorKey: take(AEAD_KEY_LENGTH),
    responderToInitiatorPrefix: take(NONCE_PREFIX_LENGTH),
    sessionId: take(SESSION_ID_LENGTH),
    sasSeed: take(32),
  };
}

/**
 * Transcript hash. Every field either side contributed is bound in, in a fixed
 * order with explicit domain separation, so the two peers cannot be steered into
 * computing the same hash from different exchanges.
 */
function computeTranscript(
  version: number,
  ephemeralInitiator: Uint8Array,
  nonceInitiator: Uint8Array,
  ephemeralResponder: Uint8Array,
  nonceResponder: Uint8Array,
): Uint8Array {
  return hash256(
    PROLOGUE,
    Uint8Array.of(version),
    Uint8Array.of(HandshakeMessage.INIT),
    ephemeralInitiator,
    nonceInitiator,
    Uint8Array.of(HandshakeMessage.RESPONSE),
    ephemeralResponder,
    nonceResponder,
  );
}

function body(type: HandshakeMessage, value: CborValue): Uint8Array {
  return concatBytes(Uint8Array.of(type), encodeCbor(value));
}

function parseBody(data: Uint8Array): { type: number; value: CborValue } {
  if (data.length < 1) throw new DecodeError('handshake: empty body');
  return { type: data[0] as number, value: decodeCbor(data.subarray(1)) };
}

/**
 * Every byte that reaches a handshake method came from a peer we have not yet
 * authenticated. This wrapper guarantees that the ONLY exception type escaping
 * the Handshake class is HandshakeError, so callers have exactly one failure
 * path to handle and a malformed packet can never surface as an unhandled
 * DecodeError somewhere up the stack.
 */
function guard<T>(hs: { failFrom: (message: string) => never }, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HandshakeError) throw err;
    hs.failFrom(err instanceof Error ? err.message : String(err));
  }
}

function requireBytes(value: CborValue, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new DecodeError(`handshake: ${field} must be a byte string`);
  if (value.length !== length) throw new DecodeError(`handshake: ${field} must be ${length} bytes`);
  return value;
}

/**
 * Drives one side of the handshake.
 *
 * The object is a strict state machine: each `read*` method may only be called
 * in the matching phase, and any protocol deviation moves it to FAILED
 * permanently. It performs no I/O - the caller ships the returned bytes over
 * whichever transport is live, which is what lets the whole handshake be tested
 * exhaustively in memory.
 */
export class Handshake {
  private phase: HandshakePhase = HandshakePhase.IDLE;
  private readonly ephemeral: { publicKey: Uint8Array; secretKey: Uint8Array };
  private readonly localNonce: Uint8Array;
  private readonly algorithm: AeadAlgorithm;

  private peerEphemeral?: Uint8Array;
  private peerNonce?: Uint8Array;
  private negotiatedVersion = PROTOCOL_VERSION;
  private transcript?: Uint8Array;
  private derived?: DerivedKeys;
  private result?: HandshakeResult;
  private failureReason?: string;

  constructor(
    readonly role: HandshakeRole,
    private readonly config: HandshakeConfig,
  ) {
    this.ephemeral = generateAgreementKeyPair(config.random.randomBytes(X25519_KEY_LENGTH));
    this.localNonce = config.random.randomBytes(HANDSHAKE_NONCE_LENGTH);
    this.algorithm = config.algorithm ?? 'chacha20poly1305';
  }

  get currentPhase(): HandshakePhase {
    return this.phase;
  }

  get failure(): string | undefined {
    return this.failureReason;
  }

  get completed(): HandshakeResult | undefined {
    return this.result;
  }

  private fail(message: string): never {
    this.phase = HandshakePhase.FAILED;
    this.failureReason = message;
    wipe(this.ephemeral.secretKey);
    throw new HandshakeError(message);
  }

  /** @internal Used by `guard` to funnel decode failures into the state machine. */
  failFrom(message: string): never {
    return this.fail(message);
  }

  // -- initiator -------------------------------------------------------------

  /** Step 1. Initiator produces INIT. */
  createInit(): Uint8Array {
    if (this.role !== HandshakeRole.INITIATOR) this.fail('createInit called on a responder');
    if (this.phase !== HandshakePhase.IDLE) this.fail(`createInit called in phase ${this.phase}`);
    this.phase = HandshakePhase.SENT_INIT;
    return body(HandshakeMessage.INIT, {
      v: PROTOCOL_VERSION,
      e: this.ephemeral.publicKey,
      n: this.localNonce,
      a: this.algorithm,
    });
  }

  // -- responder -------------------------------------------------------------

  /** Step 2. Responder consumes INIT and produces RESPONSE. */
  readInitAndCreateResponse(data: Uint8Array): Uint8Array {
    return guard(this, () => this.readInitAndCreateResponseUnsafe(data));
  }

  private readInitAndCreateResponseUnsafe(data: Uint8Array): Uint8Array {
    if (this.role !== HandshakeRole.RESPONDER) this.fail('readInit called on an initiator');
    if (this.phase !== HandshakePhase.IDLE) this.fail(`readInit called in phase ${this.phase}`);

    const { type, value } = parseBody(data);
    if (type !== HandshakeMessage.INIT) this.fail(`expected INIT, got 0x${type.toString(16)}`);
    const m = this.asMap(value);

    const version = this.asInt(m.v, 'version');
    if (version < MIN_SUPPORTED_PROTOCOL_VERSION || version > PROTOCOL_VERSION) {
      this.fail(`unsupported protocol version ${version}`);
    }
    this.negotiatedVersion = Math.min(version, PROTOCOL_VERSION);

    this.peerEphemeral = requireBytes(m.e as CborValue, X25519_KEY_LENGTH, 'ephemeral key');
    this.peerNonce = requireBytes(m.n as CborValue, HANDSHAKE_NONCE_LENGTH, 'nonce');
    if (m.a !== undefined && m.a !== this.algorithm) this.fail(`unsupported AEAD algorithm ${String(m.a)}`);

    this.transcript = computeTranscript(
      this.negotiatedVersion,
      this.peerEphemeral,
      this.peerNonce,
      this.ephemeral.publicKey,
      this.localNonce,
    );
    this.deriveFrom(this.peerEphemeral);
    this.phase = HandshakePhase.SENT_RESPONSE;

    return body(HandshakeMessage.RESPONSE, {
      v: this.negotiatedVersion,
      e: this.ephemeral.publicKey,
      n: this.localNonce,
    });
  }

  /** Step 3. Responder produces its authentication message. */
  createResponderAuth(): Uint8Array {
    if (this.role !== HandshakeRole.RESPONDER) this.fail('createResponderAuth called on an initiator');
    if (this.phase !== HandshakePhase.SENT_RESPONSE) this.fail(`createResponderAuth in phase ${this.phase}`);
    const out = this.sealAuth(SIG_CONTEXT_RESPONDER, this.derivedSendKeyFor(HandshakeRole.RESPONDER));
    this.phase = HandshakePhase.SENT_AUTH;
    return body(HandshakeMessage.AUTH_RESPONDER, out);
  }

  // -- initiator, continued --------------------------------------------------

  /** Step 4. Initiator consumes RESPONSE. */
  readResponse(data: Uint8Array): void {
    guard(this, () => this.readResponseUnsafe(data));
  }

  private readResponseUnsafe(data: Uint8Array): void {
    if (this.role !== HandshakeRole.INITIATOR) this.fail('readResponse called on a responder');
    if (this.phase !== HandshakePhase.SENT_INIT) this.fail(`readResponse in phase ${this.phase}`);

    const { type, value } = parseBody(data);
    if (type === HandshakeMessage.REJECT) this.fail(`peer rejected the handshake: ${this.rejectReason(value)}`);
    if (type !== HandshakeMessage.RESPONSE) this.fail(`expected RESPONSE, got 0x${type.toString(16)}`);
    const m = this.asMap(value);

    const version = this.asInt(m.v, 'version');
    if (version < MIN_SUPPORTED_PROTOCOL_VERSION || version > PROTOCOL_VERSION) {
      this.fail(`unsupported protocol version ${version}`);
    }
    this.negotiatedVersion = version;

    this.peerEphemeral = requireBytes(m.e as CborValue, X25519_KEY_LENGTH, 'ephemeral key');
    this.peerNonce = requireBytes(m.n as CborValue, HANDSHAKE_NONCE_LENGTH, 'nonce');
    if (timingSafeEqual(this.peerEphemeral, this.ephemeral.publicKey)) {
      // Reflected our own key back at us.
      this.fail('peer echoed our ephemeral key');
    }

    this.transcript = computeTranscript(
      this.negotiatedVersion,
      this.ephemeral.publicKey,
      this.localNonce,
      this.peerEphemeral,
      this.peerNonce,
    );
    this.deriveFrom(this.peerEphemeral);
    this.phase = HandshakePhase.SENT_RESPONSE;
  }

  /**
   * Step 5. Initiator consumes the responder's auth message and produces its
   * own. Returns the bytes to send plus the (now authenticated) result.
   */
  readResponderAuthAndCreateAuth(data: Uint8Array): { message: Uint8Array; result: HandshakeResult } {
    return guard(this, () => this.readResponderAuthAndCreateAuthUnsafe(data));
  }

  private readResponderAuthAndCreateAuthUnsafe(data: Uint8Array): { message: Uint8Array; result: HandshakeResult } {
    if (this.role !== HandshakeRole.INITIATOR) this.fail('readResponderAuth called on a responder');
    if (this.phase !== HandshakePhase.SENT_RESPONSE) this.fail(`readResponderAuth in phase ${this.phase}`);

    const { type, value } = parseBody(data);
    if (type === HandshakeMessage.REJECT) this.fail(`peer rejected the handshake: ${this.rejectReason(value)}`);
    if (type !== HandshakeMessage.AUTH_RESPONDER) this.fail(`expected AUTH_RESPONDER, got 0x${type.toString(16)}`);

    const opened = this.openAuth(value, SIG_CONTEXT_RESPONDER, this.derivedRecvKeyFor(HandshakeRole.INITIATOR));
    const message = body(HandshakeMessage.AUTH_INITIATOR, this.sealAuth(SIG_CONTEXT_INITIATOR, this.derivedSendKeyFor(HandshakeRole.INITIATOR)));

    const result = this.buildResult(opened.identityKey, opened.capabilities, opened.recognised);
    this.phase = HandshakePhase.COMPLETE;
    this.result = result;
    wipe(this.ephemeral.secretKey);
    return { message, result };
  }

  // -- responder, continued --------------------------------------------------

  /** Step 6. Responder consumes the initiator's auth message. Handshake done. */
  readInitiatorAuth(data: Uint8Array): HandshakeResult {
    return guard(this, () => this.readInitiatorAuthUnsafe(data));
  }

  private readInitiatorAuthUnsafe(data: Uint8Array): HandshakeResult {
    if (this.role !== HandshakeRole.RESPONDER) this.fail('readInitiatorAuth called on an initiator');
    if (this.phase !== HandshakePhase.SENT_AUTH) this.fail(`readInitiatorAuth in phase ${this.phase}`);

    const { type, value } = parseBody(data);
    if (type === HandshakeMessage.REJECT) this.fail(`peer rejected the handshake: ${this.rejectReason(value)}`);
    if (type !== HandshakeMessage.AUTH_INITIATOR) this.fail(`expected AUTH_INITIATOR, got 0x${type.toString(16)}`);

    const opened = this.openAuth(value, SIG_CONTEXT_INITIATOR, this.derivedRecvKeyFor(HandshakeRole.RESPONDER));
    const result = this.buildResult(opened.identityKey, opened.capabilities, opened.recognised);
    this.phase = HandshakePhase.COMPLETE;
    this.result = result;
    wipe(this.ephemeral.secretKey);
    return result;
  }

  /** Produce a REJECT message. Used when a peer is blocked or the user declines. */
  static createReject(reason: string): Uint8Array {
    return body(HandshakeMessage.REJECT, { r: reason.slice(0, 120) });
  }

  // -- internals -------------------------------------------------------------

  private rejectReason(value: CborValue): string {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
      const r = (value as Record<string, CborValue>).r;
      if (typeof r === 'string') return r.slice(0, 120);
    }
    return 'unspecified';
  }

  private asMap(value: CborValue): Record<string, CborValue> {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
      this.fail('handshake: expected a map');
    }
    return value as Record<string, CborValue>;
  }

  private asInt(value: CborValue | undefined, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) {
      this.fail(`handshake: ${field} must be a small non-negative integer`);
    }
    return value;
  }

  private deriveFrom(peerEphemeral: Uint8Array): void {
    let shared: Uint8Array;
    try {
      shared = agree(this.ephemeral.secretKey, peerEphemeral);
    } catch (err) {
      this.fail(`key agreement failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.derived = deriveAll(shared, this.transcript as Uint8Array);
    wipe(shared);
  }

  private derivedSendKeyFor(role: HandshakeRole): { key: Uint8Array; prefix: Uint8Array } {
    const d = this.derived as DerivedKeys;
    return role === HandshakeRole.INITIATOR
      ? { key: d.initiatorToResponderKey, prefix: d.initiatorToResponderPrefix }
      : { key: d.responderToInitiatorKey, prefix: d.responderToInitiatorPrefix };
  }

  private derivedRecvKeyFor(role: HandshakeRole): { key: Uint8Array; prefix: Uint8Array } {
    return this.derivedSendKeyFor(role === HandshakeRole.INITIATOR ? HandshakeRole.RESPONDER : HandshakeRole.INITIATOR);
  }

  /**
   * Handshake AEAD invocations use counter 0 with the direction's nonce prefix.
   * Application traffic starts at counter 1, so a handshake ciphertext can never
   * collide with a data packet.
   */
  private handshakeNonce(prefix: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce.set(prefix, 0);
    return nonce; // counter 0
  }

  private sealAuth(sigContext: Uint8Array, dir: { key: Uint8Array; prefix: Uint8Array }): CborValue {
    const transcript = this.transcript as Uint8Array;
    const signature = sign(concatBytes(sigContext, transcript), this.config.identity.signing.secretKey);
    const plaintext = encodeCbor({
      ik: this.config.identity.signing.publicKey,
      sg: signature,
      cp: encodeCapabilities(this.config.capabilities),
    });
    const ciphertext = aeadSeal(this.algorithm, dir.key, this.handshakeNonce(dir.prefix), plaintext, transcript);
    return { c: ciphertext };
  }

  private openAuth(
    value: CborValue,
    sigContext: Uint8Array,
    dir: { key: Uint8Array; prefix: Uint8Array },
  ): { identityKey: Uint8Array; capabilities: PeerCapabilities; recognised: boolean } {
    const m = this.asMap(value);
    const ciphertext = m.c;
    if (!(ciphertext instanceof Uint8Array)) this.fail('handshake: auth payload missing ciphertext');

    const transcript = this.transcript as Uint8Array;
    const plaintext = aeadOpen(this.algorithm, dir.key, this.handshakeNonce(dir.prefix), ciphertext, transcript);
    if (plaintext === null) this.fail('handshake: authentication payload failed to decrypt');

    let inner: Record<string, CborValue>;
    try {
      inner = this.asMap(decodeCbor(plaintext));
    } catch (err) {
      this.fail(`handshake: malformed auth payload (${err instanceof Error ? err.message : String(err)})`);
    }

    const identityKey = requireBytes(inner.ik as CborValue, ED25519_PUBLIC_KEY_LENGTH, 'identity key');
    const signature = requireBytes(inner.sg as CborValue, ED25519_SIGNATURE_LENGTH, 'signature');

    if (!verifySignature(signature, concatBytes(sigContext, transcript), identityKey)) {
      this.fail('handshake: identity signature did not verify');
    }
    if (timingSafeEqual(identityKey, this.config.identity.signing.publicKey)) {
      // Someone reflected our own identity back at us.
      this.fail('handshake: peer presented our own identity key');
    }

    let capabilities: PeerCapabilities;
    try {
      capabilities = decodeCapabilities(inner.cp as CborValue);
    } catch (err) {
      this.fail(`handshake: malformed capabilities (${err instanceof Error ? err.message : String(err)})`);
    }

    // If we have met this peer before, the presented key MUST be the stored one.
    // This is what makes a repeat meeting immune to an active attacker with no
    // user interaction whatsoever.
    const peerId = peerIdFromIdentityKey(identityKey);
    let recognised = false;
    const stored = this.config.lookupTrustedKey?.(peerId);
    if (stored) {
      if (!timingSafeEqual(stored, identityKey)) {
        this.fail('handshake: identity key does not match the one stored for this peer');
      }
      recognised = true;
    }

    return { identityKey, capabilities, recognised };
  }

  private buildResult(identityKey: Uint8Array, capabilities: PeerCapabilities, recognised: boolean): HandshakeResult {
    const d = this.derived as DerivedKeys;
    const iAmInitiator = this.role === HandshakeRole.INITIATOR;
    return {
      keys: {
        sessionId: d.sessionId,
        sendKey: iAmInitiator ? d.initiatorToResponderKey : d.responderToInitiatorKey,
        sendNoncePrefix: iAmInitiator ? d.initiatorToResponderPrefix : d.responderToInitiatorPrefix,
        recvKey: iAmInitiator ? d.responderToInitiatorKey : d.initiatorToResponderKey,
        recvNoncePrefix: iAmInitiator ? d.responderToInitiatorPrefix : d.initiatorToResponderPrefix,
        algorithm: this.algorithm,
      },
      peerIdentityKey: identityKey,
      peerId: peerIdFromIdentityKey(identityKey),
      peerCapabilities: capabilities,
      sasCodeSeed: d.sasSeed,
      transcriptHash: this.transcript as Uint8Array,
      recognisedFromTrustStore: recognised,
      negotiatedProtocolVersion: this.negotiatedVersion,
    };
  }
}
