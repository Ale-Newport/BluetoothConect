import Foundation
import CoreBluetooth

/**
 * The fast path: a BLE L2CAP connection-oriented channel.
 *
 * Apple DTS recommends L2CAP over GATT for anything bulk, and the difference is
 * not subtle - a CoC skips the ATT round trips entirely and runs several times
 * faster than write-without-response. It is not discoverable on its own, so the
 * peripheral publishes a PSM and advertises it inside a GATT characteristic;
 * that dance lives in BleTransport, and by the time a session exists here the
 * channel is already open.
 *
 * WHAT THIS CLASS OWES ITS OWNER
 *  - datagram boundaries, because a CoC is a byte stream (see BleFraming);
 *  - a bounded queue, because a stalled radio must not grow memory without end;
 *  - on close, the datagrams it never managed to write, handed back so the owner
 *    can put them on the GATT path instead of losing them.
 *
 * THREADING. `CBL2CAPChannel` hands out Foundation streams, which are run-loop
 * driven, so every byte of state in here lives on one dedicated run-loop thread
 * (BleStreamRunLoop) and nothing else touches it. Callbacks hop to the caller's
 * queue on the way out. Pumping tens of KiB per datagram on the main run loop
 * was the alternative, and it stutters the UI of an app whose whole point is to
 * feel instant.
 */
final class BleL2CAPSession: NSObject, StreamDelegate {

    /// Largest datagram this path accepts, both directions.
    static var maxDatagramSize: Int { BleFraming.maxDatagramSize }

    /// Ceiling on unwritten bytes. Past this a send is rejected rather than
    /// buffered: the layer above retries, and the phone stays alive.
    private static let maxQueuedBytes = 4 * 1024 * 1024
    private static let readChunkSize = 16 * 1024

    /*
     * All three are set by the owner before `open()` and never afterwards, which
     * is what makes reading them from the stream thread safe: `open()` hops onto
     * that thread, so the assignments happen-before any read.
     */

    /// Delivered on `callbackQueue`, one call per datagram, boundaries intact.
    var onDatagram: ((Data) -> Void)?
    /// One call per outbound datagram that this session settled itself, on
    /// `callbackQueue`: `written` true once it is in the stream, false when the
    /// session refused it. Datagrams handed back by `onClosed` are settled by
    /// the owner instead, so this never counts the same one twice.
    var onDatagramSettled: ((_ bytes: Int, _ written: Bool) -> Void)?
    /// Delivered on `callbackQueue` exactly once. `unsent` are datagrams that
    /// provably never reached the peer, for the owner to re-queue elsewhere.
    var onClosed: ((_ reason: String?, _ unsent: [BleOutboundDatagram]) -> Void)?

    private let channel: CBL2CAPChannel
    private let input: InputStream
    private let output: OutputStream
    private let callbackQueue: DispatchQueue

    // --- stream-thread state; never touched from anywhere else ---------------
    private var pending: [(item: BleOutboundDatagram, framed: Data)] = []
    private var writeOffset = 0
    private var queuedBytes = 0
    private var canWrite = false
    private var accumulator = BleFrameAccumulator()
    private var scratch = [UInt8](repeating: 0, count: BleL2CAPSession.readChunkSize)
    private var closed = false
    private var openedStreams = false

    /// Nil when CoreBluetooth handed us a channel without streams, which is not
    /// documented as possible but is cheaper to survive than to crash on.
    init?(channel: CBL2CAPChannel, callbackQueue: DispatchQueue) {
        guard let input = channel.inputStream, let output = channel.outputStream else { return nil }
        self.channel = channel
        self.input = input
        self.output = output
        self.callbackQueue = callbackQueue
        super.init()
    }

    var psm: CBL2CAPPSM { channel.psm }

    // MARK: - Lifecycle

