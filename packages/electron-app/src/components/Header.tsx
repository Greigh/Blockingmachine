import React from 'react';
import { sectionById, type AppRoute } from '../routes';

interface HeaderProps {
  route: AppRoute;
  savePath: string;
  handleRevealOutputFolder: () => void;
  navOpen?: boolean;
  onOpenNav?: () => void;
}

const SECTION_META: Record<string, { desc: string }> = {
  home: { desc: 'Protection status, list freshness, and the compile that keeps them current' },
  rules: { desc: 'Filter feeds, defense modules, custom rules, and compiled output' },
  discover: { desc: 'AI radar, engine configuration, and the rule inspector' },
  distribute: { desc: 'Push compiled blocklists to sinks and share them over the LAN' },
  settings: { desc: 'Appearance, export format, save location, startup, and about' },
};

const BETA_TABS = new Set(['rules:modules', 'discover:radar']);

export const Header: React.FC<HeaderProps> = ({
  route,
  savePath,
  handleRevealOutputFolder,
  navOpen,
  onOpenNav,
}) => {
  const section = sectionById(route.section);
  const tab = section.tabs.find((t) => t.id === route.tab);
  const title = tab?.label ?? section.label;
  const isBeta = BETA_TABS.has(`${route.section}:${route.tab}`);
  const desc = SECTION_META[route.section]?.desc ?? '';

  return (
    <header className="main-header">
      <div className="header-left">
        {onOpenNav && (
          <button
            type="button"
            className="nav-menu-btn"
            onClick={onOpenNav}
            aria-label="Open navigation"
            aria-expanded={Boolean(navOpen)}
            aria-controls="app-sidebar-nav"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
        )}
        <div className="header-category-breadcrumb">{section.label}</div>
        <h1 className="view-title">
          {title}
          {isBeta && <span className="header-title-beta-badge">Beta</span>}
        </h1>
        <span className="view-subtitle">{desc}</span>
      </div>
      <div className="header-right">
        {savePath && (
          <button
            type="button"
            className="header-action-btn"
            onClick={handleRevealOutputFolder}
            title={`Reveal output in Finder: ${savePath}`}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
              />
            </svg>
            <span>Output Folder</span>
          </button>
        )}
      </div>
    </header>
  );
};
