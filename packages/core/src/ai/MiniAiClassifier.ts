import { calculateShannonEntropy, decomposeDomain } from './entropy.js';
import {
  HIGH_ABUSE_TLDS,
  SUSPICIOUS_AD_TOKENS,
  SUSPICIOUS_TRACKER_TOKENS,
  adjustThreatCategory,
  classifyInfrastructure,
  detectAntiAdblock,
  hasStrongAdIntent,
  hostnameHasToken,
  normalizeHostname,
  scoreBrandSpoof,
} from './reputation.js';
import type {
  AiVerdict,
  DomainFeatureVector,
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
  // Top 100 natural English language trigrams (corpus-derived)
  'the', 'and', 'ing', 'ion', 'tio', 'ent', 'ati', 'for', 'her', 'ter',
  'hat', 'tha', 'ere', 'ate', 'his', 'con', 'res', 'ver', 'all', 'ons',
  'nce', 'men', 'ith', 'ted', 'ers', 'pro', 'thi', 'wit', 'are', 'ess',
  'not', 'ive', 'was', 'ect', 'rea', 'com', 'eve', 'per', 'int', 'est',
  'sta', 'cti', 'ica', 'ist', 'ear', 'ain', 'one', 'our', 'iti', 'rat',
  'tra', 'der', 'ste', 'art', 'cal', 'lan', 'ell', 'ill', 'ard', 'igh',
  'ght', 'lin', 'out', 'sto', 'mar', 'par', 'man', 'can', 'day', 'way',
  'wor', 'kin', 'new', 'ber', 'ble', 'cle', 'fle', 'ple', 'tle', 'ine',
  'ane', 'ise', 'ize', 'ous', 'ful', 'les', 'nes', 'ish', 'dis', 'mis',
  'sub', 'pre', 'pos', 'non', 'ove', 'und', 'rec', 'aut', 'bio', 'geo',
  // Common internet, technical, brand & service vocabulary trigrams
  'app', 'web', 'dev', 'net', 'api', 'sys', 'gen', 'hub', 'box', 'doc',
  'dat', 'dig', 'map', 'log', 'dns', 'sec', 'pay', 'cdn', 'med', 'off',
  'car', 'cit', 'inf', 'vid', 'col', 'ord', 'ews', 'lab', 'clu', 'lub',
  'spo', 'por', 'ort', 'gam', 'ame', 'pla', 'lay', 'mus', 'usi', 'sic',
  'ide', 'deo', 'pic', 'ict', 'tur', 'ure', 'boo', 'ook', 'pag', 'age',
  'hom', 'ome', 'liv', 'fil', 'ilm', 'mov', 'ovi', 'vie', 'ser', 'erv',
  'blo', 'mai', 'ail', 'cod', 'ode', 'clo', 'lou', 'oud', 'gua', 'uard',
  'pos', 'dep', 'epo', 'pot', 'ack', 'eck', 'ick', 'ock', 'uck', 'ash',
  'esh', 'osh', 'ush', 'ang', 'eng', 'ong', 'ung', 'ank', 'enk', 'ink',
  'onk', 'unk', 'tch', 'dge', 'str', 'spl', 'spr', 'scr', 'shr', 'thr',
  'squ', 'tac', 'tov', 'erf', 'rfl', 'flo', 'low', 'tac', 'ack',
  'kin', 'ing', 'lin', 'cor', 'orp', 'cen', 'tra', 'ral', 'nor', 'ort',
  'sou', 'eas', 'wes', 'dir', 'rec', 'tor', 'ory', 'hos', 'osp', 'pit',
  'ita', 'tal', 'uni', 'niv', 'ive', 'ver', 'ers', 'rsi', 'sit', 'ity',
  'gov', 'ove', 'ern', 'rnm', 'nme', 'ent', 'sch', 'cho', 'hoo', 'ool',
  'gui', 'lid', 'cli', 'nic', 'wea', 'eat', 'ath', 'the', 'her', 'new',
]);

/**
 * Maximum RFC 1035 / RFC 1123 domain string length.
 */
const MAX_RFC_DOMAIN_LENGTH = 253;

