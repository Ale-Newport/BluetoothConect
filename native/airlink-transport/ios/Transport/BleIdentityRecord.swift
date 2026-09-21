import Foundation

/**
 * The little blob behind the read-only identity characteristic.
 *
 * TWO PLATFORM FACTS FORCE THIS TO EXIST.
 *
 * 1. `CBPeripheralManager.startAdvertising` honours exactly two keys -
 *    `CBAdvertisementDataLocalNameKey` and `CBAdvertisementDataServiceUUIDsKey`.
 *    Every other key, service data and manufacturer data included, is silently
 *    dropped. So an iOS advertiser has nowhere in the advertisement to put the
 *    rotating token that lets a paired friend recognise it, and a peer has to
 *    connect and read it instead. An Android advertiser can and does put the
 *    token in service data, which is why discovery still reports one when the
 *    peer is an Android phone.
 * 2. An L2CAP channel is not discoverable. `publishL2CAPChannel` returns a PSM
 *    and nothing broadcasts it, so it has to travel in a characteristic too.
 *
 * This is transport plumbing, not protocol: the token is an opaque blob handed
 * down from TypeScript and handed back up unread, and the PSM is a Bluetooth
 * detail that never leaves this layer.
 *
 * Layout, little of it and all of it bounded:
 *
 *     0        version (1)
 *     1        flags; bit 0 set when a PSM follows
 *     2..3     PSM, big-endian, 0 when not published
 *     4        token length, 0..32
 *     5..      token
 *     rest     display name, UTF-8, may be empty
 */
enum BleIdentityRecord {
    static let version: UInt8 = 1

    /// Keeps a read inside a single ATT response on any MTU worth having, and
    /// bounds what a peer can make us parse.
    static let maxEncodedLength = 128
    static let maxTokenLength = 32

    private static let flagHasPSM: UInt8 = 1 << 0
    private static let flagHasDiscoveryId: UInt8 = 1 << 1
    private static let headerLength = 5
    /// Sixteen hex characters. See `DiscoveredEndpoint.discoveryId`.
    static let discoveryIdLength = 16

    struct Contents {
        var token: Data
        var displayName: String
        var psm: UInt16
        var discoveryId: String
    }

    static func encode(token: Data, displayName: String, psm: UInt16, discoveryId: String) -> Data {
        let clampedToken = token.count > maxTokenLength ? token.prefix(maxTokenLength) : token[...]

        // Only a well-formed id is published. A malformed one would be compared
        // against ours by the layer above, and something that can never match is
        // worse than nothing at all: it looks like a working filter.
        let idBytes = Data(discoveryId.utf8)
        let hasDiscoveryId = idBytes.count == discoveryIdLength

        var flags: UInt8 = 0
        if psm != 0 { flags |= flagHasPSM }
        if hasDiscoveryId { flags |= flagHasDiscoveryId }

        var out = Data(capacity: maxEncodedLength)
        out.append(version)
        out.append(flags)
        out.append(UInt8(truncatingIfNeeded: psm >> 8))
        out.append(UInt8(truncatingIfNeeded: psm))
        out.append(UInt8(clampedToken.count))
        out.append(contentsOf: clampedToken)
        if hasDiscoveryId {
            out.append(UInt8(idBytes.count))
            out.append(idBytes)
        }

        // The name is whatever room is left. Truncating UTF-8 by bytes can split
        // a scalar, so drop whole characters until it fits - a name that arrives
        // as replacement characters looks like a bug to the person reading it.
        var name = displayName
        while !name.isEmpty {
            let encoded = Data(name.utf8)
            if out.count + encoded.count <= maxEncodedLength {
                out.append(encoded)
                break
            }
            name.removeLast()
        }
        return out
    }

    /// Returns nil for anything malformed. Every byte here came from a peer.
    static func decode(_ data: Data) -> Contents? {
        guard data.count >= headerLength, data.count <= maxEncodedLength else { return nil }
        let bytes = [UInt8](data)
        guard bytes[0] == version else { return nil }

        let flags = bytes[1]
        let psm = (UInt16(bytes[2]) << 8) | UInt16(bytes[3])
        let tokenLength = Int(bytes[4])
        guard tokenLength <= maxTokenLength, headerLength + tokenLength <= bytes.count else { return nil }

        let token = Data(bytes[headerLength ..< headerLength + tokenLength])
        var cursor = headerLength + tokenLength

        var discoveryId = ""
        if (flags & flagHasDiscoveryId) != 0 {
            guard cursor < bytes.count else { return nil }
            let idLength = Int(bytes[cursor])
            cursor += 1
            guard idLength == discoveryIdLength, cursor + idLength <= bytes.count else { return nil }
            discoveryId = String(data: Data(bytes[cursor ..< cursor + idLength]), encoding: .utf8) ?? ""
            cursor += idLength
        }

        let nameBytes = Data(bytes[cursor...])
        let name = String(data: nameBytes, encoding: .utf8) ?? ""

        return Contents(
            token: token,
            displayName: name,
            psm: (flags & flagHasPSM) != 0 ? psm : 0,
            discoveryId: discoveryId
        )
    }
}
