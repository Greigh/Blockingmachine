import { describe, test, expect } from '@jest/globals';
import type { ThreatQuarantineItem, AiScanResult } from '../types';

describe('AI Threat Quarantine Dynamic Feeds', () => {
  const sampleThreats: ThreatQuarantineItem[] = [
    {
      id: 'threat-1',
      domain: 'track-high-conf.com',
      category: 'Telemetry/Analytics',
      verdict: 'tracker',
      riskLevel: 'high',
      confidence: 95,
      reasons: ['High entropy score', 'Algorithmic domain name'],
      generatedRules: ['||track-high-conf.com^'],
      source: 'watchdog',
      timestamp: '2026-09-24T12:00:00.000Z',
    },
    {
      id: 'threat-2',
      domain: 'malware-dga.org',
      category: 'Malware/Phishing',
      verdict: 'malicious',
      riskLevel: 'critical',
      confidence: 0.92, // Fractional 0-1 scale test
      reasons: ['Zero-day DGA detected'],
      generatedRules: ['||malware-dga.org^'],
      source: 'sinkhole',
      timestamp: '2026-09-24T12:05:00.000Z',
    },
    {
      id: 'threat-3',
      domain: 'low-conf-suspicious.net',
      category: 'Advertising',
      verdict: 'suspicious',
      riskLevel: 'medium',
      confidence: 65, // Below 85% threshold
      reasons: ['Uncertain pattern'],
      generatedRules: ['||low-conf-suspicious.net^'],
      source: 'inspector',
      timestamp: '2026-09-24T12:10:00.000Z',
    },
    {
      id: 'threat-4',
      domain: 'track-high-conf.com', // Duplicate entry
      category: 'Telemetry/Analytics',
      verdict: 'tracker',
      riskLevel: 'high',
      confidence: 90,
      reasons: ['Duplicate scout sighting'],
      generatedRules: ['||track-high-conf.com^'],
      source: 'crawler',
      timestamp: '2026-09-24T12:15:00.000Z',
    },
  ];

  function filterHighConfidenceQuarantine(quarantine: ThreatQuarantineItem[]): string[] {
    const highConf = quarantine
      .filter((t) => {
        const conf = typeof t.confidence === 'number' ? (t.confidence > 1 ? t.confidence : t.confidence * 100) : 0;
        return conf >= 85 && Boolean(t.domain);
      })
      .map((t) => t.domain.trim().toLowerCase());
    return Array.from(new Set(highConf)).sort();
  }

  function formatDomainFeed(domains: string[]): string {
    const header = [
      '# Title: Blockingmachine AI Threat Feed (Domain List)',
      '# Confidence Threshold: >= 85%',
      '',
    ].join('\n');
    return domains.length > 0 ? `${header}${domains.join('\n')}\n` : `${header}# No active threats\n`;
  }

  function formatAbpFeed(domains: string[]): string {
    const header = [
      '! Title: Blockingmachine AI Threat Feed (ABP Format)',
      '! Confidence Threshold: >= 85%',
      '',
    ].join('\n');
    const rules = domains.map((d) => `||${d}^`);
    return rules.length > 0 ? `${header}${rules.join('\n')}\n` : `${header}! No active threats\n`;
  }

  test('filters and deduplicates only threats with confidence >= 85%', () => {
    const filtered = filterHighConfidenceQuarantine(sampleThreats);

    expect(filtered).toHaveLength(2);
    expect(filtered).toContain('track-high-conf.com');
    expect(filtered).toContain('malware-dga.org');
    expect(filtered).not.toContain('low-conf-suspicious.net');
  });

  test('formats domain list feed accurately for DNS sinkholes (/ai-threats.txt)', () => {
    const filtered = filterHighConfidenceQuarantine(sampleThreats);
    const feed = formatDomainFeed(filtered);

    expect(feed).toContain('# Title: Blockingmachine AI Threat Feed (Domain List)');
    expect(feed).toContain('malware-dga.org\n');
    expect(feed).toContain('track-high-conf.com\n');
    expect(feed).not.toContain('low-conf-suspicious.net');
    expect(feed).not.toContain('||');
  });

  test('formats ABP rule list feed accurately (/threats.txt)', () => {
    const filtered = filterHighConfidenceQuarantine(sampleThreats);
    const feed = formatAbpFeed(filtered);

    expect(feed).toContain('! Title: Blockingmachine AI Threat Feed (ABP Format)');
    expect(feed).toContain('||malware-dga.org^\n');
    expect(feed).toContain('||track-high-conf.com^\n');
    expect(feed).not.toContain('low-conf-suspicious.net');
  });

  test('correctly identifies zero-day DGA and high-entropy threats for autonomous quarantine', () => {
    const scanResults: AiScanResult[] = [
      {
        target: 'xkcd8934jkl23mno98.biz',
        domain: 'xkcd8934jkl23mno98.biz',
        verdict: 'malicious',
        confidence: 90,
        riskLevel: 'critical',
        category: 'Malware/Phishing',
        reasons: ['High Shannon entropy', 'Zero-day DGA generation detected'],
        entropy: 4.85,
        isLikelyDga: true,
        cnames: [],
        resolvedIps: ['198.51.100.1'],
        generatedRules: ['||xkcd8934jkl23mno98.biz^'],
        provider: 'local-heuristics',
        timestamp: '2026-09-24T12:00:00.000Z',
      },
      {
        target: 'standard-site.org',
        domain: 'standard-site.org',
        verdict: 'clean',
        confidence: 98,
        riskLevel: 'none',
        category: 'Clean',
        reasons: ['Known reputable domain'],
        entropy: 2.1,
        isLikelyDga: false,
        cnames: [],
        resolvedIps: ['93.184.216.34'],
        generatedRules: [],
        provider: 'local-heuristics',
        timestamp: '2026-09-24T12:00:00.000Z',
      },
    ];

    const autoQuarantine = true;
    const candidates = scanResults.filter((r) => {
      if (r.verdict === 'clean') return false;
      if (!autoQuarantine) return true;
      const conf = typeof r.confidence === 'number' ? (r.confidence > 1 ? r.confidence : r.confidence * 100) : 0;
      return r.isLikelyDga || (typeof r.entropy === 'number' && r.entropy > 4.2) || conf >= 85;
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].domain).toBe('xkcd8934jkl23mno98.biz');
    expect(candidates[0].isLikelyDga).toBe(true);
    expect(candidates[0].entropy).toBeGreaterThan(4.2);
  });
});
