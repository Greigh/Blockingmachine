import React, { useState, useEffect, useRef } from 'react';
import { BrandLogo } from './components/BrandLogo';
import type {
  ThemeType,
  FilterFormat,
} from './types/';
import {
  ACCENT_PALETTE,
  applyAccentColor,
} from './theme';

interface SettingsProps {
  currentTheme: ThemeType;
  onThemeChange: (theme: ThemeType) => void;
  onLaunchOnboarding?: () => void;
}

const Settings: React.FC<SettingsProps> = ({
  currentTheme,
  onThemeChange,
  onLaunchOnboarding,
}) => {
  const [accentColor, setAccentColor] = useState<string>(() => {
    try {
      return localStorage.getItem('bm-accent-color') || 'blue';
    } catch {
      return 'blue';
    }
  });

  const handleAccentChange = (id: string) => {
    setAccentColor(id);
    applyAccentColor(id);
  };

  const [appVersion, setAppVersion] = useState<string>(() => {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';
  });

  useEffect(() => {
    if (window.electron?.getAppVersion) {
      window.electron
        .getAppVersion()
        .then((v) => {
          if (v) setAppVersion(v);
        })
        .catch(() => {});
    }
  }, []);

  type UpdateCheck =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'latest'; latest: string }
    | { status: 'available'; latest: string; url: string }
    | { status: 'error'; message: string };
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>({ status: 'idle' });

  const runUpdateCheck = async () => {
    if (!window.electron?.checkForUpdates) return;
    setUpdateCheck({ status: 'checking' });
    try {
      const res = await window.electron.checkForUpdates();
      if (!res.ok) {
        setUpdateCheck({ status: 'error', message: res.error });
      } else if (res.updateAvailable) {
        setUpdateCheck({ status: 'available', latest: res.latest, url: res.url });
      } else {
        setUpdateCheck({ status: 'latest', latest: res.latest });
      }
    } catch (err) {
      setUpdateCheck({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Existing state variables
  const [exportFormat, setExportFormat] = useState('');
  const [isLoadingFormat, setIsLoadingFormat] = useState(true);
  const [isSavingFormat, setIsSavingFormat] = useState(false);
  const [formatMessage, setFormatMessage] = useState<{
    text: string;
    type: 'success' | 'error' | null;
  }>({ text: '', type: null });

  // Multi-format simultaneous export state
  const [additionalFormats, setAdditionalFormats] = useState<FilterFormat[]>([]);

  const [autoStartFeedServer, setAutoStartFeedServer] = useState(false);
  const [launchOnStartup, setLaunchOnStartup] = useState(false);
  const [menuBarAgent, setMenuBarAgent] = useState(false);
  const [startupMessage, setStartupMessage] = useState('');

  // Path state variables
  const [savePath, setSavePath] = useState('');
  const [isLoadingPath, setIsLoadingPath] = useState(true);
  const [isSavingPath, setIsSavingPath] = useState(false);
  const [pathMessage, setPathMessage] = useState('');

  // Timer tracking to prevent memory leaks on unmount
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

    // Load export format & additional formats
    const loadExportFormat = async () => {
      try {
        const format = await window.electron.getExportFormat();
        if (isMounted) setExportFormat(format);
        const additionals = await window.electron.getAdditionalFormats();
        if (isMounted) setAdditionalFormats(additionals || []);
      } catch (error) {
        console.error('Error loading format:', error);
      } finally {
        if (isMounted) setIsLoadingFormat(false);
      }
    };

    // Load save path
    const loadSavePath = async () => {
      try {
        const path = await window.electron.getSavePath();
        if (isMounted) setSavePath(path);
      } catch (error) {
        console.error('Error loading path:', error);
      } finally {
        if (isMounted) setIsLoadingPath(false);
      }
    };

    if (window.electron?.getAutoStartFeedServer) {
      window.electron.getAutoStartFeedServer().then((val) => {
        if (isMounted) setAutoStartFeedServer(Boolean(val));
      }).catch(console.error);
    }

    if (window.electron?.getLaunchOnStartup) {
      window.electron.getLaunchOnStartup().then((val) => {
        if (isMounted) setLaunchOnStartup(Boolean(val));
      }).catch(console.error);
    }

    if (window.electron?.getMenuBarAgent) {
      window.electron.getMenuBarAgent().then((val) => {
        if (isMounted) setMenuBarAgent(Boolean(val));
      }).catch(console.error);
    }

    loadExportFormat();
    loadSavePath();

    return () => {
      isMounted = false;
    };
  }, []);

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

  const handleToggleAutoStartFeedServer = async (enabled: boolean) => {
    setAutoStartFeedServer(enabled);
    if (window.electron?.setAutoStartFeedServer) {
      try {
        await window.electron.setAutoStartFeedServer(enabled);
        setStartupMessage(enabled ? 'Auto-start feed server enabled' : 'Auto-start feed server disabled');
        safeSetTimeout(() => setStartupMessage(''), 3000);
      } catch (err) {
        console.error('Failed to set auto-start feed server:', err);
      }
    }
  };

  const handleToggleLaunchOnStartup = async (enabled: boolean) => {
    setLaunchOnStartup(enabled);
    if (window.electron?.setLaunchOnStartup) {
      try {
        await window.electron.setLaunchOnStartup(enabled);
        setStartupMessage(enabled ? 'Launch at startup enabled' : 'Launch at startup disabled');
        safeSetTimeout(() => setStartupMessage(''), 3000);
      } catch (err) {
        console.error('Failed to set launch on startup:', err);
      }
    }
  };

  const handleToggleMenuBarAgent = async (enabled: boolean) => {
    setMenuBarAgent(enabled);
    if (window.electron?.setMenuBarAgent) {
      try {
        await window.electron.setMenuBarAgent(enabled);
        setStartupMessage(
          enabled
            ? 'Runs in the menu bar — closing the window no longer quits the Dock app'
            : 'Menu bar mode off — the Dock icon stays while the app runs'
        );
        safeSetTimeout(() => setStartupMessage(''), 3000);
      } catch (err) {
        console.error('Failed to set menu bar agent:', err);
      }
    }
  };

  const handleFormatChange = async (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const format = e.target.value as FilterFormat;
    setExportFormat(format);
    setIsSavingFormat(true);

    try {
      const res = await window.electron.setExportFormat(format);
      if (res && !res.success) {
        throw new Error(res.error || 'Failed to save format');
      }
      showTemporaryMessage('Format updated successfully', 'success', setFormatMessage);
    } catch (error) {
      console.error('Error saving format:', error);
      const msg = error instanceof Error ? error.message : 'Failed to save format';
      showTemporaryMessage(msg, 'error', setFormatMessage);
    } finally {
      setIsSavingFormat(false);
    }
  };

  const handleToggleAdditionalFormat = async (targetFormat: FilterFormat) => {
    let next: FilterFormat[];
    if (additionalFormats.includes(targetFormat)) {
      next = additionalFormats.filter((f) => f !== targetFormat);
    } else {
      next = [...additionalFormats, targetFormat];
    }
    setAdditionalFormats(next);
    try {
      await window.electron.setAdditionalFormats(next);
      showTemporaryMessage('Simultaneous export targets updated', 'success', setFormatMessage);
    } catch (err) {
      console.error('Failed to update additional formats:', err);
    }
  };


  const handlePathChange = async () => {
    setIsSavingPath(true);
    try {
      const selectedPath = await window.electron.selectSavePath();
      if (selectedPath && typeof selectedPath === 'string') {
        setSavePath(selectedPath);
        const res = await window.electron.setSavePath(selectedPath);
        if (res && !res.success) {
          throw new Error(res.error || 'Failed to set save path');
        }
        setPathMessage('Path updated successfully!');
        safeSetTimeout(() => {
          setPathMessage('');
        }, 3000);
      } else {
        setPathMessage('No path selected.');
      }
    } catch (error) {
      console.error('Error saving path:', error);
      setPathMessage('Failed to update save path.');
      safeSetTimeout(() => {
        setPathMessage('');
      }, 3000);
    } finally {
      setIsSavingPath(false);
    }
  };

  const handleRevealPath = async () => {
    if (savePath) {
      try {
        await window.electron.showItemInFolder(savePath);
      } catch (error) {
        console.error('Failed to reveal path:', error);
      }
    }
  };

  // Helper for showing temporary success/error messages
  const showTemporaryMessage = (
    text: string,
    type: 'success' | 'error',
    setMessage: React.Dispatch<
      React.SetStateAction<{ text: string; type: 'success' | 'error' | null }>
    >
  ) => {
    setMessage({ text, type });
    safeSetTimeout(() => {
      setMessage({ text: '', type: null });
    }, 3000);
  };

  return (
    <div className="settings-container">
      <div className="settings-grid">
        {/* Theme Setting */}
        <div className="setting-card" id="settings-appearance">
          <div className="setting-card-header">
            <h2>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
                </svg>
              </span>
              Theme Appearance
            </h2>
            <span className="setting-badge secondary">Display</span>
          </div>
          <p>Choose how Blockingmachine appears on your system</p>

          <div className="theme-preview-container" role="radiogroup" aria-label="Theme appearance">
            <button
              type="button"
              role="radio"
              aria-checked={currentTheme === 'light'}
              className={`theme-preview theme-preview-light ${currentTheme === 'light' ? 'selected' : ''}`}
              onClick={() => onThemeChange('light')}
            >
              <div className="theme-preview-label">Light</div>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={currentTheme === 'dark'}
              className={`theme-preview theme-preview-dark ${currentTheme === 'dark' ? 'selected' : ''}`}
              onClick={() => onThemeChange('dark')}
            >
              <div className="theme-preview-label">Dark</div>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={currentTheme === 'system'}
              className={`theme-preview theme-preview-system ${currentTheme === 'system' ? 'selected' : ''}`}
              onClick={() => onThemeChange('system')}
            >
              <div className="theme-preview-label">System</div>
            </button>
          </div>

          {/* Accent Color Palette Customizer */}
          <div className="accent-palette-section">
            <h3 className="accent-palette-title">Accent Color Palette</h3>
            <p className="accent-palette-subtitle">
              Choose an accent tint to customize highlights, active controls, and focus glows.
            </p>
            <div className="accent-palette-grid">
              {ACCENT_PALETTE.map((accent) => (
                <button
                  key={accent.id}
                  className={`accent-color-swatch ${accentColor === accent.id ? 'selected' : ''}`}
                  onClick={() => handleAccentChange(accent.id)}
                  title={accent.name}
                  type="button"
                >
                  <span
                    className="accent-swatch-circle"
                    style={{ backgroundColor: accent.primary }}
                  />
                  <span className="accent-swatch-name">{accent.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Export Format Setting */}
        <div className="setting-card" id="settings-export">
          <div className="setting-card-header">
            <h2>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </span>
              Default Export Format
            </h2>
            <span className="setting-badge secondary">Output</span>
          </div>
          <p>Select how rules and modifiers are formatted during compilation</p>

          {isLoadingFormat ? (
            <div className="loading-path">
              <div className="path-loader"></div>
              <span>Loading format preferences...</span>
            </div>
          ) : (
            <>
              <div className="select-container">
                <select
                  className="styled-select"
                  aria-label="Default export format"
                  value={exportFormat}
                  onChange={handleFormatChange}
                  disabled={isSavingFormat}
                >
                  <option value="adguard">AdGuard (Adblock Plus & uBlock Origin format)</option>
                  <option value="abp">AdBlock Plus (Standard browser extension syntax)</option>
                  <option value="hosts">Hosts File (Standard 0.0.0.0 domain syntax for DNS)</option>
                  <option value="dnsmasq">DNSMasq (Router and Pi-hole address syntax)</option>
                  <option value="unbound">Unbound (Local DNS resolver block syntax)</option>
                  <option value="shadowrocket">Shadowrocket (iOS rule set — DOMAIN-SUFFIX rules)</option>
                  <option value="privoxy">Privoxy (action file — &#123;+block&#125; sections)</option>
                  <option value="bind">BIND DNS (Response Policy Zone records)</option>
                  <option value="bind-null">BIND DNS (shared null zone — one file, many origins)</option>
                  <option value="domains">Domain List (One clean domain per line)</option>
                  <option value="plain">Plain Text (Raw line-by-line rules)</option>
                </select>
              </div>

              {formatMessage.text && (
                <div className={`setting-message ${formatMessage.type}`} role={formatMessage.type === 'error' ? 'alert' : 'status'}>
                  {formatMessage.text}
                </div>
              )}

              <p className="setting-help-text">
                The selected format determines preprocessor directives, exception rules, and modifier compatibility when compiling blocklists.
              </p>

              {/* Simultaneous Multi-Format Export */}
              <div className="additional-formats-section">
                <span className="additional-formats-title">Simultaneous Additional Output Formats</span>
                <p className="setting-help-text">
                  Automatically generate these complementary blocklist formats in your output directory whenever you compile:
                </p>
                <div className="format-checkbox-grid">
                  {[
                    { id: 'hosts', label: 'Hosts File (0.0.0.0 for DNS/Pi-hole)' },
                    { id: 'dnsmasq', label: 'DNSMasq (server address syntax)' },
                    { id: 'adguard', label: 'AdGuard / uBlock format' },
                    { id: 'domains', label: 'Plain Domain List (one per line)' },
                    { id: 'unbound', label: 'Unbound DNS Resolver' },
                    { id: 'shadowrocket', label: 'Shadowrocket (iOS rule set)' },
                    { id: 'privoxy', label: 'Privoxy (filtering proxy action file)' },
                    { id: 'bind', label: 'BIND (Response Policy Zone)' },
                    { id: 'bind-null', label: 'BIND (shared null zone)' },
                  ]
                    .filter((item) => item.id !== exportFormat)
                    .map((item) => (
                      <label key={item.id} className="format-checkbox-label">
                        <input
                          type="checkbox"
                          checked={additionalFormats.includes(item.id as FilterFormat)}
                          onChange={() => handleToggleAdditionalFormat(item.id as FilterFormat)}
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Save Path Setting */}
        <div className="setting-card" id="settings-location">
          <div className="setting-card-header">
            <h2>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.227 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                </svg>
              </span>
              Save Location
            </h2>
            <span className="setting-badge primary">File System</span>
          </div>
          <p>Choose where to save generated filter lists and export logs</p>

          {isLoadingPath ? (
            <div className="loading-path">
              <div className="path-loader"></div>
              <span>Loading path settings...</span>
            </div>
          ) : (
            <div>
              <div className="path-input-container">
                <input
                  type="text"
                  className="path-input"
                  value={savePath}
                  readOnly
                  placeholder="No directory selected"
                />
                <button
                  className="browse-button"
                  onClick={handlePathChange}
                  disabled={isSavingPath}
                  title="Choose new output directory"
                >
                  {isSavingPath ? 'Selecting...' : 'Browse...'}
                </button>
                {savePath && (
                  <button
                    className="browse-button secondary"
                    onClick={handleRevealPath}
                    title="Reveal output directory in Finder"
                  >
                    Reveal
                  </button>
                )}
              </div>

              {pathMessage && <p className="setting-message success" role="status">{pathMessage}</p>}

              <p className="setting-help-text">
                Output files (<code className="inline-code">hosts.txt</code>, <code className="inline-code">adguard.txt</code>, <code className="inline-code">dnsmasq.txt</code>) are written directly to this directory.
              </p>
            </div>
          )}
        </div>
        {/* Startup & Background Services Card */}
        <div className="setting-card" id="settings-startup">
          <div className="setting-card-header">
            <h2>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </span>
              Startup & Background Services
            </h2>
            <span className="setting-badge">System</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', fontSize: '0.85rem' }}>
              <input
                type="checkbox"
                checked={launchOnStartup}
                onChange={(e) => handleToggleLaunchOnStartup(e.target.checked)}
                style={{ marginTop: '2px', cursor: 'pointer', accentColor: 'var(--primary-color)' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontWeight: 600 }}>Launch Blockingmachine on Computer Startup</span>
                <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                  Automatically start Blockingmachine when you log into your Mac so background distribution and scheduled compilations remain uninterrupted.
                </span>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', fontSize: '0.85rem' }}>
              <input
                type="checkbox"
                checked={menuBarAgent}
                onChange={(e) => handleToggleMenuBarAgent(e.target.checked)}
                style={{ marginTop: '2px', cursor: 'pointer', accentColor: 'var(--primary-color)' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontWeight: 600 }}>Run in Menu Bar (macOS)</span>
                <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                  Closing the window hides it to the status-bar icon instead of quitting — protection, the feed server, and scheduled compiles keep running, and the Dock icon disappears while no window is open. Launch-at-login also starts quietly in the menu bar. Untick to keep the Dock icon while the app runs.
                </span>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', fontSize: '0.85rem' }}>
              <input
                type="checkbox"
                checked={autoStartFeedServer}
                onChange={(e) => handleToggleAutoStartFeedServer(e.target.checked)}
                style={{ marginTop: '2px', cursor: 'pointer', accentColor: 'var(--primary-color)' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontWeight: 600 }}>Auto-Start Local LAN Feed Server on Launch</span>
                <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                  Automatically start the HTTP feed server (port 9191) on app launch so Home Assistant, Pi-hole, LAN devices — and the mobile companion — can reach this hub anytime. On by default; untick to keep the port closed.
                </span>
              </div>
            </label>

          </div>

          {startupMessage && <p className="setting-message success" role="status" style={{ marginTop: '10px' }}>{startupMessage}</p>}
        </div>

        <div className="setting-card" id="about-community">
          <div className="setting-card-header">
            <h2>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                </svg>
              </span>
              About & Community
            </h2>
            <span className="setting-badge secondary">v{appVersion}</span>
          </div>

          <div className="about-app-banner">
            <div className="about-app-icon">
              <BrandLogo size={36} glow />
            </div>
            <div className="about-app-meta">
              <h3>Blockingmachine</h3>
              <p>High-performance adblock compiler and DNS rule deduplicator. Developed by Greigh Studios LLC.</p>
            </div>
          </div>

          <div className="update-check-row">
            <button
              type="button"
              className="browse-button secondary"
              onClick={() => void runUpdateCheck()}
              disabled={updateCheck.status === 'checking'}
            >
              {updateCheck.status === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
            {updateCheck.status === 'latest' && (
              <span className="update-check-status" role="status">You are on the latest release (v{updateCheck.latest}).</span>
            )}
            {updateCheck.status === 'available' && (
              <a
                href={updateCheck.url}
                className="update-check-status update-check-link" role="status"
                onClick={(e) => handleExternalLink(e, updateCheck.url)}
                rel="noopener noreferrer"
              >
                v{updateCheck.latest} is available — open the release ↗
              </a>
            )}
            {updateCheck.status === 'error' && (
              <span className="update-check-status update-check-error" role="alert">Could not check: {updateCheck.message}</span>
            )}
          </div>

          {onLaunchOnboarding && (
            <div className="update-check-row">
              <button
                type="button"
                className="browse-button secondary"
                onClick={onLaunchOnboarding}
              >
                Replay welcome tour
              </button>
              <span className="update-check-status">Reopen the onboarding wizard to change your protection profile and starter feeds.</span>
            </div>
          )}

          <div className="about-links-grid">
            <a
              href="https://greighstudios.com"
              onClick={(e) => handleExternalLink(e, 'https://greighstudios.com')}
              className="about-link-item"
              rel="noopener noreferrer"
            >
              <div className="about-link-left">
                <span className="about-link-icon" style={{ color: '#38bdf8' }}>
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">Greigh Studios LLC</span>
                  <span className="about-link-subtitle">greighstudios.com</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>

            <a
              href="https://github.com/greigh/blockingmachine"
              onClick={(e) => handleExternalLink(e, 'https://github.com/greigh/blockingmachine')}
              className="about-link-item"
              rel="noopener noreferrer"
            >
              <div className="about-link-left">
                <span className="about-link-icon">
                  <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.09.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.62-3.37-1.36-3.37-1.36-.45-1.18-1.1-1.5-1.1-1.5-.9-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.38 9.38 0 0 1 12 6.84c.85.004 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.8 0 .26.18.57.69.47A10.01 10.01 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">GitHub Repository</span>
                  <span className="about-link-subtitle">greigh/blockingmachine</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>

            <a
              href="https://x.com/GreighStudios"
              onClick={(e) => handleExternalLink(e, 'https://x.com/GreighStudios')}
              className="about-link-item"
              rel="noopener noreferrer"
            >
              <div className="about-link-left">
                <span className="about-link-icon" style={{ color: '#1d9bf0' }}>
                  <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">X / Twitter</span>
                  <span className="about-link-subtitle">@GreighStudios</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>

            <a
              href="mailto:support@greighstudios.com"
              onClick={(e) => handleExternalLink(e, 'mailto:support@greighstudios.com')}
              className="about-link-item"
            >
              <div className="about-link-left">
                <span className="about-link-icon" style={{ color: 'var(--tone-success)' }}>
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="M22 6l-10 7L2 6" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">Support & Inquiries</span>
                  <span className="about-link-subtitle">support@greighstudios.com</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
