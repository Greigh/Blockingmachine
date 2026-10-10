# Pass 2 — Remediation Results

**Date:** 2026-10-09
**Scope:** Electron main/preload/renderer, TypeScript store boundaries, React view lifecycle, system-daemon socket fix (flag 77).
**Status values:** per the Pass-2 convention (`FIXED AND VERIFIED` / `FIXED BUT NOT FULLY VERIFIED` / `DEFERRED` / `REQUIRES APPROVAL` / `UNRESOLVED` / `FALSE POSITIVE`).

## Provenance note

The Pass-1 report set referenced by the task brief (`audit/AUDIT_REPORT.md`, `audit/ARCHITECTURE_REVIEW.md`,
`audit/SECURITY_REVIEW.md`, `audit/PERFORMANCE_REVIEW.md`, `audit/TEST_RESULTS.md`, `audit/REMEDIATION_PLAN.md`,
`audit/AUDIT_COVERAGE.md`) does not exist in this repository, on any branch, or in `~/Downloads` — the only audit
artifact on disk is the root `AUDIT.md` dated 2026-09-24, plus the living ledger `docs/open-flags.md`. With the
owner's explicit direction ("fresh scoped audit + remediate"), this pass treated `AUDIT.md`'s five findings as
claims to re-verify against current source, the uncommitted flag-77 diff as in-flight work to validate, and
performed a fresh review of the Electron/TypeScript/React trust surface.

## Historical findings re-verified (AUDIT.md, 2026-09-24)

| ID | Claim | Re-verified in current source | Status |
|----|-------|-------------------------------|--------|
| SEC-01 | `networksetup`/`dscacheutil` command injection | `daemonManager.ts` uses `execFile`/argument arrays and a `^[a-zA-Z0-9_\- ]+$` service-name allowlist; no shell string interpolation. `daemonManager.test.ts` still pins rejection. | FIXED AND VERIFIED (pre-existing) |
| SEC-02 | SSRF redirect bypass / local file traversal in `fetchWithConditionalCache` | `packages/core/src/fetch.ts` performs manual redirect walking (≤5), protocol re-checks each hop, `isSafePublicWebUrl` gating, 100 MB cap, SHA-256 verification. Caveat intact and documented: lexical IP checks do not defeat DNS rebinding. | FIXED AND VERIFIED (pre-existing) |
| SEC-03 | Feed server CSRF & unbounded bodies/SSE | `index.ts` feed routes enforce an origin allowlist, optional bearer token (`feedAuth.ts`, `timingSafeEqual`), 1 MB body caps, 64-client SSE cap, and the `feedServing.ts` filename allowlist. | FIXED AND VERIFIED (pre-existing) |
| SEC-04 | Daemon control API without origin checks | `packages/system-daemon/src/index.ts` binds loopback, checks Origin, caps bodies at 1 MB, validates quarantine domains (`QUARANTINE_DOMAIN_RE` + internal-suffix rejection). | FIXED AND VERIFIED (pre-existing) |
| RES-01 | Timer handles not cleared | Reviewed sites clean up in `finally`; all long-lived intervals are held in module-scoped handles. One residual leak found and fixed this pass (F-03). | FIXED AND VERIFIED (pre-existing) + F-03 |

## Flag-77 in-flight work — validated

The uncommitted diff present at the start of this pass (`dnsServer.ts` `reuseAddr`, `trayManager.ts` result
propagation, `ProtectionCard.tsx`, `DashboardView.tsx`, `daemonHardening.test.ts` coexistence test, `index.ts`
tray wiring) was left intact and re-verified this pass: `system-daemon` suite 35/35 including the
wildcard-`*:5353`-holder coexistence test and the retained exact-address conflict test; `tsc --noEmit`, ESLint,
and webpack main+renderer builds all clean. `ProtectionCard` polls on a 10 s interval with `isMountedRef`
cleanup — lifecycle discipline matches the codebase convention.

## New findings remediated this pass

