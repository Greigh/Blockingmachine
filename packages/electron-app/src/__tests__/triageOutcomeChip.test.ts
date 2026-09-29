/**
 * The triage chip, rendered.
 *
 * The suite has neither jsdom nor @testing-library, so this renders through `react-dom/server` — the
 * same approach the Unbound card and the element scan panel use. A static render has no event loop,
 * so what is asserted is the branch taken and the text produced, not a click.
 *
 * The case worth its own test is the empty one: a result with no cascade record must render nothing
 * at all, because a chip reading `SCREENED 0%` for a scan the cascade never saw is a fabricated
 * measurement.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TriageOutcomeSummary } from '../types';
import { TriageOutcomeChip } from '../components/TriageOutcomeChip';

function render(triage?: TriageOutcomeSummary | null): string {
  return renderToStaticMarkup(React.createElement(TriageOutcomeChip, { triage }));
}

function outcome(overrides: Partial<TriageOutcomeSummary> = {}): TriageOutcomeSummary {
  return {
    action: 'resolve-locally',
    ambiguity: 0.12,
    signals: [],
    explanations: [],
    source: 'local',
    contradicted: false,
    escalationFailed: false,
    ...overrides,
  };
}

describe('TriageOutcomeChip', () => {
  test('renders nothing when the result carries no cascade record', () => {
    expect(render(undefined)).toBe('');
    expect(render(null)).toBe('');
  });

  test('shows the bucket and the ambiguity score beside it', () => {
    const markup = render(outcome({ action: 'resolve-locally', ambiguity: 0.12 }));
    expect(markup).toContain('SCREENED');
    expect(markup).toContain('triage-chip-ambiguity');
    expect(markup).toContain('12%');
    expect(markup).toContain('data-triage-bucket="screened-locally"');
    expect(markup).toContain('data-triage-ambiguity="12%"');
  });

  test('renders each of the four buckets with its own class', () => {
    expect(render(outcome({ action: 'escalate', source: 'escalated' }))).toContain(
      'data-triage-bucket="escalated"',
    );
    expect(render(outcome({ action: 'deferred' }))).toContain('data-triage-bucket="deferred"');
    expect(render(outcome({ action: 'deferred' }))).toContain('DEFERRED');
    expect(render(outcome({ action: 'escalate', source: 'contested' }))).toContain(
      'data-triage-bucket="contested"',
    );
    expect(render(outcome({ action: 'escalate', source: 'contested' }))).toContain('CONTESTED');
  });

  test('marks a failed escalation so the label cannot pass for a confirmation', () => {
    const markup = render(outcome({ action: 'escalate', source: 'local', escalationFailed: true }));
    expect(markup).toContain('ESCALATED (FAILED)');
    expect(markup).toContain('triage-chip escalated');
    expect(markup).toContain('failed');
  });

  test('tones the score by the bar the engine escalates on', () => {
    expect(render(outcome({ ambiguity: 0.8 }))).toContain('tone-high');
    expect(render(outcome({ ambiguity: 0.3 }))).toContain('tone-medium');
    expect(render(outcome({ ambiguity: 0.01 }))).toContain('tone-low');
  });

  test('omits the score rather than defaulting it when the engine did not record one', () => {
    const markup = render(outcome({ action: 'deferred', ambiguity: undefined as unknown as number }));
    expect(markup).toContain('DEFERRED');
    expect(markup).not.toContain('triage-chip-ambiguity');
    expect(markup).toContain('data-triage-ambiguity="unknown"');
    expect(markup).toContain('tone-unknown');
  });

  test('carries the source sentence and the engine’s signal lines in the tooltip', () => {
    const markup = render(
      outcome({
        action: 'escalate',
        source: 'escalated',
        model: 'llama3.2',
        explanations: ['Top two classes are within 4.0 points'],
      }),
    );
    expect(markup).toContain('llama3.2');
    expect(markup).toContain('Top two classes are within 4.0 points');
    // The explanations are on their own lines after the source sentence, so a tooltip reads as a
    // list rather than as one run-on sentence.
    expect(markup).toContain('\nTop two classes are within 4.0 points');
  });

  test('does not put an empty tooltip on the chip', () => {
    const markup = render(outcome({ action: 'resolve-locally' }));
    expect(markup).toContain('title="Screened locally');
  });
});

/**
 * The wiring, asserted against the view's source.
 *
 * The Radar is one 3,000-line stateful component, so the chip is rendered through
 * `react-dom/server` above and its three call sites are pinned here instead — the same trick the
 * Deploy Hub's registry test uses. What it guards is the thing that would otherwise go wrong
 * silently: a fourth result list added later, or a `<TriageOutcomeChip />` rendered with no triage
 * on it, which renders nothing and looks like a styling choice rather than a missing wiring.
 */
describe('TriageOutcomeChip wiring in the AI Radar', () => {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const radarSource = readFileSync(join(appRoot, 'src/views/AIRadarView.tsx'), 'utf8');

  test('is imported from the shared component rather than re-implemented per list', () => {
    expect(radarSource).toContain("import { TriageOutcomeChip } from '../components/TriageOutcomeChip'");
    expect(radarSource).toContain("import { formatTriageBucketSummary } from '../triageDisplay'");
  });

  test('every verdict list that can carry a cascade record renders the chip', () => {
    // Three lists show `AiScanResult` rows: the full-page stream, the compact scout card, and the
    // canary crawler's flagged hosts. All three go through the same service, so all three carry
    // triage — a chip on two of them would make the cascade appear to be off in the third.
    const chipSites = radarSource.match(/<TriageOutcomeChip /g) || [];
    expect(chipSites.length).toBeGreaterThanOrEqual(3);
    expect(radarSource.match(/<TriageOutcomeChip triage={item\.triage}/g) || []).toHaveLength(2);
    expect(radarSource).toContain('<TriageOutcomeChip triage={host.triage} />');
  });

  test('the list summary is rendered only when the cascade produced a record', () => {
    expect(radarSource).toContain(
      'const triageBucketSummary = formatTriageBucketSummary(allResults);',
    );
    // Guarded, so a list scanned with the cascade off shows no summary line at all instead of a
    // table of zeros that reads as a cascade which decided nothing.
    expect(radarSource).toContain('{triageBucketSummary && (');
  });
});
