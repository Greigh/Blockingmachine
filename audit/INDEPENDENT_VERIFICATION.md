# Pass 3 — Independent Verification

Independent review of the Pass-2 remediation set (F-01…F-07), the flag-77 in-flight
work, and the surrounding trust boundaries. **Nothing in this document trusts a
previous report's VERIFIED status** — every claim below was reproduced against the
current source or executed behaviorally.

Verification stance changed materially from Pass 2: this pass boots the real
`registerIPCHandlers` under a mocked Electron (`ipcBehavioral.test.ts`), drives the
components in a real DOM (`*.dom.test.tsx`), starts the real feed server and reads
its output over HTTP, and profiles repeated workflows. Static source pins remain,
but no fix below is credited on pins alone.

## Method and environment

- Host: macOS (Darwin, arm64). Only supported OS available in this environment;
  Windows/Linux packaged behavior is **untested**.
- Harness: `packages/electron-app/src/__tests__/ipcBehavioral.test.ts` boots
  `index.ts` under mocked `electron` / `electron-store` / `electron-is-dev` and a
  stubbed reputation-DB edge; 22 tests invoke the real registered handlers.
- Component env: electron-app `jest.config.cjs` now runs two projects (`node` for
  `.test.ts`, `dom` + jsdom + testing-library for `.test.tsx`), mirroring
  `packages/browser-extension`'s established split.
- Packaged app: `npm run package` produced `out/Blockingmachine-darwin-arm64` —
  launched directly with `env -u ELECTRON_RUN_AS_NODE` per AGENTS.md.

## Result ledger

| ID | Pass-2 claim | Independent verdict |
|----|--------------|---------------------|
| F-01 quarantine sanitize | FIXED AND VERIFIED | **PARTIAL at verification** — write path verified behaviorally; output paths unscreened (IV-01). **Corrected this pass and re-verified over HTTP.** |
| F-02 hitsPath removal | FIXED AND VERIFIED | VERIFIED — behavioral no-op proven |
| F-03 observation timer | FIXED AND VERIFIED | VERIFIED with residual — never cleared on `before-quit` (IV-02). **Corrected this pass.** |
| F-04 RuleInspectorView lifecycle | FIXED BUT NOT FULLY VERIFIED | VERIFIED by real DOM tests, **except** one unguarded `setRuleConflict` path (IV-03). **Corrected this pass.** |
| F-05 service-install escaping | FIXED AND VERIFIED | VERIFIED for XML/systemd metachars (`plutil` roundtrip); newline→heredoc injection residual (IV-04). **Corrected this pass.** |
| F-06 store payload validation | FIXED AND VERIFIED | VERIFIED behaviorally — all hostile classes refused |
| F-07 bounded Ollama echo | FIXED AND VERIFIED | VERIFIED over real HTTP with hostile payloads |
| (new) — | — | `writeFileAtomic` tmp-name collision under same-ms concurrency (IV-05). **Corrected this pass.** |

## Pass-3 corrections applied (all post-documentation, as authorized)

- **IV-01**: `renderThreatsFeed` and the `/ai-threats.txt` route now run every emitted
  domain through `sanitizeDomain` and drop rejects; the watchdog and live-radar
  quarantine writers sanitize `t.domain`/`fresh.domain` before persisting, so the
  store stays clean for the daemon trie and SSE broadcast too.
- **IV-02**: `before-quit` clears `observationScoreTimer` alongside the other timers.
- **IV-03**: the `checkRuleConflict` `.then` callback now checks `isMountedRef`.
- **IV-04**: `daemonManager.xml()` maps `\r`/`\n` to `&#13;`/`&#10;` (single physical
  line, decodes back in the plist); `set-save-path` now rejects control characters.
- **IV-05**: `writeFileAtomic` tmp names gain a per-process sequence counter.
- Verification: `ipcBehavioral.test.ts` emit-boundary test now asserts the poisoned
  entry is absent from both feeds over real HTTP while a legitimate entry publishes;
  new `daemonManager.test.ts` case asserts a newline payload survives only as inert
  single-line plist text; full suite 788/808 (17 docker-gated + 3 gc-gated skips).

