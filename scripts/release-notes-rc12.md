## Blockingmachine v1.0.0-rc.12

Release candidate. The comprehensive UI/UX audit, WCAG 2.2 accessibility remediation, and real assistive-technology verification programme lands in this build — every Electron view is axe-clean in both themes, the layout reflows at 400% zoom, and the interface was exercised end-to-end under a live VoiceOver session and Android TalkBack. The mobile app gains real release signing and reliable version codes, the LAN control API's final hardening pass closes the Home Assistant admin and drive-by write surfaces, and the iOS companion app makes its first release appearance.

### Highlights since rc.11

- **Width-adaptive Electron navigation.** Three modes with automatic switching: full sidebar at desktop widths, a compact 62px icon rail below 900px, and a keyboard/AT-complete overlay drawer below 460px. The closed drawer is `visibility: hidden` — a VoiceOver session caught it sitting in Tab order while invisible (WCAG 2.2 SC 2.4.3); the fix keeps the slide animation and removes it from focus traversal.
- **All nine Electron views are axe-clean in both themes** (zero violations) and verified at 200% and 400% zoom (600px and 300px effective width, WCAG 2.2 SC 1.4.10) — including the previously clipped Rule Inspector, Deploy & Sync, and pairing surfaces.
- **Real assistive-technology verification.** A live macOS VoiceOver session exercised navigation, the drawer, views, dialogs, and focus restoration; Android TalkBack on the release APK verified tab-bar and Settings control labels. Status and error toasts now carry `role="status"`/`role="alert"` semantics (SC 4.1.3).
- **The LAN control API's last confirmed write surfaces are closed.** Home Assistant administrative mutations require an explicit admin token in addition to the feed credential, drive-by POSTs are gated by origin and content-type, and outbound DoH/feed pulls are body-bounded.
- **Android release signing and version management (flag 75/86).** Release APKs sign with a dedicated off-repo JKS keystore; builds fail hard when release credentials are missing instead of silently falling back to the debug certificate. `versionCode` derives from the semver version (`1.0.0-rc.12` → `1000012`) and survives `expo prebuild`. **Existing debug-signed installs cannot upgrade in place** — uninstall and re-pair once.
- **iOS companion app** — first release appearance, see the Mobile release assets.
- **Browser extension** — tier-plan copy accuracy fixes and a toast-overlap correction.

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-rc.12-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.12/Blockingmachine-1.0.0-rc.12-arm64.dmg) | macOS Apple Silicon installer (notarized) |
| [`Blockingmachine-darwin-arm64-1.0.0-rc.12.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.12/Blockingmachine-darwin-arm64-1.0.0-rc.12.zip) | macOS Apple Silicon standalone zipped app (notarized) |
| [`blockingmachine-core-1.0.0-rc.12.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.12/blockingmachine-core-1.0.0-rc.12.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0-rc.12.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.12/blockingmachine-cli-1.0.0-rc.12.tgz) | CLI executable NPM package |
| [`blockingmachine-chrome-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.12/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Web Store Manifest V3 browser extension bundle |
| [`blockingmachine-firefox-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.12/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Add-ons Manifest V3 browser extension bundle |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.12/SHA256SUMS.txt) | SHA-256 verification checksums |

**Mobile:** the signed Android APK and the new iOS build ship under [`mobile-v1.0.0-rc.12`](https://github.com/Greigh/Blockingmachine/releases/tag/mobile-v1.0.0-rc.12).

**Home Assistant:** install the add-on by adding this repository's URL in *Settings → Add-ons → Add-on Store → Repositories*, then refresh. The `v1.0.0-rc.12` tag carries the add-on and the HACS integration; administrative actions now require the dedicated admin credential.

### Verification Checksums (SHA-256)

```text
a1497bcd1e7ee0e776926b89198a63b12980012e2f4f9eae3b7eedbe23339385  Blockingmachine-1.0.0-rc.12-arm64.dmg
44b6994d3ed9e239a4503da82bbf61c85687b69caf581afb5be88254ab9a33e1  Blockingmachine-darwin-arm64-1.0.0-rc.12.zip
f04f5d4fa6ed01b2357a3b132340dfb9788e8c58a51640f393445c48d8353932  blockingmachine-chrome-mv3-v1.0.0.zip
43505416deb870a92b6ebf64ea997afed630c72e309761fbb8aae02fab6f526a  blockingmachine-cli-1.0.0-rc.12.tgz
521fe954fac7015c40473128067bb1e62ddf84909cade6c8893cf6365b582462  blockingmachine-core-1.0.0-rc.12.tgz
de14b42772985b34014d7a6ee4a4347f6a2463592e56336efab7efc6e73e44c3  blockingmachine-firefox-mv3-v1.0.0.zip
```
