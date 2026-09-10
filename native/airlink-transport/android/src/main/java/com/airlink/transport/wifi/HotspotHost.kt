package com.airlink.transport.wifi

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import com.airlink.transport.AirLinkError
import com.airlink.transport.Permissions
import com.airlink.transport.TransportAvailability
import com.airlink.transport.TransportEventSink
import com.airlink.transport.UnavailableReason

/**
 * The credentials of a running local-only hotspot.
 *
 * THESE ARE SECRETS. They exist in memory, cross the bridge once, and are handed
 * to the peer over the already-authenticated Bluetooth session. They are never
 * logged, never written to disk and never put in a diagnostic event - see the
 * logging note in [HotspotHost].
 */
data class HotspotCredentials(
    val ssid: String,
    val passphrase: String,
    /** True while the reservation is live and a peer may join. */
    val active: Boolean,
)

/**
 * The local-only hotspot: the ONLY high-bandwidth path between an iPhone and an
 * Android phone when there is no network at all.
 *
 * Deliberately NOT an [com.airlink.transport.AirLinkTransport]. It discovers
 * nothing, opens no link and moves no datagram; it produces a Wi-Fi network for
 * [LocalNetworkTransport] to run over, and its only output is a pair of
 * credentials. The module owns one of these and talks to it directly.
 *
 * WHY THE ANDROID SIDE ALWAYS HOSTS. An Android app can start a hotspot
 * (`WifiManager.startLocalOnlyHotspot`) but cannot silently join one; an iPhone
 * can join one (`NEHotspotConfiguration`) but cannot start one. The asymmetry
 * decides the roles for us.
 *
 * How the handoff works, end to end:
 *
 *   1. The two phones are already talking over BLE - slow, but authenticated.
 *   2. The Android side starts a local-only hotspot here. The system generates
 *      the SSID and a WPA2 passphrase; an app cannot choose either.
 *   3. Those credentials go to the iPhone over the existing encrypted BLE
 *      session, and nowhere else.
 *   4. The iPhone applies them with NEHotspotConfiguration and joins after one
 *      system confirmation tap.
 *   5. Both sides then run the local-network transport over that Wi-Fi: NSD
 *      finds the peer and TCP moves the photo in seconds instead of minutes.
 *
 * THINGS THE PRODUCT MUST NOT PROMISE PAST:
 *
 *   - THE RESERVATION DIES WITH THE APP. Android tears the hotspot down when
 *     this process exits or is killed, and there is no way to keep it alive in
 *     the background. A transfer over it is a foreground activity, and the UI
 *     has to say so.
 *   - Starting a hotspot usually drops the phone's own Wi-Fi connection, because
 *     most chipsets cannot be a station and a soft AP on different channels at
 *     once. Only offer this when there is no shared network already.
 *   - Only one app may hold a local-only hotspot at a time, and it will not
 *     start at all while system tethering is on.
 *   - On API 31 and 32 this cannot run at all: it needs ACCESS_FINE_LOCATION,
 *     which the manifest caps at API 30, and NEARBY_WIFI_DEVICES only exists
 *     from API 33. See the matrix in Permissions.kt - the gap is deliberate.
 *
 * THE CREDENTIALS ARE SECRETS. Every log line in this file deliberately mentions
 * lengths and outcomes only. If you add one, keep it that way: `onLog` is
 * surfaced in Developer Mode and could be screenshotted.
 */
@SuppressLint("MissingPermission")
class HotspotHost(private val context: Context) {

    private companion object {
        const val SCOPE = "hotspot"

        /** WPA2 rejects anything shorter; a shorter one means we misread the config. */
        const val MIN_PASSPHRASE_LENGTH = 8

        /**
         * How long the system gets to bring a soft AP up.
         *
         * Deliberately shorter than the module's own watchdog on this call, so
         * that when the platform simply never answers - which happens on some
         * devices when tethering is in a bad state - the caller gets this
         * specific failure rather than the module's generic one.
         */
        const val START_TIMEOUT_MS = 20_000L
    }

