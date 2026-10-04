import { describe, it, expect } from '@jest/globals';
import {
  clearHeatForDomain,
  emptyRadarHeatMap,
  ignoreHeatDomain,
  unignoreHeatDomain,
  getHeatForDomain,
  recordFlagsInHeatMap,
  suggestWatchdogCadence,
  summarizeHeatMap,
} from '../radarHeatMap';

describe('Radar heat map', () => {
  const now = Date.now();

  it('starts empty and ignores clean verdicts', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [{ domain: 'clean.example', verdict: 'clean' }], now);
    expect(heat.entries).toEqual([]);

    heat = recordFlagsInHeatMap(heat, [{ domain: 'bad.example', verdict: 'ad_server' }], now);
    expect(heat.entries).toHaveLength(1);
    expect(heat.entries[0].flags).toBe(1);
  });

  it('accumulates heat across repeated flags', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [{ domain: 'bad.example', verdict: 'ad_server' }], now);
    heat = recordFlagsInHeatMap(heat, [{ domain: 'bad.example', verdict: 'ad_server' }], now + 60_000);
    expect(heat.entries[0].flags).toBe(2);
    expect(heat.entries[0].lastSeen).toBe(now + 60_000);
  });

  it('tracks distinct clients and dedupes repeats', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [{ domain: 'bad.example', verdict: 'ad_server', client: '10.0.0.2' }], now);
    heat = recordFlagsInHeatMap(heat, [{ domain: 'bad.example', verdict: 'ad_server', client: '10.0.0.2' }], now + 1);
    heat = recordFlagsInHeatMap(heat, [{ domain: 'bad.example', verdict: 'ad_server', client: '10.0.0.3' }], now + 2);
    expect(heat.entries[0].clients).toEqual(['10.0.0.2', '10.0.0.3']);
  });

  it('resolves sibling zone heat for subdomains', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [{ domain: 'ads.evil.example', verdict: 'ad_server' }], now);
    const sibling = getHeatForDomain(heat, 'cdn.evil.example');
    expect(sibling).not.toBeNull();
    expect(sibling!.domain).toBe('cdn.evil.example');
    expect(sibling!.flags).toBe(1);
  });

  it('decays stale heat', () => {
    let heat = emptyRadarHeatMap();
    const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;
    heat = recordFlagsInHeatMap(heat, [
      { domain: 'old.example', verdict: 'ad_server' },
      { domain: 'old.example', verdict: 'ad_server' },
    ], twoWeeksAgo);
    // Re-record with an empty list at `now` to trigger decay of the old entries
    heat = recordFlagsInHeatMap(heat, [], now);
    // Two half-lives elapsed: 2 flags decay to 1
    expect(heat.entries[0].flags).toBe(1);
  });

  it('clears heat for a domain, its subdomains, and its zone siblings', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [
      { domain: 'ads.evil.example', verdict: 'ad_server' },
      { domain: 'cdn.evil.example', verdict: 'ad_server' },
      { domain: 'tracker.ads.evil.example', verdict: 'ad_server' },
      { domain: 'unrelated.example', verdict: 'tracker' },
    ], now);
    heat = clearHeatForDomain(heat, 'ads.evil.example');
    const domains = heat.entries.map((e) => e.domain);
    expect(domains).toEqual(['unrelated.example']);
  });

  it('clearHeatForDomain is safe on empty input and unknown domains', () => {
    expect(clearHeatForDomain(null, 'x.example').entries).toEqual([]);
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [{ domain: 'other.example', verdict: 'tracker' }], now);
    const cleared = clearHeatForDomain(heat, 'not-present.example');
    expect(cleared.entries).toHaveLength(1);
  });

  it('ignoring hides a domain from the active summary but keeps it listed as ignored', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [
      { domain: 'a.example', verdict: 'ad_server' },
      { domain: 'b.example', verdict: 'tracker' },
    ], now);
    heat = ignoreHeatDomain(heat, 'a.example', now);

    const summary = summarizeHeatMap(heat, now);
    expect(summary.totalDomains).toBe(1);
    expect(summary.topOffenders.map((e) => e.domain)).toEqual(['b.example']);
    expect(summary.ignoredCount).toBe(1);
    expect(summary.ignoredEntries.map((e) => e.domain)).toEqual(['a.example']);
  });

  it('ignoring generalizes across the registrable zone', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [
      { domain: 'ads.evil.example', verdict: 'ad_server' },
      { domain: 'cdn.evil.example', verdict: 'ad_server' },
      { domain: 'unrelated.example', verdict: 'tracker' },
    ], now);
    heat = ignoreHeatDomain(heat, 'ads.evil.example', now);

    const domains = heat.entries.map((e) => ({ domain: e.domain, ignored: Boolean(e.ignored) }));
    expect(domains).toContainEqual({ domain: 'ads.evil.example', ignored: true });
    expect(domains).toContainEqual({ domain: 'cdn.evil.example', ignored: true });
    expect(domains).toContainEqual({ domain: 'unrelated.example', ignored: false });
  });

  it('new flags on an ignored domain do not resurrect it or grow its heat', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [{ domain: 'bad.example', verdict: 'ad_server' }], now);
    heat = ignoreHeatDomain(heat, 'bad.example', now);
    heat = recordFlagsInHeatMap(heat, [
      { domain: 'bad.example', verdict: 'ad_server' },
      { domain: 'bad.example', verdict: 'ad_server' },
    ], now + 60_000);

    const entry = heat.entries.find((e) => e.domain === 'bad.example');
    expect(entry?.ignored).toBe(true);
    expect(entry?.flags).toBe(1);
    const summary = summarizeHeatMap(heat, now + 60_000);
    expect(summary.topOffenders).toEqual([]);
    expect(summary.totalDomains).toBe(0);
  });

  it('a brand-new sibling of an ignored zone entry starts ignored', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [{ domain: 'ads.evil.example', verdict: 'ad_server' }], now);
    heat = ignoreHeatDomain(heat, 'ads.evil.example', now);
    heat = recordFlagsInHeatMap(heat, [{ domain: 'fresh.evil.example', verdict: 'tracker' }], now + 1);

    const fresh = heat.entries.find((e) => e.domain === 'fresh.evil.example');
    expect(fresh?.ignored).toBe(true);
    expect(fresh?.ignoredAt).toBe(now + 1);
  });

  it('ignored entries are frozen from heat decay', () => {
    let heat = emptyRadarHeatMap();
    const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;
    heat = recordFlagsInHeatMap(heat, [
      { domain: 'frozen.example', verdict: 'ad_server' },
      { domain: 'frozen.example', verdict: 'ad_server' },
    ], twoWeeksAgo);
    heat = ignoreHeatDomain(heat, 'frozen.example', twoWeeksAgo);
    heat = recordFlagsInHeatMap(heat, [], now);

    const entry = heat.entries.find((e) => e.domain === 'frozen.example');
    expect(entry?.ignored).toBe(true);
    expect(entry?.flags).toBe(2); // would have decayed to 1 if not ignored
  });

  it('unignoring restores the domain to the active summary with fresh recency', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [
      { domain: 'a.example', verdict: 'ad_server' },
      { domain: 'a.example', verdict: 'ad_server' },
    ], now - 30 * 60 * 1000);
    heat = ignoreHeatDomain(heat, 'a.example', now - 10 * 60 * 1000);
    heat = unignoreHeatDomain(heat, 'a.example', now);

    const entry = heat.entries.find((e) => e.domain === 'a.example');
    expect(entry?.ignored).toBe(false);
    expect(entry?.lastSeen).toBe(now);
    const summary = summarizeHeatMap(heat, now);
    expect(summary.topOffenders.map((e) => e.domain)).toEqual(['a.example']);
    expect(summary.ignoredCount).toBe(0);
  });

  it('unignoring generalizes across the zone too', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [
      { domain: 'ads.evil.example', verdict: 'ad_server' },
      { domain: 'cdn.evil.example', verdict: 'ad_server' },
    ], now);
    heat = ignoreHeatDomain(heat, 'ads.evil.example', now);
    heat = unignoreHeatDomain(heat, 'cdn.evil.example', now + 1);

    expect(heat.entries.every((e) => !e.ignored)).toBe(true);
  });

  it('ignored domains do not inflate the recent flag pressure', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [{ domain: `noisy${Math.random()}.example`, verdict: 'ad_server' }], now);
    heat = ignoreHeatDomain(heat, heat.entries[0].domain, now);
    heat = recordFlagsInHeatMap(heat, Array.from({ length: 30 }, () => ({
      domain: `storm${Math.random()}.example`,
      verdict: 'ad_server',
    })), now);
    const summary = summarizeHeatMap(heat, now);
    // Only the 30 active storm flags count toward pressure; ignored contributes 0
    expect(summary.recentFlags).toBe(30);
  });

  it('caps the ledger at 500 entries', () => {
    let heat = emptyRadarHeatMap();
    const many = Array.from({ length: 600 }, (_, i) => ({ domain: `d${i}.example`, verdict: 'ad_server' }));
    heat = recordFlagsInHeatMap(heat, many, now);
    expect(heat.entries.length).toBeLessThanOrEqual(500);
  });

  it('summarizes hot domains and top offenders', () => {
    let heat = emptyRadarHeatMap();
    heat = recordFlagsInHeatMap(heat, [
      { domain: 'a.example', verdict: 'ad_server' },
      { domain: 'a.example', verdict: 'ad_server' },
      { domain: 'a.example', verdict: 'ad_server' },
      { domain: 'b.example', verdict: 'tracker' },
    ], now);
    const summary = summarizeHeatMap(heat, now);
    expect(summary.totalDomains).toBe(2);
    expect(summary.hotDomains).toBe(1);
    expect(summary.recentFlags).toBe(4);
    expect(summary.topOffenders[0].domain).toBe('a.example');
  });
});

