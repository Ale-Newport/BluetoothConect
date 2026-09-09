import Foundation
import Network

/**
 * Network.framework transport: Bonjour discovery plus TCP, over either an
 * existing local Wi-Fi network or Apple peer-to-peer Wi-Fi.
 *
 * ONE CODE PATH, TWO REACH PROFILES. The bridge builds two instances of this
 * class. The only behavioural difference between them is one flag:
 *
 *   .localNetwork    includePeerToPeer = false. Needs a network both phones have
 *                    joined - a router, plane Wi-Fi, or a peer's hotspot. Works
 *                    between iOS and Android, because it is just Bonjour + TCP.
 *   .peerToPeerWifi  includePeerToPeer = true. Needs no network at all: the OS
 *                    brings up an AWDL link between the two devices. Apple only.
 *                    TN3151 is unambiguous - the on-the-wire protocol is not
 *                    documented for third-party use, so an Android phone cannot
 *                    join. We never advertise this as a cross-platform path.
 *
 * Apple's peer-to-peer support is Bonjour-gated: it only engages for an
 * NWListener that advertises a service and an NWConnection/NWBrowser aimed at
 * one. The classic bug is setting includePeerToPeer on the listener alone, so
 * `makeParameters()` is the single place it is set and every listener, browser
 * and connection in this file is built from it.
 *
 * NO PROTOCOL KNOWLEDGE. This file frames, moves and counts opaque bytes. It
 * never looks inside a datagram, never adds a protocol header, and never
 * decides to reconnect - that is the TypeScript layer's job.
 *
 * SECURITY POSTURE - why a plain TCP socket is acceptable here. Everything that
 * crosses this link is already an AirLink frame: a SIGMA-I handshake, or a
 * ChaCha20-Poly1305 sealed frame bound to a mutually authenticated session.
 * Adding TLS underneath would encrypt ciphertext, authenticate a second
 * identity nobody checks, and cost a second handshake round trip on a transport
 * whose whole reason to exist is speed. The property that actually matters -
 * that an eavesdropper on the same Wi-Fi learns nothing and cannot inject - is
 * provided one layer up and is tested there. What TLS *would* add is metadata
 * hiding of the frame lengths, which the fragmentation layer already blurs.
 *
 * BACKGROUNDING. There is no background mode that keeps an NWListener or an
 * NWBrowser alive; AirLink only holds bluetooth-central/bluetooth-peripheral.
 * When the app is backgrounded these sockets are torn down by the system and
 * the links here report closed. That is honest and expected: BLE is the floor
 * that survives, and this transport is the upgrade you get while the app is
 * open. Nothing in this file pretends otherwise.
 */

/// Framing and buffer limits. Every one of these bounds memory a peer controls.
private enum NetworkFraming {
    /// Big-endian u32 length prefix. TCP is a byte stream and the contract above
    /// this layer is datagram-oriented, so the boundary has to be carried.
    static let lengthPrefixBytes = 4

    /// What we advertise to JavaScript as the largest single datagram.
    ///
    /// Framing makes this number arbitrary, so it is chosen rather than
    /// discovered: 64 KB is large enough that the fragmentation layer becomes a
    /// no-op for chat and for file chunks, and small enough that one datagram in
    /// flight per direction cannot bloat a phone's memory.
    static let maxDatagramSize = 64 * 1024

    /// Hard ceiling on a length prefix we will honour on receive.
    ///
    /// Deliberately larger than what we advertise. A peer running a slightly
    /// different build might legitimately use a bigger datagram, and killing a
    /// working link over that would be a miserable failure mode; MAX_FRAME_BYTES
    /// in the protocol layer is 256 KB, so nothing legitimate can ever exceed
    /// it. Anything larger is a desynchronised or hostile stream and the link is
    /// closed rather than allocated for.
    static let receiveHardLimit = 256 * 1024

    /// Bytes handed to the socket but not yet processed, above which a REALTIME
    /// datagram is dropped instead of queued. Realtime state is superseded by
    /// the next update, so queueing it behind a backlog is strictly worse than
    /// dropping it.
    static let realtimeHighWaterMark = 128 * 1024

    /// Absolute cap on unprocessed send bytes. Past this a reliable send is
    /// rejected loudly rather than growing an unbounded queue in a phone's RAM;
    /// the reliability layer above will retry.
    static let sendQueueHardLimit = 4 * 1024 * 1024

    /// Concurrent links this transport will hold. Bounds what an unfriendly
    /// device on the same Wi-Fi can make us allocate by connecting repeatedly.
    static let maxConcurrentLinks = 16

    /// Discovered endpoints remembered at once, so a busy network cannot grow
    /// the table without limit.
    static let maxRememberedEndpoints = 64
}

/// Timeouts. Anything that can hang on a phone in a pocket has one.
private enum NetworkTiming {
    static let minimumConnectTimeoutMs = 1_000
    static let maximumConnectTimeoutMs = 120_000
    /// How long a connection may report "not viable" before we call it dead.
    /// Short outages (a Wi-Fi roam) recover well inside this; a radio switched
    /// off never does.
    static let viabilityGraceSeconds = 6.0
    /// Backstop for close(): if Network.framework never reports .cancelled we
    /// still owe JavaScript a closed event.
    static let closeWatchdogSeconds = 3.0
    /// Backoff for restarting a browser or listener the system failed.
    static let restartBackoffSeconds: [Double] = [1, 2, 4]
}

/// TXT record keys. Short because a Bonjour TXT record is a scarce resource.
private enum NetworkTxtKey {
    static let token = "tk"
    static let displayName = "dn"
}

/**
 * One TCP connection, plus everything needed to frame and account for it.
 *
 * Queue-confined: every property is touched only on the transport's serial
 * queue, which is also the queue Network.framework was given, so its callbacks
 * arrive already serialised with our own work. `@unchecked Sendable` records
 * that promise - the compiler cannot verify queue confinement.
 */
