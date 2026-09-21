import React from 'react';
import { BrandLogo } from './BrandLogo';

interface SidebarProps {
  currentView: string;
  setCurrentView: (view: string) => void;
  enabledSourcesCount: number;
  totalSourcesCount: number;
  updateAvailable: boolean;
  handleExternalLink: (
    e: React.MouseEvent<HTMLAnchorElement>,
    url: string
  ) => void;
  onLaunchOnboarding?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  setCurrentView,
  enabledSourcesCount,
  totalSourcesCount,
  updateAvailable,
  handleExternalLink,
  onLaunchOnboarding,
}) => {
  return (
    <aside className="app-sidebar">
      {/* Top window drag region & traffic light spacer */}
      <div className="sidebar-traffic-lights" />

      {/* App Branding */}
      <div className="sidebar-brand">
        <div className="brand-icon-shield">
          <BrandLogo size={22} glow />
        </div>
        <div className="brand-info">
          <span className="brand-title">Blockingmachine</span>
          <span className="brand-version">v1.0.0-rc.1</span>
        </div>
      </div>

      {/* Sidebar Navigation Items */}
      <nav className="sidebar-nav">
        <div className="sidebar-section-label">Features</div>

        <button
          className={`sidebar-nav-item ${currentView === 'process' ? 'active' : ''}`}
          onClick={() => setCurrentView('process')}
          title="Dashboard & Filter Processor (Cmd+1)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
              />
            </svg>
          </span>
          <span className="sidebar-label">Process & Stats</span>
          <span className="sidebar-shortcut">⌘1</span>
        </button>

        <button
          className={`sidebar-nav-item ${currentView === 'sources' ? 'active' : ''}`}
          onClick={() => setCurrentView('sources')}
          title="Filter Feeds & Subscriptions (Cmd+2)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
              />
            </svg>
          </span>
          <span className="sidebar-label">Sources</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span className="sidebar-badge">
              {enabledSourcesCount}/{totalSourcesCount}
            </span>
            <span className="sidebar-shortcut">⌘2</span>
          </div>
        </button>

        <button
          className={`sidebar-nav-item ${currentView === 'modules' ? 'active' : ''}`}
          onClick={() => setCurrentView('modules')}
          title="Defense Modules [Beta] (First-Party Curated Shields) (Cmd+3)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"
              />
            </svg>
          </span>
          <span className="sidebar-label">
            Modules
            <span className="sidebar-badge-inline">Beta</span>
          </span>
          <span className="sidebar-shortcut">⌘3</span>
        </button>

        <button
          className={`sidebar-nav-item ${currentView === 'custom' ? 'active' : ''}`}
          onClick={() => setCurrentView('custom')}
          title="Custom Rules Editor (Cmd+4)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125"
              />
            </svg>
          </span>
          <span className="sidebar-label">Custom Rules</span>
          <span className="sidebar-shortcut">⌘4</span>
        </button>

        <button
          className={`sidebar-nav-item ${currentView === 'inspector' ? 'active' : ''}`}
          onClick={() => setCurrentView('inspector')}
          title="Rule & AI Inspector (Cmd+5)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
          </span>
          <span className="sidebar-label">Rule & AI Inspector</span>
          <span className="sidebar-shortcut">⌘5</span>
        </button>

        <button
          className={`sidebar-nav-item ${currentView === 'browser' ? 'active' : ''}`}
          onClick={() => setCurrentView('browser')}
          title="Compiled Rules Browser (Cmd+6)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
              />
            </svg>
          </span>
          <span className="sidebar-label">Rule Browser</span>
          <span className="sidebar-shortcut">⌘6</span>
        </button>

        <button
          className={`sidebar-nav-item ${currentView === 'bulkImport' ? 'active' : ''}`}
          onClick={() => setCurrentView('bulkImport')}
          title="Bulk Import Feeds (Cmd+7)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
              />
            </svg>
          </span>
          <span className="sidebar-label">Bulk Import</span>
          <span className="sidebar-shortcut">⌘7</span>
        </button>

        <button
          className={`sidebar-nav-item ${currentView === 'deploy' ? 'active' : ''}`}
          onClick={() => setCurrentView('deploy')}
          title="Deploy & Sinkhole Sync (Cmd+8)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="2" y="3" width="20" height="6" rx="2" />
              <rect x="2" y="15" width="20" height="6" rx="2" />
              <path strokeLinecap="round" d="M6 6h.01M6 18h.01M12 9v6M8 12h8" />
            </svg>
          </span>
          <span className="sidebar-label">Deploy & Sync</span>
          <span className="sidebar-shortcut">⌘8</span>
        </button>

        <button
          className={`sidebar-nav-item ${currentView === 'ai-radar' ? 'active' : ''}`}
          onClick={() => setCurrentView('ai-radar')}
          title="AI Ad & Tracker Discovery Radar [Beta] (Cmd+9)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="9" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3a9 9 0 019 9" />
              <circle cx="12" cy="12" r="3" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 12l4-4" />
            </svg>
          </span>
          <span className="sidebar-label">
            AI Radar
            <span className="sidebar-badge-inline beta">Beta</span>
          </span>
          <span className="sidebar-shortcut">⌘9</span>
        </button>

        <div className="sidebar-section-label">Preferences</div>

        <button
          className={`sidebar-nav-item ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => setCurrentView('settings')}
          title="Settings (Cmd+,)"
        >
          <span className="sidebar-icon">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </span>
          <span className="sidebar-label">Settings</span>
          <span className="sidebar-shortcut">⌘,</span>
          {updateAvailable && (
            <span className="update-dot" title="Update Available">
              ●
            </span>
          )}
        </button>

        {onLaunchOnboarding && (
          <button
            className="sidebar-nav-item"
            onClick={onLaunchOnboarding}
            title="Launch Welcome & Onboarding Tour"
          >
            <span className="sidebar-icon">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                />
              </svg>
            </span>
            <span className="sidebar-label">Welcome Tour</span>
          </button>
        )}
      </nav>

      {/* Native macOS Sidebar Footer */}
      <footer className="sidebar-footer">
        <div className="sidebar-status-row">
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
              handleExternalLink(e, 'https://danielhipskind.com')
            }
            className="sidebar-meta-btn"
            title="Developer Website: danielhipskind.com"
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
                d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
              />
            </svg>
            <span>Daniel Hipskind</span>
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
  );
};
