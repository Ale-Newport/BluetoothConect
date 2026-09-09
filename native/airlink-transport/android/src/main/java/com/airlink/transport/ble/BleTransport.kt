package com.airlink.transport.ble

import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import com.airlink.transport.AirLinkTransport
import com.airlink.transport.DiscoveredEndpoint
import com.airlink.transport.LinkMetricsSnapshot
import com.airlink.transport.LinkState
import com.airlink.transport.TransportAvailability
import com.airlink.transport.TransportConfiguration
import com.airlink.transport.TransportEventSink
import com.airlink.transport.TransportKind
import com.airlink.transport.UnavailableReason
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Bluetooth Low Energy: the floor everything else stands on.
 *
 * It is the ONLY transport that moves a byte between an iPhone and an Android
 * phone with no network of any kind - no router, no hotspot, no cellular, both
 * devices in aeroplane mode with Bluetooth on. Wi-Fi Direct is Android-only,
 * Apple peer-to-peer Wi-Fi is iOS-only, and Wi-Fi Aware does not work between
 * the two on real handsets. If this file is wrong, the headline feature of the
 * product does not exist.
 *
 * It is also slow - five to forty kilobytes a second - and the product says so
 * rather than hiding it. `highBandwidth` is false on every link this transport
 * produces, including upgraded ones.
 *
 * ===========================================================================
 * SHAPE
 * ===========================================================================
 *
 *   BleTransport        this file: lifecycle, routing, radio state, events
 *     BleScanner        central discovery
 *     CentralConnection one outgoing connection, and its operation queue
 *     BleGattServer     our service, our advertisement, incoming connections
 *     BleLink           one link: send queue, metrics, state machine
 *     L2cap*            the optional byte-stream upgrade, with its own framing
 *     BleWire           what the two platforms agree on, byte for byte
 *
 * NO PROTOCOL KNOWLEDGE LIVES HERE. This layer discovers endpoints, opens
 * links, moves opaque datagrams and reports state. It never reads a payload,
 * never adds a header to one, and never decides that a link should come back -
 * encryption, sequencing, retries, fragmentation, sessions and reconnection
 * all live in TypeScript, which is why they can be tested against a simulated
 * radio in milliseconds instead of against two phones on a table.
 *
 * ===========================================================================
 * THREADING
 * ===========================================================================
 *
 * One handler thread owns every piece of mutable state in this package.
 * Scanner callbacks, GATT callbacks, server callbacks, socket threads and
 * calls from the bridge all hand over to it before touching anything.
 *
 * `send` posts and returns, so a completion can never run inside the send call
 * that produced it - the fourth clause of the datagram contract, true by
 * construction rather than by inspection. The handful of methods the interface
 * defines as throwing run *on* that thread and block their caller until they
 * finish, which keeps the discipline without giving up the ability to report a
 * failure synchronously.
 */
class BleTransport(context: Context) : AirLinkTransport, BleLinkHost {

    override val kind: TransportKind = TransportKind.BLE

    override var events: TransportEventSink? = null

    private val appContext: Context = context.applicationContext
    private val availability = BleAvailability(appContext)

    private var thread: HandlerThread? = null
    private var handlerRef: Handler? = null

    private var configuration: BleWire.ServiceUuids? = null
    private var started = false

    /** What we were asked to be doing, so it can be restored when the radio comes back. */
    private var wantsDiscovery = false
    private var advertisedToken: ByteArray? = null
    private var advertisedName: String = ""

    private var scanner: BleScanner? = null
    private var gattServer: BleGattServer? = null

    /** Outgoing connections, keyed by endpoint. One at a time per peer. */
    private val connections = LinkedHashMap<String, CentralConnection>()

    /**
     * Every open link, incoming and outgoing. Concurrent because `metrics()`
     * is answered on the caller's thread - a developer-mode screen polling it
     * must not be able to interleave itself into the radio's thread.
     */
    private val links = ConcurrentHashMap<String, BleLink>()

