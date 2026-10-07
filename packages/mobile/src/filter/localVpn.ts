/**
 * JS surface for the `local-vpn` native module (Android only — iOS has no
 * VpnService equivalent without an approved Network Extension entitlement).
 * All functions no-op safely off Android / in builds where the module is absent.
 */

import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

export interface LocalVpnStatus {
  vpnRunning: boolean;
  dnsBlocked: number;
  dnsForwarded: number;
  proxyRunning: boolean;
  proxyPort: number;
  proxyAllowed: number;
  proxyBlocked: number;
}

interface NativeLocalVpn {
  needsVpnConsent(): Promise<boolean>;
  requestVpnConsent(): Promise<boolean>;
  startVpn(rulesPath: string, upstreamDns: string, label: string): Promise<boolean>;
  stopVpn(): Promise<boolean>;
  startProxy(rulesPath: string, port: number): Promise<boolean>;
  stopProxy(): Promise<boolean>;
  status(): Promise<LocalVpnStatus>;
  addListener(event: 'onVpnConsentResult', cb: (e: { granted: boolean }) => void): { remove(): void };
}

let mod: NativeLocalVpn | null = null;
function get(): NativeLocalVpn {
  if (!mod) mod = requireNativeModule<NativeLocalVpn>('LocalVpn');
  return mod;
}

export function isLocalVpnSupported(): boolean {
  return Platform.OS === 'android';
}

const EMPTY_STATUS: LocalVpnStatus = {
  vpnRunning: false,
  dnsBlocked: 0,
  dnsForwarded: 0,
  proxyRunning: false,
  proxyPort: 0,
  proxyAllowed: 0,
  proxyBlocked: 0,
};

export const LocalVpn = {
  needsVpnConsent: (): Promise<boolean> =>
    isLocalVpnSupported() ? get().needsVpnConsent() : Promise.resolve(false),
  /**
   * Resolves once consent is held: immediately if already granted, otherwise
   * after the system dialog answers (OK, cancel, or dismiss all resolve).
   */
  requestVpnConsent: (): Promise<boolean> => {
    if (!isLocalVpnSupported()) return Promise.resolve(false);
    const m = get();
    return new Promise<boolean>((resolve, reject) => {
      const sub = m.addListener('onVpnConsentResult', (e) => {
        sub.remove();
        resolve(e.granted);
      });
      m.requestVpnConsent()
        .then((already) => {
          if (already) {
            sub.remove();
            resolve(true);
          }
        })
        .catch((e) => {
          sub.remove();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });
  },
  startVpn: (rulesPath: string, upstreamDns = '8.8.8.8', label = 'Blockingmachine') =>
    get().startVpn(rulesPath, upstreamDns, label),
  stopVpn: () => get().stopVpn(),
  startProxy: (rulesPath: string, port = 8890) => get().startProxy(rulesPath, port),
  stopProxy: () => get().stopProxy(),
  status: (): Promise<LocalVpnStatus> =>
    isLocalVpnSupported() ? get().status().catch(() => EMPTY_STATUS) : Promise.resolve(EMPTY_STATUS),
};
