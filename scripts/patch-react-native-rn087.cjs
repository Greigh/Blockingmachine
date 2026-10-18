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

// npm may nest a dep under its dependent's node_modules instead of hoisting to the
// root — observed with expo-modules-core landing at expo/node_modules/ once its
// peerOptional react-native-worklets range became unsatisfiable at the root level.
// All patch targets below must resolve through the real install dir or they are
// skipped silently while the build breaks.
const pkgDirCache = new Map();
function pkgDir(name) {
  const cached = pkgDirCache.get(name);
  if (cached) return cached;
  const direct = path.join(nm, name);
  let found = direct;
  if (!fs.existsSync(path.join(direct, 'package.json'))) {
    const queue = fs.readdirSync(nm, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules')
      .flatMap((e) =>
        e.name.startsWith('@')
          ? fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })
              .filter((s) => s.isDirectory())
              .map((s) => path.join(nm, e.name, s.name))
          : [path.join(nm, e.name)],
      );
    for (const candidateDir of queue) {
      const nested = path.join(candidateDir, 'node_modules', name);
      if (fs.existsSync(path.join(nested, 'package.json'))) {
        found = nested;
        break;
      }
    }
  }
  pkgDirCache.set(name, found);
  return found;
}
function resolveInNm(rel) {
  const direct = path.join(nm, rel);
  if (fs.existsSync(direct)) return direct;
  const segs = rel.split('/');
  const pkgName = segs[0].startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
  const rest = segs.slice(pkgName === segs[0] ? 1 : 2).join('/');
  return path.join(pkgDir(pkgName), rest);
}

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
      "// react-native/src/private/assets/AssetRegistry. The deep path matters: the\n" +
      "// package-exports alias ('react-native/asset-registry') bundles as a *second*\n" +
      "// module record under Metro, which split the registry into two arrays and\n" +
      "// broke Asset.fromModule with 'Cannot read property uri of null'.\n" +
      "module.exports = require('react-native/src/private/assets/AssetRegistry');\n",
  );
  console.log('patched react-native: wrote @react-native/assets-registry stub package');
}

// Belt-and-braces for a split-brain registry observed empirically on RN 0.87 +
// expo 57 dev builds: `@expo/cli`'s resolver intercepts
// `@react-native/assets-registry/registry` and substitutes a *virtual polyfill
// module* with its own `assets` array (withMetroMultiPlatform.js), while RN's
// own resolveAssetSource reads src/private/assets/AssetRegistry.js. Two arrays
// meant `Asset.fromModule` resolved meta but got `uri of null` downstream —
// every expo-font/vector-icons load red-boxed. Back BOTH stores with one
// globalThis singleton so the module records converge regardless.
const ASSET_REGISTRY_FILE = resolveInNm('react-native/src/private/assets/AssetRegistry.js');
if (fs.existsSync(ASSET_REGISTRY_FILE)) {
  const source = fs.readFileSync(ASSET_REGISTRY_FILE, 'utf8');
  if (source.includes('const assets: Array<PackagerAsset> = [];')) {
    const patched = source.replace(
      'const assets: Array<PackagerAsset> = [];',
      "// Patched in by scripts/patch-react-native-rn087.cjs — global singleton because\n" +
        '// @expo/cli virtual-polyfills the registry under a separate module record.\n' +
        'const assets: Array<PackagerAsset> = (globalThis.__bmAssetRegistry ||= []);',
    );
    fs.writeFileSync(ASSET_REGISTRY_FILE, patched);
    console.log('patched react-native AssetRegistry: singleton asset array');
  }
}
const EXPO_CLI_MMP = resolveInNm('@expo/cli/build/src/start/server/metro/withMetroMultiPlatform.js');
if (fs.existsSync(EXPO_CLI_MMP)) {
  const source = fs.readFileSync(EXPO_CLI_MMP, 'utf8');
  const needle =
    'const ASSET_REGISTRY_SRC = `const assets=[];module.exports={registerAsset:s=>assets.push(s),getAssetByID:s=>assets[s-1]};`;';
  if (source.includes(needle)) {
    const patched = source.replace(
      needle,
      'const ASSET_REGISTRY_SRC = `const assets=globalThis.__bmAssetRegistry||(globalThis.__bmAssetRegistry=[]);' +
        "module.exports={registerAsset:s=>assets.push(s),getAssetByID:s=>assets[s-1]};`; // singleton shared with react-native/src/private/assets/AssetRegistry — patched by scripts/patch-react-native-rn087.cjs",
    );
    fs.writeFileSync(EXPO_CLI_MMP, patched);
    console.log('patched @expo/cli asset-registry polyfill: singleton asset array');
  }
}

