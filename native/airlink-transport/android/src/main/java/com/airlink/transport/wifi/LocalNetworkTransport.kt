package com.airlink.transport.wifi

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Base64
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
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Network Service Discovery (mDNS/DNS-SD) plus length-framed TCP.
 *
 * This is the cross-platform high-bandwidth path and the mirror of the iOS
 * Bonjour transport: NSD and Bonjour are the same protocol, so an Android phone
 * and an iPhone on the same Wi-Fi - a router with no WAN, plane Wi-Fi, or the
 * local-only hotspot one of them is hosting - find each other and move photos
 * at real Wi-Fi speed instead of the ~5-40 KB/s that BLE gives us.
 *
 * The wire format is defined once, in FramedTcp. Read that comment before
 * changing anything here.
 *
 * ===========================================================================
 * THE TXT RECORD - iOS must publish and read exactly these keys
 * ===========================================================================
 *
 *   "v"  protocol version, decimal ASCII. Currently "1".
 *   "t"  base64 of the rotating 6-byte advertisement token, NO padding-free
 *        variant tricks: standard base64, no line wrapping. Empty or absent
 *        when we are not advertising a token.
 *   "n"  the user's short display name, UTF-8, present only when the user has
 *        opted in to sharing it. Absent otherwise - never an empty string, so
 *        "did they opt in" is answered by presence alone.
 *
 * Keys are one character because a DNS-SD TXT record is small and this is the
 * only place a byte matters. Nothing in the record is trusted: the display name
 * is attacker-controlled text and the token only becomes meaningful after the
 * TypeScript layer matches it against a paired identity.
 * ===========================================================================
 *
 * WHEN THERE IS NO NETWORK AT ALL, one of the two phones raises one: see
 * HotspotHost.kt. That is not a transport and it is not owned here - a hotspot
 * exists solely so that this transport has somewhere to run, and the module
 * starts it on request. Everything below is identical either way, which is the
 * point: this code cannot tell a plane's Wi-Fi from a friend's hotspot.
 *
 * NewApi is suppressed at the class level rather than at each call: every
 * API-34 entry point below sits behind an explicit `Build.VERSION.SDK_INT`
 * check, and scattering the suppression made the version ladder harder to read
 * than the ladder itself.
 */
@SuppressLint("NewApi")
class LocalNetworkTransport(private val context: Context) : AirLinkTransport {

    private companion object {
        const val SCOPE = "localNetwork"

        /**
         * Wi-Fi is fast enough that eight simultaneous links is far more than a
         * social app needs, and each link costs two threads and a socket. A
         * flood of inbound connections is refused rather than allowed to
         * exhaust file descriptors.
         */
        const val MAX_LINKS = 8

        /** How many discovered services we will track at once. Bounds a hostile network. */
        const val MAX_TRACKED_ENDPOINTS = 32

        /** Display names longer than this are truncated before publishing. */
        const val MAX_DISPLAY_NAME_CHARS = 24

        /** Hard cap on any single TXT value we will carry across the bridge. */
        const val MAX_TXT_VALUE_CHARS = 64

        /**
         * Ceiling on a decoded advertisement token. The real one is 6 bytes;
         * this is only here so a peer cannot hand us a blob to carry. The same
         * number is used on the iOS side.
         */
        const val MAX_TOKEN_BYTES = 32

        /**
         * A resolve that never calls back would leak a listener slot for the
         * life of the process, so every one gets a deadline.
         */
        const val RESOLVE_TIMEOUT_MS = 10_000L

        /**
         * How often to re-announce peers this browse can still see.
         *
         * NSD is LEVEL-triggered: `onServiceFound` fires once when a service
         * appears and never again while it stays there. The presence layer
         * above is EDGE-triggered - it forgets a peer that stops being
         * announced, because no radio has a dependable "gone" signal - so a
         * transport that only reports changes loses a peer who is standing
         * right there. Bridging the two is this transport's job.
         *
         * The same number is `TIMING.presenceRefreshMs` in packages/core, and
         * `TransportEvents.peerDiscovered` records what went wrong without it.
         */
        const val PRESENCE_REFRESH_MS = 5_000L

        const val TXT_VERSION = "v"
        const val TXT_TOKEN = "t"
        const val TXT_NAME = "n"

        /**
         * Android 17 (SDK 37) makes local network access a runtime permission.
         * The constant does not exist in the SDK this module compiles against,
         * so it is spelled out; the string is stable platform API.
         */
        const val ACCESS_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
        const val ANDROID_17 = 37
    }

    override val kind: TransportKind = TransportKind.LOCAL_NETWORK

    override var events: TransportEventSink? = null

