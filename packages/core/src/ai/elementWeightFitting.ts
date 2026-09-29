/**
 * Fitting the element classifier's weights from the labelled corpus.
 *
 * The classifier's statistical head is a linear model over 25 evidence features feeding
 * a softmax; {@link ELEMENT_HAND_TUNED_WEIGHTS} was written by hand and never measured
 * against an alternative. This module replaces guesswork with a fit, and — more
 * importantly — makes the replacement *checkable*:
 *
 *  1. **The corpus is split, once, deterministically.** {@link splitElementCorpus}
 *     stratifies by canonical label and takes every *k*-th case, so the held-out set is
 *     a fixed property of the corpus rather than something a run chooses.
 *  2. **The selection set is not the test set.** The one hyperparameter that matters —
 *     how hard to pull the fit back toward the hand-tuned prior — is chosen by
 *     cross-validation over the *training* cases ({@link selectPriorStrength}), never on
 *     the held-out cases that the claim rests on.
 *  3. **Both sets are scored through the shipping code path.** {@link weightSetMetrics}
 *     behaves like the classifier: same feature extraction, same `softmaxFor`, same
 *     argmax. {@link compareWeightSets} reports the delta and names the individual cases
 *     that changed hands, so a win that is really two trades is visible as such.
 *
 * The prior is a regulariser with a measured size, and its size is much smaller than it
 * first appeared. There are four classes × 26 parameters = 104 free numbers and 77
 * training elements, and the features are heavily correlated by construction (every
 * "strong token" family also sets its "weak token" partner), so centring a Gaussian prior
 * on the hand-tuned table is a real constraint: unregularised, the fit has to spend
 * examples separating features that co-occur. Measured by cross-validation over the
 * training cases, no regularisation at all is clearly the worst candidate (mean fold
 * logLoss 1.0929 against 0.5813 at strength 1), and the chosen strength has fallen from 5
 * to **1** as the selection moved from a single inner split to folding every training case
 * into validation. The data term is a class-balanced mean, so it sums to exactly one
 * example per case; strength 1 is therefore the hand-tuning being worth a single labelled
 * element against 77, i.e. the corpus outweighs the prior about **77:1** in the shipped
 * fit. `priorStrength` is measured in average-examples, so "1" reads plainly as "the prior
 * is worth one labelled element".
 *
 * The same move improved what ships: mean held-out cross-entropy went from 0.1796 at
 * strength 5 to **0.1443** at strength 1. It is worth knowing where the evidence still
 * disagrees: an unregularised fit scores *better* on the 40 held-out cases (0.0877), which
 * its ~15-case validation folds are too small to see. The fold estimate is the honest one
 * to select on — the held-out set cannot choose the hyperparameter without becoming a
 * fitted quantity — so strength 1 ships, and the residual gap is recorded here rather than
 * tuned away, because the fix is more labelled cases, not a better hyperparameter.
 *
 * Soft targets come from the corpus's own acceptance rule: `expected` lists every label
 * the case would accept, so the target distribution is uniform over exactly that set.
 * Training on the canonical label alone would teach the model to be wrong on cases the
 * corpus explicitly permits.
 *
 * Everything here is pure and deterministic — no RNG, no clock, no I/O — so the checked-in
 * weights are reproducible from the corpus alone, and the suite can assert that a fresh
 * fit still lands on the numbers that ship.
 */

import {
  ELEMENT_CLASSES,
  ELEMENT_HAND_TUNED_WEIGHTS,
  extractElementFeatures,
  MiniAiElementClassifier,
  softmaxFor,
  type ElementClass,
  type ElementClassWeights,
  type ElementFeatureName,
  type ElementWeightSet,
} from './elementClassifier.js';
import { ELEMENT_EVAL_CORPUS, type ElementEvalCase } from './elementEvalCorpus.js';
import {
  elementActionCalibrationPair,
  expectedCalibrationError,
  type ElementActionCalibrationPair,
} from './elementEvaluation.js';

/**
 * Feature order used for every flat weight vector. Stated explicitly rather than derived
 * from `Object.keys` so the generated table reads in a stable, reviewable order and a
 * feature added to the model cannot silently reorder it.
 */
