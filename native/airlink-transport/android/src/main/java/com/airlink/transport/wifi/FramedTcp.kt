package com.airlink.transport.wifi

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The length-framed TCP datagram layer shared by every Wi-Fi transport on
 * Android, and the exact mirror of what the iOS Network.framework transport
 * writes.
 *
 * ===========================================================================
 * THE WIRE FORMAT - both platforms MUST agree byte for byte
 * ===========================================================================
 *
 *      0        1        2        3        4                 4 + length
 *      +--------+--------+--------+--------+=================+
 *      |            length (uint32)        |     payload     |
 *      +--------+--------+--------+--------+=================+
 *
 *   - `length` is BIG-ENDIAN (network byte order), unsigned, and counts ONLY
 *     the payload bytes that follow it.
 *   - Exactly one datagram per frame. One `send` of N bytes produces one frame
 *     of N bytes and one `onDatagram` of N bytes on the peer, always.
 *   - Valid `length` is 1 .. MAX_DATAGRAM_BYTES inclusive. Zero is rejected:
 *     every AirLink protocol frame carries at least a version and a type byte,
 *     so a zero-length datagram can only be a confused or hostile peer, and
 *     rejecting it gives us a free sanity check on stream alignment.
 *   - Anything outside that range is a framing violation. There is no way to
 *     resynchronise a byte stream once the length word is wrong, so the only
 *     safe response is to close the link and let the layer above reconnect.
 *   - No magic number, no version byte, no checksum. TCP already gives us
 *     integrity and ordering, and the AirLink protocol above gives us
 *     authentication; a second framing header would be two things to keep in
 *     sync across two platforms instead of one. Deliberately the plainest
 *     scheme that can possibly work.
 *
 * MAX_DATAGRAM_BYTES is BOTH the advertised `maxDatagramSize` of a link and the
 * hard ceiling on what we will read. Keeping those two the same number is the
 * point: a peer can never make us allocate a buffer we would not have been
 * willing to send ourselves. Changing it is a wire change on both platforms.
 *
 * ===========================================================================
 *
 * Nothing in this file knows anything about the AirLink protocol. It moves
 * opaque byte arrays and reports state; sequencing, encryption, retries and
 * fragmentation all live in TypeScript.
 */
internal object FramedTcp {

    /**
     * The largest datagram this transport will send or accept, in bytes.
     *
     * 64 KiB is comfortably above the 256 KiB logical frame ceiling divided
     * into a handful of fragments, small enough that a hostile peer cannot make
     * us allocate anything painful, and a round number that is easy to keep
     * identical on the Swift side.
     */
    const val MAX_DATAGRAM_BYTES = 64 * 1024

    /** Bytes of big-endian length that prefix every datagram. */
    const val LENGTH_PREFIX_BYTES = 4

    /**
     * How much may sit in one link's send queue before further sends are
     * refused. A peer that stops reading must not be able to grow our heap
     * without limit, so the queue is bounded in bytes as well as in count.
     */
    const val MAX_QUEUED_BYTES = 4 * 1024 * 1024
    const val MAX_QUEUED_DATAGRAMS = 512

    /**
     * A realtime (best-effort) datagram is dropped rather than queued once the
     * backlog passes this. Game state supersedes itself, so delivering it late
     * is worse than not delivering it - and dropping happens before a single
     * byte is written, so the framing on the wire stays perfectly aligned.
     */
    const val REALTIME_DROP_THRESHOLD_BYTES = 256 * 1024

    /** Socket read/write buffer size. Large enough that a typical frame is one refill. */
    const val STREAM_BUFFER_BYTES = 32 * 1024

    /** Encodes a payload into one heap array so it reaches the socket as one write. */
    fun frame(payload: ByteArray): ByteArray {
        val out = ByteArray(LENGTH_PREFIX_BYTES + payload.size)
        val n = payload.size
        out[0] = (n ushr 24).toByte()
        out[1] = (n ushr 16).toByte()
        out[2] = (n ushr 8).toByte()
        out[3] = n.toByte()
        System.arraycopy(payload, 0, out, LENGTH_PREFIX_BYTES, n)
        return out
    }

