/**
 * GENERATED FILE — do not edit by hand.
 *
 * The classifier vocabulary derived from the shipped static tiers, produced by
 * `scripts/derive-tier-vocabulary.mjs`. Regenerate with:
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/derive-tier-vocabulary.mjs --write
 *
 * Every token here names a host the tiers already ship and the model could not place, and
 * the evidence record below says which host justified which token. `tier_security` is
 * deliberately absent as a source: its contents are the model's own verdicts, so learning
 * from it would teach the classifier the answers it is graded on.
 *
 * The suite re-derives this file and fails if the two disagree, which is what keeps a
 * generated vocabulary from quietly becoming a hand-maintained one.
 */

import type {
  TierVocabularyEvidence,
  TierVocabularyProvenance,
  TierVocabularyRejection,
} from './tierVocabularyDerivation.js';

/** How this vocabulary was derived, and what the independent corpus said about it. */
export const TIER_VOCABULARY_PROVENANCE: TierVocabularyProvenance =
{
  "tiers": [
    {
      "tier": "tier_core",
      "hosts": 24,
      "unplaceable": 0
    },
    {
      "tier": "tier_ads",
      "hosts": 36,
      "unplaceable": 12
    },
    {
      "tier": "tier_privacy",
      "hosts": 36,
      "unplaceable": 11
    },
    {
      "tier": "tier_annoyances",
      "hosts": 22,
      "unplaceable": 22
    }
  ],
  "hostsRead": 118,
  "seedVocabulary": {
    "adTokens": 112,
    "trackerTokens": 97,
    "consentTokens": 22
  },
  "seedsConsidered": 45,
  "acceptedTokens": 42,
  "rejectedHosts": 3,
  "corpusRefusals": 0,
  "apexRefusals": 1,
  "corpus": {
    "total": 216,
    "lexicalCases": 88,
    "accuracy": 0.9907,
    "macroF1": 0.9034,
    "falsePositives": 0,
    "coverageGaps": 2,
    "baselineAccuracy": 0.9769,
    "baselineMacroF1": 0.882,
    "baselineFalsePositives": 0,
    "baselineCoverageGaps": 4
  },
  "gate": "passed: 0/122 clean domains flagged, accuracy 0.9907, macro F1 0.9034, coverage gaps 2"
}
;

/** Vendors the tiers carry whose names read as advertising to the classifier. */
export const TIER_DERIVED_AD_TOKENS: readonly string[] = 
[
  '33across',
  'adcash',
  'brightcom',
  'juicyads',
  'lijit',
  'magnite',
  'mopub',
  'sonobi',
  'stickyadstv',
  'supersonicads',
  'tremorhub',
  'zemanta',
]
;

/** Vendors the tiers carry whose names read as measurement to the classifier. */
export const TIER_DERIVED_TRACKER_TOKENS: readonly string[] = 
[
  'abtasty',
  'addthis',
  'addtoany',
  'clicktale',
  'comscore',
  'dynamicyield',
  'imrworldwide',
  'kameleoon',
  'nielsen',
  'sharethis',
]
;

/** Vendors the annoyance tier carries whose names read as consent-management or annoyance platforms. */
export const TIER_DERIVED_CONSENT_TOKENS: readonly string[] = 
[
  'cookiebot',
  'cookielaw',
  'foxpush',
  'getsitecontrol',
  'hellobar',
  'iubenda',
  'izooto',
  'justuno',
  'onetrust',
  'optimonk',
  'osano',
  'popupsmart',
  'privacy-mgmt',
  'pushengage',
  'quantcast',
  'sendpulse',
  'sleeknote',
  'termly',
  'webpushr',
  'wisepops',
]
;

/** Which host justified which token, and the family it places that host in. */
export const TIER_VOCABULARY_EVIDENCE: readonly TierVocabularyEvidence[] =
[
  {
    "token": "33across",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "33across.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "abtasty",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "abtasty.com"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "adcash",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "adcash.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "addthis",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "addthis.com"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "addtoany",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "addtoany.com"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "brightcom",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "brightcom.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "clicktale",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "clicktale.net"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "comscore",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "comscore.com"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "cookiebot",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "cookiebot.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "cookielaw",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "cookielaw.org"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "dynamicyield",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "dynamicyield.com"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "foxpush",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "foxpush.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "getsitecontrol",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "getsitecontrol.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "hellobar",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "hellobar.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "imrworldwide",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "imrworldwide.com"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "iubenda",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "iubenda.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "izooto",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "izooto.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "juicyads",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "juicyads.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "justuno",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "justuno.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "kameleoon",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "kameleoon.eu"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "lijit",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "lijit.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "magnite",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "magnite.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "mopub",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "mopub.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "nielsen",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "nielsen.com"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "onetrust",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "onetrust.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "optimonk",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "optimonk.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "osano",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "osano.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "popupsmart",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "popupsmart.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "privacy-mgmt",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "privacy-mgmt.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "pushengage",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "pushengage.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "quantcast",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "quantcast.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "sendpulse",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "sendpulse.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "sharethis",
    "vocabulary": "tracker",
    "tier": "tier_privacy",
    "hosts": [
      "sharethis.com"
    ],
    "family": "Telemetry/Analytics"
  },
  {
    "token": "sleeknote",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "sleeknote.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "sonobi",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "sonobi.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "stickyadstv",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "stickyadstv.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "supersonicads",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "supersonicads.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "termly",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "termly.io"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "tremorhub",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "tremorhub.com"
    ],
    "family": "Advertising"
  },
  {
    "token": "webpushr",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "webpushr.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "wisepops",
    "vocabulary": "consent",
    "tier": "tier_annoyances",
    "hosts": [
      "wisepops.com"
    ],
    "family": "Consent/Annoyance"
  },
  {
    "token": "zemanta",
    "vocabulary": "ad",
    "tier": "tier_ads",
    "hosts": [
      "zemanta.com"
    ],
    "family": "Advertising"
  }
]
;

/**
 * Hosts in the disagreement set that no token could place, with every attempt recorded.
 *
 * This is the machine-written form of the pin the agreement suite used to document in prose:
 * a host listed here is one the tiers ship, the model does not recognise, and the vocabulary
 * cannot honestly fix — because the model is configured to trust it, or because no label of
 * its name survives the vocabulary rules.
 */
export const TIER_VOCABULARY_REJECTIONS: readonly TierVocabularyRejection[] =
[
  {
    "tier": "tier_privacy",
    "host": "business-api.tiktok.com",
    "reason": "the only candidates that moved this host were bare labels the tier could not attest",
    "attempts": [
      {
        "token": "tiktok",
        "vocabulary": "tracker",
        "present": false,
        "family": "Clean"
      },
      {
        "token": "tiktok",
        "vocabulary": "ad",
        "present": false,
        "family": "Advertising",
        "attestation": "refused: 'tiktok' is a bare label naming tiktok.com, which tier_privacy did not list — a subdomain row cannot attest the whole brand"
      }
    ]
  },
  {
    "tier": "tier_annoyances",
    "host": "onesignal.com",
    "reason": "no candidate token moved this host into a family the tier may be called",
    "attempts": [
      {
        "token": "onesignal",
        "vocabulary": "consent",
        "present": false,
        "family": "Telemetry/Analytics"
      }
    ]
  },
  {
    "tier": "tier_annoyances",
    "host": "privy.com",
    "reason": "no candidate label survived the vocabulary rules (too short, generic, or a function word)",
    "attempts": []
  }
]
;
