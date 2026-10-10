/**
 * ProtectionCard lifecycle tests — the flag-77 dashboard control. The card polls
 * `daemon:get-status` every 10s; the poll must stop at unmount and pending IPC must not
 * touch state afterwards.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProtectionCard } from '../components/ProtectionCard';
import type { DaemonStatusInfo } from '../types';

afterEach(cleanup);

const running: DaemonStatusInfo = {
  status: 'running',
  port: 5353,
  rulesLoaded: 120_000,
  stats: { totalQueries: 1234, blockRatePercent: 7 },
} as DaemonStatusInfo;

const stopped: DaemonStatusInfo = { status: 'stopped' } as DaemonStatusInfo;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function installBridge(overrides: Record<string, unknown> = {}) {
  const bridge: Record<string, unknown> = {
    getDaemonStatus: jest.fn(() => Promise.resolve(running)),
    startDaemonProcess: jest.fn(() => Promise.resolve({ success: true })),
    toggleDaemonProtection: jest.fn(() => Promise.resolve({ success: true })),
    ...overrides,
  };
  (window as unknown as { electron: unknown }).electron = bridge;
  return bridge as Record<string, ReturnType<typeof jest.fn>>;
}

describe('ProtectionCard — polling lifecycle', () => {
  it('polls daemon status on mount and renders the running state', async () => {
    const bridge = installBridge();
    render(<ProtectionCard />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.getDaemonStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Active')).not.toBeNull();
    expect(screen.queryByText(/120,000 rules loaded/)).not.toBeNull();
  });

  it('fires the 10s poll while mounted and stops after unmount', async () => {
    jest.useFakeTimers();
    try {
      const bridge = installBridge();
      const view = render(<ProtectionCard />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(bridge.getDaemonStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(bridge.getDaemonStatus).toHaveBeenCalledTimes(2);

      view.unmount();
      await act(async () => {
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      // Six more 10s windows elapsed — no poll survived unmount.
      expect(bridge.getDaemonStatus).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops an in-flight status answer when unmounted mid-flight', async () => {
    const status = deferred<DaemonStatusInfo>();
    installBridge({ getDaemonStatus: jest.fn(() => status.promise) });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<ProtectionCard />);
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();
    await act(async () => {
      status.resolve(running);
      await Promise.resolve();
    });
    const reactWarnings = consoleError.mock.calls.filter((c) =>
      String(c[0]).includes('unmounted') || String(c[0]).includes('act('),
    );
    expect(reactWarnings).toEqual([]);
    consoleError.mockRestore();
  });

  it('drops an in-flight action result when unmounted mid-flight', async () => {
    const action = deferred<{ success: boolean; message?: string }>();
    installBridge({
      getDaemonStatus: jest.fn(() => Promise.resolve(stopped)),
      startDaemonProcess: jest.fn(() => action.promise),
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<ProtectionCard />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start dns protection/i }));
    });
    view.unmount();
    await act(async () => {
      action.resolve({ success: true });
      await Promise.resolve();
    });
    const reactWarnings = consoleError.mock.calls.filter((c) =>
      String(c[0]).includes('unmounted') || String(c[0]).includes('act('),
    );
    expect(reactWarnings).toEqual([]);
    consoleError.mockRestore();
  });

  it('surfaces a failed action message while mounted', async () => {
    installBridge({
      getDaemonStatus: jest.fn(() => Promise.resolve(stopped)),
      startDaemonProcess: jest.fn(() => Promise.resolve({ success: false, message: 'daemon binary missing' })),
    });
    render(<ProtectionCard />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start dns protection/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('daemon binary missing')).not.toBeNull();
  });
});
