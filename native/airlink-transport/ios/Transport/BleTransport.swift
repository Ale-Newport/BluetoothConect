import Foundation
import CoreBluetooth

/**
 * Bluetooth Low Energy transport.
 *
 * BLE is the floor of this product: it is the only radio two phones of different
 * makes can use with no network, no router and no server, so everything else in
 * AirLink is an upgrade on top of what this file can do. It is also slow, which
 * the UI is expected to say out loud.
 *
 * DUAL ROLE. iOS is happy to be a central and a peripheral at the same time, and
 * we are both, always. Neither side of a meeting knows which of them will tap
 * first, so every device advertises a service and scans for the same one. That
 * can produce two links between the same pair of phones; the TypeScript above
 * collapses them, because deciding which one wins is a protocol question and no
 * protocol lives down here.
 *
 * TWO PATHS FOR BYTES.
 *  - GATT. A write into the peer's RX characteristic, or a notification out of
 *    our TX characteristic. ATT preserves message boundaries, so a write is a
 *    datagram and no framing is needed.
 *  - L2CAP connection-oriented channel. Apple DTS recommends it over GATT for
 *    anything bulk and it is several times quicker. It is also a byte stream, so
 *    BleFraming re-creates the boundaries, and it is not discoverable, so the
 *    PSM travels in a GATT characteristic. If it breaks at any point the link
 *    drops back to GATT without closing - the session above must never notice.
 *
 * WHAT THIS FILE DOES NOT DO. It does not parse a payload, add a header, decide
 * when to reconnect, or hold a key. Datagrams are opaque; state is reported; the
 * protocol lives in @airlink/core.
 *
 * THREADING. CoreBluetooth gets its own serial queue and every mutable field
 * below lives on it. The two things the bridge may call from its own queue -
 * availability() and metrics() - read a snapshot behind a lock instead, so a
 * busy radio can never stall a JavaScript call.
 */
final class BleTransport: NSObject, AirLinkTransport {

    let kind: TransportKind = .ble
    weak var events: TransportEventSink?

    // MARK: - Constants

    /**
     * Mirrors BLE_IDENTITY_CHARACTERISTIC_UUID in
     * packages/core/src/protocol/constants.ts.
     *
     * The TurboModule contract is frozen and hands down three UUIDs - service,
     * rx, tx - so this fourth one cannot arrive at start(). It is a literal
     * rather than something derived from the other three ("take tx and add one")
     * because a derivation quietly produces a plausible wrong UUID the day
     * someone re-rolls the constants, whereas a literal fails against a peer
     * running the matching build, loudly and immediately. If constants.ts
     * changes, this line changes with it.
     */
    private static let identityCharacteristicUUIDString = "8A7F2C13-4E6B-4B6E-9E1D-7C3A5F0B2D41"

    private static let centralRestoreIdentifier = "com.airlink.transport.ble.central"
    private static let peripheralRestoreIdentifier = "com.airlink.transport.ble.peripheral"

    /// How long to wait for the identity read before opening the link anyway.
    /// Losing the PSM only costs speed, so this is deliberately short.
    private static let identityReadTimeoutMs = 5_000
    /// How long an L2CAP channel may take to open before we settle for GATT.
    private static let l2capOpenTimeoutMs = 10_000
    /// A write-with-response that is never acknowledged means the peer's ATT
    /// queue is wedged; the link is dead even though nothing has said so.
    private static let reliableWriteTimeoutMs = 15_000
    private static let housekeepingIntervalMs = 2_000
    /// No advertisement for this long and the peer is reported lost.
    private static let discoveryExpiryMs: Double = 15_000
    /// Duplicate advertisements arrive several times a second in the foreground;
    /// only re-report a peer this often unless its signal moved meaningfully.
    private static let rediscoveryThrottleMs: Double = 2_000
    private static let rssiChangeThreshold = 6

    /// Ceiling on datagrams queued for one link, and on their total size. A
    /// stalled radio must cost a bounded amount of memory, not all of it.
    private static let maxQueuedDatagrams = 512
    private static let maxQueuedBytes = 1024 * 1024
    /// Largest datagram accepted over GATT. Our own sends are capped at the
    /// negotiated ATT length, well under this; the slack exists so a peer that
    /// uses long writes is handled rather than dropped, and the cap exists so a
    /// peer cannot choose how much we allocate.
    private static let maxInboundGattDatagram = 4 * 1024

    // MARK: - Queue and managers

    private let queue = DispatchQueue(label: "com.airlink.transport.ble")

    private var centralManager: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?

    private var configuration: TransportConfiguration?
    private var serviceUUID: CBUUID?
    private var rxUUID: CBUUID?
    private var txUUID: CBUUID?
    private let identityUUID = CBUUID(string: BleTransport.identityCharacteristicUUIDString)

    // MARK: - Peripheral-role state

    private var gattService: CBMutableService?
    private var rxCharacteristic: CBMutableCharacteristic?
    private var txCharacteristic: CBMutableCharacteristic?
    private var identityCharacteristic: CBMutableCharacteristic?
    private var serviceAdded = false

    private var wantsAdvertising = false
    private var advertisedToken = Data()
    private var advertisedName = ""
    private var publishedPSM: CBL2CAPPSM = 0
    private var l2capPublishInFlight = false

    // MARK: - Central-role state

    private var wantsScanning = false
    private var discovered: [String: DiscoveryRecord] = [:]
    private var knownPeripherals: [UUID: CBPeripheral] = [:]

    // MARK: - Links

    private var links: [String: BleLink] = [:]
    private var linkIdByPeripheral: [UUID: String] = [:]
    private var linkIdByCentral: [UUID: String] = [:]
    private var nextLinkNumber: UInt64 = 0

    private var housekeeping: DispatchSourceTimer?

    // MARK: - Cross-queue snapshots

    private typealias Availability = (available: Bool, reason: UnavailableReason, detail: String)

    private let snapshotLock = NSLock()
    private var availabilitySnapshot: Availability
    private var metricsSnapshots: [String: LinkMetricsSnapshot] = [:]

    private struct DiscoveryRecord {
        let endpointId: String
        var name: String
        var token: String
        var rssi: Int
        var lastSeen: CFAbsoluteTime
        var lastEmitted: CFAbsoluteTime
        var lastEmittedRssi: Int

        var endpoint: DiscoveredEndpoint {
            DiscoveredEndpoint(transport: .ble, endpointId: endpointId, name: name, token: token, rssi: rssi)
        }
    }

    override init() {
        // Before any manager exists, the only honest thing we can say is whether
        // the user has already refused. CBManager.authorization answers that
        // without touching the radio and without a prompt.
        availabilitySnapshot = BleTransport.authorizationAvailability() ?? (
            false, .permissionNotRequested, "Bluetooth has not been switched on for AirLink yet."
        )
        super.init()
    }

    // MARK: - Availability

    func availability() -> (available: Bool, reason: UnavailableReason, detail: String) {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        return availabilitySnapshot
    }

    /// The permission half of the question, answerable from any thread and
    /// before a manager exists. Returns nil when permission is not the problem.
    private static func authorizationAvailability() -> Availability? {
        switch CBManager.authorization {
        case .denied, .restricted:
            return (false, .permissionDenied,
                    "AirLink needs Bluetooth to find people near you. Turn it on for AirLink in Settings.")
        case .notDetermined:
            return (false, .permissionNotRequested,
                    "AirLink will ask for Bluetooth the first time you look for someone nearby.")
        default:
            return nil
        }
    }

