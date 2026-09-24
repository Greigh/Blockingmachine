## Blockingmachine v1.0.0-rc.4

Fourth release candidate for Blockingmachine 1.0 featuring full resolution of all 31 GitHub Dependabot alerts, comprehensive dependency upgrades to the latest stable ecosystems, automated CodeQL security analysis, formal security policy disclosure (`SECURITY.md`), daemon test suite isolation and scoping hardening, and multi-store browser extension packaging.

### Highlights since RC 3

- **100% Dependabot & Security Alert Remediation**:
  - Eliminated all 31 GitHub Dependabot alerts across all repository dependencies and workspaces.
  - Fully mitigated upstream vulnerabilities across `fast-uri`, `qs`, `uuid`, `@xmldom/xmldom`, `js-yaml`, and `extract-zip` (via drop-in `@electron-internal/extract-zip`).
  - GitHub security dashboard and repository status currently verify 0 open Dependabot alerts.
- **Ecosystem & Dependency Modernization**:
  - Upgraded core runtime compatibility targeting Node.js `>=24.0.0`.
  - Upgraded `@types/node` to `^26.6.2`.
  - Upgraded ESLint to `^10.11.0` and `@typescript-eslint` to `^8.70.1`.
  - Upgraded Jest testing framework to `^30.5.2`.
  - Modernized CLI and telemetry utilities: Chalk `^6.0.0`, Cosmiconfig `^10.0.0`, Dotenv `^18.0.0`, and Mongoose `^9.10.2`.
- **CodeQL Security Analysis & Formal Security Policy**:
  - Integrated automated CodeQL analysis workflow (`.github/workflows/codeql.yml`) scanning JavaScript and TypeScript codebases on push and pull request to `main`.
  - Established formal `SECURITY.md` defining supported versions, vulnerability disclosure procedures, and response commitments.
- **Daemon Reliability & IPC Scoping Fixes**:
  - Isolated background test suites for `BlockingmachineDaemon` to prevent port contention and ensure reliable CI execution.
  - Hardened IPC event framing and local variable scoping (`timestampStr`) across telemetry streams to eliminate cross-session state bleed.
- **Browser Extension Multi-Store Packaging**:
  - Packaged production-ready Manifest V3 bundles for Chrome Web Store (`blockingmachine-chrome-mv3-v1.0.0.zip`) and Mozilla Firefox Add-ons (`blockingmachine-firefox-mv3-v1.0.0.zip`).
  - Added automated compliance validation script (`scripts/verify-mv3-compliance.mjs`) ensuring zero declarativeNetRequest rule conflicts and strict permissions scoping.
- **Continuous Integration & Quality Assurance**:
  - All CI workflows (CI, HACS Validation, CodeQL Analysis) passing cleanly with 100% test pass rate across 352 test cases.
  - Zero TypeScript compiler diagnostics and zero ESLint errors across all packages.

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-rc.4-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.4/Blockingmachine-1.0.0-rc.4-arm64.dmg) | macOS Apple Silicon installer (Drag to Applications) |
| [`Blockingmachine-darwin-arm64-1.0.0-rc.4.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.4/Blockingmachine-darwin-arm64-1.0.0-rc.4.zip) | macOS Apple Silicon standalone zipped app |
| [`blockingmachine-core-1.0.0-rc.4.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.4/blockingmachine-core-1.0.0-rc.4.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0-rc.4.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.4/blockingmachine-cli-1.0.0-rc.4.tgz) | CLI executable NPM package |
| [`blockingmachine-chrome-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.4/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Web Store Manifest V3 browser extension bundle |
| [`blockingmachine-firefox-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.4/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Add-ons Manifest V3 browser extension bundle |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.4/SHA256SUMS.txt) | SHA-256 verification checksums |

### Verification Checksums (SHA-256)

```text
5f19fdbe9eb4886b4dbc1000328807cfe29c25df9d275afcc0ea6c6314f2ce75  Blockingmachine-1.0.0-rc.4-arm64.dmg
52816238cbde1308a159bd3a8436e492f63b322fa84bd65c73af566c4f578159  Blockingmachine-darwin-arm64-1.0.0-rc.4.zip
5973849b9347362906099cf8f500a4493586bc32217cbf680ee6c860729fdeb8  blockingmachine-core-1.0.0-rc.4.tgz
9f83fc5371e281d4ddc49d9f81f7f29ce0b35ddd12ee80c4e0aaf5d6bc0266e9  blockingmachine-cli-1.0.0-rc.4.tgz
6a848889044541572203bec02d7edf2961dd91ea24de65cc756ac3776ddd7604  blockingmachine-chrome-mv3-v1.0.0.zip
47d5fd48908586c6fc9ba991d1f78d50a1f203c0b55cb4eeaaf740062feb224b  blockingmachine-firefox-mv3-v1.0.0.zip
```
