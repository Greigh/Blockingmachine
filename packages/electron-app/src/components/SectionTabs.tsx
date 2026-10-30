/**
 * SectionTabs — the top tab bar a section uses for a handful of sub-screens.
 *
 * The shell's few-screen sections (Rules, Discover) put their sub-screens behind
 * this bar rather than a second sidebar column. It implements the real tablist
 * contract — role="tablist"/"tab", roving tabindex, arrow/Home/End movement —
 * so the bar reads and drives like the platform control it is, not a row of
 * buttons with a highlight. The host owns the panels: each tab's aria-controls
 * names the id the host's panel must render (`section-tabpanel-<tabId>` — use
 * the exported `panelId()`/`tabId()` helpers, never a hand-built string), and
 * the host sets role="tabpanel" + aria-labelledby back onto the tab's id.
 */

import React from 'react';
import type { TabSpec } from '../routes';

interface SectionTabsProps {
  tabs: readonly TabSpec[];
  activeId: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
}

export const SectionTabs: React.FC<SectionTabsProps> = ({
  tabs,
  activeId,
  onSelect,
  ariaLabel,
}) => {
  const ids = tabs.map((t) => t.id);
  const activeIndex = Math.max(0, ids.indexOf(activeId));

  const move = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    if (!next || next.id === activeId) return;
    onSelect(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      move(activeIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      move(activeIndex - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(tabs.length - 1);
    }
  };

  return (
    <div className="section-tabs" role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(tab.id)}
            aria-selected={active}
            aria-controls={panelId(tab.id)}
            tabIndex={index === activeIndex ? 0 : -1}
            className={`section-tab${active ? ' active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};

/** The element id a tab renders — panels aria-labelledby it. */
export function tabId(id: string): string {
  return `section-tab-${id}`;
}

/** The element id the host's panel must render for aria-controls to resolve. */
export function panelId(id: string): string {
  return `section-tabpanel-${id}`;
}