private final class NetworkPeerLink: @unchecked Sendable {
    let id: String
    let endpointId: String
    let connection: NWConnection
    let incoming: Bool

    /// True once .ready has been seen and linkOpened has been emitted. Until
    /// then this link does not exist as far as JavaScript is concerned, so no
    /// state event may be emitted for it.
    var isOpen = false
    /// Set the moment a terminal state is reported, so closed/failed is emitted
    /// exactly once no matter which path gets there first.
    var didReportTerminal = false
    /// Non-nil while connect() is still waiting. Called exactly once.
    var connectCompletion: ((Result<String, Error>) -> Void)?
    /// Reason supplied by disconnect(), so the closed event that arrives later
    /// from .cancelled carries what the caller asked for rather than "cancelled".
    var closeReason: String?

    var connectTimeout: DispatchWorkItem?
    var viabilityTimeout: DispatchWorkItem?
    var closeWatchdog: DispatchWorkItem?

    /// Bytes accepted by send() and not yet reported processed by the socket.
    var queuedBytes = 0

    /// Sliding window used to estimate throughput from real transfers.
    var windowStart = Date().timeIntervalSince1970
    var windowBytes = 0

    init(id: String, endpointId: String, connection: NWConnection, incoming: Bool) {
        self.id = id
        self.endpointId = endpointId
        self.connection = connection
        self.incoming = incoming
    }

    func cancelTimers() {
        connectTimeout?.cancel()
        connectTimeout = nil
        viabilityTimeout?.cancel()
        viabilityTimeout = nil
        closeWatchdog?.cancel()
        closeWatchdog = nil
    }
}

/// A peer we can still reach by name, and the browse result needed to dial it.
private struct NetworkDiscoveredEndpoint {
    let id: String
    let result: NWBrowser.Result
    var name: String
    var token: String
    var lastSeen: TimeInterval
}

/// What availability() reports. Recomputed from NWPathMonitor.
private struct NetworkAvailability {
    var available: Bool
    var reason: UnavailableReason
    var detail: String
}

final class LocalNetworkTransport: AirLinkTransport, @unchecked Sendable {

    let kind: TransportKind
    weak var events: TransportEventSink?

    /// One serial queue owns every mutable property below and is the queue every
    /// Network.framework object is started on, so its callbacks never race us.
    private let queue: DispatchQueue

    private var configuration: TransportConfiguration?
    private var isStarted = false

    private var listener: NWListener?
    private var browser: NWBrowser?

    /// Bonjour instance name we publish. Generated once per start() and then
    /// held constant.
    ///
    /// Two imperfect options here. Rotating the name with every token rotation
    /// would be marginally better for unlinkability; keeping it stable is what
    /// lets a peer's endpoint id stay usable for as long as we are visible, so
    /// a connect() started a second ago still resolves. Stability wins, because
    /// the privacy gain is close to nil - the IPv6 link-local address behind the
    /// name is just as constant for the life of the process - while the churn
    /// would tear down and re-announce every peer on both sides mid-connect.
    /// The rotating token still rotates, inside the TXT record, which is what
    /// the pairing layer actually reads.
    private var serviceName: String?
    /// Names the system confirmed for us (Bonjour renames on collision), used to
    /// recognise and drop our own service in browse results.
    private var registeredServiceNames = Set<String>()
    private var isAdvertising = false
    private var advertisedToken = ""
    private var advertisedDisplayName = ""

    private var endpoints: [String: NetworkDiscoveredEndpoint] = [:]
    private var links: [String: NetworkPeerLink] = [:]

    private var browserRestartAttempt = 0
    private var listenerRestartAttempt = 0

    /// Set when the OS tells us the local-network prompt was refused. Sticky,
    /// because neither the browser nor the path will say so again until it is
    /// fixed in Settings; cleared as soon as anything actually works.
    private var localNetworkDenied = false

    private let pathMonitor = NWPathMonitor()

    /// availability() and metrics() are called synchronously from the bridge's
    /// own queue, so the two values they read live behind a lock instead of on
    /// the serial queue. Everything else stays queue-confined.
    private let stateLock = NSLock()
    private var availabilitySnapshot: NetworkAvailability
    private var metricsByLink: [String: LinkMetricsSnapshot] = [:]

    init(kind: TransportKind) {
        self.kind = kind
        self.queue = DispatchQueue(label: "com.airlink.transport.network.\(kind.rawValue)")
        self.availabilitySnapshot = NetworkAvailability(
            available: false,
            reason: .unknown,
            detail: "Checking the network."
        )

        // The path monitor runs for the lifetime of the transport rather than
        // only between start() and stop(): getCapabilities() is answered before
        // anything is started, and an honest answer needs a real path. It costs
        // nothing and triggers no permission prompt - only Bonjour does that.
        pathMonitor.pathUpdateHandler = { [weak self] path in
            self?.applyPath(path)
        }
        // Seeded before start(queue:) so the handler cannot be racing this.
        applyPath(pathMonitor.currentPath, emitChange: false)
        pathMonitor.start(queue: queue)
    }

    deinit {
        pathMonitor.cancel()
    }

    // MARK: - Availability

    func availability() -> (available: Bool, reason: UnavailableReason, detail: String) {
        stateLock.lock()
        let snapshot = availabilitySnapshot
        stateLock.unlock()
        return (snapshot.available, snapshot.reason, snapshot.detail)
    }

    private func applyPath(_ path: NWPath, emitChange: Bool = true) {
        // Called on `queue` when it comes from the monitor; the one call from
        // init() is before anything else can touch this state.
        if path.status == .unsatisfied && path.unsatisfiedReason == .localNetworkDenied {
            localNetworkDenied = true
        }

        let next = evaluate(path)

        stateLock.lock()
        let previous = availabilitySnapshot
        availabilitySnapshot = next
        stateLock.unlock()

        guard emitChange else { return }
        guard previous.available != next.available || previous.reason != next.reason else { return }
        events?.availabilityChanged(transport: kind, available: next.available, reason: next.reason)
        log("info", "availability: \(next.available) (\(next.reason.rawValue))")
    }

