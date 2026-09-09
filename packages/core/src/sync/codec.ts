/**
 * Watch-together wire codec.
 *
 * Pure functions: no clock, no session, no state, so every rule below can be
 * tested against a hand-written hostile payload.
 *
 * Same asymmetry as the chat codec: encoders throw `Error` because a bad encode
 * is our bug and should be loud; decoders throw `DecodeError` because a bad
 * decode is a peer's packet and gets dropped.
 *
 * Wire keys are single characters. A BLE GATT datagram is 180 bytes and the
 * heartbeat goes out every couple of seconds for the length of a film - the
 * difference between `"hostWallClockMs"` and `"w"` is not cosmetic.
 *
 *   s sessionId   q queryId    h sampledHash  n byteLength  d durationMs
 *   t title       m mimeType   e epoch        p positionMs  w hostWallClockMs
 *   r rate        y playing    x reason       k contentConfirmed  a availability
 */
import { decodeCbor, type CborValue } from '../protocol/cbor.js';
import { DecodeError } from '../util/varint.js';
import {
  MAX_CONTENT_DURATION_MS,
  isValidPlaybackRate,
  isValidPositionMs,
  isValidWallClockMs,
  type PlaybackAnchor,
} from './anchor.js';
import {
  SYNC_LIMITS,
  isContentAvailability,
  type ContentIdentity,
  type ContentQuery,
  type ContentReply,
} from './types.js';

// ---------------------------------------------------------------------------
// Decoded shapes
// ---------------------------------------------------------------------------

export interface SyncSessionCreate {
  readonly sessionId: string;
  readonly content: ContentIdentity;
  readonly anchor: PlaybackAnchor;
}

export interface SyncJoin {
  readonly sessionId: string;
  /** False when the joiner does not hold matching content - it is watching along blind. */
  readonly contentConfirmed: boolean;
}

/**
 * One playback command.
 *
 * Two forms share this shape, and which one it is depends on who sent it:
 *
 *  - from the HOST, `anchor` is present and is authoritative;
 *  - from a GUEST, `anchor` is null and the message is a REQUEST ("please
 *    pause", "please seek to 12:04"). A guest cannot dictate an epoch or a
 *    shared instant - only the host publishes those - so the fields simply are
 *    not there, and a mixture of the two forms is rejected as malformed.
 */
export interface SyncCommand {
  readonly sessionId: string;
  readonly anchor: PlaybackAnchor | null;
  /** Requested seek target, on a guest's SYNC_SEEK request. */
  readonly positionMs?: number;
  /** Requested rate, on a guest's SYNC_RATE request. */
  readonly rate?: number;
}

export interface SyncFarewell {
  readonly sessionId: string;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Bounded field readers
//
// Modelled on protocol/capabilities.ts and messaging/codec.ts: one helper per
// shape, all of them bounded, and a DecodeError - never a TypeError - on
// anything unexpected.
// ---------------------------------------------------------------------------

function asMap(bytes: Uint8Array, what: string): Record<string, CborValue> {
  const value = decodeCbor(bytes);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new DecodeError(`sync: ${what} must be a map`);
  }
  return value as Record<string, CborValue>;
}

function reqId(value: CborValue | undefined, what: string): string {
  if (typeof value !== 'string') throw new DecodeError(`sync: ${what} must be a string`);
  if (value.length === 0 || value.length > SYNC_LIMITS.maxIdChars) {
    throw new DecodeError(`sync: ${what} must be 1..${SYNC_LIMITS.maxIdChars} characters`);
  }
  return value;
}

function optText(value: CborValue | undefined, what: string, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new DecodeError(`sync: ${what} must be a string`);
  if (value.length > maxChars) throw new DecodeError(`sync: ${what} exceeds ${maxChars} characters`);
  return value;
}

function reqInt(value: CborValue | undefined, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new DecodeError(`sync: ${what} must be an integer`);
  if (value < min || value > max) throw new DecodeError(`sync: ${what} is out of range`);
  return value;
}

function reqBool(value: CborValue | undefined, what: string): boolean {
  if (typeof value !== 'boolean') throw new DecodeError(`sync: ${what} must be a boolean`);
  return value;
}

function reqHash(value: CborValue | undefined): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new DecodeError('sync: content hash must be a byte string');
  if (value.length !== SYNC_LIMITS.contentHashBytes) {
    throw new DecodeError(`sync: content hash must be exactly ${SYNC_LIMITS.contentHashBytes} bytes`);
  }
  return value;
}

