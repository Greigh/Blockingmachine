// @ts-check
/**
 * The app talks to user-configured Blockingmachine hubs over plain HTTP on
 * LAN addresses (http://192.168.x.y:9191, http://10.0.2.2:9191). Android 9+
 * defaults `usesCleartextTraffic` to false, which kills every hub call on a
 * release build. The old `android.usesCleartextTraffic` app.json prop is no
 * longer implemented by Expo (absent from @expo/config-types since ~SDK 50),
 * so it was silently ignored and only the template's debug-variant manifest
 * overlays carried the attribute — debug builds worked, release builds did
 * not.
 *
 * IP literals cannot be scoped through a networkSecurityConfig domain list,
 * so the minimal honest policy is the application-level attribute itself:
 * cleartext is permitted globally, but the app only ever opens connections
 * to hosts the operator entered.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

/** @type {import('@expo/config-plugins').ConfigPlugin} */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (application) {
      application.$ = { ...application.$, 'android:usesCleartextTraffic': 'true' };
    }
    return cfg;
  });
};