    fun decodeLength(header: ByteArray): Int {
        // Assembled as a Long first: a hostile peer can set the top bit, and we
        // want to reject 3_000_000_000 as "too large" rather than as a negative
        // Int that might slip past a `> max` check somewhere.
        val value =
            ((header[0].toLong() and 0xFF) shl 24) or
                ((header[1].toLong() and 0xFF) shl 16) or
                ((header[2].toLong() and 0xFF) shl 8) or
                (header[3].toLong() and 0xFF)
        return if (value < 1L || value > MAX_DATAGRAM_BYTES.toLong()) -1 else value.toInt()
    }

    /**
     * Dials the first address that answers, spending at most `timeoutMs` in
     * total across all of them.
     *
     * NSD hands back several addresses for one host (IPv4 plus one or more IPv6
     * link-locals) and there is no way to know which one is routable without
     * trying, so the budget is split rather than multiplied.
     *
     * `prepare` is given the unconnected socket - the transports use it to bind
     * the socket to a specific Network, which matters when the phone also has
     * cellular up and the local Wi-Fi has no internet.
     */
    @Throws(IOException::class)
    fun dial(
        addresses: List<InetAddress>,
        port: Int,
        timeoutMs: Int,
        prepare: ((Socket) -> Unit)? = null,
    ): Socket {
        if (addresses.isEmpty()) throw IOException("no addresses to dial")
        val deadline = System.nanoTime() + timeoutMs.toLong() * 1_000_000L
        var last: IOException? = null

        addresses.forEachIndexed { index, address ->
            val remainingMs = ((deadline - System.nanoTime()) / 1_000_000L)
            if (remainingMs <= 0L) throw last ?: IOException("connect timed out")
            val budget = remainingMs / (addresses.size - index).coerceAtLeast(1)
            // Never hand connect() a zero timeout - Socket treats 0 as "block
            // forever", which is the one thing this method must not do. The
            // floor can overshoot the remaining budget by a quarter of a second
            // on the last address, which is the cheaper of the two mistakes.
            val slice = maxOf(250L, minOf(budget, remainingMs)).toInt()

            val socket = Socket()
            try {
                prepare?.invoke(socket)
                socket.connect(InetSocketAddress(address, port), slice)
                return socket
            } catch (e: IOException) {
                last = e
                try {
                    socket.close()
                } catch (_: IOException) {
                }
            }
        }
        throw last ?: IOException("could not connect")
    }
}

/**
 * One TCP connection presented as an ordered stream of whole datagrams.
 *
 * Threading: one reader thread and one writer thread per link. `send` never
 * touches the socket on the caller's thread and never invokes its completion
 * inline, which is what the transport contract means by "callbacks are never
 * delivered re-entrantly from inside a send call".
 */
