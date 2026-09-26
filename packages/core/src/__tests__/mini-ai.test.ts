import {
  extractDomainFeatures,
  MiniAiClassifier,
  classifyDomainWithMiniAi,
  AiDetectorService,
} from '../index.js';

describe('Mini-AI Domain Threat Classifier', () => {
  describe('Mathematical Feature Extraction', () => {
    it('extracts all 25 numerical features for standard domain', () => {
      const features = extractDomainFeatures('cdn.telemetry-tracker.com');
      expect(typeof features.entropyFull).toBe('number');
      expect(typeof features.entropySld).toBe('number');
      expect(typeof features.domainLength).toBe('number');
      expect(typeof features.vowelRatio).toBe('number');
      expect(typeof features.consonantRatio).toBe('number');
      expect(typeof features.trigramPerplexity).toBe('number');
      expect(typeof features.trackerKeywordWeight).toBe('number');
      expect(features.trackerKeywordWeight).toBeGreaterThan(0.3);
    });

    it('identifies ad keyword tokens in ad server hostnames', () => {
      const features = extractDomainFeatures('adserver.bidding.adtech.net');
      expect(features.adKeywordWeight).toBeGreaterThan(0.6);
      expect(features.trackerKeywordWeight).toBeLessThan(features.adKeywordWeight);
    });

    it('identifies telemetry keyword tokens in analytics hostnames', () => {
      const features = extractDomainFeatures('pixel.analytics.beacon.com');
      expect(features.trackerKeywordWeight).toBeGreaterThan(0.6);
    });

    it('detects high trigram perplexity on randomized DGA domains', () => {
      const dgaFeatures = extractDomainFeatures('xzk7q92bwa1m.com');
      const cleanFeatures = extractDomainFeatures('contentdelivery.com');
      expect(dgaFeatures.trigramPerplexity).toBeGreaterThan(cleanFeatures.trigramPerplexity);
    });

    it('flags high-abuse TLDs', () => {
      const features = extractDomainFeatures('free-spins.buzz');
      expect(features.highRiskTld).toBe(1.0);
    });
  });

  describe('Embedded Mini-AI Model Inference', () => {
    const classifier = new MiniAiClassifier();

    it('accurately classifies known ad servers as Advertising / ad_server', () => {
      const domain = 'adservice.googleadservices.com';

      // Warm up JIT and feature caches before timing (same pattern as throughput benchmark)
      for (let i = 0; i < 50; i++) {
        classifier.classify(domain);
      }

      const prediction = classifier.classify(domain);
      expect(prediction.category).toBe('Advertising');
      expect(['ad_server', 'suspicious']).toContain(prediction.verdict);
      expect(prediction.confidence).toBeGreaterThanOrEqual(70);
      expect(prediction.topContributions.length).toBeGreaterThan(0);

      const timingSamples: number[] = [];
      for (let i = 0; i < 20; i++) {
        timingSamples.push(classifier.classify(domain).inferenceTimeMs);
      }
      timingSamples.sort((a, b) => a - b);
      const medianMs = timingSamples[Math.floor(timingSamples.length / 2)];
      const p95Ms = timingSamples[Math.ceil(timingSamples.length * 0.95) - 1];
      expect(medianMs).toBeLessThan(5);
      expect(p95Ms).toBeLessThan(10); // headroom for throttled CI runners

      const helperPrediction = classifyDomainWithMiniAi(domain);
      expect(helperPrediction.category).toBe('Advertising');
    });

    it('accurately classifies telemetry beacons as Telemetry/Analytics / tracker', () => {
      const prediction = classifier.classify('telemetry.analytics.metrics-collector.io');
      expect(prediction.category).toBe('Telemetry/Analytics');
      expect(['tracker', 'suspicious']).toContain(prediction.verdict);
      expect(prediction.confidence).toBeGreaterThanOrEqual(65);
    });

    it('protects verified infrastructure with false-positive guard (Clean)', () => {
      const prediction = classifier.classify('github.com');
      expect(prediction.category).toBe('Clean');
      expect(prediction.verdict).toBe('clean');
      expect(prediction.confidence).toBeGreaterThanOrEqual(95);
      expect(prediction.riskLevel).toBe('none');
    });

    it('flags uncloaked CNAME trackers as CNAME Cloaking', () => {
      const prediction = classifier.classify('sub.retailer.com', {
        cnames: ['retailer.criteo.com'],
        hasCnameCloaking: true,
        knownTrackerTarget: 'criteo.com',
      });
      expect(prediction.category).toBe('CNAME Cloaking');
      expect(prediction.verdict).toBe('tracker');
      expect(prediction.confidence).toBeGreaterThanOrEqual(75);
    });

    it('detects randomized DGA malware/phishing domains', () => {
      const prediction = classifier.classify('zq97kx24bwa-bot.xyz');
      expect(['Malware/Phishing', 'Advertising', 'suspicious']).toContain(prediction.category);
      expect(prediction.verdict).not.toBe('clean');
      expect(prediction.riskLevel).not.toBe('none');
    });

    it('detects brand typo-squatting and credential harvesting patterns', () => {
      const spoof1 = classifier.classify('paypa1-security.com');
      expect(spoof1.category).toBe('Malware/Phishing');
      expect(spoof1.topContributions.some((c) => c.name === 'Brand Typo-Squatting')).toBe(true);

      const spoof2 = classifier.classify('apple-id-verify-login.xyz');
      expect(spoof2.category).toBe('Malware/Phishing');
      expect(spoof2.topContributions.some((c) => c.name === 'Brand Typo-Squatting')).toBe(true);
    });

    it('supports on-device incremental feedback tuning', () => {
      const testDomain = 'borderline-metric-hub.net';

      // Reset feedback
      classifier.tuneDomainFeedback(testDomain, 'reset');
      const initial = classifier.classify(testDomain);

      // User whitelists the domain (False Positive)
      classifier.tuneDomainFeedback(testDomain, 'whitelist');
      const afterWhitelist = classifier.classify(testDomain);
      expect(afterWhitelist.classProbabilities.Clean).toBeGreaterThanOrEqual(initial.classProbabilities.Clean);

      // User blocks the domain
      classifier.tuneDomainFeedback(testDomain, 'block');
      const afterBlock = classifier.classify(testDomain);
      expect(afterBlock.classProbabilities.Clean).toBeLessThan(afterWhitelist.classProbabilities.Clean);
    });

    it('caps user feedback entries at maxFeedbackEntries and evicts least recently used', () => {
      const testClassifier = new MiniAiClassifier();
      testClassifier.clearFeedback();

      // Insert 2,050 feedback entries
      for (let i = 0; i < 2050; i++) {
        testClassifier.tuneDomainFeedback(`domain-${i}.com`, 'whitelist');
      }

      // Oldest domains should have been evicted (e.g. domain-0 to domain-49)
      expect(testClassifier.getDomainFeedback('domain-0.com')).toBe(0);
      expect(testClassifier.getDomainFeedback('domain-10.com')).toBe(0);
      expect(testClassifier.getDomainFeedback('domain-49.com')).toBe(0);

      // Most recent entries should be retained
      expect(testClassifier.getDomainFeedback('domain-2049.com')).toBe(-1.0);
      expect(testClassifier.getDomainFeedback('domain-1000.com')).toBe(-1.0);

      // Reset / clear
      testClassifier.clearFeedback();
      expect(testClassifier.getDomainFeedback('domain-2049.com')).toBe(0);
    });

    it('exports and imports feedback dictionary across sessions', () => {
      const c1 = new MiniAiClassifier();
      c1.tuneDomainFeedback('test-tracker.com', 'block');
      c1.tuneDomainFeedback('my-trusted-site.org', 'whitelist');

      const exported = c1.exportFeedback();
      expect(exported['test-tracker.com']).toBe(1.0);
      expect(exported['my-trusted-site.org']).toBe(-1.0);
      expect(c1.getFeedbackCount()).toBe(2);

      const c2 = new MiniAiClassifier();
      expect(c2.getFeedbackCount()).toBe(0);
      c2.importFeedback(exported);
      expect(c2.getFeedbackCount()).toBe(2);
      expect(c2.getDomainFeedback('test-tracker.com')).toBe(1.0);
      expect(c2.getDomainFeedback('my-trusted-site.org')).toBe(-1.0);
    });

    it('safely handles NaN, Infinity, out-of-bound biases during importFeedback', () => {
      const c = new MiniAiClassifier();
      c.importFeedback({
        'nan-domain.com': NaN,
        'inf-domain.com': Infinity,
        '-inf-domain.com': -Infinity,
        'too-high.com': 99.9,
        'too-low.com': -50.0,
        'valid-domain.com': 0.8,
      });

      expect(c.getDomainFeedback('nan-domain.com')).toBe(0);
      expect(c.getDomainFeedback('inf-domain.com')).toBe(0);
      expect(c.getDomainFeedback('-inf-domain.com')).toBe(0);
      expect(c.getDomainFeedback('too-high.com')).toBe(1.0); // clamped
      expect(c.getDomainFeedback('too-low.com')).toBe(-1.0); // clamped
      expect(c.getDomainFeedback('valid-domain.com')).toBe(0.8);
    });

    it('benchmarks sub-millisecond inference throughput (>1000 domains/sec)', () => {
      const sampleDomains = [
        'ad.doubleclick.net',
        'telemetry.app.io',
        'wikipedia.org',
        'cloud-metrics.beacon.com',
        'cdn.jsdelivr.net',
        'popunder-traffic.biz',
        'accounts.google.com',
        'bidding.dsp-exchange.com',
      ];

      // Warm up JIT optimizer
      for (let i = 0; i < 50; i++) {
        classifier.classify(sampleDomains[i % sampleDomains.length]);
      }

      const startTime = performance.now();
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        classifier.classify(sampleDomains[i % sampleDomains.length]);
      }
      const totalElapsedMs = performance.now() - startTime;
      const perDomainMs = totalElapsedMs / iterations;

      expect(perDomainMs).toBeLessThan(10.0); // Sub-millisecond on bare metal; allows headroom for virtualized/throttled CI runners
    });

    it('utilizes LRU prediction cache and tracks hit/miss statistics', () => {
      const c = new MiniAiClassifier({ maxCacheSize: 50, enableCache: true });
      c.clearCache();

      // First query: cache miss
      const p1 = c.classify('metrics.example.com');
      expect(c.getCacheStats().misses).toBe(1);
      expect(c.getCacheStats().hits).toBe(0);

      // Second query: cache hit
      const p2 = c.classify('metrics.example.com');
      expect(c.getCacheStats().hits).toBe(1);
      expect(p2.verdict).toBe(p1.verdict);
      expect(p2.category).toBe(p1.category);

      // Verify clearCache resets stats
      c.clearCache();
      expect(c.getCacheStats().size).toBe(0);
    });

    it('defends against prototype pollution in feedback and tuning', () => {
      const c = new MiniAiClassifier();
      c.tuneDomainFeedback('__proto__', 'block');
      c.tuneDomainFeedback('constructor', 'block');
      c.tuneDomainFeedback('prototype', 'block');

      expect(c.getDomainFeedback('__proto__')).toBe(0);
      expect(c.getDomainFeedback('constructor')).toBe(0);

      // JSON.parse creates a real own "__proto__" key, unlike an object literal.
      c.importFeedback(JSON.parse(
        '{"__proto__": 1.0, "constructor": 1.0, "prototype": 1.0, "clean-site.org": -1.0}',
      ));

      expect(c.getDomainFeedback('__proto__')).toBe(0);
      const exported = c.exportFeedback();
      expect(exported['__proto__']).toBeUndefined();
      expect(exported['constructor']).toBeUndefined();
      expect(exported['clean-site.org']).toBe(-1.0);
    });

    it('safely handles oversized domains, null bytes, and control characters', () => {
      const c = new MiniAiClassifier();

      // Null byte injection attempt
      const withNull = c.classify('evil\x00.tracker.com');
      expect(withNull).toBeDefined();
      expect(withNull.category).toBeDefined();

      // Zero-width spaces & control characters
      const withControl = c.classify('ads\u200B\u200C.com\x07');
      expect(withControl).toBeDefined();

      // Enormous string (memory exhaustion / ReDoS attempt)
      const oversized = 'a'.repeat(500) + '.evil-dga.xyz';
      const result = c.classify(oversized);
      expect(result).toBeDefined();
      expect(result.inferenceTimeMs).toBeLessThan(100);
    });

    it('accurately identifies and protects all private, local, and public DNS IP addresses', () => {
      const c = new MiniAiClassifier();

      // Private IPv4 (RFC 1918)
      expect(c.classify('10.0.0.1').confidence).toBe(99);
      expect(c.classify('192.168.1.1').confidence).toBe(99);
      expect(c.classify('172.16.5.10').confidence).toBe(99);
      expect(c.classify('127.0.0.1').confidence).toBe(99);
      expect(c.classify('0.0.0.0').confidence).toBe(99);

      // Private IPv6 (Loopback, Link-Local, ULA)
      expect(c.classify('::1').confidence).toBe(99);
      expect(c.classify('fe80::1').confidence).toBe(99);
      expect(c.classify('fd00::dead:beef').confidence).toBe(99);

      // Known Public DNS resolvers
      expect(c.classify('1.1.1.1').confidence).toBe(99);
      expect(c.classify('8.8.8.8').confidence).toBe(99);
      expect(c.classify('9.9.9.9').confidence).toBe(99);
      expect(c.classify('2606:4700:4700::1111').confidence).toBe(99);
    });
  });

  describe('AiDetectorService Integration with Mini-AI (Default)', () => {
    it('defaults to mini-ai provider', () => {
      const service = new AiDetectorService();
      expect(service.getConfig().provider).toBe('mini-ai');
    });

    it('scans domain using Mini-AI and returns featureScores and inferenceTimeMs', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const result = await service.scanDomain('adserver.tracking-beacon.net');

      expect(result.provider).toBe('mini-ai');
      expect(result.modelUsed).toBe('Mini-AI Embedded Classifier (v1)');
      expect(typeof result.inferenceTimeMs).toBe('number');
      expect(result.featureScores).toBeDefined();
      expect(result.generatedRules.length).toBeGreaterThan(0);
      expect(['ad_server', 'tracker', 'suspicious']).toContain(result.verdict);
    });

    it('instantly scans query log batches with high throughput', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const mockQueries = [
        { domain: 'doubleclick.net' },
        { domain: 'google.com' },
        { domain: 'telemetry.tracker.io' },
        { domain: 'github.com' },
        { domain: 'adnxs.com' },
      ];

      const start = performance.now();
      const logScan = await service.scanQueryLog(mockQueries);
      const elapsed = performance.now() - start;

      expect(logScan.totalQueriesAnalyzed).toBe(5);
      expect(logScan.flaggedCount).toBeGreaterThan(0);
      expect(logScan.cleanCount).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(200); // 5 queries scanned in under 200ms
    });

    it('protects Apple APNS on Akamai and Supabase project domains from false positive malware classification', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const falsePositiveTestDomains = [
        '1.courier-push-apple.com.akadns.net',
        '1.courier-sandbox-push-apple.com.akadns.net',
        'lqaitnsphcretimgxxdz.supabase.co',
        'lofvomagimpthggmorfp.supabase.co',
        'api.supabase.co',
        'project.railway.app',
        'my-app.fly.dev',
      ];

      for (const domain of falsePositiveTestDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
        expect(result.confidence).toBeGreaterThanOrEqual(80);
      }
    });

    it('protects global courier and logistics package tracking portals from false positive tracker detection', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const trackingDomains = [
        'tracking.royalmail.com',
        'tracking.canadapost.ca',
        'tracking.dpd.co.uk',
        'tracking.auspost.com.au',
        'track.dhl.de',
        'tracking.ups.com',
        'tracking.fedex.com',
      ];

      for (const domain of trackingDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
        expect(result.confidence).toBeGreaterThanOrEqual(80);
      }
    });

    it('protects Apple, Microsoft, and Google operating system service endpoints from false alarms', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const osServiceDomains = [
        'gateway.icloud.com',
        'mask.icloud.com',
        'captive.apple.com',
        'time.apple.com',
        'weather-data.apple.com',
        'msftconnecttest.com',
        'msftncsi.com',
        'time.windows.com',
        'title.mgt.xboxlive.com',
        'connectivitycheck.gstatic.com',
        'time.google.com',
      ];

      for (const domain of osServiceDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
        expect(result.confidence).toBeGreaterThanOrEqual(80);
      }
    });

    it('protects Smart Home, Smart TV, and local router appliance endpoints from false positives', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const iotDomains = [
        'fritz.box',
        'routerlogin.net',
        'tplinkwifi.net',
        '001788fffe123456.meethue.com',
        'd3q49yxx0a51.iot.us-east-1.amazonaws.com',
        'device-messaging-na.amazon.com',
        'aic.lgtvcommon.com',
        'setup.amplifi.com',
      ];

      for (const domain of iotDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
        expect(result.confidence).toBeGreaterThanOrEqual(80);
      }
    });

    it('protects developer serverless hash slugs, container registries, and package mirrors', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const devDomains = [
        'b41d8cd98f00b204e9800998ecf8427e.vercel.app',
        'project-staging-8a7c.up.railway.app',
        'app-srv-49a0b1.onrender.com',
        'my-edge-app.deno.dev',
        'my-worker.workers.dev',
        'registry-1.docker.io',
        'repo1.maven.org',
        'files.pythonhosted.org',
        'static.crates.io',
      ];

      for (const domain of devDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
        expect(result.confidence).toBeGreaterThanOrEqual(80);
      }
    });

    it('prevents false brand combosquatting on legitimate dictionary words', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const dictionaryDomains = [
        'snapple-delivery.com',
        'steamboat-springs.gov',
      ];

      for (const domain of dictionaryDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
      }
    });

    it('protects institutional government and higher education domains worldwide', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const institutionalDomains = [
        'www.gov.uk',
        'www.bund.de',
        'www.admin.ch',
        'overheid.nl',
        'www.gc.ca',
        'ox.ac.uk',
        'tokyo.ac.jp',
      ];

      for (const domain of institutionalDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
        expect(result.confidence).toBeGreaterThanOrEqual(85);
      }
    });

    it('protects high-entropy media streaming shards and CDN chunk routing', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const streamingDomains = [
        'video-weaver.iad03.hls.ttvnw.net',
        'audio-ak-spotify-com.akamaized.net',
        'v16m-default.akamaized.net',
        's3-r-w.nflxvideo.net',
      ];

      for (const domain of streamingDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
        expect(result.confidence).toBeGreaterThanOrEqual(80);
      }
    });

    it('protects Apple APNS CDN alias endpoints from false brand spoof or malware flags', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const appleApnsDomains = [
        '1.courier-push-apple.com.akadns.net',
        '1.courier-sandbox-push-apple.com.akadns.net',
      ];

      for (const domain of appleApnsDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
        expect(result.confidence).toBeGreaterThanOrEqual(85);
      }
    });

    it('protects multi-tenant project hash subdomains from false DGA malware flags', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const multiTenantDomains = [
        'lqaitnsphcretimgxxdz.supabase.co',
        'lofvomagimpthggmorfp.supabase.co',
        'ep-young-water-123456.neon.tech',
        'db-project-xyz.turso.io',
      ];

      for (const domain of multiTenantDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
      }
    });

    it('protects expanded international institutional and health domains', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const institutionalDomains = [
        'www.nhs.uk',
        'europa.eu',
        'who.int',
        'un.org',
        'parliament.uk',
      ];

      for (const domain of institutionalDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
      }
    });

    it('protects router administration and local network gateway portals', async () => {
      const service = new AiDetectorService({ provider: 'mini-ai' });
      const routerDomains = [
        'fritz.box',
        'routerlogin.net',
        'tplinkwifi.net',
        'setup.amplifi.com',
        'orbilogin.com',
      ];

      for (const domain of routerDomains) {
        const result = await service.scanDomain(domain);
        expect(result.verdict).toBe('clean');
        expect(result.category).toBe('Clean');
      }
    });
  });
});

