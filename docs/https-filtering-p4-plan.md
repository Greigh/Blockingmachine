# HTTPS filtering — P4 implementation plan (Android transparent capture → hub engine)

Sibling to `https-filtering-p3-plan.md`; implements design-spec §11's P4 line — **Android TCP reassembly.** Same conventions: task → review → fix → gate, separate commits, no agent trailers, one logical line per markdown block.

## Locked preconditions (verified in tree)

- `packages/mobile/modules/local-vpn/android/…/VpnFilterService.kt` (214 lines): `VpnService` establishes a tun fd via `Builder`, `readLoop` reads IP packets, `DnsPacket.parseQuery` handles UDP/53 only — block → synthesized NXDOMAIN-ish response, else `protect()`ed upstream forward. `PacProxyService.kt` exists (269 lines — check what it does; may already contain a TCP relay shape worth reusing). `Blocklist.kt` (54) — flat host blocklist.
- The engine binds `BM_BIND_HOST` (default `127.0.0.1`) — a hub-bind of the LAN address makes `:9294` reachable from the phone TODAY with zero engine changes; PROXY-v2 is already the capture contract; the phone knows original-dst from the packet header — no lookup ioctl needed at all. The hub posture (LAN listener) is new: bind a second socket or bind `0.0.0.0`+document — pick: `BM_BIND_HOST` already accepts an address; a separate `BM_LAN_BIND` second listener is NOT needed for v1 (operator chooses the bind; loopback stays the shipped default).
- Android cert-trust ceiling (documented since the spec): apps targeting API 24+ ignore user CAs → full MITM covers browsers + opted-in apps only; SNI-level verdicts (peek → block/tunnel) cover EVERY app regardless. The design's honest Android ceiling — the card/README must say it.
- Kotlin is the mobile-module language; JVM unit tests for pure-Kotlin logic run on this Mac (`modules/local-vpn` is an Expo module — check its gradle/test setup; a standalone `TcpFlow` unit must not need android.jar — keep `ParcelFileDescriptor`/`protect()` behind the service).

## Architecture (pinned)

```
app traffic ──► tun fd ──► TunLoop (parse IPv4/IPv6 packet)
                              │ TCP dst:80/443 → TcpSession (userspace TCP)
                              │    reassembled stream
                              ▼
                    protect()ed socket → <hub-ip>:9294
                    write PROXY-v2 (src = app, dst = original packet dst)
                              │
                    engine verdicts: SNI peek → tunnel | terminate | block
                              │
                    tunnel/MITM bytes relay back → TcpSession → tun writes
                              │
              UDP/53 → existing DNS path (unchanged)
              UDP/443 → DROP silently (QUIC suppression, forces TCP)
              other TCP/UDP → pass-through via protect()ed relay (unchanged posture)
```

The hub engine does ALL verdict logic — the phone is byte-dumb (the "thin adapter" architecture, same as natlook-helper). Hub discovery: manual IP entry + optional mDNS/broadcast (v1 = manual entry in settings, matching the existing daemon-host config idiom in `mobile/src/`).

## Task 1 — userspace TCP core (`TcpFlow.kt`, pure Kotlin, JVM-testable)

