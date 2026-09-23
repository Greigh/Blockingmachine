import type { DomainDecomposition, DomainLabelEntropy, DgaDetectionResult } from './types.js';

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

export function detectDgaPatterns(domain: string): DgaDetectionResult {
  const reasons: string[] = [];
  let maxScore = 0;

  const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  if (!cleanDomain || !cleanDomain.includes('.')) {
    return { isLikelyDga: false, score: 0, reasons: [] };
  }

  const decomp = decomposeDomain(cleanDomain);
  const candidateLabels: string[] = [];

  // Exclude common structural prefixes (www, mail, cdn, api) when candidate has real subdomains
  const benignPrefixes = new Set(['www', 'mail', 'webmail', 'api', 'cdn', 'static', 'assets', 'ns1', 'ns2', 'ns']);

  if (decomp.sld && !benignPrefixes.has(decomp.sld)) {
    candidateLabels.push(decomp.sld);
  }
  for (const sub of decomp.subdomains) {
    if (sub && !benignPrefixes.has(sub)) {
      candidateLabels.push(sub);
    }
  }

  if (candidateLabels.length === 0) {
    candidateLabels.push(decomp.sld || cleanDomain.split('.')[0]);
  }

  for (const label of candidateLabels) {
    let labelScore = 0;
    const labelReasons: string[] = [];
    const unhyphenated = label.replace(/-/g, '');
    const entropy = calculateShannonEntropy(label);

    // 1. Mathematically calibrated Shannon entropy check:
    // Theoretical max entropy for length N is log2(N).
    // An 8-character string max entropy is 3.0; 10-char is 3.32; 14-char is 3.80.
    if (label.length >= 14 && entropy >= 3.65) {
      labelScore += 45;
      labelReasons.push(`High Shannon entropy (${entropy}) in label "${label}"`);
    } else if (label.length >= 10 && entropy >= 3.2) {
      labelScore += 35;
      labelReasons.push(`High Shannon entropy (${entropy}) in label "${label}"`);
    } else if (label.length >= 8 && entropy >= 2.85) {
      labelScore += 25;
      labelReasons.push(`Elevated Shannon entropy (${entropy}) in label "${label}"`);
    }

    // Normalized character entropy (ratio of distinct characters to maximum possible)
    if (label.length >= 8) {
      const maxPossibleEntropy = Math.log2(label.length);
      const normEntropy = maxPossibleEntropy > 0 ? entropy / maxPossibleEntropy : 0;
      if (normEntropy >= 0.96) {
        labelScore += 25;
        labelReasons.push(`High normalized character entropy (${Math.round(normEntropy * 100)}%) with zero natural repetition in "${label}"`);
      }
    }

    // 2. High digit ratio & long digit sequence check (e.g. ad1984210.com or s7890-trk)
    const digits = (label.match(/\d/g) || []).length;
    const digitRatio = digits / label.length;
    if (label.length >= 6 && digitRatio > 0.4) {
      labelScore += 30;
      labelReasons.push(`High numeric character density (${Math.round(digitRatio * 100)}%) in "${label}"`);
    }
    if (/\d{4,}/.test(label)) {
      labelScore += 20;
      labelReasons.push(`Consecutive numeric sequence in "${label}"`);
    }

    // 3. Hexadecimal hash pattern (e.g. 16-64 char MD5, SHA1, or UUID tracking subdomain)
    const hexCandidate = unhyphenated.replace(/^(?:trk|pixel|beacon|clk|track|node|id|c2|sess|session|client)[-_]?/i, '');
    if (/^[a-f0-9]{16,64}$/i.test(hexCandidate)) {
      labelScore += 50;
      labelReasons.push(`Matches hex hash signature characteristic of ephemeral tracking beacons in "${label}"`);
    }

    // 4. Consonant cluster check (e.g., "bcdfghjkl" or "qxzjkw")
    if (/[bcdfghjklmnpqrstvwxyz]{6,}/i.test(label)) {
      labelScore += 35;
      labelReasons.push(`Unnatural consonant cluster without vowels in "${label}" (DGA signature)`);
    } else if (/[bcdfghjklmnpqrstvwxyz]{5}/i.test(label) && !/(?:catch|str|ngth|thr|match|pitch|witch)/i.test(label)) {
      labelScore += 20;
      labelReasons.push(`Elevated consonant cluster density in "${label}"`);
    }

    // 5. Vowel ratio check
    const letters = label.replace(/[^a-z]/g, '');
    if (letters.length >= 8) {
      const vowels = (letters.match(/[aeiou]/g) || []).length;
      if (vowels / letters.length <= 0.1) {
        labelScore += 30;
        labelReasons.push(`Anomalously low vowel density in "${label}" (DGA signature)`);
      }
    } else if (letters.length >= 6) {
      const vowels = (letters.match(/[aeiou]/g) || []).length;
      if (vowels === 0) {
        labelScore += 35;
        labelReasons.push(`Zero vowel content in domain label "${label}" (DGA consonant string)`);
      }
    }

    // 6. Excessive hyphenation (e.g. "trk-ad-bidding-bid-dsp-99")
    const hyphenCount = (label.match(/-/g) || []).length;
    if (hyphenCount >= 3 && label.length >= 12) {
      labelScore += 20;
      labelReasons.push(`Excessive hyphenation (${hyphenCount} hyphens) in "${label}"`);
    }

    // 7. Alternating letter-digit sequence (Markov/character matrix DGA, e.g. x1y2z3a4b5)
    if (label.length >= 8 && /(?:[a-z]\d){3,}|(?:\d[a-z]){3,}/i.test(label)) {
      labelScore += 30;
      labelReasons.push(`Alternating letter-digit sequence characteristic of Markov DGA generators in "${label}"`);
    }

    // 8. Cyclic character repetition pattern (low-entropy botnet domain, e.g. ababababab)
    if (label.length >= 8 && /^(.{2,4})\1{2,}$/i.test(label)) {
      labelScore += 35;
      labelReasons.push(`Cyclic character repetition pattern characteristic of low-entropy botnet DGA in "${label}"`);
    }

    if (labelScore > maxScore) {
      maxScore = labelScore;
      reasons.length = 0;
      reasons.push(...labelReasons);
    } else if (labelScore === maxScore && labelScore > 0) {
      reasons.push(...labelReasons);
    }
  }

  return {
    isLikelyDga: maxScore >= 50,
    score: Math.min(100, maxScore),
    reasons: Array.from(new Set(reasons)),
  };
}

