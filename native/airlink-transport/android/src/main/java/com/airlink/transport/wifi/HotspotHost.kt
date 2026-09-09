package com.airlink.transport.wifi

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import com.airlink.transport.AirLinkError
import com.airlink.transport.Availability
import com.airlink.transport.TransportEventSink
import com.airlink.transport.UnavailableReason

/**
 * The local-only hotspot: the ONLY high-bandwidth path between an iPhone and an
 * Android phone when there is no network at all.
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
 *
 * THE CREDENTIALS ARE SECRETS. They are never logged, never written to disk and
 * never put in an analytics event; they exist in memory and travel exactly once
 * over the authenticated BLE link. Every log line in this file deliberately
 * mentions lengths and outcomes only.
 *
 * ASSUMED CONTRACT: AirLinkError, Availability and TransportEventSink from the
 * parent package, as listed at the top of LocalNetworkTransport.
 */
class HotspotHost(private val context: Context) {

    private companion object {
        const val SCOPE = "hotspot"

        /**
         * The system can take a few seconds to bring a soft AP up, and on some
         * devices it never calls back at all when tethering is in a bad state -
         * hence a deadline rather than an open-ended wait.
         */
        const val START_TIMEOUT_MS = 20_000L

        /** WPA2 rejects anything shorter; a shorter one means we misread the config. */
        const val MIN_PASSPHRASE_LENGTH = 8
    }

    /** What the peer needs in order to join. Handed over the BLE link, never logged. */
    data class Credentials(val ssid: String, val passphrase: String, val active: Boolean)

    var events: TransportEventSink? = null

    /** Called when the SYSTEM stops the hotspot - user tethering, Wi-Fi off, a reboot of the AP. */
    var onStoppedBySystem: (() -> Unit)? = null

    private val controlThread = HandlerThread("airlink-hotspot").apply {
        isDaemon = true
        start()
    }
    private val control = Handler(controlThread.looper)

    private val wifiManager: WifiManager? =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager

    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    private var credentials: Credentials? = null
    private var pending: ((Result<Credentials>) -> Unit)? = null
    private var timeout: Runnable? = null

    // -- availability ---------------------------------------------------------

    fun availability(): Availability {
        if (wifiManager == null ||
            !context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)
        ) {
            return Availability(
                false,
                UnavailableReason.UNSUPPORTED_HARDWARE,
                "This device cannot create a Wi-Fi hotspot.",
            )
        }
        if (!hasHotspotPermission()) {
            return Availability(
                false,
                UnavailableReason.PERMISSION_NOT_REQUESTED,
                "AirLink needs permission to create a Wi-Fi hotspot for your friend to join.",
            )
        }
        return Availability(true, UnavailableReason.NONE, "")
    }

    /**
     * startLocalOnlyHotspot has always needed CHANGE_WIFI_STATE (an install-time
     * permission) plus a runtime one: ACCESS_FINE_LOCATION historically, and
     * NEARBY_WIFI_DEVICES from Android 13, which is what we would rather ask for
     * because it carries the neverForLocation promise. Either is accepted so a
     * user who granted location for BLE scanning on an older phone is not asked
     * twice.
     */
    private fun hasHotspotPermission(): Boolean {
        val granted = { permission: String ->
            context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            granted(Manifest.permission.NEARBY_WIFI_DEVICES)
        ) {
            return true
        }
        return granted(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    /** The credentials of the running hotspot, or null when none is running. */
    fun credentials(): Credentials? = credentials

    // -- start / stop ---------------------------------------------------------

    /**
     * Starts a hotspot and reports its credentials.
     *
     * Idempotent: calling it while one is already running resolves immediately
     * with the credentials that are already live, because the bridge may be
     * asked twice by two features that both want the fast path.
     */
    fun start(completion: (Result<Credentials>) -> Unit) {
        control.post {
            val existing = credentials
            if (existing != null && reservation != null) {
                completion(Result.success(existing))
                return@post
            }
            if (pending != null) {
                completion(Result.failure(AirLinkError.Failed("a hotspot is already starting")))
                return@post
            }

            val manager = wifiManager
            if (manager == null ||
                !context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)
            ) {
                completion(Result.failure(AirLinkError.Unsupported("hotspot")))
                return@post
            }
            if (!hasHotspotPermission()) {
                completion(Result.failure(AirLinkError.Failed("permission to create a hotspot was not granted")))
                return@post
            }

            pending = completion

            val deadline = Runnable {
                // Some devices simply never call back. Fail the caller, and if a
                // reservation turns up afterwards it is closed on arrival rather
                // than left running invisibly.
                settle(Result.failure(AirLinkError.Timeout("starting the hotspot")))
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
                            // We already gave up. Do not leave a hotspot running
                            // that nobody is going to use.
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
                        log("error", "hotspot failed: ${hotspotError(reason)}")
                        settle(Result.failure(AirLinkError.Failed("could not start the hotspot: ${hotspotError(reason)}")))
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
            reservation?.let { closeQuietly(it) }
            reservation = null
            credentials = null
            settle(Result.failure(AirLinkError.Failed("the hotspot was stopped")))
            log("info", "hotspot stopped")
        }
    }

    // -- internals ------------------------------------------------------------

    /** Must run on the control thread. Delivers at most one result per start(). */
    private fun settle(result: Result<Credentials>) {
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
    private fun credentialsOf(target: WifiManager.LocalOnlyHotspotReservation): Credentials? {
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

    private fun fromSoftApConfiguration(target: WifiManager.LocalOnlyHotspotReservation): Credentials? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val configuration = target.softApConfiguration
        val ssid = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // getSsid() is deprecated from Android 13 because an SSID is bytes,
            // not text; we decode as UTF-8, which is what the platform writes.
            configuration.wifiSsid?.bytes?.toString(Charsets.UTF_8)
        } else {
            @Suppress("DEPRECATION")
            configuration.ssid
        }
        val passphrase = configuration.passphrase
        return validated(ssid, passphrase)
    }

    private fun fromWifiConfiguration(target: WifiManager.LocalOnlyHotspotReservation): Credentials? {
        @Suppress("DEPRECATION")
        val configuration = target.wifiConfiguration ?: return null
        @Suppress("DEPRECATION")
        val ssid = configuration.SSID
        @Suppress("DEPRECATION")
        val passphrase = configuration.preSharedKey
        return validated(ssid, passphrase)
    }

    private fun validated(rawSsid: String?, rawPassphrase: String?): Credentials? {
        val ssid = stripQuotes(rawSsid)
        val passphrase = stripQuotes(rawPassphrase)
        if (ssid.isEmpty()) return null
        // An open local-only hotspot would put the transfer on the air in the
        // clear for anyone in range. The AirLink session above is encrypted
        // regardless, but we still refuse to advertise this as the fast path.
        if (passphrase.length < MIN_PASSPHRASE_LENGTH) return null
        return Credentials(ssid, passphrase, active = true)
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
