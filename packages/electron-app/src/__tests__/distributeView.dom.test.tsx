/**
 * DistributeView — the Distribute section host, DeployHubView re-skinned.
 * Twelve deploy targets behind a grouped InnerNav (DNS & routers /
 * Apps & devices / This Mac) plus a Network row for the LAN feed & pairing
 * pane. The hub's state, paneProps narrowing and selectEffect dispatch carry
 * over verbatim — what changes is the rail: a nav landmark instead of a flat
 * tab strip. At ≤460px the rail collapses to a picker above the pane.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DistributeView } from '../views/DistributeView';

afterEach(cleanup);

function bridge(overrides: Record<string, unknown> = {}) {
  (window as unknown as { electron: unknown }).electron = {
    getFeedServerStatus: jest.fn(async () => ({ isRunning: false })),
    getDaemonStatus: jest.fn(async () => ({ status: 'stopped' })),
    getSinkholeConfig: jest.fn(async () => ({})),
    ...overrides,
  };
}

/** Queries scoped to the inner nav landmark — every label also exists in the select picker. */
function nav() {
  return within(screen.getByRole('navigation', { name: 'Deploy targets' }));
}

async function renderView(overrides: Record<string, unknown> = {}) {
  const props = {
    savePath: '/tmp/out',
    onNavigateSettings: jest.fn(),
    onTriggerCompile: jest.fn(),
    ...overrides,
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<DistributeView {...props} />);
  });
  return view;
}

beforeEach(() => {
  bridge();
});

describe('DistributeView inner nav', () => {
  it('renders the three registry groups plus the network row', async () => {
    await renderView();
    const landmark = screen.getByRole('navigation', { name: 'Deploy targets' });
    expect(landmark).toBeTruthy();
    expect(nav().getByText('DNS & routers')).toBeTruthy();
    expect(nav().getByText('Apps & devices')).toBeTruthy();
    expect(nav().getByText('This Mac')).toBeTruthy();
    expect(nav().getByText('LAN feed & pairing')).toBeTruthy();
  });

  it('defaults to the registry default target (browser extension)', async () => {
    await renderView();
    const active = document.querySelector('.inner-nav-item.active');
    expect(active?.textContent).toContain('Browser ext');
  });

  it('selecting a target renders its pane', async () => {
    await renderView();
    fireEvent.click(nav().getByText('Pi-hole'));
    expect(await screen.findByText('Pi-hole Admin URL')).toBeTruthy();
  });

  it('honours initialTarget for deep links', async () => {
    await renderView({ initialTarget: 'pihole' });
    expect(await screen.findByText('Pi-hole Admin URL')).toBeTruthy();
  });

  it('network row renders the LAN feed & pairing pane', async () => {
    await renderView();
    fireEvent.click(nav().getByText('LAN feed & pairing'));
    expect(document.querySelector('.inner-nav-item.active')?.textContent).toContain(
      'LAN feed & pairing',
    );
    expect(await screen.findByText('LAN feed server')).toBeTruthy();
  });

  it('runs the registry select effect on select (daemon status refresh)', async () => {
    const getDaemonStatus = jest.fn(async () => ({ status: 'stopped' }));
    bridge({ getDaemonStatus });
    await renderView();
    getDaemonStatus.mockClear();
    fireEvent.click(nav().getByText('System daemon'));
    await act(async () => {});
    expect(getDaemonStatus).toHaveBeenCalled();
  });
});

describe('DistributeView status dots', () => {
  it('marks configured sinkholes live and unconfigured idle', async () => {
    bridge({
      getSinkholeConfig: jest.fn(async () => ({
        piholeApiKeyConfigured: true,
        piholeUrl: 'http://pi.hole/admin',
      })),
    });
    await renderView();
    const pihole = nav().getByText('Pi-hole').closest('.inner-nav-item')!;
    expect(pihole.querySelector('.inner-nav-dot')?.className).toContain('live');
    const bind = nav().getByText('BIND').closest('.inner-nav-item')!;
    expect(bind.querySelector('.inner-nav-dot')?.className).toContain('idle');
  });

  it('marks the system daemon live when it reports running', async () => {
    bridge({ getDaemonStatus: jest.fn(async () => ({ status: 'running' })) });
    await renderView();
    const row = nav().getByText('System daemon').closest('.inner-nav-item')!;
    expect(row.querySelector('.inner-nav-dot')?.className).toContain('live');
  });

  it('marks the network row live when the feed server runs', async () => {
    bridge({ getFeedServerStatus: jest.fn(async () => ({ isRunning: true })) });
    await renderView();
    const row = nav().getByText('LAN feed & pairing').closest('.inner-nav-item')!;
    expect(row.querySelector('.inner-nav-dot')?.className).toContain('live');
  });
});

describe('DistributeView narrow picker', () => {
  it('renders a select with every item for the ≤460px collapse', async () => {
    await renderView();
    const select = document.querySelector<HTMLSelectElement>('.inner-nav-select');
    expect(select).not.toBeNull();
    const labels = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
    // Options carry the status text too — the rail's dots are display:none'd at
    // this width, so the signal has to reach AT through the option itself.
    expect(labels).toContain('Pi-hole — not set up');
    expect(labels).toContain('LAN feed & pairing — not set up');
    expect(labels.length).toBe(13);
  });
});
