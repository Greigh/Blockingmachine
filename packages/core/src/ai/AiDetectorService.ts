import { createHash } from 'node:crypto';
import { calculateShannonEntropy, detectDgaPatterns, decomposeDomain } from './entropy.js';
import { resolveCnameChain, isBenignCnameTarget } from './cnameResolver.js';
import { sanitizeDomain, synthesizeRules, isDomainCoveredByRules } from './ruleSynthesizer.js';
import { classifyDomainWithMiniAi, globalMiniAiClassifier } from './MiniAiClassifier.js';
import {
  SUSPICIOUS_AD_TOKENS,
  SUSPICIOUS_TRACKER_TOKENS,
  SPECIFIC_NETWORK_TOKENS,
  HIGH_ABUSE_TLDS,
  classifyInfrastructure,
  clampConfidencePercent,
  detectAntiAdblock,
  hasStrongAdIntent,
  hostnameHasToken,
  isActiveDirectoryOrLocalDomain,
  isBenignServiceEndpoint,
  isInstitutionalDomain,
  isTelemetryToken,
  normalizeHostname,
  scoreBrandSpoof,
} from './reputation.js';
import {
  clampConfidence,
  normalizeThreatCategory,
  normalizeVerdict,
  type AiProviderConfig,
  type AiScanResult,
  type AiVerdict,
  type CrawlScanResult,
  type QueryLogScanResult,
  type RawDnsQuery,
  type RiskLevel,
  type ThreatCategory,
} from './types.js';

import { isSafePublicWebUrl, type SafeUrlCheckResult } from '../utils/urlSafety.js';
export { isSafePublicWebUrl, type SafeUrlCheckResult };

type LlmAssessment = Pick<AiScanResult, 'verdict' | 'confidence' | 'category' | 'reasons'>;

interface ScanCacheEntry {
  result: AiScanResult;
  expiresAt: number;
}

/**
 * Opaque per-process credential identifiers. API keys are mapped to a counter so
 * they never enter hash input; a fresh id is issued if the map is ever cleared.
 */
const MAX_CREDENTIAL_IDS = 64;
const credentialIds = new Map<string, number>();
let nextCredentialId = 1;

function credentialId(secret: string | undefined): number {
  if (!secret) return 0;
  let id = credentialIds.get(secret);
  if (id === undefined) {
    if (credentialIds.size >= MAX_CREDENTIAL_IDS) credentialIds.clear();
    id = nextCredentialId++;
    credentialIds.set(secret, id);
  }
  return id;
}

