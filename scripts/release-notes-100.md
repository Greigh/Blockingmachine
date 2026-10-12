## Blockingmachine v1.0.0

First stable release. Twelve release candidates of security auditing, independent verification, accessibility remediation, and platform hardening land here: a multi-pass security programme traced every finding to source and reproduced it before fixing, the Electron UI is axe-clean in both themes and verified under a live VoiceOver session and Android TalkBack, the managed DNS daemon, feed server, browser extension, Home Assistant surfaces, and mobile companion all ship from the same tag, and Mini-AI — the on-device threat classifier — now learns from live DNS and browser observations and explains its verdicts.

### Highlights since rc.12

- **Extension tier compilation now ships the real plan — including the security tier.** The compiler only ever looked inside the repository for its inputs, but the hub writes its synced lists to the configured output directory — so published extension zips were built from a weeks-old stale list and the classifier's `malware.txt` verdicts (7,291 of them) sat unfound beside the live blocklist. `tier_security` shipped empty on every release; it now ships ~3,200 rules inside a full 30,000-rule plan, ~98% of hosts placed by the hub's own category manifest. The published rc.10/rc.11/rc.12 extension zips were rebuilt and re-uploaded with corrected data — verified by downloading each artifact back and checking tier counts and `SHA256SUMS.txt`.
- **Home Assistant integration gets push updates.** The custom integration holds a persistent `/v1/events` SSE subscription against the hub and re-fires each event onto the HA bus as `blockingmachine_<name>` (`protection_changed`, `compile_completed`, `remote_control`, `rules_updated`, `quarantine_added`), with immediate coordinator refresh on state-changing events and bounded exponential backoff while polling remains the source of truth.
- **Home Assistant add-on cleanup and parity.** The `5353/udp` declaration that broke installs on hosts running mDNS is removed (nothing listens on UDP), the dead `export_formats` option is gone, `log_level` is actually wired, and `/v1/control/cosmetics` + `/v1/control/reload` now serve the hub's `remote_control` SSE contract so the browser extension works the same pointed at either server.
- **Mini-AI v3 pipeline advances.** Live DNS and browser observations score into serving verdicts through a bounded LRU index (foreign CNAME hops, prior blocked answers, wide fan-out, NXDOMAIN churn corroborate non-clean verdicts and explain themselves), Inspector feedback feeds `labels.db` through the anti-poisoned merge path, a calibration-gated credential-lure signal fires on phishing wording but never on `login.<readable-zone>`, and the Settings pane shows real v3 promotion-gate readiness.
- **Menu-bar agent mode (macOS).** Opt-in status-bar mode: closing the window hides it to the tray while protection, the feed server, and scheduled compiles keep running; login-item launch starts hidden; single-instance locking routes a second launch to the existing window.
- **electron-store 12.** Upgraded with a full breaking-change audit; the parsed-config cache is enabled so every `.get()` stops re-reading the file.

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0/Blockingmachine-1.0.0-arm64.dmg) | macOS Apple Silicon installer (notarized) |
| [`Blockingmachine-darwin-arm64-1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0/Blockingmachine-darwin-arm64-1.0.0.zip) | macOS Apple Silicon standalone zipped app (notarized) |
| [`blockingmachine-core-1.0.0.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0/blockingmachine-core-1.0.0.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0/blockingmachine-cli-1.0.0.tgz) | CLI executable NPM package |
| [`blockingmachine-chrome-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Web Store Manifest V3 browser extension bundle |
| [`blockingmachine-firefox-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Add-ons Manifest V3 browser extension bundle |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0/SHA256SUMS.txt) | SHA-256 verification checksums |

**Mobile:** the signed Android APK and the iOS build ship under [`mobile-v1.0.0`](https://github.com/Greigh/Blockingmachine/releases/tag/mobile-v1.0.0). Existing debug-signed Android installs cannot upgrade in place — uninstall and re-pair once.

**Home Assistant:** install the add-on by adding this repository's URL in *Settings → Add-ons → Add-on Store → Repositories*, then refresh. The `v1.0.0` tag carries the add-on and the HACS integration; administrative actions require the dedicated admin credential.

### Verification Checksums (SHA-256)

```text
4fdaa9cb8da895c8977fb569006c79061ed9118d6642e90aee15a937d8a05177  Blockingmachine-1.0.0-arm64.dmg
16e3fdce49a73cc65b4fc9c336f139603283145d3ed4bb50de0bf230dead773b  Blockingmachine-darwin-arm64-1.0.0.zip
0767d24035ec3f60efbc6c06bab51cf6e7adb27afd84b37415d57c51fcb08044  blockingmachine-chrome-mv3-v1.0.0.zip
59ec69ebef0b4556e2b57d4b4c6e38339a1e3fcf6287da43c6f7451163a1fcb1  blockingmachine-cli-1.0.0.tgz
51769542c8b8f9a363970477dc24f15b145b912540cd51ef9b6e22bfafb306df  blockingmachine-core-1.0.0.tgz
4275aab2ec46009af77ed5ff95621a0ea3407a2b70f6e6618a8e2a92f473bc8b  blockingmachine-firefox-mv3-v1.0.0.zip
```
