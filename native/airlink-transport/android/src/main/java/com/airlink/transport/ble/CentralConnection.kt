package com.airlink.transport.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import com.airlink.transport.LinkState

/**
 * One outgoing connection: we are the central, the peer is the peripheral.
 *
 * The whole of the connection sequence lives here, in one place, because the
 * order of it is the part that is easy to get wrong:
 *
 *   connect -> discover services -> negotiate MTU -> subscribe to TX ->
 *   read identity -> try to upgrade to L2CAP -> report the link open
 *
 * Everything from "discover services" onwards goes through
 * [GattOperationQueue], because Android allows exactly one outstanding GATT
 * operation per connection and issues no warning at all when you break that
 * rule - it simply loses the operation. See that file for the full story.
 *
 * The link is only reported open at the END of the sequence. That costs a
 * second or two of connection setup and buys the one thing that matters: the
 * datagram size and the transport path a link is born with are the ones it
 * dies with, so "reliable sends arrive in order" never has to survive a
 * mid-stream switch between two radios with different queues.
 */
// MissingPermission: BLUETOOTH_CONNECT is checked in start() and re-checked by
// BleAvailability before every entry point, and every stack call below is
// wrapped against the SecurityException a mid-session revocation raises.
// NewApi: the API 33 GATT surface is guarded by an explicit SDK_INT check at
// each call site, but those sit inside lambdas handed to the operation queue,
// which lint's flow analysis does not follow.
@SuppressLint("MissingPermission", "NewApi")
internal class CentralConnection(
    private val context: Context,
    private val device: BluetoothDevice,
    private val uuids: BleWire.ServiceUuids,
    private val availability: BleAvailability,
    private val host: BleLinkHost,
    linkId: String,
    /** Better information about the peer, learned from its identity characteristic. */
    private val onIdentity: (endpointId: String, record: BleWire.IdentityRecord) -> Unit,
    /** Called exactly once, and only for a connection that never opened. */
    private val onFailed: (Throwable) -> Unit,
    /** Called exactly once, when the link is open and usable. */
    private val onOpened: (BleLink) -> Unit,
    /** Called when this connection is finished with, opened or not. */
    private val onRetired: (CentralConnection) -> Unit,
) {

    private val handler: Handler = host.handler
    private val link = BleLink(linkId, device.address, device, incoming = false, host = host)

    private var gatt: BluetoothGatt? = null
    private var queue: GattOperationQueue? = null

    private var rxCharacteristic: BluetoothGattCharacteristic? = null
    private var txCharacteristic: BluetoothGattCharacteristic? = null

    private var attMtu: Int = BleWire.DEFAULT_ATT_MTU
    private var settled = false
    private var retired = false
    private var highPriority = false

    val endpointId: String get() = link.endpointId
    val linkId: String get() = link.id

    private val connectTimeout = Runnable {
        // Report the honest reason first, then tear down: finishWithFailure
        // marks the connect() call answered, so teardown will not report it a
        // second time with a vaguer message.
        finishWithFailure(BleErrors.timeout("connecting to ${link.endpointId}"))
        teardown("connect timed out", failed = true)
    }

    private val closeWatchdog = Runnable {
        // disconnect() should produce a STATE_DISCONNECTED callback within
        // milliseconds. When it does not - a peer that has already gone, a
        // stack mid-reset - the client interface still has to be released, or
        // the seven-or-so connection slots the controller has leak away one
        // connection at a time until nothing can connect at all.
        releaseGatt()
    }

    private val dropPriority = Runnable {
        val g = gatt ?: return@Runnable
        if (!highPriority) return@Runnable
        highPriority = false
        attempt("requestConnectionPriority(BALANCED)") {
            g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_BALANCED)
        }
    }

    // -- lifecycle ------------------------------------------------------------

    fun start(timeoutMs: Long) {
        if (!availability.canConnect) {
            finishWithFailure(BleErrors.permissionDenied())
            retire()
            return
        }
        if (!availability.isRadioOn) {
            finishWithFailure(BleErrors.radioOff())
            retire()
            return
        }

        host.onLinkState(link, LinkState.CONNECTING, "")
        handler.postDelayed(connectTimeout, timeoutMs)

        // autoConnect = false: a direct connection attempt, which is fast and
        // bounded. autoConnect = true hands the attempt to the stack to retry
        // whenever it next sees the peer, with no timeout and no feedback -
        // useful for a background reconnect policy, which is precisely the
        // decision this layer is not allowed to make.
        val phy = if (availability.supports2MPhy) {
            BluetoothDevice.PHY_LE_1M_MASK or BluetoothDevice.PHY_LE_2M_MASK
        } else {
            BluetoothDevice.PHY_LE_1M_MASK
        }

        val opened = try {
            device.connectGatt(
                context,
                false,
                callback,
                BluetoothDevice.TRANSPORT_LE,
                phy,
                handler,
            )
        } catch (t: Throwable) {
            null
        }

        if (opened == null) {
            handler.removeCallbacks(connectTimeout)
            finishWithFailure(BleErrors.failed("could not open a GATT connection to ${link.endpointId}"))
            link.close("could not open a GATT connection", failed = true)
            retire()
            return
        }

        gatt = opened
        queue = GattOperationQueue(
            handler = handler,
            onWedged = { reason -> teardown(reason, failed = true) },
            log = { level, message -> host.log(level, "[${link.id}] $message") },
        )
    }

    /** Ends the connection. Idempotent; safe from any of the paths that call it. */
    fun teardown(reason: String, failed: Boolean) {
        handler.removeCallbacks(connectTimeout)
        handler.removeCallbacks(dropPriority)
        queue?.abort(reason)

        if (!settled) {
            finishWithFailure(
                if (failed) BleErrors.failed(reason) else BleErrors.failed("connection ended: $reason"),
            )
        }

        link.close(reason, failed)

        val g = gatt
        if (g != null) {
            attempt("disconnect") { g.disconnect() }
            // Give the stack a moment to answer with STATE_DISCONNECTED, which
            // is the clean point to release the client interface.
            handler.postDelayed(closeWatchdog, 2_000)
        } else {
            retire()
        }
    }

    private fun releaseGatt() {
        handler.removeCallbacks(closeWatchdog)
        val g = gatt ?: return retire()
        gatt = null
        attempt("close") { g.close() }
        retire()
    }

    private fun retire() {
        if (retired) return
        retired = true
        onRetired(this)
    }

    private fun finishWithFailure(error: Throwable) {
        if (settled) return
        settled = true
        handler.removeCallbacks(connectTimeout)
        try {
            onFailed(error)
        } catch (t: Throwable) {
            host.log("error", "connect failure handler threw ${t.javaClass.simpleName}")
        }
    }

    // -- the connection sequence ----------------------------------------------

    private fun onConnected() {
        val g = gatt ?: return

        // Both of these are HCI-level requests rather than ATT operations, so
        // they do not go through the operation queue and cannot be "lost" by
        // it. Both materially change throughput: 2M PHY doubles the symbol
        // rate where the peer supports it, and a high-priority connection
        // interval is roughly 7.5ms instead of roughly 50ms.
        if (availability.supports2MPhy) {
            attempt("setPreferredPhy") {
                g.setPreferredPhy(
                    BluetoothDevice.PHY_LE_2M_MASK,
                    BluetoothDevice.PHY_LE_2M_MASK,
                    BluetoothDevice.PHY_OPTION_NO_PREFERRED,
                )
            }
        }
        requestHighPriority()

        queue?.submit(
            GattOpKind.DISCOVER_SERVICES,
            "discoverServices",
            issue = {
                if (g.discoverServices()) GattIssue.Accepted else GattIssue.Busy
            },
            onResult = { outcome ->
                if (!outcome.ok) {
                    teardown("service discovery failed: ${outcome.describe()}", failed = true)
                } else {
                    onServicesReady()
                }
            },
        )
    }

    private fun onServicesReady() {
        val g = gatt ?: return
        val service = try {
            g.getService(uuids.service)
        } catch (_: Throwable) {
            null
        }
        if (service == null) {
            // Connected to something that is not an AirLink peer, or to one
            // whose GATT server had not finished registering. Either way there
            // is nothing here to talk to.
            teardown("the peer does not expose the AirLink service", failed = true)
            return
        }

        rxCharacteristic = service.getCharacteristic(uuids.rx)
        txCharacteristic = service.getCharacteristic(uuids.tx)
        if (rxCharacteristic == null || txCharacteristic == null) {
            teardown("the peer's AirLink service is missing its data characteristics", failed = true)
            return
        }

        negotiateMtu()
    }

    private fun negotiateMtu() {
        val g = gatt ?: return
        queue?.submit(
            GattOpKind.REQUEST_MTU,
            "requestMtu(${BleWire.MAX_ATT_MTU})",
            issue = { if (g.requestMtu(BleWire.MAX_ATT_MTU)) GattIssue.Accepted else GattIssue.Busy },
            onResult = { outcome ->
                // A refused MTU exchange is not fatal. It means 20-byte
                // datagrams and a slow link, which the fragmentation layer
                // above copes with; failing the connection over it would be
                // worse than being slow.
                if (!outcome.ok) {
                    host.log("warn", "MTU exchange refused (${outcome.describe()}); staying at $attMtu")
                }
                subscribeToNotifications()
            },
        )
    }

    /**
     * Turning on notifications takes TWO steps, and doing only the first is the
     * most common BLE bug on this platform: `setCharacteristicNotification`
     * routes notifications inside the local stack, and the CCCD write is what
     * actually tells the peer to send them. Miss the descriptor and the link
     * connects, reports healthy, and never receives a single byte.
     */
    private fun subscribeToNotifications() {
        val g = gatt ?: return
        val tx = txCharacteristic ?: return
        val cccd = try {
            tx.getDescriptor(BleWire.CCCD_UUID)
        } catch (_: Throwable) {
            null
        }

        if (!attemptTrue("setCharacteristicNotification") { g.setCharacteristicNotification(tx, true) }) {
            teardown("could not enable notifications on the peer's TX characteristic", failed = true)
            return
        }
        if (cccd == null) {
            teardown("the peer's TX characteristic has no notification descriptor", failed = true)
            return
        }

        val enable = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        queue?.submit(
            GattOpKind.WRITE_DESCRIPTOR,
            "writeDescriptor(CCCD)",
            issue = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    statusToIssue(g.writeDescriptor(cccd, enable))
                } else {
                    @Suppress("DEPRECATION")
                    if (cccd.setValue(enable) && g.writeDescriptor(cccd)) {
                        GattIssue.Accepted
                    } else {
                        GattIssue.Busy
                    }
                }
            },
            onResult = { outcome ->
                if (!outcome.ok) {
                    teardown("the peer refused our subscription: ${outcome.describe()}", failed = true)
                } else {
                    readIdentity()
                }
            },
        )
    }

    private fun readIdentity() {
        val g = gatt ?: return
        val identityUuid = uuids.identity
        val identity = if (identityUuid == null) {
            null
        } else {
            try {
                g.getService(uuids.service)?.getCharacteristic(identityUuid)
            } catch (_: Throwable) {
                null
            }
        }

        if (identity == null) {
            // No identity characteristic means no published PSM and no name.
            // Both are enhancements; the link works without either.
            openOverGatt()
            return
        }

        queue?.submit(
            GattOpKind.READ_CHARACTERISTIC,
            "readCharacteristic(identity)",
            issue = { if (g.readCharacteristic(identity)) GattIssue.Accepted else GattIssue.Busy },
            onResult = { outcome ->
                val record = if (outcome.ok) {
                    BleWire.decodeIdentity(outcome.value)
                } else {
                    host.log("info", "identity read failed (${outcome.describe()}); GATT only")
                    BleWire.IdentityRecord.EMPTY
                }
                try {
                    onIdentity(link.endpointId, record)
                } catch (t: Throwable) {
                    host.log("warn", "identity handler threw ${t.javaClass.simpleName}")
                }
                tryL2capUpgrade(record.psm)
            },
        )
    }

    private fun tryL2capUpgrade(psm: Int) {
        if (psm == 0 || !L2cap.isSupported || !availability.canConnect) {
            openOverGatt()
            return
        }

        L2cap.connect(device, psm, BleTuning.L2CAP_CONNECT_TIMEOUT_MS, handler) { socket ->
            if (settled || retired) {
                L2cap.closeQuietly(socket)
                return@connect
            }
            if (socket == null) {
                // Silent fallback: from the user's side, nothing happened.
                host.log("info", "L2CAP upgrade to PSM $psm did not take; staying on GATT")
                openOverGatt()
                return@connect
            }

            val sender = L2capSender(
                socket = socket,
                handler = handler,
                onDatagram = { bytes -> link.deliver(bytes) },
                onBroken = { reason -> teardown(reason, failed = true) },
                log = { level, message -> host.log(level, "[${link.id}] $message") },
            )
            sender.start()
            link.attach(sender)
            open()
        }
    }

    private fun openOverGatt() {
        val g = gatt ?: return
        val rx = rxCharacteristic ?: return
        link.attach(GattWriteSender(g, rx))
        open()
    }

    private fun open() {
        if (settled) return
        settled = true
        handler.removeCallbacks(connectTimeout)
        link.markOpen()
        host.log(
            "info",
            "link ${link.id} open to ${link.endpointId} over ${link.pathLabel()}, " +
                "${link.maxDatagramSize} byte datagrams",
        )
        try {
            onOpened(link)
        } catch (t: Throwable) {
            host.log("error", "connect success handler threw ${t.javaClass.simpleName}")
        }
    }

    // -- sending --------------------------------------------------------------

    /**
     * The GATT send path: one ATT write per datagram, strictly one at a time.
     *
     * ATT writes are self-delimiting, so no framing is needed and none is
     * added: a write of N bytes becomes exactly one write request on the air
     * and exactly one `onCharacteristicWriteRequest` at the peer.
     */
    private inner class GattWriteSender(
        private val g: BluetoothGatt,
        private val rx: BluetoothGattCharacteristic,
    ) : DatagramSender {

        override val maxDatagramSize: Int get() = attMtu - BleWire.ATT_HEADER_BYTES

        override val label: String get() = "gatt-write"

        override fun send(datagram: ByteArray, reliable: Boolean, onDone: (Throwable?) -> Unit) {
            requestHighPriority()

            // Write-without-response skips the peer's ATT acknowledgement, which
            // is what makes it the fast, lossy path the realtime game channel
            // wants. It is only available if the peer's characteristic offers
            // it; when it does not, a realtime datagram quietly takes the
            // reliable path rather than being dropped.
            val wantsFast = !reliable &&
                (rx.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
            val writeType = if (wantsFast) {
                BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            } else {
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            }

            val pending = queue
            if (pending == null) {
                onDone(BleErrors.failed("the GATT connection is closed"))
                return
            }

            pending.submit(
                GattOpKind.WRITE_CHARACTERISTIC,
                "writeCharacteristic(${datagram.size}B)",
                issue = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        statusToIssue(g.writeCharacteristic(rx, datagram, writeType))
                    } else {
                        // The pre-33 API mutates the characteristic object and
                        // returns a single boolean for "busy" and "refused"
                        // alike. Treating false as busy costs a few retries in
                        // the rare permanent case and saves the datagram in the
                        // common transient one. Safe only because the queue
                        // guarantees nothing else is touching `rx`.
                        @Suppress("DEPRECATION")
                        run {
                            rx.writeType = writeType
                            if (rx.setValue(datagram) && g.writeCharacteristic(rx)) {
                                GattIssue.Accepted
                            } else {
                                GattIssue.Busy
                            }
                        }
                    }
                },
                onResult = { outcome ->
                    onDone(if (outcome.ok) null else BleErrors.failed(outcome.describe()))
                },
            )
        }

        override fun close() {
            // The GATT connection is owned by CentralConnection, not by the
            // sender: tearing the link down closes it exactly once, there.
        }
    }

    // -- metrics --------------------------------------------------------------

    /**
     * Refreshes the RSSI, but never while there is traffic waiting.
     *
     * `readRemoteRssi` queues against the same single ATT slot as a datagram,
     * so a metrics screen polling once a second would otherwise interleave
     * itself into the middle of a file transfer.
     */
    fun refreshRssi() {
        val g = gatt ?: return
        val pending = queue ?: return
        if (!link.isOpen || pending.depth > 0) return
        val now = SystemClock.elapsedRealtime()
        if (now - link.rssiReadAtMs < BleTuning.RSSI_REFRESH_INTERVAL_MS) return
        link.rssiReadAtMs = now

        pending.submit(
            GattOpKind.READ_RSSI,
            "readRemoteRssi",
            issue = { if (g.readRemoteRssi()) GattIssue.Accepted else GattIssue.Busy },
            onResult = { },
        )
    }

    private fun requestHighPriority() {
        val g = gatt ?: return
        handler.removeCallbacks(dropPriority)
        // Back to a battery-friendly interval once the link has been quiet for
        // a few seconds. The native layer cannot see "a transfer" - it has no
        // idea what the bytes are - so traffic itself is the signal.
        handler.postDelayed(dropPriority, 5_000)
        if (highPriority) return
        highPriority = true
        attempt("requestConnectionPriority(HIGH)") {
            g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        }
    }

    // -- GATT callbacks -------------------------------------------------------

    /**
     * Every callback below hands straight over to the transport's handler
     * thread before touching any state. `connectGatt` was given that handler
     * and should already be using it, but a handful of stacks have historically
     * ignored the argument and called back on a binder thread - and the cost of
     * the extra hop is a nanosecond against a radio measured in milliseconds.
     */
    private val callback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(g: BluetoothGatt?, status: Int, newState: Int) {
            handler.post {
                when (newState) {
                    BluetoothGatt.STATE_CONNECTED -> {
                        if (status == BluetoothGatt.GATT_SUCCESS) {
                            onConnected()
                        } else {
                            teardown("connection failed with GATT status $status", failed = true)
                        }
                    }

                    BluetoothGatt.STATE_DISCONNECTED -> {
                        // Status 133 (GATT_ERROR) here is Android's catch-all and
                        // is common on a first attempt to a busy peer. We report
                        // it and stop: whether and when to try again is the
                        // connection state machine's decision in TypeScript, and
                        // a retry invented down here would fight with its backoff.
                        val reason = if (status == BluetoothGatt.GATT_SUCCESS) {
                            "the peer disconnected"
                        } else {
                            "disconnected with GATT status $status"
                        }
                        teardown(reason, failed = status != BluetoothGatt.GATT_SUCCESS)
                        releaseGatt()
                    }
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt?, status: Int) {
            handler.post { queue?.complete(GattOpKind.DISCOVER_SERVICES, status, null) }
        }

        override fun onMtuChanged(g: BluetoothGatt?, mtu: Int, status: Int) {
            handler.post {
                if (status == BluetoothGatt.GATT_SUCCESS && mtu >= BleWire.DEFAULT_ATT_MTU) {
                    attMtu = mtu.coerceAtMost(BleWire.MAX_ATT_MTU)
                    host.log("info", "ATT MTU is $attMtu (${attMtu - BleWire.ATT_HEADER_BYTES} usable)")
                    // An MTU exchange the peer started arrives here too, with
                    // nothing of ours in flight. Recording it before completing
                    // the queue entry means either origin updates the size.
                    link.refreshDatagramSize()
                }
                queue?.complete(GattOpKind.REQUEST_MTU, status, null)
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt?, descriptor: BluetoothGattDescriptor?, status: Int) {
            handler.post { queue?.complete(GattOpKind.WRITE_DESCRIPTOR, status, null) }
        }

        override fun onCharacteristicWrite(
            g: BluetoothGatt?,
            characteristic: BluetoothGattCharacteristic?,
            status: Int,
        ) {
            handler.post { queue?.complete(GattOpKind.WRITE_CHARACTERISTIC, status, null) }
        }

        override fun onReadRemoteRssi(g: BluetoothGatt?, rssi: Int, status: Int) {
            handler.post {
                if (status == BluetoothGatt.GATT_SUCCESS) link.updateRssi(rssi)
                queue?.complete(GattOpKind.READ_RSSI, status, null)
            }
        }

        // -- the API 33 callbacks, and their pre-33 shadows --------------------
        //
        // From API 33 the value arrives as an argument instead of being read
        // back off the shared characteristic object, which removes a real race:
        // the old shape hands you a mutable object whose contents the stack may
        // already have replaced. Below 33 there is no alternative, so the
        // deprecated overloads stay and delegate into the same handlers - the
        // migration shape Google documents. Exactly one of each pair is called
        // on any given device.

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            val copy = value.copyOf()
            handler.post { deliverNotification(characteristic, copy) }
        }

        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt?, characteristic: BluetoothGattCharacteristic?) {
            val target = characteristic ?: return
            val value = target.value?.copyOf() ?: return
            handler.post { deliverNotification(target, value) }
        }

        override fun onCharacteristicRead(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            val copy = value.copyOf()
            handler.post { queue?.complete(GattOpKind.READ_CHARACTERISTIC, status, copy) }
        }

        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun onCharacteristicRead(
            g: BluetoothGatt?,
            characteristic: BluetoothGattCharacteristic?,
            status: Int,
        ) {
            val value = characteristic?.value?.copyOf()
            handler.post { queue?.complete(GattOpKind.READ_CHARACTERISTIC, status, value) }
        }
    }

    private fun deliverNotification(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        if (characteristic.uuid != uuids.tx) return
        // One notification is one datagram. Boundaries are preserved by ATT
        // itself, so nothing is parsed, joined or split here.
        link.deliver(value)
    }

    // -- helpers --------------------------------------------------------------

    private fun statusToIssue(status: Int): GattIssue = when (status) {
        BluetoothStatusCodes.SUCCESS -> GattIssue.Accepted
        BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY -> GattIssue.Busy
        BluetoothStatusCodes.ERROR_MISSING_BLUETOOTH_CONNECT_PERMISSION ->
            GattIssue.Refused("the Bluetooth permission was withdrawn")
        BluetoothStatusCodes.ERROR_DEVICE_NOT_BONDED -> GattIssue.Refused("the peer requires pairing")
        BluetoothStatusCodes.ERROR_GATT_WRITE_NOT_ALLOWED -> GattIssue.Refused("the peer refuses writes")
        BluetoothStatusCodes.ERROR_PROFILE_SERVICE_NOT_BOUND ->
            GattIssue.Refused("the Bluetooth service is restarting")
        else -> GattIssue.Refused("Bluetooth status $status")
    }

    /**
     * Wraps a stack call that can throw. A revoked permission raises
     * SecurityException from inside the framework, and a device the stack has
     * already forgotten raises IllegalStateException; neither may be allowed to
     * kill the handler thread and take the radio with it.
     */
    private fun attemptTrue(what: String, block: () -> Boolean): Boolean =
        try {
            block()
        } catch (t: Throwable) {
            host.log("warn", "$what threw ${t.javaClass.simpleName}")
            false
        }

    private fun attempt(what: String, block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            host.log("warn", "$what threw ${t.javaClass.simpleName}")
        }
    }
}
