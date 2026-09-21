export type ThreatCategory =
  | 'Advertising'
  | 'Telemetry/Analytics'
  | 'CNAME Cloaking'
  | 'Malware/Phishing'
  | 'Clean'
  | 'Unknown';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';

export type AiVerdict = 'ad_server' | 'tracker' | 'malicious' | 'clean' | 'suspicious';

export type AiProviderType = 'local-heuristics' | 'ollama' | 'gemini' | 'openai';

export interface AiProviderConfig {
  provider: AiProviderType;
  ollamaUrl?: string; // Default http://127.0.0.1:11434
  ollamaModel?: string; // Default llama3.2
  apiKey?: string;
  apiEndpoint?: string;
  modelName?: string;
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
  cnames: string[];
  resolvedIps: string[];
  generatedRules: string[];
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
