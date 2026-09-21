import {
  calculateShannonEntropy,
  detectDgaPatterns,
  decomposeDomain,
  resolveCnameChain,
  synthesizeRules,
  synthesizeAllowlistRule,
  sanitizeDomain,
  isDomainCoveredByRules,
  isSafePublicWebUrl,
  AiDetectorService,
  KNOWN_CLOAKED_TARGETS,
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
});

