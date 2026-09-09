/**
 * GroupSession - a named group of up to eight people, and the router that makes
 * a message from one of them reach another they cannot see.
 *
 * ## The shape of the problem
 *
 * Everything below this module is one-to-one: a PeerSession is a conversation
 * with exactly one peer. A group is not a clique. On a plane, seats 1, 2 and 3
 * are a LINE - seat 1 and seat 3 are two metres and one headrest apart, which is
 * more than enough for BLE to give up. Seat 2 has to carry the message.
 *
 * So this module does two things: it keeps a member list that converges without
 * a server, and it forwards packets for members that cannot reach each other.
 *
 * ## How forwarding works, and how it is bounded
 *
 * Controlled flooding. There is no routing table, because building one costs
 * more messages than it saves at this size and because a stale route fails
 * silently, which is the worst possible failure on a radio that comes and goes.
 * A relay sends a packet on to every member it did not receive it from. Three
 * bounds keep that affordable and safe:
 *
 *  1. A HOP LIMIT in the packet, decremented by every relay. At zero the packet
 *     stops. Eight members cannot be more than seven links apart, and in a real
 *     room they are two or three, so `MESH_LIMITS.maxHops` is 4.
 *  2. A SEEN-SET per device, bounded in both entries and age (see seenSet.ts).
 *     This is what terminates a loop: the packet comes back around the cycle,
 *     is recognised, and dies. It is also what makes a broadcast arrive exactly
 *     once at a member who can hear us two different ways.
 *  3. MEMBERSHIP CHECKS on both ends of every forward. We do not relay for a
 *     neighbour who is not in the group, we do not relay a packet whose claimed
 *     origin is not in the group, and we do not relay to a destination who is
 *     not in the group. A stranger gets nothing carried for them.
 *
 * ## The security property, stated plainly
 *
 * **A relayed message is readable by the relay.**
 *
 * AirLink's encryption is pairwise: PeerSession owns a ChaCha20-Poly1305 session
 * with one peer. When B forwards a packet from A to C, B decrypts A's frame,
 * reads the routing header - it must, or it cannot route - and re-encrypts the
 * payload into its own session with C. The application bytes pass through B's
 * memory in the clear. B is a friend in the same group, not a stranger, but the
 * UI must never claim end-to-end secrecy for a relayed message, and this module
 * reports the truth on every delivery: `GroupMessageEvent.endToEnd` is false
 * whenever the message was relayed.
 *
 * What would fix it, and is deliberately not in this build: either a group key
 * agreed among the members, or an A-to-C SIGMA-I handshake tunnelled through B
 * over GROUP_RELAY, after which the payload B forwards is opaque to it. The
 * wire format already reserves `RelayFlags.END_TO_END_SEALED` for that day, and
 * the relay path never inspects a payload, only the header - so adding it is a
 * change to the endpoints, not to the router.
 *
 * ## What this module does not do
 *
 * It does not own sessions. It borrows them, exactly as PeerSession borrows a
 * link: the app attaches an authenticated PeerSession per neighbour and detaches
 * it when that session closes. Nothing here reconnects, retries a link, or
 * decides who to connect to.
 */
import { MessageType } from '../protocol/constants.js';
import type { CborValue } from '../protocol/cbor.js';
import type { IncomingMessage } from '../session/peerSession.js';
import type { RandomSource } from '../crypto/random.js';
import { TypedEmitter, type Unsubscribe } from '../util/emitter.js';
import { Logger, silentLogger } from '../util/logger.js';
import { toHex } from '../util/bytes.js';
import type { Clock } from '../util/time.js';
import { DecodeError } from '../util/varint.js';
import { MAX_GROUP_EPOCH, MESH_LIMITS, MeshError, isMeshId } from './constants.js';
import {
  compareSnapshots,
  decodeGroupSnapshot,
  decodeMemberJoin,
  decodeMemberLeave,
  decodeRelayPacket,
  decodeStateRequest,
  encodeGroupSnapshot,
  encodeMemberJoin,
  encodeMemberLeave,
  encodeRelayPacket,
  encodeStateRequest,
} from './codec.js';
import { SeenSet, seenKey } from './seenSet.js';
import {
  MeshDropReason,
  RelayFlags,
  type GroupEvents,
  type GroupMember,
  type GroupSnapshot,
  type RelayPacket,
} from './types.js';

/**
 * The slice of PeerSession the mesh actually uses.
 *
 * Narrow on purpose. The router needs to send two kinds of message and hear
 * about incoming ones; it has no business with handshakes, link migration or
 * clock sync. A real `PeerSession` satisfies this structurally, and a test can
 * supply something far smaller.
 */
