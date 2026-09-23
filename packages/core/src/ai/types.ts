/**
 * AI Radar [Beta] - Types & Domain Models
 * @beta
 */
export type ThreatCategory =
  | 'Advertising'
  | 'Telemetry/Analytics'
  | 'CNAME Cloaking'
  | 'Malware/Phishing'
  | 'Clean'
  | 'Unknown';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';

export type AiVerdict = 'ad_server' | 'tracker' | 'malicious' | 'clean' | 'suspicious';

export type AiProviderType = 'mini-ai' | 'local-heuristics' | 'ollama' | 'gemini' | 'openai';

export interface MiniAiFeatureContribution {
  name: string;
  value: number;
  weight: number;
  impact: 'threat' | 'clean' | 'neutral';
  description: string;
}

export interface MiniAiPrediction {
  verdict: AiVerdict;
  category: ThreatCategory;
  confidence: number;
  riskLevel: RiskLevel;
  classProbabilities: Record<ThreatCategory, number>;
  topContributions: MiniAiFeatureContribution[];
  inferenceTimeMs: number;
  reasons: string[];
}

export interface AiProviderConfig {
  provider: AiProviderType;
  ollamaUrl?: string; // Default http://127.0.0.1:11434
  ollamaModel?: string; // Default llama3.2
  apiKey?: string;
  apiEndpoint?: string;
  modelName?: string;
  allowlist?: string[];
  bypassCache?: boolean;
  skipDns?: boolean;
  dnsTimeoutMs?: number;
}

export interface RuleCoverageResult {
  isCovered: boolean;
  coveringRule?: string;
}

export interface DomainLabelEntropy {
  label: string;
  entropy: number;
  isSuspicious: boolean;
}

export interface DomainDecomposition {
  sld: string;
  tld: string;
  subdomains: string[];
  labelEntropies: DomainLabelEntropy[];
}

export interface AiScanResult {
  target: string;
  domain: string;
  verdict: AiVerdict;
  confidence: number; // 0 to 100
  riskLevel: RiskLevel;
  category: ThreatCategory;
  reasons: string[];
  entropy: number;
  isLikelyDga: boolean;
  decomposition?: DomainDecomposition;
  cnames: string[];
  resolvedIps: string[];
  generatedRules: string[];
  coveredByRule?: string;
  featureScores?: Record<string, number>;
  inferenceTimeMs?: number;
  provider: AiProviderType;
  modelUsed?: string;
  timestamp: string;
}

export interface RawDnsQuery {
  domain: string;
  client?: string;
  timestamp?: string;
  elapsedMs?: number;
  blocked?: boolean;
}

export interface QueryLogScanResult {
  totalQueriesAnalyzed: number;
  flaggedCount: number;
  cleanCount: number;
  results: AiScanResult[];
  timestamp: string;
}

export interface CrawlScanResult {
  url: string;
  scannedAt: string;
  extractedHosts: string[];
  newUnblockedHosts: string[];
  flaggedHosts: AiScanResult[];
  synthesizedRules: string[];
}

/**
 * Target environments supported by the Rule Synthesizer.
 * @beta
 */
export type SynthesisTarget =
  | 'all'
  | 'adguard'
  | 'pihole'
  | 'ublock'
  | 'unbound'
  | 'dnsmasq'
  | 'hosts';

/**
 * Result of subdomain clustering and wildcard compaction.
 * @beta
 */
export interface CompactionResult {
  originalCount: number;
  compactedCount: number;
  compactedRules: string[];
  savingsPercent: number;
  collapsedGroups: Array<{
    parentDomain: string;
    subdomains: string[];
    rule: string;
  }>;
}

/**
 * Result of checking a block rule against existing allowlist rules.
 * @beta
 */
export interface RuleConflictResult {
  hasConflict: boolean;
  conflictingAllowRule?: string;
  suggestedOverrideRule?: string;
  reason?: string;
}

/**
 * Verdict of evaluating a domain against a set of filter rules.
 */
export type DomainVerdict = 'blocked' | 'exception' | 'not_blocked';

/**
 * Details of a filter rule matching a queried domain.
 */
export interface DomainRuleMatch {
  rule: string;
  pattern: string;
  isWildcard: boolean;
  isImportant: boolean;
  source?: string;
  ruleType?: string;
}

/**
 * Complete evaluation report of a domain against loaded filter rules.
 */
export interface DomainEvaluationResult {
  domain: string;
  verdict: DomainVerdict;
  matchingRule?: string;
  matchingRules: DomainRuleMatch[];
  exceptionRule?: string;
  overriddenRules: string[];
  details: string;
}

/**
 * Result of DGA pattern analysis on a domain.
 */
export interface DgaDetectionResult {
  isLikelyDga: boolean;
  score: number; // 0 (normal) to 100 (high probability machine generated)
  reasons: string[];
}

/**
 * Network infrastructure kind classified by heuristic analyzer.
 */
export type InfraKind =
  | 'ad-network'
  | 'tracker-network'
  | 'cloud'
  | 'cdn'
  | 'iot'
  | 'vendor'
  | 'platform'
  | 'dns'
  | 'none';

/**
 * Classification details for known network infrastructure.
 */
export interface InfraClassification {
  safe: boolean;
  adNetwork: boolean;
  kind: InfraKind;
  suffix?: string;
  reason: string;
}

/**
 * Lexical and behavioral feature signals used for reputation classification.
 */
export interface ReputationFeatures {
  brandSpoofScore: number;
  knownSafeInfra: number;
  adKeywordWeight: number;
  trackerKeywordWeight: number;
  trigramPerplexity: number;
  entropySld: number;
  entropySubdomain?: number;
  sldLength: number;
  highRiskTld: number;
  punycode: number;
  consecutiveConsonants: number;
  vowelRatio: number;
  userTuneBias?: number;
}

/**
 * Policy adjustment mapping raw model winner to final verdict policy.
 */
export interface CategoryAdjustment {
  category: ThreatCategory;
  probability: number;
  policyReason?: string;
}

/**
 * Input configuration for filter rule synthesizer.
 */
export interface RuleSynthesisInput {
  domain: string;
  verdict: AiVerdict;
  category: ThreatCategory;
  cnames?: string[];
  isSubdomain?: boolean;
  target?: SynthesisTarget;
  includeComments?: boolean;
  confidence?: number;
}

/**
 * Vector of extracted numerical features for domain threat classification.
 */
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
 * Result of CNAME chain traversal and cloaking detection.
 */
export interface CnameResolutionResult {
  domain: string;
  cnames: string[];
  ips: string[];
  hasCnameCloaking: boolean;
  cloakedTarget?: string;
  knownTrackerTarget?: string;
}

/**
 * Supported anti-adblock circumvention / detection providers.
 */
export type AntiAdblockProviderId =
  | 'admiral'
  | 'google-fc'
  | 'blockthrough'
  | 'adinplay'
  | 'ezoic'
  | 'nitropay'
  | 'snigel'
  | 'generic';

/**
 * Result of anti-adblock detection analysis.
 */
export interface AntiAdblockDetection {
  detected: boolean;
  provider?: AntiAdblockProviderId;
  providerName?: string;
  reason?: string;
}


