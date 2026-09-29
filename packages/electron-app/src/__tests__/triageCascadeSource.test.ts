/**
 * The seam between the engine and the results list.
 *
 * Every other test in this folder works from hand-built records, which cannot catch the failure this
 * one exists for: the display layer recognising something core no longer writes. The results list
 * claims to say *why* a row has no cascade record, and that claim rests on the exact sentence
 * `AiDetectorService.isSafeInfrastructure` puts on a guarded result plus the shape of the record the
 * cascade attaches.
 *
 * Run against the real service with `provider: 'mini-ai'`, so there is no network, no Ollama and no
 * clock: a guard-cleared domain returns before the screening pass, and a name-backed ad domain is
 * decided locally. Both are deterministic here.
 */

import { describe, test, expect } from '@jest/globals';
import { AiDetectorService } from '@blockingmachine/core';
import { GUARD_REASON_MARKER, formatTriageBucketSummary, wasClearedByGuard } from '../triageDisplay';

const cascadeOn = {
  provider: 'mini-ai' as const,
  cascade: { enabled: true, maxEscalations: 25 },
};

describe('core the results list reads', () => {
  test('the guard clears a domain before screening and says so', async () => {
    const service = new AiDetectorService({ provider: 'mini-ai' });

    for (const domain of [
      'localhost',
      'telemetry.vendor.example',
      'cdn-magiclinks.trackonomics.net',
    ]) {
      const result = await service.scanDomain(domain, cascadeOn);

      // The facts the display branches on: a clean result, no cascade record, and the guard's own
      // record of the skip. The prose marker is asserted too, because it is the fallback path for
      // records written before the field existed.
      expect(result.verdict).toBe('clean');
      expect(result.triage).toBeUndefined();
      expect(result.falsePositiveGuard?.cleared).toBe(true);
      expect(result.falsePositiveGuard?.reason).toBeTruthy();
      expect((result.reasons ?? []).join(' ')).toContain(GUARD_REASON_MARKER);
      expect(wasClearedByGuard(result)).toBe(true);
    }
  });

  test('a name-backed ad domain is screened locally and carries a record', async () => {
    const service = new AiDetectorService({ provider: 'mini-ai' });
    const result = await service.scanDomain('doubleclick.net', cascadeOn);

    expect(result.verdict).toBe('ad_server');
    expect(result.triage?.action).toBe('resolve-locally');
    expect(typeof result.triage?.ambiguity).toBe('number');
    expect(result.falsePositiveGuard).toBeUndefined();
    expect(wasClearedByGuard(result)).toBe(false);
  });

  test('the list summary separates the two kinds of missing record', async () => {
    const service = new AiDetectorService({ provider: 'mini-ai' });
    const results = [
      await service.scanDomain('doubleclick.net', cascadeOn),
      await service.scanDomain('telemetry.vendor.example', cascadeOn),
      // Same service, cascade off: no record, and no guard sentence either.
      await service.scanDomain('analytics.example.org', { provider: 'mini-ai' }),
    ];

    const line = formatTriageBucketSummary(results);
    expect(line).toContain('1 screened locally');
    expect(line).toContain('1 cleared before screening');
    expect(line).toContain('1 without a cascade record');
    // Guard-cleared domains were skipped deliberately, so they must not be counted as screened —
    // which is what a single "not screened" count would have done to them.
    expect(line).not.toContain('2 screened locally');
  });

  test('a guard-cleared domain is the only kind of untracked row a running cascade produces', async () => {
    const service = new AiDetectorService({ provider: 'mini-ai' });
    const results = [];
    for (const domain of ['doubleclick.net', 'telemetry.vendor.example', 'analytics.example.org']) {
      results.push(await service.scanDomain(domain, cascadeOn));
    }

    // With the cascade on, every row either carries a record or is guard-cleared, so the split's
    // second half is empty here — the guard is the whole explanation for a missing record.
    const line = formatTriageBucketSummary(results);
    expect(line).toContain('2 screened locally');
    expect(line).toContain('1 cleared before screening');
    expect(line).not.toContain('without a cascade record');
  });
});
