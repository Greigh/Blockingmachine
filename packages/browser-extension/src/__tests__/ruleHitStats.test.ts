import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { RuleHitStats } from '../background/ruleHitStats.js';
import {
  RULE_HIT_FLUSH_EVERY,
  RULE_HIT_MAX_TRACKED,
  STORAGE_KEY_RULE_HITS,
  STORAGE_KEY_TIER_HITS,
} from '../shared/constants.js';

interface ChromeStub {
  storageGet: any;
  storageSet: any;
  storageRemove: any;
}

function installChrome(stored?: unknown, tierHits?: unknown): ChromeStub {
  const storageGet = (jest.fn() as any).mockResolvedValue({
    ...(stored === undefined ? {} : { [STORAGE_KEY_RULE_HITS]: stored }),
    ...(tierHits === undefined ? {} : { [STORAGE_KEY_TIER_HITS]: tierHits }),
  });
  const storageSet = (jest.fn() as any).mockResolvedValue(undefined);
  const storageRemove = (jest.fn() as any).mockResolvedValue(undefined);

  (globalThis as any).chrome = {
    storage: { local: { get: storageGet, set: storageSet, remove: storageRemove } },
  };

  return { storageGet, storageSet, storageRemove };
}

beforeEach(() => {
  delete (globalThis as any).chrome;
});