    /** Set by the module immediately after construction. */
    var events: TransportEventSink? = null

    /**
     * Called when the SYSTEM stops the hotspot - the user turned tethering on,
     * switched Wi-Fi off, or a vendor policy reclaimed the radio. Not called for
     * a [stop] we asked for: the platform delivers no further callbacks once the
     * reservation has been closed from this side.
     */
    var onStoppedBySystem: (() -> Unit)? = null

    /**
     * Every mutation below happens on this one thread, so none of it needs a
     * lock and none of it can race with a WifiManager callback. The same handler
     * is handed to `startLocalOnlyHotspot`, so its callbacks land here too.
     */
    private val controlThread = HandlerThread("airlink-hotspot").apply {
        isDaemon = true
        start()
    }
    private val control = Handler(controlThread.looper)

    private val wifiManager: WifiManager? =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager

    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null

    @Volatile
    private var credentials: HotspotCredentials? = null

    private var pending: ((Result<HotspotCredentials>) -> Unit)? = null
    private var timeout: Runnable? = null

    /** The credentials of the running hotspot, or null when none is running. */
    fun credentials(): HotspotCredentials? = credentials

    /**
     * Whether a hotspot could be started right now, and if not, why.
     *
     * Wi-Fi being switched off is deliberately NOT reported as unavailable: the
     * platform brings the soft AP up regardless of the station radio's state,
     * and telling a user to turn on Wi-Fi when they do not need to would send
     * them round a loop that changes nothing.
     */
    fun availability(): TransportAvailability {
        if (wifiManager == null || !hasWifiHardware()) {
            return TransportAvailability(
                available = false,
                reason = UnavailableReason.UNSUPPORTED_HARDWARE,
                detail = "This device cannot create a Wi-Fi hotspot.",
            )
        }

        var worst = Permissions.State.GRANTED
        for (permission in Permissions.hotspotPermissions()) {
            // No activity to hand in: the distinction between "denied" and
            // "denied forever" belongs to the permission screen, and this answer
            // only has to be honest about whether we can start one now.
            val state = Permissions.state(context, null, permission)
            if (state != Permissions.State.GRANTED) worst = state
        }
        if (worst != Permissions.State.GRANTED) {
            return TransportAvailability(
                available = false,
                reason = Permissions.reasonFor(worst),
                detail = if (worst == Permissions.State.NOT_DECLARED) {
                    // The honest answer on API 31-32. No dialog can fix it and no
                    // trip to Settings can either - only a different build could.
                    "Sharing a hotspot is not available on this version of Android. " +
                        "Bluetooth still works."
                } else {
                    "AirLink needs permission to create a Wi-Fi hotspot for your friend to join."
                },
            )
        }

        return TransportAvailability(available = true, reason = UnavailableReason.NONE, detail = "")
    }

