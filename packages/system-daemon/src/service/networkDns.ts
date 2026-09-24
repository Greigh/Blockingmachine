/**
 * Operating System DNS Configuration Helpers
 * Provides commands and helpers to query, point, and restore OS resolver settings.
 */

export interface NetworkInterfaceInfo {
  serviceName: string;
  device?: string;
  isPrimary?: boolean;
}

/**
 * Commands to inspect, set, or restore DNS on macOS via networksetup
 */
export const MacDnsCommands = {
  listServices: 'networksetup -listallnetworkservices',
  getCurrentDns: (service: string) => `networksetup -getdnsservers "${service}"`,
  setLoopbackDns: (service: string, ip = '127.0.0.1') => `networksetup -setdnsservers "${service}" ${ip}`,
  restoreDhcpDns: (service: string) => `networksetup -setdnsservers "${service}" "Empty"`,
  flushCache: 'dscacheutil -flushcache && sudo killall -HUP mDNSResponder',
};

/**
 * Commands to inspect, set, or restore DNS on Linux via resolvectl or systemd-resolved
 */
export const LinuxDnsCommands = {
  setDns: (iface: string, ip = '127.0.0.1') => `resolvectl dns ${iface} ${ip}`,
  revertDns: (iface: string) => `resolvectl revert ${iface}`,
  flushCache: 'resolvectl flush-caches',
};

/**
 * Commands for Windows via netsh
 */
export const WindowsDnsCommands = {
  setDns: (interfaceName: string, ip = '127.0.0.1') =>
    `netsh interface ip set dns name="${interfaceName}" static ${ip}`,
  restoreDhcpDns: (interfaceName: string) =>
    `netsh interface ip set dns name="${interfaceName}" dhcp`,
  flushCache: 'ipconfig /flushdns',
};
