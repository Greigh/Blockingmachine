# HTTPS Filtering Engine — Design

**Status:** Approved direction (Approach A), pre-implementation. **Date:** 2026-10-26. **Scope:** System-wide HTTPS ad/tracker filtering inside apps — the capability AdGuard desktop holds as its moat — built as one shared TypeScript engine plus thin per-platform capture adapters.

## 1. Purpose & positioning

Blockingmachine already blocks ads at DNS level (daemon, router exports) and inside browsers (MV3 extension). What it cannot do today is see *inside* an app's TLS connection — which is why ads in Spotify, Discord, or an in-app webview sail through. AdGuard's desktop apps solve this with a local MITM proxy: a per-device root CA, forged leaf certificates, TLS termination, then AdGuard-syntax filtering applied to decrypted HTTP. This design ships the same capability, plus the things the rest of this repo already does better — the same verdicts the daemon, extension, mobile app, and `/v1/check` all agree on, AI-radar quarantine feeding the same block path, and LAN-hub deployment no AdGuard product offers.

Non-negotiables carried over from the repo's posture: 100% local processing, no telemetry of decrypted content (pin/bypass stores hold hostnames only — same field-pinned-by-test convention as `docs/learned-shadow-privacy.md`), and fail-safe behavior — a broken proxy must never take the user's connectivity down.

## 2. Platform reality

| Platform | Capture | Cert trust | Verdict |
| --- | --- | --- | --- |
| macOS | `pf` rdr rules (v1) → `NETransparentProxyProvider` system extension (v2, entitlement-gated) | `security add-trusted-cert` (admin prompt) | Full MITM |
| Windows | WinDivert redirector (vendored signed driver) | `certutil -addstore Root` / `Import-Certificate` (admin) | Full MITM |
| Linux | nftables/iptables REDIRECT or TPROXY (CAP_NET_ADMIN) | `update-ca-certificates` / `trust anchor` (root) | Full MITM |
| Android | `VpnService` tun (already built — `VpnFilterService`) + TCP reassembly | User CA store; API 24+ apps ignore it unless opted in | SNI + CONNECT filtering everywhere; full MITM only for cert-honoring apps |
| iOS | `NEDNSProxyProvider` (exists, entitlement pending — flag 89) | Apple exposes no TLS-intercept API | DNS + content-blocking only. AdGuard has the same ceiling. |

Three hard walls apply everywhere and are design inputs, not bugs: **certificate pinning** (apps that pin refuse forged certs — detected on handshake abort → auto-bypass), **QUIC/HTTP3** (UDP 443 is invisible to TCP capture — suppressed so traffic falls back to TCP), and **ECH** (Encrypted ClientHello hides SNI — detected → passthrough unless a DNS-derived verdict already exists).

## 3. Architecture

One new workspace — `packages/https-filter` (`@blockingmachine/https-filter`) — contains the whole MITM engine in TypeScript. It ships as a fourth webpack bundle (`filterProxy.cjs`), `asarUnpack`'d and spawned by `daemonManager` under `ELECTRON_RUN_AS_NODE`, byte-for-byte the pattern `systemDaemon.cjs` already uses. All per-platform divergence lives in small privileged capture helpers whose only job is getting TCP flows to the engine's loopback listener while telling it where each flow was originally headed — spoken as a HAProxy PROXY-protocol v2 header, so the engine needs exactly one parser for all platforms.

```
app traffic ──► capture adapter (privileged helper) ──► 127.0.0.1:9294  (+PROXY v2 header: original dst)
                                                              │
                                                              ▼
                                                   SNI observe (ClientHello peek)
                                                        │              │
                                              bypass/pinned│              │trusted
                                                        ▼              ▼
                                                  blind tunnel    forge leaf cert (SNI SAN)
                                                  to original dst terminate TLS downstream
                                                                       │
                                                                       ▼
                                                            HTTP/1.1 + HTTP/2 parse
                                                                       │
                                              request: core URL evaluator → $removeparam → $removeheader
                                                                       │
                                                            upstream tls.connect (SNI, ALPN, real chain verify)
                                                                       │
                                              response: content-type block → HTML cosmetic/scriptlet inject (+CSP rewrite)
                                                                       │
                                                                       ▼
                                                                    client
```

