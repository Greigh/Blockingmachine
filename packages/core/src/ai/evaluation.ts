/**
 * Classifier evaluation.
 *
 * Turns "the Mini-AI feels better now" into numbers that a regression test can
 * hold onto. Three views, because they answer different questions:
 *
 *  1. **Triage** — clean vs nuisance vs malicious. This is the decision the
 *     product actually makes (block, don't block, warn), so its error counts are
 *     split by direction: a clean domain flagged is a broken site, a missed
 *     tracker is an annoyance, and they must never be averaged together.
 *  2. **Per class** — precision/recall/F1 against the corpus's accepted-label
 *     sets, so fuzzy labels (ads vs analytics) are not counted as mistakes.
 *  3. **Calibration** — whether a stated confidence means anything. A model that
 *     says 99% on a coin flip is worse than one that says 60% and is right 60% of
 *     the time, and expected calibration error measures exactly that.
 */

import { THREAT_CATEGORIES, type MiniAiPrediction, type ThreatCategory } from './types.js';
import { EVAL_CORPUS, isLexicalCase, type EvalCase } from './evalCorpus.js';

export type TriageLabel = 'clean' | 'nuisance' | 'malicious';

export interface ClassifierLike {
  classify(domain: string): MiniAiPrediction;
}

export interface MisclassifiedCase {
  domain: string;
  family: string;
  expected: ThreatCategory[];
  actual: ThreatCategory;
  verdict: string;
  confidence: number;
  riskLevel: string;
  /** The signal the model reported, for triage of the miss. */
  reason: string;
}

export interface ClassScore {
  label: ThreatCategory;
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CalibrationBin {
  /** Inclusive lower bound of the predicted-probability bin. */
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

export interface EvaluationReport {
  total: number;
  /** Cases whose actual category is in the accepted label set. */
  correct: number;
  accuracy: number;
  triage: {
    accuracy: number;
    /** Clean domains the model would flag — the costly failure. */
    falsePositives: MisclassifiedCase[];
    /** Nuisance/malware the model calls clean — the annoying failure. */
    falseNegatives: MisclassifiedCase[];
    /** The subset of misses whose hostname carried the evidence. Model defects. */
    lexicalMisses: MisclassifiedCase[];
    /** Misses whose hostname is ordinary-looking: a list-coverage gap, not a defect. */
    coverageGaps: MisclassifiedCase[];
    /** Recall over the threats a name-shape model can be held responsible for. */
    lexicalRecall: number;
    lexicalCases: number;
    /** Clean domains the model calls malicious specifically. */
    falseAlarmsAsMalware: MisclassifiedCase[];
  };
  perClass: ClassScore[];
  /**
   * Every case whose actual category is not an accepted label. The triage lists
   * only see misses that cost a block-or-not decision; a nuisance filed under
   * the wrong nuisance category (or under `Unknown`) shows up here and nowhere
   * else.
   */
  exactMisses: MisclassifiedCase[];
  /**
   * expected[0] → actual counts. The diagonal is correct; off-diagonal cells
   * split into `accepted` answers (an alternate the corpus allows, e.g. a DGA
   * host called Malware when the set also accepts Advertising) and real blurs —
   * only the blurs are the work queue. Cell counts sum to `total`, so a
   * prediction on a category the axis does not list cannot vanish silently.
   */
  confusion: Array<{
    expected: ThreatCategory;
    actual: ThreatCategory;
    count: number;
    /** Entries in this cell where `actual` was an accepted label for the case. */
    accepted: number;
    /** Domains contributing to the blur — accepted alternates are excluded. */
    examples: string[];
  }>;
  macroF1: number;
  /** Aggregate over the classes that carry support. */
  weightedF1: number;
  calibration: {
    bins: CalibrationBin[];
    /** Expected calibration error across bins. */
    ece: number;
    /** Mean squared error of the probability estimates. */
    brier: number;
    /**
     * Cases that contributed a calibration pair. Every corpus case produces one
     * today; stating the denominator keeps a future eligibility filter from
     * shrinking the scored set into a better ECE.
     */
    scored: number;
    total: number;
  };
  byFamily: Array<{ family: string; total: number; accuracy: number }>;
  /** Confidence distribution for flagged predictions, as a sanity check. */
  confidenceStats: { mean: number; max: number; atOrAbove99: number; flagged: number };
}

/** Maps a prediction's verdict onto the coarse decision the product makes. */
export function triageOf(verdict: string): TriageLabel {
  if (verdict === 'clean') return 'clean';
  if (verdict === 'malicious') return 'malicious';
  return 'nuisance';
}

/** Maps an accepted-label set onto the coarse decision it implies. */
export function expectedTriage(expected: ThreatCategory[]): TriageLabel {
  if (expected.includes('Clean')) return 'clean';
  if (expected.includes('Malware/Phishing')) return 'malicious';
  return 'nuisance';
}

function scoreClass(
  label: ThreatCategory,
  cases: Array<{ expected: ThreatCategory[]; actual: ThreatCategory }>,
): ClassScore {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const entry of cases) {
    const isExpected = entry.expected.includes(label);
    const isActual = entry.actual === label;
    if (isExpected && isActual) truePositive++;
    else if (!isExpected && isActual) falsePositive++;
    else if (isExpected && !isActual) falseNegative++;
  }

  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    label,
    support: truePositive + falseNegative,
    precision,
    recall,
    f1,
  };
}

