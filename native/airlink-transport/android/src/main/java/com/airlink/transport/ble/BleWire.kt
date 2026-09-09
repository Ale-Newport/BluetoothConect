package com.airlink.transport.ble

import java.util.UUID

/**
 * Everything two AirLink phones must agree on byte for byte before either of
 * them can say a word over Bluetooth: which UUIDs the GATT service uses, what
 * the 31-byte advertisement carries, what the identity characteristic returns,
 * and how a datagram is framed once it is riding a byte stream (L2CAP) rather
 * than a self-delimiting ATT packet.
 *
 * NOTHING HERE IS PROTOCOL KNOWLEDGE. These are transport-level records - the
 * BLE equivalent of a TCP port number and a DNS-SD TXT record. The datagrams
 * that travel over the link are opaque to every line of this package: no
 * header is added to them, no byte of them is read. Encryption, sequencing,
 * fragmentation and every feature live in TypeScript.
 *
 * The iOS CoreBluetooth transport mirrors this file. Changing any layout here
 * is a wire change that breaks iPhone-to-Android, which is the whole product.
 */
internal object BleWire {

    // -- GATT service shape ---------------------------------------------------

    /**
     * Client Characteristic Configuration descriptor, the standard 0x2902.
     *
     * Writing 0x0001 to it is what actually turns notifications on over the
     * air. `setCharacteristicNotification()` only routes them locally inside
     * the Android stack - forgetting the descriptor write is the single most
     * common Android BLE bug, and it fails silently.
     */
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")

    /** ATT opcode (1 byte) + attribute handle (2 bytes). One ATT payload is MTU - 3. */
    const val ATT_HEADER_BYTES: Int = 3

    /** What every LE connection starts at until an MTU exchange succeeds: 20 usable bytes. */
    const val DEFAULT_ATT_MTU: Int = 23

    /**
     * The largest MTU `BluetoothGatt.requestMtu` accepts. We always ask for it
     * and always use whatever we are given back: iOS answers with something in
     * the 180s, a cheap Android peer may answer 23, and assuming either number
     * silently truncates datagrams.
     */
    const val MAX_ATT_MTU: Int = 517

    /**
     * Derives the three characteristic UUIDs from the service UUID.
     *
     * The TurboModule contract hands the native layer a service UUID plus the
     * RX and TX characteristic UUIDs, but not the identity one - and the
     * contract is frozen. The protocol constants define all four as
     * consecutive: service, service+1 (RX), service+2 (TX), service+3
     * (identity), differing only in the top 32 bits. So the identity UUID is
     * derived, and the derivation is *checked* against the RX and TX UUIDs we
     * were actually given. If a future protocol version breaks the pattern the
     * check fires, the identity characteristic is dropped (costing the L2CAP
     * upgrade and the readable display name, not the link), and the fix is to
     * widen the bridge contract rather than to guess here.
     */
    data class ServiceUuids(
        val service: UUID,
        val rx: UUID,
        val tx: UUID,
        val identity: UUID?,
    ) {
        companion object {
            fun from(service: String, rx: String, tx: String): ServiceUuids {
                val serviceUuid = UUID.fromString(service)
                val rxUuid = UUID.fromString(rx)
                val txUuid = UUID.fromString(tx)
                val consecutive =
                    rxUuid == offset(serviceUuid, 1) && txUuid == offset(serviceUuid, 2)
                return ServiceUuids(
                    service = serviceUuid,
                    rx = rxUuid,
                    tx = txUuid,
                    identity = if (consecutive) offset(serviceUuid, 3) else null,
                )
            }

            private fun offset(base: UUID, by: Int): UUID =
                UUID(base.mostSignificantBits + by, base.leastSignificantBits)
        }
    }

    // -- The advertisement ----------------------------------------------------

