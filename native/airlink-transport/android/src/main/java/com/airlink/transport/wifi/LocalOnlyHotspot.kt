package com.airlink.transport.wifi

import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import com.airlink.transport.AirLinkError
import com.airlink.transport.HotspotCredentials
import com.airlink.transport.Permissions
import com.airlink.transport.TransportEventSink

/**
 * The local-only hotspot: the ONLY high-bandwidth path between an iPhone and an
 * Android phone when there is no network at all.
 *
 * This class is the WifiManager half; LocalNetworkTransport implements the
 * module-facing `HotspotHost` interface and delegates here, because the two
 * belong together - the whole point of starting a hotspot is to give NSD and
 * TCP somewhere to run.
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
 *   - The reservation dies with the app. Android tears the hotspot down when
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
 * THE CREDENTIALS ARE SECRETS. They are never logged, never written to disk and
 * never put in an analytics event; they exist in memory and travel exactly once
 * over the authenticated BLE link. Every log line in this file deliberately
 * mentions lengths and outcomes only.
 */
internal class LocalOnlyHotspot(private val context: Context) {

    private companion object {
        const val SCOPE = "hotspot"

        /** WPA2 rejects anything shorter; a shorter one means we misread the config. */
        const val MIN_PASSPHRASE_LENGTH = 8

        /** Clamp on the caller's deadline, so a bad argument cannot mean "never". */
        const val MIN_TIMEOUT_MS = 5_000
        const val MAX_TIMEOUT_MS = 60_000
    }

    var events: TransportEventSink? = null

    /** Called when the SYSTEM stops the hotspot - tethering, Wi-Fi off, a vendor policy. */
    var onStoppedBySystem: (() -> Unit)? = null

    private val controlThread = HandlerThread("airlink-hotspot").apply {
        isDaemon = true
        start()
    }
    private val control = Handler(controlThread.looper)

    private val wifiManager: WifiManager? =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager

    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    private var credentials: HotspotCredentials? = null
    private var pending: ((Result<HotspotCredentials>) -> Unit)? = null
    private var timeout: Runnable? = null

    /** The credentials of the running hotspot, or null when none is running. */
    fun credentials(): HotspotCredentials? = credentials

    /**
     * Starts a hotspot and reports its credentials.
     *
     * Idempotent in the useful direction: called while one is already running it
     * resolves immediately with the live credentials, because two features may
     * both want the fast path and neither should tear down the other's hotspot.
     */
    fun start(timeoutMs: Int, completion: (Result<HotspotCredentials>) -> Unit) {
        control.post {
            val existing = credentials
            if (existing != null && reservation != null) {
                completion(Result.success(existing))
                return@post
            }
            if (pending != null) {
                completion(Result.failure(AirLinkError.Busy("Starting a hotspot")))
                return@post
            }

            val manager = wifiManager
            if (manager == null ||
                !context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)
            ) {
                completion(Result.failure(AirLinkError.Unsupported("Starting a hotspot")))
                return@post
            }
            for (permission in Permissions.hotspotPermissions()) {
                if (!Permissions.isGranted(context, permission)) {
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
            // some devices it never calls back at all when tethering is in a bad
            // state - hence a deadline rather than an open-ended wait.
            val budget = timeoutMs.coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS).toLong()
            val deadline = Runnable {
                settle(Result.failure(AirLinkError.Timeout("starting a local-only hotspot")))
            }
            timeout = deadline
            control.postDelayed(deadline, budget)

            val callback = object : WifiManager.LocalOnlyHotspotCallback() {
                override fun onStarted(started: WifiManager.LocalOnlyHotspotReservation?) {
                    control.post {
                        if (started == null) {
                            settle(Result.failure(AirLinkError.Failed("the hotspot started without a reservation")))
                            return@post
                        }
                        if (pending == null) {
                            // We already gave up, or someone called stop(). Do not
                            // leave a hotspot running that nobody will use.
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

    /** Idempotent. Safe to call when nothing is running. */
    fun stop() {
        control.post {
            val running = reservation != null
            reservation?.let { closeQuietly(it) }
            reservation = null
            credentials = null
            settle(Result.failure(AirLinkError.Failed("the hotspot was stopped")))
            if (running) log("info", "hotspot stopped")
        }
    }

    // -- internals ------------------------------------------------------------

    /** Must run on the control thread. Delivers at most one result per start(). */
    private fun settle(result: Result<HotspotCredentials>) {
        timeout?.let { control.removeCallbacks(it) }
        timeout = null
        val completion = pending ?: return
        pending = null
        completion(result)
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
     * Each is used only on the releases where it is the newest thing available.
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
            // not text. The platform writes UTF-8, so that is how we read it.
            configuration.wifiSsid?.bytes?.toString(Charsets.UTF_8)
        } else {
            @Suppress("DEPRECATION")
            configuration.ssid
        }
        return validated(ssid, configuration.passphrase)
    }

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
        // the clear for anyone in range. The AirLink session above is encrypted
        // regardless, but we still refuse to hand this out as the fast path -
        // and iOS would reject a passphrase this short anyway.
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
