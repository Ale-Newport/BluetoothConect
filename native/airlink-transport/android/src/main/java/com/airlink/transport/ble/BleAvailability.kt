package com.airlink.transport.ble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import com.airlink.transport.Permissions
import com.airlink.transport.TransportAvailability
import com.airlink.transport.TransportKind
import com.airlink.transport.UnavailableReason

/**
 * Whether Bluetooth can carry a byte right now, and if not, exactly why.
 *
 * The value of this file is honesty. "Bluetooth unavailable" is useless to a
 * user standing in an aeroplane aisle; "AirLink needs permission to find nearby
 * devices" is a button they can press. Every path below therefore ends in a
 * reason the permission screen can act on, and none of them throws - a denied
 * permission is a reported state, never an exception escaping into JavaScript.
 */
@SuppressLint("MissingPermission")
internal class BleAvailability(context: Context) {

    private val appContext: Context = context.applicationContext

    /**
     * Set by the bridge if it wants to force "we have asked" for this session.
     *
     * Android cannot distinguish "denied" from "never asked" from a permission
     * check alone: `shouldShowRequestPermissionRationale` needs an Activity,
     * which this layer has none of, and it answers false both before the first
     * request and after "don't ask again". The durable answer lives in the
     * record [Permissions] writes just before each dialog goes up, and that is
     * what [permissionReason] reads. This flag only ever overrides it upwards,
     * for a caller that knows it has already prompted.
     */
    @Volatile
    var permissionsRequested: Boolean = false

    val manager: BluetoothManager? =
        try {
            appContext.getSystemService(BluetoothManager::class.java)
        } catch (_: Throwable) {
            null
        }

    val adapter: BluetoothAdapter?
        // Read every time rather than cached: `BluetoothAdapter.getDefaultAdapter`
        // is deprecated since API 31 in favour of exactly this, and the manager
        // hands back null on a device with the feature stripped out.
        get() = try {
            manager?.adapter
        } catch (_: Throwable) {
            null
        }

    val hasLowEnergyHardware: Boolean
        get() = try {
            appContext.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
        } catch (_: Throwable) {
            false
        }

    val isRadioOn: Boolean
        get() = try {
            adapter?.isEnabled == true
        } catch (_: Throwable) {
            false
        }

    /**
     * Whether this device can be a peripheral at all.
     *
     * Not every Android phone can advertise - the capability lives in the
     * controller, and a handful of budget chipsets are scan-only. A device that
     * cannot advertise is still a perfectly good AirLink central; it just needs
     * the peer to be the one being found, which is why this is reported to
     * JavaScript rather than treated as a failure.
     */
    val canAdvertise: Boolean
        // A BLOCK BODY, NOT `get() = try { ... }`. Kotlin forbids a `return`
        // inside an expression body ("returns are not allowed for functions with
        // expression body"); allowing it when the return type is written out
        // only arrives in Kotlin 2.3, and this module builds on 2.2. The early
        // exit below is what needs the block.
        get() {
            return try {
                val a = adapter ?: return false
                a.isMultipleAdvertisementSupported && a.bluetoothLeAdvertiser != null
            } catch (_: Throwable) {
                false
            }
        }

    val supportsL2cap: Boolean get() = L2cap.isSupported

    /**
     * Both of the queries below are API 26, as is every use their answers gate
     * (`setPreferredPhy`, the PHY-aware `connectGatt`, `ScanSettings.setPhy`).
     * This module's `minSdk` is resolved from the host project, which sets 24,
     * so the check is a runtime one rather than something the compiler has
     * already guaranteed - and reporting `false` on an older device is exactly
     * right: it means 1M PHY and a legacy scan, which is what those devices do.
     */
    private val hasApi26Radio: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O

    val supports2MPhy: Boolean
        get() = try {
            hasApi26Radio && adapter?.isLe2MPhySupported == true
        } catch (_: Throwable) {
            false
        }

    val supportsExtendedAdvertising: Boolean
        get() = try {
            hasApi26Radio && adapter?.isLeExtendedAdvertisingSupported == true
        } catch (_: Throwable) {
            false
        }

    // -- runtime permissions ---------------------------------------------------

