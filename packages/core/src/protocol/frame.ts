/**
 * AirLink Protocol v1 - frame and envelope codecs.
 *
 * Layering, outermost first:
 *
 *   Transport datagram
 *     └── Frame            HANDSHAKE | SECURE | FRAGMENT | BEACON
 *           └── (SECURE)   AEAD(sessionId, counter, ciphertext+tag)
 *                 └── Envelope   channel, flags, seq, ack, type, timestamp, payload
 *                       └── Payload   CBOR map, or raw bytes for chunked media
 *
 * Every decode path here treats its input as hostile: lengths are bounded,
 * unknown values are rejected, and DecodeError is the only expected failure.
 */
import {
  AEAD_TAG_LENGTH,
  EnvelopeFlags,
  FRAGMENT_HEADER_LENGTH,
  FrameType,
  MAX_FRAGMENTS,
  MAX_FRAME_BYTES,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SECURE_HEADER_LENGTH,
  SESSION_ID_LENGTH,
  type Channel,
} from './constants.js';
import { ByteReader, ByteWriter, DecodeError } from '../util/varint.js';
import { readUint64BE, writeUint64BE } from '../util/bytes.js';

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface HandshakeFrame {
  readonly kind: typeof FrameType.HANDSHAKE;
  readonly version: number;
  readonly body: Uint8Array;
}

export interface SecureFrame {
  readonly kind: typeof FrameType.SECURE;
  readonly version: number;
  readonly sessionId: Uint8Array;
  readonly counter: number;
  readonly ciphertext: Uint8Array;
  /** The exact header bytes that were authenticated as AEAD associated data. */
  readonly aad: Uint8Array;
}

export interface FragmentFrame {
  readonly kind: typeof FrameType.FRAGMENT;
  readonly version: number;
  readonly packetId: number;
  readonly index: number;
  readonly count: number;
  readonly chunk: Uint8Array;
}

export interface BeaconFrame {
  readonly kind: typeof FrameType.BEACON;
  readonly version: number;
  readonly body: Uint8Array;
}

export type Frame = HandshakeFrame | SecureFrame | FragmentFrame | BeaconFrame;

export function encodeHandshakeFrame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + body.length);
  out[0] = PROTOCOL_VERSION;
  out[1] = FrameType.HANDSHAKE;
  out.set(body, 2);
  return out;
}

export function encodeBeaconFrame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + body.length);
  out[0] = PROTOCOL_VERSION;
  out[1] = FrameType.BEACON;
  out.set(body, 2);
  return out;
}

/**
 * Build a SECURE frame. `seal` receives the exact associated-data bytes so the
 * AEAD binds version, frame type, session id and counter.
 */
export function encodeSecureFrame(
  sessionId: Uint8Array,
  counter: number,
  plaintext: Uint8Array,
  seal: (plaintext: Uint8Array, aad: Uint8Array, counter: number) => Uint8Array,
): Uint8Array {
  if (sessionId.length !== SESSION_ID_LENGTH) throw new Error('encodeSecureFrame: bad session id length');
  const header = new Uint8Array(SECURE_HEADER_LENGTH);
  header[0] = PROTOCOL_VERSION;
  header[1] = FrameType.SECURE;
  header.set(sessionId, 2);
  writeUint64BE(new DataView(header.buffer, header.byteOffset, header.byteLength), 10, counter);

  const ciphertext = seal(plaintext, header, counter);
  const out = new Uint8Array(header.length + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, header.length);
  return out;
}

