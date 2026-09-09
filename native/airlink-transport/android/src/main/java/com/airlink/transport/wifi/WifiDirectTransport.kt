package com.airlink.transport.wifi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.MacAddress
import android.net.wifi.WifiManager
import android.net.wifi.WpsInfo
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pDeviceList
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.airlink.transport.AirLinkError
import com.airlink.transport.AirLinkTransport
import com.airlink.transport.Availability
import com.airlink.transport.DiscoveredEndpoint
import com.airlink.transport.LinkMetricsSnapshot
import com.airlink.transport.LinkState
import com.airlink.transport.Permissions
import com.airlink.transport.TransportConfiguration
import com.airlink.transport.TransportEventSink
import com.airlink.transport.TransportKind
import com.airlink.transport.UnavailableReason
import java.io.IOException
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Wi-Fi Direct (Wi-Fi P2P).
 *
 * Android to Android only. There is no iOS equivalent - an iPhone cannot join a
 * Wi-Fi Direct group at all - so this transport is an upgrade for the
 * Android-to-Android case and never a substitute for BLE or for the hotspot
 * handoff. Two Android phones in airplane mode with Wi-Fi on can reach several
 * MB/s over it, which is the difference between a photo taking three seconds and
 * taking four minutes.
 *
 * Once a group is formed this is just TCP over the p2p interface, so it reuses
 * the framing in FramedTcp unchanged. The datagram contract, the maximum size
 * and the wire format are all identical to the local-network transport.
 *
 * SHAPE OF THE FLOW, because Wi-Fi Direct is not obvious:
 *
 *   discoverPeers  -> WIFI_P2P_PEERS_CHANGED -> requestPeers -> peers we report
 *   connect        -> the two devices negotiate which one is the GROUP OWNER
 *   CONNECTION_CHANGED -> requestConnectionInfo -> groupOwnerAddress
 *   group owner listens on a fixed TCP port; the client dials it
 *
 * The framing, the maximum datagram size and every guarantee in the datagram
 * contract come from FramedTcp, shared with LocalNetworkTransport.
 */
class WifiDirectTransport(private val context: Context) : AirLinkTransport {

    private companion object {
        const val SCOPE = "wifiDirect"

        /**
         * Wi-Fi Direct gives us no way to publish a port: there is no TXT record
         * and no service registry unless we also run DNS-SD over p2p, which is a
         * second discovery mechanism to keep in step for no real gain. So the
         * group owner listens on one fixed port. If some other app on the phone
         * has taken it the bind fails and we report that honestly rather than
         * guessing another one, because the peer would have no way to learn it.
         */
        const val GROUP_OWNER_PORT = 49_711

        /** A group owner may not be listening the instant the group forms. */
        const val DIAL_RETRY_DELAY_MS = 300L

        /**
         * discoverPeers is a one-shot scan that the framework stops on its own
         * after a while. Re-issuing it is how "discovery is on" stays true.
         */
        const val DISCOVERY_REFRESH_MS = 30_000L

        const val MAX_LINKS = 4

        /** Upper bound on peers we will report from one scan. */
        const val MAX_PEERS = 32
    }

    override val kind: TransportKind = TransportKind.WIFI_DIRECT
    override var events: TransportEventSink? = null

    /**
     * The p2p framework delivers every callback on the Looper passed to
     * initialize(), so making that our own thread means all state below is
     * confined to one thread without a single lock. Kept alive across stop() so
     * a restart is cheap and cannot race with in-flight callbacks.
     */
    private val controlThread = HandlerThread("airlink-wifidirect").apply {
        isDaemon = true
        start()
    }
    private val control = Handler(controlThread.looper)
    private val controlExecutor = Executor { runnable -> control.post(runnable) }

    private val manager: WifiP2pManager? =
        context.applicationContext.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    private val wifiManager: WifiManager? =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager

    private var channel: WifiP2pManager.Channel? = null
    private var receiver: BroadcastReceiver? = null

    /** Read by the accept and dial threads, written only on `control`. */
    @Volatile
    private var started = false
    private var discovering = false

    /**
     * Mirrors WIFI_P2P_STATE_CHANGED, which is where Wi-Fi being switched off
     * lands. That broadcast is NOT sticky, so until one arrives we have no
     * direct reading and fall back to whether Wi-Fi is on at all - p2p cannot be
     * enabled without it, so the fallback is never wrong in the direction that
     * matters (telling a user to turn on a radio that is already on).
     */
    private var p2pEnabled = false
    private var p2pStateKnown = false

