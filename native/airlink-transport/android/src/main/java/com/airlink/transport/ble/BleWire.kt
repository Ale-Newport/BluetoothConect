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

            /**
             * The four UUIDs differ only in `time_low` - the first eight hex
             * digits - so the offset is added to the TOP 32 bits of the most
             * significant half, not to the whole of it. Adding it to the low end
             * would walk `time_mid` and `time_hi` instead and produce a UUID
             * that matches nothing, silently: the consistency check below would
             * fail, the identity characteristic would be dropped, and the only
             * symptom would be a missing L2CAP upgrade. Verified against the
             * four constants in packages/core/src/protocol/constants.ts.
             */
            private fun offset(base: UUID, by: Int): UUID =
                UUID(base.mostSignificantBits + (by.toLong() shl 32), base.leastSignificantBits)
        }
    }

    // -- The advertisement ----------------------------------------------------

    /**
     * THE ADVERTISEMENT IS SERVICE DATA HOLDING THE RAW TOKEN, AND NOTHING ELSE.
     *
     * This layout is dictated by CoreBluetooth, and getting it wrong costs the
     * headline feature. An iOS central reads a peer's token out of
     * `CBAdvertisementDataServiceDataKey[serviceUUID]` and base64s **the whole
     * value** as the token - it does not parse a header, because iOS has no way
     * to publish one of its own to parse against. So a version byte or a length
     * byte in front of the token would not be skipped by an iPhone; it would be
     * folded into the token, and every iPhone would fail to recognise every
     * Android friend it has ever paired with. The bytes here are exactly the
     * token the protocol layer handed down.
     *
     * WHY NOT MANUFACTURER DATA. An iOS advertiser cannot publish it and an iOS
     * central does not look for it, so it only ever works Android-to-Android -
     * and the one combination this transport exists for is the other one.
     *
     * THE BUDGET, and why the opt-in display name is not up here with it. A
     * legacy advertisement is 31 bytes and its scan response is another 31:
     *
     *   advertisement    3  flags, inserted by the controller when connectable
     *                   18  the 128-bit service UUID (2 header + 16), which MUST
     *                       be here: it is what every scan filter matches on,
     *                       and a filter is mandatory for a background iOS scan
     *                   --
     *                   10  spare
     *
     *   scan response   18  service-data header (2 + the same 16-byte UUID)
     *                   --
     *                   13  spare, and that is the whole token budget
     *
     * A second AD structure for a name costs two bytes of header before a
     * single character, and neither 10 nor 13 bytes leaves room for a name
     * worth showing. Android also cannot broadcast an *arbitrary* name in the
     * first place: `AdvertiseData.setIncludeDeviceName` publishes the system
     * Bluetooth name ("Sam's Pixel"), a durable identifier the user never
     * agreed to hand out, so it stays off. The display name therefore travels
     * in the identity characteristic, which both platforms read on connect and
     * which has room for a real name. An iPhone advertises its name in the BLE
     * local name as well, because CoreBluetooth allots that its own space - so
     * a scanner looks there too, and finds it only for iOS peers.
     */
    const val MAX_ADVERTISED_TOKEN_BYTES: Int = 13

    /**
     * @throws IllegalArgumentException when the token will not fit the scan
     *   response. Never truncates: a truncated token matches nobody, and a
     *   loudly rejected `startAdvertising` is far better than a phone that is
     *   mysteriously unrecognisable to its own friends.
     */
    fun encodeAdvertisedToken(token: ByteArray): ByteArray {
        require(token.size in 1..MAX_ADVERTISED_TOKEN_BYTES) {
            "advertisement token of ${token.size} bytes does not fit the " +
                "$MAX_ADVERTISED_TOKEN_BYTES byte scan-response budget"
        }
        // Copied so a caller reusing its buffer cannot change what we broadcast.
        return token.copyOf()
    }

    /**
     * Reads a peer's token back off its advertisement.
     *
     * Every byte is attacker-controlled - anything may put data under a service
     * UUID it has learned - so this is total: an oversized or empty value costs
     * a discarded token, never an exception on the scan callback thread. The
     * ceiling is the identity record's, not the advertisement's, so a peer
     * using a future transport with a bigger budget still parses.
     */
    fun decodeAdvertisedToken(raw: ByteArray?): ByteArray {
        if (raw == null || raw.isEmpty() || raw.size > MAX_IDENTITY_TOKEN_BYTES) return ByteArray(0)
        return raw.copyOf()
    }

    // -- The identity characteristic ------------------------------------------

    /** Format byte for the identity record. */
    private const val IDENTITY_VERSION: Byte = 1

    private const val IDENTITY_FLAG_HAS_PSM: Int = 1 shl 0

    /** version + flags + PSM(2) + token length. */
    private const val IDENTITY_HEADER_BYTES: Int = 5

    /**
     * Every bound below is shared with `ios/Transport/BleIdentityRecord.swift`
     * and must stay identical to it. A record longer than the ceiling, or a
     * token longer than the cap, is rejected outright by the iOS decoder - so a
     * mismatch here does not degrade, it silently removes the L2CAP upgrade and
     * the display name in one direction only, which is the hardest kind of bug
     * to find with two phones on a table.
     *
     * 128 bytes also keeps the whole record inside one ATT response at any MTU
     * worth having, so the common case is a single read rather than a series of
     * blob reads.
     */
    const val MAX_IDENTITY_BYTES: Int = 128
    const val MAX_IDENTITY_TOKEN_BYTES: Int = 32

    /**
     * Hard ceiling on a display name, in UTF-8 bytes, wherever it appears. Long
     * enough for a real name, short enough that a peer cannot use the identity
     * read to push a megabyte of string into a picker row.
     */
    const val MAX_NAME_BYTES: Int = 48

    /**
     * The read-only identity characteristic: the token the advertisement
     * carries, plus the two things that will not fit in one - the opt-in
     * display name and the L2CAP PSM.
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
        // A token we cannot express is dropped rather than truncated: half a
        // token is not a shorter token, it is a token that matches the wrong
        // person. The protocol's is six bytes, so this never fires in practice.
        val safeToken = if (token.size > MAX_IDENTITY_TOKEN_BYTES) ByteArray(0) else token
        val used = IDENTITY_HEADER_BYTES + safeToken.size
        val nameBytes = trimUtf8(name, minOf(MAX_NAME_BYTES, MAX_IDENTITY_BYTES - used))

        val out = ByteArray(used + nameBytes.size)
        out[0] = IDENTITY_VERSION
        out[1] = if (psm in 1..0xFFFF) IDENTITY_FLAG_HAS_PSM.toByte() else 0
        out[2] = ((psm ushr 8) and 0xFF).toByte()
        out[3] = (psm and 0xFF).toByte()
        out[4] = safeToken.size.toByte()
        safeToken.copyInto(out, IDENTITY_HEADER_BYTES)
        nameBytes.copyInto(out, used)
        return out
    }

    /**
     * Bounded and total: a peer decides what comes back from this read, so
     * anything unexpected yields an empty record - no upgrade and no name -
     * rather than an exception on a GATT callback thread.
     */
    fun decodeIdentity(raw: ByteArray?): IdentityRecord {
        if (raw == null || raw.size < IDENTITY_HEADER_BYTES || raw.size > MAX_IDENTITY_BYTES) {
            return IdentityRecord.EMPTY
        }
        if (raw[0] != IDENTITY_VERSION) return IdentityRecord.EMPTY
        val flags = raw[1].toInt() and 0xFF
        val psm = if (flags and IDENTITY_FLAG_HAS_PSM != 0) {
            ((raw[2].toInt() and 0xFF) shl 8) or (raw[3].toInt() and 0xFF)
        } else {
            0
        }
        val tokenLength = raw[4].toInt() and 0xFF
        if (tokenLength > MAX_IDENTITY_TOKEN_BYTES || IDENTITY_HEADER_BYTES + tokenLength > raw.size) {
            return IdentityRecord.EMPTY
        }
        val token = raw.copyOfRange(IDENTITY_HEADER_BYTES, IDENTITY_HEADER_BYTES + tokenLength)
        val name = decodeName(raw, IDENTITY_HEADER_BYTES + tokenLength, raw.size)
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

    /**
     * Encodes as much of [text] as fits in [limit] UTF-8 bytes, dropping WHOLE
     * characters from the end.
     *
     * Cutting UTF-8 at a byte boundary splits multi-byte sequences, and the
     * peer that decodes it sees replacement characters - which looks to the
     * person reading it like a bug in the app rather than like a shortened
     * name. Surrogate pairs are stepped over as one unit for the same reason,
     * so an emoji is either present or absent, never half of one. This mirrors
     * the same loop in `ios/Transport/BleIdentityRecord.swift`.
     */
    private fun trimUtf8(text: String, limit: Int): ByteArray {
        if (limit <= 0 || text.isEmpty()) return ByteArray(0)
        val whole = text.encodeToByteArray()
        if (whole.size <= limit) return whole

        var end = text.length
        while (end > 0) {
            // A low surrogate is never a character on its own.
            val step = if (end >= 2 && text[end - 1].isLowSurrogate() && text[end - 2].isHighSurrogate()) 2 else 1
            end -= step
            if (end == 0) break
            val candidate = text.substring(0, end).encodeToByteArray()
            if (candidate.size <= limit) return candidate
        }
        return ByteArray(0)
    }

    private fun decodeName(raw: ByteArray, from: Int, to: Int): String {
        if (from >= to) return ""
        val length = (to - from).coerceAtMost(MAX_NAME_BYTES)
        // A peer chooses these bytes, so they may not be valid UTF-8. Kotlin's
        // decoder substitutes U+FFFD rather than throwing, which is what we
        // want: a name is untrusted display text, never a decision input.
        return String(raw, from, length, Charsets.UTF_8)
    }
}
