/**
 * JS surface for the `local-vpn` native module (Android only — iOS has no
 * VpnService equivalent without an approved Network Extension entitlement).
 * All functions no-op safely off Android / in builds where the module is absent.
 */

import { Platform } from 'react-native';
import { requireNativeModule } from 'expo';

export interface LocalVpnStatus {
  vpnRunning: boolean;
  dnsBlocked: number;
  dnsForwarded: number;
  dnsDroppedUnknown: number;
  dnsTimeouts: number;
  dnsEvictions: number;
  dnsReceiveErrors: number;
  proxyRunning: boolean;
  proxyPort: number;
  proxyAllowed: number;
  proxyBlocked: number;
}

export interface HttpsCaptureStatus {
  running: boolean;
  flowsOpened: number;
  flowsClosed: number;
  quicDropped: number;
}

interface NativeLocalVpn {
  needsVpnConsent(): Promise<boolean>;
  requestVpnConsent(): Promise<boolean>;
  startVpn(rulesPath: string, upstreamDns: string, label: string): Promise<boolean>;
  stopVpn(): Promise<boolean>;
  startProxy(rulesPath: string, port: number): Promise<boolean>;
  stopProxy(): Promise<boolean>;
  startHttpsCapture(hubHost: string, hubToken: string | null, hubPort: number): Promise<boolean>;
  stopHttpsCapture(): Promise<boolean>;
  setDisallowedApps(pkgs: string[]): Promise<string[]>;
  getDisallowedApps(): Promise<string[]>;
  httpsCaptureStatus(): Promise<HttpsCaptureStatus>;
  installCaCertificate(name: string, certPem: string): Promise<boolean>;
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
  dnsDroppedUnknown: 0,
  dnsTimeouts: 0,
  dnsEvictions: 0,
  dnsReceiveErrors: 0,
  proxyRunning: false,
  proxyPort: 0,
  proxyAllowed: 0,
  proxyBlocked: 0,
};

const EMPTY_CAPTURE: HttpsCaptureStatus = {
  running: false,
  flowsOpened: 0,
  flowsClosed: 0,
  quicDropped: 0,
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
      let sub: { remove: () => void } | null = m.addListener('onVpnConsentResult', (e) => {
        done(() => resolve(e.granted));
      });
      // The dialog can die without firing the result (activity killed) — a
      // hanging promise would pin the caller's busy state and leak the sub.
      const timer = setTimeout(() => done(() => resolve(false)), 60_000);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        sub?.remove();
        sub = null;
        fn();
      };
      m.requestVpnConsent()
        .then((already) => {
          if (already) done(() => resolve(true));
        })
        .catch((e) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });
  },
  startVpn: (rulesPath: string, upstreamDns = '8.8.8.8', label = 'Blockingmachine') =>
    isLocalVpnSupported() ? get().startVpn(rulesPath, upstreamDns, label) : Promise.resolve(false),
  stopVpn: () => (isLocalVpnSupported() ? get().stopVpn() : Promise.resolve(false)),
  startProxy: (rulesPath: string, port = 8890) =>
    isLocalVpnSupported() ? get().startProxy(rulesPath, port) : Promise.resolve(false),
  stopProxy: () => (isLocalVpnSupported() ? get().stopProxy() : Promise.resolve(false)),
  /**
   * Arm hub HTTPS capture on the tunnel — the hub engine then owns :80/:443
   * verdicts. `hubToken` is the flag-127 data-port credential, emitted as the
   * PROXY-v2 auth TLV on each flow; `hubPort` is the hub's data listener.
   */
  startHttpsCapture: (hubHost: string, hubToken: string | null = null, hubPort = 9294) =>
    isLocalVpnSupported() ? get().startHttpsCapture(hubHost, hubToken, hubPort) : Promise.resolve(false),
  stopHttpsCapture: () => (isLocalVpnSupported() ? get().stopHttpsCapture() : Promise.resolve(false)),
  /**
   * Replace the per-app bypass set (flag 128) — excluded packages never
   * enter the tunnel. Resolves to the names actually stored (the native side
   * drops invalid shapes); a running tunnel re-establishes to apply them.
   */
  setDisallowedApps: (pkgs: string[]) =>
    isLocalVpnSupported() ? get().setDisallowedApps(pkgs) : Promise.resolve([]),
  getDisallowedApps: (): Promise<string[]> =>
    isLocalVpnSupported() ? get().getDisallowedApps().catch(() => []) : Promise.resolve([]),
  httpsCaptureStatus: (): Promise<HttpsCaptureStatus> =>
    isLocalVpnSupported() ? get().httpsCaptureStatus().catch(() => EMPTY_CAPTURE) : Promise.resolve(EMPTY_CAPTURE),
  /** Fire Android's certificate-install UI with a hub CA PEM — a real user consent. */
  installCaCertificate: (name: string, certPem: string) =>
    isLocalVpnSupported() ? get().installCaCertificate(name, certPem) : Promise.resolve(false),
  status: (): Promise<LocalVpnStatus> =>
    isLocalVpnSupported() ? get().status().catch(() => EMPTY_STATUS) : Promise.resolve(EMPTY_STATUS),
};
