import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ElementPicker } from '../content/elementPicker.js';
import { STORAGE_KEY_USER_COSMETICS } from '../shared/constants.js';

/**
 * Minimal document/global stubs. The picker is the piece that decides what gets
 * written to storage and injected into the page, so these tests assert on those
 * effects rather than on the visuals.
 */
interface StubStyle {
  textContent: string;
  id: string;
}

function installStubs(options: { matchCount?: number } = {}): {
  stored: Record<string, unknown>;
  injected: StubStyle[];
  sendMessage: jest.Mock;
} {
  const stored: Record<string, unknown> = {};
  const injected: StubStyle[] = [];
  const matchCount = options.matchCount ?? 1;

  (globalThis as any).CSS = (globalThis as any).CSS ?? {
    escape: (s: string) => s.replace(/[^\w-]/g, (ch) => `\\${ch}`),
  };

  const head = { appendChild: (el: StubStyle) => injected.push(el) };
  const documentStub = {
    head,
    documentElement: { appendChild: () => {}, removeChild: () => {} },
    body: { style: {} },
    getElementById: () => null,
    createElement: (tag: string) => ({
      tagName: tag.toUpperCase(),
      id: '',
      textContent: '',
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
      remove: () => {},
      addEventListener: () => {},
    }),
    querySelectorAll: (selector: string) =>
      Array.from({ length: typeof matchCount === 'function' ? 0 : matchCount }, () => ({
        selector,
      })),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as any).document = documentStub;
  (globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { hostname: 'example.com' },
  };
  (globalThis as any).location = { hostname: 'example.com' };
  (globalThis as any).requestAnimationFrame = (cb: () => void) => cb();

  const sendMessage = jest.fn();
  (globalThis as any).chrome = {
    runtime: { sendMessage, id: 'test' },
    storage: {
      local: {
        get: jest.fn(async (key: string) => ({ [key]: stored[key] })),
        set: jest.fn(async (patch: Record<string, unknown>) => {
          Object.assign(stored, patch);
        }),
      },
    },
  };

  return { stored, injected, sendMessage };
}

function fakeElement(overrides: Record<string, unknown> = {}) {
  const classes = (overrides.classList as string[]) ?? [];
  const attrs = (overrides.attrs as Record<string, string>) ?? {};
  return {
    tagName: (overrides.tagName as string) ?? 'DIV',
    id: (overrides.id as string) ?? '',
    classList: classes,
    style: { display: '' },
    isConnected: true,
    parentElement: null,
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 10, height: 10 }),
    closest: () => null,
    contains: () => false,
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ElementPicker.generateSelector', () => {
  test('returns a verified unique id selector', () => {
    installStubs();
    const el = fakeElement({ tagName: 'DIV', id: 'sponsored-top-banner', classList: ['ad'] });
    (globalThis as any).document.querySelectorAll = (selector: string) =>
      selector === '#sponsored-top-banner' ? [el] : [];

    const selector = new ElementPicker().generateSelector(el);
    expect(selector).toBe('#sponsored-top-banner');
  });

  test('returns an empty string rather than a page-wide selector', () => {
    installStubs();
    const bodyLike = fakeElement({ tagName: 'BODY', id: '' });
    // A bare tag selector would hide every element of that type: refuse instead.
    expect(new ElementPicker().generateSelector(bodyLike)).toBe('');
  });
});

describe('ElementPicker.applyRule', () => {
  test('persists the rule, hides the element, and reports the pick', async () => {
    const { stored, injected, sendMessage } = installStubs();
    const picker = new ElementPicker();
    const element = fakeElement({ tagName: 'ASIDE', classList: ['ad-slot'] });
    (globalThis as any).document.querySelectorAll = (selector: string) =>
      selector === '.ad-slot' ? [element] : [];
    (picker as any).currentElement = element;

    const ok = await picker.applyRule('.ad-slot', 1, 'element');

    expect(ok).toBe(true);
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toEqual(['.ad-slot']);
    expect(element.style.display).toBe('none');
    expect(injected.map((s) => s.textContent).join('')).toContain('.ad-slot');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ELEMENT_PICKED',
        payload: expect.objectContaining({ selector: '.ad-slot', mode: 'element' }),
      }),
    );
  });

  test('refuses a selector that would blank the page', async () => {
    const { stored, injected, sendMessage } = installStubs();
    const picker = new ElementPicker();

    for (const unsafe of ['div', 'body', '*', '.ad { }']) {
      expect(await picker.applyRule(unsafe, 1, 'element')).toBe(false);
    }

    expect(stored[STORAGE_KEY_USER_COSMETICS]).toBeUndefined();
    expect(injected).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('refuses a selector that matches far too many elements', async () => {
    const { stored } = installStubs({ matchCount: 5000 });
    const picker = new ElementPicker();

    expect(await picker.applyRule('.card', 5000, 'element')).toBe(false);
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toBeUndefined();
  });

  test('does not duplicate a rule that is already stored', async () => {
    const { stored } = installStubs();
    stored[STORAGE_KEY_USER_COSMETICS] = ['.ad-slot'];
    const picker = new ElementPicker();

    await picker.applyRule('.ad-slot', 1, 'element');
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toEqual(['.ad-slot']);
  });
});