    /// Recomputes availability from the managers and publishes any change.
    /// Must run on `queue`.
    private func refreshAvailability() {
        let next = computeAvailability()
        snapshotLock.lock()
        let previous = availabilitySnapshot
        availabilitySnapshot = next
        snapshotLock.unlock()

        guard previous.available != next.available || previous.reason != next.reason else { return }
        events?.availabilityChanged(transport: .ble, available: next.available, reason: next.reason)
        log(next.available ? "info" : "warn", "availability: \(next.reason.rawValue.isEmpty ? "available" : next.reason.rawValue)")
    }

    private func computeAvailability() -> Availability {
        if let denied = Self.authorizationAvailability(), denied.reason == .permissionDenied {
            return denied
        }
        guard let manager = centralManager else {
            return Self.authorizationAvailability() ?? (
                false, .permissionNotRequested, "Bluetooth has not been started yet."
            )
        }
        switch manager.state {
        case .poweredOn:
            return (true, .none, "")
        case .poweredOff:
            return (false, .radioOff,
                    "Bluetooth is switched off. Turn it on and AirLink will find people near you.")
        case .unauthorized:
            return (false, .permissionDenied,
                    "AirLink needs Bluetooth to find people near you. Turn it on for AirLink in Settings.")
        case .unsupported:
            return (false, .unsupportedHardware, "This device has no Bluetooth Low Energy radio.")
        case .unknown, .resetting:
            // Genuinely not known yet - the manager reports its real state a
            // moment after it is created, and the Bluetooth stack restarting
            // looks the same from here. Claiming "denied" would send the user to
            // Settings for nothing.
            return (false, .permissionNotRequested, "Waiting for Bluetooth to report its state.")
        @unknown default:
            return (false, .unknown, "Bluetooth is in a state this build does not recognise.")
        }
    }

    // MARK: - Lifecycle

    func start(configuration: TransportConfiguration) throws {
        // Validate before hopping queues so a bad UUID rejects the JavaScript
        // promise rather than disappearing into a background queue. CBUUID's
        // initialiser raises an Objective-C exception on malformed input, which
        // Swift cannot catch - so it is never handed anything unvalidated.
        guard let service = Self.parseUUID(configuration.serviceUUID) else {
            throw AirLinkError.failed("serviceUuid '\(configuration.serviceUUID)' is not a Bluetooth UUID")
        }
        guard let rx = Self.parseUUID(configuration.rxCharacteristicUUID) else {
            throw AirLinkError.failed("rxCharacteristicUuid '\(configuration.rxCharacteristicUUID)' is not a Bluetooth UUID")
        }
        guard let tx = Self.parseUUID(configuration.txCharacteristicUUID) else {
            throw AirLinkError.failed("txCharacteristicUuid '\(configuration.txCharacteristicUUID)' is not a Bluetooth UUID")
        }

        queue.async { [self] in
            if centralManager != nil, serviceUUID == service, rxUUID == rx, txUUID == tx {
                return // already up on the same UUIDs; restarting would drop live links
            }
            if centralManager != nil { teardown(reason: "transport restarted") }

            self.configuration = configuration
            serviceUUID = service
            rxUUID = rx
            txUUID = tx

            /*
             * Restoration identifiers, unconditionally.
             *
             * iOS may relaunch a backgrounded app to hand it a Bluetooth event,
             * and the only way to be handed the state that came with it is to
             * re-create the managers with the same identifiers every launch.
             * UIApplicationLaunchOptionsBluetoothCentralsKey is deprecated as of
             * iOS 26 and is deliberately not consulted.
             *
             * ShowPowerAlert is false on both. A relaunch into the background is
             * exactly when the system alert is worst - an app the user did not
             * open putting a modal on screen - and in the foreground the app has
             * a better answer anyway: availabilityChanged reports radioOff and
             * the UI explains it in our own words with a link to Settings.
             */
            centralManager = CBCentralManager(
                delegate: self,
                queue: queue,
                options: [
                    CBCentralManagerOptionRestoreIdentifierKey: Self.centralRestoreIdentifier,
                    CBCentralManagerOptionShowPowerAlertKey: false,
                ]
            )
            peripheralManager = CBPeripheralManager(
                delegate: self,
                queue: queue,
                options: [
                    CBPeripheralManagerOptionRestoreIdentifierKey: Self.peripheralRestoreIdentifier,
                    CBPeripheralManagerOptionShowPowerAlertKey: false,
                ]
            )

            startHousekeeping()
            refreshAvailability()
            log("info", "started on service \(service.uuidString)")
        }
    }

    func stop() {
        queue.async { [self] in
            teardown(reason: "transport stopped")
            refreshAvailability()
        }
    }

    /// Leaves the object reusable: start() rebuilds everything from scratch.
    private func teardown(reason: String) {
        housekeeping?.cancel()
        housekeeping = nil

        // Snapshotted because closeLink removes from `links`, and mutating a
        // dictionary through its own iterator is undefined behaviour.
        for link in Array(links.values) {
            closeLink(link, state: .closed, reason: reason, notify: true)
        }
        links.removeAll()
        linkIdByPeripheral.removeAll()
        linkIdByCentral.removeAll()

        if let central = centralManager {
            // stopScan on a manager that is not powered on is an API misuse
            // warning and nothing else, but there is no reason to earn one.
            if central.state == .poweredOn { central.stopScan() }
            central.delegate = nil
        }
        centralManager = nil

        if let peripheral = peripheralManager {
            if peripheral.state == .poweredOn {
                peripheral.stopAdvertising()
                if publishedPSM != 0 { peripheral.unpublishL2CAPChannel(publishedPSM) }
                peripheral.removeAllServices()
            }
            peripheral.delegate = nil
        }
        peripheralManager = nil

        gattService = nil
        rxCharacteristic = nil
        txCharacteristic = nil
        identityCharacteristic = nil
        serviceAdded = false
        publishedPSM = 0
        l2capPublishInFlight = false
        wantsAdvertising = false
        wantsScanning = false
        advertisedToken = Data()
        advertisedName = ""
        discovered.removeAll()
        knownPeripherals.removeAll()

        snapshotLock.lock()
        metricsSnapshots.removeAll()
        snapshotLock.unlock()
    }

    // MARK: - Advertising

    func startAdvertising(token: Data, displayName: String) throws {
        try requireUsableRadio()
        queue.async { [self] in
            wantsAdvertising = true
            advertisedToken = token
            advertisedName = displayName
            applyAdvertisingState()
        }
    }

    func stopAdvertising() {
        queue.async { [self] in
            wantsAdvertising = false
            if peripheralManager?.state == .poweredOn { peripheralManager?.stopAdvertising() }
        }
    }

    private func applyAdvertisingState() {
        guard let manager = peripheralManager, manager.state == .poweredOn, let serviceUUID else { return }
        guard serviceAdded else {
            addServiceIfNeeded()
            return
        }
        guard wantsAdvertising else { return }

        if manager.isAdvertising { manager.stopAdvertising() }

        /*
         * Only two keys mean anything to CBPeripheralManager - the local name
         * and the service UUIDs. There is no service data and no manufacturer
         * data on iOS, which is why the rotating token lives in the identity
         * characteristic instead of the advertisement.
         *
         * The name is included only when the user opted in. It is the peer's
         * only clue before connecting, and it is also the one thing here that a
         * stranger can read, so it is never populated from the device name.
         *
         * Backgrounded, iOS drops the local name entirely and moves the service
         * UUID into the advertising overflow area, which only another iOS device
         * explicitly scanning for that UUID can see. An Android scanner will not
         * find us at all. That is a platform fact, not a bug to engineer around;
         * the product tells the user to keep AirLink open.
         */
        var advertisement: [String: Any] = [CBAdvertisementDataServiceUUIDsKey: [serviceUUID]]
        if !advertisedName.isEmpty {
            advertisement[CBAdvertisementDataLocalNameKey] = advertisedName
        }
        manager.startAdvertising(advertisement)
    }