/**
 * Probability the model assigns to its own decision, as a 0–1 value, for
 * calibration. A clean verdict's confidence is the model's certainty that
 * nothing is wrong, which is the same axis: P(not a nuisance).
 */
function probabilityFor(prediction: MiniAiPrediction): number {
  return Math.min(1, Math.max(0, prediction.confidence / 100));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function evaluateClassifier(
  classifier: ClassifierLike,
  cases: EvalCase[] = EVAL_CORPUS,
): EvaluationReport {
  const results = cases.map((entry) => {
    const prediction = classifier.classify(entry.domain);
    return { entry, prediction };
  });

  let correct = 0;
  let triageCorrect = 0;
  const falsePositives: MisclassifiedCase[] = [];
  const falseNegatives: MisclassifiedCase[] = [];
  const lexicalMisses: MisclassifiedCase[] = [];
  const coverageGaps: MisclassifiedCase[] = [];
  const falseAlarmsAsMalware: MisclassifiedCase[] = [];
  let lexicalThreats = 0;
  let lexicalThreatsCaught = 0;
  const calibrationPairs: Array<{ predicted: number; actual: 0 | 1 }> = [];

  const describe = (entry: EvalCase, prediction: MiniAiPrediction): MisclassifiedCase => ({
    domain: entry.domain,
    family: entry.family,
    expected: entry.expected,
    actual: prediction.category,
    verdict: prediction.verdict,
    confidence: prediction.confidence,
    riskLevel: prediction.riskLevel,
    reason: prediction.reasons[0] ?? prediction.topContributions[0]?.description ?? '',
  });

  const exactMisses: MisclassifiedCase[] = [];

  for (const { entry, prediction } of results) {
    if (entry.expected.includes(prediction.category)) correct++;
    else exactMisses.push(describe(entry, prediction));

    const expectedLabel = expectedTriage(entry.expected);
    const actualLabel = triageOf(prediction.verdict);
    if (expectedLabel === actualLabel) triageCorrect++;

    if (expectedLabel === 'clean' && actualLabel !== 'clean') {
      falsePositives.push(describe(entry, prediction));
      if (actualLabel === 'malicious') falseAlarmsAsMalware.push(describe(entry, prediction));
    } else if (expectedLabel !== 'clean' && actualLabel === 'clean') {
      const miss = describe(entry, prediction);
      falseNegatives.push(miss);
      if (isLexicalCase(entry)) lexicalMisses.push(miss);
      else coverageGaps.push(miss);
    }

    // Recall is only fair to measure on the cases the hostname itself reveals.
    if (expectedLabel !== 'clean' && isLexicalCase(entry)) {
      lexicalThreats++;
      if (actualLabel !== 'clean') lexicalThreatsCaught++;
    }

    // Calibration is measured on the binary question "is this clean?" because
    // that is the only axis where confidence has an unambiguous meaning.
    const isActuallyClean = expectedLabel === 'clean';
    const confidence = probabilityFor(prediction);
    const predictedClean = actualLabel === 'clean';
    calibrationPairs.push({
      predicted: predictedClean ? confidence : 1 - confidence,
      actual: isActuallyClean ? 1 : 0,
    });
  }

  // The class axis is the model's full output vocabulary, not just the labels the
  // corpus happens to expect: a prediction on a category the axis omitted would
  // fall out of perClass and the confusion matrix while still counting in
  // `total` — a silence exactly where the metric should look.
  const classes: ThreatCategory[] = [...THREAT_CATEGORIES];
  const perClass = classes.map((label) =>
    scoreClass(
      label,
      results.map(({ entry, prediction }) => ({ expected: entry.expected, actual: prediction.category })),
    ),
  );

  const confusion: EvaluationReport['confusion'] = [];
  for (const expectedLabel of classes) {
    for (const actualLabel of classes) {
      const inCell = results.filter(
        ({ entry, prediction }) =>
          entry.expected[0] === expectedLabel && prediction.category === actualLabel,
      );
      if (inCell.length === 0) continue;
      // An accepted alternate (DGA called Malware when the set also allows
      // Advertising) is not a blur; the work queue is the unaccepted remainder.
      const unaccepted = inCell.filter(
        ({ entry, prediction }) => !entry.expected.includes(prediction.category),
      );
      confusion.push({
        expected: expectedLabel,
        actual: actualLabel,
        count: inCell.length,
        accepted: inCell.length - unaccepted.length,
        examples: unaccepted.slice(0, 6).map(({ entry }) => entry.domain),
      });
    }
  }

  const supported = perClass.filter((score) => score.support > 0);
  const macroF1 = supported.length === 0 ? 0 : supported.reduce((sum, s) => sum + s.f1, 0) / supported.length;
  const totalSupport = supported.reduce((sum, s) => sum + s.support, 0);
  const weightedF1 =
    totalSupport === 0 ? 0 : supported.reduce((sum, s) => sum + s.f1 * s.support, 0) / totalSupport;

  // Calibration: 10 equal-width bins, ECE = Σ (n_bin/N) · |mean predicted − observed|.
  const binCount = 10;
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lower = i / binCount;
    const upper = (i + 1) / binCount;
    const inBin = calibrationPairs.filter((pair) =>
      i === binCount - 1 ? pair.predicted >= lower && pair.predicted <= upper : pair.predicted >= lower && pair.predicted < upper,
    );
    if (inBin.length === 0) continue;
    bins.push({
      lower,
      upper,
      count: inBin.length,
      meanPredicted: round(inBin.reduce((sum, p) => sum + p.predicted, 0) / inBin.length),
      observedRate: round(inBin.reduce((sum, p) => sum + p.actual, 0) / inBin.length),
    });
  }

  const ece =
    calibrationPairs.length === 0
      ? 0
      : bins.reduce(
          (sum, bin) => sum + (bin.count / calibrationPairs.length) * Math.abs(bin.meanPredicted - bin.observedRate),
          0,
        );
  const brier =
    calibrationPairs.length === 0
      ? 0
      : calibrationPairs.reduce((sum, pair) => sum + (pair.predicted - pair.actual) ** 2, 0) /
        calibrationPairs.length;

  const families = [...new Set(cases.map((entry) => entry.family))];
  const byFamily = families.map((family) => {
    const inFamily = results.filter(({ entry }) => entry.family === family);
    const hits = inFamily.filter(({ entry, prediction }) => entry.expected.includes(prediction.category)).length;
    return { family, total: inFamily.length, accuracy: round(hits / inFamily.length) };
  });

  const flagged = results.filter(({ prediction }) => triageOf(prediction.verdict) !== 'clean');
  const confidences = flagged.map(({ prediction }) => prediction.confidence);

  return {
    total: cases.length,
    correct,
    accuracy: round(correct / cases.length),
    triage: {
      accuracy: round(triageCorrect / cases.length),
      falsePositives,
      falseNegatives,
      lexicalMisses,
      coverageGaps,
      lexicalRecall: lexicalThreats === 0 ? 0 : round(lexicalThreatsCaught / lexicalThreats),
      lexicalCases: lexicalThreats,
      falseAlarmsAsMalware,
    },
    perClass: perClass.map((score) => ({
      ...score,
      precision: round(score.precision),
      recall: round(score.recall),
      f1: round(score.f1),
    })),
    exactMisses,
    confusion,
    macroF1: round(macroF1),
    weightedF1: round(weightedF1),
    calibration: {
      bins,
      ece: round(ece),
      brier: round(brier),
      scored: calibrationPairs.length,
      total: results.length,
    },
    byFamily,
    confidenceStats: {
      mean: confidences.length === 0 ? 0 : round(confidences.reduce((a, b) => a + b, 0) / confidences.length, 2),
      max: confidences.length === 0 ? 0 : Math.max(...confidences),
      atOrAbove99: confidences.filter((c) => c >= 99).length,
      flagged: flagged.length,
    },
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Human-readable report, printed by the evaluation test and usable in a CLI. */
export function formatEvaluationReport(report: EvaluationReport): string {
  const lines: string[] = [];
  lines.push(`Mini-AI evaluation — ${report.total} labeled domains`);
  lines.push('');
  lines.push(`  exact category accuracy : ${pct(report.accuracy)} (${report.correct}/${report.total})`);
  lines.push(`  triage accuracy         : ${pct(report.triage.accuracy)}`);
  lines.push(
    `  lexical threat recall   : ${pct(report.triage.lexicalRecall)} of ${report.triage.lexicalCases} name-evident threats`,
  );
  lines.push(`  macro F1                : ${report.macroF1.toFixed(3)}   weighted F1: ${report.weightedF1.toFixed(3)}`);
  lines.push(
    `  calibration             : ECE ${report.calibration.ece.toFixed(3)}   Brier ${report.calibration.brier.toFixed(3)}` +
      `   (${report.calibration.scored} of ${report.calibration.total} cases scored)`,
  );
  lines.push('');
  lines.push('  per class            support   precision   recall      F1');
  for (const score of report.perClass) {
    lines.push(
      `    ${score.label.padEnd(20)}${String(score.support).padStart(4)}` +
        `   ${score.precision.toFixed(3).padStart(8)} ${score.recall.toFixed(3).padStart(8)} ${score.f1.toFixed(3).padStart(8)}`,
    );
  }
  lines.push('');
  lines.push('  confusion (expected first label → predicted)');
  for (const cell of report.confusion) {
    const offDiagonal = cell.expected !== cell.actual;
    // · = every case in the cell was an accepted alternate (not a blur)
    // ↳ = the cell holds real confusion: at least one unaccepted answer
    const marker = !offDiagonal ? ' ' : cell.accepted === cell.count ? '·' : '↳';
    lines.push(
      `  ${marker} ${cell.expected.padEnd(20)}→ ${cell.actual.padEnd(20)}${String(cell.count).padStart(4)}`,
    );
    if (offDiagonal && cell.accepted === cell.count) {
      lines.push('      all accepted alternates — the corpus allows this answer');
    } else if (cell.examples.length > 0) {
      lines.push(`      e.g. ${cell.examples.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('  by family');
  for (const family of report.byFamily) {
    lines.push(`    ${family.family.padEnd(12)}${String(family.total).padStart(4)} cases   ${pct(family.accuracy)}`);
  }
  lines.push('');
  lines.push(
    `  flagged predictions: ${report.confidenceStats.flagged}` +
      `   mean confidence ${report.confidenceStats.mean}` +
      `   max ${report.confidenceStats.max}` +
      `   at 99+ ${report.confidenceStats.atOrAbove99}`,
  );

  const list = (title: string, items: MisclassifiedCase[]): void => {
    if (items.length === 0) return;
    lines.push('');
    lines.push(`  ${title} (${items.length})`);
    for (const item of items) {
      lines.push(
        `    ${item.domain}  [${item.family}] expected ${item.expected.join('|')}` +
          ` → got ${item.actual} (${item.verdict}, ${item.confidence}%, ${item.riskLevel})`,
      );
      if (item.reason) lines.push(`      why: ${item.reason}`);
    }
  };

  list('CLEAN DOMAINS FLAGGED — highest cost', report.triage.falsePositives);
  list('THREATS MISSED — model defect, the name gave it away', report.triage.lexicalMisses);
  list(
    'WRONG CATEGORY — unaccepted label even though the block-or-not call was right',
    report.exactMisses.filter(
      (miss) => expectedTriage(miss.expected) === triageOf(miss.verdict),
    ),
  );
  list(
    'COVERAGE GAPS — ordinary-looking names only a list can know (not a model defect)',
    report.triage.coverageGaps,
  );

  return lines.join('\n');
}
