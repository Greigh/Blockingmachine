import { calculateShannonEntropy, decomposeDomain } from './entropy.js';
import type {
  AiVerdict,
  MiniAiFeatureContribution,
  MiniAiPrediction,
  RiskLevel,
  ThreatCategory,
} from './types.js';

/**
 * Top natural English character trigrams used for perplexity evaluation.
 * Machine-generated (DGA) domains have drastically lower trigram familiarity.
 */
const COMMON_TRIGRAMS = new Set([
  'the', 'and', 'ing', 'ion', 'tio', 'ent', 'ati', 'for', 'ter', 'com',
  'pro', 'con', 'ver', 'all', 'app', 'sta', 'res', 'ser', 'out', 'new',
  'web', 'lin', 'int', 'sys', 'gen', 'str', 'col', 'tra', 'net', 'dev',
  'api', 'hub', 'box', 'doc', 'art', 'dat', 'dig', 'map', 'log', 'dns',
  'pay', 'sec', 'cdn', 'med', 'off', 'lan', 'car', 'cit', 'inf', 'vid',
]);

const SUSPICIOUS_AD_TOKENS = new Set([
  'ad', 'ads', 'adserver', 'adservice', 'adnxs', 'adform', 'adtech',
  'doubleclick', 'googleadservices', 'googlesyndication', 'moatads', 'amazon-adsystem',
  'bid', 'bidder', 'bidding', 'rtb', 'dsp', 'ssp', 'exchange',
  'popunder', 'popcash', 'propeller', 'outbrain', 'taboola', 'mgid',
  'revcontent', 'criteo', 'pubmatic', 'rubiconproject', 'openx', 'casalemedia', 'smartadserver',
  'adsystem', 'adtrack', 'advert', 'advertising', 'adzerk', 'adblade',
]);

const SUSPICIOUS_TRACKER_TOKENS = new Set([
  'pixel', 'beacon', 'collect', 'telemetry', 'analytics', 'tracker', 'tracking',
  'click', 'conversion', 'attribution', 'affiliate', 'stat', 'stats', 'counter',
  'scorecardresearch', 'quantserve', 'branch', 'appsflyer', 'adjust', 'mixpanel',
  'segment', 'amplitude', 'sentry', 'datadoghq', 'hotjar', 'fullstory',
  'clarity', 'mouseflow', 'optimizely', 'newrelic', 'heapanalytics',
]);

const HIGH_ABUSE_TLDS = new Set([
  'top', 'xyz', 'buzz', 'click', 'fit', 'rest', 'tk', 'cf', 'gq', 'ml', 'ga',
  'work', 'cam', 'surf', 'loan', 'racing', 'icu', 'gdn', 'vip', 'monster',
]);

const KNOWN_SAFE_INFRASTRUCTURE = new Set([
  'github.com', 'githubassets.com', 'githubusercontent.com',
  'cloudflare.com', 'cloudflare.net', 'cdnjs.cloudflare.com',
  'jsdelivr.net', 'unpkg.com', 'googleapis.com', 'gstatic.com',
  'google.com', 'accounts.google.com', 'apple.com', 'appleid.apple.com',
  'icloud.com', 'microsoft.com', 'microsoftonline.com', 'live.com',
  'windowsupdate.com', 'amazon.com', 'amazonaws.com', 'aws.amazon.com',
  'wikipedia.org', 'wikimedia.org', 'mozilla.org', 'mozilla.net',
  'one.one.one.one', 'dns.google',
]);

const HIGH_PROFILE_BRANDS = [
  'paypal', 'google', 'apple', 'microsoft', 'amazon', 'netflix', 'github',
  'chase', 'bankofamerica', 'wellsfargo', 'facebook', 'instagram', 'dropbox',
  'coinbase', 'binance', 'steam', 'twitter', 'discord', 'roblox',
];

function computeLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

export interface DomainFeatureVector {
  entropyFull: number;
  entropySld: number;
  entropySubdomain: number;
  domainLength: number;
  sldLength: number;
  subdomainDepth: number;
  vowelRatio: number;
  consonantRatio: number;
  digitRatio: number;
  consecutiveConsonants: number;
  consecutiveDigits: number;
  hexScore: number;
  trigramPerplexity: number;
  adKeywordWeight: number;
  trackerKeywordWeight: number;
  cnameKnownTracker: number;
  cnameExternal: number;
  cnameDepth: number;
  knownSafeInfra: number;
  highRiskTld: number;
  punycode: number;
  hyphenRatio: number;
  syllableCadence: number;
  numericSubdomain: number;
  userTuneBias: number;
  brandSpoofScore: number;
}

