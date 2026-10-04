/**
 * Learned GBDT classifier (trained offline in Python, served here).
 *
 * "Python trains, TypeScript serves": the weights in ai-weights/ were
 * produced by the training pipeline; this module is the inference side.
 * See the training package README for the feature contract.
 *
 * @packageDocumentation
 * @beta
 */

export {
  LEARNED_FEATURE_VERSION,
  LEARNED_FEATURE_NAMES,
  LEARNED_FEATURE_NAMES_V2,
  LEARNED_V1_FEATURE_COUNT,
  LEARNED_TOKENS,
  LEARNED_COMMON_TLDS,
  LEARNED_SUSPICIOUS_TLDS,
  LEARNED_BIGRAM_LOG_PROBS,
} from './featureSpec.js';

export {
  normalizeLearnedDomain,
  featurizeLearned,
  isIpLiteralAddress,
  type BehavioralObservation,
} from './featurizer.js';

export { evaluateGbdt, type GbdtModelFile, type GbdtNode } from './gbdt.js';

export {
  createLearnedClassifier,
  parseLearnedModel,
  parseLearnedAllowlist,
  type LearnedClassifier,
  type LearnedDecision,
  type LearnedThresholds,
  type LearnedVerdict,
  type LearnedAllowlistFile,
} from './modelLoader.js';

export {
  LEARNED_SHADOW_SAMPLE_RATE,
  runShadowComparison,
  type ShadowDisagreement,
  type ShadowReference,
  type ShadowRunOptions,
  type ShadowRunResult,
  type ShadowSample,
} from './shadowMode.js';

export {
  parseLearnedManifest,
  verifyLearnedManifest,
  type LearnedManifest,
} from './manifest.js';

export { sha256Hex } from './sha256.js';
