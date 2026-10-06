# Mobile App Design — `packages/mobile`

**Status:** Phase 1 (remote-control companion) approved 2026-10-05, branch `feat/mobile-app`.
**Approach:** A — Expo dev-client + expo-router + TanStack Query.

## Goal

An iOS/Android companion app that speaks the existing `/v1/*` REST surface served by
the Electron desktop hub (`:9191`) and the Home Assistant add-on. Blocking itself stays
server-side; the phone is a remote. Phase 2 (on-device filtering via Android
`VpnService` / iOS `NEDNSProxyProvider`) is explicitly out of scope but not precluded —
the dev-client requirement already establishes `expo prebuild`, so native modules are
incremental later.

## Endpoint coverage (phase 1 — full `/v1` surface)

| Endpoint | Method | Use |
|---|---|---|
| `/v1/status` | GET | Dashboard poll: rules counts, protection+daemon state, last compile, AI radar, SSE clients, feed URLs |
| `/v1/events` | GET (SSE) | Live updates: `compile_completed`, `rules_updated`, `remote_control` → query invalidation; `quarantine_added` → in-app banner + telemetry "new" marks |
| `/v1/telemetry` | GET | Quarantine list + compilation history |
| `/v1/check?domain=` | GET | Domain verdict + covering rule |
| `/v1/protection` | GET/POST | Read/toggle daemon protection (503 = daemon stopped) |
| `/v1/compile` | POST | Trigger compile (`alreadyRunning` shown as info) |
| `/v1/control/cosmetics` | GET/POST | Cosmetics broadcast toggle |
| `/v1/control/reload` | POST | Reload broadcast to browsers |
| `/v1/control/daemon` | POST | Hub-only daemon start/stop (`{action}`); the dashboard offers Start when the daemon reads stopped |

Feed files (`/dns.txt`, `/browser.txt`, `/ai-threats.txt`, `/threats.txt`) are linked
from the status payload's `feedServer` URLs for copy/share, not rendered in-app.
`/v1/telemetry/browser` and `/v1/deploy-report` are ingest-only and not used by the app.

## Auth model

`feedToken` unset → LAN-open (documented model). Set →
mutations and `/v1/events` need `Authorization: Bearer <token>`. React Native `fetch`
sends no `Origin` header, so the origin guard treats the app like curl/HA — already
permitted. Token is stored in `expo-secure-store`, never logged, attached only to the
configured base URL.

## Connection paths (all three)

1. **Manual** — host:port + optional token; "test connection" probes `/v1/status`
   (5s timeout) before saving. Works against desktop app and add-on today.
2. **QR pairing** — `expo-camera` scans a QR rendered by the desktop app:
   `{"v":1,"url":"http://<lanip>:9191","urls":[…alternates…],"token":"<feedToken>"}`
   (`token` present only when configured; `urls` present only on multi-homed
   hosts — the app tries each address and keeps the first that answers).
3. **mDNS discovery** — `react-native-zeroconf` browses `_blockingmachine._tcp.local.`;
   results appear as one-tap cards. TXT records: `api=v1`, `version`, `token=required|open`
   so the app knows to prompt for a token before probing mutations.

## Server-side changes (`packages/electron-app` only)

- `src/mdnsAdvertiser.ts` — publishes `_blockingmachine._tcp` on `startFeedServer`,
  unpublishes on stop; `bonjour-service` dependency. Failure is logged, never fatal —
  advertising is best-effort beside the feed itself.
- `feed:getPairingPayload` IPC in `preload.ts` → `{ url, urls?, token? }` built from
  the feed server's LAN addresses + `readSecret(storeRef, safeStorage, 'feedToken')`.
- Settings pane "Pair mobile app" section renders the payload as a QR (`qrcode.react`);
  if the feed server isn't running the block offers an inline start action, since the
  QR is only useful while the server answers.
- `autoStartFeedServer` defaults to on — pairing out of the box depends on it.
- `POST /v1/control/daemon {action:'start'|'stop'}` — remote daemon lifecycle,
  mirroring the tray's own calls (the dashboard's "daemon stopped" state would
  otherwise be a dead end on mobile).
- HA add-on stays manual-pair only this phase.

## App structure

```
packages/mobile/
  app.json                 # Expo config (bundle ids, scheme blockingmachine)
  package.json             # @blockingmachine/mobile, no build script
  tsconfig.json            # extends expo/tsconfig.base
  metro.config.js          # monorepo: watchFolders + nodeModulesPaths → repo root
  babel.config.js          # babel-preset-expo
  jest.config.js           # jest-expo preset
  index.ts                 # expo-router entry
  app/
    _layout.tsx            # QueryClientProvider + ServerProvider + Tabs
    (tabs)/index.tsx       # Dashboard
    (tabs)/check.tsx       # Domain check
    (tabs)/telemetry.tsx   # Threats + compile history
    (tabs)/settings.tsx    # Server list, pairing, token
    add-server.tsx         # Modal: manual / QR / discovered
  src/
    api/types.ts           # /v1 payload shapes (mirrored; shared-contract pkg is a later refactor)
    api/client.ts          # Typed fetch wrapper, normalized errors, bearer attach
    api/sse.ts             # Chunk parser + reconnect/backoff over expo/fetch
    api/discovery.ts       # zeroconf browse → DiscoveredServer[]
    api/pairing.ts         # QR payload decode/validate
    state/servers.tsx      # ServerProvider: saved list (AsyncStorage) + token (SecureStore)
    components/…           # StatusCard, ProtectionToggle, VerdictCard, …
    __tests__/             # jest-expo + mocked fetch
```

## Data flow

- Launch → load saved servers → probe `/v1/status` per server (5s) → first reachable
  becomes active → dashboard polls on interval + SSE drives invalidation.
- Protection toggle → optimistic update → `POST /v1/protection` → 503 renders
  "daemon not running" (stopped ≠ paused, mirroring desktop semantics).
- Compile → `POST /v1/compile` → `alreadyRunning` shown as info; `lastCompile` refresh
  on next status tick or SSE `compile_completed`.

## Errors

`unreachable | unauthorized | forbidden | server` normalized in the client. Offline →
banner + retry; 401 → token prompt; SSE drop → exponential backoff, polling continues.

## Testing

`jest-expo` unit tests: client contract against mocked `fetch` (desktop + add-on
shapes), SSE chunk parser, QR decode/validation, server-store persistence. RNTL
component tests for dashboard/check. Gates match the repo: `tsc --noEmit` clean,
`eslint .` zero warnings, jest green via `npm test --workspaces`.

## Constraints & risks

- **Dev-client required** (zeroconf + camera are native): `expo prebuild` /
  `npx expo run:ios|android` — no Expo Go. Phase 2 needs it anyway.
- **node_modules growth** — Expo/RN adds ~1GB hoisted at root; React 19 is already the
  repo's version so no peer conflict is expected.
- **`npm run test --workspaces`** picks the package up automatically — scripts must be
  green before merge or CI breaks. No `build` script defined so `build --workspaces`
  skips it (mobile builds via EAS/prebuild, not `npm run build`).
- `bump-version.mjs` scans `packages/*/package.json` dynamically → 9th workspace is
  automatic; mobile version will ride release bumps (harmless — it's `private`).
- Publishing is explicit (`publish-npmjs.mjs` lists core+cli only) — mobile can never
  reach the registries; `private: true` is belt-and-suspenders.
