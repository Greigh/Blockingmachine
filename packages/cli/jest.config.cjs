module.exports = {
  // Use the ESM-aware preset for ts-jest when the package uses ESM
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // The hot-set suites replay the real 249,000-line export, and one `beforeAll` in
  // `hotlist-equivalence.test.ts` spends ~19s deciding 232 requests against it. That work is
  // synchronous, so Jest's timer cannot interrupt it and it runs to completion; but it occupies a
  // core, and an *async* test in a sibling worker can be starved past the 5s default while it
  // does. `DoctorCommand` was failing that way intermittently, for no reason of its own. 60s
  // absorbs the contention and still catches a real hang.
  testTimeout: 60000,
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.json' }],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@blockingmachine/core$': '<rootDir>/../core/src/index.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};