    /**
     * Set by the bridge once it has actually shown the OS permission prompt.
     * See [BleAvailability.permissionsRequested] for why this cannot be worked
     * out from here.
     */
    var permissionsRequested: Boolean
        get() = availability.permissionsRequested
        set(value) {
            availability.permissionsRequested = value
        }

    // -- AirLinkTransport: lifecycle ------------------------------------------

    override fun availability(): TransportAvailability = availability.availability()

    override fun start(configuration: TransportConfiguration) {
        val uuids = try {
            BleWire.ServiceUuids.from(
                configuration.serviceUuid,
                configuration.rxCharacteristicUuid,
                configuration.txCharacteristicUuid,
            )
        } catch (e: IllegalArgumentException) {
            throw BleErrors.failed("the AirLink service UUIDs are malformed: ${e.message}")
        }

        onHandler("start") {
            if (started) return@onHandler
            this.configuration = uuids
            started = true

            if (uuids.identity == null) {
                host_log(
                    "warn",
                    "the RX and TX UUIDs are not consecutive with the service UUID, so the " +
                        "identity characteristic cannot be derived: no L2CAP upgrade and no " +
                        "readable display name",
                )
            }

            registerAdapterReceiver()

            scanner = BleScanner(
                handler = handler,
                availability = availability,
                onDiscovered = { endpoint -> emit { it.peerDiscovered(endpoint) } },
                onLost = { endpoint -> emit { it.peerLost(endpoint) } },
                log = { level, message -> host_log(level, message) },
            )

            val server = BleGattServer(
                context = appContext,
                availability = availability,
                host = this,
                newLinkId = { newLinkId() },
                onIncomingLink = { link -> registerIncoming(link) },
            )
            gattServer = server
            server.start(uuids)

            host_log("info", "BLE transport started for service ${uuids.service}")
        }
    }

    /**
     * Releases everything and leaves the object ready to be started again.
     *
     * Every link is closed with a state event first, so nothing above is left
     * waiting on a link that has quietly stopped existing.
     */
    override fun stop() {
        val h = handlerRef ?: return
        onHandler("stop") {
            if (!started) return@onHandler
            started = false

            unregisterAdapterReceiver()

            scanner?.stop()
            scanner = null

            connections.values.toList().forEach { it.teardown("the transport was stopped", failed = false) }
            connections.clear()

            gattServer?.stop()
            gattServer = null

            links.values.toList().forEach { it.close("the transport was stopped", failed = false) }
            links.clear()

            configuration = null
            wantsDiscovery = false
            advertisedToken = null
            advertisedName = ""
            host_log("info", "BLE transport stopped")
        }

        // Quit last and from the caller's thread, so the block above has
        // finished running on the looper we are about to end. quitSafely lets
        // already-queued messages drain, which matters because a link's closing
        // events are among them.
        synchronized(this) {
            thread?.quitSafely()
            thread = null
            handlerRef = null
        }
        if (h.looper.thread === Thread.currentThread()) {
            // Only reachable if the bridge called stop() from a callback we
            // delivered. Nothing else to do; the looper ends on its own.
            return
        }
    }

    // -- AirLinkTransport: advertising and discovery ---------------------------

    override fun startAdvertising(token: ByteArray, displayName: String) {
        onHandler("startAdvertising") {
            val server = gattServer ?: throw BleErrors.notStarted()
            server.startAdvertising(token, displayName)
            advertisedToken = token.copyOf()
            advertisedName = displayName
        }
    }

    override fun stopAdvertising() {
        onHandlerQuietly {
            advertisedToken = null
            advertisedName = ""
            gattServer?.stopAdvertising()
        }
    }

    override fun startDiscovery() {
        onHandler("startDiscovery") {
            val uuids = configuration ?: throw BleErrors.notStarted()
            val current = scanner ?: throw BleErrors.notStarted()
            current.start(uuids.service)
            wantsDiscovery = true
        }
    }

    override fun stopDiscovery() {
        onHandlerQuietly {
            wantsDiscovery = false
            scanner?.stop()
        }
    }

