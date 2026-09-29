import type { RawDnsQuery } from './types.js';

/**
 * Behavioral analysis over raw DNS query streams.
 *
 * Lexical classification examines what a hostname *looks* like; behavioral
 * analysis examines what the hostname *does* on the network. The two signals
 * below are strong corroborating evidence for tracking infrastructure:
 *
 * - Coordinated fan-out: the same unblocked domain queried by several distinct
 *   devices is the signature of third-party tracking (or a shared service, so
 *   it is only surfaced as corroborating evidence, never as a standalone verdict).
 * - Beaconing cadence: queries at near-constant intervals with low jitter are
 *   the signature of automated telemetry check-ins rather than human browsing.
 *
 * @beta
 */

/** Minimum number of intervals required before cadence analysis is meaningful. */
const MIN_CADENCE_SAMPLES = 3;

/** Coefficient of variation (std/mean) below which a cadence counts as periodic. */
const PERIODIC_CV_THRESHOLD = 0.35;

/** Mean gap must fall inside this window to be machine-like telemetry cadence. */
const MIN_MEAN_GAP_MS = 5_000;
const MAX_MEAN_GAP_MS = 6 * 60 * 60 * 1000;

/** Minimum distinct devices before fan-out is worth reporting. */
const FANOUT_MIN_DEVICES = 3;

/** Strong fan-out: enough simultaneous devices that coordinated tracking is likely. */
const FANOUT_STRONG_DEVICES = 4;

export interface BehavioralDomainInsight {
  domain: string;
  queryCount: number;
  egressDevices: number;
  /** Periodic low-jitter query cadence detected (machine-like check-ins). */
  beaconingDetected: boolean;
  /** Median interval between queries, in seconds (when cadence was measured). */
  medianIntervalSeconds?: number;
  /** Relative jitter (std dev / mean) of the observed intervals (when measured). */
  intervalJitter?: number;
  /** Human-readable evidence lines suitable for scan results and the UI. */
  reasons: string[];
}

function parseTimestampMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  if (/^\d{10}$/.test(value)) return Number(value) * 1000; // epoch seconds
  if (/^\d{13}$/.test(value)) return Number(value); // epoch millis
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeJitter(gapsMs: number[]): { jitter: number; medianMs: number } | null {
  if (gapsMs.length < MIN_CADENCE_SAMPLES) return null;
  const mean = gapsMs.reduce((sum, g) => sum + g, 0) / gapsMs.length;
  if (mean < MIN_MEAN_GAP_MS || mean > MAX_MEAN_GAP_MS) return null;
  const variance = gapsMs.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gapsMs.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv > PERIODIC_CV_THRESHOLD) return null;
  return { jitter: Math.round(cv * 1000) / 1000, medianMs: median(gapsMs) };
}

function normalizeDomainKey(domain: string): string {
  return (typeof domain === 'string' ? domain : '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

/**
 * Aggregates raw DNS queries into per-domain behavioral insights.
 * Domains with no notable behavior (single device, no cadence) are omitted.
 */
export function analyzeQueryBehavior(queries: RawDnsQuery[]): BehavioralDomainInsight[] {
  if (!Array.isArray(queries) || queries.length === 0) return [];

  interface Aggregation {
    queryCount: number;
    clients: Set<string>;
    timestamps: number[];
  }

  const groups = new Map<string, Aggregation>();
  for (const query of queries) {
    if (!query || typeof query !== 'object') continue;
    const key = normalizeDomainKey(query.domain);
    if (!key || !key.includes('.')) continue;
    let agg = groups.get(key);
    if (!agg) {
      agg = { queryCount: 0, clients: new Set<string>(), timestamps: [] };
      groups.set(key, agg);
    }
    agg.queryCount++;
    agg.clients.add(typeof query.client === 'string' && query.client.trim() ? query.client.trim() : 'unknown');
    const ts = parseTimestampMs(query.timestamp);
    if (ts !== null) agg.timestamps.push(ts);
  }

  const insights: BehavioralDomainInsight[] = [];
  for (const [domain, agg] of groups) {
    const reasons: string[] = [];

    // Cadence analysis (only meaningful with unique, sorted timestamps)
    const uniqueTimes = Array.from(new Set(agg.timestamps)).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < uniqueTimes.length; i++) {
      const gap = uniqueTimes[i] - uniqueTimes[i - 1];
      if (gap > 0) gaps.push(gap);
    }
    const cadence = computeJitter(gaps);
    if (cadence) {
      const medianSeconds = Math.round((cadence.medianMs / 1000) * 10) / 10;
      const jitterPercent = Math.round(cadence.jitter * 100);
      reasons.push(
        `Beaconing cadence: queries repeat every ~${medianSeconds}s with only ${jitterPercent}% jitter — machine-like telemetry check-ins`,
      );
    }

    // Coordinated fan-out analysis
    const deviceCount = agg.clients.has('unknown') ? agg.clients.size - 1 : agg.clients.size;
    if (deviceCount >= FANOUT_STRONG_DEVICES) {
      reasons.push(
        `Coordinated fan-out: the same domain was queried by ${deviceCount} distinct devices on this network — third-party tracking signature`,
      );
    } else if (deviceCount === FANOUT_MIN_DEVICES) {
      reasons.push(
        `Queried by ${deviceCount} distinct devices on this network`,
      );
    }

    if (reasons.length === 0) continue;

    insights.push({
      domain,
      queryCount: agg.queryCount,
      egressDevices: deviceCount,
      beaconingDetected: cadence !== null,
      medianIntervalSeconds: cadence ? Math.round((cadence.medianMs / 1000) * 10) / 10 : undefined,
      intervalJitter: cadence?.jitter,
      reasons,
    });
  }

  return insights;
}

/** Risk-level ordering used when behavioral evidence escalates a verdict. */
const RISK_ORDER: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Escalates a risk level when behavioral evidence corroborates a non-clean verdict.
 * Clean verdicts are never escalated (periodic legitimate services such as NTP
 * time sync would otherwise be penalized for exactly the same cadence pattern).
 */
export function escalateRiskWithBehavior(
  currentRisk: string,
  insight: BehavioralDomainInsight | undefined,
): string {
  if (!insight) return currentRisk;
  const hasSignal = insight.beaconingDetected || insight.egressDevices >= FANOUT_STRONG_DEVICES;
  if (!hasSignal) return currentRisk;
  return (RISK_ORDER[currentRisk] ?? 0) < RISK_ORDER.high ? 'high' : currentRisk;
}
