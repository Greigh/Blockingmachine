import React, { useState, useEffect, useCallback, useRef } from 'react';
import Settings from './Settings';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { HomeView } from './views/HomeView';
import { RulesView } from './views/RulesView';
import { DiscoverView } from './views/DiscoverView';
import { DistributeView } from './views/DistributeView';
import { DEFAULT_ROUTE, routeForViewName, SECTIONS, type AppRoute, type SectionId } from './routes';
import { OnboardingModal, type OnboardingConfig } from './views/OnboardingModal';
import { PRESET_BUNDLES } from './views/PresetsModal';
import type { FilterSource, ThemeType, LiveRadarSession } from './types/';
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
  const [route, setRoute] = useState<AppRoute>(DEFAULT_ROUTE);
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
  // Bumped by every compile trigger (IPC, in-app buttons, onboarding) and cleared
  // when HomeView consumes it — a pending trigger survives view switches but a
  // consumed one cannot re-fire on remount. The one channel; no boolean parallel.
  const [compileNonce, setCompileNonce] = useState<number>(0);
  // The 'bulkImport' deep link wants Rules › feeds opened in bulk mode — a
  // one-shot armed value, consumed and cleared by RulesView like compileNonce.
  const [feedsInitialTab, setFeedsInitialTab] = useState<'bulk' | null>(null);
  const [liveRadarSession, setLiveRadarSession] = useState<LiveRadarSession | null>(null);
  // Drawer-mode sidebar (≤460px effective width): opened via the header menu
  // button, dismissed by item selection, backdrop click, or Escape.
  const [navOpen, setNavOpen] = useState<boolean>(false);

  const navigate = useCallback((r: AppRoute) => {
    setRoute(r);
    setNavOpen(false);
    // One-shot deep-link residue: only the 'bulkImport' wire name re-arms it.
    setFeedsInitialTab(null);
  }, []);

  const selectSection = useCallback(
    (id: SectionId) =>
      // Re-clicking the active section keeps its tab — route.tab must track the
      // panel on screen or the header title and tab-* classes would desync.
      navigate({ section: id, tab: id === route.section ? route.tab : null }),
    [navigate, route],
  );
  // Stable drawer callbacks — a fresh arrow each render would re-run
  // useDialogFocus and yank focus out of the open drawer on any App update.
  const closeNav = useCallback(() => setNavOpen(false), []);
  const openNav = useCallback(() => setNavOpen(true), []);

  useEffect(() => {
    if (window.electron?.getLiveRadarSession) {
      window.electron.getLiveRadarSession().then((session) => {
        if (session) setLiveRadarSession(session);
      });
    }

    if (window.electron?.onLiveRadarSessionUpdate) {
      const unsubscribe = window.electron.onLiveRadarSessionUpdate((session) => {
        setLiveRadarSession(session);
      });
      return () => {
        unsubscribe();
      };
    }
  }, []);

  useEffect(() => {
    if (window.electron?.getSavePath) {
      window.electron.getSavePath().then(setSavePath);
    }
  }, [route.section]);

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

    // 4. Persist on-device Mini-AI when the tour explicitly chose it
    if (config.aiSetup === 'mini-ai' && window.electron?.setAiConfig) {
      try {
        await window.electron.setAiConfig({ provider: 'mini-ai' });
      } catch (err) {
        console.error('Failed to save AI preference:', err);
      }
    }

    // 5. Trigger initial compilation if requested
    if (config.shouldCompileImmediately) {
      setCompileNonce((n) => n + 1);
      navigate({ section: 'home', tab: null });
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

  // Section-level keyboard map — the registry's own order and shortcut
  // labels, so sidebar hints and keys can never drift apart.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isOnboardingOpen) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === ',') {
        e.preventDefault();
        navigate({ section: 'settings', tab: null });
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n < SECTIONS.length) {
        e.preventDefault();
        navigate({ section: SECTIONS[n - 1].id, tab: null });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOnboardingOpen, navigate]);

  // Listen for native IPC open-settings, view navigation, and update notifications
  useEffect(() => {
    let cleanupSettings: (() => void) | undefined;
    let cleanupUpdate: (() => void) | undefined;
    let cleanupCompile: (() => void) | undefined;
    let cleanupNav: (() => void) | undefined;
    let cleanupOnboarding: (() => void) | undefined;

    if (window.electron?.onOpenSettings) {
      cleanupSettings = window.electron.onOpenSettings(() => {
        navigate({ section: 'settings', tab: null });
      });
    }

    if (window.electron?.onTriggerCompile) {
      cleanupCompile = window.electron.onTriggerCompile(() => {
        setCompileNonce((n) => n + 1);
        navigate({ section: 'home', tab: null });
      });
    }

    if (window.electron?.onNavigateView) {
      cleanupNav = window.electron.onNavigateView((view: string) => {
        const target = routeForViewName(view) ?? DEFAULT_ROUTE;
        navigate(target);
        if (view === 'bulkImport') setFeedsInitialTab('bulk');
      });
    }

    if (window.electron?.onLaunchOnboarding) {
      cleanupOnboarding = window.electron.onLaunchOnboarding(() => {
        setIsOnboardingOpen(true);
      });
    }

    if (window.electron?.onUpdateAvailable) {
      cleanupUpdate = window.electron.onUpdateAvailable(() => {
        setUpdateAvailable(true);
      });
    }

    // Subscriptions are live — tell the main process it can flush any messages
    // queued while the window was closed or mid-reload.
    window.electron?.rendererReady?.();

    return () => {
      cleanupSettings?.();
      cleanupUpdate?.();
      cleanupCompile?.();
      cleanupNav?.();
      cleanupOnboarding?.();
    };
  }, [navigate]);

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
      {/* Background Application Layout (rendered inert when onboarding is open) */}
      <div
        className="app-body-layout"
        aria-hidden={isOnboardingOpen}
        inert={isOnboardingOpen ? true : undefined}
      >
        {/* Native macOS Sidebar */}
        <Sidebar
          activeSection={route.section}
          onSelectSection={selectSection}
          enabledSourcesCount={sources.filter((s) => s.enabled).length}
          totalSourcesCount={sources.length}
          updateAvailable={updateAvailable}
          handleExternalLink={handleExternalLink}
          isRadarScanning={Boolean(liveRadarSession?.active)}
          navOpen={navOpen}
          onCloseNav={closeNav}
        />

        {/* Main Workspace Pane */}
        <main className="app-main-pane">
          <Header
            route={route}
            savePath={savePath}
            handleRevealOutputFolder={handleRevealOutputFolder}
            navOpen={navOpen}
            onOpenNav={openNav}
          />

          <div className={`main-content-scroll section-${route.section}${route.tab ? ` tab-${route.tab}` : ''}`}>
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

            {route.section === 'home' && (
              <HomeView
                savePath={savePath}
                compileNonce={compileNonce}
                onCompileConsumed={() => setCompileNonce(0)}
                navigate={navigate}
              />
            )}
            {route.section === 'rules' && (
              <RulesView
                initialTab={route.tab ?? undefined}
                feedsInitialTab={feedsInitialTab}
                onFeedsInitialTabConsumed={() => setFeedsInitialTab(null)}
                sources={sources}
                saveSources={saveSources}
                onTriggerCompile={() => {
                  setCompileNonce((n) => n + 1);
                  navigate({ section: 'home', tab: null });
                }}
                navigate={navigate}
                setError={setGlobalError}
                setSuccessMessage={setGlobalSuccessMessage}
              />
            )}
            {route.section === 'discover' && (
              <DiscoverView
                initialTab={route.tab ?? undefined}
                liveRadarSession={liveRadarSession}
                onTriggerCompile={() => {
                  setCompileNonce((n) => n + 1);
                  navigate({ section: 'home', tab: null });
                }}
                navigate={navigate}
                setError={setGlobalError}
                setSuccessMessage={setGlobalSuccessMessage}
              />
            )}
            {route.section === 'distribute' && (
              <DistributeView
                savePath={savePath}
                initialTarget={route.tab ?? undefined}
                onNavigateSettings={() => navigate({ section: 'settings', tab: null })}
                onTriggerCompile={() => {
                  setCompileNonce((n) => n + 1);
                  navigate({ section: 'home', tab: null });
                }}
                navigate={navigate}
              />
            )}
            {route.section === 'settings' && (
              <Settings
                currentTheme={selectedTheme}
                onThemeChange={handleThemeChange}
                onLaunchOnboarding={() => setIsOnboardingOpen(true)}
              />
            )}
          </div>
        </main>
      </div>

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