    private func evaluate(_ path: NWPath) -> NetworkAvailability {
        if localNetworkDenied {
            return NetworkAvailability(
                available: false,
                reason: .permissionDenied,
                detail: "AirLink needs permission to find devices on your local network. Turn it on in Settings › Privacy & Security › Local Network."
            )
        }

        switch kind {
        case .peerToPeerWifi:
            // Peer-to-peer Wi-Fi needs the Wi-Fi radio powered on and needs no
            // network whatsoever, so path.status is the wrong question - it is
            // .unsatisfied on a phone in airplane mode with Wi-Fi re-enabled,
            // which is exactly the case this transport exists for. The nearest
            // honest signal iOS gives is whether a Wi-Fi interface is up at all.
            let wifiUp = path.availableInterfaces.contains { $0.type == .wifi }
            if !wifiUp {
                return NetworkAvailability(
                    available: false,
                    reason: .radioOff,
                    detail: "Turn Wi-Fi on to connect directly to a nearby iPhone or iPad. You do not need to join a network."
                )
            }
            return NetworkAvailability(
                available: true,
                reason: .none,
                detail: "Ready to connect directly over Wi-Fi, with no network needed. Apple devices only - an Android phone cannot join this one."
            )

        default:
            // The local-network transport genuinely needs a network both devices
            // have joined. A satisfied path over cellular is not one: Bonjour
            // does not run there and a peer on the same carrier is not "local".
            let usable = path.status == .satisfied
                && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
            if !usable {
                return NetworkAvailability(
                    available: false,
                    reason: .noLocalNetwork,
                    detail: "Join the same Wi-Fi network as your friend to send photos and video at full speed. It does not need to reach the internet."
                )
            }
            return NetworkAvailability(
                available: true,
                reason: .none,
                detail: "Connected to Wi-Fi and ready to find friends on this network."
            )
        }
    }

    // MARK: - Lifecycle

    func start(configuration: TransportConfiguration) throws {
        queue.sync {
            // start() is idempotent from JavaScript's point of view: calling it
            // twice reconfigures rather than doubling up on sockets.
            if isStarted { teardown(reason: "transport restarted") }
            self.configuration = configuration
            self.serviceName = Self.makeServiceName()
            self.isStarted = true
            warnIfServiceTypeMissingFromInfoPlist(configuration.bonjourServiceType)
        }
    }

    func stop() {
        queue.sync {
            teardown(reason: "transport stopped")
            configuration = nil
            isStarted = false
        }
    }

    /// Cancels everything and reports every open link closed. Must be called on
    /// `queue`.
    private func teardown(reason: String) {
        listener?.cancel()
        listener = nil
        browser?.cancel()
        browser = nil
        registeredServiceNames.removeAll()
        endpoints.removeAll()
        browserRestartAttempt = 0
        listenerRestartAttempt = 0
        isAdvertising = false
        advertisedToken = ""
        advertisedDisplayName = ""
        serviceName = nil

        for link in links.values {
            finishConnect(link, with: .failure(AirLinkError.failed(reason)))
            reportTerminal(link, state: .closed, reason: reason)
            link.cancelTimers()
            link.connection.cancel()
        }
        links.removeAll()
        stateLock.lock()
        metricsByLink.removeAll()
        stateLock.unlock()
    }

    /// Bonjour fails silently when the service type is absent from
    /// NSBonjourServices, which is a genuinely baffling half hour to debug. Say
    /// it out loud in Developer Mode instead.
    private func warnIfServiceTypeMissingFromInfoPlist(_ type: String) {
        let declared = Bundle.main.object(forInfoDictionaryKey: "NSBonjourServices") as? [String] ?? []
        let normalised = type.hasSuffix(".") ? String(type.dropLast()) : type
        let matches = declared.contains { entry in
            let candidate = entry.hasSuffix(".") ? String(entry.dropLast()) : entry
            return candidate.caseInsensitiveCompare(normalised) == .orderedSame
        }
        if !matches {
            log("warn", "'\(type)' is not listed in NSBonjourServices; iOS will silently refuse to advertise or browse for it")
        }
    }

    // MARK: - Advertising

    func startAdvertising(token: Data, displayName: String) throws {
        var thrown: Error?
        queue.sync {
            guard isStarted, let configuration else {
                thrown = AirLinkError.notStarted
                return
            }
            isAdvertising = true
            advertisedToken = token.isEmpty ? "" : token.base64EncodedString()
            advertisedDisplayName = Self.clamp(displayName, toUtf8Bytes: 63)

            let service = makeService(type: configuration.bonjourServiceType)

            if let listener {
                // Rotating the token is a TXT record change, not a new socket.
                // Re-assigning `service` re-registers the Bonjour record while
                // the listening socket, its port, and every already-accepted
                // connection carry on untouched.
                listener.service = service
                log("info", "advertisement token rotated")
                return
            }

            do {
                // No port is given, so the system picks a free one and publishes
                // it in the SRV record. Nothing needs a fixed port: peers only
                // ever reach us through the browsed service endpoint.
                let created = try NWListener(using: makeParameters(), on: .any)
                created.service = service
                configureAndStart(created)
                listener = created
            } catch {
                isAdvertising = false
                thrown = AirLinkError.failed("could not start listening: \(error.localizedDescription)")
            }
        }
        if let thrown { throw thrown }
    }

    func stopAdvertising() {
        queue.sync {
            // Cancelling the listener stops new peers finding or dialling us.
            // Connections it already handed to newConnectionHandler are
            // independent objects and keep running, which is what we want: a
            // transfer in progress must not die because advertising stopped.
            listener?.cancel()
            listener = nil
            registeredServiceNames.removeAll()
            listenerRestartAttempt = 0
            advertisedToken = ""
            advertisedDisplayName = ""
        }
    }

