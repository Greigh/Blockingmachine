/**
 * The triage display layer.
 *
 * The cascade's own module is tested where it lives; what is tested here is the *reading* of it —
 * which bucket a record is in, what the chip says, and above all what is shown when a result carries
 * no cascade record at all. That last case is the one worth pinning hardest: a defaulted ambiguity of
 * zero would have turned "the cascade was not running" into "the cascade decided this instantly".
 */

import { describe, test, expect } from '@jest/globals';
import { DEFAULT_TRIAGE_OPTIONS } from '@blockingmachine/core';
import type { TriageOutcomeSummary } from '../types';
import {
  GUARD_REASON_MARKER,
  TRIAGE_AMBIGUITY_BAR,
  TRIAGE_BUCKET_META,
  ambiguityTone,
  formatAmbiguity,
  formatTriageBucketSummary,
  summarizeTriageBuckets,
  triageBucketOf,
  triageBucketOfResult,
  triageChipLabel,
  triageChipTitle,
  triageExplanationLines,
  triageSignalCodes,
  wasClearedByGuard,
} from '../triageDisplay';

function outcome(overrides: Partial<TriageOutcomeSummary> = {}): TriageOutcomeSummary {
  return {
    action: 'resolve-locally',
    ambiguity: 0.1,
    signals: [],
    explanations: [],
    source: 'local',
    contradicted: false,
    escalationFailed: false,
    ...overrides,
  };
}

describe('triage bucket assignment', () => {
  test('reads the four outcomes off the record', () => {
    expect(triageBucketOf(outcome({ action: 'resolve-locally' }))).toBe('screened-locally');
    expect(triageBucketOf(outcome({ action: 'escalate', source: 'escalated' }))).toBe('escalated');
    expect(triageBucketOf(outcome({ action: 'deferred' }))).toBe('deferred');
    expect(triageBucketOf(outcome({ action: 'escalate', source: 'contested' }))).toBe('contested');
  });

  test('contested outranks escalated, because both are true and the disagreement matters more', () => {
    // A contested verdict was escalated — the model *was* asked. Presenting it as "escalated"
    // would bury the one case where the shipped evidence outranked the model.
    expect(
      triageBucketOf(outcome({ action: 'escalate', source: 'contested', contradicted: true })),
    ).toBe('contested');

    // The order is fixed rather than incidental, so an impossible pairing resolves the same way
    // instead of flipping with a refactor.
    expect(triageBucketOf(outcome({ action: 'deferred', source: 'contested' }))).toBe('contested');
  });

  test('a missing or malformed record is untracked, never a defaulted outcome', () => {
    expect(triageBucketOf(undefined)).toBe('untracked');
    expect(triageBucketOf(null)).toBe('untracked');
    expect(triageBucketOf('nonsense' as unknown as TriageOutcomeSummary)).toBe('untracked');
    expect(triageBucketOf({} as TriageOutcomeSummary)).toBe('untracked');
    // An action this build does not know is not silently filed as "screened locally".
    expect(
      triageBucketOf({ action: 'something-else', source: 'local' } as unknown as TriageOutcomeSummary),
    ).toBe('untracked');
  });

  test('reads the record off a whole result defensively', () => {
    expect(triageBucketOfResult({ triage: outcome({ action: 'escalate', source: 'escalated' }) })).toBe(
      'escalated',
    );
    expect(triageBucketOfResult({})).toBe('untracked');
    expect(triageBucketOfResult(null)).toBe('untracked');
    expect(triageBucketOfResult(undefined)).toBe('untracked');
  });
});

describe('ambiguity score', () => {
  test('is rendered as a whole percent, and only when it was actually recorded', () => {
    expect(formatAmbiguity(0)).toBe('0%');
    expect(formatAmbiguity(0.42)).toBe('42%');
    expect(formatAmbiguity(0.995)).toBe('100%');
    expect(formatAmbiguity(1)).toBe('100%');
    // Out-of-range values are clamped rather than shown as 140%.
    expect(formatAmbiguity(1.4)).toBe('100%');
    expect(formatAmbiguity(-1)).toBe('0%');

    // The distinction that matters: unscored is not the same as scored-zero.
    expect(formatAmbiguity(undefined)).toBeNull();
    expect(formatAmbiguity(null)).toBeNull();
    expect(formatAmbiguity(Number.NaN)).toBeNull();
    expect(formatAmbiguity('0.4' as unknown as number)).toBeNull();
  });

  test('bands the score against the same bar the engine escalates on', () => {
    expect(ambiguityTone(0)).toBe('low');
    expect(ambiguityTone(0.24)).toBe('low');
    expect(ambiguityTone(0.25)).toBe('medium');
    expect(ambiguityTone(0.49)).toBe('medium');
    expect(ambiguityTone(0.5)).toBe('high');
    expect(ambiguityTone(0.9)).toBe('high');
    expect(ambiguityTone(undefined)).toBe('unknown');
    expect(ambiguityTone(Number.NaN)).toBe('unknown');
  });

  test('the displayed bar is the engine’s own escalation bar, not a copy that can drift', () => {
    // The renderer cannot import the engine's values without pulling Node modules into the bundle,
    // so the constant is restated there — and pinned here against the engine's default, so moving
    // the escalation bar fails this test instead of quietly mislabelling every row.
    expect(TRIAGE_AMBIGUITY_BAR).toBe(DEFAULT_TRIAGE_OPTIONS.minAmbiguity);
  });
});

