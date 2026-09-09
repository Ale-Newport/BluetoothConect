/**
 * Minimal deterministic CBOR (RFC 8949) codec.
 *
 * Why hand-rolled instead of a dependency:
 *  - runs unchanged on Hermes with zero native modules
 *  - deterministic/canonical encoding, so two peers hash payloads identically
 *  - a strictly bounded decoder: depth, element count and byte-string length are
 *    all capped, because every byte fed to it came from an untrusted peer
 *
 * Supported major types: 0 (uint), 1 (negint), 2 (bytes), 3 (text), 4 (array),
 * 5 (map), 7 (false/true/null/undefined/float64). Indefinite-length items are
 * rejected outright - canonical encoders never emit them, and accepting them
 * only widens the attack surface.
 */
import { DecodeError } from '../util/varint.js';
import { utf8Decode, utf8Encode } from '../util/bytes.js';

export type CborValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue };

export interface CborLimits {
  /** Maximum nesting depth. */
  maxDepth: number;
  /** Maximum number of elements in any single array or map. */
  maxCollectionSize: number;
  /** Maximum length of any single byte or text string. */
  maxStringLength: number;
}

export const DEFAULT_CBOR_LIMITS: CborLimits = {
  maxDepth: 24,
  maxCollectionSize: 4096,
  maxStringLength: 1 << 22, // 4 MiB
};

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

class CborWriter {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  raw(v: Uint8Array): void {
    this.ensure(v.length);
    this.buf.set(v, this.len);
    this.len += v.length;
  }

  /** Write a major-type header with the shortest possible argument encoding. */
  head(major: number, argument: number): void {
    const mt = major << 5;
    if (argument < 24) {
      this.byte(mt | argument);
    } else if (argument < 0x100) {
      this.byte(mt | 24);
      this.byte(argument);
    } else if (argument < 0x10000) {
      this.byte(mt | 25);
      this.byte(argument >>> 8);
      this.byte(argument);
    } else if (argument < 0x1_0000_0000) {
      this.byte(mt | 26);
      this.byte(argument >>> 24);
      this.byte(argument >>> 16);
      this.byte(argument >>> 8);
      this.byte(argument);
    } else {
      if (!Number.isSafeInteger(argument)) throw new Error('cbor: integer exceeds safe range');
      const hi = Math.floor(argument / 0x1_0000_0000);
      const lo = argument >>> 0;
      this.byte(mt | 27);
      this.byte(hi >>> 24);
      this.byte(hi >>> 16);
      this.byte(hi >>> 8);
      this.byte(hi);
      this.byte(lo >>> 24);
      this.byte(lo >>> 16);
      this.byte(lo >>> 8);
      this.byte(lo);
    }
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function encodeValue(w: CborWriter, value: CborValue, depth: number): void {
  if (depth > DEFAULT_CBOR_LIMITS.maxDepth) throw new Error('cbor: max encode depth exceeded');

  if (value === null) return w.byte(0xf6);
  if (value === undefined) return w.byte(0xf7);
  if (value === true) return w.byte(0xf5);
  if (value === false) return w.byte(0xf4);

  if (typeof value === 'number') {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      if (value >= 0) w.head(0, value);
      else w.head(1, -value - 1);
    } else {
      // IEEE-754 double. Canonical CBOR would shrink to float16/32 when exact;
      // we always emit float64 so encoding stays trivially reversible.
      w.byte(0xfb);
      const tmp = new Uint8Array(8);
      new DataView(tmp.buffer).setFloat64(0, value, false);
      w.raw(tmp);
    }
    return;
  }

  if (typeof value === 'string') {
    const bytes = utf8Encode(value);
    w.head(3, bytes.length);
    w.raw(bytes);
    return;
  }

  if (value instanceof Uint8Array) {
    w.head(2, value.length);
    w.raw(value);
    return;
  }

  if (Array.isArray(value)) {
    w.head(4, value.length);
    for (const item of value) encodeValue(w, item, depth + 1);
    return;
  }

  if (typeof value === 'object') {
    // Deterministic map ordering: RFC 8949 section 4.2.1 - sort by encoded key,
    // length-first then bytewise. All our keys are short text strings.
    const keys = Object.keys(value).filter((k) => (value as Record<string, CborValue>)[k] !== undefined);
    keys.sort((a, b) => {
      const ea = utf8Encode(a);
      const eb = utf8Encode(b);
      if (ea.length !== eb.length) return ea.length - eb.length;
      for (let i = 0; i < ea.length; i++) {
        if (ea[i] !== eb[i]) return (ea[i] as number) - (eb[i] as number);
      }
      return 0;
    });
    w.head(5, keys.length);
    for (const key of keys) {
      const bytes = utf8Encode(key);
      w.head(3, bytes.length);
      w.raw(bytes);
      encodeValue(w, (value as Record<string, CborValue>)[key] as CborValue, depth + 1);
    }
    return;
  }

  throw new Error(`cbor: unsupported value of type ${typeof value}`);
}

export function encodeCbor(value: CborValue): Uint8Array {
  const w = new CborWriter();
  encodeValue(w, value, 0);
  return w.finish();
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

class CborReader {
  off = 0;

  constructor(
    readonly buf: Uint8Array,
    readonly limits: CborLimits,
  ) {}

  private need(n: number): void {
    if (this.off + n > this.buf.length) throw new DecodeError('cbor: unexpected end of input');
  }

  byte(): number {
    this.need(1);
    return this.buf[this.off++] as number;
  }

  argument(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 24) return this.byte();
    if (additional === 25) {
      this.need(2);
      const v = ((this.buf[this.off] as number) << 8) | (this.buf[this.off + 1] as number);
      this.off += 2;
      return v;
    }
    if (additional === 26) {
      this.need(4);
      const v =
        (this.buf[this.off] as number) * 0x100_0000 +
        ((this.buf[this.off + 1] as number) << 16) +
        ((this.buf[this.off + 2] as number) << 8) +
        (this.buf[this.off + 3] as number);
      this.off += 4;
      return v;
    }
    if (additional === 27) {
      this.need(8);
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 8);
      const hi = dv.getUint32(0, false);
      const lo = dv.getUint32(4, false);
      this.off += 8;
      const v = hi * 0x1_0000_0000 + lo;
      if (!Number.isSafeInteger(v)) throw new DecodeError('cbor: integer exceeds safe range');
      return v;
    }
    if (additional === 31) throw new DecodeError('cbor: indefinite-length items are rejected');
    throw new DecodeError(`cbor: reserved additional information ${additional}`);
  }

