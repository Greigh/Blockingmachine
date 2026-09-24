/**
 * DeclarativeNetRequest (DNR) Ruleset Manager
 * Translates Blockingmachine filter rules into native browser declarative rules,
 * strictly adhering to Manifest V3 rule quotas and precedence hierarchy.
 */

export interface ParsedDnrCandidate {
  rawRule: string;
  pattern: string;
  isException: boolean;
  isImportant: boolean;
  priority: number;
}

export class DnrManager {
  private nextRuleId = 1;

  /**
   * Translates rule lines into prioritized candidate objects.
   */
  parseRule(line: string): ParsedDnrCandidate | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return null;

    let isException = false;
    let isImportant = false;
    let clean = trimmed;

    if (clean.startsWith('@@')) {
      isException = true;
      clean = clean.substring(2);
    }

    if (clean.includes('$important')) {
      isImportant = true;
      clean = clean.replace(/\$important/g, '');
    }

    // Extract domain pattern
    const match = clean.match(/^\|\|([^/^$]+)/);
    if (!match) return null;

    const domain = match[1].toLowerCase().replace(/\^.*$/, '').trim();
    if (!domain) return null;

    // Precedence:
    // 4: $important exception
    // 3: $important block
    // 2: standard exception (@@)
    // 1: standard block
    let priority = 1;
    if (isException && isImportant) priority = 4;
    else if (isImportant) priority = 3;
    else if (isException) priority = 2;
    else priority = 1;

    return {
      rawRule: trimmed,
      pattern: domain,
      isException,
      isImportant,
      priority
    };
  }

  /**
   * Updates dynamic DNR rules from a set of domain/adblock strings.
   * Respects browser dynamic rule quotas and prioritizes exceptions and high-priority rules.
   */
  async updateDynamicRules(ruleLines: string[]): Promise<number> {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map((r) => r.id);

    // Dynamic rule limit (standard 30,000 in modern Chrome)
    const maxQuota = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES || 30000;
    const quotaCap = Math.max(1000, maxQuota - 500);

    const candidates: ParsedDnrCandidate[] = [];
    const seenPatterns = new Set<string>();

    for (const line of ruleLines) {
      const parsed = this.parseRule(line);
      if (!parsed) continue;

      const dedupeKey = `${parsed.isException ? 'EX:' : 'BL:'}${parsed.pattern}`;
      if (seenPatterns.has(dedupeKey)) continue;
      seenPatterns.add(dedupeKey);

      candidates.push(parsed);
    }

    // Sort by priority descending so high-priority rules & exceptions fit first
    candidates.sort((a, b) => b.priority - a.priority);

    const addRules: chrome.declarativeNetRequest.Rule[] = [];
    this.nextRuleId = 1;

    for (const candidate of candidates) {
      if (addRules.length >= quotaCap) break;

      const actionType = candidate.isException
        ? chrome.declarativeNetRequest.RuleActionType.ALLOW
        : chrome.declarativeNetRequest.RuleActionType.BLOCK;

      addRules.push({
        id: this.nextRuleId++,
        priority: candidate.priority,
        action: { type: actionType },
        condition: {
          urlFilter: `||${candidate.pattern}^`,
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.SCRIPT,
            chrome.declarativeNetRequest.ResourceType.IMAGE,
            chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
            chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
            chrome.declarativeNetRequest.ResourceType.MEDIA,
            chrome.declarativeNetRequest.ResourceType.PING
          ]
        }
      });
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules
    });

    return addRules.length;
  }
}
