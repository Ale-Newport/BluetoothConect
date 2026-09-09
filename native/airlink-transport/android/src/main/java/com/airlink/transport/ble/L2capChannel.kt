package com.airlink.transport.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.os.Build
import android.os.Handler
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The L2CAP upgrade: a real byte-stream socket over the same LE connection,
 * bypassing ATT entirely.
 *
 * WHY BOTHER. GATT moves one datagram per connection interval, and every write
 * costs a round trip through the ATT queue. An L2CAP connection-oriented
 * channel has its own credit-based flow control and moves several kilobytes
 * per interval, which is the difference between a photo taking ten minutes and
 * taking two. It is available from API 29, it needs no bonding, and - the part
 * that matters for this product - it interoperates with CoreBluetooth's
 * `publishL2CAPChannel` / `openL2CAPChannel`, so it works iPhone-to-Android.
 *
 * WHAT IT COSTS. A `BluetoothSocket` is a STREAM: two 100-byte sends may arrive
 * as one 200-byte read, or as a 40-byte read and a 160-byte read. The datagram
 * contract - one send of N bytes arrives as exactly one receive of N bytes, or
 * not at all - has to be rebuilt on top of it with our own length framing. See
 * [BleWire] for the layout, which iOS mirrors.
 *
 * WHO HOSTS. The peripheral listens and publishes its PSM in the identity
 * characteristic; the central reads it and dials. Fixing the roles this way
 * means there is never a race where both sides listen and both sides dial and
 * a link ends up with two channels. If anything in the sequence fails - no
 * PSM, no permission, an older peer, a controller that refuses - the link
 * quietly stays on GATT. The user is never told about an upgrade that did not
 * happen, because from their side nothing happened.
 */
// MissingPermission: every entry point below is reached only after
// BlePermissions has confirmed BLUETOOTH_CONNECT, and every call is wrapped
// against the SecurityException a mid-session revocation would raise anyway.
// NewApi: the L2CAP surface is API 29 and is gated at runtime by
// [L2cap.isSupported]; the gate is a property rather than an inline check, and
// two of the calls sit inside worker lambdas, neither of which lint can follow.
@SuppressLint("MissingPermission", "NewApi")
internal object L2cap {

    /**
     * L2CAP connection-oriented channels arrived in API 29. Below that the
     * upgrade simply does not exist and every link runs on GATT - which is why
     * `supportsL2cap` is a runtime capability rather than a build-time one.
     */
    val isSupported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    /**
     * Dials a peer's published PSM.
     *
     * `BluetoothSocket.connect()` blocks with no timeout parameter, and on a
     * peer that has stopped answering it can block for a long time. The only
     * documented way to abort it is to close the socket from another thread, so
     * that is what the watchdog does. The dial therefore costs one short-lived
     * thread per attempt; it is bounded by [BleTuning.L2CAP_CONNECT_TIMEOUT_MS]
     * and there is at most one attempt per link.
     */
    fun connect(
        device: BluetoothDevice,
        psm: Int,
        timeoutMs: Long,
        handler: Handler,
        onResult: (BluetoothSocket?) -> Unit,
    ) {
        if (!isSupported || psm !in 1..0xFFFF) {
            handler.post { onResult(null) }
            return
        }

        val settled = AtomicBoolean(false)
        // Shared between the dialling thread and the watchdog, so it has to be
        // an atomic rather than a captured local: the watchdog closes exactly
        // the socket the worker has by then created, or nothing.
        val socket = AtomicReference<BluetoothSocket?>(null)

        val worker = Thread({
            try {
                val opened = device.createInsecureL2capChannel(psm)
                socket.set(opened)
                if (settled.get()) {
                    // The watchdog gave up while we were being created.
                    closeQuietly(opened)
                    return@Thread
                }
                opened.connect()
                if (settled.compareAndSet(false, true)) {
                    handler.post { onResult(opened) }
                } else {
                    closeQuietly(opened)
                }
            } catch (t: Throwable) {
                // IOException for a refused or unsupported channel, and
                // SecurityException if BLUETOOTH_CONNECT was revoked between the
                // check and the call. Neither is fatal: no upgrade, carry on.
                closeQuietly(socket.getAndSet(null))
                if (settled.compareAndSet(false, true)) {
                    handler.post { onResult(null) }
                }
            }
        }, "airlink-l2cap-dial")
        worker.isDaemon = true
        worker.start()

        handler.postDelayed({
            if (settled.compareAndSet(false, true)) {
                // Closing is what unblocks connect(); the worker will see an
                // IOException and exit.
                closeQuietly(socket.getAndSet(null))
                onResult(null)
            }
        }, timeoutMs)
    }