    // MARK: - Discovery

    func startDiscovery() throws {
        try requireUsableRadio()
        queue.async { [self] in
            wantsScanning = true
            applyScanState()
        }
    }

    func stopDiscovery() {
        queue.async { [self] in
            wantsScanning = false
            if centralManager?.state == .poweredOn { centralManager?.stopScan() }
        }
    }

    private func applyScanState() {
        guard wantsScanning, let manager = centralManager, manager.state == .poweredOn, let serviceUUID else { return }

        /*
         * The service-UUID filter is not an optimisation: background scanning
         * without one finds nothing at all on iOS. AllowDuplicates is asked for
         * because it is what makes RSSI live and lets a peer be declared lost
         * when its advertisements stop; iOS ignores it in the background, which
         * is fine, and the emission throttle below keeps it from flooding
         * JavaScript in the foreground.
         */
        manager.scanForPeripherals(
            withServices: [serviceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )

        // A peer another app on this phone already has connected never shows up
        // in a scan. Retrieving them costs nothing and turns an invisible peer
        // into a connectable one.
        for peripheral in manager.retrieveConnectedPeripherals(withServices: [serviceUUID]) {
            knownPeripherals[peripheral.identifier] = peripheral
            noteDiscovery(endpointId: peripheral.identifier.uuidString, name: "", token: "", rssi: 0)
        }
    }

    // MARK: - Connecting

    func connect(endpointId: String, timeoutMs: Int, completion: @escaping (Result<String, Error>) -> Void) {
        queue.async { [self] in
            let finish: (Result<String, Error>) -> Void = { result in
                // Never re-entrant, always on our queue.
                self.queue.async { completion(result) }
            }

            guard let manager = centralManager, serviceUUID != nil else {
                finish(.failure(AirLinkError.notStarted))
                return
            }
            guard manager.state == .poweredOn else {
                finish(.failure(errorForCurrentState()))
                return
            }
            guard let identifier = UUID(uuidString: endpointId) else {
                finish(.failure(AirLinkError.unknownEndpoint(endpointId)))
                return
            }

            // Already connected to this peer as a central: hand back the link we
            // have rather than building a second GATT client to the same device.
            if let existingId = linkIdByPeripheral[identifier], let existing = links[existingId], existing.state == .connected {
                finish(.success(existing.id))
                return
            }

            let peripheral: CBPeripheral
            if let known = knownPeripherals[identifier] {
                peripheral = known
            } else if let retrieved = manager.retrievePeripherals(withIdentifiers: [identifier]).first {
                peripheral = retrieved
            } else {
                finish(.failure(AirLinkError.unknownEndpoint(endpointId)))
                return
            }
            knownPeripherals[identifier] = peripheral
            peripheral.delegate = self

            let link = BleLink(id: makeLinkId(), role: .central, endpointId: endpointId)
            link.peripheral = peripheral
            link.connectCompletion = finish
            links[link.id] = link
            linkIdByPeripheral[identifier] = link.id
            publishMetrics(link)

            events?.linkState(linkId: link.id, state: .connecting, reason: "")

            // One timer covers connecting, service discovery and subscribing.
            // Any of them can hang on a peer that goes out of range mid-handshake
            // and CoreBluetooth's own connect has no timeout at all.
            link.connectTimer = makeTimer(afterMs: max(1_000, timeoutMs)) { [weak self, weak link] in
                guard let self, let link, self.links[link.id] != nil else { return }
                self.failConnect(link, error: AirLinkError.timeout("connecting to \(endpointId)"))
            }

            // Deliberately no auto-reconnect option: whether and when to
            // reconnect is a decision for the session layer, not the radio.
            manager.connect(peripheral, options: nil)
        }
    }

    func disconnect(linkId: String, reason: String) {
        queue.async { [self] in
            guard let link = links[linkId] else { return } // already gone: not an error
            closeLink(link, state: .closed, reason: reason.isEmpty ? "closed by request" : reason, notify: true)
        }
    }

    // MARK: - Sending

    func send(linkId: String, data: Data, reliable: Bool, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async { [self] in
            // Every completion hops the queue before it fires, which is what
            // makes rule 4 of the datagram contract - no re-entrant callbacks
            // from inside a send - true by construction rather than by review.
            let item = BleOutboundDatagram(data: data, reliable: reliable) { [queue] result in
                queue.async { completion(result) }
            }

            guard let link = links[linkId] else {
                item.finish(.failure(AirLinkError.unknownLink(linkId)))
                return
            }
            guard link.state == .connected else {
                item.finish(.failure(AirLinkError.failed("Link \(linkId) is \(link.state.rawValue)")))
                return
            }
            guard !data.isEmpty else {
                // A zero-length datagram cannot be framed unambiguously on the
                // stream path and carries nothing on the GATT one. Refusing is
                // better than having it mean different things per path.
                item.finish(.failure(AirLinkError.failed("Cannot send an empty datagram")))
                return
            }
            let limit = link.currentDatagramSize
            guard data.count <= limit else {
                // Loudly, never truncated.
                link.metrics.packetsDropped += 1
                publishMetrics(link)
                item.finish(.failure(AirLinkError.payloadTooLarge(data.count, limit)))
                return
            }

            if link.fastPath == .active, let session = link.l2cap {
                session.send(item)
                // Accounting happens on acceptance; the session settles the promise.
                link.metrics.packetsSent += 1
                link.metrics.bytesSent += Double(data.count)
                link.throughputWindowBytes += Double(data.count)
                publishMetrics(link)
                return
            }

            guard link.outbound.count < Self.maxQueuedDatagrams,
                  link.outboundBytes + data.count <= Self.maxQueuedBytes else {
                link.metrics.packetsDropped += 1
                publishMetrics(link)
                item.finish(.failure(AirLinkError.failed("Bluetooth send queue is full")))
                return
            }

            link.outbound.append(item)
            link.outboundBytes += data.count
            pumpOutbound(link)
        }
    }

    // MARK: - Metrics

    func metrics(linkId: String) -> LinkMetricsSnapshot? {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        return metricsSnapshots[linkId]
    }

    private func publishMetrics(_ link: BleLink) {
        link.metrics.maxDatagramSize = link.currentDatagramSize
        let snapshot = link.metrics
        snapshotLock.lock()
        metricsSnapshots[link.id] = snapshot
        snapshotLock.unlock()
    }

    // MARK: - Outbound pump

    /// Drains a link's queue as far as the stack will currently take it. Called
    /// on every send and on every "I can take more" callback; getting either of
    /// those wrong is how a BLE transport silently loses data.
    private func pumpOutbound(_ link: BleLink) {
        switch link.role {
        case .central:
            pumpCentralOutbound(link)
        case .peripheral:
            pumpPeripheralOutbound(link)
        }
        // The fast path is only adopted once the slow one has drained, so a
        // datagram already handed to ATT cannot be overtaken by one sent down
        // the L2CAP channel a moment later.
        if link.fastPath == .opening, link.outbound.isEmpty, link.reliableInFlight == nil {
            activatePendingFastPath(link)
        }
    }

    private func pumpCentralOutbound(_ link: BleLink) {
        guard let peripheral = link.peripheral, let rx = link.rxCharacteristic else { return }

        while let head = link.outbound.first {
            if head.reliable {
                // One outstanding write-with-response at a time. CoreBluetooth
                // will happily accept an unbounded number and queue them where
                // we cannot see or bound them; keeping it singular turns the
                // didWrite callback into real backpressure.
                guard link.reliableInFlight == nil else { return }
                link.outbound.removeFirst()
                link.outboundBytes -= head.data.count
                link.reliableInFlight = head
                peripheral.writeValue(head.data, for: rx, type: .withResponse)
                armReliableWatchdog(link)
                accountSent(link, bytes: head.data.count)
            } else {
                // Write-without-response is the fast, lossy-looking path, but it
                // is only lossy if this flag is ignored: the queue is finite and
                // a write past it is dropped by the stack with no error.
                guard peripheral.canSendWriteWithoutResponse else { return }
                link.outbound.removeFirst()
                link.outboundBytes -= head.data.count
                peripheral.writeValue(head.data, for: rx, type: .withoutResponse)
                accountSent(link, bytes: head.data.count)
                head.finish(.success(()))
            }
        }
    }

    private func pumpPeripheralOutbound(_ link: BleLink) {
        guard let manager = peripheralManager,
              let tx = txCharacteristic,
              let central = link.subscribedCentral else { return }

        while let head = link.outbound.first {
            /*
             * iOS gives a peripheral exactly one way to push bytes, so reliable
             * and best-effort share it. That is not a downgrade: a notification
             * is unacknowledged at ATT but the link layer underneath
             * retransmits until the controller acks, so the only way one is lost
             * is the connection dropping - which produces a state event. What
             * would silently drop data is ignoring this false.
             */
            guard manager.updateValue(head.data, for: tx, onSubscribedCentrals: [central]) else {
                return // wait for peripheralManagerIsReady(toUpdateSubscribers:)
            }
            link.outbound.removeFirst()
            link.outboundBytes -= head.data.count
            accountSent(link, bytes: head.data.count)
            head.finish(.success(()))
        }
    }

    private func armReliableWatchdog(_ link: BleLink) {
        link.reliableWatchdog?.cancel()
        link.reliableWatchdog = makeTimer(afterMs: Self.reliableWriteTimeoutMs) { [weak self, weak link] in
            guard let self, let link, self.links[link.id] != nil else { return }
            // An acknowledged write that is never acknowledged means the peer is
            // gone in a way the connection has not noticed yet. Failing the link
            // lets the session layer decide what to do; stalling forever does not.
            self.closeLink(link, state: .failed, reason: "peer stopped acknowledging writes", notify: true)
        }
    }

    private func accountSent(_ link: BleLink, bytes: Int) {
        link.metrics.packetsSent += 1
        link.metrics.bytesSent += Double(bytes)
        link.throughputWindowBytes += Double(bytes)
        publishMetrics(link)
    }

    private func accountReceived(_ link: BleLink, bytes: Int) {
        link.metrics.packetsReceived += 1
        link.metrics.bytesReceived += Double(bytes)
        link.throughputWindowBytes += Double(bytes)
        publishMetrics(link)
    }

    // MARK: - Link plumbing

    private func makeLinkId() -> String {
        nextLinkNumber += 1
        return "ble-\(nextLinkNumber)"
    }

    private func openLink(_ link: BleLink) {
        guard !link.opened else { return }
        link.opened = true
        link.state = .connected
        link.connectTimer?.cancel()
        link.connectTimer = nil

        let size = link.currentDatagramSize
        link.reportedDatagramSize = size
        publishMetrics(link)

        // BLE is never high bandwidth - even the L2CAP fast path lands far below
        // what a photo needs to feel instant - so this stays false and the
        // negotiation layer keeps looking for Wi-Fi.
        events?.linkOpened(
            linkId: link.id,
            transport: .ble,
            endpointId: link.endpointId,
            maxDatagramSize: size,
            highBandwidth: false,
            incoming: link.role == .peripheral
        )
        // Repeated as an mtuChanged so a listener that only watches that event
        // is correct from the first datagram.
        events?.mtuChanged(linkId: link.id, maxDatagramSize: size)
        events?.linkState(linkId: link.id, state: .connected, reason: "")

        let completion = link.connectCompletion
        link.connectCompletion = nil
        completion?(.success(link.id))
    }

    private func announceDatagramSize(_ link: BleLink) {
        let size = link.currentDatagramSize
        guard link.opened, size != link.reportedDatagramSize, size > 0 else { return }
        link.reportedDatagramSize = size
        publishMetrics(link)
        events?.mtuChanged(linkId: link.id, maxDatagramSize: size)
    }

    private func failConnect(_ link: BleLink, error: Error) {
        let completion = link.connectCompletion
        link.connectCompletion = nil
        closeLink(link, state: .failed, reason: (error as? AirLinkError)?.message ?? error.localizedDescription, notify: completion == nil)
        completion?(.failure(error))
    }

    /// The single exit for a link. Idempotent, so a disconnect racing a
    /// stream error cannot emit two closed events or settle a promise twice.
    private func closeLink(_ link: BleLink, state: LinkState, reason: String, notify: Bool) {
        guard links.removeValue(forKey: link.id) != nil else { return }
        link.cancelTimers()
        link.state = state

        link.l2cap?.onClosed = nil
        link.l2cap?.onDatagram = nil
        link.l2cap?.close(reason: reason)
        link.l2cap = nil
        link.fastPath = .unavailable

        let pending = link.outbound
        link.outbound.removeAll()
        link.outboundBytes = 0
        if let inFlight = link.reliableInFlight {
            link.reliableInFlight = nil
            inFlight.finish(.failure(AirLinkError.failed("Link closed: \(reason)")))
        }
        for item in pending {
            link.metrics.packetsDropped += 1
            item.finish(.failure(AirLinkError.failed("Link closed: \(reason)")))
        }

        switch link.role {
        case .central:
            if let peripheral = link.peripheral {
                linkIdByPeripheral.removeValue(forKey: peripheral.identifier)
                if let manager = centralManager, manager.state == .poweredOn,
                   peripheral.state == .connected || peripheral.state == .connecting {
                    manager.cancelPeripheralConnection(peripheral)
                }
            }
        case .peripheral:
            if let central = link.subscribedCentral {
                linkIdByCentral.removeValue(forKey: central.identifier)
            }
        }

        snapshotLock.lock()
        metricsSnapshots.removeValue(forKey: link.id)
        snapshotLock.unlock()

        if notify {
            events?.linkState(linkId: link.id, state: state, reason: reason)
        }

        let completion = link.connectCompletion
        link.connectCompletion = nil
        completion?(.failure(AirLinkError.failed(reason)))
    }

    private func activeLink(forPeripheral identifier: UUID) -> BleLink? {
        guard let id = linkIdByPeripheral[identifier] else { return nil }
        return links[id]
    }

    private func activeLink(forCentral identifier: UUID) -> BleLink? {
        guard let id = linkIdByCentral[identifier] else { return nil }
        return links[id]
    }

    // MARK: - L2CAP upgrade

    /// Central side: the peer told us its PSM, so try the fast path.
    private func beginL2CAPUpgrade(_ link: BleLink) {
        guard link.fastPath == .none, link.remotePSM != 0, let peripheral = link.peripheral else { return }
        link.fastPath = .opening
        link.l2capTimer = makeTimer(afterMs: Self.l2capOpenTimeoutMs) { [weak self, weak link] in
            guard let self, let link, link.fastPath == .opening else { return }
            self.abandonFastPath(link, reason: "L2CAP channel did not open in time")
        }
        peripheral.openL2CAPChannel(link.remotePSM)
        log("info", "link \(link.id): opening L2CAP channel on PSM \(link.remotePSM)")
    }

    private func adopt(channel: CBL2CAPChannel, for link: BleLink) {
        link.l2capTimer?.cancel()
        link.l2capTimer = nil

        guard let session = BleL2CAPSession(channel: channel, callbackQueue: queue) else {
            abandonFastPath(link, reason: "L2CAP channel had no streams")
            return
        }
        session.onDatagram = { [weak self, weak link] datagram in
            guard let self, let link, self.links[link.id] != nil else { return }
            self.accountReceived(link, bytes: datagram.count)
            self.events?.received(linkId: link.id, data: datagram)
        }
        session.onClosed = { [weak self, weak link] reason, unsent in
            guard let self, let link else { return }
            self.handleFastPathClosed(link, reason: reason, unsent: unsent)
        }
        link.l2cap = session
        session.open()

        // Do not start using it until the GATT queue is empty; see pumpOutbound.
        link.fastPath = .opening
        pumpOutbound(link)
    }

    private func activatePendingFastPath(_ link: BleLink) {
        guard link.fastPath == .opening, link.l2cap != nil else { return }
        link.fastPath = .active
        announceDatagramSize(link)
        log("info", "link \(link.id): L2CAP active, datagrams up to \(BleL2CAPSession.maxDatagramSize) bytes")
    }

    private func abandonFastPath(_ link: BleLink, reason: String) {
        guard link.fastPath != .unavailable else { return }
        link.l2capTimer?.cancel()
        link.l2capTimer = nil
        link.l2cap?.onClosed = nil
        link.l2cap?.onDatagram = nil
        link.l2cap?.close(reason: reason)
        link.l2cap = nil
        link.fastPath = .unavailable
        announceDatagramSize(link)
        log("warn", "link \(link.id): staying on GATT - \(reason)")
    }

    /// The fast path died under traffic. The link does not: GATT still works,
    /// and the session above is not told anything happened beyond a smaller MTU.
    private func handleFastPathClosed(_ link: BleLink, reason: String?, unsent: [BleOutboundDatagram]) {
        guard links[link.id] != nil else {
            for item in unsent { item.finish(.failure(AirLinkError.failed("Link closed"))) }
            return
        }

        link.l2cap = nil
        link.l2capTimer?.cancel()
        link.l2capTimer = nil
        link.fastPath = .unavailable

        // Back onto the GATT queue, in order, ahead of anything queued since.
        // These provably never reached the peer, so this cannot duplicate.
        var requeued = 0
        var rejected = 0
        for item in unsent.reversed() where !item.isSettled {
            guard item.data.count <= link.gattDatagramSize,
                  link.outbound.count < Self.maxQueuedDatagrams,
                  link.outboundBytes + item.data.count <= Self.maxQueuedBytes else {
                // A datagram sized for a 64 KiB channel does not fit an ATT
                // write. Failing it is the honest answer - the layer above
                // fragments to the MTU it has just been told about.
                rejected += 1
                link.metrics.packetsDropped += 1
                item.finish(.failure(AirLinkError.payloadTooLarge(item.data.count, link.gattDatagramSize)))
                continue
            }
            link.outbound.insert(item, at: 0)
            link.outboundBytes += item.data.count
            requeued += 1
        }

        announceDatagramSize(link)
        log("warn", "link \(link.id): L2CAP dropped (\(reason ?? "closed")); \(requeued) datagram(s) re-queued on GATT, \(rejected) too large to re-queue")
        pumpOutbound(link)
    }

    private func publishL2CAPChannelIfNeeded() {
        guard let manager = peripheralManager, manager.state == .poweredOn else { return }
        guard publishedPSM == 0, !l2capPublishInFlight else { return }
        l2capPublishInFlight = true
        /*
         * withEncryption: false, deliberately.
         *
         * Requiring link-layer encryption forces an OS pairing ceremony - a
         * system dialog, a bond stored on both phones - which is the opposite of
         * "two people open the app and it just works", and it is the part of BLE
         * that interoperates worst between iPhone and Android. Nothing is given
         * up by declining it: every byte that crosses this channel is already
         * inside a ChaCha20-Poly1305 session whose keys came from an
         * authenticated SIGMA-I handshake, so the L2CAP channel is carrying
         * ciphertext either way.
         */
        manager.publishL2CAPChannel(withEncryption: false)
    }

    // MARK: - Housekeeping

    private func startHousekeeping() {
        housekeeping?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(Self.housekeepingIntervalMs),
                       repeating: .milliseconds(Self.housekeepingIntervalMs))
        timer.setEventHandler { [weak self] in self?.houseKeepingTick() }
        timer.resume()
        housekeeping = timer
    }

