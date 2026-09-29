/**
 * A deliberately small fake DOM for testing the selector engine.
 *
 * The engine verifies every candidate selector against `query`, so the tests
 * need a matcher that behaves like `document.querySelectorAll` for the selector
 * shapes the engine can produce: compounds (`aside.ad`), ids, classes,
 * attribute selectors, `:nth-child(n)`, and child-combinator paths.
 */

export interface FakeElement {
  tagName: string;
  id: string;
  classes: string[];
  /** Mirrors the DOM's DOMTokenList for the engine's class handling. */
  classList: string[];
  attrs: Record<string, string>;
  parentElement: FakeElement | null;
  children: FakeElement[];
  isConnected: boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { top: number; left: number; width: number; height: number };
  closest(selector: string): FakeElement | null;
  contains(other: FakeElement): boolean;
  setAttribute(name: string, value: string): void;
  querySelectorAll(selector: string): FakeElement[];
}

interface ElementInit {
  tag?: string;
  id?: string;
  classes?: string[];
  attrs?: Record<string, string>;
}

function unescapeCss(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/** Parses one compound selector (no combinators). */
function parseCompound(part: string): {
  tag: string;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; value: string }>;
  nthChild: number | null;
} {
  let rest = part.trim();
  let nthChild: number | null = null;
  const nth = rest.match(/:nth-child\((\d+)\)/);
  if (nth) {
    nthChild = Number(nth[1]);
    rest = rest.replace(nth[0], '');
  }

  const attrs: Array<{ name: string; value: string }> = [];
  rest = rest.replace(/\[([a-z0-9-]+)="((?:[^"\\]|\\.)*)"\]/gi, (_m, name: string, value: string) => {
    attrs.push({ name: name.toLowerCase(), value: unescapeCss(value) });
    return '';
  });

  let id: string | null = null;
  const idMatch = rest.match(/#((?:\\.|[^\s.#[:])+)/);
  if (idMatch) {
    id = unescapeCss(idMatch[1]);
    rest = rest.replace(idMatch[0], '');
  }

  const classes: string[] = [];
  rest = rest.replace(/\.((?:\\.|[^\s.#[:])+)/g, (_m, cls: string) => {
    classes.push(unescapeCss(cls));
    return '';
  });

  return { tag: rest.trim().toLowerCase(), id, classes, attrs, nthChild };
}

function elementIndex(el: FakeElement): number {
  if (!el.parentElement) return 1;
  return el.parentElement.children.indexOf(el) + 1;
}

function matchesCompound(el: FakeElement, part: string): boolean {
  const parsed = parseCompound(part);
  if (parsed.tag && parsed.tag !== '*' && parsed.tag !== el.tagName.toLowerCase()) return false;
  if (parsed.id !== null && parsed.id !== el.id) return false;
  for (const cls of parsed.classes) {
    if (!el.classes.includes(cls)) return false;
  }
  for (const attr of parsed.attrs) {
    if ((el.getAttribute(attr.name) ?? null) !== attr.value) return false;
  }
  if (parsed.nthChild !== null && elementIndex(el) !== parsed.nthChild) return false;
  return true;
}

function matchesSelector(el: FakeElement, selector: string): boolean {
  const parts = selector.split('>').map((p) => p.trim());
  if (parts.length === 1) return matchesCompound(el, parts[0]);

  // Child chain: every part must match the corresponding node, walking up one
  // level at a time. Requiring strict adjacency matters — a lenient walk here
  // would accept selectors a browser rejects, hiding real bugs in path building.
  let node: FakeElement | null = el;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!node || !matchesCompound(node, parts[i])) return false;
    node = node.parentElement;
  }
  return true;
}

export function createElement(init: ElementInit = {}, children: FakeElement[] = []): FakeElement {
  const attrs = { ...(init.attrs ?? {}) };
  const el: FakeElement = {
    tagName: (init.tag ?? 'div').toUpperCase(),
    id: init.id ?? '',
    classes: [...(init.classes ?? [])],
    classList: [],
    attrs,
    parentElement: null,
    children: [],
    isConnected: true,
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 40 }),
    closest: (selector: string) => {
      let node: FakeElement | null = el;
      while (node) {
        if (matchesSelector(node, selector)) return node;
        node = node.parentElement;
      }
      return null;
    },
    contains: (other: FakeElement) => {
      let node: FakeElement | null = other;
      while (node) {
        if (node === el) return true;
        node = node.parentElement;
      }
      return false;
    },
    querySelectorAll: () => [],
  };

  for (const child of children) {
    child.parentElement = el;
    el.children.push(child);
  }

  // `classList` and `classes` must stay in sync, exactly as in a real element.
  el.classList = el.classes;

  return el;
}

/** Creates `body` with the given children and returns a query function. */
export function mount(children: FakeElement[]): {
  body: FakeElement;
  query: (selector: string) => FakeElement[];
} {
  const body = createElement({ tag: 'body' }, children);

  const all: FakeElement[] = [];
  const walk = (node: FakeElement): void => {
    all.push(node);
    node.children.forEach(walk);
  };
  walk(body);

  for (const el of all) {
    el.querySelectorAll = (selector: string) =>
      all.filter((candidate) => candidate !== el && el.contains(candidate) && matchesSelector(candidate, selector));
  }

  const query = (selector: string): FakeElement[] =>
    all.filter((candidate) => {
      try {
        return matchesSelector(candidate, selector);
      } catch {
        return false;
      }
    });

  return { body, query };
}
