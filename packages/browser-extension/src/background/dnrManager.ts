/**
 * DeclarativeNetRequest (DNR) Ruleset Manager
 * Translates Blockingmachine network rules into native browser declarative rules.
 */

export class DnrManager {
  private nextRuleId = 1000;

  /**
   * Updates dynamic DNR rules from a set of domain strings.
   */
  async updateDynamicRules(blockedDomains: string[]): Promise<number> {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map((r) => r.id);

    const addRules: chrome.declarativeNetRequest.Rule[] = [];

    for (const domain of blockedDomains) {
      const clean = domain.trim().toLowerCase();
      if (!clean || clean.startsWith('#') || clean.startsWith('!')) continue;

      // Extract raw domain if in ||domain^ format
      const host = clean.replace(/^\|\|/, '').replace(/\^.*$/, '');
      if (!host) continue;

      addRules.push({
        id: this.nextRuleId++,
        priority: 1,
        action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
        condition: {
          urlFilter: `||${host}^`,
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

      // Browser DNR has dynamic rule quotas (typically 30,000 rules)
      if (addRules.length >= 25000) break;
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules
    });

    return addRules.length;
  }
}