## Confirmed failures (documented before any correction)

### IV-01 — F-01 output-boundary gap: persisted/domestic domains emit verbatim into LAN feeds

- **Status: CONFIRMED, reproduced over HTTP.**
- Evidence: `renderThreatsFeed()` (`index.ts` ~639-655) maps stored domains into
  `||${d}^` with no re-screen; `/ai-threats.txt` (~3104-3122) joins `t.domain` raw.
  Writers beyond the sanitized IPC path: the watchdog sweep (~1253-1281) and the
  live-radar writer (~1491-1502) persist classifier output.
- Reproduction (executed, `ipcBehavioral.test.ts` "F-01 RESIDUAL"): seed the store
  with a pre-fix poisoned entry `domain: 'bad.example\n||allow-everything.example^'`,
  start the real feed server on 19191, GET `/threats.txt` → injected rule appears as
  a standalone feed line; same for `/ai-threats.txt`.
- Reachability analysis: the only way poison enters today is (a) a store written
  before the fix — real for existing installs; (b) an internal writer — the
  classifier's `normalizeHostname` strips control chars so `\n` cannot survive the
  scan path, but `;`, `<`, `>`, `^`, `$` do survive (`normalizeDomain` falls back to
  the raw host when `sanitizeDomain` rejects it), producing malformed/`^`-broken
  feed lines; (c) any future non-IPC writer.
- Why this is a fix-completion failure, not a new issue: F-01's stated purpose was
  feed-injection prevention; screening only the entry point leaves the emit path —
  and every persisted pre-fix entry — live.

### IV-02 — F-03 residual: `observationScoreTimer` never cleared