Loop prevention: the engine's own egress must escape capture — the helpers exempt it by running the proxy under a dedicated identity (`_blockingmachine` user on macOS/Linux so `no rdr`/`socket` rules match; filtering by helper-bound source port range on Windows where user matching is unavailable).

## 4. Reuse contract

Per owner directive, existing packages are consumed, not duplicated:

| Need | Existing code | Use |
| --- | --- | --- |
| Rule parse/store/dedup | `@blockingmachine/core` — `RuleStore`, `RuleProcessor`, `RuleDeduplicator`, `filterBrowserRules`/`filterDNSRules` boundary | Engine consumes the compiled rule store directly — proxy rules are browser-surface rules, so `filterBrowserRules` is the boundary already honored |
| Request verdicts | `@blockingmachine/core` — **new** `evaluateRequest(url, ctx)` (see §5.4) | One evaluator; mobile `matcher.ts` parity-tests against it, extension and proxy share verdict semantics with `/v1/check` |
| Cosmetic/scriptlet rules | `browser-extension/src/shared/cosmeticRules.ts`, `content/selectorEngine.ts`, `content/cosmeticHider.ts` | Extracted into `core/src/cosmetic/` — extension re-imports from core (no fork); proxy injects the compiled output into HTML streams |
| `$removeparam`/`$removeheader` semantics | `browser-extension/src/background/dnrManager.ts` | Modifier handling moves into the core evaluator; dnrManager keeps emitting DNR JSON for Chrome |
| Domain/SNI verdicts | `system-daemon/src/engine/domainTrie.ts` | The proxy imports `DomainTrie` from core side (moved or shared, no re-implementation) for host-level allow/block/pin checks |
| Process supervision | `electron-app/src/daemonManager.ts` + `system-daemon/src/service/serviceConfig.ts` launchd/systemd generators | `filterProxyManager` mirrors daemonManager; privileged helpers install via the same plist/unit generators |
| Telemetry/observability | `system-daemon/src/server/observationRecorder.ts`, circular stats buffer, `/v1/stats` | Proxy stats feed the same Deploy Hub ribbon and `/v1/events` SSE stream |
| Quarantine | `/ai-threats.txt` feed + quarantine ledger | Quarantined hosts enter the proxy block path identically to DNS |
| Cert/key cryptography | `vendor/node-forge@1.4.1` (already vendored, audited) | CA generation + leaf signing — no new dependency |
| Audit/history | `blockingmachine-database` JSONL conventions | Pinned-host store, bypass lists, proxy event ledger |
| CLI surface | `packages/cli/src/commands/BaseCommand.ts` | New `ProxyCommand` + `CertCommand` (`proxy status/toggle`, `cert install/check`) reuse the command pattern |
| Mobile capture | `modules/local-vpn` `VpnFilterService` (tun) + `PacProxyService` (CONNECT :8890) + `Blocklist` native matcher | Extended, not replaced: TCP stream reassembly added to the tun path; verdicts still come from the shared ruleset sync |

## 5. Components

### 5.1 `ca/` — certificate authority

Per-device root CA (RSA-2048, 10-year, `cA:TRUE`, pathlen:0) generated on first enable — never shipped, never leaves the device. RSA over ECDSA because the pinned signing primitive is the vendored `node-forge`, whose x509 EC-signing path is the fragile side. Private key stored encrypted at rest (`AES-256-GCM` under an OS-provided key where available: Keychain-wrapped on macOS, DPAPI on Windows, 0600 file + Secret Service attempt on Linux); the certificate alone goes to the system trust store via the platform's real consent prompt. Leaf forge: on trusted SNI, mint a leaf (SAN from SNI, 30-day validity, `serverAuth` EKU) signed by the CA, cached in an LRU. Regenerate-and-revoke is a first-class control action (`/v1/proxy/ca` POST rotate). A test asserts the CA key file is never world-readable and never included in any telemetry/export artifact.

### 5.2 `proxy/` — listeners

Three modes on loopback `:9294`: **explicit CONNECT** (standard forward-proxy; exists from P0 so everything is testable without privileges — also the LAN-hub mode where phones/other devices point at the desktop, something no AdGuard product does), **transparent** (accepts helper-spliced flows, reads PROXY v2 header for original destination), and **sni-passthrough** (peeks at ClientHello, applies domain verdict, blind-tunnels). The transparent listener must recover original destination from the PROXY header — never from `getsockopt(SO_ORIGINAL_DST)` in-process (keeps the engine dependency-free; each helper emits the header instead).

