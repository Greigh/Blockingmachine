# Pass 3 — Remaining Risks

Everything Pass 3 could not fully verify, chose not to change, or verified only in
part — with the evidence basis for each. None of these are regressions from the
remediation work; they are the honest edges of the verification surface.

---

## 2026-10-10 — Pass 4: LAN API / AI connectivity / pairing hardening

Follow-up deepening the four lanes above plus the pairing lane, per the hardening
brief. Detail lives in `LAN_SECURITY_REVIEW.md`, `AI_CONNECTION_SECURITY.md`,
`PAIRING_SECURITY_REVIEW.md`; architectural options in `SECURITY_DECISIONS.md`.

### RESOLVED — unguarded telemetry reads (new finding, **MEDIUM**)

`/v1/status`, `/v1/telemetry` and `/v1/check` answered any origin — and with the
blanket `Access-Control-Allow-Origin: *`, *any web page in any browser* could
fetch `recentTrackers` (last-50 browsing-derived tracker domains), LAN addressing
and quarantine contents. `/v1/events` was already guarded, so this was an
inconsistency, not a stated design. **Fix**: all telemetry-bearing reads now
share `rejectUnauthorisedRead` (origin guard + bearer when a token is
configured). Feed `.txt` routes stay open — they are the product's public output.
Mobile (bearer on every request), HA (bearer), extension (extension origin)
verified unaffected.

### RESOLVED — unbounded AI response bodies (**MEDIUM**)

Every provider path (`test-ai-connection` + `AiDetectorService`; Ollama, Gemini,
OpenAI-compat) called `res.json()` unbounded — a hostile/misbehaving endpoint
could pin main-process memory before the 50×120 name bound ever applied.
**Fix**: `readBoundedJson` (chunked, byte-ceilinged, fails pre-parse) on all AI
JSON reads; `isSafeLanEndpointUrl` rejects link-local/metadata/unspecified/
multicast/reserved destinations while keeping loopback + RFC1918 + public;
`redirect:'manual'` so a 3xx can never re-aim an Authorization-bearing request at
another origin. Timeouts verified behaviorally (hung-server abort).

### RESOLVED — poisoned-store `savePath` in `/v1/status` (LOW-MEDIUM)

Unguarded `dirname(savePath)` — a non-string persisted value threw TypeError in
the request handler (hang/unhandled rejection), the same hazard the adjacent
`outputDir` guard already documented. Fixed symmetrically.

### RESOLVED — feed-token generation hygiene (LOW-MEDIUM → hardened)

No CSPRNG path existed and `'1234'` was a valid token. **Fix**:
`generate-feed-token` IPC (192-bit `randomBytes`, sealed at rest, shown once in
Settings + embedded in the pairing QR) and a 16-char floor on user-typed tokens —
writes only, existing stored tokens untouched, nothing already paired breaks.
Behavioral test covers generate→seal→QR→real-HTTP-auth end-to-end.

### Still accepted / needs owner decision — now enumerated in `SECURITY_DECISIONS.md`

- **D-1** tokenless no-Origin LAN mutations (the standing MEDIUM residual —
  browser vectors closed, native LAN actors remain; mandatory/auto-generated
  token proposed for *new installs only*).
- **D-3** no loopback-only listen mode (additive proposal).
- **D-4** one shared token for all clients (per-device pairing proposal —
  protocol extension, requires mobile coordination).
- **D-5** plaintext secret fallback when `safeStorage` is unavailable.
- **D-6** AI endpoints allow loopback+LAN+public by design; hostname targets
  (`gpu-box.lan`) resolve without the filter-fetch pinning — theoretical
  rebind-into-link-local residual accepted under the LAN threat model.

### Pass-4 unverified

- HTTPS certificate path against a live TLS AI endpoint (self-signed LAN HTTPS
  will fail handshake by design).
