module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    // The element half of the Mini-AI is shared with the desktop app through core;
    // tests run it from source so a core change cannot silently diverge here.
    "^@blockingmachine/core/element-ai$": "<rootDir>/../core/src/ai/elementClassifier.ts",
    // The domain half, for the same reason — and because the tier/model agreement suite exists
    // precisely to notice a core change that would stop agreeing with the shipped tiers.
    "^@blockingmachine/core/domain-ai$": "<rootDir>/../core/src/ai/MiniAiClassifier.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
};
