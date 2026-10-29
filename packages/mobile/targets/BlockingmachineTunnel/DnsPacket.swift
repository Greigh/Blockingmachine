import Foundation

/// Minimal DNS wire helpers for the proxy: enough of the RFC 1035 header +
/// first-question section to classify a query and to build sinkhole/NXDOMAIN
/// answers. Compression pointers in the *question* section are not valid, so
/// label scanning is safe to stop at the first question.
enum DnsPacket {

    struct Query {
        /// The 12-byte header + question section verbatim — responses echo it.
        let headerQuestion: Data
        let queryType: UInt16
        let flags: UInt16
    }

    /// DNS type codes the proxy answers locally.
    private static let typeA: UInt16 = 1
    private static let typeAAAA: UInt16 = 28

    /// Parse a DNS message: returns the echoed header+question slice and QTYPE,
    /// or nil when the datagram is malformed or carries no question.
    static func parse(_ data: Data) -> Query? {
        guard data.count >= 12 else { return nil }
        let qdcount = (UInt16(data[4]) << 8) | UInt16(data[5])
        guard qdcount > 0 else { return nil }
        let flags = (UInt16(data[2]) << 8) | UInt16(data[3])

        var offset = 12
        // Walk QNAME labels to the terminating root label.
        while offset < data.count {
            let length = Int(data[offset])
            if length == 0 {
                offset += 1
                break
            }
            guard length <= 63 else { return nil } // 0xC0+ = pointer, invalid in QNAME
            offset += 1 + length
        }
        guard offset + 4 <= data.count else { return nil } // QTYPE + QCLASS
        let qtype = (UInt16(data[offset]) << 8) | UInt16(data[offset + 1])
        let end = offset + 4
        return Query(headerQuestion: data.subdata(in: 0..<end), queryType: qtype, flags: flags)
    }

    /// What the observation recorder needs from an upstream *response*:
    /// the header RCODE, the answer chain's CNAME depth, and the minimum TTL
    /// across answer RRs. Nil when the message is too short to read — the
    /// caller just records the query without upstream fields.
    static func responseSummary(_ data: Data) -> (rcode: Int, cnameDepth: Int, ttlMin: Int)? {
        guard data.count >= 12 else { return nil }
        let rcode = Int(data[3] & 0x0f)
        let qdcount = (Int(data[4]) << 8) | Int(data[5])
        let ancount = (Int(data[6]) << 8) | Int(data[7])

        var offset = 12
        // Skip the question section — same QNAME walk as `parse`.
        for _ in 0..<qdcount {
            guard let end = skipName(data, offset), end + 4 <= data.count else { return nil }
            offset = end + 4
        }

        var cnames = 0
        var ttlMin: Int?
        for _ in 0..<ancount {
            // RR name: labels or one compression pointer.
            guard let nameEnd = skipName(data, offset), nameEnd + 10 <= data.count else { return nil }
            let rtype = (UInt16(data[nameEnd]) << 8) | UInt16(data[nameEnd + 1])
            let ttl = (Int(data[nameEnd + 4]) << 24) | (Int(data[nameEnd + 5]) << 16)
                | (Int(data[nameEnd + 6]) << 8) | Int(data[nameEnd + 7])
            let rdlen = (Int(data[nameEnd + 8]) << 8) | Int(data[nameEnd + 9])
            guard nameEnd + 10 + rdlen <= data.count else { return nil }
            if rtype == 5 { cnames += 1 }
            ttlMin = min(ttlMin ?? ttl, ttl)
            offset = nameEnd + 10 + rdlen
        }
        return (rcode, cnames, ttlMin ?? 0)
    }

    /// Advance past a domain name — a label walk that ends at the root label
    /// or at one compression pointer (0xC0), which always terminates the name.
    private static func skipName(_ data: Data, _ start: Int) -> Int? {
        var offset = start
        while offset < data.count {
            let length = Int(data[offset])
            if length == 0 { return offset + 1 }
            if length & 0xC0 == 0xC0 {
                guard offset + 1 < data.count else { return nil }
                return offset + 2
            }
            guard length <= 63 else { return nil }
            offset += 1 + length
        }
        return nil
    }

    /// Extract the dotted query name for the matcher (lowercased, no trailing dot).
    static func queryName(_ data: Data) -> String? {
        guard data.count >= 13 else { return nil }
        var labels: [String] = []
        var offset = 12
        while offset < data.count {
            let length = Int(data[offset])
            if length == 0 { break }
            guard length <= 63, offset + 1 + length <= data.count else { return nil }
            let labelData = data.subdata(in: (offset + 1)..<(offset + 1 + length))
            guard let label = String(data: labelData, encoding: .ascii) else { return nil }
            labels.append(label)
            offset += 1 + length
        }
        return labels.isEmpty ? nil : labels.joined(separator: ".").lowercased()
    }

    /// Flags byte pair for a response: QR|AA, plus an RCODE in the low nibble.
    private static func responseFlags(rcode: UInt8) -> (UInt8, UInt8) {
        (0x84, rcode & 0x0f)
    }

    /// NXDOMAIN (rcode 3): header + echoed question, no answers.
    static func nxdomain(for query: Query) -> Data {
        var out = Data(query.headerQuestion)
        let (hi, lo) = responseFlags(rcode: 3)
        out[2] = hi
        out[3] = lo
        // QDCOUNT stays 1 (echoed question); ANCOUNT/NSCOUNT/ARCOUNT -> 0.
        out[6] = 0; out[7] = 0
        out[8] = 0; out[9] = 0
        out[10] = 0; out[11] = 0
        return out
    }

    /// Sinkhole answer for A (0.0.0.0) or AAAA (::): header + echoed question +
    /// one answer RR using a compression pointer (0xC00C) to the QNAME.
    static func sinkhole(for query: Query) -> Data {
        var out = nxdomain(for: query) // starts from correctly-flagged header+question
        let (hi, lo) = responseFlags(rcode: 0)
        out[2] = hi
        out[3] = lo
        out[7] = 1 // ANCOUNT = 1
        var answer = Data()
        answer.append(contentsOf: [0xC0, 0x0C]) // name -> QNAME pointer
        let isAAAA = query.queryType == typeAAAA
        let rtype = isAAAA ? typeAAAA : typeA
        answer.append(UInt8(rtype >> 8)); answer.append(UInt8(rtype & 0xff))
        answer.append(contentsOf: [0x00, 0x01]) // class IN
        answer.append(contentsOf: [0x00, 0x00, 0x00, 0x3C]) // TTL 60
        let rdata: [UInt8] = isAAAA
            ? [UInt8](repeating: 0, count: 16)
            : [0, 0, 0, 0]
        let rdlen = UInt16(rdata.count)
        answer.append(UInt8(rdlen >> 8)); answer.append(UInt8(rdlen & 0xff))
        answer.append(contentsOf: rdata)
        out.append(answer)
        return out
    }
}