    fun closeQuietly(socket: BluetoothSocket?) {
        try {
            socket?.close()
        } catch (_: IOException) {
        } catch (_: RuntimeException) {
        }
    }

    fun closeQuietly(socket: BluetoothServerSocket?) {
        try {
            socket?.close()
        } catch (_: IOException) {
        } catch (_: RuntimeException) {
        }
    }
}

/**
 * The peripheral's side of the upgrade: one listening socket for the whole
 * transport, whose PSM is published in the identity characteristic.
 *
 * One socket serves every peer - the PSM is a property of this device, not of a
 * connection - so an accepted channel is matched back to a link by the remote
 * device address. A channel we cannot match is closed rather than kept, since
 * holding it would pin a controller resource for a peer that will never use it.
 */
// See the note on L2cap above: permission is checked before we get here and
// the whole L2CAP surface is gated at runtime on API 29.
@SuppressLint("MissingPermission", "NewApi")
internal class L2capListener(
    private val handler: Handler,
    private val onAccepted: (BluetoothSocket) -> Unit,
    private val log: (String, String) -> Unit,
) {

    private var serverSocket: BluetoothServerSocket? = null
    private var acceptThread: Thread? = null
    private val running = AtomicBoolean(false)

    /** 0 when we are not listening; publish it only when it is non-zero. */
    @Volatile
    var psm: Int = 0
        private set

    /** Returns true when a channel is now published. Never throws. */
    fun start(adapter: BluetoothAdapter): Boolean {
        if (!L2cap.isSupported) return false
        if (running.get()) return psm != 0

        val socket = try {
            // Insecure, i.e. no bonding and no link-layer encryption required.
            // That is deliberate: AirLink authenticates and encrypts everything
            // itself with SIGMA-I and ChaCha20-Poly1305, and requiring a bond
            // here would put a system pairing dialog in front of two people who
            // have already agreed to talk - for protection we do not rely on.
            adapter.listenUsingInsecureL2capChannel()
        } catch (t: Throwable) {
            log("info", "L2CAP listen unavailable (${t.javaClass.simpleName}); GATT only")
            return false
        }

        val assigned = try {
            socket.psm
        } catch (t: Throwable) {
            L2cap.closeQuietly(socket)
            log("info", "L2CAP PSM unavailable (${t.javaClass.simpleName}); GATT only")
            return false
        }

        serverSocket = socket
        psm = assigned
        running.set(true)

        val thread = Thread({ acceptLoop(socket) }, "airlink-l2cap-accept")
        thread.isDaemon = true
        acceptThread = thread
        thread.start()
        log("info", "L2CAP listening on PSM $assigned")
        return true
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        psm = 0
        // Closing the server socket is what unblocks accept().
        L2cap.closeQuietly(serverSocket)
        serverSocket = null
        acceptThread = null
    }

    private fun acceptLoop(socket: BluetoothServerSocket) {
        while (running.get()) {
            val accepted = try {
                socket.accept()
            } catch (e: IOException) {
                // Our own stop() closing the socket lands here too.
                if (running.get()) log("info", "L2CAP accept ended: ${e.javaClass.simpleName}")
                return
            } catch (t: Throwable) {
                log("warn", "L2CAP accept failed: ${t.javaClass.simpleName}")
                return
            }
            handler.post {
                if (running.get()) {
                    onAccepted(accepted)
                } else {
                    L2cap.closeQuietly(accepted)
                }
            }
        }
    }
}

/**
 * One connected L2CAP channel, presented as an ordered stream of whole
 * datagrams.
 *
 * Threading: one reader thread and one writer thread. Neither ever runs on the
 * transport's handler thread, because a socket write can block for as long as
 * the peer's credit window is closed and the handler thread also drives every
 * timeout in the transport. Datagrams and completions are posted back onto the
 * handler, so ordering is preserved and nothing is delivered re-entrantly.
 */