// Every expo-* package ships a tsconfig.json extending "expo-module-scripts/tsconfig.base",
// a dev-only package npm never installs for consumers — so the IDE flags that file when
// it's opened. A minimal stub satisfies the resolution; nothing actually compiles through
// it (the workspace tsconfig excludes node_modules entirely).
const emsPkg = path.join(nm, 'expo-module-scripts');
if (!fs.existsSync(path.join(emsPkg, 'tsconfig.base.json'))) {
  fs.mkdirSync(emsPkg, { recursive: true });
  fs.writeFileSync(
    path.join(emsPkg, 'package.json'),
    JSON.stringify(
      { name: 'expo-module-scripts', version: '0.0.0', private: true },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(emsPkg, 'tsconfig.base.json'),
    JSON.stringify(
      {
        // Patched in by scripts/patch-react-native-rn087.cjs — IDE-only stub.
        compilerOptions: {
          strict: true,
          jsx: 'react-native',
          module: 'esnext',
          target: 'esnext',
          moduleResolution: 'bundler',
          skipLibCheck: true,
        },
      },
      null,
      2,
    ) + '\n',
  );
  console.log('patched node_modules: wrote expo-module-scripts tsconfig.base stub');
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
  const ktsPath = resolveInNm(rel);
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
// RN 0.88 / Expo SDK 58 templates emit `android.builtInKotlin=false` and gate their
// own applies on `if (!builtInKotlin)` — the apply must run there, not be stripped.
// So every bare/stripped apply becomes an explicitly gated apply: applies when
// built-in Kotlin is off, skips when AGP owns 'kotlin'. Both already-stripped
// marker lines and any surviving live applies are rewritten in one pass.
const KOTLIN_APPLY_OR_STRIP_RE =
  /^(\s*)(?:apply plugin:\s*["'](?:org\.jetbrains\.kotlin\.)?kotlin-android["']|plugins\.apply\("(?:org\.jetbrains\.kotlin\.)?kotlin-android"\)|apply\(plugin = "org\.jetbrains\.kotlin\.android"\)|\/\/ kotlin-android apply (?:removed|gated) by scripts\/patch-react-native-rn087\.cjs[^\n]*)\s*$/gm;
for (const rel of KOTLIN_ANDROID_APPLY_SITES) {
  const filePath = resolveInNm(rel);
  if (!fs.existsSync(filePath)) continue;
  const source = fs.readFileSync(filePath, 'utf8');
  if (source.includes('apply gated by scripts/patch-react-native-rn087.cjs')) continue;
  const isKts = rel.endsWith('.kts') || rel.endsWith('.kt');
  const gated = isKts
    ? '$1// kotlin-android apply gated by scripts/patch-react-native-rn087.cjs — AGP 9 built-in Kotlin registers `kotlin` itself\n' +
      '$1if (!((findProperty("android.builtInKotlin") as? String)?.toBoolean() ?: true)) {\n' +
      '$1    plugins.apply("org.jetbrains.kotlin.android")\n' +
      '$1}'
    : '$1// kotlin-android apply gated by scripts/patch-react-native-rn087.cjs — AGP 9 built-in Kotlin registers `kotlin` itself\n' +
      "$1if (!((project.findProperty('android.builtInKotlin') ?: 'true') as String).toBoolean()) {\n" +
      "$1    apply plugin: 'org.jetbrains.kotlin.android'\n" +
      '$1}';
  const patched = source.replace(KOTLIN_APPLY_OR_STRIP_RE, gated);
  if (patched !== source) {
    fs.writeFileSync(filePath, patched);
    console.log(`patched ${rel}: gated kotlin-android application on builtInKotlin`);
  }
}

// Companion restore: under a tree where built-in Kotlin IS enabled the Swmansion
// scripts' unconditional `extensions.configure<KotlinAndroidProjectExtension>` can
// still die (the external plugin never applies). Gate it the same way so the block
// is correct under either `android.builtInKotlin` value.
const KGP_EXTENSION_CONFIG_RE =
  /if \(project != rootProject\) \{\s*\n\s*extensions\.configure<org\.jetbrains\.kotlin\.gradle\.dsl\.KotlinAndroidProjectExtension> \{\s*\n\s*compilerOptions \{\s*\n\s*jvmTarget = JvmTarget\.fromTarget\("([^"]+)"\)\s*\n\s*\}\s*\n\s*\}\s*\n\}/g;
for (const rel of ['react-native-reanimated/android/build.gradle.kts', 'react-native-worklets/android/build.gradle.kts']) {
  const filePath = resolveInNm(rel);
  if (!fs.existsSync(filePath)) continue;
  const source = fs.readFileSync(filePath, 'utf8');
  const patched = source.replace(
    KGP_EXTENSION_CONFIG_RE,
    '// KGP-extension configure gated by scripts/patch-react-native-rn087.cjs — the\n' +
      '// extension only exists when kotlin-android applied (builtInKotlin=false).\n' +
      'if (project != rootProject && (findProperty("android.builtInKotlin") as? String)?.toBoolean() == false) {\n' +
      '    extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension> {\n' +
      '        compilerOptions {\n' +
      '            jvmTarget = JvmTarget.fromTarget("$1")\n' +
      '        }\n' +
      '    }\n' +
      '}',
  );
  if (patched !== source) {
    fs.writeFileSync(filePath, patched);
    console.log(`patched ${rel}: gated KotlinAndroidProjectExtension configure on builtInKotlin`);
  }
}
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
    file: '@expo/log-box/android/build.gradle',
    skipIf: 'kotlin.srcDirs += "src/main"',
    replacements: [
      // Kotlin sources live in src/main/ and were registered via java.srcDirs —
      // built-in Kotlin never compiles them. Register the same dir on kotlin.srcDirs.
      [
        '      java.srcDirs += "src/main"',
        '      java.srcDirs += "src/main"\n      kotlin.srcDirs += "src/main"',
      ],
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
    skipIf: '.kotlin\n        .srcDirs(getPackageListDir(project)',
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
      // Built-in Kotlin compiles kotlin.srcDirs, not java.srcDirs — the generated
      // ExpoModulesPackageList + inline modules must register on both or they are
      // never compiled (runtime ClassNotFoundException at app launch).
      [
        `.java\n        .srcDirs(getPackageListDir(project), getInlineModulesDir(project))`,
        `.java\n        .srcDirs(getPackageListDir(project), getInlineModulesDir(project))\n      ext\n        .sourceSets\n        .getByName("main")\n        .kotlin\n        .srcDirs(getPackageListDir(project), getInlineModulesDir(project))`,
      ],
    ],
  },
];
for (const { file, replacements, skipIf } of AGP9_SOURCE_PATCHES) {
  const filePath = resolveInNm(file);
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
function* iterModuleBuildGradles(rootDir = nm, depth = 0) {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const entryPath = path.join(rootDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const sub of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const subPath = path.join(entryPath, sub.name);
        yield subPath;
        const nested = path.join(subPath, 'node_modules');
        if (depth === 0 && fs.existsSync(nested)) yield* iterModuleBuildGradles(nested, 1);
      }
    } else {
      yield entryPath;
      const nested = path.join(entryPath, 'node_modules');
      if (depth === 0 && fs.existsSync(nested)) yield* iterModuleBuildGradles(nested, 1);
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

// The gated apply line shared by the app-module injections below and
// plugins/withReleaseSigning.js — under AGP 9 built-in Kotlin the AGP builtin
// registers `kotlin` itself (reapplying throws); the Expo 58 template emits
// android.builtInKotlin=false, where external KGP must apply or no Kotlin
// compiles at all.
const APP_GATED_KOTLIN =
  "if (!((findProperty('android.builtInKotlin') ?: 'true') as String).toBoolean()) { apply plugin: 'org.jetbrains.kotlin.android' }";

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

// The prebuild-generated app build needs kotlin-android when built-in Kotlin is
// off (Expo 58 emits android.builtInKotlin=false and no apply at all — the app's
// MainActivity.kt/MainApplication.kt would never compile). Inject the gated form
// when absent, and upgrade any bare/stripped apply to it. Mirrors the identical
// logic in plugins/withReleaseSigning.js, which owns this file at prebuild time.
const APP_BUILD_GRADLE = path.resolve(__dirname, '../packages/mobile/android/app/build.gradle');
if (fs.existsSync(APP_BUILD_GRADLE)) {
  const source = fs.readFileSync(APP_BUILD_GRADLE, 'utf8');
  let patched = source.replace(
    /getDefaultProguardFile\(["']proguard-android\.txt["']\)/,
    'getDefaultProguardFile("proguard-android-optimize.txt") // AGP 9 dropped the non-optimizing default',
  );
  if (!/kotlin-android|org\.jetbrains\.kotlin\.android/.test(patched)) {
    patched = patched.replace(
      /apply plugin: "com\.facebook\.react"\s*\n/,
      `apply plugin: "com.facebook.react"\n\n${APP_GATED_KOTLIN}\n`,
    );
  } else {
    patched = patched.replace(
      /^(\s*)apply plugin:\s*["']org\.jetbrains\.kotlin\.android["']\s*$/gm,
      `$1${APP_GATED_KOTLIN}`,
    );
  }
  if (patched !== source) {
    fs.writeFileSync(APP_BUILD_GRADLE, patched);
    console.log('patched packages/mobile/android/app/build.gradle: gated kotlin-android / proguard default');
  }
}

// Sixth break, on the iOS side: RN 0.87 dropped the bridge-era members
// (newArchEnabled, createRootView(with:moduleName:initProps:), createBridge,
// loadSource(for:onProgress:onComplete:), extraModules(for:),
// extraLazyModuleClasses(for:), bridge(_:didNotFindModule:)) from the public
// surface of RCTDefaultReactNativeFactoryDelegate / RCTReactNativeFactoryDelegate
// — the new architecture is the only path left. Expo SDK 57's
// ExpoReactNativeFactory.createRCTRootViewFactory still calls every one of them,
// so the Expo pod target fails to compile. The rewrite below keeps Expo's
// ExpoReactRootViewFactory (its reactDelegate wiring feeds expo-dev-client) and
// customizeRootView fan-out, but builds the configuration exactly as
// RN 0.87's own RCTReactNativeFactory.mm does: designated initializer with
// newArchEnabled fixed YES, bridge blocks left unset, extraModulesForBridge
// still honoured dynamically via respondsToSelector for any delegate that
// implements it.
const EXPO_FACTORY_SWIFT = 'expo/ios/AppDelegates/ExpoReactNativeFactory.swift';
const expoFactoryPath = resolveInNm(EXPO_FACTORY_SWIFT);
if (fs.existsSync(expoFactoryPath)) {
  const OLD_FACTORY_CONFIG = `    let configuration = RCTRootViewFactoryConfiguration(
      bundleURLBlock: bundleUrlBlock,
      newArchEnabled: weakDelegate.newArchEnabled()
    )

    configuration.createRootViewWithBridge = { bridge, moduleName, initProps in
      return weakDelegate.createRootView(with: bridge, moduleName: moduleName, initProps: initProps)
    }

    configuration.jsRuntimeConfiguratorDelegate = delegate

    configuration.createBridgeWithDelegate = { delegate, launchOptions in
      weakDelegate.createBridge(with: delegate, launchOptions: launchOptions)
    }

    configuration.customizeRootView = { rootView in
      weakDelegate.customize(rootView)
    }

    // NOTE(kudo): \`sourceURLForBridge\` is not referenced intentionally because it does not support New Architecture.
    configuration.sourceURLForBridge = nil

    configuration.loadSourceForBridgeWithProgress = { bridge, onProgress, onComplete in
      weakDelegate.loadSource(for: bridge, onProgress: onProgress, onComplete: onComplete)
    }

    if weakDelegate.responds(to: #selector(RCTReactNativeFactoryDelegate.extraModules(for:))) {
      configuration.extraModulesForBridge = { bridge in
        weakDelegate.extraModules(for: bridge)
      }
    }

    if weakDelegate.responds(to: #selector(RCTReactNativeFactoryDelegate.extraLazyModuleClasses(for:))) {
      configuration.extraLazyModuleClassesForBridge = { bridge in
        weakDelegate.extraLazyModuleClasses(for: bridge)
      }
    }

    if weakDelegate.responds(to: #selector(RCTReactNativeFactoryDelegate.bridge(_:didNotFindModule:))) {
      configuration.bridgeDidNotFindModule = { bridge, moduleName in
        weakDelegate.bridge(bridge, didNotFindModule: moduleName)
      }
    }
`;
  const NEW_FACTORY_CONFIG = `    // Patched by scripts/patch-react-native-rn087.cjs — RN 0.87 removed the
    // bridge-era delegate members; the new architecture is the only path, so the
    // configuration mirrors RCTReactNativeFactory.mm's own implementation.
    let configuration = RCTRootViewFactoryConfiguration(
      bundleURLBlock: bundleUrlBlock,
      newArchEnabled: true
    )

    configuration.jsRuntimeConfiguratorDelegate = delegate

    configuration.customizeRootView = { rootView in
      weakDelegate.customize(rootView)
    }

    // NOTE(kudo): \`sourceURLForBridge\` is not referenced intentionally because it does not support New Architecture.
    configuration.sourceURLForBridge = nil

    // extraModulesForBridge: left the delegate protocol but is still honoured
    // dynamically, matching RCTReactNativeFactory.mm's respondsToSelector path.
    let extraModulesSel = NSSelectorFromString("extraModulesForBridge:")
    if weakDelegate.responds(to: extraModulesSel) {
      configuration.extraModulesForBridge = { bridge in
        (weakDelegate.perform(extraModulesSel, with: bridge)?.takeUnretainedValue() as? [RCTBridgeModule]) ?? []
      }
    }
`;
  let source = fs.readFileSync(expoFactoryPath, 'utf8');
  if (source.includes(OLD_FACTORY_CONFIG)) {
    source = source.replace(OLD_FACTORY_CONFIG, NEW_FACTORY_CONFIG);
    fs.writeFileSync(expoFactoryPath, source);
    console.log('patched expo: ExpoReactNativeFactory.swift createRCTRootViewFactory for RN 0.87');
  } else if (!source.includes('Patched by scripts/patch-react-native-rn087.cjs')) {
    console.warn('patch-react-native-rn087: ExpoReactNativeFactory.swift shape changed — manual review needed');
  }
}
