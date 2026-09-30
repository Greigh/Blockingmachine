/**
 * GENERATED FILE — do not edit by hand.
 *
 * The element classifier's fitted weights, produced by `scripts/fit-element-weights.mjs`
 * from the labelled corpus in `elementEvalCorpus.ts`. Regenerate with:
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/fit-element-weights.mjs --write
 *
 * The provenance record below is written by the same run as the numbers, so the table
 * cannot be updated without its measurement travelling with it. The suite re-fits the
 * table and fails if the two disagree, which is what stops these values drifting from
 * the corpus that justifies them.
 */

import type { ElementWeightSet } from './elementClassifier.js';
import type { ElementWeightProvenance } from './elementWeightFitting.js';

/** How {@link ELEMENT_FITTED_WEIGHTS} was produced, and what it bought and cost. */
export const ELEMENT_FITTED_PROVENANCE: ElementWeightProvenance = {
  "corpusCases": 162,
  "trainingCases": 107,
  "holdoutCases": 55,
  "priorStrength": 1,
  "epochs": 1500,
  "holdout": {
    "baselineAccuracy": 0.8545,
    "fittedAccuracy": 0.9455,
    "baselineLogLoss": 0.6193,
    "fittedLogLoss": 0.4234
  },
  "endToEnd": {
    "total": 162,
    "baselineCorrect": 161,
    "fittedCorrect": 161
  },
  "actionCalibration": {
    "baselineEce": 0.0351,
    "fittedEce": 0.0377,
    "baselineBrier": 0.0031,
    "fittedBrier": 0.0033
  },
  "largestWeightChange": {
    "feature": "pixelGeometry",
    "from": 7,
    "to": 5.6775
  }
};

/** Weight vectors fit from the corpus; see {@link ELEMENT_FITTED_PROVENANCE}. */
export const ELEMENT_FITTED_WEIGHTS: ElementWeightSet = {
  Ad: {
    bias: -2.2704,
    adStrongToken: 13.5435,
    adWeakToken: 3.4674,
    trackerStrongToken: -3,
    trackerWeakToken: -1.0021,
    consentStrongMarker: -3,
    consentWeakToken: -0.5013,
    socialStrongMarker: -3,
    socialWeakToken: -0.5127,
    dataAdAttribute: 14,
    dataTrackerAttribute: -1,
    adHostMatch: 13,
    measureHostMatch: -3,
    socialHostMatch: -2,
    urlPathToken: 2.499,
    thirdPartyFrame: 1.8479,
    passiveSource: 0.3136,
    pixelGeometry: -2.0108,
    adSizeGeometry: 4.0438,
    overlayGeometry: 0.9857,
    lureText: -1,
    antiAdblockText: -2,
    ancestorAd: 4,
    contentText: -7.3715,
    semanticContainer: -5.2935,
    userTuneBias: 5,
  },
  Tracker: {
    bias: -3.5212,
    adStrongToken: -3,
    adWeakToken: -0.5004,
    trackerStrongToken: 13,
    trackerWeakToken: 3.9158,
    consentStrongMarker: -1,
    consentWeakToken: -0.3005,
    socialStrongMarker: -2,
    socialWeakToken: -0.5037,
    dataAdAttribute: -2,
    dataTrackerAttribute: 4,
    adHostMatch: -3,
    measureHostMatch: 12.9943,
    socialHostMatch: -2,
    urlPathToken: 2.5099,
    thirdPartyFrame: 2.0953,
    passiveSource: 0.5551,
    pixelGeometry: 5.6775,
    adSizeGeometry: -3.0005,
    overlayGeometry: -1.0006,
    lureText: -1.5,
    antiAdblockText: -2,
    ancestorAd: 3,
    contentText: -7.0092,
    semanticContainer: -5.0002,
    userTuneBias: 5,
  },
  Annoyance: {
    bias: -0.48,
    adStrongToken: -2,
    adWeakToken: 1.0391,
    trackerStrongToken: -3,
    trackerWeakToken: -1.0145,
    consentStrongMarker: 13,
    consentWeakToken: 2.7596,
    socialStrongMarker: 9,
    socialWeakToken: 1.1104,
    dataAdAttribute: -3.0014,
    dataTrackerAttribute: -1.0011,
    adHostMatch: -4,
    measureHostMatch: -3,
    socialHostMatch: 8,
    urlPathToken: 1.9988,
    thirdPartyFrame: 1.7728,
    passiveSource: 0.1314,
    pixelGeometry: -3.1802,
    adSizeGeometry: -2.0231,
    overlayGeometry: 5.1253,
    lureText: 8.0034,
    antiAdblockText: 11,
    ancestorAd: 1,
    contentText: -5.7458,
    semanticContainer: -2.2141,
    userTuneBias: 5,
  },
  Content: {
    bias: 2.2717,
    adStrongToken: -11.5434,
    adWeakToken: -4.0061,
    trackerStrongToken: -8,
    trackerWeakToken: -1.8992,
    consentStrongMarker: -8,
    consentWeakToken: -1.7578,
    socialStrongMarker: -6,
    socialWeakToken: -1.094,
    dataAdAttribute: -10,
    dataTrackerAttribute: -2,
    adHostMatch: -10,
    measureHostMatch: -9,
    socialHostMatch: -6,
    urlPathToken: -2.0076,
    thirdPartyFrame: -0.716,
    passiveSource: 0.4999,
    pixelGeometry: -2.4866,
    adSizeGeometry: -3.0221,
    overlayGeometry: -1.6104,
    lureText: -6.0034,
    antiAdblockText: -8,
    ancestorAd: -3,
    contentText: 9.1265,
    semanticContainer: 3.5078,
    userTuneBias: -5,
  },
};
