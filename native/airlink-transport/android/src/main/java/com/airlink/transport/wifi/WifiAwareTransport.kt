package com.airlink.transport.wifi

import android.content.Context
import android.content.pm.PackageManager
import com.airlink.transport.AirLinkError
import com.airlink.transport.AirLinkTransport
import com.airlink.transport.Availability
import com.airlink.transport.LinkMetricsSnapshot
import com.airlink.transport.TransportConfiguration
import com.airlink.transport.TransportEventSink
import com.airlink.transport.TransportKind
import com.airlink.transport.UnavailableReason

/**
 * Wi-Fi Aware: a capability adapter, deliberately not a transport.
 *
 * This class exists so the identifier stays in the vocabulary and the
 * capability screen can say something true about it. It never opens a radio,
 * never discovers anything and never carries a byte. Every operation reports
 * unsupported rather than pretending, which is the whole point: an offline app
 * that says "not available" is far better than one that offers a path and then
 * silently fails to connect.
 *
 * The full reasoning - hardware that most handsets do not have, iOS interop
 * that does not work in practice, and nothing to gain over the transports we
 * already ship - is in WifiAwareNotes.kt, next to this file. Read that before
 * deciding to implement it; it is the record of a decision, not an oversight.
 *
 * If the interop story ever changes, this file is the only one that has to
 * change: the framing in FramedTcp applies unchanged to an Aware socket,
 * because it is the same TCP-shaped byte stream as everything else here.
 */
class WifiAwareTransport(private val context: Context) : AirLinkTransport {

    override val kind: TransportKind = TransportKind.WIFI_AWARE
    override var events: TransportEventSink? = null

    /**
     * Unavailable in both directions, and honest about which one.
     *
     * On hardware without the feature this is a fact about the device. On
     * hardware with it, it is a decision we made: Android-to-iPhone Aware fails
     * on mainstream handsets, and Android-to-Android is already served by
     * Wi-Fi Direct at the same speed with none of the pairing ceremony.
     */
    override fun availability(): Availability {
        val hasHardware = try {
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)
        } catch (_: Throwable) {
            false
        }
        return Availability(
            available = false,
            reason = UnavailableReason.UNSUPPORTED_HARDWARE,
            detail = if (hasHardware) {
                "This device has Wi-Fi Aware hardware, but Wi-Fi Aware does not work reliably " +
                    "between Android phones and iPhones, so AirLink does not use it."
            } else {
                "This device does not support Wi-Fi Aware, and most phones do not."
            },
        )
    }

    /**
     * A no-op rather than a throw. The module starts every transport it built
     * and logs the ones that fail; a transport that is unavailable by design is
     * not a failure, and a warning on every launch would be noise that hides a
     * real one.
     */
    override fun start(configuration: TransportConfiguration) = Unit

    override fun stop() = Unit

    override fun startAdvertising(token: ByteArray, displayName: String): Unit =
        throw AirLinkError.Unsupported("Wi-Fi Aware")

    override fun stopAdvertising() = Unit

    override fun startDiscovery(): Unit = throw AirLinkError.Unsupported("Wi-Fi Aware")

    override fun stopDiscovery() = Unit

    override fun connect(endpointId: String, timeoutMs: Int, completion: (Result<String>) -> Unit) {
        completion(Result.failure(AirLinkError.Unsupported("Wi-Fi Aware")))
    }

    override fun disconnect(linkId: String, reason: String) = Unit

    override fun send(linkId: String, data: ByteArray, reliable: Boolean, completion: (Result<Unit>) -> Unit) {
        completion(Result.failure(AirLinkError.Unsupported("Wi-Fi Aware")))
    }

    override fun metrics(linkId: String): LinkMetricsSnapshot? = null
}
