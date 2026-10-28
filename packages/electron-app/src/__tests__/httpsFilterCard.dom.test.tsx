/**
 * HttpsFilterCard lifecycle + surface tests — the P1 Task 5 pane. The card
 * polls `httpsfilter:status` every 10s like ProtectionCard polls the daemon;
 * the poll must stop at unmount, the needsAdmin consent path must not reach
 * for the macOS auth sheet until the user approves, and the pin list must
 * collapse the applied ledger to per-host effective state.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HttpsFilterCard } from '../components/HttpsFilterCard';
import type { HttpsFilterStatus } from '../types';

afterEach(cleanup);

const running: HttpsFilterStatus = {
  status: 'running',
  port: 9294,
  controlPort: 9293,
  rulesLoaded: 120_000,
  protectionEnabled: true,
  policyDegraded: false,
  uptimeSeconds: 3725,
  managedByApp: true,
  captureServiceInstalled: false,
  platform: 'darwin',
  stats: {
    flowsTotal: 120,
    flowsBlocked: 9,
    requestsBlocked: 14,
    flowsTunneled: 40,
    flowsTerminated: 80,
    pinsLearned: 2,
    rulesSize: 120_000,
    blockRatePercent: 11,
  },
};

const stopped: HttpsFilterStatus = {
  status: 'stopped',
  port: 9294,
  controlPort: 9293,
  rulesLoaded: 0,
  protectionEnabled: false,
  policyDegraded: false,
  uptimeSeconds: 0,
  managedByApp: false,
  captureServiceInstalled: false,
  platform: 'darwin',
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function installBridge(overrides: Record<string, unknown> = {}) {
  const bridge: Record<string, unknown> = {
    getHttpsFilterStatus: jest.fn(() => Promise.resolve(running)),
    getHttpsFilterCaTrust: jest.fn(() =>
      Promise.resolve({ success: true, state: 'absent', message: 'not installed' }),
    ),
    getHttpsFilterPins: jest.fn(() =>
      Promise.resolve({ success: true, pins: [], corruptLineCount: 0 }),
    ),
    startHttpsFilter: jest.fn(() => Promise.resolve({ success: true, message: 'started' })),
    stopHttpsFilter: jest.fn(() => Promise.resolve({ success: true, message: 'stopped' })),
    toggleHttpsFilterPause: jest.fn(() =>
      Promise.resolve({ success: true, protectionEnabled: false }),
    ),
    installHttpsFilterCa: jest.fn(() => Promise.resolve({ success: true, state: 'trusted' })),
    uninstallHttpsFilterCa: jest.fn(() => Promise.resolve({ success: true, state: 'absent' })),
    removeHttpsFilterPin: jest.fn(() => Promise.resolve({ success: true, message: 'removed' })),
    ...overrides,
  };
  (window as unknown as { electron: unknown }).electron = bridge;
  return bridge as Record<string, ReturnType<typeof jest.fn>>;
}

describe('HttpsFilterCard — status surface', () => {
  it('polls on mount and renders the running state with the stats strip', async () => {
    const bridge = installBridge();
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.getHttpsFilterStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Active')).not.toBeNull();
    expect(screen.queryByText(/120,000 rules loaded/)).not.toBeNull();
    // The stats strip: flows terminated/tunneled/blocked + block rate.
    expect(screen.queryByText('Terminated')).not.toBeNull();
    expect(screen.queryByText('Tunnelled')).not.toBeNull();
    expect(screen.queryByText('11%')).not.toBeNull();
    // Running engine → pins fetched too.
    expect(bridge.getHttpsFilterPins).toHaveBeenCalled();
    // No content-depth counters and no cosmetic index in this payload —
    // the secondary line stays hidden rather than rendering zeros.
    expect(screen.queryByText(/Content filtering/)).toBeNull();
  });

  it('renders the content-filtering line from P2 stats, hidden when empty', async () => {
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({
          ...running,
          stats: {
            ...running.stats!,
            htmlInjected: 12,
            responsesBlocked: 3,
            scriptletsInvoked: 34,
            cspRewrites: 2,
            skippedScriptlets: 1,
            injectionsSkipped: 4,
            cosmetic: {
              selectors: 129_601,
              exceptions: 11_000,
              scriptlets: 5_658,
              scriptletExceptions: 4,
              styles: 9,
            },
          },
        }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The index populations lead — "loaded but not injecting" must read
    // differently from "0 rules" — then each non-zero counter, with the
    // emitted (not executed) wording for scriptlets.
    expect(screen.queryByText(/Content filtering —/)).not.toBeNull();
    expect(
      screen.queryByText(/129,601 selectors · 5,658 scriptlets · 9 styles loaded/),
    ).not.toBeNull();
    expect(screen.queryByText(/12 pages injected/)).not.toBeNull();
    expect(screen.queryByText(/3 responses blocked/)).not.toBeNull();
    expect(screen.queryByText(/34 scriptlets emitted/)).not.toBeNull();
    expect(screen.queryByText(/2 CSP rewrites/)).not.toBeNull();
    expect(screen.queryByText(/1 scriptlets skipped/)).not.toBeNull();
    expect(screen.queryByText(/4 injections skipped/)).not.toBeNull();

    // A loaded-but-empty index still surfaces — "0 rules" is a distinct,
    // reportable state (the line shows only its populations segment).
    cleanup();
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({
          ...running,
          stats: {
            ...running.stats!,
            cosmetic: {
              selectors: 0,
              exceptions: 0,
              scriptlets: 0,
              scriptletExceptions: 0,
              styles: 0,
            },
          },
        }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/0 selectors · 0 scriptlets loaded/)).not.toBeNull();
    expect(screen.queryByText(/pages injected/)).toBeNull();
  });

  it('surfaces the LAN hub hint only when the data bind is off loopback', async () => {
    // LAN-bound engine — the P4 hub posture; the hint must name the bind
    // and the flag-127 posture honestly (open trusted-LAN fallback here —
    // the fixture reports no dataAuthRequired).
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({ ...running, bindHost: '192.168.1.20', controlBindHost: '127.0.0.1' }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/LAN hub mode/)).not.toBeNull();
    expect(screen.queryByText(/192\.168\.1\.20:9294/)).not.toBeNull();
    expect(screen.queryByText(/trusted-LAN fallback/)).not.toBeNull();
    expect(screen.queryByText(/Android capture/)).not.toBeNull();

    // A token-gated engine reads differently — the hint says the network
    // needs the credential the QR carries.
    cleanup();
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({
          ...running,
          bindHost: '192.168.1.20',
          controlBindHost: '127.0.0.1',
          dataAuthRequired: true,
          denyPrivateDestinations: true,
        }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/data-port token is required/)).not.toBeNull();
    expect(screen.queryByText(/Loopback\/private destinations are refused/)).not.toBeNull();
    expect(screen.queryByText(/trusted-LAN fallback/)).toBeNull();

    // Loopback binds never hint — including the ::1 and 127.x spellings.
    for (const loopback of ['127.0.0.1', '::1', 'localhost', '127.0.0.2']) {
      cleanup();
      installBridge({
        getHttpsFilterStatus: jest.fn(() =>
          Promise.resolve({ ...running, bindHost: loopback }),
        ),
      });
      render(<HttpsFilterCard />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByText(/LAN hub mode/)).toBeNull();
    }

    // An engine predating the field (bindHost absent) stays silent too.
    cleanup();
    installBridge();
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/LAN hub mode/)).toBeNull();
  });

  it('shows the capture hint per platform when the capture service is not installed', async () => {
    // darwin — the hint's static text names the script via the fallback line.
    installBridge();
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/install-macos-capture\.sh/)).not.toBeNull();
    expect(screen.queryByText(/this Mac's traffic/)).not.toBeNull();

    // win32 — same hint, but the elevation note is an Administrator
    // PowerShell (Windows has no sudo verb to paste).
    cleanup();
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({ ...running, platform: 'win32' }),
      ),
      getHttpsFilterInstallScript: jest.fn(() =>
        Promise.resolve({
          success: true,
          command:
            'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Blockingmachine\\scripts\\install-windows-capture.ps1" "C:\\Blockingmachine\\filterProxy.cjs" "C:\\Blockingmachine\\node.exe"',
        }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/elevated \(Administrator\) PowerShell/)).not.toBeNull();
    expect(screen.queryByText(/install-windows-capture\.ps1/)).not.toBeNull();

    // linux — "with sudo".
    cleanup();
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({ ...running, platform: 'linux' }),
      ),
      getHttpsFilterInstallScript: jest.fn(() =>
        Promise.resolve({
          success: true,
          command:
            "sudo bash '/opt/Blockingmachine/scripts/install-linux-capture.sh' '/opt/Blockingmachine/filterProxy.cjs' '/usr/bin/node'",
        }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/the installer with sudo/)).not.toBeNull();
    expect(screen.queryByText(/install-linux-capture\.sh/)).not.toBeNull();
  });

  it('hides the capture hint when the service is installed or the platform is unsupported', async () => {
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({ ...running, captureServiceInstalled: true }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/install-macos-capture\.sh/)).toBeNull();

    // A platform with no installer script gets no hint at all.
    cleanup();
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({ ...running, platform: 'freebsd' }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/Transparent capture is not installed/)).toBeNull();
  });

  it('renders degraded with its own pill and honest detail', async () => {
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({ ...running, status: 'degraded', policyDegraded: true }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('Degraded')).not.toBeNull();
    expect(screen.queryByText(/in-memory only/)).not.toBeNull();
  });
});

describe('HttpsFilterCard — controls', () => {
  it('Run proxy calls startHttpsFilter; stop is offered only when app-managed', async () => {
    const bridge = installBridge({
      getHttpsFilterStatus: jest.fn(() => Promise.resolve(stopped)),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('Proxy off')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run proxy/i }));
      await Promise.resolve();
    });
    expect(bridge.startHttpsFilter).toHaveBeenCalledTimes(1);

    cleanup();
    installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        // A live engine the app did not spawn gets no Stop button — the
        // manager would refuse it anyway with the launchd pointer.
        Promise.resolve({ ...running, managedByApp: false, captureServiceInstalled: true }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: /stop proxy/i })).toBeNull();
  });

  it('Pause filtering toggles protection off; paused shows Resume', async () => {
    const bridge = installBridge();
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /pause filtering/i }));
      await Promise.resolve();
    });
    // running + protectionEnabled → pause asks for enabled:false.
    expect(bridge.toggleHttpsFilterPause).toHaveBeenCalledWith(false);

    cleanup();
    const pausedBridge = installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({ ...running, status: 'paused', protectionEnabled: false }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('Paused')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /resume filtering/i }));
      await Promise.resolve();
    });
    expect(pausedBridge.toggleHttpsFilterPause).toHaveBeenCalledWith(true);
  });
});

describe('HttpsFilterCard — CA row', () => {
  it('needsAdmin holds for explicit approval before elevating', async () => {
    const bridge = installBridge({
      installHttpsFilterCa: jest
        .fn()
        .mockImplementationOnce(() =>
          Promise.resolve({
            success: false,
            state: 'needs-admin',
            needsAdmin: true,
            message: 'Administrator approval is required to trust the CA.',
          }),
        )
        .mockImplementationOnce(() =>
          Promise.resolve({ success: true, state: 'trusted', message: 'trusted' }),
        ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /install ca/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The unprivileged attempt ran exactly once, unelevated, and the consent
    // strip appeared — no osascript-equivalent {elevate:true} call yet.
    expect(bridge.installHttpsFilterCa).toHaveBeenCalledTimes(1);
    expect(bridge.installHttpsFilterCa).toHaveBeenLastCalledWith(undefined);
    // The consent strip (distinct from the error banner that names the cause).
    expect(screen.queryByText(/macOS will ask for your password/i)).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve & install/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.installHttpsFilterCa).toHaveBeenCalledTimes(2);
    expect(bridge.installHttpsFilterCa).toHaveBeenLastCalledWith({ elevate: true });
    expect(screen.queryByText(/macOS will ask for your password/i)).toBeNull();
  });

  it('a trusted CA repaints the row without an Install button', async () => {
    installBridge({
      getHttpsFilterCaTrust: jest.fn(() =>
        Promise.resolve({
          success: true,
          state: 'trusted',
          message: 'trusted',
          sha256Fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77',
          keyWrapped: true,
        }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('trusted')).not.toBeNull();
    expect(screen.queryByText(/key wrapped by the OS keychain/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^install ca$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove ca/i })).not.toBeNull();
  });
});

describe('HttpsFilterCard — pins', () => {
  it('collapses the ledger to per-host effective state and removes on click', async () => {
    const bridge = installBridge({
      getHttpsFilterPins: jest.fn(() =>
        Promise.resolve({
          success: true,
          corruptLineCount: 0,
          pins: [
            { ts: 1, host: 'gone.example', action: 'pin', reason: 'handshake-abort' },
            { ts: 2, host: 'gone.example', action: 'remove' },
            { ts: 3, host: 'bypass.example', action: 'bypass', reason: 'user' },
            { ts: 4, host: 'pin.example', action: 'pin', reason: 'handshake-abort' },
          ],
        }),
      ),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // 'gone.example' pinned then removed → absent; the two live rows remain.
    expect(screen.queryByText('gone.example')).toBeNull();
    expect(screen.queryByText('bypass.example')).not.toBeNull();
    expect(screen.queryByText('pin.example')).not.toBeNull();
    expect(screen.queryByText(/Pins & bypasses \(2\)/)).not.toBeNull();

    const removeButtons = screen.getAllByRole('button', { name: /^remove$/i });
    await act(async () => {
      fireEvent.click(removeButtons[0]);
      await Promise.resolve();
    });
    // Newest-first ordering → the first row is pin.example (ts 4).
    expect(bridge.removeHttpsFilterPin).toHaveBeenCalledWith('pin.example');
  });
});

describe('HttpsFilterCard — one-engine lifecycle surface', () => {
  it('suppresses Run proxy under an installed capture service — the managed-by line instead', async () => {
    const bridge = installBridge({
      getHttpsFilterStatus: jest.fn(() =>
        Promise.resolve({ ...stopped, captureServiceInstalled: true }),
      ),
      startHttpsFilter: jest.fn(() => Promise.resolve({ success: true, message: 'started' })),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The launchd service owns the ports — offering a user-context spawn
    // here would race its KeepAlive recovery into a self-capture.
    expect(screen.queryByRole('button', { name: /run proxy/i })).toBeNull();
    expect(screen.queryByText(/managed by the capture service/)).not.toBeNull();
    expect(bridge.startHttpsFilter).not.toHaveBeenCalled();
  });

  it('renders the rendered-for-this-host install command when the IPC answers one', async () => {
    installBridge({
      getHttpsFilterStatus: jest.fn(() => Promise.resolve(stopped)),
      getHttpsFilterInstallScript: jest.fn(() =>
        Promise.resolve({
          success: true,
          command:
            "sudo bash '/opt/Blockingmachine/scripts/install-macos-capture.sh' '/opt/Blockingmachine/filterProxy.cjs' '/opt/Blockingmachine/Blockingmachine' '/Users/t/Documents/Blockingmachine/browser.txt'",
        }),
      ),
      copyToClipboard: jest.fn(),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The rendered absolute invocation — not the repo-relative hint.
    expect(
      screen.queryByText(/\/opt\/Blockingmachine\/scripts\/install-macos-capture\.sh/),
    ).not.toBeNull();
    expect(screen.queryByText(/sudo scripts\/install-macos-capture\.sh/)).toBeNull();
  });

  it('warns when the answering engine CA drifts from the trusted record', async () => {
    installBridge({
      getHttpsFilterStatus: jest.fn(() => Promise.resolve({ ...running, caDrift: true })),
    });
    render(<HttpsFilterCard />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/CA changed — re-verify trust/)).not.toBeNull();
  });
});

describe('HttpsFilterCard — polling lifecycle', () => {
  it('fires the 10s poll while mounted and stops after unmount', async () => {
    jest.useFakeTimers();
    try {
      const bridge = installBridge();
      const view = render(<HttpsFilterCard />);
      await act(async () => {
        await Promise.resolve();
      });
      const callsAfterMount = bridge.getHttpsFilterStatus.mock.calls.length;

      await act(async () => {
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(bridge.getHttpsFilterStatus.mock.calls.length).toBe(callsAfterMount + 1);

      view.unmount();
      await act(async () => {
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      // Six more 10s windows elapsed — no poll survived unmount.
      expect(bridge.getHttpsFilterStatus.mock.calls.length).toBe(callsAfterMount + 1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops an in-flight status answer when unmounted mid-flight', async () => {
    const status = deferred<HttpsFilterStatus>();
    installBridge({ getHttpsFilterStatus: jest.fn(() => status.promise) });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<HttpsFilterCard />);
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
});