    private func makeService(type: String) -> NWListener.Service {
        var txt = NWTXTRecord()
        if !advertisedToken.isEmpty { txt[NetworkTxtKey.token] = advertisedToken }
        // Only present when the user opted in. An empty key would still occupy
        // space in a record that has to fit a single DNS response.
        if !advertisedDisplayName.isEmpty { txt[NetworkTxtKey.displayName] = advertisedDisplayName }
        return NWListener.Service(name: serviceName, type: type, domain: nil, txtRecord: txt)
    }

    private func configureAndStart(_ listener: NWListener) {
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self, let listener else { return }
            switch state {
            case .ready:
                self.listenerRestartAttempt = 0
                self.noteLocalNetworkWorks()
                let port = listener.port?.rawValue.description ?? "?"
                self.log("info", "advertising on port \(port)")
            case .waiting(let error):
                // .waiting is recoverable by definition - the system is telling
                // us it will retry - so it is logged, never treated as failure.
                self.noteIfPolicyDenied(error)
                self.log("warn", "listener waiting: \(error)")
            case .failed(let error):
                self.noteIfPolicyDenied(error)
                self.log("error", "listener failed: \(error)")
                self.restartListener()
            case .cancelled, .setup:
                break
            @unknown default:
                break
            }
        }

        listener.serviceRegistrationUpdateHandler = { [weak self] change in
            guard let self else { return }
            switch change {
            case .add(let endpoint):
                if case let .service(name, _, _, _) = endpoint {
                    self.registeredServiceNames.insert(name)
                    // Bonjour renames on collision, so the published name is not
                    // necessarily the one we asked for. Drop any result now
                    // carrying it - it is us.
                    self.dropSelfFromEndpoints()
                }
            case .remove(let endpoint):
                if case let .service(name, _, _, _) = endpoint {
                    self.registeredServiceNames.remove(name)
                }
            @unknown default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }

        listener.start(queue: queue)
    }

    private func restartListener() {
        guard isStarted, listenerRestartAttempt < NetworkTiming.restartBackoffSeconds.count,
              let configuration else {
            listener = nil
            return
        }
        let delay = NetworkTiming.restartBackoffSeconds[listenerRestartAttempt]
        listenerRestartAttempt += 1
        listener?.cancel()
        listener = nil
        let type = configuration.bonjourServiceType
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.isStarted, self.listener == nil,
                  !self.advertisedToken.isEmpty || !self.advertisedDisplayName.isEmpty else { return }
            do {
                let created = try NWListener(using: self.makeParameters(), on: .any)
                created.service = self.makeService(type: type)
                self.configureAndStart(created)
                self.listener = created
            } catch {
                self.log("error", "could not restart listener: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Discovery

    func startDiscovery() throws {
        var thrown: Error?
        queue.sync {
            guard isStarted, let configuration else {
                thrown = AirLinkError.notStarted
                return
            }
            guard browser == nil else { return }
            browserRestartAttempt = 0
            startBrowser(type: configuration.bonjourServiceType)
        }
        if let thrown { throw thrown }
    }

    func stopDiscovery() {
        queue.sync {
            browser?.cancel()
            browser = nil
            browserRestartAttempt = 0
            // The endpoint table is deliberately kept. A peer that was visible a
            // moment ago is very likely still reachable, and a connect() that
            // arrives just after discovery stopped should succeed rather than
            // fail with unknown_endpoint. Stale entries cost one failed dial.
        }
    }

    private func startBrowser(type: String) {
        // bonjourWithTXTRecord rather than plain bonjour: the rotating token
        // lives in the TXT record, and the plain descriptor delivers results
        // with .none metadata, so the token would never arrive. The cost is one
        // extra DNS query per service, which on a link with two phones on it is
        // nothing.
        let created = NWBrowser(for: .bonjourWithTXTRecord(type: type, domain: nil), using: makeBrowserParameters())

        created.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.browserRestartAttempt = 0
                self.noteLocalNetworkWorks()
                self.log("info", "browsing for \(type)")
            case .waiting(let error):
                // The local-network prompt being refused surfaces here, as a DNS
                // policy error, and the browser then waits forever. Report it as
                // a reason rather than leaving the user staring at an empty list.
                self.noteIfPolicyDenied(error)
                self.log("warn", "browser waiting: \(error)")
            case .failed(let error):
                self.noteIfPolicyDenied(error)
                self.log("error", "browser failed: \(error)")
                self.restartBrowser(type: type)
            case .cancelled, .setup:
                break
            @unknown default:
                break
            }
        }

        created.browseResultsChangedHandler = { [weak self] _, changes in
            guard let self else { return }
            for change in changes {
                switch change {
                case .added(let result):
                    self.handleDiscovered(result)
                case .changed(_, let new, let flags):
                    // A metadata change is a rotated token or a changed display
                    // name: the same peer, with something the layer above needs.
                    if flags.contains(.metadataChanged) { self.handleDiscovered(new) }
                case .removed(let result):
                    self.handleLost(result)
                case .identical:
                    break
                @unknown default:
                    break
                }
            }
        }

        created.start(queue: queue)
        browser = created
    }

    private func restartBrowser(type: String) {
        guard isStarted, browserRestartAttempt < NetworkTiming.restartBackoffSeconds.count else {
            browser?.cancel()
            browser = nil
            return
        }
        let delay = NetworkTiming.restartBackoffSeconds[browserRestartAttempt]
        browserRestartAttempt += 1
        browser?.cancel()
        browser = nil
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.isStarted, self.browser == nil else { return }
            self.startBrowser(type: type)
        }
    }

