import { describe, expect, test } from '@jest/globals';
import { parseFilterRule, mergeScopedVariants, dropSubsumedBlocks } from '../background/dnrManager';
import { existsSync, readFileSync } from 'node:fs';

// A manual diagnostic, not an assertion suite: dump a compiled browser feed to
// /tmp/browser-feed.txt to inspect the priority histogram and the 28,500-rule cut boundary.
// It skips in CI, where no such fixture exists — asserting on nothing would be noise.
const FEED_PATH = '/tmp/browser-feed.txt';
const hasFeed = existsSync(FEED_PATH);

(hasFeed ? describe : describe.skip)('priority histogram', () => {
  test('what the sort produces', () => {
    const feed = readFileSync(FEED_PATH, 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('!') && !l.startsWith('['));
    const seen = new Set<string>();
    const candidates: ReturnType<typeof parseFilterRule>[] = [];
    for (const line of feed) {
      const p = parseFilterRule(line);
      if (!p) continue;
      const id = `${p.isException ? 'EX' : 'BL'}:${p.pattern}`;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(p);
    }
    const merged = dropSubsumedBlocks(mergeScopedVariants(candidates as any));
    const hist = new Map<string, number>();
    for (const c of merged) {
      const k = `pri=${c.priority} ${c.isException ? 'EX' : 'BL'}${c.initiatorDomains ? ' scoped' : ''}${c.excludedInitiatorDomains ? ' excl' : ''}`;
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
    [...hist.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}: ${n}`));
    console.log('total candidates:', merged.length);
    const sorted = [...merged].sort((a, b) => b.priority - a.priority);
    console.log('cumsum to 28500 cut — the last installed candidate:', JSON.stringify(sorted[28499]?.rawRule ?? sorted[sorted.length - 1]?.rawRule));
    const idx = sorted.findIndex((c) => !c.isException && !c.initiatorDomains && !c.excludedInitiatorDomains && c.pattern === 'google-analytics.com');
    console.log('google-analytics.com zone position in sort:', idx, idx >= 28500 ? '→ CUT' : '→ installed');
    expect(true).toBe(true);
  });
});
