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
 */

export interface LedgerExportCardProps {
  /** One line naming what the export covers, or null before the first read. */
  summary: string | null;
  /** Suggested download name, when the background has answered. */
  filename: string | null;
  onExport: () => void;
  busy?: boolean;
}

export function LedgerExportCard({
  summary,
  filename,
  onExport,
  busy = false,
}: LedgerExportCardProps) {
  const ready = typeof summary === 'string' && summary.length > 0;

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
