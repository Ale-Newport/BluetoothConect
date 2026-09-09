/**
 * Group and mesh wire codec.
 *
 * Pure functions over bytes: no clock, no session, no state. Every rule in here
 * is testable with a hand-written hostile payload, which is the point.
 *
 * The two asymmetries the rest of the codebase uses hold here too:
 *
 *  - encoders throw `Error` (our bug, be loud), decoders throw `DecodeError`
 *    (a peer's packet, drop it);
 *  - a field that is merely ugly is bounded and kept; a field that is out of
 *    range or the wrong type kills the whole packet. There is no partial parse.
 *
 * Wire keys are one character. A BLE GATT datagram is 180 bytes and a group of
 * six multiplies every byte by five.
 */
import { MessageType } from '../protocol/constants.js';
import type { CborValue } from '../protocol/cbor.js';
import { ByteReader, ByteWriter, DecodeError } from '../util/varint.js';
import { MAX_GROUP_EPOCH, MESH_LIMITS, RELAY_WIRE_VERSION, isMeshId, meshId, meshInt, meshText } from './constants.js';
import { RelayFlags, type GroupMember, type GroupSnapshot, type RelayPacket } from './types.js';

/** Timestamps must be sane: no negatives, nothing past roughly the year 2200. */
const MAX_TIMESTAMP_MS = 7_258_118_400_000;
/** Bound on a peer-supplied leave reason. Cosmetic string, so just cap it. */
const MAX_REASON_CHARS = 64;

// ---------------------------------------------------------------------------
// Bounded readers over a decoded CBOR map
// ---------------------------------------------------------------------------

function asMap(value: CborValue | null, what: string): Record<string, CborValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new DecodeError(`mesh: ${what} must be a map`);
  }
  return value as Record<string, CborValue>;
}

