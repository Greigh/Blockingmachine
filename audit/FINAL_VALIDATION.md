# Pass 2 — Final Validation

**Date:** 2026-10-09
**Host:** macOS (Darwin 27.0.0), Node v22.x toolchain (jest via `--experimental-vm-modules`), npm workspaces.

## Commands executed and results

| # | Command | Result |
|---|---------|--------|
| 1 | `npm run lint` (all workspaces) | **PASS** — exit 0, no errors/warnings reported |
| 2 | `npm run build` (all workspaces, incl. webpack main + renderer + systemDaemon bundle) | **PASS** — exit 0. Note: an intermediate failure was observed and fixed during the pass (see "Failure observed and corrected" below) |
| 3 | `npm run type-check` (all workspaces, `tsc --noEmit`) | **PASS** — exit 0 |
| 4 | `npm test` (all workspaces) | **PASS** — exit 0 |
| 5 | electron-app targeted: `jest quarantineGate storePayloads daemonManager ipcBoundary` | **PASS** — 4/4 suites, 113 tests |
| 6 | `npm test --workspace=@blockingmachine/electron-app` (full package rerun after final edits) | **PASS** — 60/64 suites (4 skipped: docker/binary-gated live suites), 755/772 tests (17 skipped) |

## Per-workspace test counts (full `npm test` run)

| Workspace | Suites | Tests | Skipped |
|-----------|--------|-------|---------|
| browser-extension | 55/56 | 809/810 | 1 |
| cli | 9/9 | 88/89 | 1 |
| core | 47/47 | 1326/1326 | 0 |
| electron-app | 60/64 | 732/749 (first run), 755/772 (final rerun) | 17 |
| homeassistant-addon | 7 | 61 | 0 |
| homeassistant-integration | python `unittest` | passed | — |
| mobile | passed | — | — |
| system-daemon | 5/5 | 35/35 | 0 |

Skipped suites are the documented docker-gated (`piholeLive`, `adguardHomeLive`, `technitiumDeployLive`)
and binary-gated (`dnsmasqDeployLive`, etc.) live rehearsals — they skip by design when images/binaries are
absent. The flag-77 `daemonHardening.test.ts` wildcard-coexistence test is inside the system-daemon 35/35.

## New/extended test files

- `packages/electron-app/src/__tests__/storePayloads.test.ts` — new, ~50 cases (F-01, F-06)
- `packages/electron-app/src/__tests__/ipcBoundary.test.ts` — new, wiring pins (F-01, F-02, F-03)
- `packages/electron-app/src/__tests__/quarantineGate.test.ts` — unchanged behavior (sanitizer moved to
  storePayloads); still passes
- `packages/electron-app/src/__tests__/daemonManager.test.ts` — +3 cases (F-05)

## Failure observed and corrected during the pass

The first version of F-01 imported `sanitizeDomain` from `@blockingmachine/core` inside
`quarantineGate.ts`. That module is imported by the renderer (`AIRadarView`), and the bare core barrel
pulls `node-fetch` → **28 webpack renderer errors**. Corrected by moving `sanitizeQuarantineItems` into
`storePayloads.ts` (main-process-only); rebuild green. Documented in `storePayloads.ts`.

## Security re-audit of modified paths

- No new IPC channels; the only contract change is removal of the dead `hitsPath` parameter.
- Renderer privileges unchanged (same `contextBridge` surface minus one dead field).
- No new Node exposure; `contextIsolation`/`sandbox`/`nodeIntegration:false` untouched.
- Validators refuse-and-report — no coercion paths added; secrets remain write-only.
- No new filesystem reads: F-02 *removed* a renderer-controlled `fs.readFile` surface.
- Generated service scripts now escape for both target parsers (XML + systemd).
- No secrets, tokens, or credentials introduced or logged in the diff.

## Performance/memory review

- F-03 removes a floating interval (event-loop retention on quit).
- F-06 removes the NaN-interval busy-loop primitive (`setInterval(fn, NaN)` ≈ 1 ms).
- F-04 removes a dangling timeout + unmounted setState calls.
- No before/after benchmarks were captured — no performance improvement is claimed beyond removing the
  defects above (per the no-fabrication requirement).

## Known limitations / not verified this pass

- React lifecycle fixes (F-04, `ProtectionCard`) verified by type-check + lint + webpack build only;
  jest is node-env with no DOM/renderer harness — no component-mount test exists.
- No packaged-app live rehearsal was run this pass (the flag-77 live `dig` verification was recorded in
  the previous session; this pass relies on the retained hardening-suite coverage).
- DNS-rebinding caveat on `isSafePublicWebUrl` remains a documented design limitation.
- `test-ai-connection` LAN fetching is an accepted boundary (feature requires it); the response echo is
  now bounded.

## Uncommitted pre-existing work preserved

The flag-77 diff (`dnsServer.ts`, `trayManager.ts`, `ProtectionCard.tsx`, `DashboardView.tsx`,
`daemonHardening.test.ts`, AGENTS.md, `docs/open-flags.md`, package version bumps) was present before this
pass and is unchanged except where fixes landed on top (`index.ts` tray result passthrough was already
theirs). Nothing was reverted or squashed away.
