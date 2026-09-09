/**
 * Groups and mesh routing.
 *
 * `GroupSession` is the whole public surface most callers need: attach an
 * authenticated PeerSession per neighbour, create or adopt a group, and send.
 * The codec and the seen-set are exported because they are pure and worth
 * testing - and reusing - on their own.
 */
export {
  MESH_LIMITS,
  MAX_GROUP_EPOCH,
  RELAY_WIRE_VERSION,
  MeshError,
  isMeshId,
  meshId,
  meshInt,
  meshText,
} from './constants.js';

export {
  MeshDropReason,
  RelayFlags,
  type GroupEvents,
  type GroupMember,
  type GroupMessageEvent,
  type GroupSnapshot,
  type RelayPacket,
} from './types.js';

export {
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
  type MemberJoinSignal,
  type MemberLeaveSignal,
} from './codec.js';

export { SeenSet, seenKey } from './seenSet.js';

export {
  GroupSession,
  type GroupSessionOptions,
  type MeshPeer,
  type SendOptions,
} from './groupSession.js';
