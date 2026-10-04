import { describe, expect, it } from '@jest/globals';
import {
  MiniAiClassifier,
  assessCorroboration,
  clampRiskLevel,
  extractDomainFeatures,
  type CorroborationTier,
  type RiskLevel,
} from '../ai/index.js';

/**
 * Corroboration-aware confidence and risk.
 *
 * A verdict is only as strong as the *independent* evidence behind it. Before this,
 * a hostname whose shape happened to look machine-generated reported itself as
 * "100% critical malware" on the strength of a single statistical property — which is
 * how a pile of real false positives ended up screaming at the user. Now the number
 * of evidence families sets a ceiling on what the verdict may claim.
 */

const classifier = new MiniAiClassifier();

const TIER_CEILING: Record<CorroborationTier, { confidence: number; risk: number }> = {
  corroborated: { confidence: 100, risk: 4 },
  'single-signal': { confidence: 70, risk: 3 },
  'lexical-only': { confidence: 50, risk: 2 },
};

const RISK_ORDER: Record<RiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

describe('Evidence corroboration', () => {
  describe('assessCorroboration', () => {
    it('counts a known ad network as specific evidence', () => {
      const domain = 'ad.doubleclick.net';
      const assessment = assessCorroboration(domain, extractDomainFeatures(domain));
      expect(assessment.families).toContain('known-network');
      expect(assessment.specific).toBeGreaterThanOrEqual(1);
      expect(assessment.tier).toBe('corroborated');
      expect(assessment.maxConfidence).toBe(100);
    });

    it('counts brand impersonation as specific evidence', () => {
      const domain = 'apple-login.xyz';
      const assessment = assessCorroboration(domain, extractDomainFeatures(domain));
      expect(assessment.families).toContain('brand-impersonation');
      expect(assessment.tier).toBe('corroborated');
    });

    it('treats a vowel-free label as strong shape evidence', () => {
      const domain = 'qxzjkwtrmpfd.com';
      const assessment = assessCorroboration(domain, extractDomainFeatures(domain));
      expect(assessment.families).toContain('vowel-free');
      expect(assessment.tier).toBe('corroborated');
    });

    it('rates a lone statistical shape signal as single-signal', () => {
      const domain = 'zq97kx24bwa-bot.xyz';
      const assessment = assessCorroboration(domain, extractDomainFeatures(domain));
      expect(assessment.specific).toBe(0);
      expect(assessment.tier).toBe('single-signal');
      expect(assessment.maxConfidence).toBe(70);
      expect(assessment.maxRiskLevel).toBe('high');
    });

    it('reports no evidence families for an ordinary readable hostname', () => {
      const domain = 'github.com';
      const assessment = assessCorroboration(domain, extractDomainFeatures(domain));
      expect(assessment.families).toEqual([]);
      expect(assessment.tier).toBe('lexical-only');
      expect(assessment.maxConfidence).toBe(50);
      expect(assessment.maxRiskLevel).toBe('medium');
    });

    it('does not count Shannon entropy as a family (every long hostname has it)', () => {
      // `example-analytics-collector` has high raw entropy but no other signal.
      const domain = 'telemetry.analytics.metrics-collector.io';
      const features = extractDomainFeatures(domain);
      expect(features.entropyFull).toBeGreaterThan(0);
      const assessment = assessCorroboration(domain, features);
      expect(assessment.families).not.toContain('entropy');
    });

    it('recognises CNAME uncloaking as a specific family', () => {
      const domain = 'sub.retailer.com';
      const assessment = assessCorroboration(domain, extractDomainFeatures(domain), {
        knownTrackerCname: true,
      });
      expect(assessment.families).toContain('cname-uncloak');
      expect(assessment.tier).toBe('corroborated');
    });

    it('never returns more families than it lists', () => {
      for (const domain of [
        'ad.doubleclick.net',
        'apple-login.xyz',
        'qxzjkwtrmpfd.com',
        'github.com',
        'beacon.example.com',
      ]) {
        const assessment = assessCorroboration(domain, extractDomainFeatures(domain));
        expect(assessment.specific).toBeLessThanOrEqual(assessment.families.length);
        expect(new Set(assessment.families).size).toBe(assessment.families.length);
      }
    });
  });

  describe('clampRiskLevel', () => {
    it('lowers a risk level that outruns its evidence', () => {
      expect(clampRiskLevel('critical', 'high')).toBe('high');
      expect(clampRiskLevel('critical', 'medium')).toBe('medium');
    });

    it('never raises a risk level', () => {
      expect(clampRiskLevel('medium', 'critical')).toBe('medium');
      expect(clampRiskLevel('none', 'critical')).toBe('none');
      expect(clampRiskLevel('low', 'low')).toBe('low');
    });
  });

  describe('classifier confidence ceilings', () => {
    it('never lets a single weak signal report critical at 100%', () => {
      const prediction = classifier.classify('zq97kx24bwa-bot.xyz');
      expect(prediction.verdict).not.toBe('clean');
      expect(prediction.corroboration).toBe('single-signal');
      expect(prediction.confidence).toBeLessThanOrEqual(70);
      expect(prediction.riskLevel).not.toBe('critical');
      expect(prediction.riskLevel).toBe('high');
    });

    it('caps a lone telemetry token below full confidence', () => {
      const prediction = classifier.classify('beacon.example.com');
      expect(prediction.corroboration).toBe('single-signal');
      expect(prediction.confidence).toBe(70);
      expect(prediction.evidenceFamilies).toContain('keyword');
    });

    it('caps keyword-only token matches', () => {
      const prediction = classifier.classify('telemetry.analytics.metrics-collector.io');
      expect(prediction.confidence).toBeLessThanOrEqual(70);
      expect(prediction.riskLevel).not.toBe('critical');
    });

    it('explains the cap in the reasons', () => {
      const prediction = classifier.classify('zq97kx24bwa-bot.xyz');
      expect(prediction.reasons.join(' ')).toMatch(/lead/i);
    });

    it('keeps full confidence for corroborated findings', () => {
      const ad = classifier.classify('ad.doubleclick.net');
      expect(ad.corroboration).toBe('corroborated');
      expect(ad.confidence).toBeGreaterThanOrEqual(90);

      const spoof = classifier.classify('apple-login.xyz');
      expect(spoof.corroboration).toBe('corroborated');
      expect(spoof.riskLevel).toBe('critical');

      const dga = classifier.classify('qxzjkwtrmpfd.com');
      expect(dga.corroboration).toBe('corroborated');
      expect(dga.riskLevel).toBe('critical');
      expect(dga.confidence).toBeGreaterThanOrEqual(90);
    });

    it('leaves clean verdicts uncapped and unannotated', () => {
      const prediction = classifier.classify('github.com');
      expect(prediction.verdict).toBe('clean');
      expect(prediction.confidence).toBeGreaterThanOrEqual(95);
      expect(prediction.riskLevel).toBe('none');
      expect(prediction.corroboration).toBeUndefined();
    });

    it.each([
      'ad.doubleclick.net',
      'scorecardresearch.com',
      'getadmiral.com',
      'apple-login.xyz',
      'paypa1-security.com',
      'xn--pple-43d.com',
      'qxzjkwtrmpfd.com',
      'xkqwzrtpmjvl.xyz',
      '4f9b2a7e1c8d0e5f.com',
      'zq97kx24bwa-bot.xyz',
      'beacon.example.com',
      'pixel.example.com',
      'tracker.acme-corp.net',
      'telemetry.analytics.metrics-collector.io',
      'xq97kz24bwamzq.com',
    ])('keeps %s within its evidence ceiling', (domain) => {
      const prediction = classifier.classify(domain);
      if (prediction.corroboration === undefined) return;
      const ceiling = TIER_CEILING[prediction.corroboration];
      expect(`${domain}:${prediction.confidence}`).toBe(`${domain}:${Math.min(prediction.confidence, ceiling.confidence)}`);
      expect(RISK_ORDER[prediction.riskLevel]).toBeLessThanOrEqual(ceiling.risk);
    });

    it('exposes families on the prediction for the UI to explain', () => {
      const prediction = classifier.classify('ad.doubleclick.net');
      expect(Array.isArray(prediction.evidenceFamilies)).toBe(true);
      expect(prediction.evidenceFamilies!.length).toBeGreaterThan(0);
    });
  });
});
