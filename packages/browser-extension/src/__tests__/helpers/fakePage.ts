/**
 * A fake page for the content-side element AI.
 *
 * The scanner and the snapshot builder are the two places where the extension
 * touches the real DOM, so they need a DOM to be tested against. Rather than pull in
 * a full implementation, this models exactly the surface those two modules use —
 * and, deliberately, nothing more, so a new browser API creeping into a code path
 * shows up as a test failure rather than as a silent untested dependency.
 */

export interface FakeElementSpec {
  tag: string;
  id?: string;
  classes?: string[];
  attributes?: Array<{ name: string; value: string }>;
  text?: string;
  width?: number;
  height?: number;
  /** Number of `a` descendants reported by `querySelectorAll('a')`. */
  links?: number;
  childCount?: number;
}

export interface FakeElement {
  tagName: string;
  id: string;
  className: string;
  classList: string[];
  attributes: Array<{ name: string; value: string }>;
  textContent: string;
  childElementCount: number;
  /** Kept in sync by `appendChild`/`append`/`replaceChildren`, like the real thing. */
  firstElementChild: FakeElement | null;
  style: Record<string, string>;
  title: string;
  children: FakeElement[];
  parentElement: FakeElement | null;
  replaceChildren(...nodes: FakeElement[]): void;
  append(...nodes: FakeElement[]): void;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { top: number; left: number; width: number; height: number };
  querySelectorAll(selector: string): unknown[];
  contains(other: unknown): boolean;
  appendChild(child: FakeElement): void;
  remove(): void;
  addEventListener(): void;
  closest(selector: string): FakeElement | null;
}

/**
 * What tests actually hold: the fake, plus the real `Element` surface the code under
 * test expects. The intersection keeps both usable, so a test can call
 * `picker.markElement(element, …)` and still read `element.children`.
 */
export type FakeElementRef = FakeElement & Element;

export interface FakePage {
  /** Elements the scan can find, in document order. */
  elements: FakeElementRef[];
  /** Style elements the extension injected into `document.head`. */
  injectedStyles: FakeElementRef[];
  documentElement: {
    children: FakeElementRef[];
    appendChild(child: FakeElementRef): void;
    removeChild(child: FakeElementRef): void;
  };
  window: Record<string, unknown>;
  /** Everything created by `document.createElement` during the test. */
  created: FakeElementRef[];
  /**
   * Invoke a `window` listener the code under test registered. The picker drives
   * itself from `mousemove`/`keydown` on `window`, so without this its HUD — the
   * part of the picker a user actually reads — cannot be exercised at all.
   */
  fireWindow(type: string, event: unknown): void;
  /** Every `window` event the code registered a listener for, in order. */
  windowListenerTypes(): string[];
  destroy(): void;
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  const trimmed = selector.trim();
  if (trimmed === '*' || trimmed === '') return true;
  if (trimmed.startsWith('.')) return element.classList.includes(trimmed.slice(1));
  if (trimmed.startsWith('#')) return element.id === trimmed.slice(1);
  if (trimmed.startsWith('[')) {
    const name = trimmed.replace(/^\[|\]$/g, '').split('=')[0];
    return element.hasAttribute(name);
  }
  return element.tagName.toLowerCase() === trimmed.toLowerCase();
}

export function createFakeElement(spec: FakeElementSpec, onRemove?: (element: FakeElement) => void): FakeElementRef {
  const attributes = [...(spec.attributes ?? [])];
  if (spec.id) attributes.push({ name: 'id', value: spec.id });

  // A real `classList` is a DOMTokenList: iterable *and* with `.contains()`. Both
  // spellings appear in the code under test, so the fake supports both.
  const classList = [...(spec.classes ?? [])] as string[] & { contains(token: string): boolean };
  classList.contains = (token: string) => classList.includes(token);

  const element: FakeElement = {
    tagName: spec.tag.toUpperCase(),
    id: spec.id ?? '',
    className: (spec.classes ?? []).join(' '),
    classList,
    attributes,
    textContent: spec.text ?? '',
    childElementCount: spec.childCount ?? 0,
    firstElementChild: null,
    style: {},
    title: '',
    children: [],
    parentElement: null,
    hasAttribute: (name: string) => attributes.some((attribute) => attribute.name === name),
    getAttribute: (name: string) => attributes.find((attribute) => attribute.name === name)?.value ?? null,
    setAttribute: (name: string, value: string) => {
      const existing = attributes.find((attribute) => attribute.name === name);
      if (existing) existing.value = value;
      else attributes.push({ name, value });
      if (name === 'id') element.id = value;
    },
    getBoundingClientRect: () => ({
      top: 10,
      left: 20,
      width: spec.width ?? 300,
      height: spec.height ?? 250,
    }),
    querySelectorAll: (selector: string) => {
      if (selector === 'a') {
        return Array.from({ length: spec.links ?? 0 }, () => element);
      }
      return [];
    },
    contains: (other: unknown) => {
      if (other === element) return true;
      return element.children.some((child) => child.contains(other));
    },
    appendChild: (child: FakeElement) => {
      element.children.push(child);
      child.parentElement = element;
      element.childElementCount = element.children.length;
      element.firstElementChild = element.children[0] ?? null;
    },
    append: (...nodes: FakeElement[]) => {
      for (const node of nodes) element.appendChild(node);
    },
    replaceChildren: (...nodes: FakeElement[]) => {
      element.children = [...nodes];
      for (const node of nodes) node.parentElement = element;
      element.childElementCount = nodes.length;
      element.firstElementChild = nodes[0] ?? null;
    },
    remove: () => {
      if (element.parentElement) {
        element.parentElement.children = element.parentElement.children.filter((child) => child !== element);
        element.parentElement.childElementCount = element.parentElement.children.length;
        element.parentElement.firstElementChild = element.parentElement.children[0] ?? null;
        element.parentElement = null;
      }
      onRemove?.(element);
    },
    addEventListener: () => {},
    closest: () => null,
  };

  // Several guards start with `x instanceof Element`, which is a real check in a
  // browser and a `ReferenceError` in Node. When the helper has installed its stub
  // class, the fake elements are instances of it. Standalone calls (no installed
  // page) keep the plain object.
  const elementClass = (globalThis as { Element?: new () => unknown }).Element;
  if (typeof elementClass === 'function') Object.setPrototypeOf(element, elementClass.prototype);

  return element as unknown as FakeElementRef;
}

