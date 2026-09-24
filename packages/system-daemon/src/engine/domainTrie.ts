import { EvaluationResult } from '../types.js';

interface RuleEntry {
  ruleText: string;
  isImportant?: boolean;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  exactBlock?: RuleEntry;
  wildcardBlock?: RuleEntry;
  exception?: RuleEntry;
}

// Browser-specific resource modifiers that should NEVER be blocked at the DNS layer
const BROWSER_ONLY_MODIFIERS = new Set([
  'image',
  'script',
  'stylesheet',
  'subdocument',
  'xmlhttprequest',
  'websocket',
  'media',
  'popup',
  'csp',
  'redirect',
  'elemhide',
  'font',
  'ping',
  'other'
]);

/**
 * Domain Suffix Trie
 * Reverses domain labels (e.g. ['net', 'doubleclick', 'ad']) to enable
 * O(k) sub-microsecond longest-suffix match against wildcards and exact rules.
 * Strictly separates DNS domain rules from browser-only rules (cosmetics, scriptlets, URL paths).
 */
export class DomainTrie {
  private root: TrieNode = { children: new Map() };

  /**
   * Adds an adblock or hosts rule to the index.
   * Rejects browser-specific rules (cosmetic hiding, scriptlets, path filters, resource modifiers)
   * to ensure DNS resolution never breaks legitimate sites.
   */
  addRule(rawRule: string): void {
    const trimmed = rawRule.trim();
    if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('#')) return;

    // 1. Reject Browser Cosmetic & Scriptlet Filters
    if (
      trimmed.includes('##') ||
      trimmed.includes('#@#') ||
      trimmed.includes('#?#') ||
      trimmed.includes('#$#') ||
      trimmed.includes('$$') ||
      trimmed.includes('+js(')
    ) {
      return;
    }

    let isException = false;
    let isImportant = false;
    let pattern = trimmed;

    if (pattern.startsWith('@@')) {
      isException = true;
      pattern = pattern.substring(2);
    }

    if (pattern.includes('$important')) {
      isImportant = true;
      pattern = pattern.replace(/\$important/g, '');
    }

    // 2. Reject rules with browser-specific modifiers ($image, $script, etc.)
    // DNS operates purely on domain resolution and cannot filter by HTTP request type
    if (pattern.includes('$')) {
      const parts = pattern.split('$');
      const modifiers = parts[1].split(',');
      const hasBrowserModifier = modifiers.some((mod) => {
        const name = mod.split('=')[0].trim().toLowerCase();
        return BROWSER_ONLY_MODIFIERS.has(name);
      });
      if (hasBrowserModifier) {
        return; // Skip browser-specific resource rule
      }
      pattern = parts[0];
    }

    let isWildcard = false;
    if (pattern.startsWith('||')) {
      isWildcard = true;
      pattern = pattern.substring(2);
    }

    // 3. Strip hosts file IP prefixes (0.0.0.0, 127.0.0.1)
    pattern = pattern.replace(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+/, '');

    // 4. Reject rules with URL paths (e.g. ||news.com/ads/*)
    // Blocking a path rule at DNS level would sinkhole the entire parent domain!
    pattern = pattern.replace(/\^.*$/, '');
    if (pattern.includes('/')) {
      return; // Skip path-specific rule
    }

    pattern = pattern.replace(/[/^].*$/, '').toLowerCase().trim();
    pattern = pattern.replace(/\.+$/, '');
    if (!pattern) return;

    // Validate domain syntax (RFC 1123)
    if (!/^[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?)+$/.test(pattern)) {
      return;
    }

    const labels = pattern.split('.').reverse();
    let current = this.root;

    for (const label of labels) {
      if (!current.children.has(label)) {
        current.children.set(label, { children: new Map() });
      }
      current = current.children.get(label)!;
    }

    const entry: RuleEntry = { ruleText: trimmed, isImportant };

    if (isException) {
      current.exception = entry;
    } else if (isWildcard) {
      current.wildcardBlock = entry;
    } else {
      current.exactBlock = entry;
    }
  }

  /**
   * Evaluates a domain against the trie obeying Blockingmachine rule precedence.
   */
  evaluate(domain: string): EvaluationResult {
    const clean = domain.trim().toLowerCase().replace(/\.$/, '');
    const labels = clean.split('.').reverse();

    let current = this.root;
    let matchedBlock: RuleEntry | null = null;
    let matchedException: RuleEntry | null = null;

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (!current.children.has(label)) break;
      current = current.children.get(label)!;

      const isExactTerminal = i === labels.length - 1;

      if (current.exception) {
        matchedException = current.exception;
      }
      if (current.wildcardBlock) {
        matchedBlock = current.wildcardBlock;
      } else if (isExactTerminal && current.exactBlock) {
        matchedBlock = current.exactBlock;
      }
    }

    // Precedence resolution:
    // 1. $important exception overrides $important block
    // 2. $important block overrides normal exception
    // 3. Normal exception overrides normal block
    if (matchedException && matchedException.isImportant) {
      return { domain: clean, verdict: 'EXCEPTION', matchingRule: matchedException.ruleText, isImportant: true };
    }
    if (matchedBlock && matchedBlock.isImportant) {
      return { domain: clean, verdict: 'BLOCKED', matchingRule: matchedBlock.ruleText, isImportant: true };
    }
    if (matchedException) {
      return { domain: clean, verdict: 'EXCEPTION', matchingRule: matchedException.ruleText };
    }
    if (matchedBlock) {
      return { domain: clean, verdict: 'BLOCKED', matchingRule: matchedBlock.ruleText };
    }

    return { domain: clean, verdict: 'ALLOWED' };
  }
}
