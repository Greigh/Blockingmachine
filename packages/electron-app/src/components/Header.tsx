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
          desc: 'Manage remote blocklist subscriptions and feed health',
        };
      case 'bulkImport':
        return {
          title: 'Bulk Import',
          desc: 'Add multiple feed URLs or drop text files',
        };
      case 'custom':
        return {
          title: 'Custom Rules',
          desc: 'Author domain blocks, allowlists, and custom rules',
        };
      case 'inspector':
        return {
          title: 'Rule Inspector',
          desc: 'Verify if any domain is blocked and trace its origin rule',
        };
      case 'settings':
        return {
          title: 'Preferences',
          desc: 'Configure export formats, auto-schedule, and file locations',
        };
      case 'process':
      default:
        return {
          title: 'Filter Processor',
          desc: 'Generate, deduplicate, and compile your blocklists',
        };
    }
  };

  const { title, desc } = getHeaderMeta();

  return (
    <header className="main-header">
      <div className="header-left">
        <h1 className="view-title">{title}</h1>
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