export const ELEMENT_FEATURE_ORDER: readonly ElementFeatureName[] = [
  'adStrongToken',
  'adWeakToken',
  'trackerStrongToken',
  'trackerWeakToken',
  'consentStrongMarker',
  'consentWeakToken',
  'socialStrongMarker',
  'socialWeakToken',
  'dataAdAttribute',
  'dataTrackerAttribute',
  'adHostMatch',
  'measureHostMatch',
  'socialHostMatch',
  'urlPathToken',
  'thirdPartyFrame',
  'passiveSource',
  'pixelGeometry',
  'adSizeGeometry',
  'overlayGeometry',
  'lureText',
  'antiAdblockText',
  'ancestorAd',
  'contentText',
  'semanticContainer',
  'userTuneBias',
];

/** Decimal places kept when a weight set is written out or compared. */
export const WEIGHT_PRECISION = 4;

/**
 * Held-out cross-entropy floors at this value per class, because the shipped softmax
 * rounds probabilities to four decimals: a class the model has ruled out entirely is
 * stored as `0`, and no amount of fitting can distinguish "0.00004" from "0". Capping
 * here rather than un-rounding the model keeps the measurement on the shipping path.
 */
const PROBABILITY_FLOOR = 1e-6;

export interface ElementWeightFitOptions {
  /** Cases to fit on. Defaults to the whole corpus. */
  cases?: readonly ElementEvalCase[];
  /** Prior centre. Defaults to {@link ELEMENT_HAND_TUNED_WEIGHTS}. */
  prior?: ElementWeightSet;
  /**
   * How much the prior counts, in average-examples. `5` means the pull toward `prior` is
   * worth five labelled elements. `0` disables the prior, which is not recommended:
   * see the module note on why 104 parameters from 77 elements needs a centre.
   */
  priorStrength?: number;
  /** Full-batch Adam steps. */
  epochs?: number;
  learningRate?: number;
  /** Weight each example inversely to its class frequency. Defaults to on. */
  balanceClasses?: boolean;
}

export interface ElementWeightFitResult {
  weights: ElementWeightSet;
  /** Weighted cross-entropy on the training cases, prior penalty excluded. */
  trainingLoss: number;
  /** Training loss after the first step, to show the fit actually descended. */
  initialLoss: number;
  epochs: number;
  examples: number;
  priorStrength: number;
}

export interface ElementWeightMetrics {
  title: string;
  cases: number;
  /** Mean cross-entropy of the corpus's soft label distribution. Lower is better. */
  logLoss: number;
  /** Mean squared error of the soft label distribution. Lower is better. */
  brier: number;
  /** Share of cases whose argmax is one of the accepted labels. */
  accuracy: number;
  /** Mean probability assigned to the accepted labels — how much mass the model gives away. */
  acceptedProbability: number;
}

export interface ElementWeightComparison {
  cases: number;
  baseline: ElementWeightMetrics;
  fitted: ElementWeightMetrics;
  /** Positive means the fit is better: the baseline's log-loss minus the fit's. */
  logLossImprovement: number;
  /** Positive means the fit is better: the fit's accuracy minus the baseline's. */
  accuracyImprovement: number;
  perClass: Array<{ label: ElementClass; support: number; baseline: number; fitted: number }>;
  /** Case labels the baseline got right and the fit gets wrong. */
  regressions: string[];
  /** Case labels the baseline got wrong and the fit gets right. */
  wins: string[];
}

/** Which corpus revision and measurement the shipped weights came from. */
export interface ElementWeightProvenance {
  corpusCases: number;
  trainingCases: number;
  holdoutCases: number;
  /** Chosen by cross-validation over the training cases, in average-examples. */
  priorStrength: number;
  epochs: number;
  /** Held-out head accuracy and cross-entropy, both weight sets, same cases. */
  holdout: {
    baselineAccuracy: number;
    fittedAccuracy: number;
    baselineLogLoss: number;
    fittedLogLoss: number;
  };
  /** Held-out end-to-end agreement with the corpus, through the full decision path. */
  endToEnd: { total: number; baselineCorrect: number; fittedCorrect: number };
  /**
   * What the fit cost, stated next to what it bought. Action-level confidence
   * calibration is a different quantity from head cross-entropy and moves the other
   * way: a sharper head is better at ranking, but the confidence the product shows is a
   * capped class probability, so sharper probabilities land nearer their caps.
   */
  actionCalibration: {
    baselineEce: number;
    fittedEce: number;
    baselineBrier: number;
    fittedBrier: number;
  };
  /** The largest single move away from the hand-tuned prior, for review. */
  largestWeightChange: { feature: ElementFeatureName; from: number; to: number };
}

