/**
 * Display formatters shared by the tab screens.
 *
 * `formatTimestamp` exists because the hub stamps compile times with
 * `toLocaleString()` before storing — a format Hermes' Date parser rejects —
 * while the Home Assistant add-on reports epochs. Prefer the parseable forms
 * and fall back to the raw string, which is already human-readable in the
 * hub's own locale.
 */

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
}

export function formatTimestampMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || ms <= 0) return 'never';
  return new Date(ms).toLocaleString();
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
