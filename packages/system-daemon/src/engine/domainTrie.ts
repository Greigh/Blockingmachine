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

/**
 * Domain Suffix Trie
 * Reverses domain labels (e.g. ['net', 'doubleclick', 'ad']) to enable
 * O(k) sub-microsecond longest-suffix match against wildcards and exact rules.
 */
export class DomainTrie {
  private root: TrieNode = { children: new Map() };

  /**
   * Adds an adblock or hosts rule to the index.
   */
  addRule(rawRule: string): void {
    const trimmed = rawRule.trim();
    if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('#')) return;

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

    let isWildcard = false;
    if (pattern.startsWith('||')) {
      isWildcard = true;
      pattern = pattern.substring(2);
    }

    // Strip trailing carat or path specifiers
    pattern = pattern.replace(/\^.*$/, '').replace(/[/^].*$/, '').toLowerCase();
    if (!pattern) return;

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
