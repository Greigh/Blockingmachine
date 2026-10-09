## Blockingmachine v1.0.0-rc.10

Release candidate. The macOS build ships notarized for the first time, `npm audit` reports zero, and the flag-72 CodeQL hardening merged in from `main`.

### Highlights since rc.9

- **macOS artifacts are signed, notarized and stapled.** `forge make` runs the full notary flow via the App Store Connect API key (`APPLE_API_*`); CI tag-push builds notarize too. Gatekeeper accepts a fresh download — `spctl -a -vv` → `source=Notarized Developer ID`.
- **`npm audit` → 0 vulnerabilities.** The three advisories with no patched upstream release are fixed by vendored copies under `vendor/` — a depth guard in `braces`, upstream PR #1152's nested-`DigestAlgorithm` check in `node-forge`, and a CJS port of the linear-scan `decode-uri-component` fix. Verified against the real PoCs, not just metadata.
- **CodeQL backlog cleared (merged from `main`).** Nineteen quadratic regex scans in shipped code became linear index walks (`core/src/utils/textScan.ts`); test trees left analysis scope; three design-intent alerts dismissed.
- **The hot set derives from the live-browser URL trace** — 91 rules covering all 413 measured blocks of its session, on a tracked, replayable derivation.

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-rc.10-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.10/Blockingmachine-1.0.0-rc.10-arm64.dmg) | macOS Apple Silicon installer (notarized) |
| [`Blockingmachine-darwin-arm64-1.0.0-rc.10.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.10/Blockingmachine-darwin-arm64-1.0.0-rc.10.zip) | macOS Apple Silicon standalone zipped app (notarized) |
| [`blockingmachine-core-1.0.0-rc.10.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.10/blockingmachine-core-1.0.0-rc.10.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0-rc.10.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.10/blockingmachine-cli-1.0.0-rc.10.tgz) | CLI executable NPM package |
| [`blockingmachine-chrome-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.10/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Web Store Manifest V3 browser extension bundle |
| [`blockingmachine-firefox-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.10/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Add-ons Manifest V3 browser extension bundle |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.10/SHA256SUMS.txt) | SHA-256 verification checksums |

### Verification Checksums (SHA-256)

```text
00053c677df2690264697e1c9bbbacc3711287847e1d2503d9ac723f8745215d  Blockingmachine-1.0.0-rc.10-arm64.dmg
e4c35476d9923d4ff47014473c5ed0a674ecd1446a20c48c90b437e4bc786a2c  Blockingmachine-darwin-arm64-1.0.0-rc.10.zip
98bbcb2605cf449438d3985fa1fa12d3ef2e41d8d21d665cd98e6dcc00109590  blockingmachine-chrome-mv3-v1.0.0.zip
5c95b39603bab8dc6e2bbae81c122e8f5fbca2b2d1612ed460fb6bf715bd0b4e  blockingmachine-cli-1.0.0-rc.10.tgz
f18a3592de4aecbf89181d776a5fc630c1fabe7a6b69505233b05a50525aa0b1  blockingmachine-core-1.0.0-rc.10.tgz
27c5565ae79b828ce5ba3dbe848601bb7c7409ccc90abfc13d65ace3e51acd97  blockingmachine-firefox-mv3-v1.0.0.zip
```
