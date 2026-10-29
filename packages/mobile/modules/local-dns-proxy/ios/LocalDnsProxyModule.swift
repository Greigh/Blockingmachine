import ExpoModulesCore

/// Bridge to the shared app-group container — what survives of the original
/// `NEDNSProxyManager` module after flag 89's removal: the dns-proxy provider
/// was deleted because Apple only runs it on supervised/MDM devices (TN3134),
/// while the file channel it created still feeds the packet-tunnel extension.
/// `publishRuleset` lands `ruleset_native.txt` where the appex reads it;
/// `drainObservations` pulls the tunnel's shadow-observation stream back out.
public class LocalDnsProxyModule: Module {

    private static let appGroup = "group.com.greighstudios.blockingmachine"
    private static let sharedRulesetName = "ruleset_native.txt"

    public func definition() -> ModuleDefinition {
        Name("LocalDnsProxy")

        // Copy a document-directory file into the app group so the extension
        // can read it. Returns the shared-container byte count written.
        AsyncFunction("publishRuleset") { (sourcePath: String) async throws -> Int in
            guard let container = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)
            else {
                throw NSError(
                    domain: "LocalDnsProxy", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "App group container unavailable — is group.com.greighstudios.blockingmachine in the entitlements?"]
                )
            }
            // JS hands us FileSystem paths, which arrive as `file://` URIs —
            // `URL(fileURLWithPath:)` would take that as a literal path.
            let src: URL
            if sourcePath.hasPrefix("file://"), let url = URL(string: sourcePath) {
                src = url
            } else {
                src = URL(fileURLWithPath: sourcePath)
            }
            let dst = container.appendingPathComponent(Self.sharedRulesetName)
            if FileManager.default.fileExists(atPath: dst.path) {
                try FileManager.default.removeItem(at: dst)
            }
            try FileManager.default.copyItem(at: src, to: dst)
            return Int((try FileManager.default.attributesOfItem(atPath: dst.path)[.size] as? NSNumber)?.intValue ?? 0)
        }

        // Read-and-clear the tunnel extension's shadow-observation stream
        // (`dns-observations.jsonl` + its single rotated generation). Returns
        // the drained body; "" when nothing is pending. A record appended
        // between read and clear is lost — the log is statistical evidence,
        // not a ledger, and the alternative (file-locking the appex) is worse.
        AsyncFunction("drainObservations") { () async throws -> String in
            guard let container = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)
            else { return "" }
            var body = ""
            for name in ["dns-observations.jsonl.1", "dns-observations.jsonl"] {
                let url = container.appendingPathComponent(name)
                guard FileManager.default.fileExists(atPath: url.path),
                      let text = try? String(contentsOf: url, encoding: .utf8)
                else { continue }
                body += text
            }
            if !body.isEmpty {
                try? FileManager.default.removeItem(
                    at: container.appendingPathComponent("dns-observations.jsonl.1"))
                try? "".write(
                    to: container.appendingPathComponent("dns-observations.jsonl"),
                    atomically: true, encoding: .utf8)
            }
            return body
        }

        // The extension's `tunnel-status.json` heartbeat verbatim, "" when it
        // has never reported. A nil group container is a real defect — throw
        // so Settings can say so instead of looking identical to "VPN off".
        AsyncFunction("tunnelStatus") { () async throws -> String in
            guard let container = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)
            else {
                throw NSError(
                    domain: "LocalDnsProxy", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "App group container unavailable"]
                )
            }
            let url = container.appendingPathComponent("tunnel-status.json")
            return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        }
    }
}
