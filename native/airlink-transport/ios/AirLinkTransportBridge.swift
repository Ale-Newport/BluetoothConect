import Foundation
import UIKit

/**
 * The Swift half of the transport module.
 *
 * Owns the transports, routes calls to whichever one a request names, and
 * funnels every event back to JavaScript through the delegate. It contains no
 * radio code itself - each transport is a separate file in Transport/ - and no
 * protocol knowledge at all.
 *
 * THREADING. Every transport reports on its own queue (CoreBluetooth on the one
 * it was given, Network.framework on its own). Everything is funnelled onto a
 * single serial queue before touching shared state, and events are handed to
 * the delegate from there. React Native's TurboModule event emitters are safe to
 * call from any thread.
 */
@objc public protocol AirLinkTransportBridgeDelegate: AnyObject {
    func emitPeerDiscovered(_ payload: [String: Any])
    func emitPeerLost(_ payload: [String: Any])
    func emitLinkOpened(_ payload: [String: Any])
    func emitLinkState(_ payload: [String: Any])
    func emitData(_ payload: [String: Any])
    func emitMtuChanged(_ payload: [String: Any])
    func emitAvailabilityChanged(_ payload: [String: Any])
    func emitLog(_ payload: [String: Any])
}

@objc public final class AirLinkTransportBridge: NSObject {

    @objc public static let shared = AirLinkTransportBridge()

    @objc public weak var delegate: AirLinkTransportBridgeDelegate?

    private let queue = DispatchQueue(label: "com.airlink.transport.bridge")
    private var transports: [TransportKind: AirLinkTransport] = [:]
    /// Which transport owns each open link, so send/disconnect can be routed.
    private var linkOwners: [String: TransportKind] = [:]
    private var configuration: TransportConfiguration?
    private var started = false

    private override init() {
        super.init()
    }

    // MARK: - Registration

    private func buildTransports() -> [TransportKind: AirLinkTransport] {
        var built: [TransportKind: AirLinkTransport] = [:]
        let ble = BleTransport()
        ble.events = self
        built[.ble] = ble

        let localNetwork = LocalNetworkTransport(kind: .localNetwork)
        localNetwork.events = self
        built[.localNetwork] = localNetwork

        // Apple peer-to-peer Wi-Fi is the same Network.framework code path with
        // includePeerToPeer enabled; it earns a separate entry because its
        // capabilities and cross-platform reach are completely different.
        let peerToPeer = LocalNetworkTransport(kind: .peerToPeerWifi)
        peerToPeer.events = self
        built[.peerToPeerWifi] = peerToPeer

        return built
    }

    private func transport(_ name: String) throws -> AirLinkTransport {
        guard let kind = TransportKind(rawValue: name) else {
            throw AirLinkError.unsupported("Transport '\(name)'")
        }
        guard let transport = transports[kind] else {
            throw AirLinkError.unsupported("Transport '\(name)' on this platform")
        }
        return transport
    }

    // MARK: - Capability and permissions

    @objc public func getCapabilities(resolve: @escaping ([String: Any]) -> Void,
                                      reject: @escaping (String, String) -> Void) {
        queue.async {
            let active = self.transports.isEmpty ? self.buildTransports() : self.transports
            var descriptors: [[String: Any]] = []

            for kind in TransportKind.allCases {
                if let transport = active[kind] {
                    let state = transport.availability()
                    descriptors.append([
                        "kind": kind.rawValue,
                        "supported": true,
                        "available": state.available,
                        "reason": state.reason.rawValue,
                        "detail": state.detail,
                    ])
                } else {
                    // Declared, and honestly reported as unavailable. Wi-Fi Direct
                    // is Android-only; Wi-Fi Aware on iOS 26 requires a special
                    // entitlement and a system pairing ceremony per peer, and does
                    // not interoperate with Android handsets in practice.
                    let detail = kind == .wifiDirect
                        ? "Wi-Fi Direct is an Android technology and has no iOS equivalent."
                        : "Wi-Fi Aware on iOS requires a dedicated entitlement and per-peer system pairing, and does not currently interoperate with Android phones."
                    descriptors.append([
                        "kind": kind.rawValue,
                        "supported": false,
                        "available": false,
                        "reason": UnavailableReason.unsupportedHardware.rawValue,
                        "detail": detail,
                    ])
                }
            }

            resolve([
                "platform": "ios",
                "osVersion": UIDevice.current.systemVersion,
                "deviceModel": Self.deviceModel(),
                "transports": descriptors,
                "canAdvertiseBle": true,
                "supportsL2cap": true,
                // No public API lets an iOS app start a hotspot. Joining one is
                // possible via NEHotspotConfiguration, which is what makes the
                // Android-hosts / iPhone-joins handoff the only high-bandwidth
                // cross-platform route with no network present.
                "canCreateHotspot": false,
                "canJoinHotspot": true,
            ])
        }
    }

