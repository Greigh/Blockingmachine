import { describe, expect, test } from '@jest/globals';
import { parseFilterRule, mergeScopedVariants, dropSubsumedBlocks } from '../background/dnrManager';
import { readFileSync } from 'node:fs';

const feed = readFileSync('/tmp/browser-feed.txt', 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('!') && !l.startsWith('['));

describe('priority histogram', () => {
  test('what the sort produces', () => {
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
