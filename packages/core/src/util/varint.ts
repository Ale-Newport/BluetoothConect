/**
 * LEB128 unsigned varint encoding - the compact integer format used across the
 * AirLink wire protocol. Values are limited to Number.MAX_SAFE_INTEGER.
 */

export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  get length(): number {
    return this.len;
  }

  u8(value: number): this {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
    return this;
  }

  u16(value: number): this {
    this.ensure(2);
    this.buf[this.len++] = (value >>> 8) & 0xff;
    this.buf[this.len++] = value & 0xff;
    return this;
  }

  u32(value: number): this {
    this.ensure(4);
    this.buf[this.len++] = (value >>> 24) & 0xff;
    this.buf[this.len++] = (value >>> 16) & 0xff;
    this.buf[this.len++] = (value >>> 8) & 0xff;
    this.buf[this.len++] = value & 0xff;
    return this;
  }

  u64(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('u64: not a safe non-negative integer');
    this.u32(Math.floor(value / 0x1_0000_0000));
    this.u32(value >>> 0);
    return this;
  }

  varint(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('varint: not a safe non-negative integer');
    let v = value;
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.u8(v);
    return this;
  }

  bytes(value: Uint8Array): this {
    this.ensure(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
    return this;
  }

  /** Length-prefixed byte string. */
  lenBytes(value: Uint8Array): this {
    this.varint(value.length);
    return this.bytes(value);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  private off = 0;

  constructor(private readonly buf: Uint8Array) {}

  get offset(): number {
    return this.off;
  }

  get remaining(): number {
    return this.buf.length - this.off;
  }

  private need(n: number): void {
    if (this.off + n > this.buf.length) {
      throw new DecodeError(`unexpected end of buffer: need ${n}, have ${this.remaining}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.off++] as number;
  }

  u16(): number {
    this.need(2);
    const v = ((this.buf[this.off] as number) << 8) | (this.buf[this.off + 1] as number);
    this.off += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v =
      ((this.buf[this.off] as number) * 0x100_0000 +
        ((this.buf[this.off + 1] as number) << 16) +
        ((this.buf[this.off + 2] as number) << 8) +
        (this.buf[this.off + 3] as number));
    this.off += 4;
    return v >>> 0;
  }

  u64(): number {
    const hi = this.u32();
    const lo = this.u32();
    const v = hi * 0x1_0000_0000 + lo;
    if (!Number.isSafeInteger(v)) throw new DecodeError('u64: value exceeds safe integer range');
    return v;
  }

  varint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) throw new DecodeError('varint: value exceeds safe integer range');
        return result;
      }
      shift *= 128;
    }
    throw new DecodeError('varint: too long');
  }

  bytes(n: number): Uint8Array {
    if (n < 0) throw new DecodeError('bytes: negative length');
    this.need(n);
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  lenBytes(): Uint8Array {
    return this.bytes(this.varint());
  }

  rest(): Uint8Array {
    const out = this.buf.subarray(this.off);
    this.off = this.buf.length;
    return out;
  }

  /** Throws unless the buffer has been fully consumed. Guards against trailing garbage. */
  expectEnd(): void {
    if (this.remaining !== 0) throw new DecodeError(`trailing bytes: ${this.remaining}`);
  }
}

/**
 * Thrown for any malformed input received from a peer. Callers MUST catch this
 * and drop the offending packet rather than letting it escape - a peer is never
 * trusted.
 */
export class DecodeError extends Error {
  override readonly name = 'DecodeError';
}
