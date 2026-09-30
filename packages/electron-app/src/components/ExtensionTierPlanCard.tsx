import React from 'react';

/**
 * The extension's static tier capacity plan, as the hub shows it.
 *
 * Presentational, and separate from the view that fetches it, for the same reason the extension's
 * own cards are: a plan decides what a packaged build ships, and the sentence that says what the
 * plan was *worth* — measured blocks or rule count — is the difference between a recommendation a
 * user can check and one they have to take on faith. Rendering it here means that sentence is
 * asserted in a test rather than only visible to someone with the app open.
 *
 * The data comes from `get-extension-tier-plan`, which runs the same `computeTierPlan` the CLI
 * runs, so this card and `blockingmachine tier-plan` cannot disagree about the same files.
 */

export interface TierPlanRow {
  id: string;
  label: string;
  rules: number;
  hits: number | null;
  errors: string[];
}

export interface TierPlanResult {
  ok: true;
  rulesDir: string;
  capacitySlots: number;
  rows: TierPlanRow[];
  broken: TierPlanRow[];
  plan: {
    enabled: string[];
    enabledRules: number;
    totalRules: number;
    staticHeadroom: number;
    bindingConstraint: string;
    benefit: number;
    benefitSource: 'evidence' | 'coverage';
    explanation: string[];
  };
  basis: { source: 'evidence' | 'coverage'; reason: string; unmeasured: string[] } | null;
  ledger: { lines: number; skipped: number; shared: number } | null;
  /** The ledger this plan was weighted by, if one was chosen. */
  ledgerPath?: string | null;
  /** Set when a chosen ledger could not be read, so the plan fell back rather than errored. */
  ledgerMissing?: string | null;
}

export interface TierPlanFailure {
  ok: false;
  error: string;
}

export type TierPlanResponse = TierPlanResult | TierPlanFailure;

export interface ExtensionTierPlanCardProps {
  state: 'loading' | 'ready' | 'error';
  result?: TierPlanResult | null;
  error?: string | null;
  /** Tiers the user has switched on, used to mark the current selection in the list. */
  enabled?: readonly string[];
  onRefresh?: () => void;
  /** Chooses the browser's rule-hit ledger, so the plan can be weighted by measurement. */
  onChooseLedger?: () => void;
  /** Forgets the chosen ledger and re-plans by rule count. */
  onClearLedger?: () => void;
}

const STATE_BY_TIER: Record<string, string> = {
  'tier_core': 'Always on',
  'tier_ads': 'Opt-in',
  'tier_privacy': 'Opt-in',
  'tier_annoyances': 'Opt-in',
};

