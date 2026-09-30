/**
 * The line that says the browser is not doing what the tier toggles say.
 *
 * The toggles render the saved selection, which is what the user asked for. This is the only place
 * the popup can say whether that selection is what the browser is actually enforcing, and it is the
 * difference between two failures that used to be invisible: tiers the browser has on that the user
 * turned off (blocking they did not ask for), and tiers the user turned on that the browser has off
 * (blocking they think they have and do not).
 *
 * It renders nothing when the two agree, because agreement is the normal state and a permanent
 * "everything is fine" banner is a banner nobody reads. The repair is a button rather than
 * something automatic: reconciling on read would erase the disagreement before anyone could see
 * it, and a browser that refused the last repair keeps that state, visibly, until a person asks
 * again.
 *
 * While blocking is paused everywhere, the state the browser *should* be in is silence, so the
 * wording changes to match what the pause promises rather than reporting the selection as missing.
 *
 * The catalogue arrives as a prop rather than being imported: this is presentational, the labels
 * are right there in the status the caller already holds, and taking them as data keeps the
 * component's runtime free of the bundle's shared tier module.
 */

import type { RulesetDrift, StaticTierId } from '../shared/rulesetTiers.js';

export interface TierDriftNoticeProps {
  drift: RulesetDrift;
  /** The catalogue, so the notice names tiers the way the switches below it do. */
  tiers: ReadonlyArray<{ id: StaticTierId; label: string }>;
  /** True while blocking is paused everywhere, which changes what the browser should be holding. */
  suspended: boolean;
  onReapply: () => void;
  busy?: boolean;
}

export function TierDriftNotice({
  drift,
  tiers,
  suspended,
  onReapply,
  busy = false,
}: TierDriftNoticeProps) {
  if (drift.known && drift.inSync) return null;

  const labelById = new Map(tiers.map((tier) => [tier.id, tier.label]));
  const labels = (ids: readonly StaticTierId[]): string =>
    ids.map((id) => labelById.get(id) ?? id).join(', ');

  if (!drift.known) {
    return (
      <div className="tier-drift unknown" data-drift="unknown">
        <span className="tier-drift-title">Could not read the browser&apos;s enabled tiers</span>
        <span className="tier-drift-detail">
          This list shows your saved selection, not what is actually blocking. It is read again the
          next time the extension reconciles.
        </span>
        <button type="button" className="tier-drift-action" disabled={busy} onClick={onReapply}>
          {busy ? 'Checking…' : 'Try again'}
        </button>
      </div>
    );
  }

  const details: string[] = [];
  if (drift.unexpected.length > 0) {
    const names = labels(drift.unexpected);
    details.push(
      suspended
        ? `Blocking is paused everywhere, but the browser still has ${names} on — the pause did not silence ${drift.unexpected.length === 1 ? 'it' : 'them'}.`
        : `The browser has ${names} on, which your saved selection does not include — ${drift.unexpected.length === 1 ? 'that tier is' : 'those tiers are'} blocking rules you turned off.`,
    );
  }
  if (drift.missing.length > 0) {
    const names = labels(drift.missing);
    details.push(
      `Your saved selection includes ${names}, which the browser has off — ${drift.missing.length === 1 ? 'that tier is' : 'those tiers are'} not blocking anything right now.`,
    );
  }

  return (
    <div className="tier-drift" data-drift="drifted">
      <span className="tier-drift-title">The browser and your saved selection disagree</span>
      {details.map((detail) => (
        <span key={detail} className="tier-drift-detail">
          {detail}
        </span>
      ))}
      <button type="button" className="tier-drift-action" disabled={busy} onClick={onReapply}>
        {busy ? 'Re-applying…' : suspended ? 'Re-apply the pause' : 'Re-apply my selection'}
      </button>
    </div>
  );
}