  bytes(n: number): Uint8Array {
    if (n > this.limits.maxStringLength) throw new DecodeError('cbor: string exceeds length limit');
    this.need(n);
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }
}

function decodeValue(r: CborReader, depth: number): CborValue {
  if (depth > r.limits.maxDepth) throw new DecodeError('cbor: max decode depth exceeded');
  const initial = r.byte();
  const major = initial >> 5;
  const additional = initial & 0x1f;

  switch (major) {
    case 0:
      return r.argument(additional);
    case 1:
      return -r.argument(additional) - 1;
    case 2:
      return r.bytes(r.argument(additional));
    case 3:
      return utf8Decode(r.bytes(r.argument(additional)));
    case 4: {
      const n = r.argument(additional);
      if (n > r.limits.maxCollectionSize) throw new DecodeError('cbor: array exceeds size limit');
      const out: CborValue[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = decodeValue(r, depth + 1);
      return out;
    }
    case 5: {
      const n = r.argument(additional);
      if (n > r.limits.maxCollectionSize) throw new DecodeError('cbor: map exceeds size limit');
      const out: Record<string, CborValue> = Object.create(null) as Record<string, CborValue>;
      let prevKey: string | null = null;
      for (let i = 0; i < n; i++) {
        const keyInitial = r.byte();
        if (keyInitial >> 5 !== 3) throw new DecodeError('cbor: only text-string map keys are supported');
        const key = utf8Decode(r.bytes(r.argument(keyInitial & 0x1f)));
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new DecodeError('cbor: forbidden map key');
        }
        if (prevKey !== null && key === prevKey) throw new DecodeError('cbor: duplicate map key');
        prevKey = key;
        out[key] = decodeValue(r, depth + 1);
      }
      return out;
    }
    case 7:
      switch (additional) {
        case 20:
          return false;
        case 21:
          return true;
        case 22:
          return null;
        case 23:
          return undefined;
        case 25: {
          // float16
          const b0 = r.byte();
          const b1 = r.byte();
          const half = (b0 << 8) | b1;
          const exp = (half >> 10) & 0x1f;
          const mant = half & 0x3ff;
          const sign = half & 0x8000 ? -1 : 1;
          if (exp === 0) return sign * mant * 2 ** -24;
          if (exp === 31) return mant ? NaN : sign * Infinity;
          return sign * (mant + 1024) * 2 ** (exp - 25);
        }
        case 26: {
          const b = r.bytes(4);
          return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, false);
        }
        case 27: {
          const b = r.bytes(8);
          return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, false);
        }
        default:
          throw new DecodeError(`cbor: unsupported simple value ${additional}`);
      }
    default:
      throw new DecodeError(`cbor: unsupported major type ${major}`);
  }
}

export function decodeCbor(bytes: Uint8Array, limits: CborLimits = DEFAULT_CBOR_LIMITS): CborValue {
  const r = new CborReader(bytes, limits);
  const value = decodeValue(r, 0);
  if (r.off !== bytes.length) throw new DecodeError('cbor: trailing bytes after top-level item');
  return value;
}

/** Decode and require the result to be a plain object. */
export function decodeCborMap(bytes: Uint8Array, limits?: CborLimits): Record<string, CborValue> {
  const v = decodeCbor(bytes, limits);
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v instanceof Uint8Array) {
    throw new DecodeError('cbor: expected a map at the top level');
  }
  return v as Record<string, CborValue>;
}