    private func houseKeepingTick() {
        let now = CFAbsoluteTimeGetCurrent()

        // Peers whose advertisements stopped. A peer we hold a link to is never
        // reported lost: the link is better evidence than the beacon.
        var expired: [DiscoveryRecord] = []
        for (endpointId, record) in Array(discovered) {
            guard (now - record.lastSeen) * 1000 > Self.discoveryExpiryMs else { continue }
            if let identifier = UUID(uuidString: endpointId), linkIdByPeripheral[identifier] != nil { continue }
            expired.append(record)
            discovered.removeValue(forKey: endpointId)
        }
        for record in expired { events?.peerLost(record.endpoint) }

        for link in Array(links.values) {
            // RSSI, and a re-read of the negotiated write length: iOS raises the
            // ATT MTU shortly after connecting and there is no callback for it,
            // so the only honest way to report a change is to look again.
            if link.role == .central, let peripheral = link.peripheral, peripheral.state == .connected {
                peripheral.readRSSI()
            }
            refreshGattDatagramSize(link)

            let elapsed = max(0.001, now - link.lastThroughputSample)
            let instant = link.throughputWindowBytes / elapsed
            // Smoothed, because a BLE connection interval makes the raw number
            // jump between zero and a burst several times a second.
            link.metrics.throughput = link.metrics.throughput == 0
                ? instant
                : link.metrics.throughput * 0.6 + instant * 0.4
            link.throughputWindowBytes = 0
            link.lastThroughputSample = now
            publishMetrics(link)
        }
    }

