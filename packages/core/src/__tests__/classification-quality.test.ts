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
    expect(
      ad.generatedRules.some(
        (rule) =>
          rule.startsWith('||ad.doubleclick.net^') ||
          rule.startsWith('||doubleclick.net^'),
      ),
    ).toBe(true);

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

  describe('False Positive Guard & Active Directory / Institutional Domain Protection', () => {
    const activeDirectoryDomains = [
      'ad.ucla.edu',
      'ad.gatech.edu',
      'ad.washington.edu',
      'ad.corp.local',
      'ad.contoso.com',
      'ad.internal.corp',
      'dc1.ad.company.com',
      'adfs.university.edu',
    ];

    it.each(activeDirectoryDomains)('treats Active Directory / enterprise host %s as clean', (domain) => {
      const pred = classifier.classify(domain);
      expect(pred.verdict).toBe('clean');
      expect(pred.category).toBe('Clean');
      expect(pred.riskLevel).toBe('none');
    });

    const institutionalDomains = [
      'ad.state.gov',
      'bid.ny.gov',
      'bids.sc.gov',
      'stats.bls.gov',
      'weather.gov',
      'irs.gov',
      'cdc.gov',
      'stats.ox.ac.uk',
      'stats.stanford.edu',
      'counter.unesco.org',
    ];

    it.each(institutionalDomains)('protects government and educational endpoint %s as clean', (domain) => {
      const pred = classifier.classify(domain);
      expect(pred.verdict).toBe('clean');
      expect(pred.category).toBe('Clean');
      expect(pred.riskLevel).toBe('none');
    });

    const legitimateServiceDomains = [
      'stats.nba.com',
      'stats.espn.com',
      'stats.stackexchange.com',
      'stats.worldbank.org',
      'stats.oecd.org',
      'dsp.stackexchange.com',
      'click.docusign.net',
      'click.redditmail.com',
      'click.uber.com',
      'counter-strike.net',
      'theguardian.com',
      'washingtonpost.com',
      'homedepot.com',
      'stackoverflow.com',
      'mayoclinic.org',
      'accuweather.com',
      'flightaware.com',
    ];

    it.each(legitimateServiceDomains)('does not falsely flag legitimate site/service %s', (domain) => {
      const pred = classifier.classify(domain);
      expect(pred.verdict).toBe('clean');
      expect(pred.category).toBe('Clean');
      expect(pred.riskLevel).toBe('none');
    });

    it('deterministically overrides any domain to Clean when user marks whitelist feedback', () => {
      const testDomain = 'adserver.adtech.de';
      const before = classifier.classify(testDomain);
      expect(before.verdict).not.toBe('clean');

      classifier.tuneDomainFeedback(testDomain, 'whitelist');
      const after = classifier.classify(testDomain);
      expect(after.verdict).toBe('clean');
      expect(after.category).toBe('Clean');
      expect(after.confidence).toBe(99);
      expect(after.riskLevel).toBe('none');
      expect(after.classProbabilities.Clean).toBe(1.0);
      expect(after.reasons).toContain('Whitelisted by user feedback (False Positive Override)');

      // Reset
      classifier.tuneDomainFeedback(testDomain, 'reset');
      const reset = classifier.classify(testDomain);
      expect(reset.verdict).not.toBe('clean');
    });

    it('detects previously unlisted ad networks as Advertising', () => {
      const adNetworks = [
        'adroll.com',
        'adsterra.com',
        'inmobi.com',
        'ironsrc.com',
        'vungle.com',
        'adcolony.com',
        'mediavine.com',
        'ezoic.com',
        'ezoic.net',
        'sovrn.com',
        'appnexus.com',
        'exoclick.com',
      ];
      for (const domain of adNetworks) {
        const pred = classifier.classify(domain);
        expect(pred.category).toBe('Advertising');
        expect(pred.verdict).not.toBe('clean');
        expect(pred.confidence).toBeGreaterThanOrEqual(70);
      }
    });

    it('detects previously unlisted tracking networks as Telemetry/Analytics', () => {
      const trackerNetworks = [
        'trackcmp.net',
        'crazyegg.com',
        'luckyorange.com',
        'inspectlet.com',
        'woopra.com',
        'clicky.com',
        'statcounter.com',
        'flurry.com',
        'singular.net',
        'kochava.com',
        'braze.com',
        'iterable.com',
        'onesignal.com',
      ];
      for (const domain of trackerNetworks) {
        const pred = classifier.classify(domain);
        expect(pred.category).toBe('Telemetry/Analytics');
        expect(pred.verdict).not.toBe('clean');
        expect(pred.confidence).toBeGreaterThanOrEqual(70);
      }
    });

    it('detects IDN Punycode homograph phishing spoofing attacks', () => {
      // xn--pple-43d.com decodes to аpple.com (Cyrillic 'а')
      const homograph = classifier.classify('xn--pple-43d.com');
      expect(homograph.category).toBe('Malware/Phishing');
      expect(homograph.verdict).toBe('malicious');
      expect(homograph.riskLevel).toBe('critical');
      expect(homograph.topContributions.some((item) => item.name === 'Brand Typo-Squatting')).toBe(true);
    });

    it('detects delivery, banking, and crypto credential harvesting lures', () => {
      const lures = [
        'fedex-delivery-reschedule.xyz',
        'citibank-online-verify.com',
        'ledger-device-validate.xyz',
        'office365-verify-account.com',
        'usps-tracking-package.com',
        'metamask-seed-phrase.xyz',
      ];
      for (const domain of lures) {
        const pred = classifier.classify(domain);
        expect(pred.category).toBe('Malware/Phishing');
        expect(pred.verdict).toBe('malicious');
        expect(pred.riskLevel).toBe('critical');
      }
    });

    it('handles compound ccTLD institutional domains correctly without false positives', () => {
      const institutionalCcTld = [
        'service.transport.gov.in',
        'stats.nsw.gov.au',
        'canada.gc.ca',
        'research.ox.ac.uk',
      ];
      for (const domain of institutionalCcTld) {
        const pred = classifier.classify(domain);
        expect(pred.verdict).toBe('clean');
        expect(pred.category).toBe('Clean');
        expect(pred.riskLevel).toBe('none');
      }
    });

    it('handles empty, whitespace, and malformed inputs gracefully with 0% confidence', () => {
      const invalidInputs = ['', '   ', 'localhost', '...', 'http://'];
      for (const input of invalidInputs) {
        const pred = classifier.classify(input);
        expect(pred.verdict).toBe('clean');
        expect(pred.category).toBe('Clean');
        expect(pred.confidence).toBe(0);
        expect(pred.riskLevel).toBe('none');
        expect(pred.reasons).toContain('Empty or malformed domain string');
      }
    });

    it('correctly normalizes and classifies Adblock Plus rules and Hosts file lines', () => {
      const ruleCases = [
        { input: '||adroll.com^$third-party', expectedCategory: 'Advertising' },
        { input: '0.0.0.0 doubleclick.net', expectedCategory: 'Advertising' },
        { input: '127.0.0.1 trackcmp.net', expectedCategory: 'Telemetry/Analytics' },
        { input: '*.vungle.com', expectedCategory: 'Advertising' },
        { input: '||status.cursor.com^', expectedCategory: 'Clean' },
      ];
      for (const { input, expectedCategory } of ruleCases) {
        const pred = classifier.classify(input);
        expect(pred.category).toBe(expectedCategory);
      }
    });

    it('handles loopback, private, and public DNS IP addresses gracefully without false alarms', () => {
      const privateIps = ['127.0.0.1', '192.168.1.1', '10.0.0.1', '::1'];
      for (const ip of privateIps) {
        const pred = classifier.classify(ip);
        expect(pred.verdict).toBe('clean');
        expect(pred.category).toBe('Clean');
        expect(pred.confidence).toBe(99);
      }

      const publicDnsIps = ['8.8.8.8', '1.1.1.1', '9.9.9.9'];
      for (const ip of publicDnsIps) {
        const pred = classifier.classify(ip);
        expect(pred.verdict).toBe('clean');
        expect(pred.category).toBe('Clean');
        expect(pred.confidence).toBe(99);
      }
    });
  });
});
