// @ts-check
/**
 * Wires the `NEDNSProxyProvider` app extension into the iOS project. The
 * extension is a real second binary (.appex embedded in PlugIns) — the only
 * way iOS permits device-wide DNS filtering without a VPN tunnel. Canonical
 * sources live in `targets/BlockingmachineDNSProxy/` so `expo prebuild --clean`
 * can regenerate `ios/`; `plugins/lib/extensionTarget.js` performs the actual
 * copy + pbxproj surgery.
 *
 * Entitlement notes: the app itself needs `networkextension`/`dns-proxy` to
 * drive NEDNSProxyManager, and both targets share
 * `group.com.greighstudios.blockingmachine` so `ruleset_native.txt` reaches
 * the extension. The dns-proxy capability needs Apple's approval on the
 * provisioning profile (flag 89) — BM_IOS_DNSPROXY=0 strips the extension +
 * its entitlements for builds where the grant has not landed (TestFlight).
 */
const { apply } = require('./lib/extensionTarget');

/** @type {import('@expo/config-plugins').ConfigPlugin} */
module.exports = function withDnsProxyTarget(config) {
  if (process.env.BM_IOS_DNSPROXY === '0') return config;
  return apply(config, {
    targetName: 'BlockingmachineDNSProxy',
    extBundleId: 'com.greighstudios.blockingmachine.dnsproxy',
    appGroup: 'group.com.greighstudios.blockingmachine',
    entitlement: 'dns-proxy',
    swiftFiles: ['DnsPacket.swift', 'Blocklist.swift', 'DNSProxyProvider.swift'],
  });
};
