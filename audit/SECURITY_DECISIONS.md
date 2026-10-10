# Security Decisions Requiring Owner / Architectural Approval

Date: 2026 (Pass 4). Each item is a deliberate tradeoff, not a defect — nothing
here has been silently changed. Status column shows what the code does *today*.

---

## D-1 — Mandatory feed token (authenticated mode) for LAN mutations

- **Current**: token optional; tokenless → mutations gated by origin only, and
  no-Origin clients trusted outright (mobile, HA, curl compatibility).
- **Risk**: in tokenless deployments any LAN process can POST
  `/v1/protection off`, `/v1/control/daemon stop`, `/v1/compile`. Browser
  vectors are closed (`.local` removed, telemetry reads gated); the residual is
  non-browser LAN actors.
- **Options**: (a) status quo + UI warning; (b) auto-generate a token on first
  run of *new* installs (legacy installs untouched — migration split); (c)
  require token for all mutations unconditionally.
- **Recommended**: (b) — new installs get authenticated mode by default with a
  generated token in the QR; a Settings escape hatch selects legacy mode.
  Existing installs migrate only on explicit opt-in.
- **Compatibility**: (b)/(c) break unpaired native clients until re-paired; HA
  integration already sends bearer when configured (no code change needed);
  extension unchanged; feed `.txt` reads unaffected under all options.
- **Complexity**: small — generation + sealed store exist since this pass; the
  work is a first-run flag, Settings mode selector, and pairing-QR default-on.
- **Approval**: REQUIRED — changes the default trust contract.

## D-2 — Rejecting no-Origin requests entirely

- **Current**: absent Origin ⇒ native client ⇒ trusted (subject to token when
  configured).
- **Risk**: Origin is the only drive-by proof; its absence is unauthenticated.
- **Options**: (a) keep; (b) reject no-Origin *only when* a token is configured
  AND none presented — **this is already today's behavior** (401); (c) reject
  no-Origin unconditionally.
- **Recommended**: keep (a)/(b). (c) would kill curl/mobile/HA outright and add
  no browser security (browsers always send Origin or Referer; we fall back to
  Referer already).
- **Compatibility**: (c) is incompatible with every documented consumer.
- **Complexity**: n/a.
- **Approval**: required only if the owner wants (c) — not recommended.

## D-3 — Loopback-only listen mode

- **Current**: binds `0.0.0.0`; no loopback option.
- **Options**: (a) none; (b) Settings toggle "local only" → bind `127.0.0.1`;
  (c) auto when no integrations configured.
- **Recommended**: (b) as an option — genuinely useful for users who only want
  browser-extension/local use and never pair devices.
- **Compatibility**: enabling it breaks mobile/HA/LAN feed pulls — must be
  opt-in with clear labeling; loopback does not authenticate local processes.
- **Complexity**: small (bind address is already a parameter path).
- **Approval**: recommended for a future pass; non-breaking additive.

## D-4 — Per-device pairing credentials (advanced pairing)

- **Current**: one shared token embedded in every QR; all clients identical.
- **Proposed**: QR carries a short-lived single-use *pairing code*; mobile
  exchanges it (`POST /v1/pair`) for a device-scoped credential; server stores a
  device table {id, name, cred-hash, lastSeen}; per-device revoke in Settings;
  shared-token path retained as legacy.
- **Benefits**: independent revocation, per-device audit, rotation without
  re-pairing everything, QR shelf-life.
- **Compatibility**: additive endpoint + additive payload field — old mobile
  builds keep using `token`; new builds prefer `pair`. Requires mobile release
  coordination to realize benefits.
- **Complexity**: medium — new endpoint, device table persistence, mobile
  exchange flow, Settings revocation UI, expiry sweeper.
- **Approval**: REQUIRED — protocol extension; documented here for roadmap.

## D-5 — Secrets at rest when `safeStorage` is unavailable

- **Current**: feed token, AI key, sinkhole credentials fall back to plaintext
  in the flat store when OS encryption is missing (Linux headless, some
  minimal DEs).
- **Options**: (a) accept + document; (b) refuse persistence of secrets when no
  cipher (breaks those installs); (c) keychain/secret-service broker per
  platform (libsecret via dbus etc.).
- **Recommended**: (a) short-term — the UI already surfaces
  `encryptionAvailable`; revisit (c) only if a real deployment needs it.
- **Approval**: required for (b)/(c); (a) is the standing decision unless
  overruled.

## D-6 — AI endpoint scope

- **Current**: `isSafeLanEndpointUrl` — loopback + LAN + public allowed;
  link-local/metadata/unspecified/multicast/reserved blocked; manual redirects;
  bounded bodies; timeouts.
- **Options**: (a) current; (b) loopback-only default with LAN opt-in; (c)
  path allowlists per provider.
- **Recommended**: (a) — LAN AI is the flagship use case (Ollama on a second
  box); (b)/(c) trade real functionality for speculative gains.
- **Approval**: required only to tighten further; current policy is
  implemented and tested.

---

*All implemented fixes this pass are non-breaking: nothing above the line was
changed in existing installs' behavior except closing confirmed defect paths
(`.local` trust, unguarded telemetry reads, unbounded AI bodies, weak tokens on
NEW writes).*
