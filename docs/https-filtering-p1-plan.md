# HTTPS filtering — P1 implementation plan (macOS capture + trust + UI)

Sibling to `https-filtering-p0-plan.md`; implements design-spec §11's P1 line — **macOS: pf helper, CA trust install, Deploy Hub pane, dogfood on this machine.** Every task below is implement → fresh-eyes review → fix → gate, separately committed, owner's dirty tree untouched, no agent trailers.

## Locked preconditions (from P0, already true)

- Engine: `startFilterProxy({storeDir, rulesPath, dataPort?, controlPort?, bindHost?, keyWrapBackend?})` from `@blockingmachine/https-filter` `dist/`; control API `/v1/proxy/*` on `:9293`; data listener `:9294` speaks explicit CONNECT, PROXY-v2 transparent, and sni/plain-HTTP dispatch.
- PROXY-v2 contract: a helper splices redirected TCP into `:9294` with a v2 STREAM header carrying the ORIGINAL destination; the engine never resolves original-dst itself (spec §5.2).
- Egress loop exemption on macOS: `rdr` on outbound `tcp:{80,443}` would capture the engine's own upstream dials → infinite recursion. The spec's answer stands: the ENGINE runs as dedicated user `_blockingmachine` so the anchor can carry `no rdr … user = _blockingmachine`. Consequence: the engine cannot write the user's login keychain → **trust install is a user-session operation owned by the app/CLI**, not the engine.
- The C helper only recovers original-dst + stamps PROXY v2 + splices; it also watches engine liveness and dumps the anchor when the engine is down (fail-open — spec §7).

## Task 1 — engine entrypoint + spawn plumbing (electron-app)

