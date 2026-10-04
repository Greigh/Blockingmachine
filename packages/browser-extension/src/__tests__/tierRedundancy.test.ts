/**
 * The live-rules redundancy diff behind `GET_TIER_REDUNDANCY`.
 *
 * What is worth pinning is the agreement between this read and the one the hub and CLI print:
 * a tier is redundant only when the installed rules already block everything it ships, and a
 * rule that blocks less than a whole domain can never produce that verdict. The failures that
 * matter are all inversions of that — a scoped rule retiring a tier, an exception counted as
 * coverage, or a browser refusal rendered as "nothing redundant".
 *
 * `readTier` is injected the way `StaticRuleIndex` injects it: in production it fetches the
 * shipped files through `chrome.runtime.getURL`; here it answers from a map, so the diff is
 * exercised without a browser.
 */

import { describe, expect, test } from '@jest/globals';
import { computeTierRedundancy } from '../background/tierRedundancy.js';

const BLOCK_TYPES = ['script', 'image', 'xmlhttprequest', 'sub_frame', 'media', 'ping'];

/** A dynamic rule as `getDynamicRules` returns it — the compiled host-block shape. */
const dnrRule = (
  urlFilter: string,
  action: 'block' | 'allow' | 'allowAllRequests' = 'block',
  condition: Record<string, unknown> = {},
) => ({
  id: 1,
  priority: 1,
  action: { type: action },
  condition: { urlFilter, resourceTypes: [...BLOCK_TYPES], ...condition },
});

const tierFile = (hosts: string[]) =>
  hosts.map((host, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: `||${host}^` },
  }));

const TIERS = [
  { id: 'tier_core', path: 'rules/tier_core.json' },
  { id: 'tier_ads', path: 'rules/tier_ads.json' },
] as const;

function readTierFrom(files: Record<string, unknown>) {
  return async (path: string) => {
    if (!(path in files)) throw new Error(`HTTP 404`);
    return files[path];
  };
}

