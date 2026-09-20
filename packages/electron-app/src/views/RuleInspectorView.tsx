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
              placeholder="Enter domain or hostname (e.g. tracking.example.com)..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            {query && (
              <button className="inspector-clear-btn" onClick={() => setQuery('')}>
                ✕
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
                  <span className="verdict-icon">🚫</span>
                  <span>DOMAIN BLOCKED</span>
                </div>
              )}
              {result.verdict === 'exception' && (
                <div className="verdict-pill pill-exception">
                  <span className="verdict-icon">🟢</span>
                  <span>ALLOWLISTED EXCEPTION</span>
                </div>
              )}
              {result.verdict === 'not_blocked' && (
                <div className="verdict-pill pill-neutral">
                  <span className="verdict-icon">⚪</span>
                  <span>NOT BLOCKED</span>
                </div>
              )}
            </div>

            <div className="verdict-domain-name">
              <code>{result.domain}</code>
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
    </div>
  );
};
