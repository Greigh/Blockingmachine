/**
 * Element classifier evaluation.
 *
 * The hostname harness answers "did it get the right category?"; this one has to
 * answer a blunter question, because element decisions *do* something: **did it hide
 * something it should not have?** Hiding is the only irreversible action here — a
 * hidden element is removed from the page the user came to read — so the report is
 * built around it:
 *
 *  1. **Safety** — `destroyedContent` counts cases the model wanted to hide that it
 *     had no business hiding. The target is zero, and it is the number to watch.
 *  2. **Coverage** — `missedHides` counts ads, trackers and nags left alone. This is
 *     the number to *improve*; it trades directly against safety only if the fixes
 *     are sloppy, which is why the corpus pins both directions. * 3. **Accuracy & calibration** — whether the class label means anything over every
 *     case, and whether the stated confidence means anything over the cases where the
 *     corpus states an expectation about acting — required or forbidden — rather than
 *     merely permitting it (ECE and Brier). Acting is the only thing a confidence is
 *     attached to, so it is the only thing it can be honest or dishonest about;
 *     restraint is measured by `missedHides` and the action mix instead.
 */

import type { ElementAction, ElementClass, ElementPrediction, ElementSnapshot } from './elementClassifier.js';
import { ELEMENT_EVAL_CORPUS, type ElementEvalCase } from './elementEvalCorpus.js';

export interface ElementClassifierLike {
  classify(snapshot: ElementSnapshot): ElementPrediction;
}

/**
 * One calibration observation: the confidence the model attached to acting, and whether
 * acting was the right call on that case.
 */
export interface ElementActionCalibrationPair {
  predicted: number;
  actual: 0 | 1;
}

/** Acting gets more consequential as it gets more aggressive, so a band is comparable by rank. */
const ACTION_RANK: Record<ElementAction, number> = { leave: 0, suggest: 1, hide: 2 };

/**
 * The pair for one case, or `null` when the corpus states no expectation about acting.
 *
 * Calibration here is precision calibration: **when the model acts, is its stated
 * confidence the probability that acting was right?** That question needs ground truth
 * about acting, and the corpus states one only at the edges of its action band:
 *
 *  - **Required** (`minAction: 'hide'`): acting is the job. The label is 1 when the
 *    verdict sits inside the band and 0 when it does not — an undersold hide is a
 *    calibration error, not a validated action.
 *  - **Forbidden** (`maxAction: 'leave'`): acting is a defect. Any verdict the model
 *    takes here is labelled 0, which is the only place overconfidence can show.
 *  - **Merely permitted** (`minAction` unset, `maxAction` above `leave`): the corpus
 *    deliberately says both acting and restraint are acceptable, so there is no honest
 *    label — scoring it 1 would claim the corpus validated acting (a permitted suggest
 *    counted as an expected one), scoring it 0 would claim it forbade acting. Either
 *    reading lets the metric be gamed by acting on exactly the cases nobody labelled,
 *    so the pair is `null`. These cases are not unmeasured: `destroyedContent`,
 *    `undersoldHides`, `missedHides` and the action mix all still see them.
 *
 * A `leave` verdict is likewise never scored, for a second reason: its confidence is a
 * class probability ("84% sure this is Content"), not an action probability ("16%
 * chance that hiding would have been right"), and nothing in the model produces that
 * second number. Scoring leaves anyway once dragged the metric's floor to ~0.10 and made
 * its ceiling move whenever a leave-only case was added — including for the hand-tuned
 * reference, which is how a *threshold* got to be knife-edge without the weights
 * changing at all.
 */
export function elementActionCalibrationPair(
  entry: ElementEvalCase,
  prediction: ElementPrediction,
): ElementActionCalibrationPair | null {
  if (prediction.action === 'leave') return null;
  // `minAction` unset means the corpus requires nothing; unless acting is forbidden
  // outright, the case carries no expectation to score against.
  if (entry.minAction === undefined && entry.maxAction !== 'leave') return null;
  const minimum = entry.minAction ?? 'leave';
  const actingInsideTheBand =
    ACTION_RANK[prediction.action] >= ACTION_RANK[minimum] &&
    ACTION_RANK[prediction.action] <= ACTION_RANK[entry.maxAction];
  return {
    predicted: prediction.confidence / 100,
    actual: actingInsideTheBand ? 1 : 0,
  };
}