    private val peers = LinkedHashMap<String, WifiP2pDevice>()
    private val links = ConcurrentHashMap<String, LinkRecord>()
    private var server: FramedTcpServer? = null

    private var pending: PendingConnect? = null
    private var pendingTimeout: Runnable? = null
    private val dialing = AtomicBoolean(false)
    private var groupFormed = false

    private val linkCounter = AtomicLong(0)

    private class LinkRecord(val link: FramedTcpLink, val endpointId: String)

    private class PendingConnect(
        val endpointId: String,
        val completion: (Result<String>) -> Unit,
        val deadlineUptimeMs: Long,
    )

    // -- availability ---------------------------------------------------------

    override fun availability(): Availability {
        if (manager == null ||
            !context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)
        ) {
            return Availability(
                false,
                UnavailableReason.UNSUPPORTED_HARDWARE,
                "This device does not support Wi-Fi Direct.",
            )
        }
        val permission = Permissions.transportState(context, null, kind)
        if (permission != Permissions.State.GRANTED) {
            return Availability(false, Permissions.reasonFor(permission), permissionDetail(permission))
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && !isLocationEnabled()) {
            // Below Android 13 the p2p scan is treated as a location capability,
            // and it silently returns nothing when Location is switched off -
            // one of the most confusing failures on the platform.
            return Availability(
                false,
                UnavailableReason.PERMISSION_DENIED,
                "Turn on Location to let Android scan for nearby devices.",
            )
        }
        if (!p2pLikelyEnabled()) {
            return Availability(
                false,
                UnavailableReason.RADIO_OFF,
                "Turn on Wi-Fi to connect directly to nearby Android devices.",
            )
        }
        return Availability(true, UnavailableReason.NONE, "")
    }

    /**
     * NEARBY_WIFI_DEVICES from Android 13, ACCESS_FINE_LOCATION before it - the
     * matrix itself lives in Permissions.kt so BLE and Wi-Fi cannot drift apart.
     */
    private fun hasNearbyPermission(): Boolean =
        Permissions.runtimePermissions(kind).all { Permissions.isGranted(context, it) }

    private fun permissionDetail(state: Permissions.State): String = when (state) {
        // The honest one. On API 31 and 32 this build holds no permission that
        // can unlock Wi-Fi Direct, and no dialog will ever change that; see the
        // gap documented in Permissions.kt.
        Permissions.State.NOT_DECLARED ->
            "Wi-Fi Direct is not available on this version of Android. Bluetooth still works."
        else ->
            "AirLink needs permission to find nearby devices over Wi-Fi."
    }

    private fun p2pLikelyEnabled(): Boolean =
        if (p2pStateKnown) p2pEnabled else wifiManager?.isWifiEnabled == true

    private fun isLocationEnabled(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return true
        val locationManager =
            context.applicationContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                ?: return true
        return try {
            locationManager.isLocationEnabled
        } catch (_: RuntimeException) {
            true
        }
    }

    // -- lifecycle ------------------------------------------------------------

    override fun start(configuration: TransportConfiguration) {
        val p2p = manager ?: throw AirLinkError.Unsupported("Wi-Fi Direct")
        if (started) return

        val opened = try {
            p2p.initialize(context.applicationContext, controlThread.looper) {
                // The framework dropped our channel - usually because Wi-Fi was
                // turned off. Report it as state, never as a crash, and let the
                // layer above decide what to do about it.
                control.post {
                    channel = null
                    p2pEnabled = false
                    events?.availabilityChanged(kind, false, UnavailableReason.RADIO_OFF)
                    log("warn", "p2p channel disconnected")
                }
            }
        } catch (t: Throwable) {
            throw AirLinkError.Failed("could not open a Wi-Fi Direct channel: ${t.javaClass.simpleName}")
        }
        if (opened == null) throw AirLinkError.Failed("could not open a Wi-Fi Direct channel")
        channel = opened
        registerReceiver()
        started = true
    }

    override fun stop() {
        control.post {
            stopDiscoveryInternal()
            links.values.toList().forEach { it.link.close("transport stopped") }
            teardownGroup()
            server?.stop()
            server = null
            peers.clear()
            failPending(AirLinkError.Failed("transport stopped"))
            unregisterReceiver()
            channel?.let { open ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    try {
                        open.close()
                    } catch (_: RuntimeException) {
                    }
                }
            }
            channel = null
            started = false
        }
    }

    private fun registerReceiver() {
        if (receiver != null) return
        val filter = IntentFilter().apply {
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
        }
        val broadcastReceiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context?, intent: Intent?) {
                when (intent?.action) {
                    WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
                        val state = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1)
                        val enabled = state == WifiP2pManager.WIFI_P2P_STATE_ENABLED
                        val changed = !p2pStateKnown || enabled != p2pEnabled
                        p2pStateKnown = true
                        if (changed) {
                            p2pEnabled = enabled
                            events?.availabilityChanged(
                                kind,
                                enabled,
                                if (enabled) UnavailableReason.NONE else UnavailableReason.RADIO_OFF,
                            )
                        }
                        if (!enabled) {
                            // The radio went away underneath every link.
                            links.values.toList().forEach { it.link.close("Wi-Fi was switched off") }
                            failPending(AirLinkError.Failed("Wi-Fi was switched off"))
                        }
                    }

                    WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> requestPeersSafely()

                    WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> requestConnectionInfoSafely()
                }
            }
        }
        // Handed our own Handler so these arrive on the control thread with
        // everything else. RECEIVER_NOT_EXPORTED from Android 13: these are
        // protected system broadcasts and nothing else may deliver them to us.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(
                    broadcastReceiver,
                    filter,
                    null,
                    control,
                    Context.RECEIVER_NOT_EXPORTED,
                )
            } else {
                context.registerReceiver(broadcastReceiver, filter, null, control)
            }
            receiver = broadcastReceiver
        } catch (t: Throwable) {
            log("error", "could not register the p2p receiver: ${t.javaClass.simpleName}")
        }
    }

    private fun unregisterReceiver() {
        val existing = receiver ?: return
        receiver = null
        try {
            context.unregisterReceiver(existing)
        } catch (_: IllegalArgumentException) {
            // Not registered. Idempotent by design.
        }
    }

    // -- advertising ----------------------------------------------------------

    /**
     * A deliberate no-op, and the honest one.
     *
     * Wi-Fi Direct has no app-controlled advertisement payload: a device is
     * discoverable whenever p2p is enabled, and what a peer sees is the system
     * device name, which an app cannot set. The rotating token could be carried
     * by publishing a DNS-SD service over p2p (WifiP2pDnsSdServiceInfo +
     * addLocalService), but that is a second discovery mechanism to keep in step
     * with NSD for one field that only matters as an optimisation - the
     * TypeScript handshake establishes identity either way. So peers found here
     * are reported with an empty token and the user confirms the first meeting,
     * exactly as they would on a fresh BLE pairing.
     */
    override fun startAdvertising(token: ByteArray, displayName: String) {
        log("debug", "Wi-Fi Direct carries no advertisement payload; nothing to publish")
    }

    override fun stopAdvertising() {
        // Nothing was published; nothing to withdraw.
    }

    // -- discovery ------------------------------------------------------------

    override fun startDiscovery() {
        val p2p = manager ?: throw AirLinkError.Unsupported("Wi-Fi Direct")
        if (!started) throw AirLinkError.NotStarted()
        if (!hasNearbyPermission()) throw AirLinkError.PermissionDenied(kind)
        control.post {
            discovering = true
            issueDiscovery(p2p)
        }
    }

    private fun issueDiscovery(p2p: WifiP2pManager) {
        val open = channel ?: return
        if (!discovering) return
        try {
            p2p.discoverPeers(
                open,
                object : WifiP2pManager.ActionListener {
                    override fun onSuccess() {}

                    override fun onFailure(reason: Int) {
                        // BUSY simply means a scan is already running; that is
                        // the outcome we wanted anyway.
                        if (reason != WifiP2pManager.BUSY) {
                            log("warn", "discoverPeers failed: ${actionError(reason)}")
                        }
                    }
                },
            )
        } catch (e: SecurityException) {
            discovering = false
            log("error", "discoverPeers denied: ${e.javaClass.simpleName}")
            events?.availabilityChanged(kind, false, UnavailableReason.PERMISSION_DENIED)
            return
        }
        control.removeCallbacks(discoveryRefresh)
        control.postDelayed(discoveryRefresh, DISCOVERY_REFRESH_MS)
    }

    private val discoveryRefresh = Runnable {
        val p2p = manager
        if (discovering && p2p != null) issueDiscovery(p2p)
    }

    override fun stopDiscovery() {
        control.post { stopDiscoveryInternal() }
    }

    private fun stopDiscoveryInternal() {
        discovering = false
        control.removeCallbacks(discoveryRefresh)
        val p2p = manager ?: return
        val open = channel ?: return
        try {
            p2p.stopPeerDiscovery(open, null)
        } catch (e: SecurityException) {
            log("debug", "stopPeerDiscovery denied: ${e.javaClass.simpleName}")
        }
    }

    private fun requestPeersSafely() {
        val p2p = manager ?: return
        val open = channel ?: return
        if (!hasNearbyPermission()) return
        try {
            p2p.requestPeers(open) { list -> onPeers(list) }
        } catch (e: SecurityException) {
            log("warn", "requestPeers denied: ${e.javaClass.simpleName}")
        }
    }

    private fun onPeers(list: WifiP2pDeviceList?) {
        // Bounded: the peer list is attacker-influenced (anyone can advertise a
        // p2p device) and every entry costs an event across the bridge.
        val current = (list?.deviceList ?: emptyList<WifiP2pDevice>()).take(MAX_PEERS)
        val seen = HashSet<String>(current.size)

        current.forEach { device ->
            val address = device.deviceAddress ?: return@forEach
            seen.add(address)
            peers[address] = device
            events?.peerDiscovered(
                DiscoveredEndpoint(
                    kind,
                    address,
                    device.deviceName ?: "",
                    // No advertisement payload exists on this transport.
                    "",
                    // Wi-Fi Direct does not report signal strength to apps.
                    0,
                ),
            )
        }

        peers.keys.toList().forEach { address ->
            if (address in seen) return@forEach
            val gone = peers.remove(address) ?: return@forEach
            events?.peerLost(DiscoveredEndpoint(kind, address, gone.deviceName ?: "", "", 0))
        }
    }

    // -- links ----------------------------------------------------------------

    override fun connect(endpointId: String, timeoutMs: Int, completion: (Result<String>) -> Unit) {
        control.post {
            val p2p = manager
            val open = channel
            if (p2p == null || open == null || !started) {
                completion(Result.failure(AirLinkError.NotStarted()))
                return@post
            }
            if (!p2pLikelyEnabled()) {
                completion(Result.failure(AirLinkError.RadioOff(kind)))
                return@post
            }
            if (!hasNearbyPermission()) {
                completion(Result.failure(AirLinkError.PermissionDenied(kind)))
                return@post
            }
            if (pending != null) {
                // One negotiation at a time: the framework has a single p2p
                // state machine and a second connect would cancel the first.
                completion(Result.failure(AirLinkError.Busy("A Wi-Fi Direct connection")))
                return@post
            }
            if (links.size >= MAX_LINKS) {
                completion(Result.failure(AirLinkError.Failed("too many open links")))
                return@post
            }
            if (!peers.containsKey(endpointId)) {
                completion(Result.failure(AirLinkError.UnknownEndpoint(endpointId)))
                return@post
            }

            val budget = timeoutMs.coerceIn(5_000, 120_000)
            val request = PendingConnect(
                endpointId,
                completion,
                SystemClock.uptimeMillis() + budget,
            )
            pending = request

            val timeout = Runnable {
                if (pending === request) {
                    cancelConnectSafely()
                    failPending(AirLinkError.Timeout("connecting to $endpointId over Wi-Fi Direct"))
                }
            }
            pendingTimeout = timeout
            control.postDelayed(timeout, budget.toLong())

            val config = try {
                buildConfig(endpointId)
            } catch (_: IllegalArgumentException) {
                // The endpoint id is a MAC address handed to us by requestPeers;
                // if it will not parse, the peer entry is stale.
                failPending(AirLinkError.UnknownEndpoint(endpointId))
                return@post
            }

            try {
                p2p.connect(
                    open,
                    config,
                    object : WifiP2pManager.ActionListener {
                        override fun onSuccess() {
                            // Only means the request was accepted. The group is
                            // formed later, and reported by broadcast.
                        }

                        override fun onFailure(reason: Int) {
                            control.post {
                                if (pending === request) {
                                    failPending(
                                        AirLinkError.Failed("Wi-Fi Direct connect failed: ${actionError(reason)}"),
                                    )
                                }
                            }
                        }
                    },
                )
            } catch (_: SecurityException) {
                // The permission was revoked between the check above and here.
                failPending(AirLinkError.PermissionDenied(kind))
            }
        }
    }

    /**
     * WifiP2pConfig.Builder arrived in Android 10 and is the only non-deprecated
     * way to describe a connection; below that the public fields are all there
     * is. Persistent mode is switched off so AirLink never leaves a saved group
     * behind on either phone.
     */
    private fun buildConfig(deviceAddress: String): WifiP2pConfig {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return WifiP2pConfig.Builder()
                .setDeviceAddress(MacAddress.fromString(deviceAddress))
                .enablePersistentMode(false)
                .build()
        }
        // groupOwnerIntent is deliberately left at the constructor's default:
        // GROUP_OWNER_INTENT_AUTO only exists from API 29, so naming it here -
        // on the branch that exists for API 26 to 28 - would be a NoSuchFieldError
        // on exactly the devices this branch is for.
        return WifiP2pConfig().apply {
            this.deviceAddress = deviceAddress
            wps = WpsInfo().apply { setup = WpsInfo.PBC }
        }
    }

    private fun requestConnectionInfoSafely() {
        val p2p = manager ?: return
        val open = channel ?: return
        try {
            p2p.requestConnectionInfo(open) { info -> onConnectionInfo(info) }
        } catch (e: SecurityException) {
            log("warn", "requestConnectionInfo denied: ${e.javaClass.simpleName}")
        }
    }

    private fun onConnectionInfo(info: WifiP2pInfo?) {
        if (info == null) return
        if (!info.groupFormed) {
            if (groupFormed) {
                groupFormed = false
                server?.stop()
                server = null
                links.values.toList().forEach { it.link.close("the Wi-Fi Direct group went away") }
            }
            return
        }
        groupFormed = true

        if (info.isGroupOwner) {
            // We host. The other phone dials us on the fixed port.
            ensureServer()
        } else {
            val address = info.groupOwnerAddress ?: return
            dialGroupOwner(address)
        }
    }

    private fun ensureServer() {
        if (server != null) return
        val listener = FramedTcpServer(::log) { socket -> acceptIncoming(socket) }
        try {
            listener.start(GROUP_OWNER_PORT)
            server = listener
        } catch (e: IOException) {
            log("error", "could not listen on port $GROUP_OWNER_PORT: ${e.javaClass.simpleName}")
            failPending(AirLinkError.Failed("port $GROUP_OWNER_PORT is already in use"))
        }
    }

    private fun acceptIncoming(socket: Socket): Boolean {
        if (!started || links.size >= MAX_LINKS) return false
        control.post {
            val request = pending
            // If this socket is the answer to our own connect() we report it as
            // outgoing, because the app asked for it - which side of the TCP
            // handshake we ended up on is an accident of the group negotiation.
            val endpointId = request?.endpointId
                ?: "${socket.inetAddress?.hostAddress ?: "?"}:${socket.port}"
            val linkId = adopt(socket, endpointId, incoming = request == null)
            if (request != null) resolvePending(linkId)
        }
        return true
    }

    private fun dialGroupOwner(address: InetAddress) {
        if (!dialing.compareAndSet(false, true)) return
        val request = pending
        val deadline = request?.deadlineUptimeMs ?: (SystemClock.uptimeMillis() + 20_000L)

        Thread({
            var socket: Socket? = null
            while (SystemClock.uptimeMillis() < deadline) {
                socket = try {
                    FramedTcp.dial(listOf(address), GROUP_OWNER_PORT, 3_000)
                } catch (_: IOException) {
                    // The group owner binds its socket only once the group is up
                    // on its side too, so a refused connection here is normal for
                    // the first few hundred milliseconds.
                    null
                } catch (t: Throwable) {
                    log("error", "dial failed: ${t.javaClass.simpleName}")
                    null
                }
                if (socket != null) break
                try {
                    Thread.sleep(DIAL_RETRY_DELAY_MS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }

            val connected = socket
            control.post {
                dialing.set(false)
                if (connected == null) {
                    if (pending != null) {
                        failPending(AirLinkError.Timeout("reaching the Wi-Fi Direct group owner"))
                    }
                    return@post
                }
                if (!started) {
                    try {
                        connected.close()
                    } catch (_: IOException) {
                    }
                    return@post
                }
                val current = pending
                val endpointId = current?.endpointId ?: address.hostAddress ?: "group-owner"
                val linkId = adopt(connected, endpointId, incoming = current == null)
                if (current != null) resolvePending(linkId)
            }
        }, "airlink-p2p-dial").apply { isDaemon = true }.start()
    }

    /** Must run on the control thread. */
    private fun adopt(socket: Socket, endpointId: String, incoming: Boolean): String {
        val linkId = "wd-${linkCounter.incrementAndGet()}"
        val link = FramedTcpLink(linkId, socket, controlExecutor, linkListener, ::log)
        links[linkId] = LinkRecord(link, endpointId)

        events?.linkOpened(
            linkId,
            kind,
            endpointId,
            FramedTcp.MAX_DATAGRAM_BYTES,
            true,
            incoming,
        )
        events?.linkState(linkId, LinkState.CONNECTED, "")
        link.start()
        return linkId
    }

    private val linkListener = object : FramedTcpLink.Listener {
        override fun onDatagram(link: FramedTcpLink, payload: ByteArray) {
            events?.received(link.linkId, payload)
        }

        override fun onClosed(link: FramedTcpLink, reason: String, failed: Boolean) {
            links.remove(link.linkId)
            events?.linkState(
                link.linkId,
                if (failed) LinkState.FAILED else LinkState.CLOSED,
                reason,
            )
            // A p2p group with nothing running over it keeps the radio busy and
            // blocks the next connect, so it is torn down once it is idle. When
            // to reconnect is still entirely the TypeScript layer's decision.
            if (links.isEmpty() && pending == null) teardownGroup()
        }
    }

    private fun resolvePending(linkId: String) {
        val request = pending ?: return
        clearPending()
        request.completion(Result.success(linkId))
    }

    private fun failPending(error: Throwable) {
        val request = pending ?: return
        clearPending()
        request.completion(Result.failure(error))
    }

    private fun clearPending() {
        pending = null
        pendingTimeout?.let { control.removeCallbacks(it) }
        pendingTimeout = null
    }

    private fun cancelConnectSafely() {
        val p2p = manager ?: return
        val open = channel ?: return
        try {
            p2p.cancelConnect(open, null)
        } catch (_: RuntimeException) {
        }
    }

    private fun teardownGroup() {
        server?.stop()
        server = null
        groupFormed = false
        val p2p = manager ?: return
        val open = channel ?: return
        try {
            p2p.removeGroup(
                open,
                object : WifiP2pManager.ActionListener {
                    override fun onSuccess() {}

                    override fun onFailure(reason: Int) {
                        // Usually "no group to remove". Not worth a log line above debug.
                        log("debug", "removeGroup: ${actionError(reason)}")
                    }
                },
            )
        } catch (_: RuntimeException) {
        }
    }

    override fun disconnect(linkId: String, reason: String) {
        control.post {
            val record = links[linkId] ?: return@post
            events?.linkState(linkId, LinkState.CLOSING, reason)
            record.link.close(reason)
        }
    }

    override fun send(linkId: String, data: ByteArray, reliable: Boolean, completion: (Result<Unit>) -> Unit) {
        control.post {
            val record = links[linkId]
            if (record == null) {
                completion(Result.failure(AirLinkError.UnknownLink(linkId)))
                return@post
            }
            if (data.size > FramedTcp.MAX_DATAGRAM_BYTES) {
                completion(
                    Result.failure(AirLinkError.PayloadTooLarge(data.size, FramedTcp.MAX_DATAGRAM_BYTES)),
                )
                return@post
            }
            record.link.send(data, reliable) { result ->
                completion(
                    result.fold(
                        onSuccess = { Result.success(Unit) },
                        onFailure = { Result.failure(AirLinkError.Failed(it.message ?: "send failed")) },
                    ),
                )
            }
        }
    }

    override fun metrics(linkId: String): LinkMetricsSnapshot? {
        val record = links[linkId] ?: return null
        val stats = record.link.stats()
        return LinkMetricsSnapshot(
            maxDatagramSize = FramedTcp.MAX_DATAGRAM_BYTES,
            rssi = 0,
            packetsSent = stats.packetsSent.toInt(),
            packetsReceived = stats.packetsReceived.toInt(),
            packetsDropped = stats.packetsDropped.toInt(),
            bytesSent = stats.bytesSent,
            bytesReceived = stats.bytesReceived,
            throughput = stats.throughput,
        )
    }

    // -- helpers --------------------------------------------------------------

    private fun actionError(reason: Int): String = when (reason) {
        WifiP2pManager.P2P_UNSUPPORTED -> "Wi-Fi Direct is not supported"
        WifiP2pManager.BUSY -> "the Wi-Fi Direct framework is busy"
        WifiP2pManager.NO_SERVICE_REQUESTS -> "no service requests"
        WifiP2pManager.ERROR -> "internal error"
        else -> "error $reason"
    }

    private fun log(level: String, message: String) {
        events?.log(level, SCOPE, message)
    }
}
