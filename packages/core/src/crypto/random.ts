/**
 * Randomness source.
 *
 * The core never reaches for a global directly: an injectable `RandomSource`
 * lets tests use a seeded deterministic PRNG while production uses the
 * platform CSPRNG.
 *
 *  - Node:         globalThis.crypto.getRandomValues (WebCrypto, available since Node 19)
 *  - React Native: polyfilled by `react-native-get-random-values`, which must be
 *                  imported once at the very top of the app entrypoint.
 */
export interface RandomSource {
  randomBytes(length: number): Uint8Array;
}

class SystemRandom implements RandomSource {
  randomBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
    if (!g.crypto || typeof g.crypto.getRandomValues !== 'function') {
      throw new Error(
        'AirLink: no CSPRNG available. On React Native, import "react-native-get-random-values" ' +
          'as the first line of index.js.',
      );
    }
    // getRandomValues has a 65536-byte per-call quota.
    for (let off = 0; off < length; off += 65536) {
      g.crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, length)));
    }
    return out;
  }
}

export const systemRandom: RandomSource = new SystemRandom();

/**
 * Deterministic, seeded PRNG for tests ONLY. Uses xoshiro128** which is fast and
 * well-distributed. Never use this for real keys.
 */
export class SeededRandom implements RandomSource {
  private s: [number, number, number, number];

  constructor(seed = 1) {
    // SplitMix32 to expand the seed into the state.
    let x = seed >>> 0;
    const next = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s = [next(), next(), next(), next()];
    if (this.s.every((v) => v === 0)) this.s[0] = 1;
  }

  private nextUint32(): number {
    const [s0, s1, s2, s3] = this.s;
    const result = (Math.imul(((s1 * 5) >>> 0) << 7 | ((s1 * 5) >>> 0) >>> 25, 9) >>> 0);
    const t = (s1 << 9) >>> 0;
    let a = s2 ^ s0;
    let b = s3 ^ s1;
    this.s[1] = (s1 ^ a) >>> 0;
    this.s[0] = (s0 ^ b) >>> 0;
    this.s[2] = (a ^ t) >>> 0;
    this.s[3] = (((b << 11) | (b >>> 21)) >>> 0);
    return result;
  }

  randomBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 4) {
      const v = this.nextUint32();
      out[i] = v & 0xff;
      if (i + 1 < length) out[i + 1] = (v >>> 8) & 0xff;
      if (i + 2 < length) out[i + 2] = (v >>> 16) & 0xff;
      if (i + 3 < length) out[i + 3] = (v >>> 24) & 0xff;
    }
    return out;
  }
}
