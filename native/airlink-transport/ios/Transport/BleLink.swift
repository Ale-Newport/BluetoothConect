import Foundation
import CoreBluetooth

/**
 * Everything the Bluetooth transport knows about one open link.
 *
 * A link is one of two shapes and the code path differs enough to be worth
 * naming: as a *central* we write into the peer's RX characteristic and receive
 * its notifications, and as a *peripheral* we receive writes and push
 * notifications back. Both may be live at once between the same two phones -
 * every device advertises and scans, so either side may have been the one to
 * dial - and the TypeScript above collapses the duplicate.
 *
 * Every field here is touched only from the transport's serial queue. There is
 * no locking on purpose: a lock would suggest the invariant is weaker than it
 * is.
 */
final class BleLink {
    enum Role {
        /// We dialled: we hold a CBPeripheral and write to it.
        case central
        /// They dialled: we hold a CBCentral and notify it.
        case peripheral
    }

    /// Where the L2CAP upgrade has got to. Once `.unavailable` it is not retried
    /// on this link - a channel that failed once tends to keep failing, and the
    /// GATT path is a working product, not a degraded mode.
    enum FastPath {
        case none
        case opening
        case active
        case unavailable
    }

    let id: String
    let role: Role
    let endpointId: String

    var state: LinkState = .connecting
    /// True once linkOpened has been emitted, so it can never be emitted twice.
    var opened = false

    // -- central role ---------------------------------------------------------
    var peripheral: CBPeripheral?
    var rxCharacteristic: CBCharacteristic?
    var txCharacteristic: CBCharacteristic?
    var identityCharacteristic: CBCharacteristic?
    var notificationsEnabled = false
    /// A write-with-response is kept singular so backpressure is real rather
    /// than a queue growing inside CoreBluetooth where we cannot see it.
    var reliableInFlight: BleOutboundDatagram?
    var reliableWatchdog: DispatchSourceTimer?

    // -- peripheral role ------------------------------------------------------
    var subscribedCentral: CBCentral?

    // -- shared ---------------------------------------------------------------
    /// ATT default until the real negotiated length is readable. Never assumed.
    var gattDatagramSize = 20
    /// Last size handed to JavaScript, so mtuChanged is emitted only on change.
    var reportedDatagramSize = 0

    var fastPath: FastPath = .none
    var l2cap: BleL2CAPSession?
    var l2capTimer: DispatchSourceTimer?
    var remotePSM: UInt16 = 0

    var outbound: [BleOutboundDatagram] = []
    var outboundBytes = 0

    var connectCompletion: ((Result<String, Error>) -> Void)?
    var connectTimer: DispatchSourceTimer?
    var identityTimer: DispatchSourceTimer?

    var metrics = LinkMetricsSnapshot()
    /// Bytes moved since the last throughput sample, both directions.
    var throughputWindowBytes: Double = 0
    var lastThroughputSample = CFAbsoluteTimeGetCurrent()

    init(id: String, role: Role, endpointId: String) {
        self.id = id
        self.role = role
        self.endpointId = endpointId
    }

    /// The size a send is measured against right now: the fast path when it is
    /// carrying traffic, the negotiated ATT length otherwise.
    var currentDatagramSize: Int {
        fastPath == .active ? BleL2CAPSession.maxDatagramSize : gattDatagramSize
    }

    func cancelTimers() {
        connectTimer?.cancel()
        connectTimer = nil
        identityTimer?.cancel()
        identityTimer = nil
        l2capTimer?.cancel()
        l2capTimer = nil
        reliableWatchdog?.cancel()
        reliableWatchdog = nil
    }
}
