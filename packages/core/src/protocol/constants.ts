/**
 * AirLink Protocol v1 - wire constants.
 *
 * Changing any value in this file is a wire-breaking change and requires
 * bumping PROTOCOL_VERSION. See docs/PROTOCOL.md.
 */

/** Current protocol version emitted by this build. */
export const PROTOCOL_VERSION = 1;

/** Oldest protocol version this build can still talk to. */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

/**
 * Service identifiers.
 *
 * The BLE service UUID is a fixed random v4 UUID. Both platforms advertise it so
 * a scanner can filter for AirLink peers without decoding manufacturer data -
 * which matters a great deal on iOS, where background scanning REQUIRES an
 * explicit service-UUID filter.
 */
export const BLE_SERVICE_UUID = '8A7F2C10-4E6B-4B6E-9E1D-7C3A5F0B2D41';
/** Peer -> peer data written by the central to the peripheral. */
export const BLE_RX_CHARACTERISTIC_UUID = '8A7F2C11-4E6B-4B6E-9E1D-7C3A5F0B2D41';
/** Peripheral -> central data delivered as notifications. */
export const BLE_TX_CHARACTERISTIC_UUID = '8A7F2C12-4E6B-4B6E-9E1D-7C3A5F0B2D41';
/** Small read-only characteristic exposing the advertising identity record. */
export const BLE_IDENTITY_CHARACTERISTIC_UUID = '8A7F2C13-4E6B-4B6E-9E1D-7C3A5F0B2D41';

/** Bonjour / NSD service type used by the local-network transport. */
export const LOCAL_NETWORK_SERVICE_TYPE = '_airlink._tcp';
/** Wi-Fi Aware service name (Android NAN publish/subscribe). */
export const WIFI_AWARE_SERVICE_NAME = 'airlink-v1';

// ---------------------------------------------------------------------------
// Frame layer
// ---------------------------------------------------------------------------