/** Installs the fake document/window globals and returns a handle to tear them down. */
export function installFakePage(specs: FakeElementSpec[]): FakePage {
  const elements: FakeElementRef[] = [];
  const created: FakeElementRef[] = [];

  // Installed before the first element is built: `createFakeElement` gives its elements
  // this prototype, and `x instanceof Element` is a guard several code paths start with.
  const previousElement = (globalThis as Record<string, unknown>).Element;
  class FakeElementClass {}
  (globalThis as Record<string, unknown>).Element = FakeElementClass;

  const injectedStyles: FakeElementRef[] = [];
  const documentElementChildren: FakeElementRef[] = [];
  const documentElement = {
    children: documentElementChildren,
    appendChild: (child: FakeElementRef) => {
      documentElementChildren.push(child);
    },
    removeChild: (child: FakeElementRef) => {
      const index = documentElementChildren.indexOf(child);
      if (index >= 0) documentElementChildren.splice(index, 1);
    },
  } as unknown as FakePage['documentElement'];

  for (const spec of specs) {
    elements.push(
      createFakeElement(spec, (removed) => {
        const index = documentElementChildren.indexOf(removed as FakeElementRef);
        if (index >= 0) documentElementChildren.splice(index, 1);
      }),
    );
  }

  const findAll = (selector: string): FakeElementRef[] => {
    const pool = [...elements, ...documentElementChildren, ...created];
    return pool.filter((element) => matchesSelector(element, selector));
  };

  const documentStub = {
    documentElement,
    body: { style: {} },
    head: {
      appendChild: (element: FakeElementRef) => {
        injectedStyles.push(element);
      },
    },
    querySelectorAll: (selector: string) => findAll(selector),
    getElementById: (id: string) => findAll(`#${id}`)[0] ?? null,
    createElement: (tag: string) => {
      const element =      createFakeElement({ tag }, (removed) => {
        const index = documentElementChildren.indexOf(removed as FakeElementRef);
        if (index >= 0) documentElementChildren.splice(index, 1);
      });
      created.push(element);
      return element;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const previousDocument = (globalThis as Record<string, unknown>).document;
  const previousWindow = (globalThis as Record<string, unknown>).window;
  const previousCSS = (globalThis as Record<string, unknown>).CSS;

  // Listeners the code under test registers on `window`, so a test can drive it the
  // way a pointer does.
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();

  (globalThis as Record<string, unknown>).document = documentStub;
  (globalThis as Record<string, unknown>).window = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const list = windowListeners.get(type) ?? [];
      list.push(handler);
      windowListeners.set(type, list);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      const list = windowListeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
      windowListeners.set(type, list);
    },
    // The picker defers its first scan through this, so it has to run.
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    clearTimeout: () => {},
    location: { hostname: 'example.com' },
  };
  (globalThis as Record<string, unknown>).CSS = {
    escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`),
  };
  // Toasts animate on the next frame; without this the page-level UI code throws in
  // a non-browser environment.
  (globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => callback();

  return {
    elements,
    injectedStyles,
    documentElement,
    window: (globalThis as Record<string, unknown>).window as Record<string, unknown>,
    created,
    fireWindow: (type: string, event: unknown) => {
      for (const handler of windowListeners.get(type) ?? []) handler(event);
    },
    windowListenerTypes: () => [...windowListeners.keys()],
    destroy: () => {
      (globalThis as Record<string, unknown>).document = previousDocument;
      (globalThis as Record<string, unknown>).window = previousWindow;
      (globalThis as Record<string, unknown>).CSS = previousCSS;
      (globalThis as Record<string, unknown>).Element = previousElement;
    },
  };
}
