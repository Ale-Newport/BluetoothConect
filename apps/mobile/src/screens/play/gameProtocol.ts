import type { StateEnvelope } from '@airlink/games';
import {
  MessageType,
  decodeCbor,
  encodeCbor,
  type CborValue,
  type IncomingMessage,
  type PeerSession,
} from '@airlink/core';

/**
 * The wire format for a game between two phones.
 *
 * The message TYPES already exist in the protocol (`MessageType.GAME_*`); what
 * lives here is only the shape of their payloads, kept in one file so both
 * sides of a game read the same definition.
 *
 * Two rules shape everything below:
 *
 *  1. NOTHING GRAPHICAL TRAVELS. A move is a few bytes - "column 4", "e2e4" -
 *     and each device draws its own board from its own copy of the state. That
 *     is what makes a game playable over Bluetooth.
 *
 *  2. THE INVITE CARRIES THE WHOLE SETUP: the seed, the seat order and the game
 *     id. Both devices then build a byte-identical starting state without
 *     another round trip, which is what lets a reconnecting player rebuild the
 *     game from its action log rather than from a state dump.
 *
 * Every field arriving from a peer is treated as hostile and is bounded here
 * before it reaches the reducer.
 */

/** Field names are one letter because a Bluetooth MTU is 185 bytes on a good day. */
export interface GameInvite {
  /**
   * Identifies THIS asking, not the game it is asking about.
   *
   * An invitation used to be identified only by the game session it would
   * create, so a retry, a rematch and a fresh invitation for the same game were
   * indistinguishable, and acknowledging one acknowledged all of them. With an
   * id of its own an invite can be repeated as often as the link demands and
   * still produce exactly ONE question on the other phone.
   */
  readonly inviteId: string;
  readonly sessionId: string;
  readonly gameId: string;
  /** Game protocol version. A mismatch means one side would apply different rules. */
  readonly version: number;
  readonly seed: number;
  /** Seat order. Index 0 is the host, and it is the same list on both devices. */
  readonly players: readonly string[];
  /** When the asking phone stops waiting. Absolute, in the sender's clock. */
  readonly expiresAt: number;
}

const MAX_ID = 64;

function asRecord(value: CborValue | null): Record<string, CborValue> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return null;
  return value as Record<string, CborValue>;
}

function asShortString(value: CborValue | undefined, max = MAX_ID): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** The session id every game message carries, or null if the message is malformed. */
export function sessionIdOf(message: IncomingMessage): string | null {
  const payload = message.value ?? safeDecode(message.raw);
  const map = asRecord(payload);
  return map ? asShortString(map.s) : null;
}

function safeDecode(raw: Uint8Array): CborValue | null {
  try {
    return decodeCbor(raw);
  } catch {
    // A peer that sends us rubbish is not an error the user can act on.
    return null;
  }
}

export function encodeInvite(invite: GameInvite): CborValue {
  return {
    s: invite.sessionId,
    i: invite.inviteId,
    g: invite.gameId,
    v: invite.version,
    d: invite.seed,
    p: [...invite.players],
    x: invite.expiresAt,
  };
}

/** Parse an invite from a peer. Returns null rather than throwing on anything odd. */
export function decodeInvite(value: CborValue | null): GameInvite | null {
  const map = asRecord(value);
  if (!map) return null;
  const sessionId = asShortString(map.s);
  const gameId = asShortString(map.g, 48);
  if (!sessionId || !gameId) return null;
  if (typeof map.v !== 'number' || !Number.isInteger(map.v) || map.v < 0 || map.v > 65535) return null;
  if (typeof map.d !== 'number' || !Number.isInteger(map.d) || map.d < 0 || map.d > 0xffffffff) return null;
  if (!Array.isArray(map.p) || map.p.length < 2 || map.p.length > 8) return null;
  const players: string[] = [];
  for (const entry of map.p) {
    const id = asShortString(entry);
    if (!id) return null;
    players.push(id);
  }
  // An invite from a build that predates invite ids still works: the game
  // session it names is a perfectly good identity for one asking, and treating
  // it as one is strictly better than refusing to play at all.
  const inviteId = asShortString(map.i) ?? sessionId;
  const expiresAt =
    typeof map.x === 'number' && Number.isFinite(map.x) && map.x > 0 ? map.x : Date.now() + INVITE_LIFETIME_MS;
  return { inviteId, sessionId, gameId, version: map.v, seed: map.d, players, expiresAt };
}

