import Foundation
import Network

/**
 * Network.framework transport: Bonjour discovery plus TCP, over either an
 * existing local Wi-Fi network or Apple peer-to-peer Wi-Fi.
 *
 * SKELETON - the class shape and the wiring are real; the Network.framework
 * work is implemented separately.
 */
final class LocalNetworkTransport: AirLinkTransport {
    let kind: TransportKind
    weak var events: TransportEventSink?

    private var configuration: TransportConfiguration?

    init(kind: TransportKind) {
        self.kind = kind
    }

    func availability() -> (available: Bool, reason: UnavailableReason, detail: String) {
        return (false, .unknown, "Local network transport is not yet implemented in this build.")
    }

    func start(configuration: TransportConfiguration) throws {
        self.configuration = configuration
    }

    func stop() {}

    func startAdvertising(token: Data, displayName: String) throws {
        throw AirLinkError.unsupported("local network advertising")
    }

    func stopAdvertising() {}

    func startDiscovery() throws {
        throw AirLinkError.unsupported("local network discovery")
    }

    func stopDiscovery() {}

    func connect(endpointId: String, timeoutMs: Int, completion: @escaping (Result<String, Error>) -> Void) {
        completion(.failure(AirLinkError.unsupported("local network connect")))
    }

    func disconnect(linkId: String, reason: String) {}

    func send(linkId: String, data: Data, reliable: Bool, completion: @escaping (Result<Void, Error>) -> Void) {
        completion(.failure(AirLinkError.unsupported("local network send")))
    }

    func metrics(linkId: String) -> LinkMetricsSnapshot? { nil }
}
