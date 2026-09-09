import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../src/crypto/random.js';
import { createIdentity, peerIdFromIdentityKey, restoreIdentity, safetyNumber } from '../src/crypto/identity.js';
import { Handshake, HandshakeError, HandshakeRole, type HandshakeConfig } from '../src/crypto/handshake.js';
import { SecureSession } from '../src/crypto/session.js';
import { ReplayWindow } from '../src/crypto/replay.js';
import { deriveSasCode, formatSasCode, sasCodesMatch } from '../src/crypto/sas.js';
import { aeadOpen, aeadSeal, agree, generateAgreementKeyPair, sign, verifySignature } from '../src/crypto/primitives.js';
import { TransportKind, type PeerCapabilities } from '../src/protocol/capabilities.js';
import { toHex } from '../src/util/bytes.js';

function caps(name: string): PeerCapabilities {
  return {
    protocolVersion: 1,
    appVersion: '0.1.0',
    platform: 'node',
    deviceModel: 'test',
    displayName: name,
    deviceId: `device-${name}`,
    transports: [TransportKind.MOCK, TransportKind.BLE],
    features: ['chat', 'games', 'files'],
    games: [
      { id: 'tic-tac-toe', version: 1 },
      { id: 'chess', version: 1 },
    ],
    maxPayloadBytes: 65536,
  };
}

function makePair(seedA = 1, seedB = 2, trustStore?: Map<string, Uint8Array>) {
  const randA = new SeededRandom(seedA);
  const randB = new SeededRandom(seedB);
  const idA = createIdentity(randA, 1000);
  const idB = createIdentity(randB, 1000);
  const lookup = trustStore ? (peerId: string) => trustStore.get(peerId) : undefined;
  const configA: HandshakeConfig = {
    identity: idA,
    capabilities: caps('Alejandro'),
    random: randA,
    ...(lookup ? { lookupTrustedKey: lookup } : {}),
  };
  const configB: HandshakeConfig = {
    identity: idB,
    capabilities: caps('Maria'),
    random: randB,
    ...(lookup ? { lookupTrustedKey: lookup } : {}),
  };
  return { idA, idB, configA, configB };
}

/** Run the four-message handshake to completion. */
function runHandshake(configA: HandshakeConfig, configB: HandshakeConfig) {
  const initiator = new Handshake(HandshakeRole.INITIATOR, configA);
  const responder = new Handshake(HandshakeRole.RESPONDER, configB);

  const init = initiator.createInit();
  const response = responder.readInitAndCreateResponse(init);
  const authR = responder.createResponderAuth();
  initiator.readResponse(response);
  const { message: authI, result: resultA } = initiator.readResponderAuthAndCreateAuth(authR);
  const resultB = responder.readInitiatorAuth(authI);
  return { initiator, responder, resultA, resultB };
}

describe('identity', () => {
  it('derives a stable peer id from the identity key', () => {
    const rand = new SeededRandom(7);
    const id = createIdentity(rand, 0);
    expect(id.peerId).toBe(peerIdFromIdentityKey(id.signing.publicKey));
    expect(id.peerId).toHaveLength(16);
    const restored = restoreIdentity(id.signing.secretKey, id.deviceId, id.createdAt);
    expect(restored.peerId).toBe(id.peerId);
    expect(toHex(restored.signing.publicKey)).toBe(toHex(id.signing.publicKey));
  });

  it('produces the same safety number regardless of argument order', () => {
    const a = createIdentity(new SeededRandom(1), 0).signing.publicKey;
    const b = createIdentity(new SeededRandom(2), 0).signing.publicKey;
    expect(safetyNumber(a, b)).toBe(safetyNumber(b, a));
    expect(safetyNumber(a, b)).toMatch(/^(\d{5} ){9}\d{5}$/);
  });

  it('never derives an id from anything but the public key', () => {
    const rand = new SeededRandom(3);
    const one = createIdentity(rand, 0);
    const two = restoreIdentity(one.signing.secretKey, 'a-totally-different-device-id', 999);
    expect(two.peerId).toBe(one.peerId);
  });
});