    /**
     * Starts a hotspot and reports its credentials. Calls back exactly once, on
     * this class's own thread.
     *
     * Idempotent in the useful direction: called while one is already running it
     * resolves immediately with the live credentials, because two features may
     * both want the fast path and neither should tear down the other's hotspot.
     */
    fun start(completion: (Result<HotspotCredentials>) -> Unit) {
        control.post {
            val existing = credentials
            if (existing != null && reservation != null) {
                completion(Result.success(existing))
                return@post
            }
            if (pending != null) {
                // Only one soft AP request may be in flight; a second would race
                // the first for the single reservation the platform hands out.
                completion(Result.failure(AirLinkError.Busy("Starting a hotspot")))
                return@post
            }

            val manager = wifiManager
            if (manager == null || !hasWifiHardware()) {
                completion(Result.failure(AirLinkError.Unsupported("Starting a hotspot")))
                return@post
            }
            for (permission in Permissions.hotspotPermissions()) {
                if (!Permissions.isGranted(context, permission)) {
                    // A missing permission is a REASON, never an unhandled throw.
                    completion(
                        Result.failure(
                            AirLinkError.Failed(
                                "AirLink does not have permission to start a Wi-Fi hotspot on this device.",
                            ),
                        ),
                    )
                    return@post
                }
            }

            pending = completion

            // The system can take several seconds to bring a soft AP up, and on
            // some devices it never calls back at all - hence a deadline rather
            // than an open-ended wait on a promise in JavaScript.
            val deadline = Runnable {
                settle(Result.failure(AirLinkError.Timeout("starting a local-only hotspot")))
            }
            timeout = deadline
            control.postDelayed(deadline, START_TIMEOUT_MS)

            val callback = object : WifiManager.LocalOnlyHotspotCallback() {
                override fun onStarted(started: WifiManager.LocalOnlyHotspotReservation?) {
                    control.post {
                        if (started == null) {
                            settle(Result.failure(AirLinkError.Failed("the hotspot started without a reservation")))
                            return@post
                        }
                        if (pending == null) {
                            // We already timed out, or someone called stop(). Do
                            // not leave a radio running that nobody will use.
                            closeQuietly(started)
                            return@post
                        }
                        val extracted = credentialsOf(started)
                        if (extracted == null) {
                            closeQuietly(started)
                            settle(Result.failure(AirLinkError.Failed("could not read the hotspot credentials")))
                            return@post
                        }
                        reservation = started
                        credentials = extracted
                        log("info", "hotspot up, passphrase ${extracted.passphrase.length} characters")
                        settle(Result.success(extracted))
                    }
                }

                override fun onStopped() {
                    control.post {
                        val wasRunning = reservation != null
                        reservation = null
                        credentials = null
                        if (wasRunning) {
                            log("info", "hotspot stopped by the system")
                            onStoppedBySystem?.invoke()
                        }
                        // Harmless when nothing is pending; settle() is a no-op
                        // once a result has been delivered.
                        settle(Result.failure(AirLinkError.Failed("the hotspot stopped before anyone joined")))
                    }
                }

                override fun onFailed(reason: Int) {
                    control.post {
                        val detail = hotspotError(reason)
                        log("error", "hotspot failed: $detail")
                        settle(Result.failure(AirLinkError.Failed("could not start the hotspot: $detail")))
                    }
                }
            }

            try {
                // The handler argument is what puts every callback above on this
                // class's thread instead of the main looper.
                manager.startLocalOnlyHotspot(callback, control)
            } catch (_: SecurityException) {
                settle(Result.failure(AirLinkError.Failed("permission to create a hotspot was refused")))
            } catch (_: IllegalStateException) {
                // Thrown when tethering is already on, or another app holds the
                // one local-only hotspot the platform allows.
                settle(Result.failure(AirLinkError.Failed("the hotspot is unavailable while tethering is on")))
            } catch (t: Throwable) {
                settle(Result.failure(AirLinkError.Failed("could not start the hotspot: ${t.javaClass.simpleName}")))
            }
        }
    }

    /** Idempotent. Safe to call when nothing is running, and safe to call twice. */
    fun stop() {
        control.post {
            val running = reservation != null
            reservation?.let { closeQuietly(it) }
            reservation = null
            credentials = null
            // A start that was still in flight has to be told, or its promise
            // never settles.
            settle(Result.failure(AirLinkError.Failed("the hotspot was stopped")))
            if (running) log("info", "hotspot stopped")
        }
    }

    // -- internals ------------------------------------------------------------

