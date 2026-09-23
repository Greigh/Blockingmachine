import { describe, it, expect } from '@jest/globals';
import {
  calculateShannonEntropy,
  detectDgaPatterns,
  synthesizeRules,
  AiDetectorService,
} from '@blockingmachine/core';

describe('Electron App AI Radar Helpers & Workflows', () => {
  describe('Heuristic Detection Accuracy', () => {
    const service = new AiDetectorService({ provider: 'local-heuristics' });

    it('flags high-entropy programmatic bidding domains as ad servers', async () => {
      const res = await service.scanDomain('bidder-eu.rtb-ad-network.bid');
      expect(['ad_server', 'suspicious']).toContain(res.verdict);
      expect(res.category).toBe('Advertising');
      expect(res.generatedRules.length).toBeGreaterThan(0);
      expect(res.generatedRules[0]).toBe('||bidder-eu.rtb-ad-network.bid^');
    });

    it('flags analytics and telemetry beacons as trackers', async () => {
      const res = await service.scanDomain('telemetry.analytics-engine.com');
      expect(['tracker', 'ad_server', 'suspicious']).toContain(res.verdict);
      expect(res.category).toMatch(/Telemetry|Advertising/);
      expect(res.generatedRules).toContain('||telemetry.analytics-engine.com^$third-party');
    });

    it('flags DGA domain patterns with high entropy', () => {
      const entropy = calculateShannonEntropy('a9f1b4c8d2e6');
      expect(entropy).toBeGreaterThan(3.0);
      expect(entropy).toBeLessThanOrEqual(5.0); // Within standard 0.0 - 5.0 scale
      const dga = detectDgaPatterns('a9f1b4c8d2e6.adtracker.org');
      expect(dga.score).toBeGreaterThanOrEqual(40);
      expect(dga.reasons.length).toBeGreaterThan(0);
    });

    it('classifies entropy tiers across the 0.00 to 5.00 scale correctly', () => {
      const normalEntropy = calculateShannonEntropy('google');
      expect(normalEntropy).toBeLessThan(3.4); // Normal tier: 0.00 - 3.39

      const elevatedEntropy = calculateShannonEntropy('google-analytics');
      expect(elevatedEntropy).toBeGreaterThanOrEqual(3.4); // Elevated tier: 3.40 - 3.79
      expect(elevatedEntropy).toBeLessThan(3.8);

      const highEntropy = calculateShannonEntropy('a9f1b4c8d2e6');
      expect(highEntropy).toBeGreaterThanOrEqual(3.4); // High/DGA range
    });

    it('identifies clean domains correctly', async () => {
      const res = await service.scanDomain('github.com');
      expect(res.verdict).toBe('clean');
      expect(res.riskLevel).toBe('none');
      expect(res.generatedRules).toEqual([]);
    });
  });

  describe('AdGuard & Pi-hole Query Log Analysis Mapping', () => {
    const service = new AiDetectorService({ provider: 'local-heuristics' });

    it('filters and deduplicates raw DNS queries correctly', async () => {
      const rawQueries = [
        { domain: 'googleadservices.com', client: '192.168.1.50', blocked: false },
        { domain: 'googleadservices.com', client: '192.168.1.51', blocked: false },
        { domain: 'cdn.jsdelivr.net', client: '192.168.1.50', blocked: false },
        { domain: 'taboola.com', client: '192.168.1.10', blocked: false },
      ];

      const report = await service.scanQueryLog(rawQueries);
      expect(report.totalQueriesAnalyzed).toBe(3); // Deduplicated from 4 to 3
      expect(report.flaggedCount).toBeGreaterThanOrEqual(2);
      expect(report.cleanCount).toBeGreaterThanOrEqual(1);

      const adservices = report.results.find((r) => r.domain === 'googleadservices.com');
      expect(adservices?.verdict).toBe('ad_server');
      expect(adservices?.generatedRules[0]).toBe('||googleadservices.com^');
    });
  });

  describe('Rule Synthesis for Custom Rules Appending', () => {
    it('generates standard ABP and hosts formatted rules', () => {
      const rules = synthesizeRules({
        domain: 'bad-tracker.io',
        verdict: 'tracker',
        category: 'Telemetry/Analytics',
      });

      expect(rules).toContain('||bad-tracker.io^');
      expect(rules).toContain('||bad-tracker.io^$third-party');
      expect(rules).toContain('0.0.0.0 bad-tracker.io');
    });

    it('synthesizes exception rules for false positive whitelisting', () => {
      const service = new AiDetectorService({ provider: 'local-heuristics' });
      expect(service.isSafeInfrastructure('cdnjs.cloudflare.com')).toBe(true);
      expect(service.isSafeInfrastructure('appleid.apple.com')).toBe(true);
    });
  });

  describe('Threat Quarantine & History Ledger Helpers', () => {
    it('creates well-formed quarantine records from scan results', async () => {
      const service = new AiDetectorService({ provider: 'local-heuristics' });
      const scan = await service.scanDomain('adserver.traffic-exchange.com');

      const quarantineRecord = {
        id: 'test-1',
        domain: scan.domain,
        category: scan.category,
        verdict: scan.verdict,
        riskLevel: scan.riskLevel,
        confidence: scan.confidence,
        reasons: scan.reasons,
        generatedRules: scan.generatedRules,
        source: 'sinkhole' as const,
        timestamp: new Date().toISOString(),
        blocked: false,
      };

      expect(quarantineRecord.domain).toBe('adserver.traffic-exchange.com');
      expect(quarantineRecord.generatedRules.length).toBeGreaterThan(0);
      expect(quarantineRecord.source).toBe('sinkhole');
    });

    it('returns domain decomposition with label breakdown', async () => {
      const service = new AiDetectorService({ provider: 'local-heuristics' });
      const scan = await service.scanDomain('bidding.dsp-ad-network.bid');
      expect(scan.decomposition).toBeDefined();
      expect(scan.decomposition?.sld).toBe('dsp-ad-network');
      expect(scan.decomposition?.tld).toBe('bid');
      expect(scan.decomposition?.labelEntropies.length).toBeGreaterThanOrEqual(3);
    });
  });
});
