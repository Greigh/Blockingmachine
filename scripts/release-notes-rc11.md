## Blockingmachine v1.0.0-rc.11

Release candidate. Three independent audit passes hardened the LAN control API, outbound fetching, the Electron IPC secret boundary, and the pairing credential lifecycle — every fix reproduced behaviorally before it landed. Mobile pairing, scanning and discovery fixes ride along.

### Highlights since rc.10

- **A `.local` web page can no longer turn protection off.** The LAN feed server trusted any `*.local` browser origin — claimable by any mDNS advertiser — so a tokenless hub could be protection-off'd by a drive-by page on a rogue LAN host. `.local`-class origins are rejected everywhere now; loopback, extension, mobile and Home Assistant clients are unaffected.
- **Browsing-derived telemetry is no longer a cross-origin read.** `/v1/status`, `/v1/telemetry` and `/v1/check` now share the origin+bearer gate `/v1/events` always had; public `.txt` feeds stay open.
- **Filter fetching resists DNS rebinding** — resolutions happen inside the connect and private-range answers are refused, closing the public-URL→internal-host SSRF.
- **AI keys never leave the main process** — the config channel is write-only, the stored key can only answer at its stored endpoint, AI fetches bound bodies, refuse redirects, and reject metadata/link-local destinations while keeping loopback and LAN providers (Ollama) working.
- **Feed tokens got a Generate button** — 192-bit CSPRNG, sealed at rest, one-time display, embedded in the pairing QR; hand-typed tokens need ≥16 chars (existing tokens untouched).
- **Mobile**: QR-permission flow can't dead-end, tab bar centers correctly, and mDNS-discovered hubs connect on Android (resolves the `.local` host itself can't).

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-rc.11-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.11/Blockingmachine-1.0.0-rc.11-arm64.dmg) | macOS Apple Silicon installer (notarized) |
| [`Blockingmachine-darwin-arm64-1.0.0-rc.11.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.11/Blockingmachine-darwin-arm64-1.0.0-rc.11.zip) | macOS Apple Silicon standalone zipped app (notarized) |
| [`blockingmachine-core-1.0.0-rc.11.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.11/blockingmachine-core-1.0.0-rc.11.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0-rc.11.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.11/blockingmachine-cli-1.0.0-rc.11.tgz) | CLI executable NPM package |
| [`blockingmachine-chrome-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.11/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Web Store Manifest V3 browser extension bundle |
| [`blockingmachine-firefox-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.11/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Add-ons Manifest V3 browser extension bundle |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.11/SHA256SUMS.txt) | SHA-256 verification checksums |

### Verification Checksums (SHA-256)

```text
3f7842fe083e3caa27759e9ec5cca9228629a5804dd73d4cb57d8af5a7de1dbf  Blockingmachine-1.0.0-rc.11-arm64.dmg
e80fd9b9d6e5c533b80fbbe2f380c10d50a8a95d9a2c42a63b1b3f329a831441  Blockingmachine-darwin-arm64-1.0.0-rc.11.zip
197367905b29deb3df844b7413d57b3382cf472c6032d02c17193f40a3eefc56  blockingmachine-chrome-mv3-v1.0.0.zip
594fc8445f25260e591c84c6b094482a66793be3a64d84e01159bd2060f81221  blockingmachine-cli-1.0.0-rc.11.tgz
dd0d1c0536d2c850ea57183ccf55246f2ee5f41feef65f7460cf42fcb949f143  blockingmachine-core-1.0.0-rc.11.tgz
918e819a7805794cd76ce658f79181dda499e22dea33f53b4726b51c50d36dbb  blockingmachine-firefox-mv3-v1.0.0.zip
```
