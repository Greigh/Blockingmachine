import {
  evaluateDomainRules,
  isDomainBlocked,
  findWinningRule,
  CompiledDomainRuleSet,
  compileRuleSet,
} from '../index.js';

describe('AI Domain Rule Evaluator Engine', () => {
  describe('Adblock Plus Wildcard & Precedence Evaluation', () => {
    const rules = [
      '||tracker.com^',
      '0.0.0.0 exact-host.io',
      '@@||safe.tracker.com^',
      '||malware.org^$important',
      '@@||malware.org^',
      '||overridden-by-important-ex.com^$important',
      '@@||overridden-by-important-ex.com^$important',
      '||company.com^$denyallow=portal.company.com|docs.company.com',
    ];

    it('matches root domain and all subdomains for ||domain^ rules', () => {
      const rootRes = evaluateDomainRules('tracker.com', rules);
      expect(rootRes.verdict).toBe('blocked');
      expect(rootRes.matchingRule).toBe('||tracker.com^');

      const subRes = evaluateDomainRules('sub.api.tracker.com', rules);
      expect(subRes.verdict).toBe('blocked');
      expect(subRes.matchingRule).toBe('||tracker.com^');

      // Does not match prefix-extended domain (e.g. nottracker.com)
      const notRes = evaluateDomainRules('nottracker.com', rules);
      expect(notRes.verdict).toBe('not_blocked');
    });

    it('unblocks subdomains when matching an exception rule', () => {
      const res = evaluateDomainRules('safe.tracker.com', rules);
      expect(res.verdict).toBe('exception');
      expect(res.exceptionRule).toBe('@@||safe.tracker.com^');
      expect(res.overriddenRules).toContain('||tracker.com^');
    });

    it('enforces $important block rule over regular exception rule', () => {
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

    it('honors $denyallow modifier to exonerate specific subdomains from block rules', () => {
      // Normal subdomain of company.com is blocked
      const adRes = evaluateDomainRules('ad.company.com', rules);
      expect(adRes.verdict).toBe('blocked');

      // Subdomains listed in $denyallow are NOT blocked
      const portalRes = evaluateDomainRules('portal.company.com', rules);
      expect(portalRes.verdict).toBe('not_blocked');

      const docsRes = evaluateDomainRules('docs.company.com', rules);
      expect(docsRes.verdict).toBe('not_blocked');

      // Sub-subdomains of an allowed denyallow domain are also protected
      const subPortalRes = evaluateDomainRules('sub.portal.company.com', rules);
      expect(subPortalRes.verdict).toBe('not_blocked');
    });
  });

  describe('Multi-Format Rule Syntax Support', () => {
    it('supports multiple hosts entries on a single line', () => {
      const multiHostRules = ['0.0.0.0 ad1.network.org ad2.network.org ad3.network.org # telemetry'];
      expect(isDomainBlocked('ad1.network.org', multiHostRules)).toBe(true);
      expect(isDomainBlocked('ad2.network.org', multiHostRules)).toBe(true);
      expect(isDomainBlocked('ad3.network.org', multiHostRules)).toBe(true);
      expect(isDomainBlocked('clean.network.org', multiHostRules)).toBe(false);
    });

    it('evaluates slashed regular expressions (/regex/) correctly', () => {
      const regexRules = ['/^ad[0-9]+\\.tracking\\.com$/'];
      expect(isDomainBlocked('ad1.tracking.com', regexRules)).toBe(true);
      expect(isDomainBlocked('ad99.tracking.com', regexRules)).toBe(true);
      expect(isDomainBlocked('nonad.tracking.com', regexRules)).toBe(false);
    });

    it('evaluates DNSMasq server=/domain/# rules correctly', () => {
      const dnsmasqRules = ['server=/telemetry-sink.net/#'];
      expect(isDomainBlocked('api.telemetry-sink.net', dnsmasqRules)).toBe(true);
      expect(isDomainBlocked('telemetry-sink.net', dnsmasqRules)).toBe(true);
    });

    it('evaluates Unbound local-zone rules with trailing dots', () => {
      const unboundRules = ['local-zone: "unbound-sinkhole.org." always_nxdomain'];
      expect(isDomainBlocked('sub.unbound-sinkhole.org', unboundRules)).toBe(true);
    });

    it('evaluates RPZ response policy zone syntax rules', () => {
      const rpzRules = ['bad-rpz.com CNAME .', '*.wildcard-rpz.org A 0.0.0.0'];
      expect(isDomainBlocked('bad-rpz.com', rpzRules)).toBe(true);
      expect(isDomainBlocked('sub.wildcard-rpz.org', rpzRules)).toBe(true);
    });
  });

  describe('False Positive Collateral Damage Protections', () => {
    it('protects against rogue rules attempting to block entire public suffixes / ccTLDs', () => {
      const rogueRules = [
        '||com^',
        '||net^',
        '||co.uk^',
        '0.0.0.0 org',
        'address=/vic.gov.au/0.0.0.0',
      ];

      // Standard domains under these TLDs/ccTLDs must NOT be blocked
      expect(isDomainBlocked('google.com', rogueRules)).toBe(false);
      expect(isDomainBlocked('wikipedia.org', rogueRules)).toBe(false);
      expect(isDomainBlocked('bbc.co.uk', rogueRules)).toBe(false);
      expect(isDomainBlocked('health.vic.gov.au', rogueRules)).toBe(false);
    });

    it('rejects overbroad asterisk wildcards that would match all domains', () => {
      const dangerousWildcards = ['*', '*.*', '*.com'];
      expect(isDomainBlocked('google.com', dangerousWildcards)).toBe(false);
      expect(isDomainBlocked('apple.com', dangerousWildcards)).toBe(false);
    });
  });

  describe('CompiledDomainRuleSet Indexing & Performance', () => {
    it('compiles rules into an index and evaluates queries with identical accuracy', () => {
      const rules = [
        '||adnetwork.com^',
        '0.0.0.0 badhost.org',
        '@@||safe.adnetwork.com^',
        '||malware.io^$important',
      ];

      const compiled = compileRuleSet(rules);
      expect(compiled.getRuleCount()).toBe(4);

      expect(compiled.isBlocked('sub.adnetwork.com')).toBe(true);
      expect(compiled.isBlocked('safe.adnetwork.com')).toBe(false);
      expect(compiled.findWinningRule('badhost.org')).toBe('0.0.0.0 badhost.org');
      expect(compiled.findWinningRule('malware.io')).toBe('||malware.io^$important');
    });

    it('handles large rule sets efficiently', () => {
      const largeRules: string[] = [];
      for (let i = 0; i < 1000; i++) {
        largeRules.push(`0.0.0.0 host-${i}.adserver.com`);
      }
      largeRules.push('||global-tracker.com^');

      const compiled = new CompiledDomainRuleSet(largeRules);
      const start = Date.now();
      const res = compiled.evaluate('api.global-tracker.com');
      const elapsed = Date.now() - start;

      expect(res.verdict).toBe('blocked');
      expect(res.matchingRule).toBe('||global-tracker.com^');
      expect(elapsed).toBeLessThan(50); // Sub-millisecond lookup
    });
  });

  describe('Edge Cases and Input Robustness', () => {
    it('returns not_blocked for empty or invalid inputs', () => {
      expect(evaluateDomainRules('', ['||test.com^'])).toEqual({
        domain: '',
        verdict: 'not_blocked',
        matchingRules: [],
        overriddenRules: [],
        details: 'Invalid domain format.',
      });

      expect(evaluateDomainRules('   ', ['||test.com^'])).toEqual({
        domain: '   ',
        verdict: 'not_blocked',
        matchingRules: [],
        overriddenRules: [],
        details: 'Invalid domain format.',
      });
    });

    it('handles null and undefined rules arrays gracefully', () => {
      expect(isDomainBlocked('google.com', null as unknown as string[])).toBe(false);
      expect(isDomainBlocked('google.com', undefined as unknown as string[])).toBe(false);
    });

    it('ignores comment lines and empty lines in rules lists', () => {
      const commentRules = [
        '! Title: EasyList',
        '# This is a hosts comment',
        '[Adblock Plus 2.0]',
        '   ',
        '||actual-ad.com^',
      ];
      expect(isDomainBlocked('actual-ad.com', commentRules)).toBe(true);
      expect(findWinningRule('actual-ad.com', commentRules)).toBe('||actual-ad.com^');
    });
  });
});