describe('ElementPicker undo', () => {
  test('removes the rule from storage and restores the element', async () => {
    const { stored, sendMessage } = installStubs();
    const picker = new ElementPicker();
    stored[STORAGE_KEY_USER_COSMETICS] = ['.ad-slot', '.other'];
    (picker as any).hiddenElement = fakeElement({ classList: ['ad-slot'] });
    (picker as any).hiddenDisplay = '';

    const ok = await picker.undoLastRule('.ad-slot');

    expect(ok).toBe(true);
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toEqual(['.other']);
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'REMOVE_USER_COSMETIC',
      payload: { selector: '.ad-slot' },
    });
  });

  test('does nothing without a selector', async () => {
    installStubs();
    expect(await new ElementPicker().undoLastRule()).toBe(false);
  });
});

describe('ElementPicker preview', () => {
  test('shows and hides the highlighted element without destroying its styles', () => {
    installStubs();
    const picker = new ElementPicker();
    const element = fakeElement({ tagName: 'DIV', classList: ['ad-slot'] });
    element.style.background = 'red';
    (picker as any).currentElement = element;

    (picker as any).togglePreview();
    expect(element.style.display).toBe('none');

    (picker as any).togglePreview();
    expect(element.style.display).toBe('');
    // Regression: restoring used to overwrite the whole style attribute.
    expect(element.style.background).toBe('red');
  });

  test('restores a previewed element when the highlight moves on', () => {
    installStubs();
    const picker = new ElementPicker();
    const first = fakeElement({ tagName: 'DIV', classList: ['ad-slot'] });
    const second = fakeElement({ tagName: 'ASIDE', classList: ['promo'] });

    (picker as any).currentElement = first;
    (picker as any).togglePreview();
    expect(first.style.display).toBe('none');

    // Hovering elsewhere must not leave the first element invisible forever.
    (picker as any).currentElement = null;
    (picker as any).highlight(second);
    expect(first.style.display).toBe('');
    expect(second.style.display).toBe('');
  });

  test('closing the picker restores a previewed element', () => {
    installStubs();
    const picker = new ElementPicker();
    const element = fakeElement({ tagName: 'DIV', classList: ['ad-slot'] });
    (picker as any).active = true;
    (picker as any).currentElement = element;
    (picker as any).togglePreview();

    picker.stop();
    expect(element.style.display).toBe('');
  });
});

describe('ElementPicker context-menu entry points', () => {
  test('blockElement applies a rule for the given element', async () => {
    const { stored } = installStubs();
    const picker = new ElementPicker();
    const element = fakeElement({ tagName: 'DIV', classList: ['ad-slot'] });
    (globalThis as any).document.querySelectorAll = (selector: string) =>
      selector === '.ad-slot' ? [element] : [];

    expect(await picker.blockElement(element)).toBe(true);
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toEqual(['.ad-slot']);
  });

  test('blockElement refuses when no safe selector exists', async () => {
    const { stored } = installStubs();
    const picker = new ElementPicker();
    const body = fakeElement({ tagName: 'BODY' });

    expect(await picker.blockElement(body)).toBe(false);
    expect(stored[STORAGE_KEY_USER_COSMETICS]).toBeUndefined();
  });

  test('selectorFor exposes the verified selector', () => {
    installStubs();
    const picker = new ElementPicker();
    const element = fakeElement({ tagName: 'DIV', classList: ['promo'] });
    (globalThis as any).document.querySelectorAll = (selector: string) =>
      selector === '.promo' ? [element] : [];

    expect(picker.selectorFor(element)).toBe('.promo');
  });
});
