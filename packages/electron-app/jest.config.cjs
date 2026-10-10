/**
 * Two test environments, declared as two projects rather than one switched mid-suite —
 * the same split `packages/browser-extension` established:
 *
 *   - `node` (.test.ts)  — the default. Main-process modules, validators and the
 *     behavioral IPC harness have no business seeing a DOM.
 *   - `dom`  (.test.tsx) — jsdom plus @testing-library/react, for React components.
 *     Lifecycle correctness (unmount guards, timer cleanup) is only observable with a
 *     real render tree and event loop.
 *
 * Splitting on file extension keeps the environment readable from the test's path.
 */

const shared = {
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.json' }],
  },
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleNameMapper: {
    '^@blockingmachine/core$': '<rootDir>/../core/src/index.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      ...shared,
      displayName: 'node',
      testEnvironment: 'node',
      testMatch: ['**/*.test.ts'],
    },
    {
      ...shared,
      displayName: 'dom',
      testEnvironment: 'jsdom',
      testMatch: ['**/*.test.tsx'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.dom.cjs'],
      restoreMocks: true,
    },
  ],
};
