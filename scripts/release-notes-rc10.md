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
caf78db49be9b17082c011a84cc71c0e694824eab1e6274614198d0102ab3962  Blockingmachine-1.0.0-rc.10-arm64.dmg
8440b3d01bf5bbf44b03f8ab14be655213675f5b3d6ec436f72f2bdf1be70a44  Blockingmachine-darwin-arm64-1.0.0-rc.10.zip
22a45cc569904f469148a46c6d66281c0aec0b389e15e1e467c16b1e63faa82f  Blockingmachine-darwin-arm64-1.0.0-rc.7.zip
cfb8cc276447c4eec7f837a01dab931d5130cdd51678f81234a714a0bc18d6c7  Blockingmachine-darwin-arm64-1.0.0-rc.8.zip
eb775a012224962b7c292c26997ac541e8feecfd67e53135bde1fd93d9d92eca  Blockingmachine-darwin-arm64-1.0.0-rc.9.zip
479e47ab9609ec16da20a3ff121d27afd7498f52e678f028216e14b17ffa88db  blockingmachine-chrome-mv3-v1.0.0.zip
5c95b39603bab8dc6e2bbae81c122e8f5fbca2b2d1612ed460fb6bf715bd0b4e  blockingmachine-cli-1.0.0-rc.10.tgz
f18a3592de4aecbf89181d776a5fc630c1fabe7a6b69505233b05a50525aa0b1  blockingmachine-core-1.0.0-rc.10.tgz
9898abdadd0a749483eb1f809288f2d51978de6ea664c0b6575f296a49e9681d  blockingmachine-firefox-mv3-v1.0.0.zip
```
