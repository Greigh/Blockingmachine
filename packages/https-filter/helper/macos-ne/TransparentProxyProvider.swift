// TransparentProxyProvider.swift — NETransparentProxyProvider scaffold (P5, entitlement-gated).
//
// STATUS: UNBUILT — this file cannot compile into a loadable system extension
// until the `com.apple.developer.networking.networkextension` entitlement with
// the `transparent-proxy` capability is granted by Apple for the
// Blockingmachine team ID. The request is an owner action (developer portal /
// entitlement email request). The pf+natlook-helper path remains the shipped
// capture mechanism; this provider is the planned v2 upgrade (design §11 P5).
//
// What the entitlement unblocks: kernel-level transparent TCP capture inside
// the app process — no pf rules, no root helper, no dedicated service user,
// and capture survives reboot by construction (the sysex is launchd-managed
// under the app's own lifecycle).
//
// Shape (mirrors natlook-helper's contract):
//   NETransparentProxyProvider.handleNewFlow(NEAppProxyTCPFlow)
//     → original destination = flow.remoteEndpoint (kernel-provided — no
//       DIOCNATLOOK, no SO_ORIGINAL_DST)
//     → open loopback socket to 127.0.0.1:9294
//     → write PROXY-v2 STREAM header (src = flow's localEndpoint/client,
//       dst = remoteEndpoint)
//     → bidirectional copy via flow.readData/write
//
// Egress-exemption note (the P1 hard requirement): NE flow rules can exclude
// by bundle ID / app rule — the engine process is excluded via
// NENetworkRule matching, which removes the dedicated-user requirement
// entirely on this path (the engine can run as the user again).

import Foundation
import NetworkExtension

final class TransparentProxyProvider: NETransparentProxyProvider {

    private let engineHost = "127.0.0.1"
    private let enginePort: UInt16 = 9294

    override func startProxy(options: [String: Any]?, completionHandler: @escaping (Error?) -> Void) {
        // Network rules arrive via the containing app's NETunnelProviderManager
        // config (`includedNetworkRules` — NENetworkRule matching TCP dst
        // ports 80/443, with exclusion rules for the engine binary).
        completionHandler(nil)
    }

    override func stopProxy(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEAppProxyFlow) -> Bool {
        guard let tcpFlow = flow as? NEAppProxyTCPFlow,
              let endpoint = tcpFlow.remoteEndpoint as? NWHostEndpoint else {
            return false // non-TCP (UDP flows would land as NEAppProxyUDPFlow) — let the system handle them
        }

        let dstAddr = endpoint.hostname // string form: "93.184.216.34" or a DNS name for FQDN flows
        let dstPort = UInt16(endpoint.port) ?? 0
        guard dstPort > 0 else { return false }

        // PROXY-v2 needs the CLIENT endpoint too. NEAppProxyFlow exposes
        // `metaData`/`sourceAppAuditToken` but not a socket-style local tuple;
        // the client address for transparent flows is the redirected source —
        // available via the flow's remote/local endpoints depending on Apple's
        // surface. The shipped contract tolerates a loopback src (the engine
        // consumes dst only — verified against proxyProtocol.ts), so we emit
        // src = 127.0.0.1:0 when the client tuple is unavailable.
        var src = sockaddr_storage(); var dst = sockaddr_storage()
        var srcLen = 0, dstLen = 0
        if !fillSockAddr(host: "127.0.0.1", port: 0, into: &src, len: &srcLen) { return false }
        if !fillSockAddr(host: dstAddr, port: dstPort, into: &dst, len: &dstLen) { return false }

        // Open the engine channel then bridge. Real implementation would use
        // NWConnection / CFSocket — kept abstract here: the splice shape is
        // the same read/write loop the C helper uses.
        guard let engine = openEngineChannel() else { return false }
        engine.sendProxyV2(src: src, srcLen: srcLen, dst: dst, dstLen: dstLen)

        bridge(flow: tcpFlow, engine: engine)
        return true
    }

    // --- scaffolds to fill when the entitlement lands ---

    private func openEngineChannel() -> EngineChannel? {
        // NWConnection(host: engineHost, port: enginePort, using: .tcp)
        return EngineChannel()
    }

    private func bridge(flow: NEAppProxyTCPFlow, engine: EngineChannel) {
        // Two copy loops:
        //   flow.readData { data, err in engine.write(data); recurse-or-close }
        //   engine.read   { data, err in flow.write(data); recurse-or-close }
        // Half-close: NEAppProxyTCPFlow has no true half-close — on read-EOF
        // the conventional pattern is `flow.closeReadWithError(nil)` +
        // continue draining the other direction until both closed.
        _ = flow
        _ = engine
    }

    private func fillSockAddr(host: String, port: UInt16, into addr: inout sockaddr_storage, len: inout Int) -> Bool {
        // inet_pton / inet6_pton + port htons — same byte layout as
        // splice.c's bm_proxy_v2_format (v4=28B, v6=52B wire headers).
        _ = host; _ = port; _ = &addr; _ = &len
        return true
    }
}

/// Loopback connection to the filter engine — placeholder for NWConnection.
final class EngineChannel {
    func sendProxyV2(src: sockaddr_storage, srcLen: Int, dst: sockaddr_storage, dstLen: Int) {
        // Emit the exact 12-byte signature + 0x21 + fam/proto + BE len +
        // src tuple + dst tuple — the golden vectors in splice-golden-test.c
        // and ProxyV2Test.kt pin the byte contract cross-platform.
        _ = src; _ = srcLen; _ = dst; _ = dstLen
    }
}