    private func refreshGattDatagramSize(_ link: BleLink) {
        let size: Int
        switch link.role {
        case .central:
            guard let peripheral = link.peripheral else { return }
            /*
             * There is no API to request an ATT MTU on iOS; the stack negotiates
             * one and this is how you read what you were given. The minimum of
             * the two is used because a reliable send must fit in a single ATT
             * Write Request: past that CoreBluetooth switches to a prepared long
             * write, which arrives at the peer as several offset fragments and
             * is a different contract entirely. withResponse reports the 512-byte
             * attribute ceiling, withoutResponse reports ATT_MTU - 3, so in
             * practice this is the latter.
             */
            size = max(20, min(peripheral.maximumWriteValueLength(for: .withoutResponse),
                               peripheral.maximumWriteValueLength(for: .withResponse)))
        case .peripheral:
            guard let central = link.subscribedCentral else { return }
            size = max(20, central.maximumUpdateValueLength)
        }
        guard size != link.gattDatagramSize else { return }
        link.gattDatagramSize = size
        announceDatagramSize(link)
    }

    // MARK: - Discovery bookkeeping

    private func noteDiscovery(endpointId: String, name: String, token: String, rssi: Int) {
        let now = CFAbsoluteTimeGetCurrent()

        guard let previous = discovered[endpointId] else {
            let record = DiscoveryRecord(
                endpointId: endpointId, name: name, token: token, rssi: rssi,
                lastSeen: now, lastEmitted: now, lastEmittedRssi: rssi
            )
            discovered[endpointId] = record
            events?.peerDiscovered(record.endpoint)
            return
        }

        // Fields are only ever filled in, never blanked: a scan response without
        // a name does not mean the peer lost the one it advertised a moment ago,
        // and the identity read fills in a token the advertisement could not
        // carry at all.
        var record = previous
        if !name.isEmpty { record.name = name }
        if !token.isEmpty { record.token = token }
        if rssi != 0 { record.rssi = rssi }
        record.lastSeen = now
        discovered[endpointId] = record

        let learnedSomething = record.name != previous.name || record.token != previous.token
        let movedSignal = abs(record.rssi - record.lastEmittedRssi) >= Self.rssiChangeThreshold
        let stale = (now - record.lastEmitted) * 1000 >= Self.rediscoveryThrottleMs
        guard learnedSomething || movedSignal || stale else { return }

        record.lastEmitted = now
        record.lastEmittedRssi = record.rssi
        discovered[endpointId] = record
        events?.peerDiscovered(record.endpoint)
    }

