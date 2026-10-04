/**
 * A bare `navigator.clipboard.writeText` rejects with `NotAllowedError` whenever the DOM
 * permission model refuses the write — an unhandled rejection the dev overlay shows as a crash
 * screen. `copyTextToClipboard` is the one path every Copy affordance takes: the preload bridge
 * first (Electron's `clipboard` module has no permission gate), the DOM API only as a fallback,
 * and a boolean result so "Copied!" indicators never claim a write that was refused.
 */

import { describe, expect, jest, test, afterEach } from '@jest/globals';
import { copyTextToClipboard } from '../clipboard';

const g = globalThis as {
  window?: { electron?: { copyToClipboard?: (text: string) => unknown } };
  navigator?: Navigator;
};

let bridgeMock: jest.Mock<(text: string) => unknown> | null = null;
let domMock: jest.Mock<(text: string) => Promise<void>> | null = null;
let navigatorPatched = false;

function install(bridge: ((text: string) => unknown) | undefined, dom: boolean) {
  g.window = bridge ? { electron: { copyToClipboard: bridge } } : undefined;
  if (dom) {
    domMock = jest.fn<(text: string) => Promise<void>>();
    Object.defineProperty(g.navigator ?? {}, 'clipboard', {
      value: { writeText: domMock },
      configurable: true,
    });
    navigatorPatched = true;
  }
}

afterEach(() => {
  delete g.window;
  if (navigatorPatched && g.navigator) {
    // @ts-expect-error — restoring the read-only global between cases.
    delete g.navigator.clipboard;
    navigatorPatched = false;
  }
});

describe('copyTextToClipboard', () => {
  test('prefers the preload bridge and never touches the DOM clipboard', async () => {
    bridgeMock = jest.fn<(text: string) => unknown>().mockReturnValue({ success: true });
    install(bridgeMock, true);
    await expect(copyTextToClipboard('||example.com^')).resolves.toBe(true);
    expect(bridgeMock).toHaveBeenCalledWith('||example.com^');
    expect(domMock).not.toHaveBeenCalled();
  });

  test('treats a void-returning bridge as success', async () => {
    install(() => undefined, true);
    await expect(copyTextToClipboard('x')).resolves.toBe(true);
    expect(domMock).not.toHaveBeenCalled();
  });

  test('a bridge refusal reports failure instead of claiming the write', async () => {
    install(() => Promise.resolve({ success: false, error: 'no clipboard' }), true);
    await expect(copyTextToClipboard('x')).resolves.toBe(false);
  });

  test('a throwing bridge falls back to the DOM path', async () => {
    install(
      () => {
        throw new Error('context destroyed');
      },
      true,
    );
    domMock!.mockResolvedValue(undefined);
    await expect(copyTextToClipboard('x')).resolves.toBe(true);
    expect(domMock).toHaveBeenCalledWith('x');
  });

  test('the DOM NotAllowedError resolves false — never an unhandled rejection', async () => {
    install(undefined, true);
    domMock!.mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'));
    await expect(copyTextToClipboard('x')).resolves.toBe(false);
  });

  test('with no bridge and no DOM clipboard it reports failure quietly', async () => {
    install(undefined, false);
    await expect(copyTextToClipboard('x')).resolves.toBe(false);
  });
});
