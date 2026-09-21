import Foundation

/**
 * Shared vocabulary for the iOS transports.
 *
 * These strings and shapes mirror the TypeScript spec in
 * `src/NativeAirLinkTransport.ts` exactly. Where a value crosses the bridge it
 * is built here, so there is one place to look when the two sides disagree.
 */

enum TransportKind: String, CaseIterable {
    case ble
    case localNetwork
    case peerToPeerWifi
    case wifiDirect
    case wifiAware
}

enum UnavailableReason: String {
    case none = ""
    case unsupportedHardware
    case unsupportedOsVersion
    case permissionDenied
    case permissionNotRequested
    case radioOff
    case noLocalNetwork
    case unknown
}

enum LinkState: String {
    case connecting
    case connected
    case closing
    case closed
    case failed
}

/// A peer seen by a transport, before any session exists.
struct DiscoveredEndpoint {
    let transport: TransportKind
    let endpointId: String
    let name: String
    /// Base64 of the rotating advertisement token, or "" when absent.
    let token: String
    /// Sixteen hex characters identifying the advertising installation for the
    /// length of its app run, or "" when the peer's build predates it. Fresh on
    /// every launch, so it links nothing across time; constant while the app
    /// runs, so "is this me?" is exact rather than a race against a rotation.
    var discoveryId: String = ""
    let rssi: Int

    var payload: [String: Any] {
        [
            "transport": transport.rawValue,
            "endpointId": endpointId,
            "name": name,
            "token": token,
            "discoveryId": discoveryId,
            "rssi": rssi,
        ]
    }
}

struct LinkMetricsSnapshot {
    var maxDatagramSize: Int = 0
    var rssi: Int = 0
    var packetsSent: Int = 0
    var packetsReceived: Int = 0
    var packetsDropped: Int = 0
    var bytesSent: Double = 0
    var bytesReceived: Double = 0
    var throughput: Double = 0
}

/// Errors surfaced to JavaScript. The `code` is what the promise rejects with.
enum AirLinkError: Error {
    case notStarted
    case unsupported(String)
    case radioOff(TransportKind)
    case permissionDenied(TransportKind)
    case unknownLink(String)
    case unknownEndpoint(String)
    case payloadTooLarge(Int, Int)
    case timeout(String)
    case failed(String)

    var code: String {
        switch self {
        case .notStarted: return "not_started"
        case .unsupported: return "unsupported"
        case .radioOff: return "radio_off"
        case .permissionDenied: return "permission_denied"
        case .unknownLink: return "unknown_link"
        case .unknownEndpoint: return "unknown_endpoint"
        case .payloadTooLarge: return "payload_too_large"
        case .timeout: return "timeout"
        case .failed: return "failed"
        }
    }

    var message: String {
        switch self {
        case .notStarted:
            return "The AirLink transport has not been started."
        case .unsupported(let what):
            return "\(what) is not supported on this device."
        case .radioOff(let kind):
            return "The radio for \(kind.rawValue) is switched off."
        case .permissionDenied(let kind):
            return "Permission for \(kind.rawValue) was not granted."
        case .unknownLink(let id):
            return "No such link: \(id)."
        case .unknownEndpoint(let id):
            return "No such endpoint: \(id)."
        case .payloadTooLarge(let size, let limit):
            return "Datagram of \(size) bytes exceeds the link limit of \(limit)."
        case .timeout(let what):
            return "Timed out: \(what)."
        case .failed(let detail):
            return detail
        }
    }
}

/// Configuration handed down from the protocol layer at start().
struct TransportConfiguration {
    let serviceUUID: String
    let rxCharacteristicUUID: String
    let txCharacteristicUUID: String
    let bonjourServiceType: String
}

/**
 * What every iOS transport implements.
 *
 * Deliberately narrow: discover, connect, move opaque datagrams, report state.
 * No transport knows anything about the AirLink protocol, encryption or
 * sessions - all of that lives in TypeScript, which is why it can be tested
 * without a radio.
 */
protocol AirLinkTransport: AnyObject {
    var kind: TransportKind { get }
    var events: TransportEventSink? { get set }

    /// Whether this transport can be used right now, and if not, why.
    func availability() -> (available: Bool, reason: UnavailableReason, detail: String)

    func start(configuration: TransportConfiguration) throws
    func stop()

    func startAdvertising(token: Data, displayName: String, discoveryId: String) throws
    func stopAdvertising()

    func startDiscovery() throws
    func stopDiscovery()

    /// Opens a link. Calls back with the new link id, or an error.
    func connect(endpointId: String, timeoutMs: Int, completion: @escaping (Result<String, Error>) -> Void)

    func disconnect(linkId: String, reason: String)

    /// Sends exactly one datagram. `reliable: false` may use a lossy fast path.
    func send(linkId: String, data: Data, reliable: Bool, completion: @escaping (Result<Void, Error>) -> Void)

    func metrics(linkId: String) -> LinkMetricsSnapshot?
}

/// How a transport reports back. Implemented by the bridge.
protocol TransportEventSink: AnyObject {
    func peerDiscovered(_ endpoint: DiscoveredEndpoint)
    func peerLost(_ endpoint: DiscoveredEndpoint)
    func linkOpened(linkId: String, transport: TransportKind, endpointId: String, maxDatagramSize: Int, highBandwidth: Bool, incoming: Bool)
    func linkState(linkId: String, state: LinkState, reason: String)
    func received(linkId: String, data: Data)
    func mtuChanged(linkId: String, maxDatagramSize: Int)
    func availabilityChanged(transport: TransportKind, available: Bool, reason: UnavailableReason)
    func log(level: String, scope: String, message: String)
}
