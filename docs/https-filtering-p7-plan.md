# HTTPS filtering — P7 implementation plan (system-proxy/PAC coverage layer)

Sibling to `https-filtering-p3-plan.md`/`p4-plan.md`; implements flag 123's owner decision of 2026-10-27 — **build the capture-free coverage layer**: write the OS system proxy (or a PAC URL pointing at the engine) so proxy-aware apps get CONNECT-based filtering with zero kernel surface, no service account, and no driver. Same conventions: task → review → fix → gate, separate commits, owner's dirty tree untouched (`git apply --cached` for files carrying foreign hunks), no agent trailers, one logical line per markdown block.

## Locked preconditions (verified in tree)

- The engine already speaks the client-facing transports this layer needs: CONNECT + plain-HTTP absolute-form on `:9294` (`packages/https-filter/src/proxy/filterProxy.ts`), and `GET /ca.pem` precedent for a read-only self-route on the data port (flag 129).
- The platform-primitive seam exists: `PlatformRunner`/`PlatformRunResult` in `packages/core/src/caTrustStore.ts` (`(file, args)` execFile-style, never a shell string; injected so unit tests never touch a real OS), with `needs-admin` outcome conventions the CA ops already keep.
- darwin writer semantics verified live on this machine 2026-10-27 against a non-primary service (`Tailscale`): `networksetup -setwebproxy/-setsecurewebproxy/-setautoproxyurl/-setproxybypassdomains` succeed **unprivileged** for an admin user (exit 0, state reads back changed), `-set*state <svc> off` reverts, and `-setproxybypassdomains … Empty` clears. The needs-admin mapping stays for non-admin accounts / policy-locked contexts — it is honest even when the common case succeeds without it.
- The consent + elevate conventions exist: `runShellAsAdmin` (`osascript … with administrator privileges`, the macOS auth sheet IS the consent UI, fired only on an explicit second click), `awaitingAdmin` strip in `HttpsFilterCard`, `needsAdmin` IPC field.
- The store already records posture by object key (`deployRefreshReports` precedent) and the `httpsFilter*` key family is established by flag 127.

## Platform design decisions (pinned so tasks don't re-litigate)

