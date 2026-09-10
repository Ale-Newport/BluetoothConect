package com.airlink.transport

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.provider.Settings
import android.util.Log
import com.airlink.transport.ble.BleTransport
import com.airlink.transport.wifi.HotspotHost
import com.airlink.transport.wifi.LocalNetworkTransport
import com.airlink.transport.wifi.WifiDirectTransport
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * The Kotlin half of the transport module.
 *
 * Owns the transports, routes every call to whichever one the `transport`
 * string names, keeps a map of link id to owning transport so `send` and
 * `disconnect` can be routed, and funnels every event back to JavaScript
 * through the codegen-generated typed emitters. It contains no radio code
 * itself - each transport is a file under `ble/` or `wifi/` - and no protocol
 * knowledge at all. It does not parse a payload, add a header, or decide when
 * to reconnect.
 *
 * THREADING. React Native calls native modules from its own threads, and each
 * transport reports from wherever its radio callbacks land (a Binder thread for
 * BLE, a socket thread for Wi-Fi). Everything is hopped onto ONE
 * [HandlerThread] before it touches shared state or emits, which:
 *
 *  - removes every lock and every race from the bookkeeping below;
 *  - gives message ordering for free, so a `linkOpened` can never be emitted
 *    after the first `onData` for that link;
 *  - satisfies the contract that a callback is never delivered re-entrantly
 *    from inside a `send` call, since a transport that calls back synchronously
 *    still has its event deferred to this thread;
 *  - keeps the React Native caller unblocked, always.
 *
 * The cost is that a transport which blocks that thread stalls every other
 * transport, which is why [AirLinkTransport] documents its methods as
 * non-blocking.
 *
 * PAYLOADS cross the bridge as base64 strings, decoded on the way in and
 * encoded on the way out. See the header of `src/NativeAirLinkTransport.ts` for
 * why that is the right trade for a boundary this small.
 */
