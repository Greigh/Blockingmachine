# @blockingmachine/mobile

iOS/Android companion for the Blockingmachine `/v1/*` surface — the remote control for
the desktop hub's feed server and the Home Assistant add-on. Blocking stays on the
server; the phone reads status, toggles protection, checks domains, triggers compiles,
and watches telemetry.

Design: [`docs/mobile-app-design.md`](../../docs/mobile-app-design.md)

## What it talks to

The same REST contract the HA integration uses, served on `:9191` by both the Electron
app and the add-on: `status`, `events` (SSE), `telemetry`, `check?domain=`,
`protection`, `compile`, `control/cosmetics`, `control/reload`. Mutations and the event
stream take `Authorization: Bearer <feedToken>` when the server has one configured;
the app stores it in the device keychain (expo-secure-store).

## Connecting (three ways)

- **Manual** — host:port + optional token.
- **QR** — scan the pairing code under Settings → Pair mobile app in the desktop app
  (`{"v":1,"url","token?"}`).
- **mDNS** — the hub advertises `_blockingmachine._tcp.local.` while the feed server
  runs; the app browses for it and shows a one-tap card (TXT `token=required` tells
  the app to prompt for a token).

## Running it

Requires an Expo **dev-client build**, not Expo Go — `react-native-zeroconf` (mDNS)
and `expo-camera` (QR) are native modules.

```sh
npm install                 # from the repo root — this is a workspace
cd packages/mobile
npx expo prebuild           # generates ios/ + android/ (gitignored)
npm run ios                 # or npm run android — builds & launches the dev client
npx expo start              # then Metro serves the JS bundle
```

## Gates

Same as every workspace: `npm test` (jest-expo: API client contract, SSE parser,
pairing decode, server-store persistence), `npm run type-check` (`tsc --noEmit`),
`npm run lint` (eslint, zero warnings). The package deliberately has **no** `build`
script — mobile builds happen via `expo prebuild`/EAS, not `npm run build --workspaces`.

## Phase 2 (not built)

On-device filtering (Android `VpnService`, iOS `NEDNSProxyProvider`) was chosen as a
later phase. The dev-client requirement already establishes native builds, so that
work is incremental rather than a re-platforming. See `docs/open-flags.md`.
