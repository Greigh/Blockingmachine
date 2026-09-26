import { describe, expect, it } from '@jest/globals';
import { Readable } from 'node:stream';
import { RuleProcessor, parseFilterList, parseFilterListStream } from '../RuleProcessor.js';
import { RuleStore } from '../RuleStore.js';
import { RuleDeduplicator } from '../RuleDeduplicator.js';
import { cleanDomainPattern, createRuleMetadata } from '../createMetadata.js';

describe('Rule identity and metadata', () => {
  it.each(['www.example.com', '||www.example.com^', ':: www.example.com'])('preserves www and IPv6 hosts in %s', (raw) => {
    expect(cleanDomainPattern(raw)).toBe('www.example.com');
  });

  it('keeps source metadata independent between parsed rules', () => {
    const source = 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt';
    const first = createRuleMetadata(source, 'blocking', '||a.example.com^');
    first.sourceInfo.category = 'poison';
    expect(createRuleMetadata(source, 'blocking', '||b.example.com^').sourceInfo.category).not.toBe('poison');
  });

  it('rejects invalid domain labels rather than exporting them as hostnames', () => {
    for (const input of ['||-bad.example^', '||bad-.example^', '||a..example^', `||${'a'.repeat(64)}.example^`]) {
      expect(cleanDomainPattern(input)).toBeNull();
    }
  });
});

describe('Equivalent buffered, streamed and stored rules', () => {
  const input = ':: first.example.com second.example.com # hosts\r\nexample.com#@%#//scriptlet("prevent-fetch")\nexample.com#$?#div:has(.ad)';

  it('keeps the same rule meanings through all three entry points', async () => {
    const store = new RuleStore(new RuleProcessor());
    input.split(/\r?\n/).forEach((line) => store.addRule(line));
    const buffered = parseFilterList(input);
    const streamed = [];
    for await (const rule of parseFilterListStream(Readable.from([input]))) streamed.push(rule);
    const summary = (rules: typeof buffered) => rules.map(({ raw, domain, isException }) => ({ raw, domain, isException })).sort((a, b) => a.raw.localeCompare(b.raw));
    expect(summary(store.getUniqueRules())).toEqual(summary(buffered));
    expect(summary(streamed)).toEqual(summary(buffered));
    expect(buffered.find((rule) => rule.raw.includes('#@%#'))?.isException).toBe(true);
    expect(buffered.find((rule) => rule.raw.includes('#$?#'))?.isException).toBe(false);
  });

  it('rejects control characters and multiline rules at the single-rule boundary', () => {
    const processor = new RuleProcessor();
    const store = new RuleStore(processor);
    expect(processor.classifyRule('||ads.example^\n@@||ads.example^')).toBeNull();
    expect(() => store.addRule(null as unknown as string)).not.toThrow();
    store.addRule('||ads.example^\u0000');
    expect(store.getUniqueRules()).toEqual([]);
  });

  it('handles CR-only line separators consistently', async () => {
    const content = '||one.example^\r||two.example^';
    const rules = parseFilterList(content);
    expect(rules.map((rule) => rule.raw)).toEqual(['||one.example^', '||two.example^']);
  });
});

describe('Conservative deduplication', () => {
  it.each([
    ['*$removeparam=fbclid', '*$removeparam=gclid'],
    ['||example.com^$script,domain=a.example', '||example.com^$script,domain=b.example'],
    ['||example.com^$redirect=noopjs', '||example.com^$redirect=noopframe'],
    ['example.com##.Ad', 'example.com##.ad'],
    ['example.com##+js(set, token, "AbC")', 'example.com##+js(set, token, "abc")'],
    ['||example.com/file?campaign=one', '||example.com/file?campaign=two'],
    ['/example$/', '/example/'],
    ['www.example.com', 'example.com'],
    ['https://example.com/file', 'http://example.com/file'],
  ])('preserves distinct semantics for %s and %s', async (first, second) => {
    const result = await new RuleDeduplicator().processRules(parseFilterList(`${first}\n${second}`));
    expect(result).toHaveLength(2);
  });

  it('keeps a suffix rule when equivalent exact-host entries also exist', async () => {
    const rules = parseFilterList('0.0.0.0 example.com\n||example.com^');
    rules[0].metadata.sources = ['a', 'b', 'c', 'd'];
    const result = await new RuleDeduplicator().processRules(rules);
    expect(result.map((rule) => rule.raw)).toContain('||example.com^');
  });

  it('does not prune children of a disabled or badfiltered parent', async () => {
    const rules = parseFilterList('||example.com^\n||ads.example.com^');
    rules[0].metadata.enabled = false;
    const deduplicator = new RuleDeduplicator();
    expect((await deduplicator.processRules(rules)).map((rule) => rule.raw)).toContain('||ads.example.com^');
    expect((await deduplicator.processRules(parseFilterList('||example.com^\n||ads.example.com^\n||example.com^$badfilter'))).map((rule) => rule.raw)).toContain('||ads.example.com^');
  });

  it('does not mutate input metadata and resets statistics for each batch', async () => {
    const rules = [...parseFilterList('||example.com^', 'first'), ...parseFilterList('||example.com^', 'second')];
    const deduplicator = new RuleDeduplicator();
    await deduplicator.processRules(rules);
    expect(rules[0].metadata.sources).toEqual(['first']);
    expect(deduplicator.getStats().duplicateGroups).toBe(1);
    await deduplicator.processRules(parseFilterList('||different.example^'));
    expect(deduplicator.getStats().duplicates).toBe(0);
    await deduplicator.processRules([]);
    expect(deduplicator.getStats().total).toBe(0);
  });
});
