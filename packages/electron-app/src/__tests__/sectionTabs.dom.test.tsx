/**
 * SectionTabs — the top tab bar a section uses for a handful of sub-screens
 * (Rules, Discover). It implements the real tablist contract: role="tablist",
 * role="tab" per item, aria-selected on the active one, arrow-key movement,
 * Home/End jumps — so the bar reads and drives like the macOS control it
 * replaces rather than a row of buttons with a highlight.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SectionTabs, panelId, tabId } from '../components/SectionTabs';

afterEach(cleanup);

const TABS = [
  { id: 'feeds', label: 'Feeds' },
  { id: 'modules', label: 'Modules' },
  { id: 'custom', label: 'Custom' },
  { id: 'output', label: 'Output' },
] as const;

function renderTabs(activeId = 'feeds', onSelect = jest.fn()) {
  return {
    onSelect,
    ...render(
      <SectionTabs tabs={TABS} activeId={activeId} onSelect={onSelect} ariaLabel="Rules sections" />,
    ),
  };
}

describe('SectionTabs', () => {
  it('renders a labelled tablist with the tabs in order', () => {
    renderTabs();
    const list = screen.getByRole('tablist', { name: 'Rules sections' });
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['Feeds', 'Modules', 'Custom', 'Output']);
  });

  it('marks only the active tab aria-selected', () => {
    renderTabs('modules');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
  });

  it('gives the active tab tabIndex 0 and the rest -1 (roving tabindex)', () => {
    renderTabs('custom');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, -1, 0, -1]);
  });

  it('links each tab to its panel and each panel back to its tab', () => {
    renderTabs('feeds');
    const feeds = screen.getByRole('tab', { name: 'Feeds' });
    expect(feeds.getAttribute('aria-controls')).toBe(panelId('feeds'));
    expect(feeds.id).toBe(tabId('feeds'));
    expect(panelId('feeds')).toBe('section-tabpanel-feeds');
    expect(tabId('feeds')).toBe('section-tab-feeds');
  });

  it('keeps exactly one tab tabbable when activeId is unknown', () => {
    renderTabs('bogus');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(tabs.every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
  });

  it('does not preventDefault Enter or Space — native button activation survives', () => {
    renderTabs('feeds');
    const list = screen.getByRole('tablist');
    expect(fireEvent.keyDown(list, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(list, { key: ' ' })).toBe(true);
  });

  it('selects on click', () => {
    const { onSelect } = renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    expect(onSelect).toHaveBeenCalledWith('custom');
  });

  it('ArrowRight/ArrowLeft move focus and select the destination tab', () => {
    const { onSelect } = renderTabs('feeds');
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith('modules');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenCalledWith('output'); // wraps from first to last
  });

  it('Home and End jump to the first and last tabs', () => {
    const { onSelect } = renderTabs('custom');
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'End' });
    expect(onSelect).toHaveBeenCalledWith('output');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(onSelect).toHaveBeenCalledWith('feeds');
  });

  it('keeps the moving focus on the newly selected tab element', () => {
    renderTabs('feeds');
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    // Selection changed means focus roved — the caller re-renders with the new
    // activeId, which carries tabIndex 0 onto the destination element.
    const modules = screen.getByRole('tab', { name: 'Modules' });
    expect(document.activeElement).toBe(modules);
  });
});