export function decodeFrame(data: Uint8Array): Frame {
  if (data.length < 2) throw new DecodeError('frame: too short');
  const version = data[0] as number;
  const type = data[1] as number;

  if (version < MIN_SUPPORTED_PROTOCOL_VERSION) {
    throw new DecodeError(`frame: protocol version ${version} is older than the minimum supported`);
  }
  // A newer peer may speak a higher version. Frames we cannot interpret are
  // rejected here; version negotiation happens during HELLO.
  if (version > PROTOCOL_VERSION) {
    throw new DecodeError(`frame: protocol version ${version} is newer than this build supports`);
  }

  switch (type) {
    case FrameType.HANDSHAKE:
      return { kind: FrameType.HANDSHAKE, version, body: data.subarray(2) };

    case FrameType.BEACON:
      return { kind: FrameType.BEACON, version, body: data.subarray(2) };

    case FrameType.SECURE: {
      if (data.length < SECURE_HEADER_LENGTH + AEAD_TAG_LENGTH) throw new DecodeError('frame: secure frame too short');
      const sessionId = data.subarray(2, 2 + SESSION_ID_LENGTH);
      const counter = readUint64BE(new DataView(data.buffer, data.byteOffset, data.byteLength), 10);
      return {
        kind: FrameType.SECURE,
        version,
        sessionId,
        counter,
        ciphertext: data.subarray(SECURE_HEADER_LENGTH),
        aad: data.subarray(0, SECURE_HEADER_LENGTH),
      };
    }

    case FrameType.FRAGMENT: {
      if (data.length < FRAGMENT_HEADER_LENGTH) throw new DecodeError('frame: fragment frame too short');
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const packetId = dv.getUint16(2, false);
      const index = dv.getUint16(4, false);
      const count = dv.getUint16(6, false);
      if (count === 0 || count > MAX_FRAGMENTS) throw new DecodeError('frame: bad fragment count');
      if (index >= count) throw new DecodeError('frame: fragment index out of range');
      return { kind: FrameType.FRAGMENT, version, packetId, index, count, chunk: data.subarray(FRAGMENT_HEADER_LENGTH) };
    }

    default:
      throw new DecodeError(`frame: unknown frame type 0x${type.toString(16)}`);
  }
}

// ---------------------------------------------------------------------------
// Fragmentation
// ---------------------------------------------------------------------------

/**
 * Split an already-encoded frame into transport-sized fragments.
 * Returns the input unchanged (as a single-element array) when it already fits.
 */
export function fragmentFrame(frame: Uint8Array, mtu: number, packetId: number): Uint8Array[] {
  if (frame.length <= mtu) return [frame];
  const payloadPerFragment = mtu - FRAGMENT_HEADER_LENGTH;
  if (payloadPerFragment <= 0) throw new Error(`fragmentFrame: MTU ${mtu} is too small for a fragment header`);
  const count = Math.ceil(frame.length / payloadPerFragment);
  if (count > MAX_FRAGMENTS) throw new Error(`fragmentFrame: frame needs ${count} fragments, limit is ${MAX_FRAGMENTS}`);

  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = frame.subarray(i * payloadPerFragment, Math.min((i + 1) * payloadPerFragment, frame.length));
    const buf = new Uint8Array(FRAGMENT_HEADER_LENGTH + chunk.length);
    buf[0] = PROTOCOL_VERSION;
    buf[1] = FrameType.FRAGMENT;
    const dv = new DataView(buf.buffer);
    dv.setUint16(2, packetId & 0xffff, false);
    dv.setUint16(4, i, false);
    dv.setUint16(6, count, false);
    buf.set(chunk, FRAGMENT_HEADER_LENGTH);
    out.push(buf);
  }
  return out;
}

interface Reassembly {
  count: number;
  received: number;
  totalBytes: number;
  parts: (Uint8Array | undefined)[];
  startedAt: number;
}

/**
 * Reassembles FRAGMENT frames back into complete frames.
 *
 * Bounded on every axis a peer controls: number of in-flight packets, fragments
 * per packet, and total buffered bytes.
 */
export class FragmentReassembler {
  private readonly inflight = new Map<number, Reassembly>();

  constructor(
    private readonly maxInflightPackets = 8,
    private readonly timeoutMs = 30_000,
  ) {}

  /** Returns the completed frame bytes, or null if more fragments are needed. */
  push(fragment: FragmentFrame, now: number): Uint8Array | null {
    this.expire(now);

    let entry = this.inflight.get(fragment.packetId);
    if (entry && entry.count !== fragment.count) {
      // Packet id reused with a different shape - start over.
      this.inflight.delete(fragment.packetId);
      entry = undefined;
    }
    if (!entry) {
      if (this.inflight.size >= this.maxInflightPackets) {
        // Evict the oldest rather than growing without bound.
        let oldestId: number | undefined;
        let oldestAt = Infinity;
        for (const [id, e] of this.inflight) {
          if (e.startedAt < oldestAt) {
            oldestAt = e.startedAt;
            oldestId = id;
          }
        }
        if (oldestId !== undefined) this.inflight.delete(oldestId);
      }
      entry = {
        count: fragment.count,
        received: 0,
        totalBytes: 0,
        parts: new Array<Uint8Array | undefined>(fragment.count),
        startedAt: now,
      };
      this.inflight.set(fragment.packetId, entry);
    }

    if (entry.parts[fragment.index] !== undefined) return null; // duplicate fragment
    entry.parts[fragment.index] = fragment.chunk;
    entry.received += 1;
    entry.totalBytes += fragment.chunk.length;

    if (entry.totalBytes > MAX_FRAME_BYTES) {
      this.inflight.delete(fragment.packetId);
      throw new DecodeError('fragment: reassembled frame exceeds size limit');
    }
    if (entry.received !== entry.count) return null;

    const out = new Uint8Array(entry.totalBytes);
    let off = 0;
    for (const part of entry.parts) {
      if (!part) throw new DecodeError('fragment: internal reassembly gap');
      out.set(part, off);
      off += part.length;
    }
    this.inflight.delete(fragment.packetId);
    return out;
  }