/**
 * Expected calibration error and Brier score over calibration pairs, equal-width bins.
 * Area-weighted, so an empty bin contributes nothing rather than a spurious error.
 */
export function expectedCalibrationError(
  pairs: readonly ElementActionCalibrationPair[],
  binCount = 5,
): { ece: number; brier: number; bins: number } {
  if (pairs.length === 0) return { ece: 0, brier: 0, bins: binCount };

  let ece = 0;
  let brier = 0;
  for (let bin = 0; bin < binCount; bin++) {
    const lower = bin / binCount;
    const upper = (bin + 1) / binCount;
    const inBin = pairs.filter(
      (pair) => pair.predicted >= lower && pair.predicted < upper + (bin === binCount - 1 ? 0.0001 : 0),
    );
    if (inBin.length === 0) continue;
    const meanPredicted = inBin.reduce((sum, pair) => sum + pair.predicted, 0) / inBin.length;
    const observed = inBin.reduce((sum, pair) => sum + pair.actual, 0) / inBin.length;
    ece += (inBin.length / pairs.length) * Math.abs(meanPredicted - observed);
  }
  for (const pair of pairs) brier += (pair.predicted - pair.actual) ** 2;
  return { ece, brier: brier / pairs.length, bins: binCount };
}

export interface ElementMisclassifiedCase {
  label: string;
  family: string;
  expected: ElementClass[];
  actual: ElementClass;
  action: ElementAction;
  confidence: number;
  tier: string;
  evidenceFamilies: string[];
  reason: string;
}

