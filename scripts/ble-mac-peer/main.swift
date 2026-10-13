// A second AirLink "phone" made of the Mac's own Bluetooth radio.
//
// WHY THIS EXISTS. The Bluetooth path is the app's whole promise - two phones,
// no network - and it cannot be exercised on a simulator, which has no radio at
// all (CBCentralManager reports .unsupported, and the app says so: "No Bluetooth
// on this device"). Testing it takes two physical Bluetooth devices, and a
// developer with one iPhone has one. The Mac has a real radio, so it can be the
// other one.
//
// WHAT IT IS, AND IS NOT. It speaks the layer BELOW the protocol: the same GATT
// service, the same three characteristics, the same identity record the iOS
// transport publishes. It does NOT implement the encrypted session above that,
// so it can never complete a pairing - it cannot become a friend. What it can do
// is the part that decides whether two phones can find each other and open a
// link at all, and it prints exactly what the iPhone does to it:
//
//   as a PERIPHERAL  it advertises, answers identity reads, and logs every
//                    subscription and write the iPhone makes. If the iPhone's
//                    identity probe works, the read shows up here within seconds
//                    and a row named after --name appears under "Other devices".
//   as a CENTRAL     it scans for the iPhone, connects, reads ITS identity
//                    record, decodes it, subscribes to its notifications and
//                    hangs up - the connection the iPhone's own probe makes to
//                    a peer.
//
// BRIDGE MODE (--bridge HOST:PORT) is what turns it from a probe into a peer. The
// radio half stays here; every datagram the iPhone writes is handed to a Node
// process (scripts/ble-mac-peer/bridge.ts) that runs the REAL AirLink protocol -
// handshake, six-digit pairing, chat, file transfer - and every datagram that
// process produces is sent back to the iPhone as a notification. The Mac then
// behaves as an AirLink phone with a Bluetooth radio and nothing else.
//
// Usage (see scripts/ble-mac-peer.sh, which builds and runs this):
//   --seconds N       how long to run (default 600)
//   --name NAME       the display name this fake peer publishes (default Mac-test)
//   --no-central      only advertise, do not scan for and connect to the iPhone
//   --with-central    in bridge mode, also probe the iPhone as a central (off there)
//   --bridge H:P      hand datagrams to a Node process listening at H:P
//
// Output is one line per event with a millisecond clock, then a SUMMARY block.

import CoreBluetooth
import Foundation
import Network

let serviceUUID = CBUUID(string: "8A7F2C10-4E6B-4B6E-9E1D-7C3A5F0B2D41")
let rxUUID = CBUUID(string: "8A7F2C11-4E6B-4B6E-9E1D-7C3A5F0B2D41")
let txUUID = CBUUID(string: "8A7F2C12-4E6B-4B6E-9E1D-7C3A5F0B2D41")
let identityUUID = CBUUID(string: "8A7F2C13-4E6B-4B6E-9E1D-7C3A5F0B2D41")

// MARK: - Arguments and logging

let arguments = CommandLine.arguments

func option(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

let runSeconds = Double(option("--seconds") ?? "") ?? 600
let fakeName = option("--name") ?? "Mac-test"
let bridgeAddress = option("--bridge")
let wantsCentral = !arguments.contains("--no-central") && (bridgeAddress == nil || arguments.contains("--with-central"))

let clock: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    return formatter
}()

func log(_ message: String) {
    let line = "[\(clock.string(from: Date()))] \(message)"
    print(line)
    fflush(stdout)
    bridge?.send(["op": "log", "line": line])
}

func hex(_ data: Data, limit: Int = 24) -> String {
    let head = data.prefix(limit).map { String(format: "%02x", $0) }.joined(separator: " ")
    return data.count > limit ? "\(head) ... (\(data.count) bytes)" : "\(head) (\(data.count) bytes)"
}

func stateName(_ state: CBManagerState) -> String {
    switch state {
    case .unknown: return "unknown"
    case .resetting: return "resetting"
    case .unsupported: return "UNSUPPORTED"
    case .unauthorized: return "UNAUTHORIZED (allow Bluetooth for this tool in System Settings)"
    case .poweredOff: return "POWERED OFF"
    case .poweredOn: return "poweredOn"
    @unknown default: return "?"
    }
}

// MARK: - The identity record (byte-for-byte what BleIdentityRecord.swift writes)

