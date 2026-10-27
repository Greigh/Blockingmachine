/**
 * HTTPS-capture helpers: the hub IP literal validation the settings card gates
 * "Start capture" on, the control-URL/host helpers, and the /v1/proxy/ca fetch
 * contract (certPem extraction + friendly failures).
 */
import {
  fetchHubCa,
  hostFromUrl,
  hubControlUrl,
  isValidIpLiteral,
  isValidIpv4,
  isValidIpv6,
} from '../filter/httpsCapture';
import { UserError } from '../errors';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

describe('isValidIpv4', () => {
  it('accepts dotted quads', () => {
    for (const ip of ['192.168.1.20', '10.0.0.5', '0.0.0.0', '255.255.255.255', '8.8.8.8']) {
      expect(isValidIpv4(ip)).toBe(true);
    }
  });

  it('rejects out-of-range, short, long, and octal-ish forms', () => {
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', 'a.b.c.d', '', '1.2.3.-4', '1.2.3.4 ']) {
      expect(isValidIpv4(bad)).toBe(false);
    }
  });
});

describe('isValidIpv6', () => {
  it('accepts full, compressed, and v4-tail forms', () => {
    for (const ip of [
      '2001:db8::5',
      'fd00::2',
      '::',
      '::1',
      '2001:0db8:0000:0000:0000:0000:0000:0005',
      'fe80::a00:27ff:fe4e:66a1',
      '::ffff:192.0.2.1',
      '2001:db8::192.0.2.1',
    ]) {
      expect(isValidIpv6(ip)).toBe(true);
    }
  });

  it('rejects bad groups, double compression, and non-compressing ::', () => {
    for (const bad of [
      '1::2::3',
      '1:2:3:4:5:6:7:8::',        // nothing left to compress
      '1:2:3:4:5:6:7:8:9',
      'gggg::1',
      '1:2:3:4:5:6:7',
      '::ffff:999.1.1.1',
      'fe80::1%eth0',
      '1.2.3.4',
      '',
    ]) {
      expect(isValidIpv6(bad)).toBe(false);
    }
  });
});

describe('isValidIpLiteral', () => {
  it('takes either family but not names', () => {
    expect(isValidIpLiteral('192.168.1.20')).toBe(true);
    expect(isValidIpLiteral('fd00::2')).toBe(true);
    expect(isValidIpLiteral('hub.local')).toBe(false);
    expect(isValidIpLiteral('blockingmachine.lan')).toBe(false);
  });
});

describe('hubControlUrl', () => {
  it('builds the control URL, bracketing v6 literals', () => {
    expect(hubControlUrl('192.168.1.20', '/v1/proxy/ca')).toBe('http://192.168.1.20:9293/v1/proxy/ca');
    expect(hubControlUrl('fd00::2', '/v1/proxy/ca')).toBe('http://[fd00::2]:9293/v1/proxy/ca');
  });
});

describe('hostFromUrl', () => {
  it('extracts the host, stripping ports and v6 brackets', () => {
    expect(hostFromUrl('http://192.168.1.20:9191')).toBe('192.168.1.20');
    expect(hostFromUrl('https://hub.example:8443/x')).toBe('hub.example');
    expect(hostFromUrl('http://[fd00::2]:9191')).toBe('fd00::2');
    expect(hostFromUrl('not a url')).toBeNull();
  });
});

describe('fetchHubCa', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

  it('returns certPem plus the optional identity fields', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ certPem: PEM, sha256Fingerprint: 'AA:BB', notAfter: '2030-01-01' }),
    })) as unknown as typeof fetch;
    const ca = await fetchHubCa('192.168.1.20', fetchMock);
    expect(ca.certPem).toBe(PEM);
    expect(ca.sha256Fingerprint).toBe('AA:BB');
    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.20:9293/v1/proxy/ca');
  });

  it('translates a non-ok answer into a friendly error', async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(fetchHubCa('192.168.1.20', fetchMock)).rejects.toThrow(UserError);
  });

  it('rejects a body without a certificate', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ unexpected: true }),
    })) as unknown as typeof fetch;
    await expect(fetchHubCa('192.168.1.20', fetchMock)).rejects.toThrow(/certificate/i);
  });

  it('rejects unreachable hubs without leaking raw errors', async () => {
    const fetchMock = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(fetchHubCa('192.168.1.20', fetchMock)).rejects.toThrow(UserError);
  });
});