describe('chip text and tooltip', () => {
  test('names each bucket in one word', () => {
    expect(triageChipLabel(outcome({ action: 'resolve-locally' }))).toBe('SCREENED');
    expect(triageChipLabel(outcome({ action: 'escalate', source: 'escalated' }))).toBe('ESCALATED');
    expect(triageChipLabel(outcome({ action: 'deferred' }))).toBe('DEFERRED');
    expect(triageChipLabel(outcome({ action: 'escalate', source: 'contested' }))).toBe('CONTESTED');
    expect(triageChipLabel(undefined)).toBe('');
  });

  test('spells out a failed escalation instead of claiming the model confirmed the verdict', () => {
    const failed = outcome({ action: 'escalate', source: 'local', escalationFailed: true });
    expect(triageChipLabel(failed)).toBe('ESCALATED (FAILED)');
    expect(triageChipTitle(failed)).toContain('failed');
    expect(triageChipTitle(failed)).toContain('embedded classifier');
    // The bucket is still "escalated" — an attempt was made — it is only the label that differs.
    expect(triageBucketOf(failed)).toBe('escalated');
  });

  test('names the model, and claims no agreement it was never told', () => {
    const title = triageChipTitle(
      outcome({ action: 'escalate', source: 'escalated', model: 'llama3.2' }),
    );
    expect(title).toContain('llama3.2');
    expect(title).toContain('verdict was applied');
    // `TriageOutcomeSummary` records the escalation, not whether the two verdicts matched — so the
    // chip must not say "confirmed", which would be a fact the engine never put on the result.
    expect(title).not.toContain('agreed');
    expect(title).not.toContain('confirmed');

    // With no model named the sentence still reads, rather than saying "escalated to undefined".
    expect(triageChipTitle(outcome({ action: 'escalate', source: 'escalated' }))).not.toContain(
      'undefined',
    );
  });

  test('an escalation whose recommendation was not applied says so', () => {
    // Defensive: the engine only sets `contradicted` alongside `source: 'contested'` today, but the
    // field is on the record, so a combination it does produce later must not read as applied.
    const title = triageChipTitle(
      outcome({ action: 'escalate', source: 'escalated', contradicted: true }),
    );
    expect(title).toContain('not applied');
    expect(title).toContain('local verdict stands');
  });

  test('the contested tooltip says the block was kept, which is the reason the token exists', () => {
    const title = triageChipTitle(
      outcome({ action: 'escalate', source: 'contested', contradicted: true, model: 'gpt-4o-mini' }),
    );
    expect(title).toContain('kept');
    expect(title).toContain('name-based evidence');
  });

  test('deferred says the local verdict stands, and untracked says there is no record', () => {
    expect(triageChipTitle(outcome({ action: 'deferred' }))).toContain('budget');
    expect(triageChipTitle(outcome({ action: 'deferred' }))).toContain('local verdict stands');
    expect(triageChipTitle(undefined)).toContain('No cascade record');
  });

  test('carries the engine’s own signal explanations and codes, filtered and never invented', () => {
    const record = outcome({
      signals: ['near-tie', '', 'tentative', 7 as unknown as string],
      explanations: ['Top two classes are within 4.0 points', '', null as unknown as string],
    });
    expect(triageExplanationLines(record)).toEqual(['Top two classes are within 4.0 points']);
    expect(triageSignalCodes(record)).toEqual(['near-tie', 'tentative']);
    expect(triageExplanationLines(undefined)).toEqual([]);
    expect(triageSignalCodes(undefined)).toEqual([]);
  });
});

