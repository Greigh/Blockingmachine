import Foundation

/// Minimal IPv4/IPv6 + UDP wire helpers for the packet tunnel. The TUN device
/// hands raw IP datagrams — enough parsing to reach the UDP payload on :53 and
/// to wrap a locally-produced DNS response in a routable reply packet.
///
/// Deliberately not handled: IP options, IPv6 extension headers (fragment,
/// hop-by-hop — almost unseen on stub-resolver DNS), and TCP. TCP DNS needs a
/// userspace stack; those segments are dropped upstream of here, matching the
/// documented UDP-only posture of the tunnel.
enum IpPacket {

    private static let protoUdp: UInt8 = 17

    struct Parsed {
        /// AF_INET or AF_INET6 — echoes back as the packetFlow protocol.
        let family: Int32
        /// Raw address bytes (4 or 16) of the sender — becomes the reply's dst.
        let srcAddr: Data
        /// Raw address bytes of the packet's destination — becomes reply's src.
        let dstAddr: Data
        let proto: UInt8
        /// L4 payload (UDP/TCP datagram) — the slice after the IP header.
        let payload: Data
    }

    struct Udp {
        let srcPort: UInt16
        let dstPort: UInt16
        /// UDP payload — the DNS wire message for :53 traffic.
        let payload: Data
    }

    static func parse(_ packet: Data, family: Int32) -> Parsed? {
        if family == AF_INET6 {
            // Fixed 40-byte header; next-header at 6. Extension headers are
            // skipped only when a plain hop chain leads to UDP — anything else
            // is out of scope for a DNS filter.
            guard packet.count >= 40 else { return nil }
            var nextHeader = packet[6]
            var offset = 40
            // Walk well-known extension headers (hop-by-hop 0, routing 43,
            // destination 60): each is len-prefixed in 8-octet units.
            var hops = 0
            while [0, 43, 60].contains(nextHeader), hops < 4 {
                guard packet.count >= offset + 2 else { return nil }
                nextHeader = packet[offset]
                let extLen = (Int(packet[offset + 1]) + 1) * 8
                guard packet.count >= offset + extLen else { return nil }
                offset += extLen
                hops += 1
            }
            guard nextHeader == protoUdp, packet.count >= offset + 8 else { return nil }
            return Parsed(
                family: AF_INET6,
                srcAddr: packet.subdata(in: 8..<24),
                dstAddr: packet.subdata(in: 24..<40),
                proto: protoUdp,
                payload: packet.subdata(in: offset..<packet.count)
            )
        }
        guard family == AF_INET, packet.count >= 20 else { return nil }
        let ihl = Int(packet[0] & 0x0f) * 4
        guard ihl >= 20, packet.count >= ihl else { return nil }
        // Fragmented datagrams: only first-fragment could carry the header —
        // MF flag or a nonzero offset means we cannot classify, drop.
        let fragField = (UInt16(packet[6]) << 8) | UInt16(packet[7])
        guard fragField & 0x3fff == 0 else { return nil }
        let proto = packet[9]
        guard proto == protoUdp else { return nil }
        let totalLen = (Int(packet[2]) << 8) | Int(packet[3])
        let payloadLen = min(packet.count, max(ihl, totalLen))
        guard payloadLen >= ihl + 8 else { return nil }
        return Parsed(
            family: AF_INET,
            srcAddr: packet.subdata(in: 12..<16),
            dstAddr: packet.subdata(in: 16..<20),
            proto: proto,
            payload: packet.subdata(in: ihl..<payloadLen)
        )
    }

    static func parseUdp(_ data: Data) -> Udp? {
        guard data.count >= 8 else { return nil }
        let src = (UInt16(data[0]) << 8) | UInt16(data[1])
        let dst = (UInt16(data[2]) << 8) | UInt16(data[3])
        let len = (Int(data[4]) << 8) | Int(data[5])
        guard len >= 8, data.count >= len else { return nil }
        return Udp(srcPort: src, dstPort: dst, payload: data.subdata(in: 8..<len))
    }

