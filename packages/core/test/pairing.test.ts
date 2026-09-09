import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/protocol/constants.js';
import { TransportKind, type PeerCapabilities } from '../src/protocol/capabilities.js';
import { encodeCbor, decodeCbor, type CborValue } from '../src/protocol/cbor.js';
import { SeededRandom } from '../src/crypto/random.js';
import { createIdentity, peerIdFromIdentityKey, type LocalIdentity } from '../src/crypto/identity.js';
import { sign } from '../src/crypto/primitives.js';
import type { HandshakeConfig } from '../src/crypto/handshake.js';
import { PeerSession } from '../src/session/peerSession.js';
import { ConnectionState } from '../src/session/stateMachine.js';
import { BLE_LIKE_CONDITIONS, HOSTILE_CONDITIONS, MockNetwork, mockToken } from '../src/transport/mock.js';
import { VirtualClock } from '../src/util/time.js';
import { concatBytes, fromBase64Url, toBase64Url, utf8Encode } from '../src/util/bytes.js';
import type { Link } from '../src/transport/types.js';

import {
  ADVERTISEMENT_KEY_LENGTH,
  ADVERTISEMENT_TOKEN_LENGTH,
  TOKEN_ROTATION_WINDOW_MS,
  acceptableTokens,
  deriveAdvertisementToken,
  generateAdvertisementKey,
  matchAdvertisementToken,
  tokenRotation,
  windowIndexFor,
} from '../src/pairing/advertisementTokens.js';
import {
  InMemoryTrustStore,
  MAX_TRUSTED_DISPLAY_NAME_LENGTH,
  PairingMethod,
  hasControlCharacters,
  sanitiseDisplayName,
  strongerPairingMethod,
  touchTrustedPeer,
  trustedKeyLookup,
  validateTrustedPeer,
  type TrustedPeer,
} from '../src/pairing/trustStore.js';
import {
  MAX_PAIRING_CODE_LENGTH,
  PAIRING_CODE_VERSION,
  PAIRING_URI_PREFIX,
  PairingCodeError,
  PairingCodeRejection,
  buildPairingCode,
  pairingCodeByteLength,
  parsePairingCode,
  tryParsePairingCode,
} from '../src/pairing/qrPairing.js';
import {
  PAIRING_BINDING_LENGTH,
  PAIRING_CONFIRM,
  PAIRING_CONFIRM_ACK,
  SasPairing,
  SasPairingState,
  pairingBinding,
} from '../src/pairing/sasPairing.js';
import {
  advertisableFriends,
  endFriendship,
  recogniseFriendToken,
  recognisableFriends,
  recordScannedFriend,
  refusalFrame,
  screenIncomingConnection,
} from '../src/pairing/friends.js';
import { PairingController } from '../src/pairing/pairingController.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALL_EPOCH = 1_700_000_000_000;

function caps(name: string, deviceId: string): PeerCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '0.1.0',
    platform: 'node',
    deviceModel: 'simulator',
    displayName: name,
    deviceId,
    transports: [TransportKind.MOCK],
    features: ['chat'],
    games: [],
    maxPayloadBytes: 65536,
  };
}

interface Device {
  identity: LocalIdentity;
  config: HandshakeConfig;
  trust: InMemoryTrustStore;
  random: SeededRandom;
}

function makeDevice(name: string, seed: number): Device {
  const random = new SeededRandom(seed);
  const identity = createIdentity(random, 1000);
  const trust = new InMemoryTrustStore();
  const config: HandshakeConfig = {
    identity,
    capabilities: caps(name, `device-${name}`),
    random,
    lookupTrustedKey: trustedKeyLookup(trust),
  };
  return { identity, config, trust, random };
}

function friendRow(identity: LocalIdentity, overrides: Partial<TrustedPeer> = {}): TrustedPeer {
  return {
    peerId: identity.peerId,
    identityKey: identity.signing.publicKey,
    displayName: 'Friend',
    method: PairingMethod.SAS,
    pairedAt: WALL_EPOCH,
    lastSeenAt: WALL_EPOCH,
    blocked: false,
    ...overrides,
  };
}

/**
 * Two real PeerSessions over MockNetwork, each with a PairingController on top -
 * the same wiring the app's SessionManager does. Adapted from test/session.test.ts.
 */
