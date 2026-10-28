import Network
import NetworkExtension

/// On-device DNS-filtering VPN — the iOS counterpart of the desktop managed
/// daemon and Android's VpnService path. This is the *standard* Network
/// Extensions surface (`packet-tunnel-provider`): runs on any consumer
/// device, unlike flag 89's `NEDNSProxyProvider`, which Apple restricts to
/// supervised/MDM-managed devices (TN3134).
///
/// Scope is deliberately DNS-only, the "local VPN" shape AdGuard/DNSCloak use:
/// `NEDNSSettings` advertises an on-tunnel resolver address, and the IPv4/IPv6
/// route tables cover only that address — so every system DNS query enters the
/// tunnel while all other traffic flows direct. Blocked names answer from the
/// synced ruleset in the shared app-group container (`ruleset_native.txt`,
/// same format the dns-proxy extension and Android consume); allowed queries
/// relay upstream over UDP, preserving nothing of the user's resolver choice —
/// the configured upstream (default Quad9) is the honest trade for filtering.
///
/// Honest limits, matching the desktop DNS-only posture: apps that bypass
/// system DNS (hardcoded resolvers, DoH/DoT) are invisible to this tunnel
/// unless they land on the advertised resolver address; TCP :53 needs a
/// userspace stack and is dropped (clients retry UDP); and domain-filtered
/// VPN is not HTTPS MITM — the CA/MITM path is flag 125's on-device engine.
final class TunnelProvider: NEPacketTunnelProvider {

    static let appGroup = "group.com.greighstudios.blockingmachine"

    /// The fictional on-tunnel resolver the OS sends all DNS to.
    private static let dnsV4 = "10.0.53.1"
    private static let dnsV6 = "fd00::53:1"

    private let blocklist = Blocklist()
    private var lastRulesLoad = Date.distantPast
    private var upstream: Network.NWEndpoint =
        .hostPort(host: "9.9.9.9", port: 53)

    /// Relays keyed by the client's original dst port — each outstanding query
    /// gets its own NWConnection so a slow upstream never blocks another.
    private var relays: [UInt16: NWConnection] = [:]

    override func startTunnel(
        options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void
    ) {
        blocklist.load(groupIdentifier: Self.appGroup)
        if let proto = protocolConfiguration as? NETunnelProviderProtocol,
           let conf = proto.providerConfiguration,
           let host = conf["upstreamDns"] as? String {
            upstream = .hostPort(
                host: Network.NWEndpoint.Host(host),
                port: Network.NWEndpoint.Port(rawValue: UInt16(conf["upstreamPort"] as? Int ?? 53)) ?? 53
            )
        }
        setTunnelNetworkSettings(makeSettings()) { [weak self] error in
            if let error {
                completionHandler(error)
                return
            }
            self?.readLoop()
            completionHandler(nil)
        }
    }

    override func stopTunnel(
        with reason: NEProviderStopReason, completionHandler: @escaping () -> Void
    ) {
        relays.values.forEach { $0.cancel() }
        relays.removeAll()
        completionHandler()
    }

    /// DNS-only tunnel settings: the resolver IPs are reachable only through
    /// the tunnel, everything else keeps the device's normal routes.
    private func makeSettings() -> NEPacketTunnelNetworkSettings {
        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        settings.mtu = 1500

        let v4 = NEIPv4Settings(addresses: ["10.0.53.2"], subnetMasks: ["255.255.255.255"])
        v4.includedRoutes = [
            NEIPv4Route(destinationAddress: Self.dnsV4, subnetMask: "255.255.255.255"),
        ]
        settings.ipv4Settings = v4

        let v6 = NEIPv6Settings(addresses: ["fd00::53:2"], networkPrefixLengths: [128])
        v6.includedRoutes = [
            NEIPv6Route(destinationAddress: Self.dnsV6, networkPrefixLength: 128),
        ]
        settings.ipv6Settings = v6

        let dns = NEDNSSettings(servers: [Self.dnsV4, Self.dnsV6])
        dns.matchDomains = [""] // every domain, not just suffix-matched ones
        settings.dnsSettings = dns
        return settings
    }

    private func readLoop() {
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self else { return }
            for (i, packet) in packets.enumerated() {
                self.handle(packet, family: protocols[i].int32Value)
            }
            self.readLoop()
        }
    }

    private func reloadRules() {
        // The app re-syncs while the tunnel runs — re-read at most once a
        // minute, per inbound packet burst rather than per datagram.
        guard Date().timeIntervalSince(lastRulesLoad) > 60 else { return }
        lastRulesLoad = Date()
        blocklist.load(groupIdentifier: Self.appGroup)
    }

    private func handle(_ packet: Data, family: Int32) {
        reloadRules()
        guard let ip = IpPacket.parse(packet, family: family),
              let udp = IpPacket.parseUdp(ip.payload),
              udp.dstPort == 53
        else { return } // nothing else routes here — drop honestly

        if let local = localAnswer(for: udp.payload) {
            packetFlow.writePackets(
                [IpPacket.udpReply(to: ip, udp: udp, payload: local)],
                withProtocols: [NSNumber(value: ip.family)]
            )
            return
        }
        relay(ip: ip, udp: udp)
    }

    /// A locally-produced response for blocked names, nil when the query
    /// should go upstream. Malformed datagrams fall through to relay.
    private func localAnswer(for datagram: Data) -> Data? {
        guard let query = DnsPacket.parse(datagram),
              let name = DnsPacket.queryName(datagram),
              blocklist.isBlocked(name)
        else { return nil }
        return (query.queryType == 1 || query.queryType == 28)
            ? DnsPacket.sinkhole(for: query)
            : DnsPacket.nxdomain(for: query)
    }

    /// Forward one query upstream and write the response back to the client.
    /// The relay is keyed on the client's source port so the reply packet can
    /// rebuild swapped headers exactly.
    private func relay(ip: IpPacket.Parsed, udp: IpPacket.Udp) {
        let conn: NWConnection
        if let existing = relays[udp.srcPort] {
            conn = existing
        } else {
            let c = NWConnection(to: upstream, using: .udp)
            relays[udp.srcPort] = c
            c.start(queue: .global())
            conn = c
        }
        conn.send(content: udp.payload, completion: .contentProcessed { [weak self] sendError in
            guard sendError == nil else { return }
            conn.receiveMessage { content, _, _, _ in
                guard let self, let content, !content.isEmpty else { return }
                self.packetFlow.writePackets(
                    [IpPacket.udpReply(to: ip, udp: udp, payload: content)],
                    withProtocols: [NSNumber(value: ip.family)]
                )
            }
        })
    }
}