/**
 * Extracts 25 numerical features for domain threat classification.
 * @beta
 */
export function extractDomainFeatures(
  domain: string,
  context?: {
    cnames?: string[];
    hasCnameCloaking?: boolean;
    knownTrackerTarget?: string;
    allowlist?: string[];
    userFeedbackBias?: number; // -1.0 to +1.0
  },
): DomainFeatureVector {
  const clean = domain.toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const parts = clean.split('.').filter(Boolean);
  const decomposition = decomposeDomain(clean);

  const sld = decomposition.sld || clean;
  const subdomains = decomposition.subdomains;
  const tld = decomposition.tld;

  // 1. Entropies (normalized 0.0 to 1.0)
  const rawEntropyFull = calculateShannonEntropy(clean);
  const rawEntropySld = calculateShannonEntropy(sld);
  const subdomainStr = subdomains.join('.');
  const rawEntropySubdomain = subdomainStr ? calculateShannonEntropy(subdomainStr) : 0;

  // Typical English words are ~2.5 - 2.8. DGA / trackers exceed 3.5 - 4.2.
  const entropyFull = Math.max(0, Math.min(1.0, (rawEntropyFull - 2.8) / 1.4));
  const entropySld = Math.max(0, Math.min(1.0, (rawEntropySld - 2.8) / 1.4));
  const entropySubdomain = rawEntropySubdomain ? Math.max(0, Math.min(1.0, (rawEntropySubdomain - 2.8) / 1.4)) : 0;

  // 2. Structural Lengths
  const domainLength = Math.min(1.0, clean.length / 60);
  const sldLength = Math.min(1.0, sld.length / 35);
  const subdomainDepth = Math.min(1.0, subdomains.length / 4);

  // 3. Character Distributions
  const lettersOnly = clean.replace(/[^a-z]/g, '');
  const totalLetters = lettersOnly.length || 1;
  const vowels = (lettersOnly.match(/[aeiou]/g) || []).length;
  const consonants = totalLetters - vowels;
  const vowelRatio = vowels / totalLetters;
  const consonantRatio = consonants / totalLetters;

  const totalChars = clean.replace(/\./g, '').length || 1;
  const digits = (clean.match(/\d/g) || []).length;
  const digitRatio = digits / totalChars;

  // 4. Consecutive Runs
  const maxConsonants = Math.max(
    0,
    ...(clean.match(/[bcdfghjklmnpqrstvwxyz]+/g) || []).map((m) => m.length),
  );
  // Consonant runs <= 3 are standard English ("str", "sch"). >= 5 is anomalous/DGA.
  const consecutiveConsonants = Math.min(1.0, Math.max(0, maxConsonants - 3) / 5);

  const maxDigits = Math.max(
    0,
    ...(clean.match(/\d+/g) || []).map((m) => m.length),
  );
  const consecutiveDigits = Math.min(1.0, maxDigits / 8);

  // 5. Hex & Hash Detection
  const hasHexLabel = parts.some((p) => p.length >= 16 && /^[a-f0-9]+$/i.test(p));
  const hexScore = hasHexLabel ? 1.0 : 0.0;

  // 6. Trigram Perplexity (Natural Language Naturalness)
  let familiarTrigrams = 0;
  let totalTrigrams = 0;
  if (sld.length >= 3) {
    for (let i = 0; i <= sld.length - 3; i++) {
      totalTrigrams++;
      if (COMMON_TRIGRAMS.has(sld.slice(i, i + 3))) {
        familiarTrigrams++;
      }
    }
  }
  // Low ratio of familiar trigrams in a long label indicates high perplexity (unnatural/DGA)
  const trigramFamiliarity = totalTrigrams > 0 ? familiarTrigrams / totalTrigrams : 0.5;
  const trigramPerplexity = sld.length >= 8 ? 1.0 - trigramFamiliarity : 0.2;

  // 7. Keyword Matching
  let adKeywordWeight = 0;
  for (const token of SUSPICIOUS_AD_TOKENS) {
    if (token.length >= 4) {
      if (clean.includes(token)) adKeywordWeight += 0.5;
    } else {
      const regex = new RegExp(`(?:^|[.-])${token}(?:[.-]|$)`, 'i');
      if (regex.test(clean)) adKeywordWeight += 0.4;
    }
  }
  adKeywordWeight = Math.min(1.5, adKeywordWeight);

  let trackerKeywordWeight = 0;
  for (const token of SUSPICIOUS_TRACKER_TOKENS) {
    if (token.length >= 4) {
      if (clean.includes(token)) trackerKeywordWeight += 0.5;
    } else {
      const regex = new RegExp(`(?:^|[.-])${token}(?:[.-]|$)`, 'i');
      if (regex.test(clean)) trackerKeywordWeight += 0.4;
    }
  }
  trackerKeywordWeight = Math.min(1.5, trackerKeywordWeight);

  // 8. CNAME Cloaking Flags
  const cnameKnownTracker = context?.knownTrackerTarget ? 1.0 : 0.0;
  const cnameExternal = context?.hasCnameCloaking ? 1.0 : 0.0;
  const cnameDepth = Math.min(1.0, (context?.cnames?.length || 0) / 4);

  // 9. Safe Infrastructure Check
  let isSafe = false;
  if (context?.allowlist && context.allowlist.length > 0) {
    isSafe = context.allowlist.some((al) => clean === al.toLowerCase() || clean.endsWith(`.${al.toLowerCase()}`));
  }
  if (!isSafe && (KNOWN_SAFE_INFRASTRUCTURE.has(clean) || Array.from(KNOWN_SAFE_INFRASTRUCTURE).some((s) => clean.endsWith(`.${s}`)))) {
    isSafe = true;
  }
  const knownSafeInfra = isSafe ? 1.0 : 0.0;

  // 10. High-Risk TLD & Punycode
  const highRiskTld = HIGH_ABUSE_TLDS.has(tld) ? 1.0 : 0.0;
  const punycode = clean.includes('xn--') ? 1.0 : 0.0;

  // 11. Hyphen & Numeric Subdomains
  const hyphenCount = (clean.match(/-/g) || []).length;
  const hyphenRatio = Math.min(1.0, hyphenCount / 4);
  const numericSubdomain = subdomains.some((sub) => /^\d+$/.test(sub)) ? 1.0 : 0.0;

  // 12. Syllable Cadence (alternation between vowels and consonants)
  let transitions = 0;
  for (let i = 0; i < lettersOnly.length - 1; i++) {
    const isV1 = /[aeiou]/.test(lettersOnly[i]);
    const isV2 = /[aeiou]/.test(lettersOnly[i + 1]);
    if (isV1 !== isV2) transitions++;
  }
  const syllableCadence = totalLetters > 1 ? transitions / (totalLetters - 1) : 0.5;

  const userTuneBias = Math.max(-1.0, Math.min(1.0, context?.userFeedbackBias || 0));

  // 13. Brand Typo-Squatting / Impersonation Detection
  let brandSpoofScore = 0;
  if (knownSafeInfra === 0) {
    const sldLower = sld.toLowerCase();
    const tokens = sldLower.split(/[-_.]/).filter(Boolean);

    for (const brand of HIGH_PROFILE_BRANDS) {
      if (sldLower === brand) {
        brandSpoofScore = 1.0;
        break;
      }
      const directDist = computeLevenshtein(sldLower, brand);
      if (directDist === 1 || (brand.length >= 6 && directDist === 2)) {
        brandSpoofScore = 1.0;
        break;
      }
      if (sldLower.includes(brand) && sldLower.length > brand.length) {
        if (/login|verify|security|auth|update|account|support|wallet|token|claim/i.test(sldLower)) {
          brandSpoofScore = 1.0;
          break;
        }
      }
      // Check tokens within hyphenated SLDs (e.g. paypa1-security, apple-id-verify)
      for (const tok of tokens) {
        if (tok === brand) {
          if (/login|verify|security|auth|update|account|support|wallet|token|claim/i.test(sldLower)) {
            brandSpoofScore = 1.0;
            break;
          }
        }
        const tokDist = computeLevenshtein(tok, brand);
        if (tokDist === 1 || (brand.length >= 6 && tokDist === 2)) {
          brandSpoofScore = 1.0;
          break;
        }
      }
      if (brandSpoofScore > 0) break;
    }
  }

  return {
    entropyFull,
    entropySld,
    entropySubdomain,
    domainLength,
    sldLength,
    subdomainDepth,
    vowelRatio,
    consonantRatio,
    digitRatio,
    consecutiveConsonants,
    consecutiveDigits,
    hexScore,
    trigramPerplexity,
    adKeywordWeight,
    trackerKeywordWeight,
    cnameKnownTracker,
    cnameExternal,
    cnameDepth,
    knownSafeInfra,
    highRiskTld,
    punycode,
    hyphenRatio,
    syllableCadence,
    numericSubdomain,
    userTuneBias,
    brandSpoofScore,
  };
}

