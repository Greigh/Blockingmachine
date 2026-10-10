# QR Pairing & Feed Token Security Review

Date: 2026 (Pass 4). Covers the desktop pairing/QR path
(`packages/electron-app/src/index.ts` feed-token handlers,
`get-feed-pairing-payload`, `mdnsAdvertiser.ts`, `Settings.tsx`) and the mobile
consumer (`packages/mobile/src/api/pairing.ts`, `api/client.ts`,
`state/servers.tsx`).

## Protocol as implemented

- QR payload: `{"v":1,"url":"http://<lan>:9191","urls":[...]?,"token":"..."?}`
  rendered locally via `qrcode.react` — no external QR service ever sees it.
- Token is included only when configured and only on explicit user action
  ("Show pairing QR"); the UI labels it "carries your feed token; treat it like
  a password."
- mDNS TXT advertises `api`, `version`, `token=required|open` — **never** the
  credential (verified in `mdnsAdvertiser.ts` source + pairing tests).
- Mobile decodes strictly (`v === 1`, URL normalized http(s)-only with userinfo
  stripped by `URL.origin`, malformed alternates dropped, blank tokens dropped);
  stores the token in **expo-secure-store** (platform keystore) keyed per server,
  server list in AsyncStorage; sends `Authorization: Bearer` on every request —
  headers only, never query strings.
- Desktop stores the token through `writeSecret` → `safeStorage`-sealed at rest
  where available; `get-feed-token-status` returns presence only (write-only
  model).

## Confirmed gaps — fixed and verified

1. **No CSPRNG generation path existed.** `set-feed-token` accepted any
   user-typed string; the security of the entire LAN mutation surface defaulted
   to whatever the user invented. Fixed: `generate-feed-token` IPC produces a
   192-bit `randomBytes` token, seals it at rest, returns it once for
   display/QR; Settings gained a Generate button + one-time display with Dismiss.

2. **No entropy floor.** `'1234'` was a valid token. Fixed: `set-feed-token`
   rejects user-typed values under 16 chars (writes only — existing stored
   tokens are untouched, so nothing already paired breaks).

3. (Verified, no fix needed) Token never crosses logs: `set`/`generate` error
   paths log the exception, not the value; payload is never `console.log`'d on
   either side.

## Behavioral evidence (`ipcBehavioral.test.ts`, "Pairing" test)

- `set-feed-token '1234'` → refused, store empty.
- `generate-feed-token` twice → 32-char base64url strings, distinct, sealed store
  holds the latest.
- `get-feed-pairing-payload` → `v:1`, `http(s)` url, `token` === stored value.
- End-to-end: no-bearer POST → 401; `Bearer <generated>` → reaches handler.

Mobile side: `pairing.test.ts` (6 tests) covers valid/corrupt/tokenless
payloads, multi-homed `urls`, encode round-trip, blank-token dropping.

## Accepted risks

- **One shared token for all clients** — pairing the phone gives it the same
  credential HA and curl use; revoking one device means rotating for all.
  Rotation path exists (`set`/`generate` again → re-pair) and works, but there
  is no per-device grant. Mitigation proposal in `SECURITY_DECISIONS.md` D-4
  (short-lived pairing code → per-device credential) — architectural.
- **QR secrecy is physical** — anyone who photographs the screen owns the token;
  the show/hide toggle + warning label is the mitigation.
- **Rotation desyncs clients** — expected; re-pairing is the recovery path.
- **safeStorage unavailable** → token sits plaintext in the flat store (same
  class as AI key fallback; flagged D-5).

## Compatibility confirmed

Extension sends `Authorization` from background worker (extension origin ✓);
HA integration + mobile send bearer on every request including reads; feed
`.txt` routes never required a token (subscribers unchanged); mDNS-only
discovery still works without a token.