    // -- AirLinkTransport: links ----------------------------------------------

    override fun connect(endpointId: String, timeoutMs: Int, completion: (Result<String>) -> Unit) {
        val h = handlerRef
        if (h == null) {
            completion(Result.failure(BleErrors.notStarted()))
            return
        }
        h.post {
            val uuids = configuration
            if (!started || uuids == null) {
                completion(Result.failure(BleErrors.notStarted()))
                return@post
            }

            val existing = connections[endpointId]
            if (existing != null) {
                // A second connect to a peer we are already talking to returns
                // the link we already have rather than opening a second one:
                // every connection costs one of the handful of slots the
                // controller has, and the session above is happy to reuse it.
                val open = links[existing.linkId]
                if (open != null && open.isOpen) {
                    completion(Result.success(existing.linkId))
                } else {
                    completion(Result.failure(BleErrors.failed("already connecting to $endpointId")))
                }
                return@post
            }

            if (!availability.isRadioOn) {
                completion(Result.failure(BleErrors.radioOff()))
                return@post
            }
            if (!availability.canConnect) {
                completion(Result.failure(BleErrors.permissionDenied()))
                return@post
            }

            val device = try {
                availability.adapter?.getRemoteDevice(endpointId)
            } catch (_: Throwable) {
                // getRemoteDevice throws IllegalArgumentException for anything
                // that is not a Bluetooth address - including a perfectly valid
                // endpoint id from another transport.
                null
            }
            if (device == null) {
                completion(Result.failure(BleErrors.unknownEndpoint(endpointId)))
                return@post
            }

            val budget = timeoutMs.toLong()
                .let { if (it <= 0L) BleTuning.DEFAULT_CONNECT_TIMEOUT_MS else it }
                .coerceIn(BleTuning.MIN_CONNECT_TIMEOUT_MS, BleTuning.MAX_CONNECT_TIMEOUT_MS)

            var answered = false
            val connection = CentralConnection(
                context = appContext,
                device = device,
                uuids = uuids,
                availability = availability,
                host = this,
                linkId = newLinkId(),
                onIdentity = { endpoint, record ->
                    scanner?.enrich(endpoint, record.name, record.token)
                },
                onFailed = { error ->
                    if (!answered) {
                        answered = true
                        completion(Result.failure(error))
                    }
                },
                onOpened = { link ->
                    links[link.id] = link
                    if (!answered) {
                        answered = true
                        completion(Result.success(link.id))
                    }
                },
                onRetired = { finished -> connections.remove(finished.endpointId, finished) },
            )
            connections[endpointId] = connection
            connection.start(budget)
        }
    }

    override fun disconnect(linkId: String, reason: String) {
        onHandlerQuietly {
            val why = if (reason.isEmpty()) "closed by request" else reason
            val connection = connections.values.firstOrNull { it.linkId == linkId }
            if (connection != null) {
                connection.teardown(why, failed = false)
                return@onHandlerQuietly
            }
            if (gattServer?.close(linkId, why) == true) return@onHandlerQuietly
            // Not ours, or already gone. close() is idempotent and always
            // eventually produces a closed state, so a second disconnect for a
            // link that has already finished is a no-op rather than an error.
            links[linkId]?.close(why, failed = false)
        }
    }

    override fun send(linkId: String, data: ByteArray, reliable: Boolean, completion: (Result<Unit>) -> Unit) {
        val h = handlerRef
        if (h == null) {
            completion(Result.failure(BleErrors.notStarted()))
            return
        }
        // Posted, never run inline: this is what makes "callbacks are never
        // delivered re-entrantly from inside a send call" true even for the
        // failure paths, which are the easy ones to get wrong.
        val posted = h.post {
            val link = links[linkId]
            if (link == null) {
                completion(Result.failure(BleErrors.unknownLink(linkId)))
                return@post
            }
            link.enqueue(data, reliable) { error ->
                completion(if (error == null) Result.success(Unit) else Result.failure(error))
            }
        }
        if (!posted) completion(Result.failure(BleErrors.notStarted()))
    }