describe('rule hit ledger', () => {
  test('starts empty and reports nothing', () => {
    installChrome();
    const stats = new RuleHitStats();
    expect(stats.snapshot()).toMatchObject({ totalHits: 0, distinctRules: 0, hits: [], text: '' });
  });

  test('restores previously counted rules and ignores malformed entries', async () => {
    installChrome([
      { rule: '||doubleclick.net^', count: 12 },
      { rule: '||adnxs.com^', count: 3 },
      { rule: '', count: 5 },
      { rule: '||zero.example^', count: 0 },
      { rule: '||bad.example^', count: 'lots' },
      null,
    ]);

    const stats = new RuleHitStats();
    await stats.load();
    const snapshot = stats.snapshot();

    expect(snapshot.distinctRules).toBe(2);
    expect(snapshot.totalHits).toBe(15);
    expect(snapshot.hits[0]).toEqual({ rule: '||doubleclick.net^', count: 12 });
  });

  test('accumulates counts per rule and batches the writes', async () => {
    const stub = installChrome();
    const stats = new RuleHitStats();
    await stats.load();

    for (let i = 0; i < RULE_HIT_FLUSH_EVERY - 1; i++) stats.record('||doubleclick.net^');
    // Under the batch size nothing has been written yet...
    expect(stub.storageSet).not.toHaveBeenCalled();

    // ...and the flush that crosses the threshold lands the whole batch at once.
    stats.record('||doubleclick.net^');
    await Promise.resolve();
    await stats.flush();
    expect(stub.storageSet).toHaveBeenCalledWith({
      [STORAGE_KEY_RULE_HITS]: [{ rule: '||doubleclick.net^', count: RULE_HIT_FLUSH_EVERY }],
    });
  });

  test('does not write when nothing was recorded since the last flush', async () => {
    const stub = installChrome();
    const stats = new RuleHitStats();
    await stats.load();
    await stats.flush();
    expect(stub.storageSet).not.toHaveBeenCalled();
  });

  test('rejects empty rules and non-positive counts', async () => {
    installChrome();
    const stats = new RuleHitStats();
    stats.record('');
    stats.record('||a.example^', 0);
    stats.record('||a.example^', -3);
    stats.record('||a.example^', Number.NaN);
    expect(stats.snapshot().distinctRules).toBe(0);
  });

  test('drops the one-off tail once the tracked-rule cap is reached', async () => {
    installChrome();
    const stats = new RuleHitStats();

    // One rule that matters, then far more one-off rules than the cap allows.
    stats.record('||hot.example^', 50);
    for (let i = 0; i < RULE_HIT_MAX_TRACKED + 500; i++) stats.record(`||tail-${i}.example^`);
    await stats.flush();

    const snapshot = stats.snapshot();
    // The cap holds, and the rule with real traffic survived the trim.
    expect(snapshot.distinctRules).toBeLessThanOrEqual(RULE_HIT_MAX_TRACKED);
    expect(snapshot.distinctRules).toBe(RULE_HIT_MAX_TRACKED);
    expect(snapshot.hits[0]).toEqual({ rule: '||hot.example^', count: 50 });
  });

  test('exports a trace the coverage command can read', async () => {
    installChrome();
    const stats = new RuleHitStats();
    stats.record('||doubleclick.net^', 7);
    stats.record('||adnxs.com^', 2);

    const snapshot = stats.snapshot();
    expect(snapshot.text.split('\n')).toEqual(['7\t||doubleclick.net^', '2\t||adnxs.com^']);
    expect(snapshot.totalHits).toBe(9);
  });

  test('survives a storage failure without losing the counts', async () => {
    const stub = installChrome();
    stub.storageSet.mockRejectedValueOnce(new Error('quota'));
    const stats = new RuleHitStats();
    stats.record('||doubleclick.net^', 4);

    await expect(stats.flush()).resolves.toBeUndefined();
    // Still counted in memory, so the next flush can persist it.
    expect(stats.snapshot().hits[0]).toEqual({ rule: '||doubleclick.net^', count: 4 });

    await stats.flush();
    expect(stub.storageSet).toHaveBeenCalledWith({
      [STORAGE_KEY_RULE_HITS]: [{ rule: '||doubleclick.net^', count: 4 }],
    });
  });

  test('reset clears memory and the stored ledger', async () => {
    const stub = installChrome([{ rule: '||doubleclick.net^', count: 9 }], [{ tier: 'tier_ads', count: 4 }]);
    const stats = new RuleHitStats();
    await stats.load();
    await stats.reset();

    expect(stats.snapshot().distinctRules).toBe(0);
    expect(stats.snapshot().tiers).toEqual({});
    expect(stub.storageRemove).toHaveBeenCalledWith([STORAGE_KEY_RULE_HITS, STORAGE_KEY_TIER_HITS]);
  });

  test('attributes matches to a tier separately from the filter histogram', async () => {
    const stub = installChrome();
    const stats = new RuleHitStats();

    // The same filter line can ship in two tiers; the histogram collapses it, the attribution
    // must not.
    stats.record('||doubleclick.net^', 5);
    stats.record('||doubleclick.net^', 2);
    stats.recordTier('tier_ads', 5);
    stats.recordTier('tier_ads', 2);
    stats.recordTier('tier_core', 1);

    const snapshot = stats.snapshot();
    expect(snapshot.distinctRules).toBe(1);
    expect(snapshot.totalHits).toBe(7);
    expect(snapshot.tiers).toEqual({ tier_ads: 7, tier_core: 1 });

    await stats.flush();
    expect(stub.storageSet).toHaveBeenCalledWith({
      [STORAGE_KEY_RULE_HITS]: [{ rule: '||doubleclick.net^', count: 7 }],
      [STORAGE_KEY_TIER_HITS]: [
        { tier: 'tier_ads', count: 7 },
        { tier: 'tier_core', count: 1 },
      ],
    });
  });

  test('leaves the stored shape alone until a tier actually fires', async () => {
    const stub = installChrome();
    const stats = new RuleHitStats();
    stats.record('||doubleclick.net^', 3);
    await stats.flush();

    // Dynamic matches have no tier, and a build without tier attribution has to keep reading this.
    expect(stub.storageSet).toHaveBeenCalledWith({
      [STORAGE_KEY_RULE_HITS]: [{ rule: '||doubleclick.net^', count: 3 }],
    });
  });

  test('restores tier counts and ignores a ruleset that is not a tier', async () => {
    installChrome(undefined, [
      { tier: 'tier_core', count: 8 },
      { tier: 'bm-periodic-sync', count: 3 },
      { tier: 'tier_ads', count: 0 },
      { tier: 'tier_privacy', count: 'lots' },
      null,
    ]);

    const stats = new RuleHitStats();
    await stats.load();
    expect(stats.snapshot().tiers).toEqual({ tier_core: 8 });
  });

  test('recordTier refuses a ruleset id that is not a shipped tier', async () => {
    installChrome();
    const stats = new RuleHitStats();
    stats.recordTier('tier_nope' as never, 4);
    stats.recordTier('tier_ads', Number.NaN);
    stats.recordTier('tier_ads', 0);

    expect(stats.snapshot().tiers).toEqual({});
  });

  test('clearTier forgets one tier, so a re-enabled tier is judged on its own window', async () => {
    const stub = installChrome();
    const stats = new RuleHitStats();
    stats.recordTier('tier_core', 3);
    stats.recordTier('tier_ads', 90);

    stats.clearTier('tier_core');
    // A tier that was never tracked is not a change, so nothing is scheduled for writing.
    stats.clearTier('tier_privacy');

    expect(stats.snapshot().tiers).toEqual({ tier_ads: 90 });

    await stats.flush();
    expect(stub.storageSet).toHaveBeenCalledWith({
      [STORAGE_KEY_RULE_HITS]: [],
      [STORAGE_KEY_TIER_HITS]: [{ tier: 'tier_ads', count: 90 }],
    });
  });
});
