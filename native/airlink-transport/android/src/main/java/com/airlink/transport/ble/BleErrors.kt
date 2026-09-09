package com.airlink.transport.ble

import com.airlink.transport.AirLinkError
import com.airlink.transport.TransportKind

/**
 * Every error this package hands back to the bridge is built here.
 *
 * This is the one file that knows how `AirLinkError` is spelled in Kotlin. The
 * shared vocabulary lives in the parent package (mirroring
 * `ios/Transport/AirLinkTypes.swift`, where the same cases carry the codes the
 * JavaScript promise rejects with), and funnelling construction through one
 * object means a change to that type is a change to this file rather than to
 * forty call sites across the radio code.
 *
 * The rule these follow: a failure the user can do something about gets its own
 * code, so the permission and connection screens can react to it. Everything
 * else is `failed` with a sentence of detail, because inventing a taxonomy the
 * UI does not use helps nobody.
 */
internal object BleErrors {

    fun notStarted(): Throwable = AirLinkError.NotStarted

    fun unsupported(what: String): Throwable = AirLinkError.Unsupported(what)

    fun radioOff(): Throwable = AirLinkError.RadioOff(TransportKind.BLE)

    fun permissionDenied(): Throwable = AirLinkError.PermissionDenied(TransportKind.BLE)

    fun unknownLink(linkId: String): Throwable = AirLinkError.UnknownLink(linkId)

    fun unknownEndpoint(endpointId: String): Throwable = AirLinkError.UnknownEndpoint(endpointId)

    /**
     * The contract is explicit that oversized sends fail rather than truncate.
     * A truncated datagram is a decryption failure two layers up, reported
     * against the wrong thing, minutes later.
     */
    fun payloadTooLarge(size: Int, limit: Int): Throwable = AirLinkError.PayloadTooLarge(size, limit)

    fun timeout(what: String): Throwable = AirLinkError.Timeout(what)

    fun failed(detail: String): Throwable = AirLinkError.Failed(detail)
}