@SuppressLint("MissingPermission")
internal class L2capSender(
    private val socket: BluetoothSocket,
    private val handler: Handler,
    private val onDatagram: (ByteArray) -> Unit,
    /** Called at most once, on the handler thread, when the channel ends by itself. */
    private val onBroken: (String) -> Unit,
    private val log: (String, String) -> Unit,
) : DatagramSender {

    private class Outbound(val frame: ByteArray?, val onDone: ((Throwable?) -> Unit)?)

    private val poison = Outbound(null, null)
    private val queue = LinkedBlockingQueue<Outbound>()
    private val closed = AtomicBoolean(false)
    private val started = AtomicBoolean(false)

    private val reader = Thread({ readLoop() }, "airlink-l2cap-rx").apply { isDaemon = true }
    private val writer = Thread({ writeLoop() }, "airlink-l2cap-tx").apply { isDaemon = true }

    override val maxDatagramSize: Int get() = BleWire.L2CAP_MAX_DATAGRAM_BYTES

    override val label: String get() = "l2cap"

    fun start() {
        if (!started.compareAndSet(false, true)) return
        try {
            log(
                "debug",
                "L2CAP channel up; tx packet ${socket.maxTransmitPacketSize}, " +
                    "rx packet ${socket.maxReceivePacketSize}",
            )
        } catch (_: Throwable) {
            // Diagnostics only; some stacks refuse these before the first byte.
        }
        reader.start()
        writer.start()
    }

    override fun send(datagram: ByteArray, reliable: Boolean, onDone: (Throwable?) -> Unit) {
        if (closed.get()) {
            handler.post { onDone(BleErrors.failed("the L2CAP channel is closed")) }
            return
        }
        if (datagram.size > BleWire.L2CAP_MAX_DATAGRAM_BYTES) {
            handler.post {
                onDone(BleErrors.payloadTooLarge(datagram.size, BleWire.L2CAP_MAX_DATAGRAM_BYTES))
            }
            return
        }
        // Framed here rather than in the writer so the whole datagram reaches
        // the socket as one write; splitting the length word from its payload
        // across two writes is how stream framing gets subtly wrong.
        queue.put(Outbound(BleWire.frame(datagram), onDone))
    }

    /**
     * Idempotent. Closing the socket from this thread is also what unblocks the
     * reader, which is blocked in a read that has no timeout - see the note in
     * [readLoop].
     */
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        L2cap.closeQuietly(socket)
        drain(BleErrors.failed("the L2CAP channel closed"))
        queue.put(poison)
    }

    // -- internals ------------------------------------------------------------

    private fun drain(cause: Throwable) {
        while (true) {
            val item = queue.poll() ?: break
            val done = item.onDone ?: continue
            handler.post { done(cause) }
        }
    }

    private fun broke(reason: String) {
        if (closed.get()) return
        handler.post {
            if (!closed.get()) onBroken(reason)
        }
    }

    private fun readLoop() {
        val header = ByteArray(BleWire.LENGTH_PREFIX_BYTES)
        try {
            val input = DataInputStream(BufferedInputStream(socket.inputStream, 16 * 1024))
            while (!closed.get()) {
                input.readFully(header)
                val length = BleWire.decodeLength(header)
                if (length < 0) {
                    // A byte stream cannot be resynchronised once the length
                    // word is wrong: every byte after it is at an unknown
                    // offset. Failing the link is the only honest option.
                    broke("L2CAP framing error: bad datagram length")
                    return
                }
                val payload = ByteArray(length)
                input.readFully(payload)
                handler.post { if (!closed.get()) onDatagram(payload) }
            }
        } catch (_: EOFException) {
            broke("the peer closed the L2CAP channel")
        } catch (e: IOException) {
            // Includes the exception raised by our own close().
            if (!closed.get()) broke("L2CAP read failed: ${e.javaClass.simpleName}")
        } catch (_: OutOfMemoryError) {
            broke("out of memory reading an L2CAP datagram")
        } catch (t: Throwable) {
            broke("L2CAP reader failed: ${t.javaClass.simpleName}")
        }
    }

    private fun writeLoop() {
        try {
            val output = BufferedOutputStream(socket.outputStream, 16 * 1024)
            while (true) {
                val item = queue.take()
                val frame = item.frame ?: return // poison: close() ran
                try {
                    output.write(frame)
                    output.flush()
                    item.onDone?.let { done -> handler.post { done(null) } }
                } catch (e: IOException) {
                    val failure = BleErrors.failed("L2CAP write failed: ${e.javaClass.simpleName}")
                    item.onDone?.let { done -> handler.post { done(failure) } }
                    broke("L2CAP write failed: ${e.javaClass.simpleName}")
                    return
                }
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (t: Throwable) {
            broke("L2CAP writer failed: ${t.javaClass.simpleName}")
        }
    }
}
