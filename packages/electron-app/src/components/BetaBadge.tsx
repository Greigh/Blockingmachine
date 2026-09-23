import React from 'react';

interface BetaBadgeProps {
  title?: string;
  className?: string;
  showIcon?: boolean;
}

export const BetaBadge: React.FC<BetaBadgeProps> = ({
  title = 'Beta Feature',
  className = 'title-beta-badge',
  showIcon = true,
}) => (
  <span className={className} title={title}>
    {showIcon && (
      <svg
        viewBox="0 0 24 24"
        width="10"
        height="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ verticalAlign: 'middle', flexShrink: 0 }}
        aria-hidden="true"
      >
        <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" />
        <path d="M8.5 2h7" />
        <path d="M7 16h10" />
      </svg>
    )}
    <span>Beta</span>
  </span>
);