    override fun metrics(linkId: String): LinkMetricsSnapshot? {
        val link = links[linkId] ?: return null
        // Ask for a fresh RSSI in the background; this call answers with what
        // we have. A read is a queued GATT operation, so it must never block a
        // metrics poll and must never jump the queue in front of a datagram.
        handlerRef?.post {
            connections.values.firstOrNull { it.linkId == linkId }?.refreshRssi()
        }
        return link.metrics()
    }

    // -- BleLinkHost -----------------------------------------------------------

    override val handler: Handler get() = ensureHandler()

    override fun onLinkOpened(link: BleLink) {
        links[link.id] = link
        emit {
            it.linkOpened(
                linkId = link.id,
                transport = TransportKind.BLE,
                endpointId = link.endpointId,
                maxDatagramSize = link.maxDatagramSize,
                highBandwidth = link.highBandwidth,
                incoming = link.incoming,
            )
        }
    }

    override fun onLinkState(link: BleLink, state: LinkState, reason: String) {
        emit { it.linkState(link.id, state, reason) }
    }

    override fun onLinkData(link: BleLink, data: ByteArray) {
        emit { it.received(link.id, data) }
    }

    override fun onLinkDatagramSizeChanged(link: BleLink, maxDatagramSize: Int) {
        emit { it.mtuChanged(link.id, maxDatagramSize) }
    }

    override fun onLinkRetired(link: BleLink) {
        links.remove(link.id)
    }

    override fun log(level: String, message: String) = host_log(level, message)

    // -- radio state -----------------------------------------------------------

    private var adapterReceiver: BroadcastReceiver? = null