async function connectPair(
  options: {
    conditions?: Partial<typeof BLE_LIKE_CONDITIONS>;
    seedA?: number;
    seedB?: number;
    /** Run before the link is opened, e.g. to pre-trust or block someone. */
    prepare?: (a: Device, b: Device) => void;
    /** Subscribe to controller events before the handshake can complete. */
    attach?: (a: PairingController, b: PairingController) => void;
    resendIntervalMs?: number;
    timeoutMs?: number;
  } = {},
) {
  const clock = new VirtualClock(0, WALL_EPOCH);
  const network = new MockNetwork(clock, 0xa11);
  network.setConditions(options.conditions ?? BLE_LIKE_CONDITIONS);

  const alejandro = makeDevice('Alejandro', options.seedA ?? 101);
  const maria = makeDevice('Maria', options.seedB ?? 202);
  options.prepare?.(alejandro, maria);

  const transportA = network.createTransport('endpoint-a');
  const transportB = network.createTransport('endpoint-b');

  await transportA.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: mockToken(1) });
  await transportB.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: mockToken(2) });
  await transportA.startDiscovery();

  const sessionA = new PeerSession('endpoint-b', { clock, handshake: alejandro.config });
  const sessionB = new PeerSession('endpoint-a', { clock, handshake: maria.config });

  const controllerOptions = (device: Device) => ({
    clock,
    trustStore: device.trust,
    identity: device.identity,
    random: device.random,
    ...(options.resendIntervalMs !== undefined ? { resendIntervalMs: options.resendIntervalMs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  const pairingA = new PairingController(sessionA, controllerOptions(alejandro));
  const pairingB = new PairingController(sessionB, controllerOptions(maria));
  options.attach?.(pairingA, pairingB);

  let incoming: Link | undefined;
  transportB.events.on('incomingLink', ({ link }) => {
    incoming = link;
    if (sessionB.isSecure) sessionB.migrateToLink(link);
    else sessionB.startAsResponder(link);
  });

  const connectPromise = transportA.connect('endpoint-b');
  await clock.advanceAsync(200);
  const linkA = await connectPromise;
  await sessionA.startAsInitiator(linkA);
  await clock.advanceAsync(2000);

  return {
    clock,
    network,
    transportA,
    transportB,
    sessionA,
    sessionB,
    pairingA,
    pairingB,
    alejandro,
    maria,
    linkA,
    get linkB(): Link {
      if (!incoming) throw new Error('no incoming link');
      return incoming;
    },
  };
}

// ---------------------------------------------------------------------------
// QR pairing
// ---------------------------------------------------------------------------

describe('QR pairing codes', () => {
  const alejandro = makeDevice('Alejandro', 1).identity;
  const maria = makeDevice('Maria', 2).identity;

  it('round-trips a code through build and strict parse', () => {
    const uri = buildPairingCode(alejandro, 'Alejandro', WALL_EPOCH);
    expect(uri.startsWith(PAIRING_URI_PREFIX)).toBe(true);

    const parsed = parsePairingCode(uri, WALL_EPOCH + 1000);
    expect(parsed.version).toBe(PAIRING_CODE_VERSION);
    expect(parsed.peerId).toBe(alejandro.peerId);
    expect(parsed.displayName).toBe('Alejandro');
    expect(parsed.issuedAt).toBe(WALL_EPOCH);
    expect(Array.from(parsed.identityKey)).toEqual(Array.from(alejandro.signing.publicKey));
  });

  it('stays small enough to scan comfortably', () => {
    const uri = buildPairingCode(alejandro, 'Alejandro Newport Diaz', WALL_EPOCH);
    // A QR in byte mode holds 271 bytes at version 10 / ECC level M. Anything
    // under that scans instantly at arm's length.
    expect(pairingCodeByteLength(uri)).toBeLessThan(271);
  });

  it('accepts the airlink:// form and is case-insensitive about the scheme', () => {
    const uri = buildPairingCode(maria, 'Maria', WALL_EPOCH);
    const body = uri.slice(PAIRING_URI_PREFIX.length);
    expect(parsePairingCode(`AIRLINK://${body}`, WALL_EPOCH).peerId).toBe(maria.peerId);
  });

  it('sanitises a hostile display name before signing it', () => {
    const uri = buildPairingCode(maria, 'Mar‮ia ', WALL_EPOCH);
    const parsed = parsePairingCode(uri, WALL_EPOCH);
    expect(parsed.displayName).toBe('Maria');
  });

  it('truncates an over-long display name rather than refusing to build', () => {
    const uri = buildPairingCode(maria, 'M'.repeat(200), WALL_EPOCH);
    expect(parsePairingCode(uri, WALL_EPOCH).displayName.length).toBe(32);
  });

  // -- hostile input ---------------------------------------------------------

  function expectRejection(fn: () => unknown, reason: PairingCodeRejection): void {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(PairingCodeError);
      expect((err as PairingCodeError).reason).toBe(reason);
      return;
    }
    throw new Error(`expected a ${reason} rejection`);
  }

  it('rejects a tampered display name', () => {
    const uri = buildPairingCode(alejandro, 'Alejandro', WALL_EPOCH);
    const decoded = decodeCbor(fromBase64Url(uri.slice(PAIRING_URI_PREFIX.length))) as Record<string, CborValue>;
    const tampered = { ...decoded, n: 'Mallory' };
    expectRejection(
      () => parsePairingCode(PAIRING_URI_PREFIX + toBase64Url(encodeCbor(tampered)), WALL_EPOCH),
      PairingCodeRejection.BAD_SIGNATURE,
    );
  });

  it('rejects a code whose identity key was swapped for someone else’s', () => {
    const uri = buildPairingCode(alejandro, 'Alejandro', WALL_EPOCH);
    const decoded = decodeCbor(fromBase64Url(uri.slice(PAIRING_URI_PREFIX.length))) as Record<string, CborValue>;
    // Swap the key but keep Alejandro's peer id: the self-consistency check bites.
    const swapped = { ...decoded, k: maria.signing.publicKey };
    expectRejection(
      () => parsePairingCode(PAIRING_URI_PREFIX + toBase64Url(encodeCbor(swapped)), WALL_EPOCH),
      PairingCodeRejection.IDENTITY_MISMATCH,
    );

    // Swap both, and re-derive the id: now it is simply Maria's key with an
    // unrelated signature, which the signature check refuses.
    const both = { ...decoded, k: maria.signing.publicKey, p: peerIdFromIdentityKey(maria.signing.publicKey) };
    expectRejection(
      () => parsePairingCode(PAIRING_URI_PREFIX + toBase64Url(encodeCbor(both)), WALL_EPOCH),
      PairingCodeRejection.BAD_SIGNATURE,
    );
  });

  it('rejects a code signed by the wrong key even when every field is consistent', () => {
    // Mallory re-signs Alejandro's card with her own key but keeps his identity.
    const contents = {
      v: PAIRING_CODE_VERSION,
      p: alejandro.peerId,
      k: alejandro.signing.publicKey,
      n: 'Alejandro',
      t: WALL_EPOCH,
    };
    const signature = sign(
      concatBytes(utf8Encode('AirLink-v1-pairing-code'), encodeCbor(contents)),
      maria.signing.secretKey,
    );
    expectRejection(
      () => parsePairingCode(PAIRING_URI_PREFIX + toBase64Url(encodeCbor({ ...contents, s: signature })), WALL_EPOCH),
      PairingCodeRejection.BAD_SIGNATURE,
    );
  });

  it('rejects an expired code, and honours a configurable window', () => {
    const uri = buildPairingCode(alejandro, 'Alejandro', WALL_EPOCH);
    expectRejection(() => parsePairingCode(uri, WALL_EPOCH + 10 * 60_000), PairingCodeRejection.EXPIRED);
    // Same code, a window wide enough to contain it.
    expect(parsePairingCode(uri, WALL_EPOCH + 10 * 60_000, { maxAgeMs: 30 * 60_000 }).peerId).toBe(alejandro.peerId);
  });

  it('rejects a code from the future beyond the skew allowance', () => {
    const uri = buildPairingCode(alejandro, 'Alejandro', WALL_EPOCH + 10 * 60_000);
    expectRejection(() => parsePairingCode(uri, WALL_EPOCH), PairingCodeRejection.ISSUED_IN_THE_FUTURE);
    // A few seconds of skew is normal and must not fail.
    expect(parsePairingCode(uri, WALL_EPOCH + 10 * 60_000 - 5_000).peerId).toBe(alejandro.peerId);
  });

  it('rejects an unsupported version before looking at anything else', () => {
    const uri = buildPairingCode(alejandro, 'Alejandro', WALL_EPOCH);
    const decoded = decodeCbor(fromBase64Url(uri.slice(PAIRING_URI_PREFIX.length))) as Record<string, CborValue>;
    expectRejection(
      () => parsePairingCode(PAIRING_URI_PREFIX + toBase64Url(encodeCbor({ ...decoded, v: 2 })), WALL_EPOCH),
      PairingCodeRejection.UNSUPPORTED_VERSION,
    );
  });

  it('rejects malformed, oversized and foreign input without throwing anything but PairingCodeError', () => {
    const cases: Array<[string, PairingCodeRejection]> = [
      ['', PairingCodeRejection.NOT_AN_AIRLINK_CODE],
      ['https://example.com/x', PairingCodeRejection.NOT_AN_AIRLINK_CODE],
      ['airlink:', PairingCodeRejection.MALFORMED],
      ['airlink:not base64!!', PairingCodeRejection.MALFORMED],
      ['airlink:' + 'A'.repeat(MAX_PAIRING_CODE_LENGTH + 1), PairingCodeRejection.TOO_LONG],
      // Valid base64url, valid CBOR, but an array rather than a map.
      [PAIRING_URI_PREFIX + toBase64Url(encodeCbor([1, 2, 3])), PairingCodeRejection.MALFORMED],
      // A map with the right shape but wrong field types.
      [
        PAIRING_URI_PREFIX + toBase64Url(encodeCbor({ v: 1, p: 'x', k: 'not bytes', n: '', t: 0, s: new Uint8Array(64) })),
        PairingCodeRejection.MALFORMED,
      ],
      // Truncated identity key.
      [
        PAIRING_URI_PREFIX +
          toBase64Url(encodeCbor({ v: 1, p: 'x', k: new Uint8Array(31), n: '', t: 0, s: new Uint8Array(64) })),
        PairingCodeRejection.MALFORMED,
      ],
      // Oversized display name.
      [
        PAIRING_URI_PREFIX +
          toBase64Url(
            encodeCbor({ v: 1, p: 'x', k: new Uint8Array(32), n: 'n'.repeat(200), t: 0, s: new Uint8Array(64) }),
          ),
        PairingCodeRejection.MALFORMED,
      ],
      // Negative timestamp.
      [
        PAIRING_URI_PREFIX +
          toBase64Url(encodeCbor({ v: 1, p: 'x', k: new Uint8Array(32), n: '', t: -1, s: new Uint8Array(64) })),
        PairingCodeRejection.MALFORMED,
      ],
      // An extra field an attacker appended hoping the parser would ignore it.
      [
        PAIRING_URI_PREFIX +
          toBase64Url(
            encodeCbor({ v: 1, p: 'x', k: new Uint8Array(32), n: '', t: 0, s: new Uint8Array(64), zz: 'extra' }),
          ),
        PairingCodeRejection.MALFORMED,
      ],
    ];
    for (const [input, reason] of cases) {
      expectRejection(() => parsePairingCode(input, WALL_EPOCH), reason);
    }
  });

  it('rejects a display name carrying control characters even with a valid signature', () => {
    // Forge the whole code, control characters and all, with a real key pair.
    const contents = {
      v: PAIRING_CODE_VERSION,
      p: maria.peerId,
      k: maria.signing.publicKey,
      n: 'Mar‮ia',
      t: WALL_EPOCH,
    };
    const signature = sign(
      concatBytes(utf8Encode('AirLink-v1-pairing-code'), encodeCbor(contents)),
      maria.signing.secretKey,
    );
    expectRejection(
      () => parsePairingCode(PAIRING_URI_PREFIX + toBase64Url(encodeCbor({ ...contents, s: signature })), WALL_EPOCH),
      PairingCodeRejection.MALFORMED,
    );
  });

  it('never throws from the non-throwing variant', () => {
    expect(tryParsePairingCode('rubbish', WALL_EPOCH).ok).toBe(false);
    const good = tryParsePairingCode(buildPairingCode(maria, 'Maria', WALL_EPOCH), WALL_EPOCH);
    expect(good.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Trust store
// ---------------------------------------------------------------------------

describe('TrustStore', () => {
  const maria = makeDevice('Maria', 7).identity;

  it('stores, looks up and removes a friend', () => {
    const store = new InMemoryTrustStore();
    expect(store.get(maria.peerId)).toBeUndefined();
    store.set(friendRow(maria, { displayName: 'Maria' }));
    expect(store.get(maria.peerId)).toEqual(maria.signing.publicKey);
    expect(store.list()).toHaveLength(1);
    store.remove(maria.peerId);
    expect(store.get(maria.peerId)).toBeUndefined();
  });

  it('copies buffers on the way in, so a stored key cannot be mutated from outside', () => {
    const store = new InMemoryTrustStore();
    const key = maria.signing.publicKey.slice();
    store.set(friendRow(maria, { identityKey: key }));
    key.fill(0);
    expect(store.get(maria.peerId)).toEqual(maria.signing.publicKey);
  });

  it('copies buffers on the way out too, so a returned row is not a handle on the anchor', () => {
    const store = new InMemoryTrustStore();
    const random = new SeededRandom(555);
    store.set(
      friendRow(maria, {
        advertisementKey: generateAdvertisementKey(random),
        selfAdvertisementKey: generateAdvertisementKey(random),
      }),
    );
    const before = store.record(maria.peerId);
    const advertisement = before?.advertisementKey?.slice();

    // A caller with a row in hand must not be able to rewrite the key the
    // handshake authenticates against.
    before?.identityKey.fill(0);
    before?.advertisementKey?.fill(0);
    for (const row of store.list()) {
      row.identityKey.fill(0);
      row.selfAdvertisementKey?.fill(0);
    }

    expect(store.get(maria.peerId)).toEqual(maria.signing.publicKey);
    expect(store.record(maria.peerId)?.identityKey).toEqual(maria.signing.publicKey);
    expect(store.record(maria.peerId)?.advertisementKey).toEqual(advertisement);
    expect(advertisableFriends(store)[0]?.advertisementKey).not.toEqual(new Uint8Array(ADVERTISEMENT_KEY_LENGTH));
  });

  it('treats a blocked peer as a stranger, never as trusted', () => {
    const store = new InMemoryTrustStore();
    store.set(friendRow(maria));
    store.block(maria.peerId);
    expect(store.isBlocked(maria.peerId)).toBe(true);
    expect(store.get(maria.peerId)).toBeUndefined();
    expect(store.record(maria.peerId)?.blocked).toBe(true);

    store.unblock(maria.peerId);
    expect(store.get(maria.peerId)).toEqual(maria.signing.publicKey);
  });

  it('keeps a block when the friendship is removed, and can block a stranger', () => {
    const store = new InMemoryTrustStore();
    store.set(friendRow(maria));
    store.block(maria.peerId);
    store.remove(maria.peerId);
    expect(store.record(maria.peerId)).toBeUndefined();
    expect(store.isBlocked(maria.peerId)).toBe(true);

    store.block('NEVERMETYOU12345');
    expect(store.isBlocked('NEVERMETYOU12345')).toBe(true);
  });

  it('bumps the revision on every mutation so caches can tell they are stale', () => {
    const store = new InMemoryTrustStore();
    const start = store.revision;
    store.set(friendRow(maria));
    store.block(maria.peerId);
    store.unblock(maria.peerId);
    store.remove(maria.peerId);
    expect(store.revision).toBe(start + 4);
  });

  it('touches lastSeenAt without disturbing anything else', () => {
    const store = new InMemoryTrustStore();
    store.set(friendRow(maria, { displayName: 'Maria' }));
    touchTrustedPeer(store, maria.peerId, WALL_EPOCH + 5000);
    expect(store.record(maria.peerId)?.lastSeenAt).toBe(WALL_EPOCH + 5000);
    expect(store.record(maria.peerId)?.displayName).toBe('Maria');
    // Touching a stranger is a no-op, not a crash.
    touchTrustedPeer(store, 'UNKNOWNPEERID000', WALL_EPOCH);
    expect(store.list()).toHaveLength(1);
  });

  it('refuses an inconsistent or oversized row', () => {
    const store = new InMemoryTrustStore();
    expect(() => store.set(friendRow(maria, { peerId: '' }))).toThrow(/peer id/);
    expect(() => store.set(friendRow(maria, { peerId: 'x'.repeat(65) }))).toThrow(/peer id/);
    // A peer id that does not hash from its key is the one thing the table may
    // never contain.
    expect(() => store.set(friendRow(maria, { peerId: 'NOTMYPEERID00000' }))).toThrow(/does not match/);
    expect(() => store.set(friendRow(maria, { identityKey: new Uint8Array(31) }))).toThrow(/32 bytes/);
    expect(() =>
      store.set(friendRow(maria, { displayName: 'x'.repeat(MAX_TRUSTED_DISPLAY_NAME_LENGTH + 1) })),
    ).toThrow(/display name/);
    expect(() => store.set(friendRow(maria, { advertisementKey: new Uint8Array(8) }))).toThrow(/advertisement key/);
    expect(() => store.set(friendRow(maria, { selfAdvertisementKey: new Uint8Array(64) }))).toThrow(
      /advertisement key/,
    );
    expect(() => store.set(friendRow(maria, { pairedAt: Number.NaN }))).toThrow(/timestamps/);
    expect(() =>
      validateTrustedPeer(friendRow(maria, { method: 'telepathy' as unknown as PairingMethod })),
    ).toThrow(/pairing method/);
    expect(store.list()).toHaveLength(0);
  });

  it('keeps the stronger pairing method when a friendship is re-established', () => {
    expect(strongerPairingMethod(PairingMethod.SAS, PairingMethod.QR)).toBe(PairingMethod.QR);
    expect(strongerPairingMethod(PairingMethod.QR, PairingMethod.SAS)).toBe(PairingMethod.QR);
    expect(strongerPairingMethod(PairingMethod.RESTORED, PairingMethod.SAS)).toBe(PairingMethod.SAS);
  });

  it('sanitises display names and spots hostile ones', () => {
    expect(hasControlCharacters('Maria')).toBe(false);
    expect(hasControlCharacters('Mar ia')).toBe(true);
    expect(hasControlCharacters('Mar‮ia')).toBe(true);
    expect(sanitiseDisplayName('  Maria  ')).toBe('Maria');
    expect(sanitiseDisplayName('x'.repeat(200)).length).toBe(MAX_TRUSTED_DISPLAY_NAME_LENGTH);
    // An emoji is never split down the middle by truncation.
    const emoji = sanitiseDisplayName('a'.repeat(63) + '\u{1F600}');
    expect(emoji).toBe('a'.repeat(63));
  });

  it('spots the invisible characters that turn one friend row into two', () => {
    // A line separator is not a C0 control, but it is still a line break: a name
    // carrying one renders as two rows, and the second one is whatever the peer
    // wants the user to read.
    expect(hasControlCharacters('Maria\u2028Verified')).toBe(true);
    expect(hasControlCharacters('Maria\u2029Verified')).toBe(true);
    expect(sanitiseDisplayName('Maria\u2028 Verified')).toBe('Maria Verified');
    // Bidi marks: invisible, and they reorder the glyphs around them just as the
    // overrides do.
    expect(hasControlCharacters('Mar\u200eia')).toBe(true);
    expect(hasControlCharacters('Mar\u200fia')).toBe(true);
    expect(hasControlCharacters('Mar\u061cia')).toBe(true);
    expect(sanitiseDisplayName('Mar\u200fia')).toBe('Maria');
    // Ordinary names, including non-Latin ones and emoji, are untouched.
    expect(hasControlCharacters('Mar\u00eda \u{1F3A7}')).toBe(false);
    expect(hasControlCharacters('\u0645\u0631\u064a\u0645')).toBe(false);
  });

  it('feeds the handshake’s lookupTrustedKey', () => {
    const store = new InMemoryTrustStore();
    const lookup = trustedKeyLookup(store);
    expect(lookup(maria.peerId)).toBeUndefined();
    store.set(friendRow(maria));
    expect(lookup(maria.peerId)).toEqual(maria.signing.publicKey);
    store.block(maria.peerId);
    expect(lookup(maria.peerId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Advertisement tokens
// ---------------------------------------------------------------------------

describe('advertisement tokens', () => {
  const random = new SeededRandom(31337);
  const key = generateAdvertisementKey(random);
  const strangerKey = generateAdvertisementKey(random);

  it('produces a six-byte token that a holder of the key can reproduce', () => {
    const token = deriveAdvertisementToken(key, WALL_EPOCH);
    expect(token.length).toBe(ADVERTISEMENT_TOKEN_LENGTH);
    expect(deriveAdvertisementToken(key.slice(), WALL_EPOCH + 1000)).toEqual(token);
  });

  it('rotates: a later window produces a different token', () => {
    const now = deriveAdvertisementToken(key, WALL_EPOCH);
    const later = deriveAdvertisementToken(key, WALL_EPOCH + TOKEN_ROTATION_WINDOW_MS);
    const muchLater = deriveAdvertisementToken(key, WALL_EPOCH + 10 * TOKEN_ROTATION_WINDOW_MS);
    expect(later).not.toEqual(now);
    expect(muchLater).not.toEqual(now);
    expect(muchLater).not.toEqual(later);
    expect(windowIndexFor(WALL_EPOCH + TOKEN_ROTATION_WINDOW_MS)).toBe(windowIndexFor(WALL_EPOCH) + 1);
  });

  it('gives two friends different tokens for the same device', () => {
    // Two friendships, two keys - which is exactly why the keys are per pairing.
    const forMaria = generateAdvertisementKey(random);
    const forSam = generateAdvertisementKey(random);
    expect(deriveAdvertisementToken(forMaria, WALL_EPOCH)).not.toEqual(deriveAdvertisementToken(forSam, WALL_EPOCH));
  });

  it('recognises a friend across a window boundary despite clock skew', () => {
    const candidates = [{ peerId: 'MARIA00000000000', advertisementKey: key }];
    // Maria's phone is a whole window behind ours: it is still broadcasting the
    // previous window's token when we look.
    const boundary = Math.ceil(WALL_EPOCH / TOKEN_ROTATION_WINDOW_MS) * TOKEN_ROTATION_WINDOW_MS;
    const stale = deriveAdvertisementToken(key, boundary - 1);
    expect(matchAdvertisementToken(stale, candidates, boundary + 1)).toBe('MARIA00000000000');

    // And one window ahead, for a phone whose clock runs fast.
    const early = deriveAdvertisementToken(key, boundary + TOKEN_ROTATION_WINDOW_MS);
    expect(matchAdvertisementToken(early, candidates, boundary + 1)).toBe('MARIA00000000000');

    // Two windows out is beyond the tolerance and is correctly not recognised.
    const tooOld = deriveAdvertisementToken(key, boundary - 2 * TOKEN_ROTATION_WINDOW_MS - 1);
    expect(matchAdvertisementToken(tooOld, candidates, boundary + 1)).toBeNull();
    expect(acceptableTokens(key, WALL_EPOCH)).toHaveLength(3);
  });

  it('does not match a stranger', () => {
    const candidates = [{ peerId: 'MARIA00000000000', advertisementKey: key }];
    expect(matchAdvertisementToken(deriveAdvertisementToken(strangerKey, WALL_EPOCH), candidates, WALL_EPOCH)).toBeNull();
    expect(matchAdvertisementToken(new Uint8Array(6), candidates, WALL_EPOCH)).toBeNull();
  });

  it('drops hostile token input rather than throwing', () => {
    const candidates = [{ peerId: 'MARIA00000000000', advertisementKey: key }];
    expect(matchAdvertisementToken(new Uint8Array(0), candidates, WALL_EPOCH)).toBeNull();
    expect(matchAdvertisementToken(new Uint8Array(5), candidates, WALL_EPOCH)).toBeNull();
    expect(matchAdvertisementToken(new Uint8Array(4096), candidates, WALL_EPOCH)).toBeNull();
    expect(matchAdvertisementToken(deriveAdvertisementToken(key, WALL_EPOCH), candidates, Number.NaN)).toBeNull();
    expect(matchAdvertisementToken(deriveAdvertisementToken(key, WALL_EPOCH), candidates, -1)).toBeNull();
    // A candidate row with a corrupt key is skipped, not fatal.
    const corrupt = [{ peerId: 'X', advertisementKey: new Uint8Array(3) }, ...candidates];
    expect(matchAdvertisementToken(deriveAdvertisementToken(key, WALL_EPOCH), corrupt, WALL_EPOCH)).toBe(
      'MARIA00000000000',
    );
    expect(() => deriveAdvertisementToken(new Uint8Array(3), WALL_EPOCH)).toThrow(/32 bytes/);
  });

  it('cycles the advertisement through every friend', () => {
    const friends = [
      { peerId: 'A', advertisementKey: generateAdvertisementKey(random) },
      { peerId: 'B', advertisementKey: generateAdvertisementKey(random) },
      { peerId: 'C', advertisementKey: generateAdvertisementKey(random) },
    ];
    const seen = new Set<string>();
    for (let slot = 0; slot < 6; slot++) {
      const chosen = tokenRotation(friends, slot, WALL_EPOCH);
      expect(chosen).not.toBeNull();
      seen.add(chosen?.peerId ?? '');
    }
    expect([...seen].sort()).toEqual(['A', 'B', 'C']);
    // Negative and absurd slots must not index out of bounds.
    expect(tokenRotation(friends, -1, WALL_EPOCH)?.peerId).toBe('C');
    expect(tokenRotation(friends, 1.5, WALL_EPOCH)).toBeNull();
    expect(tokenRotation([], 0, WALL_EPOCH)).toBeNull();
  });

  it('keeps advertising to everyone else when one friend row is unusable', () => {
    // The matcher already skips a corrupt candidate. The broadcaster has more to
    // lose by disagreeing: throwing here stops the advertising loop, and this
    // phone becomes invisible to every friend it has because of one bad row.
    const good = generateAdvertisementKey(random);
    const rows = [
      { peerId: 'CORRUPT', advertisementKey: new Uint8Array(3) },
      { peerId: 'MARIA00000000000', advertisementKey: good },
    ];
    for (const slot of [0, 1, 2, 3]) {
      expect(tokenRotation(rows, slot, WALL_EPOCH)?.peerId).toBe('MARIA00000000000');
    }
    // Nothing usable at all is silence, not a crash.
    expect(tokenRotation([{ peerId: 'CORRUPT', advertisementKey: new Uint8Array(3) }], 0, WALL_EPOCH)).toBeNull();
    // And an unusable clock is silence too.
    expect(tokenRotation(rows, 0, Number.NaN)).toBeNull();
    expect(tokenRotation(rows, 0, -1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Friends: recognition, scanning, blocking
// ---------------------------------------------------------------------------

describe('friend recognition and blocking', () => {
  const maria = makeDevice('Maria', 11).identity;
  const random = new SeededRandom(4242);

  function storeWithMaria(): { store: InMemoryTrustStore; mariaKey: Uint8Array; ourKey: Uint8Array } {
    const store = new InMemoryTrustStore();
    const mariaKey = generateAdvertisementKey(random);
    const ourKey = generateAdvertisementKey(random);
    store.set(
      friendRow(maria, { displayName: 'Maria', advertisementKey: mariaKey, selfAdvertisementKey: ourKey }),
    );
    return { store, mariaKey, ourKey };
  }

  it('puts a name to a friend’s token and ignores a stranger’s', () => {
    const { store, mariaKey } = storeWithMaria();
    const seen = deriveAdvertisementToken(mariaKey, WALL_EPOCH);
    expect(recogniseFriendToken(store, seen, WALL_EPOCH)?.displayName).toBe('Maria');

    const stranger = deriveAdvertisementToken(generateAdvertisementKey(random), WALL_EPOCH);
    expect(recogniseFriendToken(store, stranger, WALL_EPOCH)).toBeNull();
  });

  it('separates the key we advertise under from the key we listen for', () => {
    const { store, mariaKey, ourKey } = storeWithMaria();
    expect(advertisableFriends(store)).toEqual([{ peerId: maria.peerId, advertisementKey: ourKey }]);
    expect(recognisableFriends(store)).toEqual([{ peerId: maria.peerId, advertisementKey: mariaKey }]);
    // The two ends of one friendship therefore broadcast different tokens.
    expect(deriveAdvertisementToken(ourKey, WALL_EPOCH)).not.toEqual(deriveAdvertisementToken(mariaKey, WALL_EPOCH));
  });

  it('hides a blocked friend from discovery but still recognises them to refuse them', () => {
    const { store, mariaKey } = storeWithMaria();
    store.block(maria.peerId);
    const seen = deriveAdvertisementToken(mariaKey, WALL_EPOCH);
    expect(recogniseFriendToken(store, seen, WALL_EPOCH)).toBeNull();
    expect(recogniseFriendToken(store, seen, WALL_EPOCH, { includeBlocked: true })?.blocked).toBe(true);
    expect(advertisableFriends(store)).toHaveLength(0);
  });

  it('refuses a blocked peer before the handshake, by token and by id', () => {
    const { store, mariaKey } = storeWithMaria();
    const seen = deriveAdvertisementToken(mariaKey, WALL_EPOCH);
    expect(screenIncomingConnection(store, { advertisementToken: seen }, WALL_EPOCH).allowed).toBe(true);

    store.block(maria.peerId);
    const byToken = screenIncomingConnection(store, { advertisementToken: seen }, WALL_EPOCH);
    expect(byToken.allowed).toBe(false);
    expect(byToken.peerId).toBe(maria.peerId);
    expect(byToken.reason).toMatch(/blocked/);

    const byId = screenIncomingConnection(store, { peerId: maria.peerId }, WALL_EPOCH);
    expect(byId.allowed).toBe(false);

    // A stranger is allowed through to the handshake, where six digits await.
    const stranger = screenIncomingConnection(store, { endpointId: 'endpoint-x' }, WALL_EPOCH);
    expect(stranger).toEqual({ allowed: true, peerId: null, recognised: false });
  });

  it('screens hostile advertisement input without throwing', () => {
    const { store } = storeWithMaria();
    for (const token of [new Uint8Array(0), new Uint8Array(5), new Uint8Array(1024)]) {
      expect(screenIncomingConnection(store, { advertisementToken: token }, WALL_EPOCH).allowed).toBe(true);
    }
    expect(screenIncomingConnection(store, { peerId: '' }, WALL_EPOCH).allowed).toBe(true);
  });

  it('emits a deliberately vague refusal, so a block does not confirm itself', () => {
    const frame = refusalFrame();
    expect(frame.length).toBeGreaterThan(2);
    // Nothing in the bytes says "blocked".
    expect(new TextDecoder().decode(frame)).not.toMatch(/block/i);
  });

  it('records a scanned code as a QR friendship the handshake will recognise', () => {
    const store = new InMemoryTrustStore();
    const device = makeDevice('Maria', 12);
    const uri = buildPairingCode(device.identity, 'Maria', WALL_EPOCH);
    const code = parsePairingCode(uri, WALL_EPOCH);

    const result = recordScannedFriend(store, code, WALL_EPOCH);
    expect(result.ok).toBe(true);
    expect(store.get(device.identity.peerId)).toEqual(device.identity.signing.publicKey);
    expect(store.record(device.identity.peerId)?.method).toBe(PairingMethod.QR);
    // The identity key came out of band; the advertisement key cannot have, so
    // it waits for the two devices to actually meet.
    expect(store.record(device.identity.peerId)?.advertisementKey).toBeUndefined();
  });

  it('refuses to re-friend a blocked peer from a scanned code', () => {
    const store = new InMemoryTrustStore();
    const device = makeDevice('Mallory', 13);
    store.block(device.identity.peerId);
    const code = parsePairingCode(buildPairingCode(device.identity, 'Mallory', WALL_EPOCH), WALL_EPOCH);
    const result = recordScannedFriend(store, code, WALL_EPOCH);
    expect(result.ok).toBe(false);
    expect(store.get(device.identity.peerId)).toBeUndefined();
  });

  it('keeps the row when blocking, and drops it when removing', () => {
    const { store } = storeWithMaria();
    endFriendship(store, maria.peerId, { block: true });
    expect(store.record(maria.peerId)?.blocked).toBe(true);
    expect(recognisableFriends(store, { includeBlocked: true })).toHaveLength(1);

    endFriendship(store, maria.peerId);
    expect(store.record(maria.peerId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SAS state machine, in isolation
// ---------------------------------------------------------------------------

describe('SAS pairing state machine', () => {
  const a = makeDevice('A', 21).identity;
  const b = makeDevice('B', 22).identity;

  function makeSas(
    clock: VirtualClock,
    sent: Array<{ type: number; value: CborValue }>,
    overrides: { advertisementKey?: Uint8Array; timeoutMs?: number; resendIntervalMs?: number } = {},
  ): SasPairing {
    return new SasPairing({
      clock,
      sasCode: '483291',
      localIdentityKey: a.signing.publicKey,
      remoteIdentityKey: b.signing.publicKey,
      send: (type, value) => sent.push({ type, value }),
      ...overrides,
      ...(overrides.advertisementKey ? { localAdvertisementKey: overrides.advertisementKey } : {}),
    });
  }

  const binding = pairingBinding('483291', a.signing.publicKey, b.signing.publicKey);

  it('derives the same binding on both sides regardless of argument order', () => {
    expect(pairingBinding('483291', b.signing.publicKey, a.signing.publicKey)).toEqual(binding);
    expect(binding.length).toBe(PAIRING_BINDING_LENGTH);
    // A different code is a different ceremony.
    expect(pairingBinding('000000', a.signing.publicKey, b.signing.publicKey)).not.toEqual(binding);
  });

  it('walks awaiting-both → one-confirmed → both-confirmed', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent);
    expect(sas.current).toBe(SasPairingState.AWAITING_BOTH);

    sas.confirm();
    expect(sas.current).toBe(SasPairingState.ONE_CONFIRMED);
    expect(sent[0]?.type).toBe(PAIRING_CONFIRM);

    expect(sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: true })).toBe(true);
    expect(sas.current).toBe(SasPairingState.BOTH_CONFIRMED);
    expect(sas.isTerminal).toBe(true);
    // We acknowledged their confirmation.
    expect(sent.some((m) => m.type === PAIRING_CONFIRM_ACK)).toBe(true);
    sas.dispose();
    expect(clock.pendingTimers).toBe(0);
  });

  it('reaches one-confirmed when the remote side goes first', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent);
    sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: true });
    expect(sas.current).toBe(SasPairingState.ONE_CONFIRMED);
    sas.confirm();
    expect(sas.current).toBe(SasPairingState.BOTH_CONFIRMED);
    sas.dispose();
  });

  it('is rejected when the local user declines', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent);
    sas.decline();
    expect(sas.current).toBe(SasPairingState.REJECTED);
    expect((sent[0]?.value as Record<string, CborValue>).a).toBe(false);
    // Latched: a later change of heart cannot resurrect it, and neither can the
    // peer's acceptance.
    sas.confirm();
    sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: true });
    expect(sas.current).toBe(SasPairingState.REJECTED);
    sas.dispose();
  });

  it('is rejected when the remote side declines', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent);
    sas.confirm();
    sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: false });
    expect(sas.current).toBe(SasPairingState.REJECTED);
    expect(sas.remoteDecision).toBe('decline');
    sas.dispose();
  });

  it('times out rather than leaving the sheet spinning', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const settled: string[] = [];
    const sas = makeSas(clock, sent, { timeoutMs: 10_000 });
    sas.events.on('settled', ({ state }) => settled.push(state));
    sas.confirm();
    clock.advance(9_000);
    expect(sas.current).toBe(SasPairingState.ONE_CONFIRMED);
    clock.advance(2_000);
    expect(sas.current).toBe(SasPairingState.TIMED_OUT);
    expect(settled).toEqual([SasPairingState.TIMED_OUT]);
    // The timeout also stops the retransmission it was covering.
    const before = sent.length;
    clock.advance(30_000);
    expect(sent.length).toBe(before);
    sas.dispose();
    expect(clock.pendingTimers).toBe(0);
  });

  it('repeats its decision until acknowledged, then stops', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent, { resendIntervalMs: 500, timeoutMs: 60_000 });
    sas.confirm();
    clock.advance(2_100);
    const confirms = sent.filter((m) => m.type === PAIRING_CONFIRM).length;
    expect(confirms).toBeGreaterThan(3);

    sas.handlePeerMessage(PAIRING_CONFIRM_ACK, { b: binding });
    expect(sas.isAcknowledged).toBe(true);
    const after = sent.filter((m) => m.type === PAIRING_CONFIRM).length;
    clock.advance(5_000);
    expect(sent.filter((m) => m.type === PAIRING_CONFIRM).length).toBe(after);
    sas.dispose();
  });

  it('bounds retransmission so a silent peer costs a fixed amount', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = new SasPairing({
      clock,
      sasCode: '483291',
      localIdentityKey: a.signing.publicKey,
      remoteIdentityKey: b.signing.publicKey,
      send: (type, value) => sent.push({ type, value }),
      resendIntervalMs: 100,
      timeoutMs: 600_000,
      maxResends: 3,
    });
    sas.confirm();
    clock.advance(60_000);
    expect(sent.filter((m) => m.type === PAIRING_CONFIRM).length).toBe(4); // 1 initial + 3 repeats
    sas.dispose();
  });

  it('carries the advertisement key and keeps a copy of the peer’s', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const ours = generateAdvertisementKey(new SeededRandom(9));
    const theirs = generateAdvertisementKey(new SeededRandom(10));
    const sas = makeSas(clock, sent, { advertisementKey: ours });
    sas.confirm();
    expect((sent[0]?.value as Record<string, CborValue>).k).toEqual(ours);

    sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: true, k: theirs });
    expect(sas.remoteAdvertisementKey).toEqual(theirs);
    // Stored as a copy: the decoded packet buffer must not be able to change it.
    theirs.fill(0);
    expect(sas.remoteAdvertisementKey).not.toEqual(theirs);
    sas.dispose();
  });

  // -- hostile input ---------------------------------------------------------

  it('drops a confirmation from a different handshake', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent);
    const foreign = pairingBinding('000000', a.signing.publicKey, b.signing.publicKey);
    expect(sas.handlePeerMessage(PAIRING_CONFIRM, { b: foreign, a: true })).toBe(false);
    expect(sas.current).toBe(SasPairingState.AWAITING_BOTH);
    expect(sas.foreignMessages).toBe(1);
    // And it was not even acknowledged.
    expect(sent).toHaveLength(0);
    sas.dispose();
  });

  it('drops malformed, mistyped and oversized payloads without changing state', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent);
    const bad: Array<CborValue | null> = [
      null,
      'a string',
      [1, 2, 3],
      new Uint8Array(16),
      {},
      { b: 'not bytes', a: true },
      { b: new Uint8Array(PAIRING_BINDING_LENGTH - 1), a: true },
      { b: new Uint8Array(4096), a: true },
      { b: binding },
      { b: binding, a: 1 },
      { b: binding, a: 'yes' },
      { b: binding, a: true, k: new Uint8Array(31) },
      { b: binding, a: true, k: new Uint8Array(ADVERTISEMENT_KEY_LENGTH * 100) },
      { b: binding, a: true, k: 'not bytes' },
    ];
    for (const value of bad) {
      expect(sas.handlePeerMessage(PAIRING_CONFIRM, value)).toBe(false);
    }
    expect(sas.current).toBe(SasPairingState.AWAITING_BOTH);
    expect(sas.remoteDecision).toBeNull();
    expect(sas.malformedMessages).toBeGreaterThan(0);

    // An unrelated message type is not our business at all.
    expect(sas.handlePeerMessage(0x99, { b: binding, a: true })).toBe(false);
    sas.dispose();
  });

  it('takes the first remote decision and ignores a peer that changes its mind', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent);
    sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: true });
    sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: false });
    expect(sas.remoteDecision).toBe('accept');
    sas.dispose();
  });

  it('keeps acknowledging repeats after settling, because our ack may be the loss', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent);
    sas.confirm();
    sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: true });
    const acks = sent.filter((m) => m.type === PAIRING_CONFIRM_ACK).length;
    sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: true });
    expect(sent.filter((m) => m.type === PAIRING_CONFIRM_ACK).length).toBe(acks + 1);
    sas.dispose();
  });

  it('never hands the advertisement key to a peer it is declining', () => {
    // The key is a permanent tracking secret: whoever holds it recognises this
    // device's broadcasts in every future window. A decline is exactly the case
    // where the other end may be an attacker caught relaying the handshake.
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const ours = generateAdvertisementKey(new SeededRandom(77));
    const sas = makeSas(clock, sent, { advertisementKey: ours, resendIntervalMs: 100, timeoutMs: 60_000 });

    sas.decline();
    clock.advance(1_000);
    const confirms = sent.filter((m) => m.type === PAIRING_CONFIRM);
    expect(confirms.length).toBeGreaterThan(1); // the retransmissions too
    for (const message of confirms) {
      const body = message.value as Record<string, CborValue>;
      expect(body.a).toBe(false);
      expect(body.k).toBeUndefined();
    }
    sas.dispose();
  });

  it('never stores the advertisement key of a peer that declined', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const theirs = generateAdvertisementKey(new SeededRandom(78));
    const sas = makeSas(clock, sent);
    sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: false, k: theirs });
    expect(sas.current).toBe(SasPairingState.REJECTED);
    expect(sas.remoteAdvertisementKey).toBeNull();
    sas.dispose();
  });

  it('ignores an acknowledgement for a decision it has not made', () => {
    // The peer only ever acks in reply to our confirmation. One that arrives
    // first is either a bug or an attempt to switch off our retransmission
    // before it has sent anything.
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent, { resendIntervalMs: 100, timeoutMs: 60_000 });

    expect(sas.handlePeerMessage(PAIRING_CONFIRM_ACK, { b: binding })).toBe(false);
    expect(sas.isAcknowledged).toBe(false);

    sas.confirm();
    clock.advance(550);
    // The user's tap is still repeated on a lossy link.
    expect(sent.filter((m) => m.type === PAIRING_CONFIRM).length).toBeGreaterThan(3);
    sas.dispose();
  });

  it('bounds the acknowledgements a flooding peer can pull out of the radio', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent, { timeoutMs: 600_000 });
    const budget = sas.acknowledgementsLeft;

    for (let i = 0; i < 20_000; i++) sas.handlePeerMessage(PAIRING_CONFIRM, { b: binding, a: true });

    const acks = sent.filter((m) => m.type === PAIRING_CONFIRM_ACK).length;
    expect(acks).toBe(budget);
    expect(sas.acknowledgementsLeft).toBe(0);
    expect(sas.suppressedAcks).toBeGreaterThan(0);
    // Still far more than a genuinely lossy peer's own retry limit needs.
    expect(budget).toBeGreaterThan(24);
    // And the decision itself was still recorded.
    expect(sas.remoteDecision).toBe('accept');
    sas.dispose();
  });

  it('repeats an unacknowledged decision again when the link is replaced', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    const sent: Array<{ type: number; value: CborValue }> = [];
    const sas = makeSas(clock, sent, { resendIntervalMs: 100, timeoutMs: 600_000 });
    sas.confirm();
    clock.advance(60_000);
    const exhausted = sent.filter((m) => m.type === PAIRING_CONFIRM).length;
    // The whole budget went into a link that was not carrying anything.
    clock.advance(60_000);
    expect(sent.filter((m) => m.type === PAIRING_CONFIRM).length).toBe(exhausted);

    sas.resumeRetransmission();
    clock.advance(1_000);
    expect(sent.filter((m) => m.type === PAIRING_CONFIRM).length).toBeGreaterThan(exhausted);

    // Bounded: an acknowledged, or an abandoned, ceremony resumes nothing.
    sas.handlePeerMessage(PAIRING_CONFIRM_ACK, { b: binding });
    const settledCount = sent.filter((m) => m.type === PAIRING_CONFIRM).length;
    sas.resumeRetransmission();
    clock.advance(5_000);
    expect(sent.filter((m) => m.type === PAIRING_CONFIRM).length).toBe(settledCount);
    sas.dispose();
  });

  it('refuses an advertisement key of the wrong length at construction', () => {
    const clock = new VirtualClock(0, WALL_EPOCH);
    expect(
      () =>
        new SasPairing({
          clock,
          sasCode: '483291',
          localIdentityKey: a.signing.publicKey,
          remoteIdentityKey: b.signing.publicKey,
          send: () => undefined,
          localAdvertisementKey: new Uint8Array(8),
        }),
    ).toThrow(/32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// End to end, over two real PeerSessions
// ---------------------------------------------------------------------------

describe('pairing over two real sessions', () => {
  it('runs the full six-digit ceremony and leaves both friend lists correct', async () => {
    const ctx = await connectPair();

    // Both sides are held at the pairing gate, showing the same digits.
    expect(ctx.sessionA.state).toBe(ConnectionState.PAIRING);
    expect(ctx.sessionB.state).toBe(ConnectionState.PAIRING);
    expect(ctx.pairingA.sasCode).toBe(ctx.pairingB.sasCode);
    expect(ctx.pairingA.sasCode).toMatch(/^\d{6}$/);
    expect(ctx.pairingA.state).toBe(SasPairingState.AWAITING_BOTH);

    const pairedA: string[] = [];
    const pairedB: string[] = [];
    ctx.pairingA.events.on('paired', ({ peer, firstTime }) => pairedA.push(`${peer.peerId}:${String(firstTime)}`));
    ctx.pairingB.events.on('paired', ({ peer }) => pairedB.push(peer.peerId));

    ctx.pairingA.confirm();
    await ctx.clock.advanceAsync(300);
    expect(ctx.pairingA.state).toBe(SasPairingState.ONE_CONFIRMED);

    ctx.pairingB.confirm();
    await ctx.clock.advanceAsync(1000);

    expect(ctx.pairingA.state).toBe(SasPairingState.BOTH_CONFIRMED);
    expect(ctx.pairingB.state).toBe(SasPairingState.BOTH_CONFIRMED);
    expect(ctx.sessionA.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.sessionB.state).toBe(ConnectionState.CONNECTED);
    expect(pairedA).toEqual([`${ctx.maria.identity.peerId}:true`]);
    expect(pairedB).toEqual([ctx.alejandro.identity.peerId]);

    const mariaRow = ctx.alejandro.trust.record(ctx.maria.identity.peerId);
    const alejandroRow = ctx.maria.trust.record(ctx.alejandro.identity.peerId);
    expect(mariaRow?.displayName).toBe('Maria');
    expect(alejandroRow?.displayName).toBe('Alejandro');
    expect(mariaRow?.method).toBe(PairingMethod.SAS);
    expect(mariaRow?.identityKey).toEqual(ctx.maria.identity.signing.publicKey);

    // The advertisement keys line up: what Alejandro listens for is what Maria
    // broadcasts, and vice versa.
    expect(mariaRow?.advertisementKey).toEqual(alejandroRow?.selfAdvertisementKey);
    expect(alejandroRow?.advertisementKey).toEqual(mariaRow?.selfAdvertisementKey);
    expect(mariaRow?.advertisementKey).not.toEqual(mariaRow?.selfAdvertisementKey);

    // And each now recognises the other in the air.
    const wallNow = ctx.clock.wallNow();
    const mariaBroadcast = deriveAdvertisementToken(alejandroRow?.selfAdvertisementKey as Uint8Array, wallNow);
    expect(recogniseFriendToken(ctx.alejandro.trust, mariaBroadcast, wallNow)?.displayName).toBe('Maria');

    ctx.pairingA.dispose();
    ctx.pairingB.dispose();
    await ctx.sessionA.close();
    await ctx.sessionB.close();
  });

  it('records nothing when one side declines, and tears the session down', async () => {
    const ctx = await connectPair();
    const refusedA: string[] = [];
    const refusedB: string[] = [];
    ctx.pairingA.events.on('refused', ({ reason }) => refusedA.push(reason));
    ctx.pairingB.events.on('refused', ({ reason }) => refusedB.push(reason));

    ctx.pairingA.confirm();
    await ctx.clock.advanceAsync(200);
    // Maria looks at her screen, sees different digits, and taps no.
    ctx.pairingB.decline();
    await ctx.clock.advanceAsync(1000);

    expect(ctx.pairingB.state).toBe(SasPairingState.REJECTED);
    expect(ctx.pairingA.state).toBe(SasPairingState.REJECTED);
    expect(refusedA).toEqual(['pairing declined']);
    expect(refusedB).toEqual(['pairing declined']);
    // Nobody became anybody's friend.
    expect(ctx.alejandro.trust.list()).toHaveLength(0);
    expect(ctx.maria.trust.list()).toHaveLength(0);
    expect(ctx.sessionA.state).toBe(ConnectionState.DISCONNECTED);
    expect(ctx.sessionB.state).toBe(ConnectionState.DISCONNECTED);
  });

  it('times out when nobody answers, so the UI can never hang', async () => {
    const ctx = await connectPair({ timeoutMs: 8_000 });
    const refused: string[] = [];
    ctx.pairingA.events.on('refused', ({ reason }) => refused.push(reason));

    await ctx.clock.advanceAsync(12_000);
    expect(ctx.pairingA.state).toBe(SasPairingState.TIMED_OUT);
    expect(refused).toEqual(['pairing timed out']);
    expect(ctx.alejandro.trust.list()).toHaveLength(0);
    ctx.pairingB.dispose();
  });

  it('needs no user interaction at all on the second meeting', async () => {
    const ctx = await connectPair({
      prepare: (a, b) => {
        a.trust.set(friendRow(b.identity, { displayName: 'Maria' }));
        b.trust.set(friendRow(a.identity, { displayName: 'Alejandro' }));
      },
    });

    await ctx.clock.advanceAsync(1000);
    expect(ctx.sessionA.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.sessionB.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.sessionA.awaitingUserConfirmation).toBe(false);
    // The controllers confirmed on the users' behalf and healed the missing
    // advertisement keys in the process.
    expect(ctx.pairingA.state).toBe(SasPairingState.BOTH_CONFIRMED);
    const row = ctx.alejandro.trust.record(ctx.maria.identity.peerId);
    expect(row?.advertisementKey?.length).toBe(ADVERTISEMENT_KEY_LENGTH);
    expect(row?.pairedAt).toBe(WALL_EPOCH);

    ctx.pairingA.dispose();
    ctx.pairingB.dispose();
    await ctx.sessionA.close();
    await ctx.sessionB.close();
  });

  it('completes a QR pairing with one tap on the side that was scanned', async () => {
    // Maria shows her code; Alejandro scans it before either device connects.
    const ctx = await connectPair({
      prepare: (a, b) => {
        const code = parsePairingCode(buildPairingCode(b.identity, 'Maria', WALL_EPOCH), WALL_EPOCH);
        expect(recordScannedFriend(a.trust, code, WALL_EPOCH).ok).toBe(true);
      },
    });

    // Alejandro's side needed nothing: the key arrived out of band.
    expect(ctx.sessionA.awaitingUserConfirmation).toBe(false);
    expect(ctx.sessionA.state).toBe(ConnectionState.CONNECTED);
    // Maria has never seen Alejandro, so her side still asks.
    expect(ctx.sessionB.awaitingUserConfirmation).toBe(true);

    ctx.pairingB.confirm();
    await ctx.clock.advanceAsync(1500);

    expect(ctx.sessionB.state).toBe(ConnectionState.CONNECTED);
    const mariaRow = ctx.alejandro.trust.record(ctx.maria.identity.peerId);
    const alejandroRow = ctx.maria.trust.record(ctx.alejandro.identity.peerId);
    // The scanned friendship keeps its stronger provenance.
    expect(mariaRow?.method).toBe(PairingMethod.QR);
    expect(alejandroRow?.method).toBe(PairingMethod.SAS);
    // And the advertisement keys the QR could not carry are now in place.
    expect(mariaRow?.advertisementKey).toEqual(alejandroRow?.selfAdvertisementKey);

    ctx.pairingA.dispose();
    ctx.pairingB.dispose();
    await ctx.sessionA.close();
    await ctx.sessionB.close();
  });

  it('refuses a blocked peer without ever showing a pairing sheet', async () => {
    const refused: Array<{ peerId: string | null; reason: string }> = [];
    let sheetShown = 0;
    const ctx = await connectPair({
      prepare: (a, b) => {
        a.trust.set(friendRow(b.identity, { displayName: 'Maria' }));
        a.trust.block(b.identity.peerId);
      },
      attach: (pairingA) => {
        pairingA.events.on('refused', (e) => refused.push(e));
        pairingA.events.on('confirmationRequired', () => {
          sheetShown++;
        });
      },
    });
    await ctx.clock.advanceAsync(1000);

    expect(sheetShown).toBe(0);
    expect(refused).toEqual([{ peerId: ctx.maria.identity.peerId, reason: 'peer is blocked' }]);
    expect(ctx.sessionA.state).toBe(ConnectionState.DISCONNECTED);
    // The block survived: they are still not trusted.
    expect(ctx.alejandro.trust.get(ctx.maria.identity.peerId)).toBeUndefined();
    ctx.pairingB.dispose();
  });

  it('completes the ceremony over a hostile link that loses, reorders and duplicates', async () => {
    // Handshake over a plausible BLE link - it has no retry of its own - then
    // degrade the radio hard before the humans tap anything.
    const ctx = await connectPair({ resendIntervalMs: 600 });
    expect(ctx.sessionA.state).toBe(ConnectionState.PAIRING);

    ctx.network.setConditions(HOSTILE_CONDITIONS);

    ctx.pairingA.confirm();
    await ctx.clock.advanceAsync(2_000);
    ctx.pairingB.confirm();
    await ctx.clock.advanceAsync(60_000);

    // Guard against the test quietly becoming a no-op: the radio really did
    // throw packets away during the ceremony.
    expect(ctx.linkA.metrics().packetsDropped + ctx.linkB.metrics().packetsDropped).toBeGreaterThan(0);

    // 15% reliable loss, 20% reordering, 10% duplication, 160-byte MTU - and the
    // ceremony still settles identically on both phones.
    expect(ctx.pairingA.state).toBe(SasPairingState.BOTH_CONFIRMED);
    expect(ctx.pairingB.state).toBe(SasPairingState.BOTH_CONFIRMED);
    expect(ctx.sessionA.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.sessionB.state).toBe(ConnectionState.CONNECTED);

    const mariaRow = ctx.alejandro.trust.record(ctx.maria.identity.peerId);
    const alejandroRow = ctx.maria.trust.record(ctx.alejandro.identity.peerId);
    expect(mariaRow?.advertisementKey).toEqual(alejandroRow?.selfAdvertisementKey);
    expect(alejandroRow?.advertisementKey).toEqual(mariaRow?.selfAdvertisementKey);
    // Duplicated confirmations must not have paired anyone twice.
    expect(ctx.alejandro.trust.list()).toHaveLength(1);
    expect(ctx.maria.trust.list()).toHaveLength(1);

    ctx.pairingA.dispose();
    ctx.pairingB.dispose();
    await ctx.sessionA.close();
    await ctx.sessionB.close();
  });

  it('tells the screen when the session dies with the digits still showing', async () => {
    // Maria walks out of range for good, or closes the app. Alejandro's sheet is
    // still up. Disposing quietly would take the ceremony's timeout with it and
    // leave those six digits on screen with nothing alive to ever remove them.
    const ctx = await connectPair();
    const refused: Array<{ peerId: string | null; reason: string }> = [];
    const paired: string[] = [];
    ctx.pairingA.events.on('refused', (e) => refused.push(e));
    ctx.pairingA.events.on('paired', ({ peer }) => paired.push(peer.peerId));
    expect(ctx.pairingA.state).toBe(SasPairingState.AWAITING_BOTH);

    await ctx.sessionB.close('user closed the app');
    await ctx.clock.advanceAsync(1_000);

    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toMatch(/session closed/);
    expect(refused[0]?.peerId).toBe(ctx.maria.identity.peerId);
    expect(paired).toEqual([]);
    expect(ctx.alejandro.trust.list()).toHaveLength(0);
    // And nothing is left ticking.
    expect(ctx.clock.pendingTimers).toBe(0);
  });

  it('does not report a refusal twice when the session closes after a decline', async () => {
    const ctx = await connectPair();
    const refusedA: string[] = [];
    ctx.pairingA.events.on('refused', ({ reason }) => refusedA.push(reason));
    ctx.pairingA.decline();
    await ctx.clock.advanceAsync(2_000);
    expect(refusedA).toEqual(['pairing declined']);
  });

  it('finishes the ceremony after the radio dies and comes back on a new link', async () => {
    // The link carrying the ceremony goes away between the tap and the peer
    // hearing about it. When a new one is found, both phones must end up in the
    // same place - one of them thinking it has a new friend while the other is
    // still waiting is the worst of the two possible outcomes.
    const ctx = await connectPair({ resendIntervalMs: 200 });
    expect(ctx.pairingA.state).toBe(SasPairingState.AWAITING_BOTH);

    await ctx.linkA.close('radio off');
    await ctx.clock.advanceAsync(100);

    // Alejandro taps confirm into a dead link, and every retry drains into it.
    ctx.pairingA.confirm();
    await ctx.clock.advanceAsync(30_000);
    expect(ctx.pairingB.remoteDecision).toBeNull();

    // A new link, on a fresh transport instance, carrying the same session.
    const pending = ctx.transportA.connect('endpoint-b');
    await ctx.clock.advanceAsync(300);
    const secondLink = await pending;
    ctx.sessionA.migrateToLink(secondLink);
    await ctx.clock.advanceAsync(2_000);

    // Maria taps hers.
    ctx.pairingB.confirm();
    await ctx.clock.advanceAsync(5_000);

    expect(ctx.pairingA.state).toBe(SasPairingState.BOTH_CONFIRMED);
    expect(ctx.pairingB.state).toBe(SasPairingState.BOTH_CONFIRMED);
    // Both friend lists agree, and the advertisement keys still line up.
    const mariaRow = ctx.alejandro.trust.record(ctx.maria.identity.peerId);
    const alejandroRow = ctx.maria.trust.record(ctx.alejandro.identity.peerId);
    expect(mariaRow?.advertisementKey).toEqual(alejandroRow?.selfAdvertisementKey);
    expect(alejandroRow?.advertisementKey).toEqual(mariaRow?.selfAdvertisementKey);

    ctx.pairingA.dispose();
    ctx.pairingB.dispose();
    await ctx.sessionA.close();
    await ctx.sessionB.close();
  });

  it('drops a confirmation forged inside the session for a different handshake', async () => {
    const ctx = await connectPair();
    // Maria's session is authenticated, so she can put anything she likes on the
    // control channel. A confirmation bound to another ceremony is not one of
    // the things that works.
    ctx.sessionB.sendControl(PAIRING_CONFIRM, { b: new Uint8Array(PAIRING_BINDING_LENGTH), a: true });
    ctx.sessionB.sendControl(PAIRING_CONFIRM, { b: 'not bytes', a: true } as unknown as CborValue);
    ctx.sessionB.sendControl(PAIRING_CONFIRM, { nonsense: true });
    await ctx.clock.advanceAsync(500);

    expect(ctx.pairingA.state).toBe(SasPairingState.AWAITING_BOTH);
    expect(ctx.pairingA.remoteDecision).toBeNull();
    expect(ctx.alejandro.trust.list()).toHaveLength(0);

    ctx.pairingA.dispose();
    ctx.pairingB.dispose();
    await ctx.sessionA.close();
    await ctx.sessionB.close();
  });
});
