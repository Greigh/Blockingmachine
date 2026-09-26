import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { promises as dns } from 'node:dns';
import {
  AiDetectorService,
  MiniAiClassifier,
  globalMiniAiClassifier,
  calculateShannonEntropy,
  decomposeDomain,
  normalizeHostname,
  resolveCnameChain,
  clearCnameCache,
  getCnameCacheStats,
  evaluateDomainRules,
  isDomainCoveredByRules,
  synthesizeRules,
  createDefaultScanResult,
  createDefaultMiniAiPrediction,
  isAiScanResult,
  isMiniAiPrediction,
  isDomainEvaluationResult,
  isCompactionResult,
  normalizeThreatCategory,
  clampConfidence,
} from '../ai/index.js';

afterEach(() => {
  jest.restoreAllMocks();
  globalMiniAiClassifier.clearFeedback();
  clearCnameCache();
});

describe('Hostname and entropy correctness', () => {
  it.each([
    ['https://example.com/path@evil.net', 'example.com'],
    ['https://example.com?email=user@evil.net', 'example.com'],
    ['//Example.com:443/path', 'example.com'],
    ['https://user:password@example.com/path@evil.net', 'example.com'],
  ])('extracts the authority of %s', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
    expect(decomposeDomain(input).sld).toBe('example');
  });

  it('keeps an IPv6 address intact during decomposition', () => {
    expect(decomposeDomain('[2001:db8::1]:443')).toMatchObject({
      sld: '2001:db8::1',
      tld: '',
    });
  });

  it('counts Unicode code points and large ASCII frequencies correctly', () => {
    expect(calculateShannonEntropy('😀😀😀')).toBe(0);
    expect(calculateShannonEntropy('😀a')).toBe(1);
    expect(calculateShannonEntropy('a'.repeat(65536) + 'b'.repeat(65536))).toBe(
      1,
    );
  });

  it('isolates cached domain decomposition from caller mutations', () => {
    const value = decomposeDomain('cdn.example.com');
    value.subdomains.push('poison');
    value.labelEntropies[0].label = 'poison';
    const next = decomposeDomain('cdn.example.com');
    expect(next.subdomains).toEqual(['cdn']);
    expect(next.labelEntropies[0].label).toBe('cdn');
  });
});

describe('Scan and prediction cache isolation', () => {
  it('honors DNS options passed to the service constructor', () => {
    const service = new AiDetectorService({ skipDns: true, dnsTimeoutMs: 25 });
    expect(service.getConfig()).toMatchObject({
      skipDns: true,
      dnsTimeoutMs: 25,
    });
  });

  it('does not reuse predictions for a different provider or allowlist', async () => {
    const service = new AiDetectorService();
    const first = await service.scanDomain('ads.example.com', {
      skipDns: true,
    });
    expect(first.verdict).not.toBe('clean');
    const second = await service.scanDomain('ads.example.com', {
      skipDns: true,
      provider: 'local-heuristics',
      allowlist: [' EXAMPLE.COM. '],
    });
    expect(second.verdict).toBe('clean');
    expect(second.provider).toBe('local-heuristics');
  });

  it('honors changed rule coverage and user feedback on a repeated scan', async () => {
    const service = new AiDetectorService({ skipDns: true });
    await service.scanDomain('ads.example.com');
    const covered = await service.scanDomain('ads.example.com', {
      existingRules: ['||example.com^'],
    });
    expect(covered.coveredByRule).toBe('||example.com^');
    globalMiniAiClassifier.tuneDomainFeedback('ads.example.com', 'whitelist');
    expect((await service.scanDomain('ads.example.com')).verdict).toBe('clean');
  });

  it('returns the current input target and protects nested cached results', async () => {
    const service = new AiDetectorService({ skipDns: true });
    const first = await service.scanDomain('https://ads.example.com/first');
    first.reasons.push('poison');
    first.generatedRules.push('||poison.net^');
    first.decomposition!.subdomains.push('poison');
    const next = await service.scanDomain('https://ads.example.com/next');
    expect(next.target).toBe('https://ads.example.com/next');
    expect(next.reasons).not.toContain('poison');
    expect(next.generatedRules).not.toContain('||poison.net^');
    expect(next.decomposition!.subdomains).not.toContain('poison');
    next.reasons.push('second poison');
    expect((await service.scanDomain('ads.example.com')).reasons).not.toContain(
      'second poison',
    );
  });

  it('protects classifier probabilities and explanations from mutation', () => {
    const classifier = new MiniAiClassifier();
    const first = classifier.classify('ads.example.com');
    first.classProbabilities.Clean = NaN;
    first.reasons.push('poison');
    const second = classifier.classify('ads.example.com');
    expect(Number.isFinite(second.classProbabilities.Clean)).toBe(true);
    expect(second.reasons).not.toContain('poison');
    second.reasons.push('second poison');
    expect(classifier.classify('ads.example.com').reasons).not.toContain(
      'second poison',
    );
  });

  it('does not truncate a long URL before extracting its hostname', () => {
    const classifier = new MiniAiClassifier();
    const input = `https://${'u'.repeat(260)}@ads.example.com/`;
    expect(classifier.classify(input).verdict).toBe(
      classifier.classify('ads.example.com').verdict,
    );
  });
});

