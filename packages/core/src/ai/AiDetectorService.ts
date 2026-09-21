import { calculateShannonEntropy, detectDgaPatterns, decomposeDomain } from './entropy.js';
import { resolveCnameChain } from './cnameResolver.js';
import { synthesizeRules } from './ruleSynthesizer.js';
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

// Suspicious ad and tracking keyword tokens commonly found in ephemeral ad servers
const SUSPICIOUS_AD_TOKENS = new Set([
  'ad', 'ads', 'adserver', 'adservice', 'adnxs', 'adform', 'adtech',
  'doubleclick', 'googleadservices', 'googlesyndication', 'moatads', 'amazon-adsystem',
  'bid', 'bidder', 'bidding', 'rtb', 'dsp', 'ssp', 'exchange',
  'pixel', 'beacon', 'collect', 'telemetry', 'analytics', 'tracker', 'tracking',
  'click', 'conversion', 'attribution', 'affiliate', 'stat', 'stats', 'counter',
  'popunder', 'popcash', 'propeller', 'outbrain', 'taboola', 'mgid',
  'revcontent', 'criteo', 'scorecardresearch', 'quantserve', 'branch',
  'pubmatic', 'rubiconproject', 'openx', 'casalemedia', 'smartadserver',
]);

// Curated high-reputation infrastructure, CDNs, and identity providers to protect against false positives
const KNOWN_SAFE_INFRASTRUCTURE = new Set([
  'github.com',
  'githubassets.com',
  'githubusercontent.com',
  'cloudflare.com',
  'cloudflare.net',
  'cdnjs.cloudflare.com',
  'jsdelivr.net',
  'unpkg.com',
  'googleapis.com',
  'gstatic.com',
  'google.com',
  'accounts.google.com',
  'apple.com',
  'appleid.apple.com',
  'icloud.com',
  'microsoft.com',
  'microsoftonline.com',
  'live.com',
  'windowsupdate.com',
  'amazon.com',
  'amazonaws.com',
  'aws.amazon.com',
  'wikipedia.org',
  'wikimedia.org',
  'mozilla.org',
  'mozilla.net',
  'one.one.one.one',
  'dns.google',
]);

/**
 * Intelligent AI Ad & Tracker Discovery Service [Beta]
 * Combines Shannon entropy, DGA detection, CNAME uncloaking, and multi-provider LLMs.
 * @beta
 */
export class AiDetectorService {
  private defaultConfig: AiProviderConfig;