  private expire(now: number): void {
    for (const [id, entry] of this.inflight) {
      if (now - entry.startedAt > this.timeoutMs) this.inflight.delete(id);
    }
  }

  get pendingCount(): number {
    return this.inflight.size;
  }

  reset(): void {
    this.inflight.clear();
  }
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface Envelope {
  readonly channel: Channel;
  readonly flags: number;
  /** Per-channel sender sequence number. 0 on unsequenced channels. */
  readonly seq: number;
  /** Highest contiguous sequence number the sender has received on RELIABLE. */
  readonly ack: number;
  /** Bitfield acknowledging the 32 sequence numbers below `ack`. */
  readonly ackBits: number;
  readonly messageType: number;
  /**
   * Sender wall-clock milliseconds, truncated to a whole millisecond on the
   * wire. Advisory only - never trusted for security or ordering.
   */
  readonly timestamp: number;
  readonly payload: Uint8Array;
  /** Present only when EnvelopeFlags.HAS_SENDER is set (group relay). */
  readonly senderId?: string;
  /** Present only when EnvelopeFlags.HAS_DESTINATION is set (group relay). */
  readonly destinationId?: string;
}

export function encodeEnvelope(env: Envelope): Uint8Array {
  const w = new ByteWriter(env.payload.length + 48);
  w.u8(env.channel);
  w.u8(env.flags);
  if (env.flags & EnvelopeFlags.HAS_SENDER) {
    if (!env.senderId) throw new Error('encodeEnvelope: HAS_SENDER set without senderId');
    w.lenBytes(idToBytes(env.senderId));
  }
  if (env.flags & EnvelopeFlags.HAS_DESTINATION) {
    if (!env.destinationId) throw new Error('encodeEnvelope: HAS_DESTINATION set without destinationId');
    w.lenBytes(idToBytes(env.destinationId));
  }
  w.varint(env.seq);
  w.varint(env.ack);
  w.u32(env.ackBits >>> 0);
  w.varint(env.messageType);
  // Wall-clock milliseconds are integers on the wire. A caller handing us a
  // fractional clock reading must not be able to break framing.
  w.varint(Math.max(0, Math.floor(env.timestamp)));
  w.lenBytes(env.payload);
  return w.finish();
}

export function decodeEnvelope(data: Uint8Array): Envelope {
  const r = new ByteReader(data);
  const channel = r.u8();
  if (channel > 3) throw new DecodeError(`envelope: unknown channel ${channel}`);
  const flags = r.u8();

  let senderId: string | undefined;
  let destinationId: string | undefined;
  if (flags & EnvelopeFlags.HAS_SENDER) senderId = bytesToId(r.lenBytes());
  if (flags & EnvelopeFlags.HAS_DESTINATION) destinationId = bytesToId(r.lenBytes());

  const seq = r.varint();
  const ack = r.varint();
  const ackBits = r.u32();
  const messageType = r.varint();
  const timestamp = r.varint();
  const payload = r.lenBytes();
  r.expectEnd();

  const env: Envelope = {
    channel: channel as Channel,
    flags,
    seq,
    ack,
    ackBits,
    messageType,
    timestamp,
    payload,
    ...(senderId !== undefined ? { senderId } : {}),
    ...(destinationId !== undefined ? { destinationId } : {}),
  };
  return env;
}

const MAX_ID_BYTES = 64;

function idToBytes(id: string): Uint8Array {
  const out = new Uint8Array(id.length);
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code > 0x7f) throw new Error('peer ids must be ASCII');
    out[i] = code;
  }
  if (out.length > MAX_ID_BYTES) throw new Error('peer id too long');
  return out;
}

function bytesToId(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MAX_ID_BYTES) throw new DecodeError('envelope: bad peer id length');
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    // Restricted to the hex/base32 alphabet our ids actually use.
    const ok =
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x5f;
    if (!ok) throw new DecodeError('envelope: illegal character in peer id');
    out += String.fromCharCode(b);
  }
  return out;
}
