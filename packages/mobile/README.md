# @blockingmachine/mobile

iOS/Android companion for the Blockingmachine `/v1/*` surface — the remote control for the desktop hub's feed server and the Home Assistant add-on. Blocking stays on the server; the phone reads status, toggles protection, checks domains, triggers compiles, and watches telemetry.

Design: [`docs/mobile-app-design.md`](../../docs/mobile-app-design.md)

## What it talks to

The same REST contract the HA integration uses, served on `:9191` by both the Electron app and the add-on: `status`, `events` (SSE), `telemetry`, `check?domain=`, `protection`, `compile`, `control/cosmetics`, `control/reload`. Mutations and the event stream take `Authorization: Bearer <feedToken>` when the server has one configured; the app stores it in the device keychain (expo-secure-store).

## Connecting (three ways)

- **Manual** — host:port + optional token.
- **QR** — scan the pairing code under Settings → Pair mobile app in the desktop app (`{"v":1,"url","token?"}`).
- **mDNS** — the hub advertises `_blockingmachine._tcp.local.` while the feed server runs; the app browses for it and shows a one-tap card (TXT `token=required` tells the app to prompt for a token).

## Running it

Requires an Expo **dev-client build**, not Expo Go — `react-native-zeroconf` (mDNS) and `expo-camera` (QR) are native modules.

```sh
npm install                 # from the repo root — this is a workspace
cd packages/mobile
npx expo prebuild           # generates ios/ + android/ (gitignored)
npm run ios                 # or npm run android — builds & launches the dev client
npx expo start              # then Metro serves the JS bundle
```

## Gates

Same as every workspace: `npm test` (jest-expo: API client contract, SSE parser, pairing decode, server-store persistence), `npm run type-check` (`tsc --noEmit`), `npm run lint` (eslint, zero warnings). The package deliberately has **no** `build` script — mobile builds happen via `expo prebuild`/EAS, not `npm run build --workspaces`.

## Release builds (Android)

`android/` is generated output — release configuration lives in `app.json` + `app.config.js` + `plugins/` and is re-injected on every `expo prebuild`. Two pieces:

**versionCode.** `app.config.js` derives the code from `expo.version` (`major*1e6 + minor*1e4 + patch*1e2 + prerelease`; stable = 99, `rc.11` = 11) — every version bump produces a strictly higher code (`1.0.0-rc.11` → `1000011`). For a same-version rebuild, pass `BM_ANDROID_VERSION_CODE=<higher>` — it is read at *gradle* time too, so no prebuild re-run is needed. `versionName` is `expo.version` automatically.

**Signing.** `plugins/withReleaseSigning.js` appends a `signingConfigs.release` block to the generated `app/build.gradle` that reads four credentials — env vars or `gradle.properties` entries:

```sh
export BM_RELEASE_STORE_FILE=/abs/path/release.keystore
export BM_RELEASE_KEY_ALIAS=blockingmachine
export BM_RELEASE_STORE_PASSWORD=…
export BM_RELEASE_KEY_PASSWORD=…
```

With all four set, `assembleRelease` signs with the release keystore; with any missing, release tasks fail with a clear `GradleException` — **debug signing is never silently used** (verified: `:app:assembleDebug` unaffected). The owner's keystore lives at `~/.config/blockingmachine-mobile/release.keystore` (JKS, RSA-4096, valid to 2054); credentials in `~/.config/blockingmachine-mobile/signing.env` (0600). **The keystore and its env file must never enter git** (`*.jks`/`*keystore*` are already covered by package and repo ignores — keep it that way).

```sh
source ~/.config/blockingmachine-mobile/signing.env
cd packages/mobile && npx expo prebuild -p android   # only when android/ doesn't exist or config changed
cd android && ./gradlew assembleRelease              # ANDROID_HOME must point at the SDK
~/Library/Android/sdk/build-tools/*/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

The print-certs digest must match `keytool -list -v -keystore $BM_RELEASE_STORE_FILE` — never `FA:C6:17…` (the debug cert on this machine). Creating a keystore on a fresh owner machine:

```sh
mkdir -p ~/.config/blockingmachine-mobile && chmod 700 ~/.config/blockingmachine-mobile
keytool -genkeypair -v -storetype JKS -keystore ~/.config/blockingmachine-mobile/release.keystore \
  -alias blockingmachine -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Blockingmachine Mobile, O=Greigh Studios"
```

Use `-storetype JKS` explicitly — keytool's PKCS12 default cannot hold a distinct key password. **Back the keystore + passwords up offline** (encrypted volume/password manager): losing the keystore means losing update ability for every install base permanently; leaking it means anyone can ship as the app. For CI, put the same four `BM_RELEASE_*` values in CI secrets (`FORGEJO_TOKEN`-style), write the keystore to a temp path in the workflow, and never echo passwords.

**Existing installs cannot upgrade across the certificate change.** The APKs shipped to date were debug-signed; Android refuses an in-place upgrade (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) when the signing cert differs. Those users must uninstall and reinstall — paired servers and feed tokens are stored in app-private storage (AsyncStorage + expo-secure-store) and are **lost on uninstall**: they will need to re-pair (QR / mDNS / manual URL + token). There is no supported data-migration path for the debug→release transition; this is a one-time break, after which all release-signed updates upgrade in place.

**Play Store note:** if Play distribution happens later, Google Play App Signing enrolls the app with a Google-held signing key and this keystore becomes the *upload* key — nothing here blocks that path, but it does not establish it automatically.

## Phase 2 (built — on-device filtering shipped)

On-device filtering (Android `VpnService` tun + PAC proxy, `modules/local-vpn`) shipped and was exercised on the emulator; physical-device VPN verification stays open under flag 73. iOS `NEDNSProxyProvider` remains unbuilt.