### F-01 — Renderer-supplied quarantine domains written verbatim into store, daemon, and LAN feeds
- **Severity:** Low-Medium (integrity of published feeds; requires renderer compromise or XSS)
- **Root cause:** `add-threat-quarantine` trusted `item.domain` and other item fields. A `domain` containing
  `\n`, `\t`, or rule syntax (`^$important`) would inject raw lines into `threats.txt`/`ai-threats.txt`
  served to LAN subscribers and splice into the daemon's DNS rules. A missing `id` produced entries that
  `remove-threat-quarantine-item` could never match; a non-date `timestamp` NaN'd the newest-first sort.
- **Files modified:** `packages/electron-app/src/storePayloads.ts` (new `sanitizeQuarantineItems`),
  `packages/electron-app/src/index.ts` (handler consumes only the `accepted` list for store, daemon push,
  and SSE broadcast; reports `rejected` names).
- **Note on placement:** the sanitizer lives in `storePayloads.ts`, not `quarantineGate.ts`, because
  `quarantineGate.ts` is imported by the renderer (`AIRadarView`) and the bare `@blockingmachine/core`
  barrel cannot bundle for the browser target (it drags in `node-fetch`). Verified — the first version of
  this fix broke the renderer webpack build; the move restores it.
- **Tests:** `storePayloads.test.ts` — 8 cases covering newline/rule-syntax injection, non-string domains,
  non-object entries, id/timestamp repair; `ipcBoundary.test.ts` pins handler ordering (sanitize precedes
  store/daemon/SSE, no raw `items.map` survives).
- **Status:** FIXED AND VERIFIED

### F-02 — Dead `hitsPath` parameter on `get-extension-tier-plan` = file-read oracle
- **Severity:** Low (read primitive with no content exfil; still an unnecessary trust-boundary surface)
- **Root cause:** the handler preferred a renderer-supplied `hitsPath` over the dialog-remembered
  `tierLedgerPath` for `fs.readFile`. No caller passed it — dead surface that let the renderer name any
  file for a main-process read (existence/timing oracle).
- **Files modified:** `index.ts` (request type + resolution logic), `preload.ts` (bridge signature),
  `types/index.d.ts` (public type).
- **Tests:** `ipcBoundary.test.ts` pins absence of `hitsPath` in handler + preload.
- **Status:** FIXED AND VERIFIED

### F-03 — `scoreObservations` interval dropped on the floor
- **Severity:** Low (event-loop retention on quit paths; no functional defect observed)
- **Root cause:** `setInterval(scoreObservations, 5 * 60 * 1000)` was neither assigned nor `unref`'d,
  unlike every other long-lived timer in the file — it could pin the event loop open on quit.
- **Files modified:** `index.ts` — handle captured into `observationScoreTimer`, both the warm-up
  `setTimeout` and the interval `unref`'d.
- **Tests:** `ipcBoundary.test.ts` static pin on the timer site.
- **Status:** FIXED AND VERIFIED

### F-04 — `RuleInspectorView` post-await `setState` with no mount guard; uncancelled copy timeout
- **Severity:** Low (React 18 no-ops on unmounted writes, but every other view in the codebase follows the
  `isMountedRef` convention; the copy `setTimeout` could fire after unmount)
- **Root cause:** six async handlers (`handleInspect`, `handleTargetSyntaxChange`, `handleAddToCustom`,
  `handleAllowlistDomain`, `handleTuneMiniAi`, `handleForgetMiniAi`) set state after IPC awaits without a
  mount check; `handleCopy` used a bare 2.5 s `setTimeout`.
- **Files modified:** `packages/electron-app/src/views/RuleInspectorView.tsx` — `isMountedRef` +
  `copyTimeoutRef`, cleanup effect, all post-await setState guarded.
- **Tests:** static only — jest is node-env (`testMatch: **/*.test.ts`, no DOM renderer); verified by
  `tsc --noEmit` + eslint + webpack renderer build.
- **Status:** FIXED BUT NOT FULLY VERIFIED (no component test harness exists for this package)

### F-05 — Generated service-install scripts interpolate paths unescaped
- **Severity:** Low-Medium (unit-file directive injection into a root-installed service; requires a
  crafted save path + user executing the generated instructions)
