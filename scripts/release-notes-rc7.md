## Blockingmachine v1.0.0-rc.7

Seventh release candidate for Blockingmachine 1.0 — the largest since the RC line began. The spine of this release is **measurement honesty**: the hit ledger now records and exports per-tier tallies that can be reproduced outside the popup, the match pipeline's silent losses are found and fixed in a real browser, and every remaining measurement gap is written down in `docs/open-flags.md` rather than left in conversation. The full monorepo suite is green.

### Highlights since RC 6

- **The match ledger no longer silently loses blocks (`@blockingmachine/browser-extension`).** Verified end-to-end in a real Chrome via CDP: `onRuleMatchedDebug` wakes a suspended worker but drops events during the cold start, a gate skipped `getMatchedRules` whenever the live API existed, concurrent match events clobbered each other's telemetry writes, the poll only looked at the active tab, and matches on closed tabs were dropped entirely. The poll is now the always-on backstop with persisted cursor, timestamp-paired dedup, per-tab serialized commits, all-tab recovery on feedback builds, and `tabId < 0` records reaching the ledger. Session exports can honestly report `feed: 'hybrid'`.

- **The LAN feed server no longer serves whatever shares its output directory (`@blockingmachine/electron-app`).** `GET /package.json`, `/config.yaml`, `/tsconfig.json` and every traversal spelling returned 200 from a live server; the 404 listing named every file in the directory. Serving is allowlisted through `feedServing.ts`, the listing is filtered by the same predicate, and `/v1/events` — previously completely unguarded, including cross-origin `EventSource` reads under `Access-Control-Allow-Origin: *` — now takes the origin guard plus the configured `feedToken` whenever one is set. A stalled SSE subscriber is evicted past a 512 KB backlog instead of buffering events forever.

- **The AI quarantine gates were inverted, and stale verdicts never expired (`@blockingmachine/electron-app`, `@blockingmachine/core`).** Both gates quarantined *everything* in one toggle state each; three renderer paths bypassed the gate entirely; and once-quarantined domains stayed in the feed forever. A shared `quarantineGate.ts` now requires ≥85% confidence or a critical rating for all five entry points, `revalidateQuarantine` re-screens the store against the current classifier at every launch, and the vendor table caught up to real misses (`cursorvm.com`, `windsurf.com`, Elastic hosted zones, `vercel-dns-016.com`).

- **The Deploy Hub gained a Browser tab and live verification (`@blockingmachine/electron-app`).** The extension can be built and downloaded from inside the app; every button in every pane is click-tested (which caught a real wiring bug); each Deploy recipe's directives were audited against its target's own documentation; the Unbound reachability check re-runs itself on a watch and a cron's failure is reported back rather than silent.

- **A hot set can now be derived from a deployment's own exports (`scripts`, `@blockingmachine/core`).** `build-hot-list.mjs --sessions` merges the popup's ledger exports inline and derives a measured set; the popup names which list the browser is running (full export vs measured hot set, with staleness); a full export with no hot set is trimmed by measured tier benefit rather than file prefix.

- **Classifier work across the board (`@blockingmachine/core`).** A dedicated `Consent/Annoyance` verdict rung on both engines with its own risk level; the malware-verdict pass is incremental via a fingerprinted cache; the element corpus grew past 220 real-page cases with held-out contention; first-party `sponsored`/`advert` copy no longer hides at 98%; the calibration gates became reference-head margins.

- **Coverage replays full request URLs (`@blockingmachine/core`, `@blockingmachine/cli`).** Path-scoped rules are now decided against real request URLs instead of excluded from measurement; the shipped list's path-rule decidability is CI-gated at 80%; `@@||host/path` exceptions — 816 of them in the shipped list, 20 allowlisting far more than they say — are compiled and applied per request.

- **Release itself is rehearsed (`scripts`, CI).** `npm run rehearse:release` compiles fixture tiers, runs the full packaging path, opens both extension archives, and asserts what an install would read — packaging breaks are caught in CI, not at release time.

- **Eleven flags closed in `docs/open-flags.md`.** The match-ledger losses (48), the feed-server exposures (49, 50), the deploy-report ledger, secret sealing, regex safety, verdict axes, the unbound watch and more — each entry records what closed it, the verification, and what the fix deliberately does not claim.

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-rc.7-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.7/Blockingmachine-1.0.0-rc.7-arm64.dmg) | macOS Apple Silicon installer |
| [`Blockingmachine-darwin-arm64-1.0.0-rc.7.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.7/Blockingmachine-darwin-arm64-1.0.0-rc.7.zip) | macOS Apple Silicon standalone app |
| [`blockingmachine-core-1.0.0-rc.7.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.7/blockingmachine-core-1.0.0-rc.7.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0-rc.7.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.7/blockingmachine-cli-1.0.0-rc.7.tgz) | CLI executable NPM package |
| [`blockingmachine-chrome-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.7/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Manifest V3 extension |
| [`blockingmachine-firefox-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.7/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Manifest V3 extension |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.7/SHA256SUMS.txt) | SHA-256 verification checksums |

### Verification Checksums (SHA-256)

```text
aca1e094560ef1d9f32efe06b5a5fc52a27e1ab39f0991f613a22583e85ca867  Blockingmachine-1.0.0-rc.6-arm64.dmg
6c5f7d29e7540066c6b17c2e9286e7977576dabfce245e1165563de8c1d1e5b8  Blockingmachine-1.0.0-rc.7-arm64.dmg
645ba5337a5ae6adecca4fc7507cbff4471bc85d9de748025f2623fc8ca92ddc  Blockingmachine-darwin-arm64-1.0.0-rc.5.zip
987ca6ff69c6936e0371dc8d8a5a395db4a2eb5ed64d6db038a9ca1d5d73ef0f  Blockingmachine-darwin-arm64-1.0.0-rc.6.zip
879df281765eb0ce39012bdc2cbe36432dbe8647ab5f3a30c7c7be74f9203636  Blockingmachine-darwin-arm64-1.0.0-rc.7.zip
3b76138e4afe1d00b822ca7b7a2587df1ae7a421b558768696e06070931727bb  blockingmachine-chrome-mv3-v1.0.0.zip
7ec73d72346d0d67f02b789ccd671da6db7fee809202b690fb26eef88fe97bc0  blockingmachine-cli-1.0.0-rc.6.tgz
35b9c42eb651f6c781ee6793179cfe014214a2d78c773927ca9bdf07a3b4f988  blockingmachine-cli-1.0.0-rc.7.tgz
62e120540588ad766e3df274a1dcbe4b893da702a71b034f52da3895ae278910  blockingmachine-core-1.0.0-rc.6.tgz
fa82a296e10ab742bf35b9732f595fbfbd02c825bd71add18709061413a69bd6  blockingmachine-core-1.0.0-rc.7.tgz
25db99130888f4cc1468f7cdb84b72740f462ab5dddcb2ddc14e3dfa47af11e3  blockingmachine-firefox-mv3-v1.0.0.zip
```
