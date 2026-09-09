import Foundation

/**
 * Datagram framing for the byte-stream half of the Bluetooth transport.
 *
 * A GATT write or notification is already a datagram - the ATT layer preserves
 * the boundary - so nothing here touches that path. An L2CAP connection-oriented
 * channel is different: it hands us an `InputStream`/`OutputStream` pair, i.e. a
 * pure byte stream with no message boundaries at all. The transport contract
 * above us says a send of N bytes must arrive as exactly one receive of N bytes,
 * so the boundary has to be re-created here.
 *
 * The frame is a 4-byte big-endian length followed by that many bytes. Four
 * bytes rather than two because the L2CAP datagram ceiling is 64 KiB and a
 * 2-byte prefix cannot express it; the extra two bytes are noise next to a
 * payload that large. Big-endian because every other length on the wire in this
 * project is, and because it is what a person reading a packet capture expects.
 *
 * The length is bounded before a single byte is allocated for it. A peer
 * controls what it sends us, and "allocate whatever the peer asked for" is how
 * an offline app gets killed by the memory watchdog.
 */

enum BleFraming {
    /// Bytes of length prefix in front of every datagram on a stream transport.
    static let headerLength = 4

    /**
     * Largest datagram an L2CAP channel will carry.
     *
     * This is a policy number, not a protocol one: it is the point past which a
     * single datagram stops being a datagram and starts being a file, and it
     * bounds the reassembly buffer at both ends. Both sides compile the same
     * constant, so a frame larger than this can only come from a peer that is
     * broken or hostile, and it is treated as a channel violation.
     */
    static let maxDatagramSize = 64 * 1024

    /// Prefixes `payload` with its big-endian length.
    static func frame(_ payload: Data) -> Data {
        let length = UInt32(payload.count)
        var out = Data(capacity: payload.count + headerLength)
        out.append(UInt8(truncatingIfNeeded: length >> 24))
        out.append(UInt8(truncatingIfNeeded: length >> 16))
        out.append(UInt8(truncatingIfNeeded: length >> 8))
        out.append(UInt8(truncatingIfNeeded: length))
        out.append(payload)
        return out
    }
}

enum BleFramingError: Error, CustomStringConvertible {
    case emptyFrame
    case oversizedFrame(Int, limit: Int)

    var description: String {
        switch self {
        case .emptyFrame:
            return "peer framed a zero-length datagram"
        case .oversizedFrame(let length, let limit):
            return "peer framed a \(length) byte datagram, limit is \(limit)"
        }
    }
}

/**
 * Re-assembles length-prefixed datagrams out of an arbitrary byte stream.
 *
 * Deliberately a struct with no callbacks: the owner reads datagrams out of it
 * in a loop, so there is no chance of a callback firing re-entrantly in the
 * middle of a read. Memory is bounded by `headerLength + maxDatagramSize` plus
 * one read chunk, because an over-long length is rejected before its bytes are
 * ever accumulated.
 */
struct BleFrameAccumulator {
    private let maxDatagramSize: Int
    /// Always a non-slice `Data`, so its indices are 0-based and can be used
    /// interchangeably with the offsets from `withUnsafeBytes`.
    private var buffer = Data()
    /// How much of `buffer` has already been handed out. Compacting on every
    /// datagram would make a busy channel quadratic, so it is deferred.
    private var readOffset = 0

    init(maxDatagramSize: Int = BleFraming.maxDatagramSize) {
        self.maxDatagramSize = maxDatagramSize
    }

    var pendingByteCount: Int { buffer.count - readOffset }

    mutating func append(_ chunk: Data) {
        buffer.append(chunk)
    }

    /// Returns the next complete datagram, or nil when more bytes are needed.
    /// Throws when the peer framed something outside the agreed bounds, which
    /// the caller must treat as fatal to the channel - the stream is no longer
    /// interpretable once a length is wrong.
    mutating func next() throws -> Data? {
        guard pendingByteCount >= BleFraming.headerLength else {
            compact()
            return nil
        }

        let offset = readOffset
        let length = buffer.withUnsafeBytes { raw -> Int in
            (Int(raw[offset]) << 24) | (Int(raw[offset + 1]) << 16)
                | (Int(raw[offset + 2]) << 8) | Int(raw[offset + 3])
        }

        guard length > 0 else { throw BleFramingError.emptyFrame }
        guard length <= maxDatagramSize else {
            throw BleFramingError.oversizedFrame(length, limit: maxDatagramSize)
        }
        guard pendingByteCount - BleFraming.headerLength >= length else {
            compact()
            return nil
        }

        let start = offset + BleFraming.headerLength
        // Wrapping the slice in Data() re-bases its indices; a Data slice keeps
        // the parent's start index, which is the single most common way to write
        // an off-by-N bug against this type.
        let datagram = Data(buffer[start ..< start + length])
        readOffset = start + length
        compact()
        return datagram
    }

    private mutating func compact() {
        guard readOffset > 0 else { return }
        if readOffset >= buffer.count {
            buffer.removeAll(keepingCapacity: true)
            readOffset = 0
        } else if readOffset >= 8 * 1024 {
            buffer = Data(buffer[readOffset...])
            readOffset = 0
        }
    }
}

/**
 * One datagram queued for transmission, together with the promise waiting on it.
 *
 * It is a reference type on purpose: a datagram can move between the L2CAP write
 * queue and the GATT write queue when the fast path drops out, and exactly one
 * of those places must eventually settle the promise. `finish` is idempotent so
 * that a hand-off race can never resolve a JavaScript promise twice.
 */
final class BleOutboundDatagram {
    let data: Data
    /// false selects the best-effort path (BLE write-without-response).
    let reliable: Bool
    private var completion: ((Result<Void, Error>) -> Void)?

    init(data: Data, reliable: Bool, completion: @escaping (Result<Void, Error>) -> Void) {
        self.data = data
        self.reliable = reliable
        self.completion = completion
    }

    var isSettled: Bool { completion == nil }

    func finish(_ result: Result<Void, Error>) {
        guard let completion else { return }
        self.completion = nil
        completion(result)
    }
}
