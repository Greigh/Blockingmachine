/**
 * The popup's hit-ledger export action.
 *
 * Presentational on purpose, like the ledger status card: it takes the summary and renders markup,
 * with no `chrome.*` and no state, so `react-dom/server` can render the real component in a test.
 * The download itself is the popup's job (`downloadTextFile`), and the file's contents are the
 * background's — this card only asks.
 *
 * It is separate from the ledger *status* card because the two answer different questions. That one
 * says where the numbers come from; this one says what would leave the machine if you clicked.
 *
 * The per-tier split is shown here rather than only in the file, because it is the one number that
 * decides a plan: the tier rulesets are weighted by how much each has actually blocked, and a
 * reader who has to open the JSON to see that has learned nothing they can act on. It renders the
 * background's own merge of the sessions, so the card and the file cannot disagree.
 */

import type { LedgerTierCount } from '../shared/ledgerExport.js';

export interface LedgerExportCardProps {
  /** One line naming what the export covers, or null before the first read. */
  summary: string | null;
  /** Suggested download name, when the background has answered. */
  filename: string | null;
  /** Per-tier blocks across the sessions the export would contain, highest first. */
  tiers?: readonly LedgerTierCount[];
  /** Blocks in those sessions that named no shipped tier. */
  tierUnattributed?: number;
  /** Sessions of `sessions` that carried a split, so a mixed-age file says so on screen. */
  tieredSessions?: number;
  /** Sessions the export would contain, counting today's open one. */
  sessions?: number;
  /** Rules the per-session cap evicted across those sessions — a file that lost evidence says so. */
  rulesDropped?: number;
  onExport: () => void;
  busy?: boolean;
}

export function LedgerExportCard({
  summary,
  filename,
  tiers = [],
  tierUnattributed = 0,
  tieredSessions,
  sessions,
  rulesDropped = 0,
  onExport,
  busy = false,
}: LedgerExportCardProps) {
  const ready = typeof summary === 'string' && summary.length > 0;
  // Coverage is shown beside the counts rather than inferred. A table built from one session of ten
  // is a real measurement of that session, and nothing on screen would say otherwise without this.
  const partial =
    typeof tieredSessions === 'number' && typeof sessions === 'number' && tieredSessions < sessions;

  return (
    <section className="settings-card">
      <div className="card-title">
        <span>Hit ledger export</span>
        <span className={`mini-status ${ready ? 'ok' : 'off'}`}>
          {ready ? 'Ready' : 'Loading…'}
        </span>
      </div>
      <p className="card-hint">
        What this browser actually blocked, dated into sessions. Merge the exported files to build
        the hot set from real usage instead of a single captured trace.
      </p>

      <div className="kv-row">
        <span>Recorded</span>
        <strong>{ready ? summary : 'Nothing yet'}</strong>
      </div>
      {filename && (
        <div className="kv-row">
          <span>Export file</span>
          <strong>{filename}</strong>
        </div>
      )}
      {rulesDropped > 0 && (
        <div className="kv-row">
          <span>Dropped at cap</span>
          <strong title="Sessions keep the 5,000 hottest rules each; the evicted tail is counted so the file does not read as though it saw less traffic than it did">
            {rulesDropped.toLocaleString()} rules
          </strong>
        </div>
      )}

      {tiers.length > 0 && (
        <>
          <div className="kv-row">
            <span>By tier</span>
            <strong>
              {partial
                ? `${tieredSessions} of ${sessions} sessions measured`
                : 'every session measured'}
            </strong>
          </div>
          {tiers.map((tier) => (
            <div className="kv-row" key={tier.tier}>
              <span style={{ paddingLeft: '0.75rem' }}>{tier.tier}</span>
              <strong>{tier.count.toLocaleString()}</strong>
            </div>
          ))}
          {tierUnattributed > 0 && (
            <div className="kv-row">
              <span style={{ paddingLeft: '0.75rem' }}>no tier</span>
              <strong>{tierUnattributed.toLocaleString()}</strong>
            </div>
          )}
          <p className="card-hint">
            The tiers that shipped the blocking rule, which is how each ruleset gets weighted. Blocks
            in no tier came from the synced list, which is not a tier ruleset.
            {partial
              ? ' Sessions before this split existed are counted above but carry no tier tally, so the table does not describe the whole file.'
              : ''}
          </p>
        </>
      )}

      <button
        type="button"
        className="action-btn"
        onClick={onExport}
        disabled={busy || !ready}
        title={
          ready
            ? 'Download the dated session ledger as JSON'
            : 'The ledger is read from the background worker first.'
        }
      >
        {busy ? 'Exporting…' : 'Export ledger'}
      </button>
    </section>
  );
}
