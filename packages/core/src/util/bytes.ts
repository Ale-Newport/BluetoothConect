/**
 * Byte manipulation primitives shared by the whole protocol stack.
 *
 * Everything here is dependency-free and works identically on Node and Hermes
 * (React Native). No `Buffer`, no `TextEncoder` outside of the guarded helpers.
 */

/** Concatenate byte arrays into a single new array. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Constant-time equality. Used for MAC/tag/fingerprint comparison. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Plain (non constant-time) equality, for non-secret data. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const HEX_CHARS = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX_CHARS[b >>> 4];
    out += HEX_CHARS[b & 0x0f];
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('fromHex: odd-length string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('fromHex: invalid hex');
    out[i] = byte;
  }
  return out;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64Encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += alphabet[(n >>> 18) & 63]! + alphabet[(n >>> 12) & 63]! + alphabet[(n >>> 6) & 63]! + alphabet[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = (bytes[i] as number) << 16;
    out += alphabet[(n >>> 18) & 63]! + alphabet[(n >>> 12) & 63]!;
    if (pad) out += '==';
  } else if (rem === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += alphabet[(n >>> 18) & 63]! + alphabet[(n >>> 12) & 63]! + alphabet[(n >>> 6) & 63]!;
    if (pad) out += '=';
  }
  return out;
}

function b64Decode(str: string, alphabet: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) lookup[alphabet.charCodeAt(i)] = i;
  const clean = str.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? (lookup[code] as number) : -1;
    if (v < 0) throw new Error('base64: invalid character');
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (value >>> bits) & 0xff;
    }
  }
  return out.subarray(0, idx);
}

export const toBase64 = (b: Uint8Array): string => b64Encode(b, B64_ALPHABET, true);
export const fromBase64 = (s: string): Uint8Array => b64Decode(s, B64_ALPHABET);
export const toBase64Url = (b: Uint8Array): string => b64Encode(b, B64URL_ALPHABET, false);
export const fromBase64Url = (s: string): Uint8Array => b64Decode(s, B64URL_ALPHABET);

/**
 * Crockford base32 - used for human-readable short IDs (no ambiguous
 * characters, case-insensitive).
 */
const B32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function toBase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] as number);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** UTF-8 encode without depending on a global TextEncoder. */
export function utf8Encode(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        continue;
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return new Uint8Array(out);
}

/** UTF-8 decode without depending on a global TextDecoder. */
export function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++] as number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 31) << 6) | ((bytes[i++] as number) & 63));
    } else if (b0 < 0xf0) {
      out += String.fromCharCode(((b0 & 15) << 12) | (((bytes[i++] as number) & 63) << 6) | ((bytes[i++] as number) & 63));
    } else {
      const cp =
        ((b0 & 7) << 18) |
        (((bytes[i++] as number) & 63) << 12) |
        (((bytes[i++] as number) & 63) << 6) |
        ((bytes[i++] as number) & 63);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 1023));
    }
  }
  return out;
}

/** Read a big-endian unsigned 64-bit integer as a JS number (throws if unsafe). */
export function readUint64BE(view: DataView, offset: number): number {
  const hi = view.getUint32(offset, false);
  const lo = view.getUint32(offset + 4, false);
  const value = hi * 0x1_0000_0000 + lo;
  if (!Number.isSafeInteger(value)) throw new Error('readUint64BE: value exceeds Number.MAX_SAFE_INTEGER');
  return value;
}

/** Write a big-endian unsigned 64-bit integer from a JS number. */
export function writeUint64BE(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('writeUint64BE: not a safe non-negative integer');
  view.setUint32(offset, Math.floor(value / 0x1_0000_0000), false);
  view.setUint32(offset + 4, value >>> 0, false);
}
