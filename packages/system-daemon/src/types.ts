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