export const ExtensionTierPlanCard: React.FC<ExtensionTierPlanCardProps> = ({
  state,
  result,
  error,
  enabled = [],
  onRefresh,
  onChooseLedger,
  onClearLedger,
}) => {
  if (state === 'loading') {
    return (
      <div className="desktop-card tier-plan-card">
        <div className="tier-plan-card-head">
          <h3 className="tier-plan-card-title">Extension tier capacity</h3>
        </div>
        <p className="tier-plan-card-empty">Reading the tier rulesets…</p>
      </div>
    );
  }

  if (state === 'error' || !result) {
    return (
      <div className="desktop-card tier-plan-card">
        <div className="tier-plan-card-head">
          <h3 className="tier-plan-card-title">Extension tier capacity</h3>
          {onRefresh && (
            <button type="button" className="tier-plan-refresh" onClick={onRefresh}>
              Retry
            </button>
          )}
        </div>
        <p className="tier-plan-card-error">{error ?? 'The tier plan is unavailable.'}</p>
      </div>
    );
  }

  const { plan, basis, ledger, capacitySlots, rows, broken } = result;
  const active = new Set(enabled.length > 0 ? enabled : plan.enabled);
  const free = Math.max(0, capacitySlots - plan.enabledRules);

  return (
    <div className="desktop-card tier-plan-card">
      <div className="tier-plan-card-head">
        <h3 className="tier-plan-card-title">Extension tier capacity</h3>
        {onRefresh && (
          <button type="button" className="tier-plan-refresh" onClick={onRefresh}>
            Refresh
          </button>
        )}
      </div>

      {/* A broken file is checked before the headline, not after. Printing "468 of 30,000 rules
          fit 12,033 slots" directly above "there is nothing to plan" would put the reassuring
          number first and the reason not to believe it second. */}
      {broken.length > 0 ? (
        <p className="tier-plan-card-error">
          {broken.length} tier file{broken.length === 1 ? '' : 's'} failed validation, so there is
          nothing to plan: {broken.map((row) => row.label).join(', ')}.
        </p>
      ) : (
        <>
          <p className="tier-plan-card-sub">
            {plan.enabledRules.toLocaleString()} of {plan.totalRules.toLocaleString()} shipped rules fit{' '}
            {capacitySlots.toLocaleString()} static slots
            {free > 0 ? ` · ${free.toLocaleString()} free` : ''}
          </p>

          <table className="tier-plan-table">
            <thead>
              <tr>
                <th scope="col">Tier</th>
                <th scope="col">Rules</th>
                <th scope="col">Blocked</th>
                <th scope="col">In plan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const shipped = plan.enabled.includes(row.id);
                return (
                  <tr key={row.id} className={shipped ? 'tier-plan-row kept' : 'tier-plan-row'}>
                    <th scope="row">
                      {row.label}
                      <span className="tier-plan-tier-id">{STATE_BY_TIER[row.id] ?? row.id}</span>
                    </th>
                    <td>{row.rules.toLocaleString()}</td>
                    <td>{row.hits === null ? '—' : row.hits.toLocaleString()}</td>
                    {/* Three states, because they are three different facts: kept by the plan,
                        dropped from a tier that is currently on, and left out of a plan that never
                        had it on. Collapsing the last two is how a user's own choice ends up
                        looking like a recommendation against it. */}
                    <td>{shipped ? 'Kept' : active.has(row.id) ? 'Dropped' : 'Not included'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* The basis is stated whether or not it is the interesting one. A plan that quietly
              ranked by rule count is otherwise indistinguishable from a plan that weighed the
              ledger and found the evidence sufficient. */}
          <p className={`tier-plan-basis basis-${basis?.source ?? 'none'}`}>
            {basis?.reason ??
              'No ledger was supplied, so this plan is ranked by rule count. Export one from the extension popup to weight it by what actually blocked.'}
          </p>

          {result.ledgerMissing && (
            <p className="tier-plan-ledger tier-plan-ledger-missing">
              The ledger you chose could not be read ({result.ledgerMissing}), so this plan fell back
              to rule count. Re-export it from the extension popup, or choose it again.
            </p>
          )}

          {ledger && (
            <p className="tier-plan-ledger">
              {ledger.lines.toLocaleString()} measured lines
              {ledger.skipped > 0 ? `, ${ledger.skipped.toLocaleString()} naming no blockable host` : ''}
              {ledger.shared > 0
                ? `, ${ledger.shared.toLocaleString()} matching a host two tiers both ship`
                : ''}
              {result.ledgerPath ? ` · ${result.ledgerPath}` : ''}
            </p>
          )}

          {/* Without this the hub is structurally incapable of ever weighting by measurement: it
              has no ledger of its own, because the extension accumulates the measurement and the
              user exports it. */}
          <div className="tier-plan-ledger-actions">
            {result.ledgerPath && !result.ledgerMissing ? (
              <>
                <span className="tier-plan-ledger-path">{result.ledgerPath}</span>
                {onClearLedger && (
                  <button type="button" className="tier-plan-link" onClick={onClearLedger}>
                    Forget
                  </button>
                )}
              </>
            ) : (
              onChooseLedger && (
                <button type="button" className="tier-plan-link" onClick={onChooseLedger}>
                  {result.ledgerMissing ? 'Choose the ledger again' : 'Weight by a rule-hit ledger…'}
                </button>
              )
            )}
          </div>

          <ul className="tier-plan-why">
            {plan.explanation.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};
