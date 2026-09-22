import React, { useState, useEffect } from 'react';
import type {
  DomainInspectionResult,
  AiScanResult,
  RuleConflictResult,
} from '../types';
import { formatConfidencePercent, verdictBadgeLabel } from '../aiDisplay';

interface RuleInspectorViewProps {
  initialDomain?: string;
  onNavigateCustomRules?: () => void;
}

export const RuleInspectorView: React.FC<RuleInspectorViewProps> = ({
  initialDomain,
  onNavigateCustomRules,
}) => {
  const [query, setQuery] = useState(initialDomain || '');
  const [ruleResult, setRuleResult] = useState<DomainInspectionResult | null>(null);
  const [aiResult, setAiResult] = useState<AiScanResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [targetSyntax, setTargetSyntax] = useState<'all' | 'adguard' | 'pihole' | 'ublock' | 'unbound' | 'hosts'>('all');
  const [customSynthesizedRules, setCustomSynthesizedRules] = useState<string[] | null>(null);
  const [ruleConflict, setRuleConflict] = useState<RuleConflictResult | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [addedToCustom, setAddedToCustom] = useState(false);
  const [allowlisted, setAllowlisted] = useState(false);
  const [feedbackTune, setFeedbackTune] = useState<'idle' | 'threat_confirmed' | 'safe_confirmed'>('idle');
  const [activeDetailTab, setActiveDetailTab] = useState<'overview' | 'rules' | 'ai-heuristics'>('overview');

  const sampleDomains = [
    'doubleclick.net',
    'google-analytics.com',
    'telemetry.microsoft.com',
    'adservice.google.com',
    'github.com',
    'x7k9p2mqz1.biz',
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
    const rawTarget = (domainToTest !== undefined ? domainToTest : query).trim();
    if (!rawTarget) return;
    const cleanTarget = extractDomain(rawTarget);

    setIsSearching(true);
    setFeedbackTune('idle');
    setAddedToCustom(false);
    setAllowlisted(false);
    setCustomSynthesizedRules(null);
    setRuleConflict(null);
    setTargetSyntax('all');

    try {
      const [rulePromise, aiPromise] = await Promise.allSettled([
        window.electron.inspectDomain(cleanTarget || rawTarget),
        window.electron.aiScanDomain ? window.electron.aiScanDomain(cleanTarget || rawTarget) : Promise.reject(new Error('No AI API')),
      ]);

      if (rulePromise.status === 'fulfilled') {
        setRuleResult(rulePromise.value);
      } else {
        setRuleResult({
          domain: cleanTarget || rawTarget,
          inputQuery: rawTarget,
          verdict: 'not_blocked',
          details: rulePromise.reason instanceof Error ? rulePromise.reason.message : 'Error inspecting compiled rules',
        });
      }

      if (aiPromise.status === 'fulfilled') {
        const ai = aiPromise.value;
        setAiResult(ai);
        if (window.electron?.checkRuleConflict && ai.generatedRules?.length > 0) {
          window.electron.checkRuleConflict(ai.generatedRules[0]).then((conflict) => {
            if (conflict?.hasConflict) setRuleConflict(conflict);
          }).catch(console.error);
        }
      } else {
        setAiResult(null);
      }

      if (domainToTest) setQuery(domainToTest);
    } finally {
      setIsSearching(false);
    }
  };

  useEffect(() => {
    if (initialDomain && initialDomain.trim()) {
      handleInspect(initialDomain);
    }
  }, [initialDomain]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleInspect();
    }
  };

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const handleTargetSyntaxChange = async (target: 'all' | 'adguard' | 'pihole' | 'ublock' | 'unbound' | 'hosts') => {
    setTargetSyntax(target);
    if (!aiResult || !window.electron?.synthesizeCustomRules) return;
    try {
      const res = await window.electron.synthesizeCustomRules({
        domain: aiResult.domain,
        verdict: aiResult.verdict,
        category: aiResult.category,
        cnames: aiResult.cnames,
        target,
        confidence: aiResult.confidence,
      });
      if (res.success) {
        setCustomSynthesizedRules(res.rules);
        if (window.electron?.checkRuleConflict && res.rules.length > 0) {
          const conflict = await window.electron.checkRuleConflict(res.rules[0]);
          setRuleConflict(conflict?.hasConflict ? conflict : null);
        } else {
          setRuleConflict(null);
        }
      }
    } catch (err) {
      console.error('Failed to synthesize custom target rules:', err);
    }
  };

  const handleAddToCustom = async (rules: string[]) => {
    if (!rules || rules.length === 0 || !window.electron?.addCustomRules) return;
    try {
      const res = await window.electron.addCustomRules(rules);
      if (res.success) {
        setAddedToCustom(true);
      }
    } catch (err) {
      console.error('Failed to add custom rules:', err);
    }
  };

  const handleAllowlistDomain = async (domain: string) => {
    if (!domain || !window.electron?.addCustomAllowlist) return;
    try {
      const res = await window.electron.addCustomAllowlist(domain);
      if (res.success) {
        setAllowlisted(true);
      }
    } catch (err) {
      console.error('Failed to allowlist domain:', err);
    }
  };

  const handleTuneMiniAi = async (domain: string, action: 'block' | 'whitelist') => {
    if (!domain || !window.electron?.tuneMiniAiFeedback) return;
    try {
      await window.electron.tuneMiniAiFeedback(domain, action);
      setFeedbackTune(action === 'block' ? 'threat_confirmed' : 'safe_confirmed');
    } catch (err) {
      console.error('Failed to tune Mini-AI feedback:', err);
    }
  };

  const activeRulesToDisplay = customSynthesizedRules !== null
    ? customSynthesizedRules
    : (aiResult?.generatedRules || (ruleResult?.matchingRule ? [ruleResult.matchingRule] : []));

  return (
    <div className="inspector-view-container">
      {/* Search Header Banner */}
      <div className="desktop-card inspector-hero-card">
        <div className="inspector-hero-header">
          <div className="inspector-icon-shield">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 className="inspector-title" style={{ margin: 0 }}>Unified Rule &amp; AI Domain Inspector</h2>
              <span className="sidebar-badge-inline beta">AI + Rules</span>
            </div>
            <p className="inspector-subtitle">
              Verify any domain or URL against your active compiled filter lists while simultaneously running live AI threat heuristics, CNAME uncloaking, and Shannon entropy analysis.
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
              placeholder="Enter domain, hostname, or full URL (e.g. doubleclick.net, telemetry.microsoft.com, x7k9p2mqz1.biz)..."
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
                  setRuleResult(null);
                  setAiResult(null);
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
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {isSearching ? (
              <>
                <span className="loading-spinner-micro" />
                <span>Analyzing…</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span>Inspect Domain</span>
              </>
            )}
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

      {/* Unified Results Section */}
      {(ruleResult || aiResult) && (
        <div className="desktop-card inspector-result-card" style={{ padding: 20 }}>
          {/* Top Unified Verdict Banner */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 12,
              padding: '16px 20px',
              borderRadius: 10,
              background: 'var(--bg-tertiary, rgba(255, 255, 255, 0.03))',
              border: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))',
              marginBottom: 18,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {/* Filter List Rule Status */}
              {ruleResult && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {ruleResult.verdict === 'blocked' && (
                    <span className="verdict-pill pill-blocked" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                      </svg>
                      DOMAIN BLOCKED
                    </span>
                  )}
                  {ruleResult.verdict === 'exception' && (
                    <span className="verdict-pill pill-exception" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      ALLOWLIST EXCEPTION
                    </span>
                  )}
                  {ruleResult.verdict === 'not_blocked' && (
                    <span className="verdict-pill pill-neutral" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="9" />
                      </svg>
                      NOT IN COMPILED RULES
                    </span>
                  )}
                </div>
              )}

              {/* Live AI Threat Assessment */}
              {aiResult && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {aiResult.verdict === 'malicious' && (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'rgba(239, 68, 68, 0.2)',
                        color: '#f87171',
                        border: '1px solid rgba(239, 68, 68, 0.4)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      AI: HIGH THREAT ({aiResult.category.toUpperCase()})
                    </span>
                  )}
                  {(aiResult.verdict === 'ad_server' || aiResult.verdict === 'tracker') && (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: aiResult.verdict === 'ad_server' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(168, 85, 247, 0.2)',
                        color: aiResult.verdict === 'ad_server' ? '#f87171' : '#c084fc',
                        border: aiResult.verdict === 'ad_server'
                          ? '1px solid rgba(239, 68, 68, 0.4)'
                          : '1px solid rgba(168, 85, 247, 0.4)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                      }}
                    >
                      {verdictBadgeLabel(aiResult.verdict)} ({aiResult.category.toUpperCase()})
                    </span>
                  )}
                  {aiResult.verdict === 'suspicious' && (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'rgba(168, 85, 247, 0.2)',
                        color: '#c084fc',
                        border: '1px solid rgba(168, 85, 247, 0.4)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      {aiResult.category === 'Unknown'
                        ? 'SUSPICIOUS (LOW CONFIDENCE)'
                        : `SUSPICIOUS (${aiResult.category.toUpperCase()})`}
                    </span>
                  )}
                  {aiResult.verdict === 'clean' && (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'rgba(16, 185, 129, 0.2)',
                        color: '#34d399',
                        border: '1px solid rgba(16, 185, 129, 0.4)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      AI: VERIFIED CLEAN
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)', marginLeft: 4 }}>
                    Confidence: <strong>{formatConfidencePercent(aiResult.confidence)}</strong>
                  </span>
                </div>
              )}
            </div>

            <div className="verdict-domain-name" style={{ margin: 0 }}>
              <code style={{ fontSize: 16 }}>{ruleResult?.domain || aiResult?.domain || query}</code>
            </div>
          </div>

          {/* Navigation Tabs for Detailed Inspection */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))', paddingBottom: 10 }}>
            <button
              type="button"
              className={`secondary-button ${activeDetailTab === 'overview' ? 'active-tab' : ''}`}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 14px',
                borderRadius: 6,
                background: activeDetailTab === 'overview' ? 'var(--accent-primary, #6366f1)' : 'transparent',
                color: activeDetailTab === 'overview' ? '#fff' : 'inherit',
                border: activeDetailTab === 'overview' ? '1px solid var(--accent-primary, #6366f1)' : '1px solid var(--border-color, rgba(255,255,255,0.1))',
              }}
              onClick={() => setActiveDetailTab('overview')}
            >
              Unified Intelligence
            </button>
            <button
              type="button"
              className={`secondary-button ${activeDetailTab === 'rules' ? 'active-tab' : ''}`}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 14px',
                borderRadius: 6,
                background: activeDetailTab === 'rules' ? 'var(--accent-primary, #6366f1)' : 'transparent',
                color: activeDetailTab === 'rules' ? '#fff' : 'inherit',
                border: activeDetailTab === 'rules' ? '1px solid var(--accent-primary, #6366f1)' : '1px solid var(--border-color, rgba(255,255,255,0.1))',
              }}
              onClick={() => setActiveDetailTab('rules')}
            >
              Filter Rules &amp; Origin ({ruleResult?.verdict === 'blocked' ? '1 Match' : '0 Matches'})
            </button>
            <button
              type="button"
              className={`secondary-button ${activeDetailTab === 'ai-heuristics' ? 'active-tab' : ''}`}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 14px',
                borderRadius: 6,
                background: activeDetailTab === 'ai-heuristics' ? 'var(--accent-primary, #6366f1)' : 'transparent',
                color: activeDetailTab === 'ai-heuristics' ? '#fff' : 'inherit',
                border: activeDetailTab === 'ai-heuristics' ? '1px solid var(--accent-primary, #6366f1)' : '1px solid var(--border-color, rgba(255,255,255,0.1))',
              }}
              onClick={() => setActiveDetailTab('ai-heuristics')}
            >
              AI Heuristics &amp; CNAME ({aiResult ? `${aiResult.category}` : 'Offline'})
            </button>
          </div>

          {/* TAB 1: Unified Intelligence Overview */}
          {activeDetailTab === 'overview' && (
            <div>
              {/* Metric Cards Grid */}
              <div className="inspector-metrics-grid" style={{ marginBottom: 18 }}>
                <div className="metric-card">
                  <span className="card-label">Rule Engine Verdict</span>
                  <span className="card-value" style={{ fontSize: 16 }}>
                    {ruleResult?.verdict === 'blocked' ? 'Blocked' : ruleResult?.verdict === 'exception' ? 'Allowlisted' : 'Unblocked'}
                  </span>
                  <span className="card-sub">{ruleResult?.sourceName || 'No feed match'}</span>
                </div>
                <div className="metric-card">
                  <span className="card-label">AI Threat Level</span>
                  <span className="card-value" style={{ fontSize: 16 }}>
                    {aiResult?.riskLevel ? aiResult.riskLevel.toUpperCase() : 'UNKNOWN'}
                  </span>
                  <span className="card-sub">Category: {aiResult?.category || 'N/A'}</span>
                </div>
                <div className="metric-card">
                  <span className="card-label">Shannon Entropy</span>
                  <span className="card-value" style={{ fontSize: 16 }}>
                    {aiResult?.entropy !== undefined ? aiResult.entropy.toFixed(2) : '0.00'}
                  </span>
                  <span className="card-sub">{aiResult?.isLikelyDga ? 'Randomized DGA' : 'Natural Syntax'}</span>
                </div>
                <div className="metric-card">
                  <span className="card-label">CNAME Cloaking</span>
                  <span className="card-value" style={{ fontSize: 16 }}>
                    {aiResult?.cnames && aiResult.cnames.length > 0 ? `${aiResult.cnames.length} Hops` : 'Direct'}
                  </span>
                  <span className="card-sub">
                    {aiResult?.category === 'CNAME Cloaking'
                      ? 'External Tracker Alias'
                      : aiResult?.cnames && aiResult.cnames.length > 0
                        ? 'External alias'
                        : 'Standard A-Record'}
                  </span>
                </div>
              </div>

              {/* Dual Column Layout: Rule Match + AI Evidence */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 18 }}>
                {/* Left Card: Rule Details */}
                <div style={{ padding: 14, borderRadius: 8, background: 'var(--bg-secondary, rgba(255,255,255,0.02))', border: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
                  <h4 style={{ margin: '0 0 10px 0', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                    Filter List Attribution
                  </h4>
                  {ruleResult?.matchingRule ? (
                    <div>
                      <div className="rule-code-block" style={{ marginBottom: 8 }}>
                        <code>{ruleResult.matchingRule}</code>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        Origin: <strong>{ruleResult.sourceName || 'Compiled Feeds'}</strong>
                      </div>
                      {ruleResult.ruleType && (
                        <div style={{ marginTop: 6 }}>
                          <span className="classification-pill">{ruleResult.ruleType}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
                      This domain does not match any active rules in your subscribed filter lists. It can be freely resolved unless blocked by custom rules.
                    </p>
                  )}
                </div>

                {/* Right Card: AI Findings */}
                <div style={{ padding: 14, borderRadius: 8, background: 'var(--bg-secondary, rgba(255,255,255,0.02))', border: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
                  <h4 style={{ margin: '0 0 10px 0', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                    AI Threat Evidence
                  </h4>
                  {aiResult && aiResult.reasons.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6, color: 'var(--text-color)' }}>
                      {aiResult.reasons.map((r, idx) => (
                        <li key={idx}>{r}</li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
                      No malicious patterns, high entropy markers, or known tracker signatures detected.
                    </p>
                  )}
                  {aiResult?.modelUsed && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)', opacity: 0.8 }}>
                      Evaluated by: <strong>{aiResult.modelUsed}</strong>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: Filter Rules & Diagnostics */}
          {activeDetailTab === 'rules' && (
            <div className="verdict-details-grid" style={{ marginBottom: 18 }}>
              {ruleResult?.matchingRule && (
                <div className="detail-item">
                  <span className="detail-label">Matching Rule</span>
                  <div className="rule-code-block" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <code>{ruleResult.matchingRule}</code>
                    <button
                      type="button"
                      className="secondary-button"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                      onClick={() => handleCopy(ruleResult.matchingRule || '', 'rule-copy')}
                    >
                      {copiedKey === 'rule-copy' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              {ruleResult?.sourceName && (
                <div className="detail-item">
                  <span className="detail-label">Originating Source Feed</span>
                  <div className="detail-value">{ruleResult.sourceName}</div>
                </div>
              )}

              {ruleResult?.ruleType && (
                <div className="detail-item">
                  <span className="detail-label">Rule Classification</span>
                  <span className="classification-pill">{ruleResult.ruleType}</span>
                </div>
              )}

              <div className="detail-item full-width">
                <span className="detail-label">Diagnostics &amp; Behavior</span>
                <p className="detail-explanation">{ruleResult?.details || 'Standard domain rule resolution evaluation.'}</p>
              </div>
            </div>
          )}

          {/* TAB 3: AI Heuristics, DGA & CNAME */}
          {activeDetailTab === 'ai-heuristics' && (
            <div style={{ marginBottom: 18 }}>
              {/* CNAME Chain visualizer */}
              {aiResult?.cnames && aiResult.cnames.length > 0 && (
                <div className="evidence-section" style={{ marginBottom: 14 }}>
                  <h5 style={{ fontSize: 13, marginBottom: 6 }}>CNAME Uncloaking Chain Trace</h5>
                  <p style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--accent-primary, #6366f1)', fontSize: 13, background: 'rgba(0,0,0,0.2)', padding: '8px 12px', borderRadius: 6 }}>
                    {aiResult.domain} → {aiResult.cnames.join(' → ')}
                  </p>
                </div>
              )}

              {/* Feature Scores Breakdown */}
              {aiResult?.featureScores && Object.keys(aiResult.featureScores).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <h5 style={{ fontSize: 13, marginBottom: 6 }}>Mini-AI Feature Weight Breakdown</h5>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                    {Object.entries(aiResult.featureScores).map(([feature, score], idx) => (
                      <div key={idx} style={{ padding: '8px 10px', borderRadius: 6, background: 'var(--control-bg-color, rgba(255,255,255,0.03))', border: '1px solid var(--border-color, rgba(255,255,255,0.06))', fontSize: 12 }}>
                        <span style={{ fontWeight: 600 }}>{feature}</span>: <span style={{ color: score > 0 ? '#f87171' : '#34d399' }}>{score > 0 ? `+${score.toFixed(2)}` : score.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Mini-AI Metadata Banner */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(59, 130, 246, 0.08)',
                border: '1px solid rgba(59, 130, 246, 0.2)',
                fontSize: 12,
                flexWrap: 'wrap'
              }}>
                <span style={{ fontWeight: 600, color: 'var(--accent-primary, #6366f1)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  Inference Latency: {aiResult?.inferenceTimeMs !== undefined ? `${aiResult.inferenceTimeMs}ms` : '< 0.05ms'}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>•</span>
                <span>Engine: {aiResult?.modelUsed || 'Mini-AI Embedded Classifier'}</span>
                <span style={{ color: 'var(--text-secondary)' }}>•</span>
                <span>Shannon Entropy: {aiResult?.entropy !== undefined ? aiResult.entropy.toFixed(2) : '0.00'}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#10b981', fontWeight: 600 }}>
                  100% In-Memory Air-Gapped
                </span>
              </div>
            </div>
          )}

          {/* Rule Conflict Warning */}
          {ruleConflict && ruleConflict.hasConflict && (
            <div style={{
              margin: '12px 0',
              padding: '10px 14px',
              borderRadius: 8,
              background: 'rgba(234, 179, 8, 0.1)',
              border: '1px solid rgba(234, 179, 8, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-color)' }}>
                <span style={{ fontWeight: 600, color: '#eab308', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  Allowlist Conflict Detected:
                </span> {ruleConflict.reason}
                {ruleConflict.suggestedOverrideRule && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Suggested Override: <code style={{ color: 'var(--accent-primary, #6366f1)' }}>{ruleConflict.suggestedOverrideRule}</code>
                  </div>
                )}
              </div>
              {ruleConflict.suggestedOverrideRule && (
                <button
                  type="button"
                  className="secondary-button"
                  style={{ fontSize: 11, padding: '4px 10px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onClick={() => {
                    if (ruleConflict.suggestedOverrideRule) {
                      setCustomSynthesizedRules([ruleConflict.suggestedOverrideRule]);
                    }
                  }}
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  <span>Use $important Override</span>
                </button>
              )}
            </div>
          )}

          {/* Action Bar & Rule Synthesizer */}
          <div
            style={{
              padding: '16px 18px',
              borderRadius: 8,
              background: 'var(--bg-secondary, rgba(255,255,255,0.02))',
              border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
              marginTop: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Synthesize Filter Rules:</span>
                <div style={{ display: 'inline-flex', gap: 4, background: 'rgba(0,0,0,0.2)', padding: '2px 4px', borderRadius: 6 }}>
                  {(['all', 'adguard', 'pihole', 'ublock', 'unbound', 'hosts'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      style={{
                        padding: '2px 8px',
                        fontSize: 10,
                        borderRadius: 4,
                        border: 'none',
                        cursor: 'pointer',
                        background: targetSyntax === fmt ? 'var(--accent-primary, #6366f1)' : 'transparent',
                        color: targetSyntax === fmt ? '#fff' : 'var(--text-secondary, #94a3b8)',
                        fontWeight: targetSyntax === fmt ? 600 : 400,
                      }}
                      onClick={() => handleTargetSyntaxChange(fmt)}
                    >
                      {fmt === 'all' ? 'Universal' : fmt.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Interactive Action Buttons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="secondary-button"
                  style={{ fontSize: 12, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onClick={() => handleAllowlistDomain(ruleResult?.domain || aiResult?.domain || query)}
                  disabled={allowlisted}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>{allowlisted ? '✓ Allowlisted' : 'Whitelist (@@)'}</span>
                </button>

                {activeRulesToDisplay.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="secondary-button"
                      style={{ fontSize: 12, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      onClick={() => handleCopy(activeRulesToDisplay.join('\n'), 'all-rules')}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      <span>{copiedKey === 'all-rules' ? '✓ Copied' : 'Copy Rules'}</span>
                    </button>

                    <button
                      type="button"
                      className="primary-button"
                      style={{ fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                      onClick={() => {
                        if (addedToCustom && onNavigateCustomRules) {
                          onNavigateCustomRules();
                        } else {
                          handleAddToCustom(activeRulesToDisplay);
                        }
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        {addedToCustom ? (
                          <polyline points="20 6 9 17 4 12" />
                        ) : (
                          <path d="M12 4.5v15m7.5-7.5h-15" />
                        )}
                      </svg>
                      <span>{addedToCustom ? 'View in Custom Rules →' : 'Add to Custom Rules'}</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Generated Rule Snippet Box */}
            {activeRulesToDisplay.length > 0 ? (
              <div className="rules-code-block" style={{ background: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 6 }}>
                {activeRulesToDisplay.map((rule, idx) => (
                  <div key={idx} className="rule-code-line" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--text-color)' }}>
                    {rule}
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: 'var(--text-secondary, #94a3b8)', fontSize: 12, margin: '8px 0 0 0' }}>
                Clean destination. No blocking rules synthesized.
              </p>
            )}

            {/* Mini-AI Feedback Tuning */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))', flexWrap: 'wrap', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Train Mini-AI heuristics for this domain:
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  className="secondary-button"
                  style={{ fontSize: 11, padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onClick={() => handleTuneMiniAi(ruleResult?.domain || aiResult?.domain || query, 'block')}
                  disabled={feedbackTune === 'threat_confirmed'}
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                  </svg>
                  <span>{feedbackTune === 'threat_confirmed' ? '✓ Threat Confirmed' : 'Flag as Threat'}</span>
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  style={{ fontSize: 11, padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onClick={() => handleTuneMiniAi(ruleResult?.domain || aiResult?.domain || query, 'whitelist')}
                  disabled={feedbackTune === 'safe_confirmed'}
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3" />
                  </svg>
                  <span>{feedbackTune === 'safe_confirmed' ? '✓ Marked Safe' : 'Mark as Safe (False Positive)'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty State / How Unified Inspection Works */}
      {!ruleResult && !aiResult && !isSearching && (
        <div className="inspector-guide-wrapper">
          <div className="inspector-guide-header">
            <span className="guide-title">How Unified Rule &amp; AI Inspection Works</span>
            <span className="guide-sub">Simultaneously compares against compiled filter lists and deep heuristic machine learning in under 2ms</span>
          </div>

          <div className="inspector-stages-grid">
            <div className="desktop-card stage-card">
              <div className="stage-icon-wrap icon-match">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <div className="stage-number-badge">Stage 1</div>
              <h4 className="stage-title">Network &amp; Filter List Matching</h4>
              <p className="stage-desc">
                Tests domain against compiled <code>||domain.com^</code> rules, host IPs (<code>0.0.0.0</code>), and allowlists across all subscribed feeds.
              </p>
            </div>

            <div className="desktop-card stage-card">
              <div className="stage-icon-wrap icon-trace">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              </div>
              <div className="stage-number-badge">Stage 2</div>
              <h4 className="stage-title">AI Heuristics &amp; DGA Analysis</h4>
              <p className="stage-desc">
                Computes Shannon entropy, Levenshtein distance against top tracker signatures, and brand impersonation patterns using embedded Mini-AI.
              </p>
            </div>

            <div className="desktop-card stage-card">
              <div className="stage-icon-wrap icon-exception">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#a855f7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                </svg>
              </div>
              <div className="stage-number-badge">Stage 3</div>
              <h4 className="stage-title">CNAME Uncloaking &amp; Rule Synthesis</h4>
              <p className="stage-desc">
                Resolves disguised first-party CNAME tracker hops and automatically synthesizes blocking rules in Universal, AdGuard, or Pi-hole format.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