internal class FramedTcpLink(
    val linkId: String,
    private val socket: Socket,
    /** Where close notifications are delivered. Must not be the writer thread. */
    private val callbacks: Executor,
    private val listener: Listener,
    private val logger: (String, String) -> Unit,
) {

    interface Listener {
        /** Exactly one whole datagram, delivered on the link's reader thread. */
        fun onDatagram(link: FramedTcpLink, payload: ByteArray)

        /** Called exactly once per link, on the `callbacks` executor. */
        fun onClosed(link: FramedTcpLink, reason: String, failed: Boolean)
    }

    private class Outbound(
        val frame: ByteArray?,
        val payloadLength: Int,
        val completion: ((Result<Unit>) -> Unit)?,
    )

    private val poison = Outbound(null, 0, null)
    private val queue = LinkedBlockingQueue<Outbound>()

    private val closed = AtomicBoolean(false)
    private val started = AtomicBoolean(false)

    private val queuedBytes = AtomicLong(0)
    private val queuedCount = AtomicLong(0)
    private val packetsSent = AtomicLong(0)
    private val packetsReceived = AtomicLong(0)
    private val packetsDropped = AtomicLong(0)
    private val bytesSent = AtomicLong(0)
    private val bytesReceived = AtomicLong(0)
    private val startedAtNanos = AtomicLong(0)

    private val reader = Thread({ readLoop() }, "airlink-rx-$linkId").apply { isDaemon = true }
    private val writer = Thread({ writeLoop() }, "airlink-tx-$linkId").apply { isDaemon = true }

    val maxDatagramSize: Int get() = FramedTcp.MAX_DATAGRAM_BYTES

    /** Remote address as text, for diagnostics only. Never a payload. */
    val remoteDescription: String
        get() = "${socket.inetAddress?.hostAddress ?: "?"}:${socket.port}"

    fun start() {
        if (!started.compareAndSet(false, true)) return
        startedAtNanos.set(System.nanoTime())
        try {
            socket.tcpNoDelay = true // interactive traffic; Nagle would add 40ms to a chat message
            socket.keepAlive = true
            // SO_TIMEOUT is deliberately left at 0 (block forever). A read that
            // times out halfway through a frame cannot be resumed - the stream
            // would be permanently misaligned - so the only safe way to unblock
            // the reader is to close the socket, which close() does. Liveness is
            // decided in TypeScript, which pings every few seconds and calls
            // disconnect(); this layer must not invent its own reconnect policy.
            socket.soTimeout = 0
        } catch (e: SocketException) {
            logger("warn", "socket options rejected: ${e.javaClass.simpleName}")
        }
        reader.start()
        writer.start()
    }

    /**
     * Queues exactly one datagram.
     *
     * `reliable = false` selects the best-effort path: when the backlog is
     * already deep the datagram is dropped instead of queued, because newer
     * realtime state supersedes it. The drop happens before anything is
     * written, so the frame stream stays aligned.
     */
    fun send(payload: ByteArray, reliable: Boolean, completion: (Result<Unit>) -> Unit) {
        if (closed.get()) {
            post { completion(Result.failure(IOException("link $linkId is closed"))) }
            return
        }
        if (payload.isEmpty() || payload.size > FramedTcp.MAX_DATAGRAM_BYTES) {
            post {
                completion(
                    Result.failure(
                        IllegalArgumentException(
                            "datagram of ${payload.size} bytes is outside 1..${FramedTcp.MAX_DATAGRAM_BYTES}",
                        ),
                    ),
                )
            }
            return
        }

        val pending = queuedBytes.get()
        if (!reliable && pending > FramedTcp.REALTIME_DROP_THRESHOLD_BYTES) {
            packetsDropped.incrementAndGet()
            post { completion(Result.success(Unit)) }
            return
        }
        if (pending + payload.size > FramedTcp.MAX_QUEUED_BYTES ||
            queuedCount.get() >= FramedTcp.MAX_QUEUED_DATAGRAMS
        ) {
            // Refusing loudly is the contract: the reliability layer above will
            // hold the datagram and retry, which is strictly better than us
            // buffering until the process dies.
            packetsDropped.incrementAndGet()
            post { completion(Result.failure(IOException("send queue for link $linkId is full"))) }
            return
        }

        queuedBytes.addAndGet(payload.size.toLong())
        queuedCount.incrementAndGet()
        queue.put(Outbound(FramedTcp.frame(payload), payload.size, completion))
        // A close that landed between the check above and this put would already
        // have drained the queue, leaving this datagram queued against a dead
        // writer with a completion nobody ever calls - and a promise in
        // JavaScript that never settles. Draining again closes that window.
        if (closed.get()) drainQueue(IOException("link $linkId is closed"))
    }

    /** Idempotent. Always eventually produces exactly one `onClosed`. */
    fun close(reason: String) = finish(reason, failed = false)

    fun stats(): Stats {
        val elapsedSeconds = (System.nanoTime() - startedAtNanos.get()).coerceAtLeast(1L) / 1_000_000_000.0
        val moved = (bytesSent.get() + bytesReceived.get()).toDouble()
        return Stats(
            packetsSent = packetsSent.get(),
            packetsReceived = packetsReceived.get(),
            packetsDropped = packetsDropped.get(),
            bytesSent = bytesSent.get().toDouble(),
            bytesReceived = bytesReceived.get().toDouble(),
            // A lifetime average, not an instantaneous rate. Honest enough for
            // an ETA and free of the state a sliding window would need.
            throughput = if (elapsedSeconds > 0.5) moved / elapsedSeconds else 0.0,
        )
    }

    data class Stats(
        val packetsSent: Long,
        val packetsReceived: Long,
        val packetsDropped: Long,
        val bytesSent: Double,
        val bytesReceived: Double,
        val throughput: Double,
    )

    // -- internals ------------------------------------------------------------

    /**
     * Hands a callback to the transport's thread. Swallows the rejection that
     * happens when the transport is being torn down underneath us: a link that
     * is going away anyway must never take the process with it.
     */
    private fun post(block: () -> Unit) {
        try {
            callbacks.execute {
                try {
                    block()
                } catch (t: Throwable) {
                    logger("error", "callback threw: ${t.javaClass.simpleName}")
                }
            }
        } catch (_: Throwable) {
            logger("warn", "callback dropped, transport is shutting down")
        }
    }

    private fun finish(reason: String, failed: Boolean) {
        if (!closed.compareAndSet(false, true)) return
        try {
            // Closing from another thread is what unblocks the reader; see the
            // note about SO_TIMEOUT in start().
            socket.close()
        } catch (_: IOException) {
        } catch (_: RuntimeException) {
        }
        drainQueue(IOException("link $linkId closed: $reason"))
        queue.put(poison)
        post { listener.onClosed(this, reason, failed) }
    }

    private fun drainQueue(cause: IOException) {
        var sawPoison = false
        while (true) {
            val item = queue.poll() ?: break
            if (item.frame == null) {
                // The writer's stop signal. Set aside rather than dropped: a
                // consumed poison would leave the writer thread blocked on take()
                // forever. Draining continues past it, because a send racing with
                // close can have queued a datagram BEHIND it, and that datagram
                // still owns a promise that has to be settled.
                sawPoison = true
                continue
            }
            queuedBytes.addAndGet(-item.payloadLength.toLong())
            queuedCount.decrementAndGet()
            item.completion?.let { done -> post { done(Result.failure(cause)) } }
        }
        if (sawPoison) queue.put(poison)
    }

    private fun readLoop() {
        val header = ByteArray(FramedTcp.LENGTH_PREFIX_BYTES)
        try {
            val input = DataInputStream(BufferedInputStream(socket.getInputStream(), FramedTcp.STREAM_BUFFER_BYTES))
            while (!closed.get()) {
                input.readFully(header)
                val length = FramedTcp.decodeLength(header)
                if (length < 0) {
                    // Unrecoverable: a byte stream cannot be resynchronised.
                    finish("framing error: bad datagram length", failed = true)
                    return
                }
                val payload = ByteArray(length)
                input.readFully(payload)
                packetsReceived.incrementAndGet()
                bytesReceived.addAndGet(length.toLong())
                try {
                    listener.onDatagram(this, payload)
                } catch (t: Throwable) {
                    // A throwing sink must not take the radio down with it.
                    logger("error", "datagram sink threw: ${t.javaClass.simpleName}")
                }
            }
        } catch (_: EOFException) {
            finish("peer closed the link", failed = false)
        } catch (_: SocketTimeoutException) {
            finish("read timed out", failed = true)
        } catch (e: IOException) {
            // Includes the SocketException raised by our own close().
            if (closed.get()) return
            finish("read failed: ${e.javaClass.simpleName}", failed = true)
        } catch (_: OutOfMemoryError) {
            finish("out of memory reading a datagram", failed = true)
        } catch (t: Throwable) {
            finish("reader failed: ${t.javaClass.simpleName}", failed = true)
        }
    }

    private fun writeLoop() {
        try {
            val output = BufferedOutputStream(socket.getOutputStream(), FramedTcp.STREAM_BUFFER_BYTES)
            while (true) {
                val item = queue.take()
                val frame = item.frame ?: return // poison
                queuedBytes.addAndGet(-item.payloadLength.toLong())
                queuedCount.decrementAndGet()
                try {
                    // One write, one flush: the frame header and its payload can
                    // never be separated by another writer.
                    output.write(frame)
                    output.flush()
                } catch (e: IOException) {
                    item.completion?.let { done -> post { done(Result.failure(e)) } }
                    if (!closed.get()) finish("write failed: ${e.javaClass.simpleName}", failed = true)
                    return
                }
                packetsSent.incrementAndGet()
                bytesSent.addAndGet(item.payloadLength.toLong())
                item.completion?.let { done -> post { done(Result.success(Unit)) } }
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (t: Throwable) {
            if (!closed.get()) finish("writer failed: ${t.javaClass.simpleName}", failed = true)
        }
    }
}

/**
 * A TCP listener that hands accepted sockets to the transport.
 *
 * Both Wi-Fi transports need one: the local-network transport publishes its
 * port in a TXT record, the Wi-Fi Direct group owner listens on a fixed port.
 */
internal class FramedTcpServer(
    private val logger: (String, String) -> Unit,
    /** Return false to refuse the connection; the socket is then closed for you. */
    private val onAccepted: (Socket) -> Boolean,
) {

    private companion object {
        /**
         * The accept loop wakes this often to notice that stop() was called.
         * Unlike a read timeout, an accept timeout cannot leave anything
         * half-consumed, so polling here is safe.
         */
        const val ACCEPT_POLL_MS = 500

        /** Enough for a burst of reconnects, small enough to bound the kernel queue. */
        const val BACKLOG = 8
    }

    private var serverSocket: ServerSocket? = null
    private var thread: Thread? = null
    private val running = AtomicBoolean(false)

    /** The bound port, or 0 when not listening. */
    @Volatile
    var port: Int = 0
        private set

    /**
     * Binds and starts accepting. `requestedPort` of 0 asks the OS for an
     * ephemeral port, which is what the local-network transport wants because
     * it can publish whatever it gets.
     */
    @Throws(IOException::class)
    fun start(requestedPort: Int) {
        if (running.get()) return
        // Created unbound so that SO_REUSEADDR can be set BEFORE the bind, which
        // is the only time it has any effect. It matters for the Wi-Fi Direct
        // group owner, which rebinds one fixed port every time a group forms: a
        // socket left in TIME_WAIT from the previous session would otherwise
        // refuse the bind, and the peer has no way to learn a different port.
        val socket = ServerSocket()
        try {
            socket.reuseAddress = true
            // Bound to the wildcard address on purpose: on Wi-Fi Direct the
            // group owner's interface does not exist yet when the group is
            // forming, and on a shared network we may be reachable on more than
            // one interface.
            socket.bind(InetSocketAddress(requestedPort), BACKLOG)
            socket.soTimeout = ACCEPT_POLL_MS
        } catch (e: IOException) {
            // The port is taken, which is a real outcome for the Wi-Fi Direct
            // group owner's fixed port. Close before rethrowing: an unbound
            // socket left behind is a file descriptor nobody will ever reclaim.
            try {
                socket.close()
            } catch (_: IOException) {
            }
            throw e
        }
        serverSocket = socket
        port = socket.localPort
        running.set(true)
        thread = Thread({ acceptLoop(socket) }, "airlink-accept-$port").apply {
            isDaemon = true
            start()
        }
        logger("debug", "listening on port $port")
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        try {
            serverSocket?.close()
        } catch (_: IOException) {
        }
        serverSocket = null
        thread = null
        port = 0
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (running.get()) {
            val accepted =
                try {
                    socket.accept()
                } catch (_: SocketTimeoutException) {
                    continue
                } catch (e: IOException) {
                    if (running.get()) logger("warn", "accept failed: ${e.javaClass.simpleName}")
                    return
                } catch (t: Throwable) {
                    logger("error", "accept loop died: ${t.javaClass.simpleName}")
                    return
                }
            val keep =
                try {
                    onAccepted(accepted)
                } catch (t: Throwable) {
                    logger("error", "accept handler threw: ${t.javaClass.simpleName}")
                    false
                }
            if (!keep) {
                try {
                    accepted.close()
                } catch (_: IOException) {
                }
            }
        }
    }
}
