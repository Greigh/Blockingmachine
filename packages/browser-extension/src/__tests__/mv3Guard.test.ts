import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { Mv3Guard, MV3_LIMITS } from '../background/mv3Guard.js';

describe('Mv3Guard Compliance & Quota Guardian', () => {
  beforeEach(() => {
    (globalThis as any).chrome = {
      declarativeNetRequest: {
        MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES: 30000,
        getDynamicRules: (jest.fn() as any).mockResolvedValue([
          { id: 1, action: { type: 'block' }, condition: { urlFilter: '||bad.com^' } },
          { id: 2, action: { type: 'block' }, condition: { regexFilter: '^https?://ads\\.' } }
        ])
      }
    };
  });

  describe('isCompliantRule', () => {
    test('accepts valid ASCII domain patterns within 2048 chars', () => {
      expect(Mv3Guard.isCompliantRule('example.com')).toBe(true);
      expect(Mv3Guard.isCompliantRule('sub-1.tracker.analytics.co.uk')).toBe(true);
      expect(Mv3Guard.isCompliantRule('xn--bcher-kva.example')).toBe(true); // punycode
    });

    test('rejects rules exceeding maximum length', () => {
      const oversized = 'a'.repeat(MV3_LIMITS.MAX_URL_FILTER_LENGTH + 1);
      expect(Mv3Guard.isCompliantRule(oversized)).toBe(false);
    });

    test('rejects non-ASCII and whitespace characters', () => {
      expect(Mv3Guard.isCompliantRule('bad domain.com')).toBe(false);
      expect(Mv3Guard.isCompliantRule('аналитика.рф')).toBe(false); // non-ASCII Cyrillic
      expect(Mv3Guard.isCompliantRule('')).toBe(false);
    });
  });

  describe('boundCandidates', () => {
    test('bounds candidate list to quota cap and counts overflow', () => {
      const candidates: { pattern: string; priority: number }[] = [];
      for (let i = 0; i < 30000; i++) {
        candidates.push({ pattern: `tracker-${i}.com`, priority: 1 });
      }

      const { compliant, overflowCount } = Mv3Guard.boundCandidates(candidates, 28500);
      expect(compliant.length).toBe(28500);
      expect(overflowCount).toBe(1500);
    });

    test('skips non-compliant rules during candidate bounding', () => {
      const candidates = [
        { pattern: 'valid-tracker.com', priority: 1 },
        { pattern: 'invalid space.com', priority: 1 },
        { pattern: 'valid-analytics.io', priority: 1 }
      ];

      const { compliant, overflowCount } = Mv3Guard.boundCandidates(candidates, 100);
      expect(compliant.length).toBe(2);
      expect(compliant.map((c) => c.pattern)).toEqual(['valid-tracker.com', 'valid-analytics.io']);
      expect(overflowCount).toBe(0);
    });
  });

  describe('getQuotaStatus', () => {
    test('calculates accurate utilization and compliance status', async () => {
      const status = await Mv3Guard.getQuotaStatus();
      expect(status.dynamicRulesCount).toBe(2);
      expect(status.regexRulesCount).toBe(1);
      expect(status.maxDynamicRules).toBe(30000);
      expect(status.isWithinQuota).toBe(true);
      expect(status.headroomAvailable).toBe(29998);
      expect(status.utilizationPercent).toBeLessThan(1);
    });
  });
});
