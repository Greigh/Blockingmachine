/**
 * InnerNav — the grouped inner list a section uses for many sub-screens.
 *
 * Distribute's twelve deploy targets plus the network row can't share one top
 * tab strip, so the section picks its sub-screen in a second labelled nav
 * landmark instead: group headings, one row per target, a status dot where the
 * host knows whether that target is live or was never set up. Same model as
 * SectionTabs — "pick the sub-screen in the section" — on the vertical axis.
 */

import React, { type ReactNode } from 'react';

export interface InnerNavItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** 'live' when the host knows the target is configured/running, 'idle' otherwise. */
  status?: 'live' | 'idle';
}

export interface InnerNavGroup {
  label: string;
  items: readonly InnerNavItem[];
}

interface InnerNavProps {
  groups: readonly InnerNavGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
}

export const InnerNav: React.FC<InnerNavProps> = ({
  groups,
  activeId,
  onSelect,
  ariaLabel,
}) => (
  <nav className="inner-nav" aria-label={ariaLabel}>
    {groups.map((group) => (
      <div className="inner-nav-group" key={group.label}>
        <div className="inner-nav-group-label">{group.label}</div>
        {group.items.map((item) => {
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              className={`inner-nav-item${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
            >
              {item.status && (
                <span className={`inner-nav-dot ${item.status}`} aria-hidden="true" />
              )}
              {item.status && (
                <span className="visually-hidden">
                  {item.status === 'live' ? 'configured' : 'not set up'}
                </span>
              )}
              {item.icon && (
                <span className="inner-nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span className="inner-nav-label">{item.label}</span>
            </button>
          );
        })}
      </div>
    ))}
  </nav>
);