### 5.3 `tls/` — termination and upstream

`tls.TLSServer` + `SNICallback` selects the forged leaf `SecureContext`. Upstream `tls.connect` with SNI forwarded, ALPN `h2`/`http/1.1` negotiated per client, and **mandatory full chain verification against the platform trust store** — fail closed, no bypass flag, a MITM that skips upstream verification is a vulnerability. Client-side abort during handshake (the pinning signal) is recorded and the host auto-enrolls in the pin-bypass store. Non-HTTP TLS (MQTT-over-TLS, database wire protocols, etc.) detected after handshake → auto-demotes that host to sni-passthrough permanently.

### 5.4 `evaluateRequest` — new core component (the identified gap)

`core` today has no runtime URL evaluator: the extension compiles to Chrome DNR (the browser does the matching) and the mobile matcher is a host-only subset. The proxy needs `evaluateRequest(url: string, ctx: {thirdParty, method, contentType}) → {verdict, coveringRule, modifiers: {removeparam[], removeheader[], redirect, csp}}` in `core/src/evaluateRequest.ts`, handling the full ABP/AdGuard request-rule surface the repo's sources actually contain: `||domain^` host rules, path/pattern rules, `@@` exceptions, `$important` precedence, `third-party`, `$removeparam`, `$removeheader`, `$csp`. This is the same semantics `/v1/check` reports, lifted to URL level; the mobile matcher's parity harness becomes the model for a parity suite between evaluator and DNR-compiled output.

### 5.5 `pipeline/` — the filter chain

Ordered, streaming, bounded:

1. **Request verdict** — `evaluateRequest`; block → synthetic response (per AdGuard convention: empty `200` for documents is wrong — `403`/empty by content-type expectation, `502`-style stub never used).
2. **`$removeparam`** — strip listed query params before upstream.
3. **`$removeheader` / UA-Client-Hints strip** — header mutation on the forwarded request.
4. **Upstream fetch** — streamed, never buffered unboundedly.
5. **Response content-type block** — drop responses matching block verdicts by `content-type`/size signature (the "all + response blocking" scope item).
6. **HTML injection** — for `text/html` under a size cap: inject compiled cosmetic CSS + scriptlet payload at `<head>`, **and rewrite the response's CSP** (`Content-Security-Policy` + report-only) to admit the injected payload — the same CSP concession AdGuard makes; recorded in the proxy event ledger, user-visible in the UI, and never silent.

Anything outside `text/html` or over the cap streams untouched. `content-encoding` handled by decoding `gzip`/`br`/`zstd` when mutating a body (and only then — pass-through otherwise), re-encoding on output.

### 5.6 `policy/` — trust decisions

