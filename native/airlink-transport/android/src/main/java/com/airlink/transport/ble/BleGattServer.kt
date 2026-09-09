package com.airlink.transport.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.ParcelUuid
import com.airlink.transport.LinkState

/**
 * The peripheral half: our own GATT service, our advertisement, and the links
 * that peers open to us.
 *
 * AirLink runs BOTH roles at once - advertising and scanning, server and
 * client - because two phones that both only scan never meet, and asking the
 * user which of them should be "the host" is exactly the kind of question this
 * product exists to avoid. Whichever side reaches the other first wins; the
 * layer above sees a link either way and cannot tell which role produced it.
 *
 * THE SERVICE
 *
 *   RX        write / write-no-response   the central writes datagrams to us
 *   TX        notify (+ CCCD)             we notify datagrams to the central
 *   identity  read                        our token, opt-in name, L2CAP PSM
 *
 * The direction of RX and TX is fixed by the protocol constants and is written
 * from the *peripheral's* point of view, which is why a central writes to RX
 * and subscribes to TX while we do the mirror image.
 *
 * FLOW CONTROL. A notification is not fire-and-forget on Android: the stack
 * accepts one at a time and reports each with `onNotificationSent`. Sending the
 * next before that arrives drops it, silently, exactly as with characteristic
 * writes on the central side. One outstanding notification per peer, always.
 */
