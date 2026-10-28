import Network
import NetworkExtension

/// System DNS proxy — iOS's device-wide counterpart of the desktop managed
/// daemon. The system hands this extension every cleartext DNS flow (UDP/TCP
/// port 53); blocked names answer locally from the synced ruleset in the shared
/// app-group container, everything else relays to the resolver the OS actually
/// intended to use (preserving the user's DNS choice and DoT where configured).
///
/// Upstream override (optional): `NEDNSProxyProviderProtocol.providerConfiguration`
/// set by the manager arrives here via `startProxy(options:)` —
/// {"upstreamDns": "9.9.9.9", "upstreamPort": 53}. Unset means "whatever the
/// system asked" — the flow's own remote endpoint.
///
/// SDK note: NetworkExtension's ObjC `NWEndpoint` class is deprecated on
/// iOS 18+ and ambiguous to name in Swift (`NetworkExtension.NWEndpoint`
/// resolves to two candidates). Everything flow-side is carried by type
/// inference inside the read callbacks — never annotate it; convert to
/// `Network.NWEndpoint` for `NWConnection` through `NWHostEndpoint`.
final class DNSProxyProvider: NEDNSProxyProvider {

    static let appGroup = "group.com.greighstudios.blockingmachine"

    private let blocklist = Blocklist()
    private var lastRulesLoad = Date.distantPast
    private var upstreamOverride: Network.NWEndpoint?
    /// UDP flows are per-app-socket, not per-endpoint — datagrams on one flow
    /// can target different resolvers, so relays key on flow + destination.
    /// TCP flows are single-endpoint; the flow id alone is the right key.
    private var udpRelays: [String: NWConnection] = [:]
    private var tcpRelays: [ObjectIdentifier: NWConnection] = [:]

    override func startProxy(options: [String: Any]?, completionHandler: @escaping (Error?) -> Void) {
        reloadRules(force: true)
        // providerConfiguration rides in `options` per the SDK contract.
        if let host = options?["upstreamDns"] as? String {
            let port = UInt16(options?["upstreamPort"] as? Int ?? 53)
            upstreamOverride = .hostPort(
                host: Network.NWEndpoint.Host(host),
                port: Network.NWEndpoint.Port(rawValue: port) ?? 53
            )
        }
        completionHandler(nil)
    }

    override func stopProxy(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        udpRelays.values.forEach { $0.cancel() }
        tcpRelays.values.forEach { $0.cancel() }
        udpRelays.removeAll()
        tcpRelays.removeAll()
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEAppProxyFlow) -> Bool {
        // The app can re-sync rules while the proxy runs — re-read the shared
        // file at most once a minute, per new flow rather than per datagram.
        reloadRules(force: false)
        if let udp = flow as? NEAppProxyUDPFlow {
            // nil local endpoint — no local address binding required.
            udp.open(withLocalEndpoint: nil) { [weak self] error in
                guard error == nil else { return }
                self?.readUdp(udp)
            }
            return true
        }
        if let tcp = flow as? NEAppProxyTCPFlow {
            tcp.open(withLocalEndpoint: nil) { [weak self] error in
                guard error == nil else { return }
                self?.readTcp(flow: tcp, pending: Data())
            }
            return true
        }
        return false
    }

    private func reloadRules(force: Bool) {
        guard force || Date().timeIntervalSince(lastRulesLoad) > 60 else { return }
        lastRulesLoad = Date()
        blocklist.load(groupIdentifier: DNSProxyProvider.appGroup)
    }

    // MARK: - UDP

    private func readUdp(_ flow: NEAppProxyUDPFlow) {
        flow.readDatagrams { [weak self] datagrams, endpoints, error in
            guard let self, error == nil, let datagrams, let endpoints else { return }
            var answers: [Data] = []
            var senderIdx: [Int] = []
            for (i, datagram) in datagrams.enumerated() {
                let remote = endpoints[i] // inferred NE NWEndpoint — do not annotate
                if let local = self.localAnswer(for: datagram) {
                    answers.append(local)
                    senderIdx.append(i)
                } else {
                    self.relayUdp(datagram, to: Self.toNWEndpoint(remote), flow: flow) { resp in
                        flow.writeDatagrams([resp], sentBy: [remote]) { _ in }
                    }
                }
            }
            if !answers.isEmpty {
                flow.writeDatagrams(answers, sentBy: senderIdx.map { endpoints[$0] }) { _ in }
            }
            self.readUdp(flow)
        }
    }

