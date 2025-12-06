import { sourceCategories, type SourceInfo } from "./sources.js";
import { type RuleType, type RuleMetadata } from "./RuleStore.js";

// --- Helper Functions (for domain/selector extraction) ---
// You can copy these from the RuleProcessor class or refine them here

function cleanDomainPattern(originalRule: string): string | null {
  if (!originalRule || typeof originalRule !== "string") return null;
  const trimmedRule = originalRule.trim();
  // Basic check: ignore scriptlet injections or rules starting with '$'
  if (trimmedRule.startsWith("$") || trimmedRule.includes("script:"))
    return null;
  try {
    // Remove AdGuard/uBO specific options starting with $
    const parts = trimmedRule.split("$", 1);
    let pattern = parts[0].replace(/^(@@)?(\|+)?/, ""); // Remove @@ or || prefixes
    if (pattern.endsWith("^")) pattern = pattern.slice(0, -1); // Remove trailing ^ separator
    pattern = pattern.trim();

    // Basic validation (very simplified) - avoid cosmetic selectors
    if (pattern.includes("#") || pattern.includes("(")) return null;

    return pattern || null; // Return pattern or null if empty
  } catch {
    return null; // Return null on error
  }
}

function extractSelector(originalRule: string): string | null {
  if (!originalRule || typeof originalRule !== "string") return null;
  try {
    // Matches common cosmetic rule patterns (##, #@#, #?#, #$#)
    const match = originalRule.match(
      /(?:##|#@#|#\?#|#\$#|#\$\?#|#\.|\#\,)(.+)/,
    );
    // Further split by $ if options exist, take only the selector part
    const selectorPart = match ? match[1].split("$", 1)[0].trim() : null;
    return selectorPart || null; // Return selector or null if empty/not found
  } catch {
    return null; // Return null on error
  }
}
// --- End Helper Functions ---

// --- Main Function ---

export function createRuleMetadata(
  source: string,
  type: RuleType,
  rule: string,
): RuleMetadata {
  const domain = cleanDomainPattern(rule);
  const selector = extractSelector(rule);
  const sourceInfo: SourceInfo = sourceCategories[source] || {
    category: "unknown",
    trusted: false,
    priority: 0,
  };

  return {
    sources: [source],
    dateAdded: new Date(),
    lastUpdated: new Date(),
    enabled: true,
    sourceInfo: {
      category: sourceInfo.category,
      trusted: sourceInfo.trusted,
      url: source,
      priority: sourceInfo.priority,
    },
    tags: [],
    ...(domain ? { domain } : {}),
    ...(selector ? { selector } : {}),
  };
}
