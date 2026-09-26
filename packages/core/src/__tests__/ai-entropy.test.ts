import {
  calculateShannonEntropy,
  detectDgaPatterns,
  decomposeDomain,
  clearEntropyCache,
  isValidParentZone,
  FOUR_PART_PUBLIC_SUFFIXES,
  THREE_PART_PUBLIC_SUFFIXES,
  COMPOUND_CCTLDS,
  DYNAMIC_DNS_SUFFIXES,
  BENIGN_STRUCTURAL_PREFIXES,
} from '../index.js';

describe('AI Lexical Entropy & Domain Decomposition Engine', () => {
  beforeEach(() => {
    clearEntropyCache();
  });

  describe('Shannon Entropy Optimization & Accuracy', () => {
    it('returns 0 for empty or invalid inputs', () => {
      expect(calculateShannonEntropy('')).toBe(0);
      expect(calculateShannonEntropy('a')).toBe(0);
      expect(calculateShannonEntropy(null as unknown as string)).toBe(0);
      expect(calculateShannonEntropy(undefined as unknown as string)).toBe(0);
    });

    it('calculates mathematically expected entropy for uniform distributions', () => {
      // 2 distinct symbols with equal probability -> 1.0 bit
      expect(calculateShannonEntropy('ab')).toBe(1.0);
      // 4 distinct symbols with equal probability -> 2.0 bits
      expect(calculateShannonEntropy('abcd')).toBe(2.0);
      // 8 distinct symbols with equal probability -> 3.0 bits
      expect(calculateShannonEntropy('abcdefgh')).toBe(3.0);
    });

    it('computes identical results across repeated lookups using the LRU cache', () => {
      const label = 'cloudflare';
      const first = calculateShannonEntropy(label);
      const second = calculateShannonEntropy(label);
      expect(first).toBe(second);
      expect(first).toBeGreaterThan(2.0);
      expect(first).toBeLessThan(3.5);
    });

    it('handles unicode characters gracefully via the fallback path', () => {
      const unicodeStr = 'münchen';
      const entropy = calculateShannonEntropy(unicodeStr);
      expect(entropy).toBeGreaterThan(0);
      expect(typeof entropy).toBe('number');
    });

    it('handles high volume calls without memory leaks or cache overflow', () => {
      for (let i = 0; i < 5000; i++) {
        calculateShannonEntropy(`sub-${i}-label`);
      }
      // Cache should cap at 4096 without error
      expect(calculateShannonEntropy('test')).toBeGreaterThan(0);
    });
  });

  describe('Domain Decomposition & Public Suffix Detection', () => {
    it('decomposes standard single-part TLD domains', () => {
      const d = decomposeDomain('blog.google.com');
      expect(d.sld).toBe('google');
      expect(d.tld).toBe('com');
      expect(d.subdomains).toEqual(['blog']);
    });

    it('decomposes compound ccTLD domains correctly', () => {
      const d = decomposeDomain('news.bbc.co.uk');
      expect(d.sld).toBe('bbc');
      expect(d.tld).toBe('co.uk');
      expect(d.subdomains).toEqual(['news']);
    });

    it('decomposes Australian state government 3-part public suffixes', () => {
      const d = decomposeDomain('health.vic.gov.au');
      expect(d.sld).toBe('health');
      expect(d.tld).toBe('vic.gov.au');
      expect(d.subdomains).toEqual([]);

      const d2 = decomposeDomain('api.transport.nsw.gov.au');
      expect(d2.sld).toBe('transport');
      expect(d2.tld).toBe('nsw.gov.au');
      expect(d2.subdomains).toEqual(['api']);
    });

    it('handles naked 3-part public suffixes without crashing', () => {
      const d = decomposeDomain('vic.gov.au');
      expect(d.sld).toBe('vic.gov.au');
      expect(d.tld).toBe('vic.gov.au');
      expect(d.subdomains).toEqual([]);
    });

    it('decomposes cloud object storage 3-part suffixes correctly', () => {
      const s3 = decomposeDomain('my-data-bucket.s3.amazonaws.com');
      expect(s3.sld).toBe('my-data-bucket');
      expect(s3.tld).toBe('s3.amazonaws.com');
      expect(s3.subdomains).toEqual([]);

      const blob = decomposeDomain('mediaassets.blob.core.windows.net');
      expect(blob.sld).toBe('mediaassets');
      expect(blob.tld).toBe('blob.core.windows.net');
      expect(blob.subdomains).toEqual([]);
    });

    it('decomposes serverless platforms like up.railway.app and supabase.co', () => {
      const railway = decomposeDomain('my-api.up.railway.app');
      expect(railway.sld).toBe('my-api');
      expect(railway.tld).toBe('up.railway.app');
      expect(railway.subdomains).toEqual([]);

      const supa = decomposeDomain('lqaitnsphcretimgxxdz.supabase.co');
      expect(supa.sld).toBe('lqaitnsphcretimgxxdz');
      expect(supa.tld).toBe('supabase.co');
      expect(supa.subdomains).toEqual([]);

      const neon = decomposeDomain('ep-cool-db-123456.neon.tech');
      expect(neon.sld).toBe('ep-cool-db-123456');
      expect(neon.tld).toBe('neon.tech');
      expect(neon.subdomains).toEqual([]);
    });

    it('handles IPv4 addresses cleanly without treating octets as TLDs', () => {
      const d = decomposeDomain('192.168.1.1');
      expect(d.sld).toBe('192.168.1.1');
      expect(d.tld).toBe('');
      expect(d.subdomains).toEqual([]);
      expect(d.labelEntropies[0].isSuspicious).toBe(false);
    });

    it('sanitizes full URLs with basic auth credentials, ports, and queries', () => {
      const d = decomposeDomain('https://admin:secret123@api.metrics.example.com:8443/v1/metrics?interval=5m#live');
      expect(d.sld).toBe('example');
      expect(d.tld).toBe('com');
      expect(d.subdomains).toEqual(['api', 'metrics']);
    });

    it('strips trailing root FQDN dots', () => {
      const d = decomposeDomain('www.cloudflare.com.');
      expect(d.sld).toBe('cloudflare');
      expect(d.tld).toBe('com');
      expect(d.subdomains).toEqual(['www']);
    });
  });

  describe('DGA & Lexical Anomaly Detection (False Positive Elimination)', () => {
    it('does not penalize legitimate tech words where "y" is a semi-vowel', () => {
      const words = [
        'crypto-exchange.com',
        'sync-service.net',
        'python-docs.org',
        'rhythm-games.com',
        'mysql-cluster.io',
        'dynamic-proxy.net',
        'cyber-security-firm.com',
        'encrypt-data-flow.org',
      ];

      for (const domain of words) {
        const result = detectDgaPatterns(domain);
        expect(result.isLikelyDga).toBe(false);
        expect(result.score).toBeLessThan(50);
        expect(result.reasons.some((r) => r.includes('consonant cluster without vowels'))).toBe(false);
      }
    });

    it('does not penalize standard calendar years (1950 - 2040) in domains', () => {
      const yearDomains = [
        'paris2024.org',
        'agenda2030.int',
        'summer1996.com',
        'tokyo2020.jp',
        'vision2035.net',
      ];

      for (const domain of yearDomains) {
        const result = detectDgaPatterns(domain);
        expect(result.isLikelyDga).toBe(false);
        expect(result.score).toBeLessThan(50);
        expect(result.reasons.some((r) => r.includes('Consecutive numeric sequence'))).toBe(false);
      }
    });

    it('distinguishes content-addressed developer commit SHAs from tracking beacon hashes', () => {
      // Content-addressed commit hash on authorized developer host -> safe
      const devSha = detectDgaPatterns('a1b2c3d4e5f60718293a4b5c6d7e8f90.assets.github.com');
      expect(devSha.isLikelyDga).toBe(false);
      expect(devSha.score).toBeLessThan(50);

      // Same hex hash on an ad tracking host -> flagged
      const trackerHash = detectDgaPatterns('a1b2c3d4e5f60718293a4b5c6d7e8f90.tracking.com');
      expect(trackerHash.isLikelyDga).toBe(true);
      expect(trackerHash.score).toBeGreaterThanOrEqual(50);

      // Root domain itself is a UUID botnet C2 -> flagged
      const c2Uuid = detectDgaPatterns('4f9b2a7e-1c8d-0e5f-b2a7-4f9b2a7e1c8d.com');
      expect(c2Uuid.isLikelyDga).toBe(true);
      expect(c2Uuid.score).toBeGreaterThanOrEqual(50);
    });

    it('does not flag German IDN Punycode domains as high-entropy DGA', () => {
      // bücher.de in Punycode: xn--bcher-kva.de
      const result = detectDgaPatterns('xn--bcher-kva.de');
      expect(result.isLikelyDga).toBe(false);
      expect(result.score).toBeLessThan(50);
      expect(result.reasons.some((r) => r.includes('High Shannon entropy'))).toBe(false);
    });

    it('catches genuine consonant-heavy DGA botnet domains', () => {
      const result = detectDgaPatterns('qxzjkwtrmpfd.info');
      expect(result.isLikelyDga).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.reasons.some((r) => r.includes('consonant') || r.includes('vowel'))).toBe(true);
    });

    it('catches true random hex tracker subdomains with explicit tracking prefixes', () => {
      const result = detectDgaPatterns('trk-a1b2c3d4e5f60718293a4b5c6d7e8f90.bidder.net');
      expect(result.isLikelyDga).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(50);
    });

    it('handles non-string and malformed inputs with zero crash guarantee', () => {
      expect(detectDgaPatterns(null as unknown as string)).toEqual({ isLikelyDga: false, score: 0, reasons: [] });
      expect(detectDgaPatterns(undefined as unknown as string)).toEqual({ isLikelyDga: false, score: 0, reasons: [] });
      expect(detectDgaPatterns(12345 as unknown as string)).toEqual({ isLikelyDga: false, score: 0, reasons: [] });
      expect(detectDgaPatterns('https://')).toEqual({ isLikelyDga: false, score: 0, reasons: [] });
      expect(detectDgaPatterns('192.168.1.1')).toEqual({ isLikelyDga: false, score: 0, reasons: [] });
    });
  });

  describe('Rule Synthesizer Integration with 3-Part Public Suffixes', () => {
    it('prevents collapsing rules directly onto 3-part public suffixes', () => {
      expect(isValidParentZone('vic.gov.au')).toBe(false);
      expect(isValidParentZone('nsw.gov.au')).toBe(false);
      expect(isValidParentZone('s3.amazonaws.com')).toBe(false);
      expect(isValidParentZone('blob.core.windows.net')).toBe(false);
      expect(isValidParentZone('up.railway.app')).toBe(false);
    });

    it('permits parent zone collapse when valid organization SLD is present', () => {
      expect(isValidParentZone('health.vic.gov.au')).toBe(true);
      expect(isValidParentZone('transport.nsw.gov.au')).toBe(true);
      expect(isValidParentZone('mybucket.s3.amazonaws.com')).toBe(true);
      expect(isValidParentZone('myapp.up.railway.app')).toBe(true);
    });

    it('exports public suffix and structural prefix sets with expected members', () => {
      expect(FOUR_PART_PUBLIC_SUFFIXES.has('blob.core.windows.net')).toBe(true);
      expect(THREE_PART_PUBLIC_SUFFIXES.has('vic.gov.au')).toBe(true);
      expect(COMPOUND_CCTLDS.has('co.uk')).toBe(true);
      expect(DYNAMIC_DNS_SUFFIXES.has('supabase.co')).toBe(true);
      expect(DYNAMIC_DNS_SUFFIXES.has('neon.tech')).toBe(true);
      expect(BENIGN_STRUCTURAL_PREFIXES.has('cdn')).toBe(true);
    });
  });
});