    // MARK: - Helpers

    private func requireUsableRadio() throws {
        let state = availability()
        guard !state.available else { return }
        switch state.reason {
        case .permissionDenied: throw AirLinkError.permissionDenied(.ble)
        case .radioOff: throw AirLinkError.radioOff(.ble)
        case .unsupportedHardware: throw AirLinkError.unsupported("Bluetooth Low Energy")
        default:
            // .permissionNotRequested means the managers have not settled yet.
            // The intent is recorded and applied the moment they do, so this is
            // not an error - answering with one would make the very first launch
            // fail for no reason.
            return
        }
    }

    private func errorForCurrentState() -> AirLinkError {
        let state = availability()
        switch state.reason {
        case .permissionDenied: return .permissionDenied(.ble)
        case .radioOff: return .radioOff(.ble)
        case .unsupportedHardware: return .unsupported("Bluetooth Low Energy")
        default: return .failed("Bluetooth is not ready yet")
        }
    }

    private func makeTimer(afterMs: Int, _ body: @escaping () -> Void) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(max(1, afterMs)))
        timer.setEventHandler(handler: body)
        timer.resume()
        return timer
    }

    /// CBUUID's initialiser raises an Objective-C exception on a malformed
    /// string, and Swift cannot catch that - it is an immediate crash. Every
    /// UUID reaching CoreBluetooth from JavaScript goes through here first.
    private static func parseUUID(_ raw: String) -> CBUUID? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let hex = trimmed.replacingOccurrences(of: "-", with: "")
        guard hex.count == 4 || hex.count == 8 || hex.count == 32 else { return nil }
        guard hex.allSatisfy({ $0.isHexDigit }) else { return nil }
        return CBUUID(string: trimmed)
    }

    private func log(_ level: String, _ message: String) {
        events?.log(level: level, scope: "ble", message: message)
    }
}

// MARK: - CBCentralManagerDelegate

extension BleTransport: CBCentralManagerDelegate {

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        refreshAvailability()
        switch central.state {
        case .poweredOn:
            applyScanState()
        default:
            // The radio going away mid-session is a clean state event, not a
            // crash and not silence. Central-role links are gone; peripheral-role
            // ones are the peripheral manager's to mourn.
            let reason = central.state == .poweredOff ? "Bluetooth was switched off" : "Bluetooth became unavailable"
            for link in Array(links.values) where link.role == .central {
                closeLink(link, state: .failed, reason: reason, notify: true)
            }
            for record in discovered.values { events?.peerLost(record.endpoint) }
            discovered.removeAll()
        }
    }

    /**
     * Restoration. iOS relaunches the app to hand it a Bluetooth event and gives
     * back whatever the previous instance had going. Peripherals still connected
     * are re-adopted and re-discovered so they become usable links again; ones
     * that are not are simply remembered, so a later connect() can find them
     * without a scan. Nothing here decides to reconnect - the OS kept these
     * alive, we are only picking the thread back up.
     */
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        for peripheral in restored {
            knownPeripherals[peripheral.identifier] = peripheral
            peripheral.delegate = self
            guard peripheral.state == .connected, linkIdByPeripheral[peripheral.identifier] == nil else { continue }

            let link = BleLink(id: makeLinkId(), role: .central, endpointId: peripheral.identifier.uuidString)
            link.peripheral = peripheral
            links[link.id] = link
            linkIdByPeripheral[peripheral.identifier] = link.id
            publishMetrics(link)
            events?.linkState(linkId: link.id, state: .connecting, reason: "restored")
            link.connectTimer = makeTimer(afterMs: 20_000) { [weak self, weak link] in
                guard let self, let link, self.links[link.id] != nil, !link.opened else { return }
                self.closeLink(link, state: .failed, reason: "restored link never became usable", notify: true)
            }
            if let serviceUUID { peripheral.discoverServices([serviceUUID]) }
        }
        if (dict[CBCentralManagerRestoredStateScanServicesKey] as? [CBUUID])?.isEmpty == false {
            wantsScanning = true
        }
        log("info", "restored \(restored.count) peripheral(s)")
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        knownPeripherals[peripheral.identifier] = peripheral

        /*
         * The advertised local name only - never peripheral.name, which is the
         * GAP device name and is usually the owner's first name attached to
         * their phone. Broadcasting that because it was convenient would be a
         * privacy leak the user never agreed to.
         */
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? ""

        // An iOS advertiser cannot carry service data, so this is empty when the
        // peer is an iPhone; the token is read from the identity characteristic
        // after connecting instead. An Android advertiser can and does put it
        // here, which is why it is worth looking.
        var token = ""
        if let serviceUUID,
           let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
           let raw = serviceData[serviceUUID], !raw.isEmpty,
           raw.count <= BleIdentityRecord.maxTokenLength {
            token = raw.base64EncodedString()
        }

        let rssi = RSSI.intValue
        noteDiscovery(
            endpointId: peripheral.identifier.uuidString,
            name: name,
            token: token,
            // 127 is CoreBluetooth's "not available"; report 0, which the
            // contract defines as "this transport did not say".
            rssi: rssi == 127 ? 0 : rssi
        )
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard activeLink(forPeripheral: peripheral.identifier) != nil, let serviceUUID else { return }
        peripheral.delegate = self
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard let link = activeLink(forPeripheral: peripheral.identifier) else { return }
        failConnect(link, error: AirLinkError.failed(error?.localizedDescription ?? "connection failed"))
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        handleDisconnect(peripheral, isReconnecting: false, error: error)
    }

    /// iOS 17 added a richer disconnect callback that also says whether the
    /// stack means to reconnect on its own. When it is implemented CoreBluetooth
    /// calls it *instead of* the one above, and an older iOS simply never knows
    /// the selector exists - so implementing both is the runtime capability
    /// check, and the shared handler is idempotent so either route is safe.
    /// The SDK back-dates its availability annotation, so no @available is
    /// needed or wanted here.
    func centralManager(_ central: CBCentralManager,
                        didDisconnectPeripheral peripheral: CBPeripheral,
                        timestamp: CFAbsoluteTime,
                        isReconnecting: Bool,
                        error: Error?) {
        handleDisconnect(peripheral, isReconnecting: isReconnecting, error: error)
    }

    private func handleDisconnect(_ peripheral: CBPeripheral, isReconnecting: Bool, error: Error?) {
        guard let link = activeLink(forPeripheral: peripheral.identifier) else { return }
        // We never ask for auto-reconnect - when to come back is the session
        // layer's decision - so this flag should always be false. If a future
        // iOS sets it anyway, reporting the link as closed is still correct;
        // the layer above will open a new one.
        let detail = error?.localizedDescription ?? (isReconnecting ? "peer disconnected, stack is retrying" : "peer disconnected")
        if link.opened {
            closeLink(link, state: .closed, reason: detail, notify: true)
        } else {
            failConnect(link, error: AirLinkError.failed(detail))
        }
    }
}