  constructor(config?: Partial<AiProviderConfig>) {
    this.defaultConfig = {
      provider: config?.provider || 'local-heuristics',
      ollamaUrl: config?.ollamaUrl || 'http://127.0.0.1:11434',
      ollamaModel: config?.ollamaModel || 'llama3.2',
      apiKey: config?.apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '',
      apiEndpoint: config?.apiEndpoint,
      modelName: config?.modelName,
      allowlist: config?.allowlist || [],
    };
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
    const clean = domain.toLowerCase().trim();
    if (allowlist && allowlist.length > 0) {
      if (allowlist.some((al) => clean === al.toLowerCase() || clean.endsWith(`.${al.toLowerCase()}`))) {
        return true;
      }
    }
    if (KNOWN_SAFE_INFRASTRUCTURE.has(clean)) {
      return true;
    }
    for (const safe of KNOWN_SAFE_INFRASTRUCTURE) {
      if (clean.endsWith(`.${safe}`)) {
        return true;
      }
    }
    return false;
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

    // False positive protection guard
    if (this.isSafeInfrastructure(cleanDomain, config.allowlist)) {
      const decomposition = decomposeDomain(cleanDomain);
      return {
        target: domainOrUrl,
        domain: cleanDomain,
        verdict: 'clean',
        confidence: 99,
        riskLevel: 'none',
        category: 'Clean',
        reasons: ['Verified Essential Infrastructure / Whitelisted (Protected by False Positive Guard)'],
        entropy: calculateShannonEntropy(cleanDomain),
        isLikelyDga: false,
        decomposition,
        cnames: [],
        resolvedIps: [],
        generatedRules: [],
        provider: config.provider,
        timestamp: new Date().toISOString(),
      };
    }

    // 1. Run local lexical and entropy analysis
    const entropy = calculateShannonEntropy(cleanDomain);
    const dgaResult = detectDgaPatterns(cleanDomain);
    const decomposition = decomposeDomain(cleanDomain);

    // 2. Uncloak CNAME records and resolve destination IPs
    const cnameInfo = await resolveCnameChain(cleanDomain);

    // 3. Run heuristic pre-scoring
    const heuristicResult = this.evaluateHeuristics(cleanDomain, entropy, dgaResult, cnameInfo);

    let finalVerdict: AiVerdict = heuristicResult.verdict;
    let finalConfidence = heuristicResult.confidence;
    let finalCategory: ThreatCategory = heuristicResult.category;
    let finalRisk: RiskLevel = heuristicResult.riskLevel;
    const allReasons = [...heuristicResult.reasons];
    let modelUsed: string | undefined;

    // 4. If LLM provider is enabled, enhance with model reasoning
    if (config.provider !== 'local-heuristics') {
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

    return {
      target: domainOrUrl,
      domain: cleanDomain,
      verdict: finalVerdict,
      confidence: Math.round(finalConfidence),
      riskLevel: finalRisk,
      category: finalCategory,
      reasons: Array.from(new Set(allReasons)),
      entropy,
      isLikelyDga: dgaResult.isLikelyDga,
      decomposition,
      cnames: cnameInfo.cnames,
      resolvedIps: cnameInfo.ips,
      generatedRules,
      provider: config.provider,
      modelUsed,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Scans a batch of DNS queries from an AdGuard Home or Pi-hole query log.
   */
  public async scanQueryLog(
    queries: RawDnsQuery[],
    overrideConfig?: Partial<AiProviderConfig>,
  ): Promise<QueryLogScanResult> {
    const config = { ...this.defaultConfig, ...overrideConfig };

    // Deduplicate queries by domain
    const uniqueDomains = Array.from(
      new Set(queries.map((q) => this.normalizeDomain(q.domain)).filter(Boolean)),
    );

    const results: AiScanResult[] = [];
    const batchSize = 4;

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

    // 2. Keyword token analysis
    const matchedTokens: string[] = [];
    for (const token of SUSPICIOUS_AD_TOKENS) {
      if (token.length >= 4) {
        if (domain.includes(token)) {
          matchedTokens.push(token);
        }
      } else {
        const regex = new RegExp(`(?:^|[.-])${token}(?:[.-]|$)`, 'i');
        if (regex.test(domain)) {
          matchedTokens.push(token);
        }
      }
    }

    if (matchedTokens.length > 0) {
      const hasSpecificAdNetwork = matchedTokens.some((t) =>
        ['taboola', 'criteo', 'doubleclick', 'googleadservices', 'googlesyndication', 'outbrain', 'moatads', 'adnxs', 'rubiconproject', 'pubmatic'].includes(t),
      );
      score += hasSpecificAdNetwork ? 75 : Math.min(85, matchedTokens.length * 45);
      reasons.push(`Contains ad/telemetry keyword token(s): ${matchedTokens.join(', ')}`);
      if (category === 'Clean') {
        category = matchedTokens.some((t) => ['pixel', 'telemetry', 'analytics', 'beacon'].includes(t))
          ? 'Telemetry/Analytics'
          : 'Advertising';
      }
    }

    // 3. DGA / Entropy score
    if (dgaResult.isLikelyDga) {
      score += dgaResult.score * 0.6;
      reasons.push(...dgaResult.reasons);
      if (category === 'Clean') category = 'Advertising';
    } else if (entropy >= 3.6) {
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
      });

      if (!res.ok) {
        throw new Error(`Ollama HTTP error ${res.status}: ${res.statusText}`);
      }

      const json: any = await res.json();
      const parsed = JSON.parse(json.response);
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
      });

      if (!res.ok) {
        throw new Error(`Gemini API HTTP error ${res.status}: ${res.statusText}`);
      }

      const json: any = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini');

      const parsed = JSON.parse(text);
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
      });

      if (!res.ok) {
        throw new Error(`OpenAI HTTP error ${res.status}: ${res.statusText}`);
      }

      const json: any = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from OpenAI');

      const parsed = JSON.parse(content);
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
    const parsedPageUrl = new URL(pageUrl);
    const mainHost = parsedPageUrl.hostname.toLowerCase();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      timeout?.unref?.();

      const res = await fetch(pageUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!res.ok) return [];

      const html = await res.text();

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
    }

    return Array.from(origins);
  }
}