- **Status: CONFIRMED (minor).**
- `index.ts` 3412 captures + unrefs the interval (event-loop pinning fixed — verified
  statically and via the packaged app's clean SIGTERM exit), but `before-quit`
  (6090-6117) clears every other long-lived timer and not this one. Quit safety is
  covered by `unref`; the gap is consistency — a `scoreObservations` firing during
  teardown could read torn-down state (low risk; it only reads a file + store).

### IV-03 — F-04 residual: one unguarded post-await setState

- **Status: CONFIRMED (low severity).**
- `RuleInspectorView.tsx` ~117-118: `checkRuleConflict(...).then(c => { if
  (c?.hasConflict) setRuleConflict(c) })` — the only `.then` chain in the file with
  no `isMountedRef` guard (the synthesize path at ~170-171 is guarded; this one was
  missed). React 19 drops the update silently; severity is bounded to a lost warning
  log — but it is precisely the defect class F-04 claimed to close.
- Everything else in the component verified behaviorally: post-unmount IPC
  resolution drops silently (no act warnings), the copy timeout is cleared on
  unmount with the exact armed timer id, and a remount re-arms the flag.

### IV-04 — F-05 residual: newline-bearing paths inject through the macOS heredoc

- **Status: CONFIRMED, demonstrated.**
- `daemonManager.ts` `xml()` escapes `&<>` only. The plist is delivered inside a
  `sudo tee << 'EOF'` heredoc — a `savePath` containing `\nEOF\n` closes the heredoc
  early and the following lines run as root shell commands when the user pastes the
  generated script. `set-save-path` accepts any absolute string; newlines are legal
  POSIX path bytes.
- Demonstrated by generating the install script with feed path
  `/tmp/feed\nEOF\nsudo sh -c "echo pwned"\nEOF/x` — the injected line appears as a
  bare shell command after the first `EOF`.
- The systemd side is NOT affected: `unit()` escapes `\n`→`\\n` (single physical
  line, inside quotes) — verified.

### IV-05 — new finding: `writeFileAtomic` tmp-name collision

- **Status: CONFIRMED (pre-existing defect, not Pass-2-introduced).**
- `index.ts` 617-631: `tmpPath = ${filePath}.tmp-${pid}-${Date.now()}` — millisecond
  resolution. Under concurrent same-ms writes (observed at scale in the profile run:
  3358 ENOENT warnings across 2000 quarantine adds), one caller's `rename` consumes
  the shared tmp file and the other's rename fails ENOENT; the failure is swallowed
  by `.catch(console.warn)` so the observable effect is a **silently stale
  `threats.txt`** on disk.
- Adjacent observation: every `add-threat-quarantine` call renders + writes the
  snapshot — no debounce (2000 adds → 2000 renders/writes; functional but wasteful).

## Verified clean (behavioral evidence)

- **F-02**: `get-extension-tier-plan` invoked with and without `hitsPath` pointing at
  a real decoy file → byte-identical result; the path is never touched.
- **F-06 hostile payloads** — refused end-to-end through the real handlers:
  non-boolean `enabled`, non-string `customRules`, unknown format enum, non-enum
  `autoSchedule`, `javascript:`/`file:`/unparseable/non-string webhook URLs, NaN-
  producing `pollIntervalSeconds`/`durationMinutes`/`intervalMinutes` (the busy-loop
  vector — refused with a targeted notice), renderer-injected `apiKeyEncrypted` /
  `encryptionAvailable` / unknown config keys (whitelisted out),
  `adaptiveIntervalMinutes`/`cadenceReason` caller-forgery (dropped), non-string
  sinkhole fields, null/undefined/string/number payloads against object channels —
  all refuse with `{success:false}` and no partial writes.
- **F-07**: real HTTP stub serving `{models:[50KB-name, 5000 names, non-strings]}`
  → reply bounded to ≤50 names ×120 chars; non-JSON body → clean failure; missing
  `models` → `ready` fallback.
- **Packaged app (fresh build)**: launches, registers IPC, tray + feed server +
  watchdog + reputation DB all live, `/v1/status` and `/threats.txt` serve real data
  (363k rules, 43 quarantined), SIGTERM exits cleanly — no event-loop pinning.
- **Repeated-workflow profile** (`ipcProfile.test.ts`, `--expose-gc`): 2000
  quarantine adds 330ms/+11MB retained; 200 feed-server start/stop cycles +1.0MB;
  1000 watchdog writes +1.3MB. No socket/handle accumulation; watchdog re-config
  clears the previous interval (1137-1140); `trayStatusTimer` unref'd.
- **Lifecycle statics**: `window-all-closed`/`activate` recreate correctly;
  `closed` uses an identity guard so a stale window can't null a replacement;
  `will-navigate`/`setWindowOpenHandler` restrict to localhost/file + safe externals;
  `render-process-gone` logs (no auto-recovery — noted, not changed).
- **HA addon**: global timing-safe token gate; `X-Ingress-Path` explicitly
  documented as non-boundary. **Mobile**: pairing URLs normalized, non-http(s)
  refused, token bound to its paired host. **CLI**: no exec/eval surface keyed on
  external input found.

## DNS-rebinding / LAN trust evaluation

`isSafePublicWebUrl` validates scheme + literal private ranges but does not pin
resolved addresses — `fetch.ts` 323-334 gates on the URL string alone, and the
comment in `urlSafety.ts` states the limit explicitly. A public hostname resolving
to a private address still passes. This matches Pass 2's assessment: a real fix
needs a resolver-pinned HTTP agent (connect to validated IP, SNI/Host pinned to the
hostname) — architectural, out of scope for a verification pass, and **unchanged**.
LAN-side, `test-ai-connection` fetches renderer-named endpoints by design (Ollama
default is loopback); the post-fix echo bound limits content exfil to ~6KB of
bounded strings. `get-ai-config` returns the plaintext `apiKey` to the renderer by
design (settings UI displays it), so `overrideConfig.apiEndpoint` on
`ai-scan-domain` grants no capability the renderer lacks.

## Environment limitations

- Windows/Linux packaged behavior untested (no hosts available).
- Real macOS sleep/resume not forced; no `powerMonitor` handlers exist — sockets are
  kernel-managed and SSE heartbeats reap dead clients, so the exposure is limited
  to stale-but-alive state on wake. Untested on real hardware cycle.
- Renderer crash/reload recovery is log-only by current design.
- Live Docker-gated suites (pihole/adguard/technitium) skipped — images absent, per
  project policy not pulled.
- The earlier `out/` artifact predated Pass-2 fixes (`hitsPath` present,
  `storePayloads` absent); the fresh package verified above contains all of them.