/** Outer frame kinds. One transport datagram carries exactly one frame. */
export const FrameType = {
  /** Plaintext handshake message. Only valid before a session exists. */
  HANDSHAKE: 0x01,
  /** AEAD-protected application frame. */
  SECURE: 0x02,
  /** A slice of a larger SECURE frame, for transports with a small MTU. */
  FRAGMENT: 0x03,
  /** Plaintext, unauthenticated presence beacon. Carries no private data. */
  BEACON: 0x04,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** Header bytes covered as AEAD associated data on a SECURE frame. */
export const SECURE_HEADER_LENGTH = 1 /* version */ + 1 /* type */ + 8 /* sessionId */ + 8 /* counter */;
export const SESSION_ID_LENGTH = 8;
export const AEAD_TAG_LENGTH = 16;
export const AEAD_KEY_LENGTH = 32;
export const AEAD_NONCE_LENGTH = 12;
/** First 4 bytes of the nonce come from the key schedule, last 8 are the counter. */
export const NONCE_PREFIX_LENGTH = 4;

/** FRAGMENT header: version, type, packetId(u16), index(u16), count(u16). */
export const FRAGMENT_HEADER_LENGTH = 1 + 1 + 2 + 2 + 2;

/** Hard ceiling on a reassembled logical frame. Rejects memory-exhaustion attempts. */
export const MAX_FRAME_BYTES = 256 * 1024;
/** Hard ceiling on fragment count for one logical frame. */
export const MAX_FRAGMENTS = 4096;
/** Reassembly buffers older than this are discarded. */
export const FRAGMENT_REASSEMBLY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * Logical channels multiplexed over one secure session.
 *
 *  CONTROL  - liveness and session management; never retried by the app layer
 *  RELIABLE - guaranteed, ordered, deduplicated, retried across reconnects
 *  REALTIME - best-effort and coalescing; newer state supersedes older
 *  BULK     - reliable but yields to RELIABLE, so a 100 MB file cannot starve chat
 */
export const Channel = {
  CONTROL: 0,
  RELIABLE: 1,
  REALTIME: 2,
  BULK: 3,
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export const ALL_CHANNELS: readonly Channel[] = [Channel.CONTROL, Channel.RELIABLE, Channel.REALTIME, Channel.BULK];

// ---------------------------------------------------------------------------
// Envelope flags
// ---------------------------------------------------------------------------

export const EnvelopeFlags = {
  NONE: 0,
  /** An explicit sender id follows the flags byte (group relay). */
  HAS_SENDER: 1 << 0,
  /** Sender expects an ACK for this sequence number. */
  NEEDS_ACK: 1 << 1,
  /** This is a retransmission of a previously sent sequence number. */
  RETRANSMIT: 1 << 2,
  /** Payload is raw bytes rather than CBOR. */
  RAW_PAYLOAD: 1 << 3,
  /** An explicit destination id follows (group relay). */
  HAS_DESTINATION: 1 << 4,
} as const;

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export const MessageType = {
  // 0x00-0x0F  control and liveness
  PING: 0x01,
  PONG: 0x02,
  ACK: 0x03,
  ERROR: 0x04,
  BYE: 0x05,
  CLOCK_SYNC_REQUEST: 0x06,
  CLOCK_SYNC_RESPONSE: 0x07,
  KEEPALIVE: 0x08,

  // 0x10-0x1F  session, identity, presence
  HELLO: 0x10,
  HELLO_ACK: 0x11,
  CAPABILITIES: 0x12,
  PRESENCE: 0x13,
  PROFILE_UPDATE: 0x14,

  // 0x20-0x2F  messaging
  MESSAGE: 0x20,
  TYPING: 0x21,
  DELIVERY_RECEIPT: 0x22,
  READ_RECEIPT: 0x23,
  REACTION: 0x24,
  MESSAGE_DELETE: 0x25,
  MESSAGE_HISTORY_REQUEST: 0x26,
  MESSAGE_HISTORY_RESPONSE: 0x27,

  // 0x30-0x3F  games
  GAME_INVITE: 0x30,
  GAME_ACCEPT: 0x31,
  GAME_DECLINE: 0x32,
  GAME_STATE: 0x33,
  GAME_EVENT: 0x34,
  GAME_END: 0x35,
  GAME_SYNC_REQUEST: 0x36,
  GAME_INPUT: 0x37,
  GAME_LEAVE: 0x38,

  // 0x40-0x4F  file transfer
  FILE_OFFER: 0x40,
  FILE_ACCEPT: 0x41,
  FILE_DECLINE: 0x42,
  FILE_CHUNK: 0x43,
  FILE_CHUNK_ACK: 0x44,
  FILE_COMPLETE: 0x45,
  FILE_CANCEL: 0x46,
  FILE_RESUME: 0x47,
  FILE_ERROR: 0x48,

  // 0x50-0x5F  content sync (watch together)
  SYNC_CREATE: 0x50,
  SYNC_JOIN: 0x51,
  SYNC_LEAVE: 0x52,
  SYNC_PLAY: 0x53,
  SYNC_PAUSE: 0x54,
  SYNC_SEEK: 0x55,
  SYNC_RATE: 0x56,
  SYNC_HEARTBEAT: 0x57,
  SYNC_CONTENT_QUERY: 0x58,
  SYNC_CONTENT_REPLY: 0x59,
  SYNC_END: 0x5a,

  // 0x60-0x6F  groups and mesh
  GROUP_CREATE: 0x60,
  GROUP_UPDATE: 0x61,
  GROUP_MEMBER_JOIN: 0x62,
  GROUP_MEMBER_LEAVE: 0x63,
  GROUP_RELAY: 0x64,
  GROUP_STATE_REQUEST: 0x65,
  GROUP_STATE_RESPONSE: 0x66,

  // 0x70-0x7F  transport negotiation and upgrade
  TRANSPORT_OFFER: 0x70,
  TRANSPORT_ACCEPT: 0x71,
  TRANSPORT_READY: 0x72,
  TRANSPORT_FAILED: 0x73,
  TRANSPORT_SWITCH: 0x74,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

const MESSAGE_TYPE_NAMES = new Map<number, string>(
  Object.entries(MessageType).map(([name, value]) => [value as number, name]),
);

export function messageTypeName(type: number): string {
  return MESSAGE_TYPE_NAMES.get(type) ?? `UNKNOWN(0x${type.toString(16).padStart(2, '0')})`;
}

export function isKnownMessageType(type: number): type is MessageType {
  return MESSAGE_TYPE_NAMES.has(type);
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ProtocolErrorCode = {
  UNKNOWN: 0,
  UNSUPPORTED_VERSION: 1,
  MALFORMED_PACKET: 2,
  AUTHENTICATION_FAILED: 3,
  REPLAY_DETECTED: 4,
  UNKNOWN_SESSION: 5,
  UNSUPPORTED_MESSAGE: 6,
  RATE_LIMITED: 7,
  BUSY: 8,
  REJECTED_BY_USER: 9,
  INTERNAL: 10,
  FEATURE_UNAVAILABLE: 11,
} as const;
export type ProtocolErrorCode = (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode];

// ---------------------------------------------------------------------------
// Timing defaults
// ---------------------------------------------------------------------------

export const TIMING = {
  /** Interval between keepalive pings on an idle session. */
  keepaliveIntervalMs: 5_000,
  /** No traffic at all for this long means the link is presumed dead. */
  livenessTimeoutMs: 20_000,
  /** Initial retransmit timeout; adapts to measured RTT. */
  initialRetransmitMs: 400,
  minRetransmitMs: 120,
  maxRetransmitMs: 8_000,
  maxRetransmitAttempts: 8,
  /** How long the handshake may take before it is abandoned. */
  handshakeTimeoutMs: 15_000,
  /** How long a pairing confirmation stays valid. */
  pairingTimeoutMs: 120_000,
  /** Reconnect backoff schedule, milliseconds. */
  reconnectBackoffMs: [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000],
  /** Realtime channel send budget. */
  realtimeMaxQueued: 4,
  /** Sliding replay window width, in packets. */
  replayWindowSize: 1024,
  /** Clock-sync probes per round. */
  clockSyncSamples: 7,
  clockSyncIntervalMs: 30_000,
} as const;
