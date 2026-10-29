import ExpoModulesCore
import NetworkExtension

/// Bridge to `NETunnelProviderManager` — installs/controls the Blockingmachine
/// packet-tunnel extension (the on-device filtering VPN). The extension itself
/// is plain Swift + NetworkExtension in `targets/BlockingmachineTunnel/`; only
/// the control surface lives here. Ruleset delivery shares the same app-group
/// file `LocalDnsProxyModule.publishRuleset` writes — `ruleset_native.txt` is
/// format-identical for both extensions.
public class LocalTunnelModule: Module {

    private static let extensionBundleId = "com.greighstudios.blockingmachine.tunnel"

    public func definition() -> ModuleDefinition {
        Name("LocalTunnel")

        // {installed, enabled, connection} — "installed" once a saved manager
        // points at our appex bundle id; "connection" is the live NEVPNStatus.
        AsyncFunction("getStatus") { () async throws -> [String: Any] in
            let manager = try await Self.ourManager()
            guard let manager else {
                return ["installed": false, "enabled": false, "connection": "absent"]
            }
            return [
                "installed": true,
                "enabled": manager.isEnabled,
                "connection": Self.describeStatus(manager.connection.status),
            ]
        }

        // Find or create the manager pointing at the appex, persist, then
        // start/stop the tunnel. The first saveToPreferences surfaces the OS
        // "add VPN configuration" consent — that's the intended prompt.
        AsyncFunction("setEnabled") { (enabled: Bool) async throws in
            let manager = try await Self.loadOrCreateManager()
            manager.isEnabled = enabled
            try await manager.saveToPreferences()
            // The profile store is eventually consistent: right after the
            // consent-gated first save, loadFromPreferences can still throw
            // NEVPNErrorDomain 1 or read a stale isEnabled. Loop
            // load → re-assert → save until the flag sticks (~2s budget) —
            // the documented sequence for a fresh configuration.
            var lastLoadError: Error?
            for _ in 0..<10 {
                do {
                    try await manager.loadFromPreferences()
                    if manager.isEnabled == enabled {
                        lastLoadError = nil
                        break
                    }
                    manager.isEnabled = enabled
                    try await manager.saveToPreferences()
                    lastLoadError = nil
                } catch {
                    lastLoadError = error
                }
                try await Task.sleep(nanoseconds: 200_000_000)
            }
            if let lastLoadError { throw lastLoadError }
            if enabled {
                do {
                    try manager.connection.startVPNTunnel()
                } catch {
                    // Same staleness on the connection object — reload once
                    // and start again before surfacing the refusal.
                    try await manager.loadFromPreferences()
                    manager.isEnabled = true
                    try await manager.saveToPreferences()
                    try manager.connection.startVPNTunnel()
                }
            } else {
                manager.connection.stopVPNTunnel()
            }
        }
    }

    private static func ourManager() async throws -> NETunnelProviderManager? {
        try await allManagers().first(where: {
            ($0.protocolConfiguration as? NETunnelProviderProtocol)?
                .providerBundleIdentifier == extensionBundleId
        })
    }

    private static func loadOrCreateManager() async throws -> NETunnelProviderManager {
        let managers = try await allManagers()
        if let existing = managers.first(where: {
            ($0.protocolConfiguration as? NETunnelProviderProtocol)?
                .providerBundleIdentifier == extensionBundleId
        }) {
            return existing
        }
        let manager = NETunnelProviderManager()
        let proto = NETunnelProviderProtocol()
        proto.providerBundleIdentifier = extensionBundleId
        proto.serverAddress = "127.0.0.1" // display-only for per-app-less tunnels
        // The provider reads this in startTunnel(options:) — keeps upstream
        // configurable without touching appex code.
        proto.providerConfiguration = ["upstreamDns": "9.9.9.9", "upstreamPort": 53]
        manager.protocolConfiguration = proto
        manager.localizedDescription = "Blockingmachine"
        return manager
    }

    private static func allManagers() async throws -> [NETunnelProviderManager] {
        try await NETunnelProviderManager.loadAllFromPreferences()
    }

    private static func describeStatus(_ status: NEVPNStatus) -> String {
        switch status {
        case .connected: return "connected"
        case .connecting: return "connecting"
        case .reasserting: return "reasserting"
        case .disconnecting: return "disconnecting"
        case .disconnected: return "disconnected"
        default: return "invalid"
        }
    }
}
