/**
 * Blockingmachine AI Subsystem
 *
 * Public entry point for domain classification, DNS analysis and filter generation.
 * Use AiDetectorService for a complete scan, MiniAiClassifier for offline inference,
 * and compileRuleSet to reuse a rule index across many domain evaluations.
 * Domain-only evaluation ignores rules requiring browser request context.
 * DNS resolution and service orchestration require a Node.js runtime.
 *
 * @packageDocumentation
 * @beta
 */

// 1. Data Models, Enums & Interfaces
export * from './types.js';

// 1b. Remote reputation-db loader (manifest, patch schema, cache)
export {
  setDbDirectory,
  setDbCacheDirectory,
  applyPatch,
  normalizeDbList,
  type DbLists,
  type DbPatch,
  type DbManifest,
  type LoadedDb,
} from './db-loader.js';

// 2. Registrable Domain & Hostname Reputation, Brand Spoof & Anti-Adblock
export {
  HIGH_ABUSE_TLDS,
  SUSPICIOUS_AD_TOKENS,
  SUSPICIOUS_TRACKER_TOKENS,
  // The hand-written half of the vocabulary, on its own. The tier derivation seeds from these and
  // never from the shipped merge: the derived tokens are its output, so reading them back would
  // make each run depend on the last.
  HAND_WRITTEN_AD_TOKENS,
  HAND_WRITTEN_TRACKER_TOKENS,
  SPECIFIC_NETWORK_TOKENS,
  DICTIONARY_COMPOUND_EXEMPTIONS,
  MULTI_TENANT_PLATFORMS,
  UNTRUSTED_HOSTING_PLATFORMS,
  CDN_ROUTING_SUFFIXES,
  BRAND_ECOSYSTEMS,
  normalizeHostname,
  isInstitutionalDomain,
  isActiveDirectoryOrLocalDomain,
  detectAntiAdblock,
  isAdmiralAntiAdblock,
  classifyInfrastructure,
  hostnameHasToken,
  hasStrongAdIntent,
  isTelemetryToken,
  decodePunycodeLabel,
  normalizeHomoglyphs,
  isSameBrandEcosystem,
  scoreBrandSpoof,
  isBenignServiceEndpoint,
  hasCorroboratedMalwareSignals,
  assessCorroboration,
  clampRiskLevel,
  adjustThreatCategory,
  clampConfidencePercent,
  formatConfidencePercent,
  verdictBadgeLabel,

  // Remote hot-patch database (push list updates without an app release)
  BASE_DB_LISTS,
  getDbLists,
  refreshDb,
  getDbRefreshStatus,
  withTemporaryVocabulary,
  type DbRefreshStatus,
} from './reputation.js';

// 2b. The tier/model agreement contract and the vocabulary derived from it. The families each
// tier may be called are stated once here, so the suite that grades the shipped tiers and the
// derivation that learns from them cannot disagree about what agreement means.
export {
  TIER_MODEL_FAMILIES,
  TIER_VOCABULARY_SOURCES,
  GENERIC_VOCABULARY_LABELS,
  isUsableVocabularyToken,
  vocabularyCandidatesFor,
  tierVocabularySeeds,
  compareTierVocabularyCorpus,
  deriveTierVocabulary,
  tierVocabularyProvenance,
  renderTierVocabularyModule,
  type DeriveTierVocabularyInput,
  type TierVocabularyAttempt,
  type TierVocabularyCorpusSample,
  type TierVocabularyDerivation,
  type TierVocabularyEvidence,
  type TierVocabularyProvenance,
  type TierVocabularyRejection,
  type TierVocabularySeed,
  type TierVocabularySeedCoverage,
  type TierVocabularySeedSet,
} from './tierVocabularyDerivation.js';

export type {
  CorroborationAssessment,
  CorroborationTier,
  EvidenceFamily,
} from './types.js';

// 3. Shannon Entropy, DGA Heuristics & Domain Decomposition
export {
  clearEntropyCache,
  calculateShannonEntropy,
  decomposeDomain,
  detectDgaPatterns,
  BENIGN_STRUCTURAL_PREFIXES,
  FOUR_PART_PUBLIC_SUFFIXES,
  THREE_PART_PUBLIC_SUFFIXES,
  COMPOUND_CCTLDS,
  DYNAMIC_DNS_SUFFIXES,
} from './entropy.js';

// 4. CNAME Resolution, Recursive Cloak Tracing & Network Graph
export {
  KNOWN_CLOAKED_TARGETS,
  BENIGN_SAAS_CNAMES,
  TRACKING_SUBDOMAIN_PATTERN,
  isTrackingSubdomain,
  isBenignCnameTarget,
  getCnameCacheStats,
  clearCnameCache,
  resolveCnameChain,
} from './cnameResolver.js';

// 5. Filter Rule Synthesizer, Coverage Trie & Conflict Solver
export {
  sanitizeDomain,
  RuleCoverageTrie,
  isDomainCoveredByRules,
  synthesizeAntiAdblockDefusers,
  synthesizeAdmiralDefusers,
  synthesizeRules,
  synthesizeAllowlistRule,
  isValidParentZone,
  compactSubdomainRules,
  checkRuleConflict,
} from './ruleSynthesizer.js';

// 6. RFC/Adblock Domain Evaluator & Precedence Engine
export {
  CompiledDomainRuleSet,
  compileRuleSet,
  evaluateDomainRules,
  isDomainBlocked,
  findWinningRule,
  type ParsedRuleEntry,
} from './domainEvaluator.js';

