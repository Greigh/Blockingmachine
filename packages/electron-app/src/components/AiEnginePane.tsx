/**
 * AiEnginePane — the AI provider, watchdog, radar-display, and harvest settings.
 *
 * This card used to live inside Settings.tsx because Settings was the app's
 * junk drawer; the five-section shell puts feature configuration where the
 * feature lives, so the AI engine moved to Discover's "AI engine" tab. The
 * state, load/save IPC calls, handlers, and JSX below are the Settings block
 * lifted verbatim — the pane is self-contained: it loads on mount and saves
 * through the same `window.electron` surface it always did.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { ElementHarvestSummary } from '../elementHarvest';
import type {
  AiProviderConfig,
  AiWatchdogConfig,
  RadarDisplayConfig,
} from '../types/';

export const AiEnginePane: React.FC = () => {
  const [secretStorageAvailable, setSecretStorageAvailable] = useState<boolean | null>(null);
  // AI & Threat Intelligence state
  const [aiConfig, setAiConfig] = useState<AiProviderConfig>({
    provider: 'mini-ai',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.2',
    apiKey: '',
    apiEndpoint: 'https://api.openai.com/v1',
    modelName: 'gpt-4o-mini',
    cascade: { enabled: false, maxEscalations: 25, escalateClean: false },
  });
  const [watchdogConfig, setWatchdogConfig] = useState<AiWatchdogConfig>({
    enabled: false,
    intervalMinutes: 60,
    service: 'adguard',
  });
  const [isSavingAi, setIsSavingAi] = useState(false);
  const [isTestingAi, setIsTestingAi] = useState(false);
  const [aiMessage, setAiMessage] = useState<{ text: string; type: 'success' | 'error' | null }>({ text: '', type: null });
  const [aiTestResult, setAiTestResult] = useState<{ success: boolean; latencyMs?: number; message: string } | null>(null);
  const [showAiKey, setShowAiKey] = useState(false);
  const [learnedFeedbackCount, setLearnedFeedbackCount] = useState<number>(0);
  const [shadowReadiness, setShadowReadiness] = useState<{
    days: number;
    scoredDomains: number;
    disagreementRecords: number;
    sampleRecords: number;
    dnsObservationRecords: number;
    liveIndexEntries: number;
    fanoutHosts: number;
    target: { minDays: number; minScored: number };
    ready: boolean;
  } | null>(null);
  const [userLabelStats, setUserLabelStats] = useState<{ count: number; filePath: string } | null>(null);
  const [radarDisplayConfig, setRadarDisplayConfig] = useState<RadarDisplayConfig>({
    showIgnoredOffenders: false,
  });
  const [elementHarvest, setElementHarvest] = useState<ElementHarvestSummary | null>(null);
  const [elementHarvestBusy, setElementHarvestBusy] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, []);

  const safeSetTimeout = (fn: () => void, delay: number) => {
    const id = setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== id);
      fn();
    }, delay);
    timersRef.current.push(id);
    return id;
  };

  useEffect(() => {
    let isMounted = true;

    if (window.electron?.getAiConfig) {
      window.electron.getAiConfig().then((cfg) => {
        if (isMounted && cfg) {
          setAiConfig((prev) => ({ ...prev, ...cfg }));
          if (typeof cfg.encryptionAvailable === 'boolean') setSecretStorageAvailable(cfg.encryptionAvailable);
        }
      }).catch(console.error);
    }

    if (window.electron?.getAiWatchdogConfig) {
      window.electron.getAiWatchdogConfig().then((wCfg) => {
        if (isMounted && wCfg) setWatchdogConfig((prev) => ({ ...prev, ...wCfg }));
      }).catch(console.error);
    }

    if (window.electron?.getMiniAiFeedbackStats) {
      window.electron.getMiniAiFeedbackStats().then((stats) => {
        if (isMounted && stats) setLearnedFeedbackCount(stats.count || 0);
      }).catch(console.error);
    }

    if (window.electron?.getAiShadowReadiness) {
      window.electron.getAiShadowReadiness().then((r) => {
        if (isMounted && r) setShadowReadiness(r);
      }).catch(console.error);
    }

    if (window.electron?.getUserLabelStats) {
      window.electron.getUserLabelStats().then((s) => {
        if (isMounted && s) setUserLabelStats(s);
      }).catch(console.error);
    }

    if (window.electron?.getRadarDisplayConfig) {
      window.electron.getRadarDisplayConfig().then((cfg) => {
        if (isMounted && cfg) setRadarDisplayConfig((prev) => ({ ...prev, ...cfg }));
      }).catch(console.error);
    }

    if (window.electron?.getElementHarvest) {
      window.electron.getElementHarvest().then((summary) => {
        if (isMounted && summary) setElementHarvest(summary);
      }).catch(console.error);
    }
    return () => {
      isMounted = false;
    };
  }, []);

  const handleSaveAiSettings = async () => {
    setIsSavingAi(true);
    setAiMessage({ text: '', type: null });
    try {
      if (window.electron?.setAiConfig) {
        await window.electron.setAiConfig(aiConfig);
      }
      if (window.electron?.setAiWatchdogConfig) {
        await window.electron.setAiWatchdogConfig(watchdogConfig);
      }
      setAiMessage({ text: 'AI engine & Sentinel Watchdog settings saved successfully!', type: 'success' });
      safeSetTimeout(() => setAiMessage({ text: '', type: null }), 3500);
    } catch (err: any) {
      console.error('Failed to save AI settings:', err);
      setAiMessage({ text: err?.message || 'Failed to save AI configuration.', type: 'error' });
    } finally {
      setIsSavingAi(false);
    }
  };

  const handleTestAiConnection = async () => {
    setIsTestingAi(true);
    setAiTestResult(null);
    try {
      if (window.electron?.testAiConnection) {
        const res = await window.electron.testAiConnection(aiConfig);
        setAiTestResult(res);
      }
    } catch (err: any) {
      setAiTestResult({
        success: false,
        message: err?.message || 'Connection test failed',
      });
    } finally {
      setIsTestingAi(false);
    }
  };

  const handleToggleShowIgnoredOffenders = async (enabled: boolean) => {
    setRadarDisplayConfig((prev) => ({ ...prev, showIgnoredOffenders: enabled }));
    if (window.electron?.setRadarDisplayConfig) {
      try {
        await window.electron.setRadarDisplayConfig({ showIgnoredOffenders: enabled });
        setAiMessage({
          text: enabled
            ? 'Ignored offenders now shown inline in Top Repeat Offenders.'
            : 'Ignored offenders moved back into the collapsed Ignored section.',
          type: 'success',
        });
        safeSetTimeout(() => setAiMessage({ text: '', type: null }), 3000);
      } catch (err: any) {
        console.error('Failed to set radar display config:', err);
        setAiMessage({ text: err?.message || 'Failed to save radar display preference.', type: 'error' });
      }
    }
  };

  const refreshElementHarvest = async () => {
    if (window.electron?.getElementHarvest) {
      const summary = await window.electron.getElementHarvest();
      if (summary) setElementHarvest(summary);
    }
  };

  const handleChooseElementHarvest = async () => {
    if (!window.electron?.selectElementHarvest) return;
    setElementHarvestBusy(true);
    try {
      await window.electron.selectElementHarvest();
      await refreshElementHarvest();
    } catch (err: any) {
      setAiMessage({ text: err?.message || 'Failed to read the harvest file.', type: 'error' });
    } finally {
      setElementHarvestBusy(false);
    }
  };

  const handleClearElementHarvest = async () => {
    if (!window.electron?.clearElementHarvest) return;
    setElementHarvestBusy(true);
    try {
      await window.electron.clearElementHarvest();
      await refreshElementHarvest();
      setAiMessage({ text: 'Element harvest forgotten and deleted.', type: 'success' });
      safeSetTimeout(() => setAiMessage({ text: '', type: null }), 3000);
    } catch (err: any) {
      setAiMessage({ text: err?.message || 'Failed to clear the harvest.', type: 'error' });
    } finally {
      setElementHarvestBusy(false);
    }
  };

  const handleResetAiFeedback = async () => {
    if (!window.electron?.tuneMiniAiFeedback) return;
    try {
      await window.electron.tuneMiniAiFeedback('', 'reset');
      setLearnedFeedbackCount(0);
      setAiMessage({ text: 'Mini-AI learned feedback database reset successfully.', type: 'success' });
      safeSetTimeout(() => setAiMessage({ text: '', type: null }), 3000);
    } catch (err: any) {
      setAiMessage({ text: err?.message || 'Failed to reset feedback.', type: 'error' });
    }
  };

  return (
    <div className="ai-engine-pane">
        <div className="setting-card">
          <div className="setting-card-header">
            <h2>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                </svg>
              </span>
              AI & Threat Intelligence Engine
            </h2>
            <span className="setting-badge primary">Intelligence</span>
          </div>
          <p>
            Configure on-device neural classification, local LLMs, or cloud AI providers to detect algorithmic ad trackers, cloaked CNAMEs, and anomalous queries.
          </p>

          {/* Provider Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px', marginTop: '14px', marginBottom: '14px' }}>
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
                  <line x1="9" y1="2" x2="9" y2="4" />
                  <line x1="15" y1="2" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="22" />
                  <line x1="15" y1="20" x2="15" y2="22" />
                  <line x1="2" y1="9" x2="4" y2="9" />
                  <line x1="2" y1="14" x2="4" y2="14" />
                  <line x1="20" y1="9" x2="22" y2="9" />
                  <line x1="20" y1="14" x2="22" y2="14" />
                </svg>
                <span>Mini-AI Classifier (Built-in)</span>
              </span>
              <span className="opt-desc">Embedded 25-feature mathematical neural network. &lt;0.05ms execution, zero daemons, zero network calls.</span>
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
              <span className="opt-desc">Shannon entropy, lexical token boundaries, and CNAME uncloaking. 0ms latency, pure offline math.</span>
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
              <span className="opt-desc">Private on-device large language model (e.g. llama3.2). Highly accurate reasoning without cloud telemetry.</span>
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
              <span className="opt-desc">Gemini 2.0 Flash reasoning for deep pattern synthesis and evasive ad script detection.</span>
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
              <span className="opt-desc">OpenAI, Groq, LM Studio, Mistral, or any standard OpenAI-compatible API endpoint.</span>
            </button>
          </div>

          {/* Subform for selected provider */}
          <div style={{ background: 'var(--overlay-1)', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color)', marginBottom: '14px' }}>
            {aiConfig.provider === 'mini-ai' && (
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-color)', marginBottom: '4px' }}>
                  Built-in Embedded Mini-AI Active
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--secondary-color)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
                  The Mini-AI classifier extracts 25 domain features (Shannon entropy, consonant clustering, hex string density, brand squatting, vowel ratios) directly on your device without sending any data over the network.
                </p>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--overlay-2)', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                  <span style={{ fontSize: '0.78rem' }}>
                    Learned Feedback Corrections: <strong>{learnedFeedbackCount}</strong> {learnedFeedbackCount === 1 ? 'entry' : 'entries'} stored
                  </span>
                  {learnedFeedbackCount > 0 && (
                    <button
                      type="button"
                      className="browse-button secondary"
                      style={{ padding: '3px 8px', fontSize: '0.72rem', height: '24px' }}
                      onClick={handleResetAiFeedback}
                    >
                      Reset Learned Memory
                    </button>
                  )}
                </div>

                {shadowReadiness && (
                  <div className="v3-readiness">
                    <div className="v3-readiness-head">
                      <span className="v3-readiness-title">v3 training evidence</span>
                      <span className={`setting-badge ${shadowReadiness.ready ? 'success' : 'warning'}`}>
                        {shadowReadiness.ready ? 'Ready to evaluate' : 'Collecting'}
                      </span>
                    </div>
                    <div className="v3-progress-row">
                      <span className="v3-progress-label">Days of traffic</span>
                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.min(100, (shadowReadiness.days / shadowReadiness.target.minDays) * 100)}%` }}
                        />
                      </div>
                      <span className="v3-progress-count">
                        {shadowReadiness.days}/{shadowReadiness.target.minDays}
                      </span>
                    </div>
                    <div className="v3-progress-row">
                      <span className="v3-progress-label">Domains scored</span>
                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.min(100, (shadowReadiness.scoredDomains / shadowReadiness.target.minScored) * 100)}%` }}
                        />
                      </div>
                      <span className="v3-progress-count">
                        {shadowReadiness.scoredDomains.toLocaleString()}/{shadowReadiness.target.minScored.toLocaleString()}
                      </span>
                    </div>
                    <p className="v3-readiness-sources">
                      Sources: {shadowReadiness.dnsObservationRecords.toLocaleString()} DNS observations ·{' '}
                      {shadowReadiness.fanoutHosts.toLocaleString()} browser-tracked hosts ·{' '}
                      {shadowReadiness.liveIndexEntries.toLocaleString()} live in classifier ·{' '}
                      {shadowReadiness.disagreementRecords.toLocaleString()} disagreements ·{' '}
                      {shadowReadiness.sampleRecords.toLocaleString()} samples
                    </p>
                    {userLabelStats && (
                      <p className="v3-readiness-sources">
                        Labels: {userLabelStats.count.toLocaleString()} of your Confirm-Threat / Mark-Safe corrections recorded — merged into labels.db at the next training run (<code>user-labels.jsonl</code>).
                      </p>
                    )}
                    <p className="v3-readiness-note">
                      “Ready” means enough real traffic exists to evaluate a v3 model — promotion still has to pass the precision gate.
                    </p>
                  </div>
                )}
              </div>
            )}

            {aiConfig.provider === 'local-heuristics' && (
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-color)', marginBottom: '4px' }}>
                  Mathematical Heuristics Engine Active
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--secondary-color)', margin: 0, lineHeight: 1.4 }}>
                  Evaluates target domains using algorithmic Shannon entropy analysis, subdomain depth thresholds, top-level domain risk scoring, and asynchronous CNAME resolution.
                </p>
              </div>
            )}

            {aiConfig.provider === 'ollama' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>Model Presets:</span>
                  {['llama3.2', 'mistral', 'qwen2.5', 'deepseek-r1'].map((m) => (
                    <button
                      key={m}
                      type="button"
                      style={{ background: 'var(--overlay-2)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                      onClick={() => setAiConfig({ ...aiConfig, ollamaModel: m })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label className="field-label">Ollama Host URL</label>
                    <input
                      type="text"
                      className="path-input"

                      value={aiConfig.ollamaUrl || 'http://127.0.0.1:11434'}
                      onChange={(e) => setAiConfig({ ...aiConfig, ollamaUrl: e.target.value })}
                      placeholder="http://127.0.0.1:11434"
                    />
                  </div>
                  <div>
                    <label className="field-label">Model Name</label>
                    <input
                      type="text"
                      className="path-input"

                      value={aiConfig.ollamaModel || 'llama3.2'}
                      onChange={(e) => setAiConfig({ ...aiConfig, ollamaModel: e.target.value })}
                      placeholder="llama3.2"
                    />
                  </div>
                </div>
              </div>
            )}

            {aiConfig.provider === 'gemini' && (
              <div>
                <div className="field-label-row">
                  <label className="field-label" style={{ marginBottom: 0 }}>Google Gemini API Key</label>
                  <button
                    type="button"
                    className="secret-toggle-btn"
                    onClick={() => setShowAiKey(!showAiKey)}
                  >
                    {showAiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <input
                  type={showAiKey ? 'text' : 'password'}
                  className="path-input"

                  value={aiConfig.apiKey || ''}
                  onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
                  placeholder={aiConfig.apiKeySet ? `Configured ${aiConfig.apiKeyHint} — enter to replace` : 'AIzaSy...'}
                />
              </div>
            )}

            {aiConfig.provider === 'openai' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>Presets:</span>
                  <button
                    type="button"
                    style={{ background: 'var(--overlay-2)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                    onClick={() => setAiConfig({ ...aiConfig, apiEndpoint: 'https://api.openai.com/v1', modelName: 'gpt-4o-mini' })}
                  >
                    OpenAI (gpt-4o-mini)
                  </button>
                  <button
                    type="button"
                    style={{ background: 'var(--overlay-2)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                    onClick={() => setAiConfig({ ...aiConfig, apiEndpoint: 'https://api.groq.com/openai/v1', modelName: 'llama-3.3-70b-versatile' })}
                  >
                    Groq (Llama 3.3 70B)
                  </button>
                  <button
                    type="button"
                    style={{ background: 'var(--overlay-2)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                    onClick={() => setAiConfig({ ...aiConfig, apiEndpoint: 'http://localhost:1234/v1', modelName: 'local-model' })}
                  >
                    LM Studio (Local 1234)
                  </button>
                  <button
                    type="button"
                    style={{ background: 'var(--overlay-2)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                    onClick={() => setAiConfig({ ...aiConfig, apiEndpoint: 'https://openrouter.ai/api/v1', modelName: 'meta-llama/llama-3.2-3b-instruct' })}
                  >
                    OpenRouter
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '12px', marginBottom: '10px' }}>
                  <div>
                    <label className="field-label">API Endpoint URL</label>
                    <input
                      type="text"
                      className="path-input"

                      value={aiConfig.apiEndpoint || 'https://api.openai.com/v1'}
                      onChange={(e) => setAiConfig({ ...aiConfig, apiEndpoint: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div>
                    <label className="field-label">Model Name</label>
                    <input
                      type="text"
                      className="path-input"

                      value={aiConfig.modelName || 'gpt-4o-mini'}
                      onChange={(e) => setAiConfig({ ...aiConfig, modelName: e.target.value })}
                      placeholder="gpt-4o-mini"
                    />
                  </div>
                </div>
                <div>
                  <div className="field-label-row">
                    <label className="field-label" style={{ marginBottom: 0 }}>API Key</label>
                    <button
                      type="button"
                      className="secret-toggle-btn"
                      onClick={() => setShowAiKey(!showAiKey)}
                    >
                      {showAiKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <input
                    type={showAiKey ? 'text' : 'password'}
                    className="path-input"

                    value={aiConfig.apiKey || ''}
                    onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
                    placeholder={aiConfig.apiKeySet ? `Configured ${aiConfig.apiKeyHint} — enter to replace` : 'sk-...'}
                  />
                  {secretStorageAvailable === false && (
                    <p className="setting-message error" role="alert" style={{ marginTop: '6px' }}>
                      OS keychain encryption is unavailable — this key is stored as plaintext on disk.
                    </p>
                  )}
                </div>
              </div>
            )}

            {aiTestResult && (
              <div className={`test-result ${aiTestResult.success ? 'ok' : 'err'}`} style={{ marginTop: '10px' }}>
                <strong>{aiTestResult.success ? '✓' : '✗'} {aiTestResult.message}</strong> {aiTestResult.latencyMs ? `(${aiTestResult.latencyMs}ms)` : ''}
              </div>
            )}
          </div>

          {/* Triage Cascade — local screening with a bounded escalation budget */}
          <div style={{ background: 'var(--overlay-1)', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color)', marginBottom: '14px' }}>
            <div className="sinkhole-panel-header">
              <div style={{ fontWeight: 600, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 5h18M6 12h12M10 19h4" />
                </svg>
                <span>Triage Cascade</span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                <input
                  type="checkbox"
                  checked={aiConfig.cascade?.enabled === true}
                  onChange={(e) =>
                    setAiConfig({
                      ...aiConfig,
                      cascade: {
                        maxEscalations: 25,
                        escalateClean: false,
                        ...(aiConfig.cascade || {}),
                        enabled: e.target.checked,
                      },
                    })
                  }
                />
                <span>Screen locally first</span>
              </label>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--secondary-color)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
              The embedded classifier screens every candidate first — it costs nothing per lookup — and only the ones it genuinely cannot decide are sent to the provider above. Without this, the selected provider evaluates <em>everything</em>, which is what makes model-assisted blocking expensive.
            </p>

            {aiConfig.cascade?.enabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label className="field-label">Model calls per scan</label>
                  <input
                    type="number"
                    className="path-input"

                    min={0}
                    value={aiConfig.cascade?.maxEscalations ?? 25}
                    onChange={(e) =>
                      setAiConfig({
                        ...aiConfig,
                        cascade: {
                          enabled: true,
                          escalateClean: aiConfig.cascade?.escalateClean === true,
                          ...(aiConfig.cascade || {}),
                          maxEscalations: Math.max(0, parseInt(e.target.value, 10) || 0),
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <label className="field-label">Clean-traffic discovery</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem', height: '34px' }}>
                    <input
                      type="checkbox"
                      checked={aiConfig.cascade?.escalateClean === true}
                      onChange={(e) =>
                        setAiConfig({
                          ...aiConfig,
                          cascade: {
                            enabled: true,
                            maxEscalations: aiConfig.cascade?.maxEscalations ?? 25,
                            ...(aiConfig.cascade || {}),
                            escalateClean: e.target.checked,
                          },
                        })
                      }
                    />
                    <span>Also escalate uncertain <em>clean</em> verdicts</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Sentinel Watchdog Automation */}
          <div style={{ background: 'var(--overlay-1)', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color)', marginBottom: '14px' }}>
            <div className="sinkhole-panel-header">
              <div style={{ fontWeight: 600, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span>Sentinel Watchdog (Background Threat Sweep)</span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                <input
                  type="checkbox"
                  checked={watchdogConfig.enabled}
                  onChange={(e) => setWatchdogConfig({ ...watchdogConfig, enabled: e.target.checked })}
                />
                <span>Enable Watchdog</span>
              </label>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--secondary-color)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
              Periodically queries your local sinkhole query logs in the background, flags emerging ad/tracker hostnames with the selected AI engine, and records them in the Quarantine Ledger.
            </p>

            {watchdogConfig.enabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label htmlFor="watchdogInterval" style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Sweep Interval</label>
                  <select
                    id="watchdogInterval"
                    className="styled-select"

                    value={watchdogConfig.intervalMinutes}
                    onChange={(e) => setWatchdogConfig({ ...watchdogConfig, intervalMinutes: parseInt(e.target.value, 10) || 60 })}
                  >
                    <option value={15}>Every 15 Minutes</option>
                    <option value={30}>Every 30 Minutes</option>
                    <option value={60}>Every 1 Hour</option>
                    <option value={120}>Every 2 Hours</option>
                    <option value={360}>Every 6 Hours</option>
                    <option value={720}>Every 12 Hours</option>
                    <option value={1440}>Every 24 Hours</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="watchdogService" style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Sinkhole Query Target</label>
                  <select
                    id="watchdogService"
                    className="styled-select"

                    value={watchdogConfig.service}
                    onChange={(e) => setWatchdogConfig({ ...watchdogConfig, service: e.target.value as 'adguard' | 'pihole' })}
                  >
                    <option value="adguard">AdGuard Home</option>
                    <option value="pihole">Pi-hole</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Radar Display Preferences */}
          <div style={{ background: 'var(--overlay-1)', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color)', marginBottom: '14px' }}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '4px' }}>
              AI Radar Display
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--secondary-color)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
              Browsing aids for the AI Radar's Top Repeat Offenders card. Ignoring is not trusting: ignored offenders stay hidden without any allowlist rule.
            </p>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer', fontSize: '0.78rem', lineHeight: 1.4 }}>
              <input
                type="checkbox"
                checked={radarDisplayConfig.showIgnoredOffenders}
                onChange={(e) => handleToggleShowIgnoredOffenders(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: 'var(--primary-color)', marginTop: 2 }}
              />
              <span>
                <strong>Show ignored offenders inline</strong>
                <span style={{ display: 'block', opacity: 0.75, fontSize: '0.72rem' }}>
                  List ignored offenders (and their frozen heat) directly in the Top Repeat Offenders table instead of the collapsed Ignored section. Takes effect immediately, even with a Radar view already open.
                </span>
              </span>
            </label>
          </div>

          {/* Element Corpus Harvest */}
          <div style={{ background: 'var(--overlay-1)', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color)', marginBottom: '14px' }}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '4px' }}>
              Element Corpus Harvest
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--secondary-color)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
              The browser extension captures real page elements when you scan or act on one — the only source of corpus cases the hand-written set is missing. Export it from the extension popup, then point the hub at the file here so <code>npm run harvest:elements</code> can review it.
            </p>
            {elementHarvest?.path ? (
              elementHarvest.present ? (
                <>
                  <div style={{ fontSize: '0.78rem', lineHeight: 1.6, marginBottom: '10px' }}>
                    <div><strong>{elementHarvest.records.toLocaleString()}</strong> records across <strong>{elementHarvest.hosts.toLocaleString()}</strong> hosts{elementHarvest.rejected > 0 ? ` · ${elementHarvest.rejected.toLocaleString()} unreadable` : ''}</div>
                    <div><strong>{elementHarvest.labelled.toLocaleString()}</strong> carry your decisions{elementHarvest.wouldQueue > 0 ? ` · ${elementHarvest.wouldQueue.toLocaleString()} would queue as corpus candidates` : ''}</div>
                    {elementHarvest.newest && (
                      <div style={{ opacity: 0.7, fontSize: '0.72rem' }}>Newest capture {new Date(elementHarvest.newest).toLocaleString()}</div>
                    )}
                    <div style={{ opacity: 0.7, fontSize: '0.72rem', wordBreak: 'break-all' }}>{elementHarvest.path}</div>
                  </div>
                </>
              ) : (
                <p style={{ fontSize: '0.78rem', color: 'var(--danger-color, #ff6b6b)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
                  The chosen file is gone: <span style={{ wordBreak: 'break-all' }}>{elementHarvest.path}</span>
                </p>
              )
            ) : (
              <p style={{ fontSize: '0.78rem', color: 'var(--secondary-color)', margin: '0 0 10px 0', lineHeight: 1.4, opacity: 0.8 }}>
                No harvest file chosen yet.
              </p>
            )}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="browse-button secondary"
                onClick={handleChooseElementHarvest}
                disabled={elementHarvestBusy}
              >
                {elementHarvestBusy ? 'Working…' : elementHarvest?.path ? 'Choose a different harvest…' : 'Choose harvest file…'}
              </button>
              {elementHarvest?.path && (
                <button
                  type="button"
                  className="browse-button secondary"
                  onClick={handleClearElementHarvest}
                  disabled={elementHarvestBusy}
                  title="Forget this file and delete it — withdrawing what was collected should not require finding it first"
                >
                  Forget &amp; delete
                </button>
              )}
            </div>
          </div>

          {/* Action Footer */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
            <button
              type="button"
              className="browse-button secondary"
              onClick={handleTestAiConnection}
              disabled={isTestingAi}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
              <span>{isTestingAi ? 'Testing Connection...' : 'Test AI Connection'}</span>
            </button>

            <button
              type="button"
              className="browse-button"
              onClick={handleSaveAiSettings}
              disabled={isSavingAi}
            >
              {isSavingAi ? 'Saving...' : 'Save AI Settings'}
            </button>
          </div>

          {aiMessage.text && (
            <p className={`setting-message ${aiMessage.type}`} role={aiMessage.type === 'error' ? 'alert' : 'status'} style={{ marginTop: '10px' }}>
              {aiMessage.text}
            </p>
          )}
        </div>
    </div>
  );
};
