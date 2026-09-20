import React, { useState, useEffect, useRef } from 'react';

interface CustomRulesViewProps {
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
}

export const CustomRulesView: React.FC<CustomRulesViewProps> = ({
  setError,
  setSuccessMessage,
}) => {
  const [customRules, setCustomRules] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    window.electron
      .getCustomRules()
      .then((rules) => {
        if (isMountedRef.current) {
          setCustomRules(rules || '');
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (isMountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load custom rules');
          setIsLoading(false);
        }
      });

    return () => {
      isMountedRef.current = false;
    };
  }, [setError]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await window.electron.setCustomRules(customRules);
      if (res.success) {
        setSuccessMessage('Custom rules saved successfully.');
      } else {
        setError(res.error || 'Failed to save custom rules.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error saving custom rules');
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  };

  // Real-time syntax breakdown
  const lines = customRules.split('\n');
  let blockCount = 0;
  let exceptionCount = 0;
  let cosmeticCount = 0;
  let hostsCount = 0;
  let commentCount = 0;

  lines.forEach((rawLine) => {
    const l = rawLine.trim();
    if (!l) return;
    if (l.startsWith('!') || l.startsWith('# ') || l === '#') {
      commentCount++;
    } else if (l.startsWith('@@')) {
      exceptionCount++;
    } else if (l.includes('##') || l.includes('#?#') || l.includes('#@#') || l.includes('#$#')) {
      cosmeticCount++;
    } else if (l.startsWith('0.0.0.0') || l.startsWith('127.0.0.1')) {
      hostsCount++;
    } else if (l.startsWith('||') || l.startsWith('|') || l.startsWith('/')) {
      blockCount++;
    } else {
      blockCount++;
    }
  });

  const totalActiveRules = lines.filter((l) => l.trim() && !l.trim().startsWith('!') && !l.trim().startsWith('# ')).length;

  return (
    <div className="custom-rules-container">
      {/* Editor Main Card */}
      <div className="desktop-card">
        <div className="rules-header-row">
          <div>
            <h3 className="card-section-title">Author Custom Rules</h3>
            <p className="card-section-subtitle">
              Add your own local overrides, whitelist exceptions, or custom network blocks. Custom rules always take priority over remote feeds.
            </p>
          </div>

          {/* Metrics Pill Grid */}
          <div className="syntax-metrics-pills">
            <span className="syntax-pill active-total">
              <strong>{totalActiveRules}</strong> active
            </span>
            <span className="syntax-pill pill-block" title="Domain/Network Blocks (||)">
              <strong>{blockCount}</strong> blocks
            </span>
            <span className="syntax-pill pill-exception" title="Allowlist Exceptions (@@)">
              <strong>{exceptionCount}</strong> allowlists
            </span>
            <span className="syntax-pill pill-cosmetic" title="Cosmetic / Element Hiding (##)">
              <strong>{cosmeticCount}</strong> cosmetic
            </span>
            {hostsCount > 0 && (
              <span className="syntax-pill pill-hosts" title="Hosts DNS entries (0.0.0.0)">
                <strong>{hostsCount}</strong> hosts
              </span>
            )}
          </div>
        </div>

        <textarea
          value={customRules}
          onChange={(e) => setCustomRules(e.target.value)}
          placeholder="||telemetry.example.com^&#10;@@||allowed-site.com^&#10;example.com##.ad-banner&#10;0.0.0.0 malicious-tracker.net"
          rows={14}
          className="custom-rules-textarea"
          disabled={isLoading}
        />

        <div className="rules-actions-footer">
          <div className="rules-hint-text">
            <span>{lines.length} total lines • {commentCount} comments</span>
          </div>

          <button
            className="primary-button"
            onClick={handleSave}
            disabled={isSaving || isLoading}
          >
            {isSaving ? 'Saving Rules…' : 'Save Custom Rules'}
          </button>
        </div>
      </div>

      {/* Syntax Quick Reference Card */}
      <div className="desktop-card syntax-ref-card">
        <h4 className="syntax-card-title">Adblock & DNS Syntax Reference</h4>
        <div className="syntax-grid">
          <div className="syntax-item">
            <code>||example.com^</code>
            <span>Blocks <code>example.com</code> and all its subdomains across all protocols and ports.</span>
          </div>
          <div className="syntax-item">
            <code>@@||safe.example.com^</code>
            <span>Unblocks / allowlists <code>safe.example.com</code>, overriding any remote blocklist.</span>
          </div>
          <div className="syntax-item">
            <code>example.com##.ad-banner</code>
            <span>Hides elements with class <code>.ad-banner</code> on <code>example.com</code> (Cosmetic).</span>
          </div>
          <div className="syntax-item">
            <code>0.0.0.0 badsite.com</code>
            <span>Standard DNS hosts block format mapping domain to null IP address.</span>
          </div>
        </div>
      </div>
    </div>
  );
};