    /**
     * Manufacturer identifier used for the AirLink advertisement blob.
     *
     * 0xFFFF is the Bluetooth SIG's reserved "internal and interoperability
     * test" company identifier: it belongs to nobody, so anybody may use it and
     * anybody may collide with it. That is acceptable precisely because the
     * blob is treated as untrusted hint data - a malformed or foreign blob
     * yields an empty token and nothing else changes. If AirLink is ever
     * assigned a real Company Identifier, this constant is the only line that
     * changes on Android.
     */
    const val MANUFACTURER_ID: Int = 0xFFFF

    /** Format byte, so a future layout change is detectable rather than misparsed. */
    private const val ADVERTISEMENT_VERSION: Byte = 1

    /**
     * A legacy BLE advertisement is 31 bytes and the scan response is another
     * 31. The 128-bit service UUID alone costs 18 of the first budget (2 header
     * + 16 UUID) on top of the 3-byte flags structure the controller inserts
     * for a connectable advertisement, which leaves 10 bytes - too tight to
     * hold a token and a name and still have room to grow.
     *
     * So the service UUID goes in the advertisement (that is what a scan filter
     * matches on, and it MUST be there) and everything else goes in the scan
     * response. Cost: a scan-request/scan-response round trip per sighting,
     * which is why the advertisement is left scannable.
     */
    private const val SCAN_RESPONSE_BUDGET: Int = 31

    /** 1 byte length + 1 byte AD type + 2 bytes little-endian company identifier. */
    private const val MANUFACTURER_AD_OVERHEAD: Int = 4

    /** Payload bytes available to us inside the manufacturer-data structure. */
    const val ADVERTISEMENT_PAYLOAD_BUDGET: Int = SCAN_RESPONSE_BUDGET - MANUFACTURER_AD_OVERHEAD

    /**
     * The rotating advertisement token, capped. The protocol uses 6 bytes; the
     * cap exists so a caller cannot quietly overflow the advertisement budget.
     */
    const val MAX_TOKEN_BYTES: Int = 16

    /**
     * What we broadcast, and what we read back off a peer's advertisement.
     *
     *      0        1        2                 2 + tokenLength
     *      +--------+--------+=================+==============+
     *      | version| tokLen |      token      | name (UTF-8) |
     *      +--------+--------+=================+==============+
     *
     * The name runs to the end of the structure - there is no second length,
     * because there is nothing after it and a byte of budget is a byte of name.
     *
     * WHY THE NAME IS HERE AT ALL. Android cannot put an arbitrary string in a
     * BLE local name: `AdvertiseData.setIncludeDeviceName` broadcasts the
     * *system* Bluetooth name ("Sam's Pixel"), which is a durable identifier
     * the user never agreed to publish, and AirLink promises that nothing on
     * the wire is derived from the device. So the opt-in display name travels
     * in our own blob, and `setIncludeDeviceName` is never enabled. iOS, which
     * has the opposite restriction - it may advertise a local name and may not
     * advertise manufacturer data - publishes its name as the BLE local name
     * instead, so a scanner has to look in both places. It does.
     */
    class AdvertisementPayload(val token: ByteArray, val name: String)

    /**
     * @throws IllegalArgumentException when the token or name cannot fit. Never
     *   truncates: a truncated token is a token that matches nobody, and
     *   failing at `startAdvertising` is a bug the developer sees immediately
     *   rather than a phone that is mysteriously invisible.
     */
    fun encodeAdvertisement(token: ByteArray, name: String): ByteArray {
        require(token.size <= MAX_TOKEN_BYTES) {
            "advertisement token of ${token.size} bytes exceeds the $MAX_TOKEN_BYTES byte limit"
        }
        val nameBytes = name.encodeToByteArray()
        val total = 2 + token.size + nameBytes.size
        require(total <= ADVERTISEMENT_PAYLOAD_BUDGET) {
            "advertisement payload of $total bytes exceeds the $ADVERTISEMENT_PAYLOAD_BUDGET byte scan-response budget"
        }
        val out = ByteArray(total)
        out[0] = ADVERTISEMENT_VERSION
        out[1] = token.size.toByte()
        token.copyInto(out, 2)
        nameBytes.copyInto(out, 2 + token.size)
        return out
    }

