import {
  calculateShannonEntropy,
  detectDgaPatterns,
  decomposeDomain,
  resolveCnameChain,
  synthesizeRules,
  synthesizeAllowlistRule,
  sanitizeDomain,
  isDomainCoveredByRules,
  RuleCoverageTrie,
  compactSubdomainRules,
  checkRuleConflict,
  isSafePublicWebUrl,
  AiDetectorService,
  KNOWN_CLOAKED_TARGETS,
  isDomainBlocked,
  findWinningRule,
  isActiveDirectoryOrLocalDomain,
  detectAntiAdblock,
  isSameBrandEcosystem,
  UNTRUSTED_HOSTING_PLATFORMS,
  compileRuleSet,
} from '../index.js';

describe('AI Ad & Tracker Discovery Engine', () => {
  describe('Shannon Entropy Calculation', () => {
    it('returns 0 for empty string', () => {
      expect(calculateShannonEntropy('')).toBe(0);
    });

    it('calculates expected lower entropy for repetitive natural words', () => {
      const normalEntropy = calculateShannonEntropy('google');
      expect(normalEntropy).toBeLessThan(2.5);
    });

    it('calculates significantly higher entropy for randomized pseudo-DGA strings', () => {
      const randomEntropy = calculateShannonEntropy('xq97kz24bwa');
      expect(randomEntropy).toBeGreaterThan(3.3);
    });
  });

  describe('DGA & Ephemeral Pattern Detection', () => {
    it('identifies standard recognizable domain names as non-DGA', () => {
      const result = detectDgaPatterns('news.bbc.co.uk');
      expect(result.isLikelyDga).toBe(false);
      expect(result.score).toBeLessThan(50);
    });

    it('flags high-entropy randomized bidding subdomains', () => {
      const result = detectDgaPatterns('x9a7b2-rtb-trk-49102.bidder.net');
      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('flags hex hash subdomains commonly used for ephemeral tracking beacons', () => {
      const result = detectDgaPatterns('a1b2c3d4e5f60718293a4b5c6d7e8f90.tracking.com');
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.isLikelyDga).toBe(true);
    });

    it('flags DGA domains even when prefixed with www and on compound ccTLD', () => {
      const result = detectDgaPatterns('www.qxzjkwtrmpfd.co.uk');
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.isLikelyDga).toBe(true);
      expect(result.reasons.some((r) => r.includes('consonant') || r.includes('entropy') || r.includes('vowel'))).toBe(true);
    });

    it('flags UUID-formatted hex botnet C2 domains', () => {
      const result = detectDgaPatterns('4f9b2a7e-1c8d-0e5f-b2a7-4f9b2a7e1c8d.com');
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.isLikelyDga).toBe(true);
      expect(result.reasons.some((r) => r.includes('hex hash signature'))).toBe(true);
    });

    it('flags tracking beacon subdomains with prefixes', () => {
      const result = detectDgaPatterns('trk-a1b2c3d4e5f60718293a4b5c6d7e8f90.tracking.com');
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.isLikelyDga).toBe(true);
    });

    it('flags Markov alternating letter-digit generator patterns', () => {
      const result = detectDgaPatterns('x1y2z3a4b5c6.info');
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.isLikelyDga).toBe(true);
      expect(result.reasons.some((r) => r.includes('Alternating letter-digit'))).toBe(true);
    });

    it('flags cyclic character repetition low-entropy botnet domains', () => {
      const result = detectDgaPatterns('ababababab.xyz');
      expect(result.score).toBeGreaterThanOrEqual(35);
      expect(result.reasons.some((r) => r.includes('Cyclic character repetition'))).toBe(true);
    });

    it('correctly decomposes dynamic DNS and serverless tenant hostnames', () => {
      const duck = decomposeDomain('botnet123.duckdns.org');
      expect(duck.tld).toBe('duckdns.org');
      expect(duck.sld).toBe('botnet123');

      const noip = decomposeDomain('www.tracker.no-ip.biz');
      expect(noip.tld).toBe('no-ip.biz');
      expect(noip.sld).toBe('tracker');
      expect(noip.subdomains).toEqual(['www']);
    });
  });

  describe('CNAME Cloaking Resolution Dictionary', () => {
    it('contains major known cloaking providers (Criteo, Branch, Eulerian, etc.)', () => {
      expect(KNOWN_CLOAKED_TARGETS['criteo.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['branch.io']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['sc-cdn.net']).toBeDefined();
    });

    it('handles domains without CNAME records gracefully without crashing', async () => {
      const res = await resolveCnameChain('localhost', 500);
      expect(res.domain).toBe('localhost');
      expect(Array.isArray(res.cnames)).toBe(true);
    });
  });

  describe('Rule Synthesizer', () => {
    it('synthesizes ABP and Hosts rules for ad servers', () => {
      const rules = synthesizeRules({
        domain: 'ad-delivery-network.com',
        verdict: 'ad_server',
        category: 'Advertising',
      });
      expect(rules).toContain('||ad-delivery-network.com^');
      expect(rules).toContain('0.0.0.0 ad-delivery-network.com');
    });

    it('synthesizes third-party rules for trackers', () => {
      const rules = synthesizeRules({
        domain: 'analytics-beacon.io',
        verdict: 'tracker',
        category: 'Telemetry/Analytics',
      });
      expect(rules).toContain('||analytics-beacon.io^');
      expect(rules).toContain('||analytics-beacon.io^$third-party');
    });

    it('returns empty array for clean verified domains', () => {
      const rules = synthesizeRules({
        domain: 'wikipedia.org',
        verdict: 'clean',
        category: 'Clean',
      });
      expect(rules).toEqual([]);
    });
  });

  describe('AiDetectorService (Local Heuristics Mode)', () => {
    const service = new AiDetectorService({ provider: 'local-heuristics' });

    it('classifies ad network keywords as ad servers with high confidence', async () => {
      const result = await service.scanDomain('bidder.adserver-tech.com');
      expect(['ad_server', 'suspicious']).toContain(result.verdict);
      expect(result.confidence).toBeGreaterThanOrEqual(40);
      expect(result.generatedRules.length).toBeGreaterThan(0);
      expect(result.generatedRules[0]).toContain('bidder.adserver-tech.com');
    });

    it('classifies telemetry and analytics beacons as trackers', async () => {
      const result = await service.scanDomain('telemetry.analytics-pixel.org');
      expect(['tracker', 'ad_server', 'suspicious']).toContain(result.verdict);
      expect(result.category).toMatch(/Telemetry|Advertising/);
    });

    it('classifies clean mainstream domains as clean', async () => {
      const result = await service.scanDomain('github.com');
      expect(result.verdict).toBe('clean');
      expect(result.riskLevel).toBe('none');
      expect(result.generatedRules).toEqual([]);
    });

    it('processes batch query logs and calculates correct aggregate stats', async () => {
      const queries = [
        { domain: 'ads.doubleclick.net' },
        { domain: 'wikipedia.org' },
        { domain: 'github.com' },
        { domain: 'telemetry.tracker.io' },
        { domain: 'github.com' }, // duplicate to test deduplication
      ];

      const res = await service.scanQueryLog(queries);
      expect(res.totalQueriesAnalyzed).toBe(4);
      expect(res.flaggedCount).toBeGreaterThanOrEqual(2);
      expect(res.cleanCount).toBeGreaterThanOrEqual(1);
    });

    it('protects known safe infrastructure via false positive guard', async () => {
      const res = await service.scanDomain('cdnjs.cloudflare.com');
      expect(res.verdict).toBe('clean');
      expect(res.confidence).toBe(99);
      expect(res.reasons[0]).toContain('False Positive Guard');
    });

    it('honors user custom allowlist', async () => {
      const customAllow = ['custom-internal-portal.local'];
      const res = await service.scanDomain('ad.custom-internal-portal.local', { allowlist: customAllow });
      expect(res.verdict).toBe('clean');
      expect(res.confidence).toBe(99);
    });

    it('returns label decomposition and individual entropies', async () => {
      const res = await service.scanDomain('bidder-eu.rtb-ad-network.bid');
      expect(res.decomposition).toBeDefined();
      expect(res.decomposition?.sld).toBe('rtb-ad-network');
      expect(res.decomposition?.tld).toBe('bid');
      expect(res.decomposition?.subdomains).toContain('bidder-eu');
      expect(res.decomposition?.labelEntropies.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Allowlist Rule Synthesizer', () => {
    it('synthesizes standard ABP exception rule for false positive whitelisting', () => {
      const rule = synthesizeAllowlistRule('essential-service.com');
      expect(rule).toBe('@@||essential-service.com^');
    });

    it('returns empty string for invalid or malformed domain', () => {
      const rule = synthesizeAllowlistRule('bad\ndomain.com');
      expect(rule).toBe('');
    });
  });

  describe('Domain Sanitization & Rule Injection Hardening', () => {
    it('normalizes valid domains with schemes, paths, and ports', () => {
      expect(sanitizeDomain('https://Sub.AdServer.com:8443/pixel?id=123')).toBe('sub.adserver.com');
      expect(sanitizeDomain('  TRACKER.IO.  ')).toBe('tracker.io');
      expect(sanitizeDomain('192.168.1.1')).toBe('192.168.1.1');
    });

    it('rejects rule injection payloads with newlines, carriage returns, or tabs', () => {
      expect(sanitizeDomain('evil.com\n0.0.0.0 bypass.com')).toBeNull();
      expect(sanitizeDomain('evil.com\r\n@@||whitelist.com^')).toBeNull();
      expect(sanitizeDomain('evil.com\tsub.com')).toBeNull();
    });

    it('rejects filter list modifier syntax and illegal characters', () => {
      expect(sanitizeDomain('bad.com^$script')).toBeNull();
      expect(sanitizeDomain('||malicious.com')).toBeNull();
      expect(sanitizeDomain('bad.com#anchor')).toBeNull();
      expect(sanitizeDomain('bad.com@user')).toBeNull();
      expect(sanitizeDomain('bad domain.com')).toBeNull();
      expect(sanitizeDomain('')).toBeNull();
    });

    it('rejects malformed RFC 1123 domain labels', () => {
      expect(sanitizeDomain('-invalid.com')).toBeNull();
      expect(sanitizeDomain('invalid-.com')).toBeNull();
      expect(sanitizeDomain('invalid..com')).toBeNull();
      expect(sanitizeDomain('a'.repeat(64) + '.com')).toBeNull();
    });

    it('sanitizes and validates IPv6 addresses', () => {
      expect(sanitizeDomain('::1')).toBe('::1');
      expect(sanitizeDomain('[::1]')).toBe('::1');
      expect(sanitizeDomain('[::1]:8080')).toBe('::1');
      expect(sanitizeDomain('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
      expect(sanitizeDomain('[2001:db8::1]:443')).toBe('2001:db8::1');
    });

    it('rejects prototype pollution attempts', () => {
      expect(sanitizeDomain('__proto__')).toBeNull();
      expect(sanitizeDomain('constructor')).toBeNull();
      expect(sanitizeDomain('prototype')).toBeNull();
    });

    it('rejects zero-width and bidirectional control characters', () => {
      expect(sanitizeDomain('evil\u200Bdomain.com')).toBeNull();
      expect(sanitizeDomain('evil\u202Ereversed.com')).toBeNull();
      expect(sanitizeDomain('evil\uFEFFbom.com')).toBeNull();
    });

    it('rejects purely numeric domains and numeric TLDs', () => {
      expect(sanitizeDomain('123.456.789')).toBeNull();
      expect(sanitizeDomain('1.2.3.4.5')).toBeNull();
      expect(sanitizeDomain('malware.123')).toBeNull();
    });

    it('prevents rule synthesizer from creating rules for poisoned inputs', () => {
      const poisonedRules = synthesizeRules({
        domain: 'evil.com\n0.0.0.0 bypass.com',
        verdict: 'ad_server',
        category: 'Advertising',
      });
      expect(poisonedRules).toEqual([]);
    });
  });

  describe('Redundant Rule Coverage Detection (isDomainCoveredByRules)', () => {
    const existingRules = [
      '! AdGuard Filter List Rules',
      '# Host rules',
      '||doubleclick.net^',
      '||telemetry.tracker.io^$third-party',
      '0.0.0.0 adservice.google.com',
      '@@||allowed.com^',
    ];

    it('detects exact rule matches', () => {
      const res = isDomainCoveredByRules('doubleclick.net', existingRules);
      expect(res.isCovered).toBe(true);
      expect(res.coveringRule).toBe('||doubleclick.net^');
    });

    it('detects parent wildcard domain coverage for subdomains', () => {
      const res1 = isDomainCoveredByRules('ad.doubleclick.net', existingRules);
      expect(res1.isCovered).toBe(true);
      expect(res1.coveringRule).toBe('||doubleclick.net^');

      const res2 = isDomainCoveredByRules('deep.sub.ad.doubleclick.net', existingRules);
      expect(res2.isCovered).toBe(true);
    });

    it('detects hosts-format rule matches', () => {
      const res = isDomainCoveredByRules('adservice.google.com', existingRules);
      expect(res.isCovered).toBe(true);
      expect(res.coveringRule).toContain('0.0.0.0 adservice.google.com');
    });

    it('correctly reports non-covered domains', () => {
      const res = isDomainCoveredByRules('mydoubleclick.net', existingRules);
      expect(res.isCovered).toBe(false);
    });

    it('ignores allowlist exception rules', () => {
      const res = isDomainCoveredByRules('allowed.com', existingRules);
      expect(res.isCovered).toBe(false);
    });
  });

  describe('RuleCoverageTrie Data Structure', () => {
    it('accurately indexes and queries wildcard and exact rules', () => {
      const trie = new RuleCoverageTrie();
      trie.insertRules([
        '||doubleclick.net^',
        '||telemetry.app.io^',
        '0.0.0.0 adservice.google.com',
        'exact-block.org',
      ]);

      expect(trie.size).toBe(4);

      // Wildcard parent covers apex and all deeper subdomains
      expect(trie.isCovered('doubleclick.net').isCovered).toBe(true);
      expect(trie.isCovered('ad.doubleclick.net').isCovered).toBe(true);
      expect(trie.isCovered('deep.sub.ad.doubleclick.net').isCovered).toBe(true);
      expect(trie.isCovered('otherdoubleclick.net').isCovered).toBe(false);

      // Exact host rule only covers exact match
      expect(trie.isCovered('adservice.google.com').isCovered).toBe(true);
      expect(trie.isCovered('sub.adservice.google.com').isCovered).toBe(false);
      expect(trie.isCovered('google.com').isCovered).toBe(false);

      // Clears cleanly
      trie.clear();
      expect(trie.size).toBe(0);
      expect(trie.isCovered('doubleclick.net').isCovered).toBe(false);
    });

    it('benchmarks sub-millisecond throughput over 2,000 synthetic rules', () => {
      const trie = new RuleCoverageTrie();
      const syntheticRules: string[] = [];
      for (let i = 0; i < 2000; i++) {
        syntheticRules.push(`||tracker-${i}.telemetry-network.net^`);
      }
      trie.insertRules(syntheticRules);

      const start = performance.now();
      for (let i = 0; i < 500; i++) {
        trie.isCovered(`sub.tracker-${i % 2000}.telemetry-network.net`);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50); // Under 50ms for 500 queries
    });
  });

  describe('Target-Specific Rule Synthesis', () => {
    it('generates AdGuard Home specific rules with $dnsrewrite and $important', () => {
      const adRules = synthesizeRules({
        domain: 'adservice.google.com',
        verdict: 'ad_server',
        category: 'Advertising',
        target: 'adguard',
      });
      expect(adRules).toContain('||adservice.google.com^');
      expect(adRules).toContain('||adservice.google.com^$dnsrewrite=NOERROR;NODATA');

      const malRules = synthesizeRules({
        domain: 'phishing-site.xyz',
        verdict: 'malicious',
        category: 'Malware/Phishing',
        target: 'adguard',
      });
      expect(malRules).toContain('||phishing-site.xyz^$important');
    });

    it('generates Pi-hole v5/v6 regex rules', () => {
      const piRules = synthesizeRules({
        domain: 'tracking.beacon.io',
        verdict: 'tracker',
        category: 'Telemetry/Analytics',
        target: 'pihole',
      });
      expect(piRules).toContain('(^|\\.)tracking\\.beacon\\.io$');
      expect(piRules).toContain('0.0.0.0 tracking.beacon.io');
    });

    it('generates uBlock Origin scriptlet defusers and third-party modifiers', () => {
      const ublockRules = synthesizeRules({
        domain: 'adserver.com',
        verdict: 'ad_server',
        category: 'Advertising',
        target: 'ublock',
      });
      expect(ublockRules).toContain('||adserver.com^');
      expect(ublockRules).toContain('adserver.com##+js(set, adsBlocked, true)');
    });

    it('generates Unbound, dnsmasq, and hosts formats', () => {
      const unboundRules = synthesizeRules({
        domain: 'bad.net',
        verdict: 'malicious',
        category: 'Malware/Phishing',
        target: 'unbound',
      });
      expect(unboundRules).toContain('local-zone: "bad.net" always_nxdomain');

      const dnsmasqRules = synthesizeRules({
        domain: 'bad.net',
        verdict: 'malicious',
        category: 'Malware/Phishing',
        target: 'dnsmasq',
      });
      expect(dnsmasqRules).toContain('address=/bad.net/0.0.0.0');

      const hostRules = synthesizeRules({
        domain: 'bad.net',
        verdict: 'malicious',
        category: 'Malware/Phishing',
        target: 'hosts',
      });
      expect(hostRules).toEqual(['0.0.0.0 bad.net']);
    });

    it('includes reproducible metadata comments when requested', () => {
      const rules = synthesizeRules({
        domain: 'ad.doubleclick.net',
        verdict: 'ad_server',
        category: 'Advertising',
        confidence: 95,
        includeComments: true,
      });
      expect(rules.some((r) => r.startsWith('! [Blockingmachine AI]'))).toBe(true);
      expect(rules.some((r) => r.includes('95% confidence'))).toBe(true);
    });
  });

  describe('Subdomain Clustering & Wildcard Compaction', () => {
    it('collapses >= 3 subdomains under a common parent zone', () => {
      const rawDomains = [
        's1.metrics.tracker.io',
        's2.metrics.tracker.io',
        's3.metrics.tracker.io',
        'api.metrics.tracker.io',
        'standalone-ad.com',
      ];

      const res = compactSubdomainRules(rawDomains, 3);
      expect(res.originalCount).toBe(5);
      expect(res.compactedRules).toContain('||metrics.tracker.io^');
      expect(res.compactedRules).toContain('||standalone-ad.com^');
      expect(res.compactedRules.length).toBeLessThan(res.originalCount);
      expect(res.savingsPercent).toBeGreaterThan(0);
      expect(res.collapsedGroups.length).toBe(1);
      expect(res.collapsedGroups[0].parentDomain).toBe('metrics.tracker.io');
    });

    it('returns original set if no cluster meets threshold', () => {
      const rawDomains = ['a.foo.com', 'b.bar.com'];
      const res = compactSubdomainRules(rawDomains, 3);
      expect(res.compactedRules).toHaveLength(2);
      expect(res.savingsPercent).toBe(0);
    });

    it('prevents over-compaction onto compound ccTLDs (.co.uk, .com.au)', () => {
      const ukDomains = [
        'sub1.bbc.co.uk',
        'sub2.telegraph.co.uk',
        'sub3.guardian.co.uk',
        'sub4.independent.co.uk',
      ];
      const res = compactSubdomainRules(ukDomains, 3);
      // Must NOT compact to ||co.uk^ !
      expect(res.compactedRules).not.toContain('||co.uk^');
      expect(res.collapsedGroups.some((g) => g.parentDomain === 'co.uk')).toBe(false);
      expect(res.compactedRules).toHaveLength(4);
    });

    it('correctly compacts subdomains under a valid domain with a compound ccTLD', () => {
      const bbcDomains = [
        'news.bbc.co.uk',
        'weather.bbc.co.uk',
        'sport.bbc.co.uk',
      ];
      const res = compactSubdomainRules(bbcDomains, 3);
      expect(res.compactedRules).toContain('||bbc.co.uk^');
      expect(res.collapsedGroups[0].parentDomain).toBe('bbc.co.uk');
    });

    it('prevents over-compaction onto multi-tenant and serverless platforms (supabase.co, github.io, vercel.app)', () => {
      const multiTenantSubdomains = [
        'proj1.supabase.co',
        'proj2.supabase.co',
        'proj3.supabase.co',
        'user1.github.io',
        'user2.github.io',
        'user3.github.io',
      ];
      const res = compactSubdomainRules(multiTenantSubdomains, 3);
      // Must NOT compact to ||supabase.co^ or ||github.io^ !
      expect(res.compactedRules).not.toContain('||supabase.co^');
      expect(res.compactedRules).not.toContain('||github.io^');
      expect(res.collapsedGroups.some((g) => g.parentDomain === 'supabase.co')).toBe(false);
      expect(res.collapsedGroups.some((g) => g.parentDomain === 'github.io')).toBe(false);
      expect(res.compactedRules).toHaveLength(6);
    });
  });

  describe('Allowlist Conflict & Shadow Resolution', () => {
    it('detects when a proposed block rule is shadowed by an allowlist rule', () => {
      const existingAllowRules = [
        '! Whitelist filters',
        '@@||tracker.com^',
        '@@||partner.cdn.com^$document',
      ];

      const conflict = checkRuleConflict('||tracker.com^', existingAllowRules);
      expect(conflict.hasConflict).toBe(true);
      expect(conflict.conflictingAllowRule).toBe('@@||tracker.com^');
      expect(conflict.suggestedOverrideRule).toBe('||tracker.com^$important');
    });

    it('preserves existing rule options when adding $important modifier to ABP rules', () => {
      const existingAllowRules = ['@@||tracker.com^'];
      const conflict = checkRuleConflict('||tracker.com^$third-party', existingAllowRules);
      expect(conflict.hasConflict).toBe(true);
      expect(conflict.suggestedOverrideRule).toBe('||tracker.com^$third-party,important');
    });

    it('detects shadow conflict for Pi-hole regex and converts to ABP $important rule', () => {
      const existingAllowRules = ['@@||badsite.com^'];
      const conflict = checkRuleConflict('(^|\\.)badsite\\.com$', existingAllowRules);
      expect(conflict.hasConflict).toBe(true);
      expect(conflict.suggestedOverrideRule).toBe('||badsite.com^$important');
    });

    it('detects subdomain shadow conflicts against apex allowlists', () => {
      const existingAllowRules = ['@@||cdn.com^'];
      const conflict = checkRuleConflict('||sub.cdn.com^', existingAllowRules);
      expect(conflict.hasConflict).toBe(true);
      expect(conflict.suggestedOverrideRule).toBe('||sub.cdn.com^$important');
    });

    it('reports no conflict when no allowlist shadows the rule', () => {
      const existingAllowRules = ['@@||allowed.org^'];
      const conflict = checkRuleConflict('||blocked.org^', existingAllowRules);
      expect(conflict.hasConflict).toBe(false);
    });
  });

  describe('SSRF Protection (isSafePublicWebUrl)', () => {
    it('blocks cloud metadata endpoints (169.254.169.254)', () => {
      const res = isSafePublicWebUrl('http://169.254.169.254/latest/meta-data');
      expect(res.isSafe).toBe(false);
      expect(res.reason).toContain('link-local or cloud metadata');
    });

    it('blocks loopback and localhost addresses', () => {
      expect(isSafePublicWebUrl('http://127.0.0.1:8080').isSafe).toBe(false);
      expect(isSafePublicWebUrl('http://localhost:3000').isSafe).toBe(false);
      expect(isSafePublicWebUrl('http://service.local').isSafe).toBe(false);
      expect(isSafePublicWebUrl('http://[::1]:8080').isSafe).toBe(false);
    });

    it('blocks private RFC 1918 subnets', () => {
      expect(isSafePublicWebUrl('http://10.0.0.1/admin').isSafe).toBe(false);
      expect(isSafePublicWebUrl('http://192.168.1.1').isSafe).toBe(false);
      expect(isSafePublicWebUrl('http://172.16.5.10').isSafe).toBe(false);
    });

    it('blocks dangerous non-HTTP schemes', () => {
      expect(isSafePublicWebUrl('file:///etc/passwd').isSafe).toBe(false);
      expect(isSafePublicWebUrl('ftp://ftp.example.com').isSafe).toBe(false);
    });

    it('permits safe public websites', () => {
      expect(isSafePublicWebUrl('https://example.com/test').isSafe).toBe(true);
      expect(isSafePublicWebUrl('http://bbc.co.uk').isSafe).toBe(true);
    });

    it('rejects crawl requests to SSRF targets in AiDetectorService', async () => {
      const service = new AiDetectorService({ provider: 'local-heuristics' });
      await expect(service.crawlAndScanUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
        /SSRF Guard blocked crawl request/,
      );
    });
  });

  describe('In-Memory LRU/TTL Scan Cache', () => {
    it('caches scan results and avoids redundant computations on repeat queries', async () => {
      const service = new AiDetectorService({ provider: 'local-heuristics' });
      service.clearCache();

      const domain = 'telemetry.cached-beacon.org';
      const scan1 = await service.scanDomain(domain);
      expect(service.getCacheStats().hits).toBe(0);
      expect(service.getCacheStats().misses).toBe(1);

      const scan2 = await service.scanDomain(domain);
      expect(service.getCacheStats().hits).toBe(1);
      expect(scan2.domain).toBe(scan1.domain);
      expect(scan2.verdict).toBe(scan1.verdict);

      // bypassCache forces new computation
      await service.scanDomain(domain, { bypassCache: true });
      expect(service.getCacheStats().hits).toBe(1);
      expect(service.getCacheStats().misses).toBe(2);

      service.clearCache();
      expect(service.getCacheStats().size).toBe(0);
    });
  });

  describe('Domain Decomposition', () => {
    it('correctly separates subdomains, SLD, and TLD with entropy measurements', () => {
      const decomp = decomposeDomain('eu-west-1.telemetry.example.co.uk');
      expect(decomp.tld).toBe('co.uk');
      expect(decomp.sld).toBe('example');
      expect(decomp.subdomains).toEqual(['eu-west-1', 'telemetry']);
      expect(decomp.labelEntropies.length).toBe(5);

      const standardDecomp = decomposeDomain('adserver.doubleclick.net');
      expect(standardDecomp.tld).toBe('net');
      expect(standardDecomp.sld).toBe('doubleclick');
      expect(standardDecomp.subdomains).toEqual(['adserver']);
    });
  });

  describe('Enterprise Multi-Tenant SaaS False Positive Defense', () => {
    it('correctly classifies enterprise multi-tenant domains and brand ecosystems as clean', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const enterpriseDomains = [
        'apple.statuspage.io',
        'apple.zendesk.com',
        'microsoft.sharepoint.com',
        'google.okta.com',
        'apple.github.io',
        'apple.slack.com',
        'netflix.statuspage.io',
        'amazon.custhelp.com',
      ];

      for (const d of enterpriseDomains) {
        const res = await service.scanDomain(d);
        expect(res.verdict).toBe('clean');
        expect(res.category).toBe('Clean');
        expect(res.riskLevel).toBe('none');
      }
    });

    it('flags brand spoofing with phishing keywords or on untrusted domains', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const threatDomains = [
        'apple-login.xyz',
        'apple.evil-domain.com',
        'apple-login.statuspage.io',
        'xn--pple-43d.com',
        'paypa1.com',
      ];

      for (const d of threatDomains) {
        const res = await service.scanDomain(d);
        expect(res.verdict).toBe('malicious');
        expect(res.category).toBe('Malware/Phishing');
        expect(res.riskLevel).toBe('critical');
      }
    });

    it('corroborates DGA malware on generic TLDs with extreme consonant runs or hex signatures', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const dgaDomains = [
        'qxzjkwtrmpfd.com',
        '4f9b2a7e1c8d0e5f.com',
        'xkqwzrtpmjvl.xyz',
      ];

      for (const d of dgaDomains) {
        const res = await service.scanDomain(d);
        expect(res.verdict).toBe('malicious');
        expect(res.category).toBe('Malware/Phishing');
        expect(res.riskLevel).toBe('critical');
      }
    });

    it('detects short brand combosquatting and delivery/package lures', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const deliveryThreats = [
        'uspsdelivery.com',
        'dhltracking.com',
        'upsparcel.com',
        'usps-redelivery.com',
        'pncalert.com',
      ];

      for (const d of deliveryThreats) {
        const res = await service.scanDomain(d);
        expect(res.verdict).toBe('malicious');
        expect(res.category).toBe('Malware/Phishing');
      }
    });

    it('detects pseudo-TLD lures and Web3/2FA phishing lures', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const modernThreats = [
        'paypal-com.net',
        'apple-com.xyz',
        'paypalcom.org',
        'netflix-app.net',
        'metamask-airdrop.xyz',
        'coinbase-kyc.com',
        'binance-2fa.com',
      ];

      for (const d of modernThreats) {
        const res = await service.scanDomain(d);
        expect(res.verdict).toBe('malicious');
        expect(res.category).toBe('Malware/Phishing');
      }
    });

    it('accurately identifies brand typosquats while protecting genuine dictionary words', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      // Genuine dictionary words that differ by 1 letter from brand names must remain clean
      const benignWords = ['apply.com', 'steak.com', 'phase.com', 'stream.com'];
      for (const d of benignWords) {
        const res = await service.scanDomain(d);
        expect(res.verdict).toBe('clean');
        expect(res.category).toBe('Clean');
      }

      // Typosquats with leetspeak or repeated characters must be flagged
      const typosquats = ['gooogle.com', 'appple.com', 'paypa1.com', 'g00gle.com', 'app1e.com'];
      for (const d of typosquats) {
        const res = await service.scanDomain(d);
        expect(res.verdict).toBe('malicious');
        expect(res.category).toBe('Malware/Phishing');
      }
    });
  });

  describe('Domain Evaluator Helpers (isDomainBlocked & findWinningRule)', () => {
    const rules = [
      '||ads.doubleclick.net^',
      '0.0.0.0 tracking.evil.com',
      '@@||allowed.doubleclick.net^',
    ];

    it('correctly determines whether a domain is blocked', () => {
      expect(isDomainBlocked('ads.doubleclick.net', rules)).toBe(true);
      expect(isDomainBlocked('sub.ads.doubleclick.net', rules)).toBe(true);
      expect(isDomainBlocked('tracking.evil.com', rules)).toBe(true);
      expect(isDomainBlocked('allowed.doubleclick.net', rules)).toBe(false);
      expect(isDomainBlocked('clean-portal.org', rules)).toBe(false);
    });

    it('correctly returns winning rule string or undefined', () => {
      expect(findWinningRule('ads.doubleclick.net', rules)).toBe('||ads.doubleclick.net^');
      expect(findWinningRule('tracking.evil.com', rules)).toBe('0.0.0.0 tracking.evil.com');
      expect(findWinningRule('allowed.doubleclick.net', rules)).toBe('@@||allowed.doubleclick.net^');
      expect(findWinningRule('clean-portal.org', rules)).toBeUndefined();
    });
  });

  describe('Hardened AiDetectorService Guardrails & Resilience', () => {
    const service = new AiDetectorService({ provider: 'mini-ai' });

    it('normalizes URLs with HTTP credentials, port, path, and query params', async () => {
      const res = await service.scanDomain('https://admin:secret@ads.doubleclick.net:8080/ad.js?tag=123');
      expect(res.domain).toBe('ads.doubleclick.net');
      expect(res.verdict).not.toBe('clean');
    });

    it('populates coveredByRule when domain matches existing compiled rules', async () => {
      const res = await service.scanDomain('ad.doubleclick.net', {
        existingRules: ['||doubleclick.net^'],
      });
      expect(res.coveredByRule).toBe('||doubleclick.net^');
      expect(res.reasons.some((r) => r.includes('Already covered by existing rule'))).toBe(true);
    });

    it('protects institutional government and educational domains from false alarms', async () => {
      const resGov = await service.scanDomain('weather.noaa.gov');
      expect(resGov.verdict).toBe('clean');
      expect(resGov.confidence).toBe(99);
      expect(resGov.reasons[0]).toContain('False Positive Guard');

      const resEdu = await service.scanDomain('cs.mit.edu');
      expect(resEdu.verdict).toBe('clean');
      expect(resEdu.confidence).toBe(99);
      expect(resEdu.reasons[0]).toContain('False Positive Guard');
    });

    it('ensures brand spoofing with login labels is never falsely exonerated', async () => {
      const resSpoof = await service.scanDomain('login.paypal-verification.com');
      expect(resSpoof.verdict).not.toBe('clean');
      expect(resSpoof.reasons[0]).not.toContain('False Positive Guard');
    });

    it('detects anti-adblock evasion providers in local-heuristics mode', async () => {
      const heuristicService = new AiDetectorService({ provider: 'local-heuristics' });
      const res = await heuristicService.scanDomain('carter-carrier.com');
      expect(['ad_server', 'suspicious']).toContain(res.verdict);
      expect(res.reasons.some((r) => r.toLowerCase().includes('anti-adblock'))).toBe(true);
    });

    it('identifies brand phishing lures on untrusted serverless hosting platforms while keeping legitimate SaaS clean', async () => {
      const serverlessPhish = [
        'paypal.workers.dev',
        'chase.firebaseapp.com',
        'apple.pages.dev',
        'metamask.glitch.me',
      ];
      for (const d of serverlessPhish) {
        const res = await service.scanDomain(d);
        expect(res.verdict).toBe('malicious');
        expect(res.category).toBe('Malware/Phishing');
      }

      expect(UNTRUSTED_HOSTING_PLATFORMS.has('workers.dev')).toBe(true);

      // Authentic brand platforms owned by the brand itself remain clean
      const platformOwners = ['vercel.app', 'workers.dev', 'fly.io'];
      for (const d of platformOwners) {
        const res = await service.scanDomain(d);
        expect(res.verdict).toBe('clean');
      }
    });

    it('distinguishes Active Directory controllers from public ad subdomains with high precision', () => {
      // Standalone "ad." on public TLDs must NOT be classified as Active Directory
      expect(isActiveDirectoryOrLocalDomain('ad.example.com')).toBe(false);
      expect(isActiveDirectoryOrLocalDomain('ad.newspaper.org')).toBe(false);

      // Genuine Active Directory infrastructure
      expect(isActiveDirectoryOrLocalDomain('dc01.ad.company.com')).toBe(true);
      expect(isActiveDirectoryOrLocalDomain('ad.corp.local')).toBe(true);
      expect(isActiveDirectoryOrLocalDomain('ldap.company.com')).toBe(true);
      expect(isActiveDirectoryOrLocalDomain('kdc.corp.internal')).toBe(true);
      expect(isActiveDirectoryOrLocalDomain('adfs.school.edu')).toBe(true);
    });

    it('detects newly added anti-adblock and ad-recovery networks', () => {
      expect(detectAntiAdblock('uponit.com').detected).toBe(true);
      expect(detectAntiAdblock('instartlogic.com').detected).toBe(true);
      expect(detectAntiAdblock('sp-prod.net').detected).toBe(true);
      expect(detectAntiAdblock('poisedpancake.com').detected).toBe(true);
      expect(detectAntiAdblock('superficialsubstance.com').detected).toBe(true);
    });

    it('verifies expanded brand ecosystems', () => {
      expect(isSameBrandEcosystem('instagram.com', 'facebook.com')).toBe(true);
      expect(isSameBrandEcosystem('threads.net', 'meta.com')).toBe(true);
      expect(isSameBrandEcosystem('oktacdn.com', 'okta.com')).toBe(true);
      expect(isSameBrandEcosystem('wf.com', 'wellsfargo.com')).toBe(true);
      expect(isSameBrandEcosystem('informeddelivery.com', 'usps.com')).toBe(true);
      expect(isSameBrandEcosystem('redditstatic.com', 'reddit.com')).toBe(true);
    });

    it('handles full URLs, ports, and modern IPv6 :: entries in Domain Evaluator', () => {
      const rules = [
        '||ads.doubleclick.net^',
        ':: tracker.telemetry.io',
      ];
      expect(isDomainBlocked('https://ads.doubleclick.net:8080/ad.js?v=1', rules)).toBe(true);
      expect(findWinningRule('http://ads.doubleclick.net/banner', rules)).toBe('||ads.doubleclick.net^');
      expect(isDomainBlocked('tracker.telemetry.io', rules)).toBe(true);
      expect(isDomainBlocked('https://clean-site.org/page', rules)).toBe(false);

      const compiled = compileRuleSet(rules);
      expect(compiled.isBlocked('tracker.telemetry.io')).toBe(true);
    });
  });
});




