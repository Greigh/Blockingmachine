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
  downloadAndParseSource,
  type ProcessorErrors,
} from "./RuleProcessor.js";
export { RuleDeduplicator } from "./RuleDeduplicator.js";
export { createRuleMetadata, cleanDomainPattern } from "./createMetadata.js";
export {
  filterLists,
  sourceCategories,
  sourceNames,
  type SourceInfo,
  type FilterListInfo,
} from "./sources.js";
export { fetchContent } from "./fetch.js";

// Export / Formatters
export {
  generateFilterList,
  formatRule,
  generateHeader as generateAdvancedHeader,
  type FilterFormat,
  type FilterMetadata,
} from "./export/advanced-formatter.js";
export { formatRuleForType } from "./export/formatters.js";
export { generateHeader } from "./export/headers.js";
export { exportFormat, exportWithOptions } from "./export/index.js";
export { filterDNSRules, filterBrowserRules } from "./export/ruleFilters.js";

// Types
export type {
  ExportOptions,
  FilterListMetadata,
  SupportedFormat,
} from "./types.js";
