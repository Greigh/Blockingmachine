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
export { createRuleMetadata, cleanDomainPattern } from "./createMetadata.js";
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

// Export / Formatters
export {
  generateFilterList,
  formatRule,
  generateHeader as generateAdvancedHeader,
  type FilterFormat,
  type FilterMetadata,
} from "./export/advanced-formatter.js";
export { formatRuleForType, formatAdguardRule } from "./export/formatters.js";
export { generateHeader } from "./export/headers.js";
export { exportFormat, exportWithOptions } from "./export/index.js";
export { filterDNSRules, filterBrowserRules } from "./export/ruleFilters.js";

// Types
export type {
  ExportOptions,
  FilterListMetadata,
  SupportedFormat,
} from "./types.js";

// AI Ad & Tracker Discovery Engine
export * from "./ai/index.js";
