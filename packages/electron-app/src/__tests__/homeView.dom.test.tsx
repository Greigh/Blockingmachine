/**
 * HomeView — the Home section: is my network protected and current?
 * Layout contract: ProtectionCard → compile hero beside ScheduleCard in a
 * two-column row → NetworkReachStrip. The old dashboard's stats grid
 * collapses into the hero's single stat line. Children are module-mocked;
 * the contract is ordering, the stat line, and route-based navigation.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AppRoute } from '../routes';

const captured: Record<string, Record<string, unknown> | undefined> = {};

jest.unstable_mockModule('../components/ProtectionCard', () => ({
  ProtectionCard: (props: Record<string, unknown>) => {
    captured.protection = props;
    return 'PROTECTION-CARD';
  },
}));
jest.unstable_mockModule('../components/HttpsFilterCard', () => ({
  HttpsFilterCard: () => 'HTTPS-FILTER-CARD',
}));
jest.unstable_mockModule('../components/ScheduleCard', () => ({
  ScheduleCard: () => 'SCHEDULE-CARD',
}));
jest.unstable_mockModule('../components/NetworkReachStrip', () => ({
  NetworkReachStrip: (props: Record<string, unknown>) => {
    captured.reach = props;
    return 'NETWORK-REACH-STRIP';
  },
}));
// BrandLogo pulls in the PNG asset — not under test; the layout contract is.
jest.unstable_mockModule('../components/BrandLogo', () => ({
  BrandLogo: () => null,
}));

const { HomeView } = await import('../views/HomeView');

afterEach(() => {
  cleanup();
  for (const key of Object.keys(captured)) delete captured[key];
});

function bridge(overrides: Record<string, unknown> = {}) {
  (window as unknown as { electron: unknown }).electron = {
    getSources: jest.fn(async () => [
      { name: 'EasyList', url: 'https://a', enabled: true },
      { name: 'EasyPrivacy', url: 'https://b', enabled: false },
    ]),
    getCustomRules: jest.fn(async () => '||ads.example\n! comment\n||track.example'),
    getLastProcessTime: jest.fn(async () => 'Jan 1, 2026, 10:00 AM'),
    getCompilationHistory: jest.fn(async () => []),
    getFeedServerStatus: jest.fn(async () => ({ isRunning: false, port: 9191 })),
    onProcessProgress: jest.fn(() => () => {}),
    ...overrides,
  };
}

function renderHome(overrides: Record<string, unknown> = {}) {
  const navigate = jest.fn<(r: AppRoute) => void>();
  const props = {
    savePath: '/tmp/out',
    autoTriggerCompile: false,
    compileNonce: 0,
    onCompileConsumed: jest.fn(),
    navigate,
    ...overrides,
  };
  return { navigate, ...render(<HomeView {...props} />) };
}

describe('HomeView', () => {
  it('renders protection, the compile hero beside the schedule card, then the reach strip — in that order', async () => {
    bridge();
    await act(async () => {
      renderHome();
    });
    const text = document.body.textContent ?? '';
    const protectionIdx = text.indexOf('PROTECTION-CARD');
    const scheduleIdx = text.indexOf('SCHEDULE-CARD');
    const reachIdx = text.indexOf('NETWORK-REACH-STRIP');
    expect(protectionIdx).toBeGreaterThanOrEqual(0);
    expect(scheduleIdx).toBeGreaterThan(protectionIdx);
    expect(reachIdx).toBeGreaterThan(scheduleIdx);
  });

  it('mounts the compile hero with the single-line corpus stat', async () => {
    bridge();
    await act(async () => {
      renderHome();
    });
    // The workflow guide's step 2 repeats the label — the hero owns the button.
    const hero = document.querySelector('.hero-action-card')!;
    expect(hero).toBeTruthy();
    expect(hero.textContent).toContain('Run Processor');
    // The stats grid collapsed into one line: feeds enabled, custom rules, shield.
    expect(hero.textContent).toContain('1/2 feeds enabled');
    expect(hero.textContent).toContain('2 custom rules');
    expect(hero.textContent).toContain('Shield');
    // The old separate stats grid is gone.
    expect(document.querySelector('.overview-stats-grid')).toBeNull();
  });

  it('forwards route-based navigation — legacy view names translate through the registry', async () => {
    bridge();
    const { navigate } = renderHome();
    await act(async () => {});
    const onNavigate = captured.protection?.onNavigate as (view: string) => void;
    expect(typeof onNavigate).toBe('function');
    act(() => onNavigate('deploy'));
    expect(navigate).toHaveBeenCalledWith({ section: 'distribute', tab: null });
  });

  it('gives the reach strip a working Open Distribute callback', async () => {
    bridge();
    const { navigate } = renderHome();
    await act(async () => {});
    const onOpenDistribute = captured.reach?.onOpenDistribute as () => void;
    expect(typeof onOpenDistribute).toBe('function');
    act(() => onOpenDistribute());
    expect(navigate).toHaveBeenCalledWith({ section: 'distribute', tab: null });
  });
});