// Common two-part public suffixes / ccTLDs
export const COMPOUND_CCTLDS = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk',
  // Australia
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  // New Zealand
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'edu.nz', 'geek.nz',
  // Japan
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
  // South Korea
  'co.kr', 'ne.kr', 'or.kr', 're.kr', 'pe.kr', 'go.kr', 'mil.kr', 'ac.kr', 'hs.kr',
  // Brazil
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'mil.br', 'art.br',
  // Mexico
  'com.mx', 'org.mx', 'edu.mx', 'gob.mx', 'net.mx',
  // Singapore
  'com.sg', 'org.sg', 'net.sg', 'gov.sg', 'edu.sg', 'per.sg',
  // South Africa
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'edu.za', 'web.za',
  // Turkey
  'com.tr', 'org.tr', 'net.tr', 'gov.tr', 'edu.tr',
  // Taiwan
  'com.tw', 'org.tw', 'net.tw', 'gov.tw', 'edu.tw', 'idv.tw',
  // Hong Kong
  'com.hk', 'org.hk', 'net.hk', 'gov.hk', 'edu.hk', 'idv.hk',
  // India
  'co.in', 'net.in', 'org.in', 'gov.in', 'nic.in', 'ac.in', 'edu.in', 'res.in',
  // Canada
  'gc.ca',
  // China
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  // Argentina
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'gov.ar',
  // Colombia
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co', 'mil.co',
  // Philippines
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  // Pakistan
  'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk',
  // Nigeria
  'com.ng', 'net.ng', 'org.ng', 'gov.ng', 'edu.ng',
  // Ukraine
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua',
  // Israel
  'co.il', 'org.il', 'net.il', 'gov.il', 'ac.il', 'muni.il',
  // Russia
  'com.ru', 'net.ru', 'org.ru', 'gov.ru', 'edu.ru',
  // Spain
  'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es',
  // Poland
  'com.pl', 'net.pl', 'org.pl', 'info.pl', 'biz.pl',
  // Italy
  'gov.it', 'edu.it',
  // France
  'asso.fr', 'presse.fr', 'tm.fr', 'gouv.fr',
  // Germany
  'gov.de',
  // Greece
  'com.gr', 'edu.gr', 'net.gr', 'org.gr', 'gov.gr',
  // Portugal
  'com.pt', 'edu.pt', 'org.pt', 'gov.pt',
  // Malaysia
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  // Thailand
  'co.th', 'ac.th', 'go.th', 'or.th', 'net.th',
  // Vietnam
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn',
  // Indonesia
  'co.id', 'net.id', 'or.id', 'go.id', 'ac.id',
  // Chile, Peru, Venezuela
  'com.cl', 'gob.cl', 'com.pe', 'org.pe', 'net.pe', 'gob.pe', 'com.ve', 'net.ve', 'org.ve', 'gob.ve',
  // Ireland, Switzerland, Netherlands, Sweden, Norway, Austria
  'gov.ie', 'admin.ch', 'politie.nl', 'org.se', 'kommune.no', 'co.at', 'or.at', 'gv.at',
  // Middle East & North Africa
  'com.eg', 'gov.eg', 'com.sa', 'gov.sa', 'co.ae', 'gov.ae',
]);

// Dynamic DNS and serverless hosting domains where the sub-label is the real tenant SLD
export const DYNAMIC_DNS_SUFFIXES = new Set([
  'duckdns.org', 'no-ip.org', 'no-ip.biz', 'no-ip.info', 'ngrok-free.app',
  'ddns.net', 'zapto.org', 'bounceme.net', 'hopto.org', 'freeddns.org',
  'dynu.net', 'github.io', 'workers.dev', 'pages.dev', 'vercel.app',
  'netlify.app', 'web.app', 'firebaseapp.com', 'glitch.me',
]);

/**
 * Decomposes domain into SLD, TLD, subdomains and calculates Shannon entropy for each label.
 * Correctly accounts for compound ccTLDs (e.g. .co.uk, .com.au) and dynamic DNS providers.
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
    if (COMPOUND_CCTLDS.has(lastTwo) || DYNAMIC_DNS_SUFFIXES.has(lastTwo)) {
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

