export interface DaemonConfig {
  bindHost: string;
  dnsPort: number;
  controlPort: number;
  /**
   * Bind host for the CONTROL API only — defaults to 127.0.0.1 and stays
   * there unless deliberately overridden. The DNS listener may legitimately
   * bind a LAN address (a router-facing resolver), but the control surface
   * carries the query log (a browsing history) and the protection toggle —
   * its no-Origin trust model is a loopback boundary, not LAN auth, so it
   * must never ride a non-loopback bind by accident.
   */
  controlBindHost?: string;
  /**
   * Set by embedders (the Home Assistant add-on runs the daemon in-process):
   * skips the SIGINT/SIGTERM handlers and keeps a control-API failure from
   * exiting the host process — the embedder owns lifecycle and surfaces the
   * failure in its own status instead.
   */
  embedded?: boolean;
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
