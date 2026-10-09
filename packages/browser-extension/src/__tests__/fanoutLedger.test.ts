/**
 * The fan-out tally — flag 43's embeddability signal. What gets pinned: edge dedup
 * (same host+site twice is not two sites), the caps that keep a long-lived tally
 * bounded, and that stored garbage normalizes instead of corrupting.
 */
import { describe, expect, it } from '@jest/globals';
import {
  MAX_FANOUT_HOSTS,
  MAX_FIRST_PARTIES,
  emptyFanoutTally,
  normalizeStoredFanout,
  recordFanoutEdge,
} from '../shared/fanoutLedger.js';

const T0 = Date.parse('2026-10-08T12:00:00Z');

describe('recordFanoutEdge', () => {
  it('counts distinct sites, not repeat sightings', () => {
    let t = emptyFanoutTally();
    t = recordFanoutEdge(t, 'ads.tracker.com', 'news-site.com', T0).tally;
    t = recordFanoutEdge(t, 'ads.tracker.com', 'news-site.com', T0 + 1000).tally;
    t = recordFanoutEdge(t, 'ads.tracker.com', 'blog-site.org', T0 + 2000).tally;
    const e = t.entries['ads.tracker.com'];
    expect(e.firstParties).toEqual(['blog-site.org', 'news-site.com']);
    expect(e.hits).toBe(3); // hits count every sighting; firstParties counts sites
    expect(e.firstSeen).toBe('2026-10-08');
  });

  it('marks the first-party list as a floor once capped', () => {
    let t = emptyFanoutTally();
    for (let i = 0; i < MAX_FIRST_PARTIES + 5; i++) {
      t = recordFanoutEdge(t, 'beacon.cdn.com', `site${i}.com`, T0).tally;
    }
    const e = t.entries['beacon.cdn.com'];
    expect(e.firstParties).toHaveLength(MAX_FIRST_PARTIES);
    expect(e.firstPartiesCapped).toBe(true);
  });

  it('evicts the least-recently-seen host at the host cap', () => {
    let t = emptyFanoutTally();
    for (let i = 0; i < MAX_FANOUT_HOSTS; i++) {
      t = recordFanoutEdge(t, `tp${i}.net`, 'site.com', T0 + i).tally;
    }
    t = recordFanoutEdge(t, 'tp-new.net', 'site.com', T0 + MAX_FANOUT_HOSTS).tally;
    expect(Object.keys(t.entries)).toHaveLength(MAX_FANOUT_HOSTS);
    expect(t.entries['tp-new.net']).toBeDefined();
    expect(t.entries['tp0.net']).toBeUndefined(); // oldest-seen host is the evictee
  });

  it('refuses empty endpoints rather than minting junk entries', () => {
    let t = emptyFanoutTally();
    const r = recordFanoutEdge(t, '', 'site.com', T0);
    expect(r.newEdge).toBe(false);
    expect(r.tally.entries).toEqual({});
  });
});

describe('normalizeStoredFanout', () => {
  it('drops malformed entries and keeps the good ones', () => {
    const t = normalizeStoredFanout({
      entries: {
        'good.com': { firstParties: ['a.com'], hits: 5, firstSeen: '2026-10-08', lastSeen: '2026-10-08' },
        'bad.com': { firstParties: 'not-an-array' },
        'partial.com': { firstParties: ['x.com', 42, 'y.com'], hits: 'NaN' },
      },
    });
    expect(t.entries['good.com'].hits).toBe(5);
    expect(t.entries['bad.com']).toBeUndefined();
    expect(t.entries['partial.com'].firstParties).toEqual(['x.com', 'y.com']);
    expect(t.entries['partial.com'].hits).toBe(0);
  });

  it('a missing or non-object payload reads as empty, not as corruption', () => {
    expect(normalizeStoredFanout(undefined).entries).toEqual({});
    expect(normalizeStoredFanout('junk').entries).toEqual({});
  });
});
