/**
 * InnerNav — the grouped inner list a section uses when it has many sub-screens
 * (Distribute's twelve deploy targets). A second labelled nav landmark with
 * group headings, per-item status dots, and aria-current on the active row —
 * the "tab bar grown vertically" for counts a top strip can't hold.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InnerNav } from '../components/InnerNav';

afterEach(cleanup);

const GROUPS = [
  {
    label: 'DNS & routers',
    items: [
      { id: 'pihole', label: 'Pi-hole', status: 'live' as const },
      { id: 'adguard-home', label: 'AdGuard Home', status: 'idle' as const },
      { id: 'unbound', label: 'Unbound' },
    ],
  },
  {
    label: 'This Mac',
    items: [{ id: 'system-daemon', label: 'System daemon', status: 'live' as const }],
  },
] as const;

function renderNav(activeId = 'pihole', onSelect = jest.fn()) {
  return {
    onSelect,
    ...render(
      <InnerNav groups={GROUPS} activeId={activeId} onSelect={onSelect} ariaLabel="Deploy targets" />,
    ),
  };
}

describe('InnerNav', () => {
  it('renders a labelled nav landmark with group headings', () => {
    renderNav();
    const nav = screen.getByRole('navigation', { name: 'Deploy targets' });
    expect(nav).not.toBeNull();
    expect(screen.getByText('DNS & routers')).not.toBeNull();
    expect(screen.getByText('This Mac')).not.toBeNull();
  });

  it('renders every item under its group', () => {
    renderNav();
    for (const label of ['Pi-hole', 'AdGuard Home', 'Unbound', 'System daemon']) {
      expect(screen.getByText(label)).not.toBeNull();
    }
  });

  it('marks the active item aria-current and applies the active class', () => {
    renderNav('unbound');
    const active = screen.getByText('Unbound').closest('.inner-nav-item');
    expect(active?.getAttribute('aria-current')).toBe('page');
    expect(active?.className).toContain('active');
    const inactive = screen.getByText('Pi-hole').closest('.inner-nav-item');
    expect(inactive?.hasAttribute('aria-current')).toBe(false);
  });

  it('renders live/idle status dots per item, with text for screen readers', () => {
    renderNav();
    const piholeRow = screen.getByText('Pi-hole').closest('.inner-nav-item')!;
    const aghRow = screen.getByText('AdGuard Home').closest('.inner-nav-item')!;
    const unboundRow = screen.getByText('Unbound').closest('.inner-nav-item')!;
    expect(piholeRow.querySelector('.inner-nav-dot')?.className).toContain('live');
    expect(aghRow.querySelector('.inner-nav-dot')?.className).toContain('idle');
    // The dot is colour-only decoration — the status itself must reach AT as text.
    expect(piholeRow.querySelector('.visually-hidden')?.textContent).toContain('configured');
    expect(aghRow.querySelector('.visually-hidden')?.textContent).toContain('not set up');
    // No status declared → no dot at all.
    expect(unboundRow.querySelector('.inner-nav-dot')).toBeNull();
  });

  it('fires onSelect with the item id on click', () => {
    const { onSelect } = renderNav();
    fireEvent.click(screen.getByText('System daemon'));
    expect(onSelect).toHaveBeenCalledWith('system-daemon');
  });
});