    func open() {
        BleStreamRunLoop.shared.perform { [self] in
            guard !closed, !openedStreams else { return }
            openedStreams = true
            input.delegate = self
            output.delegate = self
            input.schedule(in: .current, forMode: .default)
            output.schedule(in: .current, forMode: .default)
            input.open()
            output.open()
        }
    }

    /// Idempotent. `reason` nil means the owner asked for it rather than the
    /// channel breaking.
    func close(reason: String? = nil) {
        BleStreamRunLoop.shared.perform { [self] in
            shutdown(reason: reason)
        }
    }

    func send(_ item: BleOutboundDatagram) {
        BleStreamRunLoop.shared.perform { [self] in
            guard !closed else {
                finish(item, .failure(AirLinkError.failed("L2CAP channel is closed")))
                return
            }
            guard item.data.count <= Self.maxDatagramSize else {
                finish(item, .failure(AirLinkError.payloadTooLarge(item.data.count, Self.maxDatagramSize)))
                return
            }
            let framed = BleFraming.frame(item.data)
            guard queuedBytes + framed.count <= Self.maxQueuedBytes else {
                finish(item, .failure(AirLinkError.failed("Bluetooth send queue is full")))
                return
            }
            queuedBytes += framed.count
            pending.append((item, framed))
            pumpWrites()
        }
    }

    // MARK: - StreamDelegate

    func stream(_ stream: Stream, handle event: Stream.Event) {
        // Already on the stream thread: this is the run loop we scheduled on.
        guard !closed else { return }
        switch event {
        case .hasBytesAvailable:
            readAvailable()
        case .hasSpaceAvailable:
            canWrite = true
            pumpWrites()
        case .endEncountered:
            // The peer closed the channel. Not an error, but the fast path is
            // gone and the owner has to fall back.
            shutdown(reason: "L2CAP channel closed by peer")
        case .errorOccurred:
            let detail = stream.streamError?.localizedDescription ?? "unknown stream error"
            shutdown(reason: "L2CAP stream error: \(detail)")
        default:
            break
        }
    }

    // MARK: - Reading

    private func readAvailable() {
        // Hoisted so the closure below touches nothing on `self` while `scratch`
        // is under an exclusive access.
        let stream = input
        while !closed, stream.hasBytesAvailable {
            let read = scratch.withUnsafeMutableBufferPointer { buffer -> Int in
                guard let base = buffer.baseAddress else { return -1 }
                return stream.read(base, maxLength: buffer.count)
            }
            if read == 0 {
                shutdown(reason: "L2CAP channel closed by peer")
                return
            }
            if read < 0 {
                let detail = stream.streamError?.localizedDescription ?? "read failed"
                shutdown(reason: "L2CAP read error: \(detail)")
                return
            }
            accumulator.append(Data(scratch[0 ..< read]))

            do {
                while let datagram = try accumulator.next() {
                    let sink = onDatagram
                    callbackQueue.async { sink?(datagram) }
                }
            } catch {
                // A bad length means the stream can no longer be interpreted -
                // there is no resynchronisation point in a length-prefixed
                // stream. Drop to GATT rather than guess.
                shutdown(reason: "L2CAP framing violation: \(error)")
                return
            }
        }
    }

    // MARK: - Writing