@ReactModule(name = NativeAirLinkTransportSpec.NAME)
class AirLinkTransportModule(reactContext: ReactApplicationContext) :
    NativeAirLinkTransportSpec(reactContext), TransportEventSink {

    // ---------------------------------------------------------------------
    // Threading
    // ---------------------------------------------------------------------

    private val thread = HandlerThread("airlink-transport").apply { start() }
    private val handler = Handler(thread.looper)

    /** Long-lived: an Activity here would leak every time the screen rotates. */
    private val appContext: Context = reactContext.applicationContext

    // ---------------------------------------------------------------------
    // State. Touched only on `handler`'s thread.
    // ---------------------------------------------------------------------

    private val transports = LinkedHashMap<TransportKind, AirLinkTransport>()

    /** Which transport owns each open link, so send/disconnect can be routed. */
    private val linkOwners = HashMap<String, TransportKind>()

    /**
     * The negotiated datagram limit per link. Held here as well as in the
     * transport so the module can enforce "sending more than maxDatagramSize
     * fails loudly, never truncates" centrally, for every radio, once.
     */
    private val linkLimits = HashMap<String, Int>()

    /** The local-only hotspot. Null until something actually asks for one. */
    private var hotspot: HotspotHost? = null

    private var configuration: TransportConfiguration? = null
    private var started = false

    /** Last link count handed to the foreground service, so we only act on changes. */
    private var foregroundLinkCount = 0

    private var bluetoothReceiverRegistered = false

    // ---------------------------------------------------------------------
    // Inbound bounds. A peer controls how much it sends us.
    // ---------------------------------------------------------------------

    private val pendingInboundCount = AtomicInteger(0)
    private val pendingInboundBytes = AtomicLong(0)
    private val pendingLogCount = AtomicInteger(0)

    /** In-flight permission request, if any. Only one dialog can be up at a time. */
    private var pendingPermissionRequest: PermissionRequest? = null
    private val permissionRequestCode = AtomicInteger(PERMISSION_REQUEST_CODE_BASE)

    // =====================================================================
    // Capability and permissions
    // =====================================================================

    override fun getCapabilities(promise: Promise) {
        val once = Once(promise)
        handler.post {
            try {
                if (transports.isEmpty()) buildTransports()

                val descriptors: WritableArray = Arguments.createArray()
                for (kind in TransportKind.entries) {
                    descriptors.pushMap(describe(kind))
                }

                val result = Arguments.createMap().apply {
                    putString("platform", "android")
                    putString("osVersion", Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString())
                    putString("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                    putArray("transports", descriptors)
                    putBoolean("canAdvertiseBle", canAdvertiseBle())
                    // BLE L2CAP connection-oriented channels arrived in API 29.
                    // Checked at runtime rather than at compile time so one APK
                    // serves every device and simply reports less on older ones.
                    putBoolean("supportsL2cap", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                    // WifiManager.startLocalOnlyHotspot exists from API 26, which
                    // is this library's floor, so the hardware question is only
                    // half of it: on API 31-32 there is no permission this build
                    // can hold that unlocks it (see the matrix in Permissions.kt)
                    // and createHotspot() will always reject. Reporting true
                    // there would have JavaScript offer the user a fast path
                    // that cannot exist.
                    putBoolean("canCreateHotspot", canCreateHotspot())
                    // Deliberately false, and the asymmetry is the whole reason
                    // the handoff has Android hosting: an Android app cannot
                    // silently join an arbitrary hotspot the way an iPhone can
                    // with NEHotspotConfiguration. The nearest thing Android
                    // offers, WifiNetworkSpecifier, is a system network picker
                    // the user drives, not a join we can perform.
                    putBoolean("canJoinHotspot", false)
                }
                once.resolve(result)
            } catch (t: Throwable) {
                once.reject(t)
            }
        }
    }

    /** One transport's capability descriptor, honestly. */
    private fun describe(kind: TransportKind): WritableMap {
        val transport = transports[kind]
        val gate = platformGate(kind)

        // The module's own gate is authoritative for hardware, OS version,
        // permissions and radio state, because those are facts about the device
        // rather than opinions of a transport. Only once it has nothing to
        // object to does the transport get to answer.
        //
        // An ADVISORY gate is the exception, and the local network is the only
        // one: the module can only ask about the DEFAULT network, and the whole
        // point of the hotspot handoff is a Wi-Fi path that is not the default
        // route (the phone usually keeps cellular as its default while hosting a
        // soft AP). Letting a guess about the default route veto the transport
        // that is watching every network with a NetworkCallback would report the
        // fast path as unavailable at exactly the moment it had just been built.
        //
        // The transport is asked lazily either way: its own probe can touch a
        // radio, and there is no reason to pay for that - or to log the
        // SecurityException it may raise - once an authoritative gate has
        // already objected.
        val availability = when {
            !gate.supported -> gate.availability
            gate.availability.available || gate.advisory ->
                transport?.availabilitySafely() ?: gate.availability
            else -> gate.availability
        }

        return Arguments.createMap().apply {
            putString("kind", kind.id)
            putBoolean("supported", gate.supported)
            putBoolean("available", gate.supported && availability.available)
            putString("reason", availability.reason.id)
            // A transport that is happy usually has nothing to say, but the
            // module may still have a caveat worth printing - Wi-Fi Aware is
            // "available" and still not something to rely on.
            putString("detail", availability.detail.ifBlank { gate.availability.detail })
        }
    }

    /**
     * @param advisory true when [availability] is a guess the module makes on
     *   the transport's behalf and the transport's own answer, when it has one,
     *   is better. False - the default - means the gate is a fact about the
     *   device that no transport may override.
     */
    private data class Gate(
        val supported: Boolean,
        val availability: TransportAvailability,
        val advisory: Boolean = false,
    )

    /**
     * Everything about a transport that the module can determine without asking
     * the transport: is the hardware there, is this OS new enough, do we hold
     * the permissions, is the radio on.
     */
    private fun platformGate(kind: TransportKind): Gate = when (kind) {
        // Always supported: the manifest declares
        // `uses-feature android.hardware.bluetooth_le required="true"`, so a
        // device that cannot do BLE cannot install AirLink in the first place.
        TransportKind.BLE -> Gate(supported = true, availability = bleAvailability())

        // Advisory: see [Gate.advisory] and hasLocalNetworkPath(). The transport
        // knows more than this check does and gets the last word.
        TransportKind.LOCAL_NETWORK -> Gate(
            supported = true,
            availability = if (hasLocalNetworkPath()) {
                TransportAvailability(true)
            } else {
                TransportAvailability(
                    available = false,
                    reason = UnavailableReason.NO_LOCAL_NETWORK,
                    detail = "Join the same Wi-Fi network as the other device to use the faster connection.",
                )
            },
            advisory = true,
        )

        TransportKind.PEER_TO_PEER_WIFI -> Gate(
            supported = false,
            availability = TransportAvailability(
                available = false,
                reason = UnavailableReason.UNSUPPORTED_HARDWARE,
                detail = "Apple peer-to-peer Wi-Fi is an Apple-only technology with no Android " +
                    "equivalent. Android devices use Wi-Fi Direct with each other, and Bluetooth " +
                    "or a shared hotspot with iPhones.",
            ),
        )

        TransportKind.WIFI_DIRECT -> wifiGate(
            kind = kind,
            feature = PackageManager.FEATURE_WIFI_DIRECT,
            unsupportedDetail = "This device does not have Wi-Fi Direct hardware.",
            availableDetail = "Wi-Fi Direct is only used between two Android devices.",
        )

        // Wi-Fi Aware is reported honestly in both directions and is available
        // in neither. Most handsets have no Aware radio at all; on the ones that
        // do, Android-to-iPhone Aware fails in practice (missing DCEA
        // attributes, auth status 15, PINs that are never displayed), which is
        // precisely the only case that would have justified building it. See
        // wifi/WifiAwareNotes.kt for the full reasoning. The identifier stays in
        // the vocabulary so that if the interop story ever changes this becomes
        // one new file and no feature code changes.
        TransportKind.WIFI_AWARE -> Gate(
            supported = hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE),
            availability = TransportAvailability(
                available = false,
                reason = UnavailableReason.UNSUPPORTED_HARDWARE,
                detail = if (hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)) {
                    "This device has Wi-Fi Aware hardware, but Wi-Fi Aware does not work " +
                        "reliably between Android phones and iPhones, so AirLink does not use " +
                        "it. Bluetooth, Wi-Fi Direct and a shared hotspot cover the same ground."
                } else {
                    "This device does not support Wi-Fi Aware, and most phones do not."
                },
            ),
        )
    }

    private fun wifiGate(
        kind: TransportKind,
        feature: String,
        unsupportedDetail: String,
        availableDetail: String,
    ): Gate {
        if (!hasSystemFeature(feature)) {
            return Gate(
                supported = false,
                availability = TransportAvailability(
                    available = false,
                    reason = UnavailableReason.UNSUPPORTED_HARDWARE,
                    detail = unsupportedDetail,
                ),
            )
        }
        val permission = permissionAvailability(kind)
        val availability = if (permission.available) {
            TransportAvailability(true, UnavailableReason.NONE, availableDetail)
        } else {
            permission
        }
        return Gate(supported = true, availability = availability)
    }

    private fun bleAvailability(): TransportAvailability {
        val adapter = bluetoothAdapter()
            ?: return TransportAvailability(
                available = false,
                reason = UnavailableReason.UNSUPPORTED_HARDWARE,
                detail = "This device has no Bluetooth adapter.",
            )

        // Permissions first: on API 31+ several adapter queries are gated behind
        // BLUETOOTH_CONNECT, so asking about the radio before asking about
        // permission produces a misleading answer (or a SecurityException).
        val permission = permissionAvailability(TransportKind.BLE)
        if (!permission.available) return permission

        val on = try {
            adapter.isEnabled
        } catch (t: SecurityException) {
            // Documented as needing the legacy BLUETOOTH permission, which does
            // not exist from API 31. Treated as "we are not allowed to know"
            // rather than as a crash.
            Log.w(TAG, "not permitted to read the Bluetooth adapter state", t)
            return TransportAvailability(
                available = false,
                reason = UnavailableReason.PERMISSION_DENIED,
                detail = "AirLink is not allowed to check whether Bluetooth is on.",
            )
        }

        return if (on) {
            TransportAvailability(true)
        } else {
            TransportAvailability(
                available = false,
                reason = UnavailableReason.RADIO_OFF,
                detail = "Turn Bluetooth on to find people nearby.",
            )
        }
    }

    private fun permissionAvailability(kind: TransportKind): TransportAvailability {
        val state = Permissions.transportState(appContext, permissionAwareActivityOrNull(), kind)
        if (state == Permissions.State.GRANTED) return TransportAvailability(true)

        val detail = when (state) {
            Permissions.State.NOT_REQUESTED ->
                "AirLink needs your permission to use this connection."
            Permissions.State.DENIED ->
                "Permission was declined. Tap to try again."
            Permissions.State.DENIED_PERMANENTLY ->
                "Permission was declined permanently. Turn it on in Settings to use this connection."
            Permissions.State.NOT_DECLARED ->
                // See the API 31-32 Wi-Fi gap in Permissions.kt.
                "This connection is not available on this version of Android. Bluetooth still works."
            Permissions.State.GRANTED -> ""
        }
        return TransportAvailability(
            available = false,
            reason = Permissions.reasonFor(state),
            detail = detail,
        )
    }

    override fun requestPermissions(transportNames: ReadableArray, promise: Promise) {
        val once = Once(promise)
        val requested = buildList {
            for (index in 0 until transportNames.size()) {
                transportNames.getString(index)?.let { add(it) }
            }
        }

        // Anything we do not recognise is denied rather than ignored: silently
        // dropping a transport name would look like a grant on the JS side.
        val kinds = LinkedHashMap<String, TransportKind?>()
        for (name in requested) kinds[name] = TransportKind.fromId(name)

        val needed = LinkedHashSet<String>()
        for (kind in kinds.values) {
            if (kind == null) continue
            for (permission in Permissions.runtimePermissions(kind)) {
                // Never ask for something the manifest does not declare on this
                // OS: the dialog would not appear and the promise would resolve
                // "denied" for a reason the user cannot act on.
                if (!Permissions.isDeclared(appContext, permission)) continue
                if (!Permissions.isGranted(appContext, permission)) needed.add(permission)
            }
        }

        if (needed.isEmpty()) {
            once.resolve(permissionResult(kinds))
            return
        }

        val activity = permissionAwareActivityOrNull()
        if (activity == null) {
            // No Activity means no dialog. Reporting this as "denied, and
            // Settings will not help" is honest; the app retries when a screen
            // is up. Deliberately not a rejection: a refused permission is a
            // state to show, not an error to throw.
            log("warn", "permissions", "asked for permissions with no Activity attached")
            once.resolve(permissionResult(kinds))
            return
        }

        synchronized(this) {
            if (pendingPermissionRequest != null) {
                once.reject(AirLinkError.Busy("A permission request"))
                return
            }
            val code = permissionRequestCode.incrementAndGet() and 0xFFFF
            val request = PermissionRequest(code, kinds, once)
            pendingPermissionRequest = request

            // Recorded BEFORE the dialog: the process can die while it is on
            // screen, and a forgotten request reads as "never asked" forever,
            // which is exactly the distinction the permission screen needs.
            Permissions.markRequested(appContext, needed)

            try {
                activity.requestPermissions(needed.toTypedArray(), code, permissionListener)
            } catch (t: Throwable) {
                pendingPermissionRequest = null
                Log.w(TAG, "requestPermissions failed", t)
                once.resolve(permissionResult(kinds))
                return
            }

            // A user who never answers - who swipes the app away with the dialog
            // up - must not leave a JavaScript promise pending for the life of
            // the process. On expiry we answer with whatever the OS thinks now,
            // which is the truth either way.
            //
            // Kept so the normal path can cancel it: a three-minute message
            // holding a settled promise is three minutes of a JavaScript
            // callback that cannot be collected, once per permission screen.
            val watchdog = Runnable { expirePermissionRequest(request) }
            request.watchdog = watchdog
            handler.postDelayed(watchdog, PERMISSION_TIMEOUT_MS)
        }
    }

    private class PermissionRequest(
        val code: Int,
        val kinds: Map<String, TransportKind?>,
        val once: Once,
    ) {
        /** Set immediately after the dialog goes up; cleared when it is answered. */
        @Volatile
        var watchdog: Runnable? = null
    }

    private val permissionListener = PermissionListener { requestCode, _, _ ->
        val request = synchronized(this) {
            pendingPermissionRequest?.takeIf { it.code == requestCode }?.also {
                pendingPermissionRequest = null
            }
        }
        if (request != null) {
            request.watchdog?.let { handler.removeCallbacks(it) }
            request.watchdog = null
            // The grantResults array is deliberately ignored: what matters is
            // what the OS says we hold NOW, which also covers the case where the
            // user changed a permission in Settings while the dialog was up.
            request.once.resolve(permissionResult(request.kinds))
            notifyAvailabilityAfterPermissionChange(request.kinds.values)
        }
        // Returning true removes this listener from the Activity.
        true
    }

    private fun expirePermissionRequest(request: PermissionRequest) {
        val expired = synchronized(this) {
            if (pendingPermissionRequest === request) {
                pendingPermissionRequest = null
                true
            } else {
                false
            }
        }
        if (expired) {
            request.watchdog = null
            log("warn", "permissions", "permission request expired without an answer")
            request.once.resolve(permissionResult(request.kinds))
        }
    }

    private fun permissionResult(kinds: Map<String, TransportKind?>): WritableMap {
        val activity = permissionAwareActivityOrNull()
        val granted = Arguments.createArray()
        val denied = Arguments.createArray()
        var requiresSettings = false

        for ((name, kind) in kinds) {
            if (kind == null) {
                denied.pushString(name)
                continue
            }
            when (Permissions.transportState(appContext, activity, kind)) {
                Permissions.State.GRANTED -> granted.pushString(name)
                Permissions.State.DENIED_PERMANENTLY -> {
                    denied.pushString(name)
                    requiresSettings = true
                }
                // NOT_DECLARED is a denial that Settings cannot fix either, so
                // it must not send the user there.
                else -> denied.pushString(name)
            }
        }

        return Arguments.createMap().apply {
            putBoolean("granted", denied.size() == 0)
            putArray("granted_transports", granted)
            putArray("denied_transports", denied)
            putBoolean("requiresSettings", requiresSettings)
        }
    }

    /** Let JavaScript refresh its permission screen without polling. */
    private fun notifyAvailabilityAfterPermissionChange(kinds: Collection<TransportKind?>) {
        for (kind in kinds.filterNotNull().distinct()) {
            val gate = platformGate(kind)
            availabilityChanged(kind, gate.supported && gate.availability.available, gate.availability.reason)
        }
    }

    override fun openSettings() {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", appContext.packageName, null),
        )
        try {
            val activity = reactApplicationContext.currentActivity
            if (activity != null) {
                activity.startActivity(intent)
            } else {
                // No Activity: a new task is the only way to launch, and the
                // back stack will return the user to their launcher rather than
                // to us. Better than doing nothing.
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                appContext.startActivity(intent)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "could not open the app settings page", t)
        }
    }

    // =====================================================================
    // Lifecycle
    // =====================================================================

    override fun start(
        serviceUuid: String,
        rxCharacteristicUuid: String,
        txCharacteristicUuid: String,
        bonjourServiceType: String,
        promise: Promise,
    ) {
        val once = Once(promise)
        handler.post {
            try {
                val config = TransportConfiguration(
                    serviceUuid = serviceUuid,
                    rxCharacteristicUuid = rxCharacteristicUuid,
                    txCharacteristicUuid = txCharacteristicUuid,
                    bonjourServiceType = bonjourServiceType,
                )

                // Starting twice with the same configuration is a no-op, so a
                // JavaScript hot reload does not tear a live session down. With
                // a DIFFERENT configuration it is a genuine restart: the UUIDs
                // are baked into advertisements and GATT tables, so half the
                // stack on the old ones is worse than a clean rebuild.
                if (started && configuration == config) {
                    once.resolve(null)
                    return@post
                }
                if (started) stopEverything()
                configuration = config
                if (transports.isEmpty()) buildTransports()

                // A transport that cannot start is not fatal. BLE alone is a
                // working product and everything else is an upgrade, so we
                // report and carry on.
                for ((kind, transport) in transports) {
                    try {
                        transport.start(config)
                    } catch (t: Throwable) {
                        log("warn", kind.id, "failed to start: ${describeThrowable(t)}")
                    }
                }

                registerBluetoothStateReceiver()
                started = true
                once.resolve(null)
            } catch (t: Throwable) {
                once.reject(t)
            }
        }
    }

    override fun stop(promise: Promise) {
        val once = Once(promise)
        handler.post {
            try {
                stopEverything()
                once.resolve(null)
            } catch (t: Throwable) {
                once.reject(t)
            }
        }
    }

    /** Idempotent. Safe to call from `stop()`, from `start()` and from teardown. */
    private fun stopEverything() {
        for ((kind, transport) in transports) {
            try {
                transport.stop()
            } catch (t: Throwable) {
                Log.w(TAG, "$kind failed to stop cleanly", t)
            }
        }
        // A hotspot outliving the session it was raised for would keep the
        // phone's own Wi-Fi down for nothing.
        try {
            hotspot?.stop()
        } catch (t: Throwable) {
            Log.w(TAG, "the hotspot failed to stop cleanly", t)
        }
        unregisterBluetoothStateReceiver()
        linkOwners.clear()
        linkLimits.clear()
        pendingInboundCount.set(0)
        pendingInboundBytes.set(0)
        updateForegroundSession()
        started = false
    }

    // =====================================================================
    // Advertising and discovery
    // =====================================================================

    override fun startAdvertising(
        transport: String,
        token: String,
        displayName: String,
        promise: Promise,
    ) {
        route(promise) {
            requireStarted()
            val bytes = if (token.isEmpty()) ByteArray(0) else decodeBase64(token)
            transportFor(transport).startAdvertising(bytes, displayName)
        }
    }

    override fun stopAdvertising(transport: String, promise: Promise) {
        route(promise) { transportFor(transport).stopAdvertising() }
    }

    override fun startDiscovery(transport: String, promise: Promise) {
        route(promise) {
            requireStarted()
            transportFor(transport).startDiscovery()
        }
    }

    override fun stopDiscovery(transport: String, promise: Promise) {
        route(promise) { transportFor(transport).stopDiscovery() }
    }

    // =====================================================================
    // Links
    // =====================================================================

    override fun connect(
        transport: String,
        endpointId: String,
        timeoutMs: Double,
        promise: Promise,
    ) {
        val once = Once(promise)
        handler.post {
            try {
                requireStarted()
                val target = transportFor(transport)
                val kind = target.kind
                val budget = clampTimeout(timeoutMs)

                // The transport is given the budget and is expected to honour
                // it. This watchdog is the backstop for the one that does not:
                // a JavaScript promise that never settles would strand the whole
                // connection state machine, so it gets a grace period and then
                // an honest timeout.
                val watchdog = Runnable {
                    if (once.reject(AirLinkError.Timeout("connecting to $endpointId"))) {
                        log("warn", kind.id, "connect to $endpointId timed out after ${budget}ms")
                    }
                }
                handler.postDelayed(watchdog, budget + CONNECT_WATCHDOG_GRACE_MS)

                target.connect(endpointId, budget.toInt()) { result ->
                    handler.post {
                        handler.removeCallbacks(watchdog)
                        result.fold(
                            onSuccess = { linkId ->
                                linkOwners[linkId] = kind
                                updateForegroundSession()
                                once.resolve(linkId)
                            },
                            onFailure = { once.reject(it) },
                        )
                    }
                }
            } catch (t: Throwable) {
                once.reject(t)
            }
        }
    }

    override fun disconnect(linkId: String, reason: String, promise: Promise) {
        val once = Once(promise)
        handler.post {
            try {
                val kind = linkOwners[linkId]
                val transport = kind?.let { transports[it] }
                if (transport != null) {
                    try {
                        transport.disconnect(linkId, reason)
                    } catch (t: Throwable) {
                        Log.w(TAG, "disconnect of $linkId failed", t)
                    }
                }
                // The transport still owes us a closed state event, and that is
                // what removes the link from the maps. Removing it here as well
                // would make a late `onData` unroutable rather than merely
                // unwanted.

                // Disconnecting an unknown link is not an error: the caller
                // wanted it gone, and it is gone.
                once.resolve(null)
            } catch (t: Throwable) {
                once.reject(t)
            }
        }
    }

    override fun send(linkId: String, data: String, reliable: Boolean, promise: Promise) {
        val once = Once(promise)
        handler.post {
            try {
                val kind = linkOwners[linkId] ?: throw AirLinkError.UnknownLink(linkId)
                val transport = transports[kind] ?: throw AirLinkError.UnknownLink(linkId)
                val bytes = decodeBase64(data)

                // Rule 3 of the datagram contract, enforced once for every radio:
                // over-sized sends fail loudly. Truncating here would corrupt a
                // frame in a way the layer above could not detect.
                //
                // The per-link limit arrives with `linkOpened`, which every
                // transport emits before it completes a connect - but the
                // interface does not *require* that order, and a link whose
                // limit is unknown must not become a link with no limit at all.
                // MAX_INBOUND_DATAGRAM_BYTES is the absolute ceiling in that
                // case: no transport here advertises more than 64 KiB, so it
                // rejects nothing legitimate and still stops an unbounded
                // payload reaching a radio.
                val limit = linkLimits[linkId]?.takeIf { it > 0 } ?: MAX_INBOUND_DATAGRAM_BYTES
                if (bytes.size > limit) {
                    throw AirLinkError.PayloadTooLarge(bytes.size, limit)
                }

                val watchdog = Runnable {
                    once.reject(AirLinkError.Timeout("sending ${bytes.size} bytes on $linkId"))
                }
                handler.postDelayed(watchdog, SEND_WATCHDOG_MS)

                transport.send(linkId, bytes, reliable) { result ->
                    handler.post {
                        handler.removeCallbacks(watchdog)
                        result.fold(
                            onSuccess = { once.resolve(null) },
                            onFailure = { once.reject(it) },
                        )
                    }
                }
            } catch (t: Throwable) {
                once.reject(t)
            }
        }
    }

    override fun getLinkMetrics(linkId: String, promise: Promise) {
        val once = Once(promise)
        handler.post {
            try {
                val kind = linkOwners[linkId] ?: throw AirLinkError.UnknownLink(linkId)
                val transport = transports[kind] ?: throw AirLinkError.UnknownLink(linkId)
                val snapshot = transport.metrics(linkId) ?: throw AirLinkError.UnknownLink(linkId)
                once.resolve(
                    Arguments.createMap().apply {
                        putString("linkId", linkId)
                        putString("transport", kind.id)
                        putInt("maxDatagramSize", snapshot.maxDatagramSize)
                        putInt("rssi", snapshot.rssi)
                        putInt("packetsSent", snapshot.packetsSent)
                        putInt("packetsReceived", snapshot.packetsReceived)
                        putInt("packetsDropped", snapshot.packetsDropped)
                        putDouble("bytesSent", snapshot.bytesSent)
                        putDouble("bytesReceived", snapshot.bytesReceived)
                        putDouble("throughput", snapshot.throughput)
                    }
                )
            } catch (t: Throwable) {
                once.reject(t)
            }
        }
    }

    // =====================================================================
    // Wi-Fi handoff
    // =====================================================================

    override fun createHotspot(promise: Promise) {
        val once = Once(promise)
        handler.post {
            try {
                requireStarted()
                if (!hasSystemFeature(PackageManager.FEATURE_WIFI)) {
                    throw AirLinkError.Unsupported("Starting a hotspot")
                }

                // Checked before the host is constructed, because constructing
                // one starts a thread and there is no point paying for it when
                // the answer is already no. startLocalOnlyHotspot needs the same
                // Wi-Fi permission as discovery, and on API 31-32 there is none
                // this build can hold - see the matrix in Permissions.kt.
                for (permission in Permissions.hotspotPermissions()) {
                    // "Not declared on this OS" and "declared but not granted"
                    // are different answers to JavaScript: the first sends
                    // nobody to Settings, because there is nothing there to
                    // turn on.
                    if (!Permissions.isDeclared(appContext, permission)) {
                        throw AirLinkError.Unsupported(
                            "Starting a hotspot on this version of Android",
                        )
                    }
                    if (!Permissions.isGranted(appContext, permission)) {
                        throw AirLinkError.Failed(
                            "AirLink does not have permission to start a Wi-Fi hotspot on this device.",
                        )
                    }
                }

                val host = hotspotHost()
                val availability = host.availability()
                if (!availability.available) {
                    throw AirLinkError.Failed(
                        availability.detail.ifBlank { "A Wi-Fi hotspot cannot be started right now." }
                    )
                }

                // The host has its own deadline; this one is longer on purpose,
                // so its more specific failure wins the race and this only fires
                // if the host itself never answers.
                val watchdog = Runnable {
                    once.reject(AirLinkError.Timeout("starting a local-only hotspot"))
                }
                handler.postDelayed(watchdog, HOTSPOT_WATCHDOG_MS)

                host.start { result ->
                    handler.post {
                        handler.removeCallbacks(watchdog)
                        result.fold(
                            onSuccess = { credentials ->
                                once.resolve(
                                    Arguments.createMap().apply {
                                        // These are secrets. They go straight to
                                        // JavaScript, which hands them to the peer
                                        // over the already-authenticated link, and
                                        // they are never logged here or anywhere.
                                        putString("ssid", credentials.ssid)
                                        putString("passphrase", credentials.passphrase)
                                        putBoolean("active", credentials.active)
                                    }
                                )
                            },
                            onFailure = { once.reject(it) },
                        )
                    }
                }
            } catch (t: Throwable) {
                once.reject(t)
            }
        }
    }

    override fun stopHotspot(promise: Promise) {
        val once = Once(promise)
        handler.post {
            try {
                hotspot?.stop()
            } catch (t: Throwable) {
                Log.w(TAG, "stopping the hotspot failed", t)
            }
            // Stopping a hotspot that is not running is not an error.
            once.resolve(null)
        }
    }

    /**
     * The local-only hotspot, created on first use.
     *
     * Deliberately not built with the transports: it owns a thread and a
     * `WifiManager` reservation, and the overwhelming majority of sessions -
     * every Bluetooth-only conversation - never ask for one.
     */
    private fun hotspotHost(): HotspotHost {
        hotspot?.let { return it }
        val host = HotspotHost(appContext)
        host.events = this
        host.onStoppedBySystem = {
            // The system takes the hotspot away when the user turns tethering
            // on, switches Wi-Fi off, or leaves. JavaScript learns through the
            // diagnostic channel; the link over it dies on its own and reports
            // its own closed state.
            log("warn", "hotspot", "the system stopped the hotspot")
        }
        hotspot = host
        return host
    }

    override fun joinHotspot(ssid: String, passphrase: String, promise: Promise) {
        // Not a gap we can close. An Android app cannot silently join an
        // arbitrary access point the way an iPhone can with
        // NEHotspotConfiguration; the closest API, WifiNetworkSpecifier, shows a
        // system picker and produces a network bound to this app rather than a
        // system-wide join. Rejecting here is the honest answer, and the
        // negotiation layer reads canJoinHotspot and makes the iPhone the joiner.
        Once(promise).reject(
            AirLinkError.Unsupported("Joining a hotspot"),
        )
    }

    override fun leaveHotspot(ssid: String, promise: Promise) {
        // Nothing was ever joined, so there is nothing to leave. Resolving keeps
        // the cleanup path on the JavaScript side symmetric across platforms.
        Once(promise).resolve(null)
    }

    // =====================================================================
    // TransportEventSink. Called from radio threads; everything hops first.
    // =====================================================================

    override fun peerDiscovered(endpoint: DiscoveredEndpoint) {
        handler.post { emit("onPeerDiscovered") { emitOnPeerDiscovered(endpoint.toMap()) } }
    }

    override fun peerLost(endpoint: DiscoveredEndpoint) {
        handler.post { emit("onPeerLost") { emitOnPeerLost(endpoint.toMap()) } }
    }

    override fun linkOpened(
        linkId: String,
        transport: TransportKind,
        endpointId: String,
        maxDatagramSize: Int,
        highBandwidth: Boolean,
        incoming: Boolean,
    ) {
        handler.post {
            // State first, emit second, both on this thread: JavaScript learns
            // about a link only from this event, so by the time it can call
            // send() the routing table already knows where to send.
            linkOwners[linkId] = transport
            linkLimits[linkId] = maxDatagramSize
            updateForegroundSession()
            emit("onLinkOpened") {
                emitOnLinkOpened(
                    Arguments.createMap().apply {
                        putString("linkId", linkId)
                        putString("transport", transport.id)
                        putString("endpointId", endpointId)
                        putInt("maxDatagramSize", maxDatagramSize)
                        putBoolean("highBandwidth", highBandwidth)
                        putBoolean("incoming", incoming)
                    }
                )
            }
        }
    }

    override fun linkState(linkId: String, state: LinkState, reason: String) {
        handler.post {
            if (state == LinkState.CLOSED || state == LinkState.FAILED) {
                linkOwners.remove(linkId)
                linkLimits.remove(linkId)
                updateForegroundSession()
            }
            emit("onLinkState") {
                emitOnLinkState(
                    Arguments.createMap().apply {
                        putString("linkId", linkId)
                        putString("state", state.id)
                        putString("reason", reason)
                    }
                )
            }
        }
    }

    override fun received(linkId: String, data: ByteArray) {
        // A single datagram larger than the protocol's own ceiling can only be a
        // broken transport or a hostile peer. Dropping it bounds the damage; the
        // layer above would reject it anyway.
        if (data.size > MAX_INBOUND_DATAGRAM_BYTES) {
            log("error", "module", "dropped a ${data.size} byte datagram on $linkId; the limit is $MAX_INBOUND_DATAGRAM_BYTES")
            return
        }

        val queued = pendingInboundCount.incrementAndGet()
        val queuedBytes = pendingInboundBytes.addAndGet(data.size.toLong())

        // Backpressure. If JavaScript stops draining, the queue in front of it
        // is memory a peer controls, so it is bounded - and when the bound is
        // hit we tear the link down rather than dropping datagrams. The contract
        // above is that loss is signalled by a state change, never silently, and
        // the reliability layer resends everything after a reconnect.
        if (queued > MAX_PENDING_INBOUND_DATAGRAMS || queuedBytes > MAX_PENDING_INBOUND_BYTES) {
            pendingInboundCount.decrementAndGet()
            pendingInboundBytes.addAndGet(-data.size.toLong())
            log("error", "module", "inbound backlog exceeded on $linkId; closing the link")
            handler.post {
                val kind = linkOwners[linkId]
                val transport = kind?.let { transports[it] }
                try {
                    transport?.disconnect(linkId, "inbound backlog exceeded")
                } catch (t: Throwable) {
                    Log.w(TAG, "could not close $linkId after a backlog overflow", t)
                }
            }
            return
        }

        val encoded = try {
            Base64.getEncoder().encodeToString(data)
        } catch (t: Throwable) {
            pendingInboundCount.decrementAndGet()
            pendingInboundBytes.addAndGet(-data.size.toLong())
            Log.w(TAG, "could not encode an inbound datagram", t)
            return
        }

        handler.post {
            pendingInboundCount.decrementAndGet()
            pendingInboundBytes.addAndGet(-data.size.toLong())
            emit("onData") {
                emitOnData(
                    Arguments.createMap().apply {
                        putString("linkId", linkId)
                        putString("data", encoded)
                    }
                )
            }
        }
    }

    override fun mtuChanged(linkId: String, maxDatagramSize: Int) {
        handler.post {
            linkLimits[linkId] = maxDatagramSize
            emit("onMtuChanged") {
                emitOnMtuChanged(
                    Arguments.createMap().apply {
                        putString("linkId", linkId)
                        putInt("maxDatagramSize", maxDatagramSize)
                    }
                )
            }
        }
    }

    override fun availabilityChanged(
        transport: TransportKind,
        available: Boolean,
        reason: UnavailableReason,
    ) {
        handler.post {
            emit("onAvailabilityChanged") {
                emitOnAvailabilityChanged(
                    Arguments.createMap().apply {
                        putString("transport", transport.id)
                        putBoolean("available", available)
                        putString("reason", reason.id)
                    }
                )
            }
        }
    }

    override fun log(level: String, scope: String, message: String) {
        // Diagnostics are the one thing it is safe to drop: a transport stuck in
        // a logging loop must not be able to exhaust memory through this queue.
        if (pendingLogCount.get() > MAX_PENDING_LOGS) return
        pendingLogCount.incrementAndGet()
        handler.post {
            pendingLogCount.decrementAndGet()
            emit("onLog") {
                emitOnLog(
                    Arguments.createMap().apply {
                        putString("level", level)
                        putString("scope", scope)
                        putString("message", message)
                    }
                )
            }
        }
    }

    /**
     * Every emit goes through here. The generated emitters call into the C++
     * TurboModule, which is not wired up until JavaScript first imports the
     * module and is torn down when the React instance goes away - so an emit
     * that arrives a moment too early or a moment too late must be a no-op, not
     * a crash in a radio callback.
     */
    private fun emit(name: String, body: () -> Unit) {
        try {
            body()
        } catch (t: Throwable) {
            Log.w(TAG, "could not emit $name", t)
        }
    }

    // =====================================================================
    // Transport registry
    // =====================================================================

    /**
     * Builds one instance of every transport this device can actually use.
     *
     * THIS IS THE ONE PLACE the module names a radio implementation. Each is
     * constructed independently and any failure is contained, because BLE alone
     * is a working product and everything else is an upgrade: one transport
     * that cannot be built must never take the others down with it.
     */
    private fun buildTransports() {
        register { BleTransport(it) }
        register { LocalNetworkTransport(it) }
        // Constructed only where the hardware exists, so a device without the
        // radio never pays for the object and never reports the capability.
        if (hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)) {
            register { WifiDirectTransport(it) }
        }
        // There is deliberately no Wi-Fi Aware transport: see
        // wifi/WifiAwareNotes.kt. The identifier stays alive in the negotiation
        // protocol, and platformGate() reports it honestly as never available.
    }

    private fun register(factory: TransportFactory) {
        try {
            val transport = factory(appContext)
            transport.events = this
            transports[transport.kind] = transport
        } catch (t: Throwable) {
            // Includes LinkageError: a transport whose class is missing from the
            // build simply is not offered.
            Log.w(TAG, "a transport could not be created", t)
        }
    }

    private fun transportFor(name: String): AirLinkTransport {
        val kind = TransportKind.fromId(name) ?: throw AirLinkError.Unsupported("Transport '$name'")
        return transports[kind] ?: throw AirLinkError.Unsupported("Transport '$name' on this device")
    }

    private fun AirLinkTransport.availabilitySafely(): TransportAvailability = try {
        availability()
    } catch (t: Throwable) {
        Log.w(TAG, "$kind failed to report availability", t)
        TransportAvailability(
            available = false,
            reason = UnavailableReason.UNKNOWN,
            detail = "This connection is not available right now.",
        )
    }

    private fun requireStarted() {
        if (!started) throw AirLinkError.NotStarted()
    }

    /** Every simple routed call has the same shape: hop, run, settle. */
    private fun route(promise: Promise, body: () -> Unit) {
        val once = Once(promise)
        handler.post {
            try {
                body()
                once.resolve(null)
            } catch (t: Throwable) {
                once.reject(t)
            }
        }
    }

    // =====================================================================
    // Foreground session
    // =====================================================================

    /**
     * Start the foreground service while at least one link is open and stop it
     * the moment the last one closes. The notification is permanent and visible
     * while it runs, which is exactly why it is not always on.
     */
    private fun updateForegroundSession() {
        val count = linkOwners.size
        if (count == foregroundLinkCount) return
        foregroundLinkCount = count
        if (count > 0) {
            if (!ForegroundSessionService.start(appContext, count)) {
                log(
                    "warn",
                    "module",
                    "the session service could not start; this connection will not survive backgrounding",
                )
            }
            // From API 33 the service still runs without POST_NOTIFICATIONS, but
            // its notification is hidden - so the user sees no explanation for
            // the battery use. Worth saying out loud in Developer Mode rather
            // than forcing an unrelated prompt on someone who only wanted
            // Bluetooth.
            val notifications = Permissions.notificationPermission()
            if (notifications != null && !Permissions.isGranted(appContext, notifications)) {
                log("info", "module", "notifications are not permitted; the session notification will be hidden")
            }
        } else {
            ForegroundSessionService.stop(appContext)
        }
    }

    // =====================================================================
    // Radio and network state
    // =====================================================================

    private fun bluetoothAdapter(): BluetoothAdapter? = try {
        // BluetoothAdapter.getDefaultAdapter() is deprecated; the manager is the
        // supported route from API 18 onwards.
        appContext.getSystemService(BluetoothManager::class.java)?.adapter
    } catch (t: Throwable) {
        Log.w(TAG, "could not obtain the Bluetooth adapter", t)
        null
    }

    private fun canAdvertiseBle(): Boolean = try {
        bluetoothAdapter()?.isMultipleAdvertisementSupported == true
    } catch (t: Throwable) {
        // Several devices answer this only while the adapter is on, and a few
        // throw. False is the safe answer: the app degrades to central-only
        // rather than promising an advertisement it cannot make.
        Log.w(TAG, "could not query BLE advertising support", t)
        false
    }

    /**
     * Whether `createHotspot()` could ever succeed on this device and this OS.
     *
     * Two conditions, and the second one is the interesting half: Wi-Fi
     * hardware, and a permission the merged manifest actually declares on this
     * release. On API 31 and 32 there is none - ACCESS_FINE_LOCATION is capped
     * at 30 and NEARBY_WIFI_DEVICES starts at 33 - so the honest answer there is
     * false even though the hardware and the API are both present.
     *
     * Deliberately NOT a check on whether the permission is granted: this is
     * "could you", not "may you right now". JavaScript asks for the permission
     * at the moment it offers the fast path.
     */
    private fun canCreateHotspot(): Boolean {
        if (!hasSystemFeature(PackageManager.FEATURE_WIFI)) return false
        return Permissions.hotspotPermissions().all { Permissions.isDeclared(appContext, it) }
    }

    private fun hasSystemFeature(feature: String): Boolean = try {
        appContext.packageManager.hasSystemFeature(feature)
    } catch (t: Throwable) {
        Log.w(TAG, "could not query system feature $feature", t)
        false
    }

    /**
     * Whether there is a network a peer could plausibly be reachable on.
     *
     * This is a heuristic and is documented as one: it asks about the DEFAULT
     * network, so a phone on both cellular and an internet-less Wi-Fi - or one
     * hosting a local-only hotspot, where the soft AP is never the default route
     * - reports false even though the local network would work perfectly.
     *
     * That is precisely why the gate it feeds is marked advisory in
     * [platformGate]: it is used only when the local-network transport has no
     * instance to answer for itself. The transport, which watches every network
     * with a NetworkCallback rather than guessing from the default route,
     * always wins.
     */
    private fun hasLocalNetworkPath(): Boolean = try {
        val manager = appContext.getSystemService(ConnectivityManager::class.java)
        val network = manager?.activeNetwork
        val capabilities = if (manager != null && network != null) {
            manager.getNetworkCapabilities(network)
        } else {
            null
        }
        capabilities != null && (
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
            )
    } catch (t: Throwable) {
        Log.w(TAG, "could not inspect the active network", t)
        false
    }

    /**
     * The module watches the Bluetooth adapter itself rather than trusting a
     * transport to notice. Switching Bluetooth off mid-session has to produce a
     * clean availability event even if the BLE transport is wedged, because "not
     * connected" is a state the product can show and a crash is not.
     */
    private val bluetoothStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_ON ->
                    availabilityChanged(TransportKind.BLE, true, UnavailableReason.NONE)
                BluetoothAdapter.STATE_OFF, BluetoothAdapter.STATE_TURNING_OFF ->
                    availabilityChanged(TransportKind.BLE, false, UnavailableReason.RADIO_OFF)
                else -> Unit
            }
        }
    }

    private fun registerBluetoothStateReceiver() {
        if (bluetoothReceiverRegistered) return
        try {
            val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // Mandatory from API 34 for a target of 34+. This is a protected
                // system broadcast, so NOT_EXPORTED is both correct and enough.
                appContext.registerReceiver(bluetoothStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                appContext.registerReceiver(bluetoothStateReceiver, filter)
            }
            bluetoothReceiverRegistered = true
        } catch (t: Throwable) {
            Log.w(TAG, "could not watch the Bluetooth adapter state", t)
        }
    }

    private fun unregisterBluetoothStateReceiver() {
        if (!bluetoothReceiverRegistered) return
        bluetoothReceiverRegistered = false
        try {
            appContext.unregisterReceiver(bluetoothStateReceiver)
        } catch (t: Throwable) {
            Log.w(TAG, "could not stop watching the Bluetooth adapter state", t)
        }
    }

    private fun permissionAwareActivityOrNull(): PermissionAwareActivity? = try {
        reactApplicationContext.currentActivity as? PermissionAwareActivity
    } catch (t: Throwable) {
        null
    }

    // =====================================================================
    // Teardown
    // =====================================================================

    override fun invalidate() {
        // The React instance is going away. Everything this module owns - radios,
        // the notification, a background thread - has to go with it, or the next
        // instance inherits a half-live stack.
        try {
            handler.post { stopEverything() }
            handler.post { thread.quitSafely() }
        } catch (t: Throwable) {
            Log.w(TAG, "teardown failed", t)
        }
        super.invalidate()
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    /**
     * Settles a promise exactly once.
     *
     * Every path here has at least two ways to finish - the transport's callback
     * and a watchdog - and React Native logs a hard error when a promise is
     * settled twice, so the race is resolved here rather than at each call site.
     */
    private class Once(private val promise: Promise) {
        private val settled = AtomicBoolean(false)

        fun resolve(value: Any?): Boolean {
            if (!settled.compareAndSet(false, true)) return false
            try {
                promise.resolve(value)
            } catch (t: Throwable) {
                Log.w(TAG, "could not resolve a promise", t)
            }
            return true
        }

        fun reject(error: Throwable): Boolean {
            if (!settled.compareAndSet(false, true)) return false
            try {
                val code = (error as? AirLinkError)?.code ?: "failed"
                promise.reject(code, describeThrowable(error))
            } catch (t: Throwable) {
                Log.w(TAG, "could not reject a promise", t)
            }
            return true
        }
    }

    /**
     * base64 in, bytes out. Strict on purpose: silently accepting malformed
     * input would let a corrupted string become a corrupted datagram, which the
     * layer above cannot distinguish from a hostile one.
     */
    private fun decodeBase64(value: String): ByteArray = try {
        Base64.getDecoder().decode(value)
    } catch (t: IllegalArgumentException) {
        throw AirLinkError.Failed("payload was not valid base64")
    }

    private fun clampTimeout(timeoutMs: Double): Long {
        if (timeoutMs.isNaN()) return DEFAULT_CONNECT_TIMEOUT_MS
        val value = timeoutMs.toLong()
        if (value <= 0L) return DEFAULT_CONNECT_TIMEOUT_MS
        return value.coerceIn(MIN_CONNECT_TIMEOUT_MS, MAX_CONNECT_TIMEOUT_MS)
    }

    companion object {
        private const val TAG = "AirLinkTransport"

        /**
         * Matches MAX_FRAME_BYTES in the protocol constants. A datagram larger
         * than the largest logical frame the protocol can build cannot be
         * legitimate.
         */
        private const val MAX_INBOUND_DATAGRAM_BYTES = 256 * 1024

        /** Bounds on the queue between a radio thread and JavaScript. */
        private const val MAX_PENDING_INBOUND_DATAGRAMS = 2_048
        private const val MAX_PENDING_INBOUND_BYTES = 8L * 1024 * 1024
        private const val MAX_PENDING_LOGS = 256

        private const val DEFAULT_CONNECT_TIMEOUT_MS = 15_000L
        private const val MIN_CONNECT_TIMEOUT_MS = 1_000L
        private const val MAX_CONNECT_TIMEOUT_MS = 120_000L

        /** Grace on top of the transport's own budget before the module gives up. */
        private const val CONNECT_WATCHDOG_GRACE_MS = 2_000L

        /**
         * A send that the radio has not even accepted after this long is not
         * coming back. Generous because a congested BLE queue is slow, not
         * broken.
         */
        private const val SEND_WATCHDOG_MS = 30_000L

        /**
         * Longer than the hotspot host's own 20s deadline on purpose, so its
         * specific failure reaches JavaScript rather than this generic one.
         */
        private const val HOTSPOT_WATCHDOG_MS = 25_000L

        /**
         * Long enough that a user reading the dialog is never cut off, short
         * enough that a promise cannot be pending for the life of the process.
         */
        private const val PERMISSION_TIMEOUT_MS = 180_000L

        private const val PERMISSION_REQUEST_CODE_BASE = 0x4A00

        private fun describeThrowable(error: Throwable): String =
            error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName
    }
}
