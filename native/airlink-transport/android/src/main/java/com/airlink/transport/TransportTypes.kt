package com.airlink.transport

import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap

/**
 * Shared vocabulary for the Android transports.
 *
 * These strings and shapes mirror the TypeScript spec in
 * `src/NativeAirLinkTransport.ts` and the Swift vocabulary in
 * `ios/Transport/AirLinkTypes.swift` exactly. Where a value crosses the bridge
 * it is built here, so there is one place to look when the three sides
 * disagree.
 *
 * Nothing in this file knows anything about the AirLink protocol. A transport
 * discovers endpoints, opens links, moves opaque datagrams and reports state.
 * Encryption, sequencing, retries, fragmentation and sessions all live in
 * TypeScript, which is why the whole protocol can be tested in Node without a
 * radio.
 */

/**
 * The transports this project knows about. The `id` strings are the wire values
 * shared with `TransportKind` in @airlink/core; nothing else may be sent across
 * the bridge.
 */
enum class TransportKind(val id: String) {
    /** Bluetooth Low Energy. Universal, slow, the floor everything must work on. */
    BLE("ble"),

    /** NSD (Bonjour) + TCP over a Wi-Fi network both peers already share. */
    LOCAL_NETWORK("localNetwork"),

    /**
     * Apple peer-to-peer Wi-Fi (AWDL). Declared so the two platforms speak the
     * same vocabulary; there is no Android implementation and there cannot be
     * one. Android-to-Android uses [WIFI_DIRECT] instead.
     */
    PEER_TO_PEER_WIFI("peerToPeerWifi"),

    /** Wi-Fi Direct. Android to Android only. */
    WIFI_DIRECT("wifiDirect"),

    /** Wi-Fi Aware / NAN. Absent from most hardware and no use for iOS interop. */
    WIFI_AWARE("wifiAware");

    companion object {
        fun fromId(id: String): TransportKind? = entries.firstOrNull { it.id == id }
    }
}

/**
 * Why a transport cannot currently be used. Drives the permission screen, so
 * the distinction between "never asked" and "denied" is load bearing: only one
 * of them can be fixed by asking again.
 */
enum class UnavailableReason(val id: String) {
    /** Not a reason at all - the transport is available. */
    NONE(""),
    UNSUPPORTED_HARDWARE("unsupportedHardware"),
    UNSUPPORTED_OS_VERSION("unsupportedOsVersion"),
    PERMISSION_DENIED("permissionDenied"),
    PERMISSION_NOT_REQUESTED("permissionNotRequested"),
    RADIO_OFF("radioOff"),
    NO_LOCAL_NETWORK("noLocalNetwork"),
    UNKNOWN("unknown"),
}

/** The lifecycle of one link, as reported to JavaScript. */
enum class LinkState(val id: String) {
    CONNECTING("connecting"),
    CONNECTED("connected"),
    CLOSING("closing"),
    CLOSED("closed"),
    FAILED("failed"),
}

/** Whether a transport can be used right now, and if not, why. */
data class TransportAvailability(
    val available: Boolean,
    val reason: UnavailableReason = if (available) UnavailableReason.NONE else UnavailableReason.UNKNOWN,
    /**
     * Human-readable detail shown on the permission screen. English only: this
     * library ships no resources, so a host app that needs other languages maps
     * [reason] to its own string rather than showing this.
     */
    val detail: String = "",
)

/**
 * The same type under a shorter name.
 *
 * Both spellings are in use across the radio packages, and an alias costs
 * nothing while a rename would touch several hundred lines of working transport
 * code for no behavioural gain. They are the same class: `Availability(...)`
 * constructs a [TransportAvailability] and the two are assignable in both
 * directions.
 */
typealias Availability = TransportAvailability

/**
 * A peer seen by a transport, before any session exists.
 *
 * [endpointId] is a transport-scoped handle, NOT an identity: a BLE address
 * rotates, a Wi-Fi Direct address differs per radio. The cryptographic peer id
 * only exists after the handshake, which happens in TypeScript.
 */