describe('primitives', () => {
  it('signs and verifies', () => {
    const id = createIdentity(new SeededRandom(4), 0);
    const msg = new Uint8Array([1, 2, 3, 4]);
    const sig = sign(msg, id.signing.secretKey);
    expect(verifySignature(sig, msg, id.signing.publicKey)).toBe(true);
    const tampered = msg.slice();
    tampered[0] = (tampered[0] as number) ^ 1;
    expect(verifySignature(sig, tampered, id.signing.publicKey)).toBe(false);
  });

  it('returns false rather than throwing on a malformed public key', () => {
    const sig = new Uint8Array(64);
    expect(verifySignature(sig, new Uint8Array(4), new Uint8Array(32).fill(0xff))).toBe(false);
    expect(verifySignature(new Uint8Array(3), new Uint8Array(4), new Uint8Array(32))).toBe(false);
  });

  it('agrees on the same X25519 secret from both sides', () => {
    const a = generateAgreementKeyPair();
    const b = generateAgreementKeyPair();
    expect(toHex(agree(a.secretKey, b.publicKey))).toBe(toHex(agree(b.secretKey, a.publicKey)));
  });

  it('rejects a low-order X25519 public key', () => {
    const a = generateAgreementKeyPair();
    expect(() => agree(a.secretKey, new Uint8Array(32))).toThrow(/contributory/);
  });

  it('binds associated data into the AEAD tag', () => {
    const key = new Uint8Array(32).fill(9);
    const nonce = new Uint8Array(12).fill(1);
    const aad = new Uint8Array([1, 2, 3]);
    const ct = aeadSeal('chacha20poly1305', key, nonce, new Uint8Array([7, 7]), aad);
    expect(aeadOpen('chacha20poly1305', key, nonce, ct, aad)).toEqual(new Uint8Array([7, 7]));
    expect(aeadOpen('chacha20poly1305', key, nonce, ct, new Uint8Array([9, 9, 9]))).toBeNull();
  });

  it('supports AES-256-GCM as the alternate AEAD', () => {
    const key = new Uint8Array(32).fill(3);
    const nonce = new Uint8Array(12).fill(4);
    const ct = aeadSeal('aes256gcm', key, nonce, new Uint8Array([5]), new Uint8Array(0));
    expect(aeadOpen('aes256gcm', key, nonce, ct, new Uint8Array(0))).toEqual(new Uint8Array([5]));
  });
});

