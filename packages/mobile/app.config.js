// @ts-check
/**
 * Dynamic Expo config — wraps app.json.
 *
 * app.json stays the single source of truth for `expo.version` (which becomes
 * Android versionName). This wrapper derives a monotonically increasing
 * android.versionCode from that version on every prebuild, so generated
 * build.gradle files never pin `versionCode 1`. BM_ANDROID_VERSION_CODE
 * overrides the derivation for same-version rebuilds.
 */
const appJson = require('./app.json');
const { resolveVersionCode } = require('./plugins/versionCode');

module.exports = () => {
  const expo = appJson.expo;
  return {
    expo: {
      ...expo,
      android: {
        ...expo.android,
        versionCode: resolveVersionCode(expo.version),
      },
    },
  };
};
