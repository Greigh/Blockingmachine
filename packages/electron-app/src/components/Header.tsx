import React from 'react';

interface HeaderProps {
  currentView: string;
  savePath: string;
  handleRevealOutputFolder: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  savePath,
  handleRevealOutputFolder,
}) => {
  const getHeaderMeta = () => {
    switch (currentView) {
      case 'sources':
        return {
          category: 'Rules & Feeds',
          title: 'Filter Sources',
          isBeta: false,
          desc: 'Manage remote blocklist subscriptions, sync schedules, and feed health',
        };
      case 'modules':
        return {
          category: 'Rules & Feeds',
          title: 'Defense Modules',
          isBeta: true,
          desc: 'Curated first-party shields modeled after modern ad-blocking architecture',
        };
      case 'bulkImport':
        return {
          category: 'Rules & Feeds',
          title: 'Bulk Import',
          isBeta: false,
          desc: 'Add multiple feed URLs simultaneously or drop local text files',
        };
      case 'custom':
        return {
          category: 'Rules & Feeds',
          title: 'Custom Rules',
          isBeta: false,
          desc: 'Author custom domain blocks, allowlists, and manual rule overrides',
        };
      case 'inspector':
        return {
          category: 'Tools & AI',
          title: 'Rule & AI Inspector',
          isBeta: false,
          desc: 'Evaluate compiled filter rules and query live AI threat intelligence for any domain',
        };
      case 'browser':
        return {
          category: 'Tools & AI',
          title: 'Rule Browser',
          isBeta: false,
          desc: 'Search, filter, and inspect the complete active database of compiled rules',
        };
      case 'ai-radar':
        return {
          category: 'Tools & AI',
          title: 'AI Defense Radar',
          isBeta: true,
          desc: 'Threat hunting hub: query log scout, live page canary crawler, and quarantine ledger',
        };
      case 'deploy':
        return {
          category: 'Distribution',
          title: 'Deploy & Sync',
          isBeta: false,
          desc: 'Distribute compiled blocklists to Pi-hole, AdGuard Home, or serve via the LAN Feed Server',
        };
      case 'settings':
        return {
          category: 'Preferences',
          title: 'Preferences',
          isBeta: false,
          desc: 'Configure export formats, AI intelligence engine, auto-schedule, and file locations',
        };
      case 'process':
      default:
        return {
          category: 'Overview',
          title: 'Dashboard',
          isBeta: false,
          desc: 'Compile, deduplicate, and monitor your unified network blocklists',
        };
    }
  };

  const { category, title, isBeta, desc } = getHeaderMeta();

  return (
    <header className="main-header">
      <div className="header-left">
        <div className="header-category-breadcrumb">{category}</div>
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