/**
 * Intelligent AI Ad & Tracker Discovery Service [Beta]
 * Combines Shannon entropy, DGA detection, CNAME uncloaking, brand spoofing defenses,
 * embedded neural/logistic Mini-AI, and multi-provider LLMs.
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
      allowlist: [...(config?.allowlist || [])],
      bypassCache: config?.bypassCache || false,
      skipDns: config?.skipDns,
      dnsTimeoutMs: config?.dnsTimeoutMs,
      existingRules: [...(config?.existingRules || [])],
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

  public updateConfig(config: Partial<AiProviderConfig>): void {
    this.defaultConfig = structuredClone({ ...this.defaultConfig, ...config });
    this.clearCache();
  }

  public getConfig(): AiProviderConfig {
    return structuredClone(this.defaultConfig);
  }

  /**
   * Checks whether domain matches verified essential infrastructure, institutional domains,
   * enterprise internal endpoints, or user allowlists with zero false-positive protection.
   */
  public isSafeInfrastructure(domain: string, allowlist?: string[]): boolean {
    const clean = this.normalizeDomain(domain);
    if (!clean) return false;

    // 1. User feedback explicit override (False Positive correction)
    if (globalMiniAiClassifier.getDomainFeedback(clean) <= -0.9) {
      return true;
    }

    // 2. Explicit allowlist check
    if (allowlist && allowlist.length > 0) {
      if (
        allowlist.some((al) => {
          if (!al || typeof al !== 'string') return false;
          const norm = this.normalizeDomain(al);
          return !!norm && (clean === norm || clean.endsWith('.' + norm));
        })
      ) {
        return true;
      }
    }

    // 3. Localhost and loopback endpoints
    if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1') {
      return true;
    }

    // 4. Institutional domains (government, military, academic)
    if (isInstitutionalDomain(clean)) {
      return true;
    }

    // 5. Active Directory / Private enterprise network endpoints
    if (isActiveDirectoryOrLocalDomain(clean)) {
      return true;
    }

    // 6. Security red-lines: brand spoofs, advertising intent, and anti-adblock are never safe
    if (scoreBrandSpoof(clean) > 0 || hasStrongAdIntent(clean)) {
      return false;
    }
    const aab = detectAntiAdblock(clean);
    if (aab.detected) {
      return false;
    }

    // 7. Verified cloud, CDN, and infrastructure providers
    const infra = classifyInfrastructure(clean);
    if (infra.adNetwork || infra.kind === 'tracker-network') {
      return false;
    }
    if (infra.safe && (infra.kind === 'cdn' || infra.kind === 'cloud' || infra.kind === 'vendor')) {
      return true;
    }

    // 8. Recognized benign SaaS customer service, documentation, website builders, IdP
    if (isBenignCnameTarget(clean)) {
      return true;
    }

    // 9. Benign service endpoint on readable, non-abusive domain
    return isBenignServiceEndpoint(clean);
  }

  /**
   * Scans a single domain or URL for ad, tracker, CNAME cloaking, DGA, and phishing characteristics.
   */
  public async scanDomain(
    domainOrUrl: string,
    overrideConfig?: Partial<AiProviderConfig>,
  ): Promise<AiScanResult> {
    const config = structuredClone({ ...this.defaultConfig, ...overrideConfig });
    const cleanDomain = this.normalizeDomain(domainOrUrl);
    // Every setting that affects analysis participates in the key. Credentials are
    // replaced by an opaque id and large rule lists are hashed, never retained.
    const cacheKey = createHash('sha256').update(JSON.stringify([
      cleanDomain, config.provider, config.ollamaUrl, config.ollamaModel,
      credentialId(config.apiKey), config.apiEndpoint, config.modelName, config.allowlist,
      config.skipDns, config.dnsTimeoutMs, config.existingRules,
      globalMiniAiClassifier.getDomainFeedback(cleanDomain),
    ])).digest('hex');

    // 0. Check in-memory LRU/TTL cache
    if (!config.bypassCache) {
      const cached = this.scanCache.get(cacheKey);
      if (cached) {
        if (Date.now() < cached.expiresAt) {
          this.cacheHits++;
          // Refresh LRU position
          this.scanCache.delete(cacheKey);
          this.scanCache.set(cacheKey, cached);
          return {
            ...structuredClone(cached.result),
            target: domainOrUrl,
            timestamp: new Date().toISOString(),
          };
        } else {
          this.scanCache.delete(cacheKey);
        }
      }
    }
    this.cacheMisses++;

    // False positive protection guard
    if (this.isSafeInfrastructure(cleanDomain, config.allowlist)) {
      const decomposition = decomposeDomain(cleanDomain);
      const infra = classifyInfrastructure(cleanDomain);
      const allowlisted = !!config.allowlist?.some((entry) => {
        const item = this.normalizeDomain(entry);
        return !!item && (cleanDomain === item || cleanDomain.endsWith(`.${item}`));
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
        this.setCache(cacheKey, cleanResult);
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
          finalConfidence = llmResult.confidence;
          finalCategory = llmResult.category;
          finalRisk = this.verdictToRiskLevel(finalVerdict, finalConfidence);
          allReasons.length = 0;
          allReasons.push(...llmResult.reasons);
          modelUsed = llmResult.model;
        }
      } catch (err: any) {
        // Graceful fallback to heuristic evaluation
        allReasons.push(`(AI Model offline: evaluated via high-precision heuristics: ${err?.message || err})`);
      }
    }

    // 5. Existing rules coverage check
    let coveredByRule: string | undefined;
    if (config.existingRules && config.existingRules.length > 0) {
      const coverage = isDomainCoveredByRules(cleanDomain, config.existingRules);
      if (coverage.isCovered) {
        coveredByRule = coverage.coveringRule;
        allReasons.push(`Already covered by existing rule: ${coveredByRule}`);
      }
    }

    // 6. Synthesize recommended filter rules
    const generatedRules = synthesizeRules({
      domain: cleanDomain,
      verdict: finalVerdict,
      category: finalCategory,
      confidence: finalConfidence,
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
      coveredByRule,
      featureScores,
      inferenceTimeMs,
      provider: config.provider,
      modelUsed,
      timestamp: new Date().toISOString(),
    };

    if (!config.bypassCache) {
      this.setCache(cacheKey, scanResult);
    }

    return scanResult;
  }

  private setCache(key: string, result: AiScanResult): void {
    if (this.scanCache.size >= this.maxCacheEntries) {
      const oldestKey = this.scanCache.keys().next().value;
      if (oldestKey) this.scanCache.delete(oldestKey);
    }
    this.scanCache.set(key, {
      result: structuredClone(result),
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
    const batchSize = config.provider === 'mini-ai' || config.provider === 'local-heuristics' ? 32 : 4;

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

    // Scan extracted origins with bounded parallel concurrency (6 at a time)
    const candidates = extractedHosts.slice(0, 25);
    const BATCH_SIZE = 6;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map((host) => this.scanDomain(host, config)));
      for (const scan of batchResults) {
        if (scan.verdict !== 'clean') {
          flaggedHosts.push(scan);
          synthesizedRules.push(...scan.generatedRules);
        }
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
    if (typeof input !== 'string') return '';
    const host = normalizeHostname(input);
    const sanitized = sanitizeDomain(host);
    return sanitized || host;
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
      score += 50;
      category = 'CNAME Cloaking';
      reasons.push(`Suspicious CNAME cloaking detected: first-party alias points to third-party host ${cnameInfo.cloakedTarget}`);
    }

    // 2. Brand Spoofing & Phishing Check
    const brandSpoof = scoreBrandSpoof(domain);
    if (brandSpoof > 0) {
      score += Math.min(95, 60 + brandSpoof * 30);
      category = 'Malware/Phishing';
      reasons.push('Deceptive brand spoofing or credential harvesting pattern detected');
    }

    // 3. Known Ad / Tracker Infrastructure
    const infra = classifyInfrastructure(domain);
    if (infra.adNetwork) {
      score += 85;
      if (category === 'Clean') category = 'Advertising';
      reasons.push(infra.reason || 'Matches known advertising network infrastructure');
    } else if (infra.kind === 'tracker-network') {
      score += 85;
      if (category === 'Clean') category = 'Telemetry/Analytics';
      reasons.push(infra.reason || 'Matches known tracking or analytics network infrastructure');
    }

    // 4. Anti-Adblock Circumvention Detection
    const aab = detectAntiAdblock(domain);
    if (aab.detected) {
      score += 90;
      if (category === 'Clean') category = 'Advertising';
      reasons.push(aab.reason || 'Anti-adblock evasion detection and circumvention script provider');
    }

    // 5. Keyword token analysis (strict boundaries)
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

    // 6. DGA / Algorithmic Randomization
    const decomp = decomposeDomain(domain);
    const isHighAbuseTld = HIGH_ABUSE_TLDS.has(decomp.tld);

    if (dgaResult.isLikelyDga && matchedTokens.length === 0 && !cnameInfo.knownTrackerTarget && brandSpoof === 0) {
      if (dgaResult.score >= 70 || isHighAbuseTld) {
        score += Math.min(75, dgaResult.score * 0.7);
        if (category === 'Clean') category = 'Malware/Phishing';
        reasons.push(...dgaResult.reasons);
        reasons.push('High-probability algorithmic domain generation (DGA) pattern detected');
      } else {
        score += Math.min(25, dgaResult.score * 0.25);
        reasons.push(...dgaResult.reasons);
        reasons.push('Lexical pattern is unusual, but insufficient standalone evidence to block');
      }
    } else if (dgaResult.isLikelyDga) {
      score += dgaResult.score * 0.6;
      reasons.push(...dgaResult.reasons);
      if (category === 'Clean') category = 'Advertising';
    } else if (entropy >= 3.6 && matchedTokens.length > 0) {
      score += 20;
      reasons.push(`High lexical entropy (${entropy}) indicates dynamically generated hostname`);
    }

    // 7. Benign Service Exoneration Discount
    if (isBenignServiceEndpoint(domain) && brandSpoof === 0 && !infra.adNetwork && !aab.detected) {
      if (matchedTokens.length === 0 && !cnameInfo.knownTrackerTarget) {
        score = Math.max(0, score - 30);
        reasons.push('Standard operational or service endpoint characteristics');
      }
    }

    // Determine verdict based on combined score
    let verdict: AiVerdict = 'clean';
    if (category === 'Malware/Phishing' && score >= 65) {
      verdict = 'malicious';
    } else if (score >= 70) {
      verdict = category === 'Telemetry/Analytics' ? 'tracker' : category === 'CNAME Cloaking' ? 'tracker' : 'ad_server';
    } else if (score >= 40) {
      verdict = 'suspicious';
      if (category === 'Clean') category = 'Advertising';
    } else {
      category = 'Clean';
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

  private parseLlmJson(raw: unknown): LlmAssessment {
    if (typeof raw !== 'string') throw new Error('Missing model response text');
    let cleaned = raw.trim();
    // 1. Try markdown fenced json block
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    } else {
      // 2. Extract substring between first { and last }
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1).trim();
      }
    }
    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Model response must be a JSON object');
    }
    const result = parsed as Record<string, unknown>;
    if (typeof result.verdict !== 'string' || typeof result.confidence !== 'number'
      || !Number.isFinite(result.confidence)) {
      throw new Error('Model response requires a verdict and finite numeric confidence');
    }
    const verdict = normalizeVerdict(result.verdict);
    const fallbackCategory: Record<AiVerdict, ThreatCategory> = {
      clean: 'Clean', tracker: 'Telemetry/Analytics', ad_server: 'Advertising',
      malicious: 'Malware/Phishing', suspicious: 'Unknown',
    };
    const reasons = Array.isArray(result.reasons) ? result.reasons : [result.reasons];
    return {
      verdict,
      confidence: clampConfidence(result.confidence),
      category: normalizeThreatCategory(result.category, fallbackCategory[verdict]),
      reasons: [...new Set(reasons.filter((reason): reason is string => typeof reason === 'string')
        .map((reason) => reason.trim()).filter(Boolean))],
    };
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
  ): Promise<(LlmAssessment & { model: string }) | null> {
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
      const parsed = this.parseLlmJson(json.response);
      return {
        ...parsed,
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

      const parsed = this.parseLlmJson(text);
      return {
        ...parsed,
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

      const parsed = this.parseLlmJson(content);
      return {
        ...parsed,
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
    const timeout = setTimeout(() => controller.abort(), 3500);
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