    /**
     * The permissions this transport needs, which changed shape completely in
     * Android 12.
     *
     * Before API 31, BLUETOOTH and BLUETOOTH_ADMIN were install-time grants and
     * the *runtime* permission a BLE scan needed was ACCESS_FINE_LOCATION -
     * because a list of nearby beacons is a location fix, and the platform said
     * so. From API 31 the three Bluetooth permissions became runtime grants and
     * the location one is no longer needed, which is why the manifest declares
     * BLUETOOTH_SCAN with `neverForLocation`: AirLink never wants to know where
     * anybody is, and saying so in the manifest is what earns the exemption.
     */
    fun requiredPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            )
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    fun missingPermissions(): List<String> = requiredPermissions().filterNot { granted(it) }

    /** Scanning: BLUETOOTH_SCAN from API 31, ACCESS_FINE_LOCATION before it. */
    val canScan: Boolean
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            granted(Manifest.permission.BLUETOOTH_SCAN)
        } else {
            granted(Manifest.permission.ACCESS_FINE_LOCATION) && locationServicesOn
        }

    /** Advertising: BLUETOOTH_ADVERTISE from API 31, nothing at runtime before it. */
    val canAdvertisePermission: Boolean
        get() = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            granted(Manifest.permission.BLUETOOTH_ADVERTISE)

    /** Connecting, GATT server, L2CAP: BLUETOOTH_CONNECT from API 31. */
    val canConnect: Boolean
        get() = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            granted(Manifest.permission.BLUETOOTH_CONNECT)

    private fun granted(permission: String): Boolean =
        try {
            appContext.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        } catch (_: Throwable) {
            false
        }

    /**
     * On API 23 to 30 a BLE scan returns an empty list - with no error - unless
     * the device's location *services* are switched on, separately from the
     * permission. It is the single most confusing BLE failure on Android, and
     * it looks exactly like "nobody is nearby".
     */
    private val locationServicesOn: Boolean
        get() = try {
            val lm = appContext.getSystemService(LocationManager::class.java)
            when {
                lm == null -> false
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.P -> lm.isLocationEnabled
                else ->
                    lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                        lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
            }
        } catch (_: Throwable) {
            false
        }

    /**
     * Why a missing permission is missing, in the terms the permission screen
     * acts on: "never asked" gets a button that prompts, "denied" gets one that
     * opens Settings, and getting the two the wrong way round leaves the user
     * pressing a button that does nothing.
     *
     * The distinction is not derivable from the permission itself, so it comes
     * from [Permissions] - the shared matrix in the parent package, which
     * records each request in SharedPreferences before the dialog is shown so
     * the answer survives the process being killed with one on screen. Asking
     * it rather than duplicating the logic here is what keeps this transport's
     * answer identical to the one `getCapabilities` gives for the same
     * permissions a moment later.
     */
    private fun permissionReason(): UnavailableReason {
        if (permissionsRequested) return UnavailableReason.PERMISSION_DENIED
        val reason = Permissions.reasonFor(Permissions.transportState(appContext, null, TransportKind.BLE))
        // NONE would mean "granted", which contradicts the caller having found
        // a permission missing - a race with a grant landing mid-check. The
        // recoverable answer is the safe one either way.
        return if (reason == UnavailableReason.NONE) UnavailableReason.PERMISSION_NOT_REQUESTED else reason
    }

    // -- the answer -----------------------------------------------------------

    fun availability(): TransportAvailability {
        if (manager == null || adapter == null || !hasLowEnergyHardware) {
            return TransportAvailability(
                available = false,
                reason = UnavailableReason.UNSUPPORTED_HARDWARE,
                detail = "This device has no Bluetooth Low Energy radio.",
            )
        }

        // Permissions are checked before the radio state on purpose. From
        // Android 12 an app without BLUETOOTH_CONNECT cannot even ask the user
        // to switch Bluetooth on, so "grant permission" is genuinely the first
        // step; telling them to enable the radio first would be a dead end.
        val missing = missingPermissions()
        if (missing.isNotEmpty()) {
            return TransportAvailability(
                available = false,
                reason = permissionReason(),
                detail = "AirLink needs permission to find and connect to nearby devices.",
            )
        }

        if (!isRadioOn) {
            return TransportAvailability(
                available = false,
                reason = UnavailableReason.RADIO_OFF,
                detail = "Bluetooth is switched off.",
            )
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && !locationServicesOn) {
            // There is no `locationOff` reason in the shared vocabulary, and
            // inventing one would mean changing a frozen contract. `permissionDenied`
            // is the closer of the two available: it routes to the screen that
            // explains what to switch on, which `unknown` would not.
            return TransportAvailability(
                available = false,
                reason = UnavailableReason.PERMISSION_DENIED,
                detail = "Location must be switched on for Bluetooth scanning on Android 11 and earlier. " +
                    "AirLink never uses it to work out where you are.",
            )
        }

        return TransportAvailability(
            available = true,
            reason = UnavailableReason.NONE,
            detail = if (canAdvertise) {
                ""
            } else {
                "This device can find other phones but cannot be found by them, " +
                    "so the other person needs to start the connection."
            },
        )
    }
}
