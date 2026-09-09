package com.airlink.transport

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.facebook.react.modules.core.PermissionAwareActivity

/**
 * The Android runtime-permission matrix, in one place, because this is where
 * apps like this one usually break.
 *
 * THE MATRIX
 *
 * | OS                  | Bluetooth                                          | Wi-Fi Direct / Aware / hotspot |
 * |---------------------|----------------------------------------------------|--------------------------------|
 * | API 26-30           | ACCESS_FINE_LOCATION (runtime)                     | ACCESS_FINE_LOCATION           |
 * | API 31-32           | BLUETOOTH_SCAN / _ADVERTISE / _CONNECT             | ACCESS_FINE_LOCATION           |
 * | API 33+             | BLUETOOTH_SCAN / _ADVERTISE / _CONNECT             | NEARBY_WIFI_DEVICES            |
 *
 * BLUETOOTH and BLUETOOTH_ADMIN are deliberately absent: they are install-time
 * ("normal") permissions, granted the moment the app is installed on API 30 and
 * below and gone entirely from API 31. There is nothing to request at runtime,
 * so asking for them would produce a dialog that never appears and a "denied"
 * that never resolves. The manifest declares them; this file does not.
 *
 * ACCESS_FINE_LOCATION on API 26-30 is a genuine Android requirement for BLE
 * scanning and for nothing else - AirLink never asks the OS where the phone is.
 * From API 31 the `neverForLocation` flag on BLUETOOTH_SCAN says that in a form
 * the system enforces, and the location prompt disappears.
 *
 * THE API 31-32 WI-FI GAP, stated plainly because the product must not promise
 * past it. The manifest caps ACCESS_FINE_LOCATION at `maxSdkVersion="30"`, and
 * NEARBY_WIFI_DEVICES only exists from API 33. On API 31 and 32 there is
 * therefore no permission this build can hold that unlocks Wi-Fi Direct, Wi-Fi
 * Aware or the local-only hotspot, and [state] reports that honestly as
 * [State.NOT_DECLARED] rather than looping the user through a dialog that will
 * never be shown. The trade was deliberate: raising the cap to 32 would put a
 * location prompt in front of every user on those two OS versions - including
 * the overwhelming majority who only ever use Bluetooth - to buy a Wi-Fi
 * upgrade on two OS versions. BLE, the floor everything works on, is unaffected.
 *
 * "NOT ASKED YET" VERSUS "DENIED FOREVER". Android gives no API for this.
 * `shouldShowRequestPermissionRationale` returns false both before the first
 * request and after the user has chosen "don't ask again", so the only way to
 * tell them apart is to remember that we asked. That is what the tiny
 * SharedPreferences record below is for, and it is why [markRequested] must be
 * called before the dialog goes up, not after the answer comes back - the
 * process can die while a dialog is on screen.
 */
internal object Permissions {

    private const val TAG = "AirLinkPermissions"

    private const val PREFS_NAME = "com.airlink.transport.permissions"
    private const val KEY_REQUESTED = "requested"

    /** What the OS currently thinks of one permission. */
    enum class State {
        /** Held. */
        GRANTED,

        /** Never put in front of the user. Asking will show a dialog. */
        NOT_REQUESTED,

        /** Refused once. Asking again will show the dialog again. */
        DENIED,

        /** "Don't ask again". Only the system settings page can change this. */
        DENIED_PERMANENTLY,

        /**
         * Not in the merged manifest on this OS version, so it can never be
         * granted. Neither a dialog nor the settings page can fix it - only a
         * different build can. See the API 31-32 Wi-Fi gap above.
         */
        NOT_DECLARED,
    }

    /**
     * The runtime permissions [kind] needs on THIS device. Empty means the
     * transport needs nothing beyond what the install already granted.
     */
    fun runtimePermissions(kind: TransportKind): List<String> = when (kind) {
        TransportKind.BLE ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                listOf(
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_ADVERTISE,
                    Manifest.permission.BLUETOOTH_CONNECT,
                )
            } else {
                // The one place AirLink ever touches a location permission, and
                // only because Android 11 and earlier will not scan without it.
                listOf(Manifest.permission.ACCESS_FINE_LOCATION)
            }

        TransportKind.WIFI_DIRECT, TransportKind.WIFI_AWARE -> wifiPermissions()

        // NSD plus a TCP socket over a network the user is already on needs no
        // dangerous permission at all. Android has no equivalent of the iOS
        // local-network prompt.
        TransportKind.LOCAL_NETWORK -> emptyList()

