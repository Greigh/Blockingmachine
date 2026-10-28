import Foundation

/// Suffix matcher over the shared `ruleset_native.txt` — the same bare-domain +
/// `!`-exception format the Android `Blocklist` consumes (`src/filter/ruleset.ts`
/// `toNativeRules` writes it). Exception wins over any covering block rule, and a
/// query for an exception host or any of its subdomains passes.
final class Blocklist {

    private(set) var blocked: Set<String> = []
    private(set) var exceptions: Set<String> = []

    var count: Int { blocked.count }

    /// Load `ruleset_native.txt` from the shared app-group container. Returns the
    /// number of block rules; a missing file is not an error — the proxy then
    /// behaves as a plain forwarder.
    @discardableResult
    func load(groupIdentifier: String) -> Int {
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: groupIdentifier)?
            .appendingPathComponent("ruleset_native.txt"),
            let body = try? String(contentsOf: container, encoding: .utf8)
        else { return 0 }

        var blocked: Set<String> = []
        var exceptions: Set<String> = []
        for raw in body.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces).lowercased()
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            if line.hasPrefix("!") {
                exceptions.insert(String(line.dropFirst()))
            } else {
                blocked.insert(line)
            }
        }
        self.blocked = blocked
        self.exceptions = exceptions
        return blocked.count
    }

    /// True when `name` is covered by a block rule and not rescued by an
    /// exception covering it (deepest match wins, same semantics as the core
    /// `domainEvaluator`).
    func isBlocked(_ name: String) -> Bool {
        var labels = name.lowercased().split(separator: ".").map(String.init)
        guard !labels.isEmpty else { return false }
        var blockedHit = false
        var exceptionHit = false
        while !labels.isEmpty {
            let candidate = labels.joined(separator: ".")
            if exceptions.contains(candidate) { exceptionHit = true }
            if blocked.contains(candidate) { blockedHit = true }
            labels.removeFirst()
        }
        return blockedHit && !exceptionHit
    }
}
