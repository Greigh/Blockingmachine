import { fetchContent } from "./fetch.js";
import { sourceNames } from "./sources.js";
import { performance } from "perf_hooks";
import readline from "readline";
import {
  RuleStore,
  RuleClassificationType,
  type StoredRule,
  type RuleType,
} from "./RuleStore.js";
import { createRuleMetadata } from "./createMetadata.js";

// --- Regex Definitions ---
const IPV4_REGEX = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
const IPV6_REGEX =
  /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$|^(?:[0-9a-fA-F]{1,4}:){1,7}:|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$/;
const _DOMAIN_REGEX =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const DOMAIN_OR_WILDCARD_REGEX =
  /^(\*\.)?[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const HOSTNAME_REGEX =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+\.?$/;

// --- Modifier Sets ---
const DNS_ONLY_MODIFIERS = new Set(["client", "dnstype", "dnsrewrite", "ctag"]);
const BROWSER_ONLY_MODIFIERS = new Set([
  "app",
  "header",
  "method",
  "popup",
  "strict-first-party",
  "strict-third-party",
  "to",
  "document",
  "font",
  "image",
  "media",
  "object",
  "other",
  "ping",
  "script",
  "stylesheet",
  "subdocument",
  "websocket",
  "xmlhttprequest",
  "content",
  "elemhide",
  "extension",
  "jsinject",
  "stealth",
  "urlblock",
  "genericblock",
  "generichide",
  "specifichide",
  "all",
  "cookie",
  "csp",
  "hls",
  "inline-script",
  "inline-font",
  "jsonprune",
  "xmlprune",
  "network",
  "permissions",
  "redirect",
  "redirect-rule",
  "referrerpolicy",
  "removeheader",
  "removeparam",
  "replace",
  "urltransform",
  "noop",
  "empty",
  "mp4",
  "object-subrequest",
  "webrtc",
]);
const _SHARED_MODIFIERS = new Set([
  "important",
  "badfilter",
  "denyallow",
  "domain",
  "match-case",
  "third-party",
]);

// --- Error Structure Interfaces ---
interface ProcessingError {
  rule: string;
  source: string;
  error: string;
}
interface FailedUrl {
  url: string;
  name: string;
  reason: string;
}
interface UnrecognizedRule {
  rule: string;
  source: string;
}
interface LintingError {
  rule: string;
  source: string;
  errors: string[];
}
export interface ProcessorErrors {
  unrecognizedRules: UnrecognizedRule[];
  processingErrors: ProcessingError[];
  failedUrls: FailedUrl[];
  lintingErrors: LintingError[];
}

// --- Filter Metadata Interface ---
interface FilterMetadata {
  title?: string;
  version?: string;
  homepage?: string;
  expires?: string;
  sources: string[];
  name?: string;
}

// --- Type sourceNames explicitly ---
const typedSourceNames: Record<string, string> = sourceNames;

export function parseFilterList(
  content: string,
  sourceUrl?: string,
): StoredRule[] {
  const rules: StoredRule[] = [];
  const cleanContent = content.replace(/^\uFEFF/, "");
  const lines = cleanContent.split(/\r?\n/);
  const source = sourceUrl || "unknown";
  const tempProcessor = new RuleProcessor();

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Expand multi-domain hosts file lines (e.g. "0.0.0.0 ad1.com ad2.com # comment")
    const hostsMatch = trimmedLine.match(
      /^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+([^#]+)/,
    );
    if (hostsMatch) {
      const ip = trimmedLine.split(/\s+/)[0];
      const domainTokens = hostsMatch[1].trim().split(/\s+/).filter(Boolean);
      if (domainTokens.length > 1) {
        for (const dom of domainTokens) {
          const subRule = `${ip} ${dom}`;
          const ruleType = tempProcessor.classifyRule(subRule);
          if (
            ruleType &&
            ruleType !== "comment" &&
            ruleType !== "preprocessor" &&
            ruleType !== "hint"
          ) {
            const metadata = createRuleMetadata(
              source,
              ruleType as RuleType,
              subRule,
            );
            rules.push({
              raw: subRule,
              originalRule: subRule,
              hash: "",
              type: ruleType as RuleType,
              isException: false,
              domain: metadata.domain || dom.toLowerCase(),
              metadata,
            });
          }
        }
        continue;
      }
    }

    const ruleType = tempProcessor.classifyRule(trimmedLine);

    if (
      ruleType &&
      ruleType !== "comment" &&
      ruleType !== "preprocessor" &&
      ruleType !== "hint"
    ) {
      const metadata = createRuleMetadata(
        source,
        ruleType as RuleType,
        trimmedLine,
      );

      rules.push({
        raw: trimmedLine,
        originalRule: trimmedLine,
        hash: "",
        type: ruleType as RuleType,
        isException:
          trimmedLine.startsWith("@@") ||
          trimmedLine.includes("#@#") ||
          ruleType === "unblocking",
        domain: metadata.domain || undefined,
        metadata,
      });
    }
  }
  return rules;
}

export async function* parseFilterListStream(
  stream: NodeJS.ReadableStream,
  sourceUrl?: string,
): AsyncGenerator<StoredRule, void, unknown> {
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const source = sourceUrl || "unknown";
  const tempProcessor = new RuleProcessor();

  for await (const line of rl) {
    const trimmedLine = line.replace(/^\uFEFF/, "").trim();
    if (!trimmedLine) continue;

    // Expand multi-domain hosts file lines (e.g. "0.0.0.0 ad1.com ad2.com # comment")
    const hostsMatch = trimmedLine.match(
      /^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+([^#]+)/,
    );
    if (hostsMatch) {
      const ip = trimmedLine.split(/\s+/)[0];
      const domainTokens = hostsMatch[1].trim().split(/\s+/).filter(Boolean);
      if (domainTokens.length > 1) {
        for (const dom of domainTokens) {
          const subRule = `${ip} ${dom}`;
          const ruleType = tempProcessor.classifyRule(subRule);
          if (
            ruleType &&
            ruleType !== "comment" &&
            ruleType !== "preprocessor" &&
            ruleType !== "hint"
          ) {
            const metadata = createRuleMetadata(
              source,
              ruleType as RuleType,
              subRule,
            );
            yield {
              raw: subRule,
              originalRule: subRule,
              hash: "",
              type: ruleType as RuleType,
              isException: false,
              domain: metadata.domain || dom.toLowerCase(),
              metadata,
            };
          }
        }
        continue;
      }
    }

    const ruleType = tempProcessor.classifyRule(trimmedLine);
    if (
      ruleType &&
      ruleType !== "comment" &&
      ruleType !== "preprocessor" &&
      ruleType !== "hint"
    ) {
      const metadata = createRuleMetadata(
        source,
        ruleType as RuleType,
        trimmedLine,
      );

      yield {
        raw: trimmedLine,
        originalRule: trimmedLine,
        hash: "",
        type: ruleType as RuleType,
        isException:
          trimmedLine.startsWith("@@") ||
          trimmedLine.includes("#@#") ||
          ruleType === "unblocking",
        domain: metadata.domain || undefined,
        metadata,
      };
    }
  }
}

export async function downloadAndParseSource(
  url: string,
): Promise<StoredRule[]> {
  console.log(`Processing source: ${url}`);
  const content = await fetchContent(url);
  if (content === null) {
    console.warn(
      `⚠️ Failed to fetch content for ${url}, returning empty list.`,
    );
    return [];
  }
  const rules = parseFilterList(content, url);
  console.log(`   Found ${rules.length} rules in ${url}`);
  return rules;
}

export class RuleProcessor {
  // --- Class Properties ---
  private errors: ProcessorErrors;

  constructor() {
    this.errors = {
      unrecognizedRules: [],
      processingErrors: [],
      failedUrls: [],
      lintingErrors: [],
    };
  }

  async init(): Promise<void> {
    console.log("RuleProcessor initialized.");
  }

  // --- Rule Classification ---
  classifyRule(rule: string): RuleClassificationType | null {
    const trimmedRule = rule.trim();

    // 1. Empty or Whitespace Only
    if (!trimmedRule) return null;

    // 2. Comments / Headers / Preprocessor / Hints
    if (trimmedRule.startsWith("!")) {
      if (trimmedRule.startsWith("!#")) return "preprocessor";
      if (trimmedRule.startsWith("!+")) return "hint";
      return "comment";
    }
    // Modified Comment Check
    if (
      trimmedRule.startsWith("#") &&
      !(
        trimmedRule.includes("##") ||
        trimmedRule.includes("#?") ||
        trimmedRule.includes("#@") ||
        trimmedRule.includes("#$?#") ||
        trimmedRule.includes("#$#") ||
        trimmedRule.includes("#%#") ||
        trimmedRule.includes("#.") ||
        trimmedRule.includes("#,")
      )
    ) {
      return "comment";
    }
    if (trimmedRule.startsWith("[") && trimmedRule.endsWith("]"))
      return "comment";

    // Modifier Analysis
    let hasDnsOnlyModifier = false;
    let hasBrowserOnlyModifier = false;
    const modifierMap = new Map<string, string>();
    const dollarIndex = trimmedRule.indexOf("$");
    if (
      dollarIndex !== -1 &&
      !trimmedRule.includes("##") &&
      !trimmedRule.includes("#?#") &&
      !trimmedRule.includes("#@#")
    ) {
      const modifierString = trimmedRule.slice(dollarIndex + 1);
      const modifiers = modifierString.split(",");
      for (const rawMod of modifiers) {
        const parts = rawMod.split("=");
        const mod = parts[0].trim().toLowerCase();
        modifierMap.set(mod, parts.slice(1).join("="));
        if (DNS_ONLY_MODIFIERS.has(mod)) hasDnsOnlyModifier = true;
        if (BROWSER_ONLY_MODIFIERS.has(mod)) hasBrowserOnlyModifier = true;
      }
    }

    // 3. HTML Filtering Rules
    if (
      trimmedRule.includes("$$") &&
      /\[(tag-content|wildcards|max-length|min-length)=/i.test(trimmedRule)
    ) {
      return "html-filtering";
    }
    // 4. AdGuard Extended CSS
    if (trimmedRule.includes("$$")) {
      return "extended-css";
    }
    // 5. Cosmetic Rules & Exceptions
    if (
      trimmedRule.includes("##") ||
      trimmedRule.includes("#?#") ||
      trimmedRule.includes("#@#") ||
      trimmedRule.includes("#$?#") ||
      trimmedRule.includes("#,") ||
      trimmedRule.includes("#.")
    ) {
      return "cosmetic";
    }
    // 6. Scriptlet Injection / JS Rules
    if (trimmedRule.includes("#$#") || trimmedRule.includes("#%#")) {
      return "scriptlet";
    }

    // 7. Specific Advanced Rules by Modifier (prioritize browser context if applicable)
    if (hasBrowserOnlyModifier) {
      if (modifierMap.has("csp")) return "csp";
      if (modifierMap.has("redirect") || modifierMap.has("redirect-rule"))
        return "redirect";
      if (modifierMap.has("replace")) return "replace";
      if (modifierMap.has("removeparam")) return "parameter"; // Map to 'parameter' as per RuleStore logic
      if (modifierMap.has("removeheader")) return "removeheader";
      if (modifierMap.has("permissions")) return "permissions";
      // If it has browser mods but isn't an exception, it's likely a blocking rule
      if (!trimmedRule.startsWith("@@")) return "blocking";
    }

    // 8. Unblocking/Exception Rules (can have DNS or Browser mods)
    if (trimmedRule.startsWith("@@")) {
      return "unblocking";
    }

    // 9. Network Rules (Blocking) - DNS context or general
    if (hasDnsOnlyModifier) return "blocking";

    // Handle uBO 'sponsor' syntax
    if (trimmedRule.startsWith("sponsor=")) return "blocking";
    // Handle 'ext=' syntax
    if (trimmedRule.startsWith("ext=")) return "blocking";

    // Standard ABP network syntax
    if (
      trimmedRule.startsWith("||") ||
      trimmedRule.startsWith("|") ||
      trimmedRule.endsWith("^") ||
      trimmedRule.includes("^")
    ) {
      return "blocking";
    }

    // Handle rules starting ONLY with modifiers (likely network context)
    if (trimmedRule.startsWith("$") && !/^[#]/.test(trimmedRule)) {
      // Could refine this, but often implies blocking in network context
      // $csp is handled above if browser mods exist
      return "blocking";
    }

    // Protocol Relative, Regex, Query/Fragment parts
    if (
      trimmedRule.startsWith("://") ||
      (trimmedRule.startsWith("/") && trimmedRule.endsWith("/")) ||
      trimmedRule.startsWith("&") ||
      trimmedRule.startsWith("=")
    ) {
      return "blocking";
    }

    // Path/Filename/Wildcard Check
    const patternPart = trimmedRule.split("$")[0];
    if (
      patternPart.includes("/") ||
      patternPart.includes("*") ||
      patternPart.includes("?") ||
      patternPart.includes("_") ||
      patternPart.includes(".") ||
      patternPart.includes("-") ||
      /^[a-z0-9_.-]+\.[a-z]{2,}$/i.test(patternPart)
    ) {
      return "blocking";
    }

    // IP Address / Domain/Hostname
    if (
      IPV4_REGEX.test(trimmedRule) ||
      IPV6_REGEX.test(trimmedRule) ||
      DOMAIN_OR_WILDCARD_REGEX.test(trimmedRule) ||
      (trimmedRule.includes(".") && HOSTNAME_REGEX.test(trimmedRule))
    ) {
      return "blocking";
    }

    // If still unrecognized, return null
    if (process.env.DEBUG) {
      console.warn(`[classifyRule] Rule fell through all checks: ${trimmedRule}`);
    }
    return null;
  }

  // --- Metadata Extraction ---
  extractFilterMetadata(lines: string[]): FilterMetadata | null {
    const metadata: Partial<FilterMetadata> & { sources: string[] } = {
      sources: [],
    };

    const extractMeta = (
      regex: RegExp,
      key: keyof Omit<FilterMetadata, "sources">,
    ) => {
      const line = lines.find((l) => regex.test(l));
      if (line) {
        const value = line.split(/:(.*)/s)[1]?.trim();
        // Assign if value exists (key !== 'sources' check removed as redundant)
        if (value) {
          // <<< Simplified check
          metadata[key] = value;
        }
      }
    };

    // Call extractMeta only for non-array keys
    extractMeta(/!\s*Title:/i, "title");
    extractMeta(/!\s*Version:/i, "version");
    extractMeta(/!\s*Homepage:/i, "homepage");
    extractMeta(/!\s*Expires:/i, "expires");
    // Add other metadata extractions here (ensure key is not 'sources')

    // Add the filter's own title as a source if available
    if (metadata.title && !metadata.sources.includes(metadata.title)) {
      metadata.sources.push(metadata.title);
    }

    return Object.keys(metadata).length > 1
      ? (metadata as FilterMetadata)
      : null;
  }

  // --- URL Processing ---
  async processUrl(url: string, ruleStore: RuleStore): Promise<boolean> {
    if (!ruleStore) {
      throw new Error(
        "RuleProcessor.processUrl requires a RuleStore instance.",
      );
    }
    const startTime = performance.now();
    console.log(`Fetching content for: ${url}`);
    const content = await fetchContent(url);
    const fetchEndTime = performance.now();

    const sourceName = typedSourceNames[url] || url;

    if (!content) {
      console.warn(`⚠️ No content fetched for ${url}. Skipping.`);
      this.errors.failedUrls.push({
        url,
        name: sourceName,
        reason: "No content",
      });
      return false;
    }
    console.log(`   Fetched in ${(fetchEndTime - startTime).toFixed(2)} ms`);

    const cleanContent = content.replace(/^\uFEFF/, "");
    const lines = cleanContent.split(/\r?\n/);
    const _filterMetadata = this.extractFilterMetadata(lines) || {
      name: sourceName,
      sources: [sourceName],
    };

    let processedCount = 0;
    let skippedCount = 0;
    let unrecognizedCount = 0;
    const MAX_UNRECOGNIZED_LOG = 5;

    for (const line of lines) {
      const cleanRule = line.trim();
      if (!cleanRule) continue;

      // Basic Comment/Header Skip
      if (
        cleanRule.startsWith("!") ||
        (cleanRule.startsWith("#") &&
          !/[#@?$,.]/.test(cleanRule.substring(1))) ||
        (cleanRule.startsWith("[") && cleanRule.endsWith("]"))
      ) {
        skippedCount++;
        continue;
      }

      // SKIP LINTING FOR NOW - directly classify the rule
      const type = this.classifyRule(cleanRule);

      if (type === "comment" || type === "preprocessor" || type === "hint") {
        skippedCount++;
        continue;
      }

      if (type === null) {
        if (unrecognizedCount < MAX_UNRECOGNIZED_LOG) {
          console.warn(
            `   [${sourceName}] Unrecognized rule (${unrecognizedCount + 1}): ${cleanRule}`,
          );
        }
        this.errors.unrecognizedRules.push({
          rule: cleanRule,
          source: sourceName,
        });
        unrecognizedCount++;
        continue;
      }

      try {
        ruleStore.addRule(cleanRule, sourceName);
        processedCount++;
      } catch (error: any) {
        console.error(
          `   Error processing rule "${cleanRule}" from ${url}:`,
          error,
        );
        this.errors.processingErrors.push({
          rule: cleanRule,
          source: url,
          error: error.message,
        });
      }
    }

    const processEndTime = performance.now();
    console.log(
      `   Processed ${processedCount} rules, skipped ${skippedCount} comments/meta, ${unrecognizedCount} unrecognized from ${sourceName} in ${(processEndTime - fetchEndTime).toFixed(2)} ms`,
    );

    return true;
  }

  getErrors(): ProcessorErrors {
    return {
      unrecognizedRules: [...this.errors.unrecognizedRules],
      processingErrors: [...this.errors.processingErrors],
      failedUrls: [...this.errors.failedUrls],
      lintingErrors: [...this.errors.lintingErrors],
    };
  }

  clearErrors(): void {
    this.errors = {
      unrecognizedRules: [],
      processingErrors: [],
      failedUrls: [],
      lintingErrors: [],
    };
  }
}
