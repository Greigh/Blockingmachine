import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_STATIC_TIER_IDS,
  DEFAULT_ENABLED_TIER_IDS,
  MV3_STATIC_LIMITS,
  PRIORITY_STATIC_TIER,
  STATIC_RULE_TIERS,
  buildTierStatus,
  diffRulesets,
  formatTierCapacity,
  isTierId,
  manifestRuleResources,
  resolveEnabledTierIds,
  summarizeTierCapacity,
  tierById,
  tierRuleCount,
  validateTierRuleset,
} from '../shared/rulesetTiers.js';
import { PRIORITY_EXCEPTION, PRIORITY_SITE_PAUSE, PRIORITY_USER_ALLOW } from '../shared/constants.js';

const extensionRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'));

function readTier(path: string): unknown {
  return JSON.parse(readFileSync(join(extensionRoot, path), 'utf8'));
}

describe('static ruleset tier catalogue', () => {
  test('the manifest declares exactly the catalogue, with matching paths and defaults', () => {
    // The manifest is hand-maintained JSON, so this is the guard that keeps it honest:
    // a tier added to the catalogue without a manifest entry would never load.
    expect(manifest.declarative_net_request.rule_resources).toEqual(manifestRuleResources());
  });

  test('manifest rule ids are valid ruleset identifiers and declared once each', () => {
    const ids = manifest.declarative_net_request.rule_resources.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(isTierId(id)).toBe(true);
    }
  });

  test('the enabled-in-manifest tiers are exactly the catalogue defaults', () => {
    const enabled = manifest.declarative_net_request.rule_resources
      .filter((r: any) => r.enabled)
      .map((r: any) => r.id);
    expect(enabled).toEqual([...DEFAULT_ENABLED_TIER_IDS]);
    expect(enabled).toEqual(['tier_core']);
  });

  test('every shipped ruleset file exists, is valid, and matches its declared rule count', () => {
    for (const tier of STATIC_RULE_TIERS) {
      const rules = readTier(tier.path);
      const result = validateTierRuleset(rules, tier.id);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      // The popup shows this number without reading the file, so drift is a UI lie.
      // `tierRuleCount` resolves the packaging compiler's count when tiers were compiled
      // from the hub's blocklist, and the curated catalogue otherwise.
      expect(result.ruleCount).toBe(tierRuleCount(tier));
    }
  });

  test('declared rule counts add up to the real total', () => {
    const summary = summarizeTierCapacity(ALL_STATIC_TIER_IDS);
    const realTotal = STATIC_RULE_TIERS.reduce(
      (sum, tier) => sum + (readTier(tier.path) as unknown[]).length,
      0,
    );
    expect(summary.totalRules).toBe(realTotal);
  });

  test('every tier rule uses a domain-anchored filter, never a bare label', () => {
    for (const tier of STATIC_RULE_TIERS) {
      for (const rule of readTier(tier.path) as Array<{ condition: { urlFilter: string } }>) {
        // `||label^` on a public suffix or a single label would block far too much.
        expect(rule.condition.urlFilter).toMatch(/^\|\|[a-z0-9-]+(\.[a-z0-9-]+)+\^$/);
      }
    }
  });

  test('no tier rule can outrank a synced exception or a user decision', () => {
    for (const tier of STATIC_RULE_TIERS) {
      for (const rule of readTier(tier.path) as Array<{ priority: number; action: { type: string } }>) {
        // Static rules already lose priority ties to dynamic and session rules; keeping every
        // tier at the bottom band means even a same-priority exception still beats a tier.
        expect(rule.priority).toBe(PRIORITY_STATIC_TIER);
        expect(rule.priority).toBeLessThan(PRIORITY_EXCEPTION);
        expect(rule.priority).toBeLessThan(PRIORITY_USER_ALLOW);
        expect(rule.priority).toBeLessThan(PRIORITY_SITE_PAUSE);
        // And it has to be a *block*. Priorities are compared across every match, so a static
        // allow parked at 2 would beat a dynamic block at 1 — a shipped list overriding the
        // extension's own blocking, which is the failure the bottom band exists to prevent.
        expect(rule.action.type).toBe('block');
      }
    }
  });

  test('the compliance script enforces the same two rules this module pins', () => {
    // The suite runs the shipped files; the compliance script runs the bytes Chrome parses at
    // package time. They have to agree, and neither imports the other, so the agreement is
    // pinned here rather than assumed: a script that stopped checking the action, or that pinned
    // a priority the module no longer uses, would let a bad tier through the release gate.
    const script = readFileSync(
      join(extensionRoot, '../../scripts/verify-mv3-compliance.mjs'),
      'utf8',
    );
    expect(script).toContain(`const STATIC_TIER_PRIORITY = ${PRIORITY_STATIC_TIER};`);
    expect(script).toContain("rule.action.type !== 'block'");
  });

  test('the shipped tiers stay well inside the guaranteed static budget', () => {
    const summary = summarizeTierCapacity(ALL_STATIC_TIER_IDS);
    expect(summary.totalRules).toBeLessThanOrEqual(MV3_STATIC_LIMITS.GUARANTEED_STATIC_RULES);
    expect(STATIC_RULE_TIERS.length).toBeLessThanOrEqual(MV3_STATIC_LIMITS.MAX_STATIC_RULESETS);
  });
});