/**
 * Calibrated weight coefficients for Multi-Class Mini-AI Inference.
 */
interface ModelClassWeights {
  bias: number;
  entropyFull: number;
  entropySld: number;
  lenSld: number;
  consecutiveConsonants: number;
  hexScore: number;
  trigramPerplexity: number;
  adKeywordWeight: number;
  trackerKeywordWeight: number;
  cnameKnownTracker: number;
  cnameExternal: number;
  knownSafeInfra: number;
  highRiskTld: number;
  digitRatio: number;
  punycode: number;
  userTuneBias: number;
  brandSpoofScore: number;
}

const MODEL_WEIGHTS: Record<ThreatCategory, ModelClassWeights> = {
  Clean: {
    bias: 1.5,
    entropyFull: -3.0,
    entropySld: -3.0,
    lenSld: -1.0,
    consecutiveConsonants: -4.0,
    hexScore: -6.0,
    trigramPerplexity: -4.0,
    adKeywordWeight: -7.0,
    trackerKeywordWeight: -7.0,
    cnameKnownTracker: -10.0,
    cnameExternal: -2.5,
    knownSafeInfra: 20.0,
    highRiskTld: -3.0,
    digitRatio: 0,
    punycode: 0,
    userTuneBias: -4.0,
    brandSpoofScore: -8.0,
  },
  Advertising: {
    bias: -2.0,
    entropyFull: 1.0,
    entropySld: 1.2,
    lenSld: 0.8,
    consecutiveConsonants: 0.5,
    hexScore: 0.5,
    trigramPerplexity: 0.5,
    adKeywordWeight: 16.0,
    trackerKeywordWeight: 0.5,
    cnameKnownTracker: 0.0,
    cnameExternal: 0.5,
    knownSafeInfra: -12.0,
    highRiskTld: 1.5,
    digitRatio: 0.5,
    punycode: 0.2,
    userTuneBias: 3.5,
    brandSpoofScore: 0,
  },
  'Telemetry/Analytics': {
    bias: -2.0,
    entropyFull: 0.8,
    entropySld: 1.0,
    lenSld: 0.5,
    consecutiveConsonants: 0.2,
    hexScore: 1.0,
    trigramPerplexity: 0.2,
    adKeywordWeight: 0.5,
    trackerKeywordWeight: 16.0,
    cnameKnownTracker: 0.0,
    cnameExternal: 0.8,
    knownSafeInfra: -12.0,
    highRiskTld: 0.8,
    digitRatio: 0.5,
    punycode: 0.2,
    userTuneBias: 3.5,
    brandSpoofScore: 0,
  },
  'CNAME Cloaking': {
    bias: -3.0,
    entropyFull: 0.2,
    entropySld: 0.2,
    lenSld: 0.0,
    consecutiveConsonants: 0.0,
    hexScore: 1.0,
    trigramPerplexity: 0.2,
    adKeywordWeight: 1.0,
    trackerKeywordWeight: 1.0,
    cnameKnownTracker: 14.0,
    cnameExternal: 5.0,
    knownSafeInfra: -12.0,
    highRiskTld: 0.5,
    digitRatio: 0.5,
    punycode: 0.2,
    userTuneBias: 3.5,
    brandSpoofScore: 0,
  },
  'Malware/Phishing': {
    bias: -3.0,
    entropyFull: 3.5,
    entropySld: 4.0,
    lenSld: 1.5,
    consecutiveConsonants: 5.0,
    hexScore: 5.0,
    trigramPerplexity: 4.5,
    adKeywordWeight: -5.0,
    trackerKeywordWeight: -5.0,
    cnameKnownTracker: 0.0,
    cnameExternal: 1.0,
    knownSafeInfra: -12.0,
    highRiskTld: 4.0,
    digitRatio: 2.5,
    punycode: 3.0,
    userTuneBias: 4.5,
    brandSpoofScore: 12.0,
  },
  Unknown: {
    bias: -5.0,
    entropyFull: 0,
    entropySld: 0,
    lenSld: 0,
    consecutiveConsonants: 0,
    hexScore: 0,
    trigramPerplexity: 0,
    adKeywordWeight: 0,
    trackerKeywordWeight: 0,
    cnameKnownTracker: 0,
    cnameExternal: 0,
    knownSafeInfra: 0,
    highRiskTld: 0,
    digitRatio: 0,
    punycode: 0,
    userTuneBias: 0,
    brandSpoofScore: 0,
  },
};