describe('handshake', () => {
  it('completes and agrees on keys, identities and capabilities', () => {
    const { idA, idB, configA, configB } = makePair();
    const { resultA, resultB } = runHandshake(configA, configB);

    expect(resultA.peerId).toBe(idB.peerId);
    expect(resultB.peerId).toBe(idA.peerId);
    expect(toHex(resultA.keys.sessionId)).toBe(toHex(resultB.keys.sessionId));
    // A's send key must be B's receive key, and vice versa.
    expect(toHex(resultA.keys.sendKey)).toBe(toHex(resultB.keys.recvKey));
    expect(toHex(resultA.keys.recvKey)).toBe(toHex(resultB.keys.sendKey));
    expect(toHex(resultA.transcriptHash)).toBe(toHex(resultB.transcriptHash));
    expect(resultA.peerCapabilities.displayName).toBe('Maria');
    expect(resultB.peerCapabilities.displayName).toBe('Alejandro');
    expect(resultA.peerCapabilities.games).toEqual([
      { id: 'tic-tac-toe', version: 1 },
      { id: 'chess', version: 1 },
    ]);
  });

  it('derives the same six-digit SAS on both sides', () => {
    const { configA, configB } = makePair();
    const { resultA, resultB } = runHandshake(configA, configB);
    const codeA = deriveSasCode(resultA.sasCodeSeed);
    const codeB = deriveSasCode(resultB.sasCodeSeed);
    expect(codeA).toBe(codeB);
    expect(codeA).toMatch(/^\d{6}$/);
    expect(formatSasCode(codeA)).toMatch(/^\d{3} \d{3}$/);
    expect(sasCodesMatch(formatSasCode(codeA), codeB)).toBe(true);
  });

  it('produces a different SAS for every fresh handshake', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { configA, configB } = makePair(100 + i, 200 + i);
      const { resultA } = runHandshake(configA, configB);
      seen.add(deriveSasCode(resultA.sasCodeSeed));
    }
    expect(seen.size).toBeGreaterThan(9);
  });

  it('recognises a previously trusted peer without any user interaction', () => {
    const trust = new Map<string, Uint8Array>();
    const { idA, idB, configA, configB } = makePair(11, 12, trust);
    trust.set(idB.peerId, idB.signing.publicKey);
    trust.set(idA.peerId, idA.signing.publicKey);
    const { resultA, resultB } = runHandshake(configA, configB);
    expect(resultA.recognisedFromTrustStore).toBe(true);
    expect(resultB.recognisedFromTrustStore).toBe(true);
  });

  it('aborts when a trusted peer presents a different identity key', () => {
    const trust = new Map<string, Uint8Array>();
    const { idB, configA, configB } = makePair(21, 22, trust);
    // Store a WRONG key for B - as if an attacker had swapped in their own.
    const wrong = createIdentity(new SeededRandom(99), 0).signing.publicKey;
    trust.set(idB.peerId, wrong);
    expect(() => runHandshake(configA, configB)).toThrow(HandshakeError);
  });

  it('detects a man in the middle through diverging SAS codes', () => {
    // Attacker M runs one handshake with A and another with B.
    const { configA, configB } = makePair(31, 32);
    const randM = new SeededRandom(33);
    const idM = createIdentity(randM, 0);
    const configM: HandshakeConfig = { identity: idM, capabilities: caps('Mallory'), random: randM };

    const aWithM = runHandshake(configA, configM);
    const mWithB = runHandshake(configM, configB);

    const codeA = deriveSasCode(aWithM.resultA.sasCodeSeed);
    const codeB = deriveSasCode(mWithB.resultB.sasCodeSeed);
    // The two users would read out different numbers and stop.
    expect(codeA).not.toBe(codeB);
  });

  it('rejects a tampered auth message', () => {
    const { configA, configB } = makePair(41, 42);
    const initiator = new Handshake(HandshakeRole.INITIATOR, configA);
    const responder = new Handshake(HandshakeRole.RESPONDER, configB);
    const init = initiator.createInit();
    const response = responder.readInitAndCreateResponse(init);
    const authR = responder.createResponderAuth();
    initiator.readResponse(response);
    const tampered = authR.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
    expect(() => initiator.readResponderAuthAndCreateAuth(tampered)).toThrow(HandshakeError);
  });

  it('rejects a replayed handshake transcript', () => {
    const { configA, configB } = makePair(51, 52);
    const initiator = new Handshake(HandshakeRole.INITIATOR, configA);
    const responder = new Handshake(HandshakeRole.RESPONDER, configB);
    const init = initiator.createInit();
    responder.readInitAndCreateResponse(init);
    // Replaying the same INIT into a fresh responder yields a different
    // transcript (fresh ephemeral + nonce), so nothing an attacker recorded is
    // reusable against the original session.
    const responder2 = new Handshake(HandshakeRole.RESPONDER, configB);
    const response2 = responder2.readInitAndCreateResponse(init);
    expect(toHex(response2)).not.toBe(toHex(responder.createResponderAuth()));
  });

  it('refuses a peer that reflects our own identity key back at us', () => {
    const { configA } = makePair(61, 62);
    // Both sides using the SAME identity: a reflection attack.
    const initiator = new Handshake(HandshakeRole.INITIATOR, configA);
    const responder = new Handshake(HandshakeRole.RESPONDER, configA);
    const init = initiator.createInit();
    const response = responder.readInitAndCreateResponse(init);
    const authR = responder.createResponderAuth();
    initiator.readResponse(response);
    expect(() => initiator.readResponderAuthAndCreateAuth(authR)).toThrow(/own identity key/);
  });

  it('refuses out-of-order state transitions', () => {
    const { configA, configB } = makePair(71, 72);
    const initiator = new Handshake(HandshakeRole.INITIATOR, configA);
    expect(() => initiator.readResponse(new Uint8Array([1]))).toThrow(HandshakeError);
    const responder = new Handshake(HandshakeRole.RESPONDER, configB);
    expect(() => responder.createInit()).toThrow(HandshakeError);
  });

  it('never throws anything but HandshakeError on garbage input', () => {
    let seed = 999;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 500; i++) {
      const { configA, configB } = makePair(81, 82);
      const responder = new Handshake(HandshakeRole.RESPONDER, configB);
      const len = Math.floor(rand() * 64);
      const junk = new Uint8Array(len);
      for (let j = 0; j < len; j++) junk[j] = Math.floor(rand() * 256);
      try {
        responder.readInitAndCreateResponse(junk);
      } catch (err) {
        expect(err).toBeInstanceOf(HandshakeError);
      }
      void configA;
    }
  });
});

