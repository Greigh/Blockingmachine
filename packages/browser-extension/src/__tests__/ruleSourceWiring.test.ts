/**
 * The "rule source" row in the popup is only honest if the status channel serves the record of
 * what the last apply installed — not a recount, and not a guess from the rule count. Because
 * `background/index.ts` starts the service worker on import, the seam is pinned by reading the
 * source, the way `rulesetReportWiring.test.ts` pins the tier readout. The behavioural half —
 * that `updateDynamicRules` reports the plan `chooseRuleSource` selected, and only after the
 * browser accepted it — lives in `hotRuleSource.test.ts`.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'background', 'index.ts'),
  'utf8',
);

describe('the applied rule source reaching the popup', () => {
  test('the apply path records the source the planner installed', () => {
    // The callback belongs inside the same apply call that chooses the source: any other
    // reporting path would be a second opinion about a decision already taken.
    const apply = src.indexOf('onRuleSource:');
    expect(apply).toBeGreaterThan(-1);
    expect(src.indexOf('saveRuleSource')).toBeGreaterThan(-1);
    expect(src).toContain('STORAGE_KEY_RULE_SOURCE');
  });

  test('the record is written from the callback, after the apply succeeded', () => {
    // Persisting anywhere before the browser's update resolved would leave the popup claiming a
    // source a rejected batch never installed.
    const dnr = readFileSync(
      join(fileURLToPath(new URL('..', import.meta.url)), 'background', 'dnrManager.ts'),
      'utf8',
    );
    const applyResolved = dnr.indexOf('await chrome.declarativeNetRequest.updateDynamicRules');
    const reported = dnr.indexOf('options.onRuleSource?.(');
    expect(applyResolved).toBeGreaterThan(-1);
    expect(reported).toBeGreaterThan(applyResolved);
    // And between the two sits the throw that keeps a failure silent.
    const between = dnr.slice(applyResolved, reported);
    expect(between).toContain('catch');
    expect(between).toContain('throw');
  });

  test('GET_MV3_STATUS serves the persisted record alongside the quota', () => {
    const handler = src.indexOf("case 'GET_MV3_STATUS'");
    expect(handler).toBeGreaterThan(-1);
    const block = src.slice(handler, src.indexOf('return true;', handler));
    expect(block).toContain('loadRuleSource()');
    expect(block).toContain('ruleSource');
    // Quota still comes from the browser's own reading — the record supplements, never replaces.
    expect(block).toContain('Mv3Guard.getQuotaStatus()');
  });

  test('the benefit ranking feeds the apply, built before the plan needs it', () => {
    // The no-hot-set fallback is only a fallback if it is actually wired in: the index builds
    // from the shipped tier files, weighted by the deployment's own tier tally, and the apply
    // awaits it before the planner runs — a rank that arrives late is a prefix that claims
    // otherwise.
    expect(src).toContain('new TierBenefitIndex({');
    expect(src).toContain('readTier: readTierFile');
    expect(src).toContain('ruleHits.snapshot().tiers');
    const ensure = src.indexOf('tierBenefitIndex.ensure()');
    const passed = src.indexOf('benefitRank:');
    expect(ensure).toBeGreaterThan(-1);
    expect(passed).toBeGreaterThan(ensure);
  });
});
