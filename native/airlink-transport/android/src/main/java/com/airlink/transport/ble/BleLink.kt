package com.airlink.transport.ble

import android.bluetooth.BluetoothDevice
import android.os.Handler
import android.os.SystemClock
import com.airlink.transport.LinkMetricsSnapshot
import com.airlink.transport.LinkState
import java.util.ArrayDeque

/**
 * One way of getting a datagram onto the radio.
 *
 * Three implement it: a GATT characteristic write (we are the central), a GATT
 * notification (we are the peripheral), and an L2CAP channel (either role,
 * after an upgrade). The link does not care which it has - it only cares that
 * `send` calls `onDone` exactly once, on the transport's handler thread, and
 * that it does not accept a second datagram before it has.
 */
internal interface DatagramSender {
    /** Largest single datagram this path accepts right now, in bytes. */
    val maxDatagramSize: Int

    /** A one-word name for logs and metrics: "gatt-write", "gatt-notify", "l2cap". */
    val label: String

    /**
     * Hands exactly one datagram to the radio. `onDone(null)` means the radio
     * accepted it - NOT that the peer has it, which is the reliability layer's
     * business one storey up.
     */
    fun send(datagram: ByteArray, reliable: Boolean, onDone: (Throwable?) -> Unit)

    /** Releases whatever the path owns. Idempotent. */
    fun close()
}

/**
 * How a link reports upwards. Implemented by [BleTransport], which turns these
 * into the events the TurboModule emits.
 */
internal interface BleLinkHost {
    val handler: Handler

    fun onLinkOpened(link: BleLink)
    fun onLinkState(link: BleLink, state: LinkState, reason: String)
    fun onLinkData(link: BleLink, data: ByteArray)
    fun onLinkDatagramSizeChanged(link: BleLink, maxDatagramSize: Int)

    /** The link is finished and can be forgotten. Always follows a `closed` state. */
    fun onLinkRetired(link: BleLink)

    fun log(level: String, message: String)
}

/**
 * One established BLE connection to one peer, presented as an ordered stream of
 * whole datagrams.
 *
 * Deliberately dumb, exactly like the `Link` interface it ends up behind in
 * TypeScript: no encryption, no sequencing, no retries, no reconnection. It
 * owns three things and nothing else - the send queue, the metrics, and the
 * promise that the state machine ends in `closed` exactly once.
 *
 * THREADING. Every method must be called on [BleLinkHost.handler]'s thread, and
 * every callback is invoked on it. `BleTransport.send` posts onto that thread
 * before touching a link, which is what makes the contract's "callbacks are
 * never delivered re-entrantly from inside a send call" true by construction
 * rather than by inspection.
 */
