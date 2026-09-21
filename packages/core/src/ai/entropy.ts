import type { DomainDecomposition, DomainLabelEntropy } from './types.js';

/**
 * Shannon entropy and lexical analysis for DGA and randomized ad tracker detection.
 * @beta
 */

export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0;

  const frequencies = new Map<string, number>();
  for (const char of str.toLowerCase()) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }

  let entropy = 0;
  const len = str.length;

  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return Math.round(entropy * 1000) / 1000;
}

export interface DgaDetectionResult {
  isLikelyDga: boolean;
  score: number; // 0 (normal) to 100 (high probability machine generated)
  reasons: string[];
}

export function detectDgaPatterns(domain: string): DgaDetectionResult {
  const reasons: string[] = [];
  let score = 0;

  const cleanDomain = domain.toLowerCase().trim();
  const parts = cleanDomain.split('.').filter(Boolean);
  if (parts.length === 0) {
    return { isLikelyDga: false, score: 0, reasons: [] };
  }

  // Analyze primary subdomain and secondary domain labels
  const primaryLabel = parts.length > 2 ? parts[0] : parts[parts.length - 2] || parts[0];
  const entropy = calculateShannonEntropy(primaryLabel);

  // 1. High Shannon entropy check
  if (primaryLabel.length >= 8 && entropy >= 3.8) {
    score += 45;
    reasons.push(`High Shannon entropy (${entropy}) in label "${primaryLabel}"`);
  } else if (primaryLabel.length >= 6 && entropy >= 3.4) {
    score += 25;
    reasons.push(`Elevated Shannon entropy (${entropy}) in label "${primaryLabel}"`);
  }

  // 2. High digit ratio check (e.g. ad1984210.com or s7890-trk)
  const digits = (primaryLabel.match(/\d/g) || []).length;
  const digitRatio = digits / primaryLabel.length;
  if (primaryLabel.length >= 6 && digitRatio > 0.4) {
    score += 30;
    reasons.push(`High numeric character density (${Math.round(digitRatio * 100)}%)`);
  }

  // 3. Hexadecimal hash pattern (e.g. 32-char MD5 or 40-char SHA1 tracking subdomain)
  if (/^[a-f0-9]{16,64}$/i.test(primaryLabel)) {
    score += 50;
    reasons.push('Matches hex hash signature characteristic of ephemeral tracking beacons');
  }

  // 4. Consonant cluster check (e.g., "bcdfghjkl")
  if (/[bcdfghjklmnpqrstvwxyz]{6,}/i.test(primaryLabel)) {
    score += 35;
    reasons.push('Unnatural consonant cluster without vowels (DGA signature)');
  }

  // 5. Excessive hyphenation (e.g. "trk-ad-bidding-bid-dsp-99")
  const hyphenCount = (primaryLabel.match(/-/g) || []).length;
  if (hyphenCount >= 3) {
    score += 20;
    reasons.push(`Excessive hyphenation (${hyphenCount} hyphens) in subdomain`);
  }

  return {
    isLikelyDga: score >= 50,
    score: Math.min(100, score),
    reasons,
  };
}

// Common two-part public suffixes / ccTLDs
export const COMPOUND_CCTLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'edu.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.jp', 'ne.jp', 'or.jp',
  'co.kr', 'ne.kr',
  'com.br', 'net.br', 'org.br',
  'com.mx', 'org.mx',
  'com.sg', 'org.sg',
  'co.za', 'org.za',
  'com.tr', 'org.tr',
  'com.tw', 'org.tw',
  'com.hk', 'org.hk',
]);

/**
 * Decomposes domain into SLD, TLD, subdomains and calculates Shannon entropy for each label.
 * Correctly accounts for compound ccTLDs (e.g. .co.uk, .com.au).
 * @beta
 */
export function decomposeDomain(domain: string): DomainDecomposition {
  const clean = domain.toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const parts = clean.split('.').filter(Boolean);

  if (parts.length <= 1) {
    const ent = calculateShannonEntropy(clean);
    return {
      sld: clean,
      tld: '',
      subdomains: [],
      labelEntropies: [{ label: clean, entropy: ent, isSuspicious: ent >= 3.8 }],
    };
  }

  let tld: string;
  let sld: string;
  let subdomains: string[];

  if (parts.length >= 3) {
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (COMPOUND_CCTLDS.has(lastTwo)) {
      tld = lastTwo;
      sld = parts[parts.length - 3];
      subdomains = parts.slice(0, parts.length - 3);
    } else {
      tld = parts[parts.length - 1];
      sld = parts[parts.length - 2];
      subdomains = parts.slice(0, parts.length - 2);
    }
  } else {
    tld = parts[parts.length - 1];
    sld = parts[parts.length - 2];
    subdomains = [];
  }

  const labelEntropies: DomainLabelEntropy[] = parts.map((label) => {
    const entropy = calculateShannonEntropy(label);
    const isSuspicious = label.length >= 7 && entropy >= 3.6;
    return { label, entropy, isSuspicious };
  });

  return {
    sld,
    tld,
    subdomains,
    labelEntropies,
  };
}