    /**
     * Parses a peer's blob. Every field is attacker-controlled, so this returns
     * an empty payload rather than throwing for anything it does not like: a
     * neighbouring app using 0xFFFF for its own purposes must cost us a
     * discarded scan result, never an exception on the scan callback thread.
     */
    fun decodeAdvertisement(raw: ByteArray?): AdvertisementPayload {
        val empty = AdvertisementPayload(ByteArray(0), "")
        if (raw == null || raw.size < 2) return empty
        if (raw[0] != ADVERTISEMENT_VERSION) return empty
        val tokenLength = raw[1].toInt() and 0xFF
        if (tokenLength > MAX_TOKEN_BYTES || 2 + tokenLength > raw.size) return empty
        val token = raw.copyOfRange(2, 2 + tokenLength)
        val name = decodeName(raw, 2 + tokenLength, raw.size)
        return AdvertisementPayload(token, name)
    }

    // -- The identity characteristic ------------------------------------------

    /** Format byte for the identity record; independent of the advertisement's. */
    private const val IDENTITY_VERSION: Byte = 1

    private const val IDENTITY_FLAG_HAS_PSM: Int = 1 shl 0

    /**
     * Hard ceiling on a display name, in UTF-8 bytes, wherever it appears. Long
     * enough for a real name, short enough that a peer cannot use the identity
     * read to push a megabyte of string into a picker row.
     */
    const val MAX_NAME_BYTES: Int = 48

    /**
     * The read-only identity characteristic: the same two fields the
     * advertisement carries, plus the one thing that cannot be advertised.
     *
     *      0        1        2        3        4                  5 + tokLen
     *      +--------+--------+--------+--------+--------+=========+=========+
     *      | version| flags  |    L2CAP PSM    | tokLen |  token  |  name   |
     *      +--------+--------+--------+--------+--------+=========+=========+
     *                        |<-- big-endian ->|
     *
     * WHY THE PSM IS HERE. An L2CAP connection-oriented channel needs a PSM,
     * the PSM is assigned dynamically by the stack at listen time, and BLE has
     * no other way to publish a dynamic number to a peer that has not connected
     * yet. Both platforms do it this way; it is the only route to an L2CAP
     * upgrade that works iPhone-to-Android. A peer that publishes no PSM, or a
     * record we cannot parse, simply means no upgrade - GATT carries on.
     */
    class IdentityRecord(val psm: Int, val token: ByteArray, val name: String) {
        companion object {
            val EMPTY = IdentityRecord(0, ByteArray(0), "")
        }
    }

    fun encodeIdentity(psm: Int, token: ByteArray, name: String): ByteArray {
        val safeToken = if (token.size > MAX_TOKEN_BYTES) ByteArray(0) else token
        val nameBytes = name.encodeToByteArray().let {
            // Truncating a name at a byte boundary can split a UTF-8 sequence,
            // so drop it entirely rather than emit invalid UTF-8 at a peer.
            if (it.size > MAX_NAME_BYTES) ByteArray(0) else it
        }
        val out = ByteArray(5 + safeToken.size + nameBytes.size)
        out[0] = IDENTITY_VERSION
        out[1] = if (psm in 1..0xFFFF) IDENTITY_FLAG_HAS_PSM.toByte() else 0
        out[2] = ((psm ushr 8) and 0xFF).toByte()
        out[3] = (psm and 0xFF).toByte()
        out[4] = safeToken.size.toByte()
        safeToken.copyInto(out, 5)
        nameBytes.copyInto(out, 5 + safeToken.size)
        return out
    }