    private static func deviceModel() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        let identifier = mirror.children.reduce(into: "") { result, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            result.append(Character(UnicodeScalar(UInt8(value))))
        }
        return identifier.isEmpty ? UIDevice.current.model : identifier
    }

    @objc public func requestPermissions(_ transportNames: [String],
                                         resolve: @escaping ([String: Any]) -> Void,
                                         reject: @escaping (String, String) -> Void) {
        queue.async {
            // On iOS there is no explicit permission request API for Bluetooth or
            // the local network: the system prompt appears the first time the
            // capability is used. So we start the relevant transport, let the OS
            // ask, and then report what we actually got.
            if self.transports.isEmpty { self.transports = self.buildTransports() }

            var granted: [String] = []
            var denied: [String] = []
            var pending: [String] = []
            var needsSettings = false

            for name in transportNames {
                guard let kind = TransportKind(rawValue: name), let transport = self.transports[kind] else {
                    denied.append(name)
                    continue
                }
                let state = transport.availability()
                if state.available {
                    granted.append(name)
                    continue
                }
                switch state.reason {
                case .permissionNotRequested:
                    // NOT granted. iOS decides asynchronously - the manager sits
                    // in .unknown until the user answers the prompt - and
                    // reporting it as granted made a first launch claim a
                    // permission it had not actually been given, so the app went
                    // on to advertise and scan and silently did neither.
                    pending.append(name)
                case .permissionDenied:
                    denied.append(name)
                    needsSettings = true
                default:
                    denied.append(name)
                }
            }

            // A pending transport is neither granted nor refused. Reporting it
            // as denied would be just as wrong as reporting it granted, so it is
            // reported as denied WITHOUT requiresSettings: the caller shows
            // "try again" rather than sending the user to Settings for a prompt
            // they have not seen yet.
            resolve([
                "granted": denied.isEmpty && pending.isEmpty,
                "granted_transports": granted,
                "denied_transports": denied + pending,
                "requiresSettings": needsSettings,
            ])
        }
    }

    @objc public func openSettings() {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url)
        }
    }

    // MARK: - Lifecycle

    @objc public func start(withServiceUuid serviceUuid: String,
                            rx rxUuid: String,
                            tx txUuid: String,
                            bonjourService bonjourType: String,
                            resolve: @escaping () -> Void,
                            reject: @escaping (String, String) -> Void) {
        queue.async {
            let configuration = TransportConfiguration(
                serviceUUID: serviceUuid,
                rxCharacteristicUUID: rxUuid,
                txCharacteristicUUID: txUuid,
                bonjourServiceType: bonjourType
            )
            self.configuration = configuration
            if self.transports.isEmpty { self.transports = self.buildTransports() }

            // A transport that cannot start is not fatal: BLE alone is a working
            // product, and the others are upgrades. Report and carry on.
            for (kind, transport) in self.transports {
                do {
                    try transport.start(configuration: configuration)
                } catch {
                    self.log(level: "warn", scope: kind.rawValue, message: "failed to start: \(error)")
                }
            }
            self.started = true
            resolve()
        }
    }

    @objc public func stop(resolve: @escaping () -> Void, reject: @escaping (String, String) -> Void) {
        queue.async {
            for transport in self.transports.values { transport.stop() }
            self.linkOwners.removeAll()
            self.started = false
            resolve()
        }
    }

    // MARK: - Advertising and discovery

    @objc public func startAdvertising(_ transportName: String,
                                       token: String,
                                       displayName: String,
                                       resolve: @escaping () -> Void,
                                       reject: @escaping (String, String) -> Void) {
        run(reject) {
            guard self.started else { throw AirLinkError.notStarted }
            let tokenData = Data(base64Encoded: token) ?? Data()
            try self.transport(transportName).startAdvertising(token: tokenData, displayName: displayName)
            resolve()
        }
    }

    @objc public func stopAdvertising(_ transportName: String,
                                      resolve: @escaping () -> Void,
                                      reject: @escaping (String, String) -> Void) {
        run(reject) {
            try self.transport(transportName).stopAdvertising()
            resolve()
        }
    }

    @objc public func startDiscovery(_ transportName: String,
                                     resolve: @escaping () -> Void,
                                     reject: @escaping (String, String) -> Void) {
        run(reject) {
            guard self.started else { throw AirLinkError.notStarted }
            try self.transport(transportName).startDiscovery()
            resolve()
        }
    }

    @objc public func stopDiscovery(_ transportName: String,
                                    resolve: @escaping () -> Void,
                                    reject: @escaping (String, String) -> Void) {
        run(reject) {
            try self.transport(transportName).stopDiscovery()
            resolve()
        }
    }

    // MARK: - Links

    @objc public func connect(_ transportName: String,
                              endpointId: String,
                              timeoutMs: Int,
                              resolve: @escaping (String) -> Void,
                              reject: @escaping (String, String) -> Void) {
        queue.async {
            do {
                guard self.started else { throw AirLinkError.notStarted }
                let transport = try self.transport(transportName)
                let kind = transport.kind
                transport.connect(endpointId: endpointId, timeoutMs: timeoutMs) { result in
                    self.queue.async {
                        switch result {
                        case .success(let linkId):
                            self.linkOwners[linkId] = kind
                            resolve(linkId)
                        case .failure(let error):
                            self.rejectWith(error, reject)
                        }
                    }
                }
            } catch {
                self.rejectWith(error, reject)
            }
        }
    }

    @objc public func disconnect(_ linkId: String,
                                 reason: String,
                                 resolve: @escaping () -> Void,
                                 reject: @escaping (String, String) -> Void) {
        queue.async {
            if let kind = self.linkOwners[linkId], let transport = self.transports[kind] {
                transport.disconnect(linkId: linkId, reason: reason)
                self.linkOwners.removeValue(forKey: linkId)
            }
            // Disconnecting an unknown link is not an error: the caller wanted it
            // gone, and it is gone.
            resolve()
        }
    }

    @objc public func send(_ linkId: String,
                           data base64: String,
                           reliable: Bool,
                           resolve: @escaping () -> Void,
                           reject: @escaping (String, String) -> Void) {
        queue.async {
            guard let kind = self.linkOwners[linkId], let transport = self.transports[kind] else {
                self.rejectWith(AirLinkError.unknownLink(linkId), reject)
                return
            }
            guard let payload = Data(base64Encoded: base64) else {
                self.rejectWith(AirLinkError.failed("payload was not valid base64"), reject)
                return
            }
            transport.send(linkId: linkId, data: payload, reliable: reliable) { result in
                switch result {
                case .success: resolve()
                case .failure(let error): self.rejectWith(error, reject)
                }
            }
        }
    }

    @objc public func getLinkMetrics(_ linkId: String,
                                     resolve: @escaping ([String: Any]) -> Void,
                                     reject: @escaping (String, String) -> Void) {
        queue.async {
            guard let kind = self.linkOwners[linkId],
                  let transport = self.transports[kind],
                  let snapshot = transport.metrics(linkId: linkId) else {
                self.rejectWith(AirLinkError.unknownLink(linkId), reject)
                return
            }
            resolve([
                "linkId": linkId,
                "transport": kind.rawValue,
                "maxDatagramSize": snapshot.maxDatagramSize,
                "rssi": snapshot.rssi,
                "packetsSent": snapshot.packetsSent,
                "packetsReceived": snapshot.packetsReceived,
                "packetsDropped": snapshot.packetsDropped,
                "bytesSent": snapshot.bytesSent,
                "bytesReceived": snapshot.bytesReceived,
                "throughput": snapshot.throughput,
            ])
        }
    }

    // MARK: - Wi-Fi handoff

    @objc public func createHotspot(resolve: @escaping ([String: Any]) -> Void,
                                    reject: @escaping (String, String) -> Void) {
        // iOS has no public API for an app to start a hotspot. Rejecting here is
        // the honest answer; the negotiation layer reads canCreateHotspot and
        // makes the Android side the host.
        reject(AirLinkError.unsupported("Starting a hotspot").code,
               "iOS provides no API for an app to start a Wi-Fi hotspot. The Android peer must host it.")
    }

    @objc public func stopHotspot(resolve: @escaping () -> Void,
                                  reject: @escaping (String, String) -> Void) {
        resolve()
    }

    @objc public func joinHotspot(_ ssid: String,
                                  passphrase: String,
                                  resolve: @escaping (NSNumber) -> Void,
                                  reject: @escaping (String, String) -> Void) {
        HotspotJoiner.join(ssid: ssid, passphrase: passphrase) { result in
            switch result {
            case .success(let joined): resolve(NSNumber(value: joined))
            case .failure(let error): self.rejectWith(error, reject)
            }
        }
    }

    @objc public func leaveHotspot(_ ssid: String,
                                   resolve: @escaping () -> Void,
                                   reject: @escaping (String, String) -> Void) {
        HotspotJoiner.leave(ssid: ssid)
        resolve()
    }

    // MARK: - Helpers

    private func run(_ reject: @escaping (String, String) -> Void, _ body: @escaping () throws -> Void) {
        queue.async {
            do { try body() } catch { self.rejectWith(error, reject) }
        }
    }

    private func rejectWith(_ error: Error, _ reject: (String, String) -> Void) {
        if let airLinkError = error as? AirLinkError {
            reject(airLinkError.code, airLinkError.message)
        } else {
            reject("failed", error.localizedDescription)
        }
    }
}

