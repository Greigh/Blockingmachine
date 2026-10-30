/**
 * NetworkPane — the LAN feed & pairing home under Distribute › Network.
 * The old Settings pairing card verbatim, plus a Connection options card for
 * `customWebhookUrl`, the one field the dead sinkhole card owned that no
 * deploy pane renders. The audit below is the point of the task: every field
 * the removed Settings sections carried must resolve to a home — a pane that
 * already renders it, or this one.
 */

import React from 'react';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NetworkPane } from '../views/NetworkPane';

afterEach(cleanup);

function bridge(overrides: Record<string, unknown> = {}) {
  (window as unknown as { electron: unknown }).electron = {
    getFeedToken: jest.fn(async () => ({ configured: false, mode: 'legacy' })),
    getHttpsFilterDataToken: jest.fn(async () => ({ configured: false })),
    getSinkholeConfig: jest.fn(async () => ({})),
    getFeedPairingPayload: jest.fn(async () => ({ success: false })),
    ...overrides,
  };
}

const appRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('NetworkPane', () => {
  it('renders the LAN auth, feed token, and data-port token controls', async () => {
    bridge();
    await act(async () => {
      render(<NetworkPane />);
    });
    expect(screen.getByText('LAN Authentication')).toBeTruthy();
    // The feed-token field is identified by its placeholder, not a label.
    expect(screen.getByPlaceholderText(/origin-guarded|enter a new one to replace/i)).toBeTruthy();
    expect(screen.getByText('HTTPS Data-Port Token')).toBeTruthy();
    expect(screen.getByText('Show pairing QR')).toBeTruthy();
  });

  it('offers Start feed server when the pairing payload reports it stopped', async () => {
    const startFeedServer = jest.fn(async () => ({}));
    bridge({
      startFeedServer,
      getFeedPairingPayload: jest.fn(async () => ({
        success: true,
        running: false,
        url: 'http://192.168.1.2:9191',
        payload: 'bm://pair',
        tokenConfigured: false,
      })),
    });
    await act(async () => {
      render(<NetworkPane />);
    });
    fireEvent.click(screen.getByText('Show pairing QR'));
    const start = await screen.findByText('Start feed server');
    fireEvent.click(start);
    await act(async () => {});
    expect(startFeedServer).toHaveBeenCalled();
  });

  it('renders the Connection options card with the custom webhook field', async () => {
    bridge({ getSinkholeConfig: jest.fn(async () => ({ customWebhookUrl: 'https://hook.example/x' })) });
    await act(async () => {
      render(<NetworkPane />);
    });
    const card = screen.getByText('Connection options').closest('.setting-card')!;
    expect(card).toBeTruthy();
    const input = within(card as HTMLElement).getByLabelText('Custom webhook URL') as HTMLInputElement;
    expect(input.value).toBe('https://hook.example/x');
  });

  it('saves the custom webhook URL through the shared sinkhole config', async () => {
    const setSinkholeConfig = jest.fn<(cfg: Record<string, unknown>) => Promise<unknown>>(
      async () => ({}),
    );
    bridge({
      getSinkholeConfig: jest.fn(async () => ({ piholeUrl: 'http://pi.hole/admin' })),
      setSinkholeConfig,
    });
    await act(async () => {
      render(<NetworkPane />);
    });
    const card = screen.getByText('Connection options').closest('.setting-card') as HTMLElement;
    const input = within(card).getByLabelText('Custom webhook URL');
    fireEvent.change(input, { target: { value: 'https://hook.example/new' } });
    fireEvent.click(within(card).getByText('Save'));
    await act(async () => {});
    expect(setSinkholeConfig).toHaveBeenCalled();
    const saved = setSinkholeConfig.mock.calls[0][0] as unknown as { customWebhookUrl?: string };
    expect(saved.customWebhookUrl).toBe('https://hook.example/new');
  });
});

describe('orphan-field audit', () => {
  // Every sinkholeConfig/Settings field the deleted Network Sinkholes card
  // rendered. Each must appear in a deploy pane (its real home) or in
  // NetworkPane itself — nothing may drop on the floor.
  const SINKHOLE_CARD_FIELDS = [
    'piholeUrl',
    'piholeApiKey',
    'adguardHomeUrl',
    'adguardHomeUser',
    'adguardHomePassword',
    'haToken',
    'haWebhookUrl',
    'adguardDirectPort',
    'adguardDirectUrl',
    'syncOnCompile',
    'allowInsecureLocalTls',
    'customWebhookUrl',
  ];

  const paneSources = readdirSync(join(appRoot, 'src/deploy/panes'))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => readFileSync(join(appRoot, 'src/deploy/panes', name), 'utf8'));
  const networkPane = readFileSync(join(appRoot, 'src/views/NetworkPane.tsx'), 'utf8');

  it.each(SINKHOLE_CARD_FIELDS)('%s has a home — a deploy pane or NetworkPane', (field) => {
    const inPane = paneSources.some((src) => src.includes(field));
    const inNetworkPane = networkPane.includes(field);
    expect(inPane || inNetworkPane).toBe(true);
  });

  it('the settings file no longer renders any sinkhole-credential field', () => {
    const settings = readFileSync(join(appRoot, 'src/Settings.tsx'), 'utf8');
    for (const field of SINKHOLE_CARD_FIELDS) {
      expect(settings).not.toContain(`sinkholeConfig.${field}`);
    }
  });
});