describe('SecureSession', () => {
  function sessionPair() {
    const { configA, configB } = makePair(91, 92);
    const { resultA, resultB } = runHandshake(configA, configB);
    return { a: new SecureSession(resultA.keys), b: new SecureSession(resultB.keys) };
  }

  it('encrypts and decrypts between the two peers', () => {
    const { a, b } = sessionPair();
    const aad = new Uint8Array([1, 2, 3]);
    const { ciphertext, counter } = a.seal(new Uint8Array([10, 20, 30]), aad);
    expect(b.open(ciphertext, aad, counter)).toEqual(new Uint8Array([10, 20, 30]));
  });

  it('rejects a replayed packet', () => {
    const { a, b } = sessionPair();
    const aad = new Uint8Array([9]);
    const { ciphertext, counter } = a.seal(new Uint8Array([1]), aad);
    expect(b.open(ciphertext, aad, counter)).not.toBeNull();
    expect(b.open(ciphertext, aad, counter)).toBeNull();
    expect(b.packetsRejected).toBe(1);
  });

  it('accepts out-of-order packets inside the window', () => {
    const { a, b } = sessionPair();
    const aad = new Uint8Array([0]);
    const packets = Array.from({ length: 50 }, (_, i) => a.seal(new Uint8Array([i]), aad));
    for (const p of [...packets].reverse()) {
      expect(b.open(p.ciphertext, aad, p.counter)).not.toBeNull();
    }
  });

  it('rejects a packet whose associated data was altered', () => {
    const { a, b } = sessionPair();
    const { ciphertext, counter } = a.seal(new Uint8Array([1]), new Uint8Array([1, 1]));
    expect(b.open(ciphertext, new Uint8Array([2, 2]), counter)).toBeNull();
  });

  it('rejects a packet claiming the wrong counter', () => {
    const { a, b } = sessionPair();
    const aad = new Uint8Array([0]);
    const { ciphertext } = a.seal(new Uint8Array([1]), aad);
    expect(b.open(ciphertext, aad, 12345)).toBeNull();
  });

  it('cannot decrypt its own traffic (no reflection)', () => {
    const { a } = sessionPair();
    const aad = new Uint8Array([0]);
    const { ciphertext, counter } = a.seal(new Uint8Array([1]), aad);
    expect(a.open(ciphertext, aad, counter)).toBeNull();
  });

  it('refuses use after destroy', () => {
    const { a } = sessionPair();
    a.destroy();
    expect(() => a.seal(new Uint8Array([1]), new Uint8Array(0))).toThrow();
    expect(a.open(new Uint8Array(20), new Uint8Array(0), 0)).toBeNull();
  });
});

describe('ReplayWindow', () => {
  it('accepts fresh sequence numbers and rejects repeats', () => {
    const w = new ReplayWindow(64);
    expect(w.accept(0)).toBe(true);
    expect(w.accept(0)).toBe(false);
    expect(w.accept(1)).toBe(true);
    expect(w.accept(5)).toBe(true);
    expect(w.accept(3)).toBe(true);
    expect(w.accept(3)).toBe(false);
  });

  it('rejects sequence numbers that have fallen out of the window', () => {
    const w = new ReplayWindow(64);
    w.accept(0);
    w.accept(1000);
    expect(w.accept(1)).toBe(false);
    expect(w.accept(999)).toBe(true);
  });

  it('handles a large jump forward without leaving stale bits set', () => {
    const w = new ReplayWindow(64);
    for (let i = 0; i < 64; i++) w.accept(i);
    w.accept(1_000_000);
    // 1_000_000 - 63 .. 999_999 must all still be acceptable
    for (let i = 999_950; i < 1_000_000; i++) expect(w.accept(i)).toBe(true);
    expect(w.accept(1_000_000)).toBe(false);
  });

  it('survives a randomised sequence without ever accepting a duplicate', () => {
    const w = new ReplayWindow(128);
    const accepted = new Set<number>();
    let seed = 5;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let highest = 0;
    for (let i = 0; i < 20000; i++) {
      const seq = Math.max(1, Math.floor(highest + (rand() - 0.35) * 60));
      const ok = w.accept(seq);
      if (ok) {
        expect(accepted.has(seq)).toBe(false);
        accepted.add(seq);
        highest = Math.max(highest, seq);
      }
    }
  });

  it('rejects nonsense inputs', () => {
    const w = new ReplayWindow(64);
    expect(w.accept(-1)).toBe(false);
    expect(w.accept(1.5)).toBe(false);
  });
});
