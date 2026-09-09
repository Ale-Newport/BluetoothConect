/**
 * Capability exchange.
 *
 * Two AirLink builds may differ in version, platform, available radios, feature
 * set and installed games. Peers exchange this record inside the encrypted part
 * of the handshake, and every feature gate in the app reads from it. A peer that
 * does not advertise a capability is never sent traffic for it.
 */
import type { CborValue } from './cbor.js';
import { DecodeError } from '../util/varint.js';

export const TransportKind = {
  /** In-process transport used by tests and the simulator. */
  MOCK: 'mock',
  /** Bluetooth Low Energy GATT. The universal cross-platform fallback. */
  BLE: 'ble',
  /** TCP over an existing local network (Bonjour on iOS, NSD on Android). */
  LOCAL_NETWORK: 'localNetwork',
  /** Apple peer-to-peer Wi-Fi via Network.framework (iOS to iOS only). */
  PEER_TO_PEER_WIFI: 'peerToPeerWifi',
  /** Android Wi-Fi Direct (Android to Android only). */
  WIFI_DIRECT: 'wifiDirect',
  /** Wi-Fi Aware / NAN. */
  WIFI_AWARE: 'wifiAware',
} as const;
export type TransportKind = (typeof TransportKind)[keyof typeof TransportKind];

export const ALL_TRANSPORT_KINDS: readonly TransportKind[] = [
  TransportKind.MOCK,
  TransportKind.BLE,
  TransportKind.LOCAL_NETWORK,
  TransportKind.PEER_TO_PEER_WIFI,
  TransportKind.WIFI_DIRECT,
  TransportKind.WIFI_AWARE,
];

export function isTransportKind(value: unknown): value is TransportKind {
  return typeof value === 'string' && (ALL_TRANSPORT_KINDS as readonly string[]).includes(value);
}

export const Feature = {
  CHAT: 'chat',
  REACTIONS: 'reactions',
  TYPING: 'typing',
  RECEIPTS: 'receipts',
  FILES: 'files',
  VOICE_NOTES: 'voiceNotes',
  GAMES: 'games',
  SYNC: 'sync',
  GROUPS: 'groups',
  TRANSPORT_UPGRADE: 'transportUpgrade',
} as const;
export type Feature = (typeof Feature)[keyof typeof Feature];

export const Platform = {
  IOS: 'ios',
  ANDROID: 'android',
  NODE: 'node',
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export interface PeerCapabilities {
  readonly protocolVersion: number;
  readonly appVersion: string;
  readonly platform: string;
  /** Free-form model string, shown only in Developer Mode. */
  readonly deviceModel: string;
  readonly displayName: string;
  readonly deviceId: string;
  readonly transports: readonly TransportKind[];
  readonly features: readonly string[];
  /** Game ids the peer can actually play, with the game protocol version. */
  readonly games: readonly GameCapability[];
  /** Largest single application payload the peer will accept, in bytes. */
  readonly maxPayloadBytes: number;
}

export interface GameCapability {
  readonly id: string;
  readonly version: number;
}

const MAX_LIST = 128;
const MAX_STRING = 128;

function str(value: CborValue, field: string, maxLength = MAX_STRING): string {
  if (typeof value !== 'string') throw new DecodeError(`capabilities: ${field} must be a string`);
  if (value.length > maxLength) throw new DecodeError(`capabilities: ${field} exceeds ${maxLength} characters`);
  return value;
}

function int(value: CborValue, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DecodeError(`capabilities: ${field} must be an integer`);
  }
  if (value < min || value > max) throw new DecodeError(`capabilities: ${field} out of range`);
  return value;
}

function list(value: CborValue, field: string): CborValue[] {
  if (!Array.isArray(value)) throw new DecodeError(`capabilities: ${field} must be an array`);
  if (value.length > MAX_LIST) throw new DecodeError(`capabilities: ${field} has too many entries`);
  return value;
}

export function encodeCapabilities(caps: PeerCapabilities): CborValue {
  return {
    pv: caps.protocolVersion,
    av: caps.appVersion,
    pl: caps.platform,
    dm: caps.deviceModel,
    dn: caps.displayName,
    di: caps.deviceId,
    tr: [...caps.transports],
    ft: [...caps.features],
    gm: caps.games.map((g) => [g.id, g.version] as CborValue),
    mp: caps.maxPayloadBytes,
  };
}

/** Parse a peer-supplied capability record. Every field is bounded and validated. */
export function decodeCapabilities(value: CborValue): PeerCapabilities {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new DecodeError('capabilities: expected a map');
  }
  const m = value as Record<string, CborValue>;

  const transports: TransportKind[] = [];
  for (const t of list(m.tr ?? [], 'transports')) {
    if (isTransportKind(t)) transports.push(t);
    // Unknown transport names are ignored rather than fatal: a newer peer may
    // advertise a radio this build has never heard of.
  }

  const features: string[] = [];
  for (const f of list(m.ft ?? [], 'features')) features.push(str(f, 'feature', 64));

  const games: GameCapability[] = [];
  for (const g of list(m.gm ?? [], 'games')) {
    if (!Array.isArray(g) || g.length !== 2) throw new DecodeError('capabilities: malformed game entry');
    games.push({ id: str(g[0] as CborValue, 'game id', 48), version: int(g[1] as CborValue, 'game version', 0, 65535) });
  }

  return {
    protocolVersion: int(m.pv ?? 0, 'protocolVersion', 0, 65535),
    appVersion: str(m.av ?? '', 'appVersion', 32),
    platform: str(m.pl ?? '', 'platform', 32),
    deviceModel: str(m.dm ?? '', 'deviceModel', 64),
    displayName: str(m.dn ?? '', 'displayName', 64),
    deviceId: str(m.di ?? '', 'deviceId', 64),
    transports,
    features,
    games,
    maxPayloadBytes: int(m.mp ?? 65536, 'maxPayloadBytes', 256, 16 * 1024 * 1024),
  };
}

/** Features both sides support. */
export function commonFeatures(a: PeerCapabilities, b: PeerCapabilities): string[] {
  const bSet = new Set(b.features);
  return a.features.filter((f) => bSet.has(f));
}

/** Games both sides can play, at a game-protocol version both understand. */
export function commonGames(a: PeerCapabilities, b: PeerCapabilities): GameCapability[] {
  const bMap = new Map(b.games.map((g) => [g.id, g.version]));
  const out: GameCapability[] = [];
  for (const g of a.games) {
    const theirs = bMap.get(g.id);
    if (theirs === undefined) continue;
    // Both sides must run the same game protocol major version.
    if (theirs !== g.version) continue;
    out.push(g);
  }
  return out;
}

/** Transports both sides can attempt. */
export function commonTransports(a: PeerCapabilities, b: PeerCapabilities): TransportKind[] {
  const bSet = new Set(b.transports);
  return a.transports.filter((t) => bSet.has(t));
}
