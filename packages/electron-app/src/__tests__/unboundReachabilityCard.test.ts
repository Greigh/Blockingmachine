/**
 * The reachability card, rendered.
 *
 * The suite has no jsdom, so these render through `react-dom/server` and assert the markup a user
 * would be shown — which is enough for the thing most likely to break here: the card says a
 * different amount depending on what is known (nothing, a remembered verdict, a fresh one), and a
 * snapshot-only render is the state the pane is in every time it is opened.
 */

import { describe, test, expect } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnboundReachabilityCard } from '../components/UnboundReachabilityCard';
import {
  classifyUnboundReachability,
  toReachabilitySnapshot,
  type UnboundReachabilityInput,
} from '../unboundReachability';

const NOW = '2026-09-29T12:00:00.000Z';

function verdict(overrides: Partial<UnboundReachabilityInput> = {}) {
  return classifyUnboundReachability({
    checkedAt: NOW,
    feedUrl: 'http://192.168.1.145:9191/unbound.conf',
    feedFileName: 'unbound.conf',
    feedServerRunning: true,
    selfFetch: {
      ok: true,
      status: 200,
      zones: 130_000,
      hasServerBlock: true,
      canaryDomain: 'doubleclick.net',
    },
    serves: [],
    probe: {
      target: '127.0.0.1:53',
      controlDomain: 'example.com',
      canary: { domain: 'doubleclick.net', answer: { state: 'nxdomain' } },
      control: { domain: 'example.com', answer: { state: 'resolved', addresses: ['93.184.216.34'] } },
      reference: { target: '1.1.1.1:53', answer: { state: 'resolved', addresses: ['104.16.132.229'] } },
    },
    ...overrides,
  });
}

function render(props: Partial<Parameters<typeof UnboundReachabilityCard>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(UnboundReachabilityCard, {
      result: null,
      snapshot: null,
      resolverAddress: '',
      resolverLabel: '127.0.0.1:53',
      resolverIsDefault: false,
      resolverError: null,
      referenceAddress: '',
      referenceLabel: '1.1.1.1:53',
      referenceError: null,
      referenceSource: 'explicit' as const,
      systemServers: [],
      resolverMessage: null,
      checking: false,
      now: NOW,
      onResolverAddressChange: () => {},
      onReferenceAddressChange: () => {},
      onSaveResolver: () => {},
      onCheck: () => {},
      ...props,
    }),
  );
}

