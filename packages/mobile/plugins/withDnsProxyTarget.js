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
 * the extension. `dns-proxy` is a self-serve value under the standard
 * Network Extensions capability — no Apple grant exists for it — but
 * TN3134 restricts `NEDNSProxyProvider` app extensions on iOS to
 * supervised/MDM-managed devices, enforced at runtime. BM_IOS_DNSPROXY=0
 * strips the extension + its entitlements from consumer builds
 * (TestFlight) where it could never run anyway (flag 89).
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
