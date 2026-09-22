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