/** Positions and rates are genuinely fractional, so integer-ness is not required. */
function reqPosition(value: CborValue | undefined): number {
  if (!isValidPositionMs(value)) {
    throw new DecodeError(`sync: position must be a finite number in [0, ${MAX_CONTENT_DURATION_MS}]`);
  }
  return value as number;
}

function reqRate(value: CborValue | undefined): number {
  // Catches the two attacks worth naming: a negative rate (playback running
  // backwards, which no platform supports and which inverts every drift
  // calculation) and a huge one (the follower races to the end of the file).
  if (!isValidPlaybackRate(value)) throw new DecodeError('sync: playback rate is out of range');
  return value as number;
}

function reqWallClock(value: CborValue | undefined): number {
  if (!isValidWallClockMs(value)) throw new DecodeError('sync: wall clock is out of range');
  return value as number;
}

// ---------------------------------------------------------------------------
// Content identity
// ---------------------------------------------------------------------------

function encodeContentIdentity(content: ContentIdentity): Record<string, CborValue> {
  if (!Number.isSafeInteger(content.byteLength) || content.byteLength < 0) {
    throw new Error('sync: byteLength must be a non-negative safe integer');
  }
  if (content.byteLength > SYNC_LIMITS.maxContentBytes) throw new Error('sync: byteLength exceeds the limit');
  if (!Number.isInteger(content.durationMs) || content.durationMs < 0 || content.durationMs > MAX_CONTENT_DURATION_MS) {
    throw new Error('sync: durationMs must be an integer in range');
  }
  if (content.sampledHash.length !== SYNC_LIMITS.contentHashBytes) {
    throw new Error('sync: sampledHash must be a 32-byte digest');
  }
  return {
    n: content.byteLength,
    d: content.durationMs,
    h: content.sampledHash,
    ...(content.title !== undefined ? { t: content.title.slice(0, SYNC_LIMITS.maxTitleChars) } : {}),
    ...(content.mimeType !== undefined ? { m: content.mimeType.slice(0, SYNC_LIMITS.maxMimeTypeChars) } : {}),
  };
}

