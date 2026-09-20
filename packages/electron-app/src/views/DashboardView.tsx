import React, { useState, useEffect, useRef } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Legend,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import type { ProcessingResult, FilterSource, CompilationSnapshot } from '../types';
import { BrandLogo } from '../components/BrandLogo';

interface DashboardViewProps {
  savePath: string;
  autoTriggerCompile?: boolean;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  savePath,
  autoTriggerCompile,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ProcessingResult | null>(null);
  const [progress, setProgress] = useState<{
    status: string;
    percent: number;
  } | null>(null);
  const [history, setHistory] = useState<CompilationSnapshot[]>([]);
  const [dashboardStats, setDashboardStats] = useState<{
    enabledSources: number;
    totalSources: number;
    customRulesCount: number;
    lastProcessedTime: string | null;
  }>({
    enabledSources: 0,
    totalSources: 0,
    customRulesCount: 0,
    lastProcessedTime: null,
  });

  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshStatsAndHistory = async () => {
    try {
      const sources = await window.electron.getSources();
      const enabledSources = sources.filter((s: FilterSource) => s.enabled).length;

      const customRules = await window.electron.getCustomRules();
      const customRulesCount = customRules
        .split('\n')
        .filter((line: string) => line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('!')).length;

      const lastProcessTime = await window.electron.getLastProcessTime();
      const historySnapshots = await window.electron.getCompilationHistory();

      if (isMountedRef.current) {
        setDashboardStats({
          enabledSources,
          totalSources: sources.length,
          customRulesCount,
          lastProcessedTime: lastProcessTime,
        });
        setHistory(historySnapshots || []);
      }
    } catch (err) {
      console.error('Failed to load dashboard stats:', err);
    }
  };

  useEffect(() => {
    refreshStatsAndHistory();
  }, []);

  const handleRunProcess = async () => {
    setIsLoading(true);
    setError(null);
    setLastResult(null);
    setProgress({ status: 'Initializing concurrent engine...', percent: 0 });

    try {
      const result = await window.electron.runImportProcess();
      if (isMountedRef.current) {
        setLastResult(result);
      }

      await refreshStatsAndHistory();

      if (!result.success && isMountedRef.current) {
        setError(result.error || 'An unknown error occurred during compilation.');
      }
    } catch (err) {
      console.error('Error running process:', err);
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      if (isMountedRef.current) {
        setError(message);
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
        setProgress(null);
      }
    }
  };