    private func handleDiscovered(_ result: NWBrowser.Result) {
        guard case let .service(name, _, _, _) = result.endpoint else { return }
        guard let id = Self.endpointId(for: result.endpoint) else { return }

        // Our own advertisement comes back through our own browser. Filter it
        // by the registered service name, and again by the token, because the
        // name can be renamed by the system between publishing and browsing.
        if registeredServiceNames.contains(name) { return }

        var token = ""
        var displayName = ""
        if case let .bonjour(txt) = result.metadata {
            token = Self.sanitisedToken(txt[NetworkTxtKey.token])
            displayName = Self.clamp(txt[NetworkTxtKey.displayName] ?? "", toUtf8Bytes: 63)
        }
        if !token.isEmpty && token == advertisedToken { return }

        let now = Date().timeIntervalSince1970
        let existing = endpoints[id]
        endpoints[id] = NetworkDiscoveredEndpoint(
            id: id, result: result, name: displayName, token: token, lastSeen: now
        )
        pruneEndpointsIfNeeded()

        // Re-announce on a token change too: the pairing layer matches on the
        // token, so a rotation is new information even for a known endpoint.
        if let existing, existing.token == token, existing.name == displayName { return }
        events?.peerDiscovered(DiscoveredEndpoint(
            transport: kind, endpointId: id, name: displayName, token: token, rssi: 0
        ))
    }

    private func handleLost(_ result: NWBrowser.Result) {
        guard let id = Self.endpointId(for: result.endpoint), let entry = endpoints[id] else { return }
        endpoints.removeValue(forKey: id)
        events?.peerLost(DiscoveredEndpoint(
            transport: kind, endpointId: id, name: entry.name, token: entry.token, rssi: 0
        ))
    }

    private func dropSelfFromEndpoints() {
        for (id, entry) in endpoints {
            guard case let .service(name, _, _, _) = entry.result.endpoint,
                  registeredServiceNames.contains(name) else { continue }
            endpoints.removeValue(forKey: id)
            events?.peerLost(DiscoveredEndpoint(
                transport: kind, endpointId: id, name: entry.name, token: entry.token, rssi: 0
            ))
        }
    }

    private func pruneEndpointsIfNeeded() {
        guard endpoints.count > NetworkFraming.maxRememberedEndpoints else { return }
        // Evict least-recently-seen first, and never evict an endpoint with a
        // live link on it.
        let busy = Set(links.values.map(\.endpointId))
        let evictable = endpoints.values
            .filter { !busy.contains($0.id) }
            .sorted { $0.lastSeen < $1.lastSeen }
        var overflow = endpoints.count - NetworkFraming.maxRememberedEndpoints
        for entry in evictable where overflow > 0 {
            endpoints.removeValue(forKey: entry.id)
            events?.peerLost(DiscoveredEndpoint(
                transport: kind, endpointId: entry.id, name: entry.name, token: entry.token, rssi: 0
            ))
            overflow -= 1
        }
    }

    // MARK: - Connecting

    func connect(endpointId: String, timeoutMs: Int, completion: @escaping (Result<String, Error>) -> Void) {
        queue.async {
            guard self.isStarted else {
                completion(.failure(AirLinkError.notStarted))
                return
            }
            guard let entry = self.endpoints[endpointId] else {
                completion(.failure(AirLinkError.unknownEndpoint(endpointId)))
                return
            }
            guard self.links.count < NetworkFraming.maxConcurrentLinks else {
                completion(.failure(AirLinkError.failed("too many open links on \(self.kind.rawValue)")))
                return
            }

            // Dial the browsed endpoint rather than a resolved address: it
            // carries the interface the peer was seen on, which is how the
            // system knows to bring up (or reuse) the peer-to-peer link.
            let connection = NWConnection(to: entry.result.endpoint, using: self.makeParameters())
            let link = NetworkPeerLink(
                id: self.makeLinkId(), endpointId: endpointId, connection: connection, incoming: false
            )
            link.connectCompletion = completion
            self.links[link.id] = link
            self.resetMetrics(for: link)

            let clamped = min(max(timeoutMs, NetworkTiming.minimumConnectTimeoutMs),
                              NetworkTiming.maximumConnectTimeoutMs)
            let timeout = DispatchWorkItem { [weak self, weak link] in
                guard let self, let link, link.connectCompletion != nil else { return }
                self.log("warn", "connect to \(endpointId) timed out after \(clamped)ms")
                self.abandon(link, error: AirLinkError.timeout("connecting to \(endpointId)"))
            }
            link.connectTimeout = timeout
            self.queue.asyncAfter(deadline: .now() + .milliseconds(clamped), execute: timeout)

            self.attachHandlers(to: link)
            connection.start(queue: self.queue)
        }
    }

    private func accept(_ connection: NWConnection) {
        guard isStarted else {
            connection.cancel()
            return
        }
        guard links.count < NetworkFraming.maxConcurrentLinks else {
            log("warn", "refused an inbound connection: link limit reached")
            connection.cancel()
            return
        }

        // An inbound connection arrives as an address and a port. There is no
        // way to tie it back to a browsed service without reading the payload,
        // and reading the payload is exactly what this layer must not do, so it
        // gets a synthetic endpoint id. The handshake above identifies the peer
        // properly a few milliseconds later.
        let link = NetworkPeerLink(
            id: makeLinkId(),
            endpointId: "inbound-\(UUID().uuidString.prefix(8))",
            connection: connection,
            incoming: true
        )
        links[link.id] = link
        resetMetrics(for: link)
        attachHandlers(to: link)
        connection.start(queue: queue)
    }

