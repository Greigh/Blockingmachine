// react-native ≥0.87 vendors Meta's PREBUILT hermesvm.xcframework, which ships
// without dSYMs — every iOS archive then warns "the archive did not include a
// dSYM for hermesvm.framework" at export. Meta publishes them as a separate
// `hermes-framework-dSYM-{debug,release}` tarball on Maven that the podspec
// never fetches. Two upstream code paths are patched:
//
// 1. utils/build-apple-framework.sh — the from-source path
//    (RCT_BUILD_HERMES_FROM_SOURCE). build_apple_framework() dsymutil's each
//    platform slice, but create_universal_framework() runs
//    `xcodebuild -create-xcframework` WITHOUT -debug-symbols and discards
//    them. Pair each -framework arg with its -debug-symbols path.
//
// 2. utils/replace_hermes_version.js — the prebuilt path every consumer hits.
//    The script phase runs on EVERY build; whenever the last configuration
//    differs it rm -rf's Pods/hermes-engine and re-extracts the plain
//    tarball, wiping any install-time merge. mergeHermesDsyms() re-applies
//    the merge after each extraction (and on config-match runs where a
//    previous wipe left the xcframework bare). The dSYM tarball caches
//    beside the framework tarballs in Pods/hermes-engine-artifacts/.
const fs = require('fs');
const path = require('path');

const utilsDir = path.resolve(
  __dirname,
  '../node_modules/react-native/sdks/hermes-engine/utils',
);

if (!fs.existsSync(utilsDir)) {
  console.log('patch-react-native-hermes-dsym: react-native not installed, skipping');
  process.exit(0);
}

// ── 1. build-apple-framework.sh ────────────────────────────────────────────
{
  const target = path.join(utilsDir, 'build-apple-framework.sh');
  const src = fs.readFileSync(target, 'utf8');
  const needle = '    args+="-framework $hermes_framework_path "\n';
  const patched =
    needle +
    '    if [[ -d "${platform}/hermesvm.framework.dSYM" ]]; then\n' +
    '      args+="-debug-symbols ${platform}/hermesvm.framework.dSYM "\n' +
    '    fi\n';
  if (src.includes('-debug-symbols')) {
    console.log('patch-react-native-hermes-dsym: build-apple-framework.sh already patched');
  } else if (!src.includes(needle)) {
    console.warn(
      'patch-react-native-hermes-dsym: upstream create_universal_framework drifted — re-check the patch',
    );
  } else {
    fs.writeFileSync(target, src.replace(needle, patched));
    console.log('patch-react-native-hermes-dsym: -debug-symbols added to create_universal_framework');
  }
}

// ── 2. replace_hermes_version.js ───────────────────────────────────────────
{
  const target = path.join(utilsDir, 'replace_hermes_version.js');
  const src = fs.readFileSync(target, 'utf8');
  if (src.includes('mergeHermesDsyms')) {
    console.log('patch-react-native-hermes-dsym: replace_hermes_version.js already patched');
  } else {
    const hookNeedle =
      '  replaceHermesConfiguration(configuration, version, podsRoot);\n' +
      '  updateLastBuildConfiguration(configuration);\n';
    const hookPatched = hookNeedle + '  mergeHermesDsyms(configuration, version, podsRoot);\n';
    if (!src.includes(hookNeedle)) {
      console.warn(
        'patch-react-native-hermes-dsym: upstream main() drifted — re-check the patch',
      );
      process.exit(0);
    }
    const helper = `
// [Blockingmachine] Re-merge Meta's published hermesvm dSYMs after a
// configuration swap — the freshly extracted xcframework ships none, so the
// archive would warn "did not include a dSYM for hermesvm.framework". The
// tarball caches beside the framework tarballs the podspec already keeps.
function mergeHermesDsyms(configuration, version, podsRoot) {
  const artifactsDir = \`\${podsRoot}/hermes-engine-artifacts\`;
  const tarballName = \`hermes-ios-\${version}-hermes-framework-dSYM-\${configuration.toLowerCase()}.tar.gz\`;
  const tarballPath = \`\${artifactsDir}/\${tarballName}\`;
  if (!fs.existsSync(tarballPath)) {
    fs.mkdirSync(artifactsDir, {recursive: true});
    const mirrors = [
      'https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios',
      'https://repo.reactnative.dev/maven2/com/facebook/hermes/hermes-ios',
    ];
    for (const root of mirrors) {
      const res = spawnSync(
        'curl',
        ['-fsSL', '--connect-timeout', '20', \`\${root}/\${version}/\${tarballName}\`, '-o', tarballPath],
        {stdio: 'inherit'},
      );
      if (res.status === 0 && fs.existsSync(tarballPath)) break;
    }
    if (!fs.existsSync(tarballPath) || fs.statSync(tarballPath).size < 1024) {
      fs.rmSync(tarballPath, {force: true});
      console.warn('[bm-dsym] dSYM tarball unavailable — archive will keep the missing-dSYM warning');
      return;
    }
  }
  const extractDir = \`\${artifactsDir}/dsym-extract-\${configuration.toLowerCase()}\`;
  fs.rmSync(extractDir, {force: true, recursive: true});
  fs.mkdirSync(extractDir, {recursive: true});
  const platforms = {iphoneos: 'ios-arm64', iphonesimulator: 'ios-arm64_x86_64-simulator'};
  const res = spawnSync('tar', ['-xzf', tarballPath, '-C', extractDir, ...Object.keys(platforms)], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    console.warn('[bm-dsym] dSYM tarball extraction failed');
    return;
  }
  const xcDir = \`\${podsRoot}/hermes-engine/destroot/Library/Frameworks/universal/hermesvm.xcframework\`;
  const plistPath = \`\${xcDir}/Info.plist\`;
  for (const [platform, slice] of Object.entries(platforms)) {
    const dsymSrc = \`\${extractDir}/\${platform}/hermesvm.framework.dSYM\`;
    const sliceDir = \`\${xcDir}/\${slice}\`;
    if (!fs.existsSync(dsymSrc) || !fs.existsSync(sliceDir)) continue;
    fs.mkdirSync(\`\${sliceDir}/dSYMs\`, {recursive: true});
    fs.cpSync(dsymSrc, \`\${sliceDir}/dSYMs/hermesvm.framework.dSYM\`, {recursive: true});
    for (let idx = 0; idx < 16; idx++) {
      const probe = spawnSync('/usr/libexec/PlistBuddy', [
        '-c', \`Print :AvailableLibraries:\${idx}:LibraryIdentifier\`, plistPath,
      ]);
      const id = probe.stdout?.toString().trim();
      if (!id) break;
      if (id !== slice) continue;
      const existing = spawnSync('/usr/libexec/PlistBuddy', [
        '-c', \`Print :AvailableLibraries:\${idx}:DebugSymbolsPath\`, plistPath,
      ]);
      if (existing.status !== 0) {
        spawnSync('/usr/libexec/PlistBuddy', [
          '-c', \`Add :AvailableLibraries:\${idx}:DebugSymbolsPath string\`, 'dSYMs', plistPath,
        ]);
      }
      break;
    }
  }
  console.log('[bm-dsym] merged hermesvm.framework.dSYM into the vendored xcframework');
}
`;
    fs.writeFileSync(target, src.replace(hookNeedle, hookPatched) + helper);
    console.log('patch-react-native-hermes-dsym: mergeHermesDsyms added to replace_hermes_version.js');
  }
}
