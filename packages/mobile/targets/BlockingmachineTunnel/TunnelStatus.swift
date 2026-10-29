import Foundation

/// Liveness heartbeat the app can see: the extension reports rules-loaded and
/// packet counters to `tunnel-status.json` in the app-group container, and
/// Settings renders them so "the VPN is on but nothing is filtered" is
/// answerable without a Mac attached — absent file means the extension never
/// ran, rules:0 means the shared ruleset never published, packets:0 means
/// traffic never entered the tunnel.
///
/// Same fail-soft shape as `ObservationLog`: every write is `try?`, a missing
/// container just skips reporting, and nothing here can stall the read loop.
enum TunnelStatus {

    private static let fileName = "tunnel-status.json"
    /// Coalesce bursts — a write per packet would spin the disk; one every two
    /// seconds still reads as live in Settings' 4s polling.
    private static let minWriteInterval: TimeInterval = 2

    private static let queue = DispatchQueue(label: "org.blockingmachine.tunnelstatus")
    private static var packets = 0
    private static var blocked = 0
    private static var relayed = 0
    private static var rules = 0
    private static var startedAt = Date()
    private static var lastWrite = Date.distantPast

    /// Called from `startTunnel` and the periodic rules reload.
    static func rulesLoaded(_ count: Int) {
        queue.async {
            rules = count
            flush(force: true)
        }
    }

    /// Called for every DNS datagram that reaches `handle`.
    static func packet() { bump { packets += 1 } }

    /// A query answered locally (sinkhole/NXDOMAIN) or relayed upstream.
    static func answeredBlocked() { bump { blocked += 1 } }
    static func answeredRelayed() { bump { relayed += 1 } }

    private static func bump(_ increment: () -> Void) {
        queue.async {
            increment()
            flush()
        }
    }

    private static func flush(force: Bool = false) {
        let now = Date()
        guard force || now.timeIntervalSince(lastWrite) >= minWriteInterval else { return }
        lastWrite = now
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: TunnelProvider.appGroup)
        else { return }
        let payload: [String: Any] = [
            "at": ISO8601DateFormatter().string(from: now),
            "started_at": ISO8601DateFormatter().string(from: startedAt),
            "rules": rules,
            "packets": packets,
            "blocked": blocked,
            "relayed": relayed,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(
            to: container.appendingPathComponent(fileName),
            options: .atomic
        )
    }
}
