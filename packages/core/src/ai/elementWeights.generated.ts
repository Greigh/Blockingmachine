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
  "corpusCases": 117,
  "trainingCases": 77,
  "holdoutCases": 40,
  "priorStrength": 1,
  "epochs": 1500,
  "holdout": {
    "baselineAccuracy": 0.9,
    "fittedAccuracy": 0.95,
    "baselineLogLoss": 0.2528,
    "fittedLogLoss": 0.1443
  },
  "endToEnd": {
    "total": 117,
    "baselineCorrect": 117,
    "fittedCorrect": 117
  },
  "actionCalibration": {
    "baselineEce": 0.0346,
    "fittedEce": 0.0369,
    "baselineBrier": 0.003,
    "fittedBrier": 0.0033
  },
  "largestWeightChange": {
    "feature": "passiveSource",
    "from": 1.5,
    "to": 0.2187
  }
};

/** Weight vectors fit from the corpus; see {@link ELEMENT_FITTED_PROVENANCE}. */
export const ELEMENT_FITTED_WEIGHTS: ElementWeightSet = {
  Ad: {
    bias: -2.3558,
    adStrongToken: 13.5656,
    adWeakToken: 3.5074,
    trackerStrongToken: -3,
    trackerWeakToken: -1.0013,
    consentStrongMarker: -3,
    consentWeakToken: -0.5011,
    socialStrongMarker: -3,
    socialWeakToken: -0.5047,
    dataAdAttribute: 14,
    dataTrackerAttribute: -1,
    adHostMatch: 13,
    measureHostMatch: -3,
    socialHostMatch: -2,
    urlPathToken: 2.5003,
    thirdPartyFrame: 1.9746,
    passiveSource: 0.108,
    pixelGeometry: -2.0048,
    adSizeGeometry: 3.7273,
    overlayGeometry: 0.9936,
    lureText: -1,
    antiAdblockText: -2,
    ancestorAd: 4,
    contentText: -7.3506,
    semanticContainer: -5.2562,
    userTuneBias: 5,
  },
  Tracker: {
    bias: -3.3604,
    adStrongToken: -3,
    adWeakToken: -0.5003,
    trackerStrongToken: 13,
    trackerWeakToken: 3.9333,
    consentStrongMarker: -1,
    consentWeakToken: -0.3005,
    socialStrongMarker: -2,
    socialWeakToken: -0.501,
    dataAdAttribute: -2,
    dataTrackerAttribute: 4,
    adHostMatch: -3,
    measureHostMatch: 13,
    socialHostMatch: -2,
    urlPathToken: 2.5,
    thirdPartyFrame: 1.9259,
    passiveSource: 0.2187,
    pixelGeometry: 5.7493,
    adSizeGeometry: -3.0007,
    overlayGeometry: -1.0003,
    lureText: -1.5,
    antiAdblockText: -2,
    ancestorAd: 3,
    contentText: -7.0072,
    semanticContainer: -5.0002,
    userTuneBias: 5,
  },
  Annoyance: {
    bias: -1.0872,
    adStrongToken: -2,
    adWeakToken: 1.0761,
    trackerStrongToken: -3,
    trackerWeakToken: -1.0053,
    consentStrongMarker: 13,
    consentWeakToken: 2.8632,
    socialStrongMarker: 9,
    socialWeakToken: 1.1713,
    dataAdAttribute: -3,
    dataTrackerAttribute: -1,
    adHostMatch: -4.001,
    measureHostMatch: -3,
    socialHostMatch: 8,
    urlPathToken: 2,
    thirdPartyFrame: 2.0958,
    passiveSource: 0.5541,
    pixelGeometry: -2.9417,
    adSizeGeometry: -2.0339,
    overlayGeometry: 5.5382,
    lureText: 8.0004,
    antiAdblockText: 11,
    ancestorAd: 1,
    contentText: -5.7907,
    semanticContainer: -2.3336,
    userTuneBias: 5,
  },
  Content: {
    bias: 2.8033,
    adStrongToken: -11.5656,
    adWeakToken: -4.0832,
    trackerStrongToken: -8,
    trackerWeakToken: -1.9267,
    consentStrongMarker: -8,
    consentWeakToken: -1.8616,
    socialStrongMarker: -6,
    socialWeakToken: -1.1649,
    dataAdAttribute: -10,
    dataTrackerAttribute: -2,
    adHostMatch: -10,
    measureHostMatch: -9,
    socialHostMatch: -6,
    urlPathToken: -2,
    thirdPartyFrame: -0.9964,
    passiveSource: 0.6192,
    pixelGeometry: -2.8028,
    adSizeGeometry: -2.6927,
    overlayGeometry: -2.0314,
    lureText: -6.0003,
    antiAdblockText: -8,
    ancestorAd: -3,
    contentText: 9.1486,
    semanticContainer: 3.59,
    userTuneBias: -5,
  },
};
