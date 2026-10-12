import { describe, expect, it } from '@jest/globals';
import { MiniAiClassifier, extractDomainFeatures } from '../index.js';

// Calibration guard for `lureTokenWeight`: credential-lure wording is a
// *corroborating* signal. It must (a) stay zero wherever a legitimacy gate
// applies, (b) never flip a verdict on a single token, and (c) sharpen the
// Malware/Phishing separation on stacked wording over untrusted zones.
describe('Lure-token calibration', () => {
  const classifier = new MiniAiClassifier();

  it.each([
    // Safe-infrastructure gate
    'login.microsoftonline.com',
    'accounts.google.com',
    // Benign-endpoint gate — `login.`/`billing.` on a readable zone is a
    // product surface, not a lure.
    'login.example.com',
    'billing.example.org',
    'auth.customer-portal.net',
  ])('gates the lure feature to zero on %s', (domain) => {
    expect(extractDomainFeatures(domain).lureTokenWeight).toBe(0);
  });

  it('fires on lure wording where no gate applies', () => {
    expect(extractDomainFeatures('account-verify-secure.xyz').lureTokenWeight).toBeGreaterThan(0);
    expect(extractDomainFeatures('wallet-recover.click').lureTokenWeight).toBeGreaterThan(0);
  });

  it('uses boundary matching — cognates and infixes do not fire', () => {
    // `accountant` is a different word; `logins`/`verified` fail the boundary.
    expect(extractDomainFeatures('accountant.example.party').lureTokenWeight).toBe(0);
    expect(extractDomainFeatures('verified-news.example.party').lureTokenWeight).toBe(0);
  });

  it.each([
    'status.cursor.com',
    'api.github.com',
    'login.microsoftonline.com',
    'accounts.google.com',
    'paypal.com',
    'updates.cdn-apple.com',
    'dns.google',
    'edge-prod-03.customer.example.net',
  ])('keeps %s clean with the lure feature present', (domain) => {
    const prediction = classifier.classify(domain);
    expect(prediction.verdict).toBe('clean');
    expect(prediction.category).not.toBe('Malware/Phishing');
  });

  it('a single lure token alone cannot flip a readable-zone verdict', () => {
    const features = extractDomainFeatures('verify.merchant-example.com');
    expect(features.lureTokenWeight).toBeGreaterThan(0);
    const prediction = classifier.classify('verify.merchant-example.com');
    expect(prediction.category).not.toBe('Malware/Phishing');
    expect(prediction.verdict).not.toBe('malicious');
  });

  it('stacked lure wording sharpens Malware/Phishing on an abuse TLD', () => {
    const lure = classifier.classify('account-verify-billing.xyz');
    const neutral = classifier.classify('merchant-zone-alpha.xyz');
    expect(lure.classProbabilities['Malware/Phishing'])
      .toBeGreaterThan(neutral.classProbabilities['Malware/Phishing']);
    expect(lure.category).toBe('Malware/Phishing');
  });

  it('explains the lure contribution on a malware verdict', () => {
    const prediction = classifier.classify('paypal-login.azurewebsites.net');
    expect(prediction.category).toBe('Malware/Phishing');
    expect(prediction.topContributions.some((item) => item.name === 'Credential-Lure Wording')).toBe(true);
    expect(prediction.reasons.join(' ')).toMatch(/credential wording/i);
  });

  it('does not regress the brand-spoof cases it corroborates', () => {
    expect(classifier.classify('paypa1-security.com').category).toBe('Malware/Phishing');
    expect(classifier.classify('apple-id-verify-login.xyz').category).toBe('Malware/Phishing');
  });

  it('does not reclassify known ad and tracker networks', () => {
    const cases: Array<{ domain: string; categories: string[] }> = [
      { domain: 'ad.doubleclick.net', categories: ['Advertising'] },
      { domain: 'ssl.google-analytics.com', categories: ['Telemetry/Analytics', 'Advertising'] },
      { domain: 'pixel.quantserve.com', categories: ['Telemetry/Analytics', 'Advertising'] },
      { domain: 'adnxs.com', categories: ['Advertising', 'Telemetry/Analytics'] },
    ];
    for (const entry of cases) {
      const prediction = classifier.classify(entry.domain);
      expect(entry.categories).toContain(prediction.category);
      expect(prediction.category).not.toBe('Malware/Phishing');
    }
  });
});
