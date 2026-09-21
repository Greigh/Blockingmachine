import {
  calculateShannonEntropy,
  detectDgaPatterns,
  decomposeDomain,
  resolveCnameChain,
  synthesizeRules,
  synthesizeAllowlistRule,
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
  });

  describe('Domain Decomposition', () => {
    it('correctly separates subdomains, SLD, and TLD with entropy measurements', () => {
      const decomp = decomposeDomain('eu-west-1.telemetry.example.co.uk');
      expect(decomp.subdomains.length).toBeGreaterThan(0);
      expect(decomp.labelEntropies.length).toBe(5);
    });
  });
});

