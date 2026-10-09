export interface DaemonConfig {
  bindHost: string;
  dnsPort: number;
  controlPort: number;
  upstreamDoHUrl: string;
  sinkholeIpv4: string;
  sinkholeIpv6: string;
  feedUrl: string;
  /**
   * Persisted copy of the rule feed on disk (`FEED_FILE`). When every HTTP candidate is
   * unreachable — an orphaned daemon whose hub quit, or a launchd/systemd service that
   * runs without the app — the loader falls back to the last compiled list rather than
   * starting on an invented baseline.
   */
  feedFile?: string;
  /** Persisted copy of the AI quarantine feed (`THREATS_FILE`), same fallback role. */
  threatsFile?: string;
  /**
   * JSONL stream of per-domain DNS observations (`OBSERVATIONS_FILE`) — the behavioural
   * input `ai-training` needs for the v3 feature set (real `observed_at`, CNAME-chain
   * depth/targets, response shape). Unset means no recording: the daemon stays silent
   * when run standalone. See `server/observationRecorder.ts` for bounds and shape.
   */
  observationsFile?: string;
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
