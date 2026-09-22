import { calculateShannonEntropy, detectDgaPatterns, decomposeDomain } from './entropy.js';
import { resolveCnameChain } from './cnameResolver.js';
import { sanitizeDomain, synthesizeRules } from './ruleSynthesizer.js';
import { classifyDomainWithMiniAi } from './MiniAiClassifier.js';
import {
  SUSPICIOUS_AD_TOKENS,
  SUSPICIOUS_TRACKER_TOKENS,
  SPECIFIC_NETWORK_TOKENS,
  classifyInfrastructure,
  clampConfidencePercent,
  hasStrongAdIntent,
  hostnameHasToken,
  isBenignServiceEndpoint,
  isTelemetryToken,
  scoreBrandSpoof,
} from './reputation.js';
import type {
  AiProviderConfig,
  AiScanResult,
  AiVerdict,
  CrawlScanResult,
  QueryLogScanResult,
  RawDnsQuery,
  RiskLevel,
  ThreatCategory,
} from './types.js';

export interface SafeUrlCheckResult {
  isSafe: boolean;
  reason?: string;
}

/**
 * Validates whether a target URL is safe for web crawling and canary analysis.
 * Strictly blocks private RFC 1918 subnets, loopback, link-local metadata (169.254.169.254),
 * local network hostnames (.local, .lan, localhost), and non-HTTP(S) protocols against SSRF attacks.
 * @beta
 */