        // Apple-only. Nothing to ask for because there is nothing to use.
        TransportKind.PEER_TO_PEER_WIFI -> emptyList()
    }

    /**
     * What `WifiManager.startLocalOnlyHotspot` needs. Identical to Wi-Fi Direct
     * today, but named separately because the hotspot is not a transport and
     * the two could diverge in a future OS.
     */
    fun hotspotPermissions(): List<String> = wifiPermissions()

    private fun wifiPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            listOf(Manifest.permission.NEARBY_WIFI_DEVICES)
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    /**
     * POST_NOTIFICATIONS, needed from API 33 for the foreground-service
     * notification to be VISIBLE. Kept out of [runtimePermissions] on purpose:
     * a session still runs without it, so tying it to a transport would put an
     * unrelated dialog in front of a user who only wanted to turn Bluetooth on.
     * The app asks for it at the moment it explains the ongoing notification.
     */
    fun notificationPermission(): String? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.POST_NOTIFICATIONS
        } else {
            null
        }

    /**
     * The state of one permission.
     *
     * [activity] is only needed to tell [State.DENIED] from
     * [State.DENIED_PERMANENTLY]; with no activity attached we report the
     * recoverable one, because claiming a permission is permanently lost when
     * we cannot actually check would send the user to Settings for nothing.
     */
    fun state(
        context: Context,
        activity: PermissionAwareActivity?,
        permission: String,
    ): State {
        if (isGranted(context, permission)) return State.GRANTED
        if (!isDeclared(context, permission)) return State.NOT_DECLARED
        if (!wasRequested(context, permission)) return State.NOT_REQUESTED

        val canAskAgain = try {
            activity?.shouldShowRequestPermissionRationale(permission)
        } catch (t: Throwable) {
            // The activity can go away between the null check and the call.
            Log.w(TAG, "shouldShowRequestPermissionRationale failed for $permission", t)
            null
        }
        return when (canAskAgain) {
            true -> State.DENIED
            false -> State.DENIED_PERMANENTLY
            null -> State.DENIED
        }
    }

    /** The worst state across everything [kind] needs. GRANTED when it needs nothing. */
    fun transportState(
        context: Context,
        activity: PermissionAwareActivity?,
        kind: TransportKind,
    ): State {
        val required = runtimePermissions(kind)
        if (required.isEmpty()) return State.GRANTED

        var worst = State.GRANTED
        for (permission in required) {
            val state = state(context, activity, permission)
            if (severity(state) > severity(worst)) worst = state
        }
        return worst
    }

    /**
     * Ordered so "the user can still fix this" always loses to "the user
     * cannot", which is what the permission screen needs to decide whether to
     * offer a button or an explanation.
     */
    private fun severity(state: State): Int = when (state) {
        State.GRANTED -> 0
        State.NOT_REQUESTED -> 1
        State.DENIED -> 2
        State.DENIED_PERMANENTLY -> 3
        State.NOT_DECLARED -> 4
    }

    fun isGranted(context: Context, permission: String): Boolean =
        try {
            context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        } catch (t: Throwable) {
            // Cannot happen in practice, but a permission check that throws must
            // not be the thing that kills an offline app.
            Log.w(TAG, "checkSelfPermission failed for $permission", t)
            false
        }

    /** True when the merged manifest actually declares [permission] on this OS. */
    fun isDeclared(context: Context, permission: String): Boolean =
        declaredPermissions(context).contains(permission)

    private fun declaredPermissions(context: Context): Set<String> {
        cachedDeclared?.let { return it }
        val declared = try {
            val pm = context.packageManager
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()),
                )
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            }
            info.requestedPermissions?.toSet() ?: emptySet()
        } catch (t: Throwable) {
            Log.w(TAG, "could not read the manifest permission list", t)
            // Assume everything is declared rather than reporting a device as
            // broken: the checkSelfPermission result is still authoritative.
            null
        }
        // A manifest cannot change without the process restarting, so one read
        // is enough - and this is on the getCapabilities path, which the
        // permission screen polls.
        if (declared != null) cachedDeclared = declared
        return declared ?: FALLBACK_DECLARED
    }

    @Volatile
    private var cachedDeclared: Set<String>? = null

    /**
     * Used only when the manifest could not be read at all. Contains every
     * permission this library ever asks for, so an unreadable manifest degrades
     * to "ask and find out" rather than to "give up".
     */
    private val FALLBACK_DECLARED: Set<String> = buildSet {
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        add(Manifest.permission.BLUETOOTH_SCAN)
        add(Manifest.permission.BLUETOOTH_ADVERTISE)
        add(Manifest.permission.BLUETOOTH_CONNECT)
        add(Manifest.permission.NEARBY_WIFI_DEVICES)
        add(Manifest.permission.POST_NOTIFICATIONS)
    }

    /**
     * Record that these permissions have been put in front of the user. Call
     * BEFORE showing the dialog: the process can be killed while a system
     * dialog is on screen, and a forgotten request would then read as "never
     * asked" forever.
     */
    fun markRequested(context: Context, permissions: Collection<String>) {
        if (permissions.isEmpty()) return
        try {
            val prefs = prefs(context)
            val updated = prefs.getStringSet(KEY_REQUESTED, emptySet()).orEmpty() + permissions
            prefs.edit().putStringSet(KEY_REQUESTED, updated).apply()
        } catch (t: Throwable) {
            // Losing this record only costs us the ability to say "denied
            // permanently"; it must never cost us the permission request.
            Log.w(TAG, "could not record the permission request", t)
        }
    }

    private fun wasRequested(context: Context, permission: String): Boolean =
        try {
            prefs(context).getStringSet(KEY_REQUESTED, emptySet()).orEmpty().contains(permission)
        } catch (t: Throwable) {
            Log.w(TAG, "could not read the permission record", t)
            false
        }

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** The reason to report for a transport whose permissions are not held. */
    fun reasonFor(state: State): UnavailableReason = when (state) {
        State.GRANTED -> UnavailableReason.NONE
        State.NOT_REQUESTED -> UnavailableReason.PERMISSION_NOT_REQUESTED
        State.DENIED, State.DENIED_PERMANENTLY -> UnavailableReason.PERMISSION_DENIED
        // Not a permission problem the user can act on - it is an OS version
        // problem, and saying so is the only honest answer.
        State.NOT_DECLARED -> UnavailableReason.UNSUPPORTED_OS_VERSION
    }
}
