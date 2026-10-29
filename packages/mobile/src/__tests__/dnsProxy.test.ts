/**
 * `readTunnelStatus` — the Settings-side decode of the extension's
 * `tunnel-status.json` heartbeat. The three states carry different meanings:
 * 'unavailable' means the shared container itself is missing (a broken
 * build), 'absent' means the extension has never reported, and 'ok' carries
 * the rules/packet counters that show whether DNS actually reaches it.
 */

// The app-group bridge is a native module — mock the require seam wholesale.
let mockStatus: string | Error = '';
jest.mock('../../modules/local-dns-proxy/src', () => ({
  __esModule: true,
  default: {
    publishRuleset: jest.fn(async () => 0),
    drainObservations: jest.fn(async () => ''),
    tunnelStatus: jest.fn(async () => {
      if (mockStatus instanceof Error) throw mockStatus;
      return mockStatus;
    }),
  },
}));

import { Platform } from 'react-native';
import { readTunnelStatus } from '../filter/dnsProxy';

beforeEach(() => {
  mockStatus = '';
});

it('reports absent while the extension has never written a heartbeat', async () => {
  if (Platform.OS !== 'ios') return; // jest-expo runs 'ios' — guard anyway
  await expect(readTunnelStatus()).resolves.toEqual({ state: 'absent' });
});

it('reports unavailable when the shared container cannot be reached', async () => {
  if (Platform.OS !== 'ios') return;
  mockStatus = new Error('App group container unavailable');
  await expect(readTunnelStatus()).resolves.toEqual({ state: 'unavailable' });
});

it('decodes the extension’s counters verbatim', async () => {
  if (Platform.OS !== 'ios') return;
  mockStatus = JSON.stringify({
    at: '2026-10-29T12:00:00Z',
    started_at: '2026-10-29T11:58:00Z',
    rules: 1234,
    packets: 56,
    blocked: 7,
    relayed: 49,
  });
  await expect(readTunnelStatus()).resolves.toEqual({
    state: 'ok',
    report: {
      at: '2026-10-29T12:00:00Z',
      startedAt: '2026-10-29T11:58:00Z',
      rules: 1234,
      packets: 56,
      blocked: 7,
      relayed: 49,
    },
  });
});

it('treats torn status writes as absent rather than crashing', async () => {
  if (Platform.OS !== 'ios') return;
  mockStatus = '{"rules":';
  await expect(readTunnelStatus()).resolves.toEqual({ state: 'absent' });
});
