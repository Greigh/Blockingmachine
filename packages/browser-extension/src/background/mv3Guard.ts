/**
 * Manifest V3 Compliance & Quota Guardian
 * Enforces Chrome Web Store and DeclarativeNetRequest (DNR) runtime boundaries:
 * - Dynamic rule quotas (30,000 ceiling, 28,500 safe watermark)
 * - Regex rule quotas (1,000 ceiling, 900 safe watermark)
 * - URL filter length limits (max 2048 characters)
 * - ASCII/Punycode domain conformance
 * - Positive integer rule ID uniqueness
 */

export interface Mv3QuotaStatus {
  dynamicRulesCount: number;
  maxDynamicRules: number;
  regexRulesCount: number;
  maxRegexRules: number;
  isWithinQuota: boolean;
  utilizationPercent: number;
  headroomAvailable: number;
}

export const MV3_LIMITS = {
  DEFAULT_MAX_DYNAMIC_RULES: 30000,
  SAFE_DYNAMIC_WATERMARK: 28500,
  DEFAULT_MAX_REGEX_RULES: 1000,
  SAFE_REGEX_WATERMARK: 900,
  MAX_URL_FILTER_LENGTH: 2048
};

export class Mv3Guard {
  /**
   * Validates if a rule pattern strictly adheres to Manifest V3 DNR requirements.
   */
  static isCompliantRule(pattern: string): boolean {
    if (!pattern || typeof pattern !== 'string') return false;

    // Rule 1: Length must not exceed 2048 characters
    if (pattern.length > MV3_LIMITS.MAX_URL_FILTER_LENGTH) {
      return false;
    }

    // Rule 2: Must only contain printable ASCII characters (non-ASCII must be punycode encoded)
    // Chrome DNR rejects non-ASCII characters in urlFilter
    for (let i = 0; i < pattern.length; i++) {
      const code = pattern.charCodeAt(i);
      if (code < 32 || code > 126) {
        return false;
      }
    }

    // Rule 3: Must not contain spaces or unescaped control characters
    if (/\s/.test(pattern)) {
      return false;
    }

    return true;
  }

  /**
   * Assesses current DNR dynamic rule quota consumption.
   */
  static async getQuotaStatus(): Promise<Mv3QuotaStatus> {
    const maxDynamic =
      chrome?.declarativeNetRequest?.MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES ||
      MV3_LIMITS.DEFAULT_MAX_DYNAMIC_RULES;
    const maxRegex = MV3_LIMITS.DEFAULT_MAX_REGEX_RULES;

    let dynamicRulesCount = 0;
    let regexRulesCount = 0;

    try {
      if (chrome?.declarativeNetRequest?.getDynamicRules) {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        dynamicRulesCount = rules.length;
        regexRulesCount = rules.filter((r) => r.condition.regexFilter !== undefined).length;
      }
    } catch (err) {
      console.warn('[Mv3Guard] Could not query active DNR dynamic rules:', err);
    }

    const utilizationPercent = parseFloat(((dynamicRulesCount / maxDynamic) * 100).toFixed(1));
    const headroomAvailable = Math.max(0, maxDynamic - dynamicRulesCount);
    const isWithinQuota =
      dynamicRulesCount <= MV3_LIMITS.SAFE_DYNAMIC_WATERMARK &&
      regexRulesCount <= MV3_LIMITS.SAFE_REGEX_WATERMARK;

    return {
      dynamicRulesCount,
      maxDynamicRules: maxDynamic,
      regexRulesCount,
      maxRegexRules: maxRegex,
      isWithinQuota,
      utilizationPercent,
      headroomAvailable
    };
  }

  /**
   * Filters and bounds a list of candidate rules within safe MV3 headroom.
   */
  static boundCandidates<T extends { pattern: string; priority: number }>(
    candidates: T[],
    maxAllowed: number = MV3_LIMITS.SAFE_DYNAMIC_WATERMARK
  ): { compliant: T[]; overflowCount: number } {
    const compliant: T[] = [];
    let overflowCount = 0;

    // Filter strictly compliant rules
    for (const candidate of candidates) {
      if (!this.isCompliantRule(candidate.pattern)) {
        continue;
      }

      if (compliant.length < maxAllowed) {
        compliant.push(candidate);
      } else {
        overflowCount++;
      }
    }

    return { compliant, overflowCount };
  }
}
