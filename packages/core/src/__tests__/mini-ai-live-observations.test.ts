/**
 * Live-observation features — the daemon's resolver records and the browser's
 * first-party fan-out ledger reaching the *serving* classifier, not only the
 * shadow-training tail. The guarantees under test:
 *
 *  - v1/v2 callers see byte-identical features when no observation exists;
 *  - observed facts surface as scored contributions and human-readable reasons;
 *  - a context-free cached prediction is never served for an observed domain.
 */
import { describe, expect, it } from '@jest/globals';
import {
  AiDetectorService,
  classifyDomainWithMiniAi,
  extractDomainFeatures,
  isPublicHostname,
  MiniAiClassifier,
} from '../index.js';

describe('Mini-AI live observations', () => {
  describe('feature extraction', () => {
    it('zero-fills observation features when no observation exists (v1/v2 compat)', () => {
      const features = extractDomainFeatures('tracker.example.net');
      expect(features.obsCnameForeign).toBe(0);
      expect(features.obsBlockedBefore).toBe(0);
      expect(features.obsFanoutSites).toBe(0);
      expect(features.obsNxdomainRate).toBe(0);
    });

    it('maps a full observation into the feature vector', () => {
      const features = extractDomainFeatures('metrics.example.net', {
        observations: {
          dnsSeen: true,
          dnsBlocked: true,
          dnsCnameForeign: true,
          dnsNxdomainRate: 0.8,
          fanoutSites: 24,
          fanoutHits: 96,
        },
      });
      expect(features.obsBlockedBefore).toBe(1.0);
      expect(features.obsCnameForeign).toBe(1.0);
      expect(features.obsFanoutSites).toBe(1.0); // 24/12 saturates
      expect(features.obsNxdomainRate).toBe(0.8);
    });

    it('treats absent observation fields as zero, not NaN', () => {
      const features = extractDomainFeatures('metrics.example.net', {
        observations: { dnsSeen: true },
      });
      expect(features.obsBlockedBefore).toBe(0);
      expect(features.obsCnameForeign).toBe(0);
      expect(features.obsFanoutSites).toBe(0);
      expect(features.obsNxdomainRate).toBe(0);
    });
  });

  describe('verdict integration', () => {
    const classifier = new MiniAiClassifier();

    it('surfaces a prior BLOCKED resolver verdict as a scored contribution', () => {
      const prediction = classifier.classify('pixel.analytics.beacon.com', {
        observations: {
          dnsSeen: true,
          dnsBlocked: true,
          dnsCnameForeign: true,
        },
      });
      expect(prediction.category).not.toBe('Clean');
      expect(prediction.reasons.some((r) => /already blocks this name/i.test(r))).toBe(true);
      expect(prediction.reasons.some((r) => /CNAME hop leaving/i.test(r))).toBe(true);
      expect(
        prediction.topContributions.some((c) => c.name === 'Previously Blocked'),
      ).toBe(true);
      expect(
        prediction.topContributions.some((c) => c.name === 'Observed Foreign CNAME'),
      ).toBe(true);
    });

    it('bypasses the fast-path cache in both directions when observations exist', () => {
      // A reliably-flagged name, so the observed-blocked reason must exist to observe.
      const domain = 'pixel.analytics.beacon-cachepin.com';

      // Direction 1 — cache populated context-free, then observed call: a wrongly
      // served hit would replay the cold result verbatim, without the obs reason.
      const cold = classifier.classify(domain);
      const observed = classifier.classify(domain, {
        observations: { dnsSeen: true, dnsBlocked: true },
      });
      expect(cold.reasons.some((r) => /already blocks this name/i.test(r))).toBe(false);
      if (observed.category !== 'Clean') {
        expect(observed.reasons.some((r) => /already blocks this name/i.test(r))).toBe(true);
      }

      // Direction 2 — observed call first, then context-free: if the observed call
      // had been written under the context-free key, the cold call would inherit
      // its reasons. (Covered by `cold` above running first; this pins the same
      // leak on a fresh name where order is reversed.)
      const domain2 = 'pixel.analytics.beacon-cachepin2.com';
      classifier.classify(domain2, {
        observations: { dnsSeen: true, dnsBlocked: true },
      });
      const cold2 = classifier.classify(domain2);
      expect(cold2.reasons.some((r) => /already blocks this name/i.test(r))).toBe(false);
    });

    it('leaves clean infrastructure clean even when observed', () => {
      const prediction = classifyDomainWithMiniAi('ocsp.digicert.com', {
        observations: { dnsSeen: true, dnsBlocked: false, dnsNxdomainRate: 0 },
      });
      expect(['Clean', 'Unknown']).toContain(prediction.category);
    });
  });

  describe('AiDetectorService observation provider seam', () => {
    it('feeds the registered provider into the local screen', async () => {
      const service = new AiDetectorService({
        provider: 'mini-ai',
        skipDns: true,
        bypassCache: true,
      });
      const domain = 'pixel.analytics.beacon-seam.com';
      service.setObservationProvider((d) =>
        d === domain ? { dnsSeen: true, dnsBlocked: true } : undefined,
      );
      const result = await service.scanDomain(domain);
      expect(result.reasons.some((r) => /already blocks this name/i.test(r))).toBe(true);
    });

    it('scans identically to before when no provider is registered', async () => {
      const service = new AiDetectorService({
        provider: 'mini-ai',
        skipDns: true,
        bypassCache: true,
      });
      const result = await service.scanDomain('pixel.analytics.beacon-seam2.com');
      expect(result.reasons.some((r) => /already blocks this name/i.test(r))).toBe(false);
      expect(result.verdict).toBeTruthy();
    });
  });
});

describe('isPublicHostname — the observation-corpus boundary', () => {
  it('accepts ordinary public names', () => {
    expect(isPublicHostname('tracker.example.com')).toBe(true);
    expect(isPublicHostname('WWW.Edge-01.example.net.')).toBe(true);
  });

  it('rejects discovery, reverse-zone, and private suffixes', () => {
    for (const name of [
      '_airplay._tcp.local',
      'printer.localdomain',
      'nas.lan',
      'router.home',
      'dc01.corp',
      '4.3.2.1.in-addr.arpa',
      'a.b.ip6.arpa',
      'gw.home.arpa',
      'thing.invalid',
      'x.test',
      'x.example',
      'foo.localhost',
      'intranet.internal',
    ]) {
      expect(isPublicHostname(name)).toBe(false);
    }
  });

  it('rejects non-hostname shapes — single labels, IPs, junk', () => {
    expect(isPublicHostname('nas')).toBe(false);
    expect(isPublicHostname('localhost')).toBe(false);
    expect(isPublicHostname('8.8.8.8')).toBe(false);
    expect(isPublicHostname('')).toBe(false);
    expect(isPublicHostname("daniel's macbook pro._airplay._tcp.local")).toBe(false);
  });
});
