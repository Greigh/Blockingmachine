/**
 * The popup's file-download helper.
 *
 * There is no jsdom here, so the DOM and the object-URL factory are stubbed on `globalThis`. That is
 * the point: the behaviour worth pinning is not "an anchor was made" but the order and lifetime of
 * the object URL — a URL revoked before the browser has read it fails the download with no error
 * anywhere, and one never revoked leaks the blob for as long as the popup lives.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { downloadTextFile } from '../popup/downloadText.js';

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  style: Record<string, string>;
  click: () => void;
  remove: () => void;
  removed: boolean;
}

interface Harness {
  created: FakeAnchor[];
  appended: FakeAnchor[];
  revoked: string[];
  clicks: number;
}

function makeAnchor(harness: Harness, onClick: () => void): FakeAnchor {
  const anchor: FakeAnchor = {
    href: '',
    download: '',
    rel: '',
    style: {},
    removed: false,
    click: onClick,
    remove: () => {
      anchor.removed = true;
    },
  };
  harness.created.push(anchor);
  return anchor;
}

function installDom(onClick: () => void = () => {}): Harness {
  const harness: Harness = { created: [], appended: [], revoked: [], clicks: 0 };
  let urlCounter = 0;

  (globalThis as any).URL = {
    createObjectURL: jest.fn(() => `blob:test/${++urlCounter}`),
    revokeObjectURL: jest.fn((url: string) => harness.revoked.push(url)),
  };

  (globalThis as any).document = {
    createElement: jest.fn(() =>
      makeAnchor(harness, () => {
        harness.clicks += 1;
        onClick();
      }),
    ),
    body: {
      appendChild: (node: FakeAnchor) => {
        harness.appended.push(node);
      },
    },
  };

  return harness;
}

beforeEach(async () => {
  // Let a previous test's revoke timer fire while its own URL stub is still installed. The helper
  // resolves `URL` on the timer, so a straggler would otherwise land on this test's harness and
  // make the count depend on the order the tests ran in.
  await new Promise((resolve) => setTimeout(resolve, 0));
  delete (globalThis as any).document;
  delete (globalThis as any).URL;
});

describe('downloadTextFile', () => {
  test('offers the text under the requested name, and clicks the anchor once', () => {
    const harness = installDom();

    downloadTextFile('ledger.json', '{"sessions":[]}');

    expect(harness.created).toHaveLength(1);
    expect(harness.created[0].href).toBe('blob:test/1');
    expect(harness.created[0].download).toBe('ledger.json');
    expect(harness.created[0].rel).toBe('noopener');
    expect(harness.clicks).toBe(1);
    expect(harness.appended).toHaveLength(1);
  });

  test('detaches the anchor but does not revoke the URL before the click returns', () => {
    const harness = installDom();

    downloadTextFile('ledger.json', '{}');

    // Detached: a hidden anchor left in the popup accumulates with every export.
    expect(harness.created[0].removed).toBe(true);
    // Not revoked yet — the browser has not read the blob.
    expect(harness.revoked).toEqual([]);
  });

  test('revokes the object URL on a later task', async () => {
    const harness = installDom();

    downloadTextFile('ledger.json', '{}');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.revoked).toEqual(['blob:test/1']);
  });

  test('keeps each export on its own URL, so a second export cannot cancel the first', () => {
    const harness = installDom();

    downloadTextFile('a.json', '{}');
    downloadTextFile('b.json', '{}');

    expect(harness.created.map((anchor) => anchor.href)).toEqual(['blob:test/1', 'blob:test/2']);
    expect(harness.created.map((anchor) => anchor.download)).toEqual(['a.json', 'b.json']);
  });

  test('still detaches the anchor when the click throws', () => {
    const harness = installDom(() => {
      throw new Error('no gesture');
    });

    expect(() => downloadTextFile('ledger.json', '{}')).toThrow('no gesture');
    expect(harness.created[0].removed).toBe(true);
  });
});
