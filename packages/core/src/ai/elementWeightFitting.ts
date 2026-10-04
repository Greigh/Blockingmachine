/**
 * Fitting the element classifier's weights from the labelled corpus.
 *
 * The classifier's statistical head is a linear model over 26 evidence features feeding
 * a softmax; {@link ELEMENT_HAND_TUNED_WEIGHTS} was written by hand and never measured
 * against an alternative. This module replaces guesswork with a fit, and — more
 * importantly — makes the replacement *checkable*:
 *
 *  1. **The corpus is split, once, deterministically.** {@link splitElementCorpus}
 *     stratifies by canonical label and takes every *k*-th case, so the held-out set is
 *     a fixed property of the corpus rather than something a run chooses.
 *  2. **The selection set is not the test set.** The choice that matters — which
 *     regulariser, and for the prior kind at what strength — is chosen by
 *     cross-validation over the *training* cases ({@link selectRegularisation}), never
 *     on the held-out cases that the claim rests on.
 *  3. **Both sets are scored through the shipping code path.** {@link weightSetMetrics}
 *     behaves like the classifier: same feature extraction, same `softmaxFor`, same
 *     argmax. {@link compareWeightSets} reports the delta and names the individual cases
 *     that changed hands, so a win that is really two trades is visible as such.
 *
 * The selection chooses among regularisation kinds, not only prior strengths — flag 12's
 * charge was that the prior shipped unevidenced, having never faced a regulariser of a
 * different kind, so the grid carries an **early-stop** candidate (unregularised Adam
 * halted at the checkpoint a deterministic inner validation slice liked best) beside the
 * bare fit and the prior sweep. For three corpus rounds `prior:1` won that selection —
 * a regulariser had to beat the unregularised head on ~116 training elements per fold,
 * and the margin shrank corpus round over corpus round (25×, 3.5×, 1.9×, 1.11×, 1.09×).
 * At 230 cases the margin inverted: **`none` leads the folds outright** — 0.7721 against
 * early stopping's 0.8843 and prior:1's 0.9330 — so the shipped table is, for the first
 * time since flag 12, the unregularised fit. The machinery did not change; the evidence
 * did. A later corpus can move the answer back, and the suite pins the ordering so the
 * move would be loud.
 *
 * On the 78 held-out cases the shipped table leads the hand-tuned one on both head
 * metrics — accuracy 0.8462 → **0.9615**, cross-entropy 0.6446 → **0.2540** — and the
 * honest comparison is now against the strongest shrinkage candidate the grid offers,
 * since the bare fit *is* the shipped head. Measured against prior:1 on the same holdout:
 * 75 of 78 against 72 of 78 on accuracy (all three separating cases go the bare head's
 * way), cross-entropy 0.2623 against 0.2905, Brier 0.1085 against 0.1138. The tail the
 * prior existed to protect did not need it: the unregularised head's deepest accepted-
 * probability case is 0.1605, while the prior:1 fit itself puts `app-install-banner` at
 * 0.0488 — the shrinkage manufactures the nearest thing to a floor case either head has.
 * What the prior still buys, recorded so the account is not only negative: it puts more
 * probability on accepted labels on average (0.8615 against 0.8209), the conservative
 * behaviour a prior is for, and pays for it with three held-out Content cases read as
 * threats.
 *
 * The cost of the sharper head is recorded, not hidden: fitted ECE reads 0.065 against
 * the hand-tuned 0.0495 — the flag-9 corpus's new suggest-banded cases sit in the
 * mid-confidence bins where ECE is most sensitive — at essentially flat Brier (0.0408
 * against 0.0406). `element-weights-fit.test.ts` pins every measurement above, so the
 * note and the numbers cannot drift apart silently.
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
  'cnameCloak',
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
   * see the module note on why 104 parameters from 107 elements needs a centre.
   */
  priorStrength?: number;
  /**
   * Early stopping, the alternative regulariser open flag 12 asked the selection to try:
   * instead of pulling the fit toward a prior centre, halt it the moment a held-out
   * validation slice stops improving and keep the best checkpoint seen.
   *
   * `validation` defaults to a deterministic ~1/5 stratified slice of `cases` — the same
   * stride split {@link splitElementCorpus} uses — carved *before* fitting, so the cases
   * that decide when to stop are never trained on. Inside `selectRegularisation`'s folds
   * that means each early-stopped fit is nested two levels in from the held-out set the
   * claim rests on; there is no path by which those cases can decide the stopping point.
   */
  earlyStop?: {
    /** Cases monitored for improvement. Defaults to an inner split of `cases`. */
    validation?: readonly ElementEvalCase[];
    /** Score the validation set this often, in epochs. Defaults to 25. */
    every?: number;
    /** Stop after this many consecutive non-improving checks. Defaults to 4. */
    patience?: number;
  };
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
  /**
   * When `earlyStop` ran, the epoch whose validation loss produced the returned weights —
   * always below `epochs` when stopping fired. Absent means the full schedule ran.
   */
  stoppedAtEpoch?: number;
  /** When `earlyStop` ran, how many cases the stopping decision was read from. */
  validationCases?: number;
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
  /**
   * What cross-validation over the training cases chose, stated by kind so the record
   * cannot pretend a stopped fit was pulled by a prior or vice versa. `prior` carries
   * its strength in average-examples; `early-stop` carries the epoch whose checkpoint
   * shipped.
   */
  regularisation:
    | { kind: 'none' }
    | { kind: 'prior'; strength: number }
    | { kind: 'early-stop'; stoppedAtEpoch: number };
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
  const allCases = options.cases ?? ELEMENT_EVAL_CORPUS;
  const prior = cloneWeightSet(options.prior ?? ELEMENT_HAND_TUNED_WEIGHTS);
  const priorStrength = Math.max(0, options.priorStrength ?? 5);
  const epochs = Math.max(0, Math.floor(options.epochs ?? 1500));
  const learningRate = options.learningRate ?? 0.05;
  const balanceClasses = options.balanceClasses !== false;
  const earlyStop = options.earlyStop;
  const stopEvery = Math.max(1, Math.floor(earlyStop?.every ?? 25));
  const stopPatience = Math.max(1, Math.floor(earlyStop?.patience ?? 4));

  // When early stopping runs, the cases that decide when to stop are carved out before
  // fitting — a default inner split when none is given, and an explicit set is filtered
  // out of the training cases so a monitored case is never also an example.
  let cases = allCases;
  let validation: readonly ElementEvalCase[] | undefined;
  if (earlyStop) {
    if (earlyStop.validation) {
      validation = earlyStop.validation;
      cases = allCases.filter((entry) => !validation!.includes(entry));
    } else {
      const inner = splitElementCorpus(allCases, 5);
      cases = inner.train;
      validation = inner.holdout;
    }
  }

  const examples = prepare(cases);
  const validationExamples = prepare(validation ?? []);
  if (examples.length === 0) {
    return {
      weights: prior,
      trainingLoss: 0,
      initialLoss: 0,
      epochs: 0,
      examples: 0,
      priorStrength,
      stoppedAtEpoch: earlyStop ? 0 : undefined,
      validationCases: validationExamples.length || undefined,
    };
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

  /** Plain mean cross-entropy on the validation slice — the same quantity the folds score. */
  const meanValidationLoss = (): number => {
    if (validationExamples.length === 0) return Infinity;
    let loss = 0;
    for (const { x, targets } of validationExamples) {
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
        const target = targets[cls];
        if (target === 0) continue;
        loss -= target * Math.log(Math.max(probabilities[cls] / sum, PROBABILITY_FLOOR));
      }
    }
    return loss / validationExamples.length;
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
      stoppedAtEpoch: earlyStop ? 0 : undefined,
      validationCases: validationExamples.length || undefined,
    };
  }

  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;

  // Early stopping keeps the best checkpoint *seen*, scored at `stopEvery` intervals
  // starting from the untrained prior — a fit that only makes validation worse restores
  // epoch 0 rather than the least-bad drifted state.
  let bestValidationLoss = earlyStop ? meanValidationLoss() : Infinity;
  let bestEpoch = 0;
  let bestWeights: Record<ElementClass, number[]> | undefined;
  let bestBiases: Record<ElementClass, number> | undefined;
  let misses = 0;
  let stoppedAt = epochs;
  const checkpoint = (): void => {
    bestWeights = {} as Record<ElementClass, number[]>;
    bestBiases = {} as Record<ElementClass, number>;
    for (const cls of ELEMENT_CLASSES) {
      bestWeights[cls] = [...weights[cls]];
      bestBiases[cls] = biases[cls];
    }
  };
  if (earlyStop) checkpoint();

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

    if (earlyStop && ((epoch + 1) % stopEvery === 0 || epoch === epochs - 1)) {
      const loss = meanValidationLoss();
      if (loss < bestValidationLoss) {
        bestValidationLoss = loss;
        bestEpoch = epoch + 1;
        checkpoint();
        misses = 0;
      } else {
        misses += 1;
        if (misses >= stopPatience) break;
      }
    }
  }

  // `stoppedAtEpoch` reports the checkpoint whose weights ship — where validation was
  // best — not merely where the loop happened to notice the stall.
  if (earlyStop && bestWeights && bestBiases) {
    for (const cls of ELEMENT_CLASSES) {
      weights[cls] = bestWeights[cls];
      biases[cls] = bestBiases[cls];
    }
    stoppedAt = bestEpoch;
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
    stoppedAtEpoch: earlyStop ? stoppedAt : undefined,
    validationCases: validationExamples.length || undefined,
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
 * A regularisation candidate the selection can score. `prior` pulls every step back
 * toward the hand-tuned centre by `strength` pseudo-examples; `early-stop` runs without a
 * prior and instead keeps the checkpoint a carved-out validation slice liked best;
 * `none` is the unregularised baseline every candidate has to beat.
 *
 * Open flag 12 asked the selection to stop choosing *between prior strengths* — a family
 * whose measured value had shrunk to a tie — and choose between regularisers. The fold
 * machinery, the held-out rule and the deterministic splits are unchanged; the grid is
 * what grew a second kind.
 */
export type ElementRegularisation =
  | { kind: 'none' }
  | { kind: 'prior'; strength: number }
  | { kind: 'early-stop' };

/** The candidates the shipped fit is chosen between, in scoring order. */
export const ELEMENT_REGULARISATION_GRID: readonly ElementRegularisation[] = [
  { kind: 'none' },
  { kind: 'early-stop' },
  { kind: 'prior', strength: 1 },
  { kind: 'prior', strength: 2 },
  { kind: 'prior', strength: 5 },
  { kind: 'prior', strength: 10 },
  { kind: 'prior', strength: 20 },
  { kind: 'prior', strength: 50 },
];

/** Short label for a candidate, used in reports and the run log. */
export function formatRegularisation(regularisation: ElementRegularisation): string {
  if (regularisation.kind === 'prior') return `prior:${regularisation.strength}`;
  return regularisation.kind;
}

const fitOptionsFor = (
  regularisation: ElementRegularisation,
): Pick<ElementWeightFitOptions, 'priorStrength' | 'earlyStop'> =>
  regularisation.kind === 'prior'
    ? { priorStrength: regularisation.strength }
    : regularisation.kind === 'early-stop'
      ? { priorStrength: 0, earlyStop: {} }
      : { priorStrength: 0 };

/**
 * How conservative a candidate is when the data cannot separate it from another —
 * the tie-break ordering. Early stopping ships the least-drifted good checkpoint it
 * measured, a stronger prior pulls harder toward the hand-tuned centre, and no
 * regularisation is the least constrained fit. On a cross-entropy tie the order decides;
 * ties are rare and the rule is stated so nobody reads meaning into a float.
 */
const conservatism = (regularisation: ElementRegularisation): number =>
  regularisation.kind === 'early-stop'
    ? Number.POSITIVE_INFINITY
    : regularisation.kind === 'prior'
      ? regularisation.strength
      : 0;

/**
 * Picks the regularisation by cross-validation over the training cases.
 *
 * This is the step that keeps the held-out number honest: choosing the candidate by
 * looking at held-out performance would make that performance partly a fitted quantity,
 * so the training cases are folded, the grid is scored on the held-out fold of each
 * split, and the winner is refit on all of the training cases. An `early-stop` candidate
 * never monitors the fold it is scored on — its stopping signal comes from an inner
 * split the fit carves for itself, so the nesting holds at every level.
 *
 * It used to score a *single* inner split of the training set, which meant each candidate
 * was fitted on ~half the cases it would finally see and validated on ~a quarter. That
 * measured the fit's starvation rather than the regulariser's value: an unregularised fit
 * looked catastrophic there (inner logLoss 1.18 against 0.34) while the same fit on all
 * the training cases generalised *at least as well* as any regularised one (held-out
 * logLoss 0.09 against 0.18). Folding every training case into validation removes the
 * regime change: the scored fit and the shipped fit now differ only in how much data they
 * see, and the answer is allowed to come out either way.
 */
export function selectRegularisation(options: {
  cases?: readonly ElementEvalCase[];
  candidates?: readonly ElementRegularisation[];
  epochs?: number;
  learningRate?: number;
  /** Validation folds. More folds means less data held out per fit, and less bias. */
  folds?: number;
} = {}): {
  regularisation: ElementRegularisation;
  scores: Array<{ regularisation: ElementRegularisation; logLoss: number; accuracy: number }>;
} {
  const cases = options.cases ?? splitElementCorpus().train;
  const candidates = options.candidates ?? ELEMENT_REGULARISATION_GRID;
  const folds = stratifiedFolds(cases, options.folds ?? 5);

  const scores = candidates.map((regularisation) => {
    let logLoss = 0;
    let accuracy = 0;
    for (const heldOut of folds) {
      const training = cases.filter((entry) => !heldOut.includes(entry));
      const fit = fitElementWeights({
        cases: training,
        ...fitOptionsFor(regularisation),
        epochs: options.epochs,
        learningRate: options.learningRate,
      });
      const metrics = weightSetMetrics(fit.weights, heldOut, formatRegularisation(regularisation));
      logLoss += metrics.logLoss / folds.length;
      accuracy += metrics.accuracy / folds.length;
    }
    return {
      regularisation,
      // Rounded so two candidates that tie to the precision the artifact keeps tie here
      // too, and the tie-break rule is deciding rather than a float nobody can see.
      logLoss: roundTo(logLoss, WEIGHT_PRECISION),
      accuracy: roundTo(accuracy, WEIGHT_PRECISION),
    };
  });

  // Lowest mean cross-validated cross-entropy wins; ties go to the more conservative
  // candidate, the choice that changes the table least when the data cannot separate them.
  let best = scores[0];
  for (const score of scores) {
    if (score.logLoss < best.logLoss) best = score;
    else if (
      score.logLoss === best.logLoss &&
      conservatism(score.regularisation) > conservatism(best.regularisation)
    ) {
      best = score;
    }
  }

  return { regularisation: best?.regularisation ?? { kind: 'prior', strength: 5 }, scores };
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
  const regularisation =
    result.stoppedAtEpoch !== undefined
      ? `early-stop @ epoch ${result.stoppedAtEpoch} on ${result.validationCases} validation cases`
      : `prior ${result.priorStrength}`;
  return `fit ${result.examples} cases, ${regularisation}, ${result.epochs} epochs — loss ${result.initialLoss.toFixed(4)} → ${result.trainingLoss.toFixed(4)}`;
}