    /// NE-side flow endpoint → `Network.NWEndpoint` for `NWConnection`.
    private static func toNWEndpoint(_ ep: AnyObject) -> Network.NWEndpoint {
        if let host = ep as? NetworkExtension.NWHostEndpoint,
            let port = UInt16(host.port)
        {
            return .hostPort(
                host: Network.NWEndpoint.Host(host.hostname),
                port: Network.NWEndpoint.Port(rawValue: port) ?? 53
            )
        }
        return .hostPort(host: "9.9.9.9", port: 53)
    }

    /// A locally-produced response for blocked names, nil when the query should
    /// go upstream. Non-question or malformed datagrams fall through to relay.
    private func localAnswer(for datagram: Data) -> Data? {
        guard let query = DnsPacket.parse(datagram),
            let name = DnsPacket.queryName(datagram),
            blocklist.isBlocked(name)
        else { return nil }
        return (query.queryType == 1 || query.queryType == 28)
            ? DnsPacket.sinkhole(for: query)
            : DnsPacket.nxdomain(for: query)
    }

    private func relayUdp(_ datagram: Data, to target: Network.NWEndpoint,
                          flow: NEAppProxyUDPFlow, writeBack: @escaping (Data) -> Void) {
        let destination = upstreamOverride ?? target
        let key = "\(ObjectIdentifier(flow))|\(destination)"
        let conn: NWConnection
        if let existing = udpRelays[key] {
            conn = existing
        } else {
            let c = NWConnection(to: destination, using: .udp)
            udpRelays[key] = c
            c.start(queue: .global())
            conn = c
        }
        conn.send(content: datagram, completion: .contentProcessed { sendError in
            guard sendError == nil else { return }
            conn.receiveMessage { content, _, _, _ in
                guard let content, !content.isEmpty else { return }
                writeBack(content)
            }
        })
    }

    // MARK: - TCP (length-prefixed DNS over TCP)

    /// DNS/TCP frames each message with a 2-byte length prefix; `pending`
    /// accumulates until a whole frame has arrived.
    private func readTcp(flow: NEAppProxyTCPFlow, pending: Data) {
        flow.readData { [weak self] chunk, error in
            guard let self, error == nil, let chunk, !chunk.isEmpty else { return }
            var buffer = pending
            buffer.append(chunk)
            var responses = Data()
            while buffer.count >= 2 {
                let length = (Int(buffer[0]) << 8) | Int(buffer[1])
                guard buffer.count >= 2 + length else { break }
                let message = buffer.subdata(in: 2..<(2 + length))
                buffer.removeFirst(2 + length)
                if let local = self.localAnswer(for: message) {
                    // The response may differ in size from the query — re-frame it.
                    responses.append(UInt8(local.count >> 8))
                    responses.append(UInt8(local.count & 0xff))
                    responses.append(local)
                } else {
                    self.relayTcp(message, flow: flow)
                }
            }
            if !responses.isEmpty {
                flow.write(responses) { _ in }
            }
            self.readTcp(flow: flow, pending: buffer)
        }
    }

    private func relayTcp(_ message: Data, flow: NEAppProxyTCPFlow) {
        let key = ObjectIdentifier(flow)
        let target = upstreamOverride ?? Self.toNWEndpoint(flow.remoteEndpoint)
        let conn: NWConnection
        if let existing = tcpRelays[key] {
            conn = existing
        } else {
            let c = NWConnection(to: target, using: .tcp)
            tcpRelays[key] = c
            c.start(queue: .global())
            conn = c
        }
        var framed = Data([UInt8(message.count >> 8), UInt8(message.count & 0xff)])
        framed.append(message)
        conn.send(content: framed, completion: .contentProcessed { sendError in
            guard sendError == nil else { return }
            conn.receive(minimumIncompleteLength: 2, maximumLength: 65535) { head, _, _, _ in
                guard let head, head.count >= 2 else { return }
                let length = (Int(head[0]) << 8) | Int(head[1])
                conn.receive(minimumIncompleteLength: length, maximumLength: length) { body, _, _, _ in
                    guard let body else { return }
                    var out = Data(head.prefix(2))
                    out.append(body)
                    flow.write(out) { _ in }
                }
            }
        })
    }
}
