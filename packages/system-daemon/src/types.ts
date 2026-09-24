export interface DaemonConfig {
  bindHost: string;
  dnsPort: number;
  controlPort: number;
  upstreamDoHUrl: string;
  sinkholeIpv4: string;
  sinkholeIpv6: string;
  feedUrl: string;
}

export type DnsVerdict = 'BLOCKED' | 'ALLOWED' | 'EXCEPTION';

export interface EvaluationResult {
  domain: string;
  verdict: DnsVerdict;
  matchingRule?: string;
  isImportant?: boolean;
}

export interface QueryTelemetryEntry {
  domain: string;
  verdict: DnsVerdict;
  timestamp: string;
  clientIp?: string;
  matchingRule?: string;
}

export interface DaemonStats {
  totalQueries: number;
  blockedQueries: number;
  allowedQueries: number;
  rulesLoaded: number;
  uptimeSeconds: number;
  recentQueries: QueryTelemetryEntry[];
}

export interface DaemonStatusResponse {
  status: 'running' | 'paused';
  port: number;
  controlPort: number;
  upstream: string;
  rulesLoaded: number;
  protectionEnabled: boolean;
  uptimeSeconds: number;
  stats: {
    totalQueries: number;
    blockedQueries: number;
    allowedQueries: number;
    blockRatePercent: number;
  };
}