- **Root cause:** `getServiceInstallInstructions` XML-escaped feed paths in the plist but not
  `process.execPath`/daemon entry, and interpolated all three feed paths plus the `ExecStart` pair raw into
  the systemd unit. systemd unescapes C-sequences inside `Environment="…"`, expands `%` specifiers, and
  splits `ExecStart` on unquoted whitespace — a path containing `"`, `\`, `%`, space, or `\n` corrupts the
  unit or injects a directive.
- **Files modified:** `daemonManager.ts` — `unit()` escaper (`\\`, `"`, `%`, `\n`, `\r`, `\t`), plist
  `ProgramArguments` XML-escaped, `ExecStart` quoted pair.
- **Tests:** `daemonManager.test.ts` — three new cases: systemd escaping (incl. newline→`\\n` so no real
  `ExecStartPost=` line materializes), plist XML escaping, quoted `ExecStart` regex.
- **Status:** FIXED AND VERIFIED

### F-06 — Store-writing IPC handlers trusted renderer payload shapes
- **Severity:** Low-Medium. The concrete defect: non-numeric `pollIntervalSeconds`/`intervalMinutes`
  produced `NaN` → `setInterval(fn, NaN)` ≈ 1 ms busy-loop hammering the configured sinkhole (CPU + LAN
  noise). Malformed `filterSources`/`customRules`/`additionalFormats`/`autoSchedule`/`webhookUrl`/
  `aiConfig`/`sinkhole-config` persisted junk that downstream consumers re-read as trusted.
  `set-ai-config` additionally let a renderer write `apiKeyEncrypted` (blob this keychain cannot read →
  silent credential loss) and `encryptionAvailable` (spoofs the "secrets are sealed" UI).
- **Files modified:** `packages/electron-app/src/storePayloads.ts` (new — whitelist validators),
  `index.ts` handlers: `save-custom-rules`, `save-sources`, `set-filter-sources`, `set-additional-formats`,
  `set-auto-schedule`, `set-webhook-url`, `start-live-radar-session`, `set-ai-watchdog-config`,
  `set-ai-config`, `set-sinkhole-config`.
- **Convention:** refuse-and-report — malformed input returns `{success:false, error}`; unknown keys are
  dropped rather than persisted; no `Boolean()`/`String()` coercion that could conceal malformed input.
- **Tests:** `storePayloads.test.ts` — ~50 cases across all validators incl. the NaN-timer regression,
  adaptive-field drop, sealed-field drop, per-field type checks.
- **Status:** FIXED AND VERIFIED

### F-07 — `test-ai-connection` echoed unbounded remote content through IPC
- **Severity:** Low (renderer names the Ollama URL by design — LAN endpoints are the feature; but the
  response `models[].name` was joined unbounded into the IPC reply, and non-string names stringified)
- **Files modified:** `index.ts` — names filtered to strings, capped at 50 × 120 chars.
- **Tests:** covered by type-check + review; no dedicated unit test (handler is in non-importable `index.ts`).
- **Status:** FIXED AND VERIFIED (bounded by construction; SSRF-by-design caveat documented below)

## Assessed and intentionally not changed

- **`test-ai-connection` fetches renderer-supplied `ollamaUrl`/`apiEndpoint`.** Reaching LAN/local
  endpoints is the feature (Ollama default is `127.0.0.1:11434`); applying `isSafePublicWebUrl` would
  break it. Returns status/latency + bounded model names only — no request body control beyond GET.
  Documented as an accepted boundary, consistent with `test-sinkhole-connection`.
- **`set-sinkhole-config` secret fields** already write-only with `clearSecrets` opt-in — kept.
- **`get-feed-pairing-payload`** includes the feed token in the QR payload — that *is* the pairing
  mechanism; unchanged.
- **`isSafePublicWebUrl` DNS-rebinding caveat** — lexical checks don't resolve/pin DNS; documented in
  source, unchanged (would require a resolver-pinned fetcher — architectural, deferred).

## Regression assessment

All modified paths are covered: `storePayloads.test.ts` (new, ~50 cases), `ipcBoundary.test.ts` (new,
wiring pins), `quarantineGate.test.ts` + `daemonManager.test.ts` (extended). Full monorepo suite green —
see `FINAL_VALIDATION.md`. No public API or file-format changes; the only IPC contract change is the
removal of the dead `hitsPath` parameter (no caller used it).
