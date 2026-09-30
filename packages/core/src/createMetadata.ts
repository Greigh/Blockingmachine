import { isValidDomainName } from "./utils/ruleSyntax.js";
import { sourceCategories, sourceNames, type SourceInfo } from "./sources.js";
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
    for (let i = 0; i < trimmedRule.length - 1; i++) {
      const code = trimmedRule.charCodeAt(i);
      if (
        (code === 32 || (code >= 9 && code <= 13)) &&
        trimmedRule.charCodeAt(i + 1) === 35
      ) {
        trimmedRule = trimmedRule.slice(0, i);
        break;
      }
    }
    trimmedRule = trimmedRule.trim();

    // Strip hosts file IP prefix if present (e.g. 0.0.0.0, 127.0.0.1, ::1)
    trimmedRule = trimmedRule
      .replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/, "")
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
    pattern = pattern.replace(/^https?:\/\//i, "").replace(/\.$/, "");
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
    if (isValidDomainName(pattern)) {
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

/**
 * Resolves a rule's publisher to its category, by name or by URL.
 *
 * The two keys were the same concept written down once each and never joined. `sourceCategories`
 * is built from the curated profiles and keyed by *name* (26 of 26 resolve by name, 0 by URL),
 * while the parser is handed the source **URL** — `downloadAndParseSource` calls
 * `parseFilterList(content, url)` — so every lookup missed and every rule in the hub's compiled
 * output was categorised `unknown`, untrusted, priority 0. The category was not missing data;
 * it was a key that did not match.
 *
 * `sourceNames` is the project's own URL -> name map, and using it rather than parsing the URL
 * means a rule from a list the catalog knows resolves to that list's category, while an
 * arbitrary user-supplied list still falls through to `unknown` rather than guessing. Both keys
 * are tried, because callers legitimately pass either: the store and the legacy name aliases
 * are name-keyed while the download path is URL-keyed.
 */
export function resolveSourceInfo(source: string): SourceInfo {
  if (source && Object.prototype.hasOwnProperty.call(sourceCategories, source)) {
    return sourceCategories[source]!;
  }
  const name = sourceNames[source];
  if (name && Object.prototype.hasOwnProperty.call(sourceCategories, name)) {
    return sourceCategories[name]!;
  }
  return { category: "unknown", trusted: false, priority: 0 };
}

export function createRuleMetadata(
  source: string,
  type: RuleType,
  rule: string,
): RuleMetadata {
  const domain = cleanDomainPattern(rule);
  const selector = extractSelector(rule);
  const sourceInfo: SourceInfo = resolveSourceInfo(source);

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
