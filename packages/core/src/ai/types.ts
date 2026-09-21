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