/**
 * Embedded Mini-AI Domain Threat Classifier.
 * Zero external dependencies, pure mathematical evaluation in <0.05ms per domain.
 * @beta
 */
export class MiniAiClassifier {
  private userFeedbackMap = new Map<string, number>();
  private readonly maxFeedbackEntries = 2000;

  /**
   * Adjusts the classification bias for a domain based on user confirmation.
   * Whitelisting sets a negative bias (-1.0), Blocking sets a positive bias (+1.0).
   * Implements LRU cap to prevent unbounded memory growth.
   */
  public tuneDomainFeedback(domain: string, action: 'whitelist' | 'block' | 'reset'): void {
    const clean = domain.toLowerCase().trim();
    if (action === 'reset') {
      this.userFeedbackMap.delete(clean);
      return;
    }

    if (this.userFeedbackMap.size >= this.maxFeedbackEntries && !this.userFeedbackMap.has(clean)) {
      const oldestKey = this.userFeedbackMap.keys().next().value;
      if (oldestKey) this.userFeedbackMap.delete(oldestKey);
    }

    this.userFeedbackMap.delete(clean);
    this.userFeedbackMap.set(clean, action === 'whitelist' ? -1.0 : 1.0);
  }

  public clearFeedback(): void {
    this.userFeedbackMap.clear();
  }

