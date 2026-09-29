/**
 * One row's triage outcome: the bucket, and the ambiguity score that produced it.
 *
 * Presentational only — every decision (which bucket, what the labels say, whether the score is
 * known at all) lives in `../triageDisplay`, which is pure and unit-tested. This component exists so
 * the two Radar result lists render the same chip instead of two hand-written copies that drift, and
 * so the markup is render-testable.
 *
 * A result with no cascade record renders *nothing*, not a neutral chip: the absence of a screening
 * record is not a screening outcome, and a greyed "SCREENED 0%" would be a fabricated one.
 */

import React from 'react';
import type { TriageOutcomeSummary } from '../types';
import {
  ambiguityTone,
  formatAmbiguity,
  triageBucketOf,
  triageChipLabel,
  triageChipTitle,
  triageExplanationLines,
} from '../triageDisplay';

export interface TriageOutcomeChipProps {
  /** The engine's cascade record for this result, when it has one. */
  triage?: TriageOutcomeSummary | null;
}

export const TriageOutcomeChip: React.FC<TriageOutcomeChipProps> = ({ triage }) => {
  const bucket = triageBucketOf(triage);
  if (bucket === 'untracked') return null;

  const ambiguity = formatAmbiguity(triage?.ambiguity);
  const tone = ambiguityTone(triage?.ambiguity);
  const failed = bucket === 'escalated' && triage?.escalationFailed === true;

  // The tooltip carries the engine's own per-signal sentences as well as the source line, so the
  // reasoning behind an escalation is one hover away without widening the row.
  const title = [triageChipTitle(triage), ...triageExplanationLines(triage)]
    .filter((line) => typeof line === 'string' && line.length > 0)
    .join('\n');

  return (
    <span
      className={`triage-chip ${bucket} tone-${tone}${failed ? ' failed' : ''}`}
      title={title}
      data-triage-bucket={bucket}
      data-triage-ambiguity={ambiguity ?? 'unknown'}
    >
      <span className="triage-chip-label">{triageChipLabel(triage)}</span>
      {ambiguity !== null && (
        <span className="triage-chip-ambiguity" aria-label={`ambiguity ${ambiguity}`}>
          {ambiguity}
        </span>
      )}
    </span>
  );
};

export default TriageOutcomeChip;
