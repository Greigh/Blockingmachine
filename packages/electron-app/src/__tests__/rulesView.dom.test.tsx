/**
 * RulesView — the Rules section host. Four sub-screens behind SectionTabs:
 * Feeds (SourcesView), Modules, Custom, Output (RuleBrowser). The host owns
 * the tab state and the cross-section navigation callbacks — the views
 * underneath are mounted unchanged, so their own bridges and tests carry on.
 * The sub-views are module-mocked here: the host's contract is which view
 * mounts under which tab with which props, not the views' internals.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AppRoute } from '../routes';

const captured: Record<string, Record<string, unknown>> = {};

jest.unstable_mockModule('../views/SourcesView', () => ({
  SourcesView: (props: Record<string, unknown>) => {
    captured.sources = props;
    return 'SOURCES-VIEW';
  },
}));
jest.unstable_mockModule('../views/ModulesView', () => ({
  ModulesView: (props: Record<string, unknown>) => {
    captured.modules = props;
    return 'MODULES-VIEW';
  },
}));
jest.unstable_mockModule('../views/CustomRulesView', () => ({
  CustomRulesView: (props: Record<string, unknown>) => {
    captured.custom = props;
    return 'CUSTOM-VIEW';
  },
}));
jest.unstable_mockModule('../views/RuleBrowserView', () => ({
  RuleBrowserView: (props: Record<string, unknown>) => {
    captured.browser = props;
    return 'BROWSER-VIEW';
  },
}));

const { RulesView } = await import('../views/RulesView');

afterEach(() => {
  cleanup();
  for (const key of Object.keys(captured)) delete captured[key];
});

function renderHost(overrides: Record<string, unknown> = {}) {
  const navigate = jest.fn<(r: AppRoute) => void>();
  const props = {
    sources: [],
    saveSources: jest.fn(async () => {}),
    onTriggerCompile: jest.fn(),
    navigate,
    setError: jest.fn(),
    setSuccessMessage: jest.fn(),
    ...overrides,
  };
  return { navigate, ...render(<RulesView {...props} />) };
}

describe('RulesView', () => {
  it('renders the four tabs with the design labels', () => {
    renderHost();
    expect(
      screen.getAllByRole('tab').map((t) => t.textContent),
    ).toEqual(['Feeds', 'Modules', 'Custom', 'Output']);
  });

  it('mounts SourcesView under the feeds tab by default', () => {
    renderHost();
    expect(screen.getByText('SOURCES-VIEW')).toBeTruthy();
    expect(typeof captured.sources?.setError).toBe('function');
  });

  it('forwards feedsInitialTab to SourcesView as initialTab', () => {
    renderHost({ feedsInitialTab: 'bulk' });
    expect(captured.sources?.initialTab).toBe('bulk');
  });

  it('honours initialTab for a deep link into another sub-screen', () => {
    renderHost({ initialTab: 'custom' });
    expect(screen.getByText('CUSTOM-VIEW')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Custom' }).getAttribute('aria-selected')).toBe('true');
  });

  it('switches sub-screens on tab click and wires the panel contract', () => {
    renderHost();
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }));
    expect(screen.getByText('BROWSER-VIEW')).toBeTruthy();
    const panel = screen.getByRole('tabpanel');
    expect(panel.id).toBe('section-tabpanel-output');
    expect(panel.getAttribute('aria-labelledby')).toBe('section-tab-output');
  });

  it('falls back to feeds when initialTab is unknown', () => {
    renderHost({ initialTab: 'bogus' });
    expect(screen.getByText('SOURCES-VIEW')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Feeds' }).getAttribute('aria-selected')).toBe('true');
  });

  it('routes ModulesView’s deploy affordance to the distribute section', () => {
    const { navigate } = renderHost();
    fireEvent.click(screen.getByRole('tab', { name: 'Modules' }));
    act(() => {
      (captured.modules?.onNavigateDeploy as () => void)();
    });
    expect(navigate).toHaveBeenCalledWith({ section: 'distribute', tab: null });
  });

  it('forwards onTriggerCompile to ModulesView and RuleBrowserView', () => {
    const onTriggerCompile = jest.fn();
    renderHost({ onTriggerCompile });
    fireEvent.click(screen.getByRole('tab', { name: 'Modules' }));
    act(() => (captured.modules?.onTriggerCompile as () => void)());
    expect(onTriggerCompile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }));
    act(() => (captured.browser?.onTriggerCompile as () => void)());
    expect(onTriggerCompile).toHaveBeenCalledTimes(2);
  });
});
