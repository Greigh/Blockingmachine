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
          title: 'Filter Sources',
          isBeta: false,
          desc: 'Manage remote blocklist subscriptions and feed health',
        };
      case 'modules':
        return {
          title: 'Defense Modules',
          isBeta: true,
          desc: 'First-party modular filter list engine modeled after modern ad-blocking architecture',
        };
      case 'bulkImport':
        return {
          title: 'Bulk Import',
          isBeta: false,
          desc: 'Add multiple feed URLs or drop text files',
        };
      case 'custom':
        return {
          title: 'Custom Rules',
          isBeta: false,
          desc: 'Author domain blocks, allowlists, and custom rules',
        };
      case 'inspector':
        return {
          title: 'Rule Inspector',
          isBeta: false,
          desc: 'Verify if any domain is blocked and trace its origin rule',
        };
      case 'browser':
        return {
          title: 'Rule Browser',
          isBeta: false,
          desc: 'Search, filter, and inspect the active set of compiled rules',
        };
      case 'deploy':
        return {
          title: 'Deploy & Sync',
          isBeta: false,
          desc: 'Connect your compiled blocklists to AdGuard Home, Pi-hole, desktop apps, and LAN devices',
        };
      case 'ai-radar':
        return {
          title: 'AI Defense Radar',
          isBeta: true,
          desc: 'Real-time AI scanner for shifting ad servers, ephemeral bidding hostnames, and CNAME cloaking',
        };
      case 'settings':
        return {
          title: 'Preferences',
          isBeta: false,
          desc: 'Configure export formats, auto-schedule, and file locations',
        };
      case 'process':
      default:
        return {
          title: 'Filter Processor',
          isBeta: false,
          desc: 'Generate, deduplicate, and compile your blocklists',
        };
    }
  };

  const { title, isBeta, desc } = getHeaderMeta();

  return (
    <header className="main-header">
      <div className="header-left">
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