describe('DNS resolution lifecycle', () => {
  it('protects cached DNS arrays from callers', async () => {
    const first = await resolveCnameChain('localhost');
    first.cnames.push('poison.net');
    expect((await resolveCnameChain('localhost')).cnames).toEqual([]);
  });

  it('stops cyclic chains before adding the origin again', async () => {
    jest
      .spyOn(dns.Resolver.prototype, 'resolveCname')
      .mockImplementation(async (host) =>
        host === 'start.example.com'
          ? ['next.example.com']
          : ['start.example.com'],
      );
    jest.spyOn(dns.Resolver.prototype, 'resolve4').mockResolvedValue([]);
    jest.spyOn(dns.Resolver.prototype, 'resolve6').mockResolvedValue([]);
    expect((await resolveCnameChain('start.example.com')).cnames).toEqual([
      'next.example.com',
    ]);
  });

  it('does not cache timed-out results or start address lookups after cancellation', async () => {
    let complete!: (records: string[]) => void;
    jest.spyOn(dns.Resolver.prototype, 'resolveCname').mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    const addresses = jest
      .spyOn(dns.Resolver.prototype, 'resolve4')
      .mockResolvedValue([]);
    jest.spyOn(dns.Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const result = await resolveCnameChain('slow.example.com', 5);
    complete(['late.example.com']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.cnames).toEqual([]);
    expect(addresses).not.toHaveBeenCalled();
    expect(getCnameCacheStats().size).toBe(0);
  });

  it('does not cache native DNS timeouts that occur before the overall deadline', async () => {
    const timeout = Object.assign(new Error('DNS timed out'), {
      code: 'ETIMEOUT',
    });
    const lookup = jest
      .spyOn(dns.Resolver.prototype, 'resolveCname')
      .mockRejectedValue(timeout);
    jest.spyOn(dns.Resolver.prototype, 'resolve4').mockRejectedValue(timeout);
    jest.spyOn(dns.Resolver.prototype, 'resolve6').mockRejectedValue(timeout);
    await resolveCnameChain('native-timeout.example.com', 3000);
    await resolveCnameChain('native-timeout.example.com', 3000);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(getCnameCacheStats().size).toBe(0);
  });

  it('does not let an in-flight lookup repopulate a cleared cache', async () => {
    let complete!: (records: string[]) => void;
    jest.spyOn(dns.Resolver.prototype, 'resolveCname').mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    jest.spyOn(dns.Resolver.prototype, 'resolve4').mockResolvedValue([]);
    jest.spyOn(dns.Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const pending = resolveCnameChain('clear.example.com');
    clearCnameCache();
    complete([]);
    await pending;
    expect(getCnameCacheStats()).toEqual({ size: 0, inFlight: 0 });
  });
});

describe('External model response handling', () => {
  it('keeps the selected verdict paired with its own confidence', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          response: JSON.stringify({
            verdict: 'clean',
            category: 'Clean',
            confidence: 0,
            reasons: ['Model is uncertain'],
          }),
        }),
      ),
    );
    const result = await new AiDetectorService({
      provider: 'ollama',
      skipDns: true,
    }).scanDomain('ads.example.com');
    expect(result.verdict).toBe('clean');
    expect(result.confidence).toBe(0);
  });

  it('filters non-string explanations at the external data boundary', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          response: JSON.stringify({
            verdict: 'tracker',
            category: 'Telemetry/Analytics',
            confidence: 80,
            reasons: ['  Tracking beacon  ', null, {}, ''],
          }),
        }),
      ),
    );
    const result = await new AiDetectorService({
      provider: 'ollama',
      skipDns: true,
    }).scanDomain('metrics.example.com');
    expect(result.reasons).toEqual(['Tracking beacon']);
    expect(isAiScanResult(result)).toBe(true);
  });

  it.each([
    '[]',
    '{"verdict":"clean","confidence":1e309}',
    '{"verdict":"clean"}',
  ])(
    'falls back to heuristics for malformed model JSON %s',
    async (response) => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ response })));
      const result = await new AiDetectorService({
        provider: 'ollama',
        skipDns: true,
      }).scanDomain('ads.example.com');
      expect(result.verdict).toBe('suspicious');
      expect(result.modelUsed).toBeUndefined();
      expect(isAiScanResult(result)).toBe(true);
    },
  );
});

