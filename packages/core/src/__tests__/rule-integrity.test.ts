import {
  RuleProcessor,
  RuleDeduplicator,
  generateFilterList,
  resolveDnsPrecedence,
  evaluateDomainRules,
  parseFilterList,
  type FilterMetadata,
} from '../index.js';

describe('Rule Engine Integrity & Ordering Suite', () => {
  const meta: FilterMetadata = {
    title: 'Integrity Test List',
    description: 'Verifying rule order, precedence, and exception suppression',
    homepage: 'https://blockingmachine.com',
    version: '1.0.0',
    lastUpdated: '2026-09-23T00:00:00.000Z',
  };

  describe('Scriptlet Classification in RuleProcessor', () => {
    const processor = new RuleProcessor();

    it('classifies uBlock Origin procedural scriptlet injection as scriptlet', () => {
      expect(
        processor.classifyRule('example.com##+js(set, admiral, noopfn)'),
      ).toBe('scriptlet');
    });

    it('classifies uBlock Origin procedural scriptlet exception as scriptlet', () => {
      expect(
        processor.classifyRule('example.com#@#+js(set, admiral, noopfn)'),
      ).toBe('scriptlet');
    });

    it('classifies AdGuard JS scriptlet injection (#%#) as scriptlet', () => {
      expect(
        processor.classifyRule("example.com#%#//scriptlet('set', 'googlefc')"),
      ).toBe('scriptlet');
    });

    it('classifies AdGuard JS scriptlet exception (#@%#) as scriptlet', () => {
      expect(
        processor.classifyRule("example.com#@%#//scriptlet('set', 'googlefc')"),
      ).toBe('scriptlet');
    });

    it('classifies AdGuard script injection (#$#) as scriptlet', () => {
      expect(
        processor.classifyRule('example.com#$#abort-current-inline-script'),
      ).toBe('scriptlet');
    });

    it('classifies AdGuard script injection exception (#@$#) as scriptlet', () => {
      expect(
        processor.classifyRule('example.com#@$#abort-current-inline-script'),
      ).toBe('scriptlet');
    });

    it('classifies standard cosmetic element hiding as cosmetic', () => {
      expect(processor.classifyRule('example.com##.ad-banner')).toBe('cosmetic');
      expect(processor.classifyRule('##div[class*="sponsored"]')).toBe('cosmetic');
      expect(processor.classifyRule('example.com#@#.ad-banner')).toBe('cosmetic');
    });
  });

  describe('Scriptlet Deduplication in RuleDeduplicator', () => {
    it('preserves distinct uBO scriptlets on the same domain without collision', () => {
      const deduplicator = new RuleDeduplicator();
      const r1 = 'example.com##+js(set, admiral, noopfn)';
      const r2 = 'example.com##+js(abort-current-inline-script, test)';

      const k1 = deduplicator.stripRule(r1);
      const k2 = deduplicator.stripRule(r2);

      expect(k1).toContain('scriptlet=+js(set, admiral, noopfn)');
      expect(k2).toContain('scriptlet=+js(abort-current-inline-script, test)');
      expect(k1).not.toBe(k2);
    });

    it('deduplicates identical scriptlet rules', () => {
      const deduplicator = new RuleDeduplicator();
      const r1 = 'example.com##+js(set, admiral, noopfn)';
      const r2 = 'example.com##+js(set,   admiral,  noopfn)';

      const k1 = deduplicator.stripRule(r1);
      const k2 = deduplicator.stripRule(r2);

      expect(k1).toBe(k2);
    });
  });

  describe('DNS Sinkhole Precedence & Exception Suppression', () => {
    it('actively suppresses blocked domain when covered by exact allowlist rule', () => {
      const rules = parseFilterList(
        `
||analytics.tracking.com^
0.0.0.0 malware.org
@@||analytics.tracking.com^
        `.trim(),
        'test-source',
      );

      const precedence = resolveDnsPrecedence(rules);
      expect(precedence.activeBlocks.map((r) => r.domain || r.raw)).toContain(
        'malware.org',
      );
      // analytics.tracking.com MUST be pruned from active blocks
      expect(precedence.allowlistedDomains.has('analytics.tracking.com')).toBe(
        true,
      );
      expect(
        precedence.activeBlocks.some(
          (r) =>
            r.raw.includes('analytics.tracking.com') ||
            r.domain === 'analytics.tracking.com',
        ),
      ).toBe(false);

      const hostsOutput = generateFilterList(rules, meta, 'hosts');
      expect(hostsOutput).toContain('0.0.0.0 malware.org');
      expect(hostsOutput).toContain(
        '# EXCEPTION: @@||analytics.tracking.com^',
      );
      // Crucial: 0.0.0.0 analytics.tracking.com MUST NOT be present
      expect(hostsOutput).not.toContain('0.0.0.0 analytics.tracking.com');
    });

    it('actively suppresses subdomain blocks when parent domain is allowlisted', () => {
      const rules = parseFilterList(
        `
0.0.0.0 s1.cdn.safe-portal.com
0.0.0.0 s2.cdn.safe-portal.com
@@||safe-portal.com^
        `.trim(),
        'test-source',
      );

      const precedence = resolveDnsPrecedence(rules);
      expect(precedence.activeBlocks).toHaveLength(0);

      const hostsOutput = generateFilterList(rules, meta, 'hosts');
      expect(hostsOutput).not.toContain('0.0.0.0 s1.cdn.safe-portal.com');
      expect(hostsOutput).not.toContain('0.0.0.0 s2.cdn.safe-portal.com');
      expect(hostsOutput).toContain('# EXCEPTION: @@||safe-portal.com^');
    });

    it('enforces $important blocking override over regular exceptions', () => {
      const rules = parseFilterList(
        `
||critical-malware.com^$important
@@||critical-malware.com^
        `.trim(),
        'test-source',
      );

      const precedence = resolveDnsPrecedence(rules);
      // Because block has $important and exception does not, block WINS
      expect(
        precedence.activeBlocks.some((r) =>
          r.raw.includes('critical-malware.com'),
        ),
      ).toBe(true);

      const hostsOutput = generateFilterList(rules, meta, 'hosts');
      expect(hostsOutput).toContain('0.0.0.0 critical-malware.com');
      expect(hostsOutput).toContain(
        '# EXCEPTION OVERRIDDEN BY $important: @@||critical-malware.com^',
      );
    });

    it('enforces $important exception override over $important blocking rules', () => {
      const rules = parseFilterList(
        `
||important-site.com^$important
@@||important-site.com^$important
        `.trim(),
        'test-source',
      );

      const precedence = resolveDnsPrecedence(rules);
      // $important exception overrides $important block
      expect(
        precedence.activeBlocks.some((r) =>
          r.raw.includes('important-site.com'),
        ),
      ).toBe(false);

      const hostsOutput = generateFilterList(rules, meta, 'hosts');
      expect(hostsOutput).not.toContain('0.0.0.0 important-site.com');
      expect(hostsOutput).toContain(
        '# EXCEPTION: @@||important-site.com^$important',
      );
    });

    it('emits dnsmasq and unbound forwarders for child exceptions under blocked parent zones', () => {
      const rules = parseFilterList(
        `
||adnetwork.com^
@@||safe.adnetwork.com^
        `.trim(),
        'test-source',
      );

      const dnsmasqOutput = generateFilterList(rules, meta, 'dnsmasq');
      expect(dnsmasqOutput).toContain('address=/adnetwork.com/0.0.0.0');
      expect(dnsmasqOutput).toContain('server=/safe.adnetwork.com/#');
      expect(dnsmasqOutput).toContain('# EXCEPTION: @@||safe.adnetwork.com^');

      const unboundOutput = generateFilterList(rules, meta, 'unbound');
      expect(unboundOutput).toContain('local-zone: "adnetwork.com" always_nxdomain');
      expect(unboundOutput).toContain('local-zone: "safe.adnetwork.com" transparent');
    });
  });

  describe('Canonical Section Ordering in Compiled Filter Lists', () => {
    it('structures browser filter lists into canonical sections in correct order', () => {
      const mixedRulesText = `
||network-block-b.com^
example.com##+js(set, admiral, noopfn)
@@||allowed-portal.com^
||network-block-a.com^
nytimes.com##.sponsor-ad
@@||another-allowed.com^
      `.trim();

      const rules = parseFilterList(mixedRulesText, 'mixed');
      const adgOutput = generateFilterList(rules, meta, 'adguard');

      // 1. Verify all rules exist
      expect(adgOutput).toContain('@@||allowed-portal.com^');
      expect(adgOutput).toContain('@@||another-allowed.com^');
      expect(adgOutput).toContain('example.com##+js(set, admiral, noopfn)');
      expect(adgOutput).toContain('nytimes.com##.sponsor-ad');
      expect(adgOutput).toContain('||network-block-a.com^');
      expect(adgOutput).toContain('||network-block-b.com^');

      // 2. Verify section ordering: Whitelist -> Scriptlets -> Cosmetic -> Network
      const whitelistIdx = adgOutput.indexOf('Whitelist & Exception Rules');
      const scriptletsIdx = adgOutput.indexOf('Procedural Scriptlet Defusers');
      const cosmeticIdx = adgOutput.indexOf('Cosmetic & Element Hiding Rules');
      const networkIdx = adgOutput.indexOf('Network Blocking Rules');

      expect(whitelistIdx).toBeGreaterThan(0);
      expect(scriptletsIdx).toBeGreaterThan(whitelistIdx);
      expect(cosmeticIdx).toBeGreaterThan(scriptletsIdx);
      expect(networkIdx).toBeGreaterThan(cosmeticIdx);

      // 3. Verify alphabetical sort within sections ('allowed' precedes 'another')
      const allowAnotherIdx = adgOutput.indexOf('@@||another-allowed.com^');
      const allowPortalIdx = adgOutput.indexOf('@@||allowed-portal.com^');
      expect(allowPortalIdx).toBeLessThan(allowAnotherIdx);

      const netAIdx = adgOutput.indexOf('||network-block-a.com^');
      const netBIdx = adgOutput.indexOf('||network-block-b.com^');
      expect(netAIdx).toBeLessThan(netBIdx);
    });
  });

  describe('evaluateDomainRules Engine', () => {
    const rules = [
      '||tracker.com^',
      '0.0.0.0 exact-host.io',
      '@@||safe.tracker.com^',
      '||malware.org^$important',
      '@@||malware.org^',
      '||overridden-by-important-ex.com^$important',
      '@@||overridden-by-important-ex.com^$important',
    ];

    it('detects wildcard blocking rules for subdomains', () => {
      const res = evaluateDomainRules('api.tracker.com', rules);
      expect(res.verdict).toBe('blocked');
      expect(res.matchingRule).toBe('||tracker.com^');
    });

    it('detects exact hosts file rule blocking', () => {
      const res = evaluateDomainRules('exact-host.io', rules);
      expect(res.verdict).toBe('blocked');
      expect(res.matchingRule).toBe('0.0.0.0 exact-host.io');
    });

    it('unblocks subdomains when covered by an exception rule', () => {
      const res = evaluateDomainRules('safe.tracker.com', rules);
      expect(res.verdict).toBe('exception');
      expect(res.exceptionRule).toBe('@@||safe.tracker.com^');
      expect(res.overriddenRules).toContain('||tracker.com^');
    });

    it('enforces $important block rule over normal exception rule', () => {
      const res = evaluateDomainRules('malware.org', rules);
      expect(res.verdict).toBe('blocked');
      expect(res.matchingRule).toBe('||malware.org^$important');
      expect(res.overriddenRules).toContain('@@||malware.org^');
    });

    it('enforces $important exception rule over $important block rule', () => {
      const res = evaluateDomainRules('overridden-by-important-ex.com', rules);
      expect(res.verdict).toBe('exception');
      expect(res.exceptionRule).toBe('@@||overridden-by-important-ex.com^$important');
    });

    it('returns not_blocked for completely benign domains', () => {
      const res = evaluateDomainRules('wikipedia.org', rules);
      expect(res.verdict).toBe('not_blocked');
      expect(res.matchingRules).toHaveLength(0);
    });
  });
});