    private func pumpWrites() {
        while !closed, canWrite, let head = pending.first {
            let framed = head.framed
            let remaining = framed.count - writeOffset
            guard remaining > 0 else {
                complete(head: head)
                continue
            }

            let written = framed.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int in
                guard let base = raw.baseAddress else { return -1 }
                let start = base.advanced(by: writeOffset).assumingMemoryBound(to: UInt8.self)
                return output.write(start, maxLength: remaining)
            }

            if written < 0 {
                let detail = output.streamError?.localizedDescription ?? "write failed"
                shutdown(reason: "L2CAP write error: \(detail)")
                return
            }
            if written == 0 {
                canWrite = false
                return
            }

            writeOffset += written
            queuedBytes -= written
            if writeOffset == framed.count {
                complete(head: head)
            } else {
                // Short write: the socket buffer is full. Wait to be told there
                // is room rather than spinning on the run loop.
                canWrite = false
                return
            }
        }
    }

    private func complete(head: (item: BleOutboundDatagram, framed: Data)) {
        pending.removeFirst()
        writeOffset = 0
        // "Handed to the radio" is the strongest promise a stream can make; the
        // reliability layer above is what turns that into delivery.
        finish(head.item, .success(()))
    }

    // MARK: - Teardown

    private func shutdown(reason: String?) {
        guard !closed else { return }
        closed = true

        if openedStreams {
            input.delegate = nil
            output.delegate = nil
            input.remove(from: .current, forMode: .default)
            output.remove(from: .current, forMode: .default)
            input.close()
            output.close()
        }

        /*
         * Everything still in `pending` provably never reached the peer, and
         * that includes the partially written head: the peer's un-framer holds a
         * truncated frame it will never complete, and it discards its buffer
         * when the channel dies. So a half-written datagram is never surfaced
         * twice, and handing the whole queue back is safe - no duplication, no
         * reordering.
         *
         * The one thing this cannot recover is a datagram fully written into the
         * socket buffer that the controller had not yet transmitted. That window
         * is identical to the one a GATT link has when the connection drops, and
         * it is exactly what the reliability layer above is designed for.
         */
        let unsent = pending.map { $0.item }
        pending.removeAll()
        queuedBytes = 0
        writeOffset = 0
        canWrite = false

        let sink = onClosed
        onClosed = nil
        onDatagram = nil
        onDatagramSettled = nil
        callbackQueue.async { sink?(reason, unsent) }
    }

    private func finish(_ item: BleOutboundDatagram, _ result: Result<Void, Error>) {
        var written = false
        if case .success = result { written = true }
        let bytes = item.data.count
        let settled = onDatagramSettled
        // Off the stream thread, always: rule 4 of the datagram contract says a
        // callback is never delivered re-entrantly from inside a send.
        callbackQueue.async {
            item.finish(result)
            settled?(bytes, written)
        }
    }
}

/**
 * One private thread with a run loop, shared by every L2CAP channel.
 *
 * Foundation streams need a run loop and CoreBluetooth's dispatch queue is not
 * one. The two honest options were this or `RunLoop.main`; the main run loop
 * would put 64 KiB memcpys in front of the UI, so it lost. One thread serves
 * every channel because channels are few and each one is idle most of the time.
 */
/// `@unchecked Sendable` because the compiler cannot see the one invariant that
/// makes it true: `loop` is written once on the worker thread and published
/// through the semaphore before `init` returns, and nothing writes it again.
final class BleStreamRunLoop: NSObject, @unchecked Sendable {
    static let shared = BleStreamRunLoop()

    /// Written once on the worker thread and published through `ready` before
    /// `init` returns, so every later read sees it without further sync.
    private var loop: CFRunLoop?
    private let ready = DispatchSemaphore(value: 0)

    private override init() {
        super.init()
        let thread = Thread(target: self, selector: #selector(threadMain), object: nil)
        thread.name = "com.airlink.transport.ble.l2cap"
        thread.qualityOfService = .userInitiated
        thread.start()
        ready.wait()
    }

    @objc private func threadMain() {
        loop = CFRunLoopGetCurrent()
        ready.signal()
        let runLoop = RunLoop.current
        // A port with no traffic keeps the run loop from falling straight
        // through in the gaps between one channel closing and the next opening.
        runLoop.add(NSMachPort(), forMode: .default)
        while !Thread.current.isCancelled {
            runLoop.run(mode: .default, before: .distantFuture)
        }
    }

    func perform(_ block: @escaping () -> Void) {
        guard let loop else {
            // Cannot happen once init has returned; running inline is still
            // better than dropping work on the floor.
            block()
            return
        }
        CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue, block)
        CFRunLoopWakeUp(loop)
    }
}
