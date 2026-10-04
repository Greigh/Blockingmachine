/**
 * The quarantine gate used to be spelled out twice — once per sweep — and both spellings were
 * wrong in opposite directions: the watchdog quarantined every flagged domain when the entropy
 * toggle was OFF (`if (!autoQuarantine) return true`), and the live radar quarantined every
 * flagged domain when it was ON (`autoQuarantine || ...`). `ai-threats.txt` filled with
 * single-signal conf-70 trackers — `windsurf-telemetry.codeium.com`, `beacon.example.com`,
 * `use1-turn.fpjs.io` — none of which could ever meet the feed's own published 85% bar.
 *
 * `shouldAutoQuarantine` is the one gate now; `revalidateQuarantine` re-judges the persisted
 * ledger against the current classifier so verdicts from an older engine stop being served.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { revalidateQuarantine, shouldAutoQuarantine, type QuarantineStoreLike } from '../quarantineGate';
import type { ThreatQuarantineItem } from '../types';

const item = (domain: string, source: ThreatQuarantineItem['source'] = 'sinkhole'): ThreatQuarantineItem => ({
  id: `id-${domain}`,
  domain,
  category: 'Telemetry/Analytics',
  verdict: 'suspicious',
  riskLevel: 'medium',
  confidence: 0.7,
  reasons: [],
  generatedRules: [],
  source,
  timestamp: '2026-01-01T00:00:00.000Z',
});

const result = (over: Partial<Parameters<typeof shouldAutoQuarantine>[0]> = {}) => ({
  verdict: 'suspicious' as const,
  confidence: 70,
  riskLevel: 'high' as const,
  isLikelyDga: false,
  entropy: 3.0,
  ...over,
});

describe('shouldAutoQuarantine', () => {
  test('clean verdicts never quarantine', () => {
    expect(shouldAutoQuarantine(result({ verdict: 'clean', confidence: 99 }), true)).toBe(false);
  });

  test('confident or critical verdicts quarantine regardless of the toggle', () => {
    expect(shouldAutoQuarantine(result({ confidence: 85 }), false)).toBe(true);
    expect(shouldAutoQuarantine(result({ confidence: 0.9 }), false)).toBe(true);
    expect(shouldAutoQuarantine(result({ confidence: 40, riskLevel: 'critical' }), false)).toBe(true);
  });

  test('a high-risk-but-low-confidence flag is a review lead, not a quarantine', () => {
    // This is the entry the old gates published: riskLevel high on a single keyword signal.
    expect(shouldAutoQuarantine(result({ confidence: 70 }), true)).toBe(false);
    expect(shouldAutoQuarantine(result({ confidence: 70 }), false)).toBe(false);
  });

  test('the toggle widens the gate only to entropy/DGA detections', () => {
    const dga = result({ confidence: 60, riskLevel: 'medium', isLikelyDga: true });
    expect(shouldAutoQuarantine(dga, true)).toBe(true);
    expect(shouldAutoQuarantine(dga, false)).toBe(false);
    const hot = result({ confidence: 60, riskLevel: 'medium', entropy: 4.5 });
    expect(shouldAutoQuarantine(hot, true)).toBe(true);
    expect(shouldAutoQuarantine(hot, false)).toBe(false);
  });
});

describe('revalidateQuarantine', () => {
  test('evicts entries the current classifier reports clean', async () => {
    const stored = [item('www.homedepot.com'), item('g00gle.com')];
    const store: QuarantineStoreLike = {
      get: () => stored.slice(),
      set: jest.fn(),
    };
    const scan = (d: string) =>
      Promise.resolve({ verdict: d === 'g00gle.com' ? ('malicious' as const) : ('clean' as const) });
    const log = jest.fn();
    const out = await revalidateQuarantine(store, scan, log);
    expect(out.cleared).toEqual(['www.homedepot.com']);
    expect(store.set).toHaveBeenCalledWith('aiThreatQuarantine', [item('g00gle.com')]);
  });

  test('keeps unjudgeable and inspector-sourced entries untouched', async () => {
    const stored = [item('unreachable.example'), item('user-parked.example', 'inspector')];
    const store: QuarantineStoreLike = {
      get: () => stored.slice(),
      set: jest.fn(),
    };
    const scan = () => Promise.reject(new Error('classifier offline'));
    const out = await revalidateQuarantine(store, scan, () => {});
    expect(out.cleared).toEqual([]);
    expect(out.kept).toBe(2);
    expect(store.set).not.toHaveBeenCalled();
  });
});