export interface MeshPeer {
  /** The authenticated cryptographic identity, or null before the handshake. */
  readonly peerId: string | null;
  sendReliable(messageType: number, value: CborValue): number;
  sendReliableRaw(messageType: number, payload: Uint8Array): number;
  readonly events: {
    on(event: 'message', listener: (message: IncomingMessage) => void): Unsubscribe;
  };
}

export interface GroupSessionOptions {
  /** Our own cryptographic peer id. Must satisfy the shared identifier rule. */
  readonly localPeerId: string;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly localDisplayName?: string;
  readonly logger?: Logger;
  /** Hop budget put on packets we originate. Clamped to MESH_LIMITS.maxHops. */
  readonly defaultHops?: number;
  readonly seenCapacity?: number;
  readonly seenTtlMs?: number;
}

export interface SendOptions {
  /** Override the hop budget for this message. Clamped to 1..maxHops. */
  readonly hops?: number;
  /**
   * Assert that `payload` is already sealed for the destination, so a relay
   * learns nothing from carrying it. Nothing in this build seals payloads; set
   * this only if the caller has its own scheme, because the destination will be
   * told the message was confidential from the relays.
   */
  readonly endToEndSealed?: boolean;
}

interface Neighbour {
  readonly peer: MeshPeer;
  readonly off: Unsubscribe;
}

export class GroupSession {
  readonly events = new TypedEmitter<GroupEvents>();

  private state: GroupSnapshot | null = null;
  private readonly neighbours = new Map<string, Neighbour>();
  private readonly seen: SeenSet;
  private readonly log: Logger;
  private disposed = false;

  /** Developer-mode counters. Every one of them is a rule a peer can trip. */
  packetsRelayed = 0;
  packetsDelivered = 0;
  packetsDropped = 0;
  malformedPackets = 0;
  sendFailures = 0;

  constructor(private readonly options: GroupSessionOptions) {
    if (!isMeshId(options.localPeerId, MESH_LIMITS.maxPeerIdLength)) {
      throw new MeshError(`GroupSession: "${options.localPeerId}" is not a valid peer id`);
    }
    this.log = (options.logger ?? silentLogger).child(`mesh:${options.localPeerId}`);
    this.seen = new SeenSet(
      options.clock,
      options.seenCapacity ?? MESH_LIMITS.seenCapacity,
      options.seenTtlMs ?? MESH_LIMITS.seenTtlMs,
    );
  }

  // -- identity and state ----------------------------------------------------

  get localPeerId(): string {
    return this.options.localPeerId;
  }

  /** The current group, or null if this device is not in one. */
  get snapshot(): GroupSnapshot | null {
    return this.state;
  }

  get groupId(): string | null {
    return this.state?.groupId ?? null;
  }

  get hostId(): string | null {
    return this.state?.hostId ?? null;
  }

  get isHost(): boolean {
    return this.state !== null && this.state.hostId === this.options.localPeerId;
  }

  /**
   * False when the designated host is no longer in the member list - it walked
   * out of range or left. This is the condition an automatic host migration
   * would watch; today the app watches it and calls `promoteHost`.
   */
  get hostPresent(): boolean {
    const state = this.state;
    return state !== null && state.members.some((m) => m.peerId === state.hostId);
  }

  get members(): readonly GroupMember[] {
    return this.state?.members ?? [];
  }

  isMember(peerId: string): boolean {
    return this.state !== null && this.state.members.some((m) => m.peerId === peerId);
  }

  /** Member ids we currently hold a direct session to. */
  get reachableMembers(): readonly string[] {
    const out: string[] = [];
    for (const id of this.neighbours.keys()) if (this.isMember(id)) out.push(id);
    return out;
  }

  /** Every id we hold a session to, member or not. */
  get attachedPeers(): readonly string[] {
    return [...this.neighbours.keys()];
  }

  // -- neighbours ------------------------------------------------------------

  /**
   * Register an authenticated session with a directly reachable peer.
   *
   * The mesh identity IS the cryptographic identity: if the session knows its
   * peer id, it must match the one supplied here. Letting the two differ would
   * mean a peer could be relayed for under a name it never proved.
   */
  attach(peerId: string, peer: MeshPeer): Unsubscribe {
    this.assertUsable();
    if (!isMeshId(peerId, MESH_LIMITS.maxPeerIdLength)) {
      throw new MeshError(`attach: "${peerId}" is not a valid peer id`);
    }
    if (peerId === this.options.localPeerId) throw new MeshError('attach: cannot attach a session to ourselves');
    if (peer.peerId !== null && peer.peerId !== peerId) {
      throw new MeshError(`attach: session is authenticated as ${peer.peerId}, not ${peerId}`);
    }
    // Re-attaching replaces: a reconnect hands us a new session for the same
    // peer, and two live subscriptions would deliver everything twice.
    this.detach(peerId);

    const off = peer.events.on('message', (message) => this.handleMessage(peerId, message));
    const neighbour: Neighbour = { peer, off };
    this.neighbours.set(peerId, neighbour);
    // Identity-checked, so a stale unsubscribe from a previous session cannot
    // tear down the reconnection that replaced it.
    return () => {
      if (this.neighbours.get(peerId) === neighbour) this.detach(peerId);
    };
  }