describe('tier state normalization', () => {
  test('an unsaved state falls back to the defaults', () => {
    expect(resolveEnabledTierIds(undefined)).toEqual(['tier_core']);
    expect(resolveEnabledTierIds(null)).toEqual(['tier_core']);
    expect(resolveEnabledTierIds('tier_ads')).toEqual(['tier_core']);
  });

  test('an explicitly empty selection stays empty instead of reverting to the defaults', () => {
    // The distinction that matters: `[]` is "the user turned everything off", not "unset".
    expect(resolveEnabledTierIds([])).toEqual([]);
    expect(resolveEnabledTierIds(['tier_core'])).toEqual(['tier_core']);
  });

  test('unknown ids are dropped and duplicates collapse', () => {
    expect(resolveEnabledTierIds(['tier_ads', 'tier_ads', 'not-a-tier', 7, null])).toEqual(['tier_ads']);
  });

  test('isTierId and tierById only accept real tiers', () => {
    expect(isTierId('tier_privacy')).toBe(true);
    expect(isTierId('tier_nope')).toBe(false);
    expect(tierById('tier_privacy')?.ruleCount).toBe(36);
    expect(tierById('tier_core')?.defaultEnabled).toBe(true);
  });
});

describe('ruleset diffing', () => {
  test('computes the minimal enable/disable call', () => {
    expect(diffRulesets(['tier_core'], ['tier_core', 'tier_ads'])).toEqual({
      enableRulesetIds: ['tier_ads'],
      disableRulesetIds: [],
    });
    expect(diffRulesets(['tier_core', 'tier_ads'], ['tier_core'])).toEqual({
      enableRulesetIds: [],
      disableRulesetIds: ['tier_ads'],
    });
    expect(diffRulesets(['tier_core'], [])).toEqual({
      enableRulesetIds: [],
      disableRulesetIds: ['tier_core'],
    });
  });

  test('is a no-op when nothing changed, so no wakeup is wasted', () => {
    const enabled = ['tier_core', 'tier_ads'];
    expect(diffRulesets(enabled, enabled)).toEqual({ enableRulesetIds: [], disableRulesetIds: [] });
  });
});

