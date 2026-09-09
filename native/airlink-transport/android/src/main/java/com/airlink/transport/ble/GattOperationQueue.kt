package com.airlink.transport.ble

import android.bluetooth.BluetoothGatt
import android.os.Handler
import java.util.ArrayDeque

/**
 * The single most important object in the Android BLE half of AirLink.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * Android's `BluetoothGatt` allows exactly ONE outstanding operation per
 * connection. A characteristic write, a characteristic read, a descriptor
 * write and an MTU request all queue against the same slot inside the stack -
 * and the stack does not queue for you. Issue a second operation before the
 * first has called back and one of two things happens, depending on the
 * device: the call returns a busy status, or - far worse, and the common case
 * on older stacks - it returns success and the operation is silently dropped.
 *
 * That is what "firing writes back to back silently drops data" means, and it
 * is why almost every Android BLE app is subtly lossy. There is no flag to
 * turn on and no callback that tells you it happened. The only fix is to keep
 * the ordering yourself: hold every operation in a queue, issue exactly one,
 * and issue the next only when that one's callback has fired.
 *
 * The datagram contract depends on it directly. "A send of N bytes arrives as
 * exactly one receive of the same N bytes, or not at all" and "reliable sends
 * arrive in order and without duplication" are both properties of this queue,
 * not of the radio.
 *
 * ===========================================================================
 * THREADING
 * ===========================================================================
 *
 * Every method must be called on the transport's handler thread, and every
 * completion is invoked on it. GATT callbacks arrive on a binder thread, so the
 * connection posts them here rather than calling in directly - which also
 * gives the contract's "callbacks are never delivered re-entrantly from inside
 * a send call" for free.
 */
internal enum class GattOpKind {
    DISCOVER_SERVICES,
    REQUEST_MTU,
    READ_CHARACTERISTIC,
    WRITE_CHARACTERISTIC,
    WRITE_DESCRIPTOR,
    READ_RSSI,
}

/** What happened when we asked the stack to start an operation. */
internal sealed class GattIssue {
    /** The stack took it; its callback is now owed to us. */
    object Accepted : GattIssue()

    /** The stack is busy with something of its own. Worth retrying shortly. */
    object Busy : GattIssue()

    /** The stack refused outright. Retrying will not help. */
    class Refused(val reason: String) : GattIssue()
}

/**
 * The result of one operation. `error` is set when the operation never reached
 * the radio or never came back; `status` is the GATT status when it did.
 */
internal class GattOutcome(
    val status: Int,
    val value: ByteArray?,
    val error: String?,
) {
    val ok: Boolean get() = error == null && status == BluetoothGatt.GATT_SUCCESS

    fun describe(): String = error ?: "GATT status $status"

    companion object {
        fun failure(reason: String) = GattOutcome(BluetoothGatt.GATT_FAILURE, null, reason)
    }
}

