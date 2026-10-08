module.exports = {
  preset: 'jest-expo',
  setupFiles: ['./jest.setup.ts'],
  moduleNameMapper: {
    // expo-modules-core is nested under expo/node_modules by npm (its peerOptional
    // worklets range conflicts with our RN 0.87 tree when hoisted); map it through.
    '^expo-modules-core$': '<rootDir>/../../node_modules/expo/node_modules/expo-modules-core',
    '^expo-modules-core/(.*)$': '<rootDir>/../../node_modules/expo/node_modules/expo-modules-core/$1',
    // npm update/prune wipes the postinstall-written @react-native/assets-registry
    // stub without re-running postinstall — resolve the import jest-expo's setup
    // needs straight to RN 0.87's real module so the suite survives stub loss.
    '^@react-native/assets-registry/registry$': '<rootDir>/../../node_modules/react-native/src/asset-registry.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-native-async-storage)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@tanstack/.*|react-native-url-polyfill|react-native-zeroconf)',
  ],
  testMatch: ['**/__tests__/**/*.test.(ts|tsx)'],
};