describe('tier capacity', () => {
  test('counts active rules and remaining static slots', () => {
    const none = summarizeTierCapacity([]);
    expect(none.enabledRules).toBe(0);
    expect(none.headroom).toBe(MV3_STATIC_LIMITS.GUARANTEED_STATIC_RULES);
    expect(none.enabledTiers).toBe(0);
    expect(none.totalTiers).toBe(STATIC_RULE_TIERS.length);

    // Derived from `tierRuleCount`, never hardcoded: the packaging compiler rewrites the
    // tier files from the hub's blocklist, so a frozen number here would make `npm test`
    // fail for anyone who had just run a package build.
    const coreRules = tierRuleCount(tierById('tier_core')!);
    const coreOnly = summarizeTierCapacity(['tier_core']);
    expect(coreOnly.enabledRules).toBe(coreRules);
    expect(coreOnly.disabledRules).toBe(coreOnly.totalRules - coreRules);

    const all = summarizeTierCapacity(ALL_STATIC_TIER_IDS);
    expect(all.enabledRules).toBe(all.totalRules);
    expect(all.headroom).toBe(MV3_STATIC_LIMITS.GUARANTEED_STATIC_RULES - all.totalRules);
  });

  test('formats a human line for the popup', () => {
    const coreRules = tierRuleCount(tierById('tier_core')!);
    expect(formatTierCapacity(summarizeTierCapacity(['tier_core']))).toContain(
      `${coreRules} static rules active`,
    );
    expect(formatTierCapacity(summarizeTierCapacity(['tier_core']))).toContain('slots free');
    // Singular, because "1 rules" reads as a bug to a user.
    expect(formatTierCapacity({ ...summarizeTierCapacity(['tier_core']), enabledRules: 1 })).toContain('1 static rule active');
  });

  test('builds a per-tier status with enablement, descriptions, and live diagnostics', () => {
    const status = buildTierStatus(['tier_core', 'tier_annoyances'], 29700);
    expect(status.tiers).toHaveLength(STATIC_RULE_TIERS.length);
    expect(status.tiers.map((t) => t.id)).toEqual([...ALL_STATIC_TIER_IDS]);

    const core = status.tiers.find((t) => t.id === 'tier_core')!;
    expect(core.enabled).toBe(true);
    expect(core.ruleCount).toBe(tierRuleCount(tierById('tier_core')!));
    expect(core.label).toMatch(/core/i);
    expect(core.description.length).toBeGreaterThan(10);

    const ads = status.tiers.find((t) => t.id === 'tier_ads')!;
    expect(ads.enabled).toBe(false);

    expect(status.enabledTiers).toBe(2);
    expect(status.enabledRules).toBe(
      tierRuleCount(tierById('tier_core')!) + tierRuleCount(tierById('tier_annoyances')!),
    );
    expect(status.availableStaticRules).toBe(29700);
  });

  test('reports a null availability when the browser does not expose it', () => {
    expect(buildTierStatus(['tier_core']).availableStaticRules).toBeNull();
  });

  test('carries the suspended flag without disturbing the selection', () => {
    expect(buildTierStatus(['tier_core']).suspended).toBe(false);
    const paused = buildTierStatus(['tier_core'], 29976, true);
    expect(paused.suspended).toBe(true);
    // The selection is what the user chose, independent of whether it is currently silencing.
    expect(paused.tiers.find((t) => t.id === 'tier_core')?.enabled).toBe(true);
  });
});

describe('tier ruleset validation', () => {
  const validRule = {
    id: 1,
    priority: PRIORITY_STATIC_TIER,
    action: { type: 'block' },
    condition: { urlFilter: '||example.com^' },
  };

  test('accepts a well-formed ruleset', () => {
    const result = validateTierRuleset([validRule], 'tier_test');
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.ruleCount).toBe(1);
  });

  test('rejects a non-array or an empty ruleset', () => {
    expect(validateTierRuleset({}, 'tier_test').ok).toBe(false);
    expect(validateTierRuleset([], 'tier_test').ok).toBe(false);
    expect(validateTierRuleset([], 'tier_test').errors[0]).toMatch(/empty/);
  });

  test('rejects duplicate and non-positive rule ids', () => {
    const rule = (id: number) => ({ ...validRule, id });
    const duplicate = validateTierRuleset([rule(1), rule(1)], 'tier_test');
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors.some((e) => /duplicate rule id/.test(e))).toBe(true);

    expect(validateTierRuleset([rule(0)], 'tier_test').ok).toBe(false);
    expect(validateTierRuleset([{ ...validRule, id: '1' }], 'tier_test').ok).toBe(false);
  });

  test('rejects any priority that could outrank the dynamic or user bands', () => {
    const result = validateTierRuleset([{ ...validRule, priority: PRIORITY_EXCEPTION }], 'tier_test');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /precedence/.test(e))).toBe(true);
    expect(validateTierRuleset([{ ...validRule, priority: 0 }], 'tier_test').ok).toBe(false);
  });

  test('rejects exception and redirect actions in a tier', () => {
    const allow = validateTierRuleset([{ ...validRule, action: { type: 'allow' } }], 'tier_test');
    expect(allow.ok).toBe(false);
    expect(allow.errors.some((e) => /block rules/.test(e))).toBe(true);
  });

  test('rejects a missing, whitespace-bearing, or non-ASCII urlFilter', () => {
    expect(validateTierRuleset([{ ...validRule, condition: {} }], 'tier_test').ok).toBe(false);
    expect(
      validateTierRuleset([{ ...validRule, condition: { urlFilter: '||a b^' } }], 'tier_test').ok,
    ).toBe(false);
    expect(
      validateTierRuleset([{ ...validRule, condition: { urlFilter: '||exämple.com^' } }], 'tier_test').ok,
    ).toBe(false);
  });

  test('rejects an empty resourceTypes list when the key is present', () => {
    expect(
      validateTierRuleset([{ ...validRule, condition: { urlFilter: '||a.com^', resourceTypes: [] } }], 'tier_test').ok,
    ).toBe(false);
    expect(
      validateTierRuleset(
        [{ ...validRule, condition: { urlFilter: '||a.com^', resourceTypes: ['script', 'image'] } }],
        'tier_test',
      ).ok,
    ).toBe(true);
  });
});
