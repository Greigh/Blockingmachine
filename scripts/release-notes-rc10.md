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
2ece93896853c62dc2bb46f378c1e50e82cd9aaac6d0372358064123cfedd942  Blockingmachine-darwin-arm64-1.0.0-rc.10.zip
ae65f10ed2b7c4f65c1c2915906475127c1a77d439c389bf3cac06f1f3531de7  Blockingmachine-linux-x64-1.0.0-rc.10.zip
1c217ce4575a89a71e370c62882a7fac6154ac3bfb29033b5b568b08a79c461c  Blockingmachine-win32-x64-1.0.0-rc.10.zip
a56411b733fe00bdb779c156d07430497e44d63c436f2b38e5fd584299a58978  Blockingmachine.dmg
a4ec9db5765a9c365856f5105fcf4de6426e0b8c2ff5a12efcc95cdc8cf234a0  BlockingmachineSetup.exe
beec796cecf41a95923acddc514e9cfb1234f379a669d03ea1d8075523d667b2  blockingmachine-1.0.0.rc.10-1.x86_64.rpm
7f3fc9283050eb6be11b8797337bf837a2a954b7c812bc835f3ccd1082c3cbaa  blockingmachine-chrome-mv3-v1.0.0.zip
5c95b39603bab8dc6e2bbae81c122e8f5fbca2b2d1612ed460fb6bf715bd0b4e  blockingmachine-cli-1.0.0-rc.10.tgz
d34e67d439090aaf1787a40b4a6fd818808b046e9db315ae78c0135dd5e12c4c  blockingmachine-core-1.0.0-rc.10.tgz
3b8d002d5626d0412b77af37f9a8356d7f028af01e4ca0634ef8c7154690cd60  blockingmachine-firefox-mv3-v1.0.0.zip
b0d33b56c0f77fb9b0ab1da19402823b443d76dd3540de3c5699a64462daeee2  blockingmachine_1.0.0.rc.10_amd64.deb
```
