/**
 * Chat wire codec.
 *
 * Pure functions, no clock, no session, no state - so every rule below can be
 * tested on its own with a hand-written hostile payload.
 *
 * Two asymmetries are deliberate:
 *
 *  - Encoders throw `Error`, decoders throw `DecodeError`. A bad encode is our
 *    bug and should be loud; a bad decode is a peer's packet and is dropped.
 *  - Text is SANITISED on both sides, but length is REJECTED on both sides.
 *    Dropping a whole message because it contained a stray control character
 *    would let one peer's bug silence a conversation; stripping the character
 *    keeps the words and removes the forgery vector. Length is different: an
 *    oversized body is an attack on memory and on a 40 KB/s radio, and the only
 *    safe answer is no.
 *
 * Wire keys are one or two characters throughout. A BLE GATT datagram is 180
 * bytes; spending 12 of them on the word "attachments" costs real seconds.
 */
import { encodeCbor, type CborValue } from '../protocol/cbor.js';
import { DecodeError } from '../util/varint.js';
import {
  CHAT_LIMITS,
  type ChatAttachment,
  type ChatMessage,
  type DeleteRequestSignal,
  type HistoryRequestSignal,
  type HistoryResponseSignal,
  type ReactionSignal,
  type ReceiptSignal,
  type TypingSignal,
} from './types.js';

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

/** Number of Unicode code points, not UTF-16 code units. */
export function codePointLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/**
 * UTF-8 byte length without allocating the encoded copy. Matches what
 * `utf8Encode` will actually produce, including the 3-byte replacement an
 * unpaired surrogate turns into.
 */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      n += 1;
    } else if (code < 0x800) {
      n += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    } else {
      n += 3;
    }
  }
  return n;
}

/**
 * Remove characters that cannot survive the round trip or that could forge the
 * look of a chat bubble:
 *
 *  - unpaired surrogates, which UTF-8 encoding turns into U+FFFD, so a message
 *    would come back a different length than it went out;
 *  - C0 controls and DEL, which can rewrite a terminal or a log line;
 *  - U+202D/U+202E, the bidi *overrides*, which let text render in an order
 *    other than the one it is stored in (the Trojan Source trick). The bidi
 *    marks and isolates that real right-to-left text needs are left alone.
 */
export function sanitizeChatText(text: string, allowNewlines = true): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        out += String.fromCharCode(code, low);
        i++;
      }
      continue; // unpaired high surrogate: dropped
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // unpaired low surrogate
    if (code === 0x0a || code === 0x09) {
      if (allowNewlines) out += String.fromCharCode(code);
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    if (code === 0x202d || code === 0x202e) continue;
    out += String.fromCharCode(code);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounded field readers
//
// Modelled on protocol/capabilities.ts: one helper per shape, every one of them
// bounded, and a DecodeError - never a TypeError - on anything unexpected.
// ---------------------------------------------------------------------------

function asMap(value: CborValue | undefined, what: string): Record<string, CborValue> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new DecodeError(`chat: ${what} must be a map`);
  }
  return value as Record<string, CborValue>;
}

function reqString(value: CborValue | undefined, what: string, maxChars: number): string {
  if (typeof value !== 'string') throw new DecodeError(`chat: ${what} must be a string`);
  // Length is checked in code points, because that is the unit the limit is
  // stated in and the unit a user counts in.
  if (codePointLength(value) > maxChars) throw new DecodeError(`chat: ${what} exceeds ${maxChars} characters`);
  return value;
}

function reqInt(value: CborValue | undefined, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new DecodeError(`chat: ${what} must be an integer`);
  if (value < min || value > max) throw new DecodeError(`chat: ${what} out of range`);
  return value;
}

function optInt(value: CborValue | undefined, what: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  return reqInt(value, what, min, max);
}

function reqBool(value: CborValue | undefined, what: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new DecodeError(`chat: ${what} must be a boolean`);
  return value;
}

