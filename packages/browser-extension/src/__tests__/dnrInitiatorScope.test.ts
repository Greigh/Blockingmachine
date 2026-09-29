import { describe, test, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilterRule, planListRules } from '../background/dnrManager.js';

/**
 * Measures the initiator-scoping change against the real compiled browser export rather than a
 * handful of toy rules.
 *
 * The claim under test is precise: a filter line that declares its own per-site scope (`$domain=`)
 * must never be shipped as a rule that applies everywhere, and expressing that scope must not cost
 * one DNR rule per site. Both are properties of the whole list, so they are asserted on the whole
 * list.
 */
const extensionRoot = fileURLToPath(new URL('../../', import.meta.url));
const compiledListPath = join(extensionRoot, '../cli/filters/output/genericBrowserRules.txt');

const describeRealList = existsSync(compiledListPath) ? describe : describe.skip;

describeRealList('initiator scoping against the real compiled list', () => {
  const lines = readFileSync(compiledListPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  test('no rule that declares a $domain= scope is ever emitted globally', () => {
    const scopedLines = lines.filter((line) => line.includes('$domain='));
    expect(scopedLines.length).toBeGreaterThan(500);

    let scoped = 0;
    let refused = 0;
    for (const line of scopedLines) {
      const parsed = parseFilterRule(line);
      if (!parsed) {
        // Cosmetic lines, and rules whose declared scope has no DNR equivalent, are dropped
        // rather than widened into a global block.
        refused++;
        continue;
      }
      const carriesScope =
        (parsed.initiatorDomains?.length ?? 0) > 0 ||
        (parsed.excludedInitiatorDomains?.length ?? 0) > 0;
      expect(carriesScope).toBe(true);
      scoped++;
    }

    // The overwhelming majority is expressible; the few that are not are refused, not broadened.
    expect(scoped).toBeGreaterThan(500);
    expect(scoped).toBeGreaterThan(refused);
  });

  test('per-site scoping costs one rule per filter line, not one per site', () => {
    const plan = planListRules(lines, {}, Number.MAX_SAFE_INTEGER);

    expect(plan.overflow).toBe(0);
    // Merging scoped variants means the compiled rule set is never larger than the list.
    expect(plan.rules.length).toBeLessThanOrEqual(plan.offered);
    expect(plan.scoped).toBeGreaterThan(500);
    const pathPreserving = plan.rules.filter(
      (rule) => rule.pattern.startsWith('||') && rule.pattern.slice(2).includes('/'),
    ).length;
    // These lines used to collapse into a whole-zone `||host^` block that broke the site's own
    // resources; they now keep the path the list actually named.
    expect(pathPreserving).toBeGreaterThan(1000);

    const zoneBlocks = plan.rules.filter(
      (rule) => /^\|\|[^/]+\^$/.test(rule.pattern) && !rule.initiatorDomains,
    ).length;

    console.log(
      `\n[initiator scope] ${plan.offered.toLocaleString()} lines -> ${plan.rules.length.toLocaleString()} rules | ` +
        `${plan.scoped.toLocaleString()} per-site scoped | ${pathPreserving.toLocaleString()} path-preserving | ` +
        `${zoneBlocks.toLocaleString()} global zone blocks | ${plan.skipped.toLocaleString()} skipped`,
    );
  });

  test('no emitted block is already covered by a global zone block', () => {
    const plan = planListRules(lines, {}, Number.MAX_SAFE_INTEGER);

    const zonePriority = new Map<string, number>();
    for (const rule of plan.rules) {
      const host = /^\|\|([^/|^]+)\^$/.exec(rule.pattern)?.[1];
      if (!host || rule.action !== 'block') continue;
      if (rule.initiatorDomains?.length || rule.excludedInitiatorDomains?.length) continue;
      zonePriority.set(host, Math.max(zonePriority.get(host) ?? 0, rule.priority));
    }

    const redundant = plan.rules.filter((rule) => {
      if (rule.action !== 'block') return false;
      const isGlobalZone =
        /^\|\|[^/|^]+\^$/.test(rule.pattern) &&
        !rule.initiatorDomains &&
        !rule.excludedInitiatorDomains;
      if (isGlobalZone) return false;
      const host = /^\|\|([^/|^]+)[/^]/.exec(rule.pattern)?.[1];
      if (!host) return false;
      const covering = zonePriority.get(host);
      return covering !== undefined && rule.priority <= covering;
    });

    // A precise rule that its own zone block already covers can never be the rule that fires, so
    // shipping it would only make path handling cost more rules than the zone collapse it replaces.
    expect(redundant).toEqual([]);
  });
});