// MARK: - CBPeripheralDelegate (central role)

extension BleTransport: CBPeripheralDelegate {

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let link = activeLink(forPeripheral: peripheral.identifier) else { return }
        if let error {
            failConnect(link, error: AirLinkError.failed("service discovery failed: \(error.localizedDescription)"))
            return
        }
        guard let serviceUUID, let rxUUID, let txUUID,
              let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            failConnect(link, error: AirLinkError.failed("peer does not expose the AirLink service"))
            return
        }
        peripheral.discoverCharacteristics([rxUUID, txUUID, identityUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let link = activeLink(forPeripheral: peripheral.identifier) else { return }
        if let error {
            failConnect(link, error: AirLinkError.failed("characteristic discovery failed: \(error.localizedDescription)"))
            return
        }
        guard let rxUUID, let txUUID else { return }

        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case rxUUID: link.rxCharacteristic = characteristic
            case txUUID: link.txCharacteristic = characteristic
            case identityUUID: link.identityCharacteristic = characteristic
            default: break
            }
        }

        guard link.rxCharacteristic != nil, let tx = link.txCharacteristic else {
            failConnect(link, error: AirLinkError.failed("peer is missing an AirLink characteristic"))
            return
        }
        refreshGattDatagramSize(link)
        peripheral.setNotifyValue(true, for: tx)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard let link = activeLink(forPeripheral: peripheral.identifier), characteristic.uuid == txUUID else { return }
        if let error {
            failConnect(link, error: AirLinkError.failed("could not subscribe: \(error.localizedDescription)"))
            return
        }
        guard characteristic.isNotifying else { return }

        link.notificationsEnabled = true
        refreshGattDatagramSize(link)
        // Usable now: we can write to RX and we will be told about TX. The
        // identity read that follows is an upgrade, not a precondition - waiting
        // for it would add a round trip to every single connection.
        openLink(link)

        if let identity = link.identityCharacteristic {
            link.identityTimer = makeTimer(afterMs: Self.identityReadTimeoutMs) { [weak self, weak link] in
                guard let self, let link, link.fastPath == .none else { return }
                link.identityTimer = nil
                self.log("info", "link \(link.id): no identity read, staying on GATT")
                link.fastPath = .unavailable
            }
            peripheral.readValue(for: identity)
        } else {
            link.fastPath = .unavailable
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let link = activeLink(forPeripheral: peripheral.identifier) else { return }
        if error != nil { return }
        guard let value = characteristic.value, !value.isEmpty else { return }

        if characteristic.uuid == txUUID {
            // One notification is one datagram: ATT preserved the boundary, so
            // there is nothing to un-frame here.
            guard value.count <= Self.maxInboundGattDatagram else {
                link.metrics.packetsDropped += 1
                publishMetrics(link)
                return
            }
            accountReceived(link, bytes: value.count)
            events?.received(linkId: link.id, data: value)
            return
        }

        if characteristic.uuid == identityUUID {
            link.identityTimer?.cancel()
            link.identityTimer = nil
            guard let record = BleIdentityRecord.decode(value) else {
                link.fastPath = .unavailable
                return
            }
            // Now we can tell JavaScript who this is. An iOS peer had nowhere to
            // put its token in the advertisement, so this is the first moment a
            // paired friend becomes recognisable.
            if !record.token.isEmpty || !record.displayName.isEmpty {
                noteDiscovery(
                    endpointId: link.endpointId,
                    name: record.displayName,
                    token: record.token.base64EncodedString(),
                    rssi: link.metrics.rssi
                )
            }
            if record.psm != 0 {
                link.remotePSM = record.psm
                beginL2CAPUpgrade(link)
            } else {
                link.fastPath = .unavailable
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let link = activeLink(forPeripheral: peripheral.identifier), characteristic.uuid == rxUUID else { return }
        link.reliableWatchdog?.cancel()
        link.reliableWatchdog = nil

        let inFlight = link.reliableInFlight
        link.reliableInFlight = nil

        if let error {
            link.metrics.packetsDropped += 1
            publishMetrics(link)
            inFlight?.finish(.failure(AirLinkError.failed("write failed: \(error.localizedDescription)")))
        } else {
            inFlight?.finish(.success(()))
        }
        pumpOutbound(link)
    }

    /// The stack's write-without-response queue has room again. Ignoring this is
    /// the classic way to lose data on iOS without a single error being reported.
    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        guard let link = activeLink(forPeripheral: peripheral.identifier) else { return }
        pumpOutbound(link)
    }

    func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        guard error == nil, let link = activeLink(forPeripheral: peripheral.identifier) else { return }
        let value = RSSI.intValue
        link.metrics.rssi = value == 127 ? 0 : value
        publishMetrics(link)
    }

    func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
        guard let serviceUUID, invalidatedServices.contains(where: { $0.uuid == serviceUUID }) else { return }
        guard let link = activeLink(forPeripheral: peripheral.identifier) else { return }
        // The peer tore down and rebuilt its GATT database - usually the app
        // restarting. Our characteristic handles are stale, so the link is over.
        closeLink(link, state: .closed, reason: "peer restarted its Bluetooth service", notify: true)
    }

    /// Central side of the L2CAP upgrade. The Swift selector is
    /// `peripheral(_:didOpen:error:)`; `didOpenL2CAPChannel` was obsoleted in
    /// Swift 3 and does not exist to be implemented.
    func peripheral(_ peripheral: CBPeripheral, didOpen channel: CBL2CAPChannel?, error: Error?) {
        guard let link = activeLink(forPeripheral: peripheral.identifier) else {
            return
        }
        guard let channel, error == nil else {
            abandonFastPath(link, reason: error?.localizedDescription ?? "channel did not open")
            return
        }
        adopt(channel: channel, for: link)
    }
}

// MARK: - CBPeripheralManagerDelegate (peripheral role)

