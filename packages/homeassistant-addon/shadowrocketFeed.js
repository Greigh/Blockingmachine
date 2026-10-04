/**
 * Shadowrocket rule-set generation for the Home Assistant add-on.
 *
 * Shadowrocket is an iOS/iPadOS proxy client, and it is the reason this feed exists on the add-on:
 * the desktop hub's feed is served by a process that has to be running, on a machine that has to be
 * awake, while a phone wants a URL on the house LAN that answers whenever the server does. An
 * add-on is already a long-lived service on that LAN, so it can serve the rule set itself and a
 * phone can subscribe to the add-on rather than to a laptop.
 *
 * Three properties of the format are load-bearing and are the reason this is not just the DNS feed
 * with a different extension:
 *
 *   - The rules live under a **`[Rule]` section**. The app reads them from there; a bare list in the
 *     file is not read at all.
 *   - Comments are **`#`**. `!` is AdGuard syntax and a Shadowrocket config rejects it.
 *   - Rules are **`DOMAIN-SUFFIX`**, not `DOMAIN`. `DOMAIN` matches that host only, so every
 *     subdomain of a blocked domain would be missed — the exact defect the desktop export had.
 *
 * And the one that is easy to get backwards: a Shadowrocket/Surge rule set is **first-match-wins**,
 * so a child that was allowed under a blocked parent has to be emitted *before* the parent that
 * would otherwise swallow it. Unbound resolves on the longest match and Privoxy takes the last
 * match, so the other two feeds order the same exception in the opposite direction.
 */

import { hostFromRule, normalizeHost } from './hostRules.js';

/** The action that blocks, and the one that lets a request through. */
const BLOCK = 'REJECT';
const ALLOW = 'DIRECT';

/** One rendered rule line for a host. `DOMAIN-SUFFIX` covers the domain and everything under it. */
function ruleLine(host, action) {
  return `DOMAIN-SUFFIX,${host},${action}`;
}

/**
 * The Shadowrocket rule for one feed line, or null when the line is neither a block nor an allow.
 *
 * A path- or modifier-scoped rule has no `DOMAIN-SUFFIX` equivalent — the format's answer to a
 * path is a separate rule type, and a `DOMAIN-SUFFIX` block would over-block the whole domain. The
 * host is taken and the scoping dropped, which matches what the DNS feed already decided to keep.
 */
export function shadowrocketRuleFromRule(rule) {
  const parsed = hostFromRule(rule);
  if (!parsed) return null;
  return ruleLine(parsed.host, parsed.allowed ? ALLOW : BLOCK);
}

/**
 * Converts a whole feed into sorted, de-duplicated rule lines, **allows before blocks**.
 *
 * Two decisions worth stating. De-duplication happens on the rendered line, so `||ads.example^`
 * and `0.0.0.0 ads.example` — the same block written two ways — collapse into one rule rather than
 * two that can never both match. And the two groups are sorted independently and concatenated, so
 * the allow rules precede the blocks as a class; interleaving them alphabetically would put
 * `example.com,REJECT` ahead of `sub.example.com,DIRECT` and silently re-block the child.
 */
export function rulesToShadowrocketRules(rules) {
  const allows = new Set();
  const blocks = new Set();

  for (const rule of Array.isArray(rules) ? rules : []) {
    const parsed = hostFromRule(rule);
    if (!parsed) continue;
    (parsed.allowed ? allows : blocks).add(parsed.host);
  }

  const allowLines = [...allows].sort().map((host) => ruleLine(host, ALLOW));
  const blockLines = [...blocks].sort().map((host) => ruleLine(host, BLOCK));
  return [...allowLines, ...blockLines];
}

/**
 * Renders the rule set the Shadowrocket feed serves.
 *
 * The `[Rule]` section header and the `#` comment style are part of what makes the file loadable,
 * so they are asserted in tests rather than left to look like decoration.
 */
export function renderShadowrocketFeed(rules, { generatedAt = new Date().toISOString() } = {}) {
  const lines = rulesToShadowrocketRules(rules);
  const allowCount = lines.filter((line) => line.endsWith(`,${ALLOW}`)).length;
  const header = [
    '# Blockingmachine — Shadowrocket rule set',
    `# Generated: ${generatedAt}`,
    `# Rules: ${lines.length} (${allowCount} allowed before ${lines.length - allowCount} blocked)`,
    '# Subscribe in Shadowrocket with Config → Add Remote Config → Rule Set. Do not edit by hand.',
    '[Rule]',
  ];
  return `${[...header, ...lines].join('\n')}\n`;
}

/**
 * The host names Shadowrocket will match for a set of feed lines.
 *
 * Exported for the add-on's status payload and tests, which want the count and the ordering without
 * re-deriving them from rendered text.
 */
export function shadowrocketHostCount(rules) {
  return new Set(rulesToShadowrocketRules(rules).map((line) => line.split(',')[1])).size;
}

export { normalizeHost };