describe('list summary', () => {
  const results = [
    ...Array.from({ length: 402 }, () => ({ triage: outcome({ action: 'resolve-locally' }) })),
    ...Array.from({ length: 12 }, (_, i) =>
      ({ triage: outcome({ action: 'escalate', source: 'escalated', ambiguity: 0.6 + i / 100 }) })),
    { triage: outcome({ action: 'escalate', source: 'contested', ambiguity: 0.61 }) },
    ...Array.from({ length: 2 }, () => ({ triage: outcome({ action: 'deferred', ambiguity: 0.7 }) })),
  ];

  test('counts every result into exactly one bucket', () => {
    const summary = summarizeTriageBuckets(results);
    expect(summary.total).toBe(417);
    expect(summary.tracked).toBe(417);
    expect(summary.tallies.find((t) => t.bucket === 'screened-locally')?.count).toBe(402);
    expect(summary.tallies.find((t) => t.bucket === 'escalated')?.count).toBe(12);
    expect(summary.tallies.find((t) => t.bucket === 'contested')?.count).toBe(1);
    expect(summary.tallies.find((t) => t.bucket === 'deferred')?.count).toBe(2);
    // Buckets are exclusive, so the tally total is the input length — nothing counted twice,
    // nothing dropped.
    expect(summary.tallies.reduce((sum, tally) => sum + tally.count, 0)).toBe(results.length);
    // Empty buckets are omitted rather than shown as a zero, and untracked is absent here.
    expect(summary.tallies).toHaveLength(4);
  });

  test('a contested verdict counts as the model call it was', () => {
    const summary = summarizeTriageBuckets(results);
    expect(summary.escalationRate).toBeCloseTo(13 / 417, 6);
  });

  test('reports coverage honestly when only part of the list was screened', () => {
    const mixed = [{ triage: outcome({ action: 'resolve-locally' }) }, {}, null, undefined];
    const summary = summarizeTriageBuckets(mixed);
    expect(summary.total).toBe(4);
    expect(summary.tracked).toBe(1);
    expect(summary.clearedByGuard).toBe(0);
    expect(summary.tallies.find((t) => t.bucket === 'untracked')?.count).toBe(3);
    const line = formatTriageBucketSummary(mixed);
    expect(line).toContain('3 without a cascade record');
  });

  // A guard-cleared domain and a cascade-off domain look identical on the result — both clean, both
  // with no cascade record — and mean opposite things: one was skipped on purpose, the other never
  // reached the cascade. Measured against the real service (provider `mini-ai`, cascade enabled, no
  // network): `localhost`, `telemetry.vendor.example` and `cdn-magiclinks.trackonomics.net` all come
  // back clean with no triage record and this sentence in `reasons`.
  describe('the false-positive guard', () => {
    const cleared = {
      verdict: 'clean',
      reasons: ['Product status, API, CDN, or update endpoint (Protected by False Positive Guard)'],
    };

    test('is recognised by the sentence core writes', () => {
      expect(wasClearedByGuard(cleared)).toBe(true);
    });

    test('is recognised by the guard record, which is what core writes now', () => {
      // The field is authoritative and needs no prose: this result has no marker in `reasons`.
      expect(
        wasClearedByGuard({
          verdict: 'clean',
          reasons: ['Active Directory or enterprise infrastructure endpoint'],
          falsePositiveGuard: { cleared: true, reason: 'Product status, API, CDN, or update endpoint' },
        }),
      ).toBe(true);
    });

    test('is not read off a record that says the guard did not clear it', () => {
      expect(
        wasClearedByGuard({ verdict: 'clean', falsePositiveGuard: { cleared: false } }),
      ).toBe(false);
    });

    test('refuses a malformed record rather than guessing', () => {
      // Every one of these would be read as a cleared domain by a lenient check, and the count they
      // feed is shown to the user as fact.
      for (const falsePositiveGuard of [
        { cleared: 'yes' },
        { cleared: 1 },
        { reason: 'Product status, API, CDN, or update endpoint' },
        {},
        null,
        'cleared',
        7,
      ]) {
        expect(
          wasClearedByGuard({ verdict: 'clean', falsePositiveGuard } as never),
        ).toBe(false);
      }
    });

    test('the record never survives a screened or non-clean result', () => {
      // A guarded result is clean with no cascade record by construction; either one alongside the
      // record is a contradiction, and the screened reading wins.
      expect(
        wasClearedByGuard({
          verdict: 'clean',
          triage: outcome(),
          falsePositiveGuard: { cleared: true },
        }),
      ).toBe(false);
      expect(
        wasClearedByGuard({ verdict: 'tracker', falsePositiveGuard: { cleared: true } }),
      ).toBe(false);
    });

    test('falls back to the marker for records written before the field existed', () => {
      const summary = summarizeTriageBuckets([cleared]);
      expect(summary.clearedByGuard).toBe(1);
      const withField = summarizeTriageBuckets([
        { verdict: 'clean', falsePositiveGuard: { cleared: true } },
      ]);
      expect(withField.clearedByGuard).toBe(1);
    });

    test('is not inferred from a clean verdict alone', () => {
      expect(wasClearedByGuard({ verdict: 'clean', reasons: ['Clean verdict kept locally'] })).toBe(
        false,
      );
      expect(wasClearedByGuard({ verdict: 'clean' })).toBe(false);
      expect(wasClearedByGuard({ verdict: 'clean', reasons: 'not-an-array' })).toBe(false);
      // The marker on a non-clean verdict is a different fact than "cleared without screening".
      expect(
        wasClearedByGuard({ verdict: 'tracker', reasons: [GUARD_REASON_MARKER] }),
      ).toBe(false);
      // A record means the cascade ran, whatever the reasons say.
      expect(
        wasClearedByGuard({ verdict: 'clean', reasons: [GUARD_REASON_MARKER], triage: outcome() }),
      ).toBe(false);
      expect(wasClearedByGuard(null)).toBe(false);
      expect(wasClearedByGuard(undefined)).toBe(false);
    });

    test('splits the untracked count by cause, exhaustively', () => {
      const list = [cleared, { triage: outcome({ action: 'escalate' }) }, {}, null];
      const summary = summarizeTriageBuckets(list);
      expect(summary.clearedByGuard).toBe(1);
      const line = formatTriageBucketSummary(list);
      expect(line).toContain('1 cleared before screening');
      expect(line).toContain('2 without a cascade record');
      // Nothing lost in the split: guard-cleared plus unrecorded is the whole untracked count.
      expect(summary.total - summary.tracked).toBe(3);
      expect(summary.clearedByGuard + 2).toBe(summary.total - summary.tracked);
    });

    test('leaves the plain unrecorded wording when the guard cleared nothing', () => {
      const line = formatTriageBucketSummary([{ triage: outcome() }, {}]);
      expect(line).toContain('1 without a cascade record');
      expect(line).not.toContain('cleared before screening');
    });
  });

  test('says nothing at all when no result carries a cascade record', () => {
    // The failure this prevents: a summary reading "0 screened locally" for a list the cascade
    // never saw, which reads as a working cascade that found nothing.
    expect(formatTriageBucketSummary([])).toBeNull();
    expect(formatTriageBucketSummary(undefined)).toBeNull();
    expect(formatTriageBucketSummary(null)).toBeNull();
    expect(formatTriageBucketSummary([{}, { triage: undefined }])).toBeNull();
  });

  test('writes the line the header shows, with zero contested and deferred omitted', () => {
    const line = formatTriageBucketSummary(results);
    expect(line).toBe(
      [
        '402 screened locally',
        '12 escalated',
        '1 contested',
        '2 deferred',
        '13 model calls (3.1%)',
      ].join(' \u00b7 '),
    );

    const quiet = [{ triage: outcome({ action: 'resolve-locally' }) }];
    expect(formatTriageBucketSummary(quiet)).toBe(
      ['1 screened locally', '0 escalated', '0 model calls (0.0%)'].join(' \u00b7 '),
    );

    // One call is "1 model call", not "1 model calls".
    expect(
      formatTriageBucketSummary([
        { triage: outcome({ action: 'resolve-locally' }) },
        { triage: outcome({ action: 'escalate', source: 'escalated' }) },
      ]),
    ).toContain('1 model call (50.0%)');
  });

  test('tolerates junk without inventing a bucket for it', () => {
    const summary = summarizeTriageBuckets('nope' as unknown as never[]);
    expect(summary.total).toBe(0);
    expect(summary.tallies).toEqual([]);
    expect(summary.escalationRate).toBe(0);
  });

  test('every bucket the summary can name has display text', () => {
    for (const [bucket, meta] of Object.entries(TRIAGE_BUCKET_META)) {
      expect(meta.label.trim().length).toBeGreaterThan(0);
      expect(meta.description.trim().length).toBeGreaterThan(0);
      if (bucket !== 'untracked') expect(meta.short.trim().length).toBeGreaterThan(0);
    }
  });
});
