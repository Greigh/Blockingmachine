# Agent Notes

Project context and operational knowledge for agents working in this repository.
Session-level detail lives in the Dexio wiki under `projects/blockingmachine/` and in
`docs/open-flags.md` (the audit ledger — open items at top, closed ones at bottom).

## Current release state

- **`v1.0.0-rc.8` shipped 2026-10-04** — tag on `origin` (GitHub `Greigh/Blockingmachine`)
  and `forgejo` (`git.greighstudios.com`). GitHub pre-release holds the full asset set:
  local darwin-arm64 dmg/zip + extension zips + npm tarballs + `SHA256SUMS.txt`
  (all 12 payloads hashed post-upload), plus `publish.yml`'s CI-built win32/linux/
  macos installers attached automatically on the tag push.
- **`make/` must be emptied before `package-all.mjs`** — `gh release create … make/*`
  sweeps the whole directory, so rc.7 artifacts rode onto the rc.8 release once and
  had to be deleted after the fact. Clean the dir (or hand the script a fresh
  checkout) before any release run.
- **npmjs.com**: `@blockingmachine/core` and `@blockingmachine/cli` `1.0.0-rc.8` under
  dist-tag `rc`.
- **Forgejo npm registry**: publish fails `401 Unauthorized` — `FORGEJO_TOKEN` in `.env`
  is invalid outright ("access token does not exist" per the API), not merely
  under-scoped. Git pushes authenticate over SSH, a different credential. Needs a
  fresh token with package write scope — flag 53 tracks it.
- **`npm audit`**: one unpatched advisory remains — `braces` (GHSA-vfj7-8cjw-p6xm,
  all versions, no patched release). Forge 8.0.1 took it 9 → 6; the residual chain is
  `webpack-dev-server` → `chokidar`/`http-proxy-middleware` → `micromatch` → `braces`,
  dev-toolchain only. `audit fix --force` proposes a breaking Forge downgrade; do not
  take it — flag 52 tracks it.
- **Electron Forge 8 sharp edges**: `main` must be `.webpack/main/index.cjs` (the
  plugin emits `.cjs` and refuses bare `.webpack/main`); `afterPrune` hooks take one
  `{buildPath, electronVersion, platform, arch}` object, not positional args; the
  root `junk` override must stay absent — `@electron/packager@20` needs `junk@^4`
  ESM, forcing `^3` breaks `isJunk` import. `forge package` stages per-arch under
  `.webpack/<arch>/` then restores the arch into the staged app; a stray `index.cjs`
  at the package root is stale output, not the convention.
- **`ELECTRON_RUN_AS_NODE=1` is exported into agent shells on this machine** —
  it forces every Electron binary into node mode, so a packaged
  `Blockingmachine.app` exec'd from an agent shell dies silently in <1s on
  `require('electron')` (packaged stderr goes to os_log, not the tty). It is NOT
  in launchctl or any rc file — the user's `open`/double-click path is unaffected.
  Always run packaged binaries as `env -u ELECTRON_RUN_AS_NODE <binary>` and do
  not diagnose a silent packaged-exec exit as an app defect.
