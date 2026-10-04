/**
 * The popup's element-scan panel.
 *
 * Presentational on purpose: it takes the scan result and three callbacks and renders
 * markup, with no `chrome.*` and no state. The popup owns the messaging, this owns what
 * the user reads — which is what makes the panel renderable in a test without a DOM,
 * a browser or a mocked extension API.
 */

import { elementAiScanSummary, elementAiTone } from '../shared/elementAiDisplay.js';

export interface ElementScanEvidenceRow {
  id: string;
  label: string;
  detail: string;
  strength: 'definitive' | 'supporting' | 'context';
}

export interface ElementScanGroup {
  selector: string;
  matches: number;
  elementClass: 'Ad' | 'Tracker' | 'Annoyance' | 'Content';
  count: number;
  confidence: number;
  label: string;
  reason: string;
  evidence?: ElementScanEvidenceRow[];
}

export interface ElementScanResult {
  scanned: number;
  hideCount: number;
  suggestCount: number;
  groups: ElementScanGroup[];
}

export interface ElementScanPanelProps {
  scan: ElementScanResult | null;
  busy: boolean;
  onScan: () => void;
  /** No selectors means "hide everything the scan found". */
  onHide: (selectors?: string[]) => void;
  onHighlight: () => void;
  /**
   * What the corpus harvest currently holds, as a line of prose plus the export callback.
   *
   * Passed in rather than imported: the panel must not reach for the core package at
   * runtime, and the numbers it shows (how many real elements, how many of them carry a
   * decision) are already words by the time they get here.
   */
  harvest: { summary: string; filename: string; busy: boolean } | null;
  onExportHarvest: () => void;
}

/** How many groups the panel lists before the rest are left to the page outline. */
const MAX_GROUPS = 5;

const MARKERS: Record<ElementScanEvidenceRow['strength'], string> = {
  definitive: '●',
  supporting: '○',
  context: '·',
};

export function ElementScanPanel({
  scan,
  busy,
  onScan,
  onHide,
  onHighlight,
  harvest,
  onExportHarvest,
}: ElementScanPanelProps) {
  return (
    <section className="settings-card ai-card">
      <div className="section-head">
        <span className="section-title">
          <span className="ai-chip">AI</span> Element scan
        </span>
        <button className="chip-btn" disabled={busy} onClick={onScan}>
          {busy ? 'Scanning…' : scan ? 'Rescan' : 'Scan page'}
        </button>
      </div>
      <p className="card-hint">
        The on-device model reads this page's elements — markup, sources, geometry and copy — and says
        which ones are ads, trackers or nags. Nothing is hidden until you say so.
      </p>

      {scan && (
        <>
          <div className="ai-summary">
            {elementAiScanSummary({ hide: scan.hideCount, suggest: scan.suggestCount })}
            <span className="ai-summary-sub">{scan.scanned.toLocaleString()} elements examined</span>
          </div>

          {scan.groups.length > 0 && (
            <div className="ai-group-list">
              {scan.groups.slice(0, MAX_GROUPS).map((group) => (
                <div key={group.selector} className={`ai-group tone-${elementAiTone(group.elementClass)}`}>
                  <div className="ai-group-main">
                    <code className="ai-group-selector">{group.selector}</code>
                    <span className="ai-group-meta">
                      {group.elementClass} · {group.confidence}% · {group.matches} element
                      {group.matches === 1 ? '' : 's'}
                    </span>
                    <span className="ai-group-reason">{group.reason}</span>
                    {group.evidence && group.evidence.length > 0 && (
                      <ul className="ai-group-evidence">
                        {group.evidence.map((row) => (
                          <li key={row.id} className={`ai-evidence-row strength-${row.strength}`}>
                            <span className="ai-evidence-mark" aria-hidden="true">
                              {MARKERS[row.strength]}
                            </span>
                            <span className="ai-evidence-label">{row.label}</span>
                            {row.detail && <code className="ai-evidence-detail">{row.detail}</code>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <button
                    className="chip-btn"
                    disabled={busy}
                    // The visible text cannot name what it acts on \u2014 every group says "Hide" \u2014 so a
                    // screen-reader user heard "Hide, Hide, Hide" with nothing to tell them which
                    // element each one removes, on the one action here that takes content off the
                    // page. The label carries the selector and the count, because both are needed:
                    // the selector identifies it and the count says how much of the page it takes.
                    // The visible text stays "Hide" \u2014 the row above it already shows the selector to
                    // anyone who can see, and repeating it twice reads as noise.
                    aria-label={`Hide ${group.matches} element${group.matches === 1 ? '' : 's'} matching ${group.selector}`}
                    onClick={() => onHide([group.selector])}
                  >
                    Hide
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="ai-actions">
            <button className="chip-btn" onClick={onHighlight}>
              Show me where
            </button>
            {scan.hideCount > 0 && (
              <button className="chip-btn primary" disabled={busy} onClick={() => onHide()}>
                Hide all {scan.hideCount}
              </button>
            )}
          </div>
        </>
      )}

      {harvest && (
        <div className="ai-harvest">
          <p className="card-hint">
            Scans and your own decisions also collect the elements they saw, so the element
            corpus can grow from real pages instead of from guesswork. {harvest.summary}
          </p>
          <div className="ai-actions">
            <button
              className="chip-btn"
              disabled={harvest.busy}
              onClick={onExportHarvest}
              title="Writes a file of captured elements for the corpus queue, and clears this buffer"
            >
              {harvest.busy ? 'Exporting…' : 'Export captured elements'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
