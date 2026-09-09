/**
 * QR pairing - the strongest way two people become friends.
 *
 * WHY IT IS THE STRONGEST. Every other first meeting has to defend against an
 * active attacker relaying the handshake, and the only defence available is
 * making two humans compare six digits. A scanned code sidesteps the problem
 * entirely: the identity key travels OUT OF BAND, over photons between two
 * phones held a hand's width apart, on a channel an attacker on the radio
 * cannot touch. Once the scanner holds the key, the handshake demands exactly
 * that key and a man in the middle has nothing to offer. No digits, no taps, no
 * trust decision left to a tired human in an airport.
 *
 * WHAT THE CODE CONTAINS. { version, peerId, identityKey, displayName,
 * issuedAt } plus a self-signature made with the matching secret key. The
 * signature does not make the code trustworthy on its own - anyone can generate
 * a key pair and sign their own code - it proves that the presenter HOLDS the
 * secret key for the identity they are showing, so a code cannot be copied off
 * one screen and replayed as somebody else's. The out-of-band channel supplies
 * the trust; the signature supplies the binding.
 *
 * SIZE. CBOR keeps the map tight, base64url survives being pasted into anything,
 * and the whole URI lands near 230 characters - a QR that scans instantly at
 * arm's length in bad light, which is the only measure that matters.
 */
import { decodeCbor, encodeCbor, type CborLimits, type CborValue } from '../protocol/cbor.js';
import {
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SIGNATURE_LENGTH,
  sign,
  verifySignature,
} from '../crypto/primitives.js';
import { peerIdFromIdentityKey, type LocalIdentity } from '../crypto/identity.js';
import { concatBytes, fromBase64Url, toBase64Url, utf8Encode } from '../util/bytes.js';
import { hasControlCharacters, sanitiseDisplayName } from './trustStore.js';

/** Version of the QR payload format. Bumped only for a breaking change. */
export const PAIRING_CODE_VERSION = 1;

/** URI scheme, so a camera app or a deep link can hand the code straight to us. */
export const PAIRING_URI_SCHEME = 'airlink';
export const PAIRING_URI_PREFIX = `${PAIRING_URI_SCHEME}:`;

/** Longest display name a code may carry. Shorter than the friend row's, to keep the QR small. */
export const MAX_PAIRING_CODE_NAME_LENGTH = 32;

/**
 * Hard ceiling on the URI we will even attempt to decode. Our own codes are
 * around 230 characters; anything an order of magnitude larger is either a
 * different kind of QR or someone probing the decoder.
 */
export const MAX_PAIRING_CODE_LENGTH = 1024;

/**
 * How long a displayed code stays valid.
 *
 * A pairing code is a live invitation, not a business card. Bounding its age
 * means a screenshot posted to a group chat a week later cannot be used to
 * silently add its subject as a friend, and it forces the presenter's phone to
 * be present and awake at the moment of the scan.
 */
export const DEFAULT_PAIRING_CODE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Tolerance for the scanner's clock running behind the presenter's. Two phones
 * offline for a week can disagree by a minute; a code that appears to come from
 * the near future is far likelier to be clock skew than an attack.
 */
export const DEFAULT_PAIRING_CODE_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Tight limits for a payload that is by definition tiny. The default decoder
 * limits allow a 4 MiB string; a QR code has no business carrying one.
 */
const QR_CBOR_LIMITS: CborLimits = { maxDepth: 4, maxCollectionSize: 16, maxStringLength: 256 };

const QR_SIGNATURE_DOMAIN = utf8Encode('AirLink-v1-pairing-code');

/** Exactly the keys a version-1 code may contain. Anything else is a forgery attempt or a bug. */
const ALLOWED_KEYS: readonly string[] = ['v', 'p', 'k', 'n', 't', 's'];

export interface PairingCode {
  readonly version: number;
  readonly peerId: string;
  /** Long-term Ed25519 public key, delivered out of band. */
  readonly identityKey: Uint8Array;
  readonly displayName: string;
  /** Wall-clock milliseconds at which the presenter generated the code. */
  readonly issuedAt: number;
}

export const PairingCodeRejection = {
  NOT_AN_AIRLINK_CODE: 'notAnAirlinkCode',
  TOO_LONG: 'tooLong',
  MALFORMED: 'malformed',
  UNSUPPORTED_VERSION: 'unsupportedVersion',
  BAD_SIGNATURE: 'badSignature',
  EXPIRED: 'expired',
  ISSUED_IN_THE_FUTURE: 'issuedInTheFuture',
  /** The peer id does not hash from the identity key it travels with. */
  IDENTITY_MISMATCH: 'identityMismatch',
} as const;
export type PairingCodeRejection = (typeof PairingCodeRejection)[keyof typeof PairingCodeRejection];

