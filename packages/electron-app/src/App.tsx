import React, { useState, useEffect, useCallback, useRef } from 'react';
import Settings from './Settings';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { DashboardView } from './views/DashboardView';
import { SourcesView } from './views/SourcesView';
import { BulkImportView } from './views/BulkImportView';
import { CustomRulesView } from './views/CustomRulesView';
import { RuleInspectorView } from './views/RuleInspectorView';
import { RuleBrowserView } from './views/RuleBrowserView';
import { OnboardingModal, type OnboardingConfig } from './views/OnboardingModal';
import { PRESET_BUNDLES } from './views/PresetsModal';
import type { FilterSource, ThemeType } from './types/';
import { applyTheme, applyAccentColor } from './theme';
import './index.css';

// --- External Link Helper Function ---
const handleExternalLink = async (
  e: React.MouseEvent<HTMLAnchorElement, MouseEvent>,
  url: string
) => {
  e.preventDefault();
  try {
    await window.electron.openExternal(url);
  } catch (error) {
    console.error('Failed to open link:', error);
  }
};

function App() {
  const [currentView, setCurrentView] = useState('process');
  const [selectedTheme, setSelectedTheme] = useState<ThemeType>('system');
  const [isThemeLoading, setIsThemeLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sources, setSources] = useState<FilterSource[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalSuccessMessage, setGlobalSuccessMessage] = useState<string | null>(null);
  const [savePath, setSavePath] = useState<string>('');
  const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bm-onboarding-completed') !== 'true';
    } catch {
      return false;
    }
  });
  const [autoTriggerCompile, setAutoTriggerCompile] = useState<boolean>(false);

  useEffect(() => {
    window.electron.getSavePath().then(setSavePath);
  }, [currentView]);

  const memoizedApplyTheme = useCallback(applyTheme, []);

  // Theme synchronization on mount
  useEffect(() => {
    let isMounted = true;
    const loadAndApplyTheme = async () => {
      try {
        const storedTheme = (await window.electron.getTheme()) as ThemeType;
        if (isMounted) {
          setSelectedTheme(storedTheme);
          memoizedApplyTheme(storedTheme);
        }
      } catch {
        if (isMounted) memoizedApplyTheme('system');
      } finally {
        if (isMounted) setIsThemeLoading(false);
      }
    };
    loadAndApplyTheme();

    try {
      const savedAccent = localStorage.getItem('bm-accent-color') || 'blue';
      applyAccentColor(savedAccent);
    } catch {}

    return () => {
      isMounted = false;
    };
  }, [memoizedApplyTheme]);

  const handleThemeChange = useCallback(
    async (newTheme: ThemeType) => {
      setSelectedTheme(newTheme);
      memoizedApplyTheme(newTheme);
      try {
        await window.electron.setTheme(newTheme);
      } catch (error) {
        console.error('Failed to set theme:', error);
      }
    },
    [memoizedApplyTheme]
  );

  // Load sources on mount
  useEffect(() => {
    let isMounted = true;
    const loadSources = async () => {
      try {
        const loadedSources = await window.electron.getSources();
        if (isMounted) {
          setSources(loadedSources || []);
        }
      } catch (err) {
        console.error('Failed to load sources:', err);
        if (isMounted) {
          setGlobalError(
            err instanceof Error ? err.message : 'Failed to load sources.'
          );
        }
      }
    };
    loadSources();
    return () => {
      isMounted = false;
    };
  }, []);

  // Clear global messages automatically
  useEffect(() => {
    if (globalSuccessMessage || globalError) {
      const timer = setTimeout(() => {
        setGlobalSuccessMessage(null);
        setGlobalError(null);
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [globalSuccessMessage, globalError]);

  const saveSources = useCallback(
    async (updatedSources: FilterSource[], successMsg?: string) => {
      setGlobalError(null);
      setGlobalSuccessMessage(null);
      try {
        const result = await window.electron.saveSources(updatedSources);
        if (!result.success) {
          throw new Error(result.error || 'Unknown error saving sources');
        }
        setSources(updatedSources);
        if (successMsg) {
          setGlobalSuccessMessage(successMsg);
        }
      } catch (err) {
        console.error('Failed to save sources:', err);
        const errorMsg =
          err instanceof Error ? err.message : 'Failed to save sources.';
        setGlobalError(errorMsg);
        throw err;
      }
    },
    []
  );

  const handleOnboardingComplete = async (config: OnboardingConfig) => {
    try {
      localStorage.setItem('bm-onboarding-completed', 'true');
    } catch {}

    setIsOnboardingOpen(false);

    // 1. If a starter bundle was selected, subscribe its feeds
    if (config.selectedBundleId) {
      const bundle = PRESET_BUNDLES.find((b) => b.id === config.selectedBundleId);
      if (bundle) {
        const existingUrls = new Set(sources.map((s) => s.url.trim().toLowerCase()));
        const toAdd = bundle.items
          .filter((item) => !existingUrls.has(item.url.trim().toLowerCase()))
          .map((item) => ({
            name: item.name,
            url: item.url,
            enabled: true,
          }));

        if (toAdd.length > 0) {
          const merged = [...sources, ...toAdd];
          try {
            await saveSources(
              merged,
              `Subscribed to ${bundle.name} (${toAdd.length} feeds).`,
            );
          } catch (err) {
            console.error('Failed to subscribe starter pack:', err);
          }
        }
      }
    }

    // 2. Set export format if configured
    if (config.exportFormat) {
      try {
        await window.electron.setExportFormat(config.exportFormat);
      } catch (err) {
        console.error('Failed to set export format:', err);
      }
    }

    // 3. Set accent color
    if (config.accentColor) {
      applyAccentColor(config.accentColor);
    }

    // 4. Trigger initial compilation if requested
    if (config.shouldCompileImmediately) {
      setCurrentView('process');
      setAutoTriggerCompile(true);
      setTimeout(() => setAutoTriggerCompile(false), 1500);
    }
  };

  // ResizeObserver for window dimensions
  useEffect(() => {
    const containerElement = containerRef.current;
    if (!containerElement) return;

    let resizeTimeout: NodeJS.Timeout | null = null;
    const observer = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const width = containerElement.offsetWidth;
      const height = containerElement.offsetHeight;

      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (window.electron && typeof window.electron.notifyResize === 'function') {
          window.electron.notifyResize(width, height);
        }
      }, 100);
    });

    observer.observe(containerElement);
    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      observer.disconnect();
    };
  }, []);

  // Global Keyboard Shortcuts (Cmd+1..6, Cmd+,)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '1') {
          e.preventDefault();
          setCurrentView('process');
        } else if (e.key === '2') {
          e.preventDefault();
          setCurrentView('sources');
        } else if (e.key === '3') {
          e.preventDefault();
          setCurrentView('bulkImport');
        } else if (e.key === '4') {
          e.preventDefault();
          setCurrentView('custom');
        } else if (e.key === '5') {
          e.preventDefault();
          setCurrentView('inspector');
        } else if (e.key === '6') {
          e.preventDefault();
          setCurrentView('browser');
        } else if (e.key === ',') {
          e.preventDefault();
          setCurrentView('settings');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Listen for native IPC open-settings and update notifications
  useEffect(() => {
    let cleanupSettings: (() => void) | undefined;
    let cleanupUpdate: (() => void) | undefined;
    let cleanupCompile: (() => void) | undefined;

    if (window.electron?.onOpenSettings) {
      cleanupSettings = window.electron.onOpenSettings(() => {
        setCurrentView('settings');
      });
    }

    if (window.electron?.onTriggerCompile) {
      cleanupCompile = window.electron.onTriggerCompile(() => {
        setCurrentView('process');
      });
    }

    if (window.electron?.onUpdateAvailable) {
      cleanupUpdate = window.electron.onUpdateAvailable(() => {
        setUpdateAvailable(true);
      });
    }

    return () => {
      cleanupSettings?.();
      cleanupUpdate?.();
      cleanupCompile?.();
    };
  }, []);

  const handleRevealOutputFolder = () => {
    if (savePath) {
      window.electron.showItemInFolder(savePath);
    }
  };

  if (isThemeLoading) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        Loading application...
      </div>
    );
  }

  return (
    <div className="app-shell" ref={containerRef}>
      {/* Native macOS Sidebar */}
      <Sidebar
        currentView={currentView}
        setCurrentView={setCurrentView}
        enabledSourcesCount={sources.filter((s) => s.enabled).length}
        totalSourcesCount={sources.length}
        updateAvailable={updateAvailable}
        handleExternalLink={handleExternalLink}
        onLaunchOnboarding={() => setIsOnboardingOpen(true)}
      />

      {/* Main Workspace Pane */}
      <main className="app-main-pane">
        <Header
          currentView={currentView}
          savePath={savePath}
          handleRevealOutputFolder={handleRevealOutputFolder}
        />

        <div className="main-content-scroll">
          {globalError && (
            <div className="dashboard-alert error-banner">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <span>{globalError}</span>
            </div>
          )}

          {globalSuccessMessage && (
            <div className="dashboard-alert success-banner">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{globalSuccessMessage}</span>
            </div>
          )}

          {currentView === 'process' && (
            <DashboardView
              savePath={savePath}
              autoTriggerCompile={autoTriggerCompile}
            />
          )}
          {currentView === 'sources' && (
            <SourcesView
              sources={sources}
              saveSources={saveSources}
              setError={setGlobalError}
              setSuccessMessage={setGlobalSuccessMessage}
            />
          )}
          {currentView === 'bulkImport' && (
            <BulkImportView
              currentSources={sources}
              saveSources={saveSources}
              setError={setGlobalError}
              setSuccessMessage={setGlobalSuccessMessage}
            />
          )}
          {currentView === 'custom' && (
            <CustomRulesView
              setError={setGlobalError}
              setSuccessMessage={setGlobalSuccessMessage}
            />
          )}
          {currentView === 'inspector' && <RuleInspectorView />}
          {currentView === 'browser' && (
            <RuleBrowserView
              onTriggerCompile={() => setCurrentView('process')}
            />
          )}
          {currentView === 'settings' && (
            <Settings
              currentTheme={selectedTheme}
              onThemeChange={handleThemeChange}
              onLaunchOnboarding={() => setIsOnboardingOpen(true)}
            />
          )}
        </div>
      </main>

      {/* Interactive First-Launch & Replay Onboarding Modal */}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        currentSources={sources}
        onComplete={handleOnboardingComplete}
      />
    </div>
  );
}

export default App;
