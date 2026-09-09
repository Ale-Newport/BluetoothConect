/**
 * The one boundary between JavaScript and the radios.
 *
 * Everything above this file is platform-agnostic TypeScript; everything below
 * it is Swift or Kotlin that knows about CoreBluetooth, Network.framework, the
 * Android Bluetooth stack and Wi-Fi Direct. The native side holds NO protocol
 * knowledge whatsoever: it discovers endpoints, opens links, and moves opaque
 * datagrams. Encryption, sequencing, retries, fragmentation and every feature
 * live in @airlink/core.
 *
 * Keeping the boundary this thin is what lets the entire protocol be tested in
 * Node against a simulated network, and what makes adding a radio a change to
 * one native file rather than to the app.
 *
 * PAYLOAD ENCODING. Datagrams cross as base64 strings. React Native's codegen
 * has no ArrayBuffer type for TurboModule specs, so a string is the only
 * faithful option, and base64 is the only encoding that survives the JS string
 * boundary without corruption. It costs 33% in size and a copy in each
 * direction - measurable on a Wi-Fi link, irrelevant on Bluetooth, and worth it
 * for a boundary this small. If bulk throughput ever becomes the bottleneck,
 * the replacement is a Nitro module passing ArrayBuffers by reference; the
 * shape of this API would not change.
 */
import type { TurboModule, CodegenTypes } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Transport identifiers. These strings match TransportKind in @airlink/core;
 * codegen cannot express a TypeScript union of string literals in a spec, so
 * they travel as plain strings and are validated on the JS side.
 *
 *   'ble'             Bluetooth Low Energy. Universal, slow, the floor.
 *   'localNetwork'    Bonjour / NSD + TCP over a shared Wi-Fi network.
 *   'peerToPeerWifi'  Apple peer-to-peer Wi-Fi (iOS to iOS only).
 *   'wifiDirect'      Wi-Fi Direct (Android to Android only).
 *   'wifiAware'       Wi-Fi Aware / NAN. Reported unavailable on most hardware.
 */

export interface NativeTransportCapability {
  /** One of the transport identifiers above. */
  kind: string;
  /** True when this build and this hardware could use it at all. */
  supported: boolean;
  /** True when it is usable right now (permissions granted, radio on). */
  available: boolean;
  /**
   * When unavailable, why: 'unsupportedHardware' | 'unsupportedOsVersion' |
   * 'permissionDenied' | 'permissionNotRequested' | 'radioOff' |
   * 'noLocalNetwork' | 'unknown'.
   */
  reason: string;
  /** Human-readable detail for the permission screen. Already localised. */
  detail: string;
}

export interface NativeCapabilities {
  platform: string;
  osVersion: string;
  deviceModel: string;
  transports: NativeTransportCapability[];
  /** True when this device can act as a BLE peripheral, not only a central. */
  canAdvertiseBle: boolean;
  /** True when BLE L2CAP connection-oriented channels are available. */
  supportsL2cap: boolean;
  /** True when the device can start a local-only hotspot (Android). */
  canCreateHotspot: boolean;
  /** True when the app can ask the OS to join a hotspot (iOS). */
  canJoinHotspot: boolean;
}

export interface NativePermissionResult {
  granted: boolean;
  /** Transport identifiers that are now usable. */
  granted_transports: string[];
  /** Transports the user refused. */
  denied_transports: string[];
  /** True when the user chose "don't ask again" and only Settings can fix it. */
  requiresSettings: boolean;
}

export interface NativeDiscoveredPeer {
  transport: string;
  /** Transport-scoped handle. NOT a stable identity - it may rotate. */
  endpointId: string;
  /** Advertised name if the transport carries one. Untrusted. */
  name: string;
  /** Base64 of the rotating advertisement token, or '' when absent. */
  token: string;
  /** dBm, or 0 when the transport does not report signal strength. */
  rssi: CodegenTypes.Int32;
}

export interface NativeLinkOpened {
  linkId: string;
  transport: string;
  endpointId: string;
  /** Largest single datagram this link accepts, in bytes. */
  maxDatagramSize: CodegenTypes.Int32;
  /** True when this transport can carry photos and video at a usable rate. */
  highBandwidth: boolean;
  /** True when the peer opened this link to us rather than the other way round. */
  incoming: boolean;
}

export interface NativeLinkStateEvent {
  linkId: string;
  /** 'connecting' | 'connected' | 'closing' | 'closed' | 'failed' */
  state: string;
  reason: string;
}

export interface NativeDataEvent {
  linkId: string;
  /** Base64 of exactly one datagram. Message boundaries are preserved. */
  data: string;
}

export interface NativeMtuEvent {
  linkId: string;
  maxDatagramSize: CodegenTypes.Int32;
}