// 7. Embedded Mini-AI Machine Learning Classifier
export {
  MiniAiClassifier,
  globalMiniAiClassifier,
  classifyDomainWithMiniAi,
  extractDomainFeatures,
  getRegistrableZone,
  type MiniAiClassifierOptions,
} from './MiniAiClassifier.js';

// 7a. Embedded Mini-AI Element Classifier (DOM snapshots: ad / tracker / nag / content)
export {
  ELEMENT_CLASSES,
  ELEMENT_ACTIONS,
  ELEMENT_SOURCE_KINDS,
  ELEMENT_AD_STRONG_TOKENS,
  ELEMENT_AD_WEAK_TOKENS,
  ELEMENT_TRACKER_STRONG_TOKENS,
  ELEMENT_TRACKER_WEAK_TOKENS,
  ELEMENT_CONSENT_STRONG_MARKERS,
  ELEMENT_CONSENT_WEAK_TOKENS,
  ELEMENT_NAG_MARKERS,
  ELEMENT_SOCIAL_STRONG_MARKERS,
  ELEMENT_SOCIAL_WEAK_TOKENS,
  ELEMENT_ANTI_ADBLOCK_PHRASES,
  ELEMENT_LURE_PHRASES,
  ELEMENT_SOURCE_HOST_KINDS,
  ELEMENT_URL_PATH_TOKENS,
  ELEMENT_URL_PATH_VENDOR_PATH_TOKENS,
  ELEMENT_MODEL_WEIGHTS,
  IAB_AD_SIZES,
  MiniAiElementClassifier,
  globalMiniAiElementClassifier,
  classifyElementWithMiniAi,
  normalizeElementSnapshot,
  extractElementFeatures,
  analyzeElement,
  assessElementEvidence,
  adjustElementClass,
  elementSignature,
  tokenizeElementIdentifier,
  matchSourceHostKind,
  hostOfUrl,
  isElementSnapshot,
  type ElementClass,
  type ElementAction,
  type ElementSourceKind,
  type ElementEvidenceFamily,
  type ElementSnapshot,
  type ElementFeatureVector,
  type ElementFeatureName,
  type ElementFeatureAnalysis,
  type ElementEvidenceDetails,
  type ElementEvidenceAssessment,
  type ElementPrediction,
  type MiniAiElementClassifierOptions,
} from './elementClassifier.js';

// 7d. Corpus candidates harvested from real pages. A model's verdict is provenance, not a
// label, so nothing here can label a candidate and nothing here is imported by the harness
// that grades `ELEMENT_EVAL_CORPUS`.
export {
  HARVEST_TEXT_LIMIT,
  HARVEST_DEFAULT_MAX_AGE_DAYS,
  HARVEST_DEFAULT_PER_HOST,
  HARVEST_DEFAULT_TOTAL,
  isHarvestedHumanDecision,
  redactHarvestSnapshot,
  harvestCandidateId,
  sanitizeHarvestedElement,
  sanitizeHarvestedElements,
  renderHarvestFile,
  parseHarvestFile,
  selectHarvestCandidates,
  proposeHarvestEvalCase,
  formatHarvestReport,
  type HarvestedVerdict,
  type HarvestedHumanDecision,
  type HarvestedElement,
  type SanitizedHarvestedElement,
  type ElementHarvestCandidate,
  type ElementHarvestOptions,
  type ElementHarvestSelection,
} from './elementCorpusHarvest.js';

// 7c. Triage Cascade (screen everything locally, escalate only the undecided)
export {
  HIGH_PRECISION_FAMILIES,
  DEFAULT_TRIAGE_OPTIONS,
  assessAmbiguity,
  planTriage,
  mergeTriageVerdict,
  mergeTriageVerdicts,
  summarizeTriage,
  type TriageCandidate,
  type TriageSignals,
  type TriageReasonCode,
  type AmbiguityAssessment,
  type TriageAction,
  type TriageItem,
  type TriageStats,
  type TriagePlan,
  type TriageOptions,
  type EscalationVerdict,
  type TriageVerdict,
  type TriageVerdictSource,
} from './triage.js';

// 7b. Behavioral DNS Stream Analysis (fan-out & beaconing cadence)
export {
  analyzeQueryBehavior,
  escalateRiskWithBehavior,
  type BehavioralDomainInsight,
} from './behavioral.js';

// 8. AI Detector Multi-Provider Service Orchestrator
export {
  AiDetectorService,
  selectThirdPartyCandidates,
  isSafePublicWebUrl,
  type SafeUrlCheckResult,
} from './AiDetectorService.js';

// 9. Learned GBDT Classifier (trained offline in Python, served here)
export {
  LEARNED_FEATURE_VERSION,
  LEARNED_FEATURE_NAMES,
  LEARNED_FEATURE_NAMES_V2,
  LEARNED_V1_FEATURE_COUNT,
  LEARNED_TOKENS,
  LEARNED_COMMON_TLDS,
  LEARNED_SUSPICIOUS_TLDS,
  LEARNED_BIGRAM_LOG_PROBS,
  normalizeLearnedDomain,
  featurizeLearned,
  isIpLiteralAddress,
  evaluateGbdt,
  createLearnedClassifier,
  parseLearnedModel,
  parseLearnedAllowlist,
  parseLearnedManifest,
  verifyLearnedManifest,
  sha256Hex,
  runShadowComparison,
  type BehavioralObservation,
  type GbdtModelFile,
  type GbdtNode,
  type LearnedClassifier,
  type LearnedDecision,
  type LearnedThresholds,
  type LearnedVerdict,
  type LearnedAllowlistFile,
  type LearnedManifest,
  type ShadowDisagreement,
  type ShadowReference,
  type ShadowRunOptions,
  type ShadowRunResult,
  type ShadowSample,
} from './learned/index.js';
