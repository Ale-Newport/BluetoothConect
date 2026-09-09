package com.airlink.transport.wifi

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
import com.airlink.transport.HotspotCredentials
import com.airlink.transport.HotspotHost
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
 * This transport also owns the local-only hotspot (see LocalOnlyHotspot), which
 * is why it implements HotspotHost: a hotspot exists solely so that NSD and TCP
 * have somewhere to run when there is no shared network at all.
 */
class LocalNetworkTransport(private val context: Context) : AirLinkTransport, HotspotHost {

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
         * A resolve that never calls back would leak a listener slot for the
         * life of the process, so every one gets a deadline.
         */
        const val RESOLVE_TIMEOUT_MS = 10_000L

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

    /**
     * The Android side of the cross-platform handoff. It lives here rather than
     * in its own transport because it is not one: it produces a Wi-Fi network
     * for THIS transport to run over. Declared before `events` so the setter
     * below always has something to hand the sink to.
     */
    private val hotspot = LocalOnlyHotspot(context)

    override var events: TransportEventSink? = null
        set(value) {
            field = value
            hotspot.events = value
        }

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

        control.execute { watchLocalNetwork() }
        log("info", "listening on port ${listening.port}")
    }

    override fun stop() {
        control.execute {
            stopAdvertisingInternal()
            stopDiscoveryInternal()
            server?.stop()
            server = null
            endpoints.clear()
            unwatchLocalNetwork()
            // Closing every link produces a `closed` state event for each, which
            // is what the layer above needs to stop waiting on them.
            links.values.toList().forEach { it.link.close("transport stopped") }
            // A hotspot outliving the transport stack would be a radio nobody is
            // watching and a network nobody can use.
            hotspot.stop()
            started = false
            configuration = null
        }
    }

    private fun watchLocalNetwork() {
        val manager = connectivity ?: return
        if (networkCallback != null) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                control.execute {
                    localNetwork = network
                    events?.availabilityChanged(kind, true, UnavailableReason.NONE)
                }
            }

            override fun onLost(network: Network) {
                control.execute {
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

        control.execute {
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

            val registration = object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
                    control.execute {
                        registeredServiceName = serviceInfo.serviceName
                        log("info", "advertising as ${serviceInfo.serviceName} on port ${tcpServer.port}")
                    }
                }

                override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    control.execute {
                        registrationListener = null
                        registeredServiceName = null
                        log("error", "advertising failed: ${nsdError(errorCode)}")
                        events?.availabilityChanged(kind, false, UnavailableReason.UNKNOWN)
                    }
                }

                override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {
                    control.execute { registeredServiceName = null }
                }

                override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    control.execute {
                        registeredServiceName = null
                        log("warn", "unregister failed: ${nsdError(errorCode)}")
                    }
                }
            }

            requestedServiceName = instanceName
            try {
                manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration)
                registrationListener = registration
            } catch (e: RuntimeException) {
                // IllegalArgumentException for a malformed record, IllegalStateException
                // when NSD itself is wedged. Neither is worth crashing an offline app.
                log("error", "advertising rejected: ${e.javaClass.simpleName}")
            }
        }
    }

    override fun stopAdvertising() {
        control.execute { stopAdvertisingInternal() }
    }

    private fun stopAdvertisingInternal() {
        val manager = nsdManager ?: return
        val listener = registrationListener ?: return
        registrationListener = null
        registeredServiceName = null
        requestedServiceName = null
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

        control.execute {
            if (discoveryListener != null) return@execute

            val listener = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(regType: String) {
                    control.execute { log("info", "discovering $regType") }
                }

                override fun onStartDiscoveryFailed(failedType: String, errorCode: Int) {
                    control.execute {
                        discoveryListener = null
                        log("error", "discovery failed to start: ${nsdError(errorCode)}")
                        events?.availabilityChanged(kind, false, UnavailableReason.UNKNOWN)
                    }
                }

                override fun onStopDiscoveryFailed(failedType: String, errorCode: Int) {
                    control.execute { log("warn", "discovery failed to stop: ${nsdError(errorCode)}") }
                }

                override fun onDiscoveryStopped(stoppedType: String) {
                    control.execute { discoveryListener = null }
                }

                override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                    control.execute { handleServiceFound(serviceInfo) }
                }

                override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                    control.execute { handleServiceLost(serviceInfo.serviceName) }
                }
            }

            try {
                manager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
                discoveryListener = listener
            } catch (e: RuntimeException) {
                log("error", "discovery rejected: ${e.javaClass.simpleName}")
            }
        }
    }

    override fun stopDiscovery() {
        control.execute { stopDiscoveryInternal() }
    }

    private fun stopDiscoveryInternal() {
        val manager = nsdManager ?: return
        discoveryListener?.let { listener ->
            discoveryListener = null
            try {
                manager.stopServiceDiscovery(listener)
            } catch (_: IllegalArgumentException) {
                // Not running. Fine.
            }
        }
        if (Build.VERSION.SDK_INT >= 34) {
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
        val config = configuration ?: return
        val name = serviceInfo.serviceName ?: return
        if (!sameServiceType(serviceInfo.serviceType, config.bonjourServiceType)) return
        // Our own advertisement comes back to us; there is no flag for it, only
        // the name, which is why we remember both what we asked for and what the
        // system settled on after any collision rename.
        if (name == registeredServiceName || name == requestedServiceName) return
        if (serviceInfoCallbacks.containsKey(name)) return
        if (endpoints.size >= MAX_TRACKED_ENDPOINTS && !endpoints.containsKey(name)) {
            log("warn", "ignoring $name, already tracking ${endpoints.size} peers")
            return
        }

        if (Build.VERSION.SDK_INT >= 34) {
            registerServiceInfoCallback(serviceInfo, name)
        } else {
            resolveQueue.addLast(serviceInfo)
            pumpResolveQueue()
        }
    }

    private fun handleServiceLost(name: String?) {
        val serviceName = name ?: return
        if (Build.VERSION.SDK_INT >= 34) {
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
        if (Build.VERSION.SDK_INT < 34) return
        val manager = nsdManager ?: return
        val callback = object : NsdManager.ServiceInfoCallback {
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
                control.execute {
                    serviceInfoCallbacks.remove(name)
                    log("warn", "could not track $name: ${nsdError(errorCode)}")
                }
            }

            override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
                control.execute { publishResolved(serviceInfo) }
            }

            override fun onServiceLost() {
                control.execute { handleServiceLost(name) }
            }

            override fun onServiceInfoCallbackUnregistered() {
                control.execute { serviceInfoCallbacks.remove(name) }
            }
        }
        try {
            manager.registerServiceInfoCallback(serviceInfo, control, callback)
            serviceInfoCallbacks[name] = callback
        } catch (e: RuntimeException) {
            log("warn", "tracking $name rejected: ${e.javaClass.simpleName}")
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
                control.execute {
                    log("debug", "resolve failed for ${serviceInfo.serviceName}: ${nsdError(errorCode)}")
                    finishResolve(generation)
                }
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                control.execute {
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
        control.schedule(
            {
                if (resolveInFlight && resolveGeneration == generation) {
                    log("debug", "resolve timed out for ${next.serviceName}")
                    finishResolve(generation)
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
        val token = textOf(attributes[TXT_TOKEN])
        val displayName = textOf(attributes[TXT_NAME], MAX_DISPLAY_NAME_CHARS)

        val endpoint = ResolvedEndpoint(name, addresses, port, displayName, token)
        endpoints[name] = endpoint
        events?.peerDiscovered(endpointOf(endpoint))
    }

    private fun addressesOf(serviceInfo: NsdServiceInfo): List<InetAddress> {
        if (Build.VERSION.SDK_INT >= 34) {
            val all = try {
                serviceInfo.hostAddresses
            } catch (_: RuntimeException) {
                emptyList<InetAddress>()
            }
            if (all.isNotEmpty()) return all.toList()
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
        control.execute {
            if (!started) {
                completion(Result.failure(AirLinkError.NotStarted()))
                return@execute
            }
            val endpoint = endpoints[endpointId]
            if (endpoint == null) {
                completion(Result.failure(AirLinkError.UnknownEndpoint(endpointId)))
                return@execute
            }
            if (links.size >= MAX_LINKS) {
                completion(Result.failure(AirLinkError.Failed("too many open links")))
                return@execute
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
            control.execute {
                completion(
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
            control.execute {
                completion(Result.failure(AirLinkError.Failed("connect failed: ${t.javaClass.simpleName}")))
            }
            return
        }

        control.execute {
            if (!started) {
                try {
                    socket.close()
                } catch (_: IOException) {
                }
                completion(Result.failure(AirLinkError.NotStarted()))
                return@execute
            }
            val linkId = adopt(socket, endpointId, incoming = false)
            completion(Result.success(linkId))
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
        control.execute { adopt(socket, endpointId, incoming = true) }
        return true
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
        control.execute {
            val record = links[linkId] ?: return@execute
            events?.linkState(linkId, LinkState.CLOSING, reason)
            record.link.close(reason)
        }
    }

    override fun send(linkId: String, data: ByteArray, reliable: Boolean, completion: (Result<Unit>) -> Unit) {
        control.execute {
            val record = links[linkId]
            if (record == null) {
                completion(Result.failure(AirLinkError.UnknownLink(linkId)))
                return@execute
            }
            if (data.size > FramedTcp.MAX_DATAGRAM_BYTES) {
                // Never truncate. The fragmentation layer above owns splitting.
                completion(
                    Result.failure(AirLinkError.PayloadTooLarge(data.size, FramedTcp.MAX_DATAGRAM_BYTES)),
                )
                return@execute
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

    // -- hotspot (HotspotHost) -------------------------------------------------

    override fun createHotspot(timeoutMs: Int, completion: (Result<HotspotCredentials>) -> Unit) {
        hotspot.start(timeoutMs, completion)
    }

    override fun stopHotspot() {
        hotspot.stop()
    }

    // -- helpers --------------------------------------------------------------

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