function zeroVector(prior: ElementClassWeights): number[] {
  return ELEMENT_FEATURE_ORDER.map((name) => prior[name] ?? 0);
}

/** Deep copy, so a caller can never mutate a table it was handed. */
export function cloneWeightSet(weights: ElementWeightSet): ElementWeightSet {
  const copy = {} as ElementWeightSet;
  for (const cls of ELEMENT_CLASSES) {
    const vector = weights[cls];
    const next = { bias: vector.bias } as ElementClassWeights;
    for (const name of ELEMENT_FEATURE_ORDER) next[name] = vector[name] ?? 0;
    copy[cls] = next;
  }
  return copy;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** The corpus target distribution: uniform over every label the case accepts. */
export function elementTargets(testCase: ElementEvalCase): Record<ElementClass, number> {
  const targets = { Ad: 0, Tracker: 0, Annoyance: 0, Content: 0 } as Record<ElementClass, number>;
  const accepted = testCase.expected.filter((cls) => ELEMENT_CLASSES.includes(cls));
  const share = accepted.length > 0 ? 1 / accepted.length : 0;
  for (const cls of accepted) targets[cls] = share;
  return targets;
}

/**
 * Deterministic stratified split.
 *
 * Cases are grouped by canonical label, sorted by label name, and every `holdoutEvery`-th
 * one is held out. Sorting first is what makes the split independent of corpus order —
 * appending cases never reshuffles which existing cases are held out, and no seed is
 * needed for the split to be reproducible.
 */
export function splitElementCorpus(
  cases: readonly ElementEvalCase[] = ELEMENT_EVAL_CORPUS,
  holdoutEvery = 3,
): { train: ElementEvalCase[]; holdout: ElementEvalCase[] } {
  const byClass = new Map<ElementClass, ElementEvalCase[]>();
  for (const cls of ELEMENT_CLASSES) byClass.set(cls, []);
  for (const entry of cases) {
    const bucket = byClass.get(entry.expected[0]);
    // An unlabelled or unrecognised canonical class is a corpus defect; keep it in
    // training so it can still inform the fit rather than silently vanishing.
    if (bucket) bucket.push(entry);
    else byClass.get('Content')!.push(entry);
  }

  const train: ElementEvalCase[] = [];
  const holdout: ElementEvalCase[] = [];
  const stride = Math.max(2, Math.floor(holdoutEvery));
  for (const cls of ELEMENT_CLASSES) {
    const list = [...(byClass.get(cls) ?? [])].sort((a, b) => a.label.localeCompare(b.label));
    list.forEach((entry, index) => {
      if (index % stride === 0) holdout.push(entry);
      else train.push(entry);
    });
  }
  return { train, holdout };
}

function featureValues(snapshot: ElementEvalCase['snapshot']): number[] {
  const vector = extractElementFeatures(snapshot);
  return ELEMENT_FEATURE_ORDER.map((name) => {
    const value = vector[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  });
}

interface PreparedExample {
  x: number[];
  targets: Record<ElementClass, number>;
}

function prepare(cases: readonly ElementEvalCase[]): PreparedExample[] {
  return cases.map((entry) => ({ x: featureValues(entry.snapshot), targets: elementTargets(entry) }));
}

/**
 * Fits the logistic head by full-batch Adam on soft-target cross-entropy with a Gaussian
 * prior centred on `prior`.
 *
 * Deterministic by construction: the parameters start at the prior, the optimiser state
 * starts at zero, and the examples are visited in a fixed order. Two runs on the same
 * corpus produce bit-identical weights, which is what lets the suite treat the shipped
 * table as a build artifact rather than a snapshot someone has to eyeball.
 */
export function fitElementWeights(options: ElementWeightFitOptions = {}): ElementWeightFitResult {
  const cases = options.cases ?? ELEMENT_EVAL_CORPUS;
  const prior = cloneWeightSet(options.prior ?? ELEMENT_HAND_TUNED_WEIGHTS);
  const priorStrength = Math.max(0, options.priorStrength ?? 5);
  const epochs = Math.max(0, Math.floor(options.epochs ?? 1500));
  const learningRate = options.learningRate ?? 0.05;
  const balanceClasses = options.balanceClasses !== false;

  const examples = prepare(cases);
  if (examples.length === 0) {
    return { weights: prior, trainingLoss: 0, initialLoss: 0, epochs: 0, examples: 0, priorStrength };
  }

  // Class balance: without it the 51 content cases would dominate, and Content is the
  // class the model already wins by default.
  const classCounts = new Map<ElementClass, number>();
  for (const entry of cases) {
    const cls = entry.expected[0];
    classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
  }
  const exampleWeights = cases.map((entry) => {
    if (!balanceClasses) return 1;
    const count = classCounts.get(entry.expected[0]) ?? 1;
    return cases.length / (ELEMENT_CLASSES.length * Math.max(1, count));
  });
  const totalWeight = exampleWeights.reduce((sum, value) => sum + value, 0) || 1;

  // Parameters: one vector per class, plus its bias. Regularising the bias too keeps the
  // hand-set class base rates from being thrown away by a few dozen examples.
  const weights = {} as Record<ElementClass, number[]>;
  const biases = {} as Record<ElementClass, number>;
  const priorWeights = {} as Record<ElementClass, number[]>;
  const priorBiases = {} as Record<ElementClass, number>;
  for (const cls of ELEMENT_CLASSES) {
    priorWeights[cls] = zeroVector(prior[cls]);
    priorBiases[cls] = prior[cls].bias;
    weights[cls] = [...priorWeights[cls]];
    biases[cls] = priorBiases[cls];
  }

  const mWeights: Record<ElementClass, number[]> = {} as Record<ElementClass, number[]>;
  const vWeights: Record<ElementClass, number[]> = {} as Record<ElementClass, number[]>;
  const mBiases = {} as Record<ElementClass, number>;
  const vBiases = {} as Record<ElementClass, number>;
  for (const cls of ELEMENT_CLASSES) {
    mWeights[cls] = ELEMENT_FEATURE_ORDER.map(() => 0);
    vWeights[cls] = ELEMENT_FEATURE_ORDER.map(() => 0);
    mBiases[cls] = 0;
    vBiases[cls] = 0;
  }

  const probabilities = {} as Record<ElementClass, number>;

  const meanCrossEntropy = (): number => {
    let loss = 0;
    for (let i = 0; i < examples.length; i += 1) {
      const { x, targets } = examples[i];
      let max = -Infinity;
      for (const cls of ELEMENT_CLASSES) {
        let score = biases[cls];
        const vector = weights[cls];
        for (let f = 0; f < x.length; f += 1) score += vector[f] * x[f];
        probabilities[cls] = score;
        if (score > max) max = score;
      }
      let sum = 0;
      for (const cls of ELEMENT_CLASSES) {
        const exp = Math.exp(probabilities[cls] - max);
        probabilities[cls] = exp;
        sum += exp;
      }
      let caseLoss = 0;
      for (const cls of ELEMENT_CLASSES) {
        const target = targets[cls];
        if (target === 0) continue;
        caseLoss -= target * Math.log(Math.max(probabilities[cls] / sum, PROBABILITY_FLOOR));
      }
      loss += (exampleWeights[i] / totalWeight) * caseLoss;
    }
    return loss;
  };

  const initialLoss = meanCrossEntropy();
  if (epochs === 0) {
    return {
      weights: cloneWeightSet(prior),
      trainingLoss: initialLoss,
      initialLoss,
      epochs: 0,
      examples: examples.length,
      priorStrength,
    };
  }

  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradWeights = {} as Record<ElementClass, number[]>;
    const gradBiases = {} as Record<ElementClass, number>;
    for (const cls of ELEMENT_CLASSES) {
      gradWeights[cls] = ELEMENT_FEATURE_ORDER.map(() => 0);
      gradBiases[cls] = 0;
    }

    for (let i = 0; i < examples.length; i += 1) {
      const { x, targets } = examples[i];
      const share = exampleWeights[i] / totalWeight;

      let max = -Infinity;
      for (const cls of ELEMENT_CLASSES) {
        let score = biases[cls];
        const vector = weights[cls];
        for (let f = 0; f < x.length; f += 1) score += vector[f] * x[f];
        probabilities[cls] = score;
        if (score > max) max = score;
      }
      let sum = 0;
      for (const cls of ELEMENT_CLASSES) {
        const exp = Math.exp(probabilities[cls] - max);
        probabilities[cls] = exp;
        sum += exp;
      }

      for (const cls of ELEMENT_CLASSES) {
        const error = share * (probabilities[cls] / sum - targets[cls]);
        if (error === 0) continue;
        gradBiases[cls] += error;
        const gradientRow = gradWeights[cls];
        for (let f = 0; f < x.length; f += 1) gradientRow[f] += error * x[f];
      }
    }

    // L2 toward the prior, expressed per example so `priorStrength` reads as a number of
    // labelled elements rather than an opaque coefficient.
    for (const cls of ELEMENT_CLASSES) {
      const row = gradWeights[cls];
      for (let f = 0; f < row.length; f += 1) {
        row[f] += (priorStrength / examples.length) * (weights[cls][f] - priorWeights[cls][f]);
      }
      gradBiases[cls] += (priorStrength / examples.length) * (biases[cls] - priorBiases[cls]);
    }

    const biasCorrection1 = 1 - beta1 ** (epoch + 1);
    const biasCorrection2 = 1 - beta2 ** (epoch + 1);

    for (const cls of ELEMENT_CLASSES) {
      const row = gradWeights[cls];
      for (let f = 0; f < row.length; f += 1) {
        const gradient = row[f];
        mWeights[cls][f] = beta1 * mWeights[cls][f] + (1 - beta1) * gradient;
        vWeights[cls][f] = beta2 * vWeights[cls][f] + (1 - beta2) * gradient * gradient;
        const mHat = mWeights[cls][f] / biasCorrection1;
        const vHat = vWeights[cls][f] / biasCorrection2;
        weights[cls][f] -= (learningRate * mHat) / (Math.sqrt(vHat) + epsilon);
      }
      const gradient = gradBiases[cls];
      mBiases[cls] = beta1 * mBiases[cls] + (1 - beta1) * gradient;
      vBiases[cls] = beta2 * vBiases[cls] + (1 - beta2) * gradient * gradient;
      biases[cls] -= (learningRate * (mBiases[cls] / biasCorrection1)) / (Math.sqrt(vBiases[cls] / biasCorrection2) + epsilon);
    }
  }

  const fitted = {} as ElementWeightSet;
  for (const cls of ELEMENT_CLASSES) {
    const vector = { bias: roundTo(biases[cls], WEIGHT_PRECISION) } as ElementClassWeights;
    ELEMENT_FEATURE_ORDER.forEach((name, index) => {
      vector[name] = roundTo(weights[cls][index], WEIGHT_PRECISION);
    });
    fitted[cls] = vector;
  }

  return {
    weights: fitted,
    trainingLoss: meanCrossEntropy(),
    initialLoss,
    epochs,
    examples: examples.length,
    priorStrength,
  };
}

/**
 * Scores a weight set the way the classifier would: same features, same `softmaxFor`,
 * same argmax over `ELEMENT_CLASSES`. Deliberately the shipping path rather than a
 * private copy, so a candidate cannot look better here than it behaves in production.
 */
export function weightSetMetrics(
  weights: ElementWeightSet,
  cases: readonly ElementEvalCase[],
  title = 'weights',
): ElementWeightMetrics {
  if (cases.length === 0) {
    return { title, cases: 0, logLoss: 0, brier: 0, accuracy: 0, acceptedProbability: 0 };
  }

  let logLoss = 0;
  let brier = 0;
  let correct = 0;
  let acceptedProbability = 0;

  for (const entry of cases) {
    const probabilities = softmaxFor(extractElementFeatures(entry.snapshot), weights);
    const targets = elementTargets(entry);
    const accepted = entry.expected.filter((cls) => ELEMENT_CLASSES.includes(cls));

    let caseLoss = 0;
    let caseBrier = 0;
    let acceptedMass = 0;
    for (const cls of ELEMENT_CLASSES) {
      const probability = Math.max(probabilities[cls] ?? 0, PROBABILITY_FLOOR);
      const target = targets[cls];
      if (target > 0) {
        caseLoss -= target * Math.log(probability);
        acceptedMass += probabilities[cls] ?? 0;
      }
      caseBrier += (probability - target) ** 2;
    }
    logLoss += caseLoss;
    brier += caseBrier;
    acceptedProbability += acceptedMass / Math.max(1, accepted.length);

    let best: ElementClass = 'Content';
    let bestProbability = -Infinity;
    for (const cls of ELEMENT_CLASSES) {
      const probability = probabilities[cls] ?? 0;
      if (probability > bestProbability) {
        bestProbability = probability;
        best = cls;
      }
    }
    if (accepted.includes(best)) correct += 1;
  }

  return {
    title,
    cases: cases.length,
    logLoss: roundTo(logLoss / cases.length, WEIGHT_PRECISION),
    brier: roundTo(brier / cases.length, WEIGHT_PRECISION),
    accuracy: roundTo(correct / cases.length, WEIGHT_PRECISION),
    acceptedProbability: roundTo(acceptedProbability / cases.length, WEIGHT_PRECISION),
  };
}

/**
 * Calibration of the *action* decision under a candidate weight set.
 *
 * The head's log-loss is not the only bar: the classifier multiplies its winning
 * probability into a stated confidence that the product shows the user, so a sharper
 * softmax can improve cross-entropy while making the confidence less honest. This runs
 * the candidate through the real classifier and the harness's own calibration
 * definition, so the fit is judged on the guarantee the suite already enforces.
 */
export function weightSetActionCalibration(
  weights: ElementWeightSet,
  cases: readonly ElementEvalCase[] = ELEMENT_EVAL_CORPUS,
): { ece: number; brier: number; bins: number; scored: number } {
  const classifier = new MiniAiElementClassifier({ weights });
  const pairs = cases
    .map((entry) => elementActionCalibrationPair(entry, classifier.classify(entry.snapshot)))
    .filter((pair): pair is ElementActionCalibrationPair => pair !== null);
  const { ece, brier, bins } = expectedCalibrationError(pairs);
  return { ece: roundTo(ece, WEIGHT_PRECISION), brier: roundTo(brier, WEIGHT_PRECISION), bins, scored: pairs.length };
}

/** Per-class accuracy of the head, so an average that hides a collapsed class is visible. */
function perClassAccuracy(
  weights: ElementWeightSet,
  cases: readonly ElementEvalCase[],
): Map<ElementClass, number> {
  const buckets = new Map<ElementClass, { total: number; correct: number }>();
  for (const cls of ELEMENT_CLASSES) buckets.set(cls, { total: 0, correct: 0 });

  for (const entry of cases) {
    const bucket = buckets.get(entry.expected[0]);
    if (!bucket) continue;
    bucket.total += 1;
    const probabilities = softmaxFor(extractElementFeatures(entry.snapshot), weights);
    let best: ElementClass = 'Content';
    let bestProbability = -Infinity;
    for (const cls of ELEMENT_CLASSES) {
      const probability = probabilities[cls] ?? 0;
      if (probability > bestProbability) {
        bestProbability = probability;
        best = cls;
      }
    }
    if (entry.expected.includes(best)) bucket.correct += 1;
  }

  const result = new Map<ElementClass, number>();
  for (const [cls, bucket] of buckets) {
    result.set(cls, bucket.total === 0 ? 0 : roundTo(bucket.correct / bucket.total, WEIGHT_PRECISION));
  }
  return result;
}

function argmaxClass(weights: ElementWeightSet, entry: ElementEvalCase): ElementClass {
  const probabilities = softmaxFor(extractElementFeatures(entry.snapshot), weights);
  let best: ElementClass = 'Content';
  let bestProbability = -Infinity;
  for (const cls of ELEMENT_CLASSES) {
    const probability = probabilities[cls] ?? 0;
    if (probability > bestProbability) {
      bestProbability = probability;
      best = cls;
    }
  }
  return best;
}

/**
 * The A/B the whole exercise exists for: both weight sets, the same held-out cases, and
 * the individual cases that changed hands on either side.
 */
export function compareWeightSets(
  baseline: ElementWeightSet,
  fitted: ElementWeightSet,
  cases: readonly ElementEvalCase[] = ELEMENT_EVAL_CORPUS,
): ElementWeightComparison {
  const baselineMetrics = weightSetMetrics(baseline, cases, 'hand-tuned');
  const fittedMetrics = weightSetMetrics(fitted, cases, 'fitted');
  const baselinePerClass = perClassAccuracy(baseline, cases);
  const fittedPerClass = perClassAccuracy(fitted, cases);

  const regressions: string[] = [];
  const wins: string[] = [];
  const support = new Map<ElementClass, number>();
  for (const cls of ELEMENT_CLASSES) support.set(cls, 0);

  for (const entry of cases) {
    support.set(entry.expected[0], (support.get(entry.expected[0]) ?? 0) + 1);
    const baselineRight = entry.expected.includes(argmaxClass(baseline, entry));
    const fittedRight = entry.expected.includes(argmaxClass(fitted, entry));
    if (baselineRight && !fittedRight) regressions.push(entry.label);
    if (!baselineRight && fittedRight) wins.push(entry.label);
  }

  return {
    cases: cases.length,
    baseline: baselineMetrics,
    fitted: fittedMetrics,
    logLossImprovement: roundTo(baselineMetrics.logLoss - fittedMetrics.logLoss, WEIGHT_PRECISION),
    accuracyImprovement: roundTo(fittedMetrics.accuracy - baselineMetrics.accuracy, WEIGHT_PRECISION),
    perClass: ELEMENT_CLASSES.map((cls) => ({
      label: cls,
      support: support.get(cls) ?? 0,
      baseline: baselinePerClass.get(cls) ?? 0,
      fitted: fittedPerClass.get(cls) ?? 0,
    })),
    regressions: regressions.sort(),
    wins: wins.sort(),
  };
}

/**
 * Splits the training cases into deterministic, class-stratified folds.
 *
 * Every fold holds out roughly the same proportion of each class, so no fold can be
 * scored on a validation slice that is all Content: the fold assignment is by index
 * within a class, sorted by label, with no RNG and no clock.
 */
function stratifiedFolds(cases: readonly ElementEvalCase[], foldCount: number): ElementEvalCase[][] {
  const folds: ElementEvalCase[][] = Array.from({ length: Math.max(2, foldCount) }, () => []);
  const byClass = new Map<ElementClass, ElementEvalCase[]>();
  for (const cls of ELEMENT_CLASSES) byClass.set(cls, []);
  for (const entry of cases) {
    const bucket = byClass.get(entry.expected[0]) ?? byClass.get('Content');
    bucket?.push(entry);
  }
  for (const cls of ELEMENT_CLASSES) {
    const list = [...(byClass.get(cls) ?? [])].sort((a, b) => a.label.localeCompare(b.label));
    list.forEach((entry, index) => folds[index % folds.length].push(entry));
  }
  return folds.filter((fold) => fold.length > 0);
}

/**
 * Picks the prior strength by cross-validation over the training cases.
 *
 * This is the step that keeps the held-out number honest: choosing the strength by
 * looking at held-out performance would make that performance partly a fitted quantity,
 * so the training cases are folded, the grid is scored on the held-out fold of each
 * split, and the winner is refit on all of the training cases.
 *
 * It used to score a *single* inner split of the training set, which meant each candidate
 * was fitted on ~half the cases it would finally see and validated on ~a quarter. That
 * measured the fit's starvation rather than the prior's value: an unregularised fit looked
 * catastrophic there (inner logLoss 1.18 against 0.34) while the same fit on all the
 * training cases generalised *at least as well* as any regularised one (held-out logLoss
 * 0.09 against 0.18). Folding every training case into validation removes the regime
 * change: the scored fit and the shipped fit now differ only in how much data they see,
 * and the answer is allowed to come out either way.
 */
export function selectPriorStrength(options: {
  cases?: readonly ElementEvalCase[];
  grid?: readonly number[];
  epochs?: number;
  learningRate?: number;
  /** Validation folds. More folds means less data held out per fit, and less bias. */
  folds?: number;
} = {}): { priorStrength: number; scores: Array<{ priorStrength: number; logLoss: number; accuracy: number }> } {
  const cases = options.cases ?? splitElementCorpus().train;
  const grid = options.grid ?? [0, 1, 2, 5, 10, 20, 50];
  const folds = stratifiedFolds(cases, options.folds ?? 5);

  const scores = grid.map((priorStrength) => {
    let logLoss = 0;
    let accuracy = 0;
    for (const heldOut of folds) {
      const training = cases.filter((entry) => !heldOut.includes(entry));
      const fit = fitElementWeights({
        cases: training,
        priorStrength,
        epochs: options.epochs,
        learningRate: options.learningRate,
      });
      const metrics = weightSetMetrics(fit.weights, heldOut, `prior=${priorStrength}`);
      logLoss += metrics.logLoss / folds.length;
      accuracy += metrics.accuracy / folds.length;
    }
    return {
      priorStrength,
      // Rounded so two candidates that tie to the precision the artifact keeps tie here
      // too, and the tie-break rule is deciding rather than a float nobody can see.
      logLoss: roundTo(logLoss, WEIGHT_PRECISION),
      accuracy: roundTo(accuracy, WEIGHT_PRECISION),
    };
  });

  // Lowest mean cross-validated cross-entropy wins; ties go to the stronger prior, which
  // is the more conservative choice when the data cannot tell the difference.
  let best = scores[0];
  for (const score of scores) {
    if (score.logLoss < best.logLoss) best = score;
    else if (score.logLoss === best.logLoss && score.priorStrength > best.priorStrength) best = score;
  }

  return { priorStrength: best?.priorStrength ?? 5, scores };
}

/** The single largest move away from the prior, reported so a human can sanity-check it. */
export function largestWeightChange(
  prior: ElementWeightSet,
  fitted: ElementWeightSet,
): { feature: ElementFeatureName; from: number; to: number } {
  let best: { feature: ElementFeatureName; from: number; to: number } = {
    feature: ELEMENT_FEATURE_ORDER[0],
    from: 0,
    to: 0,
  };
  let bestDelta = -1;
  for (const cls of ELEMENT_CLASSES) {
    for (const name of ELEMENT_FEATURE_ORDER) {
      const from = prior[cls][name] ?? 0;
      const to = fitted[cls][name] ?? 0;
      const delta = Math.abs(to - from);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = { feature: name, from, to };
      }
    }
  }
  return best;
}

/**
 * Renders a weight set as TypeScript source, in {@link ELEMENT_FEATURE_ORDER} order.
 * Used by `scripts/fit-element-weights.mjs` so the checked-in table is always a direct
 * transcription of a fit rather than a number anyone retyped.
 */
export function renderWeightSetSource(weights: ElementWeightSet, indent = '  '): string {
  const lines: string[] = ['{'];
  for (const cls of ELEMENT_CLASSES) {
    lines.push(`${indent}${cls}: {`);
    lines.push(`${indent}${indent}bias: ${weights[cls].bias},`);
    for (const name of ELEMENT_FEATURE_ORDER) {
      lines.push(`${indent}${indent}${name}: ${weights[cls][name] ?? 0},`);
    }
    lines.push(`${indent}},`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** Human-readable one-line summary, for scripts and test output. */
export function formatWeightFit(result: ElementWeightFitResult): string {
  return `fit ${result.examples} cases, prior ${result.priorStrength}, ${result.epochs} epochs — loss ${result.initialLoss.toFixed(4)} → ${result.trainingLoss.toFixed(4)}`;
}