data class DiscoveredEndpoint(
    val transport: TransportKind,
    val endpointId: String,
    /** Advertised name if the transport carries one. Untrusted, may be "". */
    val name: String,
    /** Base64 of the rotating advertisement token, or "" when absent. */
    val token: String,
    /** dBm, or 0 when the transport does not report signal strength. */
    val rssi: Int,
) {
    /** The `NativeDiscoveredPeer` payload, built in exactly one place. */
    fun toMap(): WritableMap = Arguments.createMap().apply {
        putString("transport", transport.id)
        putString("endpointId", endpointId)
        putString("name", name)
        putString("token", token)
        putInt("rssi", rssi)
    }
}

/**
 * Live quality numbers for one link. Surfaced raw only in Developer Mode.
 *
 * The counters are per link and reset when the link is replaced; the layer
 * above keeps the durable statistics, because it is the layer that survives a
 * link being swapped from Bluetooth to Wi-Fi mid-conversation.
 */
data class LinkMetricsSnapshot(
    val maxDatagramSize: Int = 0,
    val rssi: Int = 0,
    val packetsSent: Int = 0,
    val packetsReceived: Int = 0,
    val packetsDropped: Int = 0,
    val bytesSent: Double = 0.0,
    val bytesReceived: Double = 0.0,
    /** Estimated throughput in bytes per second, or 0 when unknown. */
    val throughput: Double = 0.0,
)

/**
 * Errors surfaced to JavaScript. [code] is what the promise rejects with, and
 * it is stable: the TypeScript side switches on it, so these strings are part
 * of the contract and match the iOS `AirLinkError` codes one for one.
 */
sealed class AirLinkError(val code: String, message: String) : Exception(message) {

    class NotStarted :
        AirLinkError("not_started", "The AirLink transport has not been started.")

    class Unsupported(what: String) :
        AirLinkError("unsupported", "$what is not supported on this device.")

    class RadioOff(kind: TransportKind) :
        AirLinkError("radio_off", "The radio for ${kind.id} is switched off.")

    class PermissionDenied(kind: TransportKind) :
        AirLinkError("permission_denied", "Permission for ${kind.id} was not granted.")

    class UnknownLink(id: String) :
        AirLinkError("unknown_link", "No such link: $id.")

    class UnknownEndpoint(id: String) :
        AirLinkError("unknown_endpoint", "No such endpoint: $id.")

    class PayloadTooLarge(size: Int, limit: Int) :
        AirLinkError("payload_too_large", "Datagram of $size bytes exceeds the link limit of $limit.")

    class Timeout(what: String) :
        AirLinkError("timeout", "Timed out: $what.")

    /**
     * Two callers asked for the same one-at-a-time resource. The only one today
     * is the OS permission dialog, which cannot be stacked.
     */
    class Busy(what: String) :
        AirLinkError("busy", "$what is already in progress.")

    class Failed(detail: String) :
        AirLinkError("failed", detail)
}

/** Configuration handed down from the protocol layer at `start()`. */
data class TransportConfiguration(
    val serviceUuid: String,
    val rxCharacteristicUuid: String,
    val txCharacteristicUuid: String,
    val bonjourServiceType: String,
)

/**
 * What every Android transport implements.
 *
 * Deliberately narrow: discover, connect, move opaque datagrams, report state.
 *
 * THREADING CONTRACT, and it matters. Every method here is called from the
 * module's single transport thread and **must return promptly without
 * blocking** - no socket reads, no `join()`, no waiting on a GATT callback.
 * Work that takes time belongs on the transport's own thread or executor, with
 * the answer delivered through the completion lambda or through
 * [TransportEventSink]. One transport that blocks stalls every other transport,
 * because they all share that thread.
 *
 * Any method may throw [AirLinkError]; the module turns it into a promise
 * rejection with a stable code. Throwing anything else is a bug, but the module
 * catches that too rather than letting the app die.
 *
 * CONSTRUCTION. The module builds each transport with a single `Context`
 * argument - the application context, never an Activity - and then sets
 * [events]. Keep the constructor cheap and side-effect free: nothing may touch
 * a radio before `start()`.
 */
interface AirLinkTransport {
    val kind: TransportKind