- **Compile pipeline**: `runImportProcess` (extracted from the
  `run-import-process` handler; the IPC handler and `compileInvoker` — used by the
  auto-schedule timer — both call it). The ~130s malware classify pass runs in
  `.webpack/main/classifierWorker.cjs` (`worker_threads`, third webpack entry,
  `asarUnpack`'d); dedup/extract/classify loops yield via `yieldToEventLoop`.
  `filters/` ships via `extraResource` — relative `./filters/...` sources resolve
  `process.resourcesPath`-first packaged, `app.getAppPath()` in dev.
- **macOS notarization**: `osxNotarize` in `forge.config.cjs` is env-gated —
  `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` or
  `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`; unset means signed-but-unnotarized
  (flag 54). After `rm -rf` + `cp -R` reinstalling the app, run
  `lsregister -f /Applications/Blockingmachine.app` or `open` silently no-ops on
  the stale LaunchServices record.

## Release pipeline (`scripts/release.mjs`)

`npm run release -- <version>` runs: all workspace tests → lint → clean build → version
bump across 8 workspaces → `make/` artifacts → annotated tag → push both remotes →
`gh release create --prerelease` with assets → npmjs + Forgejo registry publishes
(`--skip-npmjs` / `--skip-forgejo` gates).

Known sharp edges:

- **Resume skips** (`--skip-tests --skip-build --skip-make`) must go directly to node:
  `node scripts/release.mjs <v> --skip-…`. Passing them through `npm run release --`
  turns them into npm config noise and the script re-runs everything.
- **Tag push races `publish.yml`** — the workflow's release job uploads CI assets with
  `--clobber`. If a local `gh release create` is mid-upload, asset-name collisions 422
  and roll the release back. Recover by creating the release manually, then
  `gh workflow run publish.yml` to attach platform builds.
- `release.mjs` loads `.env` via `process.loadEnvFile` for `NPMJS_TOKEN` /
  `FORGEJO_TOKEN` / `GITHUB_TOKEN`; missing tokens log and skip rather than fail.
- **Packaging rewrites `packages/browser-extension/rules/tier_*.json` and
  `src/shared/tierCounts.generated.ts`** — the compiled 30k-rule plan over the
  118-host curated baseline. `check:tiers`, `check:vocabulary` and the
  `tierVocabularyDerivation` suite are provenance-checked against the *baseline*,
  so `release.mjs` restores those paths before staging. A commit that contains
  expanded `rules/` files is a bug (rc.7's `c1d06fb` did exactly this; the
  vocabulary derivation exploded from 45 seeds to 9,707 and CI ran 2.9 h).
- `zz-plan-check.test.ts` is a manual histogram diagnostic that reads
  `/tmp/browser-feed.txt` — it skips when the fixture is absent (always in CI).

## CI

- `.github/workflows/ci.yml` builds the monorepo **before** `type-check` — workspace
  consumers resolve `@blockingmachine/core` types through `dist/*.d.ts`, so type-check
  without a build collapses those imports to `any` and cascades strict errors out of
  `packages/cli`. Keep that order.
- `.forgejo/workflows/ci.yml` now mirrors the same ordering (lint → build → test);
  run 312 is the first green Forgejo CI on it. Forgejo's build step catches things
  `tsc --noEmit` cannot — webpack `extensionAlias` is what lets `.js` specifiers in
  `.ts` sources resolve in the bundles (added for the reachability-harness
  convention: plain `tsc` emits extension-preserved ESM that Node runs directly).
- `publish.yml` triggers on tag push (`v*`) and `workflow_dispatch`; it builds all
  platforms and uploads onto the release, creating it if absent.
- `.forgejo/workflows/weekly-tier-compile.yml` mirrors the GitHub weekly ledger cut
  (Monday 04:17 UTC + dispatch), PR'ing via the pulls API with the injected
  `GITHUB_TOKEN` — no new actions or secrets. First real run not yet observed
  (flag 26).

## Live-daemon rehearsals (flag 42)

- `scripts/unbound-reachability-live.sh --native` runs four real resolvers on this
  host (Unbound 1.26.1) — `MODULES` in that script must stay in step with
  `unboundReachability.ts`'s runtime imports, and `argv.mjs` is copied into the
  harness dir beside `harness.mjs`. Both were stale once; the rig fails on
  `ERR_MODULE_NOT_FOUND`, not on a resolver verdict.
- `dnsmasqDeployLive.test.ts` needs a `dnsmasq` binary (`brew install dnsmasq`) and
  `dig`; skips cleanly without them. Same convention for `bind-mechanisms.test.ts`
  (named + named-checkzone) and `privoxyDeployLive.test.ts` (`brew install privoxy`).
- Docker-gated suites (`image inspect` gate, never pull): `piholeLive.test.ts`
  (`pihole/pihole`), `adguardHomeLive.test.ts` (`adguard/adguardhome`),
  `technitiumDeployLive.test.ts` (`technitium/dns-server`). Each runs a container,
  drives the daemon's own API and checks the observable effect; skips when the
  image is absent so CI and contributors stay green.
- Pi-hole supports v5 (`?auth=`) and v6 (`/api/auth` sid + `X-FTL-SID`) via
  `piholeApi.ts`; `sinkholeFetch` uses fresh single-use sockets +
  `insecureHTTPParser` because FTL/CivetWeb emits bytes after the chunk terminator
  that poison strict-parser socket reuse. Colima/docker-on-mac still flakes
  occasionally — the live suite tolerates transport errors, never semantic ones.
- BIND null-zone: `exportFormat` delegates allowed children per parent
  (`db.bm.null.<parent>`, child `IN NS` to resolved authority); the sync
  `generateFilterList` stays NOT HONOURED — inject `resolveNs` in tests rather
  than hitting DNS.

## Verified suite counts (rc.7)

Core 47/1322, CLI 89, browser-extension 55/793, electron-app 54/607 (55 suites,
10 skipped incl. docker-gated live suites when images are absent),
homeassistant-integration 14. `tsc --noEmit` clean everywhere; eslint
zero warnings. Extension tests need `--experimental-vm-modules` (the `npm test` script
sets it — bare `npx jest` fails to load 15 suites).

## Testing the LAN feed server

`npm run start` in `packages/electron-app` (or the running dev app on :9191) serves the
feed. Routes are guarded by
`feedAuth.ts` (origin allowlist + optional `feedToken` bearer, unset = documented
LAN-open model, flag 45) and filename-allowlisted by `feedServing.ts`.