Persisted JSONL stores (audit convention): `bypass.hosts` (user), `bypass.apps` (per-process where capture reports it), `pins.learned` (auto-enrolled on handshake abort — restorable, shown in UI like the Radar's ignored-offenders pattern), `pins.static` (shipped seed list: known pinners — OS updaters, banking-adjacent, `*.apple.com` account flows). `@@` exceptions from the rule store win at every layer. Default policy: MITM enabled for all processes except the shipped bypass seed and the pin store — matching the "Full MITM + selective" decision.

### 5.7 `control/` — API surface

Same `/v1/*` vocabulary on its own port (`:9293`, next to daemon `:9292`): `GET /v1/proxy/status|stats`, `POST /v1/proxy/toggle`, `POST /v1/proxy/reload` (new ruleset), `GET|POST /v1/proxy/ca` (status | rotate), `GET /v1/proxy/pins` (list) + `POST /v1/proxy/pins/{restore,remove}`, `GET /v1/proxy/bypass` + mutations. Emits `proxy_` events onto the existing `/v1/events` SSE so mobile and the dashboard watch it like the daemon.

### 5.8 Capture helpers (the only platform code)

- **macOS** — `com.blockingmachine.proxy` launchd daemon running as dedicated user `_blockingmachine`. It owns two jobs: it writes a `pf` anchor (`rdr pass on <iface> proto tcp to any port {80,443} -> 127.0.0.1 port <helperPort>`, `no rdr … user _blockingmachine` so the engine's own egress escapes) and `pfctl -E`s it; and because `rdr` puts no helper in the data path, the helper itself is the acceptor — it accepts each redirected flow on `<helperPort>`, resolves the original destination through the pf NAT-lookup ioctl (`DIOCNATLOOK`), stamps the PROXY v2 header, and splices the flow to the engine on `127.0.0.1:9294`. Rules unload on exit/stop. Installed through the existing launchd generator; enable requires an admin prompt once.
- **Windows** — vendored signed WinDivert driver + a small redirector helper (the repo's one non-TS component, `native/windivert-redirect/`, built in CI): diverts outbound TCP/443|80 to the loopback listener, stamps PROXY headers. `certutil`/`Import-Certificate` for the CA.
- **Linux** — nftables `tproxy`/`redirect` table + a tiny original-dst helper speaking the same PROXY v2 contract (CAP_NET_ADMIN via the existing systemd generator, `AmbientCapabilities`). 
- **Android** — shipped (P4): `VpnFilterService` gained the userspace TCP core (`modules/local-vpn/.../tcp/` — `Packet`/`TcpSession`/`TcpDispatcher`) that reassembles TCP :80/:443 flows out of the tun fd and splices each onto a `protect()`ed socket to the LAN hub's data listener (`<hub>:9294`, PROXY-v2 carrying the app's source and the packet's original destination — the phone is byte-dumb, the hub engine owns every verdict). UDP/443 is drop-counted so QUIC falls back into the TCP path; `PacProxyService` CONNECT path stays. MITM for cert-honoring apps only (§2); everything else gets SNI verdicts — already better than today.
- **iOS** — explicitly out of scope (§2); the NEDNSProxy entitlement work (flag 89) continues on the DNS path only.

### 5.9 UI surfaces

Deploy Hub gains a **HTTPS Filtering** pane beside Local System DNS: status pill, CA-install walkthrough per platform (with honest per-OS consent copy), bypass/pin list management mirroring the Radar's offenders UI (list → hide/restore), stats ribbon reusing the daemon card pattern. Mobile remote surfaces `proxy` status exactly like `daemon` status today. Settings → Privacy gains the "proxy stores hostnames only, never bodies" disclosure wired to the privacy-doc convention.

## 6. Data flow

Compile path is untouched upstream of one new artifact: `runImportProcess` → rules → `generateFilterList` gains a `proxy-rules` emission (full request rules + modifiers + compiled cosmetic payload — the browser-surface set, honoring `filterBrowserRules`) → written beside `/dns.txt` → `POST /v1/proxy/reload` fires with the existing daemon reload. `filterBrowserRules`/`filterDNSRules` stay the hard boundary: the proxy never sees a DNS directive, the daemon never sees a URL rule. Runtime: capture → SNI verdict via `DomainTrie` → terminate → `evaluateRequest` per request → transforms → upstream → response transforms → client. Verdicts and counts land in the circular stats buffer; `proxy_event` entries (block, pin-learned, csp-rewrite) go to the JSONL ledger only — hostnames and rule IDs, never bodies, headers, or paths.

## 7. Error handling & safety policy

| Failure | Behavior |
| --- | --- |
| Upstream cert invalid/expired | Fail closed — block page equivalent (empty error matching expectation), counted, never tunneled-through silently |
| Client aborts forged handshake (pinning) | Host auto-enrolls to `pins.learned`, blind-tunnels from then on; entry visible/restorable in UI |
| Engine crashes/exits | Capture helpers unload redirect rules on watchdog loss — connectivity is never held hostage to the filter |
| CA key unreadable/corrupt | Proxy refuses to start, explicit UI error, regenerate offered — never silently falls back to passthrough-all |
| Non-HTML/oversized body | Streams untouched; no buffering DoS on the proxy itself |
| Trust-store write denied | Feature stays off with actionable error; DNS blocking unaffected |

## 8. Testing

- **Unit** — leaf forge correctness (SAN chains, cache), `evaluateRequest` against the same corpus the DNR compiler tests use, `$removeparam`/`$removeheader` semantics, HTML injector fixtures (injection point selection, charset, chunked bodies), CSP rewriter, PROXY v2 parser, pin-store transitions.
- **Integration (CI-safe)** — local HTTPS origin + client through explicit CONNECT mode: real forged-cert handshake, real upstream verify, verdict/block/inject end-to-end. No privileges, runs everywhere the suite does.
- **Live rehearsals** (repo convention, all skip-gated): pf leg on this Mac (sudo-gated like `dnsmasqDeployLive.test.ts`), Android emulator VpnService+SNI pass (existing rig from flag 73), Linux TPROXY in docker (`--cap-add NET_ADMIN`, same convention as `openwrt-live.sh`), Windows leg stays a named manual pass on real hardware.
- **Security suite** — upstream verification cannot be disabled by config; CA key perms asserted; no leaf reuse across CA rotation; pin store tamper-evidence (JSONL hash-chain per audit conventions); injected-payload provenance (only compiled rules, never remote content).

## 9. Phasing

- **P0 — engine core:** `https-filter` package, CA/forge, CONNECT + sni-passthrough listeners, `evaluateRequest` in core, request pipeline (verdict/params/headers), `/v1/proxy/*`, `ProxyCommand`/`CertCommand` in CLI. Zero privileges, fully tested.
- **P1 — macOS:** pf helper, CA trust install, Deploy Hub pane, dogfood on this machine.
- **P2 — content depth:** response content-type blocking, HTML cosmetic injection + CSP rewrite, pin UI polish.
- **P3 — Windows + Linux:** WinDivert redirector + nftables helper, cert install flows, packaging into `publish.yml`.
- **P4 — Android:** shipped. VpnService TCP reassembly → SNI everywhere; MITM through the hub engine for cert-honoring apps — the phone splices reassembled flows to `<hub-ip>:9294` (PROXY-v2) rather than running a local listener, so all verdict logic stays in the engine (thin-adapter architecture, same as natlook-helper). Engine-side posture: `BM_BIND_HOST=<lan-ip>` puts the data listener on the LAN — the `/v1/proxy/*` control API is loopback by construction and cannot follow it.
- **P5 — macOS NE upgrade:** `NETransparentProxyProvider` system extension replacing pf once the `networkextension` transparent-proxy entitlement clears (one request covers it and flag 89's dns-proxy). Scaffold shipped at `packages/https-filter/helper/macos-ne/TransparentProxyProvider.swift` — `handleNewFlow` gets the original destination from `flow.remoteEndpoint` (no ioctl), emits the same PROXY-v2 contract, and NE's bundle-ID exclusion rules retire the `_blockingmachine` service user entirely. Entitlement request is owner-action; tracked as flag 131.
- **Extension point (post-P3) — realized as a posture in P4:** LAN hub mode exists today — `BM_BIND_HOST=<lan-ip>` binds the data listener to the network and the Android VpnService capture is its first client (opted-in devices splice TCP :80/:443 to it). Still unbuilt from the original sketch: advertising the listener to other devices (PAC file off the feed server), and any authentication on the data port — it is unauthenticated by design, trusted-LAN only (flags `hub-lan-auth-posture`, `mobile-hub-ca-over-plain-lan`).

## 10. Open decisions recorded

- Vendored `node-forge` is the signing primitive — consistent with the vendored-deps posture; revisit only if upstream ships a real patched release (AGENTS.md maintenance contract).
- A privileged helper per desktop platform is unavoidable for transparent capture — kept minimal, rootless where possible (dedicated user, not root, on macOS/Linux; the Windows redirector needs admin to install the driver, not to run it).
- Android full-MITM coverage is bounded by platform cert trust (§2) — stated honestly rather than promised.
- The `/v1/proxy/*` control API is loopback by construction (P4): `startControlServer` refuses a non-loopback bind (`isLoopbackBindHost`), and env exposes it only as `BM_CONTROL_BIND_HOST` for loopback-family variation — a LAN-bound data listener can never drag the unauthenticated mutation surface onto the network.
- QUIC suppression mechanism (block UDP/443 in the capture helper vs. `Alt-Svc`/quic hint stripping) is decided at P1 implementation time — both work, helper-side blocking is cleaner.
- ECH handling: passthrough for unknown ECH hosts at v1; DNS-observed verdicts still apply where the query was seen.
