import {
  AiDetectorService,
  MiniAiClassifier,
  clampConfidencePercent,
  extractDomainFeatures,
  formatConfidencePercent,
  verdictBadgeLabel,
} from '../index.js';

const scanConfig = { provider: 'mini-ai' as const, skipDns: true, bypassCache: true };

describe('Classification quality', () => {
  const classifier = new MiniAiClassifier();
  const service = new AiDetectorService({ provider: 'mini-ai' });

  const knownGood = [
    'diag.meethue.com',
    'bridge.meethue.com',
    'status.cursor.com',
    'api.github.com',
    'status.github.com',
    'status.slack.com',
    'onedscolprdcus09.centralus.cloudapp.azure.com',
    'waws-prod-blu-179.eastus.cloudapp.azure.com',
    'mystorage.blob.core.windows.net',
    'contoso.azurewebsites.net',
    'bucket-name.s3.us-east-1.amazonaws.com',
    'd111111abcdef8.cloudfront.net',
    'my-service.appspot.com',
    'storage.googleapis.com',
    'updates.cdn-apple.com',
    'ocsp.apple.com',
    'time.apple.com',
    'login.microsoftonline.com',
    'mqtt.ecobee.com',
    'device.tplinkcloud.com',
    'api.smartthings.com',
    'api.openai.com',
    'download.mozilla.org',
    'dns.google',
    'one.one.one.one',
    'www.google.com',
    'accounts.google.com',
    'paypal.com',
    'cdn.jsdelivr.net',
    'edge-prod-03.customer.example.net',
  ];

  it.each(knownGood)('treats %s as clean infrastructure', (domain) => {
    const prediction = classifier.classify(domain);
    expect(prediction.verdict).toBe('clean');
    expect(prediction.category).toBe('Clean');
    expect(prediction.riskLevel).toBe('none');
    expect(prediction.confidence).toBeGreaterThan(0);
    expect(prediction.confidence).toBeLessThanOrEqual(100);
    expect(prediction.category).not.toBe('Malware/Phishing');
  });

  it('does not treat status hosts as telemetry because of the letters s-t-a-t', () => {
    const features = extractDomainFeatures('status.cursor.com');
    expect(features.trackerKeywordWeight).toBe(0);
    const prediction = classifier.classify('status.cursor.com');
    expect(prediction.reasons.join(' ')).not.toMatch(/telemetry token/i);
  });

  it('does not escalate weak or structural hostnames to malware', () => {
    const domains = [
      '0tp9ssgtptvs.stspg-customer.com',
      'xq97kz24bwamzq.com',
      'edge-prod-03.customer.example.net',
    ];
    for (const domain of domains) {
      const prediction = classifier.classify(domain);
      expect(prediction.category).not.toBe('Malware/Phishing');
      expect(prediction.verdict).not.toBe('malicious');
      expect(prediction.riskLevel).not.toBe('critical');
      expect(prediction.riskLevel).not.toBe('high');
      expect(prediction.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('keeps real ad and tracker networks', () => {
    const cases: Array<{ domain: string; categories: string[] }> = [
      { domain: 'ad.doubleclick.net', categories: ['Advertising'] },
      { domain: 'googleads.g.doubleclick.net', categories: ['Advertising'] },
      { domain: 'www.googleadservices.com', categories: ['Advertising'] },
      { domain: 'pagead2.googlesyndication.com', categories: ['Advertising'] },
      { domain: 'ssl.google-analytics.com', categories: ['Telemetry/Analytics', 'Advertising'] },
      { domain: 'www.googletagmanager.com', categories: ['Telemetry/Analytics', 'Advertising'] },
      { domain: 'scorecardresearch.com', categories: ['Telemetry/Analytics', 'Advertising'] },
      { domain: 'pixel.quantserve.com', categories: ['Telemetry/Analytics', 'Advertising'] },
      { domain: 'adnxs.com', categories: ['Advertising', 'Telemetry/Analytics'] },
      { domain: 'criteo.com', categories: ['Advertising', 'Telemetry/Analytics'] },
      { domain: 'taboola.com', categories: ['Advertising', 'Telemetry/Analytics'] },
      { domain: 'adservice.google.com', categories: ['Advertising'] },
    ];

    for (const entry of cases) {
      const prediction = classifier.classify(entry.domain);
      expect(entry.categories).toContain(prediction.category);
      expect(prediction.verdict).not.toBe('clean');
      expect(prediction.confidence).toBeGreaterThanOrEqual(70);
      expect(prediction.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('reserves malware for corroborated phishing and abuse-TLD DGA names', () => {
    const spoof = classifier.classify('paypa1-security.com');
    expect(spoof.category).toBe('Malware/Phishing');
    expect(spoof.verdict).toBe('malicious');
    expect(spoof.topContributions.some((item) => item.name === 'Brand Typo-Squatting')).toBe(true);

    const lure = classifier.classify('apple-id-verify-login.xyz');
    expect(lure.category).toBe('Malware/Phishing');
    expect(lure.verdict).toBe('malicious');

    const hostedPhish = classifier.classify('paypal-login.azurewebsites.net');
    expect(hostedPhish.category).toBe('Malware/Phishing');
    expect(hostedPhish.verdict).toBe('malicious');
    expect(hostedPhish.riskLevel).not.toBe('none');

    const abuseTld = classifier.classify('zq97kx24bwa-bot.xyz');
    expect(abuseTld.verdict).not.toBe('clean');
    expect(abuseTld.riskLevel).not.toBe('none');
    expect(['Malware/Phishing', 'Advertising']).toContain(abuseTld.category);
  });

  it('does not recommend block rules for clean product and cloud hosts', async () => {
    const domains = [
      'status.cursor.com',
      'diag.meethue.com',
      'waws-prod-blu-179.eastus.cloudapp.azure.com',
      'onedscolprdcus09.centralus.cloudapp.azure.com',
    ];
    for (const domain of domains) {
      const result = await service.scanDomain(domain, scanConfig);
      expect(result.verdict).toBe('clean');
      expect(result.category).toBe('Clean');
      expect(result.generatedRules).toEqual([]);
      expect(result.confidence).toBeLessThanOrEqual(100);
      expect(result.reasons.join(' ')).not.toMatch(/Malware\/Phishing/i);
    }
  });

  it('still synthesizes block rules for doubleclick and scorecardresearch', async () => {
    const ad = await service.scanDomain('ad.doubleclick.net', scanConfig);
    expect(ad.verdict).toBe('ad_server');
    expect(ad.category).toBe('Advertising');
    expect(ad.generatedRules.some((rule) => rule.includes('doubleclick.net'))).toBe(true);
    expect(ad.confidence).toBeLessThanOrEqual(100);

    const tracker = await service.scanDomain('scorecardresearch.com', scanConfig);
    expect(tracker.verdict).not.toBe('clean');
    expect(tracker.generatedRules.length).toBeGreaterThan(0);
    expect(tracker.confidence).toBeLessThanOrEqual(100);
  });

  it('clamps confidence onto 0–100', () => {
    expect(clampConfidencePercent(99)).toBe(99);
    expect(clampConfidencePercent(99.4)).toBe(99);
    expect(clampConfidencePercent(9900)).toBe(100);
    expect(clampConfidencePercent(101)).toBe(100);
    expect(clampConfidencePercent(-4)).toBe(0);
    expect(clampConfidencePercent(Number.NaN)).toBe(0);
    expect(formatConfidencePercent(99)).toBe('99%');
    expect(formatConfidencePercent(9900)).toBe('100%');
    expect(verdictBadgeLabel('ad_server')).toBe('AD SERVER');
    expect(verdictBadgeLabel('tracker')).toBe('TRACKER');
    expect(verdictBadgeLabel('malicious')).toBe('MALWARE');
    expect(verdictBadgeLabel('suspicious')).toBe('SUSPICIOUS');
    expect(verdictBadgeLabel('clean')).toBe('CLEAN');
  });
});
