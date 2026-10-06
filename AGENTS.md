# Agent Notes

Project context and operational knowledge for agents working in this repository.
Session-level detail lives in the Dexio wiki under `projects/blockingmachine/` and in
`docs/open-flags.md` (the audit ledger — open items at top, closed ones at bottom).

## Current release state

- **`v1.0.0-rc.9` shipped 2026-10-04** — tag on `origin` (GitHub `Greigh/Blockingmachine`)
  and `forgejo` (`git.greighstudios.com`). GitHub pre-release holds the full asset set:
  local darwin-arm64 dmg/zip + extension zips + npm tarballs + `SHA256SUMS.txt`,
  plus `publish.yml`'s CI-built win32/linux/macos installers attached on the tag push.
- **`package-all.mjs` empties `make/` itself now** — `gh release create … make/*`
  sweeps the whole directory, so rc.7/rc.8 leftovers rode onto the rc.9 release and
  polluted `SHA256SUMS.txt` until deleted post-hoc. The script now `rmSync`s the dir
  before collecting; the manual-clean advice is moot.
- **npmjs.com**: `@blockingmachine/core` and `@blockingmachine/cli` `1.0.0-rc.9` under
  dist-tag `rc`. A publish may sit in npm's internal "staged" state for minutes —
  `npm view` 404s while the packument finalizes and a republish 409s
  ("previously staged version"). It resolves on its own; poll the packument.
