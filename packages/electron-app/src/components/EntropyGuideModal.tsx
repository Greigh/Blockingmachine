import React, { useEffect } from 'react';

interface EntropyGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const EntropyGuideModal: React.FC<EntropyGuideModalProps> = ({ isOpen, onClose }) => {
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="ai-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="ai-modal-card entropy-guide-card" onClick={(e) => e.stopPropagation()}>
        <div className="ai-modal-header">
          <div className="ai-modal-title-col">
            <h4 className="ai-modal-title">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 22h16" />
                <path d="M7 17l4-8 4 6 5-11" />
              </svg>
              <span>Shannon Entropy & Randomness Guide</span>
            </h4>
            <p className="ai-modal-desc">
              How Blockingmachine evaluates algorithmic randomness to uncover stealth tracking tokens, ephemeral ad bidding hostnames, and DGA algorithms.
            </p>
          </div>
          <button
            type="button"
            className="ai-modal-close-btn"
            onClick={onClose}
            aria-label="Close entropy guide"
            title="Close"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="ai-modal-body entropy-guide-body">
          {/* Quick Summary Pill Callout */}
          <div className="entropy-summary-box">
            <div className="entropy-scale-lead">
              <span className="scale-num">0.00 – 5.00</span>
              <span className="scale-title">Shannon Entropy Scale</span>
            </div>
            <p className="entropy-scale-text">
              Shannon Entropy measures the <strong>mathematical unpredictability and character frequency randomness</strong> of a domain label. It tells you whether a domain name looks like natural human language or an automated machine-generated token.
            </p>
          </div>

          {/* Visual Gauge Meter */}
          <div className="entropy-meter-container">
            <div className="entropy-meter-bar">
              <div className="entropy-segment segment-normal" title="0.0 - 3.4: Normal">
                <span>0.0 – 3.4</span>
              </div>
              <div className="entropy-segment segment-elevated" title="3.4 - 3.8: Elevated">
                <span>3.4 – 3.8</span>
              </div>
              <div className="entropy-segment segment-high" title="3.8 - 5.0: High Randomness">
                <span>3.8 – 5.0</span>
              </div>
            </div>
            <div className="entropy-meter-labels">
              <span>0.0 (Pure Repetition)</span>
              <span>3.4 (Elevated)</span>
              <span>3.8 (Threshold)</span>
              <span>5.0 (Max Randomness)</span>
            </div>
          </div>

          {/* Three Tier Breakdown */}
          <div className="entropy-tiers-list">
            <div className="entropy-tier-card normal">
              <div className="tier-header">
                <span className="entropy-badge-tag normal">0.00 – 3.39 Normal</span>
                <span className="tier-name">Natural Syntax / Dictionary</span>
              </div>
              <p className="tier-desc">
                Consistent character frequencies typical of natural language words, human-crafted brand names, and everyday services.
              </p>
              <div className="tier-example">
                Examples: <code>google.com</code> (2.32), <code>github.com</code> (2.58), <code>apple.com</code> (2.19)
              </div>
            </div>

            <div className="entropy-tier-card elevated">
              <div className="tier-header">
                <span className="entropy-badge-tag elevated">3.40 – 3.79 Elevated</span>
                <span className="tier-name">Compound or Segmented Tokens</span>
              </div>
              <p className="tier-desc">
                Moderate lexical complexity resulting from hyphenated terms, combined dictionary roots, or mixed numeric subdomains.
              </p>
              <div className="tier-example">
                Examples: <code>google-analytics.com</code> (3.77), <code>cdn-origin-east2.net</code> (3.55)
              </div>
            </div>

            <div className="entropy-tier-card high">
              <div className="tier-header">
                <span className="entropy-badge-tag high">3.80 – 5.00 High Randomness</span>
                <span className="tier-name">Machine-Generated / DGA / Tracker Token</span>
              </div>
              <p className="tier-desc">
                High mathematical randomness characteristic of programmatic advertising bidding pools, dynamic tracking hashes, session beacons, and malware Domain Generation Algorithms (DGA).
              </p>
              <div className="tier-example">
                Examples: <code>telemetry.individual.githubcopilot.com</code> (4.02), <code>a9f1b4c8d2e6.adexchange.biz</code> (4.41)
              </div>
            </div>
          </div>

          {/* Why it is out of 5.0 & Why it matters */}
          <div className="entropy-faq-grid">
            <div className="faq-card">
              <h5 className="faq-question">Why is it out of 5.0?</h5>
              <p className="faq-answer">
                Shannon Entropy is calculated in bits per character: <code>H = -∑ p·log₂(p)</code>. In DNS hostnames consisting of standard lowercase letters, digits, and hyphens (37 valid characters), the theoretical maximum information density is <strong>log₂(37) ≈ 5.21 bits</strong>, which caps at <strong>5.00</strong> in real-world domain analysis.
              </p>
            </div>
            <div className="faq-card">
              <h5 className="faq-question">Why does Blockingmachine check this?</h5>
              <p className="faq-answer">
                Ad exchanges and behavioral surveillance networks frequently spin up temporary, randomized subdomains to evade static blocklists. Mini-AI analyzes Shannon entropy offline in <strong>&lt;0.05ms</strong> with zero network lookups, flagging evasive ad beacons before human list maintainers see them.
              </p>
            </div>
          </div>
        </div>

        <div className="ai-modal-footer">
          <button
            type="button"
            className="primary-button"
            onClick={onClose}
            style={{ minWidth: 100 }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
