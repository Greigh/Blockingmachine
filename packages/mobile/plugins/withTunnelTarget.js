// @ts-check
/**
 * Wires the `NEPacketTunnelProvider` app extension into the iOS project —
 * the on-device filtering VPN. `packet-tunnel-provider` is part of the
 * standard Network Extensions capability every paid App ID carries: no Apple
 * grant, TestFlight-shippable today (the same "local VPN" route
 * AdGuard/DNSCloak use). It is also the only consumer-viable iOS provider —
 * `dns-proxy` needs a supervised/MDM device (TN3134), which is why flag 89's
 * `BlockingmachineDNSProxy` target was removed rather than shipped.
 *
 * Canonical sources live in `targets/BlockingmachineTunnel/` — the tunnel
 * compiles the shared DNS wire helpers (`DnsPacket.swift`, `Blocklist.swift`)
 * as its own now that it is the only extension target.
 * BM_IOS_TUNNEL=0 strips the extension + its entitlements if a build ever
 * needs to omit it.
 */
const { apply } = require('./lib/extensionTarget');

/** @type {import('@expo/config-plugins').ConfigPlugin} */
module.exports = function withTunnelTarget(config) {
  if (process.env.BM_IOS_TUNNEL === '0') return config;
  return apply(config, {
    targetName: 'BlockingmachineTunnel',
    extBundleId: 'com.greighstudios.blockingmachine.tunnel',
    appGroup: 'group.com.greighstudios.blockingmachine',
    entitlement: 'packet-tunnel-provider',
    swiftFiles: [
      'IpPacket.swift',
      'TunnelProvider.swift',
      'ObservationLog.swift',
      'TunnelStatus.swift',
      'DnsPacket.swift',
      'Blocklist.swift',
    ],
  });
};