- **Forgejo npm registry**: publish fails `401 Unauthorized` — `FORGEJO_TOKEN` in `.env`
  is invalid outright ("access token does not exist" per the API), not merely
  under-scoped. Git pushes authenticate over SSH, a different credential. Needs a
  fresh token with package write scope — flag 53 tracks it. Both publish scripts now
  exit nonzero on a real failure (already-published tolerated as idempotent), so a
  future bad token turns the workflow step red instead of passing quietly.
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
  auto-schedule timer — both call it). Two `worker_threads` bundles carry the
  synchronous CPU: `classifierWorker.cjs` (~130s cold classify) and
  `outputWorker.cjs` (post-dedup generation — three `generateFilterList` calls,
  both segregations, host-candidate extraction, hot-set derivation; input is the
  rules' joined raws, never the ~160MB rule-object clone). Both are webpack
  entries and `asarUnpack`'d; each has a yielded inline fallback
  (`generateOutputsInline`, the classify loop). Dedup/attribution loops yield
  via `yieldToEventLoop`. `filters/` ships via `extraResource` — relative
  `./filters/...` sources resolve `process.resourcesPath`-first packaged,
  `app.getAppPath()` in dev. The managed DNS daemon is a third bundle,
  `systemDaemon.cjs` (`daemonManager.start()` spawns it under
  `ELECTRON_RUN_AS_NODE`; the tray's "Start DNS Protection" row calls the same
  path). Webpack entries pointing *outside* `src/` must use the built `dist/`
  entry, not `src/` — ts-loader picks up the other package's own tsconfig
  (`rootDir`) and then rejects every electron-app file as "not under rootDir".
- **macOS notarization**: `osxNotarize` in `forge.config.cjs` is env-gated —
  `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` or
  `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`; unset means signed-but-unnotarized
  (flag 54). After `rm -rf` + `cp -R` reinstalling the app, run
  `lsregister -f /Applications/Blockingmachine.app` or `open` silently no-ops on
  the stale LaunchServices record. After *several* rm/recopy cycles in one day
  the wedge can deepen: every LaunchServices-mediated launch of
  `com.electron.blockingmachine` (open, open -b, AppleEvent reopen) then exits
  0 in ~100ms before app code — for any copy of the binary, including a
  pristine release zip — while direct exec and other apps stay fine.
  `lsregister -u`/`-f` and `tccutil reset` did not clear it; the recovery is a
  reboot (or `sudo killall launchservicesd`). Verify the binary itself with
  `env -u ELECTRON_RUN_AS_NODE <binary>` before diagnosing an app defect.

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

Core 47/1322, CLI 89, browser-extension 55/793, electron-app 55/619 (56 suites,
10 skipped incl. docker-gated live suites when images are absent),
homeassistant-addon 51 (`node --test`), homeassistant-integration 13 (`unittest`).
`tsc --noEmit` clean everywhere; eslint zero warnings. Extension tests need
`--experimental-vm-modules` (the `npm test` script
sets it — bare `npx jest` fails to load 15 suites).

## Testing the LAN feed server

`npm run start` in `packages/electron-app` (or the running dev app on :9191) serves the
feed. Routes are guarded by
`feedAuth.ts` (origin allowlist + optional `feedToken` bearer, unset = documented
LAN-open model, flag 45) and filename-allowlisted by `feedServing.ts`.

## Home Assistant surface

- The HACS integration lives at repo-root `custom_components/blockingmachine/`;
  `packages/homeassistant-integration/custom_components` is a **symlink** to it
  (so `find` without `-L` sees nothing). `hacs.json` belongs at the package/repo
  root — never inside the domain dir.
- The `blockingmachine` integration talks the `/v1/*` REST API that **both** the
  electron app's feed server and the HA add-on implement — the shapes must agree:
  `/v1/status` (`rules`, `protection`, `aiRadar`, `browserTelemetry`),
  `/v1/compile`, `/v1/protection` (POST `{enabled}`, 503 when the daemon is down),
  `/v1/check?domain=` (flat `blocked` boolean + matcher detail, longest-match
  semantics), `/v1/control/*`. A token field rides every request as
  `Authorization: Bearer` — the add-on gates its whole surface when `feed_token`
  is set, the app gates mutations on `feedToken`.
- The integration's Python tests mock the `homeassistant` package — new HA
  imports in the component need matching `sys.modules` mocks in
  `tests/test_coordinator_logic.py`.

## Mobile companion (`packages/mobile`, on `feat/mobile-app`)

- Expo SDK 57 + expo-router, iOS/Android remote for the `/v1` surface. Spec:
  `docs/mobile-app-design.md`. **Dev-client builds only** — `react-native-zeroconf`
  (mDNS) and `expo-camera` (QR) are native; Expo Go cannot run it.
- **React is deliberately `^19.3.0`, not the template's 19.2.3** — the repo hoists
  react@19.3.0; pinning 19.2.3 nests a second copy and every renderer test dies on
  a null hooks dispatcher. `@testing-library/react-native` v14 renders through
  `test-renderer@^1` (not `react-test-renderer`). `typescript ~5.8.3` is kept for
  repo consistency — `expo install --check` flags all three mismatches; they are
  intentional.
- **Deps track npm-latest, not Expo's bundled pins** (deliberate): `react-native
  ^0.87.1` vs SDK-57's 0.86.3, `async-storage ^3.1.1` vs 2.2.0, `safe-area-context
  ^5.10.1` vs ~5.7.0, `screens ^4.28.0` vs ~4.26.0. `expo install --check` flags all
  of them — intentional. SDK 58 exists only as `next` (pre-release); the expo-*
  modules stay on the `latest`/57 line. RN 0.87 relocated two entry points Expo 57
  still addresses at 0.86 paths, bridged by postinstall patch
  `scripts/patch-react-native-rn087.cjs` (`rn-get-polyfills` →
  `@react-native/js-polyfills`; `@react-native/assets-registry` stub package →
  `react-native/asset-registry`). Without it `expo export` hard-fails in
  `@expo/metro-config` and every jest-expo suite dies on the unresolvable mock.
  The same script carries the whole **Android-side bridge to AGP 9.2.1** (RN 0.87's
  pinned AGP — requires Gradle 9.4.1; the generated wrapper's distributionUrl is
  bumped by hand, `android/` is gitignored): `-Xskip-metadata-version-check` on the
  included plugin builds (KGP-2.1 compilers vs Gradle's stdlib 2.3), removal of every
  `kotlin-android` apply (AGP-9 built-in Kotlin owns the `kotlin` extension — the
  external KGP casts to the deleted `BaseExtension`), AGP-8→9 DSL type swaps inside
  expo's own Gradle plugin Kotlin sources (`BaseExtension`→`CommonExtension<*,…>`,
  `LibraryExtension`→api.dsl, `flavorDimensions`/`singleVariant`/`versionName`
  rewrites), a scan that strips `targetSdkVersion`/`versionCode`/`versionName` from
  every module `android/build.gradle` (removed from the library DSL), Kotlin-source
  dirs built-in Kotlin would miss (`src/compose` in expo-modules-core, `src/main` in
  `@expo/log-box`, and the autolinking-generated package-list/inline-module dirs —
  all were registered via `java.srcDirs`, which built-in Kotlin ignores →
  `ExpoModulesPackageList` `ClassNotFoundException` at app launch), and
  `gradle.properties` appends (`android.kotlinVersion=2.2.10` for KSP alignment,
  `android.sourceset.disallowProvider=false`,
  `android.disallowKotlinSourceSets=false`). `expo prebuild --clean` regenerates
  `android/`, so every repo-side edit there is re-applied by the postinstall script —
  verify `./gradlew assembleRelease` stays green rather than trusting a stale dir.
- The workspace has **no `build` script** so `npm run build --workspaces` skips it —
  builds are `expo prebuild`/EAS. `test`/`lint`/`type-check` do run under
  `--workspaces`.
- **`usesCleartextTraffic: true` in `app.json` is load-bearing** — every endpoint is
  a user-supplied LAN `http://` host; Android's default network policy blocks them
  all. iOS parity rides the `NSAppTransportSecurity`/`NSAllowsArbitraryLoads`
  infoPlist entry. `react-native-zeroconf@0.17` exports the `Zeroconf` *class* —
  `discovery.ts` instantiates + caches it (per-instance DeviceEventEmitter
  listeners). Emulator rehearsal caveat: the virtual NAT blocks host multicast, so
  mDNS "Find on network" runs NSD but can never resolve — physical-device check.
- Server-side pairing surface: `mdnsAdvertiser.ts` publishes `_blockingmachine._tcp`
  (TXT `api=v1`, `version`, `token=required|open`) while the feed server listens;
  `get-feed-pairing-payload` IPC feeds the Settings QR (`{"v":1,"url","token?"}`).
  bonjour-service bundles into `.webpack/main` — no externals config needed.
- Client shape differences it must tolerate: add-on `/v1/check` answers
  `matchedHost`/`source` where the hub answers `coveringRule`/`verdict`; add-on
  `/v1/status` lacks `daemonStatus`/`recentTrackers`/`activeSseClients`; add-on
  `/v1/protection` is POST-only (read protection via status).