  public getDomainFeedback(domain: string): number {
    return this.userFeedbackMap.get(domain.toLowerCase().trim()) || 0;
  }

  public exportFeedback(): Record<string, number> {
    return Object.fromEntries(this.userFeedbackMap.entries());
  }

  public importFeedback(feedback: Record<string, number>): void {
    if (!feedback || typeof feedback !== 'object') return;
    const entries = Object.entries(feedback).slice(0, this.maxFeedbackEntries);
    for (const [domain, bias] of entries) {
      if (typeof domain === 'string' && typeof bias === 'number' && Number.isFinite(bias)) {
        const clean = domain.toLowerCase().trim();
        if (!clean) continue;
        const clampedBias = Math.max(-1.0, Math.min(1.0, bias));
        if (this.userFeedbackMap.size >= this.maxFeedbackEntries && !this.userFeedbackMap.has(clean)) {
          const oldestKey = this.userFeedbackMap.keys().next().value;
          if (oldestKey) this.userFeedbackMap.delete(oldestKey);
        }
        this.userFeedbackMap.set(clean, clampedBias);
      }
    }
  }

  public getFeedbackCount(): number {
    return this.userFeedbackMap.size;
  }

  /**
   * Classifies a domain using the embedded neural/logistic model.
   */
  public classify(
    domain: string,
    context?: {
      cnames?: string[];
      hasCnameCloaking?: boolean;
      knownTrackerTarget?: string;
      allowlist?: string[];
    },
  ): MiniAiPrediction {
    const startTime = performance.now();
    const userBias = this.getDomainFeedback(domain);
    const features = extractDomainFeatures(domain, {
      ...context,
      userFeedbackBias: userBias,
    });

    // Compute logit scores for each category
    const categories: ThreatCategory[] = [
      'Clean',
      'Advertising',
      'Telemetry/Analytics',
      'CNAME Cloaking',
      'Malware/Phishing',
    ];

    const logits: Record<ThreatCategory, number> = {
      Clean: 0,
      Advertising: 0,
      'Telemetry/Analytics': 0,
      'CNAME Cloaking': 0,
      'Malware/Phishing': 0,
      Unknown: -999,
    };

    const contributions: MiniAiFeatureContribution[] = [];

    for (const cat of categories) {
      const w = MODEL_WEIGHTS[cat];
      let z = w.bias;
      z += features.entropyFull * w.entropyFull;
      z += features.entropySld * w.entropySld;
      z += features.sldLength * w.lenSld;
      z += features.consecutiveConsonants * w.consecutiveConsonants;
      z += features.hexScore * w.hexScore;
      z += features.trigramPerplexity * w.trigramPerplexity;
      z += features.adKeywordWeight * w.adKeywordWeight;
      z += features.trackerKeywordWeight * w.trackerKeywordWeight;
      z += features.cnameKnownTracker * w.cnameKnownTracker;
      z += features.cnameExternal * w.cnameExternal;
      z += features.knownSafeInfra * w.knownSafeInfra;
      z += features.highRiskTld * w.highRiskTld;
      z += features.digitRatio * w.digitRatio;
      z += features.punycode * w.punycode;
      z += features.userTuneBias * w.userTuneBias;
      z += features.brandSpoofScore * w.brandSpoofScore;

      logits[cat] = z;
    }

    // Softmax probabilities
    const maxLogit = Math.max(...categories.map((c) => logits[c]));
    const expValues = categories.map((c) => Math.exp(logits[c] - maxLogit));
    const sumExp = expValues.reduce((a, b) => a + b, 0);

    const classProbabilities: Record<ThreatCategory, number> = {
      Clean: 0,
      Advertising: 0,
      'Telemetry/Analytics': 0,
      'CNAME Cloaking': 0,
      'Malware/Phishing': 0,
      Unknown: 0,
    };

    categories.forEach((cat, idx) => {
      classProbabilities[cat] = Math.round((expValues[idx] / sumExp) * 1000) / 1000;
    });

    // Find predicted class
    let bestCategory: ThreatCategory = 'Clean';
    let highestProb = -1;
    for (const cat of categories) {
      if (classProbabilities[cat] > highestProb) {
        highestProb = classProbabilities[cat];
        bestCategory = cat;
      }
    }

    // False positive guard
    if (features.knownSafeInfra > 0) {
      bestCategory = 'Clean';
      highestProb = 0.99;
      classProbabilities.Clean = 0.99;
    }

    // Map category to verdict
    let verdict: AiVerdict = 'clean';
    if (bestCategory === 'Advertising') {
      verdict = highestProb >= 0.65 ? 'ad_server' : 'suspicious';
    } else if (bestCategory === 'Telemetry/Analytics') {
      verdict = highestProb >= 0.65 ? 'tracker' : 'suspicious';
    } else if (bestCategory === 'CNAME Cloaking') {
      verdict = highestProb >= 0.65 ? 'tracker' : 'suspicious';
    } else if (bestCategory === 'Malware/Phishing') {
      verdict = highestProb >= 0.7 ? 'malicious' : 'suspicious';
    }

    // Risk level
    let riskLevel: RiskLevel = 'none';
    if (verdict === 'malicious') riskLevel = 'critical';
    else if (verdict === 'ad_server' || verdict === 'tracker') {
      riskLevel = highestProb >= 0.8 ? 'high' : 'medium';
    } else if (verdict === 'suspicious') {
      riskLevel = 'medium';
    }

    // Compile human-readable explanations & top feature attributions
    const reasons: string[] = [];

    if (features.knownSafeInfra > 0) {
      contributions.push({
        name: 'Safe Infrastructure',
        value: 1.0,
        weight: 15.0,
        impact: 'clean',
        description: 'Verified public CDN / cloud identity infrastructure',
      });
      reasons.push('Verified essential infrastructure or user whitelist (Protected by False Positive Guard)');
    }

    if (features.adKeywordWeight > 0.3) {
      contributions.push({
        name: 'Ad Keywords',
        value: features.adKeywordWeight,
        weight: 7.2,
        impact: 'threat',
        description: 'Matches known ad network token signatures',
      });
      reasons.push(`Contains ad network token signature (Weight: ${features.adKeywordWeight.toFixed(2)})`);
    }

    if (features.trackerKeywordWeight > 0.3) {
      contributions.push({
        name: 'Telemetry Tokens',
        value: features.trackerKeywordWeight,
        weight: 7.2,
        impact: 'threat',
        description: 'Matches tracking / analytics beacon signatures',
      });
      reasons.push(`Contains behavioral telemetry token signature (Weight: ${features.trackerKeywordWeight.toFixed(2)})`);
    }

    if (features.cnameKnownTracker > 0) {
      contributions.push({
        name: 'CNAME Tracker Alias',
        value: 1.0,
        weight: 9.5,
        impact: 'threat',
        description: 'Uncloaked CNAME resolves to recognized tracking network',
      });
      reasons.push(`CNAME uncloaking revealed tracking network alias (${context?.knownTrackerTarget})`);
    }

    if (features.hexScore > 0) {
      contributions.push({
        name: 'Hex Hash Subdomain',
        value: 1.0,
        weight: 4.5,
        impact: 'threat',
        description: 'Matches ephemeral tracking beacon hash pattern',
      });
      reasons.push('Contains hexadecimal hash label characteristic of ephemeral tracking beacons');
    }

    if (features.consecutiveConsonants >= 0.5) {
      contributions.push({
        name: 'Consonant Cluster',
        value: features.consecutiveConsonants,
        weight: 4.2,
        impact: 'threat',
        description: 'Unnatural consecutive consonants without vowels',
      });
      reasons.push('Unnatural consonant cluster indicating machine-generated domain (DGA)');
    }

    if (features.trigramPerplexity >= 0.6) {
      contributions.push({
        name: 'Trigram Perplexity',
        value: features.trigramPerplexity,
        weight: 4.0,
        impact: 'threat',
        description: 'Drastically deviates from natural English n-gram distribution',
      });
      reasons.push(`High trigram perplexity (${features.trigramPerplexity.toFixed(2)}): random character sequencing`);
    }

    if (features.entropyFull >= 3.7) {
      contributions.push({
        name: 'Shannon Entropy',
        value: features.entropyFull,
        weight: 2.5,
        impact: 'threat',
        description: 'High information entropy in hostname',
      });
      reasons.push(`High Shannon entropy (${features.entropyFull.toFixed(2)}) indicates pseudo-random hostname`);
    }

    if (features.brandSpoofScore > 0) {
      contributions.push({
        name: 'Brand Typo-Squatting',
        value: 1.0,
        weight: 6.5,
        impact: 'threat',
        description: 'Impersonates or typo-squats a high-profile brand domain',
      });
      reasons.push('Brand impersonation or typo-squatting credential harvesting pattern detected');
    }

    if (features.highRiskTld > 0) {
      contributions.push({
        name: 'High-Abuse TLD',
        value: 1.0,
        weight: 3.5,
        impact: 'threat',
        description: 'TLD is historically associated with ad redirect campaigns',
      });
      reasons.push('Registered on high-abuse top-level domain frequently used for ad evasion');
    }

    if (reasons.length === 0) {
      reasons.push('Standard lexical structure: no ad tokens, tracking beacons, or DGA patterns detected');
    }

    const elapsed = Math.round((performance.now() - startTime) * 1000) / 1000;
    const confidence = Math.round(highestProb * 100);

    return {
      verdict,
      category: bestCategory,
      confidence: Math.max(10, Math.min(99, confidence)),
      riskLevel,
      classProbabilities,
      topContributions: contributions.sort((a, b) => b.weight * b.value - a.weight * a.value).slice(0, 5),
      inferenceTimeMs: elapsed,
      reasons,
    };
  }
}

// Global shared singleton for fast caching and in-process tuning
export const globalMiniAiClassifier = new MiniAiClassifier();

/**
 * Convenience helper to classify a domain with the global Mini-AI instance.
 * @beta
 */
export function classifyDomainWithMiniAi(
  domain: string,
  context?: {
    cnames?: string[];
    hasCnameCloaking?: boolean;
    knownTrackerTarget?: string;
    allowlist?: string[];
  },
): MiniAiPrediction {
  return globalMiniAiClassifier.classify(domain, context);
}