internal class BleLink(
    val id: String,
    val endpointId: String,
    val device: BluetoothDevice,
    /** True when the peer opened this link to us rather than the other way round. */
    val incoming: Boolean,
    private val host: BleLinkHost,
) {

    private class Outbound(
        val bytes: ByteArray,
        val reliable: Boolean,
        val completion: (Throwable?) -> Unit,
    )

    var state: LinkState = LinkState.CONNECTING
        private set

    private var sender: DatagramSender? = null
    private val outbound = ArrayDeque<Outbound>()
    private var sending = false
    private var openedEmitted = false
    private var closedEmitted = false

    /** Last reported datagram size, so a change is only announced when it is one. */
    private var announcedDatagramSize = 0

    // Metrics. Written only on the handler thread; volatile so `metrics()` can
    // read them from the bridge's thread without a lock on the hot path.
    @Volatile private var packetsSent: Int = 0
    @Volatile private var packetsReceived: Int = 0
    @Volatile private var packetsDropped: Int = 0
    @Volatile private var bytesSent: Long = 0
    @Volatile private var bytesReceived: Long = 0
    @Volatile private var rssi: Int = 0
    @Volatile private var windowStartMs: Long = SystemClock.elapsedRealtime()
    @Volatile private var windowBytes: Long = 0
    @Volatile private var lastRate: Double = 0.0

    /** When the RSSI was last refreshed, so a metrics poll cannot stall a transfer. */
    var rssiReadAtMs: Long = 0

    val isOpen: Boolean get() = state == LinkState.CONNECTED

    val maxDatagramSize: Int get() = sender?.maxDatagramSize ?: 0

    /**
     * BLE is never a high-bandwidth transport, and this reports `false` even
     * after an L2CAP upgrade.
     *
     * L2CAP is several times faster than GATT, which is worth having - but the
     * honest ceiling is still tens of kilobytes per second, and the flag is
     * what the layer above uses to decide whether it may offer a photo or a
     * video at a usable rate. Saying "yes" here would put a ten-minute progress
     * bar in front of a user who was promised a quick one.
     */
    val highBandwidth: Boolean get() = false

    // -- lifecycle ------------------------------------------------------------

    /**
     * Attaches the path datagrams will travel over. Called once, before the
     * link opens: the send path is fixed for the life of a link.
     *
     * That is a deliberate limitation. Switching a live link from GATT to
     * L2CAP mid-stream would mean datagrams in flight on the old path racing
     * datagrams on the new one, and "reliable sends arrive in order" would stop
     * being true - and the native layer is not allowed to invent the handshake
     * that would fix it, because the native layer holds no protocol knowledge.
     * So the L2CAP upgrade is attempted *before* the link is reported open, and
     * a link that opened on GATT stays on GATT until it closes.
     */
    fun attach(sender: DatagramSender) {
        this.sender = sender
    }

    /** Reports the link open. Idempotent; only the first call is announced. */
    fun markOpen() {
        if (openedEmitted || closedEmitted) return
        openedEmitted = true
        state = LinkState.CONNECTED
        announcedDatagramSize = maxDatagramSize
        host.onLinkOpened(this)
        host.onLinkState(this, LinkState.CONNECTED, "")
    }

    /**
     * Announces a change in the usable datagram size - in practice, the ATT MTU
     * exchange landing after the link opened rather than before it. Silent when
     * nothing changed.
     */
    fun refreshDatagramSize() {
        val size = maxDatagramSize
        if (size <= 0 || size == announcedDatagramSize) return
        announcedDatagramSize = size
        if (openedEmitted && !closedEmitted) {
            host.onLinkDatagramSizeChanged(this, size)
        }
    }

    /**
     * Ends the link. Idempotent, and guaranteed to produce exactly one `closed`
     * state event however many times, and from however many directions, it is
     * called - the peer hanging up, the radio being switched off, `stop()`, and
     * an explicit `disconnect()` all land here.
     */
    fun close(reason: String, failed: Boolean = false) {
        if (closedEmitted) return
        closedEmitted = true

        if (state != LinkState.CLOSING) {
            state = LinkState.CLOSING
            host.onLinkState(this, LinkState.CLOSING, reason)
        }

        // Fail the backlog before tearing the path down, so every caller of
        // send() gets its completion exactly once and nobody is left waiting on
        // a promise that can no longer resolve.
        val cause = BleErrors.failed("link $id closed: $reason")
        while (true) {
            val queued = outbound.pollFirst() ?: break
            complete(queued, cause)
        }
        sending = false

        try {
            sender?.close()
        } catch (t: Throwable) {
            host.log("warn", "closing the send path for $id threw ${t.javaClass.simpleName}")
        }
        sender = null

        state = if (failed) LinkState.FAILED else LinkState.CLOSED
        // A failed link still reports `closed` afterwards: the contract says
        // close() always eventually produces a closed state, and the state
        // machine above treats `failed` as extra colour, not as a terminal it
        // has to special-case.
        if (failed) host.onLinkState(this, LinkState.FAILED, reason)
        host.onLinkState(this, LinkState.CLOSED, reason)
        host.onLinkRetired(this)
    }

    // -- sending --------------------------------------------------------------

    /**
     * Queues exactly one datagram.
     *
     * Fails - loudly, never truncating - when the link is not open, when the
     * datagram is larger than the negotiated maximum, or when the backlog is
     * full. That last case is backpressure, not an error in the usual sense:
     * the reliability layer holds the datagram and tries again, which is
     * strictly better than this layer buffering until the process dies.
     */
    fun enqueue(bytes: ByteArray, reliable: Boolean, completion: (Throwable?) -> Unit) {
        val path = sender
        if (!isOpen || path == null) {
            completion(BleErrors.failed("link $id is not connected"))
            return
        }
        if (bytes.isEmpty()) {
            // Not a datagram. Rejected rather than sent, because an empty ATT
            // write is indistinguishable from several other things on the wire
            // and the layer above never has a reason to send one.
            completion(BleErrors.failed("a datagram must not be empty"))
            return
        }
        val limit = path.maxDatagramSize
        if (bytes.size > limit) {
            completion(BleErrors.payloadTooLarge(bytes.size, limit))
            return
        }

        if (!reliable) {
            if (outbound.size >= BleTuning.MAX_REALTIME_QUEUE_DEPTH) {
                // Best-effort by definition: newer game state supersedes what is
                // waiting, so something has to go. It must be a BEST-EFFORT
                // datagram, never a reliable one - the two share this queue, and
                // discarding a reliable datagram while reporting it sent would
                // break the contract's "reliable sends arrive in order and
                // without duplication; loss is signalled, never silent" in the
                // worst possible way: as a message that vanishes while its
                // sender is told it was sent.
                val victim = removeOldestRealtime()
                packetsDropped++
                if (victim != null) {
                    // Reported as success because for this channel that is what
                    // happened; rejecting it would make the caller retry state
                    // that is already stale.
                    complete(victim, null)
                } else {
                    // The backlog is entirely reliable traffic, so realtime
                    // yields to it: the newest best-effort datagram is the one
                    // dropped, and it is dropped before it is ever queued.
                    completion(null)
                    return
                }
            }
        } else if (outbound.size >= BleTuning.MAX_RELIABLE_QUEUE_DEPTH) {
            packetsDropped++
            completion(BleErrors.failed("the send queue for link $id is full"))
            return
        }

        outbound.addLast(Outbound(bytes, reliable, completion))
        pump()
    }

    /**
     * The oldest queued best-effort datagram, removed. Null when everything
     * waiting is reliable and must therefore be left exactly where it is.
     *
     * It can never pick the datagram currently on the radio: [pump] takes that
     * one off the queue before handing it to the sender, so anything still in
     * here is provably unsent and dropping it cannot duplicate or reorder
     * anything.
     */
    private fun removeOldestRealtime(): Outbound? {
        val iterator = outbound.iterator()
        while (iterator.hasNext()) {
            val item = iterator.next()
            if (!item.reliable) {
                iterator.remove()
                return item
            }
        }
        return null
    }

    private fun pump() {
        if (sending || closedEmitted) return
        val path = sender ?: return
        val next = outbound.pollFirst() ?: return
        sending = true

        // One datagram in flight at a time, always. On the GATT paths the stack
        // enforces this too (see GattOperationQueue); on L2CAP it is ours to
        // keep. Doing it here as well means the ordering guarantee does not
        // change shape when a link is upgraded.
        path.send(next.bytes, next.reliable) { error ->
            sending = false
            if (error == null) {
                packetsSent++
                bytesSent += next.bytes.size
                record(next.bytes.size)
            } else {
                packetsDropped++
            }
            complete(next, error)
            pump()
        }
    }

    private fun complete(item: Outbound, error: Throwable?) {
        try {
            item.completion(error)
        } catch (t: Throwable) {
            host.log("error", "send completion on $id threw ${t.javaClass.simpleName}")
        }
    }

    // -- receiving ------------------------------------------------------------

    /** Exactly one whole datagram, from whichever path is carrying this link. */
    fun deliver(bytes: ByteArray) {
        if (closedEmitted || bytes.isEmpty()) return
        packetsReceived++
        bytesReceived += bytes.size
        record(bytes.size)
        host.onLinkData(this, bytes)
    }

    // -- metrics --------------------------------------------------------------

    fun updateRssi(value: Int) {
        rssi = value
        rssiReadAtMs = SystemClock.elapsedRealtime()
    }

    /** Safe to call from any thread. */
    fun metrics(): LinkMetricsSnapshot =
        LinkMetricsSnapshot(
            maxDatagramSize = maxDatagramSize,
            rssi = rssi,
            packetsSent = packetsSent,
            packetsReceived = packetsReceived,
            packetsDropped = packetsDropped,
            bytesSent = bytesSent.toDouble(),
            bytesReceived = bytesReceived.toDouble(),
            throughput = throughput(),
        )

    /**
     * Bytes per second over a short sliding window rather than over the life of
     * the link, because the number is used for a transfer ETA and a lifetime
     * average would hide the phone going back in a pocket. An idle link decays
     * to zero on its own, which is the honest reading.
     */
    private fun throughput(): Double {
        val elapsed = SystemClock.elapsedRealtime() - windowStartMs
        if (elapsed < 500) return lastRate
        return windowBytes * 1000.0 / elapsed
    }

    private fun record(bytes: Int) {
        windowBytes += bytes
        val elapsed = SystemClock.elapsedRealtime() - windowStartMs
        if (elapsed >= BleTuning.THROUGHPUT_WINDOW_MS) {
            lastRate = windowBytes * 1000.0 / elapsed
            windowStartMs = SystemClock.elapsedRealtime()
            windowBytes = 0
        }
    }

    /** The path currently carrying this link, for logs. */
    fun pathLabel(): String = sender?.label ?: "none"
}
