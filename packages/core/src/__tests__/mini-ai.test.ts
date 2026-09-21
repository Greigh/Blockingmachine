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
      const prediction = classifier.classify('adservice.googleadservices.com');
      expect(prediction.category).toBe('Advertising');
      expect(['ad_server', 'suspicious']).toContain(prediction.verdict);
      expect(prediction.confidence).toBeGreaterThanOrEqual(70);
      expect(prediction.topContributions.length).toBeGreaterThan(0);
      expect(prediction.inferenceTimeMs).toBeLessThan(5); // Ultra fast

      const helperPrediction = classifyDomainWithMiniAi('adservice.googleadservices.com');
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

      const startTime = performance.now();
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        classifier.classify(sampleDomains[i % sampleDomains.length]);
      }
      const totalElapsedMs = performance.now() - startTime;
      const perDomainMs = totalElapsedMs / iterations;

      expect(perDomainMs).toBeLessThan(0.5); // Under 0.5ms per domain (>2000 domains/sec)
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
  });
});
