/**
 * The line that says what the recommended tier plan was weighted by.
 *
 * Presentational and separate from `PopupApp` for the same reason `LedgerExportCard` is: the
 * popup cannot be rendered in a test, and this is the sentence that decides whether a user
 * believes the recommendation above it. A plan that changed basis without saying so would read as
 * the same kind of plan as one that did not, and the user has no other way to tell.
 *
 * `basis` is carried as a data attribute rather than left to the wording, because the two states
 * deserve different weight visually and a test should be able to assert which one rendered
 * without matching on prose.
 */

import React from 'react';
import type { PlanBenefitView } from '../shared/tierAttribution.js';

export interface TierPlanBasisProps {
  basis: PlanBenefitView;
}

export function TierPlanBasis({ basis }: TierPlanBasisProps): React.ReactElement {
  return (
    <div className="tier-plan-basis" data-basis={basis.source}>
      {basis.reason}
    </div>
  );
}
