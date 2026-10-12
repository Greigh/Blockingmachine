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