/**
 * How long an invitation is worth showing.
 *
 * The asking phone stops asking at the same moment, so the two sides agree
 * about when a question has gone stale without having to say so.
 */
export const INVITE_LIFETIME_MS = 45_000;

/** A short acknowledgement carrying only the thing being acknowledged. */
export function encodeAck(id: string): CborValue {
  return { i: id };
}

export function decodeAck(value: CborValue | null): string | null {
  const map = asRecord(value);
  if (!map) return null;
  return asShortString(map.i);
}

/**
 * An action, already encoded by the game's own `encodeAction`.
 *
 * `n` is the state version this action expects to be applied ON TOP OF. It
 * costs a couple of bytes and it is what turns "the board is wrong and nobody
 * knows why" into "I am one move behind, send me the position": a receiver
 * whose own version does not match knows it has missed something, and can ask,
 * instead of rejecting every move from here to the end of the game.
 */
export function encodeEvent(sessionId: string, action: CborValue, previousVersion: number): CborValue {
  return { s: sessionId, a: action, n: previousVersion };
}

export function decodeEvent(
  value: CborValue | null,
): { sessionId: string; action: CborValue; previousVersion: number | null } | null {
  const map = asRecord(value);
  if (!map) return null;
  const sessionId = asShortString(map.s);
  if (!sessionId || map.a === undefined) return null;
  const previousVersion =
    typeof map.n === 'number' && Number.isInteger(map.n) && map.n >= 0 ? map.n : null;
  return { sessionId, action: map.a, previousVersion };
}

/** A whole board plus the bookkeeping to carry on from it. See `StateEnvelope`. */
export function encodeSnapshot(sessionId: string, envelope: StateEnvelope): Uint8Array {
  return encodeCbor({
    s: sessionId,
    v: envelope.state,
    t: Math.round(envelope.elapsedMs),
    n: envelope.version,
    q: { ...envelope.seq },
  });
}

export function decodeSnapshot(raw: Uint8Array): { sessionId: string; envelope: StateEnvelope } | null {
  const map = asRecord(safeDecode(raw));
  if (!map) return null;
  const sessionId = asShortString(map.s);
  if (!sessionId || map.v === undefined) return null;
  const elapsedMs = typeof map.t === 'number' && Number.isFinite(map.t) ? map.t : 0;
  const version = typeof map.n === 'number' && Number.isInteger(map.n) && map.n >= 0 ? map.n : 0;

  // The sequence vector is bounded here rather than trusted: it comes off a
  // radio, and it decides which actions this device will accept next.
  const seq: Record<string, number> = {};
  const rawSeq = asRecord(map.q ?? null);
  if (rawSeq) {
    for (const [player, value] of Object.entries(rawSeq)) {
      if (player.length > MAX_ID) continue;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1e7) {
        seq[player] = value;
      }
    }
  }
  return { sessionId, envelope: { state: map.v, seq, version, elapsedMs } };
}

/** Every game message type, so the room can ignore chat and file traffic cheaply. */
export const GAME_MESSAGE_TYPES: readonly number[] = [
  MessageType.GAME_INVITE,
  MessageType.GAME_INVITE_ACK,
  MessageType.GAME_ACCEPT,
  MessageType.GAME_DECLINE,
  MessageType.GAME_RESPONSE_ACK,
  MessageType.GAME_READY,
  MessageType.GAME_START,
  MessageType.GAME_STATE,
  MessageType.GAME_EVENT,
  MessageType.GAME_END,
  MessageType.GAME_SYNC_REQUEST,
  MessageType.GAME_LEAVE,
  MessageType.GAME_REMATCH_REQUEST,
  MessageType.GAME_REMATCH_ACCEPT,
];

/**
 * Send, and say whether the bytes were handed over.
 *
 * A send throws while the link is down, which is a completely normal thing to
 * happen on a plane and never something to show the user as an error - the room
 * shows "Reconnecting…" and keeps the board.
 */
export function trySend(session: PeerSession, messageType: number, value: CborValue): boolean {
  try {
    session.sendReliable(messageType, value);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort send for snapshots. A stale snapshot is worth less than a fresh one. */
export function trySendRealtime(session: PeerSession, messageType: number, payload: Uint8Array, key: string): boolean {
  try {
    session.sendRealtime(messageType, payload, key);
    return true;
  } catch {
    return false;
  }
}

export { MessageType };
