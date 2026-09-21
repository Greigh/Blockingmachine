import React, { useState } from 'react';
import type { DomainInspectionResult } from '../types';

export const RuleInspectorView: React.FC = () => {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<DomainInspectionResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const sampleDomains = [
    'telemetry.microsoft.com',
    'google-analytics.com',
    'doubleclick.net',
    'github.com',
    'adservice.google.com',
  ];

  const extractDomain = (input: string): string => {
    let cleaned = input.trim().toLowerCase();
    if (cleaned.startsWith('http://') || cleaned.startsWith('https://') || cleaned.startsWith('ftp://')) {
      try {
        const parsed = new URL(cleaned);
        cleaned = parsed.hostname;
      } catch {
        // fallback regex
      }
    }
    cleaned = cleaned.replace(/^[a-zA-Z]+:\/\//, '');
    cleaned = cleaned.replace(/[/?#].*$/, '');
    cleaned = cleaned.replace(/:[0-9]+$/, '');
    cleaned = cleaned.replace(/^www\./, '');
    return cleaned;
  };

  const isUrlInput = Boolean(
    query.trim() &&
      (query.includes('://') ||
        query.includes('/') ||
        query.includes('?') ||
        query.startsWith('www.'))
  );
  const detectedDomain = isUrlInput ? extractDomain(query) : '';

  const handleInspect = async (domainToTest?: string) => {
    const target = (domainToTest !== undefined ? domainToTest : query).trim();
    if (!target) return;

    setIsSearching(true);
    try {
      const inspection = await window.electron.inspectDomain(target);
      setResult(inspection);
      if (domainToTest) setQuery(domainToTest);
    } catch (err) {
      setResult({
        domain: target,
        inputQuery: target,
        verdict: 'not_blocked',
        details: err instanceof Error ? err.message : 'Error inspecting domain',
      });
    } finally {
      setIsSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleInspect();
    }
  };

  return (
    <div className="inspector-view-container">
      {/* Search Header Banner */}
      <div className="desktop-card inspector-hero-card">
        <div className="inspector-hero-header">
          <div className="inspector-icon-shield">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </div>
          <div>
            <h2 className="inspector-title">Live Domain Rule Inspector</h2>
            <p className="inspector-subtitle">
              Verify whether any domain, hostname, or tracker is blocked by your compiled filter lists, and trace the exact matching rule and source feed.
            </p>
          </div>
        </div>

        {/* Input Bar */}
        <div className="inspector-input-group">
          <div className="inspector-input-wrapper">
            <svg className="inspector-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              className="inspector-text-input"
              placeholder="Enter domain, hostname, or full URL (e.g. roku.com or https://doubleclick.net)..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            {query && (
              <button
                className="inspector-clear-btn"
                onClick={() => {
                  setQuery('');
                  setResult(null);
                }}
                aria-label="Clear input"
                title="Clear input"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          <button
            className="primary-button inspector-submit-btn"
            onClick={() => handleInspect()}
            disabled={!query.trim() || isSearching}
          >
            {isSearching ? 'Analyzing…' : 'Inspect Rule'}
          </button>
        </div>

        {isUrlInput && detectedDomain && (
          <div className="inspector-url-hint">
            <span className="hint-badge">URL Detected</span>
            <span className="hint-text">
              Target host domain: <strong>{detectedDomain}</strong>
            </span>
          </div>
        )}

        {/* Sample Pills */}
        <div className="inspector-samples-row">
          <span className="samples-label">Quick test:</span>
          {sampleDomains.map((sample) => (
            <button
              key={sample}
              className="sample-domain-chip"
              onClick={() => handleInspect(sample)}
            >
              {sample}
            </button>
          ))}
        </div>
      </div>

      {/* Results View */}
      {result && (
        <div className={`desktop-card inspector-result-card verdict-${result.verdict}`}>
          <div className="verdict-banner-row">
            <div className="verdict-badge-wrap">
              {result.verdict === 'blocked' && (
                <div className="verdict-pill pill-blocked">
                  <span className="verdict-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                    </svg>
                  </span>
                  <span>DOMAIN BLOCKED</span>
                </div>
              )}
              {result.verdict === 'exception' && (
                <div className="verdict-pill pill-exception">
                  <span className="verdict-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span>ALLOWLISTED EXCEPTION</span>
                </div>
              )}
              {result.verdict === 'not_blocked' && (
                <div className="verdict-pill pill-neutral">
                  <span className="verdict-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                  </span>
                  <span>NOT BLOCKED</span>
                </div>
              )}
            </div>

            <div className="verdict-domain-name">
              <code>{result.domain}</code>
              {result.inputQuery && result.inputQuery.toLowerCase() !== result.domain.toLowerCase() && (
                <span className="original-url-caption">
                  Resolved from input: <code>{result.inputQuery}</code>
                </span>
              )}
            </div>
          </div>

          <div className="verdict-details-grid">
            {result.matchingRule && (
              <div className="detail-item">
                <span className="detail-label">Matching Rule</span>
                <div className="rule-code-block">
                  <code>{result.matchingRule}</code>
                </div>
              </div>
            )}

            {result.sourceName && (
              <div className="detail-item">
                <span className="detail-label">Originating Source</span>
                <div className="detail-value">{result.sourceName}</div>
              </div>
            )}

            {result.ruleType && (
              <div className="detail-item">
                <span className="detail-label">Rule Classification</span>
                <span className="classification-pill">{result.ruleType}</span>
              </div>
            )}

            <div className="detail-item full-width">
              <span className="detail-label">Diagnostics & Behavior</span>
              <p className="detail-explanation">{result.details}</p>
            </div>
          </div>
        </div>
      )}

      {/* Empty State / How Inspection Works */}
      {!result && !isSearching && (
        <div className="inspector-guide-wrapper">
          <div className="inspector-guide-header">
            <span className="guide-title">How Domain Matching & Resolution Works</span>
            <span className="guide-sub">Every domain query is verified through three engine stages in under 2ms</span>
          </div>

          <div className="inspector-stages-grid">
            <div className="desktop-card stage-card">
              <div className="stage-icon-wrap icon-match">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <div className="stage-number-badge">Stage 1</div>
              <h4 className="stage-title">Network & Wildcard Match</h4>
              <p className="stage-desc">
                Tests domain against compiled <code>||domain.com^</code> rules, host IPs (<code>0.0.0.0</code>), and wildcards across all active feeds.
              </p>
            </div>

            <div className="desktop-card stage-card">
              <div className="stage-icon-wrap icon-exception">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="stage-number-badge">Stage 2</div>
              <h4 className="stage-title">Exception Override Layer</h4>
              <p className="stage-desc">
                Evaluates priority allowlist rules (<code>@@||domain^</code>) to unbreak websites and ensure trusted destinations are never blocked.
              </p>
            </div>

            <div className="desktop-card stage-card">
              <div className="stage-icon-wrap icon-trace">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
              </div>
              <div className="stage-number-badge">Stage 3</div>
              <h4 className="stage-title">Origin Feed Attribution</h4>
              <p className="stage-desc">
                Identifies which specific subscribed filter list (e.g. AdGuard Base, EasyList) contributed the rule, enabling granular tuning.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
