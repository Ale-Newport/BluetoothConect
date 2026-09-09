import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../../../Projects/Bluetooth/packages/core/src/crypto/random.js';
import { createIdentity } from '../../../../Projects/Bluetooth/packages/core/src/crypto/identity.js';

describe('who is who', () => {
  it('prints peer ids', () => {
    const a = createIdentity(new SeededRandom(101), 1000);
    const b = createIdentity(new SeededRandom(202), 1000);
    console.log('alejandro(a)', a.peerId);
    console.log('maria(b)', b.peerId);
    console.log('a initiates?', a.peerId < b.peerId);
    expect(true).toBe(true);
  });
});