    /// Wrap `payload` in a reply datagram: src/dst addresses and ports swapped
    /// from the request. IPv4 UDP checksums are optional (zeroed); IPv6
    /// requires one — computed over the pseudo-header + datagram.
    static func udpReply(to request: Parsed, udp: Udp, payload: Data) -> Data {
        var udpLen = 8 + payload.count
        var dgram = Data(capacity: udpLen + 40)
        dgram.append(contentsOf: [UInt8(udp.dstPort >> 8), UInt8(udp.dstPort & 0xff)])
        dgram.append(contentsOf: [UInt8(udp.srcPort >> 8), UInt8(udp.srcPort & 0xff)])
        dgram.append(contentsOf: [UInt8(udpLen >> 8), UInt8(udpLen & 0xff)])
        dgram.append(contentsOf: [0, 0]) // checksum — v4 skips, v6 fills below
        dgram.append(payload)
        udpLen = dgram.count

        if request.family == AF_INET6 {
            var packet = Data(capacity: 40 + dgram.count)
            packet.append(contentsOf: [0x60, 0, 0, 0]) // version 6, tc/fl 0
            packet.append(contentsOf: [UInt8(udpLen >> 8), UInt8(udpLen & 0xff)])
            packet.append(contentsOf: [protoUdp, 64]) // next header, hop limit
            packet.append(request.dstAddr)
            packet.append(request.srcAddr)
            packet.append(dgram)
            let sum = udpChecksumV6(src: request.dstAddr, dst: request.srcAddr, udp: dgram)
            packet[40 + 6] = UInt8(sum >> 8)
            packet[40 + 7] = UInt8(sum & 0xff)
            return packet
        }

        var packet = Data(capacity: 20 + dgram.count)
        packet.append(contentsOf: [0x45, 0]) // version 4, ihl 5, tos
        let total = 20 + dgram.count
        packet.append(contentsOf: [UInt8(total >> 8), UInt8(total & 0xff)])
        packet.append(contentsOf: [0, 0, 0x40, 0]) // id, DF
        packet.append(contentsOf: [64, protoUdp]) // ttl, proto
        packet.append(contentsOf: [0, 0]) // header checksum — filled below
        packet.append(request.dstAddr)
        packet.append(request.srcAddr)
        packet.append(dgram)
        let sum = headerChecksum(packet.subdata(in: 0..<20))
        packet[10] = UInt8(sum >> 8)
        packet[11] = UInt8(sum & 0xff)
        return packet
    }

    /// RFC 1071 internet checksum over a byte range.
    private static func headerChecksum(_ data: Data) -> UInt16 {
        var sum: UInt32 = 0
        var i = 0
        while i + 1 < data.count {
            sum += UInt32((UInt16(data[i]) << 8) | UInt16(data[i + 1]))
            i += 2
        }
        if i < data.count { sum += UInt32(UInt16(data[i]) << 8) }
        while (sum >> 16) != 0 { sum = (sum & 0xffff) + (sum >> 16) }
        return ~UInt16(truncatingIfNeeded: sum)
    }

    /// IPv6 UDP checksum is mandatory — pseudo-header + full datagram.
    private static func udpChecksumV6(src: Data, dst: Data, udp: Data) -> UInt16 {
        var pseudo = Data()
        pseudo.append(src)
        pseudo.append(dst)
        let len = UInt32(udp.count)
        pseudo.append(contentsOf: [UInt8(len >> 24), UInt8(len >> 16), UInt8(len >> 8), UInt8(len)])
        pseudo.append(contentsOf: [0, 0, 0, protoUdp])
        var sum: UInt32 = 0
        for block in [pseudo, udp] {
            var i = 0
            while i + 1 < block.count {
                sum += UInt32((UInt16(block[i]) << 8) | UInt16(block[i + 1]))
                i += 2
            }
            if i < block.count { sum += UInt32(UInt16(block[i]) << 8) }
        }
        while (sum >> 16) != 0 { sum = (sum & 0xffff) + (sum >> 16) }
        let folded = ~UInt16(truncatingIfNeeded: sum)
        return folded == 0 ? 0xffff : folded
    }
}