describe('Adaptive watchdog cadence', () => {
  const now = Date.now();

  function heatWithFlags(count: number) {
    let heat = emptyRadarHeatMap();
    // Distinct by construction rather than by luck. These names were `d${Math.random()}.example`,
    // which made every flag a *candidate* for collision and every run of this block a different
    // input — a suite that cannot be shown to be deterministic is a suite whose failures cannot be
    // triaged, and this block's output decides an interval the watchdog actually runs on.
    const flagged = Array.from({ length: count }, (_, i) => ({ domain: `d${i}.example`, verdict: 'ad_server' as const }));
    heat = recordFlagsInHeatMap(heat, flagged, now);
    return heat;
  }

  it('tightens the interval under high threat pressure', () => {
    const suggestion = suggestWatchdogCadence(heatWithFlags(30), 60, now);
    expect(suggestion.intervalMinutes).toBe(30);
    expect(suggestion.reason).toMatch(/doubling/i);
  });

  it('moderately tightens under moderate pressure', () => {
    const suggestion = suggestWatchdogCadence(heatWithFlags(10), 60, now);
    expect(suggestion.intervalMinutes).toBe(45);
    expect(suggestion.reason).toMatch(/25%/i);
  });

  it('stretches the interval when quiet', () => {
    const suggestion = suggestWatchdogCadence(emptyRadarHeatMap(), 60, now);
    expect(suggestion.intervalMinutes).toBe(120);
    expect(suggestion.reason).toMatch(/stretch/i);
  });

  it('keeps the configured interval at baseline pressure', () => {
    const suggestion = suggestWatchdogCadence(heatWithFlags(3), 60, now);
    expect(suggestion.intervalMinutes).toBe(60);
  });

  it('never goes below the 5 minute floor', () => {
    const suggestion = suggestWatchdogCadence(heatWithFlags(40), 6, now);
    expect(suggestion.intervalMinutes).toBeGreaterThanOrEqual(5);
  });
});