function decodeContentIdentity(m: Record<string, CborValue>): ContentIdentity {
  const title = optText(m.t, 'title', SYNC_LIMITS.maxTitleChars);
  const mimeType = optText(m.m, 'mimeType', SYNC_LIMITS.maxMimeTypeChars);
  return {
    byteLength: reqInt(m.n, 'byteLength', 0, SYNC_LIMITS.maxContentBytes),
    durationMs: reqInt(m.d, 'durationMs', 0, MAX_CONTENT_DURATION_MS),
    sampledHash: reqHash(m.h),
    ...(title !== undefined ? { title } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
  };
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

function encodeAnchor(anchor: PlaybackAnchor): Record<string, CborValue> {
  if (!Number.isInteger(anchor.epoch) || anchor.epoch < 0 || anchor.epoch > SYNC_LIMITS.maxEpoch) {
    throw new Error('sync: epoch must be an integer in range');
  }
  if (!isValidPositionMs(anchor.positionMs)) throw new Error('sync: anchor position is out of range');
  if (!isValidWallClockMs(anchor.hostWallClockMs)) throw new Error('sync: anchor wall clock is out of range');
  if (!isValidPlaybackRate(anchor.rate)) throw new Error('sync: anchor rate is out of range');
  return {
    e: anchor.epoch,
    p: anchor.positionMs,
    w: anchor.hostWallClockMs,
    r: anchor.rate,
    y: anchor.playing,
  };
}

function decodeAnchor(m: Record<string, CborValue>): PlaybackAnchor {
  return {
    epoch: reqInt(m.e, 'epoch', 0, SYNC_LIMITS.maxEpoch),
    positionMs: reqPosition(m.p),
    hostWallClockMs: reqWallClock(m.w),
    rate: reqRate(m.r),
    playing: reqBool(m.y, 'playing'),
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function encodeContentQuery(query: ContentQuery): CborValue {
  return { q: query.queryId, ...encodeContentIdentity(query.content) };
}

export function decodeContentQuery(bytes: Uint8Array): ContentQuery {
  const m = asMap(bytes, 'content query');
  return { queryId: reqId(m.q, 'queryId'), content: decodeContentIdentity(m) };
}

export function encodeContentReply(reply: ContentReply): CborValue {
  if (!isContentAvailability(reply.availability)) throw new Error('sync: unknown availability');
  return {
    q: reply.queryId,
    a: reply.availability,
    ...(reply.content !== undefined ? encodeContentIdentity(reply.content) : {}),
  };
}

export function decodeContentReply(bytes: Uint8Array): ContentReply {
  const m = asMap(bytes, 'content reply');
  const availability = reqInt(m.a, 'availability', 0, 2);
  if (!isContentAvailability(availability)) throw new DecodeError('sync: unknown availability');
  // The descriptor is optional, and all three of its required fields must be
  // present together or absent together - a half-populated one is malformed.
  const hasContent = m.n !== undefined || m.d !== undefined || m.h !== undefined;
  return {
    queryId: reqId(m.q, 'queryId'),
    availability,
    ...(hasContent ? { content: decodeContentIdentity(m) } : {}),
  };
}

export function encodeSessionCreate(create: SyncSessionCreate): CborValue {
  return {
    s: create.sessionId,
    ...encodeContentIdentity(create.content),
    ...encodeAnchor(create.anchor),
  };
}

export function decodeSessionCreate(bytes: Uint8Array): SyncSessionCreate {
  const m = asMap(bytes, 'session create');
  return {
    sessionId: reqId(m.s, 'sessionId'),
    content: decodeContentIdentity(m),
    anchor: decodeAnchor(m),
  };
}

export function encodeJoin(join: SyncJoin): CborValue {
  return { s: join.sessionId, k: join.contentConfirmed };
}

export function decodeJoin(bytes: Uint8Array): SyncJoin {
  const m = asMap(bytes, 'join');
  return { sessionId: reqId(m.s, 'sessionId'), contentConfirmed: reqBool(m.k, 'contentConfirmed') };
}

/** Host form: the full anchor. */
export function encodeAnchoredCommand(sessionId: string, anchor: PlaybackAnchor): CborValue {
  return { s: sessionId, ...encodeAnchor(anchor) };
}

/** Guest form: a request, carrying only the value the guest is asking for. */
export function encodeCommandRequest(
  sessionId: string,
  request: { positionMs?: number; rate?: number } = {},
): CborValue {
  const out: Record<string, CborValue> = { s: sessionId };
  if (request.positionMs !== undefined) {
    if (!isValidPositionMs(request.positionMs)) throw new Error('sync: requested position is out of range');
    out.p = request.positionMs;
  }
  if (request.rate !== undefined) {
    if (!isValidPlaybackRate(request.rate)) throw new Error('sync: requested rate is out of range');
    out.r = request.rate;
  }
  return out;
}

export function decodeCommand(bytes: Uint8Array): SyncCommand {
  const m = asMap(bytes, 'command');
  const sessionId = reqId(m.s, 'sessionId');

  // e/w/y are the fields only a host may set. Present means "anchor"; absent
  // means "request"; a mixture is a peer trying to have it both ways.
  const anchorKeys = [m.e, m.w, m.y];
  const present = anchorKeys.filter((v) => v !== undefined && v !== null).length;
  if (present === anchorKeys.length) {
    return { sessionId, anchor: decodeAnchor(m) };
  }
  if (present !== 0) throw new DecodeError('sync: command carries a partial anchor');

  const positionMs = m.p === undefined || m.p === null ? undefined : reqPosition(m.p);
  const rate = m.r === undefined || m.r === null ? undefined : reqRate(m.r);
  return {
    sessionId,
    anchor: null,
    ...(positionMs !== undefined ? { positionMs } : {}),
    ...(rate !== undefined ? { rate } : {}),
  };
}

export function encodeFarewell(farewell: SyncFarewell): CborValue {
  return {
    s: farewell.sessionId,
    ...(farewell.reason !== undefined ? { x: farewell.reason.slice(0, SYNC_LIMITS.maxReasonChars) } : {}),
  };
}

export function decodeFarewell(bytes: Uint8Array): SyncFarewell {
  const m = asMap(bytes, 'farewell');
  const reason = optText(m.x, 'reason', SYNC_LIMITS.maxReasonChars);
  return { sessionId: reqId(m.s, 'sessionId'), ...(reason !== undefined ? { reason } : {}) };
}
