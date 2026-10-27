// Cosmetic/scriptlet rule index + the shared selector-safety check (P2 task 1).
export {
  checkSelectorStructure,
  checkListSelectorStructure,
  DANGEROUS_SELECTOR_CHARS,
  MAX_LIST_SELECTOR_LENGTH,
  MAX_SELECTOR_LENGTH,
  type SelectorSafetyResult,
} from "./selectorSafety.js";
export {
  canonicalScriptletName,
  CANONICAL_SCRIPTLET_NAMES,
  createCosmeticIndex,
  type CosmeticIndex,
  type CosmeticIndexStats,
  type CosmeticPayload,
  type ScriptletCall,
} from "./cosmeticIndex.js";
