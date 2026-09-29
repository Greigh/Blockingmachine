import { describe, it, expect } from '@jest/globals';
import { formatRelativeTime, heatBadgeClass, verdictBadgeLabel } from '../aiDisplay';

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z');

  it('renders compact relative times', () => {
    expect(formatRelativeTime('2026-09-28T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-09-28T11:45:00.000Z', now)).toBe('15m ago');
    expect(formatRelativeTime('2026-09-28T09:30:00.000Z', now)).toBe('2h ago');
    expect(formatRelativeTime('2026-09-26T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('falls back to the locale date beyond a month', () => {
    const old = '2026-01-01T00:00:00.000Z';
    expect(formatRelativeTime(old, now)).toBe(new Date(Date.parse(old)).toLocaleDateString());
  });

  it('handles missing, invalid, and future timestamps', () => {
    expect(formatRelativeTime(null, now)).toBe('—');
    expect(formatRelativeTime(undefined, now)).toBe('—');
    expect(formatRelativeTime('not-a-date', now)).toBe('—');
    expect(formatRelativeTime('2026-09-28T13:00:00.000Z', now)).toBe('—');
  });
});

describe('heatBadgeClass', () => {
  it('maps flag counts to escalating intensity levels', () => {
    expect(heatBadgeClass(1)).toBe('heat-low');
    expect(heatBadgeClass(2)).toBe('heat-warm');
    expect(heatBadgeClass(3)).toBe('heat-hot');
    expect(heatBadgeClass(5)).toBe('heat-hot');
    expect(heatBadgeClass(6)).toBe('heat-critical');
    expect(heatBadgeClass(50)).toBe('heat-critical');
  });

  it('degrades gracefully on invalid input', () => {
    expect(heatBadgeClass(0)).toBe('heat-low');
    expect(heatBadgeClass(null)).toBe('heat-low');
    expect(heatBadgeClass(undefined)).toBe('heat-low');
    expect(heatBadgeClass(Number.NaN)).toBe('heat-low');
    expect(heatBadgeClass(2.9)).toBe('heat-warm');
  });
});

describe('verdictBadgeLabel', () => {
  it('labels known verdicts', () => {
    expect(verdictBadgeLabel('ad_server')).toBe('AD SERVER');
    expect(verdictBadgeLabel('tracker')).toBe('TRACKER');
    expect(verdictBadgeLabel('malicious')).toBe('MALWARE');
  });

  it('uppercases unknown verdicts with spaces', () => {
    expect(verdictBadgeLabel('some_new_kind')).toBe('SOME NEW KIND');
  });
});
