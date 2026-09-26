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

// 2. Registrable Domain & Hostname Reputation, Brand Spoof & Anti-Adblock
export {
  HIGH_ABUSE_TLDS,
  SUSPICIOUS_AD_TOKENS,
  SUSPICIOUS_TRACKER_TOKENS,
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
  adjustThreatCategory,
  clampConfidencePercent,
  formatConfidencePercent,
  verdictBadgeLabel,
} from './reputation.js';

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
  type MiniAiClassifierOptions,
} from './MiniAiClassifier.js';

// 8. AI Detector Multi-Provider Service Orchestrator
export {
  AiDetectorService,
  isSafePublicWebUrl,
  type SafeUrlCheckResult,
} from './AiDetectorService.js';
