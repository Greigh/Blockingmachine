import Foundation

/// Flag-43 recorder: every query the tunnel answers becomes one JSONL record
/// (`{"domain","verdict","rcode","cname_depth","ttl_min","latency_ms"}`) in the
/// app-group container — the same `DnsObservationRecord` shape the desktop
/// daemon's recorder writes. The main app drains the file and POSTs the batch
/// to the hub's `/v1/shadow/observations`, where the learned-model shadow
/// scorer compares each domain's production verdict with the candidate
/// model's — the accrual that decides whether the AI ever gets to enforce.
///
/// Fail-soft by construction: every write is `try?`, a missing group
/// container just skips recording, and nothing here can stall the read loop.
/// Dedup mirrors the hub recorder's — a domain re-recorded within five
/// minutes is residue, not signal — because every line is a future upload.
enum ObservationLog {

    private static let fileName = "dns-observations.jsonl"
    private static let rotatedName = "dns-observations.jsonl.1"
    /// One rotation generation, ~256 KB live + ~256 KB rotated — bounded even
    /// when the phone never pairs with a hub.
    private static let rotateAtBytes: UInt64 = 256 * 1024
    private static let dedupeWindow: TimeInterval = 300
    private static let dedupeMaxEntries = 500

    /// Serial queue: `handle` runs on packetFlow's queue but relay completions
    /// run on `.global()` — appends must interleave atomically.
    private static let queue = DispatchQueue(label: "org.blockingmachine.obslog")
    private static var lastRecorded: [String: Date] = [:]

    /// Append one observation. Called from both the local-answer path
    /// (verdict BLOCKED, upstream fields nil) and the relay path (verdict
    /// ALLOWED, fields read off the upstream response).
    static func record(
        domain: String,
        verdict: String,
        rcode: Int? = nil,
        cnameDepth: Int? = nil,
        ttlMin: Int? = nil,
        latencyMs: Int? = nil
    ) {
        queue.async {
            let now = Date()
            if let last = lastRecorded[domain], now.timeIntervalSince(last) < dedupeWindow {
                return
            }
            lastRecorded[domain] = now
            if lastRecorded.count > dedupeMaxEntries {
                // Cheap prune: drop the oldest quarter rather than tracking
                // insertion order — dedup is a volume control, not an LRU spec.
                let cutoff = now.addingTimeInterval(-dedupeWindow / 2)
                lastRecorded = lastRecorded.filter { $0.value > cutoff }
                if lastRecorded.count > dedupeMaxEntries {
                    lastRecorded.removeAll(keepingCapacity: true)
                }
            }
            write(domain: domain, verdict: verdict, rcode: rcode,
                  cnameDepth: cnameDepth, ttlMin: ttlMin, latencyMs: latencyMs)
        }
    }

    private static func write(
        domain: String, verdict: String, rcode: Int?,
        cnameDepth: Int?, ttlMin: Int?, latencyMs: Int?
    ) {
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: TunnelProvider.appGroup)
        else { return }
        let file = container.appendingPathComponent(fileName)

        if let size = try? FileManager.default
            .attributesOfItem(atPath: file.path)[.size] as? UInt64,
           size > rotateAtBytes {
            let rotated = container.appendingPathComponent(rotatedName)
            try? FileManager.default.removeItem(at: rotated)
            try? FileManager.default.moveItem(at: file, to: rotated)
        }

        var rec: [String: Any] = ["domain": domain, "verdict": verdict]
        if let rcode { rec["rcode"] = rcode }
        if let cnameDepth { rec["cname_depth"] = cnameDepth }
        if let ttlMin { rec["ttl_min"] = ttlMin }
        if let latencyMs { rec["latency_ms"] = latencyMs }
        guard let line = try? JSONSerialization.data(withJSONObject: rec) else { return }
        var payload = line
        payload.append(0x0a) // '\n'

        if FileManager.default.fileExists(atPath: file.path) {
            guard let handle = try? FileHandle(forWritingTo: file) else { return }
            defer { try? handle.close() }
            try? handle.seekToEnd()
            try? handle.write(contentsOf: payload)
        } else {
            try? payload.write(to: file, options: .atomic)
        }
    }
}