export interface NativeAvailabilityEvent {
  transport: string;
  available: boolean;
  reason: string;
}

export interface NativeLinkMetrics {
  linkId: string;
  transport: string;
  maxDatagramSize: CodegenTypes.Int32;
  rssi: CodegenTypes.Int32;
  packetsSent: CodegenTypes.Int32;
  packetsReceived: CodegenTypes.Int32;
  packetsDropped: CodegenTypes.Int32;
  bytesSent: CodegenTypes.Double;
  bytesReceived: CodegenTypes.Double;
  /** Estimated throughput in bytes per second, or 0 when unknown. */
  throughput: CodegenTypes.Double;
}

export interface NativeHotspotCredentials {
  ssid: string;
  passphrase: string;
  /** True when the hotspot is running and a peer may join. */
  active: boolean;
}

/** Diagnostic line from the native layer, surfaced in Developer Mode. */
export interface NativeLogEvent {
  level: string;
  scope: string;
  message: string;
}

export interface Spec extends TurboModule {
  // -- capability and permissions -------------------------------------------

  /** What this device and this build can actually do, right now. */
  getCapabilities(): Promise<NativeCapabilities>;

  /**
   * Ask for whatever the given transports need, with the OS prompts. Call this
   * only at the moment the capability is first used, never on launch.
   */
  requestPermissions(transports: string[]): Promise<NativePermissionResult>;

  /** Open the system settings page for this app. */
  openSettings(): void;

  // -- lifecycle -------------------------------------------------------------

  /**
   * Bring the native stack up. `serviceUuid`, `rxCharacteristicUuid` and
   * `txCharacteristicUuid` come from the protocol constants so the two sides
   * cannot drift apart.
   */
  start(
    serviceUuid: string,
    rxCharacteristicUuid: string,
    txCharacteristicUuid: string,
    bonjourServiceType: string,
  ): Promise<void>;

  /** Tear everything down: stop advertising, stop scanning, close every link. */
  stop(): Promise<void>;

  // -- advertising and discovery --------------------------------------------

  /**
   * Advertise our presence.
   * @param token base64 of the rotating 6-byte advertisement token
   * @param displayName included only when the user has opted in; '' otherwise
   */
  startAdvertising(transport: string, token: string, displayName: string): Promise<void>;
  stopAdvertising(transport: string): Promise<void>;

  startDiscovery(transport: string): Promise<void>;
  stopDiscovery(transport: string): Promise<void>;

  // -- links -----------------------------------------------------------------

  /** Open a link to a discovered endpoint. Resolves with the new link id. */
  connect(transport: string, endpointId: string, timeoutMs: CodegenTypes.Int32): Promise<string>;

  disconnect(linkId: string, reason: string): Promise<void>;

  /**
   * Send exactly one datagram.
   *
   * Resolves once the transport has accepted it for transmission - NOT once the
   * peer has it. Rejects if the link is down or the payload exceeds
   * maxDatagramSize; it must never truncate.
   *
   * @param reliable false selects a best-effort path where the transport has
   *   one (BLE write-without-response), which the realtime game channel uses.
   */
  send(linkId: string, data: string, reliable: boolean): Promise<void>;

  getLinkMetrics(linkId: string): Promise<NativeLinkMetrics>;

  // -- Wi-Fi handoff ---------------------------------------------------------

  /**
   * Android: start a local-only hotspot and return its credentials, which are
   * then handed to the peer over the existing Bluetooth link. Rejects on iOS,
   * where no app-controlled hotspot API exists.
   */
  createHotspot(): Promise<NativeHotspotCredentials>;
  stopHotspot(): Promise<void>;

  /**
   * iOS: ask the OS to join a hotspot, which shows one system confirmation.
   * This is the only route to high-bandwidth iPhone-to-Android transfer with no
   * network present.
   */
  joinHotspot(ssid: string, passphrase: string): Promise<boolean>;
  leaveHotspot(ssid: string): Promise<void>;

  // -- events ----------------------------------------------------------------

  readonly onPeerDiscovered: CodegenTypes.EventEmitter<NativeDiscoveredPeer>;
  readonly onPeerLost: CodegenTypes.EventEmitter<NativeDiscoveredPeer>;
  readonly onLinkOpened: CodegenTypes.EventEmitter<NativeLinkOpened>;
  readonly onLinkState: CodegenTypes.EventEmitter<NativeLinkStateEvent>;
  readonly onData: CodegenTypes.EventEmitter<NativeDataEvent>;
  readonly onMtuChanged: CodegenTypes.EventEmitter<NativeMtuEvent>;
  readonly onAvailabilityChanged: CodegenTypes.EventEmitter<NativeAvailabilityEvent>;
  readonly onLog: CodegenTypes.EventEmitter<NativeLogEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeAirLinkTransport');
