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

    /**
     * Captured once rather than fetched per use, and that is deliberate.
     *
     * The transport ends its handler thread in `stop()`. A GATT server callback
     * can still arrive after that - the stack takes its time letting go - and
     * asking the host for a handler at that moment would build a whole new
     * thread to run work for a transport that has already shut down. Holding
     * the original means a late post simply returns false and the message is
     * dropped, which is exactly what should happen to it.
     */
    private val handler: Handler = host.handler

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

        // closePeer rather than link.close, so every pending timer is cancelled
        // as well: a grace period left armed would fire minutes later against a
        // peer this object no longer knows about.
        peers.values.toList().forEach { closePeer(it, "the transport was stopped", failed = false) }
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
            // Everything is torn back down rather than left half-built. A
            // server object with no service on it looks healthy to every check
            // in this file, so keeping one would mean `startAdvertising` waited
            // forever for an onServiceAdded that is never coming - and the only
            // symptom would be a phone nobody can find.
            host.log("error", "the GATT service was refused; incoming links are unavailable")
            server = null
            service = null
            rxCharacteristic = null
            txCharacteristic = null
            identityCharacteristic = null
            try {
                opened.close()
            } catch (t: Throwable) {
                host.log("debug", "closing the refused GATT server threw ${t.javaClass.simpleName}")
            }
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

        // Validate the token before changing any state, so a rejected call
        // leaves us advertising exactly what we were advertising before.
        val advertised = try {
            BleWire.encodeAdvertisedToken(token)
        } catch (e: IllegalArgumentException) {
            throw BleErrors.failed(e.message ?: "the advertisement token does not fit")
        }

        this.token = advertised
        // The name is NOT part of the advertisement - there is no room for it
        // next to a 128-bit service UUID, and Android cannot broadcast an
        // arbitrary one anyway. It is served from the identity characteristic,
        // so any length the user chooses is safe here: a long name can never be
        // the reason a phone fails to advertise.
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
        beginAdvertising(ids)
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
            if (usingLegacyAdvertiser || !ADVERTISING_SETS_AVAILABLE) {
                advertiser?.stopAdvertising(legacyAdvertiseCallback)
            } else {
                advertiser?.stopAdvertisingSet(advertisingSetCallback)
            }
        } catch (t: Throwable) {
            host.log("debug", "stopping the advertiser threw ${t.javaClass.simpleName}")
        }
        advertisingSet = null
    }

    /**
     * The two 31-byte structures, built in one place because the split between
     * them is load bearing. See the budget arithmetic in [BleWire].
     */
    private fun buildAdvertiseData(ids: BleWire.ServiceUuids): Pair<AdvertiseData, AdvertiseData> {
        val advertisement = AdvertiseData.Builder()
            // The service UUID has to be in the advertisement itself, not the
            // scan response: it is what every scan filter matches on, and a
            // filter is mandatory for an iOS central scanning in the
            // background. Eighteen bytes of the thirty-one go here.
            .addServiceUuid(ParcelUuid(ids.service))
            // Never the system Bluetooth name. See the note in BleWire.
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .build()

        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .apply {
                // Service data under our own UUID, holding the raw token and
                // nothing else - the one layout CoreBluetooth can read. Omitted
                // entirely rather than sent empty when there is no token, so a
                // scanner sees "no token" instead of "a zero-length one".
                if (token.isNotEmpty()) addServiceData(ParcelUuid(ids.service), token)
            }
            .build()

        return advertisement to scanResponse
    }

    private fun beginAdvertising(ids: BleWire.ServiceUuids) {
        val advertiser = try {
            availability.adapter?.bluetoothLeAdvertiser
        } catch (_: Throwable) {
            null
        } ?: throw BleErrors.unsupported("Bluetooth advertising on this device")

        stopAdvertising()
        wantsAdvertising = true

        val (advertiseData, scanResponse) = buildAdvertiseData(ids)

        // The whole advertising-set API - the parameters, the callback and
        // `startAdvertisingSet` itself - is API 26. This module's minSdk is
        // resolved from the host project, which sets 24, so the version has to
        // be checked at runtime rather than assumed: on API 24 and 25 merely
        // *constructing* the callback below would raise NoClassDefFoundError and
        // take the whole GATT server down with it.
        if (!ADVERTISING_SETS_AVAILABLE) {
            startLegacyAdvertising(advertiseData, scanResponse)
            return
        }

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

    /**
     * LAZY, and that is load bearing on API 24 and 25.
     *
     * `AdvertisingSetCallback` does not exist before API 26. An anonymous
     * subclass of it in a property *initializer* would be loaded - and fail to
     * resolve its superclass - the moment a `BleGattServer` is constructed,
     * which happens on every device the moment the transport starts. Deferring
     * it means the class is only ever touched behind
     * [ADVERTISING_SETS_AVAILABLE], and an old device quietly uses the legacy
     * advertiser instead of losing Bluetooth altogether.
     */
    private val advertisingSetCallback: AdvertisingSetCallback by lazy { newAdvertisingSetCallback() }

    private fun newAdvertisingSetCallback(): AdvertisingSetCallback = object : AdvertisingSetCallback() {
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
                    val (advertisement, scanResponse) = buildAdvertiseData(ids)
                    startLegacyAdvertising(advertisement, scanResponse)
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

        /**
         * Datagrams this peer wrote to us before its link opened, in order.
         *
         * An iOS central starts writing the moment its subscription is
         * confirmed, while we are still waiting for the L2CAP channel it is
         * about to dial. See [BleTuning.MAX_PREOPEN_INBOUND_DATAGRAMS].
         */
        val held = ArrayDeque<ByteArray>()
        var heldBytes: Int = 0

        /**
         * Notifications we gave up waiting for, whose `onNotificationSent` the
         * stack still owes us.
         *
         * Exactly the hazard [GattOperationQueue.abandoned] exists for, on the
         * peripheral's side of the radio: without this, a late acknowledgement
         * completes the NEXT notification, so a datagram the stack never
         * accepted is reported as sent. That is the one failure the datagram
         * contract forbids outright - loss that is never signalled.
         */
        var abandonedNotifications: Int = 0

        /**
         * Notify timeouts in a row, for the same reason
         * [BleTuning.WEDGED_OPERATION_TIMEOUTS] exists on the central's queue.
         *
         * When the stack has genuinely lost an acknowledgement rather than
         * merely delayed it, the ghost above is never claimed and every
         * subsequent notification's real acknowledgement is swallowed by it. A
         * link in that state is not slow, it is finished - and saying so lets
         * the session above reconnect instead of watching every datagram take
         * ten seconds and fail.
         */
        var consecutiveNotifyTimeouts: Int = 0

        /** True when [payload] fits the pre-open hold and has been taken. */
        fun hold(payload: ByteArray): Boolean {
            if (held.size >= BleTuning.MAX_PREOPEN_INBOUND_DATAGRAMS) return false
            if (heldBytes + payload.size > BleTuning.MAX_PREOPEN_INBOUND_BYTES) return false
            held.addLast(payload)
            heldBytes += payload.size
            return true
        }

        val subscribeTimeout = Runnable {
            if (!opened) {
                host.log("info", "dropping $address: connected but never subscribed")
                closePeer(this@ServerPeer, "the peer never subscribed", failed = true)
            }
        }

        val l2capGrace = Runnable { if (!opened) openOverGatt(this@ServerPeer) }

        /**
         * The shorter of the two waits: this peer has subscribed but has not
         * read our identity yet, so we do not know whether it is the kind of
         * peer that upgrades. See [awaitFastPath].
         *
         * A separate object from [l2capGrace] even though the two do the same
         * thing, because `Handler.removeCallbacks` matches on identity: folding
         * them into one would make cancelling the short wait also cancel the
         * long one it was just promoted to, and the link would open on GATT the
         * instant the identity read landed.
         */
        val identityGrace = Runnable { if (!opened) openOverGatt(this@ServerPeer) }

        val notifyTimeout = Runnable {
            val done = notifyDone
            notifyDone = null
            if (done != null) {
                // The stack still owes this notification an acknowledgement and
                // may yet deliver it. Recorded so it cannot be mistaken for the
                // next notification's. See [abandonedNotifications].
                abandonedNotifications++
                consecutiveNotifyTimeouts++
                done.invoke(BleErrors.failed("the notification was never acknowledged"))
                if (consecutiveNotifyTimeouts >= BleTuning.WEDGED_OPERATION_TIMEOUTS) {
                    closePeer(this@ServerPeer, "notifications stopped being acknowledged", failed = true)
                }
            }
        }
    }

    private fun closePeer(peer: ServerPeer, reason: String, failed: Boolean) {
        handler.removeCallbacks(peer.subscribeTimeout)
        handler.removeCallbacks(peer.l2capGrace)
        handler.removeCallbacks(peer.identityGrace)
        handler.removeCallbacks(peer.notifyTimeout)
        peers.remove(peer.address)
        L2cap.closeQuietly(peer.pendingSocket)
        peer.pendingSocket = null
        // Anything still held never reached JavaScript and never will: the link
        // is closing and no `onData` may follow a `closed` state.
        peer.held.clear()
        peer.heldBytes = 0
        peer.link.close(reason, failed)
        try {
            server?.cancelConnection(peer.device)
        } catch (t: Throwable) {
            host.log("debug", "cancelConnection threw ${t.javaClass.simpleName}")
        }
    }

    /**
     * Decides how long, if at all, to hold a freshly subscribed peer before
     * opening its link on GATT.
     *
     * THE PROBLEM THIS SOLVES, and it is the difference between the L2CAP
     * upgrade working in one direction and in both.
     *
     * A peripheral cannot ask a central whether it intends to upgrade -
     * negotiating that in band would be protocol knowledge, which this layer is
     * not allowed to hold - so all it has is the order of the operations the
     * central performs. The two platforms do them in different orders, and both
     * are defensible:
     *
     *   Android central   reads identity, THEN subscribes. By the time we get
     *                     here it already knows our PSM, so a channel is very
     *                     likely on its way: wait the full grace.
     *   iOS central       subscribes, THEN reads identity, because it opens its
     *                     link immediately and treats the upgrade as something
     *                     that arrives afterwards. So at this moment it has no
     *                     idea we have a PSM at all.
     *
     * Opening on GATT immediately, as the obvious implementation does, means
     * every iPhone-to-Android link is stuck on GATT forever - the iPhone dials
     * a moment later and finds a link that has already committed to the slow
     * path. Waiting the full grace for everybody instead would add seconds to
     * every incoming connection from a peer that was never going to upgrade.
     *
     * So there are two waits. A peer that has read our identity gets the long
     * one. A peer that has not gets a short one, and the identity read - if it
     * comes, which for any real AirLink peer it does within a few milliseconds
     * of subscribing - promotes it to the long one. A peer that never reads
     * identity pays [BleTuning.IDENTITY_READ_GRACE_MS] once and nothing else.
     */
    private fun awaitFastPath(peer: ServerPeer) {
        if (peer.opened) return
        if (l2capListener.psm == 0) {
            openOverGatt(peer)
            return
        }
        handler.removeCallbacks(peer.identityGrace)
        handler.removeCallbacks(peer.l2capGrace)
        if (peer.readOurIdentity) {
            handler.postDelayed(peer.l2capGrace, BleTuning.L2CAP_ACCEPT_GRACE_MS)
        } else {
            handler.postDelayed(peer.identityGrace, BleTuning.IDENTITY_READ_GRACE_MS)
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
        handler.removeCallbacks(peer.identityGrace)
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
        flushHeld(peer)
    }

    private fun openOverL2cap(peer: ServerPeer, socket: BluetoothSocket) {
        if (peer.opened) {
            L2cap.closeQuietly(socket)
            return
        }
        handler.removeCallbacks(peer.l2capGrace)
        handler.removeCallbacks(peer.identityGrace)
        handler.removeCallbacks(peer.subscribeTimeout)
        peer.opened = true
        val sender = L2capSender(
            socket = socket,
            handler = handler,
            onDatagram = { bytes -> peer.link.deliver(bytes) },
            onBroken = { reason -> closePeer(peer, reason, failed = true) },
            log = { level, message -> host.log(level, "[${peer.link.id}] $message") },
        )
        peer.link.attach(sender)
        peer.link.markOpen()
        host.log(
            "info",
            "incoming link ${peer.link.id} from ${peer.address} over l2cap, " +
                "${peer.link.maxDatagramSize} byte datagrams",
        )
        onIncomingLink(peer.link)
        // The held GATT datagrams are delivered BEFORE the reader thread is
        // started, so nothing that arrives on the channel can overtake a
        // datagram the peer wrote earlier over ATT. The central drains its own
        // ATT queue before adopting the channel, so this preserves the order the
        // peer sent them in.
        flushHeld(peer)
        sender.start()
    }

    /**
     * Delivers, in order, every datagram this peer wrote before its link opened.
     *
     * Called after `markOpen` on purpose: `onLinkOpened` has already reached
     * JavaScript by then, so these arrive as data on a link it knows about
     * rather than as events about nothing.
     */
    private fun flushHeld(peer: ServerPeer) {
        if (peer.held.isEmpty()) return
        host.log(
            "debug",
            "delivering ${peer.held.size} datagram(s) held from ${peer.address} before the link opened",
        )
        while (true) {
            val next = peer.held.removeFirstOrNull() ?: break
            peer.heldBytes -= next.size
            peer.link.deliver(next)
        }
        peer.heldBytes = 0
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
                    // `confirm = false` is a notification rather than an
                    // indication: no ATT acknowledgement, twice the throughput,
                    // and the link layer underneath still retransmits until the
                    // peer's controller has it. BluetoothStatusCodes.SUCCESS is
                    // a Java compile-time constant, so it is folded into a
                    // literal here and the API 33 class is never referenced at
                    // runtime on an older device.
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
                    try {
                        beginAdvertising(ids)
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
                // A ghost is claimed BEFORE anything in flight can be mistaken
                // for its owner, and before the live timeout is cancelled: this
                // acknowledgement belongs to a notification we already failed,
                // not to the one waiting now.
                if (peer.abandonedNotifications > 0) {
                    peer.abandonedNotifications--
                    host.log("debug", "late notification acknowledgement from $address; ignored")
                    return@post
                }
                handler.removeCallbacks(peer.notifyTimeout)
                peer.consecutiveNotifyTimeouts = 0
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
                peers[address]?.let { peer ->
                    val first = !peer.readOurIdentity
                    peer.readOurIdentity = true
                    // Only the first read of a record promotes the wait. A blob
                    // read at a later offset is the same read continuing, and
                    // restarting the grace on each one would let a peer stretch
                    // it indefinitely.
                    if (first && peer.subscribed && !peer.opened) awaitFastPath(peer)
                }
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

                awaitFastPath(peer)
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
                // An empty ATT write is not a datagram - `deliver` ignores one
                // anyway - and discarding it here is also what stops a peer
                // filling the pre-open hold below with nothing.
                if (payload.isEmpty()) return@post
                if (!peer.opened) {
                    // HELD, NOT DROPPED, and this is the whole of iPhone-to-
                    // Android working at all.
                    //
                    // An iOS central opens its link the instant its subscription
                    // is confirmed and writes its first datagram immediately;
                    // the L2CAP upgrade is something it arranges afterwards. We
                    // are still inside awaitFastPath at that moment, holding the
                    // connection for the channel that iPhone is about to dial.
                    // Discarding the write here - acknowledged on the wire, so
                    // the iPhone is told it was sent - loses the datagram that
                    // starts the session, every time, in one direction only.
                    //
                    // So it waits, in order, and flushHeld delivers it the
                    // moment the path is settled.
                    if (peer.hold(payload)) return@post

                    // The hold is full: this peer is plainly mid-conversation,
                    // so there is nothing left to gain by waiting for a channel
                    // that has not arrived. Opening on GATT flushes everything
                    // held, in order, ahead of this datagram.
                    host.log(
                        "warn",
                        "$address filled the pre-open buffer; opening ${peer.link.id} on GATT now",
                    )
                    openOverGatt(peer)
                    if (!peer.opened) {
                        // openOverGatt could not open it - no registered service
                        // - and has already closed the peer.
                        return@post
                    }
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
                if (!execute || assembled.isEmpty() || peer == null) return@post
                if (peer.opened) {
                    peer.link.deliver(assembled)
                } else if (!peer.hold(assembled)) {
                    // Same reasoning as the ordinary write above; a long write
                    // that arrives before the link opens is held, not dropped.
                    openOverGatt(peer)
                    if (peer.opened) peer.link.deliver(assembled)
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

    private companion object {
        /**
         * Whether `BluetoothLeAdvertiser.startAdvertisingSet` and the
         * `AdvertisingSet*` types exist on this device: they are all API 26.
         *
         * This module's `minSdk` is resolved from the host project rather than
         * pinned here, and the app sets 24 - so "the library was written for 26"
         * is not something the compiler enforces and cannot be relied on. Every
         * use of the advertising-set API therefore sits behind this.
         */
        val ADVERTISING_SETS_AVAILABLE: Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
    }
}
