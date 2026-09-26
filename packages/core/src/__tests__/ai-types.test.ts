import { describe, it, expect } from '@jest/globals';
import {
  THREAT_CATEGORIES,
  RISK_LEVELS,
  AI_VERDICTS,
  AI_PROVIDER_TYPES,
  SYNTHESIS_TARGETS,
  DOMAIN_VERDICTS,
  INFRA_KINDS,
  ANTI_ADBLOCK_PROVIDERS,
  isThreatCategory,
  isRiskLevel,
  isAiVerdict,
  isAiProviderType,
  isSynthesisTarget,
  isDomainVerdict,
  isInfraKind,
  isAntiAdblockProviderId,
  isAiScanResult,
  isMiniAiPrediction,
  isDomainEvaluationResult,
  isCompactionResult,
  normalizeVerdict,
  normalizeThreatCategory,
  normalizeRiskLevel,
  clampConfidence,
  createDefaultScanResult,
  createDefaultMiniAiPrediction,
  createDefaultDomainEvaluationResult,
} from '../index.js';

describe('AI Radar Types & Runtime Hardening Guards', () => {
  describe('Enumeration Constants & Type Guards', () => {
    it('validates ThreatCategory values correctly', () => {
      for (const cat of THREAT_CATEGORIES) {
        expect(isThreatCategory(cat)).toBe(true);
      }
      expect(isThreatCategory('InvalidCategory')).toBe(false);
      expect(isThreatCategory('')).toBe(false);
      expect(isThreatCategory(123)).toBe(false);
      expect(isThreatCategory(null)).toBe(false);
    });

    it('validates RiskLevel values correctly', () => {
      for (const level of RISK_LEVELS) {
        expect(isRiskLevel(level)).toBe(true);
      }
      expect(isRiskLevel('extreme')).toBe(false);
      expect(isRiskLevel(undefined)).toBe(false);
    });

    it('validates AiVerdict values correctly', () => {
      for (const verdict of AI_VERDICTS) {
        expect(isAiVerdict(verdict)).toBe(true);
      }
      expect(isAiVerdict('safe')).toBe(false);
      expect(isAiVerdict('blocked')).toBe(false);
    });

    it('validates AiProviderType values correctly', () => {
      for (const provider of AI_PROVIDER_TYPES) {
        expect(isAiProviderType(provider)).toBe(true);
      }
      expect(isAiProviderType('claude')).toBe(false);
    });

    it('validates SynthesisTarget values correctly', () => {
      for (const target of SYNTHESIS_TARGETS) {
        expect(isSynthesisTarget(target)).toBe(true);
      }
      expect(isSynthesisTarget('bind9')).toBe(false);
    });

    it('validates DomainVerdict values correctly', () => {
      for (const verdict of DOMAIN_VERDICTS) {
        expect(isDomainVerdict(verdict)).toBe(true);
      }
      expect(isDomainVerdict('clean')).toBe(false);
    });

    it('validates InfraKind values correctly', () => {
      for (const kind of INFRA_KINDS) {
        expect(isInfraKind(kind)).toBe(true);
      }
      expect(isInfraKind('satellite')).toBe(false);
    });

    it('validates AntiAdblockProviderId values correctly', () => {
      for (const prov of ANTI_ADBLOCK_PROVIDERS) {
        expect(isAntiAdblockProviderId(prov)).toBe(true);
      }
      expect(isAntiAdblockProviderId('unknown-blocker')).toBe(false);
    });
  });

  describe('Structural Interface Type Guards', () => {
    it('validates a valid AiScanResult', () => {
      const valid = createDefaultScanResult('example.com', {
        confidence: 95,
        verdict: 'clean',
        category: 'Clean',
        riskLevel: 'none',
      });
      expect(isAiScanResult(valid)).toBe(true);
      expect(isAiScanResult({})).toBe(false);
      expect(isAiScanResult(null)).toBe(false);
      expect(isAiScanResult({ ...valid, verdict: 'not-a-verdict' })).toBe(false);
    });

    it('validates a valid MiniAiPrediction', () => {
      const pred = createDefaultMiniAiPrediction({
        confidence: 88,
        verdict: 'ad_server',
        category: 'Advertising',
        riskLevel: 'high',
      });
      expect(isMiniAiPrediction(pred)).toBe(true);
      expect(isMiniAiPrediction(null)).toBe(false);
      expect(isMiniAiPrediction({ ...pred, classProbabilities: null })).toBe(false);
    });

    it('validates a valid DomainEvaluationResult', () => {
      const evalRes = createDefaultDomainEvaluationResult('ad.com', {
        verdict: 'blocked',
      });
      expect(isDomainEvaluationResult(evalRes)).toBe(true);
      expect(isDomainEvaluationResult(null)).toBe(false);
    });

    it('validates a valid CompactionResult', () => {
      const compaction = {
        originalCount: 10,
        compactedCount: 3,
        compactedRules: ['||parent.com^'],
        savingsPercent: 70,
        collapsedGroups: [{ parentDomain: 'parent.com', subdomains: ['s1.parent.com'], rule: '||parent.com^' }],
      };
      expect(isCompactionResult(compaction)).toBe(true);
      expect(isCompactionResult({ originalCount: '10' })).toBe(false);
    });
  });

  describe('Normalization & Sanitization Helpers', () => {
    it('normalizes various input representations of verdicts', () => {
      expect(normalizeVerdict('clean')).toBe('clean');
      expect(normalizeVerdict('Safe')).toBe('clean');
      expect(normalizeVerdict('ALLOW')).toBe('clean');
      expect(normalizeVerdict('ad')).toBe('ad_server');
      expect(normalizeVerdict('advertising')).toBe('ad_server');
      expect(normalizeVerdict('tracker')).toBe('tracker');
      expect(normalizeVerdict('telemetry')).toBe('tracker');
      expect(normalizeVerdict('phishing')).toBe('malicious');
      expect(normalizeVerdict('malware')).toBe('malicious');
      expect(normalizeVerdict('gibberish', 'suspicious')).toBe('suspicious');
    });

    it('normalizes various input representations of threat categories', () => {
      expect(normalizeThreatCategory('Advertising')).toBe('Advertising');
      expect(normalizeThreatCategory('adserver')).toBe('Advertising');
      expect(normalizeThreatCategory('telemetry')).toBe('Telemetry/Analytics');
      expect(normalizeThreatCategory('phishing-hub')).toBe('Malware/Phishing');
      expect(normalizeThreatCategory('cname-cloak')).toBe('CNAME Cloaking');
      expect(normalizeThreatCategory('safe')).toBe('Clean');
      expect(normalizeThreatCategory('unknown-noise')).toBe('Unknown');
    });

    it('normalizes risk levels safely', () => {
      expect(normalizeRiskLevel('critical')).toBe('critical');
      expect(normalizeRiskLevel('CRITICAL')).toBe('critical');
      expect(normalizeRiskLevel('high')).toBe('high');
      expect(normalizeRiskLevel('medium')).toBe('medium');
      expect(normalizeRiskLevel('none')).toBe('none');
      expect(normalizeRiskLevel('invalid', 'low')).toBe('low');
    });

    it('clamps confidence between 0 and 100 with bounds checking', () => {
      expect(clampConfidence(50)).toBe(50);
      expect(clampConfidence(150)).toBe(100);
      expect(clampConfidence(-20)).toBe(0);
      expect(clampConfidence(88.7)).toBe(89);
      expect(clampConfidence(NaN, 25)).toBe(25);
      expect(clampConfidence(Infinity, 0)).toBe(0);
      expect(clampConfidence('not a number', 50)).toBe(50);
    });
  });

  describe('Safe Default Factory Constructors', () => {
    it('creates structurally complete default scan result', () => {
      const res = createDefaultScanResult('example.com');
      expect(res.domain).toBe('example.com');
      expect(res.target).toBe('example.com');
      expect(res.verdict).toBe('clean');
      expect(res.category).toBe('Clean');
      expect(res.confidence).toBe(0);
      expect(res.riskLevel).toBe('none');
      expect(Array.isArray(res.reasons)).toBe(true);
      expect(Array.isArray(res.cnames)).toBe(true);
      expect(Array.isArray(res.resolvedIps)).toBe(true);
      expect(Array.isArray(res.generatedRules)).toBe(true);
      expect(res.timestamp).toBeDefined();
    });

    it('creates structurally complete default MiniAi prediction', () => {
      const pred = createDefaultMiniAiPrediction();
      expect(pred.verdict).toBe('clean');
      expect(pred.category).toBe('Clean');
      expect(pred.classProbabilities.Clean).toBe(1.0);
      expect(pred.classProbabilities.Advertising).toBe(0);
      expect(Array.isArray(pred.topContributions)).toBe(true);
      expect(Array.isArray(pred.reasons)).toBe(true);
    });
  });
});
