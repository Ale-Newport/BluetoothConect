import { describe, it } from 'vitest';
import { SeededRandom } from '../src/crypto/random.js';
import { agree, generateAgreementKeyPair, hash256, deriveKey } from '../src/crypto/primitives.js';
import { deriveSasCode } from '../src/crypto/sas.js';
import { utf8Encode } from '../src/util/bytes.js';

const PROLOGUE = utf8Encode('AirLink-v1-handshake');
const DERIVED_LENGTH = 32 + 4 + 32 + 4 + 8 + 32;

function transcript(v: number, eI: Uint8Array, nI: Uint8Array, eR: Uint8Array, nR: Uint8Array) {
  return hash256(PROLOGUE, Uint8Array.of(v), Uint8Array.of(0x01), eI, nI, Uint8Array.of(0x02), eR, nR);
}
function sasFor(shared: Uint8Array, th: Uint8Array) {
  const okm = deriveKey(shared, th, 'AirLink v1 traffic keys', DERIVED_LENGTH);
  return deriveSasCode(okm.slice(DERIVED_LENGTH - 32));
}

describe('probe 8.2', () => {
  it('grind n_R to hit a target SAS', () => {
    const r = new SeededRandom(7);
    const alice = generateAgreementKeyPair(r.randomBytes(32));
    const nI = r.randomBytes(16);
    const mitm = generateAgreementKeyPair(r.randomBytes(32));   // FIXED -> ECDH constant
    const shared = agree(mitm.secretKey, alice.publicKey);      // computed ONCE

    // target = the SAS the MITM already locked in on the Bob leg
    const target = sasFor(shared, transcript(1, alice.publicKey, nI, mitm.publicKey, r.randomBytes(16)));

    const nR = new Uint8Array(16);
    const dv = new DataView(nR.buffer);
    const t0 = Date.now();
    let tries = 0, found = false;
    const BUDGET_MS = 20000;
    while (Date.now() - t0 < BUDGET_MS) {
      dv.setUint32(0, tries, true);
      const s = sasFor(shared, transcript(1, alice.publicKey, nI, mitm.publicKey, nR));
      tries++;
      if (s === target) { found = true; break; }
    }
    const ms = Date.now() - t0;
    console.log('=== 8.2 SAS grinding ===');
    console.log('target SAS      :', target);
    console.log('tries           :', tries.toLocaleString());
    console.log('elapsed ms      :', ms);
    console.log('rate (tries/s)  :', Math.round(tries / (ms / 1000)).toLocaleString());
    console.log('found match     :', found);
    console.log('ECDH per try    : 0 (shared secret fixed) -> cost is 1 SHA256 + 2 HKDF');
    console.log('expected tries for 1e6 space : 1,000,000 =>  est seconds:', (1e6 / (tries / (ms/1000))).toFixed(1));
  });
});
