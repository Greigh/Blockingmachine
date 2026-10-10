/**
 * RuleInspectorView lifecycle tests — the F-04 remediation, exercised in a real DOM.
 *
 * The defect class: IPC answers arriving after the view unmounted still ran setState,
 * and the copy-confirmation timer outlived the component. These tests mount the real
 * component, hold the IPC promises pending, unmount mid-flight, then resolve — and spy
 * on the timer functions to prove cleanup actually ran.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RuleInspectorView } from '../views/RuleInspectorView';
import type { AiScanResult, DomainInspectionResult } from '../types';

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ruleHit: DomainInspectionResult = {
  domain: 'ads.example.com',
  inputQuery: 'ads.example.com',
  verdict: 'blocked',
  matchingRule: '||ads.example.com^',
  sourceName: 'test-source',
  details: 'matched',
};

const aiHit: AiScanResult = {
  target: 'ads.example.com',
  domain: 'ads.example.com',
  verdict: 'suspicious',
  confidence: 90,
  riskLevel: 'medium',
  category: 'Advertising',
  reasons: ['test'],
  entropy: 3.1,
  isLikelyDga: false,
  cnames: [],
  resolvedIps: [],
  generatedRules: [],
  provider: 'local-heuristics',
  timestamp: '2026-01-01T00:00:00Z',
};

function installBridge(overrides: Record<string, unknown> = {}) {
  const bridge: Record<string, unknown> = {
    inspectDomain: jest.fn(() => Promise.resolve(ruleHit)),
    aiScanDomain: jest.fn(() => Promise.resolve(aiHit)),
    copyToClipboard: jest.fn(() => Promise.resolve({ success: true })),
    ...overrides,
  };
  (window as unknown as { electron: unknown }).electron = bridge;
  return bridge as Record<string, ReturnType<typeof jest.fn>>;
}

async function typeAndInspect() {
  const input = screen.getByPlaceholderText(/domain|URL|example/i);
  fireEvent.change(input, { target: { value: 'ads.example.com' } });
  const btn = screen.getByRole('button', { name: /inspect domain/i });
  await act(async () => {
    fireEvent.click(btn);
  });
}

describe('RuleInspectorView — lifecycle', () => {
  it('renders and runs the inspect flow to a rendered result', async () => {
    const bridge = installBridge();
    render(<RuleInspectorView />);
    await typeAndInspect();
    expect(bridge.inspectDomain).toHaveBeenCalled();
    expect(bridge.aiScanDomain).toHaveBeenCalled();
    // Result rendered — the matching-rule row is only present after setRuleResult ran.
    expect(screen.queryByText(/\|\|ads\.example\.com\^/)).not.toBeNull();
  });

  it('holds IPC pending, unmounts mid-flight, and resolves cleanly without post-unmount work', async () => {
    const inspect = deferred<DomainInspectionResult>();
    const scan = deferred<AiScanResult>();
    installBridge({
      inspectDomain: jest.fn(() => inspect.promise),
      aiScanDomain: jest.fn(() => scan.promise),
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<RuleInspectorView />);
    await typeAndInspect();
    view.unmount();
    // IPC answers land after unmount — guards must drop them silently.
    await act(async () => {
      inspect.resolve(ruleHit);
      scan.resolve(aiHit);
    });
    const reactWarnings = consoleError.mock.calls.filter((c) =>
      String(c[0]).includes('unmounted') || String(c[0]).includes('act('),
    );
    expect(reactWarnings).toEqual([]);
    consoleError.mockRestore();
  });

  it('cancels the copy-confirmation timeout on unmount', async () => {
    installBridge();
    const view = render(<RuleInspectorView />);
    await typeAndInspect();

    // The matching-rule copy button lives under the "Filter Rules & Origin" tab.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /filter rules & origin/i }));
    });
    const copyBtn = screen.getByRole('button', { name: /^copy$/i });

    const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
    const timeoutIds: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const id = realSetTimeout(fn, ms);
      timeoutIds.push(id);
      return id;
    }) as typeof setTimeout);

    await act(async () => {
      fireEvent.click(copyBtn);
    });
    // The 2.5s "Copied" timeout is armed and the button shows the confirmation.
    expect(setSpy).toHaveBeenCalled();
    expect(copyBtn.textContent).toBe('Copied');

    view.unmount();
    // Cleanup must have cleared exactly the timer the copy handler armed.
    expect(clearSpy.mock.calls.flat()).toEqual(expect.arrayContaining(timeoutIds));
  });

  it('the armed copy timer clears the label while mounted', async () => {
    jest.useFakeTimers();
    try {
      installBridge();
      render(<RuleInspectorView />);
      await act(async () => {
        const input = screen.getByPlaceholderText(/domain|URL|example/i);
        fireEvent.change(input, { target: { value: 'ads.example.com' } });
        fireEvent.click(screen.getByRole('button', { name: /inspect domain/i }));
        // flush the IPC promise resolutions through act
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /filter rules & origin/i }));
      });
      const copyBtn = screen.getByRole('button', { name: /^copy$/i });
      await act(async () => {
        fireEvent.click(copyBtn);
        await Promise.resolve();
      });
      expect(copyBtn.textContent).toBe('Copied');
      await act(async () => {
        jest.advanceTimersByTime(2600);
      });
      expect(copyBtn.textContent).toBe('Copy');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a second render mounts fresh with the mount flag restored', async () => {
    installBridge();
    const first = render(<RuleInspectorView />);
    await typeAndInspect();
    first.unmount();
    // Remount: isMountedRef must be re-armed by the effect, not left false.
    const second = render(<RuleInspectorView />);
    await typeAndInspect();
    expect(screen.queryByText(/\|\|ads\.example\.com\^/)).not.toBeNull();
    second.unmount();
  });
});