- Windows/Linux packaged runtime; packaged UI smoke — macOS-only host.
- Real-network DNS (`dns.lookup` patched, same binding node's connect calls).

---

## 2026-10-10 — Security follow-up pass: items 1–3 remediated, item re-rating

The four items below were reviewed against live behavior (real HTTP, patched DNS,
real IPC handlers), independently re-rated, and corrected where a non-breaking
fix existed. Historical assessments above are preserved for context.

### RESOLVED — item 2 `.local` origin trust (re-rated **MEDIUM-HIGH**, was low-medium/design)

The prior note understated this: `*.local` is not merely "claimable in theory" — it
is claimable by **any device on the LAN** (mDNS has no admission control), and the
guarded set includes `POST /v1/control/daemon {"action":"stop"}` and
`POST /v1/protection`, which **disable DNS protection network-wide**. With no
`feedToken` configured — the default — a page served from `rogue-printer.local`
and merely *opened* in the victim's browser could turn the product off: a
no-credential, cross-network protection-bypass primitive, not a config nuisance.

**Reproduced behaviorally** (`ipcBehavioral.test.ts`): pre-fix, a POST carrying
`Origin: http://evil-printer.local` reached the daemon-control handler and
`GET /v1/events` streamed live telemetry to `rogue-mdns.local`.

**Fix**: `.local` removed from `isSafeClientOrigin` (`index.ts` ~2680). Verified
no documented consumer uses a `.local` Origin — browser extensions carry
`chrome-extension:`/`moz-extension:`, mobile/RN sends no Origin, the HA
integration is server-side, and the renderer never fetches the feed server
(grep-verified). Loopback, extension-scheme, and no-Origin clients are
regression-tested still-open.

### RESOLVED — item 1 DNS rebinding (re-rated **MEDIUM**, was "documented limit")

A public-looking filter-source URL whose DNS answers private addresses passed
the lexical-only guard and fetched from loopback/metadata/LAN services — an
SSRF whose response body is then parsed into the blocklist (read primitive +
integrity pollution). Triggered unauthenticated on every source refresh once a
bad URL is configured.

**Reproduced behaviorally** (`fetch-dns-rebinding.test.ts`): `dns.lookup` patched
so `rebind.public.example` answers `127.0.0.1`; pre-fix the fetch connected to a
local HTTP server and returned its body.

**Fix**: resolver-pinned agents in `core/src/fetch.ts` — `dns.lookup(all)` inside
the connection, every answer filtered through the same `isSafePublicWebUrl`
range policy, connect only to a survivor; the checked address *is* the dialed
address. `EBM_PRIVATE_NET_BLOCK` short-circuits to 403 without retries.
`allowPrivateNetworks` (LAN feeds, sinkhole deploys) keeps the platform
resolver — regression-tested still-working.

### RESOLVED — item 3 plaintext AI key over IPC (re-rated **MEDIUM**, was "accepted design")

`get-ai-config` returned the plaintext key: one IPC call to steal it on any
renderer compromise. Additionally the audit under-noted that
`ai-scan-domain`/`ai-scan-querylog`/`ai-crawl-url` spread `overrideConfig` over
the stored config — a renderer-supplied `apiEndpoint` alone would have sent the
**stored** key to a renderer-named host; `test-ai-connection` had the same
renderer-endpoint + stored-key combination. Exfil was independent of the read.

**Fix** (write-only credential protocol, all in `index.ts`):
- `get-ai-config` returns `apiKey:''` + `apiKeySet`/`apiKeyHint` (last-4).
- `set-ai-config` treats empty `apiKey` as "keep stored" (round-trip safe).
- `test-ai-connection` falls back to the stored key **and** the stored endpoint —
  a renderer-named endpoint only applies to a renderer-supplied key (paired).
- New `mergeAiOverride` sanitizes scan overrides and applies `apiEndpoint` only
  when `apiKey` accompanies it; all three scan handlers use it. The renderer
  never passes overrides (grep-verified), so this is non-breaking.
- Settings/AIRadarView key fields now display "Configured (hint) — enter to
  replace"; keys are typed in, never displayed back.

**Reproduced behaviorally**: masked-read/keep-on-empty round-trip tests plus a
`fetch` spy proving the stored key answers only at its paired endpoint.

### RESOLVED — concurrent atomic feed writes (new, this pass)

Pass 3 fixed same-ms tmp-name collisions but left an ordering race: fire-and-forget
persists on every `aiThreatQuarantine` change could rename out of order, leaving an
**older** snapshot as the final `threats.txt` — the file dnsmasq serves and the
daemon reloads after the app exits. Silent (errors are swallowed by design).

**Fix**: per-path promise chaining inside `writeFileAtomic` — every same-path
write queues behind the previous, so the last logical write is the last physical
one. Applies to all callers (threats snapshot, compile outputs, feed files).

**Reproduced behaviorally**: 40 rapid quarantine adds → 40 queued persists →
final file contains all 40 domains, zero `.tmp-*` debris.

### Still accepted / needs owner decision (not changed)

- **No-Origin LAN mutations when `feedToken` is unset** — raw socket clients
  (curl, mobile RN, HA integration, dnsmasq pullers) send no Origin and pass by
  design; a hostile process *on the LAN* can equally post mutations. Browser
  drive-bys are closed (item above); this residual is a LAN-execution exposure
  only, re-rated **MEDIUM**. Making the token mandatory or auto-generating one at
  first boot breaks existing unpaired/legacy clients — **architectural approval
  required**; recommend an owner decision before release.
- Item 4 `test-ai-connection` LAN fetching — purpose-built for LAN endpoints;
  bounded echo stands. Item 5 pairing-QR token — by design.
- `localhost`-origin pages retain mutation rights — a deliberately-visited local
  page is locally-executed trust, unlike mDNS-claimable `.local`.

### Unverified in this pass

- Windows/Linux packaged apps — only macOS is testable here (unchanged from
  Pass 3).
- Real-network rebinding (behavioral proof used patched `dns.lookup`, the same
  binding node's connect path calls; `/etc/resolv` resolution unexercised).
- The HTTPS agent path — `publicOnlyAgents.https` shares the identical lookup;
  exercised structurally, not against a live TLS server.
- A hypothetical `.local`-origin browser tool — none is documented; if one
  exists it now gets 403 and needs a loopback/extension origin or a feedToken.

**Regression**: `lint` ✓ `build` ✓ `type-check` ✓ · core 1330/1330 ·
electron-app 795/815 (20 env-gated skips) · cli 88/89 · system-daemon 35/35 ·
browser-extension 809/810 · homeassistant-addon green. No deploy/publish run.

---

## Accepted trust-boundary limits (unchanged, documented)

1. **DNS rebinding on outbound fetches** — `isSafePublicWebUrl` validates the URL
   string only; a public hostname resolving to a private IP passes
   (`fetch.ts` ~323, `urlSafety.ts` ~55 documents the limit itself). Closing this
   needs a resolver-pinned HTTP agent — connect to the validated IP with SNI/Host
   pinned to the hostname. Architectural change; deferred, requires owner decision.
   *Exposure*: a malicious/mutating DNS answer could turn a "public" filter-source
   fetch into a LAN-internal request (read-only into the parser, no credentials
   attached — worst case is fetched content from an internal endpoint parsed as a
   blocklist).

2. **`.local` origin trust on the LAN feed API** — `isSafeClientOrigin`
   (`index.ts` ~2680) accepts any `*.local` origin for mutations when no feedToken
   is configured (and curl-style no-Origin requests always pass — intentional for
   local tooling). A `.local` name is claimable by any mDNS advertiser; a
   drive-by page on a rogue LAN host could drive mutation endpoints
   (`set-sinkhole-config`, protection toggle) in a no-token deployment. Mitigation
   exists: configuring `feedToken` requires Bearer auth on top of origin.
   *Recommend*: consider requiring the token unconditionally for mutations, or
   tightening `.local` trust — owner decision, not changed unilaterally.

3. **Renderer sees the plaintext AI apiKey** — `get-ai-config` returns
   `saved.apiKey` (~5358) because the settings UI displays it. Consequence: every
   renderer-side override path (`overrideConfig.apiEndpoint` on `ai-scan-domain`)
   grants no capability beyond what the renderer already holds. Accepted design;
   noted so it isn't re-flagged.

4. **`test-ai-connection` LAN fetching** — fetches a renderer-named endpoint
   (Ollama's purpose is a local/LAN server). Post-F-07 echo bound limits returned
   content to ≤50 names ×120 chars. SSRF-adjacent by design; bounded.

5. **Pairing QR embeds the feed token** — by design; it's the pairing mechanism.
   Printed/QR'd URLs are a deliberate tradeoff documented in code.

## Verified-but-limited areas

6. **Renderer crash recovery is log-only** — `render-process-gone` at ~6148 logs
   and continues; the window is not recreated and the user sees a blank view until
   reload. Tolerable for a utility; a future hardening could auto-reload.

7. **No sleep/resume handlers** — no `powerMonitor` usage anywhere. Sleep pauses
   timers and freezes sockets; SSE heartbeats reap dead clients on wake. Not
   exercised on a real lid-close cycle in this pass.

8. **Quarantine snapshot writes are unbatched** — every `add-threat-quarantine`
   call renders + atomically rewrites `threats.txt`. Burst sends are functional
   but wasteful; a trailing-edge debounce would be the follow-up (not applied —
   behavior change, not needed for correctness now that tmp names are unique).

9. **Pre-fix poisoned store entries are now dropped at the emit boundary** — the
   fix screens output, it does not scrub the store. `aiThreatQuarantine` may still
   *hold* malformed entries that silently publish nothing. A startup-time store
   scrub would be the tidy follow-up; not applied (it mutates persisted user data).

## Environment-limited verification (untested, not failed)

10. **Windows/Linux packaged behavior** — untested; only macOS arm64 was built and
    launched. The systemd unit was validated structurally and by escape tests, but
    never by `systemd-analyze verify` or a real install (no systemd host here).

11. **Real launchd install** — the plist is `plutil`-valid with hostile paths, but
    the script was never run as root (correctly — verification must not modify the
    host's service registry).

12. **Docker-gated live suites** — pihole/adguard/technitium suites skipped; images
    absent and project policy forbids pulling them.

13. **The pre-Pass-2 packaged artifact** — the `out/` build found on entry predated
    all remediations (hitsPath present). The verified build is the fresh
    `npm run package` from this pass; if a release ships, ship a fresh artifact.

14. **`npm test` under default flags skips the heap tripwire** —
    `ipcProfile.test.ts` skips without `--expose-gc` (asserting heap deltas without
    GC would measure the runner, not the code). Numbers under `--expose-gc`:
    2000 quarantine adds +14.5MB retained; 200 feed-server cycles +1.1MB; 1000
    watchdog writes +1.2MB. No leak signal — but this is a spot profile, not a
    soak test.
