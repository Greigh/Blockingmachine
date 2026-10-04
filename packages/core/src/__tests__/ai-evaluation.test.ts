import { beforeAll, describe, expect, it } from '@jest/globals';
import { MiniAiClassifier, MODEL_WEIGHTS, type ModelClassWeights } from '../ai/MiniAiClassifier.js';
import { THREAT_CATEGORIES, type ThreatCategory } from '../ai/types.js';
import {
  CRITICAL_NEGATIVES,
  EVAL_CORPUS,
  casesByFamily,
  type EvalCase,
} from '../ai/evalCorpus.js';
import { evaluateClassifier, formatEvaluationReport, triageOf } from '../ai/evaluation.js';

/**
 * Model quality, measured rather than asserted case by case.
 *
 * The thresholds below are a ratchet: they describe what the classifier does
 * today, not what it should ideally do. Raising them is the point of the file —
 * a change that improves the model raises the bar, and a change that trades
 * precision for recall (or vice versa) has to be justified in the numbers.
 */

/**
 * How much worse than the reference head the shipped head's ECE may be.
 * See the `stays calibrated` test for why this is a margin and not a number.
 */
const ECE_REGRESSION_MARGIN = 0.005;
const BRIER_REGRESSION_MARGIN = 0.005;
/**
 * Absolute headroom on top of the margin: shipped ECE must stay below
 * reference + this however the two heads compare.
 */
const ECE_ABSOLUTE_HEADROOM = 0.02;

/**
 * The calibration reference: the shipped table with its vocabulary knowledge
 * removed — the ad/tracker/consent keyword weights, the CNAME lookups, the
 * safe-infrastructure list and the brand-spoof table all zeroed, so only the
 * shape features (entropy, length, consonant runs, digits, trigram familiarity)
 * still score. It is the strongest hand-tuned head that knows no names, and it
 * is a real competitor, not a strawman: on this corpus it keeps 97.7% triage
 * accuracy, so `shipped <= reference + margin` is a bound that can be lost.
 */
const REFERENCE_WEIGHTS: Record<ThreatCategory, ModelClassWeights> = Object.fromEntries(
  THREAT_CATEGORIES.map((cat) => [
    cat,
    {
      ...MODEL_WEIGHTS[cat],
      adKeywordWeight: 0,
      trackerKeywordWeight: 0,
      consentKeywordWeight: 0,
      cnameKnownTracker: 0,
      cnameExternal: 0,
      knownSafeInfra: 0,
      brandSpoofScore: 0,
    },
  ]),
) as Record<ThreatCategory, ModelClassWeights>;

const classifier = new MiniAiClassifier();
const referenceClassifier = new MiniAiClassifier({ weights: REFERENCE_WEIGHTS });
const report = evaluateClassifier(classifier, EVAL_CORPUS);
const referenceReport = evaluateClassifier(referenceClassifier, EVAL_CORPUS);

