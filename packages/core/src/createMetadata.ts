import { sourceCategories, type SourceInfo } from "./sources.js";
import { type RuleType, type RuleMetadata } from "./RuleStore.js";

// --- Helper Functions (for domain/selector extraction) ---
// You can copy these from the RuleProcessor class or refine them here

export function cleanDomainPattern(originalRule: string): string | null {
  if (!originalRule || typeof originalRule !== "string") return null;
  let trimmedRule = originalRule.trim();
  if (!trimmedRule) return null;

  // Basic check: ignore comments, preprocessors, scriptlet injections, or rules starting with '$'
  if (
    trimmedRule.startsWith("!") ||
    trimmedRule.startsWith("[") ||
    trimmedRule.startsWith("#") ||
    trimmedRule.startsWith("$") ||
    trimmedRule.includes("script:")
  ) {
    return null;
  }

  // Cosmetic and scriptlet injection rules are element-hiding, not DNS/domain blocking
  if (
    trimmedRule.includes("##") ||
    trimmedRule.includes("#@#") ||
    trimmedRule.includes("#?#") ||
    trimmedRule.includes("#$#") ||
    trimmedRule.includes("#$?#") ||
    trimmedRule.includes("#%#") ||
    trimmedRule.includes("#@%#") ||
    trimmedRule.includes("$$") ||
    trimmedRule.includes("#.") ||
    trimmedRule.includes("#,")
  ) {
    return null;
  }

  try {
    // Strip trailing comments (e.g. in hosts files "127.0.0.1 example.com # comment")
    const commentMatch = trimmedRule.search(/\s+#/);
    if (commentMatch !== -1) {
      trimmedRule = trimmedRule.slice(0, commentMatch);
    }
    trimmedRule = trimmedRule.trim();

    // Strip hosts file IP prefix if present (e.g. 0.0.0.0, 127.0.0.1, ::1)
    trimmedRule = trimmedRule
      .replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+/, "")
      .trim();

    // Remove AdGuard/uBO specific options starting with $
    const parts = trimmedRule.split("$", 1);
    let pattern = parts[0];
    if (pattern.startsWith("@@")) {
      pattern = pattern.slice(2);
    }
    while (pattern.startsWith("|")) {
      pattern = pattern.slice(1);
    }
    while (pattern.endsWith("^") || pattern.endsWith("/")) {
      pattern = pattern.slice(0, -1);
    }
    pattern = pattern.replace(/^(?:https?:\/\/)?(?:www\.)?/, "");
    pattern = pattern.trim();

    // Avoid cosmetic selectors, regex, or rules containing paths/query
    if (
      !pattern ||
      pattern.includes("#") ||
      pattern.includes("(") ||
      pattern.includes("/") ||
      pattern.includes("*") ||
      pattern.includes("?") ||
      pattern.includes(" ")
    ) {
      return null;
    }

    // Must have at least one dot and valid domain-like characters
    if (/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(pattern)) {
      return pattern.toLowerCase();
    }

    return null;
  } catch {
    return null;
  }
}

export function extractSelector(originalRule: string): string | null {
  if (!originalRule || typeof originalRule !== "string") return null;
  try {
    // Matches common cosmetic rule patterns (##, #@#, #?#, #$#, #$?#, #%#, #@%#, #., #,)
    const match = originalRule.match(
      /(?:##|#@#|#\?#|#\$#|#\$\?#|#%#|#@%#|#\.|\#\,)(.+)/,
    );
    // Never split by $ because CSS attribute selectors use $= (e.g. [id$="-ad"]) or CSS variables
    const selectorPart = match ? match[1].trim() : null;
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