  /** Forget a neighbour. Does not touch group membership - that is separate. */
  detach(peerId: string): void {
    const existing = this.neighbours.get(peerId);
    if (!existing) return;
    existing.off();
    this.neighbours.delete(peerId);
  }

  // -- group lifecycle -------------------------------------------------------

  /**
   * Create a group with this device as host and sole member.
   * The group id is random, never derived from a name or an identity.
   */
  create(name: string, groupId?: string): GroupSnapshot {
    this.assertUsable();
    if (groupId !== undefined && !isMeshId(groupId, MESH_LIMITS.maxGroupIdLength)) {
      throw new MeshError(`create: "${groupId}" is not a valid group id`);
    }
    const now = this.options.clock.wallNow();
    const snapshot: GroupSnapshot = {
      groupId: groupId ?? toHex(this.options.random.randomBytes(8)),
      name: name.slice(0, MESH_LIMITS.maxGroupNameLength),
      hostId: this.options.localPeerId,
      epoch: 1,
      members: [
        {
          peerId: this.options.localPeerId,
          displayName: this.options.localDisplayName ?? '',
          joinedAt: now,
        },
      ],
      updatedAt: now,
    };
    this.state = snapshot;
    this.events.emit('stateChanged', { snapshot, reason: 'created' });
    // Nothing goes on the wire: a group of one has nobody to tell. The
    // invitation is GROUP_CREATE, and `addMember` is what sends it.
    return snapshot;
  }

  /**
   * Adopt a group state handed to us out of band - a QR code, or a GROUP_CREATE
   * from the host. Replaces any group we were in.
   */
  adopt(snapshot: GroupSnapshot): void {
    this.assertUsable();
    if (snapshot.members.length > MESH_LIMITS.maxMembers) throw new MeshError('adopt: too many members');
    this.state = snapshot;
    this.seen.clear();
    this.events.emit('stateChanged', { snapshot, reason: 'adopted' });
  }

  /**
   * Announce ourselves to the group. Neighbours add us and, if one of them is
   * the host, it bumps the epoch and re-broadcasts the authoritative state.
   */
  announceSelf(): void {
    const state = this.requireGroup();
    const member: GroupMember = {
      peerId: this.options.localPeerId,
      displayName: this.options.localDisplayName ?? '',
      joinedAt: this.options.clock.wallNow(),
    };
    this.applyJoin(member);
    this.sendToAll(MessageType.GROUP_MEMBER_JOIN, encodeMemberJoin({ groupId: state.groupId, member }), null);
  }

  /** Tell the group we are going. Local state is left intact for the UI to show. */
  leave(reason = 'left'): void {
    const state = this.requireGroup();
    this.sendToAll(
      MessageType.GROUP_MEMBER_LEAVE,
      encodeMemberLeave({ groupId: state.groupId, peerId: this.options.localPeerId, reason }),
      null,
    );
  }

  /** Ask a neighbour (or every neighbour) for their view of the group. */
  requestState(peerId?: string): void {
    const state = this.requireGroup();
    const payload = encodeStateRequest(state.groupId);
    if (peerId === undefined) {
      this.sendToAll(MessageType.GROUP_STATE_REQUEST, payload, null);
      return;
    }
    const neighbour = this.neighbours.get(peerId);
    if (!neighbour) throw new MeshError(`requestState: ${peerId} is not attached`);
    this.sendCbor(peerId, neighbour.peer, MessageType.GROUP_STATE_REQUEST, payload);
  }

  /** Add a member locally and, when we are the host, make it authoritative. */
  addMember(member: GroupMember): void {
    const state = this.requireGroup();
    if (!isMeshId(member.peerId, MESH_LIMITS.maxPeerIdLength)) throw new MeshError('addMember: invalid peer id');
    if (this.isMember(member.peerId)) return;
    if (state.members.length >= MESH_LIMITS.maxMembers) {
      throw new MeshError(`addMember: the group already has ${MESH_LIMITS.maxMembers} members`);
    }
    this.applyJoin(member);
    // Two different messages, because the two audiences need different things.
    // The new member has no group at all, so it needs the whole state -
    // GROUP_CREATE *is* the invitation. Everybody else has the group already
    // and needs one line of news.
    this.sendCborTo(member.peerId, MessageType.GROUP_CREATE, encodeGroupSnapshot(this.state ?? state));
    this.sendToAll(
      MessageType.GROUP_MEMBER_JOIN,
      encodeMemberJoin({ groupId: state.groupId, member }),
      member.peerId,
    );
    // The host turns the addition into a numbered state, which is what heals a
    // member that was out of range while all this happened.
    if (this.isHost) this.bumpAndGossip('member added');
  }

