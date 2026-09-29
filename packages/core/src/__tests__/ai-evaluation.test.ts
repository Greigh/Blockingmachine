import { MiniAiClassifier } from '../ai/MiniAiClassifier.js';
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

const classifier = new MiniAiClassifier();
const report = evaluateClassifier(classifier, EVAL_CORPUS);

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
    // ordinary-looking name (comscore.com, bat.bing.com) is a list-coverage gap
    // and is reported separately — averaging the two would hide real defects.
    expect(report.triage.lexicalCases).toBeGreaterThanOrEqual(60);
    expect(report.triage.lexicalRecall).toBeGreaterThanOrEqual(0.95);
    expect(report.triage.lexicalMisses).toEqual([]);
  });

  it('keeps the number of list-coverage gaps in sight', () => {
    // Not a pass/fail on the model: this number should go down as curated lists
    // grow, and it should never grow silently.
    expect(report.triage.coverageGaps.length).toBeLessThanOrEqual(5);
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
    expect(report.calibration.ece).toBeLessThanOrEqual(0.15);
    expect(report.calibration.brier).toBeLessThanOrEqual(0.12);
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
    ];
    for (const miss of misses) {
      expect(miss.domain).toBeTruthy();
      expect(triageOf(miss.verdict)).not.toBeUndefined();
      // Every miss must carry a reason, so triage does not need a debugger.
      expect(typeof miss.reason).toBe('string');
    }
  });
});