`packages/https-filter/src/main.ts` — the spawnable entry: config from env (`BM_STORE_DIR`, `BM_RULES_PATH`, `BM_DATA_PORT`, `BM_CONTROL_PORT`, `BM_BIND_HOST`), `startFilterProxy`, SIGTERM/SIGINT → `close()`, exit non-zero on bind/CA failure. tsc emits it into `dist/main.js`; if the package is ESM keep the emitted file directly node-runnable (check `packages/https-filter/package.json` `type` + tsconfig module — mirror whatever `system-daemon/dist/index.js` does since daemonManager already spawns that).
`packages/electron-app/webpack.main.config.cjs` — fifth entry `filterProxy: '../https-filter/dist/main.js'` (dist, not src — same tsconfig-rootDir reason as systemDaemon); add `filterProxy.cjs` to the `asarUnpack` glob in `forge.config.cjs`.
`packages/electron-app/src/filterProxyManager.ts` — mirrors `daemonManager.ts` exactly: `candidatePaths` (packaged `app.asar.unpacked/.webpack/main/filterProxy.cjs` first, dev `dist/main.js` fallbacks), `spawn(process.execPath, [entry], {env:{...process.env, ELECTRON_RUN_AS_NODE:'1', BM_*}})`, `detached`, stderr piped, `start()/stop()/getStatus()` where status = `fetch http://127.0.0.1:9293/v1/proxy/status` with a short timeout (reuse whatever HTTP idioms daemonManager uses). storeDir = `app.getPath('userData')/https-filter`; rulesPath = the compiled proxy-rules artifact path (see Task 4's compile wiring below — for Task 1, point at the existing compiled rules file location the hub already produces, or accept env override).
Tests: whatever harness daemonManager has — mirror it (path resolution, spawn failure message, status fetch parse).

## Task 2 — macOS natlook helper (C) + watchdog + build

`packages/https-filter/helper/macos/natlook-helper.c` (~450 lines, C11, no deps beyond system libs): bind `127.0.0.1:<helperPort>` (argv), accept, `DIOCNATLOOK` on `/dev/pf` for the ORIGINAL destination of the redirected socket (build `pfioc_natlook` from getpeername/getsockname — accepted socket's peer = client saddr/sport, local = pre-rdr dst recovered via lookup; fields in network order, AF_INET + AF_INET6), synthesize a PROXY-v2 STREAM header (signature `\r\n\r\n\0\r\nQUIT\n`, ver/cmd `0x21`, fam/proto AF_INET=0x11/AF_INET6=0x21, len, src/dst addrs+ports — src = client), connect `127.0.0.1:9294`, write header then splice both directions (poll(2) loop, half-close aware). Watchdog: every ~2s, connect 9294; on N consecutive failures `system("pfctl -a com.blockingmachine -F all")` → anchor gone → fail-open (rdr stops → connectivity restored); re-add only via the installer re-run (don't auto-reload — a flapping engine shouldn't oscillate rules). Structured stderr log lines (no payload content).
`packages/https-filter/helper/macos/build.sh` — `clang -O2 -Wall -Wextra -o natlook-helper natlook-helper.c`, output beside the source or `dist/helper/`; wired into `npm run build -w @blockingmachine/https-filter` as a darwin-gated prebuild (non-darwin skips).
Tests: pure-C seam is thin — put the PROXY-v2 emit + natlook-struct assembly in testable functions (compile a test binary `helper-test` in a `--test` mode or a separate `natlook-test.c` driving a loopback splice with a stubbed original-dst path — e.g. env override `BM_HELPER_TEST_DST=host:port` short-circuits the ioctl so the splice/PROXY-v2 path is exercisable without pf). Jest-side: `helper.test.ts` skips on non-darwin, builds via build.sh, runs the binary against two loopback listeners and asserts the PROXY-v2 header bytes + splice fidelity (binary garbage round-trips).

## Task 3 — pf anchor + installer/uninstaller (one admin prompt)

`packages/https-filter/helper/macos/pf.anchor` — the anchor fragment:
```
no rdr proto tcp user = _blockingmachine
rdr pass on en0 proto tcp from any to any port {80,443} -> 127.0.0.1 port <HELPERPORT>
```
`scripts/install-macos-capture.sh` (must run with admin rights; the app invokes it via `osascript -e 'do shell script "…" with administrator privileges'` — the repo's established consent convention): creates `_blockingmachine` user (`sysadminctl`/`dscl` — pick the script's idiom, idempotent), creates `/Users/Shared/Blockingmachine/https-filter/` (store dir, `0700`, owned `_blockingmachine`), writes the anchor to `/etc/pf.anchors/com.blockingmachine`, `pfctl -a com.blockingmachine -f <anchor>` + `pfctl -E`, installs two launchd plists into `/Library/LaunchDaemons/`: `com.blockingmachine.natlook.plist` (root, helperPort 9295, KeepAlive) and `com.blockingmachine.proxy.plist` (`UserName=_blockingmachine`, runs `node <path-to-filterProxy-bundle>` — resolve the installed bundle path; env `BM_STORE_DIR=/Users/Shared/Blockingmachine/https-filter`, `BM_DATA_PORT=9294`, `BM_CONTROL_PORT=9293`, KeepAlive).
`scripts/uninstall-macos-capture.sh` — `pfctl -a com.blockingmachine -F all`, `pfctl -d` only if pf wasn't enabled before (record prior state at install), bootout plists, remove anchor (keep store dir + user — document why: ledger/CA state survives reinstall).
Tests: script-structure test (assert plist content/anchor render from a template with test ports — generate-to-tmp then diff expected text), not a live run. Live leg ships as `scripts/macos-capture-rehearse.sh` — sudo-gated per repo convention (`dnsmasqDeployLive` idiom): installs, asserts `curl -x http://127.0.0.1:9294 https://…` (explicit mode) AND a transparent `curl https://example.com` still works (rdr→helper→splice→engine→upstream), asserts a blocked test domain 403s via transparent fetch, uninstalls, prints verdicts. NEVER auto-run — it needs the operator's password; mark in the script header.

## Task 4 — CA trust store ops (`core`) + consumers

`packages/core/src/caTrustStore.ts` — platform trust ops on a CA PEM, consumed by BOTH cli and electron (the shared dep both already have):
- `trustStatus(pem): Promise<'trusted'|'installed-untrusted'|'absent'|'unsupported'>` — darwin: `security find-certificate -a -c <name>` to find it, `security verify-cert -c <tmpfile>` / trust-settings inspection for state (verify-cert alone doesn't report user trust overrides — `security dump-trust-settings -d` for admin domain presence; keep the heuristic honest: absent | present).
- `install(pem): Promise<'installed'|'needs-admin'|'unsupported'>` — darwin `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db <tmp.pem>`; a non-interactive failure (`errSecAuthFailed`/`User interaction is not allowed`) returns `'needs-admin'` — the APP then offers the admin-prompt path (`osascript do shell script … with administrator privileges`), the CLI prints the sudo line.
- `remove(pem)` — `security remove-trusted-cert` / `delete-certificate` on the matching cert.
- win32/linux: return `'unsupported'` with a named TODO (P3) — do not half-implement.
- All spawns execFile-style, bounded timeouts, tmp files under os.tmpdir with 0600, no logging of cert material beyond the fingerprint.
CLI (`packages/cli/src/commands/CertCommand.ts` + cli.ts): `cert status` already prints posture; add `cert trust-check` (fetch PEM via `/v1/proxy/ca`, then `trustStatus`), `cert install`, `cert uninstall` — PEM fetch stays HTTP; trust op is local spawn via core.
Electron (`index.ts` IPC): `httpsfilter:ca-trust-status` / `httpsfilter:ca-install` / `httpsfilter:ca-uninstall` handlers calling the same core functions (the PEM comes from the manager's `/v1/proxy/ca` fetch).
Tests: jest with injected runner seam (execFile fake) for parsing/branch logic — never invoke real `security` in unit tests; a `BM_LIVE_KEYCHAIN=1`-style env gate (`BM_LIVE_TRUST=1`) gets a darwin round-trip test that installs then removes, skipped by default.

## Task 5 — Deploy Hub "HTTPS Filtering" pane + mobile status

`electron-app/src/components/HttpsFilterCard.tsx` — mirror `ProtectionCard`'s idiom: status pill (off / running / paused / degraded), enable toggle → `filterProxyManager.start()/stop()` via new `httpsfilter:*` IPC (`httpsfilter:start|stop|status|toggle-pause`), CA row (trust status + Install button → `httpsfilter:ca-install`), pins/bypass counts + `proxy pins`-equivalent list view (via `/v1/proxy/pins`), stats ribbon (flows terminated/tunneled/blocked, blockRate). Renderer calls go through `preload.ts` — extend the bridge exactly how the daemon's status already crosses it.
Wire into `App.tsx`/`deploy` where ProtectionCard sits; register IPC in `index.ts` beside the `daemon:*` handlers.
Mobile (`packages/mobile`): the spec says "daemon status surfaces in mobile remote like the DNS daemon does" — find the existing daemon-status fetch path and add the proxy status pill beside it (same control host, `:9293`). Read-only status only — no mutations from mobile this phase.
Tests: renderer component test if the suite has that idiom (check `__tests__`); IPC handler tests where existing daemon IPC tests live; mobile: mirror existing status-fetch tests.

## Sequencing

T1 ∥ T2+T3 (disjoint files) → T4 → T5 (needs T1's manager + IPC surface). T3's rehearsal script ships unrun — it requires the operator's password and a live pf; that's the dogfood gate.

## Carried-forward while P1 runs

- Flag 96 remains open (`thirdParty` needs a browser-side initiator).
- QUIC suppression mechanism decision lands in T3 (helper-side `block out proto udp to port 443` line in the anchor — cheap and correct per spec §10's leaning).
- Never: engine writes user's login keychain; pf anchor without `no rdr user = _blockingmachine`; auto-running the rehearsal; git-committing the owner's dirty-tree files.
