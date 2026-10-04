import React from 'react';
import type { AppliedRuleSource } from '../shared/types.js';

/**
 * One quota-card row naming the list the last successful application installed. Rendered from the
 * record the background persists rather than recomputed here: inferring "hot" from a low rule
 * count would confuse a pruned full export, user-rule trims and site pauses with the measured set.
 *
 * `appliedLabel` arrives formatted ("2h ago") — relative-time formatting already lives in the
 * popup, and this row should not grow a second one.
 */
export const RuleSourceRow: React.FC<{ record: AppliedRuleSource; appliedLabel: string }> = ({
  record,
  appliedLabel,
}) => {
  const stale = record.hotSet?.absentFromFull ?? 0;
  const own = record.hotSet?.ownRules ?? 0;
  const title =
    record.source === 'hot'
      ? `the measured hot set (${record.offered.toLocaleString()} rules) — installing the full export would have pruned ${record.fullOverflow.toLocaleString()} rules` +
        (own > 0
          ? `; ${own.toLocaleString()} of them were measured on this browser's own hit ledger`
          : '')
      : record.tierTrimmed
        ? `the full export, cut to the budget by measured tier benefit — ${record.installed.toLocaleString()} kept, ${record.fullOverflow.toLocaleString()} unmeasured-tail rules dropped`
        : 'the full compiled export';
  return (
    <div className="kv-row">
      <span>Rule source</span>
      <span
        className={`mini-status ${record.source === 'hot' || stale > 0 ? 'warn' : 'ok'}`}
        title={
          stale > 0
            ? `${title} — ${stale.toLocaleString()} of the hot set's rules are absent from the full export it was served beside, so it was measured against an older list`
            : title
        }
      >
        {record.source === 'hot' ? 'measured hot set' : 'full export'}
        {' · '}
        {appliedLabel}
        {stale > 0 ? ` · ${stale.toLocaleString()} stale` : ''}
      </span>
    </div>
  );
};