enum IdentityRecord {
    static func encode(token: Data, name: String, discoveryId: String) -> Data {
        var out = Data()
        out.append(1) // version
        out.append(0b10) // flags: bit 1 = a discovery id follows
        out.append(0) // PSM high
        out.append(0) // PSM low
        out.append(UInt8(token.count))
        out.append(token)
        out.append(UInt8(discoveryId.utf8.count))
        out.append(Data(discoveryId.utf8))
        out.append(Data(name.utf8))
        return out
    }

    struct Contents {
        let token: Data
        let discoveryId: String
        let name: String
        let psm: UInt16
    }

    static func decode(_ data: Data) -> Contents? {
        let bytes = [UInt8](data)
        guard bytes.count >= 5, bytes[0] == 1 else { return nil }
        let flags = bytes[1]
        let psm = (UInt16(bytes[2]) << 8) | UInt16(bytes[3])
        let tokenLength = Int(bytes[4])
        guard tokenLength <= 32, 5 + tokenLength <= bytes.count else { return nil }
        let token = Data(bytes[5 ..< 5 + tokenLength])
        var cursor = 5 + tokenLength
        var discoveryId = ""
        if flags & 0b10 != 0 {
            guard cursor < bytes.count else { return nil }
            let length = Int(bytes[cursor])
            cursor += 1
            guard length == 16, cursor + length <= bytes.count else { return nil }
            discoveryId = String(data: Data(bytes[cursor ..< cursor + length]), encoding: .utf8) ?? ""
            cursor += length
        }
        let name = String(data: Data(bytes[cursor...]), encoding: .utf8) ?? ""
        return Contents(token: token, discoveryId: discoveryId, name: name, psm: flags & 1 != 0 ? psm : 0)
    }
}

// MARK: - Bridge to the Node process that speaks the protocol

/// Line-delimited JSON over a loopback TCP connection. Everything runs on the main
/// queue, which is also where CoreBluetooth calls back, so nothing here races.
final class Bridge {
    private let connection: NWConnection
    private var pending = Data()
    var onMessage: (([String: Any]) -> Void)?
    var onClosed: (() -> Void)?

    init?(address: String) {
        let parts = address.split(separator: ":")
        guard parts.count == 2, let port = NWEndpoint.Port(String(parts[1])) else { return nil }
        connection = NWConnection(host: NWEndpoint.Host(String(parts[0])), port: port, using: .tcp)
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.onClosed?() }
            if case .cancelled = state { self?.onClosed?() }
        }
        connection.start(queue: .main)
        receive()
    }

    func send(_ message: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0a)
        connection.send(content: data, completion: .contentProcessed { _ in })
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.pending.append(data)
                while let newline = self.pending.firstIndex(of: 0x0a) {
                    let line = self.pending.subdata(in: self.pending.startIndex ..< newline)
                    self.pending.removeSubrange(self.pending.startIndex ... newline)
                    if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                        self.onMessage?(object)
                    }
                }
            }
            if error != nil || isComplete {
                self.onClosed?()
            } else {
                self.receive()
            }
        }
    }
}

var bridge: Bridge?

// MARK: - The peer

final class Peer: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate, CBPeripheralManagerDelegate {
    private var central: CBCentralManager?
    private var manager: CBPeripheralManager?

    // What we publish.
    private let token = Data((0 ..< 6).map { _ in UInt8.random(in: 0 ... 255) })
    private let discoveryId = "0123456789abcdef"
    private var identityRecord: Data { IdentityRecord.encode(token: token, name: fakeName, discoveryId: discoveryId) }

    // What we saw.
    private var sightings: [UUID: Int] = [:]
    private var probed: [UUID: Date] = [:]
    private var inFlight: [UUID: CBPeripheral] = [:]
    private var identityReadsByPhone = 0
    private var subscriptionsByPhone = 0
    private var writesByPhone = 0
    private var bytesWrittenByPhone = 0
    private var phoneIdentities = 0
    private var phoneNotifications = 0
    private var advertisingStarted = false

    // The notification path back to the iPhone, used in bridge mode.
    private var txCharacteristic: CBMutableCharacteristic?
    private var txQueue: [Data] = []
    private var subscribedCentral: CBCentral?

    func start() {
        bridge?.onMessage = { [weak self] message in self?.fromBridge(message) }
        bridge?.onClosed = {
            log("the protocol process went away; stopping")
            exit(0)
        }
        bridge?.start()
        manager = CBPeripheralManager(delegate: self, queue: nil)
        if wantsCentral { central = CBCentralManager(delegate: self, queue: nil) }
        log("authorization: \(CBManager.authorization.rawValue) (3 = allowed)")
    }

