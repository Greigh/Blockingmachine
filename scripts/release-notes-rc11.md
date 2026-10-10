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