    /** Bounded and total, for the same reason as [decodeAdvertisement]. */
    fun decodeIdentity(raw: ByteArray?): IdentityRecord {
        if (raw == null || raw.size < 5) return IdentityRecord.EMPTY
        if (raw[0] != IDENTITY_VERSION) return IdentityRecord.EMPTY
        val flags = raw[1].toInt() and 0xFF
        val psm = if (flags and IDENTITY_FLAG_HAS_PSM != 0) {
            ((raw[2].toInt() and 0xFF) shl 8) or (raw[3].toInt() and 0xFF)
        } else {
            0
        }
        val tokenLength = raw[4].toInt() and 0xFF
        if (tokenLength > MAX_TOKEN_BYTES || 5 + tokenLength > raw.size) return IdentityRecord.EMPTY
        val token = raw.copyOfRange(5, 5 + tokenLength)
        val name = decodeName(raw, 5 + tokenLength, raw.size)
        return IdentityRecord(psm, token, name)
    }

    // -- L2CAP datagram framing -----------------------------------------------

    /**
     * A GATT write or notification is self-delimiting: one ATT packet in, one
     * ATT packet out, boundaries preserved by the protocol. An L2CAP
     * connection-oriented channel is not - `BluetoothSocket` is a byte stream,
     * and two 100-byte sends may arrive as one 200-byte read. So the datagram
     * contract has to be rebuilt on top of it:
     *
     *      0        1        2        3        4                 4 + length
     *      +--------+--------+--------+--------+=================+
     *      |            length (uint32)        |     payload     |
     *      +--------+--------+--------+--------+=================+
     *
     * Big-endian, counting payload bytes only, exactly one datagram per frame.
     * This is deliberately the same framing the Wi-Fi transports use so there
     * is one format to keep in step with iOS rather than two; it is written out
     * again here rather than shared so that the BLE transport does not depend
     * on the Wi-Fi package.
     *
     * A length outside 1..[L2CAP_MAX_DATAGRAM_BYTES] is a framing violation.
     * There is no way to resynchronise a byte stream once the length word is
     * wrong, so the only safe response is to fail the link and let the layer
     * above reconnect.
     */
    const val LENGTH_PREFIX_BYTES: Int = 4

    /**
     * The largest datagram an L2CAP link will send or accept, and the number
     * reported as `maxDatagramSize` once a link has been upgraded.
     *
     * Both meanings are the same number on purpose: a peer can never make us
     * allocate a buffer larger than one we would have been willing to send.
     */
    const val L2CAP_MAX_DATAGRAM_BYTES: Int = 64 * 1024

    fun frame(payload: ByteArray): ByteArray {
        val out = ByteArray(LENGTH_PREFIX_BYTES + payload.size)
        val n = payload.size
        out[0] = (n ushr 24).toByte()
        out[1] = (n ushr 16).toByte()
        out[2] = (n ushr 8).toByte()
        out[3] = n.toByte()
        payload.copyInto(out, LENGTH_PREFIX_BYTES)
        return out
    }

    /** Returns -1 for any length we will not honour. */
    fun decodeLength(header: ByteArray): Int {
        // Assembled as a Long first: a hostile peer can set the top bit, and
        // 3_000_000_000 must be rejected as "too large" rather than slip past a
        // `> max` check as a negative Int.
        val value =
            ((header[0].toLong() and 0xFF) shl 24) or
                ((header[1].toLong() and 0xFF) shl 16) or
                ((header[2].toLong() and 0xFF) shl 8) or
                (header[3].toLong() and 0xFF)
        return if (value < 1L || value > L2CAP_MAX_DATAGRAM_BYTES.toLong()) -1 else value.toInt()
    }

    // -- internals ------------------------------------------------------------

    private fun decodeName(raw: ByteArray, from: Int, to: Int): String {
        if (from >= to) return ""
        val length = (to - from).coerceAtMost(MAX_NAME_BYTES)
        // A peer chooses these bytes, so they may not be valid UTF-8. Kotlin's
        // decoder substitutes U+FFFD rather than throwing, which is what we
        // want: a name is untrusted display text, never a decision input.
        return String(raw, from, length, Charsets.UTF_8)
    }
}
