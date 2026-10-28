import ExpoModulesCore
import NetworkExtension

/// Bridge to `NEDNSProxyManager` — installs/enables the Blockingmachine DNS
/// proxy extension system-wide, and publishes the synced native ruleset into
/// the app-group container the extension reads. The extension itself is plain
/// Swift + NetworkExtension; only the control surface lives here.
public class LocalDnsProxyModule: Module {

    private static let extensionBundleId = "com.blockingmachine.mobile.dnsproxy"
    private static let appGroup = "group.com.greighstudios.blockingmachine"
    private static let sharedRulesetName = "ruleset_native.txt"

    public func definition() -> ModuleDefinition {
        Name("LocalDnsProxy")

        // {installed, enabled} — the extension is considered installed once the
        // manager's saved providerProtocol points at its bundle id.
        AsyncFunction("getStatus") { () async throws -> [String: Any] in
            try await Self.loadManager()
            let proto = NEDNSProxyManager.shared().providerProtocol
            return [
                "installed": proto?.providerBundleIdentifier == Self.extensionBundleId,
                "enabled": NEDNSProxyManager.shared().isEnabled,
            ]
        }

        // Configure (or re-use) the manager pointing at the appex, set the
        // enabled flag and persist — first save surfaces the OS permission flow.
        AsyncFunction("setEnabled") { (enabled: Bool) async throws in
            try await Self.loadManager()
            let manager = NEDNSProxyManager.shared()
            if manager.providerProtocol?.providerBundleIdentifier != Self.extensionBundleId {
                let proto = NEDNSProxyProviderProtocol()
                proto.providerBundleIdentifier = Self.extensionBundleId
                // Provider reads this via startProxy(options:) — keeps the
                // upstream resolver configurable without touching appex code.
                proto.providerConfiguration = ["upstreamDns": "9.9.9.9", "upstreamPort": 53]
                manager.providerProtocol = proto
            }
            manager.localizedDescription = "Blockingmachine DNS"
            manager.isEnabled = enabled
            try await manager.saveToPreferences()
        }

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
    }

    private static func loadManager() async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            NEDNSProxyManager.shared().loadFromPreferences { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }
}

private extension NEDNSProxyManager {
    func saveToPreferences() async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            saveToPreferences { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }
}