`modules/local-vpn/android/src/main/java/com/blockingmachine/localvpn/tcp/`:
- `Packet.kt` — IP(v4+v6)/TCP header parse+serialize (checksums, options: MSS/WSOPT/SACK-ok/sack/timestamp passthrough-or-strip — pin: negotiate NO SACK/timestamp to keep the stack small — emit them as absent in SYN-ACK, clients cope).
- `TcpSession.kt` — per-flow TCB: SYN → SYN-ACK (ISSN random); state machine SYN_RECV→EST→CLOSE_WAIT/FIN_WAIT/CLOSED/LAST_ACK/TIME_WAIT-lite; receive-side reassembly (out-of-order queue keyed by seq, bounded 256KiB); send-side: ack-driven emit of downstream bytes (the `protect()`ed socket's read → tun writes), window advertisement (fixed 64KiB, clamp window scale); FIN propagation both directions; RST on malformed; no retransmit of our own data beyond a small retry queue (the client is on the same device — loss is tun-local and rare; a bounded 3-retry RTO queue covers emulator edge cases without a full congestion stack); flow idle-timeout reaper (60s silent → RST+free).
- `TunLoop` glue in `VpnFilterService.readLoop`: dispatch TCP dst∈{80,443} → session lookup by 5-tuple → `session.onPacket(bytes)` → emits tun writes + pushes payload to the upstream socket; a `sessions: ConcurrentHashMap` bounded (1024) with LRU-evict+RST.
- Upstream: per-session `protect()`ed `Socket(hubHost, 9294)` + `bm_proxy_v2` header write (the exact same byte layout — port the emit from `helper/common/splice.c` to Kotlin, golden-byte test it against the same fixtures).
- `Socket` I/O threads: one reader thread per session copying upstream→tun-emit queue; tun writes serialized through the existing single-file-descriptor writer (add a synchronized `emit`).

Tests (pure JVM, `modules/local-vpn/src/test/` or wherever the module keeps unit tests — check `LocalVpnModule` test layout): packet parse/serialize round-trip + checksum golden vectors; SYN/SYN-ACK handshake state machine; in-order + out-of-order reassembly (2-seg, gap-then-fill, dup); FIN both directions (half-close: client FIN → upstream shutdown(OUT) → upstream data still flows back); RST; retransmit-lite (drop our data, client re-ACKs → resend); window clamp; idle reaper; PROXY-v2 emit vs golden v4/v6 vectors (same bytes the C helper golden test asserts — COPY the vectors); a `FakeTun`+`FakeSocket` end-to-end: bytes in → parsed → upstream write; upstream bytes → tun packets with correct seq/ack.

## Task 2 — service wiring + hub config + UI

- `VpnFilterService`: hub host/port from intent extras (persisted via the existing settings store — find how `rulesPath`/hosts persist today); TCP dispatch per Task-1; UDP/443 drop counter; `protect()` on every upstream dial.
- `LocalVpnModule`: expose `startHttpsCapture(hubHost)`/`stopHttpsCapture()`/status (flows count) to JS beside the existing vpn controls; the JS side gets a `HubCapture` settings card (find the remote/daemon config UI surface — mirror it): hub IP field, connect/disconnect, status pill (flow count), and a CA-trust note ("install the hub's CA on this device for HTTPS content filtering — without it, hostname-level blocking still works"). CA install on Android = user flow (download PEM via `http://hub:9293/v1/proxy/ca` + `KeyChain.createInstallIntent()` — a real intent exists for user-CA install; do it via a "Install CA" button firing the intent with the fetched PEM — cleanest legit API).
- Loop prevention: the `protect()`ed socket to hub:9294 is fine by construction (it never re-enters the tun); the tun's own route-add must NOT capture the hub IP (`addAllowedApplication`/route exclusion or simply never route <hub-ip> — document).
- QUIC: UDP/443 counted-dropped (forces TCP into our session path).
- `mobile/src/` status surface: flows/blocked counters via the module (mirror the existing status-pill conventions).

Tests: module-facing logic where the harness allows (the Kotlin TCP core is the real coverage; service glue is thin — structural unit tests for config parse + intent building).

## Task 3 — engine hub posture + docs + flags

- `main.ts`/`configFromEnv`: `BM_BIND_HOST` already exists — add a `BM_LAN_PROXIES` optional second bind? NO — keep one bind; document that hub mode = `BM_BIND_HOST=<lan-ip>` (loopback then closes — a deliberate posture the operator picks). Add to `index.ts` status payload: nothing needed (bindHost already surfaced? check).
- `HttpsFilterCard`: "LAN hub mode" hint line when `bindHost !== 127.0.0.1` (surfaces that the proxy accepts remote flows — security note: the data listener now trusts LAN clients; document the threat posture: no auth on the data port — recommend bind-to-LAN only on trusted nets; the control port stays loopback — VERIFY it can't also be LAN-bound accidentally).
- `docs/https-filtering-design.md` §9 LAN-hub extension: mark Android-via-hub as shipped-posture.
- `docs/open-flags.md`: android-no-ondevice-engine (nodejs-mobile track — the full-MITM-on-device upgrade, its own phase), android-cert-trust-ceiling (API24+ user-CA wall — documented, unfixable), tun-only-on-locked-profiles, the hub-LAN-auth posture (bind-to-LAN trusts the network — flag for a token/mTLS layer if this becomes multi-user).

## Sequencing + non-goals

T1 (TCP core — the heavyweight) → T2 (wiring/UI) → T3 (posture/docs). Each reviewed. Non-goals: on-device engine (flagged), UDP relay beyond DNS/QUIC-drop (general UDP proxying is its own phase — only 443's drop is in scope), IPv6-in-IPv6 weirdness (v6 TCP flows pass through unchanged — capture v4+v6 TCP uniformly anyway since it's cheap: the session key carries the family), per-app rules (the tun `addAllowedApplication` API exists — per-app bypass is a flag, not P4).

## Verification reality

Pure-JVM TCP tests run here. A real emulator/device leg (adb install, VpnService grant, browse through hub) is operator-gated — the plan ships `scripts/android-capture-rehearse.sh` (emulator-detected, adb-driven: start emulator if image exists, install debug apk if built, drive a curl through `adb shell` … the shell can't see the VPN-protected path honestly — rehearse via an on-device WebView fetch or a test-app fetch; mark the honest limits). Never auto-run.
