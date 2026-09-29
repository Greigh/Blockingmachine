import {
  MiniAiClassifier,
  analyzeQueryBehavior,
  escalateRiskWithBehavior,
  getRegistrableZone,
  selectThirdPartyCandidates,
  type RawDnsQuery,
} from '../index.js';

const scanConfig = { provider: 'mini-ai' as const, skipDns: true, bypassCache: true };

describe('Registrable zone resolution', () => {
  it('returns two-label zones for ordinary domains', () => {
    expect(getRegistrableZone('status.cursor.com')).toBe('cursor.com');
    expect(getRegistrableZone('api.example.co.uk')).toBe('example.co.uk');
    expect(getRegistrableZone('example.com')).toBe('example.com');
  });

  it('keeps tenant labels on dynamic DNS and multi-tenant hosting suffixes', () => {
    // The tenant label is part of the registrable identity on shared hosting
    expect(getRegistrableZone('myapp.tenant.github.io')).toBe('tenant.github.io');
  });

  it('is safe on malformed input', () => {
    expect(getRegistrableZone('')).toBeNull();
    expect(getRegistrableZone('localhost')).toBe('localhost');
  });
});

describe('Zone-generalized feedback memory', () => {
  let classifier: MiniAiClassifier;

  beforeEach(() => {
    classifier = new MiniAiClassifier({ enableCache: false });
  });

  it('generalizes whitelist feedback to sibling subdomains', () => {
    classifier.tuneDomainFeedback('api.example.com', 'whitelist');
    // Exact domain keeps its own entry
    expect(classifier.getDomainFeedback('api.example.com')).toBe(-1.0);
    // Sibling inherits the zone entry
    expect(classifier.getDomainFeedback('api2.example.com')).toBe(-1.0);
    expect(classifier.getZoneFeedback('example.com')).toBe(-1.0);
    expect(classifier.getFeedbackZone('api2.example.com')).toBe('example.com');
  });

  it('keeps exact-domain bias precedence over zone bias', () => {
    classifier.tuneDomainFeedback('api.example.com', 'whitelist');
    classifier.tuneDomainFeedback('ads.example.com', 'block');
    expect(classifier.getDomainFeedback('ads.example.com')).toBe(1.0);
    expect(classifier.getDomainFeedback('api.example.com')).toBe(-1.0);
    // Untuned sibling inherits the most recent zone-wide action
    expect(classifier.getDomainFeedback('other.example.com')).toBe(1.0);
  });

  it('restores zone bias through export/import round trips', () => {
    classifier.tuneDomainFeedback('api.example.com', 'whitelist');
    const exported = classifier.exportFeedback();
    const restored = new MiniAiClassifier({ enableCache: false });
    restored.importFeedback(exported);
    expect(restored.getDomainFeedback('sibling.example.com')).toBe(-1.0);
  });

  it('reset feedback removes the zone entry while exact entries survive', () => {
    classifier.tuneDomainFeedback('api.example.com', 'block');
    // Deleting via a sibling resolves to the zone entry
    expect(classifier.deleteDomainFeedback('weird-other.example.com')).toBe(true);
    expect(classifier.getZoneFeedback('example.com')).toBe(0);
    expect(classifier.getFeedbackZone('sibling.example.com')).toBeNull();
    // The exact entry recorded for api.example.com remains
    expect(classifier.getDomainFeedback('api.example.com')).toBe(1.0);
    expect(classifier.getFeedbackCount()).toBe(1);
  });

  it('does not generalize across different registrable zones', () => {
    classifier.tuneDomainFeedback('api.example.com', 'whitelist');
    expect(classifier.getDomainFeedback('api.other.org')).toBe(0);
    expect(classifier.getDomainFeedback('example.com.evil.io')).toBe(0);
  });
});