export class PairingCodeError extends Error {
  override readonly name = 'PairingCodeError';
  constructor(
    readonly reason: PairingCodeRejection,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The bytes the self-signature covers.
 *
 * Note that this is rebuilt from the PARSED fields rather than lifted out of the
 * received buffer. Our CBOR encoder is canonical, so the two agree byte for byte
 * on a well-formed code - and on a malformed one the signature simply fails,
 * which means an attacker cannot smuggle anything past the verifier by choosing
 * a non-canonical encoding or by appending fields the parser ignores.
 */
function signedBytes(code: PairingCode): Uint8Array {
  return concatBytes(
    QR_SIGNATURE_DOMAIN,
    encodeCbor({
      v: code.version,
      p: code.peerId,
      k: code.identityKey,
      n: code.displayName,
      t: code.issuedAt,
    }),
  );
}

/** Build the "airlink:..." URI this device presents as a QR code. */
export function buildPairingCode(identity: LocalIdentity, displayName: string, wallNow: number): string {
  if (!Number.isFinite(wallNow) || wallNow < 0) throw new Error('buildPairingCode: wall clock must be non-negative');
  const contents: PairingCode = {
    version: PAIRING_CODE_VERSION,
    peerId: identity.peerId,
    identityKey: identity.signing.publicKey,
    displayName: sanitiseDisplayName(displayName, MAX_PAIRING_CODE_NAME_LENGTH),
    issuedAt: Math.floor(wallNow),
  };
  const signature = sign(signedBytes(contents), identity.signing.secretKey);
  const payload = encodeCbor({
    v: contents.version,
    p: contents.peerId,
    k: contents.identityKey,
    n: contents.displayName,
    t: contents.issuedAt,
    s: signature,
  });
  return PAIRING_URI_PREFIX + toBase64Url(payload);
}

export interface ParsePairingCodeOptions {
  /** Reject a code older than this. Defaults to five minutes. */
  readonly maxAgeMs?: number;
  /** Allow the presenter's clock to be this far ahead of ours. */
  readonly maxClockSkewMs?: number;
}

function reject(reason: PairingCodeRejection, message: string): never {
  throw new PairingCodeError(reason, message);
}

function requireBytes(value: CborValue, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) reject(PairingCodeRejection.MALFORMED, `pairing code: ${field} must be bytes`);
  if (value.length !== length) {
    reject(PairingCodeRejection.MALFORMED, `pairing code: ${field} must be exactly ${length} bytes`);
  }
  return value;
}

/**
 * Strict parser. Every check below exists because the input is a bitmap
 * photographed from a stranger's screen: the scheme, the length, the encoding,
 * the version, every field's type and bound, the self-consistency of the id and
 * the key, the signature, and the age. A failure is always a typed rejection -
 * never a crash, and never a partially trusted result.
 */
export function parsePairingCode(
  text: string,
  wallNow: number,
  options: ParsePairingCodeOptions = {},
): PairingCode {
  if (typeof text !== 'string') reject(PairingCodeRejection.NOT_AN_AIRLINK_CODE, 'pairing code: not a string');
  const trimmed = text.trim();
  // Bound the input before any decoding runs, so a megabyte of base64 costs
  // nothing.
  if (trimmed.length > MAX_PAIRING_CODE_LENGTH) {
    reject(PairingCodeRejection.TOO_LONG, `pairing code: longer than ${MAX_PAIRING_CODE_LENGTH} characters`);
  }
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(PAIRING_URI_PREFIX)) {
    reject(PairingCodeRejection.NOT_AN_AIRLINK_CODE, 'pairing code: missing the airlink: scheme');
  }
  // Accept "airlink:xxx" and "airlink://xxx" - some camera apps normalise one
  // into the other, and the difference carries no meaning.
  let body = trimmed.slice(PAIRING_URI_PREFIX.length);
  if (body.startsWith('//')) body = body.slice(2);
  if (body.length === 0) reject(PairingCodeRejection.MALFORMED, 'pairing code: empty payload');

  let raw: Uint8Array;
  try {
    raw = fromBase64Url(body);
  } catch (err) {
    reject(PairingCodeRejection.MALFORMED, `pairing code: ${err instanceof Error ? err.message : String(err)}`);
  }