    func summary() {
        print("")
        print("SUMMARY")
        print("  iPhone advertisements seen        : \(sightings.count) device(s), \(sightings.values.reduce(0, +)) sighting(s)")
        print("  iPhone identity records read      : \(phoneIdentities)   (the Mac reading the iPhone)")
        print("  iPhone notifications received     : \(phoneNotifications)")
        print("  iPhone read OUR identity record   : \(identityReadsByPhone)   (the iPhone's identity probe)")
        print("  iPhone subscribed to our TX       : \(subscriptionsByPhone)   (the iPhone opened a link)")
        print("  iPhone writes to our RX           : \(writesByPhone) write(s), \(bytesWrittenByPhone) byte(s)")
        fflush(stdout)
    }

    // MARK: Peripheral role - we pretend to be an AirLink phone

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        log("peripheral state: \(stateName(peripheral.state))")
        guard peripheral.state == .poweredOn else { return }

        let rx = CBMutableCharacteristic(type: rxUUID, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
        let tx = CBMutableCharacteristic(type: txUUID, properties: [.notify], value: nil, permissions: [.readable])
        txCharacteristic = tx
        let identity = CBMutableCharacteristic(type: identityUUID, properties: [.read], value: nil, permissions: [.readable])
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [rx, tx, identity]
        peripheral.add(service)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            log("could not add the service: \(error.localizedDescription)")
            return
        }
        log("service added; advertising as \"\(fakeName)\" (token \(hex(token)), discovery id \(discoveryId))")
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
            CBAdvertisementDataLocalNameKey: fakeName,
        ])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error {
            log("advertising FAILED: \(error.localizedDescription)")
        } else {
            advertisingStarted = true
            log("advertising started")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == identityUUID else {
            peripheral.respond(to: request, withResult: .requestNotSupported)
            return
        }
        let record = identityRecord
        guard request.offset <= record.count else {
            peripheral.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = record.subdata(in: request.offset ..< record.count)
        peripheral.respond(to: request, withResult: .success)
        identityReadsByPhone += 1
        log("*** THE IPHONE READ OUR IDENTITY RECORD (central \(request.central.identifier.uuidString.prefix(8)), offset \(request.offset)) - its identity probe works")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard characteristic.uuid == txUUID else { return }
        subscriptionsByPhone += 1
        log("*** THE IPHONE SUBSCRIBED to our TX (central \(central.identifier.uuidString.prefix(8)), max notification size \(central.maximumUpdateValueLength) bytes) - it opened a link")
        subscribedCentral = central
        txQueue.removeAll()
        bridge?.send(["op": "open", "mtu": central.maximumUpdateValueLength, "central": central.identifier.uuidString])
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard characteristic.uuid == txUUID else { return }
        log("the iPhone unsubscribed (central \(central.identifier.uuidString.prefix(8)))")
        if subscribedCentral?.identifier == central.identifier {
            subscribedCentral = nil
            txQueue.removeAll()
            bridge?.send(["op": "close"])
        }
    }

    /// CoreBluetooth has room again after `updateValue` said it had none.
    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        pumpTx()
    }

    // MARK: Bridge: datagrams to and from the protocol process

    private func fromBridge(_ message: [String: Any]) {
        switch message["op"] as? String {
        case "tx":
            guard let encoded = message["data"] as? String, let data = Data(base64Encoded: encoded) else { return }
            txQueue.append(data)
            pumpTx()
        case "quit":
            log("asked to stop by the protocol process")
            summary()
            exit(0)
        default:
            break
        }
    }

    private func pumpTx() {
        guard let manager, let tx = txCharacteristic, let central = subscribedCentral else { return }
        while let head = txQueue.first {
            // Targeted at the one central we are bridging, so a second subscriber
            // can never receive another session's frames.
            guard manager.updateValue(head, for: tx, onSubscribedCentrals: [central]) else { return }
            txQueue.removeFirst()
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            let value = request.value ?? Data()
            writesByPhone += 1
            bytesWrittenByPhone += value.count
            if bridge != nil {
                bridge?.send(["op": "rx", "data": value.base64EncodedString()])
            } else {
                log("iPhone WROTE to RX: \(hex(value))")
            }
        }
        if let first = requests.first { peripheral.respond(to: first, withResult: .success) }
    }

    // MARK: Central role - we look for the iPhone

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        log("central state: \(stateName(central.state))")
        guard central.state == .poweredOn else { return }
        central.scanForPeripherals(withServices: [serviceUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        log("scanning for AirLink peers")
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let id = peripheral.identifier
        sightings[id, default: 0] += 1
        if sightings[id] == 1 {
            let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? "(no local name)"
            let keys = advertisementData.keys.sorted().joined(separator: ", ")
            let hasServiceData = advertisementData[CBAdvertisementDataServiceDataKey] != nil
            log("SAW AN AIRLINK PEER \(id.uuidString.prefix(8)): name \"\(name)\", RSSI \(RSSI), advertisement keys [\(keys)], service data \(hasServiceData ? "PRESENT" : "absent (as expected from an iPhone)")")
        }

        // Probe it, the way the iPhone's own probe does: connect, read, hang up.
        // At most one at a time, and not the same peer twice inside a minute.
        guard inFlight.isEmpty else { return }
        if let last = probed[id], Date().timeIntervalSince(last) < 60 { return }
        probed[id] = Date()
        inFlight[id] = peripheral
        peripheral.delegate = self
        log("connecting to the iPhone to read its identity")
        central.connect(peripheral, options: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
            guard let self, self.inFlight[id] != nil else { return }
            log("probe of the iPhone timed out after 12 s")
            central.cancelPeripheralConnection(peripheral)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        log("connected to the iPhone; discovering its service")
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        inFlight[peripheral.identifier] = nil
        log("could not connect to the iPhone: \(error?.localizedDescription ?? "unknown error")")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        inFlight[peripheral.identifier] = nil
        log("disconnected from the iPhone\(error.map { " (\($0.localizedDescription))" } ?? "")")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            log("the iPhone does not expose the AirLink service: \(error?.localizedDescription ?? "not found")")
            central?.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics([rxUUID, txUUID, identityUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let found = service.characteristics ?? []
        log("the iPhone's characteristics: \(found.map { String($0.uuid.uuidString.prefix(8)) }.joined(separator: ", "))")
        log("  write size it accepts: \(peripheral.maximumWriteValueLength(for: .withoutResponse)) bytes without response, \(peripheral.maximumWriteValueLength(for: .withResponse)) with response")
        if let identity = found.first(where: { $0.uuid == identityUUID }) {
            peripheral.readValue(for: identity)
        } else {
            log("  the iPhone has NO identity characteristic")
        }
        if let tx = found.first(where: { $0.uuid == txUUID }) {
            peripheral.setNotifyValue(true, for: tx)
        }
        // Hold the link briefly so a subscription is a real subscription, then go.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.inFlight[peripheral.identifier] != nil else { return }
            self.central?.cancelPeripheralConnection(peripheral)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error {
            log("read/notify of \(characteristic.uuid.uuidString.prefix(8)) failed: \(error.localizedDescription)")
            return
        }
        guard let value = characteristic.value else { return }
        if characteristic.uuid == identityUUID {
            phoneIdentities += 1
            if let record = IdentityRecord.decode(value) {
                log("*** THE IPHONE'S IDENTITY RECORD decodes: name \"\(record.name)\", token \(record.token.count) bytes, discovery id \"\(record.discoveryId)\", PSM \(record.psm)")
            } else {
                log("the iPhone's identity record did NOT decode: \(hex(value))")
            }
        } else if characteristic.uuid == txUUID {
            phoneNotifications += 1
            log("notification from the iPhone: \(hex(value))")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        log("subscription to the iPhone's \(characteristic.uuid.uuidString.prefix(8)): \(error == nil ? (characteristic.isNotifying ? "active" : "off") : "FAILED - \(error!.localizedDescription)")")
    }
}

// MARK: - Run

if let bridgeAddress {
    guard let connected = Bridge(address: bridgeAddress) else {
        print("bad --bridge address: \(bridgeAddress)")
        exit(2)
    }
    bridge = connected
}
let peer = Peer()
log("AirLink BLE peer: advertising as \"\(fakeName)\" for \(Int(runSeconds)) s (central role \(wantsCentral ? "on" : "off")\(bridge != nil ? ", bridged to the protocol" : ""))")
peer.start()

DispatchQueue.main.asyncAfter(deadline: .now() + runSeconds) {
    log("time is up")
    peer.summary()
    exit(0)
}

signal(SIGTERM) { _ in
    peer.summary()
    exit(0)
}
RunLoop.main.run()
