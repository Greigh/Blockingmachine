import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  AiProviderConfig,
  AiScanResult,
  QueryLogScanResult,
  CrawlScanResult,
  SinkholeConfig,
} from '../types/';

interface AIRadarViewProps {
  onTriggerCompile?: () => void;
  onNavigateDeploy?: () => void;
  setError?: (msg: string | null) => void;
  setSuccessMessage?: (msg: string | null) => void;
}

type RadarTab = 'sinkhole-scout' | 'domain-inspector' | 'canary-crawler';

export const AIRadarView: React.FC<AIRadarViewProps> = ({
  onTriggerCompile,
  onNavigateDeploy,
  setError,
  setSuccessMessage,
}) => {
  const isMountedRef = useRef(true);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const safeSetTimeout = useCallback((fn: () => void, delayMs: number) => {
    const id = setTimeout(() => {
      if (isMountedRef.current) fn();
    }, delayMs);
    timersRef.current.push(id);
    return id;
  }, []);

  const [activeTab, setActiveTab] = useState<RadarTab>('sinkhole-scout');
  const [aiConfig, setAiConfig] = useState<AiProviderConfig>({
    provider: 'local-heuristics',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.2',
    apiKey: '',
  });

  // Settings modal state
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isTestingAi, setIsTestingAi] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<{ success: boolean; latencyMs?: number; message: string } | null>(null);

  // Tab 1: Sinkhole Scout State
  const [scoutService, setScoutService] = useState<'adguard' | 'pihole'>('adguard');
  const [isScouting, setIsScouting] = useState(false);
  const [scoutResult, setScoutResult] = useState<QueryLogScanResult | null>(null);
  const [sinkholeConfig, setSinkholeConfig] = useState<SinkholeConfig | null>(null);
  const [blockedItemsMap, setBlockedItemsMap] = useState<Set<string>>(new Set());

  // Tab 2: Domain Inspector State
  const [inspectorInput, setInspectorInput] = useState('');
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectorResult, setInspectorResult] = useState<AiScanResult | null>(null);

  // Tab 3: Canary Crawler State
  const [crawlerUrl, setCrawlerUrl] = useState('');
  const [isCrawling, setIsCrawling] = useState(false);
  const [crawlerResult, setCrawlerResult] = useState<CrawlScanResult | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Load configuration on mount
  useEffect(() => {
    isMountedRef.current = true;

    if (window.electron?.getAiConfig) {
      window.electron.getAiConfig().then((cfg) => {
        if (isMountedRef.current && cfg) setAiConfig(cfg);
      });
    }

    if (window.electron?.getSinkholeConfig) {
      window.electron.getSinkholeConfig().then((sinkhole) => {
        if (isMountedRef.current && sinkhole) {
          setSinkholeConfig(sinkhole);
          if (sinkhole.adguardHomeUrl) {
            setScoutService('adguard');
          } else if (sinkhole.piholeUrl) {
            setScoutService('pihole');
          }
        }
      });
    }

    return () => {
      isMountedRef.current = false;
      for (const t of timersRef.current) {
        clearTimeout(t);
      }
      timersRef.current = [];
    };
  }, []);

  const handleCopy = useCallback((text: string, key: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      if (isMountedRef.current) {
        setCopiedKey(key);
        safeSetTimeout(() => setCopiedKey(null), 2200);
      }
    }
  }, [safeSetTimeout]);

  // Save AI Config
  const handleSaveConfig = async () => {
    if (!window.electron?.setAiConfig) return;
    try {
      await window.electron.setAiConfig(aiConfig);
      setIsConfigOpen(false);
      setSuccessMessage?.('AI Radar provider settings saved.');
    } catch (err: any) {
      setError?.(`Failed to save settings: ${err?.message || err}`);
    }
  };

  // Test AI Connection
  const handleTestAiConnection = async () => {
    if (!window.electron?.testAiConnection) return;
    setIsTestingAi(true);
    setAiTestResult(null);
    try {
      const res = await window.electron.testAiConnection(aiConfig);
      if (isMountedRef.current) setAiTestResult(res);
    } catch (err: any) {
      if (isMountedRef.current) {
        setAiTestResult({
          success: false,
          message: err?.message || 'Connection test failed',
        });
      }
    } finally {
      if (isMountedRef.current) setIsTestingAi(false);
    }
  };

  // Run Sinkhole Query Scout
  const handleRunScout = async () => {
    if (!window.electron?.aiScanQueryLog) return;
    setIsScouting(true);
    setError?.(null);
    try {
      const res = await window.electron.aiScanQueryLog({ service: scoutService, limit: 60 });
      if (isMountedRef.current) {
        setScoutResult(res);
        if (res.flaggedCount === 0) {
          setSuccessMessage?.(`Analyzed ${res.totalQueriesAnalyzed} unblocked queries. All benign.`);
        } else {
          setSuccessMessage?.(`Flagged ${res.flaggedCount} suspicious ad/tracker domains out of ${res.totalQueriesAnalyzed} queries.`);
        }
      }
    } catch (err: any) {
      setError?.(`Query log scout failed: ${err?.message || err}`);
    } finally {
      if (isMountedRef.current) setIsScouting(false);
    }
  };

  // Add rules to custom rules
  const handleAddRulesToCustom = async (rules: string[], identifier: string) => {
    if (!window.electron?.addCustomRules || rules.length === 0) return;
    try {
      const res = await window.electron.addCustomRules(rules);
      if (res.success) {
        setBlockedItemsMap((prev) => new Set(prev).add(identifier));
        setSuccessMessage?.(`Added ${res.count} blocking rule(s) to Custom Rules.`);
      } else {
        setError?.(res.error || 'Failed to add custom rules');
      }
    } catch (err: any) {
      setError?.(`Failed to add custom rules: ${err?.message || err}`);
    }
  };

  // Batch block all flagged queries
  const handleBlockAllFlagged = async () => {
    if (!scoutResult) return;
    const allRules: string[] = [];
    const ids: string[] = [];
    for (const item of scoutResult.results) {
      if (item.verdict !== 'clean' && item.generatedRules.length > 0) {
        allRules.push(item.generatedRules[0]);
        ids.push(item.domain);
      }
    }
    if (allRules.length === 0) return;

    if (window.electron?.addCustomRules) {
      try {
        const res = await window.electron.addCustomRules(allRules);
        if (res.success) {
          setBlockedItemsMap((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.add(id);
            return next;
          });
          setSuccessMessage?.(`Successfully blocked and added ${res.count} rules to Custom Rules!`);
        }
      } catch (err: any) {
        setError?.(`Failed to block rules: ${err?.message || err}`);
      }
    }
  };

  // Run Domain Inspector
  const handleInspectDomain = async (overrideDomain?: string) => {
    const target = (overrideDomain || inspectorInput).trim();
    if (!target) return;
    if (overrideDomain) setInspectorInput(overrideDomain);

    if (!window.electron?.aiScanDomain) return;
    setIsInspecting(true);
    setInspectorResult(null);
    setError?.(null);
    try {
      const res = await window.electron.aiScanDomain(target);
      if (isMountedRef.current) setInspectorResult(res);
    } catch (err: any) {
      setError?.(`Domain inspection failed: ${err?.message || err}`);
    } finally {
      if (isMountedRef.current) setIsInspecting(false);
    }
  };

  // Run Canary Crawler
  const handleRunCrawler = async () => {
    const url = crawlerUrl.trim();
    if (!url) return;
    if (!window.electron?.aiCrawlUrl) return;
    setIsCrawling(true);
    setCrawlerResult(null);
    setError?.(null);
    try {
      const res = await window.electron.aiCrawlUrl(url);
      if (isMountedRef.current) setCrawlerResult(res);
    } catch (err: any) {
      setError?.(`Web crawl failed: ${err?.message || err}`);
    } finally {
      if (isMountedRef.current) setIsCrawling(false);
    }
  };

  return (
    <div className="ai-radar-container">
      {/* Hero Header Card */}
      <div className="ai-radar-hero">
        <div className="ai-radar-hero-left">
          <div className="ai-radar-badge">
            <span className="radar-sweep-icon" />
            <span>AI Radar Active</span>
          </div>
          <h2 className="ai-radar-title">AI Ad & Tracker Discovery Engine</h2>
          <p className="ai-radar-subtitle">
            Detect rapidly shifting ad servers, ephemeral bidding hostnames, CNAME cloaking, and zero-day trackers before they evade static filter lists.
          </p>
        </div>

        <div className="ai-radar-hero-right">
          <div className="ai-provider-pill" onClick={() => setIsConfigOpen(true)}>
            <span className="provider-status-dot" />
            <div className="provider-info-col">
              <span className="provider-label-small">Active Engine</span>
              <span className="provider-name">
                {aiConfig.provider === 'local-heuristics' && 'Offline Heuristics & Entropy (0ms)'}
                {aiConfig.provider === 'ollama' && `Ollama (${aiConfig.ollamaModel || 'llama3.2'})`}
                {aiConfig.provider === 'gemini' && 'Google Gemini 2.0 Flash'}
                {aiConfig.provider === 'openai' && 'OpenAI Model'}
              </span>
            </div>
            <button type="button" className="provider-settings-btn" title="Configure AI Provider">
              ⚙️
            </button>
          </div>
        </div>
      </div>

      {/* Mode Navigation Tabs */}
      <div className="ai-radar-nav-tabs">
        <button
          type="button"
          className={`radar-tab-btn ${activeTab === 'sinkhole-scout' ? 'active' : ''}`}
          onClick={() => setActiveTab('sinkhole-scout')}
        >
          <span className="tab-icon">📡</span>
          <span>Sinkhole Query Scout</span>
          {sinkholeConfig && (sinkholeConfig.adguardHomeUrl || sinkholeConfig.piholeUrl) && (
            <span className="tab-connected-pill">Homelab Linked</span>
          )}
        </button>

        <button
          type="button"
          className={`radar-tab-btn ${activeTab === 'domain-inspector' ? 'active' : ''}`}
          onClick={() => setActiveTab('domain-inspector')}
        >
          <span className="tab-icon">🔍</span>
          <span>Domain & Payload Inspector</span>
        </button>

        <button
          type="button"
          className={`radar-tab-btn ${activeTab === 'canary-crawler' ? 'active' : ''}`}
          onClick={() => setActiveTab('canary-crawler')}
        >
          <span className="tab-icon">🕷️</span>
          <span>Web Canary Crawler</span>
        </button>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: SINKHOLE QUERY SCOUT */}
      {/* ========================================================================= */}
      {activeTab === 'sinkhole-scout' && (
        <div className="radar-tab-content">
          <div className="radar-card">
            <div className="radar-card-header">
              <div>
                <h3 className="radar-card-title">Live Homelab Query Log Scout</h3>
                <p className="radar-card-desc">
                  Inspect unblocked DNS queries passing through your AdGuard Home or Pi-hole to identify stealthy ad exchanges and telemetry endpoints.
                </p>
              </div>

              <div className="scout-action-group">
                <div className="service-switch-pills">
                  <button
                    type="button"
                    className={`service-pill ${scoutService === 'adguard' ? 'active' : ''}`}
                    onClick={() => setScoutService('adguard')}
                  >
                    AdGuard Home
                  </button>
                  <button
                    type="button"
                    className={`service-pill ${scoutService === 'pihole' ? 'active' : ''}`}
                    onClick={() => setScoutService('pihole')}
                  >
                    Pi-hole
                  </button>
                </div>

                <button
                  type="button"
                  className="primary-button radar-scout-btn"
                  onClick={handleRunScout}
                  disabled={isScouting}
                >
                  {isScouting ? 'Scanning Queries...' : '🚀 Scout Live Queries'}
                </button>

                {onTriggerCompile && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={onTriggerCompile}
                    title="Trigger filter compilation (Cmd+R)"
                  >
                    ⚡ Compile
                  </button>
                )}
              </div>
            </div>

            {/* If no sinkhole configured */}
            {sinkholeConfig && !sinkholeConfig.adguardHomeUrl && !sinkholeConfig.piholeUrl && (
              <div className="radar-hint-box">
                <span className="hint-icon">💡</span>
                <div>
                  <strong>No sinkhole configured yet:</strong> Enter your AdGuard Home or Pi-hole details in the Deploy Hub to automatically scout your homelab DNS queries.
                  <button type="button" className="text-button-link" onClick={onNavigateDeploy}>
                    Open Deploy Hub ➔
                  </button>
                </div>
              </div>
            )}

            {/* Metrics summary bar */}
            {scoutResult && (
              <div className="scout-metrics-row">
                <div className="metric-box">
                  <span className="metric-num">{scoutResult.totalQueriesAnalyzed}</span>
                  <span className="metric-label">Queries Analyzed</span>
                </div>
                <div className="metric-box warning">
                  <span className="metric-num">{scoutResult.flaggedCount}</span>
                  <span className="metric-label">Flagged Ad/Trackers</span>
                </div>
                <div className="metric-box success">
                  <span className="metric-num">{scoutResult.cleanCount}</span>
                  <span className="metric-label">Clean Services</span>
                </div>
                {scoutResult.flaggedCount > 0 && (
                  <button
                    type="button"
                    className="primary-button block-all-flagged-btn"
                    onClick={handleBlockAllFlagged}
                  >
                    ★ Block All Flagged ({scoutResult.flaggedCount})
                  </button>
                )}
              </div>
            )}

            {/* Query Results List */}
            {scoutResult && (
              <div className="scout-results-list">
                {scoutResult.results
                  .filter((r) => r.verdict !== 'clean')
                  .map((item, idx) => {
                    const isBlocked = blockedItemsMap.has(item.domain);
                    return (
                      <div key={idx} className="scout-threat-card">
                        <div className="threat-header">
                          <div className="threat-title-col">
                            <div className="threat-domain-row">
                              <span className="threat-domain">{item.domain}</span>
                              <span className={`verdict-chip ${item.verdict}`}>
                                {item.verdict === 'ad_server' ? '🚨 AD SERVER' : '👁️ TRACKER'}
                              </span>
                              <span className="category-chip">{item.category}</span>
                            </div>
                            <div className="threat-entropy-row">
                              <span>Entropy: <strong>{item.entropy}</strong></span>
                              {item.cnames.length > 0 && (
                                <span className="cname-chain-pill">
                                  CNAME ➔ {item.cnames[item.cnames.length - 1]}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="threat-actions">
                            {isBlocked ? (
                              <span className="blocked-status-pill">✓ Blocked</span>
                            ) : (
                              <button
                                type="button"
                                className="secondary-button block-threat-btn"
                                onClick={() => handleAddRulesToCustom([item.generatedRules[0]], item.domain)}
                              >
                                ＋ Add Rule
                              </button>
                            )}
                            <button
                              type="button"
                              className="secondary-button copy-threat-btn"
                              onClick={() => handleCopy(item.generatedRules[0] || `||${item.domain}^`, `threat-${idx}`)}
                            >
                              {copiedKey === `threat-${idx}` ? '✓ Copied' : 'Copy'}
                            </button>
                          </div>
                        </div>

                        {/* Reasons */}
                        <div className="threat-reasons">
                          {item.reasons.map((r, rIdx) => (
                            <span key={rIdx} className="reason-pill">• {r}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}

                {scoutResult.flaggedCount === 0 && (
                  <div className="empty-state-card">
                    <span className="empty-icon">🛡️</span>
                    <h4>No Threatening Queries Detected</h4>
                    <p>All scanned unblocked queries from your recent query log appear safe and benign.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: DOMAIN & PAYLOAD INSPECTOR */}
      {/* ========================================================================= */}
      {activeTab === 'domain-inspector' && (
        <div className="radar-tab-content">
          <div className="radar-card">
            <h3 className="radar-card-title">Deep Domain & Payload Inspector</h3>
            <p className="radar-card-desc">
              Inspect any target hostname, programmatic ad bidder, or CNAME-cloaked tracking beacon to analyze Shannon entropy, DGA probability, and AI verdicts.
            </p>

            {/* Input Bar */}
            <div className="inspector-search-row">
              <input
                type="text"
                className="inspector-input"
                placeholder="Enter domain or URL (e.g. x7k9-trk.bidder.net or doubleclick.net)..."
                value={inspectorInput}
                onChange={(e) => setInspectorInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleInspectDomain();
                }}
              />
              <button
                type="button"
                className="primary-button inspect-action-btn"
                onClick={() => handleInspectDomain()}
                disabled={isInspecting || !inspectorInput.trim()}
              >
                {isInspecting ? 'Analyzing...' : '⚡ Inspect with AI'}
              </button>
            </div>

            {/* Quick Test Chips */}
            <div className="quick-test-row">
              <span className="quick-label">Try sample:</span>
              <button type="button" className="quick-chip" onClick={() => handleInspectDomain('x9a7b2-rtb-trk-49102.bidder.net')}>
                Dynamic RTB Ad Bidder
              </button>
              <button type="button" className="quick-chip" onClick={() => handleInspectDomain('doubleclick.net')}>
                Ad Exchange
              </button>
              <button type="button" className="quick-chip" onClick={() => handleInspectDomain('telemetry.analytics-pixel.org')}>
                Tracking Beacon
              </button>
              <button type="button" className="quick-chip" onClick={() => handleInspectDomain('wikipedia.org')}>
                Clean Domain
              </button>
            </div>

            {/* Inspection Results Box */}
            {inspectorResult && (
              <div className="inspector-result-panel">
                <div className={`verdict-banner ${inspectorResult.verdict}`}>
                  <div className="verdict-banner-left">
                    <span className="verdict-icon">
                      {inspectorResult.verdict === 'clean' ? '✅' : '🚨'}
                    </span>
                    <div>
                      <h4 className="verdict-title">
                        {inspectorResult.verdict.toUpperCase().replace('_', ' ')}
                      </h4>
                      <span className="verdict-subtitle">
                        Confidence: <strong>{inspectorResult.confidence}%</strong> | Risk Level: <strong>{inspectorResult.riskLevel.toUpperCase()}</strong>
                      </span>
                    </div>
                  </div>
                  <span className="verdict-category-tag">{inspectorResult.category}</span>
                </div>

                <div className="inspector-metrics-grid">
                  <div className="metric-card">
                    <span className="card-label">Shannon Entropy</span>
                    <span className="card-value">{inspectorResult.entropy}</span>
                    <span className="card-sub">{inspectorResult.entropy >= 3.6 ? 'High (Ad cluster)' : 'Normal distribution'}</span>
                  </div>
                  <div className="metric-card">
                    <span className="card-label">DGA Score</span>
                    <span className="card-value">{inspectorResult.isLikelyDga ? 'Detected' : 'Negative'}</span>
                    <span className="card-sub">{inspectorResult.isLikelyDga ? 'Randomized syntax' : 'Natural syntax'}</span>
                  </div>
                  <div className="metric-card">
                    <span className="card-label">CNAME Status</span>
                    <span className="card-value">{inspectorResult.cnames.length > 0 ? `${inspectorResult.cnames.length} Hops` : 'Direct'}</span>
                    <span className="card-sub">{inspectorResult.cnames.length > 0 ? 'External alias' : 'Direct DNS A-record'}</span>
                  </div>
                </div>

                {/* Evidence List */}
                <div className="evidence-section">
                  <h5>Analysis & Evidence Findings</h5>
                  <ul>
                    {inspectorResult.reasons.map((reason, idx) => (
                      <li key={idx}>{reason}</li>
                    ))}
                  </ul>
                </div>

                {/* Generated Rules */}
                {inspectorResult.generatedRules.length > 0 && (
                  <div className="generated-rules-section">
                    <div className="rules-section-header">
                      <h5>Recommended Rules (ABP / AdGuard / Hosts)</h5>
                      <div className="rules-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleCopy(inspectorResult.generatedRules.join('\n'), 'inspector-rules')}
                        >
                          {copiedKey === 'inspector-rules' ? '✓ Copied' : 'Copy All Rules'}
                        </button>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => handleAddRulesToCustom(inspectorResult.generatedRules, inspectorResult.domain)}
                        >
                          ＋ Add to Custom Rules
                        </button>
                      </div>
                    </div>
                    <div className="rules-code-block">
                      {inspectorResult.generatedRules.map((rule, idx) => (
                        <div key={idx} className="rule-code-line">{rule}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: WEB CANARY CRAWLER */}
      {/* ========================================================================= */}
      {activeTab === 'canary-crawler' && (
        <div className="radar-tab-content">
          <div className="radar-card">
            <h3 className="radar-card-title">Web Canary Page Crawler</h3>
            <p className="radar-card-desc">
              Scan any web page to discover hidden third-party script beacons, ad iframe origins, and real-time programmatic bidding partners.
            </p>

            <div className="inspector-search-row">
              <input
                type="text"
                className="inspector-input"
                placeholder="Enter URL to crawl (e.g. https://example-news-site.com)..."
                value={crawlerUrl}
                onChange={(e) => setCrawlerUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRunCrawler();
                }}
              />
              <button
                type="button"
                className="primary-button inspect-action-btn"
                onClick={handleRunCrawler}
                disabled={isCrawling || !crawlerUrl.trim()}
              >
                {isCrawling ? 'Crawling Page...' : '🕷️ Crawl & Discover'}
              </button>
            </div>

            {/* Crawler results */}
            {crawlerResult && (
              <div className="crawler-results-panel">
                <div className="crawler-stats-row">
                  <div className="metric-box">
                    <span className="metric-num">{crawlerResult.extractedHosts.length}</span>
                    <span className="metric-label">Discovered External Origins</span>
                  </div>
                  <div className="metric-box warning">
                    <span className="metric-num">{crawlerResult.flaggedHosts.length}</span>
                    <span className="metric-label">Flagged Ad Tech Hosts</span>
                  </div>
                  <div className="metric-box success">
                    <span className="metric-num">{crawlerResult.synthesizedRules.length}</span>
                    <span className="metric-label">Synthesized Rules</span>
                  </div>
                </div>

                {crawlerResult.flaggedHosts.length > 0 && (
                  <div className="crawler-flagged-section">
                    <div className="rules-section-header">
                      <h5>Flagged Ad Tech Hosts on Page</h5>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => handleAddRulesToCustom(crawlerResult.synthesizedRules, 'crawler-batch')}
                      >
                        ＋ Add All {crawlerResult.synthesizedRules.length} Rules to Custom Rules
                      </button>
                    </div>

                    <div className="flagged-hosts-grid">
                      {crawlerResult.flaggedHosts.map((host, idx) => (
                        <div key={idx} className="flagged-host-item">
                          <div className="host-title-row">
                            <span className="host-domain">{host.domain}</span>
                            <span className={`verdict-chip ${host.verdict}`}>
                              {host.verdict === 'ad_server' ? 'AD SERVER' : 'TRACKER'}
                            </span>
                          </div>
                          <span className="host-category">{host.category} | Confidence: {host.confidence}%</span>
                          {host.generatedRules.length > 0 && (
                            <code className="host-rule-code">{host.generatedRules[0]}</code>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {crawlerResult.flaggedHosts.length === 0 && (
                  <div className="empty-state-card">
                    <span className="empty-icon">✓</span>
                    <h4>No Third-Party Ad Tech Detected</h4>
                    <p>No overt tracking or ad server hostnames were identified on this page.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* AI PROVIDER SETTINGS MODAL */}
      {/* ========================================================================= */}
      {isConfigOpen && (
        <div className="ai-modal-backdrop" onClick={() => setIsConfigOpen(false)}>
          <div className="ai-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="ai-modal-header">
              <h3>AI Radar Engine Settings</h3>
              <button type="button" className="close-modal-btn" onClick={() => setIsConfigOpen(false)}>✕</button>
            </div>

            <div className="ai-modal-body">
              <label className="input-field-label">AI Engine Provider</label>
              <div className="provider-select-row">
                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'local-heuristics' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'local-heuristics' })}
                >
                  <span className="opt-title">⚡ Offline Heuristics</span>
                  <span className="opt-desc">Shannon entropy, DGA detection & CNAME uncloaking. 0ms latency, zero API keys.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'ollama' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'ollama' })}
                >
                  <span className="opt-title">🤖 Local Ollama</span>
                  <span className="opt-desc">100% private local LLM (llama3.2, mistral, qwen). Zero data leaves your Mac.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'gemini' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'gemini' })}
                >
                  <span className="opt-title">✨ Google Gemini</span>
                  <span className="opt-desc">Ultra-fast Gemini 2.0 Flash reasoning via API key.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'openai' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'openai' })}
                >
                  <span className="opt-title">🌐 OpenAI / Compatible</span>
                  <span className="opt-desc">OpenAI, Groq, or local OpenAI-compatible server.</span>
                </button>
              </div>

              {/* Ollama options */}
              {aiConfig.provider === 'ollama' && (
                <div className="provider-sub-form">
                  <div className="input-group">
                    <label className="input-field-label">Ollama Host URL</label>
                    <input
                      type="text"
                      className="text-input"
                      value={aiConfig.ollamaUrl || 'http://127.0.0.1:11434'}
                      onChange={(e) => setAiConfig({ ...aiConfig, ollamaUrl: e.target.value })}
                      placeholder="http://127.0.0.1:11434"
                    />
                  </div>
                  <div className="input-group">
                    <label className="input-field-label">Model Name</label>
                    <input
                      type="text"
                      className="text-input"
                      value={aiConfig.ollamaModel || 'llama3.2'}
                      onChange={(e) => setAiConfig({ ...aiConfig, ollamaModel: e.target.value })}
                      placeholder="llama3.2"
                    />
                  </div>
                </div>
              )}

              {/* Gemini options */}
              {aiConfig.provider === 'gemini' && (
                <div className="provider-sub-form">
                  <div className="input-group">
                    <label className="input-field-label">Google Gemini API Key</label>
                    <input
                      type="password"
                      className="text-input"
                      value={aiConfig.apiKey || ''}
                      onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
                      placeholder="AIzaSy..."
                    />
                  </div>
                </div>
              )}

              {/* OpenAI options */}
              {aiConfig.provider === 'openai' && (
                <div className="provider-sub-form">
                  <div className="input-group">
                    <label className="input-field-label">API Endpoint URL</label>
                    <input
                      type="text"
                      className="text-input"
                      value={aiConfig.apiEndpoint || 'https://api.openai.com/v1'}
                      onChange={(e) => setAiConfig({ ...aiConfig, apiEndpoint: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div className="input-group">
                    <label className="input-field-label">API Key</label>
                    <input
                      type="password"
                      className="text-input"
                      value={aiConfig.apiKey || ''}
                      onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
                      placeholder="sk-..."
                    />
                  </div>
                </div>
              )}

              {/* Test Result Box */}
              {aiTestResult && (
                <div className={`ai-test-badge ${aiTestResult.success ? 'success' : 'error'}`}>
                  <span>{aiTestResult.success ? '✓' : '⚠️'}</span>
                  <span>{aiTestResult.message} {aiTestResult.latencyMs ? `(${aiTestResult.latencyMs}ms)` : ''}</span>
                </div>
              )}
            </div>

            <div className="ai-modal-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={handleTestAiConnection}
                disabled={isTestingAi}
              >
                {isTestingAi ? 'Testing...' : '⚡ Test Connection'}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={handleSaveConfig}
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