function asArray(value: CborValue | undefined, what: string, maxLength: number): CborValue[] {
  if (!Array.isArray(value)) throw new DecodeError(`mesh: ${what} must be an array`);
  // Checked before anything is copied out: the point of the bound is to refuse
  // to spend memory, not to notice afterwards that we spent too much.
  if (value.length > maxLength) throw new DecodeError(`mesh: ${what} has too many entries`);
  return value;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * A member on the wire is a 3-element array, not a map: `[peerId, name, joinedAt]`.
 * Eight members with three named keys each would spend well over a hundred bytes
 * on the words - a second and a half of a BLE link, per state update.
 */
function encodeMember(member: GroupMember): CborValue {
  return [member.peerId, member.displayName, Math.max(0, Math.floor(member.joinedAt))];
}

function decodeMember(value: CborValue): GroupMember {
  if (!Array.isArray(value) || value.length !== 3) throw new DecodeError('mesh: malformed member entry');
  return {
    peerId: meshId(value[0], 'member peerId', MESH_LIMITS.maxPeerIdLength),
    displayName: meshText(value[1], 'member displayName', MESH_LIMITS.maxDisplayNameLength),
    joinedAt: meshInt(value[2], 'member joinedAt', 0, MAX_TIMESTAMP_MS),
  };
}

// ---------------------------------------------------------------------------
// Snapshot - carried identically by GROUP_CREATE, GROUP_UPDATE and
// GROUP_STATE_RESPONSE, because all three answer the same question.
// ---------------------------------------------------------------------------

export function encodeGroupSnapshot(snapshot: GroupSnapshot): CborValue {
  if (snapshot.members.length > MESH_LIMITS.maxMembers) {
    throw new Error(`mesh: cannot encode ${snapshot.members.length} members, limit is ${MESH_LIMITS.maxMembers}`);
  }
  if (!isMeshId(snapshot.groupId, MESH_LIMITS.maxGroupIdLength)) throw new Error('mesh: invalid groupId');
  if (!isMeshId(snapshot.hostId, MESH_LIMITS.maxPeerIdLength)) throw new Error('mesh: invalid hostId');
  return {
    g: snapshot.groupId,
    n: snapshot.name,
    h: snapshot.hostId,
    e: snapshot.epoch,
    u: Math.max(0, Math.floor(snapshot.updatedAt)),
    m: snapshot.members.map(encodeMember),
  };
}

export function decodeGroupSnapshot(value: CborValue | null): GroupSnapshot {
  const m = asMap(value, 'group snapshot');
  const rawMembers = asArray(m.m, 'members', MESH_LIMITS.maxMembers);

  const members: GroupMember[] = [];
  const seen = new Set<string>();
  for (const entry of rawMembers) {
    const member = decodeMember(entry);
    // A duplicated member id would make "is this peer a member" ambiguous, and
    // every relay decision downstream is built on that question.
    if (seen.has(member.peerId)) throw new DecodeError('mesh: duplicate member in snapshot');
    seen.add(member.peerId);
    members.push(member);
  }

  return {
    groupId: meshId(m.g, 'groupId', MESH_LIMITS.maxGroupIdLength),
    name: meshText(m.n ?? '', 'group name', MESH_LIMITS.maxGroupNameLength),
    // The host is NOT required to appear in the member list. A host that has
    // just walked out of the room leaves exactly that state behind, and it has
    // to be representable or the group cannot describe its own situation.
    hostId: meshId(m.h, 'hostId', MESH_LIMITS.maxPeerIdLength),
    epoch: meshInt(m.e, 'epoch', 0, MAX_GROUP_EPOCH),
    members,
    updatedAt: meshInt(m.u ?? 0, 'updatedAt', 0, MAX_TIMESTAMP_MS),
  };
}

/**
 * The same rules `decodeGroupSnapshot` enforces, applied to a snapshot that did
 * NOT arrive through the decoder.
 *
 * A snapshot handed in out of band - scanned from a QR code across the aisle,
 * restored from a file, typed by a caller - is exactly as untrusted as one off
 * the wire, and it reaches us through `GroupSession.adopt`, which is a plain
 * TypeScript call the type system cannot police. Without this check a group id
 * outside the shared alphabet, a fractional epoch or a duplicated member id
 * gets into local state, and the damage shows up much later and somewhere else:
 * every snapshot we then gossip is rejected by every peer as malformed, so the
 * device is silently and permanently unable to agree with the group.
 *
 * Returns a human-readable description of the FIRST problem, or null when the
 * snapshot is well-formed. A string rather than a throw, so the caller decides
 * which error type belongs to its own API.
 */
export function snapshotProblem(snapshot: GroupSnapshot): string | null {
  if (!isMeshId(snapshot.groupId, MESH_LIMITS.maxGroupIdLength)) return 'groupId is not a valid identifier';
  if (!isMeshId(snapshot.hostId, MESH_LIMITS.maxPeerIdLength)) return 'hostId is not a valid identifier';
  if (typeof snapshot.name !== 'string' || snapshot.name.length > MESH_LIMITS.maxGroupNameLength) {
    return `name must be a string of at most ${MESH_LIMITS.maxGroupNameLength} characters`;
  }
  if (!Number.isInteger(snapshot.epoch) || snapshot.epoch < 0 || snapshot.epoch > MAX_GROUP_EPOCH) {
    return 'epoch must be an integer within the group epoch range';
  }
  if (!Number.isInteger(snapshot.updatedAt) || snapshot.updatedAt < 0 || snapshot.updatedAt > MAX_TIMESTAMP_MS) {
    return 'updatedAt must be a plausible millisecond timestamp';
  }
  if (!Array.isArray(snapshot.members)) return 'members must be an array';
  if (snapshot.members.length > MESH_LIMITS.maxMembers) {
    return `members exceeds the limit of ${MESH_LIMITS.maxMembers}`;
  }
  const seen = new Set<string>();
  for (const member of snapshot.members) {
    if (member === null || typeof member !== 'object') return 'malformed member entry';
    if (!isMeshId(member.peerId, MESH_LIMITS.maxPeerIdLength)) return 'member peerId is not a valid identifier';
    if (typeof member.displayName !== 'string' || member.displayName.length > MESH_LIMITS.maxDisplayNameLength) {
      return 'member displayName is not a bounded string';
    }
    if (!Number.isInteger(member.joinedAt) || member.joinedAt < 0 || member.joinedAt > MAX_TIMESTAMP_MS) {
      return 'member joinedAt must be a plausible millisecond timestamp';
    }
    // A duplicated id makes "is this peer a member" ambiguous, and every relay
    // decision downstream is built on that one question.
    if (seen.has(member.peerId)) return `duplicate member ${member.peerId}`;
    seen.add(member.peerId);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Join / leave / state request
// ---------------------------------------------------------------------------

export interface MemberJoinSignal {
  readonly groupId: string;
  readonly member: GroupMember;
}

export function encodeMemberJoin(signal: MemberJoinSignal): CborValue {
  return { g: signal.groupId, m: encodeMember(signal.member) };
}

export function decodeMemberJoin(value: CborValue | null): MemberJoinSignal {
  const m = asMap(value, 'member join');
  return {
    groupId: meshId(m.g, 'groupId', MESH_LIMITS.maxGroupIdLength),
    member: decodeMember(m.m as CborValue),
  };
}

export interface MemberLeaveSignal {
  readonly groupId: string;
  readonly peerId: string;
  readonly reason: string;
}

export function encodeMemberLeave(signal: MemberLeaveSignal): CborValue {
  return { g: signal.groupId, p: signal.peerId, r: signal.reason.slice(0, MAX_REASON_CHARS) };
}

export function decodeMemberLeave(value: CborValue | null): MemberLeaveSignal {
  const m = asMap(value, 'member leave');
  return {
    groupId: meshId(m.g, 'groupId', MESH_LIMITS.maxGroupIdLength),
    peerId: meshId(m.p, 'peerId', MESH_LIMITS.maxPeerIdLength),
    reason: meshText(m.r ?? '', 'leave reason', MAX_REASON_CHARS),
  };
}

export function encodeStateRequest(groupId: string): CborValue {
  return { g: groupId };
}

export function decodeStateRequest(value: CborValue | null): string {
  const m = asMap(value, 'state request');
  return meshId(m.g, 'groupId', MESH_LIMITS.maxGroupIdLength);
}

// ---------------------------------------------------------------------------
// Relay packet
//
// Binary rather than CBOR, and deliberately laid out as the envelope's own
// optional id fields are (protocol/frame.ts): a length-prefixed run of ASCII
// from the [0-9A-Za-z-_] alphabet, capped at 64 bytes.
//
// Those envelope fields - EnvelopeFlags.HAS_SENDER and HAS_DESTINATION - are
// where this routing information belongs, and where it will live once
// PeerSession exposes them on its send path. It does not today: `sendReliable`
// and `sendReliableRaw` build the envelope themselves and offer no way to set
// either id. So the header rides one layer down, inside the payload, in the
// identical encoding, and the receive path prefers the envelope's `senderId`
// whenever the session does supply one. When the send API grows the fields, the
// same bytes move up a layer and the format does not change.
//
// The security consequence is the same either way, and it is stated in full at
// the top of groupSession.ts: a relay reads this header. It must, or it cannot
// route. It also decrypts and re-encrypts the payload, because the only
// encryption in this build is pairwise.
// ---------------------------------------------------------------------------

function writeId(w: ByteWriter, id: string, field: string): void {
  // Empty is legal only for destinationId (a broadcast) - the caller decides.
  if (id.length > MESH_LIMITS.maxPeerIdLength) throw new Error(`mesh: ${field} too long`);
  const bytes = new Uint8Array(id.length);
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code > 0x7f) throw new Error(`mesh: ${field} must be ASCII`);
    bytes[i] = code;
  }
  w.lenBytes(bytes);
}

function readId(r: ByteReader, field: string, maxLength: number, allowEmpty: boolean): string {
  const bytes = r.lenBytes();
  if (bytes.length === 0) {
    if (allowEmpty) return '';
    throw new DecodeError(`mesh: ${field} is empty`);
  }
  if (bytes.length > maxLength) throw new DecodeError(`mesh: ${field} too long`);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] as number);
  // One alphabet rule for the whole stack; see isMeshId in constants.ts.
  if (!isMeshId(out, maxLength)) throw new DecodeError(`mesh: ${field} is not a valid identifier`);
  return out;
}

