// @ts-check
/**
 * Dynamic Expo config — wraps app.json.
 *
 * app.json stays the single source of truth for `expo.version` (which becomes
 * Android versionName and iOS CFBundleShortVersionString). This wrapper derives
 * monotonically increasing platform build numbers — android.versionCode and
 * ios.buildNumber (CFBundleVersion) — from that version on every prebuild, so
 * generated projects never pin `versionCode 1`/`CFBundleVersion 1`.
 * BM_ANDROID_VERSION_CODE overrides the derivation for same-version rebuilds.
 */
const appJson = require('./app.json');
const { resolveVersionCode } = require('./plugins/versionCode');

module.exports = () => {
  const expo = appJson.expo;
  const buildNumber = resolveVersionCode(expo.version);
  return {
    expo: {
      ...expo,
      // CFBundleShortVersionString admits ≤3 dot-separated integers — a semver
      // prerelease like "1.0.1-beta.2" fails ASC validation. The beta stream
      // differentiates builds via CFBundleVersion, so the marketing string
      // emits the base triple and prerelease builds attach to the release's
      // own TestFlight version. The full semver still drives versionCode
      // derivation above and lives in the monorepo tag.
      version: expo.version.split('-')[0],
      android: {
        ...expo.android,
        versionCode: buildNumber,
      },
      ios: {
        ...expo.ios,
        buildNumber: String(buildNumber),
      },
    },
  };
};