describe('Mini-AI evaluation corpus', () => {
  beforeAll(() => {
    // Printed on every run so improvements and regressions are visible.
    console.log(`\n${formatEvaluationReport(report)}\n`);
  });

  it('has a corpus worth measuring', () => {
    expect(report.total).toBeGreaterThanOrEqual(150);
    for (const family of ['infra', 'consumer', 'device', 'ad', 'telemetry', 'malware', 'dga']) {
      expect(casesByFamily(family as EvalCase['family']).length).toBeGreaterThan(0);
    }
  });

  it('never labels the same domain two different ways', () => {
    // A duplicate case with a different accepted-label set guarantees a miss no
    // model can avoid — the corpus then reads one miss worse than reality.
    const domains = EVAL_CORPUS.map((entry) => entry.domain);
    const duplicates = domains.filter((domain, i) => domains.indexOf(domain) !== i);
    expect([...new Set(duplicates)]).toEqual([]);
  });

  it('never flags a clean domain as malicious', () => {
    expect(report.triage.falseAlarmsAsMalware).toEqual([]);
  });

  it('keeps the clean-domain false-positive rate low', () => {
    const cleanCases = EVAL_CORPUS.filter((entry) => entry.expected.includes('Clean'));
    expect(cleanCases.length).toBeGreaterThan(100);
    // A mistaken block breaks an ordinary site, so this budget is deliberately
    // far stricter than the recall budget below.
    expect(report.triage.falsePositives.length / cleanCases.length).toBeLessThanOrEqual(0.05);
  });

  it('catches the threats its evidence could see, and misses nothing name-evident', () => {
    // Missing a threat whose name gives it away is a model defect. Missing an
    // ordinary-looking name (bat.bing.com, browser.sentry-cdn.com) is a list-coverage
    // gap and is reported separately — averaging the two would hide real defects.
    expect(report.triage.lexicalCases).toBeGreaterThanOrEqual(60);
    expect(report.triage.lexicalRecall).toBeGreaterThanOrEqual(0.95);
    expect(report.triage.lexicalMisses).toEqual([]);
  });

  it('keeps the number of list-coverage gaps in sight', () => {
    // Not a pass/fail on the model: this number should go down as curated lists grow,
    // and it should never grow silently. It was 5 until the token lists gained the SSP
    // and measurement vendors the shipped static tiers carry (`33across`, `magnite`,
    // `comscore`, `ct.pinterest` and the rest) — the local screen now places 3 of those
    // 5 by itself. The ceiling is a ratchet, so it moves down with the measurement: the
    // remaining pair are genuinely list-only, and the failure this guards against is a
    // change that quietly adds a third.
    expect(report.triage.coverageGaps.map((miss) => miss.domain)).toEqual([
      'bat.bing.com',
      'browser.sentry-cdn.com',
    ]);
  });

  it('holds its overall quality above the recorded baseline', () => {
    expect(report.triage.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(report.macroF1).toBeGreaterThanOrEqual(0.85);
    expect(report.perClass.find((c) => c.label === 'Clean')?.f1).toBeGreaterThanOrEqual(0.9);
  });

  it('stays calibrated on the block-or-not decision', () => {
    // Confidence has to mean something. ECE is measured on the binary question
    // the product actually asks, so a model that is right when it says it is
    // right keeps this low even if it saturates the top of the range.
    //
    // Stated as a margin over the reference head on the same corpus through the
    // same harness, the way the element calibration gates are — an absolute bar
    // on a metric whose scale has already moved twice (the confusion-axis fix,
    // the denominator pin) is a bar that quietly becomes a knife-edge. The
    // measured gap today: shipped ECE 0.0435 vs reference 0.0646, Brier 0.0195
    // vs 0.0260 — the shipped head is *better* calibrated than the strongest
    // vocabulary-free head, so the margin is slack in the safe direction and a
    // real degradation is what trips it.
    expect(report.calibration.ece).toBeLessThanOrEqual(referenceReport.calibration.ece + ECE_REGRESSION_MARGIN);
    expect(report.calibration.ece).toBeLessThan(referenceReport.calibration.ece + ECE_ABSOLUTE_HEADROOM);
    expect(report.calibration.brier).toBeLessThanOrEqual(referenceReport.calibration.brier + BRIER_REGRESSION_MARGIN);
    // The bounds above are only meaningful if the reference is a real
    // competitor rather than a degenerate table that happens to score zero.
    expect(referenceReport.calibration.ece).toBeGreaterThan(0);
    expect(referenceReport.calibration.brier).toBeGreaterThan(0);
    // The scored set must be stated, not implied: an empty or filtered pair list
    // would read ECE 0 and pass vacuously — the failure shape the element
    // metric's leave-exclusion once had.
    expect(report.calibration.scored).toBe(report.total);
  });

  it('rejects a deliberately degraded weight table on the margin, not the absolute number', () => {
    // The flag-8 verify: a worse weight set must fail the margin gate without
    // anyone lowering a literal. Every coefficient negated — the corruption a
    // bad merge or a transposed sign produces — still classifies plausibly on
    // triage (81.5%), but its confidences invert and the margin, not the old
    // absolute bar, is what catches it: 0.138 > reference 0.065 + 0.005.
    const negated = Object.fromEntries(
      THREAT_CATEGORIES.map((cat) => [
        cat,
        Object.fromEntries(
          Object.entries(MODEL_WEIGHTS[cat]).map(([key, value]) => [key, -value]),
        ),
      ]),
    ) as unknown as Record<ThreatCategory, ModelClassWeights>;
    const degraded = evaluateClassifier(new MiniAiClassifier({ weights: negated }), EVAL_CORPUS);
    expect(degraded.calibration.ece).toBeGreaterThan(
      referenceReport.calibration.ece + ECE_REGRESSION_MARGIN,
    );
    expect(degraded.calibration.brier).toBeGreaterThan(
      referenceReport.calibration.brier + BRIER_REGRESSION_MARGIN,
    );
  });

  it('keeps every case inside the confusion matrix', () => {
    // The matrix only holds cells whose labels are on the class axis, so its
    // counts summing to `total` is the proof that no predicted category falls
    // outside it — an `Unknown` or future eighth category must land somewhere.
    const cellTotal = report.confusion.reduce((sum, cell) => sum + cell.count, 0);
    expect(cellTotal).toBe(report.total);
    // Accepted alternates are not blurs: a cell whose every answer is allowed
    // must say so, and its example list (the work queue) must be empty.
    for (const cell of report.confusion) {
      if (cell.expected === cell.actual) continue;
      if (cell.accepted === cell.count) expect(cell.examples).toEqual([]);
      else expect(cell.examples.length).toBeGreaterThan(0);
    }
  });

  it('names every unaccepted answer', () => {
    // Triage misses are enumerable already; a case filed under the wrong
    // nuisance category (or `Unknown`) is only visible in exactMisses, so that
    // list must carry every case `correct` did not count.
    expect(report.exactMisses.length).toBe(report.total - report.correct);
    for (const miss of report.exactMisses) {
      expect(miss.expected).not.toContain(miss.actual);
      expect(miss.reason).toBeTruthy();
    }
    expect(report.exactMisses.map((miss) => miss.domain).sort()).toEqual([
      'bat.bing.com',
      'browser.sentry-cdn.com',
      'visualwebsiteoptimizer.com',
    ]);
  });

  it('never reports high confidence on a domain it gets wrong', () => {
    // The dangerous combination is "wrong AND certain". A wrong answer is
    // survivable at moderate confidence; at 99% it is a decision the user cannot
    // reasonably second-guess.
    const wrong = [...report.triage.falsePositives, ...report.triage.lexicalMisses];
    const certain = wrong.filter((miss) => miss.confidence >= 95);
    expect(certain.map((miss) => miss.domain)).toEqual([]);
  });

  it('never recommends blocking a critical negative', () => {
    for (const domain of CRITICAL_NEGATIVES) {
      const prediction = classifier.classify(domain);
      expect({ domain, verdict: prediction.verdict }).toEqual({ domain, verdict: 'clean' });
    }
  });

  it('reports the exact domains it misses, so misses can be worked on', () => {
    const misses = [
      ...report.triage.falsePositives,
      ...report.triage.falseNegatives,
      ...report.triage.coverageGaps,
      ...report.exactMisses,
    ];
    for (const miss of misses) {
      expect(miss.domain).toBeTruthy();
      expect(['clean', 'nuisance', 'malicious']).toContain(triageOf(miss.verdict));
      // Every miss must carry a reason, so triage does not need a debugger.
      expect(miss.reason).toBeTruthy();
    }
  });
});