export function encodeRelayPacket(packet: RelayPacket): Uint8Array {
  if (packet.hops < 1 || packet.hops > MESH_LIMITS.maxHops || !Number.isInteger(packet.hops)) {
    throw new Error(`mesh: hop budget ${packet.hops} is outside 1..${MESH_LIMITS.maxHops}`);
  }
  if (packet.payload.length > MESH_LIMITS.maxRelayPayloadBytes) {
    throw new Error(`mesh: relay payload of ${packet.payload.length} bytes exceeds the limit`);
  }
  if (packet.innerType === MessageType.GROUP_RELAY) {
    throw new Error('mesh: a relay packet may not carry another relay packet');
  }

  const w = new ByteWriter(packet.payload.length + 128);
  w.u8(RELAY_WIRE_VERSION);
  w.u8(packet.flags & 0xff);
  writeId(w, packet.groupId, 'groupId');
  writeId(w, packet.originId, 'originId');
  writeId(w, packet.destinationId, 'destinationId');
  writeId(w, packet.messageId, 'messageId');
  w.u8(packet.hops);
  w.varint(packet.innerType);
  w.lenBytes(packet.payload);
  return w.finish();
}

export function decodeRelayPacket(bytes: Uint8Array): RelayPacket {
  const r = new ByteReader(bytes);
  const version = r.u8();
  // Unknown relay versions are refused rather than best-effort parsed: a
  // half-understood routing header is how a packet ends up somewhere it was
  // never addressed.
  if (version !== RELAY_WIRE_VERSION) throw new DecodeError(`mesh: unsupported relay version ${version}`);

  const flags = r.u8();
  // Reject flag bits this build does not define, so a future bit that changes
  // how the payload must be handled cannot be silently ignored by an old peer.
  const knownFlags = RelayFlags.END_TO_END_SEALED;
  if ((flags & ~knownFlags) !== 0) throw new DecodeError('mesh: unknown relay flags');

  const groupId = readId(r, 'groupId', MESH_LIMITS.maxGroupIdLength, false);
  const originId = readId(r, 'originId', MESH_LIMITS.maxPeerIdLength, false);
  const destinationId = readId(r, 'destinationId', MESH_LIMITS.maxPeerIdLength, true);
  const messageId = readId(r, 'messageId', MESH_LIMITS.maxMessageIdLength, false);

  const hops = r.u8();
  if (hops < 1 || hops > MESH_LIMITS.maxHops) throw new DecodeError(`mesh: hop budget ${hops} out of range`);

  const innerType = r.varint();
  if (innerType > 0xffff) throw new DecodeError('mesh: inner message type out of range');
  // No nesting. A relay inside a relay is pure amplification: one packet that
  // costs the mesh two floods, and a header a relay would have to parse twice.
  if (innerType === MessageType.GROUP_RELAY) throw new DecodeError('mesh: nested relay packet');

  const payload = r.lenBytes();
  if (payload.length > MESH_LIMITS.maxRelayPayloadBytes) throw new DecodeError('mesh: relay payload too large');
  r.expectEnd();

  // A packet addressed to its own sender is either a bug or an attempt to make
  // a relay talk to itself. Neither is worth forwarding.
  if (destinationId === originId) throw new DecodeError('mesh: packet addressed to its own origin');

  return {
    groupId,
    originId,
    destinationId,
    messageId,
    hops,
    flags,
    innerType,
    // Copy out of the reader's view: the caller keeps this after the datagram
    // buffer is recycled, and a subarray would alias it.
    payload: payload.slice(),
  };
}

