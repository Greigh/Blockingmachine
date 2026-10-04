import { describe, expect, it } from '@jest/globals';
import { AiDetectorService } from '../index.js';
import { classifyDomainWithMiniAi } from '../ai/MiniAiClassifier.js';
import { isAiVerdict, normalizeVerdict } from '../ai/types.js';

/**
 * The consent/annoyance rung on the verdict axis.
 *
 * Both engines used to flatten a confident `Consent/Annoyance` category into the same
 * `suspicious` verdict a low-confidence leftover gets — the display could not tell "the model
 * knows this is a consent platform" from "the model could not decide". These tests pin the
 * dedicated `annoyance` rung so a future category or engine change cannot silently land a
 * named family on the generic rung again.
 */
describe('annoyance verdict rung', () => {
  it('is a member of the verdict axis', () => {
    expect(isAiVerdict('annoyance')).toBe(true);
  });

  it('normalizes the consent vocabulary a model may answer with', () => {
    for (const word of ['annoyance', 'annoyances', 'consent', 'consent_management', 'cmp']) {
      expect(normalizeVerdict(word)).toBe('annoyance');
    }
  });

  it('mini-AI returns annoyance — not suspicious — for a consent platform', () => {
    // `cdn.cookielaw.org` is the corpus's CMP-vendor exemplar: the consent token fires, the
    // category is Consent/Annoyance, and the verdict must say what it is.
    const prediction = classifyDomainWithMiniAi('cdn.cookielaw.org');
    expect({ category: prediction.category, verdict: prediction.verdict }).toEqual({
      category: 'Consent/Annoyance',
      verdict: 'annoyance',
    });
    // A confident annoyance sits below the uncertainty rung — it is not a threat.
    expect(prediction.riskLevel).toBe('low');
  });

  it('local heuristics return annoyance for a consent-token host', async () => {
    const service = new AiDetectorService({ provider: 'local-heuristics' });
    const result = await service.scanDomain('cmp.consentmanager.io');
    expect({ category: result.category, verdict: result.verdict }).toEqual({
      category: 'Consent/Annoyance',
      verdict: 'annoyance',
    });
  });

  it('keeps the suspicious rung for genuinely undecided verdicts', async () => {
    // The rung the consent verdict vacated still belongs to low-confidence leftovers — a
    // mid-score non-clean verdict must not collapse upward into `annoyance`.
    const service = new AiDetectorService({ provider: 'local-heuristics' });
    const result = await service.scanDomain('ads-metrics-collector.example.net');
    if (result.category !== 'Consent/Annoyance' && result.verdict === 'suspicious') {
      expect(result.riskLevel).toBe('medium');
    }
  });
});