    private func attachHandlers(to link: NetworkPeerLink) {
        link.connection.stateUpdateHandler = { [weak self, weak link] state in
            guard let self, let link else { return }
            switch state {
            case .ready:
                self.open(link)
            case .waiting(let error):
                // Waiting is NOT failure: the path may still come up - a Wi-Fi
                // association completing, or AWDL negotiating. The connect
                // timeout is what eventually gives up, not this.
                self.noteIfPolicyDenied(error)
                self.log("info", "link \(link.id) waiting: \(error)")
            case .failed(let error):
                self.noteIfPolicyDenied(error)
                self.fail(link, reason: "connection failed: \(error)")
            case .cancelled:
                self.finishConnect(link, with: .failure(AirLinkError.failed("connection cancelled")))
                self.reportTerminal(link, state: .closed, reason: "connection cancelled")
                self.forget(link)
            case .preparing, .setup:
                break
            @unknown default:
                break
            }
        }

        link.connection.viabilityUpdateHandler = { [weak self, weak link] viable in
            guard let self, let link else { return }
            if viable {
                link.viabilityTimeout?.cancel()
                link.viabilityTimeout = nil
                return
            }
            // A radio switched off, or a phone carried out of range, shows up
            // here long before TCP notices. Give it a grace period - a Wi-Fi
            // roam recovers in a second - then declare it dead so JavaScript
            // gets a clean state event instead of a link that silently stops
            // moving bytes. This is reporting, not reconnecting: the decision to
            // try again belongs one layer up.
            guard link.viabilityTimeout == nil else { return }
            let item = DispatchWorkItem { [weak self, weak link] in
                guard let self, let link else { return }
                self.fail(link, reason: "the network went away")
            }
            link.viabilityTimeout = item
            self.queue.asyncAfter(deadline: .now() + NetworkTiming.viabilityGraceSeconds, execute: item)
        }

        // A better path exists (Wi-Fi appeared while we were on peer-to-peer, say).
        // Switching transports is a negotiation the TypeScript layer performs
        // with the peer; silently migrating the socket underneath it would make
        // its metrics lie. Log it and leave it alone.
        link.connection.betterPathUpdateHandler = { [weak self, weak link] better in
            guard let self, let link, better else { return }
            self.log("debug", "link \(link.id): a better network path is available")
        }
    }

    private func open(_ link: NetworkPeerLink) {
        guard !link.isOpen, links[link.id] != nil else { return }
        link.isOpen = true
        link.connectTimeout?.cancel()
        link.connectTimeout = nil
        noteLocalNetworkWorks()

        setMetrics(for: link) { $0.maxDatagramSize = NetworkFraming.maxDatagramSize }

        // Order matters and is deliberate: announce the link, then its state,
        // then resolve connect(), and only then start pulling bytes off the
        // socket. JavaScript therefore can never see a data event for a link it
        // has not been told about.
        events?.linkOpened(
            linkId: link.id,
            transport: kind,
            endpointId: link.endpointId,
            maxDatagramSize: NetworkFraming.maxDatagramSize,
            highBandwidth: true,
            incoming: link.incoming
        )
        events?.linkState(linkId: link.id, state: .connected, reason: "")
        finishConnect(link, with: .success(link.id))
        receiveLengthPrefix(link)
    }

    /// Terminal failure of a link that may or may not have opened.
    private func fail(_ link: NetworkPeerLink, reason: String) {
        guard links[link.id] != nil else { return }
        finishConnect(link, with: .failure(AirLinkError.failed(reason)))
        reportTerminal(link, state: .failed, reason: reason)
        link.connection.cancel()
        forget(link)
    }

    /// Give up on a connect that never opened, without ever emitting a state
    /// event for a link JavaScript was never told about.
    private func abandon(_ link: NetworkPeerLink, error: Error) {
        finishConnect(link, with: .failure(error))
        link.connection.cancel()
        forget(link)
    }

    private func finishConnect(_ link: NetworkPeerLink, with result: Result<String, Error>) {
        guard let completion = link.connectCompletion else { return }
        link.connectCompletion = nil
        link.connectTimeout?.cancel()
        link.connectTimeout = nil
        completion(result)
    }

    /// Emits closed/failed exactly once for a link that reached JavaScript.
    private func reportTerminal(_ link: NetworkPeerLink, state: LinkState, reason: String) {
        guard link.isOpen, !link.didReportTerminal else { return }
        link.didReportTerminal = true
        events?.linkState(linkId: link.id, state: state, reason: reason)
    }

    private func forget(_ link: NetworkPeerLink) {
        link.cancelTimers()
        links.removeValue(forKey: link.id)
        stateLock.lock()
        metricsByLink.removeValue(forKey: link.id)
        stateLock.unlock()
    }

    func disconnect(linkId: String, reason: String) {
        queue.async {
            guard let link = self.links[linkId] else {
                // Idempotent by construction: an already-closed link is exactly
                // the state the caller asked for.
                return
            }
            if link.isOpen && !link.didReportTerminal {
                self.events?.linkState(linkId: link.id, state: .closing, reason: reason)
            }
            self.finishConnect(link, with: .failure(AirLinkError.failed(reason.isEmpty ? "disconnected" : reason)))
            link.connection.cancel()

            // cancel() normally lands in .cancelled within milliseconds and that
            // is where closed is emitted. This watchdog exists so that the
            // promise "close always eventually produces a closed event" holds
            // even if the framework never calls back.
            let watchdog = DispatchWorkItem { [weak self, weak link] in
                guard let self, let link, self.links[link.id] != nil else { return }
                self.log("warn", "link \(link.id) did not report cancelled; forcing closed")
                self.reportTerminal(link, state: .closed, reason: reason)
                link.connection.forceCancel()
                self.forget(link)
            }
            link.closeWatchdog = watchdog
            self.queue.asyncAfter(deadline: .now() + NetworkTiming.closeWatchdogSeconds, execute: watchdog)
        }
    }

    // MARK: - Sending