    private fun registerAdapterReceiver() {
        if (adapterReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
                val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
                handlerRef?.post { onAdapterState(state) }
            }
        }
        val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // Only the system sends this, so the receiver is not exported -
                // required from API 33 and the right answer on every version.
                appContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                appContext.registerReceiver(receiver, filter)
            }
            adapterReceiver = receiver
        } catch (t: Throwable) {
            host_log("warn", "could not observe the Bluetooth adapter: ${t.javaClass.simpleName}")
        }
    }

    private fun unregisterAdapterReceiver() {
        val receiver = adapterReceiver ?: return
        adapterReceiver = null
        try {
            appContext.unregisterReceiver(receiver)
        } catch (_: Throwable) {
            // Already gone. Not worth a line in the log.
        }
    }

    /**
     * The radio being switched off mid-session has to produce a clean state
     * event, not a crash and not a link that claims to be connected.
     *
     * TURNING_OFF is handled rather than OFF because it arrives while the stack
     * can still be talked to: sockets close, the advertiser stops, and the
     * links report closed in the ordinary way. By the time OFF arrives every
     * call into the stack would be throwing.
     *
     * What this does NOT do is reconnect anything when the radio comes back. It
     * restores the discovery and advertising we were asked for - the state the
     * caller believes we are in - and leaves reopening links to the connection
     * state machine in TypeScript, which owns the backoff and the session that
     * survives the gap.
     */
    private fun onAdapterState(state: Int) {
        when (state) {
            BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> {
                if (!started) return
                host_log("info", "Bluetooth is switching off; closing everything cleanly")

                scanner?.stop()
                connections.values.toList().forEach { it.teardown("Bluetooth was switched off", failed = true) }
                connections.clear()
                gattServer?.stop()
                links.values.toList().forEach { it.close("Bluetooth was switched off", failed = true) }
                links.clear()

                emit { it.availabilityChanged(TransportKind.BLE, false, UnavailableReason.RADIO_OFF) }
            }

            BluetoothAdapter.STATE_ON -> {
                if (!started) return
                host_log("info", "Bluetooth is back; restoring discovery and advertising")
                val uuids = configuration
                if (uuids != null) {
                    val server = BleGattServer(
                        context = appContext,
                        availability = availability,
                        host = this,
                        newLinkId = { newLinkId() },
                        onIncomingLink = { link -> registerIncoming(link) },
                    )
                    gattServer = server
                    server.start(uuids)

                    val token = advertisedToken
                    if (token != null) {
                        try {
                            server.startAdvertising(token, advertisedName)
                        } catch (t: Throwable) {
                            host_log("warn", "could not resume advertising: ${t.message ?: "unknown"}")
                        }
                    }
                    if (wantsDiscovery) {
                        try {
                            scanner?.start(uuids.service)
                        } catch (t: Throwable) {
                            host_log("warn", "could not resume discovery: ${t.message ?: "unknown"}")
                        }
                    }
                }
                val state = availability.availability()
                emit {
                    it.availabilityChanged(TransportKind.BLE, state.available, state.reason)
                }
            }
        }
    }

    // -- internals -------------------------------------------------------------

    private fun registerIncoming(link: BleLink) {
        links[link.id] = link
        // The only signal strength we have for a peer that dialled us is the
        // one we measured from its advertisement: a GATT server has no
        // equivalent of readRemoteRssi. Stale by a few seconds, and honest.
        scanner?.lastRssi(link.endpointId)?.let { link.updateRssi(it) }
    }

    private fun newLinkId(): String = "ble-" + UUID.randomUUID().toString()

    /**
     * Hands an event to the sink, on the handler thread, without letting a
     * throwing sink take the radio down with it.
     */
    private inline fun emit(block: (TransportEventSink) -> Unit) {
        val sink = events ?: return
        try {
            block(sink)
        } catch (t: Throwable) {
            try {
                sink.log("error", "ble", "event sink threw ${t.javaClass.simpleName}")
            } catch (_: Throwable) {
                // A sink that throws from its own logger is beyond helping.
            }
        }
    }

    // Named with an underscore so it cannot be confused with the BleLinkHost
    // override of the same idea, which delegates here.
    private fun host_log(level: String, message: String) {
        val sink = events ?: return
        try {
            sink.log(level, "ble", message)
        } catch (_: Throwable) {
        }
    }

    @Synchronized
    private fun ensureHandler(): Handler {
        val existing = handlerRef
        if (existing != null) return existing
        val created = HandlerThread("airlink-ble", Process.THREAD_PRIORITY_FOREGROUND)
        created.start()
        val handler = Handler(created.looper)
        thread = created
        handlerRef = handler
        return handler
    }

    /**
     * Runs a block on the handler thread and waits for it, so a method the
     * interface declares as throwing can still throw.
     *
     * The wait is bounded. The handler thread only ever runs short, non-blocking
     * work - every socket operation is on a thread of its own - so exceeding
     * this means something is genuinely stuck, and reporting a timeout is far
     * better than hanging whichever thread the bridge called us on.
     */
    private fun <T> onHandler(what: String, block: () -> T): T {
        val h = handler
        if (Looper.myLooper() === h.looper) return block()

        val latch = CountDownLatch(1)
        var result: T? = null
        var failure: Throwable? = null
        val posted = h.post {
            try {
                result = block()
            } catch (t: Throwable) {
                failure = t
            } finally {
                latch.countDown()
            }
        }
        if (!posted) throw BleErrors.notStarted()
        if (!latch.await(HANDLER_CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            throw BleErrors.timeout(what)
        }
        failure?.let { throw it }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    /** For the interface methods that cannot report a failure anyway. */
    private fun onHandlerQuietly(block: () -> Unit) {
        val h = handlerRef ?: return
        if (Looper.myLooper() === h.looper) {
            try {
                block()
            } catch (t: Throwable) {
                host_log("warn", "${t.javaClass.simpleName}: ${t.message ?: "no detail"}")
            }
            return
        }
        h.post {
            try {
                block()
            } catch (t: Throwable) {
                host_log("warn", "${t.javaClass.simpleName}: ${t.message ?: "no detail"}")
            }
        }
    }

    private companion object {
        const val HANDLER_CALL_TIMEOUT_MS = 5_000L
    }
}
