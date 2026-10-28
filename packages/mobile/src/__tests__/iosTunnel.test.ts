/**
 * `iosTunnel.ts` — the standalone iOS VPN filter surface. Two honest paths:
 * absent module (Android/dev client) degrades to unsupported, and a present
 * module's status/error mapping behaves.
 */

import { Platform } from 'react-native';

describe('iosTunnel surface', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('unsupported when the native module is absent', async () => {
    jest.resetModules();
    jest.doMock('../../modules/local-tunnel/src', () => {
      throw new Error('Cannot find native module LocalTunnel');
    });
    const m = require('../filter/iosTunnel') as typeof import('../filter/iosTunnel');
    expect(m.isIosTunnelSupported()).toBe(false);
    expect(await m.getIosTunnelStatus()).toEqual({
      installed: false,
      enabled: false,
      connection: 'absent',
    });
  });

  test('status + enable map through on iOS', async () => {
    if (Platform.OS !== 'ios') return; // jest-expo runs 'ios' — guard anyway
    jest.resetModules();
    const setEnabled = jest.fn(async (_e: boolean) => {});
    jest.doMock('../../modules/local-tunnel/src', () => ({
      __esModule: true,
      default: {
        getStatus: async () => ({
          installed: true,
          enabled: true,
          connection: 'connected',
        }),
        setEnabled,
      },
    }));
    const m = require('../filter/iosTunnel') as typeof import('../filter/iosTunnel');
    expect(m.isIosTunnelSupported()).toBe(true);
    expect(await m.getIosTunnelStatus()).toEqual({
      installed: true,
      enabled: true,
      connection: 'connected',
    });
    await m.setIosTunnelEnabled(true);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  test('enable failure wraps the NE error with the consent context', async () => {
    if (Platform.OS !== 'ios') return;
    jest.resetModules();
    jest.doMock('../../modules/local-tunnel/src', () => ({
      __esModule: true,
      default: {
        getStatus: async () => ({
          installed: false,
          enabled: false,
          connection: 'absent',
        }),
        setEnabled: async () => {
          throw new Error('IPC failed');
        },
      },
    }));
    const m = require('../filter/iosTunnel') as typeof import('../filter/iosTunnel');
    // Post-reset class identity: re-require errors so instanceof compares the
    // same UserError the module under test throws.
    const { UserError } = require('../errors') as typeof import('../errors');
    await expect(m.setIosTunnelEnabled(true)).rejects.toThrow(UserError);
    await expect(m.setIosTunnelEnabled(true)).rejects.toThrow(/VPN configuration/);
  });
});