    /**
     * Every mutation of the state below happens on this one thread, so none of
     * it needs a lock and none of it can race with an NSD callback. It is
     * created once and outlives stop(): a transport may be started again, and
     * quiescing a thread is far less error-prone than tearing one down while
     * link callbacks are still in flight.
     */
    private val control: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "airlink-localnet").apply { isDaemon = true }
        }

    private val nsdManager: NsdManager? =
        context.applicationContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
    private val connectivity: ConnectivityManager? =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    /** These three are read on the caller's thread and cleared on `control`. */
    @Volatile
    private var configuration: TransportConfiguration? = null

    @Volatile
    private var started = false

    @Volatile
    private var server: FramedTcpServer? = null
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    /**
     * Whether the caller has asked us to be discovering right now.
     *
     * Separate from [discoveryListener] because the framework's own view lags
     * ours in both directions: `stopServiceDiscovery` is asynchronous, and a
     * resolve or a service-info update that was already in flight when it was
     * called still lands afterwards. Without this flag those late callbacks
     * publish a `peerDiscovered` for a transport that has stopped discovering,
     * and the layer above then holds an endpoint it will never be told is gone.
     */
    private var discovering = false
    /** Drives the presence heartbeat while a browse is live. */
    private var presenceTask: ScheduledFuture<*>? = null

    /** The name the system actually registered - it renames us on a collision. */
    private var registeredServiceName: String? = null
    /** The name we asked for, needed to recognise our own service before registration completes. */
    private var requestedServiceName: String? = null

    private val endpoints = LinkedHashMap<String, ResolvedEndpoint>()

    /**
     * Concurrent because metrics() is answered on the caller's thread and the
     * accept loop peeks at the count; every mutation still happens on `control`.
     */
    private val links = ConcurrentHashMap<String, LinkRecord>()

    /** API 34+: one live callback per discovered service. Must be unregistered. */
    private val serviceInfoCallbacks = HashMap<String, NsdManager.ServiceInfoCallback>()

    /**
     * Below API 34 the deprecated resolveService is all we have, and on older
     * releases only one resolve may be in flight at a time - a second returns
     * FAILURE_ALREADY_ACTIVE. Serialising them costs a little latency and
     * removes an entire class of "discovery silently stops working" bugs.
     */
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolveInFlight = false
    /** Distinguishes "my resolve timed out" from "a later resolve is running". */
    private var resolveGeneration = 0L

    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    /** Read by the dial thread when binding a socket; written only on `control`. */
    @Volatile
    private var localNetwork: Network? = null

    private val linkCounter = AtomicLong(0)

    private data class ResolvedEndpoint(
        val serviceName: String,
        val addresses: List<InetAddress>,
        val port: Int,
        val displayName: String,
        val token: String,
    )

    private class LinkRecord(val link: FramedTcpLink, val endpointId: String)

    // -- availability ---------------------------------------------------------

    override fun availability(): Availability {
        if (nsdManager == null) {
            return Availability(
                false,
                UnavailableReason.UNSUPPORTED_HARDWARE,
                "This device has no network service discovery support.",
            )
        }
        if (!hasLocalNetworkPermission()) {
            return Availability(
                false,
                UnavailableReason.PERMISSION_NOT_REQUESTED,
                "AirLink needs permission to talk to devices on your local network.",
            )
        }
        if (!hasUsableLocalNetwork()) {
            return Availability(
                false,
                UnavailableReason.NO_LOCAL_NETWORK,
                "Join a Wi-Fi network - or have your friend share theirs - to use the fast connection.",
            )
        }
        return Availability(true, UnavailableReason.NONE, "")
    }

    /**
     * NSD plus a TCP socket needs no dangerous permission today - Android has no
     * equivalent of the iOS local-network prompt - which is why
     * Permissions.runtimePermissions(LOCAL_NETWORK) is empty.
     *
     * Android 17 (SDK 37) changes that: an app targeting it that has not been
     * granted ACCESS_LOCAL_NETWORK gets timeouts on local TCP and EPERM on
     * multicast, with no error that tells the user anything. We only enforce it
     * when the merged manifest actually declares the permission, because an app
     * whose targetSdk is still below 37 keeps the implicit grant and asking
     * about a permission it never declared would report a false negative.
     */
    private fun hasLocalNetworkPermission(): Boolean {
        if (Build.VERSION.SDK_INT < ANDROID_17) return true
        if (!Permissions.isDeclared(context, ACCESS_LOCAL_NETWORK)) return true
        return Permissions.isGranted(context, ACCESS_LOCAL_NETWORK)
    }

    /**
     * Any local IP network will do - this transport does not need the internet
     * and must never require it, because the whole product exists for the case
     * where there is none.
     */
    private fun hasUsableLocalNetwork(): Boolean {
        if (localNetwork != null) return true
        val manager = connectivity ?: return false
        return try {
            val active = manager.activeNetwork ?: return false
            val capabilities = manager.getNetworkCapabilities(active) ?: return false
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        } catch (e: SecurityException) {
            log("warn", "ACCESS_NETWORK_STATE denied: ${e.javaClass.simpleName}")
            false
        }
    }

    // -- lifecycle ------------------------------------------------------------

    override fun start(configuration: TransportConfiguration) {
        // Fail here rather than at the first advertise: an absent NsdManager is a
        // property of the device, not of this call.
        if (nsdManager == null) throw AirLinkError.Failed("network service discovery is unavailable")
        if (started) return
        this.configuration = configuration
        started = true

        val listening = FramedTcpServer(::log) { socket -> acceptIncoming(socket) }
        try {
            // Port 0: the OS picks, and we publish whatever we get in the TXT
            // record. Nothing here may hard-code a port - two AirLink installs on
            // the same network would collide on it.
            listening.start(0)
        } catch (e: IOException) {
            started = false
            this.configuration = null
            throw AirLinkError.Failed("could not open a listening socket: ${e.javaClass.simpleName}")
        }
        server = listening

        onControl { watchLocalNetwork() }
        log("info", "listening on port ${listening.port}")
    }

    override fun stop() {
        // Everything start() created is released synchronously HERE and torn
        // down on the control thread afterwards, because the module is allowed
        // to stop() and start() again in a single pass - that is what a
        // configuration change does. If this method only posted, the posted
        // teardown would run after the new start() and close the NEW listening
        // socket, leaving a transport that is "started" and unreachable.
        // Capturing the old socket keeps the two sessions apart.
        started = false
        configuration = null
        val listening = server
        server = null

        onControl {
            stopAdvertisingInternal()
            stopDiscoveryInternal()
            listening?.stop()
            endpoints.clear()
            unwatchLocalNetwork()
            // Closing every link produces a `closed` state event for each, which
            // is what the layer above needs to stop waiting on them.
            links.values.toList().forEach { it.link.close("transport stopped") }
        }
    }

    private fun watchLocalNetwork() {
        val manager = connectivity ?: return
        if (networkCallback != null) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                onControl {
                    localNetwork = network
                    events?.availabilityChanged(kind, true, UnavailableReason.NONE)
                }
            }

            override fun onLost(network: Network) {
                onControl {
                    if (localNetwork == network) localNetwork = null
                    if (!hasUsableLocalNetwork()) {
                        // Wi-Fi being switched off mid-session is a state event,
                        // never an exception. The links die with it and each one
                        // reports itself closed.
                        events?.availabilityChanged(kind, false, UnavailableReason.NO_LOCAL_NETWORK)
                    }
                }
            }
        }
        // clearCapabilities() matters: the default request demands
        // NET_CAPABILITY_INTERNET, and the networks this product cares about -
        // a hotspot with no uplink, a plane's Wi-Fi - do not have it.
        val request = NetworkRequest.Builder()
            .clearCapabilities()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        try {
            manager.registerNetworkCallback(request, callback)
            networkCallback = callback
        } catch (e: SecurityException) {
            log("warn", "cannot watch the network: ${e.javaClass.simpleName}")
        } catch (e: RuntimeException) {
            // Too many outstanding requests: not fatal, we just lose live updates.
            log("warn", "network callback rejected: ${e.javaClass.simpleName}")
        }
    }

    private fun unwatchLocalNetwork() {
        val manager = connectivity ?: return
        val callback = networkCallback ?: return
        networkCallback = null
        localNetwork = null
        try {
            manager.unregisterNetworkCallback(callback)
        } catch (_: IllegalArgumentException) {
            // Already gone. Nothing to do.
        }
    }

    // -- advertising ----------------------------------------------------------

    override fun startAdvertising(token: ByteArray, displayName: String) {
        val manager = nsdManager ?: throw AirLinkError.Failed("network service discovery is unavailable")
        val config = configuration ?: throw AirLinkError.NotStarted()
        val tcpServer = server ?: throw AirLinkError.NotStarted()
        if (tcpServer.port == 0) throw AirLinkError.NotStarted()

        val tokenBase64 = if (token.isEmpty()) "" else Base64.encodeToString(token, Base64.NO_WRAP)
        // The instance name is public, so it is derived from the rotating token
        // rather than from anything durable. Two devices advertising the same
        // token would collide, and mDNS resolves that by renaming one of them -
        // which onServiceRegistered tells us about.
        val suffix = if (tokenBase64.length >= 6) {
            tokenBase64.substring(0, 6).replace(Regex("[^A-Za-z0-9]"), "0")
        } else {
            java.lang.Long.toHexString(System.nanoTime() and 0xFFFFFF)
        }
        val instanceName = "AirLink-$suffix"

        onControl {
            stopAdvertisingInternal()

            val info = NsdServiceInfo().apply {
                serviceName = instanceName
                serviceType = normaliseServiceType(config.bonjourServiceType)
                port = tcpServer.port
                setAttribute(TXT_VERSION, "1")
                if (tokenBase64.isNotEmpty()) setAttribute(TXT_TOKEN, tokenBase64)
                // Presence of the key is the opt-in signal, so an empty name is
                // published as no key at all rather than as "".
                if (displayName.isNotEmpty()) {
                    setAttribute(TXT_NAME, displayName.take(MAX_DISPLAY_NAME_CHARS))
                }
            }

            val registration = RegistrationSession(tcpServer.port)

            requestedServiceName = instanceName
            try {
                manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration)
                registrationListener = registration
            } catch (e: RuntimeException) {
                // IllegalArgumentException for a malformed record, IllegalStateException
                // when NSD itself is wedged. Neither is worth crashing an offline app.
                requestedServiceName = null
                log("error", "advertising rejected: ${e.javaClass.simpleName}")
            }
        }
    }

    /**
     * One advertisement, for as long as it is the current one.
     *
     * A named class rather than an anonymous object for exactly the reason
     * [ServiceTracker] is: every callback checks it is still the CURRENT
     * registration before touching shared state. Rotating the token calls
     * startAdvertising again, which unregisters this one and registers the next,
     * and the platform then delivers this one's `onServiceUnregistered` - or a
     * late `onRegistrationFailed` - AFTER the replacement is live. Without the
     * check those callbacks null out the NEW registration's listener and name:
     * the new advertisement is then never unregistered (a leaked NSD
     * registration) and `handleServiceFound` stops recognising our own service,
     * so we report ourselves to JavaScript as a peer.
     */
    private inner class RegistrationSession(private val port: Int) : NsdManager.RegistrationListener {

        override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
            onControl {
                if (!isCurrent()) return@onControl
                registeredServiceName = serviceInfo.serviceName
                log("info", "advertising as ${serviceInfo.serviceName} on port $port")
            }
        }

        override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
            onControl {
                if (!isCurrent()) return@onControl
                registrationListener = null
                registeredServiceName = null
                // Cleared here too: nothing is advertising this name any more, so
                // keeping it would go on filtering a real peer that happened to
                // pick it. See the note in stopAdvertisingInternal().
                requestedServiceName = null
                log("error", "advertising failed: ${nsdError(errorCode)}")
                events?.availabilityChanged(kind, false, UnavailableReason.UNKNOWN)
            }
        }

        override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {
            onControl { if (isCurrent()) registeredServiceName = null }
        }

        override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
            onControl {
                if (!isCurrent()) return@onControl
                registeredServiceName = null
                log("warn", "unregister failed: ${nsdError(errorCode)}")
            }
        }

        /** Must run on the control thread. */
        private fun isCurrent(): Boolean = registrationListener === this
    }

    override fun stopAdvertising() {
        onControl { stopAdvertisingInternal() }
    }

    private fun stopAdvertisingInternal() {
        // Cleared BEFORE the early return below, and that order is the point.
        // onRegistrationFailed drops the listener but cannot clear the name we
        // ASKED for, so a failed advertisement used to leave `requestedServiceName`
        // set for the life of the process - and that name is what
        // handleServiceFound uses to recognise its own service. A real peer whose
        // instance name collided with it would then be filtered out as "us" and
        // never reported at all.
        registeredServiceName = null
        requestedServiceName = null
        val manager = nsdManager ?: return
        val listener = registrationListener ?: return
        registrationListener = null
        try {
            manager.unregisterService(listener)
        } catch (_: IllegalArgumentException) {
            // Never registered, or already unregistered. Idempotent by design.
        }
    }

    // -- discovery ------------------------------------------------------------

    override fun startDiscovery() {
        val manager = nsdManager ?: throw AirLinkError.Failed("network service discovery is unavailable")
        val config = configuration ?: throw AirLinkError.NotStarted()
        if (!hasLocalNetworkPermission()) throw AirLinkError.PermissionDenied(kind)
        val serviceType = normaliseServiceType(config.bonjourServiceType)

        onControl {
            discovering = true
            if (discoveryListener != null) return@onControl

            val listener = DiscoverySession()
            try {
                manager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
                discoveryListener = listener
                startPresenceHeartbeat()
            } catch (e: RuntimeException) {
                // Nothing is discovering, so nothing may publish a peer.
                discovering = false
                log("error", "discovery rejected: ${e.javaClass.simpleName}")
            }
        }
    }

    /**
     * One browse, for as long as it is the current one.
     *
     * Named, and current-checked, for the same reason [ServiceTracker] and
     * [RegistrationSession] are. `stopServiceDiscovery` is asynchronous: a
     * stop() immediately followed by a start() - which is what a configuration
     * change does - leaves the OLD browse's `onDiscoveryStopped` arriving after
     * the NEW one is live. An unchecked callback would then null out the new
     * listener, so `stopDiscoveryInternal` could never unregister it: a leaked
     * NSD browse that keeps the radio awake and a second browse layered on top
     * of it the next time discovery starts.
     */
    private inner class DiscoverySession : NsdManager.DiscoveryListener {

        override fun onDiscoveryStarted(regType: String) {
            onControl { log("info", "discovering $regType") }
        }

        override fun onStartDiscoveryFailed(failedType: String, errorCode: Int) {
            onControl {
                if (!isCurrent()) return@onControl
                discoveryListener = null
                // Nothing is discovering, so nothing may publish a peer.
                discovering = false
                log("error", "discovery failed to start: ${nsdError(errorCode)}")
                events?.availabilityChanged(kind, false, UnavailableReason.UNKNOWN)
            }
        }

        override fun onStopDiscoveryFailed(failedType: String, errorCode: Int) {
            onControl { log("warn", "discovery failed to stop: ${nsdError(errorCode)}") }
        }

        override fun onDiscoveryStopped(stoppedType: String) {
            onControl {
                if (!isCurrent()) return@onControl
                discoveryListener = null
                discovering = false
            }
        }

        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
            onControl { if (isCurrent()) handleServiceFound(serviceInfo) }
        }

        override fun onServiceLost(serviceInfo: NsdServiceInfo) {
            onControl { if (isCurrent()) handleServiceLost(serviceInfo.serviceName) }
        }

        /** Must run on the control thread. */
        private fun isCurrent(): Boolean = discoveryListener === this
    }

    override fun stopDiscovery() {
        onControl { stopDiscoveryInternal() }
    }

    /**
     * Tell the layer above that everyone we can see is still there.
     *
     * See [PRESENCE_REFRESH_MS]. Announcing a peer that has actually gone is
     * the cheaper error: the row is untrusted, a dial to it fails gracefully,
     * and `onServiceLost` corrects it.
     */
    private fun startPresenceHeartbeat() {
        presenceTask?.cancel(false)
        presenceTask = control.scheduleWithFixedDelay(
            // Explicitly a Runnable for the same reason the resolve timeout is:
            // ScheduledExecutorService swallows a throw into the future, and a
            // repeating task that throws is silently cancelled for ever.
            Runnable {
                if (!discovering) return@Runnable
                for (endpoint in endpoints.values.toList()) {
                    events?.peerDiscovered(endpointOf(endpoint))
                }
            },
            PRESENCE_REFRESH_MS,
            PRESENCE_REFRESH_MS,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun stopDiscoveryInternal() {
        discovering = false
        presenceTask?.cancel(false)
        presenceTask = null
        val manager = nsdManager ?: return
        discoveryListener?.let { listener ->
            discoveryListener = null
            try {
                manager.stopServiceDiscovery(listener)
            } catch (_: IllegalArgumentException) {
                // Not running. Fine.
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            serviceInfoCallbacks.values.toList().forEach { callback ->
                try {
                    manager.unregisterServiceInfoCallback(callback)
                } catch (_: IllegalArgumentException) {
                    // Already unregistered by the framework.
                }
            }
        }
        serviceInfoCallbacks.clear()
        resolveQueue.clear()
        resolveInFlight = false
    }

    private fun handleServiceFound(serviceInfo: NsdServiceInfo) {
        if (!discovering) return
        val config = configuration ?: return
        val name = serviceInfo.serviceName ?: return
        if (!sameServiceType(serviceInfo.serviceType, config.bonjourServiceType)) return
        // Our own advertisement comes back to us; there is no flag for it, only
        // the name, which is why we remember both what we asked for and what the
        // system settled on after any collision rename.
        if (name == registeredServiceName || name == requestedServiceName) return
        if (serviceInfoCallbacks.containsKey(name)) return
        // Three separate bounds because a service can sit in any one of these
        // and never reach the next: a noisy - or hostile - network can announce
        // names all day, and each one costs us a framework registration or a
        // queue slot. The peer count is the number the product cares about; the
        // other two exist so that nothing grows while it is still "pending".
        if (endpoints.size >= MAX_TRACKED_ENDPOINTS && !endpoints.containsKey(name)) {
            log("warn", "ignoring $name, already tracking ${endpoints.size} peers")
            return
        }
        if (serviceInfoCallbacks.size >= MAX_TRACKED_ENDPOINTS || resolveQueue.size >= MAX_TRACKED_ENDPOINTS) {
            log("warn", "ignoring $name, already resolving ${MAX_TRACKED_ENDPOINTS} services")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            registerServiceInfoCallback(serviceInfo, name)
        } else {
            resolveQueue.addLast(serviceInfo)
            pumpResolveQueue()
        }
    }

    private fun handleServiceLost(name: String?) {
        val serviceName = name ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // A tracker whose service is gone is unregistered rather than kept
            // alive waiting for it to come back: the framework will report the
            // service through onServiceFound again if it does, and a tracker per
            // peer that has ever been seen is a registration we would never
            // release on a network people walk in and out of all day.
            serviceInfoCallbacks.remove(serviceName)?.let { callback ->
                try {
                    nsdManager?.unregisterServiceInfoCallback(callback)
                } catch (_: IllegalArgumentException) {
                    // Already unregistered by the framework.
                }
            }
        }
        val gone = endpoints.remove(serviceName) ?: return
        events?.peerLost(endpointOf(gone))
    }

    /**
     * API 34+ path. registerServiceInfoCallback replaces the deprecated
     * resolveService and is strictly better for us: it keeps delivering updates
     * when a peer's address changes - which happens the moment someone moves
     * from a router to a hotspot - instead of handing back one stale snapshot.
     */
    private fun registerServiceInfoCallback(serviceInfo: NsdServiceInfo, name: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
        val manager = nsdManager ?: return
        val tracker = ServiceTracker(name)
        try {
            manager.registerServiceInfoCallback(serviceInfo, control, tracker)
            serviceInfoCallbacks[name] = tracker
        } catch (e: RuntimeException) {
            // IllegalArgumentException for a service info the framework will not
            // accept, IllegalStateException when NSD is wedged. Losing one peer
            // is not worth crashing an offline app for.
            log("warn", "tracking $name rejected: ${e.javaClass.simpleName}")
        }
    }

    /**
     * One live subscription to one discovered service (API 34+).
     *
     * A named class rather than an anonymous object so that every callback can
     * check it is still the CURRENT tracker for this name before touching the
     * map. A peer that walks out of range and back produces a second tracker,
     * and a late `onServiceInfoCallbackUnregistered` from the first must not
     * evict the second - that would leak a framework registration and let a
     * third be created for the same service.
     */
    private inner class ServiceTracker(private val name: String) : NsdManager.ServiceInfoCallback {

        override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
            onControl {
                forget()
                log("warn", "could not track $name: ${nsdError(errorCode)}")
            }
        }

        override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
            onControl { publishResolved(serviceInfo) }
        }

        override fun onServiceLost() {
            onControl { handleServiceLost(name) }
        }

        override fun onServiceInfoCallbackUnregistered() {
            onControl { forget() }
        }

        /** Must run on the control thread. */
        private fun forget() {
            if (serviceInfoCallbacks[name] === this) serviceInfoCallbacks.remove(name)
        }
    }

    /** Pre-34 path: one resolve at a time, each with a deadline. */
    private fun pumpResolveQueue() {
        if (resolveInFlight) return
        val manager = nsdManager ?: return
        val next = resolveQueue.pollFirst() ?: return
        resolveInFlight = true
        val generation = ++resolveGeneration

        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                onControl {
                    log("debug", "resolve failed for ${serviceInfo.serviceName}: ${nsdError(errorCode)}")
                    finishResolve(generation)
                }
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                onControl {
                    publishResolved(serviceInfo)
                    finishResolve(generation)
                }
            }
        }

        try {
            legacyResolve(manager, next, listener)
        } catch (e: RuntimeException) {
            log("warn", "resolve rejected: ${e.javaClass.simpleName}")
            finishResolve(generation)
            return
        }

        // A resolve that never calls back would stall discovery forever, so the
        // queue moves on regardless. The generation check is what stops this
        // timeout from cancelling whichever resolve started after it.
        // Explicitly a Runnable, not a bare lambda: ScheduledExecutorService
        // overloads schedule() on Runnable AND on Callable<V>, and both accept a
        // zero-argument lambda. Naming the interface is the difference between
        // this compiling and an overload-resolution error, and it costs nothing.
        control.schedule(
            Runnable {
                try {
                    if (resolveInFlight && resolveGeneration == generation) {
                        log("debug", "resolve timed out for ${next.serviceName}")
                        finishResolve(generation)
                    }
                } catch (t: Throwable) {
                    log("error", "resolve timeout threw: ${t.javaClass.simpleName}")
                }
            },
            RESOLVE_TIMEOUT_MS,
            TimeUnit.MILLISECONDS,
        )
    }

    /**
     * resolveService is deprecated from API 34 in favour of
     * registerServiceInfoCallback, which is what we use there. Below 34 it is
     * the only thing that exists, so the suppression is confined to this one
     * call rather than spread across the discovery path.
     */
    @Suppress("DEPRECATION")
    private fun legacyResolve(
        manager: NsdManager,
        serviceInfo: NsdServiceInfo,
        listener: NsdManager.ResolveListener,
    ) {
        manager.resolveService(serviceInfo, listener)
    }

    /** Must run on the control thread. Ignores stale completions. */
    private fun finishResolve(generation: Long) {
        if (resolveGeneration != generation || !resolveInFlight) return
        resolveInFlight = false
        pumpResolveQueue()
    }

    private fun publishResolved(serviceInfo: NsdServiceInfo) {
        // A resolve or a service-info update that was already in flight when
        // stopDiscovery() was called still arrives. Publishing it would announce
        // a peer for a transport that has stopped looking, and no peerLost would
        // ever follow it.
        if (!discovering) return
        val name = serviceInfo.serviceName ?: return
        val port = serviceInfo.port
        if (port <= 0 || port > 65535) return

        val addresses = addressesOf(serviceInfo)
        if (addresses.isEmpty()) return

        val attributes: Map<String, ByteArray?> = try {
            serviceInfo.attributes ?: emptyMap()
        } catch (_: RuntimeException) {
            emptyMap()
        }
        val token = sanitisedToken(attributes[TXT_TOKEN])
        val displayName = textOf(attributes[TXT_NAME], MAX_DISPLAY_NAME_CHARS)

        val endpoint = ResolvedEndpoint(name, addresses, port, displayName, token)
        endpoints[name] = endpoint
        events?.peerDiscovered(endpointOf(endpoint))
    }

    private fun addressesOf(serviceInfo: NsdServiceInfo): List<InetAddress> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // getHostAddresses() is the API-34 replacement and gives us ALL of
            // them - a peer usually has an IPv4 and one or more IPv6
            // link-locals, and only trying them tells us which one routes.
            val all: List<InetAddress> = try {
                serviceInfo.hostAddresses?.filterNotNull() ?: emptyList()
            } catch (_: RuntimeException) {
                emptyList()
            }
            if (all.isNotEmpty()) return all
        }
        // getHost() is deprecated from API 34 and gives one address only, which
        // is why it is the fallback rather than the default.
        val single = legacyHost(serviceInfo)
        return if (single == null) emptyList() else listOf(single)
    }

    /** getHost() is deprecated from API 34; isolated here so the suppression is too. */
    @Suppress("DEPRECATION")
    private fun legacyHost(serviceInfo: NsdServiceInfo): InetAddress? = try {
        serviceInfo.host
    } catch (_: RuntimeException) {
        null
    }

    private fun endpointOf(endpoint: ResolvedEndpoint) = DiscoveredEndpoint(
        kind,
        endpoint.serviceName,
        endpoint.displayName,
        endpoint.token,
        // mDNS carries no signal strength. 0 is the contract's "not reported".
        0,
    )

    // -- links ----------------------------------------------------------------

    override fun connect(endpointId: String, timeoutMs: Int, completion: (Result<String>) -> Unit) {
        onControl {
            if (!started) {
                deliver(completion, Result.failure(AirLinkError.NotStarted()))
                return@onControl
            }
            val endpoint = endpoints[endpointId]
            if (endpoint == null) {
                deliver(completion, Result.failure(AirLinkError.UnknownEndpoint(endpointId)))
                return@onControl
            }
            if (links.size >= MAX_LINKS) {
                deliver(completion, Result.failure(AirLinkError.Failed("too many open links")))
                return@onControl
            }

            val budget = timeoutMs.coerceIn(1_000, 60_000)
            // The dial blocks, so it cannot run on the control thread - that
            // thread has to stay free to service NSD callbacks and closes.
            Thread({ dial(endpointId, endpoint, budget, completion) }, "airlink-dial")
                .apply { isDaemon = true }
                .start()
        }
    }

    /** Runs on a throwaway dial thread. Every exit path settles the promise. */
    private fun dial(
        endpointId: String,
        endpoint: ResolvedEndpoint,
        budget: Int,
        completion: (Result<String>) -> Unit,
    ) {
        val socket = try {
            FramedTcp.dial(endpoint.addresses, endpoint.port, budget) { candidate ->
                bindToLocalNetwork(candidate)
            }
        } catch (e: IOException) {
            onControl {
                deliver(
                    completion,
                    Result.failure(
                        if (e is java.net.SocketTimeoutException) {
                            AirLinkError.Timeout("connecting to $endpointId")
                        } else {
                            AirLinkError.Failed("could not reach $endpointId: ${e.javaClass.simpleName}")
                        },
                    ),
                )
            }
            return
        } catch (t: Throwable) {
            onControl {
                deliver(completion, Result.failure(AirLinkError.Failed("connect failed: ${t.javaClass.simpleName}")))
            }
            return
        }

        onControl {
            if (!started) {
                closeQuietly(socket)
                deliver(completion, Result.failure(AirLinkError.NotStarted()))
                return@onControl
            }
            // The cap was checked before the dial thread was started, and every
            // concurrent connect() checked the same pre-dial count - so N
            // simultaneous calls can all pass it and all arrive here. Checking
            // again where the map is mutated is what makes MAX_LINKS a limit
            // rather than a hint. The socket is ours to close: nothing else
            // holds it once the dial thread has handed it over.
            if (links.size >= MAX_LINKS) {
                closeQuietly(socket)
                deliver(completion, Result.failure(AirLinkError.Failed("too many open links")))
                return@onControl
            }
            val linkId = adopt(socket, endpointId, incoming = false)
            deliver(completion, Result.success(linkId))
        }
    }

    /**
     * Binds an unconnected socket to the Wi-Fi network we discovered the peer
     * on. Without this a phone that still has cellular up can route a hotspot
     * address out of the wrong interface and simply time out.
     */
    private fun bindToLocalNetwork(socket: Socket) {
        val network = localNetwork ?: return
        try {
            network.bindSocket(socket)
        } catch (_: IOException) {
            // Best effort. The default route usually works; this only helps the
            // awkward multi-network case.
            log("debug", "could not bind socket to the local network")
        }
    }

    private fun acceptIncoming(socket: Socket): Boolean {
        if (!started) return false
        if (links.size >= MAX_LINKS) {
            log("warn", "refusing an incoming connection, ${links.size} links already open")
            return false
        }
        // The remote address is the only handle we have for a peer that dialled
        // us; it is a transport-scoped id, never an identity. The handshake in
        // TypeScript decides who this actually is.
        val endpointId = "${socket.inetAddress?.hostAddress ?: "?"}:${socket.port}"
        onControl {
            // Re-checked on this side of the hop, not only on the accept thread.
            // The count above is a snapshot: a burst of simultaneous inbound
            // connections all pass it and then all adopt, so MAX_LINKS is only
            // really a limit when it is enforced where the map is mutated.
            // Returning true above means the accept loop has handed ownership
            // over, so a socket we decline here has to be closed here - nothing
            // else can, and one nobody owns stays open until the process dies.
            if (!started || links.size >= MAX_LINKS) {
                closeQuietly(socket)
                return@onControl
            }
            adopt(socket, endpointId, incoming = true)
        }
        return true
    }

    /** A socket we decided not to adopt. Never worth an exception. */
    private fun closeQuietly(socket: Socket) {
        try {
            socket.close()
        } catch (_: IOException) {
        } catch (_: RuntimeException) {
        }
    }

    /** Must run on the control thread. Returns the new link id. */
    private fun adopt(socket: Socket, endpointId: String, incoming: Boolean): String {
        val linkId = "ln-${linkCounter.incrementAndGet()}"
        val link = FramedTcpLink(linkId, socket, control, linkListener, ::log)
        links[linkId] = LinkRecord(link, endpointId)

        events?.linkOpened(
            linkId,
            kind,
            endpointId,
            FramedTcp.MAX_DATAGRAM_BYTES,
            true, // Wi-Fi carries photos and video at a usable rate.
            incoming,
        )
        events?.linkState(linkId, LinkState.CONNECTED, "")
        // Started last so the first datagram cannot arrive before the layer
        // above has been told the link exists.
        link.start()
        return linkId
    }

    private val linkListener = object : FramedTcpLink.Listener {
        override fun onDatagram(link: FramedTcpLink, payload: ByteArray) {
            // Delivered on the link's reader thread: it never re-enters send().
            events?.received(link.linkId, payload)
        }

        override fun onClosed(link: FramedTcpLink, reason: String, failed: Boolean) {
            links.remove(link.linkId)
            events?.linkState(
                link.linkId,
                if (failed) LinkState.FAILED else LinkState.CLOSED,
                reason,
            )
        }
    }

    override fun disconnect(linkId: String, reason: String) {
        onControl {
            val record = links[linkId] ?: return@onControl
            events?.linkState(linkId, LinkState.CLOSING, reason)
            record.link.close(reason)
        }
    }

    override fun send(linkId: String, data: ByteArray, reliable: Boolean, completion: (Result<Unit>) -> Unit) {
        onControl {
            val record = links[linkId]
            if (record == null) {
                deliver(completion, Result.failure(AirLinkError.UnknownLink(linkId)))
                return@onControl
            }
            if (data.size > FramedTcp.MAX_DATAGRAM_BYTES) {
                // Never truncate. The fragmentation layer above owns splitting.
                deliver(
                    completion,
                    Result.failure(AirLinkError.PayloadTooLarge(data.size, FramedTcp.MAX_DATAGRAM_BYTES)),
                )
                return@onControl
            }
            record.link.send(data, reliable) { result ->
                deliver(
                    completion,
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

    /**
     * Runs one piece of work on the control thread, and contains anything it
     * throws.
     *
     * EVERY hop onto this thread goes through here rather than through
     * `control.execute` directly, and that is not defensive decoration. NSD
     * delivers its callbacks on this executor too, and the framework getters
     * this class calls from inside them - `setAttribute`, `getAttributes`,
     * `getHostAddresses` - all throw on a record the platform dislikes. A
     * `ScheduledThreadPoolExecutor` wraps every task in a future, so a throw
     * there is not merely fatal-or-not: it is SWALLOWED, with no log line and
     * no clue why discovery stopped working. Catching it here is what turns
     * that into a diagnostic the developer-mode log can show.
     */
    private fun onControl(block: () -> Unit) {
        try {
            control.execute {
                try {
                    block()
                } catch (t: Throwable) {
                    log("error", "control task threw: ${t.javaClass.simpleName}")
                }
            }
        } catch (_: Throwable) {
            // RejectedExecutionException: the executor is shutting down. A task
            // that cannot be scheduled is not worth an exception to the caller.
            log("warn", "control task dropped, transport is shutting down")
        }
    }

    /**
     * Hands a result to a caller's completion, on the control thread.
     *
     * This thread is also the one NSD delivers its callbacks on, so a completion
     * that threw would take the process down from inside a system callback. It
     * is contained here; the promise on the JavaScript side is settled either
     * way, which is the part that matters.
     */
    private fun <T> deliver(completion: (Result<T>) -> Unit, result: Result<T>) {
        try {
            completion(result)
        } catch (t: Throwable) {
            log("error", "a completion threw: ${t.javaClass.simpleName}")
        }
    }

    /**
     * NSD wants "_airlink._tcp"; some releases hand the type back with a
     * trailing dot, or with the local domain appended. Comparing normalised
     * forms is the difference between finding iPhones and silently finding
     * nothing.
     */
    private fun normaliseServiceType(raw: String): String =
        raw.trim().removeSuffix(".").removeSuffix(".local").removeSuffix(".")

    private fun sameServiceType(candidate: String?, expected: String): Boolean {
        val a = normaliseServiceType(candidate ?: return false).lowercase()
        val b = normaliseServiceType(expected).lowercase()
        return a == b || a.endsWith(b) || b.endsWith(a)
    }

    /**
     * TXT values are attacker-controlled bytes. Decoding is bounded and never
     * throws, and the result is truncated: nothing downstream should have to
     * defend itself against a peer that pads a record to the mDNS limit.
     */
    private fun textOf(value: ByteArray?, limit: Int = MAX_TXT_VALUE_CHARS): String {
        if (value == null || value.isEmpty()) return ""
        return try {
            String(value, Charsets.UTF_8).take(limit)
        } catch (_: Throwable) {
            ""
        }
    }

    /**
     * The advertisement token, validated and re-encoded canonically.
     *
     * Mirrors `sanitisedToken` in the iOS LocalNetworkTransport, and has to: the
     * pairing layer in TypeScript MATCHES ON THIS STRING, so if one platform
     * passed the peer's bytes through verbatim and the other canonicalised them,
     * the same phone would produce two different tokens and a paired friend
     * would sometimes not be recognised. Decoding also rejects a TXT value that
     * is not base64 at all, which is one less hostile input to reason about
     * above this layer.
     *
     * The 32-byte ceiling is generous - the token is 6 bytes - and exists only
     * so a peer cannot make us carry an arbitrary blob across the bridge.
     */
    private fun sanitisedToken(value: ByteArray?): String {
        val raw = textOf(value)
        if (raw.isEmpty()) return ""
        return try {
            val decoded = Base64.decode(raw, Base64.DEFAULT)
            if (decoded.isEmpty() || decoded.size > MAX_TOKEN_BYTES) {
                ""
            } else {
                Base64.encodeToString(decoded, Base64.NO_WRAP)
            }
        } catch (_: IllegalArgumentException) {
            // Not base64. A peer is free to publish nonsense; we are not free to
            // pass it on.
            ""
        }
    }

    private fun nsdError(code: Int): String = when (code) {
        NsdManager.FAILURE_INTERNAL_ERROR -> "internal error"
        NsdManager.FAILURE_ALREADY_ACTIVE -> "already active"
        NsdManager.FAILURE_MAX_LIMIT -> "too many requests"
        else -> "error $code"
    }

    private fun log(level: String, message: String) {
        events?.log(level, SCOPE, message)
    }
}
