/**
 * DiscoverView — the Discover section host. Radar (AIRadarView), AI engine
 * (AiEnginePane), and Inspect (RuleInspectorView) behind SectionTabs. The one
 * deep-link that matters: Radar's onNavigateInspector(domain) becomes a tab
 * switch that carries the domain into the inspector — yesterday's cross-view
 * jump is now an in-section one. Sub-views are module-mocked; the contract is
 * tab dispatch + prop forwarding.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AppRoute } from '../routes';

const captured: Record<string, Record<string, unknown>> = {};

jest.unstable_mockModule('../views/AIRadarView', () => ({
  AIRadarView: (props: Record<string, unknown>) => {
    captured.radar = props;
    return 'RADAR-VIEW';
  },
}));
jest.unstable_mockModule('../components/AiEnginePane', () => ({
  AiEnginePane: () => 'AI-ENGINE-PANE',
}));
jest.unstable_mockModule('../views/RuleInspectorView', () => ({
  RuleInspectorView: (props: Record<string, unknown>) => {
    captured.inspector = props;
    return 'INSPECTOR-VIEW';
  },
}));

const { DiscoverView } = await import('../views/DiscoverView');

afterEach(() => {
  cleanup();
  for (const key of Object.keys(captured)) delete captured[key];
});

function renderHost(overrides: Record<string, unknown> = {}) {
  const navigate = jest.fn<(r: AppRoute) => void>();
  const props = {
    liveRadarSession: null,
    onTriggerCompile: jest.fn(),
    navigate,
    setError: jest.fn(),
    setSuccessMessage: jest.fn(),
    ...overrides,
  };
  return { navigate, ...render(<DiscoverView {...props} />) };
}

describe('DiscoverView', () => {
  it('renders the three tabs with the design labels', () => {
    renderHost();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Radar',
      'AI engine',
      'Inspect',
    ]);
  });

  it('mounts AIRadarView under the radar tab by default', () => {
    renderHost();
    expect(screen.getByText('RADAR-VIEW')).toBeTruthy();
    expect(captured.radar?.liveRadarSession).toBeNull();
  });

  it('mounts AiEnginePane under the engine tab', () => {
    renderHost({ initialTab: 'engine' });
    expect(screen.getByText('AI-ENGINE-PANE')).toBeTruthy();
  });

  it('radar → inspector deep link switches tab and carries the domain', () => {
    renderHost();
    act(() => {
      (captured.radar?.onNavigateInspector as (d: string) => void)('evil.example.com');
    });
    expect(screen.getByText('INSPECTOR-VIEW')).toBeTruthy();
    expect(captured.inspector?.initialDomain).toBe('evil.example.com');
    expect(screen.getByRole('tab', { name: 'Inspect' }).getAttribute('aria-selected')).toBe('true');
  });

  it('honours initialTab + inspectorDomain for IPC deep links into inspect', () => {
    renderHost({ initialTab: 'inspect', inspectorDomain: 'seeded.example' });
    expect(screen.getByText('INSPECTOR-VIEW')).toBeTruthy();
    expect(captured.inspector?.initialDomain).toBe('seeded.example');
  });

  it('routes the inspector’s custom-rules affordance to rules › custom', () => {
    const { navigate } = renderHost({ initialTab: 'inspect' });
    act(() => {
      (captured.inspector?.onNavigateCustomRules as () => void)();
    });
    expect(navigate).toHaveBeenCalledWith({ section: 'rules', tab: 'custom' });
  });

  it('radar’s settings affordance is the engine tab switch — its only caller is "Configure AI Engine"', () => {
    renderHost();
    act(() => {
      (captured.radar?.onNavigateSettings as () => void)();
    });
    expect(screen.getByText('AI-ENGINE-PANE')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'AI engine' }).getAttribute('aria-selected')).toBe('true');
  });

  it('routes radar’s deploy affordance to the distribute section', () => {
    const { navigate } = renderHost();
    act(() => {
      (captured.radar?.onNavigateDeploy as () => void)();
    });
    expect(navigate).toHaveBeenCalledWith({ section: 'distribute', tab: null });
  });
});
