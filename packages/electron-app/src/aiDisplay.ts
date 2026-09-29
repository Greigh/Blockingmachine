/**
 * Scan confidence is already a 0–100 percentage. Clamp it for display
 * so a value is never shown above 100%.
 */
export function clampConfidencePercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function formatConfidencePercent(value: number | null | undefined): string {
  return `${clampConfidencePercent(value)}%`;
}

export function verdictBadgeLabel(verdict: string): string {
  switch (verdict) {
    case 'ad_server':
      return 'AD SERVER';
    case 'tracker':
      return 'TRACKER';
    case 'malicious':
      return 'MALWARE';
    case 'suspicious':
      return 'SUSPICIOUS';
    case 'clean':
      return 'CLEAN';
    default:
      return verdict.replace(/_/g, ' ').toUpperCase();
  }
}

/**
 * Formats a timestamp (ISO 8601 string or epoch milliseconds) as a compact
 * relative time for heat-map style UI: "just now", "5m ago", "3h ago",
 * "2d ago", falling back to the locale date for anything older than a month.
 * Invalid or missing input yields "—".
 */
export function formatRelativeTime(
  timestamp: string | number | null | undefined,
  now: number = Date.now(),
): string {
  if (timestamp == null || timestamp === '') return '—';
  const then = typeof timestamp === 'number'
    ? timestamp
    : Date.parse(timestamp);
  if (!Number.isFinite(then) || then <= 0) return '—';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return '—';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

export type HeatBadgeLevel = 'heat-low' | 'heat-warm' | 'heat-hot' | 'heat-critical';

/**
 * Maps a repeat-offender flag count to a badge intensity level:
 * 1 flag → low (fresh), 2 → warm, 3–5 → hot, 6+ → critical (persistent offender).
 */
export function heatBadgeClass(flags: number | null | undefined): HeatBadgeLevel {
  const value = typeof flags === 'number' && Number.isFinite(flags) ? Math.max(0, Math.floor(flags)) : 0;
  if (value >= 6) return 'heat-critical';
  if (value >= 3) return 'heat-hot';
  if (value === 2) return 'heat-warm';
  return 'heat-low';
}