    private fun hasWifiHardware(): Boolean = try {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)
    } catch (_: RuntimeException) {
        // A package manager that throws must not be what stops an offline app.
        false
    }

    /** Must run on the control thread. Delivers at most one result per start(). */
    private fun settle(result: Result<HotspotCredentials>) {
        timeout?.let { control.removeCallbacks(it) }
        timeout = null
        val completion = pending ?: return
        pending = null
        try {
            completion(result)
        } catch (t: Throwable) {
            log("error", "hotspot completion threw: ${t.javaClass.simpleName}")
        }
    }

    private fun closeQuietly(target: WifiManager.LocalOnlyHotspotReservation) {
        try {
            target.close()
        } catch (t: Throwable) {
            log("debug", "closing the reservation threw ${t.javaClass.simpleName}")
        }
    }

    /**
     * Reading the SSID and passphrase is three different APIs depending on the
     * release, and each older one is deprecated rather than removed:
     *
     *   API 33+  SoftApConfiguration.getWifiSsid() -> WifiSsid, raw bytes
     *   API 30+  SoftApConfiguration.getSsid()     -> deprecated String
     *   API 26+  getWifiConfiguration()            -> deprecated WifiConfiguration
     *
     * Each is used only on the releases where it is the newest thing available,
     * which is the whole reason this is a ladder and not one call.
     */
    private fun credentialsOf(target: WifiManager.LocalOnlyHotspotReservation): HotspotCredentials? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                fromSoftApConfiguration(target)
            } else {
                fromWifiConfiguration(target)
            }
        } catch (t: Throwable) {
            // Never let a vendor's odd configuration object crash the app.
            log("error", "could not read the hotspot configuration: ${t.javaClass.simpleName}")
            null
        }
    }

    private fun fromSoftApConfiguration(
        target: WifiManager.LocalOnlyHotspotReservation,
    ): HotspotCredentials? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val configuration = target.softApConfiguration
        val ssid = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // getSsid() is deprecated from Android 13 because an SSID is bytes,
            // not text. The platform writes UTF-8 for a generated local-only
            // hotspot, so that is how we read it back.
            configuration.wifiSsid?.bytes?.toString(Charsets.UTF_8)
        } else {
            @Suppress("DEPRECATION")
            configuration.ssid
        }
        return validated(ssid, configuration.passphrase)
    }

    /**
     * getWifiConfiguration() is deprecated from API 30 in favour of
     * getSoftApConfiguration(), which is what we use there. Below 30 it is the
     * only thing that exists, so the suppression is confined to this one file's
     * fallback rather than spread across the class.
     */
    @Suppress("DEPRECATION")
    private fun fromWifiConfiguration(
        target: WifiManager.LocalOnlyHotspotReservation,
    ): HotspotCredentials? {
        val configuration = target.wifiConfiguration ?: return null
        return validated(configuration.SSID, configuration.preSharedKey)
    }

    private fun validated(rawSsid: String?, rawPassphrase: String?): HotspotCredentials? {
        val ssid = stripQuotes(rawSsid)
        val passphrase = stripQuotes(rawPassphrase)
        if (ssid.isEmpty()) return null
        // An open local-only hotspot would put a photo transfer on the air in
        // the clear for anyone in range. The AirLink session above it is
        // encrypted regardless, but we still refuse to offer this as the fast
        // path - and iOS would reject a passphrase this short anyway.
        if (passphrase.length < MIN_PASSPHRASE_LENGTH) return null
        return HotspotCredentials(ssid, passphrase, active = true)
    }

    /** WifiConfiguration stores both fields quoted; SoftApConfiguration does not. */
    private fun stripQuotes(value: String?): String {
        val text = value ?: return ""
        return if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
            text.substring(1, text.length - 1)
        } else {
            text
        }
    }

    private fun hotspotError(reason: Int): String = when (reason) {
        WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL ->
            "no Wi-Fi channel is free"
        WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE ->
            "the Wi-Fi hardware is busy with something else"
        WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED ->
            "tethering is not allowed on this device"
        WifiManager.LocalOnlyHotspotCallback.ERROR_GENERIC ->
            "the system refused"
        else -> "error $reason"
    }

    private fun log(level: String, message: String) {
        // Deliberately never includes the SSID or the passphrase.
        events?.log(level, SCOPE, message)
    }
}