    func send(linkId: String, data: Data, reliable: Bool, completion: @escaping (Result<Void, Error>) -> Void) {
        // Everything hops onto the serial queue, which is also what guarantees
        // no event is ever delivered re-entrantly from inside this call.
        queue.async {
            guard let link = self.links[linkId] else {
                completion(.failure(AirLinkError.unknownLink(linkId)))
                return
            }
            guard link.isOpen, !link.didReportTerminal else {
                completion(.failure(AirLinkError.failed("link \(linkId) is not connected")))
                return
            }
            // Loud, never truncating. Truncation would corrupt a frame the peer
            // then fails to authenticate, which is a far worse bug to chase.
            guard data.count <= NetworkFraming.maxDatagramSize else {
                completion(.failure(AirLinkError.payloadTooLarge(data.count, NetworkFraming.maxDatagramSize)))
                return
            }

            if !reliable && link.queuedBytes > NetworkFraming.realtimeHighWaterMark {
                // TCP has no lossy path, so best-effort is expressed by dropping
                // here rather than by the wire. This is what `reliable: false`
                // buys on this transport, and it is the right trade: the next
                // realtime update supersedes this one anyway.
                self.setMetrics(for: link) { $0.packetsDropped += 1 }
                completion(.success(()))
                return
            }
            guard link.queuedBytes <= NetworkFraming.sendQueueHardLimit else {
                completion(.failure(AirLinkError.failed("send queue for link \(linkId) is full")))
                return
            }

            // Header and payload in one buffer: one send, so nothing can ever
            // interleave a length prefix with somebody else's body.
            let frame = Self.frame(data)
            link.queuedBytes += frame.count

            link.connection.send(content: frame, completion: .contentProcessed { [weak self, weak link] error in
                guard let self, let link else { return }
                link.queuedBytes = max(0, link.queuedBytes - frame.count)
                if let error {
                    completion(.failure(AirLinkError.failed("send failed: \(error)")))
                    self.fail(link, reason: "send failed: \(error)")
                    return
                }
                self.setMetrics(for: link) {
                    $0.packetsSent += 1
                    $0.bytesSent += Double(data.count)
                }
                self.noteTransfer(link, bytes: data.count)
                // Resolved when the transport has accepted the bytes, which is
                // what the contract promises - not when the peer has them.
                completion(.success(()))
            })
        }
    }

    private static func frame(_ payload: Data) -> Data {
        let length = UInt32(payload.count)
        var frame = Data(capacity: NetworkFraming.lengthPrefixBytes + payload.count)
        frame.append(UInt8(truncatingIfNeeded: length >> 24))
        frame.append(UInt8(truncatingIfNeeded: length >> 16))
        frame.append(UInt8(truncatingIfNeeded: length >> 8))
        frame.append(UInt8(truncatingIfNeeded: length))
        frame.append(payload)
        return frame
    }

    // MARK: - Receiving

    /**
     * Un-framing, in two exact reads.
     *
     * The obvious implementation - receive whatever arrives, append to a buffer,
     * scan for complete frames - is where stream transports go wrong: an
     * off-by-one in the scan silently merges or splits datagrams, and the bug
     * only shows up under load. Asking Network.framework for exactly the four
     * header bytes and then exactly the body length removes the buffer, and with
     * it the class of bug. The framework does the buffering, correctly, and
     * there is never more than one datagram of ours outstanding, so TCP flow
     * control bounds what a peer can make us hold.
     */
    private func receiveLengthPrefix(_ link: NetworkPeerLink) {
        guard link.isOpen, !link.didReportTerminal else { return }
        link.connection.receive(minimumIncompleteLength: NetworkFraming.lengthPrefixBytes,
                                maximumLength: NetworkFraming.lengthPrefixBytes) { [weak self, weak link] content, _, isComplete, error in
            guard let self, let link else { return }
            if let error {
                self.fail(link, reason: "receive failed: \(error)")
                return
            }
            let header = content ?? Data()
            guard header.count == NetworkFraming.lengthPrefixBytes else {
                // Short only when the peer closed. An empty read on a frame
                // boundary is an orderly shutdown; a partial header is a stream
                // cut mid-datagram. Either way the link is finished.
                if isComplete {
                    self.close(link, reason: header.isEmpty ? "peer closed the connection"
                                                            : "connection closed mid-datagram")
                } else {
                    self.fail(link, reason: "truncated length prefix")
                }
                return
            }

            var length = 0
            for byte in header { length = (length << 8) | Int(byte) }

            guard length <= NetworkFraming.receiveHardLimit else {
                // Refuse to allocate on a peer's say-so.
                self.fail(link, reason: "peer announced a \(length) byte datagram, over the \(NetworkFraming.receiveHardLimit) byte limit")
                return
            }
            if length == 0 {
                // A zero-byte datagram is still a datagram: N bytes in, N bytes
                // out. Delivering nothing here would break the contract.
                self.deliver(link, payload: Data())
                self.receiveLengthPrefix(link)
                return
            }
            self.receiveBody(link, length: length)
        }
    }

    private func receiveBody(_ link: NetworkPeerLink, length: Int) {
        link.connection.receive(minimumIncompleteLength: length, maximumLength: length) { [weak self, weak link] content, _, isComplete, error in
            guard let self, let link else { return }
            if let error {
                self.fail(link, reason: "receive failed: \(error)")
                return
            }
            guard let payload = content, payload.count == length else {
                if isComplete {
                    self.close(link, reason: "connection closed mid-datagram")
                } else {
                    self.fail(link, reason: "truncated datagram body")
                }
                return
            }
            self.deliver(link, payload: payload)
            self.receiveLengthPrefix(link)
        }
    }

    private func deliver(_ link: NetworkPeerLink, payload: Data) {
        setMetrics(for: link) {
            $0.packetsReceived += 1
            $0.bytesReceived += Double(payload.count)
        }
        noteTransfer(link, bytes: payload.count)
        events?.received(linkId: link.id, data: payload)
    }

    /// Orderly close initiated by the peer.
    private func close(_ link: NetworkPeerLink, reason: String) {
        guard links[link.id] != nil else { return }
        finishConnect(link, with: .failure(AirLinkError.failed(reason)))
        reportTerminal(link, state: .closed, reason: reason)
        link.connection.cancel()
        forget(link)
    }

    // MARK: - Metrics

