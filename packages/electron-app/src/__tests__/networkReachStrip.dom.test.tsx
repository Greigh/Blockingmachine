/**
 * NetworkReachStrip — the Home surface's answer to "and is it reaching my
 * devices?": one chip per live signal — configured sinkholes with refresh
 * freshness, the DNS daemon, the browser extension's last contact, the LAN
 * feed — plus the Open Distribute escape.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NetworkReachStrip } from '../components/NetworkReachStrip';

afterEach(cleanup);

const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

function bridge(overrides: Record<string, unknown> = {}) {
  (window as unknown as { electron: unknown }).electron = {
    getSinkholeConfig: jest.fn(async () => ({ piholeUrl: 'http://pi.hole/admin' })),
    getDaemonStatus: jest.fn(async () => ({ status: 'running' })),
    getLiveServices: jest.fn(async () => ({
      daemon: { status: 'running' },
      feed: { isRunning: true, port: 9191 },
      extension: { lastContactAt: twoHoursAgo },
      autoSchedule: '24h',
    })),
    getDeployRefreshReports: jest.fn(async () => ({
      unbound: { lastOkAt: twoHoursAgo, lastOkPeer: 'router.lan' },
    })),
    ...overrides,
  };
}

describe('NetworkReachStrip', () => {
  it('renders a chip per configured/live target with freshness text', async () => {
    bridge();
    await act(async () => {
      render(<NetworkReachStrip onOpenDistribute={jest.fn()} />);
    });
    expect(screen.getByText(/Pi-hole/).textContent).toContain('configured');
    expect(screen.getByText(/Unbound/).textContent).toContain('router.lan');
    expect(screen.getByText(/DNS daemon/i).textContent).toContain('running');
    expect(screen.getByText(/extension/i).textContent).toContain('ago');
    expect(screen.getByText(/feed/i).textContent).toContain('9191');
  });

  it('omits targets with no signal — AdGuard/Home Assistant unconfigured shows nothing', async () => {
    bridge();
    await act(async () => {
      render(<NetworkReachStrip onOpenDistribute={jest.fn()} />);
    });
    expect(screen.queryByText(/AdGuard/)).toBeNull();
    expect(screen.queryByText(/Home Assistant/)).toBeNull();
  });

  it('says "configured" for sinkholes — their API paths never emit refresh reports', async () => {
    bridge();
    await act(async () => {
      render(<NetworkReachStrip onOpenDistribute={jest.fn()} />);
    });
    expect(screen.getByText(/Pi-hole/).textContent).toContain('configured');
  });

  it('names a fresh failure even when an older success is on record', async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    bridge({
      getDeployRefreshReports: jest.fn(async () => ({
        unbound: { lastOkAt: twoHoursAgo, lastFailAt: fiveMinutesAgo, lastFailPeer: 'router.lan' },
      })),
    });
    await act(async () => {
      render(<NetworkReachStrip onOpenDistribute={jest.fn()} />);
    });
    const chip = screen.getByText(/Unbound/);
    expect(chip.textContent).toContain('refresh failed');
    expect(chip.textContent).not.toContain('synced');
  });

  it('reports the feed as unknown rather than down when the aggregate read fails', async () => {
    bridge({
      getLiveServices: jest.fn(async () => { throw new Error('aggregate down'); }),
      getFeedServerStatus: jest.fn(async () => ({ isRunning: true, port: 9191 })),
    });
    await act(async () => {
      render(<NetworkReachStrip onOpenDistribute={jest.fn()} />);
    });
    expect(screen.getByText(/LAN feed/).textContent).toContain('9191');
  });

  it('renders no recipe-target chip when reports are empty — a report is the only proof they ran', async () => {
    bridge({ getDeployRefreshReports: jest.fn(async () => ({})) });
    await act(async () => {
      render(<NetworkReachStrip onOpenDistribute={jest.fn()} />);
    });
    expect(screen.queryByText(/Unbound/)).toBeNull();
  });

  it('fires onOpenDistribute from the Open Distribute button', async () => {
    bridge();
    const onOpenDistribute = jest.fn();
    await act(async () => {
      render(<NetworkReachStrip onOpenDistribute={onOpenDistribute} />);
    });
    fireEvent.click(screen.getByRole('button', { name: /Open Distribute/i }));
    expect(onOpenDistribute).toHaveBeenCalled();
  });
});
