// @ts-check
/**
 * Wires the `NEPacketTunnelProvider` app extension into the iOS project —
 * the on-device filtering VPN. Unlike `withDnsProxyTarget`'s `dns-proxy`
 * value, `packet-tunnel-provider` is part of the standard Network Extensions
 * capability every paid App ID carries: no Apple grant, TestFlight-shippable
 * today (the same "local VPN" route AdGuard/DNSCloak use).
 *
 * Canonical sources live in `targets/BlockingmachineTunnel/`; the matcher +
 * DNS wire helpers (`DnsPacket.swift`, `Blocklist.swift`) are shared with the
 * dns-proxy target and copied in by `plugins/lib/extensionTarget.js`.
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
    swiftFiles: ['IpPacket.swift', 'TunnelProvider.swift'],
    // The DNS payload parser + suffix matcher stay canonical on the
    // dns-proxy target; this target compiles the same files.
    extraSrcDirs: [
      {
        dir: 'BlockingmachineDNSProxy',
        files: ['DnsPacket.swift', 'Blocklist.swift'],
      },
    ],
  });
};