export function isSafePublicWebUrl(urlStr: string): SafeUrlCheckResult {
  if (!urlStr || typeof urlStr !== 'string') {
    return { isSafe: false, reason: 'URL must be a non-empty string' };
  }

  let toParse = urlStr.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(toParse)) {
    if (!/^https?:\/\//i.test(toParse)) {
      const scheme = toParse.split(':')[0].toLowerCase();
      return { isSafe: false, reason: `Forbidden protocol "${scheme}:": only http and https are permitted` };
    }
  } else {
    toParse = `https://${toParse}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(toParse);
  } catch {
    return { isSafe: false, reason: 'Malformed or invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { isSafe: false, reason: `Forbidden protocol "${parsed.protocol}": only http and https are permitted` };
  }

  let host = parsed.hostname.toLowerCase().trim();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  ) {
    return { isSafe: false, reason: 'Target resolved to localhost or internal network domain' };
  }

  if (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc00:') ||
    host.startsWith('fd00:')
  ) {
    return { isSafe: false, reason: 'Target resolved to IPv6 loopback, link-local, or private address' };
  }

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [o0, o1, o2, o3] = [
      Number(ipv4Match[1]),
      Number(ipv4Match[2]),
      Number(ipv4Match[3]),
      Number(ipv4Match[4]),
    ];
    if (o0 > 255 || o1 > 255 || o2 > 255 || o3 > 255) {
      return { isSafe: false, reason: 'Invalid IPv4 address' };
    }

    // Loopback 127.0.0.0/8
    if (o0 === 127) {
      return { isSafe: false, reason: 'Target is IPv4 loopback address (127.0.0.0/8)' };
    }
    // Unspecified 0.0.0.0/8
    if (o0 === 0) {
      return { isSafe: false, reason: 'Target is IPv4 unspecified address (0.0.0.0/8)' };
    }
    // Link-local / Cloud metadata 169.254.0.0/16
    if (o0 === 169 && o1 === 254) {
      return { isSafe: false, reason: 'Target is link-local or cloud metadata address (169.254.0.0/16)' };
    }
    // RFC 1918 Private Subnets
    if (o0 === 10) {
      return { isSafe: false, reason: 'Target is RFC 1918 private subnet (10.0.0.0/8)' };
    }
    if (o0 === 172 && o1 >= 16 && o1 <= 31) {
      return { isSafe: false, reason: 'Target is RFC 1918 private subnet (172.16.0.0/12)' };
    }
    if (o0 === 192 && o1 === 168) {
      return { isSafe: false, reason: 'Target is RFC 1918 private subnet (192.168.0.0/16)' };
    }
    // Broadcast 255.255.255.255
    if (o0 === 255 && o1 === 255 && o2 === 255 && o3 === 255) {
      return { isSafe: false, reason: 'Target is broadcast address' };
    }
    // Documentation / Test networks RFC 5737
    if (o0 === 192 && o1 === 0 && o2 === 2) {
      return { isSafe: false, reason: 'Target is documentation/test address (192.0.2.0/24)' };
    }
    if (o0 === 198 && o1 === 51 && o2 === 100) {
      return { isSafe: false, reason: 'Target is documentation/test address (198.51.100.0/24)' };
    }
    if (o0 === 203 && o1 === 0 && o2 === 113) {
      return { isSafe: false, reason: 'Target is documentation/test address (203.0.113.0/24)' };
    }
  }

  return { isSafe: true };
}

interface ScanCacheEntry {
  result: AiScanResult;
  expiresAt: number;
}

/**
 * Intelligent AI Ad & Tracker Discovery Service [Beta]
 * Combines Shannon entropy, DGA detection, CNAME uncloaking, and multi-provider LLMs.
 * @beta
 */
export class AiDetectorService {
  private defaultConfig: AiProviderConfig;
  private scanCache = new Map<string, ScanCacheEntry>();
  private readonly maxCacheEntries = 500;
  private readonly cacheTtlMs = 15 * 60 * 1000; // 15 minutes
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(config?: Partial<AiProviderConfig>) {
    this.defaultConfig = {
      provider: config?.provider || 'mini-ai',
      ollamaUrl: config?.ollamaUrl || 'http://127.0.0.1:11434',
      ollamaModel: config?.ollamaModel || 'llama3.2',
      apiKey: config?.apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '',
      apiEndpoint: config?.apiEndpoint,
      modelName: config?.modelName,
      allowlist: config?.allowlist || [],
      bypassCache: config?.bypassCache || false,
    };
  }

  public getCacheStats(): { size: number; maxEntries: number; hits: number; misses: number } {
    return {
      size: this.scanCache.size,
      maxEntries: this.maxCacheEntries,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }

  public clearCache(): void {
    this.scanCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  public updateConfig(config: Partial<AiProviderConfig>) {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  public getConfig(): AiProviderConfig {
    return { ...this.defaultConfig };
  }

  /**
   * Checks whether domain matches verified essential infrastructure or user allowlist.
   */
  public isSafeInfrastructure(domain: string, allowlist?: string[]): boolean {
    const clean = this.normalizeDomain(domain);
    if (allowlist && allowlist.length > 0) {
      if (allowlist.some((al) => clean === al.toLowerCase() || clean.endsWith(`.${al.toLowerCase()}`))) {
        return true;
      }
    }
    if (scoreBrandSpoof(clean) > 0 || hasStrongAdIntent(clean)) return false;
    const infra = classifyInfrastructure(clean);
    if (infra.adNetwork || infra.kind === 'tracker-network') return false;
    if (infra.safe) return true;
    return isBenignServiceEndpoint(clean);
  }

  /**
   * Scans a single domain or URL for ad/tracker characteristics.
   */
  public async scanDomain(
    domainOrUrl: string,
    overrideConfig?: Partial<AiProviderConfig>,
  ): Promise<AiScanResult> {
    const config = { ...this.defaultConfig, ...overrideConfig };
    const cleanDomain = this.normalizeDomain(domainOrUrl);

    // 0. Check in-memory LRU/TTL cache
    if (!config.bypassCache) {
      const cached = this.scanCache.get(cleanDomain);
      if (cached) {
        if (Date.now() < cached.expiresAt) {
          this.cacheHits++;
          // Refresh LRU position
          this.scanCache.delete(cleanDomain);
          this.scanCache.set(cleanDomain, cached);
          return {
            ...cached.result,
            timestamp: new Date().toISOString(),
          };
        } else {
          this.scanCache.delete(cleanDomain);
        }
      }
    }
    this.cacheMisses++;

    // False positive protection guard
    if (this.isSafeInfrastructure(cleanDomain, config.allowlist)) {
      const decomposition = decomposeDomain(cleanDomain);
      const infra = classifyInfrastructure(cleanDomain);
      const allowlisted = !!config.allowlist?.some((entry) => {
        const item = entry.toLowerCase();
        return cleanDomain === item || cleanDomain.endsWith(`.${item}`);
      });
      const guardDetail = infra.safe
        ? infra.reason
        : allowlisted
          ? 'Verified Essential Infrastructure / Whitelisted'
          : 'Product status, API, CDN, or update endpoint';
      const cleanResult: AiScanResult = {
        target: domainOrUrl,
        domain: cleanDomain,
        verdict: 'clean',
        confidence: 99,
        riskLevel: 'none',
        category: 'Clean',
        reasons: [`${guardDetail} (Protected by False Positive Guard)`],
        entropy: calculateShannonEntropy(cleanDomain),
        isLikelyDga: false,
        decomposition,
        cnames: [],
        resolvedIps: [],
        generatedRules: [],
        provider: config.provider,
        timestamp: new Date().toISOString(),
      };

      if (!config.bypassCache) {
        this.setCache(cleanDomain, cleanResult);
      }

      return cleanResult;
    }

    // 1. Run local lexical and entropy analysis
    const entropy = calculateShannonEntropy(cleanDomain);
    const dgaResult = detectDgaPatterns(cleanDomain);
    const decomposition = decomposeDomain(cleanDomain);

    // 2. Uncloak CNAME records and resolve destination IPs
    const cnameInfo = config.skipDns
      ? { domain: cleanDomain, cnames: [], ips: [], hasCnameCloaking: false }
      : await resolveCnameChain(cleanDomain, config.dnsTimeoutMs ?? 600);

    // 3. Run heuristic pre-scoring
    const heuristicResult = this.evaluateHeuristics(cleanDomain, entropy, dgaResult, cnameInfo);

    let finalVerdict: AiVerdict = heuristicResult.verdict;
    let finalConfidence = heuristicResult.confidence;
    let finalCategory: ThreatCategory = heuristicResult.category;
    let finalRisk: RiskLevel = heuristicResult.riskLevel;
    const allReasons = [...heuristicResult.reasons];
    let modelUsed: string | undefined;
    let featureScores: Record<string, number> | undefined;
    let inferenceTimeMs: number | undefined;

    // 4. If Mini-AI is selected (Default), run embedded neural/logistic model (<0.05ms)
    if (config.provider === 'mini-ai') {
      const miniPrediction = classifyDomainWithMiniAi(cleanDomain, {
        cnames: cnameInfo.cnames,
        hasCnameCloaking: cnameInfo.hasCnameCloaking,
        knownTrackerTarget: cnameInfo.knownTrackerTarget,
        allowlist: config.allowlist,
      });

      finalVerdict = miniPrediction.verdict;
      finalConfidence = miniPrediction.confidence;
      finalCategory = miniPrediction.category;
      finalRisk = miniPrediction.riskLevel;
      allReasons.length = 0;
      allReasons.push(...miniPrediction.reasons);
      modelUsed = 'Mini-AI Embedded Classifier (v1)';
      inferenceTimeMs = miniPrediction.inferenceTimeMs;
      featureScores = {
        entropy,
        dgaScore: dgaResult.score,
        confidence: miniPrediction.confidence,
        ...miniPrediction.classProbabilities,
      };
    } else if (config.provider !== 'local-heuristics') {
      // If external LLM provider is enabled (Ollama, Gemini, OpenAI)
      try {
        const llmResult = await this.queryLlm(cleanDomain, config, {
          entropy,
          dgaScore: dgaResult.score,
          cnames: cnameInfo.cnames,
          cloakedTarget: cnameInfo.knownTrackerTarget || cnameInfo.cloakedTarget,
          preliminaryVerdict: heuristicResult.verdict,
        });

        if (llmResult) {
          finalVerdict = llmResult.verdict;
          finalConfidence = Math.max(finalConfidence, llmResult.confidence);
          finalCategory = llmResult.category;
          finalRisk = this.verdictToRiskLevel(finalVerdict, finalConfidence);
          allReasons.push(...llmResult.reasons);
          modelUsed = llmResult.model;
        }
      } catch (err: any) {
        // Graceful fallback to heuristic evaluation
        allReasons.push(`(AI Model offline: evaluated via high-precision heuristics: ${err?.message || err})`);
      }
    }

    // 5. Synthesize recommended filter rules
    const generatedRules = synthesizeRules({
      domain: cleanDomain,
      verdict: finalVerdict,
      category: finalCategory,
      cnames: cnameInfo.cnames,
    });

    const scanResult: AiScanResult = {
      target: domainOrUrl,
      domain: cleanDomain,
      verdict: finalVerdict,
      confidence: clampConfidencePercent(finalConfidence),
      riskLevel: finalRisk,
      category: finalCategory,
      reasons: Array.from(new Set(allReasons)),
      entropy,
      isLikelyDga: dgaResult.isLikelyDga,
      decomposition,
      cnames: cnameInfo.cnames,
      resolvedIps: cnameInfo.ips,
      generatedRules,
      featureScores,
      inferenceTimeMs,
      provider: config.provider,
      modelUsed,
      timestamp: new Date().toISOString(),
    };

    if (!config.bypassCache) {
      this.setCache(cleanDomain, scanResult);
    }

    return scanResult;
  }

  private setCache(key: string, result: AiScanResult): void {
    if (this.scanCache.size >= this.maxCacheEntries) {
      const oldestKey = this.scanCache.keys().next().value;
      if (oldestKey) this.scanCache.delete(oldestKey);
    }
    this.scanCache.set(key, {
      result,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  /**
   * Scans a batch of DNS queries from an AdGuard Home or Pi-hole query log.
   */
  public async scanQueryLog(
    queries: RawDnsQuery[],
    overrideConfig?: Partial<AiProviderConfig>,
  ): Promise<QueryLogScanResult> {
    const config: AiProviderConfig = {
      ...this.defaultConfig,
      skipDns: true,
      ...overrideConfig,
    };

    // Deduplicate queries by domain
    const uniqueDomains = Array.from(
      new Set(queries.map((q) => this.normalizeDomain(q.domain)).filter(Boolean)),
    );

    const results: AiScanResult[] = [];
    const batchSize = (config.provider === 'mini-ai' || config.provider === 'local-heuristics') ? 32 : 4;

    for (let i = 0; i < uniqueDomains.length; i += batchSize) {
      const batch = uniqueDomains.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((domain) => this.scanDomain(domain, config)),
      );
      results.push(...batchResults);
    }

    const flaggedCount = results.filter((r) => r.verdict !== 'clean').length;
    const cleanCount = results.filter((r) => r.verdict === 'clean').length;

    return {
      totalQueriesAnalyzed: uniqueDomains.length,
      flaggedCount,
      cleanCount,
      results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Crawls a webpage, extracts outbound script/iframe/beacon hostnames, and evaluates them.
   */
  public async crawlAndScanUrl(
    targetUrl: string,
    overrideConfig?: Partial<AiProviderConfig>,
  ): Promise<CrawlScanResult> {
    const config = { ...this.defaultConfig, ...overrideConfig };
    let fullUrl = targetUrl.trim();
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
      fullUrl = `https://${fullUrl}`;
    }

    // SSRF Guard Check
    const safety = isSafePublicWebUrl(fullUrl);
    if (!safety.isSafe) {
      throw new Error(`SSRF Guard blocked crawl request to "${fullUrl}": ${safety.reason}`);
    }

    const extractedHosts = await this.extractWebpageOrigins(fullUrl);
    const flaggedHosts: AiScanResult[] = [];
    const synthesizedRules: string[] = [];

    // Scan extracted origins
    for (const host of extractedHosts.slice(0, 25)) {
      const scan = await this.scanDomain(host, config);
      if (scan.verdict !== 'clean') {
        flaggedHosts.push(scan);
        synthesizedRules.push(...scan.generatedRules);
      }
    }

    return {
      url: fullUrl,
      scannedAt: new Date().toISOString(),
      extractedHosts,
      newUnblockedHosts: extractedHosts,
      flaggedHosts,
      synthesizedRules: Array.from(new Set(synthesizedRules)),
    };
  }

  // --- Internal Helper Methods ---

  private normalizeDomain(input: string): string {
    const sanitized = sanitizeDomain(input);
    if (sanitized) return sanitized;
    let clean = input.trim().toLowerCase();
    clean = clean.replace(/^[a-z]+:\/\//i, '');
    clean = clean.split('/')[0];
    clean = clean.split(':')[0];
    clean = clean.replace(/^\.+|\.+$/g, '');
    return clean;
  }

  private evaluateHeuristics(
    domain: string,
    entropy: number,
    dgaResult: { isLikelyDga: boolean; score: number; reasons: string[] },
    cnameInfo: { hasCnameCloaking: boolean; cloakedTarget?: string; knownTrackerTarget?: string },
  ): { verdict: AiVerdict; confidence: number; category: ThreatCategory; riskLevel: RiskLevel; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;
    let category: ThreatCategory = 'Clean';

    // 1. CNAME Cloaking check
    if (cnameInfo.knownTrackerTarget) {
      score += 85;
      category = 'CNAME Cloaking';
      reasons.push(`CNAME cloaking unmasked: points to known tracking network ${cnameInfo.knownTrackerTarget}`);
    } else if (cnameInfo.hasCnameCloaking && cnameInfo.cloakedTarget) {
      score += 40;
      reasons.push(`Domain aliases external third-party CNAME target: ${cnameInfo.cloakedTarget}`);
    }

    // 2. Keyword token analysis (boundaries, so "status" is not "stat")
    const matchedTokens: string[] = [];
    const keywordTokens = [...SUSPICIOUS_AD_TOKENS, ...SUSPICIOUS_TRACKER_TOKENS];
    for (const token of keywordTokens) {
      if (hostnameHasToken(domain, token)) matchedTokens.push(token);
    }

    if (matchedTokens.length > 0) {
      const hasSpecificAdNetwork = matchedTokens.some((t) => SPECIFIC_NETWORK_TOKENS.has(t));
      score += hasSpecificAdNetwork ? 75 : Math.min(85, matchedTokens.length * 45);
      reasons.push(`Contains ad/telemetry keyword token(s): ${matchedTokens.join(', ')}`);
      if (category === 'Clean') {
        category = matchedTokens.some((t) => isTelemetryToken(t))
          ? 'Telemetry/Analytics'
          : 'Advertising';
      }
    }

    // 3. DGA / entropy. Lexical shape alone is not an ad or malware verdict.
    if (dgaResult.isLikelyDga && matchedTokens.length === 0 && !cnameInfo.knownTrackerTarget) {
      score += Math.min(20, dgaResult.score * 0.2);
      reasons.push(...dgaResult.reasons);
      reasons.push('Lexical pattern is unusual, but there is no ad, tracker, or phishing evidence');
    } else if (dgaResult.isLikelyDga) {
      score += dgaResult.score * 0.6;
      reasons.push(...dgaResult.reasons);
      if (category === 'Clean') category = 'Advertising';
    } else if (entropy >= 3.6 && matchedTokens.length > 0) {
      score += 20;
      reasons.push(`High lexical entropy (${entropy}) indicates dynamically generated hostname`);
    }

    // Determine verdict based on combined score
    let verdict: AiVerdict = 'clean';
    if (score >= 70) {
      verdict = category === 'Telemetry/Analytics' ? 'tracker' : 'ad_server';
    } else if (score >= 40) {
      verdict = 'suspicious';
      if (category === 'Clean') category = 'Advertising';
    } else {
      reasons.push('No anomalous ad tech, tracking tokens, or CNAME cloaking detected');
    }

    const confidence = Math.min(99, Math.max(15, score));
    const riskLevel = this.verdictToRiskLevel(verdict, confidence);

    return { verdict, confidence, category, riskLevel, reasons };
  }

  private verdictToRiskLevel(verdict: AiVerdict, confidence: number): RiskLevel {
    if (verdict === 'malicious') return 'critical';
    if (verdict === 'ad_server' || verdict === 'tracker') {
      return confidence >= 75 ? 'high' : 'medium';
    }
    if (verdict === 'suspicious') return 'medium';
    return 'none';
  }

  private async queryLlm(
    domain: string,
    config: AiProviderConfig,
    context: {
      entropy: number;
      dgaScore: number;
      cnames: string[];
      cloakedTarget?: string;
      preliminaryVerdict: string;
    },
  ): Promise<{ verdict: AiVerdict; confidence: number; category: ThreatCategory; reasons: string[]; model: string } | null> {
    const prompt = `Analyze this domain for network-level ad blocking and telemetry detection:
Domain: "${domain}"
Context:
- Shannon Entropy: ${context.entropy}
- DGA Machine Score: ${context.dgaScore}/100
- CNAME Chain: ${context.cnames.join(' -> ') || 'None'}
- Cloaked Target: ${context.cloakedTarget || 'None'}
- Preliminary Assessment: ${context.preliminaryVerdict}

Classify whether this hostname is an advertising server, user tracker, telemetry beacon, malicious domain, or clean service.
Respond ONLY with a valid JSON object matching this schema:
{
  "verdict": "ad_server" | "tracker" | "malicious" | "clean" | "suspicious",
  "confidence": number between 1 and 100,
  "category": "Advertising" | "Telemetry/Analytics" | "CNAME Cloaking" | "Malware/Phishing" | "Clean",
  "reasons": ["string explaining specific technical findings"]
}`;

    const parseLlmJson = (raw: string): any => {
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      }
      return JSON.parse(cleaned);
    };

    // 1. Local Ollama Provider
    if (config.provider === 'ollama') {
      const ollamaUrl = config.ollamaUrl || 'http://127.0.0.1:11434';
      const model = config.ollamaModel || 'llama3.2';

      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          format: 'json',
          stream: false,
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!res.ok) {
        throw new Error(`Ollama HTTP error ${res.status}: ${res.statusText}`);
      }

      const json: any = await res.json();
      const parsed = parseLlmJson(json.response);
      return {
        verdict: parsed.verdict,
        confidence: Number(parsed.confidence) || 80,
        category: parsed.category || 'Advertising',
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [String(parsed.reasons)],
        model: `ollama/${model}`,
      };
    }

    // 2. Google Gemini API Provider
    if (config.provider === 'gemini') {
      const apiKey = config.apiKey;
      if (!apiKey) throw new Error('Missing Gemini API key');

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!res.ok) {
        throw new Error(`Gemini API HTTP error ${res.status}: ${res.statusText}`);
      }

      const json: any = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini');

      const parsed = parseLlmJson(text);
      return {
        verdict: parsed.verdict,
        confidence: Number(parsed.confidence) || 85,
        category: parsed.category || 'Advertising',
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [String(parsed.reasons)],
        model: 'gemini-2.0-flash',
      };
    }

    // 3. OpenAI or OpenAI-compatible endpoint
    if (config.provider === 'openai') {
      const endpoint = config.apiEndpoint || 'https://api.openai.com/v1';
      const model = config.modelName || 'gpt-4o-mini';
      const apiKey = config.apiKey;

      const res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!res.ok) {
        throw new Error(`OpenAI HTTP error ${res.status}: ${res.statusText}`);
      }

      const json: any = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from OpenAI');

      const parsed = parseLlmJson(content);
      return {
        verdict: parsed.verdict,
        confidence: Number(parsed.confidence) || 85,
        category: parsed.category || 'Advertising',
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [String(parsed.reasons)],
        model: `openai/${model}`,
      };
    }

    return null;
  }

  private async extractWebpageOrigins(pageUrl: string): Promise<string[]> {
    const origins = new Set<string>();

    const safeCheck = isSafePublicWebUrl(pageUrl);
    if (!safeCheck.isSafe) {
      return [];
    }

    const parsedPageUrl = new URL(pageUrl);
    const mainHost = parsedPageUrl.hostname.toLowerCase();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    timeout?.unref?.();

    try {
      const res = await fetch(pageUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!res.ok) return [];

      // Open redirect guard: check final destination URL
      if (res.url && !isSafePublicWebUrl(res.url).isSafe) {
        return [];
      }

      // Memory-safe stream reading capped at 2MB to prevent DoS / OOM crashes
      let html = '';
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let totalBytes = 0;
        const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB limit

        try {
          while (totalBytes < MAX_HTML_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalBytes += value.length;
              html += decoder.decode(value, { stream: true });
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      }

      // Extract script src, iframe src, and img src attributes
      const srcMatches = html.matchAll(/(?:src|href)=["'](https?:\/\/[^"'\s>]+)["']/gi);
      for (const match of srcMatches) {
        try {
          const u = new URL(match[1]);
          const host = u.hostname.toLowerCase();
          if (host && host !== mainHost && !host.endsWith(`.${mainHost}`)) {
            origins.add(host);
          }
        } catch {
          // ignore invalid URLs
        }
      }

      // Extract prebid / OpenRTB partner endpoint domains in inline javascript
      const inlineDomainMatches = html.matchAll(/(?:https?:\/\/)?([a-zA-Z0-9.-]+\.(?:bid|ad|media|pubmatic|rubiconproject|openx|criteo|casalemedia|smartadserver|taboola|outbrain|appnexus)\.[a-z]{2,})/gi);
      for (const match of inlineDomainMatches) {
        const host = match[1].toLowerCase();
        if (host && host !== mainHost) {
          origins.add(host);
        }
      }
    } catch {
      // Return any collected origins
    } finally {
      clearTimeout(timeout);
    }

    return Array.from(origins);
  }
}