function reqList(value: CborValue | undefined, what: string, maxLength: number): CborValue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DecodeError(`chat: ${what} must be an array`);
  if (value.length > maxLength) throw new DecodeError(`chat: ${what} has more than ${maxLength} entries`);
  return value;
}

/**
 * Identifiers are generated by us (`newSortableId`) or by a peer running the
 * same code, so the alphabet is known and narrow. Restricting it means an id
 * can be pasted into a log, a URL or a SQL parameter without escaping surprises.
 */
const ID_PATTERN = /^[A-Za-z0-9_.~-]{1,64}$/;

function messageId(value: CborValue | undefined, what: string): string {
  if (typeof value !== 'string') throw new DecodeError(`chat: ${what} must be a string`);
  if (!ID_PATTERN.test(value)) throw new DecodeError(`chat: ${what} is not a valid identifier`);
  return value;
}

/** Throwing variant for our own outbound values. */
export function assertValidId(id: string, what = 'message id'): string {
  if (!ID_PATTERN.test(id)) throw new Error(`chat: ${what} must be 1-${CHAT_LIMITS.maxIdChars} of [A-Za-z0-9_.~-]`);
  return id;
}

const MIME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export function encodeAttachment(attachment: ChatAttachment): CborValue {
  assertValidId(attachment.fileId, 'attachment file id');
  const name = sanitizeChatText(attachment.name, false);
  if (name.length === 0) throw new Error('chat: attachment name must not be empty');
  if (codePointLength(name) > CHAT_LIMITS.maxAttachmentNameChars) {
    throw new Error(`chat: attachment name exceeds ${CHAT_LIMITS.maxAttachmentNameChars} characters`);
  }
  if (!MIME_PATTERN.test(attachment.mimeType) || attachment.mimeType.length > CHAT_LIMITS.maxMimeTypeChars) {
    throw new Error(`chat: attachment mime type "${attachment.mimeType}" is not a valid media type`);
  }
  if (
    !Number.isInteger(attachment.byteLength) ||
    attachment.byteLength < 0 ||
    attachment.byteLength > CHAT_LIMITS.maxAttachmentBytes
  ) {
    throw new Error('chat: attachment byteLength out of range');
  }
  /*
   * The optional numbers are checked on the way OUT, against exactly the limits
   * the decoder enforces on the way in. This file's own rule, stated at the
   * top, is that limits are duplicated on both sides - our bugs caught here,
   * their bytes caught there - and these three were the exception.
   *
   * It cost a shipped feature. A voice note's duration arrived from the
   * recorder as 3472.5623582766438, CBOR wrote it as a float64 because that is
   * a legal number, and the peer's decoder refused it and dropped the entire
   * message. Silent on this side, invisible on that side. An encoder must
   * never be able to emit something its own decoder would reject: throwing
   * here puts the failure in the sender's stack, where it can be seen.
   */
  const optionalInts: readonly [string, number | undefined, number][] = [
    ['width', attachment.width, 65_535],
    ['height', attachment.height, 65_535],
    ['durationMs', attachment.durationMs, 24 * 60 * 60 * 1000],
  ];
  for (const [field, value, max] of optionalInts) {
    // `null` is skipped as well as `undefined`: the decoder's `optInt` treats
    // both as "not present", so an absent value must not become an error here.
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new Error(`chat: attachment ${field} must be a whole number between 0 and ${max}`);
    }
  }
  return {
    f: attachment.fileId,
    n: name,
    m: attachment.mimeType,
    b: attachment.byteLength,
    w: attachment.width,
    h: attachment.height,
    d: attachment.durationMs,
  };
}

