// react-native ≥0.87 (npm `latest`; what packages/mobile runs under Expo SDK 57 until
// SDK 58 goes stable) moved two files that expo/jest-expo 57 still address at their
// 0.86 locations:
//
//   react-native/rn-get-polyfills.js        → @react-native/js-polyfills (same `() => paths` shape)
//   @react-native/assets-registry/registry  → react-native/asset-registry (now in RN's own exports)
//
// @expo/metro-config requires the first via an absolute path (exports can't help);
// its transformer.assetRegistryPath and jest-expo's jest.mock() target both name the
// second. Stub both back into existence — each write is skipped when the real file is
// already there (RN 0.86 installs, or upstream restores the paths).
const fs = require('fs');
const path = require('path');

const nm = path.resolve(__dirname, '../node_modules');

const polyfillShim = path.join(nm, 'react-native/rn-get-polyfills.js');
if (fs.existsSync(path.join(nm, 'react-native/package.json')) && !fs.existsSync(polyfillShim)) {
  fs.writeFileSync(
    polyfillShim,
    "// Patched in by scripts/patch-react-native-rn087.cjs — RN 0.87 moved this entry point.\n" +
      "module.exports = require('@react-native/js-polyfills');\n",
  );
  console.log('patched react-native: wrote rn-get-polyfills.js shim');
}

