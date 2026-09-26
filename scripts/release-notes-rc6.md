## Blockingmachine v1.0.0-rc.6

Sixth release candidate for Blockingmachine 1.0, focused on rule engine correctness, deduplication precision, and publishing hygiene. This release resolves a long-standing tie-breaking flaw in the rule selection engine, closes a canonical key collision in scriptlet deduplication, and eliminates duplicate package listings on GitHub Packages. All 565 automated tests pass.

### Highlights since RC 5

- **Rule Engine: `selectBestRule` — `$important` Priority Fix (`@blockingmachine/core`)**:
  - `RuleDeduplicator.selectBestRule` previously failed to prefer `$important`-flagged rules over equivalent non-`$important` variants when provenance scores were equal, causing the wrong representative rule to be selected during deduplication.
  - Added an explicit `$important` priority check before suffix-pattern and score comparisons, ensuring `||domain.com^$important` always wins over `||domain.com^` in a merge group.

- **Rule Engine: Scriptlet Whitespace Normalization (`@blockingmachine/core`)**:
  - `RuleDeduplicator.stripRule` previously generated distinct canonical keys for identical scriptlet rules that differed only in internal whitespace (e.g., `##+js(set, admiral, noopfn)` vs `##+js(set,   admiral,  noopfn)`), causing functionally-duplicate scriptlet rules to survive deduplication.
  - Scriptlet payloads are now collapsed to a single canonical whitespace form (`payload.replace(/\s+/g, ' ').trim()`) before key generation, correctly deduplicating all equivalent scriptlet variants.

- **Duplicate Package Fix — GitHub Packages Publishing**:
  - `scripts/publish-gpr.mjs` previously published each package under three separate names (`@greigh/blockingmachine-core`, `@greigh/core`, `@blockingmachine/core`), resulting in four package listings on GitHub Packages instead of the expected two.
  - Simplified to publish only under the canonical `@blockingmachine/core` and `@blockingmachine/cli` names, matching the package scope declared in each workspace `package.json`.

- **CI: Release Notes Lookup Fix (`.github/workflows/publish.yml`)**:
  - Replaced the fragile string-manipulation release notes filename derivation with a robust `grep -oP` pattern that correctly maps any `v1.0.0-rc.N` tag to `scripts/release-notes-rcN.md`.
  - Updated the workflow fallback tag from the stale `v1.0.0-rc.4` to `v1.0.0-rc.6`.

- **Test Suite Expansion**:
  - Added regression coverage for `selectBestRule` `$important` tie-breaking.
  - Added regression coverage for scriptlet canonical key whitespace equivalence.
  - **565 automated tests passing** across 23 test suites (100% pass rate).
  - Zero TypeScript diagnostics, zero ESLint errors.

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-rc.6-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.6/Blockingmachine-1.0.0-rc.6-arm64.dmg) | macOS Apple Silicon installer |
| [`Blockingmachine-darwin-arm64-1.0.0-rc.6.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.6/Blockingmachine-darwin-arm64-1.0.0-rc.6.zip) | macOS Apple Silicon standalone app |
| [`blockingmachine-core-1.0.0-rc.6.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.6/blockingmachine-core-1.0.0-rc.6.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0-rc.6.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.6/blockingmachine-cli-1.0.0-rc.6.tgz) | CLI executable NPM package |
| [`blockingmachine-chrome-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.6/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Manifest V3 extension |
| [`blockingmachine-firefox-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.6/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Manifest V3 extension |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.6/SHA256SUMS.txt) | SHA-256 verification checksums |