describe('UnboundReachabilityCard', () => {
  test('invites a first check instead of implying the deployment works', () => {
    const markup = render();
    expect(markup).toContain('Check now');
    expect(markup).toContain('Run a check to see whether the file is being served');
    expect(markup).not.toContain('unbound-reachability-rows');
  });

  test('shows a busy label while the check is running', () => {
    const markup = render({ checking: true });
    expect(markup).toContain('Checking…');
    expect(markup).not.toContain('>Check now<');
  });

  test('renders the rows behind a fresh verdict, each with its own tone', () => {
    const markup = render({ result: verdict() });
    expect(markup).toContain('The drop-in is loaded and the resolver is blocking');
    expect(markup).toContain('unbound-reachability-badge ok');
    expect(markup).toContain('Drop-in served');
    expect(markup).toContain('130,000 local-zone statements');
    expect(markup).toContain('NXDOMAIN — the drop-in is loaded');
    expect(markup).toContain('unbound-reachability-row-value ok');
  });

  test('shows the remedy when the drop-in is not loaded', () => {
    const markup = render({
      result: verdict({
        probe: {
          target: '127.0.0.1:53',
          controlDomain: 'example.com',
          canary: { domain: 'doubleclick.net', answer: { state: 'resolved', addresses: ['1.2.3.4'] } },
          control: { domain: 'example.com', answer: { state: 'resolved', addresses: ['93.184.216.34'] } },
          reference: { target: '1.1.1.1:53', answer: { state: 'resolved' } },
        },
      }),
    });
    expect(markup).toContain('The resolver is not using the drop-in');
    expect(markup).toContain('unbound-reachability-badge warn');
    expect(markup).toContain('include:');
  });

  test('falls back to the remembered verdict when no check has run this session', () => {
    const markup = render({ snapshot: toReachabilitySnapshot(verdict()) });
    expect(markup).toContain('The drop-in is loaded and the resolver is blocking');
    expect(markup).toContain('Checked just now');
    // The remembered verdict carries no rows, and the card has to cope with that rather than
    // rendering an empty table.
    expect(markup).not.toContain('unbound-reachability-rows');
  });

  test('names the address the next check will query, and the problem when there is one', () => {
    expect(render({ resolverLabel: '192.168.1.1:5335' })).toContain('The check queries 192.168.1.1:5335');

    // The fallback is named as a fallback, so a default query to localhost is never mistaken for
    // an address the user chose.
    const fallback = render({ resolverLabel: '127.0.0.1:53', resolverIsDefault: true });
    expect(fallback).toContain('No address is set, so the check queries 127.0.0.1:53');

    const bad = render({ resolverLabel: null, resolverError: 'No resolver address is set.' });
    expect(bad).toContain('No resolver address is set.');
    expect(bad).toContain('value=""');
  });

  test('surfaces both the typed address and the saved-state message', () => {
    const markup = render({ resolverAddress: '192.168.1.1', resolverMessage: 'Saved.' });
    expect(markup).toContain('value="192.168.1.1"');
    expect(markup).toContain('Saved.');
    expect(markup).toContain('Save addresses');
  });

  test('explains what the reference resolver is for, and says when there is none', () => {
    const withReference = render({ referenceLabel: '1.1.1.1:53', referenceSource: 'explicit' });
    expect(withReference).toContain('also looked up on 1.1.1.1:53');

    const system = render({ referenceLabel: '192.168.1.1:53', referenceSource: 'system' });
    expect(system).toContain('this machine\u2019s own configured resolver');

    const none = render({ referenceLabel: null, referenceSource: 'none' });
    expect(none).toContain('reported as unconfirmed');
  });

  test('offers the address this machine already resolves through when the default is in use', () => {
    const markup = render({
      resolverLabel: '127.0.0.1:53',
      resolverIsDefault: true,
      systemServers: ['192.168.1.1'],
    });
    expect(markup).toContain('This machine resolves through 192.168.1.1');
  });

  test('says the verdict is re-checked on its own, and only where that is true', () => {
    // A verdict on screen means this hub produced one, and a stored verdict is one of the two
    // things that make a deployment worth watching — so the sentence is safe exactly here, and the
    // app being closed is named rather than left for someone to discover.
    const withVerdict = render({ result: verdict() });
    expect(withVerdict).toContain('re-checked every 15 minutes while the app is open');

    // Before the first check there is no deployment to watch, so promising a cadence would be a
    // claim about nothing.
    const empty = render();
    expect(empty).not.toContain('re-checked');
  });

  test('a refresh that failed while the app was closed is named on the remembered verdict', () => {
    // The flag's scenario end to end: the cron's reload failed at 02:14, the report was
    // persisted, and on next launch the stored snapshot — rows and all — carries the failure
    // instead of only the last green verdict.
    const snapshot = toReachabilitySnapshot(
      verdict({
        refreshReport: {
          lastOkAt: '2026-09-29T05:00:00.000Z',
          lastFailAt: '2026-09-29T10:14:00.000Z',
          lastFailDetail: 'unbound-checkconf rejected the file',
        },
      }),
    );
    const markup = render({ snapshot });
    expect(markup).toContain('scheduled refresh reported failure');
    expect(markup).toContain('unbound-checkconf rejected the file');
    expect(markup).toContain('unbound-refresh-alert');
  });

  test('a healed failure renders no alert — the success that wiped it is the newest evidence', () => {
    const snapshot = toReachabilitySnapshot(
      verdict({
        refreshReport: {
          lastFailAt: '2026-09-29T05:00:00.000Z',
          lastFailDetail: 'conf rejected',
          lastOkAt: '2026-09-29T11:00:00.000Z',
        },
      }),
    );
    const markup = render({ snapshot });
    expect(markup).not.toContain('unbound-refresh-alert');
  });
});
