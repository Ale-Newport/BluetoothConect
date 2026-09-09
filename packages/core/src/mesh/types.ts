/**
 * Groups and mesh routing - domain types.
 *
 * A "group" here is three to eight people in one room, on one plane row, at one
 * dinner table. That shapes every decision in this module:
 *
 *  - the member list is small enough to send whole, every time, so there are no
 *    deltas to lose and no way for two peers to disagree about what a delta
 *    meant;
 *  - not everyone can hear everyone. A plane row is a LINE, not a clique, so a
 *    message from seat 1 to seat 3 has to be carried by seat 2;
 *  - there is no server to be the source of truth, so the state has to converge
 *    on its own from whatever fragments of gossip reach each device.
 *
 * Pure data only. No clock, no session, no I/O - so the merge rule and the
 * wire format can be tested on their own.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface GroupMember {
  /** Cryptographic peer id. The durable identity, not a transport handle. */
  readonly peerId: string;
  /** Display name as last advertised by that peer. Untrusted, bounded, cosmetic. */
  readonly displayName: string;
  /** Sender's wall clock when they joined. Advisory - used only for display. */
  readonly joinedAt: number;
}

/**
 * The complete state of a group, as one value.
 *
 * Snapshots are immutable and totally ordered by `compareSnapshots`, which is
 * what lets a device that has been out of range for a minute take whichever of
 * two states it is offered and be certain every other device will take the same
 * one. Without a total order, gossip converges to different answers on
 * different phones, and the group silently splits.
 */
export interface GroupSnapshot {
  readonly groupId: string;
  readonly name: string;
  /**
   * The member currently acting as host. A plain field, deliberately: host
   * migration is a change to this one value plus an epoch bump, and nothing
   * else in the module reads it except `isHost`.
   */
  readonly hostId: string;
  /**
   * Monotonic version counter. Bumped by whoever makes an authoritative change.
   * The first term of the snapshot ordering.
   */
  readonly epoch: number;
  /**
   * Members in join order. Order is part of the state - it is what a future
   * automatic host migration would use to agree on who goes next without a
   * round of voting.
   */
  readonly members: readonly GroupMember[];
  /** Wall clock of the last local change. Advisory; never used for ordering. */
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

export const RelayFlags = {
  NONE: 0,
  /**
   * The payload is already sealed for the destination, so a relay carrying it
   * learns nothing from it.
   *
   * AirLink does not yet have a group key or an end-to-end session between two
   * members who cannot see each other, so nothing in this build sets this bit
   * by itself. A caller that has its own sealing scheme can set it, and the
   * destination is told through `GroupMessageEvent.endToEnd`. See the security
   * note at the top of groupSession.ts for what is actually true today.
   */
  END_TO_END_SEALED: 1 << 0,
} as const;

/**
 * One application message travelling through the mesh.
 *
 * `destinationId` empty means "every member" - a broadcast. Anything else is a
 * unicast to that member, forwarded by whoever can reach them.
 */
export interface RelayPacket {
  readonly groupId: string;
  /** The member that actually composed this. NOT the neighbour that handed it over. */
  readonly originId: string;
  /** Target member, or '' for a broadcast to the whole group. */
  readonly destinationId: string;
  /** Unique per (origin, message). The key the loop-breaking seen-set is built on. */
  readonly messageId: string;
  /** Forwards still permitted. Decremented by each relay; 0 means stop. */
  readonly hops: number;
  readonly flags: number;
  /** MessageType of the payload, so the receiver can route it like any message. */
  readonly innerType: number;
  readonly payload: Uint8Array;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Why a packet was thrown away. Every value here is a rule a hostile or merely
 * confused peer can trip, and every one of them is a test.
 */
export const MeshDropReason = {
  MALFORMED: 'malformed',
  WRONG_GROUP: 'wrongGroup',
  /** The neighbour that handed us the packet is not in the group. */
  RELAY_NOT_MEMBER: 'relayNotMember',
  /** The claimed original sender is not in the group. */
  ORIGIN_NOT_MEMBER: 'originNotMember',
  /** The packet is addressed to somebody who is not in the group. */
  DESTINATION_NOT_MEMBER: 'destinationNotMember',
  /** The group already holds MESH_LIMITS.maxMembers people. */
  GROUP_FULL: 'groupFull',
  /** Our own packet came back to us. */
  OWN_PACKET: 'ownPacket',
  /** Seen already - a second copy from a second path, or a loop closing. */
  DUPLICATE: 'duplicate',
  /** Out of hops. It travelled as far as its sender permitted. */
  HOP_LIMIT: 'hopLimit',
  /** No group has been created or joined on this device yet. */
  NO_GROUP: 'noGroup',
  /**
   * This origin has already spent its share of our relay budget for the moment.
   * We still delivered anything addressed to us; we simply will not fan it out.
   */
  RATE_LIMITED: 'rateLimited',
  /**
   * A state update claiming an epoch so far ahead of ours that believing it
   * would pin the counter at its ceiling and freeze the group permanently.
   */
  EPOCH_JUMP: 'epochJump',
  /**
   * The session that handed us this has since authenticated as somebody other
   * than the peer it was attached as. Nothing it says can be attributed.
   */
  IDENTITY_MISMATCH: 'identityMismatch',
} as const;
export type MeshDropReason = (typeof MeshDropReason)[keyof typeof MeshDropReason];

/** An application message that reached us, directly or through a relay. */
export interface GroupMessageEvent {
  readonly groupId: string;
  /** The member who composed it. */
  readonly from: string;
  /** The neighbour who handed it to us. Equal to `from` on a direct delivery. */
  readonly via: string;
  readonly type: number;
  readonly payload: Uint8Array;
  readonly broadcast: boolean;
  readonly hopsRemaining: number;
  /** True when at least one other device forwarded this. */
  readonly relayed: boolean;
  /**
   * False when a relay on the path could read the payload in the clear.
   *
   * Today this is `!relayed`: a relayed payload is decrypted by the relay and
   * re-encrypted onwards, so the relaying phone genuinely sees the plaintext.
   * The UI must not claim otherwise. See groupSession.ts.
   */
  readonly endToEnd: boolean;
}

export interface GroupEvents {
  message: GroupMessageEvent;
  stateChanged: { readonly snapshot: GroupSnapshot; readonly reason: string };
  memberJoined: { readonly member: GroupMember };
  memberLeft: { readonly peerId: string; readonly reason: string };
  hostChanged: { readonly from: string; readonly to: string };
  /**
   * The host left the group and nobody has taken over. The app decides what
   * happens next by calling `promoteHost`; this module never decides by itself.
   */
  hostLost: { readonly hostId: string };
  /** A packet we carried for somebody else. Diagnostics and tests. */
  relayed: {
    readonly messageId: string;
    readonly origin: string;
    readonly destination: string | null;
    readonly hopsRemaining: number;
    readonly to: readonly string[];
  };
  dropped: { readonly reason: MeshDropReason; readonly via: string; readonly detail?: string };
}
