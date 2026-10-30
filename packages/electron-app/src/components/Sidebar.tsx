import React, { useState, useEffect, useRef } from 'react';
import { BrandLogo } from './BrandLogo';
import { useDialogFocus } from './useDialogFocus';
import { SECTIONS, type SectionId } from '../routes';

interface SidebarProps {
  activeSection: SectionId;
  onSelectSection: (id: SectionId) => void;
  enabledSourcesCount: number;
  totalSourcesCount: number;
  updateAvailable: boolean;
  handleExternalLink: (
    e: React.MouseEvent<HTMLAnchorElement>,
    url: string
  ) => void;
  isRadarScanning?: boolean;
  navOpen?: boolean;
  onCloseNav?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSelectSection,
  enabledSourcesCount,
  totalSourcesCount,
  updateAvailable,
  handleExternalLink,
  isRadarScanning,
  navOpen,
  onCloseNav,
}) => {
  const [version, setVersion] = useState<string>(() => {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';
  });

  useEffect(() => {
    if (window.electron?.getAppVersion) {
      window.electron
        .getAppVersion()
        .then((v) => {
          if (v) setVersion(v);
        })
        .catch(() => {});
    }
  }, []);

  // Drawer mode (≤460px effective width): the aside is an overlay — focus
  // moves into it on open, Tab cycles inside, Escape closes, focus returns to
  // the header menu button. At wider widths navOpen stays false and the hook
  // never engages, so the persistent rail keeps normal Tab flow.
  const asideRef = useRef<HTMLElement>(null);
  useDialogFocus(asideRef, Boolean(navOpen), onCloseNav ?? (() => {}));

  return (
    <>
      {navOpen && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={onCloseNav}
        />
      )}
    <aside ref={asideRef} className={`app-sidebar${navOpen ? ' nav-open' : ''}`}>
      {/* Top window drag region & traffic light spacer */}
      <div className="sidebar-traffic-lights" />

      {/* App Branding */}
      <div className="sidebar-brand">
        <div className="brand-icon-shield">
          <BrandLogo size={22} glow />
        </div>
        <div className="brand-info">
          <span className="brand-title">Blockingmachine</span>
          <span className="brand-version">v{version}</span>
        </div>
      </div>

      {/* Sidebar Navigation Items — the five sections, straight from the registry */}
      <nav className="sidebar-nav" id="app-sidebar-nav" aria-label="Primary">
        {SECTIONS.map((section) => {
          const active = activeSection === section.id;
          return (
            <button
              key={section.id}
              className={`sidebar-nav-item ${active ? 'active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelectSection(section.id)}
              title={`${section.label} (${section.shortcut.replace('⌘', 'Cmd+')})`}
            >
              <span className="sidebar-icon" aria-hidden="true">
                {section.icon}
              </span>
              <span className="sidebar-label">
                {section.label}
                {section.id === 'discover' && isRadarScanning && (
                  <span className="sidebar-radar-live-pill" title="Live background scanning active">
                    <span className="live-radar-ping-dot" />
                    LIVE
                  </span>
                )}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {section.id === 'rules' && (
                  <span className="sidebar-badge">
                    {enabledSourcesCount}/{totalSourcesCount}
                  </span>
                )}
                <span className="sidebar-shortcut">{section.shortcut}</span>
                {section.id === 'settings' && updateAvailable && (
                  <span className="update-dot" title="Update Available">
                    ●
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Native macOS Sidebar Footer */}
      <footer className="sidebar-footer">
        <div className="sidebar-status-row" title="Core Engine: Ready">
          <div className="engine-status-indicator">
            <span className="status-dot pulse" />
            <span className="engine-status-label">Core Engine</span>
          </div>
          <span className="engine-status-badge">Ready</span>
        </div>

        <div className="sidebar-meta-row">
          <a
            href="#"
            onClick={(e) =>
              handleExternalLink(e, 'https://greighstudios.com')
            }
            className="sidebar-meta-btn"
            title="Greigh Studios LLC: greighstudios.com"
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
              />
            </svg>
            <span>Greigh Studios</span>
          </a>
          <a
            href="#"
            onClick={(e) =>
              handleExternalLink(
                e,
                'https://github.com/greigh/Blockingmachine'
              )
            }
            className="sidebar-meta-btn"
            title="GitHub Repository: greigh/Blockingmachine"
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="currentColor"
            >
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            <span>GitHub</span>
          </a>
        </div>
      </footer>
    </aside>
    </>
  );
};