@SuppressLint("MissingPermission", "NewApi")
internal class BleGattServer(
    private val context: Context,
    private val availability: BleAvailability,
    private val host: BleLinkHost,
    private val newLinkId: () -> String,
    private val onIncomingLink: (BleLink) -> Unit,
) {

    private val handler: Handler get() = host.handler

    private var uuids: BleWire.ServiceUuids? = null
    private var server: BluetoothGattServer? = null
    private var service: BluetoothGattService? = null
    private var rxCharacteristic: BluetoothGattCharacteristic? = null
    private var txCharacteristic: BluetoothGattCharacteristic? = null
    private var identityCharacteristic: BluetoothGattCharacteristic? = null
    private var serviceAdded = false

    private var advertising = false
    private var wantsAdvertising = false
    private var advertisingSet: AdvertisingSet? = null
    private var usingLegacyAdvertiser = false

    private var token: ByteArray = ByteArray(0)
    private var displayName: String = ""

    /** The bytes served from the identity characteristic. Rebuilt when anything in it changes. */
    private var identityValue: ByteArray = BleWire.encodeIdentity(0, ByteArray(0), "")

    private val peers = LinkedHashMap<String, ServerPeer>()

    private val l2capListener = L2capListener(
        handler = handler,
        onAccepted = { socket -> acceptL2cap(socket) },
        log = { level, message -> host.log(level, message) },
    )

    // -- lifecycle ------------------------------------------------------------

    /**
     * Opens the GATT server and registers the service.
     *
     * Called at `start()` rather than at `startAdvertising()`, so a peer that
     * already knows our address - one reconnecting after a walk out of range -
     * has something to connect to even while we are not advertising.
     */
    fun start(serviceUuids: BleWire.ServiceUuids) {
        uuids = serviceUuids
        ensureServer()
    }

    fun stop() {
        stopAdvertising()
        l2capListener.stop()

        peers.values.toList().forEach { it.link.close("the transport was stopped", failed = false) }
        peers.clear()

        val current = server
        server = null
        service = null
        rxCharacteristic = null
        txCharacteristic = null
        identityCharacteristic = null
        serviceAdded = false
        if (current != null) {
            try {
                current.clearServices()
                current.close()
            } catch (t: Throwable) {
                host.log("warn", "closing the GATT server threw ${t.javaClass.simpleName}")
            }
        }
        // Everything above is rebuilt by start(); the object is reusable.
    }

    private fun ensureServer(): Boolean {
        if (server != null) return true
        val ids = uuids ?: return false
        if (!availability.canConnect) {
            host.log("info", "no Bluetooth connect permission yet; the GATT server is not open")
            return false
        }
        if (!availability.isRadioOn) return false

        val manager = availability.manager ?: return false
        val opened = try {
            manager.openGattServer(context, serverCallback)
        } catch (t: Throwable) {
            host.log("warn", "openGattServer threw ${t.javaClass.simpleName}")
            null
        }
        if (opened == null) {
            host.log("warn", "the system refused a GATT server; incoming links are unavailable")
            return false
        }
        server = opened

        // The L2CAP listener has to exist before the identity value is built,
        // because the PSM it hands back is one of the fields in it.
        if (availability.canConnect) {
            val adapter = availability.adapter
            if (adapter != null) l2capListener.start(adapter)
        }
        rebuildIdentityValue()

        val rx = BluetoothGattCharacteristic(
            ids.rx,
            // Both write flavours: with-response is the ordered, acknowledged
            // path everything reliable uses, without-response is the lossy fast
            // path the realtime game channel asks for.
            BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            // PERMISSION_WRITE, not PERMISSION_WRITE_ENCRYPTED. Requiring
            // link-layer encryption would force a system pairing dialog - a
            // six-digit ceremony between two people who have already agreed to
            // talk - to protect a channel AirLink independently encrypts and
            // authenticates with SIGMA-I and ChaCha20-Poly1305. The bytes
            // crossing this characteristic are ciphertext.
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )

        val tx = BluetoothGattCharacteristic(
            ids.tx,
            // Notify rather than indicate. An indication is acknowledged at the
            // ATT layer and halves throughput; a notification is not, but the
            // LINK layer underneath still retransmits until the peer's
            // controller acknowledges it. So while a link reports connected,
            // notifications arrive in order and exactly once - which is what
            // the datagram contract actually asks for.
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            0,
        )
        tx.addDescriptor(
            BluetoothGattDescriptor(
                BleWire.CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            ),
        )

        val identity = ids.identity?.let {
            BluetoothGattCharacteristic(
                it,
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ,
            )
        }

        val built = BluetoothGattService(ids.service, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        built.addCharacteristic(rx)
        built.addCharacteristic(tx)
        identity?.let { built.addCharacteristic(it) }

        rxCharacteristic = rx
        txCharacteristic = tx
        identityCharacteristic = identity
        service = built

        val accepted = try {
            opened.addService(built)
        } catch (t: Throwable) {
            host.log("warn", "addService threw ${t.javaClass.simpleName}")
            false
        }
        if (!accepted) {
            host.log("error", "the GATT service was refused; incoming links are unavailable")
            return false
        }
        return true
    }

    // -- advertising ----------------------------------------------------------

    /**
     * @throws Throwable one of [BleErrors] when we cannot advertise at all -
     *   no permission, radio off, hardware that has no advertiser, or a token
     *   and name that will not fit in the 31 bytes a scan response has.
     */
    fun startAdvertising(token: ByteArray, displayName: String) {
        val ids = uuids ?: throw BleErrors.notStarted()
        if (!availability.isRadioOn) throw BleErrors.radioOff()
        if (!availability.canAdvertisePermission) throw BleErrors.permissionDenied()
        if (!availability.canAdvertise) {
            throw BleErrors.unsupported("Bluetooth advertising on this device")
        }

        // Validate the payload before changing any state, so a rejected call
        // leaves us advertising exactly what we were advertising before.
        val payload = try {
            BleWire.encodeAdvertisement(token, displayName)
        } catch (e: IllegalArgumentException) {
            throw BleErrors.failed(e.message ?: "the advertisement payload does not fit")
        }

        this.token = token.copyOf()
        this.displayName = displayName
        rebuildIdentityValue()

        wantsAdvertising = true
        if (!ensureServer()) throw BleErrors.failed("the GATT server could not be opened")
        if (!serviceAdded) {
            // onServiceAdded will start us; advertising a service that has not
            // finished registering invites peers to connect to nothing.
            host.log("debug", "advertising deferred until the GATT service is registered")
            return
        }
        beginAdvertising(ids, payload)
    }

    fun stopAdvertising() {
        wantsAdvertising = false
        if (!advertising) return
        advertising = false
        val advertiser = try {
            availability.adapter?.bluetoothLeAdvertiser
        } catch (_: Throwable) {
            null
        }
        try {
            if (usingLegacyAdvertiser) {
                advertiser?.stopAdvertising(legacyAdvertiseCallback)
            } else {
                advertiser?.stopAdvertisingSet(advertisingSetCallback)
            }
        } catch (t: Throwable) {
            host.log("debug", "stopping the advertiser threw ${t.javaClass.simpleName}")
        }
        advertisingSet = null
    }

    private fun beginAdvertising(ids: BleWire.ServiceUuids, payload: ByteArray) {
        val advertiser = try {
            availability.adapter?.bluetoothLeAdvertiser
        } catch (_: Throwable) {
            null
        } ?: throw BleErrors.unsupported("Bluetooth advertising on this device")

        stopAdvertising()
        wantsAdvertising = true

        val advertiseData = AdvertiseData.Builder()
            // The service UUID has to be in the advertisement itself, not the
            // scan response: it is what every scan filter matches on, and a
            // filter is mandatory for an iOS central scanning in the
            // background. Sixteen bytes of the thirty-one go here.
            .addServiceUuid(ParcelUuid(ids.service))
            // Never the system Bluetooth name. See BleWire.AdvertisementPayload.
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .build()

        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addManufacturerData(BleWire.MANUFACTURER_ID, payload)
            .build()

        val parameters = AdvertisingSetParameters.Builder()
            // Legacy mode, deliberately. Extended advertising is invisible to
            // an iPhone and to any Android peer whose controller predates it,
            // and this transport exists to reach both. The modern API is used
            // for what it is actually better at - a real callback carrying the
            // parameters the controller settled on - not for the extended
            // format.
            .setLegacyMode(true)
            .setConnectable(true)
            // Legacy connectable advertisements are ADV_IND, which is scannable
            // by definition; the stack rejects the combination outright if this
            // is false. It is also what carries our scan response.
            .setScannable(true)
            .setInterval(AdvertisingSetParameters.INTERVAL_LOW)
            // Discovery only runs while the user is looking at the screen, so
            // the battery cost is bounded by the session - and a peer that is
            // never found is a broken headline feature.
            .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_HIGH)
            .build()

        try {
            advertiser.startAdvertisingSet(
                parameters,
                advertiseData,
                scanResponse,
                null,
                null,
                advertisingSetCallback,
                handler,
            )
            usingLegacyAdvertiser = false
            advertising = true
        } catch (t: Throwable) {
            host.log("warn", "startAdvertisingSet threw ${t.javaClass.simpleName}; trying the legacy advertiser")
            startLegacyAdvertising(advertiseData, scanResponse)
        }
    }

    /**
     * The older `startAdvertising` path.
     *
     * Not deprecated, just older and blinder: it reports success or a numeric
     * failure and nothing about what the controller actually agreed to. It
     * exists here only as the fallback for a device whose stack refuses
     * advertising sets, which does happen on the long tail of Android 8 and 9
     * hardware this product still has to work on.
     */
    private fun startLegacyAdvertising(advertiseData: AdvertiseData, scanResponse: AdvertiseData) {
        val advertiser = try {
            availability.adapter?.bluetoothLeAdvertiser
        } catch (_: Throwable) {
            null
        } ?: return

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .setTimeout(0)
            .build()

        try {
            advertiser.startAdvertising(settings, advertiseData, scanResponse, legacyAdvertiseCallback)
            usingLegacyAdvertiser = true
            advertising = true
        } catch (t: Throwable) {
            host.log("error", "advertising failed entirely: ${t.javaClass.simpleName}")
            advertising = false
        }
    }

    private val advertisingSetCallback = object : AdvertisingSetCallback() {
        override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, status: Int) {
            handler.post {
                if (status == AdvertisingSetCallback.ADVERTISE_SUCCESS) {
                    advertisingSet = set
                    advertising = true
                    host.log("info", "advertising at ${txPower}dBm")
                    return@post
                }
                advertising = false
                host.log("warn", "startAdvertisingSet failed with status $status; falling back")
                val ids = uuids
                if (wantsAdvertising && ids != null) {
                    val payload = try {
                        BleWire.encodeAdvertisement(token, displayName)
                    } catch (_: IllegalArgumentException) {
                        return@post
                    }
                    startLegacyAdvertising(
                        AdvertiseData.Builder()
                            .addServiceUuid(ParcelUuid(ids.service))
                            .setIncludeDeviceName(false)
                            .setIncludeTxPowerLevel(false)
                            .build(),
                        AdvertiseData.Builder()
                            .setIncludeDeviceName(false)
                            .setIncludeTxPowerLevel(false)
                            .addManufacturerData(BleWire.MANUFACTURER_ID, payload)
                            .build(),
                    )
                }
            }
        }

        override fun onAdvertisingSetStopped(set: AdvertisingSet?) {
            handler.post {
                advertisingSet = null
                advertising = false
            }
        }
    }

    private val legacyAdvertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            handler.post { advertising = true }
        }

        override fun onStartFailure(errorCode: Int) {
            handler.post {
                advertising = false
                val detail = when (errorCode) {
                    AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE ->
                        "the advertisement does not fit in 31 bytes"
                    AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS ->
                        "too many apps are advertising"
                    AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> "already advertising"
                    AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR ->
                        "the Bluetooth stack reported an internal error"
                    AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "this device cannot advertise"
                    else -> "error $errorCode"
                }
                host.log("error", "advertising failed: $detail")
            }
        }
    }

    private fun rebuildIdentityValue() {
        identityValue = BleWire.encodeIdentity(l2capListener.psm, token, displayName)
    }

    // -- peers ----------------------------------------------------------------

    /**
     * One central connected to our GATT server.
     *
     * A connection is not yet a link. A peer becomes one when it subscribes to
     * TX, which is the only signal that says "I am an AirLink peer and I am
     * ready" - anything that connects and stays silent is dropped after
     * [BleTuning.SUBSCRIBE_GRACE_MS] rather than being allowed to sit on one of
     * the handful of connection slots the controller has.
     */
    private inner class ServerPeer(val device: BluetoothDevice, val address: String) {
        val link = BleLink(newLinkId(), address, device, incoming = true, host = host)

        var attMtu: Int = BleWire.DEFAULT_ATT_MTU
        var subscribed = false
        var opened = false

        /** True once this central has read our identity, so it knows our PSM. */
        var readOurIdentity = false

        /** An L2CAP channel that arrived before the subscription did. */
        var pendingSocket: BluetoothSocket? = null

        /** The one outstanding notification, waiting for onNotificationSent. */
        var notifyDone: ((Throwable?) -> Unit)? = null

        /** Bounded reassembly buffer for a GATT long write. Almost always unused. */
        var prepared: ByteArray = ByteArray(0)

        val subscribeTimeout = Runnable {
            if (!opened) {
                host.log("info", "dropping $address: connected but never subscribed")
                closePeer(this@ServerPeer, "the peer never subscribed", failed = true)
            }
        }

        val l2capGrace = Runnable { if (!opened) openOverGatt(this@ServerPeer) }

        val notifyTimeout = Runnable {
            val done = notifyDone
            notifyDone = null
            done?.invoke(BleErrors.failed("the notification was never acknowledged"))
        }
    }

    private fun closePeer(peer: ServerPeer, reason: String, failed: Boolean) {
        handler.removeCallbacks(peer.subscribeTimeout)
        handler.removeCallbacks(peer.l2capGrace)
        handler.removeCallbacks(peer.notifyTimeout)
        peers.remove(peer.address)
        L2cap.closeQuietly(peer.pendingSocket)
        peer.pendingSocket = null
        peer.link.close(reason, failed)
        try {
            server?.cancelConnection(peer.device)
        } catch (t: Throwable) {
            host.log("debug", "cancelConnection threw ${t.javaClass.simpleName}")
        }
    }

    private fun openOverGatt(peer: ServerPeer) {
        if (peer.opened) return
        val tx = txCharacteristic
        if (tx == null) {
            closePeer(peer, "the GATT service is not registered", failed = true)
            return
        }
        handler.removeCallbacks(peer.l2capGrace)
        handler.removeCallbacks(peer.subscribeTimeout)
        peer.opened = true
        peer.link.attach(NotifySender(peer, tx))
        peer.link.markOpen()
        host.log(
            "info",
            "incoming link ${peer.link.id} from ${peer.address} over ${peer.link.pathLabel()}, " +
                "${peer.link.maxDatagramSize} byte datagrams",
        )
        onIncomingLink(peer.link)
    }

    private fun openOverL2cap(peer: ServerPeer, socket: BluetoothSocket) {
        if (peer.opened) {
            L2cap.closeQuietly(socket)
            return
        }
        handler.removeCallbacks(peer.l2capGrace)
        handler.removeCallbacks(peer.subscribeTimeout)
        peer.opened = true
        val sender = L2capSender(
            socket = socket,
            handler = handler,
            onDatagram = { bytes -> peer.link.deliver(bytes) },
            onBroken = { reason -> closePeer(peer, reason, failed = true) },
            log = { level, message -> host.log(level, "[${peer.link.id}] $message") },
        )
        sender.start()
        peer.link.attach(sender)
        peer.link.markOpen()
        host.log(
            "info",
            "incoming link ${peer.link.id} from ${peer.address} over l2cap, " +
                "${peer.link.maxDatagramSize} byte datagrams",
        )
        onIncomingLink(peer.link)
    }

    private fun acceptL2cap(socket: BluetoothSocket) {
        val address = try {
            socket.remoteDevice?.address
        } catch (_: Throwable) {
            null
        }
        val peer = if (address == null) null else peers[address]

        if (peer == null) {
            // A channel from a device with no GATT connection to us. Nothing
            // sane produces this, and holding it would pin a controller
            // resource for a peer that will never use it.
            host.log("info", "unmatched L2CAP channel from ${address ?: "an unknown device"}; closed")
            L2cap.closeQuietly(socket)
            return
        }
        if (peer.opened) {
            // The grace period expired and the link already opened on GATT. It
            // stays there: swapping the path underneath a live link would race
            // datagrams already in flight, and the ordering guarantee is worth
            // more than the extra throughput.
            host.log("info", "late L2CAP channel from ${peer.address}; the link is already on GATT")
            L2cap.closeQuietly(socket)
            return
        }
        if (!peer.subscribed) {
            peer.pendingSocket = socket
            return
        }
        openOverL2cap(peer, socket)
    }

    // -- sending --------------------------------------------------------------

    /**
     * The peripheral's send path: one ATT notification per datagram, one
     * outstanding at a time, gated on `onNotificationSent`.
     *
     * `reliable` makes no difference here. There is no unacknowledged flavour
     * of a notification to choose - the fast path exists only on the central's
     * side, as write-without-response - so a realtime datagram takes the same
     * route and gets its best-effort behaviour from the link's queue policy
     * instead.
     */
    private inner class NotifySender(
        private val peer: ServerPeer,
        private val tx: BluetoothGattCharacteristic,
    ) : DatagramSender {

        override val maxDatagramSize: Int get() = peer.attMtu - BleWire.ATT_HEADER_BYTES

        override val label: String get() = "gatt-notify"

        override fun send(datagram: ByteArray, reliable: Boolean, onDone: (Throwable?) -> Unit) {
            val current = server
            if (current == null) {
                onDone(BleErrors.failed("the GATT server is closed"))
                return
            }
            if (peer.notifyDone != null) {
                // BleLink allows one datagram in flight per link, so this can
                // only mean a bug on our side rather than a busy radio.
                onDone(BleErrors.failed("a notification is already in flight"))
                return
            }

            peer.notifyDone = onDone
            handler.postDelayed(peer.notifyTimeout, BleTuning.GATT_OPERATION_TIMEOUT_MS)

            val accepted = try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    current.notifyCharacteristicChanged(peer.device, tx, false, datagram) ==
                        BluetoothStatusCodes.SUCCESS
                } else {
                    // The pre-33 API takes the value off the characteristic
                    // object, which is shared by every connected peer. Safe
                    // only because the set and the notify happen together, on
                    // the one handler thread that touches any of this.
                    @Suppress("DEPRECATION")
                    (tx.setValue(datagram) && current.notifyCharacteristicChanged(peer.device, tx, false))
                }
            } catch (t: Throwable) {
                host.log("warn", "notifyCharacteristicChanged threw ${t.javaClass.simpleName}")
                false
            }

            if (!accepted) {
                handler.removeCallbacks(peer.notifyTimeout)
                peer.notifyDone = null
                onDone(BleErrors.failed("the notification was refused by the stack"))
            }
        }

        override fun close() {
            // The connection belongs to the server, not to the sender.
        }
    }

    // -- GATT server callbacks -------------------------------------------------

    private val serverCallback = object : BluetoothGattServerCallback() {

        override fun onServiceAdded(status: Int, added: BluetoothGattService?) {
            handler.post {
                serviceAdded = status == BluetoothGatt.GATT_SUCCESS
                if (!serviceAdded) {
                    host.log("error", "the GATT service failed to register (status $status)")
                    return@post
                }
                host.log("debug", "GATT service registered")
                val ids = uuids
                if (wantsAdvertising && !advertising && ids != null) {
                    val payload = try {
                        BleWire.encodeAdvertisement(token, displayName)
                    } catch (_: IllegalArgumentException) {
                        return@post
                    }
                    try {
                        beginAdvertising(ids, payload)
                    } catch (t: Throwable) {
                        host.log("error", "advertising failed: ${t.message ?: t.javaClass.simpleName}")
                    }
                }
            }
        }

        override fun onConnectionStateChange(device: BluetoothDevice?, status: Int, newState: Int) {
            val target = device ?: return
            val address = try {
                target.address ?: return
            } catch (_: Throwable) {
                return
            }
            handler.post {
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        if (peers.containsKey(address)) return@post
                        val peer = ServerPeer(target, address)
                        peers[address] = peer
                        host.onLinkState(peer.link, LinkState.CONNECTING, "")
                        handler.postDelayed(peer.subscribeTimeout, BleTuning.SUBSCRIBE_GRACE_MS)
                    }

                    BluetoothProfile.STATE_DISCONNECTED -> {
                        val peer = peers[address] ?: return@post
                        closePeer(
                            peer,
                            if (status == BluetoothGatt.GATT_SUCCESS) {
                                "the peer disconnected"
                            } else {
                                "disconnected with GATT status $status"
                            },
                            failed = status != BluetoothGatt.GATT_SUCCESS,
                        )
                    }
                }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice?, mtu: Int) {
            val address = device?.address ?: return
            handler.post {
                val peer = peers[address] ?: return@post
                if (mtu < BleWire.DEFAULT_ATT_MTU) return@post
                peer.attMtu = mtu.coerceAtMost(BleWire.MAX_ATT_MTU)
                host.log("info", "ATT MTU for $address is ${peer.attMtu}")
                // The central drives the MTU exchange and may finish it after
                // the link is already open, so the new size is announced rather
                // than assumed to have been known all along.
                peer.link.refreshDatagramSize()
            }
        }

        override fun onNotificationSent(device: BluetoothDevice?, status: Int) {
            val address = device?.address ?: return
            handler.post {
                val peer = peers[address] ?: return@post
                handler.removeCallbacks(peer.notifyTimeout)
                val done = peer.notifyDone ?: return@post
                peer.notifyDone = null
                done(
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        null
                    } else {
                        BleErrors.failed("the notification failed with GATT status $status")
                    },
                )
            }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice?,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic?,
        ) {
            val target = device ?: return
            val address = try {
                target.address ?: return
            } catch (_: Throwable) {
                return
            }
            val uuid = characteristic?.uuid
            handler.post {
                val identityUuid = uuids?.identity
                if (identityUuid == null || uuid != identityUuid) {
                    respond(target, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null)
                    return@post
                }
                val value = identityValue
                if (offset < 0 || offset > value.size) {
                    respond(target, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
                    return@post
                }
                // A read longer than MTU-1 arrives as a series of blob reads at
                // increasing offsets; honouring `offset` is what makes them
                // reassemble correctly at the peer.
                peers[address]?.readOurIdentity = true
                respond(
                    target,
                    requestId,
                    BluetoothGatt.GATT_SUCCESS,
                    offset,
                    value.copyOfRange(offset, value.size),
                )
            }
        }

        override fun onDescriptorReadRequest(
            device: BluetoothDevice?,
            requestId: Int,
            offset: Int,
            descriptor: BluetoothGattDescriptor?,
        ) {
            val target = device ?: return
            val address = try {
                target.address ?: return
            } catch (_: Throwable) {
                return
            }
            val isCccd = descriptor?.uuid == BleWire.CCCD_UUID
            handler.post {
                if (!isCccd) {
                    respond(target, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null)
                    return@post
                }
                val subscribed = peers[address]?.subscribed == true
                val value = if (subscribed) {
                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                } else {
                    BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
                }
                if (offset < 0 || offset > value.size) {
                    respond(target, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
                } else {
                    respond(
                        target,
                        requestId,
                        BluetoothGatt.GATT_SUCCESS,
                        offset,
                        value.copyOfRange(offset, value.size),
                    )
                }
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice?,
            requestId: Int,
            descriptor: BluetoothGattDescriptor?,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            val target = device ?: return
            val address = try {
                target.address ?: return
            } catch (_: Throwable) {
                return
            }
            val isCccd = descriptor?.uuid == BleWire.CCCD_UUID
            val payload = value?.copyOf()
            handler.post {
                if (!isCccd) {
                    if (responseNeeded) {
                        respond(target, requestId, BluetoothGatt.GATT_WRITE_NOT_PERMITTED, offset, null)
                    }
                    return@post
                }
                if (responseNeeded) {
                    respond(
                        target,
                        requestId,
                        BluetoothGatt.GATT_SUCCESS,
                        offset,
                        if (preparedWrite) payload else null,
                    )
                }

                val peer = peers[address] ?: return@post
                // 0x0001 is notify, 0x0002 indicate; either means "start
                // sending". 0x0000 means the peer is switching us off.
                val enabling = payload != null &&
                    payload.size >= 2 &&
                    ((payload[0].toInt() and 0x03) != 0)

                if (!enabling) {
                    peer.subscribed = false
                    if (peer.opened) {
                        closePeer(peer, "the peer unsubscribed", failed = false)
                    }
                    return@post
                }

                if (peer.subscribed) return@post
                peer.subscribed = true
                handler.removeCallbacks(peer.subscribeTimeout)

                val waiting = peer.pendingSocket
                if (waiting != null) {
                    peer.pendingSocket = null
                    openOverL2cap(peer, waiting)
                    return@post
                }

                // The only honest signal that this central intends an L2CAP
                // upgrade is that it has already read our identity, and so
                // knows our PSM. When it has, wait briefly for the channel;
                // when it has not, open on GATT immediately rather than make
                // every peer that will never upgrade pay for the ones that
                // might. See the ordering note in CentralConnection.
                if (l2capListener.psm != 0 && peer.readOurIdentity) {
                    handler.postDelayed(peer.l2capGrace, BleTuning.L2CAP_ACCEPT_GRACE_MS)
                } else {
                    openOverGatt(peer)
                }
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice?,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic?,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            val target = device ?: return
            val address = try {
                target.address ?: return
            } catch (_: Throwable) {
                return
            }
            val uuid = characteristic?.uuid
            // Copied immediately: the array the framework hands us is not
            // guaranteed to outlive this callback, and it is about to cross a
            // thread.
            val payload = value?.copyOf() ?: ByteArray(0)

            handler.post {
                val rxUuid = uuids?.rx
                if (rxUuid == null || uuid != rxUuid) {
                    if (responseNeeded) {
                        respond(target, requestId, BluetoothGatt.GATT_WRITE_NOT_PERMITTED, offset, null)
                    }
                    return@post
                }
                val peer = peers[address]
                if (peer == null) {
                    if (responseNeeded) {
                        respond(target, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
                    }
                    return@post
                }

                if (preparedWrite) {
                    // A "long write": the peer splits one value across several
                    // prepared writes and then commits them. We never ask a peer
                    // to do this - maxDatagramSize is advertised precisely so it
                    // does not have to - but a peer that does must not be able to
                    // prepare writes until we run out of heap, and must not
                    // silently lose the tail.
                    val misaligned = offset != peer.prepared.size
                    val tooLong =
                        peer.prepared.size + payload.size > BleTuning.MAX_PREPARED_WRITE_BYTES
                    if (misaligned || tooLong) {
                        peer.prepared = ByteArray(0)
                        if (responseNeeded) {
                            respond(
                                target,
                                requestId,
                                if (misaligned) {
                                    BluetoothGatt.GATT_INVALID_OFFSET
                                } else {
                                    BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH
                                },
                                offset,
                                null,
                            )
                        }
                        return@post
                    }
                    peer.prepared = peer.prepared + payload
                    if (responseNeeded) {
                        // The prepare-write response echoes the value, per ATT.
                        respond(target, requestId, BluetoothGatt.GATT_SUCCESS, offset, payload)
                    }
                    return@post
                }

                if (offset != 0) {
                    if (responseNeeded) {
                        respond(target, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
                    }
                    return@post
                }

                // Answer before delivering. The peer's next write is waiting on
                // this response, and the layer above may take a moment with the
                // datagram; making it wait would halve throughput.
                if (responseNeeded) {
                    respond(target, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                }
                if (!peer.opened) {
                    // A datagram before the subscription that opens the link has
                    // nowhere to go: JavaScript has never been told this link
                    // exists, so an onData for it would be an event about
                    // nothing. Acknowledged on the wire, dropped here, counted
                    // nowhere - and no correct peer sends one.
                    host.log("warn", "datagram from $address before the link opened; dropped")
                    return@post
                }
                // One ATT write is one datagram. Nothing is parsed, joined or
                // split - the boundary came from the protocol below us.
                peer.link.deliver(payload)
            }
        }

        override fun onExecuteWrite(device: BluetoothDevice?, requestId: Int, execute: Boolean) {
            val target = device ?: return
            val address = try {
                target.address ?: return
            } catch (_: Throwable) {
                return
            }
            handler.post {
                val peer = peers[address]
                val assembled = peer?.prepared ?: ByteArray(0)
                peer?.prepared = ByteArray(0)
                respond(target, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                if (execute && assembled.isNotEmpty() && peer != null && peer.opened) {
                    peer.link.deliver(assembled)
                }
            }
        }
    }

    private fun respond(device: BluetoothDevice, requestId: Int, status: Int, offset: Int, value: ByteArray?) {
        try {
            server?.sendResponse(device, requestId, status, offset, value)
        } catch (t: Throwable) {
            host.log("debug", "sendResponse threw ${t.javaClass.simpleName}")
        }
    }

    // -- accessors used by the transport --------------------------------------

    val publishedPsm: Int get() = l2capListener.psm

    val isAdvertising: Boolean get() = advertising

    fun links(): List<BleLink> = peers.values.map { it.link }

    fun close(linkId: String, reason: String): Boolean {
        val peer = peers.values.firstOrNull { it.link.id == linkId } ?: return false
        closePeer(peer, reason, failed = false)
        return true
    }
}