// ---------------------------------------------------------------------------
// Snapshot ordering - the rule that makes gossip converge
// ---------------------------------------------------------------------------

/**
 * Canonical form of a member list, for the last tie-break only.
 * Order-sensitive on purpose: join order is part of the state.
 */
function membersKey(members: readonly GroupMember[]): string {
  let out = '';
  for (const m of members) out += `${m.peerId},`;
  return out;
}

/**
 * Total order over snapshots. Returns >0 when `a` should win, <0 when `b`
 * should, 0 when they are indistinguishable.
 *
 * It has to be TOTAL, not merely a heuristic. Two phones that pick different
 * winners from the same pair of states never converge - the group splits, and
 * neither user is told. The terms, in order:
 *
 *  1. Higher epoch. This is the real signal: an epoch is bumped by whoever made
 *     a deliberate change, so a higher one means "later decision".
 *  2. Lexicographically smaller hostId. Only reachable when two members
 *     promoted a host at the same epoch - a genuine race - and any consistent
 *     rule will do provided both sides apply the same one.
 *  3. More members, then lexicographically smaller member list. Reachable only
 *     when two announcements crossed. Arbitrary, deterministic, and
 *     self-healing: whoever loses is told the winning state by the next gossip.
 */
export function compareSnapshots(a: GroupSnapshot, b: GroupSnapshot): number {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? 1 : -1;
  if (a.hostId !== b.hostId) return a.hostId < b.hostId ? 1 : -1;
  if (a.members.length !== b.members.length) return a.members.length > b.members.length ? 1 : -1;
  const ka = membersKey(a.members);
  const kb = membersKey(b.members);
  if (ka !== kb) return ka < kb ? 1 : -1;
  return 0;
}
