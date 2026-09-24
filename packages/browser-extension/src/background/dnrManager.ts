import { Mv3Guard, MV3_LIMITS } from './mv3Guard.js';

export interface ParsedDnrCandidate {
  rawRule: string;
  pattern: string;
  isException: boolean;
  isImportant: boolean;
  priority: number;
}

// Regex to validate syntactically compliant domain hostnames (RFC 1123)
const DOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?)+$/;

const RESERVED_INFRASTRUCTURE = new Set([
  'localhost',
  'local',
  'broadcasthost',
  'home.arpa',
  'invalid',
  'test',
  'example',
  'onion'
]);

const BARE_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'org.nz',
  'net.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.br',
  'org.br',
  'net.br',
  'com.cn',
  'net.cn',
  'org.cn',
  'co.in',
  'net.in',
  'org.in',
  'github.io',
  'pages.dev',
  'vercel.app',
  'cloudfront.net',
  'azurewebsites.net',
  'amazonaws.com'
]);

export class DnrManager {
  private nextRuleId = 1;

  /**
   * Translates rule lines into prioritized candidate objects.
   * Supports ABP wildcards (||domain^), exceptions (@@), hosts entries, and plain domains.
   */
  parseRule(line: string): ParsedDnrCandidate | null {
    let clean = line.trim();
    if (!clean || clean.startsWith('#') || clean.startsWith('!')) return null;

    // 1. Strictly exclude cosmetic filters and scriptlets (handled in content/defusers)
    if (
      clean.includes('##') ||
      clean.includes('#@#') ||
      clean.includes('#?#') ||
      clean.includes('$$') ||
      clean.includes('+js(')
    ) {
      return null;
    }

    // 2. Strictly exclude DNS-only directives
    if (
      clean.includes('$dnsrewrite') ||
      clean.includes('$dnstype') ||
      clean.includes('$client') ||
      clean.includes('$ctag') ||
      clean.includes('.arpa')
    ) {
      return null;
    }

    // 3. Exclude raw loopback / broadcasthost hosts mappings
    if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+(?:localhost|broadcasthost|local)/i.test(clean)) {
      return null;
    }

    let isException = false;
    let isImportant = false;

    if (clean.startsWith('@@')) {
      isException = true;
      clean = clean.substring(2).trim();
    }

    if (clean.includes('$important')) {
      isImportant = true;
      clean = clean.replace(/\$important/g, '').trim();
    }

    // Strip hosts file IP prefixes (0.0.0.0, 127.0.0.1)
    clean = clean.replace(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+/, '');

    // Strip leading adblock wildcard ||
    if (clean.startsWith('||')) {
      clean = clean.substring(2);
    }

    // Strip trailing ^ or modifiers ($third-party, /path, ^$doc)
    clean = clean.replace(/\^.*$/, '').replace(/[$^/].*$/, '').trim().toLowerCase();

    // Strip trailing period if present
    clean = clean.replace(/\.+$/, '');

    // Validate that the remaining string is a syntactically valid domain name
    // to prevent Chrome DNR from throwing "Invalid urlFilter" on the entire batch
    if (!clean || !DOMAIN_REGEX.test(clean)) {
      return null;
    }

    // Exclude reserved infrastructure and bare public suffixes
    if (RESERVED_INFRASTRUCTURE.has(clean) || BARE_PUBLIC_SUFFIXES.has(clean)) {
      return null;
    }

    // Precedence:
    // 4: $important exception (@@...$important)
    // 3: $important block (...$important)
    // 2: standard exception (@@)
    // 1: standard block
    let priority = 1;
    if (isException && isImportant) priority = 4;
    else if (isImportant) priority = 3;
    else if (isException) priority = 2;
    else priority = 1;

    return {
      rawRule: line.trim(),
      pattern: clean,
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

    // Enforce Manifest V3 safe watermark and syntax bounds
    const maxQuota =
      chrome.declarativeNetRequest?.MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES ||
      MV3_LIMITS.DEFAULT_MAX_DYNAMIC_RULES;
    const quotaCap = Math.min(MV3_LIMITS.SAFE_DYNAMIC_WATERMARK, Math.max(1000, maxQuota - 500));

    const { compliant, overflowCount } = Mv3Guard.boundCandidates(candidates, quotaCap);
    if (overflowCount > 0) {
      console.warn(
        `[Mv3Guard] Rule list exceeds safe MV3 dynamic limit (${quotaCap}). Bound ${compliant.length} rules, ${overflowCount} overflow rules pruned. Use @blockingmachine/system-daemon for unlimited network-level filtering.`
      );
    }

    const addRules: chrome.declarativeNetRequest.Rule[] = [];
    this.nextRuleId = 1;

    for (const candidate of compliant) {

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

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules
      });
    } catch (err) {
      console.error('[DNR] Failed to apply dynamic rules batch:', err);
      throw err;
    }

    return addRules.length;
  }
}
