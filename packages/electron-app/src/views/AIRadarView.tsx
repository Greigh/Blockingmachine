import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type {
  AiProviderConfig,
  AiScanResult,
  QueryLogScanResult,
  CrawlScanResult,
  SinkholeConfig,
  ThreatQuarantineItem,
  AiWatchdogConfig,
  RuleConflictResult,
  LiveRadarSession,
} from '../types/';
import { formatConfidencePercent, verdictBadgeLabel } from '../aiDisplay';
import { BetaBadge } from '../components/BetaBadge';
import { EntropyGuideModal } from '../components/EntropyGuideModal';

interface AIRadarViewProps {
  liveRadarSession?: LiveRadarSession | null;
  onTriggerCompile?: () => void;
  onNavigateDeploy?: () => void;
  onNavigateInspector?: (domain?: string) => void;
  onNavigateSettings?: () => void;
  setError?: (msg: string | null) => void;
  setSuccessMessage?: (msg: string | null) => void;
}

type RadarTab = 'sinkhole-scout' | 'domain-inspector' | 'canary-crawler' | 'quarantine-history';

export const AIRadarView: React.FC<AIRadarViewProps> = ({
  liveRadarSession,
  onTriggerCompile,
  onNavigateDeploy,
  onNavigateInspector,
  onNavigateSettings,
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
  const [scoutError, setScoutError] = useState<string | null>(null);
  const [sinkholeConfig, setSinkholeConfig] = useState<SinkholeConfig | null>(null);
  const [blockedItemsMap, setBlockedItemsMap] = useState<Set<string>>(new Set());
  const [isEntropyModalOpen, setIsEntropyModalOpen] = useState(false);

  // Live Radar Continuous Scanning Session State
  const [durationMinutes, setDurationMinutes] = useState<number>(15);
  const [isCustomDuration, setIsCustomDuration] = useState<boolean>(false);
  const [customMinutesInput, setCustomMinutesInput] = useState<string>('10');
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState<number>(10);
  const [now, setNow] = useState<number>(Date.now());
  const [queryListFilter, setQueryListFilter] = useState<'all' | 'flagged' | 'clean'>('all');

  // Dedicated Uncluttered Search Stream View & Filtering
  const [isSearchingView, setIsSearchingView] = useState<boolean>(false);
  const [streamSearchText, setStreamSearchText] = useState<string>('');
  const [streamCategoryFilter, setStreamCategoryFilter] = useState<'all' | 'flagged' | 'clean' | 'ad_server' | 'tracker' | 'malicious' | 'entropy'>('all');
  const [streamStatusFilter, setStreamStatusFilter] = useState<'all' | 'unblocked' | 'blocked'>('all');
  const [streamSortBy, setStreamSortBy] = useState<'newest' | 'entropy-desc' | 'entropy-asc' | 'domain-asc'>('newest');

  useEffect(() => {
    if (!liveRadarSession?.active) return;
    setIsSearchingView(true);
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [liveRadarSession?.active]);

  useEffect(() => {
    if (liveRadarSession?.service) {
      setScoutService(liveRadarSession.service);
    }
  }, [liveRadarSession?.service]);

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
  const [ruleConflict, setRuleConflict] = useState<RuleConflictResult | null>(null);

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

  const handleCopy = useCallback(async (text: string, key: string) => {
    try {
      if (window.electron?.copyToClipboard) {
        await window.electron.copyToClipboard(text);
      } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      if (isMountedRef.current) {
        setCopiedKey(key);
        safeSetTimeout(() => setCopiedKey(null), 2200);
      }
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
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

  const handleToggleAutoQuarantineDga = async (checked: boolean) => {
    const updated = { ...watchdogConfig, autoQuarantineEntropyDga: checked };
    setWatchdogConfig(updated);
    if (window.electron?.setAiWatchdogConfig) {
      await window.electron.setAiWatchdogConfig(updated);
      setSuccessMessage?.(`Auto-quarantine zero-day DGA / high-entropy domains ${checked ? 'enabled' : 'disabled'}.`);
    }
  };

  // Live Radar Background Scanning Handlers
  const handleStartLiveScan = async () => {
    if (!window.electron?.startLiveRadarSession) return;
    setError?.(null);
    setScoutError(null);
    const chosenDuration = isCustomDuration ? Math.max(1, parseInt(customMinutesInput, 10) || 15) : durationMinutes;
    try {
      await window.electron.startLiveRadarSession({
        service: scoutService,
        durationMinutes: chosenDuration,
        pollIntervalSeconds,
      });
      setIsSearchingView(true);
      setSuccessMessage?.(`Started background Live Radar (${chosenDuration === 0 ? 'Continuous' : `${chosenDuration} minutes`}). Scanning continues in background even if you leave this screen.`);
    } catch (err: any) {
      setError?.(`Failed to start Live Radar: ${err?.message || err}`);
    }
  };

  const handleStopLiveScan = async () => {
    if (!window.electron?.stopLiveRadarSession) return;
    try {
      await window.electron.stopLiveRadarSession();
      setSuccessMessage?.('Live Radar session stopped.');
      loadQuarantine();
    } catch (err: any) {
      setError?.(`Failed to stop Live Radar: ${err?.message || err}`);
    }
  };

  const formatSessionRemaining = () => {
    if (!liveRadarSession?.active) return '';
    if (liveRadarSession.endTime === 0) {
      const elapsedSec = Math.max(0, Math.floor((now - liveRadarSession.startTime) / 1000));
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      return `Elapsed: ${m}:${s.toString().padStart(2, '0')} (Continuous)`;
    }
    const remainingSec = Math.max(0, Math.floor((liveRadarSession.endTime - now) / 1000));
    const m = Math.floor(remainingSec / 60);
    const s = remainingSec % 60;
    return `${m}:${s.toString().padStart(2, '0')} remaining`;
  };

  // Run Sinkhole Query Scout (One-Shot)
  const handleRunScout = async () => {
    if (!window.electron?.aiScanQueryLog) return;
    setIsScouting(true);
    setError?.(null);
    setScoutError(null);
    try {
      const res = await window.electron.aiScanQueryLog({ service: scoutService, limit: 60 });
      if (isMountedRef.current) {
        setScoutResult(res);
        setIsSearchingView(true);

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

        if (res.notice && res.totalQueriesAnalyzed === 0) {
          setSuccessMessage?.(res.notice);
        } else if (res.flaggedCount === 0) {
          setSuccessMessage?.(`Analyzed ${res.totalQueriesAnalyzed} unblocked queries. All benign.`);
        } else {
          setSuccessMessage?.(`Flagged ${res.flaggedCount} suspicious ad/tracker domains out of ${res.totalQueriesAnalyzed} queries.`);
        }
      }
    } catch (err: any) {
      const message = `Query log scout failed: ${err?.message || err}`;
      if (isMountedRef.current) {
        setScoutResult(null);
        setScoutError(message);
      }
      setError?.(message);
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
    const resultsPool = (liveRadarSession && liveRadarSession.results.length > 0)
      ? liveRadarSession.results
      : (scoutResult?.results || []);
    if (resultsPool.length === 0) return;
    const allRules: string[] = [];
    const ids: string[] = [];
    for (const item of resultsPool) {
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
        if (window.electron?.checkRuleConflict && res.rules.length > 0) {
          window.electron.checkRuleConflict(res.rules[0]).then((conflict) => {
            if (isMountedRef.current) {
              setRuleConflict(conflict.hasConflict ? conflict : null);
            }
          }).catch(console.error);
        } else {
          setRuleConflict(null);
        }
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

  // Run Domain Inspector (or delegate to Unified Inspector)
  const handleInspectDomain = async (overrideDomain?: string) => {
    const target = (overrideDomain || inspectorInput).trim();
    if (!target) return;
    if (overrideDomain) setInspectorInput(overrideDomain);

    if (onNavigateInspector) {
      onNavigateInspector(target);
      return;
    }

    if (!window.electron?.aiScanDomain) return;
    setIsInspecting(true);
    setInspectorResult(null);
    setCustomSynthesizedRules(null);
    setRuleConflict(null);
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
        if (window.electron?.checkRuleConflict && res.generatedRules.length > 0) {
          window.electron.checkRuleConflict(res.generatedRules[0]).then((conflict) => {
            if (isMountedRef.current) {
              setRuleConflict(conflict.hasConflict ? conflict : null);
            }
          }).catch(console.error);
        } else {
          setRuleConflict(null);
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

  // Stream results computation & filtering
  const hasLiveResults = Boolean(liveRadarSession && (liveRadarSession.results.length > 0 || liveRadarSession.totalQueriesAnalyzed > 0));
  const allResults = hasLiveResults ? liveRadarSession!.results : (scoutResult?.results || []);
  const totalQueries = hasLiveResults ? liveRadarSession!.totalQueriesAnalyzed : (scoutResult?.totalQueriesAnalyzed || 0);
  const flaggedCount = hasLiveResults ? liveRadarSession!.flaggedCount : (scoutResult?.flaggedCount || 0);
  const cleanCount = hasLiveResults ? liveRadarSession!.cleanCount : (scoutResult?.cleanCount || 0);
  const isVisible = hasLiveResults || Boolean(scoutResult) || Boolean(liveRadarSession?.active);

  const adCount = allResults.filter((r) => r.verdict === 'ad_server' || r.category === 'Advertising').length;
  const trackerCount = allResults.filter((r) => r.verdict === 'tracker' || r.category === 'Telemetry/Analytics' || r.category === 'CNAME Cloaking').length;
  const malwareCount = allResults.filter((r) => r.verdict === 'malicious' || r.verdict === 'suspicious' || r.category === 'Malware/Phishing').length;
  const highEntropyCount = allResults.filter((r) => (r.entropy || 0) >= 3.4).length;
  const blockedCount = allResults.filter((r) => blockedItemsMap.has(r.domain) || Boolean(r.coveredByRule)).length;
  const unblockedCount = allResults.length - blockedCount;

  const streamFilteredResults = useMemo(() => {
    let list = [...allResults];

    if (streamSearchText.trim()) {
      const q = streamSearchText.trim().toLowerCase();
      list = list.filter((item) =>
        item.domain.toLowerCase().includes(q) ||
        (item.category && item.category.toLowerCase().includes(q)) ||
        (item.verdict && item.verdict.toLowerCase().includes(q)) ||
        (item.reasons && item.reasons.some((r) => r.toLowerCase().includes(q))) ||
        (item.cnames && item.cnames.some((c) => c.toLowerCase().includes(q)))
      );
    }

    if (streamCategoryFilter === 'flagged') {
      list = list.filter((item) => item.verdict !== 'clean');
    } else if (streamCategoryFilter === 'clean') {
      list = list.filter((item) => item.verdict === 'clean');
    } else if (streamCategoryFilter === 'ad_server') {
      list = list.filter((item) => item.verdict === 'ad_server' || item.category === 'Advertising');
    } else if (streamCategoryFilter === 'tracker') {
      list = list.filter((item) => item.verdict === 'tracker' || item.category === 'Telemetry/Analytics' || item.category === 'CNAME Cloaking');
    } else if (streamCategoryFilter === 'malicious') {
      list = list.filter((item) => item.verdict === 'malicious' || item.verdict === 'suspicious' || item.category === 'Malware/Phishing');
    } else if (streamCategoryFilter === 'entropy') {
      list = list.filter((item) => (item.entropy || 0) >= 3.4);
    }

    if (streamStatusFilter === 'blocked') {
      list = list.filter((item) => blockedItemsMap.has(item.domain) || Boolean(item.coveredByRule));
    } else if (streamStatusFilter === 'unblocked') {
      list = list.filter((item) => !blockedItemsMap.has(item.domain) && !item.coveredByRule);
    }

    if (streamSortBy === 'entropy-desc') {
      list.sort((a, b) => (b.entropy || 0) - (a.entropy || 0));
    } else if (streamSortBy === 'entropy-asc') {
      list.sort((a, b) => (a.entropy || 0) - (b.entropy || 0));
    } else if (streamSortBy === 'domain-asc') {
      list.sort((a, b) => a.domain.localeCompare(b.domain));
    }

    return list;
  }, [allResults, streamSearchText, streamCategoryFilter, streamStatusFilter, streamSortBy, blockedItemsMap]);

  return (
    <div className="ai-radar-container">
      {/* =========================================================================
          1. UNIFIED COMPACT TOP CONTROL BAR (Hidden during dedicated full-page search stream)
         ========================================================================= */}
      {(!isSearchingView || activeTab !== 'sinkhole-scout') && (
        <>
          <div className="radar-top-bar">
            {/* Left: AI Discovery Engine Info */}
            <div className="radar-top-info">
          <div className="radar-info-main-col">
            <div className="radar-title-row">
              <span className="radar-live-badge-mini">
                <span className="live-radar-ping-dot" />
                AI RADAR ACTIVE
              </span>
              <h2 className="radar-top-title">
                AI Ad & Tracker Discovery Engine <BetaBadge />
              </h2>
            </div>
            <p className="radar-top-desc">
              Detect rapidly shifting ad servers, ephemeral bidding hostnames, CNAME cloaking, and zero-day trackers before they evade static filter lists.
            </p>
          </div>

          <div
            className="ai-provider-pill"
            onClick={() => (onNavigateSettings ? onNavigateSettings() : setIsConfigOpen(true))}
            title="Configure AI Engine in Preferences"
          >
            <span className="provider-status-dot" />
            <div className="provider-info-col">
              <span className="provider-label-small">Active Engine</span>
              <span className="provider-name">
                {aiConfig.provider === 'mini-ai' && 'Mini-AI Classifier (<0.05ms)'}
                {aiConfig.provider === 'local-heuristics' && 'Offline Heuristics & Entropy (0ms)'}
                {aiConfig.provider === 'ollama' && `Ollama (${aiConfig.ollamaModel || 'llama3.2'})`}
                {aiConfig.provider === 'gemini' && 'Google Gemini 2.0 Flash'}
                {aiConfig.provider === 'openai' && 'OpenAI Model'}
              </span>
            </div>
            <button
              type="button"
              className="provider-settings-btn"
              title="Configure AI Engine in Preferences"
              onClick={(e) => {
                e.stopPropagation();
                if (onNavigateSettings) onNavigateSettings();
                else setIsConfigOpen(true);
              }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Right: Integrated AI Sentinel Watchdog Cardlet */}
        <div className="radar-top-watchdog">
          <div className="watchdog-top-header">
            <div className="watchdog-title-inline">
              <span className={`provider-status-dot ${watchdogConfig.enabled ? 'active' : ''}`} />
              <span className="watchdog-label-strong">AI Sentinel Watchdog</span>
              <BetaBadge />
            </div>
            {watchdogConfig.lastRun ? (
              <span className="watchdog-last-run">
                Last: {new Date(watchdogConfig.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            ) : (
              <span className="watchdog-last-run">Homelab Guard</span>
            )}
          </div>

          <p className="watchdog-desc">
            Autonomous background threat hunter. Periodically audits your DNS query logs to detect zero-day trackers and auto-stages them into your Quarantine Ledger.
          </p>

          <div className="watchdog-top-controls">
            <div className="watchdog-status-tag">
              <span className={`status-indicator-dot ${watchdogConfig.enabled ? 'active' : 'idle'}`} />
              <span>{watchdogConfig.enabled ? 'Auto-Quarantining Active' : 'Watchdog Paused'}</span>
            </div>

            <div className="watchdog-action-group">
              <select
                className="watchdog-select-compact"
                value={watchdogConfig.intervalMinutes || 60}
                onChange={(e) => handleChangeWatchdogInterval(parseInt(e.target.value, 10))}
                title="Watchdog background run interval"
              >
                <option value={60}>Every 1 Hour</option>
                <option value={360}>Every 6 Hours</option>
                <option value={1440}>Every 24 Hours</option>
              </select>

              <button
                type="button"
                className={`watchdog-toggle-btn-compact ${watchdogConfig.enabled ? 'active' : ''}`}
                onClick={() => handleToggleWatchdog(!watchdogConfig.enabled)}
              >
                {watchdogConfig.enabled ? '✓ Active' : 'Enable'}
              </button>
            </div>
          </div>

          <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))' }}>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.75rem',
                color: 'var(--text-secondary, #94a3b8)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={watchdogConfig.autoQuarantineEntropyDga !== false}
                onChange={(e) => handleToggleAutoQuarantineDga(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: 'var(--accent-color, #6366f1)' }}
              />
              <span>Auto-quarantine zero-day DGA / high-entropy domains</span>
            </label>
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
          <span className="tab-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 11a9 9 0 0 1 9 9" />
              <path d="M4 4a16 16 0 0 1 16 16" />
              <circle cx="5" cy="19" r="1" />
            </svg>
          </span>
          <span>Sinkhole Query Scout</span>
          {sinkholeConfig && (sinkholeConfig.adguardHomeUrl || sinkholeConfig.piholeUrl) && (
            <span className="tab-connected-pill">Homelab Linked</span>
          )}
        </button>

        <button
          type="button"
          className={`radar-tab-btn ${activeTab === 'canary-crawler' ? 'active' : ''}`}
          onClick={() => setActiveTab('canary-crawler')}
        >
          <span className="tab-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </span>
          <span>Web Canary Crawler</span>
        </button>

        <button
          type="button"
          className={`radar-tab-btn ${activeTab === 'quarantine-history' ? 'active' : ''}`}
          onClick={() => setActiveTab('quarantine-history')}
        >
          <span className="tab-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </span>
          <span>Threat Quarantine Ledger</span>
          {quarantineList.length > 0 && (
            <span className="tab-count-badge">{quarantineList.length}</span>
          )}
        </button>
      </div>
      </>
      )}

      {/* ========================================================================= */}
      {/* TAB 1: SINKHOLE QUERY SCOUT */}
      {/* ========================================================================= */}
      {activeTab === 'sinkhole-scout' && (
        <div className="radar-tab-content">
          {isSearchingView ? (
            <div className="radar-search-page">
              {/* Sticky Top Status & Action Bar */}
              <div className="radar-search-header">
                <div className="radar-search-header-left">
                  <button
                    type="button"
                    className="secondary-button back-to-setup-btn"
                    onClick={() => setIsSearchingView(false)}
                    title="Return to Scout & Target Sinkhole configuration"
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="19" y1="12" x2="5" y2="12" />
                      <polyline points="12 19 5 12 12 5" />
                    </svg>
                    <span>Scout Setup</span>
                  </button>

                  <div className="radar-search-status-badge">
                    {liveRadarSession?.active ? (
                      <>
                        <span className="live-radar-ping-dot active" />
                        <span className="search-status-text">LIVE RADAR STREAM</span>
                        <span className="search-countdown-badge">⏱ {formatSessionRemaining()}</span>
                        <span className="search-poll-badge">Poll #{liveRadarSession.pollCount || 1} ({totalQueries} analyzed)</span>
                      </>
                    ) : (
                      <>
                        <span className="live-radar-ping-dot" />
                        <span className="search-status-text">SCOUT AUDIT RESULTS</span>
                        <span className="search-poll-badge">{totalQueries || allResults.length} Queries</span>
                      </>
                    )}
                  </div>

                  <span className="sinkhole-name-badge">
                    {scoutService === 'adguard' ? 'AdGuard Home' : 'Pi-hole'}
                  </span>
                </div>

                <div className="radar-search-header-right">
                  {liveRadarSession?.active ? (
                    <button
                      type="button"
                      className="danger-button stop-live-btn-compact"
                      onClick={handleStopLiveScan}
                      title="Stop background scanning session"
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                        <rect x="5" y="5" width="14" height="14" rx="2" />
                      </svg>
                      <span>Stop Live Scan</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={handleRunScout}
                      disabled={isScouting}
                      title="Re-scan latest DNS queries"
                    >
                      <span>{isScouting ? 'Scanning...' : 'Scout Again'}</span>
                    </button>
                  )}

                  {flaggedCount > 0 && (
                    <button
                      type="button"
                      className="primary-button block-all-flagged-btn"
                      onClick={handleBlockAllFlagged}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      <span>Block All Flagged ({flaggedCount})</span>
                    </button>
                  )}

                  <button
                    type="button"
                    className="entropy-guide-badge-btn"
                    onClick={() => setIsEntropyModalOpen(true)}
                    title="Understand Shannon Entropy and the 0.0 – 5.0 randomness scale"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                    <span>Entropy Guide</span>
                  </button>
                </div>
              </div>

              {/* Search & Advanced Multi-Filter Toolbar */}
              <div className="radar-search-toolbar">
                <div className="search-input-wrapper">
                  <svg className="search-input-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    className="stream-search-input"
                    placeholder="Filter by domain, category, keyword..."
                    value={streamSearchText}
                    onChange={(e) => setStreamSearchText(e.target.value)}
                  />
                  {streamSearchText && (
                    <button
                      type="button"
                      className="clear-search-btn"
                      onClick={() => setStreamSearchText('')}
                      title="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* Metric Filter Tabs */}
                <div className="stream-filter-pills">
                  <button
                    type="button"
                    className={`stream-pill ${streamCategoryFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setStreamCategoryFilter('all')}
                  >
                    <span>All Queries</span>
                    <span className="pill-count">{allResults.length}</span>
                  </button>

                  <button
                    type="button"
                    className={`stream-pill warning ${streamCategoryFilter === 'flagged' ? 'active' : ''}`}
                    onClick={() => setStreamCategoryFilter('flagged')}
                  >
                    <span className="pill-dot warning" />
                    <span>Flagged</span>
                    <span className="pill-count warning">{flaggedCount}</span>
                  </button>

                  <button
                    type="button"
                    className={`stream-pill success ${streamCategoryFilter === 'clean' ? 'active' : ''}`}
                    onClick={() => setStreamCategoryFilter('clean')}
                  >
                    <span className="pill-dot success" />
                    <span>Clean</span>
                    <span className="pill-count success">{cleanCount}</span>
                  </button>

                  <button
                    type="button"
                    className={`stream-pill ${streamCategoryFilter === 'ad_server' ? 'active' : ''}`}
                    onClick={() => setStreamCategoryFilter('ad_server')}
                  >
                    <span>Ads</span>
                    <span className="pill-count">{adCount}</span>
                  </button>

                  <button
                    type="button"
                    className={`stream-pill ${streamCategoryFilter === 'tracker' ? 'active' : ''}`}
                    onClick={() => setStreamCategoryFilter('tracker')}
                  >
                    <span>Trackers</span>
                    <span className="pill-count">{trackerCount}</span>
                  </button>

                  <button
                    type="button"
                    className={`stream-pill ${streamCategoryFilter === 'malicious' ? 'active' : ''}`}
                    onClick={() => setStreamCategoryFilter('malicious')}
                  >
                    <span>Threats</span>
                    <span className="pill-count">{malwareCount}</span>
                  </button>

                  <button
                    type="button"
                    className={`stream-pill ${streamCategoryFilter === 'entropy' ? 'active' : ''}`}
                    onClick={() => setStreamCategoryFilter('entropy')}
                    title="High Entropy (≥ 3.4 / 5.0) queries"
                  >
                    <span>High Entropy</span>
                    <span className="pill-count">{highEntropyCount}</span>
                  </button>
                </div>

                {/* Status & Sort Controls */}
                <div className="stream-aux-controls">
                  <select
                    className="stream-select status-select"
                    value={streamStatusFilter}
                    onChange={(e) => setStreamStatusFilter(e.target.value as any)}
                    title="Filter by block status"
                  >
                    <option value="all">Status: All ({allResults.length})</option>
                    <option value="unblocked">Unblocked ({unblockedCount})</option>
                    <option value="blocked">Blocked in Rules ({blockedCount})</option>
                  </select>

                  <select
                    className="stream-select sort-select"
                    value={streamSortBy}
                    onChange={(e) => setStreamSortBy(e.target.value as any)}
                    title="Sort order"
                  >
                    <option value="newest">Sort: Stream Order</option>
                    <option value="entropy-desc">Highest Entropy</option>
                    <option value="entropy-asc">Lowest Entropy</option>
                    <option value="domain-asc">Domain (A-Z)</option>
                  </select>
                </div>
              </div>

              {/* Subdomain Compaction Banner if available */}
              {compactionSummary && compactionSummary.savingsPercent > 0 && (
                <div style={{
                  padding: '8px 14px',
                  borderRadius: 8,
                  background: 'rgba(99, 102, 241, 0.08)',
                  border: '1px solid rgba(99, 102, 241, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 10,
                }}>
                  <div style={{ fontSize: 12, color: 'var(--text-color)' }}>
                    <span style={{ fontWeight: 600, color: '#6366f1' }}>Subdomain Compaction: </span>
                    Collapsed {compactionSummary.originalCount} subdomains into {compactionSummary.compactedCount} parent zone rules ({compactionSummary.savingsPercent}% reduction).
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    style={{ fontSize: 11.5, padding: '4px 10px', fontWeight: 600 }}
                    onClick={() => handleAddRulesToCustom(compactionSummary.compactedRules, 'compacted-subdomains')}
                  >
                    ＋ Add Compacted Rules ({compactionSummary.compactedCount})
                  </button>
                </div>
              )}

              {/* Spacious Results List */}
              {streamFilteredResults.length === 0 ? (
                <div className="radar-empty-query-box">
                  {streamStatusFilter === 'blocked' && blockedCount === 0 ? (
                    <div className="radar-empty-blocked-state">
                      <div className="empty-state-shield-icon">
                        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                      </div>
                      <h4 className="empty-state-title">No Queries Currently Blocked in Rules</h4>
                      <p className="empty-state-description">
                        All {allResults.length} captured live queries passed through unblocked.
                        {flaggedCount > 0 ? (
                          <> AI Radar flagged <strong>{flaggedCount} potential threat{flaggedCount > 1 ? 's' : ''}</strong> (ad servers, trackers, or high entropy hostnames) that are not yet blocked.</>
                        ) : (
                          <> No ad servers or malicious hostnames have been flagged or blocked in this session yet.</>
                        )}
                      </p>
                      <div className="empty-state-actions">
                        {flaggedCount > 0 && (
                          <button
                            type="button"
                            className="primary-button"
                            style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', border: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                            onClick={handleBlockAllFlagged}
                          >
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                            </svg>
                            <span>Block All Flagged ({flaggedCount})</span>
                          </button>
                        )}
                        {flaggedCount > 0 && (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                              setStreamStatusFilter('all');
                              setStreamCategoryFilter('flagged');
                            }}
                          >
                            <span>View Flagged Threats ({flaggedCount})</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            setStreamStatusFilter('all');
                            setStreamCategoryFilter('all');
                            setStreamSearchText('');
                          }}
                        >
                          <span>Show All Queries ({allResults.length})</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p>
                        {streamSearchText
                          ? `No queries matched "${streamSearchText}".`
                          : streamCategoryFilter !== 'all'
                          ? `No queries match the "${streamCategoryFilter}" filter.`
                          : streamStatusFilter === 'blocked'
                          ? 'No blocked queries match current search or category filters.'
                          : streamStatusFilter === 'unblocked'
                          ? 'No unblocked queries match current search or category filters.'
                          : allResults.length === 0
                          ? 'Waiting for unblocked DNS queries to arrive... Keep browsing or testing on your network.'
                          : 'No queries match current filters.'}
                      </p>
                      {(streamSearchText || streamCategoryFilter !== 'all' || streamStatusFilter !== 'all') && (
                        <button
                          type="button"
                          className="secondary-button"
                          style={{ marginTop: 8 }}
                          onClick={() => {
                            setStreamSearchText('');
                            setStreamCategoryFilter('all');
                            setStreamStatusFilter('all');
                          }}
                        >
                          Clear All Filters
                        </button>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="radar-search-results-list">
                  {streamFilteredResults.map((item, idx) => {
                    const isBlocked = blockedItemsMap.has(item.domain) || Boolean(item.coveredByRule);
                    const isClean = item.verdict === 'clean';

                    return (
                      <div
                        key={`${item.domain}-${idx}`}
                        className={`radar-search-card ${isClean ? 'clean-query-card' : 'flagged-threat'}`}
                      >
                        <div className="search-card-main-row">
                          <div className="search-card-identity">
                            <span className="search-card-domain" title={item.domain}>{item.domain}</span>

                            <button
                              type="button"
                              className={`search-card-copy-btn ${copiedKey === `domain-${idx}` ? 'copied' : ''}`}
                              onClick={() => handleCopy(item.domain, `domain-${idx}`)}
                              title={copiedKey === `domain-${idx}` ? 'Domain copied to clipboard!' : 'Copy domain name'}
                              aria-label="Copy domain name"
                            >
                              {copiedKey === `domain-${idx}` ? (
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                              )}
                            </button>

                            <span className={`verdict-chip ${item.verdict}`}>
                              {verdictBadgeLabel(item.verdict)}
                            </span>

                            {item.category && item.category.toLowerCase() !== item.verdict.toLowerCase() && item.category.toLowerCase() !== 'clean' && (
                              <span className="category-chip">{item.category}</span>
                            )}

                            <div
                              className="entropy-score-badge compact"
                              onClick={() => setIsEntropyModalOpen(true)}
                              title="Shannon Entropy: Measures character randomness on a 0.0 to 5.0 scale."
                              role="button"
                              tabIndex={0}
                            >
                              <span className="entropy-label">Entropy:</span>
                              <strong className="entropy-val">{Number(item.entropy).toFixed(2)}</strong>
                              <span className={`entropy-badge-tag ${item.entropy >= 3.8 ? 'high' : item.entropy >= 3.4 ? 'elevated' : 'normal'}`}>
                                {item.entropy >= 3.8 ? 'High' : item.entropy >= 3.4 ? 'Elevated' : 'Normal'}
                              </span>
                            </div>

                            {item.cnames && item.cnames.length > 0 && (
                              <span className="cname-chain-pill" title={`CNAME chain: ${item.cnames.join(' → ')}`}>
                                CNAME → {item.cnames[item.cnames.length - 1]}
                              </span>
                            )}
                          </div>

                          <div className="search-card-actions">
                            {isBlocked ? (
                              <span className="blocked-status-pill" title={item.coveredByRule ? `Covered by existing rule: ${item.coveredByRule}` : 'Added to Custom Rules'}>
                                ✓ {item.coveredByRule ? 'Covered in Rules' : 'Blocked'}
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="secondary-button block-threat-btn"
                                onClick={() => handleAddRulesToCustom([item.generatedRules[0] || `||${item.domain}^`], item.domain)}
                                title="Add blocking rule to Custom Rules"
                              >
                                ＋ Add Rule
                              </button>
                            )}

                            {!isClean && (
                              <button
                                type="button"
                                className="secondary-button whitelist-threat-btn"
                                onClick={() => handleWhitelistDomain(item.domain)}
                                title="Report as false positive and add whitelist rule (@@||...)"
                              >
                                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span>Whitelist</span>
                              </button>
                            )}

                            <button
                              type="button"
                              className={`threat-icon-action-btn ${copiedKey === `scout-${idx}` ? 'copied' : ''}`}
                              onClick={() => handleCopy(item.generatedRules[0] || `||${item.domain}^`, `scout-${idx}`)}
                              title={copiedKey === `scout-${idx}` ? 'Rule copied to clipboard!' : 'Copy Rule (||domain^)'}
                              aria-label="Copy Rule"
                            >
                              {copiedKey === `scout-${idx}` ? (
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                              )}
                            </button>

                            {onNavigateInspector && (
                              <button
                                type="button"
                                className="threat-icon-action-btn"
                                onClick={() => onNavigateInspector(item.domain)}
                                title="Inspect domain in Rule & AI Inspector (⌘5)"
                                aria-label="Inspect domain"
                              >
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="11" cy="11" r="8" />
                                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>

                        {item.reasons && item.reasons.length > 0 && (
                          <div className="search-card-reasons">
                            {item.reasons.map((r, rIdx) => (
                              <span key={rIdx} className="reason-pill">• {r}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="radar-card">
            <div className="radar-card-header">
              <div>
                <h3 className="radar-card-title">
                  <span>Live Homelab Query Log Scout</span>
                  <BetaBadge />
                </h3>
                <p className="radar-card-desc">
                  Inspect unblocked DNS queries passing through your AdGuard Home or Pi-hole to identify stealthy ad exchanges and telemetry endpoints.
                </p>
              </div>
              {isVisible && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setIsSearchingView(true)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}
                  title="Switch to dedicated uncluttered full-page view"
                >
                  <span>Full-Page View ({allResults.length})</span>
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              )}
            </div>

            {/* Quick Banner to switch to full-page search stream */}
            {isVisible && (
              <div className="radar-search-mode-banner">
                <div className="search-banner-left">
                  <span className={`live-radar-ping-dot ${liveRadarSession?.active ? 'active' : ''}`} />
                  <div>
                    <strong>{liveRadarSession?.active ? 'Live Radar session active in background:' : 'Scout query audit completed:'}</strong>{' '}
                    <span>{allResults.length} queries scanned • {flaggedCount} threat(s) flagged {liveRadarSession?.active && `(${formatSessionRemaining()})`}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="primary-button open-stream-btn"
                  onClick={() => setIsSearchingView(true)}
                  title="Open dedicated uncluttered search page with advanced filters"
                >
                  <span>Open Full-Page Search View</span>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            )}

            {/* SINKHOLE TARGET, DURATION & INTERVAL CONFIGURATION BAR */}
            <div className="radar-session-config-bar">
              <div className="config-bar-row config-bar-row-top">
                <div className="sinkhole-target-section">
                  <span className="config-section-label">Target Sinkhole:</span>
                  <div className="service-switch-pills">
                    <button
                      type="button"
                      className={`service-pill ${scoutService === 'adguard' ? 'active' : ''}`}
                      onClick={() => setScoutService('adguard')}
                      disabled={Boolean(liveRadarSession?.active)}
                    >
                      AdGuard Home
                    </button>
                    <button
                      type="button"
                      className={`service-pill ${scoutService === 'pihole' ? 'active' : ''}`}
                      onClick={() => setScoutService('pihole')}
                      disabled={Boolean(liveRadarSession?.active)}
                    >
                      Pi-hole
                    </button>
                  </div>
                </div>

                <div className="duration-config-section">
                  <span className="config-section-label">Scan Duration:</span>
                  <div className="duration-pill-group">
                    {[
                      { label: '5m', val: 5 },
                      { label: '15m', val: 15 },
                      { label: '30m', val: 30 },
                      { label: '1h', val: 60 },
                      { label: 'Continuous', val: 0 },
                    ].map((preset) => (
                      <button
                        key={preset.val}
                        type="button"
                        disabled={Boolean(liveRadarSession?.active)}
                        className={`duration-pill ${!isCustomDuration && durationMinutes === preset.val ? 'active' : ''}`}
                        onClick={() => {
                          setIsCustomDuration(false);
                          setDurationMinutes(preset.val);
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={Boolean(liveRadarSession?.active)}
                      className={`duration-pill ${isCustomDuration ? 'active' : ''}`}
                      onClick={() => setIsCustomDuration(true)}
                    >
                      Custom...
                    </button>
                  </div>

                  {isCustomDuration && (
                    <div className="custom-duration-input-wrap">
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        disabled={Boolean(liveRadarSession?.active)}
                        className="custom-duration-input"
                        value={customMinutesInput}
                        onChange={(e) => setCustomMinutesInput(e.target.value)}
                      />
                      <span className="custom-duration-unit">minutes</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="config-bar-row config-bar-row-bottom">
                <div className="interval-config-section">
                  <span className="config-section-label">Poll Every:</span>
                  <div className="interval-pill-group">
                    {[
                      { label: '5s', val: 5 },
                      { label: '10s (Default)', val: 10 },
                      { label: '30s', val: 30 },
                    ].map((intv) => (
                      <button
                        key={intv.val}
                        type="button"
                        disabled={Boolean(liveRadarSession?.active)}
                        className={`interval-pill ${pollIntervalSeconds === intv.val ? 'active' : ''}`}
                        onClick={() => setPollIntervalSeconds(intv.val)}
                      >
                        {intv.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="scout-action-group">
                  {liveRadarSession?.active ? (
                    <button
                      type="button"
                      className="danger-button live-stop-scan-btn"
                      onClick={handleStopLiveScan}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                        <rect x="5" y="5" width="14" height="14" rx="2" />
                      </svg>
                      <span>Stop Live Scan</span>
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary-button radar-scout-btn"
                        onClick={handleStartLiveScan}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 2a10 10 0 0110 10" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                        <span>Start Live Scan ({isCustomDuration ? `${customMinutesInput}m` : durationMinutes === 0 ? 'Continuous' : `${durationMinutes}m`})</span>
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={handleRunScout}
                        disabled={isScouting}
                        title="Quick single-query log audit"
                      >
                        <span>{isScouting ? 'Scanning...' : 'Scout Once'}</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* LIVE ACTIVE SCANNING BANNER */}
            {liveRadarSession?.active && (
              <div className="radar-live-banner">
                <div className="radar-live-sweep-box">
                  <div className="radar-sweep-wave wave-1" />
                  <div className="radar-sweep-wave wave-2" />
                  <div className="radar-sweep-center-dot" />
                </div>
                <div className="radar-live-banner-content">
                  <div className="radar-live-status-row">
                    <span className="live-status-pill">
                      <span className="live-status-dot" />
                      LIVE RADAR ACTIVE
                    </span>
                    <span className="live-time-countdown">
                      ⏱ {formatSessionRemaining()}
                    </span>
                    <span className="live-poll-badge">
                      Poll #{liveRadarSession?.pollCount || 1}
                    </span>
                    {liveRadarSession?.lastPollTime && (
                      <span className="live-last-poll">
                        Last poll: {new Date(liveRadarSession.lastPollTime).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  <p className="radar-live-note">
                    Radar is actively scouting unblocked DNS queries in the background and auto-quarantining newly detected ad exchanges. <strong>You can switch to other screens or minimize the app without interrupting this session.</strong>
                  </p>
                </div>
              </div>
            )}

            {/* If no sinkhole configured */}
            {sinkholeConfig && (sinkholeConfig.adguardMode === 'ha-api' || sinkholeConfig.adguardMode === 'webhook') && !sinkholeConfig.adguardDirectUrl && (
              <div className="radar-hint-box">
                <div>
                  <strong>AdGuard Direct URL needed for the query log.</strong> {sinkholeConfig.adguardMode === 'webhook' ? 'Webhook mode reloads Home Assistant and does not read the AdGuard query log.' : `Home Assistant REST API mode is using ${sinkholeConfig.adguardHomeUrl || 'the Home Assistant URL'} for reloads.`} Set the AdGuard Direct URL, for example https://homeassistant.local:8124, in Deploy Hub so this scout does not read Home Assistant.
                  <button type="button" className="text-button-link" onClick={onNavigateDeploy} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
                    <span>Open Deploy Hub</span>
                  </button>
                </div>
              </div>
            )}

            {(scoutError || liveRadarSession?.lastError) && (
              <div className="radar-hint-box scout-error-box" role="alert">
                <div>
                  <strong>Query log issue:</strong> {scoutError || liveRadarSession?.lastError}
                </div>
              </div>
            )}

            {sinkholeConfig && !sinkholeConfig.adguardHomeUrl && !sinkholeConfig.adguardDirectUrl && !sinkholeConfig.piholeUrl && (
              <div className="radar-hint-box">
                <span className="hint-icon">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18h6" />
                    <path d="M10 22h4" />
                    <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
                  </svg>
                </span>
                <div>
                  <strong>No sinkhole configured yet:</strong> Enter your AdGuard Home or Pi-hole details in the Deploy Hub to automatically scout your homelab DNS queries.
                  <button type="button" className="text-button-link" onClick={onNavigateDeploy} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
                    <span>Open Deploy Hub</span>
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {/* Metrics summary bar */}
            {(() => {
              const hasLiveResults = Boolean(liveRadarSession && (liveRadarSession.results.length > 0 || liveRadarSession.totalQueriesAnalyzed > 0));
              const allResults = hasLiveResults ? liveRadarSession!.results : (scoutResult?.results || []);
              const totalQueries = hasLiveResults ? liveRadarSession!.totalQueriesAnalyzed : (scoutResult?.totalQueriesAnalyzed || 0);
              const flagged = hasLiveResults ? liveRadarSession!.flaggedCount : (scoutResult?.flaggedCount || 0);
              const clean = hasLiveResults ? liveRadarSession!.cleanCount : (scoutResult?.cleanCount || 0);
              const isVisible = hasLiveResults || Boolean(scoutResult) || Boolean(liveRadarSession?.active);

              if (!isVisible) return null;

              return (
                <div className="scout-metrics-row">
                  <div className="metric-tabs-group">
                    <button
                      type="button"
                      className={`metric-tab-pill ${queryListFilter === 'all' ? 'active' : ''}`}
                      onClick={() => setQueryListFilter('all')}
                      title="Show all analyzed queries"
                    >
                      <span className="metric-tab-label">All Queries</span>
                      <span className="metric-tab-count">{allResults.length || totalQueries}</span>
                    </button>
                    <button
                      type="button"
                      className={`metric-tab-pill warning ${queryListFilter === 'flagged' ? 'active' : ''}`}
                      onClick={() => setQueryListFilter('flagged')}
                      title="Filter only flagged ad/tracker threats"
                    >
                      <span className="metric-tab-dot warning" />
                      <span className="metric-tab-label">Flagged Threats</span>
                      <span className="metric-tab-count warning">{flagged}</span>
                    </button>
                    <button
                      type="button"
                      className={`metric-tab-pill success ${queryListFilter === 'clean' ? 'active' : ''}`}
                      onClick={() => setQueryListFilter('clean')}
                      title="Filter clean benign queries"
                    >
                      <span className="metric-tab-dot success" />
                      <span className="metric-tab-label">Clean Services</span>
                      <span className="metric-tab-count success">{clean}</span>
                    </button>
                  </div>

                  <div className="metric-actions-group">
                    <button
                      type="button"
                      className="entropy-guide-badge-btn"
                      onClick={() => setIsEntropyModalOpen(true)}
                      title="Understand Shannon Entropy and the 0.0 – 5.0 randomness scale"
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      <span>Entropy Guide</span>
                    </button>
                    {flagged > 0 && (
                      <button
                        type="button"
                        className="primary-button block-all-flagged-btn"
                        onClick={handleBlockAllFlagged}
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                        <span>Block All Flagged ({flagged})</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

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
                  <span style={{ fontWeight: 600, color: '#6366f1', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                    Subdomain Wildcard Compaction:
                  </span> Collapsed {compactionSummary.originalCount} subdomains into {compactionSummary.compactedCount} parent zone rules ({compactionSummary.savingsPercent}% list bloat reduction).
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
            {(() => {
              const hasLiveResults = Boolean(liveRadarSession && (liveRadarSession.results.length > 0 || liveRadarSession.totalQueriesAnalyzed > 0));
              const allResults = hasLiveResults ? liveRadarSession!.results : (scoutResult?.results || []);
              const isVisible = hasLiveResults || Boolean(scoutResult) || Boolean(liveRadarSession?.active);

              if (!isVisible) return null;

              const filtered = allResults.filter((item) => {
                if (queryListFilter === 'flagged') return item.verdict !== 'clean';
                if (queryListFilter === 'clean') return item.verdict === 'clean';
                return true;
              });

              if (filtered.length === 0) {
                return (
                  <div className="radar-empty-query-box">
                    <p>
                      {queryListFilter === 'flagged'
                        ? 'No suspicious ad or tracker domains detected in this query batch. All queries are benign.'
                        : allResults.length === 0
                        ? 'Waiting for unblocked DNS queries to arrive... Keep browsing or testing on your network.'
                        : 'No queries match this filter.'}
                    </p>
                  </div>
                );
              }

              return (
                <div className="scout-results-list">
                  {filtered.map((item, idx) => {
                    const isBlocked = blockedItemsMap.has(item.domain) || Boolean(item.coveredByRule);
                    const isClean = item.verdict === 'clean';

                    return (
                      <div key={`${item.domain}-${idx}`} className={`scout-threat-card ${isClean ? 'clean-query-card' : ''}`}>
                        <div className="threat-header">
                          <div className="threat-title-col">
                            <div className="threat-domain-row">
                              <span className="threat-domain">{item.domain}</span>
                              <span className={`verdict-chip ${item.verdict}`}>
                                {verdictBadgeLabel(item.verdict)}
                              </span>
                              {item.category &&
                                item.category.toLowerCase() !== item.verdict.toLowerCase() &&
                                item.category.toLowerCase() !== 'clean' && (
                                  <span className="category-chip">{item.category}</span>
                                )}
                            </div>
                            <div className="threat-entropy-row">
                              <div
                                className="entropy-score-badge"
                                onClick={() => setIsEntropyModalOpen(true)}
                                title="Shannon Entropy: Measures character randomness on a 0.0 to 5.0 scale."
                                role="button"
                                tabIndex={0}
                              >
                                <span className="entropy-label">Entropy:</span>
                                <strong className="entropy-val">{Number(item.entropy).toFixed(2)}</strong>
                                <span className="entropy-max">/ 5.0</span>
                                <span className={`entropy-badge-tag ${item.entropy >= 3.8 ? 'high' : item.entropy >= 3.4 ? 'elevated' : 'normal'}`}>
                                  {item.entropy >= 3.8 ? 'High Randomness' : item.entropy >= 3.4 ? 'Elevated' : 'Normal'}
                                </span>
                              </div>
                              {item.cnames && item.cnames.length > 0 && (
                                <span className="cname-chain-pill">
                                  CNAME → {item.cnames[item.cnames.length - 1]}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="threat-actions">
                            {isBlocked ? (
                              <span className="blocked-status-pill" title={item.coveredByRule ? `Covered by existing rule: ${item.coveredByRule}` : 'Added to Custom Rules'}>
                                ✓ {item.coveredByRule ? 'Covered in Rules' : 'Blocked'}
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="secondary-button block-threat-btn"
                                onClick={() => handleAddRulesToCustom([item.generatedRules[0] || `||${item.domain}^`], item.domain)}
                              >
                                ＋ Add Rule
                              </button>
                            )}
                            {!isClean && (
                              <button
                                type="button"
                                className="secondary-button whitelist-threat-btn"
                                onClick={() => handleWhitelistDomain(item.domain)}
                                title="Report as false positive and add whitelist rule (@@||...)"
                              >
                                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span>Whitelist</span>
                              </button>
                            )}
                            <button
                              type="button"
                              className={`threat-icon-action-btn ${copiedKey === `scout-${idx}` ? 'copied' : ''}`}
                              onClick={() => handleCopy(item.generatedRules[0] || `||${item.domain}^`, `scout-${idx}`)}
                              title={copiedKey === `scout-${idx}` ? 'Rule copied to clipboard!' : 'Copy Rule (||domain^)'}
                              aria-label="Copy Rule"
                            >
                              {copiedKey === `scout-${idx}` ? (
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                              )}
                            </button>
                            {onNavigateInspector && (
                              <button
                                type="button"
                                className="threat-icon-action-btn"
                                onClick={() => onNavigateInspector(item.domain)}
                                title="Inspect domain in Rule & AI Inspector (⌘5)"
                                aria-label="Inspect domain"
                              >
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="11" cy="11" r="8" />
                                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>

                        {item.reasons && item.reasons.length > 0 && (
                          <div className="threat-reasons">
                            {item.reasons.map((r, rIdx) => (
                              <span key={rIdx} className="reason-pill">• {r}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: DOMAIN & PAYLOAD INSPECTOR */}
      {/* ========================================================================= */}
      {activeTab === 'domain-inspector' && (
        <div className="radar-tab-content">
          <div className="radar-card">
            <div style={{
              marginBottom: 16,
              padding: '14px 16px',
              borderRadius: 8,
              background: 'rgba(168, 85, 247, 0.08)',
              border: '1px solid rgba(168, 85, 247, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}>
              <div>
                <strong style={{ color: '#c084fc', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  Consolidated in Rule & AI Inspector:
                </strong>
                <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Domain heuristics and compiled filter list rules are now evaluated simultaneously in the Unified Rule & AI Inspector (⌘5).
                </p>
              </div>
              {onNavigateInspector && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => onNavigateInspector(inspectorInput)}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  Open in Unified Inspector ↗
                </button>
              )}
            </div>

            <h3 className="radar-card-title">
              <span>Real-Time Domain & Payload Inspector</span>
              <BetaBadge />
            </h3>
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
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span>{isInspecting ? 'Analyzing...' : 'Inspect with AI'}</span>
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
                      {inspectorResult.verdict === 'clean' ? (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                          <line x1="12" y1="9" x2="12" y2="13" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                      )}
                    </span>
                    <div>
                      <h4 className="verdict-title">
                        {inspectorResult.verdict.toUpperCase().replace('_', ' ')}
                      </h4>
                      <span className="verdict-subtitle">
                        Confidence: <strong>{formatConfidencePercent(inspectorResult.confidence)}</strong> | Risk Level: <strong>{inspectorResult.riskLevel.toUpperCase()}</strong>
                      </span>
                    </div>
                  </div>
                  <span className="verdict-category-tag">{inspectorResult.category}</span>
                </div>

                <div className="inspector-metrics-grid">
                  <div
                    className="metric-card"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setIsEntropyModalOpen(true)}
                    title="Click for Shannon Entropy scale breakdown"
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span className="card-label">Shannon Entropy</span>
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--muted-text)' }}>
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    </div>
                    <span className="card-value">{Number(inspectorResult.entropy).toFixed(2)} <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>/ 5.0</span></span>
                    <span className="card-sub">{inspectorResult.entropy >= 3.8 ? 'High Randomness (DGA)' : inspectorResult.entropy >= 3.4 ? 'Elevated Complexity' : 'Normal distribution'}</span>
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
                      {inspectorResult.domain} → {inspectorResult.cnames.join(' → ')}
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
                  <span style={{ fontWeight: 600, color: 'var(--primary-color)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                    Inference Latency: {inspectorResult.inferenceTimeMs !== undefined ? `${inspectorResult.inferenceTimeMs}ms` : '< 0.05ms'}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>•</span>
                  <span>Engine: {inspectorResult.modelUsed || 'Mini-AI Embedded Classifier'}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>•</span>
                  <span title="Shannon Entropy: 0.0 to 5.0 scale measuring character randomness">
                    Entropy Index: {inspectorResult.entropy.toFixed(2)} / 5.0
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>•</span>
                  <span style={{ color: '#3b82f6', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" />
                    </svg>
                    Learned Domains: {learnedFeedbackCount} saved to disk
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#10b981', fontWeight: 600 }}>
                    100% In-Memory Air-Gapped
                  </span>
                </div>

                {/* Whitelist Conflict Override Banner */}
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
                          Suggested Override: <code style={{ color: 'var(--primary-color)' }}>{ruleConflict.suggestedOverrideRule}</code>
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
                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        <span>Whitelist (False Positive)</span>
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
            <h3 className="radar-card-title">
              <span>Web Canary Page Crawler</span>
              <BetaBadge />
            </h3>
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
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                <span>{isCrawling ? 'Crawling Page...' : 'Crawl & Discover'}</span>
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
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      <span>Block All Discovered ({crawlerResult.synthesizedRules.length})</span>
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
                              {verdictBadgeLabel(host.verdict)}
                            </span>
                            {host.category &&
                              host.category.toLowerCase() !== host.verdict.toLowerCase() &&
                              host.category.toLowerCase() !== 'clean' && (
                                <span className="category-chip">{host.category}</span>
                              )}
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
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            <span>Whitelist</span>
                          </button>
                          {onNavigateInspector && (
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => onNavigateInspector(host.domain)}
                              title="Inspect in Unified Rule & AI Inspector"
                            >
                              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="11" cy="11" r="8" />
                                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                              </svg>
                              <span>Inspect</span>
                            </button>
                          )}
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
                <h3 className="radar-card-title">
                  <span>Discovered Threat Quarantine Ledger</span>
                  <BetaBadge />
                </h3>
                <p className="radar-card-desc">
                  Persistent record of all anomalous ad networks, programmatic bidders, and stealth trackers intercepted across Sinkhole Scout, Watchdog, Inspector, and Crawler.
                </p>
              </div>

              <div className="scout-action-group">
                {onTriggerCompile && (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={onTriggerCompile}
                    title="Compile updated filter rules in Process view"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    <span>Compile Rules</span>
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => handleExportQuarantine('abp')}
                  disabled={quarantineList.length === 0}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span>Export ABP List</span>
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => handleExportQuarantine('hosts')}
                  disabled={quarantineList.length === 0}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span>Export Hosts</span>
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleClearQuarantineLedger}
                  disabled={quarantineList.length === 0}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  <span>Clear Ledger</span>
                </button>
              </div>
            </div>

            {/* Live Dynamic Threat Feeds Banner */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                background: 'rgba(99, 102, 241, 0.08)',
                border: '1px solid rgba(99, 102, 241, 0.25)',
                borderRadius: '8px',
                padding: '12px 16px',
                marginBottom: '16px',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-color, #f8fafc)' }}>
                  <span>🛡️ Live Dynamic Threat Feeds (Port 9191)</span>
                  <span style={{ fontSize: '0.7rem', padding: '2px 6px', borderRadius: '4px', background: 'rgba(34, 197, 94, 0.2)', color: '#4ade80' }}>Auto-Updating</span>
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary, #94a3b8)', marginTop: '2px' }}>
                  High-confidence (≥ 85%) quarantined zero-day threats are materialized in real time as network-wide feeds and auto-injected into DNS trie memory.
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="secondary-button"
                  style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                  onClick={() => {
                    handleCopy('http://127.0.0.1:9191/threats.txt', 'threat-feed-url');
                    setSuccessMessage?.('Copied ABP threat feed URL to clipboard');
                  }}
                  title="Copy http://127.0.0.1:9191/threats.txt"
                >
                  Copy ABP Feed (/threats.txt)
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                  onClick={() => {
                    handleCopy('http://127.0.0.1:9191/ai-threats.txt', 'ai-threat-feed-url');
                    setSuccessMessage?.('Copied domain threat feed URL to clipboard');
                  }}
                  title="Copy http://127.0.0.1:9191/ai-threats.txt"
                >
                  Copy Domain Feed (/ai-threats.txt)
                </button>
              </div>
            </div>

            {/* Toolbar */}
            <div className="quarantine-toolbar">
              <div className="quarantine-filters">
                {['all', 'advertising', 'telemetry/analytics', 'cname cloaking', 'malware/phishing'].map((cat) => (
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
                <span className="hint-icon">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </span>
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
                              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              <span>Whitelist</span>
                            </button>
                            {onNavigateInspector && (
                              <button
                                type="button"
                                className="secondary-button"
                                style={{ padding: '4px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                onClick={() => onNavigateInspector(item.domain)}
                                title="Inspect in Unified Rule & AI Inspector"
                              >
                                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="11" cy="11" r="8" />
                                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                                <span>Inspect</span>
                              </button>
                            )}
                            <button
                              type="button"
                              className="secondary-button"
                              style={{ padding: '4px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                              onClick={() => handleRemoveQuarantineItem(item.id)}
                              title="Remove from quarantine"
                              aria-label="Remove from quarantine"
                            >
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
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
                <h4 className="ai-modal-title">
                  <span>AI Radar Provider Configuration</span>
                  <BetaBadge />
                </h4>
                <p className="ai-modal-desc">
                  Select your discovery engine. Local Heuristics runs with 0 network calls; Ollama provides high-intelligence private local LLM analysis.
                </p>
              </div>
              <button
                type="button"
                className="ai-modal-close-btn"
                onClick={() => setIsConfigOpen(false)}
                aria-label="Close configuration"
                title="Close"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
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
                  <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" />
                      <line x1="9" y1="1" x2="9" y2="4" />
                      <line x1="15" y1="1" x2="15" y2="4" />
                      <line x1="9" y1="20" x2="9" y2="23" />
                      <line x1="15" y1="20" x2="15" y2="23" />
                      <line x1="20" y1="9" x2="23" y2="9" />
                      <line x1="20" y1="14" x2="23" y2="14" />
                      <line x1="1" y1="9" x2="4" y2="9" />
                      <line x1="1" y1="14" x2="4" y2="14" />
                    </svg>
                    <span>Mini-AI Classifier (Built-in)</span>
                  </span>
                  <span className="opt-desc">Embedded 25-feature mathematical neural classifier. &lt;0.05ms speed, zero external dependencies, zero daemons.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'local-heuristics' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'local-heuristics' })}
                >
                  <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                    <span>Local Heuristics</span>
                  </span>
                  <span className="opt-desc">Shannon entropy, lexical token boundaries, and CNAME uncloaking. 0ms, zero external data sharing.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'ollama' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'ollama' })}
                >
                  <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                      <line x1="6" y1="6" x2="6.01" y2="6" />
                      <line x1="6" y1="18" x2="6.01" y2="18" />
                    </svg>
                    <span>Ollama Local LLM</span>
                  </span>
                  <span className="opt-desc">Air-gapped on-device neural network (e.g. llama3.2). Private and highly accurate.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'gemini' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'gemini' })}
                >
                  <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                    <span>Google Gemini Flash</span>
                  </span>
                  <span className="opt-desc">Gemini 2.0 Flash reasoning for deep pattern extraction and evasion detection.</span>
                </button>

                <button
                  type="button"
                  className={`provider-option-btn ${aiConfig.provider === 'openai' ? 'active' : ''}`}
                  onClick={() => setAiConfig({ ...aiConfig, provider: 'openai' })}
                >
                  <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                    <span>OpenAI / Compatible</span>
                  </span>
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
                  <span>
                    {aiTestResult.success ? (
                      '✓'
                    ) : (
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                    )}
                  </span>
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
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span>{isTestingAi ? 'Testing...' : 'Test Connection'}</span>
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
      {/* Shannon Entropy & Randomness Guide Modal */}
      <EntropyGuideModal
        isOpen={isEntropyModalOpen}
        onClose={() => setIsEntropyModalOpen(false)}
      />
    </div>
  );
};