const registryPkg = path.join(nm, '@react-native/assets-registry');
if (!fs.existsSync(registryPkg)) {
  fs.mkdirSync(registryPkg, { recursive: true });
  fs.writeFileSync(
    path.join(registryPkg, 'package.json'),
    JSON.stringify(
      { name: '@react-native/assets-registry', version: '0.0.0', main: 'registry.js' },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(registryPkg, 'registry.js'),
    "// Patched in by scripts/patch-react-native-rn087.cjs — RN 0.87 hosts the registry at\n" +
      "// react-native/asset-registry (exposed via its package exports).\n" +
      "module.exports = require('react-native/asset-registry');\n",
  );
  console.log('patched react-native: wrote @react-native/assets-registry stub package');
}

// Third break, on the Android side: RN 0.87's gradle-plugin pulls an AGP that requires
// Gradle >=9.4.1, whose bundled kotlin-stdlib (2.3.0) is newer than the metadata
// version the Kotlin JVM plugin (2.1.20) in Expo's included builds can read. The build
// fails inside those composites before app code is ever reached. The documented escape
// hatch is -Xskip-metadata-version-check — stdlib's ABI is stable, so the older
// compiler reading a newer stdlib jar is safe. Appended once per composite, idempotently.
const SKIP_CHECK_BLOCK = `
// Patched in by scripts/patch-react-native-rn087.cjs — Kotlin-2.1 compiler vs the
// kotlin-stdlib 2.3.0 jar Gradle 9.4.1 puts on this classpath.
allprojects {
    tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
        compilerOptions.freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
`;
const KOTLIN_METADATA_TARGETS = [
  'expo-modules-autolinking/android/expo-gradle-plugin/build.gradle.kts',
  'expo-modules-core/expo-module-gradle-plugin/build.gradle.kts',
];
for (const rel of KOTLIN_METADATA_TARGETS) {
  const ktsPath = path.join(nm, rel);
  if (!fs.existsSync(ktsPath)) continue;
  const kts = fs.readFileSync(ktsPath, 'utf8');
  if (!kts.includes('-Xskip-metadata-version-check')) {
    fs.writeFileSync(ktsPath, kts + SKIP_CHECK_BLOCK);
    console.log(`patched ${rel}: added -Xskip-metadata-version-check to allprojects`);
  }
}

// Fourth break, same root cause on the module side: RN 0.87 pins AGP 9, which has
// built-in Kotlin enabled by default — AGP registers its own `kotlin` extension, so
// every `apply plugin: 'kotlin-android'` / `plugins.apply("kotlin-android")` in a
// library or app build now double-registers and dies. The external KGP can't be used
// instead (it casts AGP's extension to the removed BaseExtension). The fix that keeps
// the whole stack is: leave builtInKotlin on and remove every kotlin-android plugin
// *application* — the AGP builtin supplies the same `kotlin` extension, KotlinCompile
// tasks, and `kotlin {}` DSL, so per-module kotlinOptions blocks keep working.
const KOTLIN_ANDROID_APPLY_SITES = [
  'expo-modules-core/expo-module-gradle-plugin/src/main/kotlin/expo/modules/plugin/ProjectConfiguration.kt',
  'expo-modules-core/android/ExpoModulesCorePlugin.gradle',
  'react-native-gesture-handler/android/build.gradle',
  'react-native-safe-area-context/android/build.gradle',
  'react-native-screens/android/build.gradle',
  '@react-native-async-storage/async-storage/android/build.gradle',
  'react-native-reanimated/android/build.gradle.kts',
  'react-native-worklets/android/build.gradle.kts',
];
const KOTLIN_APPLY_RE = /^(\s*)(?:apply plugin:\s*["']kotlin-android["']|plugins\.apply\("kotlin-android"\)|apply\(plugin = "org\.jetbrains\.kotlin\.android"\))\s*$/gm;
for (const rel of KOTLIN_ANDROID_APPLY_SITES) {
  const filePath = path.join(nm, rel);
  if (!fs.existsSync(filePath)) continue;
  const source = fs.readFileSync(filePath, 'utf8');
  const patched = source.replace(
    KOTLIN_APPLY_RE,
    '$1// kotlin-android apply removed by scripts/patch-react-native-rn087.cjs — AGP 9 built-in Kotlin',
  );
  if (patched !== source) {
    fs.writeFileSync(filePath, patched);
    console.log(`patched ${rel}: removed kotlin-android plugin application`);
  }
}

// Fifth break: the expo gradle plugins were compiled against AGP-8 types. AGP 9
// moved the public DSL to com.android.build.api.dsl — the old com.android.build.gradle
// package types either vanished (BaseExtension) or are no longer what the registered
// extension implements (LibraryExtension → LibraryExtensionImpl). Import swaps plus
// one behavior-equivalent rewrite: flavorDimensions is a read-only List<String> on
// CommonExtension, so mutation goes through addAll-of-missing instead of the removed
// flavorDimensions(vararg) setter.
const AGP9_SOURCE_PATCHES = [
  {
    file: 'expo-modules-core/expo-module-gradle-plugin/src/main/kotlin/expo/modules/plugin/ProjectConfiguration.kt',
    replacements: [
      [
        'import com.android.build.gradle.LibraryExtension',
        'import com.android.build.api.dsl.LibraryExtension',
      ],
    ],
  },
  {
    file: 'expo-modules-core/expo-module-gradle-plugin/src/main/kotlin/expo/modules/plugin/android/AndroidLibraryExtension.kt',
    replacements: [
      [
        'import com.android.build.gradle.LibraryExtension',
        'import com.android.build.api.dsl.LibraryExtension',
      ],
      // AGP 9's publishing DSL uses receiver lambdas — the explicit `publishing ->`
      // param style no longer compiles; `it`-style unqualified members do.
      ['publishing { publishing ->', 'publishing {'],
      ['publishing.singleVariant', 'singleVariant'],
      // Library DSL dropped targetSdk entirely in AGP 9 (it is an app-level
      // setting); lintOptions was renamed to lint (lint.abortOnError).
      ['    this@defaultConfig.targetSdk = targetSdk\n', ''],
      ['lintOptions.isAbortOnError = false', 'lint.abortOnError = false'],
    ],
  },
  {
    file: 'expo-modules-core/android/build.gradle',
    skipIf: 'srcDirs += shouldIncludeCompose',
    replacements: [
      // AGP 9 built-in Kotlin compiles kotlin.srcDirs, not java.srcDirs — the
      // conditional src/compose|src/withoutCompose dir must land on both.
      [
        "      java {\n        if (shouldIncludeCompose) {\n          srcDirs += 'src/compose'\n        } else {\n          srcDirs += 'src/withoutCompose'\n        }\n      }",
        "      java {\n        if (shouldIncludeCompose) {\n          srcDirs += 'src/compose'\n        } else {\n          srcDirs += 'src/withoutCompose'\n        }\n      }\n      kotlin {\n        srcDirs += shouldIncludeCompose ? 'src/compose' : 'src/withoutCompose'\n      }",
      ],
    ],
  },
  {
    file: 'expo-modules-core/expo-module-gradle-plugin/src/main/kotlin/expo/modules/plugin/android/MavenPublicationExtension.kt',
    replacements: [
      // versionName was removed from the AGP 9 library DSL. This publication path
      // only executes for modules that apply maven-publish (never in a local app
      // build); project.version is the conventional Gradle publication version.
      [
        'project.androidLibraryExtension().defaultConfig.versionName',
        'project.version.toString()',
      ],
    ],
  },
  {
    file: 'expo-modules-autolinking/android/expo-gradle-plugin/expo-autolinking-plugin/src/main/kotlin/expo/modules/plugin/ExpoAutolinkingPlugin.kt',
    replacements: [
      [
        'import com.android.build.gradle.BaseExtension',
        'import com.android.build.api.dsl.CommonExtension',
      ],
      ['as? BaseExtension', 'as? CommonExtension<*, *, *, *, *, *>'],
      ['as? CommonExtension\n', 'as? CommonExtension<*, *, *, *, *, *>\n'],
      ['as? CommonExtension ?', 'as? CommonExtension<*, *, *, *, *, *> ?'],
      [': BaseExtension,', ': CommonExtension<*, *, *, *, *, *>,'],
      [': CommonExtension,', ': CommonExtension<*, *, *, *, *, *>,'],
      ['appAndroid: BaseExtension', 'appAndroid: CommonExtension<*, *, *, *, *, *>'],
      ['appAndroid: CommonExtension\n', 'appAndroid: CommonExtension<*, *, *, *, *, *>\n'],
      ['appAndroid\n      .flavorDimensionList', 'appAndroid\n      .flavorDimensions'],
      ['(consumerAndroid.flavorDimensionList)', '(consumerAndroid.flavorDimensions)'],
      [
        'consumerAndroid.flavorDimensions(*consumerDimensions.toTypedArray())',
        'consumerAndroid.flavorDimensions.addAll(consumerDimensions.filter { it !in consumerAndroid.flavorDimensions })',
      ],
    ],
  },
];
for (const { file, replacements, skipIf } of AGP9_SOURCE_PATCHES) {
  const filePath = path.join(nm, file);
  if (!fs.existsSync(filePath)) continue;
  let source = fs.readFileSync(filePath, 'utf8');
  if (skipIf && source.includes(skipIf)) continue;
  let touched = false;
  for (const [from, to] of replacements) {
    if (source.includes(from)) {
      source = source.split(from).join(to);
      touched = true;
    }
  }
  if (touched) {
    fs.writeFileSync(filePath, source);
    console.log(`patched ${file}: AGP 9 DSL type swaps`);
  }
}

// AGP 9 removed several members from the *library* DSL outright — targetSdk,
// versionCode, versionName — so groovy lines setting them in library modules
// NoSuchMethodError at configuration time (application-level use in the app
// module is still valid; it lives under packages/, never node_modules). Also:
// buildConfigField requires buildFeatures.buildConfig=true in AGP 9. Scan every
// dependency's android/build.gradle — the set of modules drifts with installs.
const REMOVED_DSL_LINE = /^\s*(?:targetSdkVersion|versionCode|versionName)\b/m;
function* iterModuleBuildGradles() {
  for (const entry of fs.readdirSync(nm, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(nm, entry.name);
    if (entry.name.startsWith('@')) {
      for (const sub of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (sub.isDirectory()) yield path.join(entryPath, sub.name);
      }
    } else {
      yield entryPath;
    }
  }
}
for (const pkgDir of iterModuleBuildGradles()) {
  const filePath = path.join(pkgDir, 'android/build.gradle');
  if (!fs.existsSync(filePath)) continue;
  let source = fs.readFileSync(filePath, 'utf8');
  let touched = false;
  if (REMOVED_DSL_LINE.test(source)) {
    source = source
      .split('\n')
      .filter((line) => !REMOVED_DSL_LINE.test(line))
      .join('\n');
    touched = true;
  }
  // A stripped `versionName "x"` line leaves `${versionName}` interpolations
  // dangling; every expo module sets a project-level `version` with the same value.
  if (source.includes('${versionName}')) {
    source = source.split('${versionName}').join('${version}');
    touched = true;
  }
  if (source.includes('buildConfigField') && !/buildConfig\s+true|buildConfig\s*=\s*true/.test(source)) {
    source = source.replace(/^(\s*)android\s*\{/m, '$1android {\n$1  buildFeatures {\n$1    buildConfig true\n$1  }\n');
    touched = true;
  }
  if (touched) {
    fs.writeFileSync(filePath, source);
    console.log(`patched ${path.relative(nm, filePath)}: AGP 9 library-DSL cleanup`);
  }
}

// AGP 9 also rejects Provider<> added to sourceSets.srcDirs (some linked module still
// does it). AGP's own error message names the opt-back-in flag; without it the app
// project fails configuration before compilation starts.
const APP_GRADLE_PROPERTIES = path.resolve(__dirname, '../packages/mobile/android/gradle.properties');
const GRADLE_PROPERTIES_APPENDS = [
  [
    '# Patched in by scripts/patch-react-native-rn087.cjs — a linked module adds\n' +
      '# a Provider<> to sourceSets.srcDirs; AGP 9 rejects that without this opt-in.\n' +
      'android.sourceset.disallowProvider=false\n',
    'android.sourceset.disallowProvider',
  ],
  [
    '# The RN classpath carries KGP 2.2.10 while the expo template pins kotlin 2.2.0 —\n' +
    '# modules that resolve ksp versions off rootProject.ext get the wrong KSP.\n' +
    'android.kotlinVersion=2.2.10\n',
    'android.kotlinVersion=',
  ],
  [
    '# KSP (async-storage/Room) registers generated sources through kotlin.sourceSets,\n' +
    '# which AGP 9 built-in Kotlin rejects without this suppression.\n' +
    'android.disallowKotlinSourceSets=false\n',
    'android.disallowKotlinSourceSets',
  ],
];
if (fs.existsSync(APP_GRADLE_PROPERTIES)) {
  let source = fs.readFileSync(APP_GRADLE_PROPERTIES, 'utf8');
  for (const [block, marker] of GRADLE_PROPERTIES_APPENDS) {
    if (!source.includes(marker)) {
      source = source.trimEnd() + '\n\n' + block;
      console.log(`patched packages/mobile/android/gradle.properties: ${marker}`);
    }
  }
  fs.writeFileSync(APP_GRADLE_PROPERTIES, source);
}

// RN 0.87's AGP 9.2.1 requires Gradle >=9.4.1 but expo-prebuild generates the wrapper
// pinning 9.3.1 — bump the distributionUrl so a fresh `prebuild --clean` dir still works.
const WRAPPER_PROPS = path.resolve(__dirname, '../packages/mobile/android/gradle/wrapper/gradle-wrapper.properties');
if (fs.existsSync(WRAPPER_PROPS)) {
  const source = fs.readFileSync(WRAPPER_PROPS, 'utf8');
  const patched = source.replace(
    /distributionUrl=.*gradle-9\.(0|1|2|3)(?:\.\d+)?-/,
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.4.1-',
  );
  if (patched !== source) {
    fs.writeFileSync(WRAPPER_PROPS, patched);
    console.log('patched gradle-wrapper.properties: distributionUrl -> gradle-9.4.1');
  }
}

// The prebuild-generated app build applies KGP directly — same collision, but the file
// lives in the repo (packages/mobile/android is wiped by `expo prebuild --clean`, so
// this must run at install time too, not just once by hand).
const APP_BUILD_GRADLE = path.resolve(__dirname, '../packages/mobile/android/app/build.gradle');
if (fs.existsSync(APP_BUILD_GRADLE)) {
  const source = fs.readFileSync(APP_BUILD_GRADLE, 'utf8');
  const patched = source.replace(
    /^(\s*)apply plugin:\s*["']org\.jetbrains\.kotlin\.android["']\s*$/gm,
    '$1// kotlin-android apply removed by scripts/patch-react-native-rn087.cjs — AGP 9 built-in Kotlin',
  );
  if (patched !== source) {
    fs.writeFileSync(APP_BUILD_GRADLE, patched);
    console.log('patched packages/mobile/android/app/build.gradle: removed kotlin-android apply');
  }
}
