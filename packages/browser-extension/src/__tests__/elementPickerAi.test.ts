import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ElementPicker } from '../content/elementPicker.js';
import { ElementAiScanner } from '../content/elementScanner.js';
import {
  STORAGE_KEY_ELEMENT_AI_FEEDBACK,
  STORAGE_KEY_USER_COSMETICS,
} from '../shared/constants.js';
import { installFakePage, type FakePage } from './helpers/fakePage.js';

let page: FakePage;
let stored: Record<string, unknown>;
let sendMessage: jest.Mock;

/**
 * A page with two identical ad containers, so "block similar" has something to
 * group, plus a hero the model must be taught about before it will act.
 */
function installPage(): FakePage {
  return installFakePage([
    { tag: 'div', classes: ['adsbygoogle'], width: 300, height: 250 },
    { tag: 'div', classes: ['adsbygoogle'], width: 300, height: 250 },
    { tag: 'aside', classes: ['sidebar-unit'], width: 300, height: 600, text: 'Recommended for you' },
    { tag: 'div', classes: ['hero'], width: 1440, height: 420, text: 'Welcome to our store' },
    { tag: 'img', attributes: [{ name: 'src', value: 'https://metrics.example.net/p.gif' }], width: 1, height: 1 },
    { tag: 'div', classes: ['plain-widget'], width: 200, height: 100, text: 'Nothing to see' },
  ]);
}

beforeEach(() => {
  page = installPage();
  stored = {};
  sendMessage = jest.fn();

  (globalThis as Record<string, unknown>).chrome = {
    runtime: { sendMessage, id: 'test' },
    storage: {
      local: {
        get: jest.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const entry of keys) out[entry] = stored[entry];
          return out;
        }),
        set: jest.fn(async (patch: Record<string, unknown>) => {
          Object.assign(stored, patch);
        }),
      },
    },
  };
});

afterEach(() => {
  page.destroy();
});

function makePicker(): { picker: ElementPicker; scanner: ElementAiScanner } {
  const scanner = new ElementAiScanner();
  return { picker: new ElementPicker({ scanner }), scanner };
}

describe('ElementPicker — the HUD spells out the evidence', () => {
  const textOf = (element: { children: unknown[]; textContent: string }): string => {
    const nested = element.children.map((child) => textOf(child as { children: unknown[]; textContent: string })).join(' ');
    return `${element.textContent} ${nested}`.trim();
  };

  const hudText = (): string => {
    const hud = page.created.find((element) => element.id === 'bm-picker-hud');
    expect(hud).toBeDefined();
    return textOf(hud as unknown as { children: unknown[]; textContent: string });
  };

  it('lists the signals behind the verdict instead of only naming the class', () => {
    const { picker } = makePicker();
    picker.start();

    page.fireWindow('mousemove', { clientX: 10, clientY: 10, target: page.elements[0] });

    const hud = hudText();
    expect(hud).toContain('Likely ad');
    // The verdict, then the evidence: the identifier that said ad, and the rectangle.
    expect(hud).toContain('Ad markup');
    expect(hud).toContain('"adsbygoogle"');
    expect(hud).toContain('Standard ad size 300x250');
    picker.stop();
  });

  it('says a beacon is geometry, and names the box it measured', () => {
    const { picker } = makePicker();
    picker.start();

    page.fireWindow('mousemove', { clientX: 10, clientY: 10, target: page.elements[4] });

    const hud = hudText();
    expect(hud).toContain('Beacon geometry');
    expect(hud).toContain('1×1');
    picker.stop();
  });

  it('tells the user when there is no independent evidence, rather than nothing', () => {
    const { picker } = makePicker();
    picker.start();

    page.fireWindow('mousemove', { clientX: 10, clientY: 10, target: page.elements[5] });

    const hud = hudText();
    expect(hud).toContain('No independent evidence');
    picker.stop();
  });
});

describe('ElementPicker — learning from the user', () => {
  it('persists a "this is an ad" decision and applies it immediately', async () => {
    const { picker, scanner } = makePicker();
    const sidebar = page.elements[2];

    expect(scanner.classifyElement(sidebar).action).not.toBe('hide');
    expect(await picker.markElement(sidebar, 'hide')).toBe(true);

    const persisted = stored[STORAGE_KEY_ELEMENT_AI_FEEDBACK] as Record<string, number>;
    expect(persisted).toBeDefined();
    expect(Object.values(persisted)).toContain(1);

    // The very same element is now actionable, without a list update.
    const after = scanner.classifyElement(sidebar);
    expect(after.action).toBe('hide');
    expect(after.evidenceFamilies).toContain('user-choice');
  });

  it('persists a "not an ad" decision as a veto', async () => {
    const { picker, scanner } = makePicker();
    const ad = page.elements[0];
    expect(scanner.classifyElement(ad).action).toBe('hide');

    expect(await picker.markElement(ad, 'keep')).toBe(true);

    const after = scanner.classifyElement(ad);
    expect(after.action).toBe('leave');
    expect(after.reasons[0]).toContain('content');
    const persisted = stored[STORAGE_KEY_ELEMENT_AI_FEEDBACK] as Record<string, number>;
    expect(Object.values(persisted)).toContain(-1);
  });

  it('survives a storage failure without breaking the picker', async () => {
    const { picker } = makePicker();
    const setMock = (globalThis as any).chrome.storage.local.set as jest.Mock<() => Promise<void>>;
    setMock.mockRejectedValueOnce(new Error('quota'));

    const ok = await picker.markElement(page.elements[2], 'hide');
    // The decision still applies in this page; only persistence failed.
    expect(ok).toBe(true);
  });
});

describe('ElementPicker — blocking an AI cluster', () => {
  it('persists one rule for the whole cluster and injects it', async () => {
    const { picker, scanner } = makePicker();
    const result = scanner.scan();
    const adsense = result.groups.find((group) => group.selector === '.adsbygoogle');
    expect(adsense).toBeDefined();
    if (!adsense) return;

    const blocked = await picker.blockAiGroups([adsense]);
    expect(blocked.blocked).toBe(1);
    expect(blocked.selectors).toEqual(['.adsbygoogle']);
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toEqual(['.adsbygoogle']);
    expect(page.injectedStyles.length).toBeGreaterThan(0);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ELEMENT_PICKED', payload: expect.objectContaining({ selector: '.adsbygoogle' }) }),
    );
  });

  it('refuses selectors that fail validation', async () => {
    const { picker } = makePicker();
    const blocked = await picker.blockAiGroups([
      // A bare tag would hide every aside on every site.
      { key: 'aside', selector: 'aside', matches: 1, elementClass: 'Ad', count: 1, confidence: 99, label: '', reason: '', evidence: [] },
    ]);
    expect(blocked.blocked).toBe(0);
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toBeUndefined();
  });

  it('undoes every rule it added, in one call', async () => {
    const { picker } = makePicker();
    stored[STORAGE_KEY_USER_COSMETICS] = ['.adsbygoogle', '.onetrust-banner-sdk'];

    await picker.undoRules(['.adsbygoogle', '.onetrust-banner-sdk']);
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toEqual([]);
  });

  it('uses the AI cluster rather than a structural selector for "similar"', async () => {
    const { picker } = makePicker();
    const ad = page.elements[0];

    expect(await picker.blockSimilarTo(ad)).toBe(true);
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toEqual(['.adsbygoogle']);
  });
});
