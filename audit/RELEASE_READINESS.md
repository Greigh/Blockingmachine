# Pass 3 — Release Readiness

## Classification: **CONDITIONALLY READY**

The application is verified substantially better than at Pass-2's close: every
remediation now has behavioral evidence rather than static source assertions, four
confirmed completeness gaps were found and corrected, and the packaged macOS build
launches, serves feeds, and exits cleanly. "Conditionally" because the
verification is deep on macOS only and several trust-boundary tradeoffs are
deliberate-but-undecided owner calls — not because any known defect remains open.

## What this pass independently established

### Reproductions and verification (executed, not asserted)

| Check | Method | Result |
|-------|--------|--------|
| F-01 write path | Real `add-threat-quarantine` handler under mocked-Electron boot | newline/rule-syntax batches refused; valid items land |
| F-01 emit path (gap found + fixed) | Real feed server on :19191, `curl` of `/threats.txt` + `/ai-threats.txt` | pre-fix: injected line published verbatim; post-fix: dropped, legit entries publish |
| F-02 hitsPath | Real handler invoked ± `hitsPath` at a decoy file | byte-identical response; file never read |
| F-03 timers | Source + packaged-app SIGTERM | captured, unref'd, now cleared on quit; clean exit observed |
| F-04 lifecycle | jsdom + testing-library, pending-IPC-then-unmount | post-unmount setState dropped; copy timeout cleared by exact id; remount re-arms |
| F-05 plist/systemd | `plutil -lint` roundtrip + heredoc-break payload | XML metachars roundtrip byte-identical; `\nEOF\n` can no longer break the heredoc |
| F-06 payload classes | Real handlers, hostile corpus | every malformed/oversized/prototype-ish payload refused, no partial writes |
| F-07 Ollama echo | Real HTTP stub with hostile `models` | ≤50 names ×120 chars; non-JSON clean-fails |
| Startup→shutdown | Fresh `npm run package` binary, direct exec | IPC registered, tray+feed+watchdog live, 200s on feeds, SIGTERM clean |
| Repeated workflows | `--expose-gc` profile | +14.5MB/2000 adds, +1.1MB/200 server cycles, +1.2MB/1000 writes — no leak signal |

### New defects found in Pass 3 (all corrected)

1. Emit-boundary quarantine gap (pre-fix poisoned stores could inject feed lines).
2. `observationScoreTimer` not cleared at quit.
3. Unguarded `setRuleConflict` in a fire-and-forget `.then`.
4. Newline-in-path heredoc injection into the root-run launchd install script.
5. `writeFileAtomic` same-millisecond tmp-name collision → silently stale snapshots.

### Verification totals

- electron-app: **788 passed / 808 total** (17 docker-gated + 3 gc-gated skips), 63/68 suites.
- Whole workspace: browser-ext 809/810, cli 88/89, core 1326/1326, system-daemon 35/35, mobile + HA suites green.
- `npm run lint`, `npm run build`, `npm run type-check` — all exit 0 on the final tree.
- New test infrastructure: `ipcBehavioral.test.ts` (22), `ruleInspector.dom.test.tsx` (5), `protectionCard.dom.test.tsx` (5), `ipcProfile.test.ts` (3, gc-gated), daemonManager +1.

## Conditions attached to READY

1. **Ship a fresh package.** The `out/` artifact present at pass start predated all
   fixes; the verified build is the one produced here. Any release must cut a new
   artifact and verify `storePayloads`/`observationScoreTimer` symbols exist in the
   asar (one `grep -c`, as done this pass).
2. **Decide the remaining owner-level trust call** before or at release, not after:
   whether `feedToken` becomes mandatory (or auto-generated at first boot) for LAN
   mutations in *new* installs — `SECURITY_DECISIONS.md` D-1 with a concrete
   recommended option. Pass 4 closed the sharper edges around it: `.local`
   origins rejected, telemetry reads (`/v1/status` `/v1/telemetry` `/v1/check`)
   now carry the same origin+bearer gate `/v1/events` always had, CSPRNG token
   generation exists (`generate-feed-token` + Settings Generate button, 16-char
   floor on hand-typed tokens), and QR→bearer auth is verified end-to-end. The
   residual is raw no-Origin LAN posts in tokenless deployments — a deliberate
   compatibility exposure; sign off or tighten.
3. **Windows/Linux packaged verification is absent.** If the release ships those
   platforms, package and smoke-test on each — the systemd unit in particular has
   never met `systemd-analyze verify`.
4. **One manual macOS smoke** of the packaged UI (window open, settings save,
   daemon start/stop from the dashboard card) — this pass verified the process
   lifecycle and feeds, not rendered pixels.

## Not blocking, but tracked

- Real sleep/resume cycle untested (no powerMonitor handlers exist — likely fine,
  unproven).
- Pre-fix quarantine stores keep their malformed rows inert-but-present; a startup
  scrub would tidy (deferred — mutates user data).
- Docker-gated live suites stayed skipped per project policy.

## Confidence statement

High confidence in the Electron main/renderer trust boundary, store-payload
integrity, quarantine feed correctness, lifecycle/timer hygiene, and the packaged
macOS binary — all verified behaviorally on this pass. Medium confidence on
cross-platform packaging (macOS-only evidence) and on real-hardware sleep/crash
cycles (untested). No fabricated results: every number above was emitted by an
executed command in this session.