describe('Domain rule semantics', () => {
  it('preserves www when evaluating an exact hosts rule', () => {
    expect(
      isDomainCoveredByRules('www.example.com', ['www.example.com']).isCovered,
    ).toBe(true);
    expect(
      isDomainCoveredByRules('example.com', ['www.example.com']).isCovered,
    ).toBe(false);
    expect(
      isDomainCoveredByRules('www.example.com', ['www.example.com$important'])
        .isCovered,
    ).toBe(true);
    expect(
      evaluateDomainRules('example.com', [
        '||example.com^',
        '@@www.example.com',
      ]).verdict,
    ).toBe('blocked');
    expect(
      evaluateDomainRules('www.example.com', [
        '||example.com^',
        '@@www.example.com',
      ]).verdict,
    ).toBe('exception');
  });

  it('does not apply request-scoped modifiers through fallback rule syntax', () => {
    expect(
      isDomainCoveredByRules('example.com', ['example.com$script']).isCovered,
    ).toBe(false);
    expect(
      evaluateDomainRules('example.com', [
        '||example.com^',
        '@@https://example.com$script',
      ]).verdict,
    ).toBe('blocked');
    expect(
      isDomainCoveredByRules('example.com', ['0.0.0.0 example.com # costs $1'])
        .isCovered,
    ).toBe(true);
  });

  it('badfilter only disables the matching rule, preserving child rules', () => {
    const rules = [
      '||example.com^',
      '||ads.example.com^',
      '||example.com^$badfilter',
    ];
    expect(evaluateDomainRules('ads.example.com', rules).matchingRule).toBe(
      '||ads.example.com^',
    );
  });

  it('recognizes modifiers in any order and disables exception rules', () => {
    const rules = [
      '||example.com^$denyallow=safe.example.com,important',
      '@@||example.com^',
    ];
    expect(evaluateDomainRules('ads.example.com', rules).verdict).toBe(
      'blocked',
    );
    expect(
      evaluateDomainRules('example.com', [
        '||example.com^',
        '@@||example.com^',
        '@@||example.com^$badfilter',
      ]).verdict,
    ).toBe('blocked');
  });

  it.each(['script', 'third-party', 'domain=news.example', 'redirect=noopjs'])(
    'does not claim whole-domain blocking for $%s',
    (modifier) => {
      const rules = [`||example.com^$${modifier}`];
      expect(evaluateDomainRules('example.com', rules).verdict).toBe(
        'not_blocked',
      );
      expect(isDomainCoveredByRules('example.com', rules).isCovered).toBe(
        false,
      );
    },
  );

  it('coverage respects exceptions, denyallow and disabled rules', () => {
    for (const rules of [
      ['||example.com^', '@@||safe.example.com^'],
      ['||example.com^$denyallow=safe.example.com'],
      ['||example.com^', '||example.com^$badfilter'],
    ])
      expect(isDomainCoveredByRules('safe.example.com', rules).isCovered).toBe(
        false,
      );
  });

  it('does not generate rules blocking shared hosting CNAME destinations', () => {
    const rules = synthesizeRules({
      domain: 'ads.example.com',
      verdict: 'ad_server',
      category: 'Advertising',
      cnames: ['tenant.cloudfront.net', 'retailer.criteo.com'],
    });
    expect(rules).not.toContain('||tenant.cloudfront.net^');
    expect(rules).toContain('||retailer.criteo.com^');
  });

  it('preserves zero confidence in generated comments', () => {
    const rules = synthesizeRules({
      domain: 'ads.example.com',
      verdict: 'ad_server',
      category: 'Advertising',
      confidence: 0,
      includeComments: true,
    });
    expect(rules[0]).toContain('(0% confidence)');
  });
});

describe('Runtime contracts', () => {
  it.each([NaN, Infinity, -1, 101])(
    'rejects invalid confidence %s',
    (confidence) => {
      expect(
        isAiScanResult(createDefaultScanResult('example.com', { confidence })),
      ).toBe(false);
      expect(
        isMiniAiPrediction(createDefaultMiniAiPrediction({ confidence })),
      ).toBe(false);
    },
  );

  it('validates required scan fields and nested values', () => {
    const valid = createDefaultScanResult('example.com');
    expect(isAiScanResult({ ...valid, provider: 'invalid' })).toBe(false);
    expect(isAiScanResult({ ...valid, reasons: [42] })).toBe(false);
    expect(isAiScanResult({ ...valid, cnames: undefined })).toBe(false);
    expect(isAiScanResult({ ...valid, featureScores: { Clean: NaN } })).toBe(
      false,
    );
    expect(
      isAiScanResult({ ...valid, decomposition: { subdomains: [] } }),
    ).toBe(false);
  });

  it('rejects malformed probabilities, rule matches and compaction groups', () => {
    expect(
      isMiniAiPrediction({
        ...createDefaultMiniAiPrediction(),
        classProbabilities: [],
      }),
    ).toBe(false);
    expect(
      isDomainEvaluationResult({
        domain: 'example.com',
        verdict: 'blocked',
        matchingRules: [{}],
        overriddenRules: [],
        details: '',
      }),
    ).toBe(false);
    expect(
      isCompactionResult({
        originalCount: 1,
        compactedCount: 1,
        compactedRules: ['||example.com^'],
        savingsPercent: 0,
        collapsedGroups: [{}],
      }),
    ).toBe(false);
  });

  it('normalizes categories by meaning and clamps invalid fallbacks', () => {
    expect(normalizeThreatCategory('cname cloaking ad tracker')).toBe(
      'CNAME Cloaking',
    );
    expect(normalizeThreatCategory('download')).toBe('Unknown');
    expect(clampConfidence(NaN, Infinity)).toBe(0);
    expect(clampConfidence(undefined, 150)).toBe(100);
  });
});