  let decoded: CborValue;
  try {
    decoded = decodeCbor(raw, QR_CBOR_LIMITS);
  } catch (err) {
    reject(PairingCodeRejection.MALFORMED, `pairing code: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded) || decoded instanceof Uint8Array) {
    reject(PairingCodeRejection.MALFORMED, 'pairing code: payload is not a map');
  }
  const m = decoded as Record<string, CborValue>;
  for (const key of Object.keys(m)) {
    if (!ALLOWED_KEYS.includes(key)) reject(PairingCodeRejection.MALFORMED, `pairing code: unexpected field "${key}"`);
  }

  // Version first: a future format may reuse these field names for something
  // else, so nothing below this line is meaningful until the version matches.
  const version = m.v;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 65535) {
    reject(PairingCodeRejection.MALFORMED, 'pairing code: version must be a small integer');
  }
  if (version !== PAIRING_CODE_VERSION) {
    reject(PairingCodeRejection.UNSUPPORTED_VERSION, `pairing code: unsupported version ${version}`);
  }

  const identityKey = requireBytes(m.k as CborValue, ED25519_PUBLIC_KEY_LENGTH, 'identity key');
  const signature = requireBytes(m.s as CborValue, ED25519_SIGNATURE_LENGTH, 'signature');

  const peerId = m.p;
  if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) {
    reject(PairingCodeRejection.MALFORMED, 'pairing code: peer id must be a short string');
  }

  const displayName = m.n;
  if (typeof displayName !== 'string' || displayName.length > MAX_PAIRING_CODE_NAME_LENGTH) {
    reject(PairingCodeRejection.MALFORMED, 'pairing code: display name must be a short string');
  }
  // Rejected rather than stripped: sanitising here would change the bytes the
  // signature covers, and our own generator never emits them anyway.
  if (hasControlCharacters(displayName)) {
    reject(PairingCodeRejection.MALFORMED, 'pairing code: display name contains control characters');
  }

  const issuedAt = m.t;
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    reject(PairingCodeRejection.MALFORMED, 'pairing code: issuedAt must be a non-negative integer');
  }

  // The peer id is a truncated hash of the identity key. Checking it here means
  // a code can never introduce a key under someone else's id, and it costs one
  // hash.
  if (peerIdFromIdentityKey(identityKey) !== peerId) {
    reject(PairingCodeRejection.IDENTITY_MISMATCH, 'pairing code: peer id does not match the identity key');
  }

  const contents: PairingCode = { version, peerId, identityKey, displayName, issuedAt };
  if (!verifySignature(signature, signedBytes(contents), identityKey)) {
    reject(PairingCodeRejection.BAD_SIGNATURE, 'pairing code: self-signature did not verify');
  }

  // Freshness last: a stale code that is otherwise valid is a different problem
  // from a forged one, and the UI says something different about each.
  if (!Number.isFinite(wallNow)) reject(PairingCodeRejection.MALFORMED, 'pairing code: local clock is unusable');
  const maxAge = options.maxAgeMs ?? DEFAULT_PAIRING_CODE_MAX_AGE_MS;
  const skew = options.maxClockSkewMs ?? DEFAULT_PAIRING_CODE_CLOCK_SKEW_MS;
  const age = wallNow - issuedAt;
  if (age > maxAge) reject(PairingCodeRejection.EXPIRED, `pairing code: issued ${Math.round(age / 1000)}s ago`);
  if (-age > skew) reject(PairingCodeRejection.ISSUED_IN_THE_FUTURE, 'pairing code: issued in the future');

  return contents;
}

/** Non-throwing variant, for UI code that scans continuously. */
export function tryParsePairingCode(
  text: string,
  wallNow: number,
  options: ParsePairingCodeOptions = {},
): { ok: true; code: PairingCode } | { ok: false; reason: PairingCodeRejection; message: string } {
  try {
    return { ok: true, code: parsePairingCode(text, wallNow, options) };
  } catch (err) {
    if (err instanceof PairingCodeError) return { ok: false, reason: err.reason, message: err.message };
    // Nothing else should escape, but a scanner loop must not be the place we
    // find that out.
    return { ok: false, reason: PairingCodeRejection.MALFORMED, message: String(err) };
  }
}

/**
 * Bytes a QR encoder would have to carry for this URI. base64url is outside the
 * QR alphanumeric set, so the code goes in byte mode and this is the figure that
 * decides the QR version - which is to say, how big the squares are.
 */
export function pairingCodeByteLength(uri: string): number {
  return utf8Encode(uri).length;
}
