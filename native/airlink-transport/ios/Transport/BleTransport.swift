import Foundation
import CoreBluetooth

/**
 * Bluetooth Low Energy transport.
 *
 * SKELETON - the class shape and the wiring are real; the CoreBluetooth work is
 * implemented separately. Every method that is not yet implemented throws or
 * reports unavailable rather than pretending to succeed.
 */
final class BleTransport: NSObject, AirLinkTransport {
    let kind: TransportKind = .ble
    weak var events: TransportEventSink?

    private var configuration: TransportConfiguration?

    func availability() -> (available: Bool, reason: UnavailableReason, detail: String) {
        return (false, .unknown, "Bluetooth transport is not yet implemented in this build.")
    }

    func start(configuration: TransportConfiguration) throws {
        self.configuration = configuration
    }

    func stop() {}

    func startAdvertising(token: Data, displayName: String) throws {
        throw AirLinkError.unsupported("BLE advertising")
    }

    func stopAdvertising() {}

    func startDiscovery() throws {
        throw AirLinkError.unsupported("BLE discovery")
    }

    func stopDiscovery() {}

    func connect(endpointId: String, timeoutMs: Int, completion: @escaping (Result<String, Error>) -> Void) {
        completion(.failure(AirLinkError.unsupported("BLE connect")))
    }

    func disconnect(linkId: String, reason: String) {}

    func send(linkId: String, data: Data, reliable: Bool, completion: @escaping (Result<Void, Error>) -> Void) {
        completion(.failure(AirLinkError.unsupported("BLE send")))
    }

    func metrics(linkId: String) -> LinkMetricsSnapshot? { nil }
}
