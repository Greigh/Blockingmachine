# Agent Notes

Project context and operational knowledge for agents working in this repository.
Session-level detail lives in the Dexio wiki under `projects/blockingmachine/` and in
`docs/open-flags.md` (the audit ledger — open items at top, closed ones at bottom).

## Current release state

- **`v1.0.0-rc.7` shipped 2026-10-03** — tag on `origin` (GitHub `Greigh/Blockingmachine`)
  and `forgejo` (`git.greighstudios.com`). GitHub pre-release holds local darwin-arm64
  artifacts + extension zips + npm tarballs + `SHA256SUMS.txt`; `publish.yml` was
  manually dispatched to attach CI-built win32/linux/macos builds.
- **npmjs.com**: `@blockingmachine/core` and `@blockingmachine/cli` `1.0.0-rc.7` under
  dist-tag `rc`.
- **Forgejo npm registry**: publish fails `401 Unauthorized` — `FORGEJO_TOKEN` in `.env`
  lacks package-write scope. Needs a fresh token before the next release can publish
  there.

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
- `publish.yml` triggers on tag push (`v*`) and `workflow_dispatch`; it builds all
  platforms and uploads onto the release, creating it if absent.

## Verified suite counts (rc.7)

Core 47/1315, CLI 89, browser-extension 55/792, electron-app 47/579 (1 skipped,
pre-existing), homeassistant-integration 14. `tsc --noEmit` clean everywhere; eslint
zero warnings. Extension tests need `--experimental-vm-modules` (the `npm test` script
sets it — bare `npx jest` fails to load 15 suites).

## Testing the LAN feed server

`npm run start` in `packages/electron-app` (or the running dev app on :9191) serves the
feed. Routes are guarded by
`feedAuth.ts` (origin allowlist + optional `feedToken` bearer, unset = documented
LAN-open model, flag 45) and filename-allowlisted by `feedServing.ts`.
