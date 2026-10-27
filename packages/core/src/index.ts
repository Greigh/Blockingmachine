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
export {
  createRuleMetadata,
  cleanDomainPattern,
  resolveSourceInfo,
} from "./createMetadata.js";
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
  readBoundedJsonBody,
  readBoundedTextBody,
  type FetchOptions,
  type FetchResult,
} from "./fetch.js";
export {
  isSafePublicWebUrl,
  isSafeLanEndpointUrl,
  isLocalNetworkHost,
  credentialAllowed,
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

// Runtime URL request evaluation — the verdict a request rule gives one request, for
// consumers the compiled exports cannot serve (the MITM proxy, on-device matchers).
export {
  createRequestEvaluator,
  type RequestContext,
  type RequestEvaluator,
  type RequestVerdict,
} from "./evaluateRequest.js";

// Cosmetic/scriptlet rule index + the shared structural selector check — the
// response-depth half of the filter list (P2 task 1). The extension imports the
// structural check through the `@blockingmachine/core/selectorSafety` subpath so
// it never bundles this index (or the entropy tables it consults).
export {
  checkSelectorStructure,
  checkListSelectorStructure,
  translateExtendedSelector,
  DANGEROUS_SELECTOR_CHARS,
  MAX_LIST_SELECTOR_LENGTH,
  MAX_SELECTOR_LENGTH,
  type ExtendedSelectorTranslation,
  type SelectorSafetyResult,
} from "./cosmetic/selectorSafety.js";
export {
  canonicalScriptletName,
  CANONICAL_SCRIPTLET_NAMES,
  createCosmeticIndex,
  type CosmeticIndex,
  type CosmeticIndexStats,
  type CosmeticPayload,
  type ScriptletCall,
} from "./cosmetic/cosmeticIndex.js";

// OS trust-store ops on the HTTPS-filter proxy CA (P1 Task 4 + P3 Task 3) —
// the cli's `cert` verbs and the electron `httpsfilter:ca-*` IPC both consume
// these. darwin runs `security`; win32 runs `certutil -user` against the
// CurrentUser Root store; linux runs NSS `certutil` on ~/.pki/nssdb with a
// sudo-guided system-store fallback. Other platforms answer 'unsupported'.
// The `firefox*` ops are the separate per-profile cert9.db path (flag 116):
// they run through a located NSS certutil — PATH plus conventional
// locations like Homebrew's `nss` — and report each profile independently,
// `tool-missing` when no NSS certutil exists on the box.
export {
  trustStatus,
  installCa,
  removeCa,
  macOsLoginKeychainPath,
  commonNameFromSubject,
  firefoxNssProfileDbs,
  firefoxTrustStatus,
  firefoxInstallCa,
  firefoxRemoveCa,
  linuxSystemStoreCommands,
  LINUX_SYSTEM_CA_TARGET,
  type CaTrustState,
  type CaInstallOutcome,
  type CaRemoveOutcome,
  type CaTrustStoreOptions,
  type FirefoxTrustOptions,
  type FirefoxTrustReport,
  type FirefoxProfileTrust,
  type FirefoxProfileTrustState,
  type SecurityRunner,
  type SecurityRunResult,
  type PlatformRunner,
  type PlatformRunResult,
} from "./caTrustStore.js";
