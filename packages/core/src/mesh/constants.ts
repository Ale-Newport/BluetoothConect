/**
 * Mesh limits, wire constants and the shared identifier rule.
 *
 * Every number in here is a bound on memory or work that a *peer* can make us
 * spend, so each one is enforced on a decode path rather than merely assumed.
 * A group is a hostile environment by construction: a relay handles bytes that
 * neither it nor its user asked for.
 */
import { DecodeError } from '../util/varint.js';

export const MESH_LIMITS = {
  /**
   * A plane row, a dinner table, a hotel lobby. Eight is already optimistic
   * over BLE, where every extra member costs another concurrent GATT
   * connection and a share of a ~5-40 KB/s budget. The cap also bounds the
   * fan-out of a flood, which is what keeps relaying affordable.
   */
  maxMembers: 8,
  maxGroupIdLength: 64,
  maxGroupNameLength: 48,
  maxDisplayNameLength: 64,
  maxPeerIdLength: 64,
  maxMessageIdLength: 24,

  /**
   * Hard ceiling on the hop budget a peer may put on the wire. With at most
   * eight members the network diameter cannot exceed seven hops, and in
   * practice a line of phones is three or four; four is generous and bounds
   * how much work one injected packet can cost the mesh.
   */
  maxHops: 4,
  /** Hop budget a message starts with unless the caller asks for less. */
  defaultHops: 4,

  /** Largest application payload that may travel inside a relay packet. */
  maxRelayPayloadBytes: 32 * 1024,

  /** Entries retained by the loop-breaking seen-set. Bounded memory, always. */
  seenCapacity: 512,
  /** How long an entry stays in the seen-set. Longer than any plausible flood. */
  seenTtlMs: 120_000,

  /**
   * Relay budget, per origin, over a sliding window.
   *
   * The seen-set stops a packet being carried TWICE; nothing else stops one
   * member originating a million distinct packets. Each one we accept costs us
   * up to `maxMembers - 1` outbound sends, and `ReliableChannel` queues what it
   * cannot yet transmit - so on a BLE link that has slipped into a pocket the
   * queue is the thing that grows until the OS kills the app.
   *
   * These numbers are per ORIGIN, so one greedy member cannot spend anybody
   * else's share, and they are far above anything a human generates: 64 relayed
   * packets or 256 KB a second is already an order of magnitude more than a BLE
   * link can carry.
   *
   * This bounds AMPLIFICATION - the fan-out we perform on somebody else's
   * behalf. It is not end-to-end back-pressure, which would need a queue-depth
   * signal PeerSession does not expose on its send path today.
   */
  relayWindowMs: 1000,
  relayPacketsPerWindow: 64,
  relayBytesPerWindow: 256 * 1024,
} as const;

/**
 * Largest epoch advance we will accept from a peer in a single state update.
 *
 * The epoch is peer-supplied and bounded above by MAX_GROUP_EPOCH, but "in
 * range" is not the same as "believable". A member that hands us 0xffffffff
 * pins the counter at its ceiling forever - `bumpEpoch` saturates there, so no
 * later change can ever out-rank it and the group is frozen at whatever the
 * remaining tie-breaks pick. Recovery is impossible without every device
 * leaving and re-forming the group.
 *
 * An epoch is bumped once per membership or host change in a group of at most
 * eight people, so a device that has been out of range for an entire flight is
 * still only a handful behind. A thousand is generous by orders of magnitude
 * and still refuses the jump that would freeze us.
 */
export const MAX_EPOCH_ADVANCE = 1024;

/** Version byte of the GROUP_RELAY packet header. */
export const RELAY_WIRE_VERSION = 1;

/**
 * Ceiling on the group state counter: a 32-bit unsigned integer.
 *
 * Shared by the codec (which rejects anything larger from a peer) and by the
 * session (which saturates rather than wrapping at it). A wrap would break the
 * total order that gossip convergence depends on.
 */
export const MAX_GROUP_EPOCH = 0xffff_ffff;

/**
 * Thrown for a *local* misuse of the mesh API (promoting a non-member, sending
 * to a stranger, joining a full group). Never thrown because of a peer: bytes
 * from a peer produce a DecodeError, which the router swallows as a drop.
 */
export class MeshError extends Error {
  override readonly name = 'MeshError';
}

/**
 * Identifiers used by the mesh travel in the envelope's senderId/destinationId
 * fields, so they must satisfy exactly the rule frame.ts enforces on decode:
 * a non-empty run of [0-9A-Za-z-_]. Keeping the check here as well means a
 * malformed id is rejected by the mesh before it can reach an encoder that
 * would throw, and the two rules are documented as the single rule they are.
 */
export function isMeshId(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;
    if (!ok) return false;
  }
  return true;
}

/** Validate a peer-supplied identifier. Throws DecodeError, so callers drop. */
export function meshId(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new DecodeError(`mesh: ${field} must be a string`);
  if (!isMeshId(value, maxLength)) throw new DecodeError(`mesh: ${field} is not a valid identifier`);
  return value;
}

/** Validate a peer-supplied, human-facing string: bounded, otherwise free-form. */
export function meshText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new DecodeError(`mesh: ${field} must be a string`);
  if (value.length > maxLength) throw new DecodeError(`mesh: ${field} exceeds ${maxLength} characters`);
  return value;
}

/** Validate a peer-supplied integer against an inclusive range. */
export function meshInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DecodeError(`mesh: ${field} must be an integer`);
  }
  if (value < min || value > max) throw new DecodeError(`mesh: ${field} out of range`);
  return value;
}
