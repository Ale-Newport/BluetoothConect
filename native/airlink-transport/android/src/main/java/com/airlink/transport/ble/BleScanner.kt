package com.airlink.transport.ble

import android.annotation.SuppressLint
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Build
import android.os.Handler
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Base64
import com.airlink.transport.DiscoveredEndpoint
import com.airlink.transport.TransportKind
import java.util.UUID

/**
 * The central half of discovery: finding AirLink peers with
 * `BluetoothLeScanner`.
 *
 * `BluetoothAdapter.startLeScan` is long deprecated and is not used here; the
 * scanner API is the only correct one, and it is the only one that takes a
 * filter, which matters more than it looks. A filtered scan is the only kind
 * Android keeps running with the screen off, and a service-UUID filter is the
 * only thing an iPhone in the foreground can be matched on.
 *
 * WHAT WE CANNOT SEE, and must not pretend to. A backgrounded iOS peripheral
 * moves its service UUIDs into the advertisement's overflow area, which Apple
 * documents as discoverable only by an iOS device that is explicitly scanning
 * for them, and drops its local name. No Android `ScanFilter` will ever match
 * it. That is a platform decision, not a bug we can engineer around, and the
 * product tells the user the truth: keep AirLink open.
 */
@SuppressLint("MissingPermission")
internal class BleScanner(
    private val handler: Handler,
    private val availability: BleAvailability,
    private val onDiscovered: (DiscoveredEndpoint) -> Unit,
    private val onLost: (DiscoveredEndpoint) -> Unit,
    private val log: (String, String) -> Unit,
) {

    private class Sighting(var endpoint: DiscoveredEndpoint, var lastSeenMs: Long, var announcedMs: Long)

    private val sightings = LinkedHashMap<String, Sighting>()
    private var scanning = false
    private var serviceUuid: UUID? = null
    private var restartScheduled = false

    /**
     * How often the same peer may be re-announced while it sits there
     * advertising. A peer advertises ten times a second and the bridge turns
     * every announcement into a JavaScript event; throttling here keeps a
     * crowded room from becoming the thing that drops frames.
     */
    private val reannounceIntervalMs = 2_000L

    val isScanning: Boolean get() = scanning

    /** @throws Throwable one of [BleErrors] when the scan cannot be started at all. */
    fun start(service: UUID) {
        if (scanning && serviceUuid == service) return
        if (!availability.isRadioOn) throw BleErrors.radioOff()
        if (!availability.canScan) throw BleErrors.permissionDenied()

        val scanner = availability.adapter?.bluetoothLeScanner
            ?: throw BleErrors.failed("Bluetooth scanning is unavailable right now.")

        stop()
        serviceUuid = service

        val filters = listOf(
            ScanFilter.Builder().setServiceUuid(ParcelUuid(service)).build(),
        )

        val settings = ScanSettings.Builder()
            // Discovery happens while the user is looking at a "finding
            // people" screen, so latency beats battery for the seconds it
            // takes; the transport stops scanning as soon as it is told to.
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
            .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
            .setReportDelay(0)
            .apply {
                // setLegacy(false) means "report extended advertisements as
                // well as legacy ones". It is the superset and it is what we
                // want - but ONLY on a controller that supports extended
                // scanning. Asking for it on one that does not is a documented
                // way to get a scan that finds nothing at all, which is the
                // worst possible failure for this product because it looks
                // exactly like an empty room.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    availability.supportsExtendedAdvertising
                ) {
                    setLegacy(false)
                    setPhy(ScanSettings.PHY_LE_ALL_SUPPORTED)
                }
            }
            .build()

        try {
            scanner.startScan(filters, settings, callback)
        } catch (t: Throwable) {
            throw BleErrors.failed("Bluetooth scanning failed to start: ${t.javaClass.simpleName}")
        }

        scanning = true
        handler.postDelayed(sweep, BleTuning.PEER_SWEEP_INTERVAL_MS)
        log("info", "scanning for service $service")
    }

    fun stop() {
        handler.removeCallbacks(sweep)
        if (scanning) {
            try {
                availability.adapter?.bluetoothLeScanner?.stopScan(callback)
            } catch (t: Throwable) {
                log("debug", "stopScan threw ${t.javaClass.simpleName}; ignored")
            }
        }
        scanning = false
        sightings.clear()
    }

    /**
     * The signal strength last measured from this peer's advertisement, if we
     * have seen one.
     *
     * It is the only reading available for a link the peer opened to us: a GATT
     * *server* has no equivalent of `readRemoteRssi`, so an incoming link would
     * otherwise report a flat zero forever.
     */
    fun lastRssi(endpointId: String): Int? = sightings[endpointId]?.endpoint?.rssi

    /**
     * Folds better information into a peer we already know about.
     *
     * An Android advertisement has 31 bytes and an iPhone in the background
     * has none at all, so a display name is frequently missing from the air but
     * present in the identity characteristic. When a link reads it, discovery
     * gets to correct itself - the picker row that said "Unknown device"
     * becomes the person's name.
     */
    fun enrich(endpointId: String, name: String, token: ByteArray) {
        val existing = sightings[endpointId] ?: return
        val current = existing.endpoint
        val betterName = if (name.isNotEmpty()) name else current.name
        val betterToken =
            if (token.isNotEmpty()) Base64.encodeToString(token, Base64.NO_WRAP) else current.token
        if (betterName == current.name && betterToken == current.token) return
        existing.endpoint = DiscoveredEndpoint(
            transport = current.transport,
            endpointId = current.endpointId,
            name = betterName,
            token = betterToken,
            rssi = current.rssi,
        )
        existing.announcedMs = SystemClock.elapsedRealtime()
        onDiscovered(existing.endpoint)
    }

    // -- callbacks ------------------------------------------------------------

    private val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult?) {
            val safe = result ?: return
            // Scan results arrive on the framework's thread. Everything in this
            // transport happens on one handler thread, so it is handed over
            // before it touches any state.
            handler.post { ingest(safe) }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>?) {
            val safe = results?.toList() ?: return
            handler.post { safe.forEach { ingest(it) } }
        }

        override fun onScanFailed(errorCode: Int) {
            handler.post { failed(errorCode) }
        }
    }

    private fun ingest(result: ScanResult) {
        if (!scanning) return

        val device = result.device ?: return
        val address = try {
            device.address ?: return
        } catch (_: Throwable) {
            return
        }

        val record = result.scanRecord
        val blob = BleWire.decodeAdvertisement(
            try {
                record?.getManufacturerSpecificData(BleWire.MANUFACTURER_ID)
            } catch (_: Throwable) {
                null
            },
        )

        // Android peers put the opt-in name in our manufacturer blob; iOS peers
        // can only put it in the BLE local name. Look in both, prefer ours.
        val advertisedName = try {
            record?.deviceName.orEmpty()
        } catch (_: Throwable) {
            ""
        }
        val name = (if (blob.name.isNotEmpty()) blob.name else advertisedName)
            .take(BleWire.MAX_NAME_BYTES)

        val endpoint = DiscoveredEndpoint(
            transport = TransportKind.BLE,
            // The MAC address is a transport-scoped handle and nothing more.
            // Most modern peers advertise a resolvable private address that
            // rotates every fifteen minutes, so this is emphatically NOT an
            // identity - the cryptographic one only exists after the handshake,
            // two layers above this file.
            endpointId = address,
            name = name,
            token = if (blob.token.isEmpty()) {
                ""
            } else {
                Base64.encodeToString(blob.token, Base64.NO_WRAP)
            },
            rssi = result.rssi,
        )

        val now = SystemClock.elapsedRealtime()
        val existing = sightings[address]
        if (existing == null) {
            if (sightings.size >= BleTuning.MAX_TRACKED_PEERS) {
                // A hostile device can cycle its address as fast as it can
                // advertise. Drop the oldest rather than grow without bound;
                // it will be rediscovered on its next advertisement if it is
                // real.
                val oldest = sightings.keys.firstOrNull()
                if (oldest != null) sightings.remove(oldest)
            }
            sightings[address] = Sighting(endpoint, now, now)
            onDiscovered(endpoint)
            return
        }

        existing.lastSeenMs = now
        val changed = existing.endpoint.name != endpoint.name || existing.endpoint.token != endpoint.token
        existing.endpoint = endpoint
        if (changed || now - existing.announcedMs >= reannounceIntervalMs) {
            existing.announcedMs = now
            onDiscovered(endpoint)
        }
    }

    private val sweep = object : Runnable {
        override fun run() {
            if (!scanning) return
            val now = SystemClock.elapsedRealtime()
            val gone = sightings.entries
                .filter { now - it.value.lastSeenMs > BleTuning.PEER_LOST_TIMEOUT_MS }
                .map { it.key }
            gone.forEach { address ->
                val sighting = sightings.remove(address) ?: return@forEach
                onLost(sighting.endpoint)
            }
            handler.postDelayed(this, BleTuning.PEER_SWEEP_INTERVAL_MS)
        }
    }

    private fun failed(errorCode: Int) {
        scanning = false
        val detail = when (errorCode) {
            ScanCallback.SCAN_FAILED_ALREADY_STARTED -> "a scan is already running"
            ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "the app could not register a scanner"
            ScanCallback.SCAN_FAILED_INTERNAL_ERROR -> "the Bluetooth stack reported an internal error"
            ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED -> "this device does not support the requested scan"
            // Codes added in later releases (out of hardware resources, scanning
            // too frequently) are reported by number rather than referenced by
            // name, so this compiles and behaves the same on every API level.
            else -> "scan error $errorCode"
        }
        log("warn", "scan failed: $detail")

        val recoverable =
            errorCode == ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED ||
                errorCode == ScanCallback.SCAN_FAILED_INTERNAL_ERROR
        val service = serviceUuid
        if (!recoverable || service == null || restartScheduled) return

        // Android throttles an app to five scan starts in thirty seconds and
        // answers the sixth with a registration failure. Retrying immediately
        // would spend what is left of the budget and guarantee another failure,
        // so there is exactly one retry and it waits.
        restartScheduled = true
        handler.postDelayed({
            restartScheduled = false
            try {
                start(service)
            } catch (t: Throwable) {
                log("warn", "scan restart failed: ${t.message ?: t.javaClass.simpleName}")
            }
        }, BleTuning.SCAN_RESTART_DELAY_MS)
    }
}