  /** Remove a member locally and tell the group. */
  removeMember(peerId: string, reason = 'removed'): void {
    const state = this.requireGroup();
    if (!this.isMember(peerId)) return;
    this.applyLeave(peerId, reason);
    this.sendToAll(MessageType.GROUP_MEMBER_LEAVE, encodeMemberLeave({ groupId: state.groupId, peerId, reason }), null);
  }

  // -- host migration --------------------------------------------------------

  /**
   * Move the host role to another member.
   *
   * This is deliberately explicit and deliberately dumb: it changes one field,
   * bumps the epoch, and gossips the result. It works because every member
   * already holds the whole state - the member list, its order, the group name
   * and the epoch - so there is nothing for a new host to be handed. That is
   * the "migration readiness" this module is built for.
   *
   * AUTOMATIC migration is NOT implemented, and the two things it would need are
   * both consensus problems, not code problems:
   *
   *  1. AGREEMENT ON WHO GOES NEXT. The obvious rule - the earliest remaining
   *     member in `members`, which is join order and identical on every device -
   *     is already available here, and `compareSnapshots` already makes two
   *     simultaneous promotions converge to one answer. What is missing is the
   *     confidence that everyone is looking at the same member list at the same
   *     moment; a member who was out of range for the last two joins would pick
   *     a different successor, and then two hosts would each be gossiping a
   *     higher epoch at each other.
   *  2. DETECTING HOST LOSS WITHOUT SPLIT-BRAIN. A phone in a pocket is
   *     indistinguishable from a phone that left, and on BLE that ambiguity
   *     lasts tens of seconds. If half the room decides the host is gone while
   *     the other half still has a live session to it, both halves are right
   *     about their own view and the group splits into two that will not
   *     re-merge cleanly - each will have advanced its own epoch. A real
   *     implementation needs a quorum ("a majority of the last-known member list
   *     agrees it cannot reach the host") plus a grace period longer than the
   *     BLE reconnect window, and it must refuse to promote at all when it
   *     cannot reach a majority - staying host-less is recoverable, splitting is
   *     not.
   *
   * Until that exists, the app calls this after telling the user what happened.
   */
  promoteHost(peerId: string): GroupSnapshot {
    const state = this.requireGroup();
    if (!this.isMember(peerId)) throw new MeshError(`promoteHost: ${peerId} is not a member of this group`);
    if (state.hostId === peerId) return state;

    const from = state.hostId;
    const next: GroupSnapshot = {
      ...state,
      hostId: peerId,
      epoch: this.bumpEpoch(state.epoch),
      updatedAt: this.options.clock.wallNow(),
    };
    this.state = next;
    this.events.emit('hostChanged', { from, to: peerId });
    this.events.emit('stateChanged', { snapshot: next, reason: 'host promoted' });
    this.gossipState(null);
    return next;
  }

  // -- sending ---------------------------------------------------------------

  /**
   * Send to one member, directly if we can reach them and through a relay if we
   * cannot. Returns false when there was nobody to hand it to.
   */
  sendTo(destinationId: string, messageType: number, payload: Uint8Array, options: SendOptions = {}): boolean {
    const state = this.requireGroup();
    if (destinationId === this.options.localPeerId) throw new MeshError('sendTo: cannot address ourselves');
    if (!this.isMember(destinationId)) throw new MeshError(`sendTo: ${destinationId} is not a member of this group`);

    const packet = this.buildPacket(state.groupId, destinationId, messageType, payload, options);
    // Remember our own packet before it leaves. If the mesh loops it back to us
    // through a relay, it is a duplicate, not a new message.
    this.seen.add(seenKey(packet.originId, packet.messageId));

    // Directly reachable: one hop, no flood. This is the common case in a room
    // where most people can hear most people.
    if (this.neighbours.has(destinationId)) {
      return this.sendPacket(destinationId, packet);
    }
    return this.floodPacket(packet, null) > 0;
  }