export interface ElementClassScore {
  label: ElementClass;
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ElementEvaluationReport {
  total: number;
  correct: number;
  accuracy: number;
  safety: {
    /** Cases hidden that should not have been: the defect counter. */
    destroyedContent: ElementMisclassifiedCase[];
    /** Cases the corpus requires hiding that were merely suggested. */
    undersoldHides: ElementMisclassifiedCase[];
    /** Cases the corpus requires hiding that were left alone entirely. */
    missedHides: ElementMisclassifiedCase[];
    /** Cases hidden whose class was not among the accepted labels. */
    mislabelledHides: ElementMisclassifiedCase[];
    /** Hides with no explanation at all. A verdict must be able to say why. */
    unexplainedHides: ElementMisclassifiedCase[];
  };
  perClass: ElementClassScore[];
  confusion: Array<{ expected: ElementClass; actual: ElementClass; count: number; examples: string[] }>;
  macroF1: number;
  weightedF1: number;
  /** `scored` of the cases carried an expectation the model could be held to; the rest specified none. */
  calibration: { ece: number; brier: number; bins: number; scored: number; total: number };
  byFamily: Array<{ family: string; total: number; accuracy: number }>;
  actionMix: Record<ElementAction, number>;
  confidenceStats: { mean: number; max: number; atOrAbove90: number; acting: number };
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scoreClass(
  label: ElementClass,
  rows: Array<{ expected: ElementClass[]; actual: ElementClass }>,
): ElementClassScore {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const row of rows) {
    const isExpected = row.expected.includes(label);
    const isActual = row.actual === label;
    if (isExpected && isActual) truePositive++;
    else if (!isExpected && isActual) falsePositive++;
    else if (isExpected && !isActual) falseNegative++;
  }

  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { label, support: truePositive + falseNegative, precision, recall, f1 };
}

/** The classes an action is expected to accompany. */
const ACTION_CLASSES: Record<ElementAction, ElementClass[]> = {
  hide: ['Ad', 'Tracker', 'Annoyance'],
  suggest: ['Ad', 'Tracker', 'Annoyance', 'Content'],
  leave: ['Content'],
};

export function evaluateElementClassifier(
  classifier: ElementClassifierLike,
  cases: ElementEvalCase[] = ELEMENT_EVAL_CORPUS,
): ElementEvaluationReport {
  const results = cases.map((entry) => ({ entry, prediction: classifier.classify(entry.snapshot) }));

  const describe = (entry: ElementEvalCase, prediction: ElementPrediction): ElementMisclassifiedCase => ({
    label: entry.label,
    family: entry.family,
    expected: entry.expected,
    actual: prediction.elementClass,
    action: prediction.action,
    confidence: prediction.confidence,
    tier: prediction.corroboration,
    evidenceFamilies: [...prediction.evidenceFamilies],
    reason: prediction.reasons[0] ?? '',
  });

  let correct = 0;
  const destroyedContent: ElementMisclassifiedCase[] = [];
  const undersoldHides: ElementMisclassifiedCase[] = [];
  const missedHides: ElementMisclassifiedCase[] = [];
  const mislabelledHides: ElementMisclassifiedCase[] = [];
  const unexplainedHides: ElementMisclassifiedCase[] = [];
  const actionMix: Record<ElementAction, number> = { hide: 0, suggest: 0, leave: 0 };
  const calibrationPairs: ElementActionCalibrationPair[] = [];
  let acting = 0;
  let confidenceSum = 0;
  let maxConfidence = 0;
  let atOrAbove90 = 0;

  for (const { entry, prediction } of results) {
    const row = describe(entry, prediction);
    if (entry.expected.includes(prediction.elementClass)) correct++;
    actionMix[prediction.action]++;

    const mustHide = entry.minAction === 'hide';
    const mayHide = entry.maxAction === 'hide';
    const classAllowed = ACTION_CLASSES[prediction.action].includes(prediction.elementClass);

    if (prediction.action === 'hide' && !mayHide) destroyedContent.push(row);
    if (prediction.action === 'hide' && !classAllowed) mislabelledHides.push(row);
    if (prediction.action === 'hide' && prediction.reasons.length === 0) unexplainedHides.push(row);
    if (mustHide && prediction.action !== 'hide') {
      (prediction.action === 'suggest' ? undersoldHides : missedHides).push(row);
    }

    if (prediction.action !== 'leave') {
      acting++;
      confidenceSum += prediction.confidence;
      if (prediction.confidence > maxConfidence) maxConfidence = prediction.confidence;
      if (prediction.confidence >= 90) atOrAbove90++;
    }

    const pair = elementActionCalibrationPair(entry, prediction);
    if (pair) calibrationPairs.push(pair);
  }

  const classes: ElementClass[] = ['Ad', 'Tracker', 'Annoyance', 'Content'];
  const rows = results.map(({ entry, prediction }) => ({
    expected: entry.expected,
    actual: prediction.elementClass,
  }));
  const perClass = classes.map((label) => scoreClass(label, rows));

  const confusion: ElementEvaluationReport['confusion'] = [];
  for (const expectedLabel of classes) {
    for (const actualLabel of classes) {
      const inCell = results.filter(
        ({ entry, prediction }) =>
          entry.expected[0] === expectedLabel && prediction.elementClass === actualLabel,
      );
      if (inCell.length === 0) continue;
      confusion.push({
        expected: expectedLabel,
        actual: actualLabel,
        count: inCell.length,
        examples: inCell.slice(0, 5).map(({ entry }) => entry.label),
      });
    }
  }

  const supported = perClass.filter((score) => score.support > 0);
  const macroF1 = supported.length === 0 ? 0 : supported.reduce((sum, score) => sum + score.f1, 0) / supported.length;
  const totalSupport = supported.reduce((sum, score) => sum + score.support, 0);
  const weightedF1 =
    totalSupport === 0 ? 0 : supported.reduce((sum, score) => sum + score.f1 * score.support, 0) / totalSupport;

  const bins = 5;
  const { ece, brier } = expectedCalibrationError(calibrationPairs, bins);

  const familyMap = new Map<string, { total: number; correct: number }>();
  for (const { entry, prediction } of results) {
    const bucket = familyMap.get(entry.family) ?? { total: 0, correct: 0 };
    bucket.total++;
    if (entry.expected.includes(prediction.elementClass)) bucket.correct++;
    familyMap.set(entry.family, bucket);
  }

  return {
    total: cases.length,
    correct,
    accuracy: round(correct / cases.length),
    safety: { destroyedContent, undersoldHides, missedHides, mislabelledHides, unexplainedHides },
    perClass: perClass.map((score) => ({
      ...score,
      precision: round(score.precision),
      recall: round(score.recall),
      f1: round(score.f1),
    })),
    confusion,
    macroF1: round(macroF1),
    weightedF1: round(weightedF1),
    calibration: { ece: round(ece), brier: round(brier), bins, scored: calibrationPairs.length, total: results.length },
    byFamily: Array.from(familyMap.entries())
      .map(([family, bucket]) => ({ family, total: bucket.total, accuracy: round(bucket.correct / bucket.total) }))
      .sort((a, b) => a.family.localeCompare(b.family)),
    actionMix,
    confidenceStats: {
      mean: acting === 0 ? 0 : round(confidenceSum / acting, 2),
      max: maxConfidence,
      atOrAbove90,
      acting,
    },
  };
}

/** Human-readable report body, used by the evaluation test's console output. */
export function formatElementReport(report: ElementEvaluationReport): string {
  const lines: string[] = [];
  lines.push(`\nElement classification — ${report.total} labeled elements`);
  lines.push('');
  lines.push(`  class accuracy        : ${(report.accuracy * 100).toFixed(1)}% (${report.correct}/${report.total})`);
  lines.push(`  macro F1              : ${report.macroF1.toFixed(3)}   weighted F1: ${report.weightedF1.toFixed(3)}`);
  lines.push(
    `  acting calibration    : ECE ${report.calibration.ece.toFixed(3)}   Brier ${report.calibration.brier.toFixed(3)}` +
      `   (${report.calibration.scored} of ${report.calibration.total} cases stated an expectation about acting)`,
  );
  lines.push(`  actions               : ${report.actionMix.hide} hide, ${report.actionMix.suggest} suggest, ${report.actionMix.leave} leave`);
  lines.push('');

  lines.push('  safety (lower is better)');
  lines.push(`    content destroyed   : ${report.safety.destroyedContent.length}`);
  for (const entry of report.safety.destroyedContent.slice(0, 8)) {
    lines.push(`      ↳ ${entry.label} → ${entry.actual} ${entry.confidence}% — ${entry.reason}`);
  }
  lines.push(`    hid without a reason: ${report.safety.unexplainedHides.length}`);
  lines.push(`    mislabelled hides   : ${report.safety.mislabelledHides.length}`);
  lines.push(`    missed hides        : ${report.safety.missedHides.length}`);
  for (const entry of report.safety.missedHides.slice(0, 8)) {
    lines.push(`      ↳ ${entry.label} → ${entry.actual} (${entry.action}) [${entry.evidenceFamilies.join(',')}]`);
  }
  lines.push(`    undersold to suggest: ${report.safety.undersoldHides.length}`);
  for (const entry of report.safety.undersoldHides.slice(0, 8)) {
    lines.push(`      ↳ ${entry.label} → ${entry.actual} (${entry.action}) [${entry.evidenceFamilies.join(',')}]`);
  }
  lines.push('');

  lines.push('  per class            support   precision   recall      F1');
  for (const score of report.perClass) {
    lines.push(
      `    ${score.label.padEnd(17)} ${String(score.support).padStart(6)}   ${score.precision.toFixed(3).padStart(9)}   ${score.recall
        .toFixed(3)
        .padStart(7)}   ${score.f1.toFixed(3)}`,
    );
  }
  lines.push('');

  lines.push('  confusion (expected[0] → predicted)');
  for (const cell of report.confusion) {
    const marker = cell.expected === cell.actual ? ' ' : '↳';
    lines.push(`  ${marker} ${cell.expected.padEnd(11)} → ${cell.actual.padEnd(11)} ${String(cell.count).padStart(3)}   ${cell.examples.slice(0, 3).join(', ')}`);
  }
  lines.push('');

  lines.push('  by family');
  for (const entry of report.byFamily) {
    lines.push(`    ${entry.family.padEnd(14)} ${String(entry.total).padStart(3)} cases   ${(entry.accuracy * 100).toFixed(1)}%`);
  }
  lines.push('');

  return lines.join('\n');
}