    /** Set by the module immediately after construction. */
    var events: TransportEventSink?

    /** Whether this transport can be used right now, and if not, why. */
    fun availability(): TransportAvailability

    fun start(configuration: TransportConfiguration)

    /** Stop everything and release every resource. May be called again after. */
    fun stop()

    /**
     * @param token the rotating advertisement token, already decoded from base64
     * @param displayName included only when the user opted in; "" otherwise
     */
    fun startAdvertising(token: ByteArray, displayName: String)
    fun stopAdvertising()

    fun startDiscovery()
    fun stopDiscovery()

    /**
     * Open a link. Calls back exactly once with the new link id, or an error.
     * The transport is responsible for honouring [timeoutMs]; the module keeps
     * its own watchdog anyway, because a transport that never calls back would
     * otherwise hang a JavaScript promise forever.
     */
    fun connect(endpointId: String, timeoutMs: Int, completion: (Result<String>) -> Unit)

    /** Idempotent. Must eventually produce a `closed` (or `failed`) link state. */
    fun disconnect(linkId: String, reason: String)

    /**
     * Send exactly one datagram.
     *
     * Calls back exactly once, when the transport has accepted the bytes for
     * transmission - NOT when the peer has them. A send of N bytes must arrive
     * at the peer as one receive of the same N bytes or not at all: never split,
     * never coalesced, never truncated. Stream transports add their own length
     * framing to make that true.
     *
     * @param reliable false selects a best-effort path where the transport has
     *   one (BLE write-without-response), which the realtime game channel uses.
     */
    fun send(linkId: String, data: ByteArray, reliable: Boolean, completion: (Result<Unit>) -> Unit)

    /** Null when this transport does not own [linkId]. */
    fun metrics(linkId: String): LinkMetricsSnapshot?
}

/**
 * How a transport reports back. Implemented by [AirLinkTransportModule].
 *
 * Every method may be called from any thread; the module hops each one onto its
 * own serial thread before touching state or emitting, so a transport never has
 * to think about it. That hop is also what guarantees the contract that no
 * callback is delivered re-entrantly from inside a `send` call.
 *
 * Call [linkOpened] before the first [received] for a link, and [linkState]
 * with [LinkState.CLOSED] or [LinkState.FAILED] exactly once when it ends -
 * including when the radio is switched off underneath it. A link that vanishes
 * without a state event leaks a session on the JavaScript side.
 */
interface TransportEventSink {
    fun peerDiscovered(endpoint: DiscoveredEndpoint)
    fun peerLost(endpoint: DiscoveredEndpoint)

    fun linkOpened(
        linkId: String,
        transport: TransportKind,
        endpointId: String,
        maxDatagramSize: Int,
        highBandwidth: Boolean,
        incoming: Boolean,
    )

    fun linkState(linkId: String, state: LinkState, reason: String)

    fun received(linkId: String, data: ByteArray)

    fun mtuChanged(linkId: String, maxDatagramSize: Int)

    fun availabilityChanged(transport: TransportKind, available: Boolean, reason: UnavailableReason)

    /** Diagnostic line, surfaced in Developer Mode. Level is one of debug/info/warn/error. */
    fun log(level: String, scope: String, message: String)
}

/*
 * THE LOCAL-ONLY HOTSPOT is deliberately NOT part of this vocabulary. It is not
 * a transport - it moves no datagrams - it is a `WifiManager` reservation whose
 * only output is a pair of credentials, so it lives with the Wi-Fi code in
 * `wifi/HotspotHost.kt` and the module talks to that class directly.
 *
 * Why it exists at all: an Android app can START a hotspot
 * (`WifiManager.startLocalOnlyHotspot`) but cannot silently join one; an iOS app
 * can JOIN one (`NEHotspotConfiguration`) but cannot start one. That asymmetry
 * is exactly why the only high-bandwidth cross-platform path with no network
 * present has Android hosting and the iPhone joining.
 */

/**
 * How the module constructs a transport: one application `Context` in, one
 * transport out. Kept as an alias so the registry reads as one line per radio.
 */
internal typealias TransportFactory = (Context) -> AirLinkTransport
