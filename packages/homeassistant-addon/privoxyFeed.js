/**
 * Privoxy action-file generation for the Home Assistant add-on.
 *
 * Privoxy cannot subscribe to a blocklist: `actionsfile` names a file in its config directory and
 * nothing else, and it is re-read only at startup. So the deployment is a `curl` copy step plus a
 * restart — and until this route existed the only host answering for the fetch was the desktop
 * hub, which stops answering whenever the laptop sleeps. The add-on is already the long-lived
 * service on that LAN, so it renders the action file from the same DNS feed the Unbound drop-in
 * and the Shadowrocket rule set are rendered from, and the proxy host fetches from the add-on.
 *
 * Three properties of the format are load-bearing, and they are why this is not the DNS feed with
 * a different extension:
 *
 *   - The patterns live under a **`{+block{…}}` section**. A pattern with no action block above it
 *     belongs to nothing, so the section header is part of the artifact, not decoration.
 *   - The pattern is **`.host` with a leading dot**. A bare host in an action file matches that
 *     host only, so every subdomain of a blocked domain would be missed — the same defect class
 *     as BIND's bare QNAME trigger, fixed the same way.
 *   - Privoxy is **last-match-wins**, the opposite of a Shadowrocket rule set, so a bypass has to
 *     be emitted *after* the block section it escapes, in a `{-block}` section at the end.
 *
 * The rule-to-host step lives in `hostRules.js`, shared with the other feeds — the whole point of
 * the module: a host one feed fails to parse is a host sinkholed in the resolver but reachable
 * through the proxy.
 */

import { hostFromRule } from './hostRules.js';

/**
 * The section markers, identical to the desktop exporter's constants.
 *
 * `Blockingmachine Blocklist` inside the braces is the reason Privoxy logs when it blocks, and it
 * has to spell exactly what the desktop artifact spells or a diff between the two reads as drift.
 */
const BLOCK_SECTION = '{+block{Blockingmachine Blocklist}}';
const BYPASS_SECTION = '{-block}';

/** One action-file pattern for a host — the leading dot matches the domain and all subdomains. */
function patternLine(host) {
  return `.${host}`;
}

/**
 * The pattern one feed line contributes, with the section it belongs under.
 *
 * Returns null for anything that is not a block or an allow — cosmetic rules, comments and
 * directives act on a document, not on a URL pattern. Allows are returned rather than dropped
 * because the action file *can* express them: `{-block}` after the block section releases the
 * host and everything under it, and for an allow whose parent was never blocked that entry is a
 * no-op rather than a wrong answer.
 */
export function privoxyPatternFromRule(rule) {
  const parsed = hostFromRule(rule);
  if (!parsed) return null;
  return { pattern: patternLine(parsed.host), allowed: parsed.allowed };
}

/**
 * Converts a whole feed into sorted, de-duplicated patterns, **blocks before allows**.
 *
 * De-duplication happens on the rendered pattern, so `||ads.example^` and `0.0.0.0 ads.example`
 * collapse into one `.ads.example` instead of two identical matches. The two groups are sorted
 * independently and the allows are emitted last as a class, because last-match-wins is the
 * mechanism that makes a child bypass work — interleaving them alphabetically would put
 * `.parent.example` after `.child.parent.example` and silently re-block the child.
 */
export function rulesToPrivoxyPatterns(rules) {
  const blocks = new Set();
  const allows = new Set();

  for (const rule of Array.isArray(rules) ? rules : []) {
    const parsed = hostFromRule(rule);
    if (!parsed) continue;
    (parsed.allowed ? allows : blocks).add(patternLine(parsed.host));
  }

  return {
    blocks: [...blocks].sort(),
    // A direct contradiction (`||x^` and `@@||x^` in the same feed) is left in both sets: the
    // bypass section is emitted after the block section, so last-match-wins resolves it to the
    // allow — the same answer Shadowrocket's first-match-wins gives to the same pair.
    allows: [...allows].sort(),
  };
}

/**
 * Renders the action file the Privoxy feed serves.
 *
 * Comments are `#` because that is what an action file accepts, and the bypass section is only
 * emitted when there is something in it — an empty `{-block}` section parses fine but tells the
 * reader there are exceptions when there are none.
 */
export function renderPrivoxyFeed(rules, { generatedAt = new Date().toISOString() } = {}) {
  const { blocks, allows } = rulesToPrivoxyPatterns(rules);
  const header = [
    '# Blockingmachine — Privoxy action file',
    `# Generated: ${generatedAt}`,
    `# Patterns: ${blocks.length} blocked${allows.length ? `, ${allows.length} allowed` : ''}`,
    '# Copy into the Privoxy config directory, name it in an actionsfile line, and restart.',
    '# Do not edit by hand, it is regenerated.',
    '',
    BLOCK_SECTION,
  ];
  const body = [...blocks];
  if (allows.length > 0) {
    body.push('', BYPASS_SECTION, ...allows);
  }
  return `${[...header, ...body].join('\n')}\n`;
}

/**
 * The pattern count the add-on's status payload and dashboard report.
 *
 * Counts rendered patterns rather than input lines, so the number the card shows is the number
 * Privoxy will actually read.
 */
export function privoxyPatternCount(rules) {
  const { blocks, allows } = rulesToPrivoxyPatterns(rules);
  return blocks.length + allows.length;
}
