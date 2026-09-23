import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampConfidencePercent, formatConfidencePercent, verdictBadgeLabel } from '../aiDisplay';

const here = dirname(fileURLToPath(import.meta.url));

describe('Confidence display', () => {
  it('renders confidence on a 0–100 scale and never above 100%', () => {
    expect(formatConfidencePercent(99)).toBe('99%');
    expect(formatConfidencePercent(99.6)).toBe('100%');
    expect(formatConfidencePercent(9900)).toBe('100%');
    expect(formatConfidencePercent(0)).toBe('0%');
    expect(formatConfidencePercent(undefined)).toBe('0%');
    expect(clampConfidencePercent(-20)).toBe(0);
    expect(clampConfidencePercent(42.2)).toBe(42);
  });

  it('labels radar badges from the engine verdict', () => {
    expect(verdictBadgeLabel('ad_server')).toBe('AD SERVER');
    expect(verdictBadgeLabel('tracker')).toBe('TRACKER');
    expect(verdictBadgeLabel('malicious')).toBe('MALWARE');
    expect(verdictBadgeLabel('suspicious')).toBe('SUSPICIOUS');
    expect(verdictBadgeLabel('clean')).toBe('CLEAN');
  });

  it('does not multiply inspector confidence by 100', () => {
    const inspector = readFileSync(join(here, '../views/RuleInspectorView.tsx'), 'utf8');
    const radar = readFileSync(join(here, '../views/AIRadarView.tsx'), 'utf8');
    expect(inspector).not.toMatch(/confidence[^;\n]*\*\s*100/);
    expect(radar).not.toMatch(/confidence[^;\n]*\*\s*100/);
    expect(inspector).toContain('formatConfidencePercent');
    expect(radar).toContain('verdictBadgeLabel');
  });
});
