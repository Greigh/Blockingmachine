// Config exports
export { defaultFilterMeta, type FilterMetaConfig } from "./config/meta.js";
export { createPaths } from "./config/paths.js";
export { defaultPerformance } from "./config/performance.js";

// Core RuleStore and Processor
export {
  RuleStore,
  type RuleClassificationType,
  type StoredRule,
  type RuleType,
  type RuleModifier,
  type RuleMetadata,
  type RuleStats,
} from "./RuleStore.js";
export {
  RuleProcessor,
  parseFilterList,
  parseFilterListStream,
  downloadAndParseSource,
  type ProcessorErrors,
} from "./RuleProcessor.js";
export {
  RuleDeduplicator,
  type MergedRuleMetadata,
} from "./RuleDeduplicator.js";
export { createRuleMetadata, cleanDomainPattern, resolveSourceInfo } from "./createMetadata.js";
export {
  filterLists,
  sourceCategories,
  sourceNames,
  CURATED_SOURCE_PROFILES,
  getSourceProfile,
  detectSourceClassification,
  displayFilterLabel,
  type SourceInfo,
  type FilterListInfo,
  type SourceScope,
  type SourceCategory,
  type SourceProfile,
} from "./sources.js";
export {
  fetchContent,
  fetchWithConditionalCache,
  type FetchOptions,
  type FetchResult,
} from "./fetch.js";
export {
  isSafePublicWebUrl,
  type SafeUrlCheckResult,
} from "./utils/urlSafety.js";

// Export / Formatters
export {
  generateFilterList,
  formatRule,
  generateHeader as generateAdvancedHeader,
  type FilterFormat,
  type FilterMetadata,
} from "./export/advanced-formatter.js";
export {
  formatRuleForType,
  formatAdguardRule,
  getDnsDomain,
  bindRpzBlockRecords,
  bindRpzPassthruRecords,
  BIND_NULL_ZONE_FILE,
  BIND_NULL_ZONE_CONTENTS,
} from "./export/formatters.js";
export { generateHeader } from "./export/headers.js";
export { exportFormat, exportWithOptions } from "./export/index.js";
export type { ExportFormatOptions } from "./export/index.js";
export {
  bindNullDelegatedZoneFile,
  bindNullZoneStanza,
  renderBindNullDelegatedZone,
} from "./export/bindDelegation.js";
export {
  filterDNSRules,
  filterBrowserRules,
  resolveDnsPrecedence,
  type DnsPrecedenceResult,
} from "./export/ruleFilters.js";

// Types
export {
  EXPORT_FORMATS,
  type ExportOptions,
  type FilterListMetadata,
  type SupportedFormat,
  type OutputFormat,
} from "./types.js";

// AI Ad & Tracker Discovery Engine
export * from "./ai/index.js";

// Blocklist coverage analysis (which rules actually fire on real traffic)
export * from "./coverage.js";

// Structural refusal of provably backtracking /regex/ rules — the only in-process answer to
// an engine with no step budget.
export * from "./regexSafety.js";

// Browser-reported rule hits, aggregated across sessions — the evidence the trimmed hot set is
// built from when it comes from real usage rather than a captured trace.
export * from "./ledgerAggregate.js";
export * from "./tiers.js";
export * from "./tierPlanInput.js";
export * from "./ruleHost.js";

// Replaying captured requests through a compiled rule set (the offline half of a measurement)
export * from "./ruleReplay.js";
