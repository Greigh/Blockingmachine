/**
 * Two test environments, declared as two projects rather than one switched mid-suite.
 *
 * The extension has always been tested in `node` — the background worker, the content
 * scripts and the shared helpers are all server-side logic, and a DOM would only let a
 * test quietly depend on one. The popup is the opposite: it is a React tree, and its
 * behaviour lives in event handlers. `renderToStaticMarkup` covers the markup (there is a
 * 227-line suite for the element-scan panel built on it) but a static render has no event
 * loop, so a handler is never fired and a component that passes every markup assertion can
 * still be wired to the wrong callback.
 *
 * So the two live side by side and neither can drift into the other:
 *
 *   - `node` (.ts)  — the default, unchanged. If a background test starts reaching for
 *     `document`, it fails here rather than passing because a DOM happened to be around.
 *   - `dom` (.tsx)  — jsdom plus @testing-library/react, for components.
 *
 * Splitting on file extension rather than a per-file `@jest-environment` docblock is
 * deliberate: the environment a test runs in should be readable from the test's path, and
 * the setup file (jest-dom matchers, React's act environment) must not load into the node
 * project, where `@testing-library/jest-dom` has nothing to attach to.
 */

/** Shared by both projects, so a core change cannot diverge between them. */
const moduleNameMapper = {
  // The element half of the Mini-AI is shared with the desktop app through core;
  // tests run it from source so a core change cannot silently diverge here.
  '^@blockingmachine/core/element-ai$': '<rootDir>/../core/src/ai/elementClassifier.ts',
  // The domain half, for the same reason — and because the tier/model agreement suite exists
  // precisely to notice a core change that would stop agreeing with the shipped tiers.
  '^@blockingmachine/core/domain-ai$': '<rootDir>/../core/src/ai/MiniAiClassifier.ts',
  // The rule→host reader the benefit fallback shares with the tier compiler — from source,
  // so a change to what counts as a host cannot diverge between the two.
  '^@blockingmachine/core/ruleHost$': '<rootDir>/../core/src/ruleHost.ts',
  // The tier-id vocabulary the ledger export validates against — from source, so a tier
  // rename cannot leave the popup counting against a stale list.
  '^@blockingmachine/core/tiers$': '<rootDir>/../core/src/tiers.ts',
  '^(\\.{1,2}/.*)\\.js$': '$1',
};

const transform = {
  '^.+\\.tsx?$': [
    'ts-jest',
    {
      useESM: true,
      diagnostics: {
        // 151002: ts-jest's "esModuleInterop" advisory, which this package sets on purpose.
        ignoreCodes: [151002],
      },
    },
  ],
};

const base = {
  preset: 'ts-jest/presets/default-esm',
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  moduleNameMapper,
  transform,
};

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      ...base,
      displayName: 'node',
      testEnvironment: 'node',
      testMatch: ['**/*.test.ts'],
      extensionsToTreatAsEsm: ['.ts'],
    },
    {
      ...base,
      displayName: 'dom',
      // The environment exists for components. `restoreMocks` is on because a component
      // test that leaks a spy into the next test is a test that passes for the wrong
      // reason, and cleanup is cheaper than diagnosing it.
      testEnvironment: 'jsdom',
      testMatch: ['**/*.test.tsx'],
      extensionsToTreatAsEsm: ['.ts', '.tsx'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.dom.cjs'],
      restoreMocks: true,
    },
  ],
};
