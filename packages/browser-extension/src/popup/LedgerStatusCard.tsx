/**
 * The popup's block-ledger readout.
 *
 * Presentational on purpose, like the element-scan panel: it takes the ledger status and renders
 * markup, with no `chrome.*` and no state, so `react-dom/server` can render the real component in a
 * test. The popup owns the messaging; this owns what the user reads.
 *
 * The card answers one question the counts cannot: *where did these numbers come from?* The live
 * debug event and the polled `getMatchedRules` path disagree about what a match even carries — the
 * first has the request URL, the second only the rule — so the source is stated, not implied. The
 * quota rides along because a polled ledger with a spent budget looks identical to a page that
 * simply blocked nothing.
 */

import {
  describeLedger,
  formatLedgerQuota,
  ledgerFeedDetail,
  ledgerFeedLabel,
  ledgerFeedTone,
  type LedgerStatus,
} from '../shared/ledgerStatus.js';

export interface LedgerStatusCardProps {
  /** `null` until the first read comes back from the background worker. */
  status: LedgerStatus | null;
}

const SOURCE_LABELS: Record<LedgerStatus['feed'], string> = {
  live: 'Live events',
  polled: 'Polled',
  unavailable: 'None',
};

export function LedgerStatusCard({ status }: LedgerStatusCardProps) {
  return (
    <section className="settings-card">
      <div className="card-title">
        <span>Block ledger</span>
        <span
          className={`mini-status ${status ? ledgerFeedTone(status.feed) : 'off'}`}
          title={status ? describeLedger(status) : undefined}
        >
          {status ? ledgerFeedLabel(status.feed) : 'Loading…'}
        </span>
      </div>
      <p className="card-hint">
        Where the per-tab block counts come from. The browser offers two reporting paths and they are
        not equivalent, so this says which one is feeding the ledger.
      </p>

      {status && (
        <>
          <div className="kv-row">
            <span>Match source</span>
            <strong>{SOURCE_LABELS[status.feed]}</strong>
          </div>
          <div className="kv-row">
            <span>getMatchedRules quota</span>
            <strong>{formatLedgerQuota(status.quota)}</strong>
          </div>
          <p className="card-hint">{ledgerFeedDetail(status.feed)}</p>
        </>
      )}
    </section>
  );
}