export function decodeAttachment(value: CborValue): ChatAttachment {
  const m = asMap(value, 'attachment');
  const mime = reqString(m.m, 'attachment mime type', CHAT_LIMITS.maxMimeTypeChars);
  if (!MIME_PATTERN.test(mime)) throw new DecodeError('chat: attachment mime type is not a valid media type');

  // The name reaches a filesystem in the app layer. Path separators are removed
  // here so a peer cannot propose "../../../etc/passwd" as a display name and
  // have a careless caller use it verbatim.
  const rawName = reqString(m.n, 'attachment name', CHAT_LIMITS.maxAttachmentNameChars);
  const name = sanitizeChatText(rawName, false).replace(/[/\\]/g, '_');
  if (name.length === 0) throw new DecodeError('chat: attachment name is empty');

  const width = optInt(m.w, 'attachment width', 0, 65_535);
  const height = optInt(m.h, 'attachment height', 0, 65_535);
  const durationMs = optInt(m.d, 'attachment duration', 0, 24 * 60 * 60 * 1000);

  return {
    fileId: messageId(m.f, 'attachment file id'),
    name,
    mimeType: mime,
    byteLength: reqInt(m.b, 'attachment byteLength', 0, CHAT_LIMITS.maxAttachmentBytes),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// MESSAGE
// ---------------------------------------------------------------------------

/**
 * Normalise and bound a body the app supplied. Returns the text that will
 * actually be sent, which may differ from the input if it contained characters
 * `sanitizeChatText` removes.
 */
export function normalizeBody(text: string): string {
  const clean = sanitizeChatText(text);
  if (codePointLength(clean) > CHAT_LIMITS.maxBodyCodePoints) {
    throw new Error(`chat: message body exceeds ${CHAT_LIMITS.maxBodyCodePoints} characters`);
  }
  if (utf8Length(clean) > CHAT_LIMITS.maxBodyBytes) {
    throw new Error(`chat: message body exceeds ${CHAT_LIMITS.maxBodyBytes} bytes when encoded`);
  }
  return clean;
}

export function encodeChatMessage(message: ChatMessage): CborValue {
  assertValidId(message.id);
  if (!Number.isInteger(message.timestamp) || message.timestamp < 0 || message.timestamp > CHAT_LIMITS.maxTimestampMs) {
    throw new Error('chat: message timestamp out of range');
  }
  if (message.attachments.length > CHAT_LIMITS.maxAttachmentsPerMessage) {
    throw new Error(`chat: more than ${CHAT_LIMITS.maxAttachmentsPerMessage} attachments`);
  }
  const text = normalizeBody(message.text);
  if (text.length === 0 && message.attachments.length === 0) {
    throw new Error('chat: a message must carry text or at least one attachment');
  }
  if (message.replyToId !== null) assertValidId(message.replyToId, 'replyTo id');

  return {
    i: message.id,
    s: message.timestamp,
    t: text.length > 0 ? text : undefined,
    r: message.replyToId ?? undefined,
    a: message.attachments.length > 0 ? message.attachments.map((a) => encodeAttachment(a)) : undefined,
  };
}

export function decodeChatMessage(value: CborValue): ChatMessage {
  const m = asMap(value, 'message');

  // Timestamps are the classic hostile field: a negative value would sort a
  // message before every real one, and a value far in the future would pin it
  // to the top of the conversation forever.
  const timestamp = reqInt(m.s, 'message timestamp', 0, CHAT_LIMITS.maxTimestampMs);

  const rawText = m.t === undefined || m.t === null ? '' : reqString(m.t, 'message body', CHAT_LIMITS.maxBodyCodePoints);
  if (utf8Length(rawText) > CHAT_LIMITS.maxBodyBytes) {
    throw new DecodeError(`chat: message body exceeds ${CHAT_LIMITS.maxBodyBytes} bytes`);
  }
  const text = sanitizeChatText(rawText);

  const attachments = reqList(m.a, 'attachments', CHAT_LIMITS.maxAttachmentsPerMessage).map((a) => decodeAttachment(a));
  if (text.length === 0 && attachments.length === 0) {
    throw new DecodeError('chat: a message must carry text or at least one attachment');
  }

  const replyToId = m.r === undefined || m.r === null ? null : messageId(m.r, 'replyTo id');

  return {
    id: messageId(m.i, 'message id'),
    timestamp,
    text,
    replyToId,
    attachments,
  };
}

/** Encoded size of one message, for the history-response byte budget. */
export function encodedMessageSize(message: ChatMessage): number {
  return encodeCbor(encodeChatMessage(message)).length;
}

// ---------------------------------------------------------------------------
// TYPING
// ---------------------------------------------------------------------------

/** Bounds on a peer-supplied indicator lifetime. */
export const TYPING_TTL_BOUNDS = { minMs: 500, maxMs: 15_000 } as const;

export function encodeTyping(signal: TypingSignal): CborValue {
  const ttl = Math.max(TYPING_TTL_BOUNDS.minMs, Math.min(TYPING_TTL_BOUNDS.maxMs, Math.floor(signal.ttlMs)));
  return { y: signal.typing, x: ttl };
}

export function decodeTyping(value: CborValue): TypingSignal {
  const m = asMap(value, 'typing');
  const typing = reqBool(m.y, 'typing flag', false);
  // A peer asking for a ten-hour indicator is either broken or malicious; in
  // both cases the answer is the same, and it is not "believe them".
  const requested = optInt(m.x, 'typing ttl', 0, 24 * 60 * 60 * 1000) ?? TYPING_TTL_BOUNDS.maxMs;
  const ttlMs = Math.max(TYPING_TTL_BOUNDS.minMs, Math.min(TYPING_TTL_BOUNDS.maxMs, requested));
  return { typing, ttlMs };
}

// ---------------------------------------------------------------------------
// DELIVERY_RECEIPT / READ_RECEIPT
// ---------------------------------------------------------------------------

export function encodeReceipt(signal: ReceiptSignal): CborValue {
  if (signal.ids.length === 0) throw new Error('chat: receipt must name at least one message');
  if (signal.ids.length > CHAT_LIMITS.maxIdsPerBatch) {
    throw new Error(`chat: receipt names more than ${CHAT_LIMITS.maxIdsPerBatch} messages`);
  }
  for (const id of signal.ids) assertValidId(id);
  return { i: signal.ids.map((id) => id as CborValue), s: Math.max(0, Math.floor(signal.at)) };
}

export function decodeReceipt(value: CborValue): ReceiptSignal {
  const m = asMap(value, 'receipt');
  const list = reqList(m.i, 'receipt ids', CHAT_LIMITS.maxIdsPerBatch);
  if (list.length === 0) throw new DecodeError('chat: receipt names no messages');
  return {
    ids: list.map((id) => messageId(id, 'receipt id')),
    at: reqInt(m.s ?? 0, 'receipt timestamp', 0, CHAT_LIMITS.maxTimestampMs),
  };
}

// ---------------------------------------------------------------------------
// REACTION
// ---------------------------------------------------------------------------

/** Normalise an emoji for the wire. Throws if it cannot be one. */
export function normalizeReaction(emoji: string): string {
  const clean = sanitizeChatText(emoji, false);
  if (clean.length === 0) throw new Error('chat: reaction must not be empty');
  if (codePointLength(clean) > CHAT_LIMITS.maxReactionCodePoints) {
    throw new Error(`chat: reaction exceeds ${CHAT_LIMITS.maxReactionCodePoints} code points`);
  }
  if (utf8Length(clean) > CHAT_LIMITS.maxReactionBytes) {
    throw new Error(`chat: reaction exceeds ${CHAT_LIMITS.maxReactionBytes} bytes`);
  }
  return clean;
}

export function encodeReaction(signal: ReactionSignal): CborValue {
  return {
    i: assertValidId(signal.messageId, 'reaction target id'),
    e: normalizeReaction(signal.emoji),
    x: signal.removed ? true : undefined,
    s: Math.max(0, Math.floor(signal.at)),
  };
}

export function decodeReaction(value: CborValue): ReactionSignal {
  const m = asMap(value, 'reaction');
  const raw = reqString(m.e, 'reaction', CHAT_LIMITS.maxReactionCodePoints);
  if (utf8Length(raw) > CHAT_LIMITS.maxReactionBytes) throw new DecodeError('chat: reaction exceeds byte limit');
  const emoji = sanitizeChatText(raw, false);
  if (emoji.length === 0) throw new DecodeError('chat: reaction is empty after sanitisation');
  return {
    messageId: messageId(m.i, 'reaction target id'),
    emoji,
    removed: reqBool(m.x, 'reaction removed flag', false),
    at: reqInt(m.s ?? 0, 'reaction timestamp', 0, CHAT_LIMITS.maxTimestampMs),
  };
}

// ---------------------------------------------------------------------------
// MESSAGE_DELETE
// ---------------------------------------------------------------------------

export function encodeDeleteRequest(signal: DeleteRequestSignal): CborValue {
  if (signal.ids.length === 0) throw new Error('chat: delete request must name at least one message');
  if (signal.ids.length > CHAT_LIMITS.maxIdsPerBatch) {
    throw new Error(`chat: delete request names more than ${CHAT_LIMITS.maxIdsPerBatch} messages`);
  }
  for (const id of signal.ids) assertValidId(id);
  return { i: signal.ids.map((id) => id as CborValue) };
}

export function decodeDeleteRequest(value: CborValue): DeleteRequestSignal {
  const m = asMap(value, 'delete request');
  const list = reqList(m.i, 'delete ids', CHAT_LIMITS.maxIdsPerBatch);
  if (list.length === 0) throw new DecodeError('chat: delete request names no messages');
  return { ids: list.map((id) => messageId(id, 'delete id')) };
}

// ---------------------------------------------------------------------------
// MESSAGE_HISTORY_REQUEST / RESPONSE
// ---------------------------------------------------------------------------

export function encodeHistoryRequest(signal: HistoryRequestSignal): CborValue {
  assertValidId(signal.requestId, 'history request id');
  if (signal.afterId !== null) assertValidId(signal.afterId, 'history cursor id');
  const limit = Math.max(1, Math.min(CHAT_LIMITS.maxHistoryPageSize, Math.floor(signal.limit)));
  return {
    q: signal.requestId,
    s: Math.max(0, Math.min(CHAT_LIMITS.maxTimestampMs, Math.floor(signal.sinceMs))),
    a: signal.afterId ?? undefined,
    n: limit,
  };
}

export function decodeHistoryRequest(value: CborValue): HistoryRequestSignal {
  const m = asMap(value, 'history request');
  // The limit is clamped, never rejected: a peer asking for a million messages
  // gets a page of 100, which is a better answer than a dropped packet and an
  // app that appears to have stopped syncing.
  const requested = reqInt(m.n ?? CHAT_LIMITS.maxHistoryPageSize, 'history limit', 0, 0x7fff_ffff);
  return {
    requestId: messageId(m.q, 'history request id'),
    sinceMs: reqInt(m.s ?? 0, 'history since', 0, CHAT_LIMITS.maxTimestampMs),
    afterId: m.a === undefined || m.a === null ? null : messageId(m.a, 'history cursor id'),
    limit: Math.max(1, Math.min(CHAT_LIMITS.maxHistoryPageSize, requested)),
  };
}

export function encodeHistoryResponse(signal: HistoryResponseSignal): CborValue {
  assertValidId(signal.requestId, 'history request id');
  if (signal.messages.length > CHAT_LIMITS.maxHistoryPageSize) {
    throw new Error(`chat: history response exceeds ${CHAT_LIMITS.maxHistoryPageSize} messages`);
  }
  return {
    q: signal.requestId,
    m: signal.messages.map((msg) => encodeChatMessage(msg)),
    x: signal.more ? true : undefined,
  };
}

export function decodeHistoryResponse(value: CborValue): HistoryResponseSignal {
  const m = asMap(value, 'history response');
  const list = reqList(m.m, 'history messages', CHAT_LIMITS.maxHistoryPageSize);
  return {
    requestId: messageId(m.q, 'history request id'),
    messages: list.map((entry) => decodeChatMessage(entry)),
    more: reqBool(m.x, 'history more flag', false),
  };
}
