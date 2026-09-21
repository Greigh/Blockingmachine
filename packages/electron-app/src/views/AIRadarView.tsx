import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  AiProviderConfig,
  AiScanResult,
  QueryLogScanResult,
  CrawlScanResult,
  SinkholeConfig,
  ThreatQuarantineItem,
  AiWatchdogConfig,
} from '../types/';

interface AIRadarViewProps {
  onTriggerCompile?: () => void;
  onNavigateDeploy?: () => void;
  setError?: (msg: string | null) => void;
  setSuccessMessage?: (msg: string | null) => void;
}

type RadarTab = 'sinkhole-scout' | 'domain-inspector' | 'canary-crawler' | 'quarantine-history';

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
    provider: 'mini-ai',
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

  // Watchdog state
  const [watchdogConfig, setWatchdogConfig] = useState<AiWatchdogConfig>({
    enabled: false,
    intervalMinutes: 60,
    service: 'adguard',
  });

  // Tab 2: Domain Inspector State
  const [inspectorInput, setInspectorInput] = useState('');
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectorResult, setInspectorResult] = useState<AiScanResult | null>(null);

  // Tab 3: Canary Crawler State
  const [crawlerUrl, setCrawlerUrl] = useState('');
  const [isCrawling, setIsCrawling] = useState(false);
  const [crawlerResult, setCrawlerResult] = useState<CrawlScanResult | null>(null);

  // Tab 4: Quarantine & History State
  const [quarantineList, setQuarantineList] = useState<ThreatQuarantineItem[]>([]);
  const [quarantineFilter, setQuarantineFilter] = useState<string>('all');
  const [quarantineSearch, setQuarantineSearch] = useState<string>('');

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [targetSyntax, setTargetSyntax] = useState<'all' | 'adguard' | 'pihole' | 'ublock' | 'unbound' | 'hosts'>('all');
  const [customSynthesizedRules, setCustomSynthesizedRules] = useState<string[] | null>(null);
  const [learnedFeedbackCount, setLearnedFeedbackCount] = useState<number>(0);
  const [compactionSummary, setCompactionSummary] = useState<any>(null);

  const loadFeedbackStats = useCallback(async () => {
    if (window.electron?.getMiniAiFeedbackStats) {
      try {
        const stats = await window.electron.getMiniAiFeedbackStats();
        if (isMountedRef.current && stats) setLearnedFeedbackCount(stats.count);
      } catch (err) {
        console.error('Failed to load feedback stats:', err);
      }
    }
  }, []);

  const loadQuarantine = useCallback(async () => {
    if (window.electron?.getThreatQuarantine) {
      try {
        const items = await window.electron.getThreatQuarantine();
        if (isMountedRef.current && items) setQuarantineList(items);
      } catch (err) {
        console.error('Failed to load quarantine ledger:', err);
      }
    }
  }, []);

  const loadWatchdog = useCallback(async () => {
    if (window.electron?.getAiWatchdogConfig) {
      try {
        const cfg = await window.electron.getAiWatchdogConfig();
        if (isMountedRef.current && cfg) setWatchdogConfig(cfg);
      } catch (err) {
        console.error('Failed to load AI Watchdog config:', err);
      }
    }
  }, []);

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

    loadQuarantine();
    loadWatchdog();
    loadFeedbackStats();

    return () => {
      isMountedRef.current = false;
      for (const t of timersRef.current) {
        clearTimeout(t);
      }
      timersRef.current = [];
    };
  }, [loadQuarantine, loadWatchdog, loadFeedbackStats]);

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

  // Toggle Watchdog
  const handleToggleWatchdog = async (enabled: boolean) => {
    const updated = { ...watchdogConfig, enabled };
    setWatchdogConfig(updated);
    if (window.electron?.setAiWatchdogConfig) {
      await window.electron.setAiWatchdogConfig(updated);
      setSuccessMessage?.(`AI Sentinel Watchdog ${enabled ? 'enabled' : 'disabled'}.`);
    }
  };

  const handleChangeWatchdogInterval = async (intervalMinutes: number) => {
    const updated = { ...watchdogConfig, intervalMinutes };
    setWatchdogConfig(updated);
    if (window.electron?.setAiWatchdogConfig) {
      await window.electron.setAiWatchdogConfig(updated);
      setSuccessMessage?.(`Watchdog scout interval set to ${intervalMinutes} minutes.`);
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

        // Auto-quarantine newly flagged domains
        if (res.flaggedCount > 0 && window.electron?.addThreatQuarantine) {
          const newThreats: ThreatQuarantineItem[] = res.results
            .filter((r) => r.verdict !== 'clean')
            .map((r) => ({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              domain: r.domain,
              category: r.category,
              verdict: r.verdict,
              riskLevel: r.riskLevel,
              confidence: r.confidence,
              reasons: r.reasons,
              generatedRules: r.generatedRules,
              source: 'sinkhole',
              timestamp: new Date().toISOString(),
              blocked: false,
            }));
          window.electron.addThreatQuarantine(newThreats).then(() => {
            loadQuarantine();
          });
        }

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
        if (identifier && window.electron?.tuneMiniAiFeedback) {
          window.electron.tuneMiniAiFeedback(identifier, 'block');
        }
        setSuccessMessage?.(`Added ${res.count} blocking rule(s) to Custom Rules.`);
        loadQuarantine();
        loadFeedbackStats();
      } else {
        setError?.(res.error || 'Failed to add custom rules');
      }
    } catch (err: any) {
      setError?.(`Failed to add custom rules: ${err?.message || err}`);
    }
  };

  // Whitelist False Positive Domain
  const handleWhitelistDomain = async (domain: string) => {
    if (!window.electron?.addCustomAllowlist) return;
    try {
      const res = await window.electron.addCustomAllowlist(domain);
      if (res.success) {
        if (window.electron?.tuneMiniAiFeedback) {
          window.electron.tuneMiniAiFeedback(domain, 'whitelist');
        }
        setSuccessMessage?.(`Whitelisted ${domain} (${res.rule}). Added exception rule to Custom Rules.`);
        loadQuarantine();
        loadFeedbackStats();
      } else {
        setError?.(res.error || 'Failed to whitelist domain');
      }
    } catch (err: any) {
      setError?.(`Failed to whitelist domain: ${err?.message || err}`);
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
          loadQuarantine();
        }
      } catch (err: any) {
        setError?.(`Failed to block rules: ${err?.message || err}`);
      }
    }
  };

  // Target syntax selector change
  const handleTargetSyntaxChange = async (target: 'all' | 'adguard' | 'pihole' | 'ublock' | 'unbound' | 'hosts') => {
    setTargetSyntax(target);
    if (!inspectorResult || !window.electron?.synthesizeCustomRules) return;
    try {
      const res = await window.electron.synthesizeCustomRules({
        domain: inspectorResult.domain,
        verdict: inspectorResult.verdict,
        category: inspectorResult.category,
        cnames: inspectorResult.cnames,
        target,
        confidence: inspectorResult.confidence,
      });
      if (res.success && isMountedRef.current) {
        setCustomSynthesizedRules(res.rules);
      }
    } catch (err) {
      console.error('Failed to synthesize custom target rules:', err);
    }
  };

  // Compute Subdomain Compaction when scoutResult updates
  useEffect(() => {
    if (scoutResult && scoutResult.results.length > 0 && window.electron?.compactSubdomainRules) {
      const flagged = scoutResult.results.filter((r) => r.verdict !== 'clean').map((r) => r.domain);
      if (flagged.length >= 3) {
        window.electron.compactSubdomainRules(flagged, 3).then((res) => {
          if (isMountedRef.current) setCompactionSummary(res);
        }).catch(console.error);
      } else {
        setCompactionSummary(null);
      }
    } else {
      setCompactionSummary(null);
    }
  }, [scoutResult]);

  // Run Domain Inspector
  const handleInspectDomain = async (overrideDomain?: string) => {
    const target = (overrideDomain || inspectorInput).trim();
    if (!target) return;
    if (overrideDomain) setInspectorInput(overrideDomain);

    if (!window.electron?.aiScanDomain) return;
    setIsInspecting(true);
    setInspectorResult(null);
    setCustomSynthesizedRules(null);
    setTargetSyntax('all');
    setError?.(null);
    try {
      const res = await window.electron.aiScanDomain(target);
      if (isMountedRef.current) {
        if (window.electron?.isDomainCoveredByRules) {
          const coverage = await window.electron.isDomainCoveredByRules(res.domain);
          if (coverage.isCovered) {
            res.coveredByRule = coverage.coveringRule;
          }
        }
        setInspectorResult(res);

        if (res.verdict !== 'clean' && window.electron?.addThreatQuarantine) {
          const item: ThreatQuarantineItem = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            domain: res.domain,
            category: res.category,
            verdict: res.verdict,
            riskLevel: res.riskLevel,
            confidence: res.confidence,
            reasons: res.reasons,
            generatedRules: res.generatedRules,
            source: 'inspector',
            timestamp: new Date().toISOString(),
            blocked: false,
          };
          window.electron.addThreatQuarantine([item]).then(() => loadQuarantine());
        }
      }
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
      if (isMountedRef.current) {
        setCrawlerResult(res);

        if (res.flaggedHosts.length > 0 && window.electron?.addThreatQuarantine) {
          const items: ThreatQuarantineItem[] = res.flaggedHosts.map((r) => ({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            domain: r.domain,
            category: r.category,
            verdict: r.verdict,
            riskLevel: r.riskLevel,
            confidence: r.confidence,
            reasons: r.reasons,
            generatedRules: r.generatedRules,
            source: 'crawler',
            timestamp: new Date().toISOString(),
            blocked: false,
          }));
          window.electron.addThreatQuarantine(items).then(() => loadQuarantine());
        }
      }
    } catch (err: any) {
      setError?.(`Web crawl failed: ${err?.message || err}`);
    } finally {
      if (isMountedRef.current) setIsCrawling(false);
    }
  };

  // Remove single quarantine item
  const handleRemoveQuarantineItem = async (id: string) => {
    if (window.electron?.removeThreatQuarantineItem) {
      await window.electron.removeThreatQuarantineItem(id);
      loadQuarantine();
    }
  };

  // Clear all quarantine
  const handleClearQuarantineLedger = async () => {
    if (window.electron?.clearThreatQuarantine) {
      await window.electron.clearThreatQuarantine();
      loadQuarantine();
      setSuccessMessage?.('Threat Quarantine ledger cleared.');
    }
  };

  // Export Quarantine
  const handleExportQuarantine = (format: 'abp' | 'hosts' | 'json') => {
    if (quarantineList.length === 0) return;
    let text = '';
    let mime = 'text/plain';
    let filename = `bm-quarantine-${Date.now()}`;
    if (format === 'abp') {
      text = `! Blockingmachine AI Threat Quarantine Export [Beta]\n! Exported: ${new Date().toISOString()}\n! Total: ${quarantineList.length}\n\n` +
        quarantineList.map((i) => (i.generatedRules[0] || `||${i.domain}^`)).join('\n');
      filename += '.txt';
    } else if (format === 'hosts') {
      text = `# Blockingmachine AI Threat Quarantine Export [Beta]\n# Exported: ${new Date().toISOString()}\n\n` +
        quarantineList.map((i) => `0.0.0.0 ${i.domain}`).join('\n');
      filename += '.txt';
    } else {
      text = JSON.stringify(quarantineList, null, 2);
      mime = 'application/json';
      filename += '.json';
    }
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setSuccessMessage?.(`Exported ${quarantineList.length} threat records in ${format.toUpperCase()} format.`);
  };

  // Filtered quarantine items
  const filteredQuarantine = quarantineList.filter((item) => {
    if (quarantineFilter !== 'all' && item.category.toLowerCase() !== quarantineFilter.toLowerCase()) {
      return false;
    }
    if (quarantineSearch.trim()) {
      const q = quarantineSearch.trim().toLowerCase();
      return item.domain.toLowerCase().includes(q) || item.category.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="ai-radar-container">
      {/* Hero Header Card */}
      <div className="ai-radar-hero">
        <div className="ai-radar-hero-left">
          <div className="ai-radar-badge">
            <span className="radar-sweep-icon" />
            <span>AI Radar Active</span>
            <span className="ai-beta-tag">BETA</span>
          </div>
          <h2 className="ai-radar-title">
            AI Ad & Tracker Discovery Engine <span className="title-beta-pill">Beta</span>
          </h2>
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
                {aiConfig.provider === 'mini-ai' && '🧠 Mini-AI Classifier (<0.05ms)'}
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

        <button
          type="button"
          className={`radar-tab-btn ${activeTab === 'quarantine-history' ? 'active' : ''}`}
          onClick={() => setActiveTab('quarantine-history')}
        >
          <span className="tab-icon">🛡️</span>
          <span>Threat Quarantine Ledger</span>
          {quarantineList.length > 0 && (
            <span className="tab-count-badge">{quarantineList.length}</span>
          )}
        </button>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: SINKHOLE QUERY SCOUT */}
      {/* ========================================================================= */}
      {activeTab === 'sinkhole-scout' && (
        <div className="radar-tab-content">
          {/* AI Sentinel Watchdog Card */}
          <div className="watchdog-banner-card">
            <div className="watchdog-info">
              <div className="watchdog-title-row">
                <span>🤖 AI Sentinel Watchdog [Beta]</span>
                <span className={`provider-status-dot ${watchdogConfig.enabled ? 'active' : ''}`} />
              </div>
              <p className="watchdog-desc">
                Automatically scouts unblocked queries from your homelab sinkhole in the background and quarantines newly discovered ad exchanges without interrupting your workflow.
                {watchdogConfig.lastRun && (
                  <span style={{ marginLeft: 6, color: 'var(--primary-color)' }}>
                    (Last ran: {new Date(watchdogConfig.lastRun).toLocaleTimeString()})
                  </span>
                )}
              </p>
            </div>

            <div className="watchdog-controls">
              <select
                className="watchdog-select"
                value={watchdogConfig.intervalMinutes || 60}
                onChange={(e) => handleChangeWatchdogInterval(parseInt(e.target.value, 10))}
              >
                <option value={60}>Every 1 Hour</option>
                <option value={360}>Every 6 Hours</option>
                <option value={1440}>Every 24 Hours</option>
              </select>

              <button
                type="button"
                className={`watchdog-toggle-btn ${watchdogConfig.enabled ? 'active' : ''}`}
                onClick={() => handleToggleWatchdog(!watchdogConfig.enabled)}
              >
                {watchdogConfig.enabled ? '✓ Watchdog Active' : 'Enable Watchdog'}
              </button>
            </div>
          </div>

          <div className="radar-card">
            <div className="radar-card-header">
              <div>
                <h3 className="radar-card-title">Live Homelab Query Log Scout [Beta]</h3>
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

            {/* Subdomain Compaction Notice Banner */}
            {compactionSummary && compactionSummary.savingsPercent > 0 && (
              <div style={{
                margin: '12px 0',
                padding: '12px 16px',
                borderRadius: 8,
                background: 'rgba(99, 102, 241, 0.08)',
                border: '1px solid rgba(99, 102, 241, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
              }}>
                <div style={{ fontSize: 13, color: 'var(--text-color)' }}>
                  <span style={{ fontWeight: 600, color: '#6366f1' }}>⚡ Subdomain Wildcard Compaction:</span> Collapsed {compactionSummary.originalCount} subdomains into {compactionSummary.compactedCount} parent zone rules ({compactionSummary.savingsPercent}% list bloat reduction).
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                    Zones: {compactionSummary.collapsedGroups.map((g: any) => g.parentDomain).join(', ')}
                  </div>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  style={{ fontSize: 12, padding: '6px 12px', fontWeight: 600 }}
                  onClick={() => handleAddRulesToCustom(compactionSummary.compactedRules, 'compacted-subdomains')}
                >
                  ＋ Add Compacted Rules ({compactionSummary.compactedCount})
                </button>
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
                              className="secondary-button whitelist-threat-btn"
                              onClick={() => handleWhitelistDomain(item.domain)}
                              title="Report as false positive and add whitelist rule (@@||...)"
                            >
                              ⚪ Whitelist
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => handleCopy(item.generatedRules[0] || `||${item.domain}^`, `scout-${idx}`)}
                            >
                              {copiedKey === `scout-${idx}` ? '✓ Copied' : '📋 Copy'}
                            </button>
                          </div>
                        </div>

                        <div className="threat-reasons">
                          {item.reasons.map((r, rIdx) => (
                            <span key={rIdx} className="reason-pill">• {r}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
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
            <h3 className="radar-card-title">Real-Time Domain & Payload Inspector [Beta]</h3>
            <p className="radar-card-desc">
              Execute deep heuristic scoring, CNAME uncloaking, Shannon entropy measurements, and LLM reasoning against any suspect domain.
            </p>

            <div className="inspector-search-row">
              <input
                type="text"
                className="inspector-input"
                placeholder="Enter domain or hostname (e.g. adservice.google.com, bidder-rtb.example.net)..."
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
              <button type="button" className="quick-chip" onClick={() => handleInspectDomain('cdnjs.cloudflare.com')}>
                Protected CDN (False Positive Guard)
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

                {/* Domain Decomposition Widget */}
                {inspectorResult.decomposition && (
                  <div className="decomposition-widget">
                    <div className="decomp-label">Domain Label Breakdown & Entropy Analysis:</div>
                    <div className="decomp-pills-row">
                      {inspectorResult.decomposition.labelEntropies.map((le, idx) => (
                        <span
                          key={idx}
                          className={`decomp-pill ${le.isSuspicious ? 'suspicious' : 'normal'}`}
                          title={`Label: ${le.label} | Shannon Entropy: ${le.entropy}`}
                        >
                          <span className="decomp-sub-name">{le.label}</span>
                          <span className="decomp-entropy-tag">H: {le.entropy}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* CNAME Chain visualizer */}
                {inspectorResult.cnames.length > 0 && (
                  <div className="evidence-section" style={{ marginTop: 12 }}>
                    <h5>CNAME Uncloaking Chain Trace</h5>
                    <p style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--primary-color)', fontSize: 13 }}>
                      {inspectorResult.domain} ➔ {inspectorResult.cnames.join(' ➔ ')}
                    </p>
                  </div>
                )}

                {/* Evidence List */}
                <div className="evidence-section">
                  <h5>Analysis & Evidence Findings</h5>
                  <ul>
                    {inspectorResult.reasons.map((reason, idx) => (
                      <li key={idx}>{reason}</li>
                    ))}
                  </ul>
                </div>

                {/* Mini-AI Performance & Feature Insights */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginTop: 12,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(59, 130, 246, 0.08)',
                  border: '1px solid rgba(59, 130, 246, 0.2)',
                  fontSize: 12,
                  flexWrap: 'wrap'
                }}>
                  <span style={{ fontWeight: 600, color: 'var(--primary-color)' }}>
                    ⚡ Inference Latency: {inspectorResult.inferenceTimeMs !== undefined ? `${inspectorResult.inferenceTimeMs}ms` : '< 0.05ms'}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>•</span>
                  <span>Engine: {inspectorResult.modelUsed || 'Mini-AI Embedded Classifier'}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>•</span>
                  <span>Entropy Index: {inspectorResult.entropy.toFixed(2)}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>•</span>
                  <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                    🧠 Learned Domains: {learnedFeedbackCount} saved to disk
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#10b981', fontWeight: 600 }}>
                    100% In-Memory Air-Gapped
                  </span>
                </div>

                {/* Generated Rules */}
                <div className="generated-rules-section">
                  <div className="rules-section-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-color)' }}>Synthesized Filter Rules</span>
                      <div style={{ display: 'inline-flex', gap: 4, background: 'rgba(0,0,0,0.15)', padding: '2px 4px', borderRadius: 6 }}>
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
                              background: targetSyntax === fmt ? 'var(--primary-color)' : 'transparent',
                              color: targetSyntax === fmt ? '#fff' : 'var(--text-secondary)',
                              fontWeight: targetSyntax === fmt ? 600 : 400,
                            }}
                            onClick={() => handleTargetSyntaxChange(fmt)}
                          >
                            {fmt === 'all' ? 'Universal' : fmt.toUpperCase()}
                          </button>
                        ))}
                      </div>
                      {inspectorResult.coveredByRule && (
                        <span
                          style={{
                            fontSize: 11,
                            padding: '3px 8px',
                            borderRadius: 6,
                            background: 'rgba(16, 185, 129, 0.15)',
                            color: '#10b981',
                            border: '1px solid rgba(16, 185, 129, 0.3)',
                            fontWeight: 600,
                          }}
                        >
                          ✓ Already Covered ({inspectorResult.coveredByRule})
                        </span>
                      )}
                    </div>
                    <div className="rules-actions">
                      <button
                        type="button"
                        className="secondary-button whitelist-threat-btn"
                        onClick={() => handleWhitelistDomain(inspectorResult.domain)}
                      >
                        ⚪ Whitelist (False Positive)
                      </button>
                      {(customSynthesizedRules !== null ? customSynthesizedRules : inspectorResult.generatedRules).length > 0 && (
                        <>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => handleCopy((customSynthesizedRules !== null ? customSynthesizedRules : inspectorResult.generatedRules).join('\n'), 'inspector-rules')}
                          >
                            {copiedKey === 'inspector-rules' ? '✓ Copied' : 'Copy All Rules'}
                          </button>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={blockedItemsMap.has(inspectorResult.domain) || Boolean(inspectorResult.coveredByRule)}
                            onClick={() => handleAddRulesToCustom(customSynthesizedRules !== null ? customSynthesizedRules : inspectorResult.generatedRules, inspectorResult.domain)}
                          >
                            {inspectorResult.coveredByRule ? '✓ Covered in Rules' : blockedItemsMap.has(inspectorResult.domain) ? '✓ In Custom Rules' : '＋ Add to Custom Rules'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {(customSynthesizedRules !== null ? customSynthesizedRules : inspectorResult.generatedRules).length > 0 ? (
                    <div className="rules-code-block">
                      {(customSynthesizedRules !== null ? customSynthesizedRules : inspectorResult.generatedRules).map((rule, idx) => (
                        <div key={idx} className="rule-code-line">{rule}</div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ color: 'var(--secondary-color)', fontSize: 12, margin: '8px 0 0 0' }}>
                      Verified clean domain. No blocking rules synthesized.
                    </p>
                  )}
                </div>
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
            <h3 className="radar-card-title">Web Canary Page Crawler [Beta]</h3>
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
                    <span className="metric-label">Extracted Origins</span>
                  </div>
                  <div className="metric-box warning">
                    <span className="metric-num">{crawlerResult.flaggedHosts.length}</span>
                    <span className="metric-label">Flagged Ad/Trackers</span>
                  </div>
                  {crawlerResult.synthesizedRules.length > 0 && (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => handleAddRulesToCustom(crawlerResult.synthesizedRules, 'crawler-all')}
                    >
                      ★ Block All Discovered ({crawlerResult.synthesizedRules.length})
                    </button>
                  )}
                </div>

                <div className="crawler-flagged-list">
                  {crawlerResult.flaggedHosts.map((host, idx) => (
                    <div key={idx} className="scout-threat-card">
                      <div className="threat-header">
                        <div className="threat-title-col">
                          <div className="threat-domain-row">
                            <span className="threat-domain">{host.domain}</span>
                            <span className={`verdict-chip ${host.verdict}`}>
                              {host.verdict === 'ad_server' ? '🚨 AD SERVER' : '👁️ TRACKER'}
                            </span>
                            <span className="category-chip">{host.category}</span>
                          </div>
                        </div>

                        <div className="threat-actions">
                          <button
                            type="button"
                            className="secondary-button block-threat-btn"
                            onClick={() => handleAddRulesToCustom([host.generatedRules[0]], host.domain)}
                          >
                            ＋ Add Rule
                          </button>
                          <button
                            type="button"
                            className="secondary-button whitelist-threat-btn"
                            onClick={() => handleWhitelistDomain(host.domain)}
                          >
                            ⚪ Whitelist
                          </button>
                        </div>
                      </div>
                      <div className="threat-reasons">
                        {host.reasons.map((r, rIdx) => (
                          <span key={rIdx} className="reason-pill">• {r}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: THREAT QUARANTINE LEDGER */}
      {/* ========================================================================= */}
      {activeTab === 'quarantine-history' && (
        <div className="radar-tab-content">
          <div className="radar-card">
            <div className="radar-card-header">
              <div>
                <h3 className="radar-card-title">Discovered Threat Quarantine Ledger [Beta]</h3>
                <p className="radar-card-desc">
                  Persistent record of all anomalous ad networks, programmatic bidders, and stealth trackers intercepted across Sinkhole Scout, Watchdog, Inspector, and Crawler.
                </p>
              </div>

              <div className="scout-action-group">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => handleExportQuarantine('abp')}
                  disabled={quarantineList.length === 0}
                >
                  📥 Export ABP List
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => handleExportQuarantine('hosts')}
                  disabled={quarantineList.length === 0}
                >
                  📥 Export Hosts
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleClearQuarantineLedger}
                  disabled={quarantineList.length === 0}
                >
                  🗑️ Clear Ledger
                </button>
              </div>
            </div>

            {/* Toolbar */}
            <div className="quarantine-toolbar">
              <div className="quarantine-filters">
                {['all', 'advertising', 'telemetry/analytics', 'cname cloaking'].map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={`service-pill ${quarantineFilter === cat ? 'active' : ''}`}
                    onClick={() => setQuarantineFilter(cat)}
                  >
                    {cat.toUpperCase()}
                  </button>
                ))}
              </div>

              <input
                type="text"
                className="quarantine-search-input"
                placeholder="Search quarantined domains..."
                value={quarantineSearch}
                onChange={(e) => setQuarantineSearch(e.target.value)}
              />
            </div>

            {filteredQuarantine.length === 0 ? (
              <div className="radar-hint-box" style={{ marginTop: 20 }}>
                <span className="hint-icon">🛡️</span>
                <div>
                  <strong>Quarantine Ledger is clean:</strong>
                  {' '}No threats matching your current filter. Run a Sinkhole Query Scout or enable the background Sentinel Watchdog to populate discovered ad domains automatically.
                </div>
              </div>
            ) : (
              <div className="quarantine-table-wrap">
                <table className="quarantine-table">
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th>Category</th>
                      <th>Verdict</th>
                      <th>Source</th>
                      <th>Timestamp</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredQuarantine.map((item) => (
                      <tr key={item.id}>
                        <td className="quarantine-domain-cell">{item.domain}</td>
                        <td>
                          <span className="category-chip">{item.category}</span>
                        </td>
                        <td>
                          <span className={`verdict-chip ${item.verdict}`}>
                            {item.verdict.toUpperCase().replace('_', ' ')}
                          </span>
                        </td>
                        <td>
                          <span className={`quarantine-source-badge ${item.source}`}>
                            {item.source}
                          </span>
                        </td>
                        <td className="quarantine-date-cell">
                          {new Date(item.timestamp).toLocaleString()}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div className="threat-actions" style={{ justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              className="secondary-button block-threat-btn"
                              onClick={() => handleAddRulesToCustom(item.generatedRules, item.domain)}
                            >
                              ＋ Block
                            </button>
                            <button
                              type="button"
                              className="secondary-button whitelist-threat-btn"
                              onClick={() => handleWhitelistDomain(item.domain)}
                            >
                              ⚪ Whitelist
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              style={{ padding: '4px 8px', fontSize: 11 }}
                              onClick={() => handleRemoveQuarantineItem(item.id)}
                              title="Remove from quarantine"
                            >
                              ✕
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* PROVIDER CONFIGURATION MODAL */}
      {/* ========================================================================= */}
      {isConfigOpen && (
        <div className="ai-modal-overlay" onClick={() => setIsConfigOpen(false)}>
          <div className="ai-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="ai-modal-header">
              <div className="ai-modal-title-col">
                <h4 className="ai-modal-title">AI Radar Provider Configuration [Beta]</h4>
                <p className="ai-modal-desc">
                  Select your discovery engine. Local Heuristics runs with 0 network calls; Ollama provides high-intelligence private local LLM analysis.
                </p>
              </div>
              <button
                type="button"
                className="ai-modal-close-btn"
                onClick={() => setIsConfigOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="ai-modal-body">
              <div className="provider-options-grid">
                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'mini-ai' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'mini-ai' })}
                  style={{ position: 'relative' }}
                >
                  <span style={{ position: 'absolute', top: 8, right: 8, fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#10b981', color: '#fff', fontWeight: 700 }}>RECOMMENDED</span>
                  <span className="opt-title">🧠 Mini-AI Classifier (Built-in)</span>
                  <span className="opt-desc">Embedded 25-feature mathematical neural classifier. &lt;0.05ms speed, zero external dependencies, zero daemons.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'local-heuristics' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'local-heuristics' })}
                >
                  <span className="opt-title">⚡ Local Heuristics</span>
                  <span className="opt-desc">Shannon entropy, lexical token boundaries, and CNAME uncloaking. 0ms, zero external data sharing.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'ollama' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'ollama' })}
                >
                  <span className="opt-title">🦙 Ollama Local LLM</span>
                  <span className="opt-desc">Air-gapped on-device neural network (e.g. llama3.2). Private and highly accurate.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'gemini' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'gemini' })}
                >
                  <span className="opt-title">✨ Google Gemini Flash</span>
                  <span className="opt-desc">Gemini 2.0 Flash reasoning for deep pattern extraction and evasion detection.</span>
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
