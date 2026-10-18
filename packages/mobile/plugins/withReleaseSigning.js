// @ts-check
/**
 * Release signing for the Android app — durable across `expo prebuild`.
 *
 * The android/ tree is generated output (gitignored), so hand-edits to
 * app/build.gradle are wiped every prebuild. This config plugin appends the
 * release-signing wiring during prebuild instead.
 *
 * Behaviour:
 *  - Credentials come from env vars or gradle.properties entries
 *    (BM_RELEASE_STORE_FILE / BM_RELEASE_KEY_ALIAS / BM_RELEASE_STORE_PASSWORD /
 *    BM_RELEASE_KEY_PASSWORD). Nothing secret is ever written into the repo.
 *  - When all four are present, the release buildType signs with the release
 *    keystore. When any is missing, release-scoped tasks
 *    (assembleRelease / bundleRelease / packageRelease / installRelease /
 *    publish…Release) throw a clear GradleException at task-graph time —
 *    debug builds are unaffected and debug signing is NEVER silently used
 *    for release.
 *  - Play Store note: for Play App Signing this same keystore would act as
 *    the upload key; the app-signing key would then live with Google. The
 *    wiring here does not preclude that migration.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

const GRADLE_SNIPPET = `
// --- Blockingmachine release signing (plugins/withReleaseSigning.js) ---
def bmVersionCodeOverride = (System.getenv('BM_ANDROID_VERSION_CODE') ?: findProperty('BM_ANDROID_VERSION_CODE') ?: '').toString()
if (bmVersionCodeOverride) {
    // Prebuild stamps the semver-derived code (see app.config.js); a same-version
    // rebuild bumps it here at gradle time without re-running prebuild.
    android { defaultConfig { versionCode bmVersionCodeOverride.toInteger() } }
}
def bmReleaseStoreFile = (System.getenv('BM_RELEASE_STORE_FILE') ?: findProperty('BM_RELEASE_STORE_FILE') ?: '').toString()
def bmReleaseKeyAlias = (System.getenv('BM_RELEASE_KEY_ALIAS') ?: findProperty('BM_RELEASE_KEY_ALIAS') ?: 'blockingmachine').toString()
def bmReleaseStorePassword = (System.getenv('BM_RELEASE_STORE_PASSWORD') ?: findProperty('BM_RELEASE_STORE_PASSWORD') ?: '').toString()
def bmReleaseKeyPassword = (System.getenv('BM_RELEASE_KEY_PASSWORD') ?: findProperty('BM_RELEASE_KEY_PASSWORD') ?: '').toString()
def bmReleaseSigningReady = !bmReleaseStoreFile.isEmpty() && !bmReleaseStorePassword.isEmpty() && !bmReleaseKeyPassword.isEmpty()
if (bmReleaseSigningReady) {
    android {
        signingConfigs {
            release {
                storeFile file(bmReleaseStoreFile)
                keyAlias bmReleaseKeyAlias
                storePassword bmReleaseStorePassword
                keyPassword bmReleaseKeyPassword
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.release
            }
        }
    }
}
gradle.taskGraph.whenReady { graph ->
    if (!bmReleaseSigningReady && graph.allTasks.any { it.name ==~ /(assemble|bundle|package|install|publish)[A-Za-z]*Release[A-Za-z]*/ }) {
        throw new GradleException("Blockingmachine release builds REQUIRE the release keystore — debug signing is never silently used. " +
            "Set BM_RELEASE_STORE_FILE, BM_RELEASE_KEY_ALIAS, BM_RELEASE_STORE_PASSWORD and BM_RELEASE_KEY_PASSWORD " +
            "as environment variables or gradle.properties entries; see packages/mobile/README.md for keystore creation and backup.")
    }
}
// --- end Blockingmachine release signing ---
`;

/** @type {import('@expo/config-plugins').ConfigPlugin} */
module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    // AGP 9's built-in Kotlin registers the `kotlin` extension itself, so the
    // template's explicit kotlin-android application throws "extension already
    // registered" (the same conflict scripts/patch-react-native-rn087.cjs strips
    // from expo-modules-core). The generated app module needs the same strip —
    // kotlinOptions/KotlinCompile keep working through the AGP builtin.
    cfg.modResults.contents = cfg.modResults.contents
      // AGP 9 built-in Kotlin registers `kotlin` itself, so an unconditional
      // kotlin-android apply throws "extension already registered" — but the
      // Expo 58 template emits `android.builtInKotlin=false`, where the app
      // module (MainActivity.kt/MainApplication.kt) NEEDS the external plugin.
      // Gate the apply on the property so it is correct under either regime.
      .replace(
        /^\s*apply plugin: ["'](?:org\.jetbrains\.kotlin\.)?kotlin-android["']\s*$/m,
        "if (!((findProperty('android.builtInKotlin') ?: 'true') as String).toBoolean()) { apply plugin: 'org.jetbrains.kotlin.android' }",
      )
      // AGP 9 rejects the legacy unoptimised proguard preset outright.
      .replace(/proguard-android\.txt/g, 'proguard-android-optimize.txt');
    // The template no longer emits the kotlin-android apply at all — inject the
    // gated form after the react plugin when it is absent entirely.
    if (!/kotlin-android|org\.jetbrains\.kotlin\.android/.test(cfg.modResults.contents)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /apply plugin: "com\.facebook\.react"\s*\n/,
        'apply plugin: "com.facebook.react"\n\n' +
          "if (!((findProperty('android.builtInKotlin') ?: 'true') as String).toBoolean()) { apply plugin: 'org.jetbrains.kotlin.android' }\n",
      );
    }
    if (!cfg.modResults.contents.includes('Blockingmachine release signing')) {
      cfg.modResults.contents += GRADLE_SNIPPET;
    }
    return cfg;
  });
};