extension BleTransport: CBPeripheralManagerDelegate {

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        refreshAvailability()
        switch peripheral.state {
        case .poweredOn:
            addServiceIfNeeded()
        default:
            // Everything the peripheral manager owned is gone: services are
            // dropped, the PSM is unpublished, subscriptions are void.
            serviceAdded = false
            gattService = nil
            publishedPSM = 0
            l2capPublishInFlight = false
            let reason = peripheral.state == .poweredOff ? "Bluetooth was switched off" : "Bluetooth became unavailable"
            for link in Array(links.values) where link.role == .peripheral {
                closeLink(link, state: .failed, reason: reason, notify: true)
            }
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String: Any]) {
        // Re-adopt the service the previous instance published rather than
        // adding a second copy of it, which CoreBluetooth would reject.
        if let services = dict[CBPeripheralManagerRestoredStateServicesKey] as? [CBMutableService],
           let serviceUUID,
           let restored = services.first(where: { $0.uuid == serviceUUID }) {
            gattService = restored
            serviceAdded = true
            for characteristic in restored.characteristics ?? [] {
                guard let mutable = characteristic as? CBMutableCharacteristic else { continue }
                if mutable.uuid == rxUUID {
                    rxCharacteristic = mutable
                } else if mutable.uuid == txUUID {
                    txCharacteristic = mutable
                } else if mutable.uuid == identityUUID {
                    identityCharacteristic = mutable
                }
            }
        }
        if dict[CBPeripheralManagerRestoredStateAdvertisementDataKey] != nil {
            wantsAdvertising = true
        }
        log("info", "peripheral state restored")
    }

    private func addServiceIfNeeded() {
        guard let manager = peripheralManager, manager.state == .poweredOn else { return }
        guard !serviceAdded, gattService == nil, let serviceUUID, let rxUUID, let txUUID else {
            applyAdvertisingState()
            return
        }

        // RX accepts both write types so a peer can choose per datagram: a
        // command for the realtime game channel, a request when it wants the
        // acknowledgement. Permissions stay open because the payload is already
        // end-to-end encrypted - demanding an encrypted ATT link here would mean
        // an OS pairing dialog for no additional secrecy.
        let rx = CBMutableCharacteristic(
            type: rxUUID,
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable]
        )
        let tx = CBMutableCharacteristic(
            type: txUUID,
            properties: [.notify],
            value: nil,
            permissions: [.readable]
        )
        // value: nil so it is answered dynamically - the PSM appears after the
        // service does, and the token rotates underneath it.
        let identity = CBMutableCharacteristic(
            type: identityUUID,
            properties: [.read],
            value: nil,
            permissions: [.readable]
        )

        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [rx, tx, identity]

        rxCharacteristic = rx
        txCharacteristic = tx
        identityCharacteristic = identity
        gattService = service

        manager.add(service)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            serviceAdded = false
            gattService = nil
            log("error", "could not publish the AirLink GATT service: \(error.localizedDescription)")
            return
        }
        serviceAdded = true
        publishL2CAPChannelIfNeeded()
        applyAdvertisingState()
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error {
            log("error", "advertising failed: \(error.localizedDescription)")
        } else if advertisedName.isEmpty {
            log("info", "advertising the AirLink service, no display name")
        } else {
            log("info", "advertising the AirLink service as '\(advertisedName)'")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didPublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?) {
        l2capPublishInFlight = false
        if let error {
            // No fast path to offer. GATT alone is the product's floor and it
            // works, so this is a log line, not a failure.
            log("warn", "L2CAP channel not published: \(error.localizedDescription)")
            return
        }
        publishedPSM = PSM
        log("info", "L2CAP channel published on PSM \(PSM)")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didUnpublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?) {
        if publishedPSM == PSM { publishedPSM = 0 }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard characteristic.uuid == txUUID else { return }
        if let existing = activeLink(forCentral: central.identifier), existing.opened { return }

        // The peer subscribing is the peripheral-side definition of "connected":
        // it can now hear us, and it already knows how to write to us.
        let link = BleLink(id: makeLinkId(), role: .peripheral, endpointId: central.identifier.uuidString)
        link.subscribedCentral = central
        link.gattDatagramSize = max(20, central.maximumUpdateValueLength)
        links[link.id] = link
        linkIdByCentral[central.identifier] = link.id

        // Ask for the tightest connection interval the stack will give us. It is
        // a hint, not a guarantee, and it is the single biggest lever on BLE
        // latency that a peripheral has.
        peripheral.setDesiredConnectionLatency(.low, for: central)

        openLink(link)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard characteristic.uuid == txUUID, let link = activeLink(forCentral: central.identifier) else { return }
        closeLink(link, state: .closed, reason: "peer unsubscribed", notify: true)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == identityUUID else {
            peripheral.respond(to: request, withResult: .requestNotSupported)
            return
        }
        let record = BleIdentityRecord.encode(
            token: advertisedToken,
            displayName: advertisedName,
            psm: publishedPSM
        )
        guard request.offset <= record.count else {
            peripheral.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = record.subdata(in: request.offset ..< record.count)
        peripheral.respond(to: request, withResult: .success)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }

        /*
         * Exactly one response per invocation, always, using the first request.
         *
         * A Write Request that is never answered wedges the central's ATT queue
         * for the life of the connection, and CBATTRequest does not say which
         * write type it came from - our RX characteristic accepts both, so there
         * is nothing to branch on. CoreBluetooth discards the response for a
         * write-command, so answering unconditionally is the only rule that is
         * safe in both directions.
         */
        var result: CBATTError.Code = .success
        var sawWritableCharacteristic = false
        var datagrams: [(central: CBCentral, data: Data)] = []
        var currentCentral: CBCentral?
        var currentData = Data()

        for request in requests {
            guard request.characteristic.uuid == rxUUID else { continue }
            sawWritableCharacteristic = true
            let value = request.value ?? Data()

            if request.offset == 0 {
                /*
                 * Offset zero starts a datagram. Several independent
                 * write-commands can arrive in one array, and a single long
                 * write arrives as contiguous offsets - this distinguishes them,
                 * which is the difference between N datagrams and one.
                 */
                if let central = currentCentral { datagrams.append((central, currentData)) }
                currentCentral = request.central
                currentData = value
            } else if let central = currentCentral,
                      central.identifier == request.central.identifier,
                      request.offset == currentData.count {
                currentData.append(value)
            } else {
                result = .invalidOffset
                currentCentral = nil
                currentData = Data()
                break
            }

            // A peer decides how long its writes are; we decide how much we are
            // willing to hold for it.
            if currentData.count > Self.maxInboundGattDatagram {
                result = .invalidAttributeValueLength
                currentCentral = nil
                currentData = Data()
                break
            }
        }
        if let central = currentCentral { datagrams.append((central, currentData)) }
        if !sawWritableCharacteristic { result = .writeNotPermitted }

        peripheral.respond(to: first, withResult: result)

        for entry in datagrams where !entry.data.isEmpty {
            guard let link = activeLink(forCentral: entry.central.identifier) else { continue }
            accountReceived(link, bytes: entry.data.count)
            events?.received(linkId: link.id, data: entry.data)
        }
    }

    /// The notification queue drained. Every peripheral-role link shares it, so
    /// every one of them gets a chance to move.
    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        for link in Array(links.values) where link.role == .peripheral {
            pumpOutbound(link)
        }
    }

    /// Peripheral side of the L2CAP upgrade: a central opened the channel whose
    /// PSM it read out of our identity characteristic.
    func peripheralManager(_ peripheral: CBPeripheralManager, didOpen channel: CBL2CAPChannel?, error: Error?) {
        guard let channel, error == nil else {
            log("warn", "inbound L2CAP channel failed: \(error?.localizedDescription ?? "unknown")")
            return
        }
        guard let peer = channel.peer as? CBCentral, let link = activeLink(forCentral: peer.identifier) else {
            // A channel we cannot attribute to a link is a channel we can never
            // read from. Closing its streams is the only way not to leak it.
            channel.inputStream?.close()
            channel.outputStream?.close()
            log("warn", "closing an L2CAP channel from an unknown central")
            return
        }
        guard link.fastPath == .none else { return }
        adopt(channel: channel, for: link)
    }
}
