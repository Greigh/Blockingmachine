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
