// Explicitly re-export everything needed by the CLI
import { defaultFilterMeta } from "./config/meta.js";
import { createPaths } from "./config/paths.js";
import { defaultPerformance } from "./config/performance.js";
import { exportWithOptions } from "./export/index.js";
import { RuleType, RuleModifier, RuleMetadata } from "./RuleStore.js";
// Re-export types
import type { FilterMetaConfig } from "./config/meta.js";
import type {
  ExportOptions,
  FilterListMetadata,
  SupportedFormat,
} from "./types.js";

// Export everything explicitly
export {
  // Functions and constants
  defaultFilterMeta,
  createPaths,
  defaultPerformance,
  exportWithOptions,
};

// Re-export types
export type {
  RuleType,
  RuleModifier,
  RuleMetadata,
  FilterMetaConfig,
  ExportOptions,
  FilterListMetadata,
  SupportedFormat,
};
