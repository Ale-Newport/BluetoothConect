package com.airlink.transport.ble

/**
 * Every timeout and every bound the BLE transport enforces, in one place.
 *
 * Two rules produced this list. The first: anything that can hang gets a
 * timeout, because this code runs on a phone in a pocket and the Android
 * Bluetooth stack will occasionally accept an operation and never call back.
 * The second: anything a peer can grow gets a ceiling, because a peer decides
 * how much it sends us and how often.
 *
 * None of these are protocol values. The reliability layer in TypeScript has
 * its own retransmit and liveness timers; nothing here retries a datagram or
 * decides that a link should come back.
 */
internal object BleTuning {

    /**
     * How long one queued GATT operation may sit in flight before we give up on
     * it and let the queue move on.
     *
     * A healthy ATT round trip is single-digit milliseconds even at a slow
     * connection interval. Ten seconds does not rescue a slow operation; it
     * detects a stack that has silently swallowed one, which is the failure
     * this timer exists for.
     */
    const val GATT_OPERATION_TIMEOUT_MS: Long = 10_000

    /**
     * Consecutive operation timeouts before the connection is declared wedged
     * and torn down. One may be a transient stall; two in a row means the ATT
     * channel is gone even though Android still says "connected".
     */
    const val WEDGED_OPERATION_TIMEOUTS: Int = 2

    /**
     * `writeCharacteristic` can come back "busy" when the stack has an
     * operation of its own in flight (a service-changed indication, a bond
     * refresh). Our queue guarantees we are not the cause, so a short retry is
     * correct where failing the datagram would not be.
     */
    const val BUSY_RETRY_ATTEMPTS: Int = 5
    const val BUSY_RETRY_DELAY_MS: Long = 25

    /** Bounds on the connect timeout the JavaScript side asks for. */
    const val MIN_CONNECT_TIMEOUT_MS: Long = 1_000
    const val MAX_CONNECT_TIMEOUT_MS: Long = 60_000
    const val DEFAULT_CONNECT_TIMEOUT_MS: Long = 15_000

    /**
     * How long the central's L2CAP dial may take before the link settles for
     * GATT.
     *
     * The LE connection is already up by this point, so a channel that is
     * coming at all comes fast. Waiting longer would delay every connection to
     * a peer whose L2CAP is broken - and a slow connection is far more visible
     * to the user than a slow transfer.
     */
    const val L2CAP_CONNECT_TIMEOUT_MS: Long = 2_500

    /**
     * How long the peripheral holds a subscribed connection open waiting for
     * the central's L2CAP channel before opening the link over GATT instead.
     * Only ever waited when we published a PSM *and* that peer read our
     * identity characteristic, so a peer with no L2CAP never pays it.
     *
     * DELIBERATELY LONGER THAN THE DIAL TIMEOUT ABOVE, by a wide margin.
     *
     * The two sides are racing the same event from opposite ends and cannot
     * talk to each other about it - agreeing on an upgrade in-band would be
     * protocol knowledge, which this layer is not allowed to hold. If the
     * peripheral gave up first, a channel that connected a moment later would
     * be closed under a link that had already opened on GATT, and the central
     * would see its brand-new socket die and fail the whole link. Letting the
     * central give up first means the peripheral's wait always ends in a
     * decision the central has already made. The residual race - a dial that
     * completes in the last hundred milliseconds of the margin - costs one
     * failed link and one reconnect, which the session above survives without
     * losing a message.
     */
    const val L2CAP_ACCEPT_GRACE_MS: Long = 4_000

    /**
     * How long a subscribed peer that has NOT yet read our identity is held
     * before its link opens on GATT.
     *
     * This exists for one peer in particular: an iOS central subscribes first
     * and reads the identity characteristic immediately afterwards, so at the
     * moment it subscribes there is no way to tell it apart from a peer that
     * will never upgrade. The read follows within a few milliseconds on a live
     * connection, so this only has to cover an ATT round trip and a little
     * scheduling - it is not a guess at how long an upgrade takes, which is
     * what [L2CAP_ACCEPT_GRACE_MS] is for.
     *
     * It is the delay every incoming link from a peer with no identity
     * characteristic pays exactly once, which is why it is this short.
     */
    const val IDENTITY_READ_GRACE_MS: Long = 700

    /**
     * How long an incoming GATT connection may sit without subscribing to our
     * TX characteristic before we drop it. Anything that connects and stays
     * silent is not an AirLink peer - or is one that failed halfway - and it is
     * holding one of the handful of connection slots the controller has.
     */
    const val SUBSCRIBE_GRACE_MS: Long = 20_000

    /** A peer not seen for this long is reported lost. */
    const val PEER_LOST_TIMEOUT_MS: Long = 10_000
    const val PEER_SWEEP_INTERVAL_MS: Long = 2_000

    /**
     * The most peers we will track from a scan. A crowded room - or one hostile
     * device cycling its address - must not grow this map without limit.
     */
    const val MAX_TRACKED_PEERS: Int = 128

    /** Minimum gap between RSSI reads, so a metrics poll cannot stall a transfer. */
    const val RSSI_REFRESH_INTERVAL_MS: Long = 2_000

    /**
     * Reliable datagrams accepted but not yet handed to the radio. Beyond this
     * `send` fails loudly: the reliability layer above holds the datagram and
     * retries, which is strictly better than this layer buffering until the
     * process dies.
     */
    const val MAX_RELIABLE_QUEUE_DEPTH: Int = 64

    /**
     * Realtime datagrams are dropped rather than queued past this depth. Newer
     * game state supersedes older, so delivering it late is worse than not
     * delivering it. The drop is counted in `packetsDropped` and reported as a
     * success, because for a best-effort channel that is what happened.
     */
    const val MAX_REALTIME_QUEUE_DEPTH: Int = 4

    /**
     * Ceiling on a GATT long write reassembled from prepared writes.
     *
     * We advertise `maxDatagramSize` and no correct peer will exceed it, so
     * this path should never run. It is implemented anyway because the
     * alternative to bounding it is a peer that can prepare writes until we run
     * out of heap.
     */
    const val MAX_PREPARED_WRITE_BYTES: Int = 8 * 1024

    /** Window used for the throughput estimate reported in link metrics. */
    const val THROUGHPUT_WINDOW_MS: Long = 3_000

    /**
     * One retry, after a pause, when the scanner refuses to start. Android
     * throttles an app to five scan starts per thirty seconds and answers
     * further attempts with a registration failure; retrying immediately would
     * spend the rest of the budget and guarantee failure.
     */
    const val SCAN_RESTART_DELAY_MS: Long = 6_000
}