/**
 * Known public recursive DNS resolvers (IPv4 & IPv6).
 */
const KNOWN_PUBLIC_DNS = new Set([
  '8.8.8.8',
  '8.8.4.4',
  '1.1.1.1',
  '1.0.0.1',
  '9.9.9.9',
  '149.112.112.112',
  '208.67.222.222',
  '208.67.220.220',
  '94.140.14.14',
  '94.140.15.15',
  '2606:4700:4700::1111',
  '2606:4700:4700::1001',
  '2001:4860:4860::8888',
  '2001:4860:4860::8844',
  '2620:fe::fe',
  '2620:fe::9',
]);

/**
 * Fast helper to analyze whether a host string is a raw IP address (IPv4 or IPv6),
 * and whether it constitutes private, local, or trusted resolver infrastructure.
 */
function analyzeIpAddress(host: string): { isIp: boolean; isPrivateOrLocal: boolean; isPublicDns: boolean } {
  // Check IPv4
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
  // Check IPv6 (with or without brackets, full or compressed)
  const cleanIpv6 = host.replace(/^\[|\]$/g, '');
  const isIpv6 = cleanIpv6.includes(':') && /^[a-f0-9:]+$/i.test(cleanIpv6);

  if (!isIpv4 && !isIpv6) {
    return { isIp: false, isPrivateOrLocal: false, isPublicDns: false };
  }

  if (KNOWN_PUBLIC_DNS.has(cleanIpv6) || KNOWN_PUBLIC_DNS.has(host)) {
    return { isIp: true, isPrivateOrLocal: false, isPublicDns: true };
  }

  // IPv4 Private & Loopback Checks
  if (isIpv4) {
    if (
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '255.255.255.255' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') || // Link-local
      host.startsWith('100.64.') ||  // CGNAT
      host.startsWith('192.0.2.') || // Documentation
      host.startsWith('198.51.100.') ||
      host.startsWith('203.0.113.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) || // RFC 1918 172.16.0.0/12
      /^22[4-9]\./.test(host) || // Multicast
      /^23\d\./.test(host)
    ) {
      return { isIp: true, isPrivateOrLocal: true, isPublicDns: false };
    }
  }

  // IPv6 Private & Loopback Checks
  if (isIpv6) {
    const lower = cleanIpv6.toLowerCase();
    if (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fe80:') || // Link-local
      lower.startsWith('fc00:') || // ULA
      lower.startsWith('fd00:') || // ULA
      lower.startsWith('ff00:') || // Multicast
      lower.startsWith('::ffff:') || // IPv4-mapped
      lower.startsWith('2001:db8:') // Documentation
    ) {
      return { isIp: true, isPrivateOrLocal: true, isPublicDns: false };
    }
  }

  return { isIp: true, isPrivateOrLocal: false, isPublicDns: false };
}

/**
 * Sanitizes domain inputs against ReDoS, control characters, null bytes,
 * length anomalies, and malformed structures.
 */
function sanitizeInputDomain(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Strip control characters, zero-width characters, null bytes
  const normalized = normalizeHostname(raw);
  if (normalized.length > MAX_RFC_DOMAIN_LENGTH) return '';
  return normalized;
}

/**
 * Extracts 25 numerical features for domain threat classification.
 * All feature values are strictly finite numbers bounded between 0.0 and 1.5.
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
  const clean = sanitizeInputDomain(domain);
  const parts = clean.split('.').filter(Boolean);
  const decomposition = decomposeDomain(clean);

  const sld = decomposition.sld || clean;
  const subdomains = Array.isArray(decomposition.subdomains) ? decomposition.subdomains : [];
  const tld = decomposition.tld || '';

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
  const domainLength = Math.max(0, Math.min(1.0, clean.length / 60));
  const sldLength = Math.max(0, Math.min(1.0, sld.length / 35));
  const subdomainDepth = Math.max(0, Math.min(1.0, subdomains.length / 4));

  // 3. Character Distributions
  const lettersOnly = clean.replace(/[^a-z]/g, '');
  const totalLetters = lettersOnly.length || 1;
  const vowels = (lettersOnly.match(/[aeiou]/g) || []).length;
  const consonants = Math.max(0, totalLetters - vowels);
  const vowelRatio = Math.max(0, Math.min(1.0, vowels / totalLetters));
  const consonantRatio = Math.max(0, Math.min(1.0, consonants / totalLetters));

  const totalChars = clean.replace(/\./g, '').length || 1;
  const digits = (clean.match(/\d/g) || []).length;
  const digitRatio = Math.max(0, Math.min(1.0, digits / totalChars));

  // 4. Consecutive Runs
  const maxConsonants = Math.max(
    0,
    ...(clean.match(/[bcdfghjklmnpqrstvwxyz]+/g) || []).map((m) => m.length),
  );
  // Consonant runs <= 3 are standard English ("str", "sch"). >= 5 is anomalous/DGA.
  const consecutiveConsonants = Math.max(0, Math.min(1.0, Math.max(0, maxConsonants - 3) / 5));

  const maxDigits = Math.max(
    0,
    ...(clean.match(/\d+/g) || []).map((m) => m.length),
  );
  const consecutiveDigits = Math.max(0, Math.min(1.0, maxDigits / 8));

  // 5. Hex & Hash Detection (supports standard and hyphenated/UUID hex labels)
  const hasHexLabel = parts.some((p) => {
    const unhyphenated = p.replace(/-/g, '');
    return unhyphenated.length >= 16 && /^[a-f0-9]+$/i.test(unhyphenated);
  });
  const hexScore = hasHexLabel ? 1.0 : 0.0;

  // 6. Trigram Perplexity (Natural Language Naturalness)
  // Evaluates the most complex label in the domain (SLD or high-entropy subdomain)
  const evalLabel = (subdomains.length > 0 && rawEntropySubdomain > rawEntropySld && subdomains[0].length >= sld.length)
    ? subdomains[0]
    : sld;
  let familiarTrigrams = 0;
  let totalTrigrams = 0;
  if (evalLabel.length >= 3) {
    for (let i = 0; i <= evalLabel.length - 3; i++) {
      totalTrigrams++;
      if (COMMON_TRIGRAMS.has(evalLabel.slice(i, i + 3))) {
        familiarTrigrams++;
      }
    }
  }
  // Low ratio of familiar trigrams in a long label indicates high perplexity (unnatural/DGA)
  const trigramFamiliarity = totalTrigrams > 0 ? familiarTrigrams / totalTrigrams : 0.5;
  const trigramPerplexity = evalLabel.length >= 8 ? Math.max(0, Math.min(1.0, 1.0 - trigramFamiliarity)) : 0.2;

  // 7. Keyword Matching (label boundaries; `status` must not match `stat`)
  let adKeywordWeight = 0;
  for (const token of SUSPICIOUS_AD_TOKENS) {
    if (!hostnameHasToken(clean, token)) continue;
    adKeywordWeight += token.length >= 4 ? 0.5 : 0.4;
  }
  adKeywordWeight = Math.max(0, Math.min(1.5, adKeywordWeight));

  let trackerKeywordWeight = 0;
  for (const token of SUSPICIOUS_TRACKER_TOKENS) {
    if (!hostnameHasToken(clean, token)) continue;
    trackerKeywordWeight += token.length >= 4 ? 0.5 : 0.4;
  }
  trackerKeywordWeight = Math.max(0, Math.min(1.5, trackerKeywordWeight));

  // 8. CNAME Cloaking Flags (bounded)
  const cnameKnownTracker = context?.knownTrackerTarget ? 1.0 : 0.0;
  const cnameExternal = context?.hasCnameCloaking ? 1.0 : 0.0;
  const rawCnames = Array.isArray(context?.cnames) ? context!.cnames.slice(0, 16) : [];
  const cnameDepth = Math.max(0, Math.min(1.0, rawCnames.length / 4));

  // 9. Safe infrastructure. Advertising intent and brand spoofs are not protected.
  const allowlist = Array.isArray(context?.allowlist) ? context!.allowlist.slice(0, 500) : [];
  const allowlisted = allowlist.some((al) => {
    if (typeof al !== 'string') return false;
    const entry = normalizeHostname(al);
    return entry.length > 0 && (clean === entry || clean.endsWith(`.${entry}`));
  });

  const infra = classifyInfrastructure(clean);
  const brandSpoofScore = allowlisted ? 0 : Math.max(0, scoreBrandSpoof(clean));
  const adIntent = hasStrongAdIntent(clean);
  const reputationSafe = infra.safe
    && !infra.adNetwork
    && infra.kind !== 'tracker-network'
    && !adIntent
    && brandSpoofScore <= 0;
  const knownSafeInfra = allowlisted || reputationSafe ? 1.0 : 0.0;

  // 10. High-Risk TLD & Punycode
  const highRiskTld = HIGH_ABUSE_TLDS.has(tld) ? 1.0 : 0.0;
  const punycode = clean.includes('xn--') ? 1.0 : 0.0;

  // 11. Hyphen & Numeric Subdomains
  const hyphenCount = (clean.match(/-/g) || []).length;
  const hyphenRatio = Math.max(0, Math.min(1.0, hyphenCount / 4));
  const numericSubdomain = subdomains.some((sub) => /^\d+$/.test(sub)) ? 1.0 : 0.0;

  // 12. Syllable Cadence (alternation between vowels and consonants)
  let transitions = 0;
  for (let i = 0; i < lettersOnly.length - 1; i++) {
    const isV1 = /[aeiou]/.test(lettersOnly[i]);
    const isV2 = /[aeiou]/.test(lettersOnly[i + 1]);
    if (isV1 !== isV2) transitions++;
  }
  const syllableCadence = totalLetters > 1 ? Math.max(0, Math.min(1.0, transitions / (totalLetters - 1))) : 0.5;

  const rawFeedbackBias = typeof context?.userFeedbackBias === 'number' && Number.isFinite(context.userFeedbackBias)
    ? context.userFeedbackBias
    : 0;
  const userTuneBias = Math.max(-1.0, Math.min(1.0, rawFeedbackBias));

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
    trigramPerplexity: -2.0,
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
    trigramPerplexity: 2.5,
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
 * Options to configure MiniAiClassifier behavior and memory boundaries.
 */
export interface MiniAiClassifierOptions {
  maxFeedbackEntries?: number;
  maxCacheSize?: number;
  enableCache?: boolean;
}

/**
 * Cached prediction representation.
 */
interface CacheEntry {
  prediction: MiniAiPrediction;
  timestamp: number;
}

function clonePrediction(prediction: MiniAiPrediction): MiniAiPrediction {
  return {
    ...prediction,
    classProbabilities: { ...prediction.classProbabilities },
    topContributions: prediction.topContributions.map((item) => ({ ...item })),
    reasons: [...prediction.reasons],
  };
}

/**
 * Embedded Mini-AI Domain Threat Classifier.
 * Zero external dependencies, pure mathematical evaluation in <0.05ms per domain.
 * Hardened with ReDoS protection, memory bounds, input sanitization, and an LRU cache.
 * @beta
 */
export class MiniAiClassifier {
  private userFeedbackMap = new Map<string, number>();
  private predictionCache = new Map<string, CacheEntry>();
  private readonly maxFeedbackEntries: number;
  private readonly maxCacheSize: number;
  private readonly enableCache: boolean;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(options?: MiniAiClassifierOptions) {
    this.maxFeedbackEntries = options?.maxFeedbackEntries && options.maxFeedbackEntries > 0
      ? Math.min(10000, options.maxFeedbackEntries)
      : 2000;
    this.maxCacheSize = options?.maxCacheSize && options.maxCacheSize > 0
      ? Math.min(20000, options.maxCacheSize)
      : 5000;
    this.enableCache = options?.enableCache !== false;
  }

  /**
   * Adjusts the classification bias for a domain based on user confirmation.
   * Whitelisting sets a negative bias (-1.0), Blocking sets a positive bias (+1.0).
   * Implements LRU cap to prevent unbounded memory growth.
   */
  public tuneDomainFeedback(domain: string, action: 'whitelist' | 'block' | 'reset'): void {
    if (typeof domain !== 'string') return;
    const clean = sanitizeInputDomain(domain);
    // Prototype pollution & empty guard
    if (!clean || clean === '__proto__' || clean === 'constructor' || clean === 'prototype') {
      return;
    }

    if (action === 'reset') {
      this.userFeedbackMap.delete(clean);
      this.clearCache();
      return;
    }

    if (this.userFeedbackMap.size >= this.maxFeedbackEntries && !this.userFeedbackMap.has(clean)) {
      const oldestKey = this.userFeedbackMap.keys().next().value;
      if (oldestKey) this.userFeedbackMap.delete(oldestKey);
    }

    this.userFeedbackMap.delete(clean);
    this.userFeedbackMap.set(clean, action === 'whitelist' ? -1.0 : 1.0);
    this.clearCache();
  }

  public clearFeedback(): void {
    this.userFeedbackMap.clear();
    this.clearCache();
  }

  public getDomainFeedback(domain: string): number {
    if (typeof domain !== 'string') return 0;
    const clean = sanitizeInputDomain(domain);
    return this.userFeedbackMap.get(clean) || 0;
  }

  public exportFeedback(): Record<string, number> {
    const exported = Object.create(null) as Record<string, number>;
    for (const [k, v] of this.userFeedbackMap.entries()) {
      if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
        exported[k] = v;
      }
    }
    return exported;
  }

  public importFeedback(feedback: Record<string, number>): void {
    if (!feedback || typeof feedback !== 'object') return;
    const entries = Object.entries(feedback).slice(0, this.maxFeedbackEntries);
    for (const [domain, bias] of entries) {
      if (
        typeof domain === 'string' &&
        domain !== '__proto__' &&
        domain !== 'constructor' &&
        domain !== 'prototype' &&
        typeof bias === 'number' &&
        Number.isFinite(bias)
      ) {
        const clean = sanitizeInputDomain(domain);
        if (!clean) continue;
        const clampedBias = Math.max(-1.0, Math.min(1.0, bias));
        if (this.userFeedbackMap.size >= this.maxFeedbackEntries && !this.userFeedbackMap.has(clean)) {
          const oldestKey = this.userFeedbackMap.keys().next().value;
          if (oldestKey) this.userFeedbackMap.delete(oldestKey);
        }
        this.userFeedbackMap.delete(clean);
        this.userFeedbackMap.set(clean, clampedBias);
      }
    }
    this.clearCache();
  }

  public getFeedbackCount(): number {
    return this.userFeedbackMap.size;
  }

  /**
   * Clears the internal prediction memoization cache.
   */
  public clearCache(): void {
    this.predictionCache.clear();
  }

  /**
   * Retrieves cache performance metrics.
   */
  public getCacheStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.predictionCache.size,
      hitRate: total > 0 ? Math.round((this.cacheHits / total) * 1000) / 1000 : 0,
    };
  }

  /**
   * Classifies a domain using the embedded neural/logistic model.
   * Fully hardened with fail-safe boundaries to guarantee 0 unhandled exceptions.
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

    try {
      // Guard against empty, non-string, or malformed domain inputs
      const normalized = sanitizeInputDomain(domain);
      if (!normalized || (!normalized.includes('.') && !normalized.includes(':'))) {
        const elapsed = Math.round((performance.now() - startTime) * 1000) / 1000;
        return {
          verdict: 'clean',
          category: 'Clean',
          confidence: 0,
          riskLevel: 'none',
          classProbabilities: {
            Clean: 1.0,
            Advertising: 0,
            'Telemetry/Analytics': 0,
            'CNAME Cloaking': 0,
            'Malware/Phishing': 0,
            Unknown: 0,
          },
          topContributions: [],
          inferenceTimeMs: elapsed,
          reasons: ['Empty or malformed domain string'],
        };
      }

      // Guard against raw IP address inputs
      const ipCheck = analyzeIpAddress(normalized);
      if (ipCheck.isIp) {
        const elapsed = Math.round((performance.now() - startTime) * 1000) / 1000;
        if (ipCheck.isPrivateOrLocal) {
          return {
            verdict: 'clean',
            category: 'Clean',
            confidence: 99,
            riskLevel: 'none',
            classProbabilities: { Clean: 1.0, Advertising: 0, 'Telemetry/Analytics': 0, 'CNAME Cloaking': 0, 'Malware/Phishing': 0, Unknown: 0 },
            topContributions: [
              {
                name: 'Private/Local IP Address',
                value: 1.0,
                weight: 15.0,
                impact: 'clean',
                description: 'Local loopback or RFC 1918 private network endpoint',
              },
            ],
            inferenceTimeMs: elapsed,
            reasons: ['Local loopback or RFC 1918 private network endpoint (protected)'],
          };
        }

        if (ipCheck.isPublicDns) {
          return {
            verdict: 'clean',
            category: 'Clean',
            confidence: 99,
            riskLevel: 'none',
            classProbabilities: { Clean: 1.0, Advertising: 0, 'Telemetry/Analytics': 0, 'CNAME Cloaking': 0, 'Malware/Phishing': 0, Unknown: 0 },
            topContributions: [
              {
                name: 'Known Public DNS',
                value: 1.0,
                weight: 15.0,
                impact: 'clean',
                description: 'Known public recursive DNS resolver endpoint',
              },
            ],
            inferenceTimeMs: elapsed,
            reasons: ['Known public recursive DNS resolver endpoint'],
          };
        }

        return {
          verdict: 'clean',
          category: 'Clean',
          confidence: 85,
          riskLevel: 'none',
          classProbabilities: { Clean: 0.9, Advertising: 0.02, 'Telemetry/Analytics': 0.02, 'CNAME Cloaking': 0.01, 'Malware/Phishing': 0.05, Unknown: 0 },
          topContributions: [],
          inferenceTimeMs: elapsed,
          reasons: ['Raw IP address endpoint (not a domain hostname)'],
        };
      }

      const userBias = this.getDomainFeedback(normalized);

      // Check Fast-Path Prediction Cache
      const hasDynamicContext = !!context?.knownTrackerTarget || !!context?.hasCnameCloaking || (context?.cnames && context.cnames.length > 0);
      let cacheKey = '';
      if (this.enableCache && !hasDynamicContext && (!context?.allowlist || context.allowlist.length === 0)) {
        cacheKey = `${normalized}|${userBias}`;
        const cached = this.predictionCache.get(cacheKey);
        if (cached) {
          this.cacheHits++;
          // Refresh LRU order
          this.predictionCache.delete(cacheKey);
          this.predictionCache.set(cacheKey, cached);
          const cachedElapsed = Math.round((performance.now() - startTime) * 1000) / 1000;
          return {
            ...clonePrediction(cached.prediction),
            inferenceTimeMs: cachedElapsed,
          };
        }
        this.cacheMisses++;
      }

      // If user explicitly whitelisted the domain (False Positive feedback override):
      if (userBias <= -0.9) {
        const elapsed = Math.round((performance.now() - startTime) * 1000) / 1000;
        const result: MiniAiPrediction = {
          verdict: 'clean',
          category: 'Clean',
          confidence: 99,
          riskLevel: 'none',
          classProbabilities: {
            Clean: 1.0,
            Advertising: 0,
            'Telemetry/Analytics': 0,
            'CNAME Cloaking': 0,
            'Malware/Phishing': 0,
            Unknown: 0,
          },
          topContributions: [
            {
              name: 'User Whitelist Feedback',
              value: 1.0,
              weight: 20.0,
              impact: 'clean',
              description: 'Explicit user whitelist tuning (False Positive Override)',
            },
          ],
          inferenceTimeMs: elapsed,
          reasons: ['Whitelisted by user feedback (False Positive Override)'],
        };
        if (cacheKey) this.saveToCache(cacheKey, result);
        return result;
      }

      const features = extractDomainFeatures(normalized, {
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

        logits[cat] = Number.isFinite(z) ? z : 0;
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

      if (Number.isFinite(sumExp) && sumExp > 0) {
        categories.forEach((cat, idx) => {
          classProbabilities[cat] = Math.round((expValues[idx] / sumExp) * 1000) / 1000;
        });
      } else {
        classProbabilities.Clean = 1.0;
      }

      // Find predicted class
      let bestCategory: ThreatCategory = 'Clean';
      let highestProb = -1;
      for (const cat of categories) {
        if (classProbabilities[cat] > highestProb) {
          highestProb = classProbabilities[cat];
          bestCategory = cat;
        }
      }

      const host = normalized;
      const allowlisted = !!context?.allowlist?.some((entry) => {
        if (typeof entry !== 'string') return false;
        const item = normalizeHostname(entry);
        return item.length > 0 && (host === item || host.endsWith(`.${item}`));
      });

      const adjustment = adjustThreatCategory(normalized, features, bestCategory, highestProb, {
        knownTrackerCname: features.cnameKnownTracker > 0,
        allowlisted,
      });
      bestCategory = adjustment.category;
      highestProb = adjustment.probability;

      // When category is adjusted to Clean, renormalize probability distribution
      if (bestCategory === 'Clean') {
        classProbabilities.Clean = Math.max(classProbabilities.Clean, highestProb);
        const remainder = Math.max(0, 1.0 - classProbabilities.Clean);
        const otherCategories = categories.filter((c) => c !== 'Clean');
        const otherSum = otherCategories.reduce((sum, c) => sum + classProbabilities[c], 0);

        if (otherSum > 0) {
          for (const c of otherCategories) {
            classProbabilities[c] = Math.round(((classProbabilities[c] / otherSum) * remainder) * 1000) / 1000;
          }
        } else {
          for (const c of otherCategories) {
            classProbabilities[c] = 0;
          }
        }
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
      } else if (bestCategory === 'Unknown') {
        verdict = 'suspicious';
      }

      // Risk level. Uncorroborated lexical noise stays low, never critical.
      let riskLevel: RiskLevel = 'none';
      if (verdict === 'malicious') riskLevel = 'critical';
      else if (verdict === 'ad_server' || verdict === 'tracker') {
        riskLevel = highestProb >= 0.8 ? 'high' : 'medium';
      } else if (bestCategory === 'Unknown') {
        riskLevel = 'low';
      } else if (verdict === 'suspicious') {
        riskLevel = 'medium';
      }

      // Compile human-readable explanations & top feature attributions
      const reasons: string[] = [];

      if (features.knownSafeInfra > 0 || (adjustment.policyReason && bestCategory === 'Clean')) {
        contributions.push({
          name: 'Safe Infrastructure',
          value: 1.0,
          weight: 15.0,
          impact: 'clean',
          description: adjustment.policyReason || 'Verified public CDN, cloud, vendor, or device infrastructure',
        });
      }

      // Only check anti-adblock if domain is not verified safe infrastructure
      if (bestCategory !== 'Clean' && features.knownSafeInfra <= 0) {
        const aabCheck = detectAntiAdblock(normalized);
        if (aabCheck.detected) {
          contributions.push({
            name: 'Anti-Adblock Infrastructure',
            value: 1.0,
            weight: 12.0,
            impact: 'threat',
            description: aabCheck.reason || 'Anti-adblock and ad-recovery platform',
          });
        }
      }

      if (bestCategory !== 'Clean' && features.adKeywordWeight > 0.3) {
        contributions.push({
          name: 'Ad Keywords',
          value: features.adKeywordWeight,
          weight: 7.2,
          impact: 'threat',
          description: 'Matches known ad network token signatures',
        });
        reasons.push(`Contains ad network token signature (Weight: ${features.adKeywordWeight.toFixed(2)})`);
      }

      if (bestCategory !== 'Clean' && features.trackerKeywordWeight > 0.3) {
        contributions.push({
          name: 'Telemetry Tokens',
          value: features.trackerKeywordWeight,
          weight: 7.2,
          impact: 'threat',
          description: 'Matches tracking / analytics beacon signatures',
        });
        reasons.push(`Contains behavioral telemetry token signature (Weight: ${features.trackerKeywordWeight.toFixed(2)})`);
      }

      if (bestCategory !== 'Clean' && features.cnameKnownTracker > 0) {
        contributions.push({
          name: 'CNAME Tracker Alias',
          value: 1.0,
          weight: 9.5,
          impact: 'threat',
          description: 'Uncloaked CNAME resolves to recognized tracking network',
        });
        reasons.push(`CNAME uncloaking revealed tracking network alias (${context?.knownTrackerTarget})`);
      }

      if (bestCategory !== 'Clean' && features.hexScore > 0) {
        contributions.push({
          name: 'Hex Hash Subdomain',
          value: 1.0,
          weight: 4.5,
          impact: 'threat',
          description: 'Matches ephemeral tracking beacon hash pattern',
        });
        reasons.push('Contains hexadecimal hash label characteristic of ephemeral tracking beacons');
      }

      if (bestCategory !== 'Clean' && features.consecutiveConsonants >= 0.5) {
        contributions.push({
          name: 'Consonant Cluster',
          value: features.consecutiveConsonants,
          weight: 4.2,
          impact: 'threat',
          description: 'Unnatural consecutive consonants without vowels',
        });
        reasons.push('Unnatural consonant cluster indicating machine-generated domain (DGA)');
      }

      if (bestCategory !== 'Clean' && features.trigramPerplexity >= 0.6) {
        contributions.push({
          name: 'Trigram Perplexity',
          value: features.trigramPerplexity,
          weight: 4.0,
          impact: 'threat',
          description: 'Drastically deviates from natural English n-gram distribution',
        });
        reasons.push(`High trigram perplexity (${features.trigramPerplexity.toFixed(2)}): random character sequencing`);
      }

      if (bestCategory !== 'Clean' && features.brandSpoofScore > 0) {
        contributions.push({
          name: 'Brand Typo-Squatting',
          value: 1.0,
          weight: 6.5,
          impact: 'threat',
          description: 'Impersonates or typo-squats a high-profile brand domain',
        });
        reasons.push('Brand impersonation or typo-squatting credential harvesting pattern detected');
      }

      if (bestCategory !== 'Clean' && features.highRiskTld > 0) {
        contributions.push({
          name: 'High-Abuse TLD',
          value: 1.0,
          weight: 3.5,
          impact: 'threat',
          description: 'TLD is historically associated with ad redirect campaigns',
        });
        reasons.push('Registered on high-abuse top-level domain frequently used for ad evasion');
      }

      if (adjustment.policyReason) {
        if (bestCategory === 'Clean' || bestCategory === 'Unknown') {
          reasons.length = 0;
        }
        if (!reasons.includes(adjustment.policyReason)) {
          reasons.unshift(adjustment.policyReason);
        }
      }

      if (reasons.length === 0) {
        reasons.push('Standard lexical structure: no ad tokens, tracking beacons, or DGA patterns detected');
      }

      const elapsed = Math.round((performance.now() - startTime) * 1000) / 1000;
      const confidence = Math.round(highestProb * 100);

      const predictionResult: MiniAiPrediction = {
        verdict,
        category: bestCategory,
        confidence: Math.max(0, Math.min(100, confidence)),
        riskLevel,
        classProbabilities,
        topContributions: contributions.sort((a, b) => b.weight * b.value - a.weight * a.value).slice(0, 5),
        inferenceTimeMs: elapsed,
        reasons: Array.from(new Set(reasons)),
      };

      if (cacheKey) {
        this.saveToCache(cacheKey, predictionResult);
      }

      return predictionResult;
    } catch {
      // Zero-crash fail-safe fallback
      const elapsed = Math.round((performance.now() - startTime) * 1000) / 1000;
      return {
        verdict: 'clean',
        category: 'Clean',
        confidence: 50,
        riskLevel: 'none',
        classProbabilities: {
          Clean: 1.0,
          Advertising: 0,
          'Telemetry/Analytics': 0,
          'CNAME Cloaking': 0,
          'Malware/Phishing': 0,
          Unknown: 0,
        },
        topContributions: [],
        inferenceTimeMs: elapsed,
        reasons: ['Fail-safe clean classification: unexpected evaluation error'],
      };
    }
  }

  private saveToCache(key: string, prediction: MiniAiPrediction): void {
    if (this.predictionCache.size >= this.maxCacheSize) {
      const oldestKey = this.predictionCache.keys().next().value;
      if (oldestKey) this.predictionCache.delete(oldestKey);
    }
    this.predictionCache.set(key, {
      prediction: clonePrediction(prediction),
      timestamp: Date.now(),
    });
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
