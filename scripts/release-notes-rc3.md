## Blockingmachine v1.0.0-rc.3

Third release candidate for Blockingmachine 1.0 featuring hardened AI classification, entropy recalibration, badfilter neutralization, desktop UI polish, and macOS application installers.

### Highlights since RC 2

- **AI Architecture & Type Centralization**:
  - Centralized all AI verdicts, targets, threat categories, heuristic models, and metadata schemas into `packages/core/src/ai/types.ts`.
  - Guaranteed complete cross-package type contracts across `@blockingmachine/core`, `@blockingmachine/cli`, and `@blockingmachine/electron-app`.
- **Entropy Engine Recalibration**:
  - Fine-tuned Shannon entropy scoring thresholds to prevent false positives on legitimate hashes, UUIDs, and CDN identifiers while effectively detecting DGA domains.
  - Added base64 chunk pattern detection, subdomain segment analysis, and bigram transition anomaly scoring.
- **Rule Synthesizer & Badfilter Neutralization**:
  - Added automatic `$badfilter` rule generation to neutralize conflicting or erroneous upstream filter rules without modifying external feeds.
  - Added procedural scriptlet defuser synthesis (`##+js(...)`, `#%#//scriptlet(...)`) and domain-anchored network blocking with strict separator enforcement.
- **Reputation & Threat Intelligence**:
  - Dynamic threat categorization across Adware, Trackers, Cryptominers, Telemetry, Phishing, and Evasive Adblock Walls.
  - Enriched CNAME cloaking analysis with recursive depth limits and strict loop detection.
- **Desktop Application & UI Polish**:
  - AI Radar and Domain Inspector: added live risk level indicators, confidence gauges, and direct one-click rule synthesis.
  - Deploy Hub & Dashboard: enhanced status indicators for connected sinkholes (Pi-hole, AdGuard Home, Local Feed Server).
  - Resolved all TypeScript and ESLint type warnings across Electron views and IPC bridges.
  - Guarded macOS login item registration in unpackaged development to prevent OS platform errors.
- **Testing & Continuous Integration**:
  - All 352 unit and integration tests passing with 100% pass rate.
  - Calibrated benchmark inference headroom to ensure stable CI test execution across virtualized runners.
  - Clean build output across all monorepo workspaces with 0 lint warnings.

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-rc.3-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.3/Blockingmachine-1.0.0-rc.3-arm64.dmg) | macOS Apple Silicon installer (Drag to Applications) |
| [`Blockingmachine-darwin-arm64-1.0.0-rc.3.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.3/Blockingmachine-darwin-arm64-1.0.0-rc.3.zip) | macOS Apple Silicon standalone zipped app |
| [`blockingmachine-core-1.0.0-rc.3.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.3/blockingmachine-core-1.0.0-rc.3.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0-rc.3.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.3/blockingmachine-cli-1.0.0-rc.3.tgz) | CLI executable NPM package |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.3/SHA256SUMS.txt) | SHA-256 verification checksums |

### Verification Checksums (SHA-256)

```text
899d5ec8411ebcfee6854d60babf462a5d922af534339fc23b85f91def64797e  Blockingmachine-1.0.0-rc.3-arm64.dmg
2f1053568d4eca3bfb507dcb7a41acc1d3c27157276549ab2f999d2a39a32d28  Blockingmachine-darwin-arm64-1.0.0-rc.3.zip
add08a6ca9f51075fa8076b1f695ec17affc3748dd66ad686d946f7feab8cd8c  blockingmachine-core-1.0.0-rc.3.tgz
9756637dfd362a7a1b69e3bc6af8dec38102a5b8f8f4a892078a3725c096a047  blockingmachine-cli-1.0.0-rc.3.tgz
```
