import { describe, expect, it } from '@jest/globals';
import { hostname as osHostname } from 'os';
import { advertiseTxt, advertiseFeedServer, mdnsServiceHost } from '../mdnsAdvertiser';

describe('advertiseTxt', () => {
  it('advertises api v1, the version, and an explicit token state', () => {
    expect(advertiseTxt({ version: '1.0.0-rc.9', tokenRequired: true })).toEqual({
      api: 'v1',
      version: '1.0.0-rc.9',
      token: 'required',
    });
    expect(advertiseTxt({ version: '1.0.0-rc.9', tokenRequired: false })).toEqual({
      api: 'v1',
      version: '1.0.0-rc.9',
      token: 'open',
    });
  });
});

describe('mdnsServiceHost', () => {
  it('never returns the machine LocalHostName — claiming it on the wire made macOS rename the host', () => {
    const host = mdnsServiceHost('Daniels-MacBook-Pro.local');
    expect(host).toBe('Daniels-MacBook-Pro-bm.local');
    expect(host).not.toBe('Daniels-MacBook-Pro.local');
  });

  it('normalizes all os.hostname() shapes to a DNS-safe unique name', () => {
    expect(mdnsServiceHost('My Mac.local')).toBe('My-Mac-bm.local');
    expect(mdnsServiceHost('host.internal')).toBe('host-bm.local');
    expect(mdnsServiceHost('workstation')).toBe('workstation-bm.local');
    expect(mdnsServiceHost('')).toBe('hub-bm.local');
    // The real hostname on this machine — whatever it is — must not round-trip.
    const real = mdnsServiceHost();
    expect(real.endsWith('-bm.local')).toBe(true);
    expect(real.toLowerCase()).not.toBe(osHostname().toLowerCase().replace(/\.$/, ''));
  });

  it('keeps long hostnames inside the DNS label limit', () => {
    const host = mdnsServiceHost(`${'a'.repeat(70)}.local`);
    for (const label of host.split('.')) expect(label.length).toBeLessThanOrEqual(63);
    expect(host.endsWith('-bm.local')).toBe(true);
  });
});

describe('advertiseFeedServer', () => {
  it('never throws and returns a stoppable handle even without multicast', () => {
    // jest has no bonjour wiring; load may succeed (dep is installed) but publish on a
    // port-less environment must still return a handle rather than throw.
    const handle = advertiseFeedServer({ port: 9191, version: 'test', tokenRequired: false });
    expect(typeof handle.stop).toBe('function');
    expect(() => handle.stop()).not.toThrow();
    expect(() => handle.stop()).not.toThrow(); // idempotent
  });
});
