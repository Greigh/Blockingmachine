/**
 * mDNS discovery — the hostname-vs-address split. Android's HTTP stack cannot
 * resolve `.local` names (only NsdManager multicasts), so a discovered server
 * must be dialed by its resolved address, not its advertised hostname.
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  browseServers,
  pickConnectHost,
  type DiscoveredServer,
} from '../api/discovery';

type Listener = (arg: unknown) => void;
const listeners: Record<string, Listener[]> = {};

jest.mock('react-native-zeroconf', () => ({
  __esModule: true,
  default: class {
    scan = jest.fn();
    stop = jest.fn();
    on(event: string, cb: Listener) {
      (listeners[event] ??= []).push(cb);
    }
    removeListener(event: string, cb: Listener) {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== cb);
    }
  },
}));

const emit = (event: string, arg: unknown) =>
  (listeners[event] ?? []).forEach((cb) => cb(arg));

describe('pickConnectHost', () => {
  it('prefers a resolved IPv4 over the .local hostname', () => {
    expect(
      pickConnectHost('hub.local.', ['10.0.2.15', 'fe80::1']),
    ).toBe('10.0.2.15');
  });

  it('brackets a bare IPv6 when no v4 resolved', () => {
    expect(pickConnectHost('hub.local.', ['fd00::15'])).toBe('[fd00::15]');
  });

  it('falls back to the hostname when nothing resolved', () => {
    expect(pickConnectHost('hub.local.', [])).toBe('hub.local.');
  });
});

describe('browseServers', () => {
  it('maps the resolved service to a dialable connectHost', () => {
    const found: DiscoveredServer[] = [];
    const session = browseServers({ onFound: (s) => found.push(s) });
    emit('resolved', {
      name: 'Blockingmachine Hub',
      host: 'daniels-macbook-pro-3.local.',
      port: 9191,
      addresses: ['10.0.2.15'],
      txt: { api: 'v1', version: '1.0.0-rc.10', token: 'open' },
    });
    session.stop();

    expect(found).toHaveLength(1);
    expect(found[0].host).toBe('daniels-macbook-pro-3.local.');
    expect(found[0].connectHost).toBe('10.0.2.15');
    expect(found[0].txt).toEqual({
      api: 'v1',
      version: '1.0.0-rc.10',
      token: 'open',
    });
  });

  it('keeps the hostname as connectHost when the service resolves no address', () => {
    const found: DiscoveredServer[] = [];
    const session = browseServers({ onFound: (s) => found.push(s) });
    emit('resolved', {
      name: 'Blockingmachine Hub',
      host: 'hub.local.',
      port: 9191,
      addresses: [],
      txt: {},
    });
    session.stop();

    expect(found[0].connectHost).toBe('hub.local.');
  });
});
