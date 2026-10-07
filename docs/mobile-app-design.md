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
    _layout.tsx            # QueryClientProvider + ServerProvider + ServerEventsProvider + GestureHandlerRootView + Tabs
    (tabs)/index.tsx       # Dashboard
    (tabs)/check.tsx       # Domain check (+ swipe-to-delete history)
    (tabs)/telemetry.tsx   # Threats + compile history + activity feed
    (tabs)/settings.tsx    # Server list (swipe-to-delete), pairing, token
    add-server.tsx         # Modal: manual / QR / discovered
  src/
    api/types.ts           # /v1 payload shapes (mirrored; shared-contract pkg is a later refactor)
    api/client.ts          # Typed fetch wrapper, normalized errors, bearer attach
    api/sse.ts             # Chunk parser + reconnect/backoff over expo/fetch
    api/discovery.ts       # zeroconf browse → DiscoveredServer[]
    api/pairing.ts         # QR payload decode/validate
    state/servers.tsx      # ServerProvider: saved list (AsyncStorage) + token (SecureStore)
    state/events.tsx       # ServerEventsProvider: app-wide SSE, alert + activity feed
    components/ui.tsx      # Card, Pill, ActionButton (Pressable+ripple), ErrorBanner, Skeleton
    haptics.ts             # expo-haptics wrapper: tap / select / success / error
    format.ts              # Timestamp + uptime + relative-time formatters
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

## Phase 2 — on-device filtering (implemented 2026-10-06)

Three cooperating layers let the phone filter without the hub:

**Ruleset sync** (`src/filter/ruleset.ts`): `Sync rules from hub` downloads the
hub's `/dns.txt` once and persists three artifacts under
`FileSystem.documentDirectory`: `ruleset.txt` (raw feed), `ruleset_native.txt`
(bare-domain + `!exception` lines for the native services), `ruleset.meta.json`
(sync time, count, source). ABP `||host^` / `@@` lines are normalized by
`toNativeRules`; `$options`/path rules are dropped (meaningless at DNS level).

**JS matcher** (`src/filter/matcher.ts`): a standalone evaluator implementing the
same domain semantics as the core `domainEvaluator` (suffix match, exceptions
win) with **no Node built-ins** — the core evaluator transitively pulls
`node:fs` via reputation/db-loader, which Hermes cannot bundle. Jest
`ruleset.test.ts` pins parity against the real core evaluator.

**Android native module** (`modules/local-vpn/` — an Expo local module, autolinked
from `./modules` by default): `LocalVpnModule` bridges; `VpnFilterService`
establishes a `tun0` interface with a single `/32` route for a virtual resolver
(`10.0.0.53`), parses DNS packets (`DnsPacket`), NXDOMAINs blocked names and
relays allowed ones to upstream UDP/53; `PacProxyService` serves `proxy.pac` and
answers CONNECT/plain-HTTP as a forward proxy (domain-level HTTPS filtering, no
MITM). `Blocklist` is the shared native matcher.

The **Check tab** prefers the hub verdict and falls back to the on-device
ruleset on `ApiError.kind === 'unreachable'` (or when no server is configured);
the **Dashboard** shows standalone mode when a ruleset exists without a server;
**Settings** gained the Standalone filter card (sync/status/clear) and the
On-device filter card (VPN consent/start/stop, proxy start/stop, live counters).

Hard-won platform details:

- `VpnService.prepare()`'s intent **must** be launched via
  `startActivityForResult` — `ConfirmDialog` resolves the caller through
  `getCallingPackage()`, which a bare `startActivity` leaves null, so the dialog
  self-finishes instantly (opens "visible" then dies ~seconds later).
  `OnActivityResult` emits `onVpnConsentResult`; JS awaits the event and
  auto-starts the VPN on grant — one tap, no dead end.
- `app.json` needs `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` +
  `POST_NOTIFICATIONS`, and each service needs
  `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` — missing any of these throws
  `SecurityException` at `startForeground`. Regenerate `android/` (or patch the
  merged manifest) when permissions change; `gradlew` alone does not re-merge.
- `documentDirectory` is a `file://` URI — the Kotlin side strips the scheme
  before `File()`.
- `packages/mobile/.gitignore` anchors `/android/` to the package root so
  `modules/*/android/` (real source) is tracked while prebuild output stays
  ignored.
- Emulator driving quirks: `input` events run as uid 2000 — taps that land while
  the app isn't frontmost hit the launcher and can open unrelated apps (this
  AVD's Shortcake widget kept stealing taps); uiautomator dumps report
  off-screen-but-rendered RN nodes with real bounds, so a "present" node isn't
  necessarily visible.

iOS remains Phase-2-blocked: equivalent filtering needs the Network Extension
entitlement (Apple approval) — the JS matcher and ruleset layers are
platform-shared, only the packet interception is Android-only.
