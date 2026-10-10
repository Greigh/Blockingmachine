# LAN API Security Review

Date: 2026 (Pass 4 — LAN/AI/pairing hardening). Supersedes the LAN sections of
`REMAINING_RISKS.md`. Source of truth: `packages/electron-app/src/index.ts` (feed
server ~line 2620–3420) and `packages/electron-app/src/feedAuth.ts`.

## Bind surface

- One HTTP server, `feedHttpServer.listen(port, '0.0.0.0')` — every interface,
  port 9191 default (renderer-selectable 1024–65535). No loopback-only mode
  exists today; see `SECURITY_DECISIONS.md` D-3.
- `Access-Control-Allow-Origin: *` is set unconditionally on every response;
  `Access-Control-Allow-Methods: GET, HEAD, OPTIONS` — a browser preflight for a
  POST can never succeed (verified: OPTIONS → 204, no POST in Allow).
- Malformed URI → 400 before routing.

## Endpoint inventory and guards

Origin guard `isSafeClientOrigin` (trusted: no-Origin native clients, `localhost`,
`127.0.0.1`, `chrome-extension:`, `moz-extension:` — `.local`/`.lan`/`.internal`/
`.home.arpa` removed this pass after a live drive-by repro). Token check
`feedTokenAuthorised` (constant-style bearer compare; token from sealed store).

| Route | Class | Guard | Body cap |
|---|---|---|---|
| `/browser.txt`, `/adguardbrowser.txt`, `/hotlist.txt` | public feed read | none — deliberately open | n/a |
| `/ai-threats.txt` | public feed read | none | n/a |
| `/v1/status`, `/api/status` | telemetry read | `rejectUnauthorisedRead` (origin + token-if-configured) | n/a |
| `/v1/events` | SSE telemetry | `rejectUnauthorisedRead` | n/a |
| `/v1/check` | telemetry read | `rejectUnauthorisedRead` | n/a |
| `/v1/telemetry` | telemetry read | `rejectUnauthorisedRead` | n/a |
| `/v1/telemetry/browser` | mutation | `rejectUnauthorisedMutation` | 1 MB |
| `/v1/deploy-report` | mutation | `rejectUnauthorisedMutation` | none taken |
| `/v1/control/cosmetics` | mutation | `rejectUnauthorisedMutation` | 1 MB |
| `/v1/control/reload` | mutation | `rejectUnauthorisedMutation` | none taken |
| `/v1/control/daemon` | mutation | `rejectUnauthorisedMutation` | 1 MB |
| `/v1/protection` | mutation | `rejectUnauthorisedMutation` | 1 MB |
| `/v1/compile` | mutation | `rejectUnauthorisedMutation` | none taken |

`/api/...` aliases share the same guards. Oversized bodies: the socket is
destroyed mid-stream (verified — not parsed, not truncated-then-acted-on).

## Confirmed defects — fixed and verified

1. **`.local` origin drive-by (was MEDIUM-HIGH).** Reproduced live before the
   fix: `Origin: http://evil-printer.local` POST `{"action":"stop"}` to
   `/v1/control/daemon` passed the gate (200/handler-verdict), and a
   `rogue-mdns.local` page could open `/v1/events`. `.local` is mDNS-claimable by
   any LAN device, so this was an unauthenticated cross-device control channel in
   tokenless deployments, not a config footnote. Fixed by removing `.local` from
   the origin allowlist; behavioral test asserts 403 on mutations and SSE.
   Verified zero documented consumers use a `.local` browser origin.

2. **Unguarded telemetry reads (`/v1/status`, `/v1/telemetry`, `/v1/check`).**
   `recentTrackers` (browsing-derived, last-50 tracker domains), LAN addressing
   and quarantine contents were readable by *any* web page thanks to `ACAO:*`.
   `/v1/events` was already guarded — the omission was inconsistent, not a stated
   design. Fixed: all telemetry-bearing reads now share `rejectUnauthorisedRead`
   (origin guard + bearer when configured). Feed `.txt` routes stay open — they
   are the product's public output. Paired consumers (mobile bearer, HA bearer,
   extension origin) verified unaffected.

3. **Poisoned-store `savePath` crash.** `dirname(savePath)` was called unguarded
   in `/v1/status` — a non-string persisted value threw TypeError inside the
   request handler (request hang/unhandled rejection). Same class of bug the
   existing `outputDir` guard documented two screens earlier. Fixed.

## Verified non-bypasses (behavioral tests, `ipcBehavioral.test.ts`)

- Token configured: no-Origin-no-bearer → 401; wrong bearer → 401; no-Origin +
  right bearer → reaches handler; **forbidden origin + valid bearer → 403**
  (controls are independent — the token cannot launder a bad origin).
- Tokenless: `.local`/random origins → 403 on all mutation and telemetry routes;
  loopback, `chrome-extension://`, no-Origin → open.
- OPTIONS → 204, Allow lacks POST.
- 2 MB body → connection destroyed.
- mDNS advert carries only `required|open`, never the token.

## Accepted risks (owner-visible; see SECURITY_DECISIONS.md)

- **No-Origin LAN mutations in tokenless deployments.** Any LAN *process* (a
  compromised smart-TV app, a curl one-liner) can POST `/v1/protection
  {"enabled":false}` with no Origin and no token. Browser vectors are closed;
  the native-client channel is the residual. Making the token mandatory or
  auto-generated-on-first-run is D-1 — architectural approval required because it
  changes every existing install's contract.
- **Loopback-vs-LAN indistinguishable at accept()**. Node sees both as TCP from
  an address; `localhost` origins could equally come from a same-host browser —
  acceptable because a same-host attacker already controls the machine.
- **DNS rebinding *into* the server**: a hostile page on `rebind.example`
  resolving to the LAN IP still sends `Origin: rebind.example` → 403. The Host
  header is not validated because it is not the trust boundary — Origin is, and
  native clients don't rebind.

## Proposed modes (not implemented — approval required)

See `SECURITY_DECISIONS.md` D-1/D-3 for the authenticated / legacy / local-only
mode design and migration path.