  /**
   * Send to every member: directly to the ones we can reach, and through them to
   * the ones we cannot. One packet id for the whole broadcast, so a member who
   * can hear us two ways still delivers it exactly once.
   *
   * Returns the number of neighbours the packet was handed to.
   */
  broadcast(messageType: number, payload: Uint8Array, options: SendOptions = {}): number {
    const state = this.requireGroup();
    const packet = this.buildPacket(state.groupId, '', messageType, payload, options);
    this.seen.add(seenKey(packet.originId, packet.messageId));
    return this.floodPacket(packet, null);
  }

  // -- diagnostics -----------------------------------------------------------

  diagnostics(): Record<string, unknown> {
    return {
      localPeerId: this.options.localPeerId,
      groupId: this.groupId,
      hostId: this.hostId,
      isHost: this.isHost,
      hostPresent: this.hostPresent,
      epoch: this.state?.epoch ?? null,
      memberCount: this.members.length,
      attachedPeers: this.attachedPeers,
      reachableMembers: this.reachableMembers,
      seenEntries: this.seen.size,
      packetsRelayed: this.packetsRelayed,
      packetsDelivered: this.packetsDelivered,
      packetsDropped: this.packetsDropped,
      malformedPackets: this.malformedPackets,
      sendFailures: this.sendFailures,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, neighbour] of this.neighbours) neighbour.off();
    this.neighbours.clear();
    this.seen.clear();
    this.events.removeAllListeners();
  }

  // -- inbound ---------------------------------------------------------------

  private handleMessage(via: string, message: IncomingMessage): void {
    if (this.disposed) return;
    try {
      switch (message.type) {
        case MessageType.GROUP_CREATE:
        case MessageType.GROUP_UPDATE:
        case MessageType.GROUP_STATE_RESPONSE:
          this.onSnapshot(via, message.value);
          return;
        case MessageType.GROUP_MEMBER_JOIN:
          this.onJoin(via, message.value);
          return;
        case MessageType.GROUP_MEMBER_LEAVE:
          this.onLeave(via, message.value);
          return;
        case MessageType.GROUP_STATE_REQUEST:
          this.onStateRequest(via, message.value);
          return;
        case MessageType.GROUP_RELAY:
          this.onRelay(via, message);
          return;
        default:
          // Not ours. Another feature module owns this message type.
          return;
      }
    } catch (err) {
      if (err instanceof DecodeError) {
        this.malformedPackets++;
        this.drop(MeshDropReason.MALFORMED, via, err.message);
        return;
      }
      // Anything else is a bug on this side. Contain it - one bad packet must
      // never take the mesh down - but make it loud in the log.
      this.log.error('unexpected error handling a group message', { via, err: String(err) });
    }
  }

  private onSnapshot(via: string, value: CborValue | null): void {
    const incoming = decodeGroupSnapshot(value);
    const current = this.state;

    if (!current) {
      // No group yet: this is an invitation. We accept it only if we are named
      // in it, so a stranger cannot drop us into a group we never agreed to.
      if (!incoming.members.some((m) => m.peerId === this.options.localPeerId)) {
        this.drop(MeshDropReason.NO_GROUP, via, 'invited to a group we are not a member of');
        return;
      }
      // ...and the inviter has to be in it too. Otherwise any peer we happen to
      // have a session with could hand us a roster it has nothing to do with.
      if (!incoming.members.some((m) => m.peerId === via)) {
        this.drop(MeshDropReason.RELAY_NOT_MEMBER, via, 'invitation from outside the group');
        return;
      }
      this.state = incoming;
      this.events.emit('stateChanged', { snapshot: incoming, reason: `adopted from ${via}` });
      this.gossipState(via);
      return;
    }

    if (incoming.groupId !== current.groupId) {
      this.drop(MeshDropReason.WRONG_GROUP, via);
      return;
    }
    // Only a current member may change the group's state. There is no signed
    // membership record in this build, so "a member said so" is the strongest
    // statement available - a signed roster from the host is what would let a
    // device verify a state change it did not witness.
    if (!this.isMember(via)) {
      this.drop(MeshDropReason.RELAY_NOT_MEMBER, via, 'state update from a non-member');
      return;
    }

    const order = compareSnapshots(incoming, current);
    if (order > 0) {
      const hostChanged = incoming.hostId !== current.hostId;
      this.state = incoming;
      if (hostChanged) this.events.emit('hostChanged', { from: current.hostId, to: incoming.hostId });
      this.events.emit('stateChanged', { snapshot: incoming, reason: `update from ${via}` });
      this.diffMembers(current, incoming);
      // Gossip only on change. That is what makes the epidemic terminate: the
      // second copy of a snapshot no longer wins, so it is not passed on.
      this.gossipState(via);
      return;
    }
    if (order < 0) {
      // They are behind. Answer with what we have; because our state strictly
      // wins, they will accept it and will not answer back.
      this.sendCborTo(via, MessageType.GROUP_STATE_RESPONSE, encodeGroupSnapshot(current));
    }
  }

  private onJoin(via: string, value: CborValue | null): void {
    const signal = decodeMemberJoin(value);
    const state = this.state;
    if (!state) {
      this.drop(MeshDropReason.NO_GROUP, via);
      return;
    }
    if (signal.groupId !== state.groupId) {
      this.drop(MeshDropReason.WRONG_GROUP, via);
      return;
    }
    // Either the peer is announcing itself, or a member is repeating an
    // announcement it heard. Both are how a join crosses a room; a stranger
    // repeating one is not.
    if (via !== signal.member.peerId && !this.isMember(via)) {
      this.drop(MeshDropReason.RELAY_NOT_MEMBER, via, 'join announced by a non-member');
      return;
    }
    if (this.isMember(signal.member.peerId)) return; // already known: no change, no gossip
    if (state.members.length >= MESH_LIMITS.maxMembers) {
      this.drop(MeshDropReason.DESTINATION_NOT_MEMBER, via, 'group is full');
      return;
    }

    this.applyJoin(signal.member);
    // Pass it on so the far end of a line hears about it too. Terminates
    // because a repeat finds the member already present and returns above.
    this.sendToAll(MessageType.GROUP_MEMBER_JOIN, encodeMemberJoin(signal), via);
    // The host is the authority: it turns an announcement into a numbered state
    // that heals anyone who missed the gossip.
    if (this.isHost) {
      this.bumpAndGossip('member joined');
    }
  }

  private onLeave(via: string, value: CborValue | null): void {
    const signal = decodeMemberLeave(value);
    const state = this.state;
    if (!state) {
      this.drop(MeshDropReason.NO_GROUP, via);
      return;
    }
    if (signal.groupId !== state.groupId) {
      this.drop(MeshDropReason.WRONG_GROUP, via);
      return;
    }
    if (via !== signal.peerId && !this.isMember(via)) {
      this.drop(MeshDropReason.RELAY_NOT_MEMBER, via, 'departure announced by a non-member');
      return;
    }
    if (!this.isMember(signal.peerId)) return; // already gone: no change, no gossip

    this.applyLeave(signal.peerId, signal.reason);
    this.sendToAll(MessageType.GROUP_MEMBER_LEAVE, encodeMemberLeave(signal), via);
    if (this.isHost) this.bumpAndGossip('member left');
  }

  private onStateRequest(via: string, value: CborValue | null): void {
    const groupId = decodeStateRequest(value);
    const state = this.state;
    if (!state || state.groupId !== groupId) {
      this.drop(MeshDropReason.WRONG_GROUP, via);
      return;
    }
    if (!this.isMember(via)) {
      this.drop(MeshDropReason.RELAY_NOT_MEMBER, via, 'state requested by a non-member');
      return;
    }
    this.sendCborTo(via, MessageType.GROUP_STATE_RESPONSE, encodeGroupSnapshot(state));
  }

  /**
   * The relay path. Every early return here is a rule, and every rule exists
   * because the packet arrived from somewhere we do not control.
   */
  private onRelay(via: string, message: IncomingMessage): void {
    const state = this.state;
    if (!state) {
      this.drop(MeshDropReason.NO_GROUP, via);
      return;
    }
    // Raw payload: the routing header is binary, not CBOR. A DecodeError here
    // is caught by handleMessage and counted as malformed.
    const packet = decodeRelayPacket(message.raw);

    if (packet.groupId !== state.groupId) {
      this.drop(MeshDropReason.WRONG_GROUP, via);
      return;
    }
    // We do not carry packets for people who are not in the group - not as the
    // link peer that handed it over, and not as the claimed original sender.
    if (!this.isMember(via)) {
      this.drop(MeshDropReason.RELAY_NOT_MEMBER, via);
      return;
    }
    if (!this.isMember(packet.originId)) {
      this.drop(MeshDropReason.ORIGIN_NOT_MEMBER, via, packet.originId);
      return;
    }
    if (packet.originId === this.options.localPeerId) {
      // Our own packet, back around a cycle. The seen-set would catch it too;
      // this is the cheaper and clearer check.
      this.drop(MeshDropReason.OWN_PACKET, via);
      return;
    }
    if (packet.destinationId !== '' && !this.isMember(packet.destinationId)) {
      this.drop(MeshDropReason.DESTINATION_NOT_MEMBER, via, packet.destinationId);
      return;
    }
    // Test-and-set in one step: this is the loop breaker and the deduplicator.
    if (this.seen.add(seenKey(packet.originId, packet.messageId))) {
      this.drop(MeshDropReason.DUPLICATE, via, packet.messageId);
      return;
    }

    const relayed = packet.originId !== via;

    if (packet.destinationId === this.options.localPeerId) {
      // Addressed to us. It stops here - forwarding a packet that has arrived
      // would be pure amplification.
      this.deliver(packet, via, relayed);
      return;
    }
    if (packet.destinationId === '') {
      this.deliver(packet, via, relayed);
      // ...and keep the broadcast moving outward.
    }

    const hopsRemaining = packet.hops - 1;
    if (hopsRemaining < 1) {
      this.drop(MeshDropReason.HOP_LIMIT, via, packet.messageId);
      return;
    }
    const forwarded: RelayPacket = { ...packet, hops: hopsRemaining };
    const targets = this.forwardTargets(forwarded, via);
    const delivered: string[] = [];
    for (const id of targets) if (this.sendPacket(id, forwarded)) delivered.push(id);
    if (delivered.length > 0) {
      this.packetsRelayed++;
      this.events.emit('relayed', {
        messageId: packet.messageId,
        origin: packet.originId,
        destination: packet.destinationId === '' ? null : packet.destinationId,
        hopsRemaining,
        to: delivered,
      });
    }
  }

  private deliver(packet: RelayPacket, via: string, relayed: boolean): void {
    this.packetsDelivered++;
    // The envelope's own senderId is preferred when the session supplies one;
    // today it never does on this path (see the note in codec.ts), so the
    // header's originId is what identifies the sender. Both are claims made by
    // the link peer and neither is a signature - within a group, membership is
    // the trust boundary.
    this.events.emit('message', {
      groupId: packet.groupId,
      from: packet.originId,
      via,
      type: packet.innerType,
      payload: packet.payload,
      broadcast: packet.destinationId === '',
      hopsRemaining: packet.hops,
      relayed,
      // A relay in the path read this payload, unless the sender sealed it
      // itself. Never claim otherwise.
      endToEnd: !relayed || (packet.flags & RelayFlags.END_TO_END_SEALED) !== 0,
    });
  }

  // -- state mutation --------------------------------------------------------

  private applyJoin(member: GroupMember): void {
    const state = this.state;
    if (!state || state.members.some((m) => m.peerId === member.peerId)) return;
    const next: GroupSnapshot = {
      ...state,
      members: [...state.members, member],
      updatedAt: this.options.clock.wallNow(),
    };
    this.state = next;
    this.events.emit('memberJoined', { member });
    this.events.emit('stateChanged', { snapshot: next, reason: 'member joined' });
  }

  private applyLeave(peerId: string, reason: string): void {
    const state = this.state;
    if (!state || !state.members.some((m) => m.peerId === peerId)) return;
    const next: GroupSnapshot = {
      ...state,
      members: state.members.filter((m) => m.peerId !== peerId),
      updatedAt: this.options.clock.wallNow(),
    };
    this.state = next;
    this.events.emit('memberLeft', { peerId, reason });
    this.events.emit('stateChanged', { snapshot: next, reason: 'member left' });
    // The host walking out is the interesting case, and the one this module
    // refuses to resolve by itself. `hostId` deliberately still names the peer
    // that left, so every member agrees on what was lost and `promoteHost` has
    // a definite "from".
    if (next.hostId === peerId) this.events.emit('hostLost', { hostId: peerId });
  }

  /** Report joins and leaves implied by adopting a whole new snapshot. */
  private diffMembers(before: GroupSnapshot, after: GroupSnapshot): void {
    const had = new Set(before.members.map((m) => m.peerId));
    const has = new Set(after.members.map((m) => m.peerId));
    for (const member of after.members) if (!had.has(member.peerId)) this.events.emit('memberJoined', { member });
    for (const member of before.members) {
      if (!has.has(member.peerId)) this.events.emit('memberLeft', { peerId: member.peerId, reason: 'state update' });
    }
    // Only on the transition. A group that has been host-less for a minute must
    // not re-announce the fact on every gossip that passes through.
    if (!has.has(after.hostId) && had.has(before.hostId) && before.hostId === after.hostId) {
      this.events.emit('hostLost', { hostId: after.hostId });
    }
  }

  /**
   * Advance the epoch.
   *
   * Saturating rather than wrapping. A wrap would break the total order that
   * `compareSnapshots` depends on, and a throw would let a peer that sent us a
   * maximal epoch disable our own API. At the ceiling the ordering falls back to
   * the host and member tie-breaks, which are still total - convergence
   * survives, only the "later decision wins" signal is lost, four billion
   * changes into a group that holds at most eight people.
   */
  private bumpEpoch(epoch: number): number {
    return epoch >= MAX_GROUP_EPOCH ? MAX_GROUP_EPOCH : epoch + 1;
  }

  private bumpAndGossip(reason: string): void {
    const state = this.state;
    if (!state) return;
    const next: GroupSnapshot = {
      ...state,
      epoch: this.bumpEpoch(state.epoch),
      updatedAt: this.options.clock.wallNow(),
    };
    this.state = next;
    this.events.emit('stateChanged', { snapshot: next, reason });
    this.gossipState(null);
  }

  private gossipState(except: string | null): void {
    const state = this.state;
    if (!state) return;
    this.sendToAll(MessageType.GROUP_UPDATE, encodeGroupSnapshot(state), except);
  }

  // -- outbound plumbing -----------------------------------------------------

  private buildPacket(
    groupId: string,
    destinationId: string,
    messageType: number,
    payload: Uint8Array,
    options: SendOptions,
  ): RelayPacket {
    if (payload.length > MESH_LIMITS.maxRelayPayloadBytes) {
      throw new MeshError(`payload of ${payload.length} bytes exceeds the relay limit`);
    }
    if (messageType === MessageType.GROUP_RELAY) throw new MeshError('cannot relay a relay packet');
    const requested = options.hops ?? this.options.defaultHops ?? MESH_LIMITS.defaultHops;
    const hops = Math.max(1, Math.min(MESH_LIMITS.maxHops, Math.floor(requested)));
    return {
      groupId,
      originId: this.options.localPeerId,
      destinationId,
      messageId: toHex(this.options.random.randomBytes(8)),
      hops,
      flags: options.endToEndSealed === true ? RelayFlags.END_TO_END_SEALED : RelayFlags.NONE,
      innerType: messageType,
      payload,
    };
  }

  /**
   * Who a packet goes to next.
   *
   * A unicast whose destination we can reach directly goes only there. Anything
   * else floods to every member we can reach, minus the neighbour it came from
   * (it already has it) and minus the origin (it wrote it).
   */
  private forwardTargets(packet: RelayPacket, except: string | null): string[] {
    if (packet.destinationId !== '' && this.neighbours.has(packet.destinationId)) {
      return packet.destinationId === except ? [] : [packet.destinationId];
    }
    const out: string[] = [];
    for (const id of this.neighbours.keys()) {
      if (id === except || id === packet.originId || id === this.options.localPeerId) continue;
      if (!this.isMember(id)) continue; // never relay to a non-member
      out.push(id);
    }
    return out;
  }

  private floodPacket(packet: RelayPacket, except: string | null): number {
    let sent = 0;
    for (const id of this.forwardTargets(packet, except)) {
      if (this.sendPacket(id, packet)) sent++;
    }
    return sent;
  }

  private sendPacket(peerId: string, packet: RelayPacket): boolean {
    const neighbour = this.neighbours.get(peerId);
    if (!neighbour) return false;
    let bytes: Uint8Array;
    try {
      bytes = encodeRelayPacket(packet);
    } catch (err) {
      // Encoding our own packet can only fail because of a bug on this side.
      this.sendFailures++;
      this.log.error('failed to encode a relay packet', { to: peerId, err: String(err) });
      return false;
    }
    try {
      neighbour.peer.sendReliableRaw(MessageType.GROUP_RELAY, bytes);
      return true;
    } catch (err) {
      // A session can refuse: closed, or still waiting on a pairing code. One
      // dead neighbour must not abort a broadcast to the other five.
      this.sendFailures++;
      this.log.debug('relay send refused by the session', { to: peerId, err: String(err) });
      return false;
    }
  }

  private sendToAll(messageType: number, value: CborValue, except: string | null): void {
    for (const [id, neighbour] of this.neighbours) {
      if (id === except) continue;
      this.sendCbor(id, neighbour.peer, messageType, value);
    }
  }

  private sendCborTo(peerId: string, messageType: number, value: CborValue): void {
    const neighbour = this.neighbours.get(peerId);
    if (!neighbour) return;
    this.sendCbor(peerId, neighbour.peer, messageType, value);
  }

  private sendCbor(peerId: string, peer: MeshPeer, messageType: number, value: CborValue): void {
    try {
      peer.sendReliable(messageType, value);
    } catch (err) {
      this.sendFailures++;
      this.log.debug('group control send refused by the session', { to: peerId, err: String(err) });
    }
  }

  private drop(reason: MeshDropReason, via: string, detail?: string): void {
    this.packetsDropped++;
    this.events.emit('dropped', detail !== undefined ? { reason, via, detail } : { reason, via });
  }

  private requireGroup(): GroupSnapshot {
    this.assertUsable();
    if (!this.state) throw new MeshError('no group: call create() or adopt() first');
    return this.state;
  }

  private assertUsable(): void {
    if (this.disposed) throw new MeshError('GroupSession has been disposed');
  }
}
