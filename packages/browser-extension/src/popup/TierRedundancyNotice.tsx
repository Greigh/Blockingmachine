/**
 * The sentence that says how much of the shipped tiers the live dynamic rules already block.
 *
 * The same finding the hub's tier-plan card and `tier plan --synced` print, computed against the
 * artifact this surface can actually see — the installed dynamic rules — rather than the list's
 * source text. Presentational and separate from `PopupApp` for the same reason `LedgerExportCard`
 * is: the popup cannot be rendered in a test, and the distinctions below are the difference
 * between the answer and a guess.
 *
 * The states are kept distinct because they are different facts: the browser refusing to list its
 * rules is "unknown", not "nothing redundant"; an installed set that names no whole domain means
 * every tier stands alone; and a fully redundant tier gets the caveat in the same breath, because
 * the finding on its own reads as "turn these off" when it only means "the dynamic rules carry
 * this too". `state` is carried as a data attribute rather than left to the wording, for the same
 * reason `TierPlanBasis` carries `data-basis` — a test should assert which state rendered without
 * matching on prose.
 */

import React from 'react';
import type { TierRedundancyReport } from '../background/tierRedundancy.js';

export interface TierRedundancyNoticeProps {
  report: TierRedundancyReport;
  /** The tiers the card is already listing, for turning ids into the labels the user sees. */
  tiers: readonly { id: string; label: string }[];
}

type RedundancyState = 'unknown' | 'empty' | 'none' | 'finding';

export function TierRedundancyNotice({
  report,
  tiers,
}: TierRedundancyNoticeProps): React.ReactElement {
  const { synced, redundantTiers, userOwned } = report;
  const labelOf = (id: string) => tiers.find((tier) => tier.id === id)?.label ?? id;
  // Host-covered but not claim-covered: the synced rules block these hosts for their own
  // resource types, while the tier's `||host^` claims every type — navigations and websockets
  // still rely on it. That is not "redundant", but it is worth naming.
  const typeLimitedTiers = Object.entries(report.tiers)
    .filter(([, entry]) => (entry?.redundant?.typeLimited ?? 0) > 0)
    .map(([id]) => labelOf(id));
  // The user's own share is a suffix, not a fold-in: "covered by your rules" and "covered by the
  // list" are different facts, and a host in both sets would double-count if summed.
  const ownSuffix =
    userOwned && userOwned.hosts > 0
      ? `, plus ${userOwned.hosts.toLocaleString()} from your own rules`
      : '';

  let state: RedundancyState;
  let sentence: string;
  if (!synced) {
    state = 'unknown';
    sentence = 'The live dynamic rules could not be read, so no tier could be checked for redundancy.';
  } else if (synced.hosts === 0) {
    state = 'empty';
    const installed = synced.lines + (userOwned?.lines ?? 0);
    sentence =
      installed === 0
        ? 'No dynamic rules are installed — nothing to diff the tiers against.'
        : `${installed.toLocaleString()} dynamic rules installed, none from the synced list ` +
          'blocking a whole domain — no tier is redundant with it.';
  } else if (redundantTiers.length === 0) {
    state = 'none';
    sentence =
      "Every tier blocks something the synced list's rules do not — no tier is redundant with " +
      `it. Diffed against ${synced.hosts.toLocaleString()} blocked hosts` +
      (synced.exceptions > 0 ? ` (${synced.exceptions.toLocaleString()} excepted)` : '') +
      ownSuffix +
      '.' +
      (typeLimitedTiers.length > 0
        ? ` ${typeLimitedTiers.map((label) => label).join(', ')} ${
            typeLimitedTiers.length === 1 ? 'is' : 'are'
          } host-covered, but only for the request types the synced rules claim.`
        : '');
  } else {
    state = 'finding';
    sentence =
      `${redundantTiers.length === 1 ? 'One tier blocks' : `${redundantTiers.length} tiers block`} ` +
      `nothing the synced list's rules do not: ${redundantTiers.map(labelOf).join(', ')}. ` +
      `Diffed against ${synced.hosts.toLocaleString()} blocked hosts` +
      (synced.exceptions > 0 ? ` (${synced.exceptions.toLocaleString()} excepted)` : '') +
      ownSuffix +
      '.';
  }

  return (
    <div className={`tier-redundancy ${state}`} data-state={state}>
      {sentence}
      {state === 'finding' && (
        <span className="tier-redundancy-caveat">
          Redundant is not the same as useless — the dynamic rules carry these today, and the tier
          buys the coverage back if they stop.
        </span>
      )}
    </div>
  );
}