describe('Behavioral query stream analysis', () => {
  const base = Date.now();

  function beaconQueries(domain: string, gapMs: number, count: number, client = '192.168.1.10'): RawDnsQuery[] {
    const queries: RawDnsQuery[] = [];
    for (let i = 0; i < count; i++) {
      queries.push({ domain, client, timestamp: new Date(base + i * gapMs).toISOString(), blocked: false });
    }
    return queries;
  }

  it('detects periodic low-jitter beaconing cadence', () => {
    const insights = analyzeQueryBehavior(beaconQueries('telemetry-beacon.example', 60_000, 6));
    const insight = insights.find((i) => i.domain === 'telemetry-beacon.example');
    expect(insight).toBeDefined();
    expect(insight!.beaconingDetected).toBe(true);
    expect(insight!.medianIntervalSeconds).toBe(60);
    expect(insight!.reasons.some((r) => /beaconing cadence/i.test(r))).toBe(true);
  });

  it('detects coordinated fan-out across devices', () => {
    const devices = ['192.168.1.2', '192.168.1.3', '192.168.1.4', '192.168.1.5'];
    const queries: RawDnsQuery[] = devices.map((client, i) => ({
      domain: 'shared-tracker.example',
      client,
      timestamp: new Date(base + i * 1000).toISOString(),
      blocked: false,
    }));
    const insight = analyzeQueryBehavior(queries).find((i) => i.domain === 'shared-tracker.example');
    expect(insight).toBeDefined();
    expect(insight!.egressDevices).toBe(4);
    expect(insight!.reasons.some((r) => /coordinated fan-out/i.test(r))).toBe(true);
  });

  it('does not flag single-device human-paced traffic', () => {
    const queries: RawDnsQuery[] = [0, 13_000, 41_000, 77_000, 96_000].map((offset) => ({
      domain: 'normal-browsing.example',
      client: '192.168.1.2',
      timestamp: new Date(base + offset).toISOString(),
      blocked: false,
    }));
    expect(analyzeQueryBehavior(queries)).toEqual([]);
  });

  it('handles missing timestamps and clients gracefully', () => {
    const queries: RawDnsQuery[] = [
      { domain: 'no-meta.example', blocked: false },
      { domain: 'no-meta.example', blocked: false },
    ];
    expect(analyzeQueryBehavior(queries)).toEqual([]);
  });

  it('escalates flagged risk with behavioral evidence but never escalates clean verdicts', () => {
    const insight = {
      domain: 'x',
      queryCount: 10,
      egressDevices: 4,
      beaconingDetected: true,
      reasons: ['evidence'],
    };
    expect(escalateRiskWithBehavior('medium', insight)).toBe('high');
    expect(escalateRiskWithBehavior('high', insight)).toBe('high');
    expect(escalateRiskWithBehavior('none', undefined)).toBe('none');
  });

  it('enriches scanQueryLog results with behavioral evidence', async () => {
    const { AiDetectorService } = await import('../index.js');
    const service = new AiDetectorService({ provider: 'mini-ai', skipDns: true });
    const queries: RawDnsQuery[] = [
      ...beaconQueries('ad.doubleclick.net', 30_000, 5, '192.168.1.7'),
      ...beaconQueries('ad.doubleclick.net', 30_000, 5, '192.168.1.8'),
      { domain: 'status.cursor.com', client: '192.168.1.7', blocked: false },
    ];
    const report = await service.scanQueryLog(queries, scanConfig);
    const flagged = report.results.find((r) => r.domain === 'ad.doubleclick.net');
    expect(flagged).toBeDefined();
    expect(flagged!.verdict).not.toBe('clean');
    expect(flagged!.reasons.some((r) => /beaconing cadence/i.test(r))).toBe(true);
    expect(flagged!.riskLevel).toBe('high');
    // Clean domains stay clean even with beacon-like cadence
    const clean = report.results.find((r) => r.domain === 'status.cursor.com');
    expect(clean?.verdict).toBe('clean');
  });
});

describe('Crawler third-party selection', () => {
  it('drops first-party hosts and www counterparts but keeps third parties', () => {
    const candidates = selectThirdPartyCandidates(
      'www.news-site.example',
      [
        'www.news-site.example',
        'static.news-site.example',
        'cdn.assets-news-site.example',
        'ads third-party.example'.replace(' ', '.'),
        'google-analytics.com',
      ],
      [],
    );
    expect(candidates).toContain('ads.third-party.example');
    expect(candidates).toContain('google-analytics.com');
    expect(candidates).not.toContain('www.news-site.example');
    expect(candidates).not.toContain('static.news-site.example');
  });

  it('drops hosts already covered by existing rules', () => {
    const candidates = selectThirdPartyCandidates(
      'news-site.example',
      ['doubleclick.net', 'innocent-cdn.example'],
      ['||doubleclick.net^'],
    );
    expect(candidates).not.toContain('doubleclick.net');
    expect(candidates).toContain('innocent-cdn.example');
  });

  it('keeps multi-tenant platform hosts that are not the page itself', () => {
    const candidates = selectThirdPartyCandidates(
      'vendor.example',
      ['customer-support.zendesk.com', 'vendor.example'],
      [],
    );
    expect(candidates).toContain('customer-support.zendesk.com');
    expect(candidates).not.toContain('vendor.example');
  });
});
