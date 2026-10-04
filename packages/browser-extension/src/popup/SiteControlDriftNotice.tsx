/**
 * The line that says the browser is not enforcing the site choices the toggles describe.
 *
 * The shield status reads decisions out of storage, which is what the user asked for — and a
 * pause the browser has no rule for renders exactly like a pause that is pausing. This notice
 * is the only place the popup can say otherwise, and the two directions are different problems:
 * a pause or allowance with no rule behind it is enforcement the user thinks they have and do
 * not, while a rule with no decision behind it is a pause or an allowance they did not make.
 *
 * It renders nothing when the two agree, and nothing at all before the first view arrives —
 * no reading is not agreement. The repair is a button rather than a side effect of opening the
 * popup: reconciling on read would erase the disagreement before anyone could see it, and a
 * browser that refused the last repair keeps that state, visibly, until a person asks again.
 *
 * The visual treatment is the tier drift notice's: the same disagreement, one table further
 * along — dynamic rules instead of enabled rulesets — so it is styled by the same classes.
 */

import type { SiteControlDrift } from '../shared/types.js';

export interface SiteControlDriftNoticeProps {
  /** Absent means the view has not arrived yet — no reading, so nothing to say either way. */
  drift?: SiteControlDrift | null;
  /**
   * Why the last apply call refused, when the view carries one. The drift names the
   * disagreement; this names its cause, so the notice can say "the browser refused" instead
   * of leaving the gap to read as an unexplained one.
   */
  applyError?: string;
  /** True while blocking is paused everywhere, which changes what the browser should be holding. */
  globalPaused: boolean;
  onReapply: () => void;
  busy?: boolean;
}

export function SiteControlDriftNotice({
  drift,
  applyError,
  globalPaused,
  onReapply,
  busy = false,
}: SiteControlDriftNoticeProps) {
  if (!drift || (drift.known && drift.inSync)) return null;

  if (!drift.known) {
    return (
      <div className="tier-drift unknown" data-drift="unknown">
        <span className="tier-drift-title">Could not read the browser&apos;s rules</span>
        <span className="tier-drift-detail">
          This panel shows your saved choices — whether they are actually enforced could not be
          read. It is checked again the next time the extension reconciles.
        </span>
        {applyError && (
          <span className="tier-drift-detail">The last attempt to apply them failed — {applyError}.</span>
        )}
        <button type="button" className="tier-drift-action" disabled={busy} onClick={onReapply}>
          {busy ? 'Checking…' : 'Try again'}
        </button>
      </div>
    );
  }

  const list = (names: readonly string[]): string => names.join(', ');
  const details: string[] = [];

  if (drift.missingPauses.length > 0) {
    const names = list(drift.missingPauses);
    details.push(
      `Blocking is paused on ${names} in your settings, but the browser has no pause rule for ${
        drift.missingPauses.length === 1 ? 'it — that site is' : 'them — those sites are'
      } still being filtered.`,
    );
  }
  if (drift.missingAllowances.length > 0) {
    const names = list(drift.missingAllowances);
    details.push(
      `You allowed ${names}, but the browser has no allow rule for ${
        drift.missingAllowances.length === 1 ? 'it — that domain is' : 'them — those domains are'
      } still being blocked.`,
    );
  }
  if (drift.missingRules.length > 0) {
    details.push(
      `Your saved ${
        drift.missingRules.length === 1 ? 'rule' : 'rules'
      } ${list(drift.missingRules)} ${
        drift.missingRules.length === 1 ? 'has' : 'have'
      } no rule in the browser — not in effect right now.`,
    );
  }
  if (drift.unexpectedPauses.length > 0) {
    details.push(
      `The browser is still letting ${list(drift.unexpectedPauses)} through — ${
        drift.unexpectedPauses.length === 1 ? 'a pause' : 'pauses'
      } you no longer have saved.`,
    );
  }
  if (drift.unexpectedAllowances.length > 0) {
    details.push(
      `The browser is still allowing ${list(drift.unexpectedAllowances)} — ${
        drift.unexpectedAllowances.length === 1 ? 'an allowance' : 'allowances'
      } you no longer have saved.`,
    );
  }
  if (drift.unexpectedRules.length > 0) {
    details.push(
      `The browser is enforcing ${
        drift.unexpectedRules.length === 1 ? 'a rule' : 'rules'
      } no saved choice produced: ${list(drift.unexpectedRules)}.`,
    );
  }
  if (drift.unexpectedBlocking > 0) {
    details.push(
      `Blocking is paused everywhere, but the browser still holds ${drift.unexpectedBlocking.toLocaleString()} ` +
        'blocklist rules — the pause did not clear them.',
    );
  }
  if (applyError) {
    details.push(`The last attempt to apply your choices failed — ${applyError}.`);
  }

  return (
    <div className="tier-drift" data-drift="drifted">
      <span className="tier-drift-title">The browser and your saved choices disagree</span>
      {details.map((detail) => (
        <span key={detail} className="tier-drift-detail">
          {detail}
        </span>
      ))}
      <button type="button" className="tier-drift-action" disabled={busy} onClick={onReapply}>
        {busy ? 'Re-applying…' : globalPaused ? 'Re-apply the pause' : 'Re-apply my choices'}
      </button>
    </div>
  );
}