**Two modes, one engine target.** `manual` writes the OS HTTP+HTTPS proxy at `127.0.0.1:9294`; `pac` writes the OS auto-config URL at `http://127.0.0.1:9294/proxy.pac` — a new read-only self-route on the data listener, mirroring `isCaPemRequest` (origin-form and absolute-form to this listener's own authority), exempt from token/denylist like `/ca.pem`, deriving the `PROXY` authority from the request's Host header so a LAN-hub fetch emits the LAN address. The PAC body returns `PROXY <authority>; DIRECT` — the `; DIRECT` tail is the fail-open: a stopped engine degrades to direct connectivity instead of holding it hostage, which is exactly why PAC is the recommended mode and manual carries the honest warning.

**Snapshot-first reversion.** `applySystemProxy` reads full prior state before the first write and returns it; the caller persists `{applied, prior, at}`; `revertSystemProxy` re-reads current state and refuses (`skipped-foreign`) when it no longer matches `applied` — a user edit since our write means the OS settings are theirs again, and nothing we recorded may be reverted under them. darwin records per-service triples (`-getwebproxy`/`-getsecurewebproxy`/`-getautoproxyurl`/`-getproxybypassdomains`) so a service that appeared after our write is never touched; win32 records the four `Internet Settings` values including absent-before; linux records the six gsettings keys.

**Per-platform writers** — all spawns through the injected `platformRunner`, argv-shaped:

- win32: `reg query|add|delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` — `ProxyEnable`/`ProxyServer`/`ProxyOverride`/`AutoConfigURL`, per-user hive, no admin. Runner-mock verified only (this host is darwin) — named in the ledger.
- darwin: `networksetup` per enabled service from `-listallnetworkservices` (asterisk-marked disabled lines skipped). Manual writes web+secure+bypass; PAC writes autoproxyurl. Verified unprivileged on this host; `needs-admin` still maps authorization-worded failures and the darwin elevate path batches the whole write plan through one `runShellAsAdmin` call (one auth sheet, not N).
- linux: `gsettings list-recursively org.gnome.system.proxy` (+`.http`+`.https` children) / `gsettings set` — `mode 'manual'|'auto'`, per-protocol host/port, `ignore-hosts`, `autoconfig-url`. Tool-missing or `No such schema` → `unsupported`. nmcli carries no proxy surface (verified: `nmcli connection` has no proxy keys) — gsettings is the only linux writer; KDE's kwriteconfig is a named gap, not silently skipped.

**Engine integration.** `httpsfilter:stop` reverts a recorded `manual` write BEFORE stopping the engine — a manual system proxy aimed at a dead :9294 would hold proxy-aware apps' connectivity, and fail-safe is the design non-negotiable. `pac` records persist across stop by design (the `; DIRECT` tail absorbs the gap).

## Task 1 — core writers (`packages/core/src/systemProxy.ts`)

`SystemProxyConfig` (`{mode:'manual'|'pac', host?, port?, pacUrl?}`), `SystemProxyState` (platform-tagged JSON-serializable union — persisted verbatim in the store), `readSystemProxyState` / `planSystemProxyApply` / `planSystemProxyRevert` (pure argv plans — the darwin elevate path renders them into one shell line) / `applySystemProxy` / `revertSystemProxy` / `stateMatchesConfig` / `summarizeSystemProxyState` / `normalizeSystemProxyState`. `defaultPlatformRunner` gains an export in `caTrustStore.ts` so the seam is shared, not duplicated. Tests: `systemProxy.test.ts` — recording-runner argv pins per platform, prior-state snapshot shape, revert-only-own-writes (`skipped-foreign` on drifted state), absent-before value deletion on win32 revert, needs-admin mapping, unsupported platforms spawn nothing.

## Task 2 — the PAC self-route (`packages/https-filter/src/proxy/filterProxy.ts`)

`GET /proxy.pac` beside `/ca.pem`: same accept grammar, `application/x-ns-proxy-autoconfig` body — `FindProxyForURL` returning `DIRECT` for plain names / `localhost` / `*.local` / loopback+RFC1918+link-local literal ranges, else `PROXY <authority>; DIRECT` with `<authority>` from the request Host header (the bound host:port when absent). Tests in `filterProxy.auth.test.ts` — served unauthenticated like `/ca.pem`, absolute-form to self served, foreign authority proxied not answered, body carries the request's authority and the DIRECT fallback.

## Task 3 — IPC + store + elevate (`packages/electron-app/src/index.ts`, `preload.ts`, `types/index.d.ts`)

Store key `httpsFilterSystemProxy` (`{applied, prior, at}`). Handlers: `httpsfilter:system-proxy-status` (state + record + drift flag), `httpsfilter:system-proxy-apply` (mode + `{elevate}` — refuses while the engine is stopped: a proxy pointed at a dead port is a connectivity bug, not a config), `httpsfilter:system-proxy-revert`. darwin `elevate` renders `planSystemProxy*` through one `runShellAsAdmin` — the auth sheet fires only on the renderer's explicit second click, the ca-install convention verbatim. `httpsfilter:stop` reverts a recorded manual write first and names it in the reply.

## Task 4 — card surface (`HttpsFilterCard.tsx`)

"System proxy" row under the CA row: pill (on/off/unsupported/needs-admin), mode pick in the consent strip (PAC preselected — the strip names exactly what will be written before any OS write), per-state detail lines, disable=revert. Coverage labels stay honest everywhere this row describes the layer: **"proxy-aware apps only — apps that ignore the system proxy bypass by design."** Under an installed capture service the row reads as the lighter capture-free layer, not redundant-with-capture. Polls on mount + after actions + the CA cadence — networksetup probes are subprocess weight, same as `security`.

## Task 5 — ledger + docs

`known-issues.md` flag 123 → `closed-issues.md` in numeric position with `**Where (original entry):**` + original bullets preserved and real test names in `**Verified:**`. `docs/https-filtering-design.md` §9 extension-point line updated — the PAC/system-proxy layer is no longer unbuilt (and its sketch's "PAC file off the feed server" is subsumed by the data-port self-route). Honesty bounds recorded: win32/linux writers verified by runner-mock only.

## Explicit non-goals

- WPAD/dhcp PAC discovery (wpad.dat advertisement) — a separate, hostile-shaped surface.
- KDE (`kwriteconfig`) and non-GNOME linux desktops — probed, named gaps; honest `unsupported`.
- Auto-clearing the OS proxy on app quit/uninstall beyond the recorded-record semantics — reversion restores exactly what was written, when asked or when stop demands it (manual mode).
- Forcing non-proxy-aware apps through the engine — that is capture's job and the card says so.