// MARK: - TransportEventSink

extension AirLinkTransportBridge: TransportEventSink {
    func peerDiscovered(_ endpoint: DiscoveredEndpoint) {
        delegate?.emitPeerDiscovered(endpoint.payload)
    }

    func peerLost(_ endpoint: DiscoveredEndpoint) {
        delegate?.emitPeerLost(endpoint.payload)
    }

    func linkOpened(linkId: String, transport: TransportKind, endpointId: String,
                    maxDatagramSize: Int, highBandwidth: Bool, incoming: Bool) {
        queue.async { self.linkOwners[linkId] = transport }
        delegate?.emitLinkOpened([
            "linkId": linkId,
            "transport": transport.rawValue,
            "endpointId": endpointId,
            "maxDatagramSize": maxDatagramSize,
            "highBandwidth": highBandwidth,
            "incoming": incoming,
        ])
    }

    func linkState(linkId: String, state: LinkState, reason: String) {
        if state == .closed || state == .failed {
            queue.async { self.linkOwners.removeValue(forKey: linkId) }
        }
        delegate?.emitLinkState(["linkId": linkId, "state": state.rawValue, "reason": reason])
    }

    func received(linkId: String, data: Data) {
        delegate?.emitData(["linkId": linkId, "data": data.base64EncodedString()])
    }

    func mtuChanged(linkId: String, maxDatagramSize: Int) {
        delegate?.emitMtuChanged(["linkId": linkId, "maxDatagramSize": maxDatagramSize])
    }

    func availabilityChanged(transport: TransportKind, available: Bool, reason: UnavailableReason) {
        delegate?.emitAvailabilityChanged([
            "transport": transport.rawValue,
            "available": available,
            "reason": reason.rawValue,
        ])
    }

    func log(level: String, scope: String, message: String) {
        delegate?.emitLog(["level": level, "scope": scope, "message": message])
    }
}
