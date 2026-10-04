/**
 * Triage cascade tests.
 *
 * Two halves, deliberately kept apart:
 *
 * 1. **Contract tests** pin the properties the architecture depends on — nothing is
 *    ever dropped, decisive evidence never spends budget, and a tiebreaker can never
 *    silently clear a target the local evidence defends.
 * 2. **Measurement tests** run the cascade over the classifiers' own evaluation
 *    corpora, so the escalation rate is a number this repo computes rather than a
 *    claim made in a README.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  DEFAULT_TRIAGE_OPTIONS,
  HIGH_PRECISION_FAMILIES,
  assessAmbiguity,
  mergeTriageVerdict,
  mergeTriageVerdicts,
  planTriage,
  summarizeTriage,
  type EscalationVerdict,
  type TriageCandidate,
  type TriageItem,
} from '../ai/triage.js';
import { AiDetectorService } from '../ai/AiDetectorService.js';
import { classifyDomainWithMiniAi } from '../ai/MiniAiClassifier.js';
import { classifyElementWithMiniAi, type ElementClass } from '../ai/elementClassifier.js';
import { EVAL_CORPUS } from '../ai/evalCorpus.js';
import type { ThreatCategory } from '../ai/types.js';
import { ELEMENT_EVAL_CORPUS, MUST_HIDE_CASES } from '../ai/elementEvalCorpus.js';

const candidate = (overrides: Partial<TriageCandidate> = {}): TriageCandidate => ({
  id: 'example.com',
  verdict: 'clean',
  confidence: 90,
  riskLevel: 'none',
  ...overrides,
});

// ─── Ambiguity signals ────────────────────────────────────────────────────────

describe('assessAmbiguity — signals', () => {
  it('flags a near tie between the top two classes', () => {
    const result = assessAmbiguity(
      candidate({
        verdict: 'suspicious',
        confidence: 52,
        classProbabilities: { Clean: 0.44, Advertising: 0.41 },
      }),
    );
    expect(result.signals.nearTie).toBe(true);
    expect(result.reasons).toContain('near-tie');
  });

  it('does not flag a near tie when the distribution is decisive', () => {
    const result = assessAmbiguity(
      candidate({
        verdict: 'ad_server',
        confidence: 93,
        classProbabilities: { Advertising: 0.93, Clean: 0.04 },
      }),
    );
    expect(result.signals.nearTie).toBe(false);
    expect(result.ambiguous).toBe(false);
  });

  it('flags an unsupported verdict — the model probability is the only support', () => {
    const result = assessAmbiguity(
      candidate({ verdict: 'tracker', confidence: 55, corroboration: 'lexical-only' }),
    );
    expect(result.signals.unsupported).toBe(true);
    expect(result.reasons).toContain('unsupported');
  });

  it('flags the classifier\'s own uncertain bucket', () => {
    const result = assessAmbiguity(candidate({ verdict: 'suspicious', confidence: 55 }));
    expect(result.signals.selfDoubt).toBe(true);
  });

  it('flags conflicting feature contributions', () => {
    const result = assessAmbiguity(
      candidate({
        verdict: 'suspicious',
        confidence: 55,
        topContributions: [
          { name: 'adToken', value: 1, weight: 1, impact: 'threat', description: '' },
          { name: 'benignToken', value: 1, weight: 1, impact: 'clean', description: '' },
        ],
      }),
    );
    expect(result.signals.conflicting).toBe(true);
    expect(result.reasons).toContain('conflicting-evidence');
  });

  it('does not flag conflict when one side clearly dominates', () => {
    const result = assessAmbiguity(
      candidate({
        verdict: 'suspicious',
        confidence: 55,
        topContributions: [
          { name: 'adToken', value: 1, weight: 1, impact: 'threat', description: '' },
          { name: 'benignToken', value: 0.1, weight: 1, impact: 'clean', description: '' },
        ],
      }),
    );
    expect(result.signals.conflicting).toBe(false);
  });

  it('flags a non-clean verdict resting on no evidence family at all', () => {
    const result = assessAmbiguity(candidate({ verdict: 'tracker', confidence: 55 }));
    expect(result.signals.noEvidence).toBe(true);
  });

  it('flags confidence inside the block/allow boundary band', () => {
    const result = assessAmbiguity(candidate({ verdict: 'ad_server', confidence: 62 }));
    expect(result.signals.boundary).toBe(true);
    expect(result.reasons).toContain('decision-boundary');
  });

  it('keeps ambiguity inside 0-1 for any input', () => {
    const everything = assessAmbiguity(
      candidate({
        verdict: 'suspicious',
        confidence: 65,
        corroboration: 'lexical-only',
        classProbabilities: { Clean: 0.5, Advertising: 0.49 },
        topContributions: [
          { name: 'a', value: 1, weight: 1, impact: 'threat', description: '' },
          { name: 'b', value: 1, weight: 1, impact: 'clean', description: '' },
        ],
      }),
    );
    expect(everything.ambiguity).toBeGreaterThan(0.9);
    expect(everything.ambiguity).toBeLessThanOrEqual(1);
  });

  it('survives a malformed candidate without throwing', () => {
    expect(() => assessAmbiguity({} as TriageCandidate)).not.toThrow();
    expect(() =>
      assessAmbiguity({ id: 'x', verdict: 'clean', confidence: NaN, riskLevel: 'none' }),
    ).not.toThrow();
    const result = assessAmbiguity({} as TriageCandidate);
    expect(result.ambiguity).toBe(0);
  });
});

// ─── Decisive evidence ────────────────────────────────────────────────────────

describe('assessAmbiguity — decisive evidence', () => {
  it('never escalates a non-clean verdict backed by name-based evidence', () => {
    const result = assessAmbiguity(
      candidate({
        verdict: 'tracker',
        confidence: 58,
        corroboration: 'corroborated',
        evidenceFamilies: ['known-network'],
        classProbabilities: { 'Telemetry/Analytics': 0.5, Clean: 0.48 },
      }),
    );
    expect(result.signals.highPrecision).toBe(true);
    expect(result.reasons).toContain('decisive-evidence');
    expect(result.ambiguity).toBe(0);
    expect(result.ambiguous).toBe(false);
  });

  it('treats every high-precision family as decisive on a non-clean verdict', () => {
    for (const family of HIGH_PRECISION_FAMILIES) {
      const result = assessAmbiguity(
        candidate({ verdict: 'ad_server', confidence: 56, evidenceFamilies: [family] }),
      );
      expect(result.signals.highPrecision).toBe(true);
      expect(result.ambiguous).toBe(false);
    }
  });

  it('escalates a clean verdict contradicted by name-based evidence, even with clean escalation off', () => {
    // Name-based evidence says tracker, the model says clean. That is a conflict rather
    // than an uncertainty — exactly the missed-block case — so it must not be
    // short-circuited by the decisive rule or by the clean-traffic policy.
    const result = assessAmbiguity(
      candidate({
        verdict: 'clean',
        confidence: 66,
        evidenceFamilies: ['cname-uncloak'],
        classProbabilities: { Clean: 0.52, 'CNAME Cloaking': 0.45 },
      }),
    );
    expect(result.reasons).toContain('contradiction');
    expect(result.ambiguous).toBe(true);
  });

  it('does not let decisive evidence override genuinely conflicting signals', () => {
    const result = assessAmbiguity(
      candidate({
        verdict: 'tracker',
        confidence: 65,
        evidenceFamilies: ['known-network'],
        topContributions: [
          { name: 'a', value: 1, weight: 1, impact: 'threat', description: '' },
          { name: 'b', value: 1, weight: 1, impact: 'clean', description: '' },
        ],
      }),
    );
    expect(result.reasons).not.toContain('decisive-evidence');
  });

  it('is the only way a contested verdict can happen, and it is reachable', () => {
    // `contested` needs three things at once: a non-clean verdict, high-precision evidence so the
    // merge defends the block, and an ambiguity still over the default bar so the candidate is
    // escalated at all. `conflicting` is what keeps `decisive` false; the near-tie and the
    // block/allow boundary band carry the score past the bar. Measured, not reasoned about: a
    // 51-domain sweep through the service produced no contested case, which is why this pins the
    // window rather than leaving it to the reader to infer that it exists.
    const contestedWindow = candidate({
      id: 'ambiguous-tracker.example',
      verdict: 'tracker',
      confidence: 60,
      riskLevel: 'medium',
      evidenceFamilies: ['known-network'],
      classProbabilities: { 'Telemetry/Analytics': 0.44, Clean: 0.4 },
      topContributions: [
        { name: 'a', value: 1, weight: 1, impact: 'threat', description: '' },
        { name: 'b', value: 1, weight: 1, impact: 'clean', description: '' },
      ],
    });

    const assessment = assessAmbiguity(contestedWindow);
    expect(assessment.signals.highPrecision).toBe(true);
    expect(assessment.reasons).toContain('conflicting-evidence');
    expect(assessment.reasons).not.toContain('decisive-evidence');
    expect(assessment.ambiguity).toBeGreaterThanOrEqual(DEFAULT_TRIAGE_OPTIONS.minAmbiguity);
    expect(assessment.ambiguous).toBe(true);

    // The escalation then recommends clearing the target, and the merge refuses.
    const merged = mergeTriageVerdict(contestedWindow, {
      verdict: 'clean',
      confidence: 91,
      riskLevel: 'none',
      model: 'test-model',
    });
    expect(merged.source).toBe('contested');
    expect(merged.contradicted).toBe(true);
    expect(merged.verdict).toBe('tracker');
  });
});

// ─── Clean-traffic policy ─────────────────────────────────────────────────────

describe('assessAmbiguity — clean traffic policy', () => {
  const uncertainClean = candidate({
    verdict: 'clean',
    confidence: 45,
    classProbabilities: { Clean: 0.46, Advertising: 0.38 },
  });

  it('resolves uncertain clean verdicts locally by default', () => {
    const result = assessAmbiguity(uncertainClean);
    expect(result.ambiguous).toBe(false);
    expect(result.reasons).toContain('kept-clean');
  });

  it('escalates uncertain clean verdicts when escalateClean is enabled', () => {
    const result = assessAmbiguity(uncertainClean, { escalateClean: true });
    expect(result.ambiguous).toBe(true);
  });

  it('never escalates a confident clean verdict even with escalateClean on', () => {
    const result = assessAmbiguity(
      candidate({
        verdict: 'clean',
        confidence: 95,
        classProbabilities: { Clean: 0.95, Advertising: 0.02 },
      }),
      { escalateClean: true },
    );
    expect(result.ambiguous).toBe(false);
  });

  it('ignores explicitly-undefined options instead of erasing the defaults', () => {
    // Forwarding an optional config field yields `{ minAmbiguity: undefined }`, which a
    // plain object spread would apply — making every comparison silently fail.
    const result = assessAmbiguity(
      candidate({ verdict: 'suspicious', confidence: 52, corroboration: 'lexical-only' }),
      { minAmbiguity: undefined, escalateClean: undefined },
    );
    expect(result.ambiguous).toBe(true);
    expect(DEFAULT_TRIAGE_OPTIONS.minAmbiguity).toBe(0.5);
  });
});

// ─── Planning: budget, ranking, and the no-drop invariant ─────────────────────

describe('planTriage', () => {
  const noise = (id: string, risk: TriageCandidate['riskLevel'] = 'medium'): TriageCandidate =>
    candidate({
      id,
      verdict: 'suspicious',
      confidence: 55,
      riskLevel: risk,
      corroboration: 'lexical-only',
      classProbabilities: { Clean: 0.5, Advertising: 0.48 },
    });

  it('never drops a candidate', () => {
    const plan = planTriage([noise('a'), candidate({ id: 'b' }), noise('c')], {
      maxEscalations: 1,
    });
    expect(plan.stats.screened).toBe(3);
    expect(plan.escalate.length + plan.resolvedLocally.length + plan.deferred.length).toBe(3);
    expect(plan.items).toHaveLength(3);
  });

  it('caps escalations at the budget and records the rest as deferred', () => {
    const plan = planTriage(
      [noise('a'), noise('b'), noise('c'), noise('d')],
      { maxEscalations: 2 },
    );
    expect(plan.escalate).toHaveLength(2);
    expect(plan.deferred).toHaveLength(2);
    expect(plan.stats.budgetRemaining).toBe(0);
    for (const item of plan.deferred) {
      // A deferred candidate keeps its local verdict; it is never left undecided.
      expect(item.local.verdict).toBe('suspicious');
    }
  });

  it('subtracts escalations already spent from the budget', () => {
    const plan = planTriage([noise('a'), noise('b'), noise('c')], {
      maxEscalations: 3,
      spentEscalations: 2,
    });
    expect(plan.escalate).toHaveLength(1);
    expect(plan.stats.budgetRemaining).toBe(0);
  });

  it('escalates the most ambiguous candidates first', () => {
    const veryAmbiguous = candidate({
      id: 'very',
      verdict: 'suspicious',
      confidence: 55,
      corroboration: 'lexical-only',
      classProbabilities: { Clean: 0.5, Advertising: 0.49 },
    });
    const mildlyAmbiguous = candidate({
      id: 'mildly',
      verdict: 'suspicious',
      confidence: 55,
    });
    const plan = planTriage([mildlyAmbiguous, veryAmbiguous], { maxEscalations: 1 });
    expect(plan.escalate[0].id).toBe('very');
  });

  it('marks the budget by position so duplicate ids cannot exceed the cap', () => {
    const plan = planTriage([noise('same'), noise('same'), noise('same')], {
      maxEscalations: 1,
    });
    expect(plan.escalate).toHaveLength(1);
    expect(plan.deferred).toHaveLength(2);
  });

  it('breaks equally-ambiguous ties toward the higher-stakes candidate', () => {
    const plan = planTriage([noise('low', 'low'), noise('critical', 'critical')], {
      maxEscalations: 1,
    });
    expect(plan.escalate[0].id).toBe('critical');
  });

  it('reports the model calls the exclusive-fork design would have made', () => {
    const plan = planTriage([noise('a'), noise('b'), candidate({ id: 'c' })], {
      maxEscalations: 25,
    });
    expect(plan.stats.forkLlmCalls).toBe(3);
    expect(plan.stats.llmCallsSaved).toBe(3 - plan.stats.escalated);
  });

  it('handles an empty batch', () => {
    const plan = planTriage([]);
    expect(plan.stats.screened).toBe(0);
    expect(plan.stats.escalationRate).toBe(0);
    expect(summarizeTriage(plan)).toContain('Screened 0');
  });

  it('produces a stable, order-independent escalation set', () => {
    const items = [noise('a'), noise('b'), noise('c')];
    const forward = planTriage(items, { maxEscalations: 2 }).escalate.map((i) => i.id);
    const backward = planTriage([...items].reverse(), { maxEscalations: 2 })
      .escalate.map((i) => i.id);
    expect(new Set(forward)).toEqual(new Set(backward));
  });

  it('summarizes the screening pass for a human', () => {
    const plan = planTriage([noise('a'), candidate({ id: 'b' })], { maxEscalations: 1 });
    const summary = summarizeTriage(plan);
    expect(summary).toContain('Screened 2');
    expect(summary).toContain('escalated 1');
    expect(summary).toContain('model calls avoided');
  });
});

// ─── Merge contract ───────────────────────────────────────────────────────────

describe('mergeTriageVerdict', () => {
  const localTracker = candidate({
    id: 'tracker.example',
    verdict: 'tracker',
    confidence: 55,
    riskLevel: 'medium',
    evidenceFamilies: ['known-network'],
  });

  const verdict = (overrides: Partial<EscalationVerdict> = {}): EscalationVerdict => ({
    verdict: 'tracker',
    confidence: 88,
    riskLevel: 'high',
    model: 'test-model',
    ...overrides,
  });

  it('keeps the higher confidence when both methods agree', () => {
    const merged = mergeTriageVerdict(localTracker, verdict());
    expect(merged.source).toBe('escalated');
    expect(merged.agreement).toBe(true);
    expect(merged.confidence).toBe(88);
  });

  it('refuses to let a tiebreaker clear name-based evidence', () => {
    const merged = mergeTriageVerdict(
      localTracker,
      verdict({ verdict: 'clean', confidence: 91, riskLevel: 'none' }),
    );
    expect(merged.verdict).toBe('tracker');
    expect(merged.source).toBe('contested');
    expect(merged.contradicted).toBe(true);
    expect(merged.reasons.join(' ')).toContain('name-based evidence');
  });

  it('refuses the same override when the verdict is merely corroborated', () => {
    const merged = mergeTriageVerdict(
      candidate({ id: 'x', verdict: 'ad_server', confidence: 60, corroboration: 'corroborated' }),
      verdict({ verdict: 'clean', confidence: 91 }),
    );
    expect(merged.verdict).toBe('ad_server');
    expect(merged.contradicted).toBe(true);
  });

  it('accepts a clearing verdict on a genuinely undecided candidate', () => {
    const merged = mergeTriageVerdict(
      candidate({ id: 'x', verdict: 'suspicious', confidence: 52 }),
      verdict({ verdict: 'clean', confidence: 80, riskLevel: 'none' }),
    );
    expect(merged.verdict).toBe('clean');
    expect(merged.source).toBe('escalated');
    expect(merged.contradicted).toBe(false);
    expect(merged.riskLevel).toBe('none');
  });

  it('accepts an escalation from the model on an undecided candidate', () => {
    const merged = mergeTriageVerdict(
      candidate({ id: 'x', verdict: 'suspicious', confidence: 52 }),
      verdict({ verdict: 'malicious', confidence: 85, riskLevel: 'critical' }),
    );
    expect(merged.verdict).toBe('malicious');
    expect(merged.riskLevel).toBe('critical');
  });

  it('degrades to the local verdict when the escalation fails', () => {
    const merged = mergeTriageVerdict(localTracker, null);
    expect(merged.verdict).toBe('tracker');
    expect(merged.source).toBe('local');
    expect(merged.escalationFailed).toBe(true);
    expect(merged.confidence).toBe(55);
  });

  it('treats a malformed model verdict as a failed escalation, not an error', () => {
    expect(mergeTriageVerdict(localTracker, {} as EscalationVerdict).escalationFailed).toBe(true);
    expect(
      mergeTriageVerdict(localTracker, { verdict: 5 } as unknown as EscalationVerdict)
        .escalationFailed,
    ).toBe(true);
  });

  it('merges a batch keyed either by Map or by plain object', () => {
    const items = planTriage(
      [
        candidate({
          id: 'a',
          verdict: 'suspicious',
          confidence: 52,
          corroboration: 'lexical-only',
          classProbabilities: { Clean: 0.5, Advertising: 0.49 },
        }),
      ],
      { maxEscalations: 1 },
    ).escalate;
    expect(items).toHaveLength(1);
    const byMap = mergeTriageVerdicts(items, new Map([['a', verdict({ verdict: 'ad_server' })]]));
    expect(byMap[0].verdict).toBe('ad_server');
    const byObject = mergeTriageVerdicts(items, { a: verdict({ verdict: 'ad_server' }) });
    expect(byObject[0].verdict).toBe('ad_server');
  });
});

// ─── Service integration: the fork becomes a cascade ──────────────────────────

describe('AiDetectorService cascade', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof jest.fn>;

  const modelReply = (payload: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  });

  const scan = (domain: string, config: Record<string, unknown>) =>
    new AiDetectorService({ provider: 'openai', apiKey: 'test-key', skipDns: true, ...config })
      .scanDomain(domain, { skipDns: true });

  beforeEach(() => {
    fetchMock = jest.fn(async () => modelReply({ verdict: 'clean', confidence: 90 }));
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  it('makes no model call when the local screen can defend the verdict', async () => {
    const result = await scan('doubleclick.net', { cascade: { enabled: true } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.triage?.action).toBe('resolve-locally');
    expect(result.triage?.source).toBe('local');
    expect(result.modelUsed).toContain('Mini-AI');
  });

  it('spends exactly one model call on an undecided candidate and records provenance', async () => {
    // The classifier reports this one as `suspicious` — its own uncertain bucket — so it
    // is exactly the candidate a cascade should hand on.
    const result = await scan('visualwebsiteoptimizer.com', {
      cascade: { enabled: true, minAmbiguity: 0, maxEscalations: 5 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.triage?.action).toBe('escalate');
    expect(result.triage?.source).toBe('escalated');
    expect(result.triage?.escalationFailed).toBe(false);
  });

  it('does not call the model when the budget is exhausted, and still returns a verdict', async () => {
    const result = await scan('visualwebsiteoptimizer.com', {
      cascade: { enabled: true, minAmbiguity: 0, maxEscalations: 0 },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.triage?.action).toBe('deferred');
    expect(result.verdict).toBeTruthy();
  });

  it('honours an already-spent session budget', async () => {
    const result = await scan('visualwebsiteoptimizer.com', {
      cascade: { enabled: true, minAmbiguity: 0, maxEscalations: 3, spentEscalations: 3 },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.triage?.action).toBe('deferred');
  });

  it('never spends budget on a verdict backed by name-based evidence, even at minAmbiguity 0', async () => {
    // The budget is available and the threshold says escalate — but the local verdict
    // rests on a curated network lookup, so a second opinion could only erode it.
    const result = await scan('doubleclick.net', {
      cascade: { enabled: true, minAmbiguity: 0, maxEscalations: 5 },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.triage?.action).toBe('resolve-locally');
    expect(result.triage?.signals).toContain('decisive-evidence');
    expect(result.verdict).not.toBe('clean');
  });

  it('degrades to the local verdict when the escalation transport fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    const result = await scan('visualwebsiteoptimizer.com', {
      cascade: { enabled: true, minAmbiguity: 0, maxEscalations: 5 },
    });

    expect(result.triage?.escalationFailed).toBe(true);
    expect(result.triage?.source).toBe('local');
    expect(result.verdict).toBeTruthy();
  });

  it('keeps the exclusive-fork behaviour when the cascade is off', async () => {
    const result = await scan('doubleclick.net', {});

    // Without `cascade`, `provider` still means "the one engine that sees everything".
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.triage).toBeUndefined();
  });

  it('records the screening explanation for the UI', async () => {
    const result = await scan('visualwebsiteoptimizer.com', { cascade: { enabled: true } });
    expect(result.triage?.explanations.length).toBeGreaterThan(0);
    expect(result.triage?.signals.length).toBeGreaterThan(0);
  });

  it('shares one budget across a whole query log instead of one per domain', async () => {
    const service = new AiDetectorService({
      provider: 'openai',
      apiKey: 'test-key',
      skipDns: true,
      cascade: { enabled: true, minAmbiguity: 0, maxEscalations: 2 },
    });
    // All four are genuinely undecided locally, so the plan has to choose.
    const queries = [
      'visualwebsiteoptimizer.com',
      'analytics.twitter.com',
      'n4k7x2p9qw8.top',
      'zq97kx24bwa-bot.xyz',
    ].map((domain) => ({ domain }));

    const result = await service.scanQueryLog(queries, { skipDns: true });

    // Four undecided domains, a budget of two: the plan caps the spend rather than
    // granting each domain its own allowance, which is the entire cost argument.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.totalQueriesAnalyzed).toBe(4);
    const escalated = result.results.filter((r) => r.triage?.action === 'escalate');
    expect(escalated).toHaveLength(2);
  });
});

// ─── Measurement over the real corpora ────────────────────────────────────────

function domainCandidates(): TriageCandidate[] {
  return EVAL_CORPUS.map((entry) => {
    const prediction = classifyDomainWithMiniAi(entry.domain);
    return {
      id: entry.domain,
      verdict: prediction.verdict,
      confidence: prediction.confidence,
      riskLevel: prediction.riskLevel,
      classProbabilities: prediction.classProbabilities,
      corroboration: prediction.corroboration,
      evidenceFamilies: prediction.evidenceFamilies,
      topContributions: prediction.topContributions,
    };
  });
}

// The element model's classes are not the domain threat categories, so the probabilities
// travel through the mapping the verdict line already asserts: Ad is Advertising, Tracker is
// Telemetry/Analytics, Annoyance is Consent/Annoyance, Content is Clean.
const ELEMENT_CLASS_TO_THREAT = {
  Ad: 'Advertising',
  Tracker: 'Telemetry/Analytics',
  Annoyance: 'Consent/Annoyance',
  Content: 'Clean',
} as const satisfies Record<ElementClass, ThreatCategory>;

function elementCandidates(): TriageCandidate[] {
  return ELEMENT_EVAL_CORPUS.map((entry) => {
    const prediction = classifyElementWithMiniAi(entry.snapshot);
    return {
      id: entry.label,
      verdict: prediction.elementClass === 'Content' ? 'clean' : 'tracker',
      confidence: prediction.confidence,
      riskLevel: 'medium',
      classProbabilities: Object.fromEntries(
        Object.entries(prediction.classProbabilities).map(([cls, p]) => [
          ELEMENT_CLASS_TO_THREAT[cls as ElementClass],
          p,
        ]),
      ),
      // The element engine spells its weakest tier `model-only`.
      corroboration:
        prediction.corroboration === 'model-only' ? 'lexical-only' : prediction.corroboration,
      evidenceFamilies: prediction.evidenceFamilies,
      topContributions: prediction.topContributions,
    };
  });
}

describe('cascade measured over the real corpora', () => {
  it('escalates a small, bounded share of hostname traffic', () => {
    const candidates = domainCandidates();
    const plan = planTriage(candidates, { maxEscalations: 25 });
    const rate = plan.stats.escalationRate;

    // The whole architecture is judged on this number: screening everything locally is
    // only interesting if the escalated share stays small.
    console.log(
      `[cascade] hostnames: ${plan.stats.screened} screened · ` +
        `${plan.stats.escalated} escalated (${(rate * 100).toFixed(1)}%) · ` +
        `${plan.stats.deferred} deferred · ${plan.stats.llmCallsSaved} calls avoided`,
    );
    expect(candidates.length).toBeGreaterThan(100);
    expect(rate).toBeLessThan(0.5);
    expect(plan.escalate.length).toBeLessThanOrEqual(25);
  });

  it('never escalates a hostname it can defend, and never escalates a clean one by default', () => {
    const plan = planTriage(domainCandidates(), { maxEscalations: 200 });
    for (const item of plan.escalate) {
      expect(item.ambiguity).toBeGreaterThanOrEqual(DEFAULT_TRIAGE_OPTIONS.minAmbiguity);
      expect(item.local.verdict).not.toBe('clean');
    }
  });

  it('keeps the elements the product must hide decided locally', () => {
    const candidates = elementCandidates();
    const plan = planTriage(candidates, { maxEscalations: 25 });
    const byLabel = new Map(plan.items.map((item) => [item.id, item]));

    // A must-hide case that the classifier is confident about must not burn budget:
    // the classifier already decided it, and the model would only be confirming.
    let mustHideEscalated = 0;
    for (const entry of MUST_HIDE_CASES) {
      const item = byLabel.get(entry.label);
      if (!item) continue;
      if (item.local.confidence >= 80 && item.action === 'escalate') mustHideEscalated += 1;
    }

    console.log(
      `[cascade] elements: ${plan.stats.screened} screened · ` +
        `${plan.stats.escalated} escalated (${(plan.stats.escalationRate * 100).toFixed(1)}%) · ` +
        `${mustHideEscalated} confident must-hide cases escalated`,
    );
    expect(mustHideEscalated).toBe(0);
  });

  it('leaves a confidently-wrong verdict unflagged — a knowledge gap is not an uncertainty', () => {
    // The honest limitation, pinned so nobody later claims the cascade fixes it. A
    // hostname the model confidently mislabels has no uncertainty signal to trip; only
    // list coverage reaches it. This is why the repo already documents these cases as
    // `list-dependent` and expects the fix to be coverage rather than the model.
    const missed = candidate({
      id: 'bat.bing.com',
      verdict: 'clean',
      confidence: 99,
      classProbabilities: { Clean: 0.99, 'Telemetry/Analytics': 0.005 },
    });
    expect(assessAmbiguity(missed, { escalateClean: true }).ambiguous).toBe(false);
  });

  it('earns its keep on ordinary-looking hostnames in discovery mode', () => {
    const listDependent = EVAL_CORPUS.filter((entry) => entry.signal === 'list-dependent').map(
      (entry) => {
        const prediction = classifyDomainWithMiniAi(entry.domain);
        return {
          id: entry.domain,
          verdict: prediction.verdict,
          confidence: prediction.confidence,
          riskLevel: prediction.riskLevel,
          classProbabilities: prediction.classProbabilities,
          corroboration: prediction.corroboration,
          evidenceFamilies: prediction.evidenceFamilies,
          topContributions: prediction.topContributions,
        };
      },
    );

    const screeningOnly = planTriage(listDependent, { maxEscalations: 500 });
    const discovery = planTriage(listDependent, { maxEscalations: 500, escalateClean: true });

    // A list-dependent case is ordinary-looking by construction: no fingerprint model can
    // know what `comscore.com` does. These are the hostnames a filter list has to carry,
    // and the ones a purely local screen silently passes.
    const missed = (plan: typeof discovery): TriageItem[] =>
      plan.items.filter((item) => item.local.verdict === 'clean');
    const caught = (plan: typeof discovery): number =>
      missed(plan).filter((item) => item.action === 'escalate').length;

    console.log(
      `[cascade] list-dependent (n=${listDependent.length}): ` +
        `screening-only escalated ${screeningOnly.stats.escalated}, caught ${caught(screeningOnly)}/${missed(screeningOnly).length} of the local misses · ` +
        `discovery escalated ${discovery.stats.escalated}, caught ${caught(discovery)}/${missed(discovery).length}`,
    );

    // Discovery mode is the whole point of the flag: it escalates the ordinary-looking
    // hostnames the local screen passes, which is what no list-based blocker can do.
    expect(missed(screeningOnly).length).toBeGreaterThan(0);
    expect(caught(discovery)).toBeGreaterThan(caught(screeningOnly));
  });

  it('a cascade resolves every candidate, whichever path it takes', () => {
    for (const candidates of [domainCandidates(), elementCandidates()]) {
      const plan = planTriage(candidates, { maxEscalations: 10 });
      expect(plan.items).toHaveLength(candidates.length);
      for (const item of plan.items) {
        expect(['resolve-locally', 'escalate', 'deferred']).toContain(item.action);
        expect(item.local.verdict).toBeTruthy();
      }
    }
  });
});
