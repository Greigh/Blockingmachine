import React, { useState, useEffect, useRef, useMemo } from 'react';

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

  // Real-time syntax breakdown (single pass, memoized to prevent render latency on large sets)
  const { totalLines, totalActiveRules, blockCount, exceptionCount, cosmeticCount, hostsCount, commentCount } = useMemo(() => {
    let blocks = 0;
    let exceptions = 0;
    let cosmetics = 0;
    let hosts = 0;
    let comments = 0;
    let active = 0;

    const allLines = customRules.split('\n');

    for (let i = 0; i < allLines.length; i++) {
      const l = allLines[i].trim();
      if (!l) continue;

      const isCosmetic = l.includes('##') || l.includes('#?#') || l.includes('#@#') || l.includes('#$#');
      const isComment = l.startsWith('!') || (l.startsWith('[') && l.endsWith(']')) || (l.startsWith('#') && !isCosmetic);

      if (isComment) {
        comments++;
      } else {
        active++;
        if (l.startsWith('@@')) {
          exceptions++;
        } else if (isCosmetic) {
          cosmetics++;
        } else if (l.startsWith('0.0.0.0') || l.startsWith('127.0.0.1')) {
          hosts++;
        } else {
          blocks++;
        }
      }
    }

    return {
      totalLines: allLines.length,
      totalActiveRules: active,
      blockCount: blocks,
      exceptionCount: exceptions,
      cosmeticCount: cosmetics,
      hostsCount: hosts,
      commentCount: comments,
    };
  }, [customRules]);

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

        {/* IDE Frame Bar */}
        <div className="editor-frame-container">
          <div className="editor-tab-strip">
            <div className="editor-tab-item active">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              <span>custom_rules.txt</span>
            </div>
            <span className="editor-syntax-badge">Adblock & DNS Syntax</span>
          </div>

          <textarea
            value={customRules}
            onChange={(e) => setCustomRules(e.target.value)}
            placeholder="||telemetry.example.com^&#10;@@||allowed-site.com^&#10;example.com##.ad-banner&#10;0.0.0.0 malicious-tracker.net"
            rows={12}
            className="custom-rules-textarea"
            disabled={isLoading}
          />
        </div>

        <div className="rules-actions-footer">
          <div className="rules-hint-text">
            <span>{totalLines} total lines • {commentCount} comments</span>
          </div>

          <button
            type="button"
            className="primary-button save-rules-btn"
            onClick={handleSave}
            disabled={isSaving || isLoading}
          >
            {isSaving ? (
              <span>Saving Rules…</span>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                <span>Save Custom Rules</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Syntax Quick Reference Card */}
      <div className="desktop-card syntax-ref-card">
        <div className="syntax-header-row">
          <h4 className="syntax-card-title">Adblock & DNS Syntax Reference</h4>
          <span className="syntax-card-sub">Click any template to append to your rules</span>
        </div>
        <div className="syntax-grid">
          <button
            type="button"
            className="syntax-item-chip"
            onClick={() => setCustomRules((prev) => prev ? prev + '\n||example.com^' : '||example.com^')}
            title="Click to insert example"
          >
            <code>||example.com^</code>
            <span>Blocks <strong>example.com</strong> and all its subdomains across all ports</span>
          </button>
          <button
            type="button"
            className="syntax-item-chip"
            onClick={() => setCustomRules((prev) => prev ? prev + '\n@@||safe.example.com^' : '@@||safe.example.com^')}
            title="Click to insert example"
          >
            <code>@@||safe.example.com^</code>
            <span>Unblocks / allowlists <strong>safe.example.com</strong>, overriding all blocks</span>
          </button>
          <button
            type="button"
            className="syntax-item-chip"
            onClick={() => setCustomRules((prev) => prev ? prev + '\nexample.com##.ad-banner' : 'example.com##.ad-banner')}
            title="Click to insert example"
          >
            <code>example.com##.ad-banner</code>
            <span>Cosmetic rule: hides CSS elements with class <strong>.ad-banner</strong></span>
          </button>
          <button
            type="button"
            className="syntax-item-chip"
            onClick={() => setCustomRules((prev) => prev ? prev + '\n0.0.0.0 badsite.com' : '0.0.0.0 badsite.com')}
            title="Click to insert example"
          >
            <code>0.0.0.0 badsite.com</code>
            <span>Standard DNS hosts block mapping domain to null IP (0.0.0.0)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