  useEffect(() => {
    const unsubscribe = window.electron.onProcessProgress((data) => {
      if (isMountedRef.current) {
        setProgress(data);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (autoTriggerCompile && !isLoading) {
      handleRunProcess();
    }
  }, [autoTriggerCompile]);

  // Keyboard shortcut Cmd+R to compile
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        if (!isLoading) {
          handleRunProcess();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLoading]);

  const handleRevealOutput = () => {
    if (savePath) {
      window.electron.showItemInFolder(savePath);
    }
  };

  // Delta calculation compared to previous compilation
  let ruleDeltaText: string | null = null;
  let isPositiveDelta = true;
  if (history.length >= 2) {
    const currentCount = history[0].uniqueRuleCount;
    const prevCount = history[1].uniqueRuleCount;
    const diff = currentCount - prevCount;
    if (diff !== 0) {
      isPositiveDelta = diff > 0;
      const pct = ((diff / prevCount) * 100).toFixed(1);
      ruleDeltaText = `${diff > 0 ? '+' : ''}${diff.toLocaleString()} rules (${diff > 0 ? '+' : ''}${pct}%) since previous run`;
    }
  }

  return (
    <div className="dashboard-content-flow">
      {/* Hero Action Card */}
      <div className="desktop-card hero-action-card">
        <div className="hero-content-wrapper">
          <div className="hero-text-col">
            <div className="hero-status-pill">
              <span className="status-indicator-dot" />
              <span>Engine Ready</span>
              {dashboardStats.lastProcessedTime && (
                <span className="last-run-timestamp">Last run: {dashboardStats.lastProcessedTime}</span>
              )}
            </div>
            <h2 className="hero-heading">Compile & Export Filter Lists</h2>
            <p className="hero-subtext">
              Fetches enabled filter feeds concurrently, parses Adblock & DNS rules, executes deduplication, and compiles clean outputs.
            </p>

            <div className="hero-meta-strip">
              <span className="meta-strip-item">
                Output Directory:
                <button
                  type="button"
                  className="output-path-pill"
                  onClick={handleRevealOutput}
                  title="Click to reveal file in Finder"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                  <span>{savePath || 'Not set'}</span>
                </button>
              </span>
            </div>
          </div>

          <div className="hero-action-col">
            <button
              className="primary-button hero-compile-btn"
              onClick={handleRunProcess}
              disabled={isLoading || dashboardStats.enabledSources === 0}
            >
              {isLoading ? (
                <>
                  <span className="loading-spinner" />
                  <span>Processing Rules…</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 01.359.852L12.982 9.75h7.268a.75.75 0 01.548 1.262l-10.5 11.25a.75.75 0 01-1.272-.71l1.992-7.302H3.75a.75.75 0 01-.548-1.262l10.5-11.25a.75.75 0 01.913-.143z" clipRule="evenodd" />
                  </svg>
                  <span>Run Processor</span>
                  <span className="btn-shortcut-hint">⌘R</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Progress Bar with Live Concurrency Status */}
        {isLoading && progress && (
          <div className="processing-progress-tray">
            <div className="progress-info-row">
              <span className="progress-status-text">{progress.status}</span>
              <span className="progress-percent-text">{progress.percent}%</span>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.max(5, Math.min(100, progress.percent))}%` }}
              />
            </div>
          </div>
        )}

        {/* Error Alert */}
        {error && (
          <div className="dashboard-alert error-banner">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Snapshot Summary Cards (Pre-run overview) */}
      <div className="overview-stats-grid">
        <div className="desktop-card summary-card">
          <div className="summary-icon-wrap icon-shield">🛡️</div>
          <div className="summary-data-col">
            <span className="summary-num">{dashboardStats.enabledSources}/{dashboardStats.totalSources}</span>
            <span className="summary-label">Active Sources</span>
          </div>
        </div>

        <div className="desktop-card summary-card">
          <div className="summary-icon-wrap icon-pencil">✍️</div>
          <div className="summary-data-col">
            <span className="summary-num">{dashboardStats.customRulesCount}</span>
            <span className="summary-label">Custom Rules</span>
          </div>
        </div>

        <div className="desktop-card summary-card">
          <div className="summary-icon-wrap icon-clock">🕒</div>
          <div className="summary-data-col">
            <span className="summary-num">{dashboardStats.lastProcessedTime ? dashboardStats.lastProcessedTime.split(',')[0] : 'Never'}</span>
            <span className="summary-label">Last Compilation</span>
          </div>
        </div>

        {ruleDeltaText && (
          <div className={`desktop-card summary-card delta-card ${isPositiveDelta ? 'pos' : 'neg'}`}>
            <div className="summary-icon-wrap">{isPositiveDelta ? '📈' : '📉'}</div>
            <div className="summary-data-col">
              <span className="summary-num delta-num">{isPositiveDelta ? 'Expanding' : 'Optimized'}</span>
              <span className="summary-label" title={ruleDeltaText}>{ruleDeltaText}</span>
            </div>
          </div>
        )}
      </div>

      {/* Detailed KPI Results & Visualizations */}
      {lastResult && lastResult.success ? (
        <div className="results-suite-container">
          {/* 4-Column Hero KPI Grid */}
          <div className="results-kpi-grid">
            <div className="desktop-card kpi-metric-card">
              <span className="kpi-metric-label">Total Ingested</span>
              <div className="kpi-metric-val">{lastResult.processedRuleCount.toLocaleString()}</div>
              <span className="kpi-metric-sub">Raw rules across feeds</span>
            </div>

            <div className="desktop-card kpi-metric-card highlight-kpi">
              <span className="kpi-metric-label">Unique Rules</span>
              <div className="kpi-metric-val">{lastResult.uniqueRuleCount.toLocaleString()}</div>
              <span className="kpi-metric-sub">Compiled output size</span>
            </div>

            <div className="desktop-card kpi-metric-card">
              <span className="kpi-metric-label">Blocking Rules</span>
              <div className="kpi-metric-val">
                {Math.max(0, lastResult.uniqueRuleCount - (lastResult.exceptionRuleCount || 0)).toLocaleString()}
              </div>
              <span className="kpi-metric-sub">Intercepted domains</span>
            </div>

            <div className="desktop-card kpi-metric-card">
              <span className="kpi-metric-label">Allowlist Exceptions</span>
              <div className="kpi-metric-val">{(lastResult.exceptionRuleCount || 0).toLocaleString()}</div>
              <span className="kpi-metric-sub">Unbreak exceptions (@@)</span>
            </div>
          </div>

          {/* Efficiency & Deduplication Bar */}
          {(() => {
            const duplicates = Math.max(0, lastResult.processedRuleCount - lastResult.uniqueRuleCount);
            const efficiency = lastResult.processedRuleCount > 0
              ? ((duplicates / lastResult.processedRuleCount) * 100).toFixed(2)
              : '0.00';
            const uniquePct = lastResult.processedRuleCount > 0
              ? ((lastResult.uniqueRuleCount / lastResult.processedRuleCount) * 100).toFixed(1)
              : '100';

            return (
              <div className="desktop-card deduplication-card">
                <div className="dedup-header">
                  <div>
                    <h3 className="dedup-title">Deduplication & Engine Efficiency</h3>
                    <p className="dedup-sub">
                      {duplicates.toLocaleString()} duplicate rules eliminated • {efficiency}% deduplication efficiency
                    </p>
                  </div>
                  <div className="dedup-rate-badge">{efficiency}% Saved</div>
                </div>

                <div className="segmented-progress-bar">
                  <div className="seg-fill seg-unique" style={{ width: `${uniquePct}%` }} title={`Unique Rules: ${uniquePct}%`} />
                  <div className="seg-fill seg-dupes" style={{ width: `${efficiency}%` }} title={`Duplicate Rules Purged: ${efficiency}%`} />
                </div>

                <div className="segmented-legend">
                  <span className="seg-legend-item"><span className="seg-swatch swatch-unique" /> Active Rules ({uniquePct}%)</span>
                  <span className="seg-legend-item"><span className="seg-swatch swatch-dupes" /> Purged Duplicates ({efficiency}%)</span>
                </div>
              </div>
            );
          })()}

          {/* Visualization Charts Grid */}
          <div className="analytics-charts-grid">
            {/* Donut Composition Chart */}
            <div className="desktop-card chart-panel-card">
              <h3 className="chart-panel-title">Rule Distribution</h3>
              <div className="donut-chart-container">
                <ResponsiveContainer width="100%" height={230}>
                  <PieChart>
                    <Pie
                      data={[
                        {
                          name: 'Blocking Rules',
                          value: Math.max(0, lastResult.uniqueRuleCount - (lastResult.exceptionRuleCount || 0)),
                        },
                        {
                          name: 'Allowlist Exceptions',
                          value: lastResult.exceptionRuleCount || 0,
                        },
                      ]}
                      cx="50%"
                      cy="50%"
                      innerRadius={65}
                      outerRadius={88}
                      paddingAngle={4}
                      dataKey="value"
                      stroke="none"
                    >
                      <Cell fill="#007aff" />
                      <Cell fill="#34c759" />
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: 'rgba(28, 28, 30, 0.95)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '12px',
                        backdropFilter: 'blur(10px)',
                      }}
                      formatter={(val: any) => [Number(val).toLocaleString(), 'Rules']}
                    />
                    <Legend
                      verticalAlign="bottom"
                      height={36}
                      formatter={(val: string) => (
                        <span style={{ color: 'var(--text-color)', fontSize: '12px', fontWeight: 500 }}>
                          {val}
                        </span>
                      )}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-center-metric">
                  <span className="center-metric-number">
                    {lastResult.uniqueRuleCount > 1000
                      ? `${(lastResult.uniqueRuleCount / 1000).toFixed(1)}k`
                      : lastResult.uniqueRuleCount}
                  </span>
                  <span className="center-metric-label">Active Rules</span>
                </div>
              </div>
            </div>

            {/* Ingested vs Deduplicated Bar Comparison */}
            <div className="desktop-card chart-panel-card">
              <h3 className="chart-panel-title">Ingested vs Output Comparison</h3>
              <div className="bar-chart-container">
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart
                    data={[
                      {
                        name: 'Ingested',
                        Rules: lastResult.processedRuleCount,
                        fill: '#8e8e93',
                      },
                      {
                        name: 'Compiled',
                        Rules: lastResult.uniqueRuleCount,
                        fill: '#007aff',
                      },
                    ]}
                    margin={{ top: 15, right: 15, left: 0, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.05)" vertical={false} />
                    <XAxis dataKey="name" stroke="var(--secondary-color)" fontSize={11} tickLine={false} />
                    <YAxis
                      stroke="var(--secondary-color)"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(val: number) => (val >= 1000 ? `${(val / 1000).toFixed(0)}k` : `${val}`)}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'rgba(28, 28, 30, 0.95)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '12px',
                        backdropFilter: 'blur(10px)',
                      }}
                      formatter={(val: any) => [Number(val).toLocaleString(), 'Rules']}
                    />
                    <Bar dataKey="Rules" radius={[4, 4, 0, 0]} maxBarSize={45}>
                      <Cell fill="#8e8e93" />
                      <Cell fill="#007aff" />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      ) : (
        !isLoading && (
          <div className="desktop-card initial-ready-state">
            <div className="ready-state-icon">
              <BrandLogo size={44} glow />
            </div>
            <h3 className="ready-state-title">Ready to Compile Blocklists</h3>
            <p className="ready-state-desc">
              Click <strong>Run Processor</strong> above or press <kbd className="shortcut-kbd">⌘R</kbd> to fetch all {dashboardStats.enabledSources} active sources and compile your unified filter lists concurrently.
            </p>
          </div>
        )
      )}
    </div>
  );
};