describe('computeTierRedundancy', () => {
  test('a compiled six-type block host-covers but never fully covers an all-types tier rule', async () => {
    const report = await computeTierRedundancy({
      rules: [dnrRule('||a.com^'), dnrRule('||b.com^'), dnrRule('||ads.net^')],
      readTier: readTierFrom({
        'rules/tier_core.json': tierFile(['a.com', 'b.com']),
        'rules/tier_ads.json': tierFile(['ads.net', 'fresh.com']),
      }),
      tiers: TIERS,
    });

    expect(report.synced).toEqual({ hosts: 3, exceptions: 0, lines: 3, skipped: 0 });
    expect(report.tiers.tier_core).toEqual({
      total: 2,
      // Host-covered but never *fully* covered: the compiled blocks claim six resource
      // types, the tier's `||host^` claims all of them — navigations and websockets still
      // rely on the tier, so "redundant" would be an overclaim.
      redundant: { rules: 2, hosts: 2, typeLimited: 2, complete: false },
      userCovered: null,
    });
    // One rule of two covered: partially duplicated and still load-bearing.
    expect(report.tiers.tier_ads).toEqual({
      total: 2,
      redundant: { rules: 1, hosts: 1, typeLimited: 1, complete: false },
      userCovered: null,
    });
    expect(report.redundantTiers).toEqual([]);
  });

  test('an unrestricted covering rule still completes a tier — the rung is honest, not dead', async () => {
    // `complete` must be reachable or the flag means nothing: a dynamic rule carrying *no*
    // `resourceTypes` claims every type, so it covers the tier's all-types claim outright.
    const unrestricted = (urlFilter: string) => ({
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter },
    });
    const report = await computeTierRedundancy({
      rules: [unrestricted('||a.com^'), unrestricted('||b.com^')],
      readTier: readTierFrom({
        'rules/tier_core.json': tierFile(['a.com', 'b.com']),
        'rules/tier_ads.json': tierFile(['fresh.com']),
      }),
      tiers: TIERS,
    });

    expect(report.tiers.tier_core?.redundant).toEqual({ rules: 2, hosts: 2, typeLimited: 0, complete: true });
    expect(report.redundantTiers).toEqual(['tier_core']);
  });

  test('a rule the user installed is their coverage, not the list\'s', async () => {
    // `userPatterns` is the provenance record — the filters `planListRules(customRules)` produced.
    // A hand-typed `||a.com^` shares the list's priority band, so without the set there is no
    // honest way to tell it from a synced rule; with it, the coverage is credited correctly.
    const report = await computeTierRedundancy({
      rules: [dnrRule('||a.com^'), dnrRule('||b.com^'), dnrRule('||ads.net^')],
      userPatterns: new Set(['||a.com^']),
      readTier: readTierFrom({
        'rules/tier_core.json': tierFile(['a.com', 'b.com']),
        'rules/tier_ads.json': tierFile(['ads.net']),
      }),
      tiers: TIERS,
    });

    // The synced read sees only what the list installed — `a.com` is the user's.
    expect(report.synced).toEqual({ hosts: 2, exceptions: 0, lines: 2, skipped: 0 });
    expect(report.userOwned).toEqual({ hosts: 1, exceptions: 0, lines: 1, skipped: 0 });
    // `tier_core` is only half-covered by the list: no longer "redundant" in a way that invites
    // turning it off, and the half the user carries is named as theirs.
    expect(report.tiers.tier_core?.redundant).toEqual({ rules: 1, hosts: 1, typeLimited: 1, complete: false });
    expect(report.tiers.tier_core?.userCovered).toEqual({ rules: 1, hosts: 1, typeLimited: 1, complete: false });
    expect(report.redundantTiers).toEqual([]);
  });

  test('a tier covered entirely by the user is not reported as redundant with the list', async () => {
    const report = await computeTierRedundancy({
      rules: [dnrRule('||a.com^'), dnrRule('||b.com^')],
      userPatterns: new Set(['||a.com^', '||b.com^']),
      readTier: readTierFrom({
        'rules/tier_core.json': tierFile(['a.com', 'b.com']),
        'rules/tier_ads.json': tierFile(['fresh.com']),
      }),
      tiers: TIERS,
    });

    expect(report.tiers.tier_core?.redundant).toEqual({ rules: 0, hosts: 0, typeLimited: 0, complete: false });
    expect(report.tiers.tier_core?.userCovered).toEqual({ rules: 2, hosts: 2, typeLimited: 2, complete: false });
    expect(report.redundantTiers).toEqual([]);
  });

  test('a scoped dynamic rule cannot retire a tier, and an exception keeps it load-bearing', async () => {
    const report = await computeTierRedundancy({
      rules: [
        // Scoped to one site — a `$domain=` rule in rule form, refused exactly as the text reader
        // refuses it. `site-scoped.com` never enters the blocked set.
        dnrRule('||site-scoped.com^', 'block', { initiatorDomains: ['shop.example'] }),
        // The parent is blocked but one subdomain is excepted, so the tier is still the only
        // thing blocking `allowed.tracker.com`.
        dnrRule('||tracker.com^'),
        dnrRule('||allowed.tracker.com^', 'allow'),
      ],
      readTier: readTierFrom({
        'rules/tier_core.json': tierFile(['site-scoped.com', 'tracker.com', 'allowed.tracker.com']),
        'rules/tier_ads.json': tierFile(['tracker.com']),
      }),
      tiers: TIERS,
    });

    expect(report.synced).toEqual({ hosts: 1, exceptions: 1, lines: 3, skipped: 1 });
    expect(report.tiers.tier_core?.redundant).toEqual({ rules: 1, hosts: 1, typeLimited: 1, complete: false });
    // `tier_ads` ships only `tracker.com`, which the dynamic block host-covers — the exception is
    // on a subdomain the tier never claimed. Still type-limited, never fully redundant.
    expect(report.tiers.tier_ads?.redundant?.complete).toBe(false);
    expect(report.redundantTiers).toEqual([]);
  });

  test('reports "could not look" as null, never as an empty diff', async () => {
    const report = await computeTierRedundancy({
      rules: null,
      readTier: readTierFrom({ 'rules/tier_core.json': tierFile(['a.com']), 'rules/tier_ads.json': [] }),
      tiers: TIERS,
    });

    // "The browser refused to list its rules" and "nothing was redundant" are different facts,
    // and the popup renders them differently — so the report carries null rather than zeroes.
    expect(report.synced).toBeNull();
    expect(report.tiers.tier_core?.redundant).toBeNull();
    expect(report.tiers.tier_core?.total).toBe(1);
    expect(report.redundantTiers).toEqual([]);
  });

  test('an unreadable tier file leaves its entry null without losing the others', async () => {
    const report = await computeTierRedundancy({
      rules: [dnrRule('||a.com^')],
      readTier: readTierFrom({
        'rules/tier_ads.json': tierFile(['a.com']),
        // tier_core absent: the fetch rejects.
      }),
      tiers: TIERS,
    });

    expect(report.tiers.tier_core).toEqual({ total: null, redundant: null, userCovered: null });
    expect(report.tiers.tier_ads?.redundant?.complete).toBe(false);
    // A tier that could not be read is never named redundant — an unreadable file is not the
    // same finding as a covered one.
    expect(report.redundantTiers).toEqual([]);
  });

  test('with nothing installed there is no coverage to report, and that is not an error', async () => {
    const report = await computeTierRedundancy({
      rules: [],
      readTier: readTierFrom({
        'rules/tier_core.json': tierFile(['a.com']),
        'rules/tier_ads.json': tierFile(['b.com']),
      }),
      tiers: TIERS,
    });

    expect(report.synced).toEqual({ hosts: 0, exceptions: 0, lines: 0, skipped: 0 });
    expect(report.tiers.tier_core?.redundant).toEqual({ rules: 0, hosts: 0, typeLimited: 0, complete: false });
    expect(report.redundantTiers).toEqual([]);
  });

  test('a report is deterministic for the same inputs', async () => {
    const options = {
      rules: [dnrRule('||b.com^'), dnrRule('||a.com^')],
      readTier: readTierFrom({
        'rules/tier_core.json': tierFile(['a.com']),
        'rules/tier_ads.json': tierFile(['b.com']),
      }),
      tiers: TIERS,
    };
    const first = await computeTierRedundancy(options);
    const second = await computeTierRedundancy(options);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