internal class GattOperationQueue(
    private val handler: Handler,
    /**
     * Called when the connection has stopped answering entirely. The owner is
     * expected to tear the link down; this queue never reconnects anything.
     */
    private val onWedged: (String) -> Unit,
    private val log: (String, String) -> Unit,
) {

    private class Entry(
        val kind: GattOpKind,
        val label: String,
        val issue: () -> GattIssue,
        val onResult: (GattOutcome) -> Unit,
    ) {
        var busyAttempts: Int = 0
    }

    private val pending = ArrayDeque<Entry>()
    private var inFlight: Entry? = null
    private var consecutiveTimeouts: Int = 0
    private var shutDown: Boolean = false

    /** Fires when the in-flight operation has not called back in time. */
    private val timeoutRunnable = Runnable { onTimeout() }

    val depth: Int get() = pending.size + if (inFlight != null) 1 else 0

    /**
     * Queues one operation. `issue` is invoked later, on the handler thread,
     * when the slot is free; `onResult` is invoked exactly once.
     */
    fun submit(
        kind: GattOpKind,
        label: String,
        issue: () -> GattIssue,
        onResult: (GattOutcome) -> Unit,
    ) {
        if (shutDown) {
            onResult(GattOutcome.failure("the GATT connection is closed"))
            return
        }
        pending.addLast(Entry(kind, label, issue, onResult))
        pump()
    }

    /**
     * Completes the in-flight operation from a GATT callback.
     *
     * The kind is checked rather than assumed. A stray callback - one that
     * arrives after we timed the operation out, or one for an operation the
     * stack started on its own - must not be allowed to complete an unrelated
     * operation and advance the queue, which would put a write's completion on
     * an MTU request and lose the datagram.
     */
    fun complete(kind: GattOpKind, status: Int, value: ByteArray?) {
        val entry = inFlight
        if (entry == null) {
            log("debug", "late $kind callback with nothing in flight; ignored")
            return
        }
        if (entry.kind != kind) {
            log("warn", "unexpected $kind callback while ${entry.kind} was in flight; ignored")
            return
        }
        handler.removeCallbacks(timeoutRunnable)
        inFlight = null
        consecutiveTimeouts = 0
        deliver(entry, GattOutcome(status, value, null))
        pump()
    }

    /**
     * Fails everything and stops accepting work. Idempotent, and safe to call
     * from the middle of a completion.
     */
    fun abort(reason: String) {
        shutDown = true
        handler.removeCallbacks(timeoutRunnable)
        val entry = inFlight
        inFlight = null
        entry?.let { deliver(it, GattOutcome.failure(reason)) }
        while (true) {
            val next = pending.pollFirst() ?: break
            deliver(next, GattOutcome.failure(reason))
        }
    }

    // -- internals ------------------------------------------------------------

    private fun pump() {
        if (shutDown || inFlight != null) return
        val entry = pending.pollFirst() ?: return
        inFlight = entry

        when (val issue = safeIssue(entry)) {
            is GattIssue.Accepted -> {
                handler.postDelayed(timeoutRunnable, BleTuning.GATT_OPERATION_TIMEOUT_MS)
            }

            is GattIssue.Busy -> {
                inFlight = null
                entry.busyAttempts++
                if (entry.busyAttempts > BleTuning.BUSY_RETRY_ATTEMPTS) {
                    deliver(entry, GattOutcome.failure("${entry.label}: the stack stayed busy"))
                    pump()
                } else {
                    // Back to the FRONT of the queue: this operation has not run
                    // yet, and letting a later datagram overtake it would break
                    // the ordering the contract promises.
                    pending.addFirst(entry)
                    handler.postDelayed(
                        { pump() },
                        BleTuning.BUSY_RETRY_DELAY_MS * entry.busyAttempts,
                    )
                }
            }

            is GattIssue.Refused -> {
                inFlight = null
                deliver(entry, GattOutcome.failure("${entry.label}: ${issue.reason}"))
                pump()
            }
        }
    }

    /**
     * The stack throws on a revoked permission, a device that vanished, and a
     * handful of internal states. None of those may reach the handler thread's
     * uncaught handler: an offline app that dies is worse than one that says
     * "not connected".
     */
    private fun safeIssue(entry: Entry): GattIssue =
        try {
            entry.issue()
        } catch (t: Throwable) {
            GattIssue.Refused("${t.javaClass.simpleName}: ${t.message ?: "no detail"}")
        }

    private fun deliver(entry: Entry, outcome: GattOutcome) {
        try {
            entry.onResult(outcome)
        } catch (t: Throwable) {
            log("error", "completion for ${entry.label} threw ${t.javaClass.simpleName}")
        }
    }

    private fun onTimeout() {
        val entry = inFlight ?: return
        inFlight = null
        consecutiveTimeouts++
        log("warn", "${entry.label} timed out after ${BleTuning.GATT_OPERATION_TIMEOUT_MS}ms")
        deliver(entry, GattOutcome.failure("${entry.label} timed out"))

        if (consecutiveTimeouts >= BleTuning.WEDGED_OPERATION_TIMEOUTS) {
            // Android can hold a connection in STATE_CONNECTED long after the
            // ATT channel has stopped answering - typically when the peer has
            // walked out of range rather than disconnected cleanly. Two dead
            // operations in a row is the earliest honest moment to say so.
            val reason = "the GATT connection stopped answering"
            abort(reason)
            onWedged(reason)
            return
        }
        pump()
    }
}
