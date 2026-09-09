import { describe, expect, it } from 'vitest';
import { decodeCbor, encodeCbor, type CborValue } from '../src/protocol/cbor.js';
import { ByteReader, ByteWriter, DecodeError } from '../src/util/varint.js';
import { fromHex, toBase64, fromBase64, toHex, utf8Decode, utf8Encode } from '../src/util/bytes.js';

describe('varint / ByteWriter / ByteReader', () => {
  it('round-trips varints across the whole safe-integer range', () => {
    const values = [0, 1, 127, 128, 255, 256, 16383, 16384, 2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER];
    for (const v of values) {
      const bytes = new ByteWriter().varint(v).finish();
      expect(new ByteReader(bytes).varint()).toBe(v);
    }
  });

  it('uses the minimum number of bytes', () => {
    expect(new ByteWriter().varint(0).finish().length).toBe(1);
    expect(new ByteWriter().varint(127).finish().length).toBe(1);
    expect(new ByteWriter().varint(128).finish().length).toBe(2);
    expect(new ByteWriter().varint(16383).finish().length).toBe(2);
    expect(new ByteWriter().varint(16384).finish().length).toBe(3);
  });

  it('round-trips fixed-width integers', () => {
    const w = new ByteWriter().u8(200).u16(60000).u32(4_000_000_000).u64(Number.MAX_SAFE_INTEGER);
    const r = new ByteReader(w.finish());
    expect(r.u8()).toBe(200);
    expect(r.u16()).toBe(60000);
    expect(r.u32()).toBe(4_000_000_000);
    expect(r.u64()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects reads past the end of the buffer', () => {
    expect(() => new ByteReader(new Uint8Array(1)).u32()).toThrow(DecodeError);
  });

  it('rejects an over-long varint rather than looping', () => {
    const evil = new Uint8Array(12).fill(0xff);
    expect(() => new ByteReader(evil).varint()).toThrow(DecodeError);
  });

  it('expectEnd catches trailing bytes', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3]));
    r.u8();
    expect(() => r.expectEnd()).toThrow(DecodeError);
  });
});

describe('byte helpers', () => {
  it('round-trips hex and base64', () => {
    const data = new Uint8Array([0, 1, 127, 128, 255, 42, 7]);
    expect(fromHex(toHex(data))).toEqual(data);
    expect(fromBase64(toBase64(data))).toEqual(data);
  });

  it('round-trips UTF-8 including astral characters', () => {
    for (const s of ['', 'hola', 'Did you bring the headphones?', 'Yes 😭', '日本語テスト', 'é']) {
      expect(utf8Decode(utf8Encode(s))).toBe(s);
    }
  });
});

describe('CBOR', () => {
  const cases: CborValue[] = [
    0,
    1,
    -1,
    23,
    24,
    255,
    256,
    65535,
    65536,
    -1000,
    Number.MAX_SAFE_INTEGER,
    1.5,
    -0.25,
    true,
    false,
    null,
    '',
    'AirLink',
    '😭 emoji',
    new Uint8Array(0),
    new Uint8Array([1, 2, 3]),
    [],
    [1, 'two', new Uint8Array([3])],
    {},
    { a: 1, b: [true, null], c: { nested: 'yes' } },
  ];

  it('round-trips every supported value', () => {
    for (const value of cases) {
      expect(decodeCbor(encodeCbor(value))).toEqual(value);
    }
  });

  it('is deterministic regardless of key insertion order', () => {
    const a = encodeCbor({ zebra: 1, apple: 2, mango: 3 });
    const b = encodeCbor({ mango: 3, apple: 2, zebra: 1 });
    expect(toHex(a)).toBe(toHex(b));
  });

  it('rejects trailing bytes', () => {
    const bytes = new Uint8Array([...encodeCbor(1), 0x00]);
    expect(() => decodeCbor(bytes)).toThrow(DecodeError);
  });

  it('rejects indefinite-length items', () => {
    // 0x9f = indefinite-length array
    expect(() => decodeCbor(new Uint8Array([0x9f, 0x01, 0xff]))).toThrow(DecodeError);
  });

  it('rejects prototype-polluting keys', () => {
    // map(1) { "__proto__": 1 }
    const key = utf8Encode('__proto__');
    const bytes = new Uint8Array([0xa1, 0x60 | key.length, ...key, 0x01]);
    expect(() => decodeCbor(bytes)).toThrow(DecodeError);
  });

  it('rejects non-text map keys', () => {
    // map(1) { 1: 1 }
    expect(() => decodeCbor(new Uint8Array([0xa1, 0x01, 0x01]))).toThrow(DecodeError);
  });

  it('enforces the depth limit', () => {
    let value: CborValue = 0;
    for (let i = 0; i < 40; i++) value = [value];
    expect(() => encodeCbor(value)).toThrow();
  });

  it('enforces collection size limits on decode', () => {
    // array(5000) header without the elements - must fail on the limit, not OOM
    const header = new Uint8Array([0x99, 0x13, 0x88]);
    expect(() => decodeCbor(header)).toThrow(DecodeError);
  });

  it('survives arbitrary garbage without throwing anything but DecodeError', () => {
    let seed = 12345;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rand() * 32);
      const bytes = new Uint8Array(len);
      for (let j = 0; j < len; j++) bytes[j] = Math.floor(rand() * 256);
      try {
        decodeCbor(bytes);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        if (!(err instanceof DecodeError) && !(err instanceof RangeError)) {
          throw new Error(`unexpected error type ${(err as Error).name}: ${(err as Error).message}`);
        }
      }
    }
  });
});