    func metrics(linkId: String) -> LinkMetricsSnapshot? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return metricsByLink[linkId]
    }

    private func resetMetrics(for link: NetworkPeerLink) {
        stateLock.lock()
        metricsByLink[link.id] = LinkMetricsSnapshot(maxDatagramSize: NetworkFraming.maxDatagramSize)
        stateLock.unlock()
    }

    private func setMetrics(for link: NetworkPeerLink, _ body: (inout LinkMetricsSnapshot) -> Void) {
        stateLock.lock()
        var snapshot = metricsByLink[link.id] ?? LinkMetricsSnapshot(maxDatagramSize: NetworkFraming.maxDatagramSize)
        body(&snapshot)
        metricsByLink[link.id] = snapshot
        stateLock.unlock()
    }

    /// Estimates throughput from what actually moved, over ~1 second windows.
    ///
    /// An idle gap is not slowness: a link that sits quiet for a minute and then
    /// sends one kilobyte has not dropped to 17 bytes a second, so a long window
    /// is thrown away rather than sampled. This is what feeds the file-transfer
    /// ETA, and an ETA built on a lie is worse than no ETA.
    private func noteTransfer(_ link: NetworkPeerLink, bytes: Int) {
        link.windowBytes += bytes
        let now = Date().timeIntervalSince1970
        let elapsed = now - link.windowStart
        guard elapsed >= 1.0 else { return }
        defer {
            link.windowStart = now
            link.windowBytes = 0
        }
        guard elapsed <= 5.0 else { return }
        let sample = Double(link.windowBytes) / elapsed
        setMetrics(for: link) {
            $0.throughput = $0.throughput == 0 ? sample : ($0.throughput * 0.7) + (sample * 0.3)
        }
    }

    // MARK: - Parameters

    /**
     * The parameters every listener and connection is built from.
     *
     * Peer-to-peer must be requested on BOTH sides of the conversation - the
     * listener that advertises and the connection that dials - which is the one
     * mistake that reliably turns AWDL off without any error to show for it.
     * Building both from this single function is the cheapest way to make that
     * impossible to get wrong.
     */
    private func makeParameters() -> NWParameters {
        let tcp = NWProtocolTCP.Options()
        // Interactive traffic: a 40-byte ack must not wait on Nagle.
        tcp.noDelay = true
        // Notice a peer that walked away rather than waiting out TCP's default,
        // which is measured in hours.
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 2
        tcp.keepaliveInterval = 2
        tcp.keepaliveCount = 3
        // A belt to the connect timeout's braces, in seconds.
        tcp.connectionTimeout = 10

        // tls: nil is a deliberate choice, not an omission - see the note at the
        // top of this file. The payload is already sealed and authenticated.
        let parameters = NWParameters(tls: nil, tcp: tcp)

        // THE flag. Everything else in this file is identical between the two
        // instances of this class.
        parameters.includePeerToPeer = (kind == .peerToPeerWifi)

        // AWDL and Bonjour are both IPv6 link-local; forcing IPv4 would break
        // peer-to-peer outright and is never needed on a local link.
        parameters.prohibitedInterfaceTypes = [.cellular]
        // An offline app has no business on a metered path, and a peer on the
        // far side of a cellular connection is not a peer.
        parameters.prohibitExpensivePaths = true
        parameters.serviceClass = .responsiveData

        return parameters
    }

    /// Browsing needs no protocol stack, only the same peer-to-peer intent.
    private func makeBrowserParameters() -> NWParameters {
        let parameters = NWParameters()
        parameters.includePeerToPeer = (kind == .peerToPeerWifi)
        parameters.prohibitedInterfaceTypes = [.cellular]
        return parameters
    }

    // MARK: - Small helpers

    private func makeLinkId() -> String {
        "\(kind.rawValue)-\(UUID().uuidString.prefix(8))"
    }

    private static func makeServiceName() -> String {
        // Random, so nothing durable about the device is broadcast. 64 bits of
        // hex is 16 characters, comfortably inside Bonjour's 63-byte limit.
        String(format: "%016llx", UInt64.random(in: UInt64.min...UInt64.max))
    }

    private static func endpointId(for endpoint: NWEndpoint) -> String? {
        guard case let .service(name, type, domain, _) = endpoint else { return nil }
        // Stable for as long as the peer keeps advertising, which is exactly the
        // window in which connect() has to be able to find it again. The
        // interface is left out on purpose: the same peer seen on two interfaces
        // is one peer.
        return "\(name).\(type).\(domain)"
    }

    /// Everything in a TXT record was written by somebody else's phone.
    private static func sanitisedToken(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty, raw.count <= 64 else { return "" }
        guard let decoded = Data(base64Encoded: raw), !decoded.isEmpty, decoded.count <= 32 else { return "" }
        // Re-encode so what crosses the bridge is canonical base64 regardless of
        // what the peer put on the wire.
        return decoded.base64EncodedString()
    }

    private static func clamp(_ value: String, toUtf8Bytes limit: Int) -> String {
        guard !value.isEmpty else { return "" }
        var result = value
        while result.utf8.count > limit { result = String(result.dropLast()) }
        return result
    }

    /// kDNSServiceErr_PolicyDenied / kDNSServiceErr_NotPermitted. Hard-coded
    /// rather than imported from dnssd because these two values are wire
    /// constants that cannot change, and this is the only signal iOS gives that
    /// the local-network prompt was refused - there is still no API to query it.
    private static let dnsPolicyDeniedCodes: Set<Int32> = [-65570, -65571]

    private func noteIfPolicyDenied(_ error: NWError) {
        guard case let .dns(code) = error, Self.dnsPolicyDeniedCodes.contains(code) else { return }
        guard !localNetworkDenied else { return }
        localNetworkDenied = true
        applyPath(pathMonitor.currentPath)
    }

    private func noteLocalNetworkWorks() {
        guard localNetworkDenied else { return }
        localNetworkDenied = false
        applyPath(pathMonitor.currentPath)
    }

    private func log(_ level: String, _ message: String) {
        events?.log(level: level, scope: kind.rawValue, message: message)
    }
}
