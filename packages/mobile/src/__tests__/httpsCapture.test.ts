/**
 * HTTPS-capture helpers: the hub IP literal validation the settings card gates
 * "Start capture" on, the URL/host helpers, the flag-129 data-port /ca.pem
 * fetch contract (PEM extraction + a locally computed fingerprint + friendly
 * failures), the pure-TS SHA-256 it stands on, and the paired-material store.
 */
import { createHash } from 'node:crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  fetchHubCa,
  fingerprintOfPem,
  hostFromUrl,
  hubControlUrl,
  hubDataUrl,
  isValidIpLiteral,
  isValidIpv4,
  isValidIpv6,
  loadCaFingerprint,
  loadHubPort,
  loadHubToken,
  loadPairedCa,
  pemToDer,
  saveCaFingerprint,
  saveHubPort,
  saveHubToken,
  savePairedCa,
} from '../filter/httpsCapture';
import { sha256Hex } from '../filter/sha256';
import { UserError } from '../errors';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

const store = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

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

describe('hubDataUrl', () => {
  it('builds the data-port URL on :9294 by default, honouring an override', () => {
    expect(hubDataUrl('192.168.1.20', '/v1/proxy/ca.pem')).toBe('http://192.168.1.20:9294/v1/proxy/ca.pem');
    expect(hubDataUrl('fd00::2', '/v1/proxy/ca.pem')).toBe('http://[fd00::2]:9294/v1/proxy/ca.pem');
    expect(hubDataUrl('192.168.1.20', '/v1/proxy/ca.pem', 8300)).toBe('http://192.168.1.20:8300/v1/proxy/ca.pem');
  });
});

describe('sha256 (pure TS)', () => {
  const enc = new TextEncoder();
  it('matches the published vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(enc.encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto across lengths around the block boundary', () => {
    for (const n of [1, 55, 56, 63, 64, 65, 119, 128, 1000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
      expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});

describe('fingerprintOfPem', () => {
  // A real PEM block (self-signed test material — the DER is what matters,
  // and the fingerprint is computed over exactly those bytes).
  const PEM =
    '-----BEGIN CERTIFICATE-----\n' +
    'MIIBszCCAVmgAwIBAgIUApKJHkHflzOiKBrju+/XxR7bk8YwCgYIKoZIzj0EAwIw\n' +
    'EDEOMAwGA1UEAwwFdGVzdDAeFw0yNjAxMDEwMDAwMDBaFw0yNzAxMDEwMDAwMDBa\n' +
    'MBAxDjAMBgNVBAMMBXRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASqeFqV\n' +
    'iU1y3Nw+fzqU6rPS6YFi9tyVqgDJ60aL+2Jlq9FsnEUMZ2sxXSqgg7/HHjCw\n' +
    'm9VoL5DsZVBB8MQIo1MwUTAdBgNVHQ4EFgQUYdM5nPImWxkg4Gg3+uS9cjBx\n' +
    'MWUwHwYDVR0jBBgwFoAUYdM5nPImWxkg4Gg3+uS9cjBxMWUwDwYDVR0TAQH/\n' +
    'BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA2+Omc0xCiX1CGxBZ2OPmzMF3\n' +
    'OkFpIGgKfhP7NsM2p2cCIBEqMq4g7Ps6w0Ic66HN1i26CMT0zFoSJGDuAD+x\n' +
    'V4lW\n' +
    '-----END CERTIFICATE-----\n';

  it('renders the same AA:BB fingerprint node:crypto derives from the DER', () => {
    const der = pemToDer(PEM);
    expect(der).not.toBeNull();
    const expected = createHash('sha256')
      .update(Buffer.from(der!))
      .digest('hex')
      .toUpperCase()
      .match(/../g)!
      .join(':');
    expect(fingerprintOfPem(PEM)).toBe(expected);
    expect(fingerprintOfPem(PEM)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('answers null for non-PEM input', () => {
    expect(fingerprintOfPem('not a cert')).toBeNull();
    expect(fingerprintOfPem('')).toBeNull();
    expect(fingerprintOfPem('-----BEGIN CERTIFICATE-----\n@@@\n-----END CERTIFICATE-----')).toBeNull();
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
  const PEM =
    '-----BEGIN CERTIFICATE-----\n' +
    'MIIBszCCAVmgAwIBAgIUApKJHkHflzOiKBrju+/XxR7bk8YwCgYIKoZIzj0EAwIw\n' +
    'EDEOMAwGA1UEAwwFdGVzdDAeFw0yNjAxMDEwMDAwMDBaFw0yNzAxMDEwMDAwMDBa\n' +
    'MBAxDjAMBgNVBAMMBXRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASqeFqV\n' +
    'iU1y3Nw+fzqU6rPS6YFi9tyVqgDJ60aL+2Jlq9FsnEUMZ2sxXSqgg7/HHjCw\n' +
    'm9VoL5DsZVBB8MQIo1MwUTAdBgNVHQ4EFgQUYdM5nPImWxkg4Gg3+uS9cjBx\n' +
    'MWUwHwYDVR0jBBgwFoAUYdM5nPImWxkg4Gg3+uS9cjBxMWUwDwYDVR0TAQH/\n' +
    'BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA2+Omc0xCiX1CGxBZ2OPmzMF3\n' +
    'OkFpIGgKfhP7NsM2p2cCIBEqMq4g7Ps6w0Ic66HN1i26CMT0zFoSJGDuAD+x\n' +
    'V4lW\n' +
    '-----END CERTIFICATE-----\n';

  const pemFetch = (body: string = PEM, ok = true, status = 200) =>
    jest.fn(async () => ({ ok, status, text: async () => body })) as unknown as typeof fetch;

  it('reads PEM from the data port and computes the fingerprint locally', async () => {
    const fetchMock = pemFetch();
    const ca = await fetchHubCa('192.168.1.20', fetchMock);
    expect(ca.certPem).toBe(PEM);
    // The fingerprint is derived on-device — the same value node:crypto
    // reports for the DER, rendered like the hub's card shows it.
    const der = pemToDer(PEM)!;
    const expected = createHash('sha256')
      .update(Buffer.from(der))
      .digest('hex')
      .toUpperCase()
      .match(/../g)!
      .join(':');
    expect(ca.sha256Fingerprint).toBe(expected);
    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.20:9294/v1/proxy/ca.pem');
  });

  it('honours a paired non-default data port', async () => {
    const fetchMock = pemFetch();
    await fetchHubCa('192.168.1.20', fetchMock, 8300);
    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.20:8300/v1/proxy/ca.pem');
  });

  it('translates a non-ok answer into a friendly error', async () => {
    const fetchMock = pemFetch('', false, 404);
    await expect(fetchHubCa('192.168.1.20', fetchMock)).rejects.toThrow(UserError);
  });

  it('rejects a body without a certificate', async () => {
    const fetchMock = pemFetch('no certificate here');
    await expect(fetchHubCa('192.168.1.20', fetchMock)).rejects.toThrow(/certificate/i);
  });

  it('refuses a PEM that does not decode — no install of garbage', async () => {
    // The markers are present but the base64 body yields no DER bytes.
    const fetchMock = pemFetch('-----BEGIN CERTIFICATE-----\n@@@\n-----END CERTIFICATE-----\n');
    await expect(fetchHubCa('192.168.1.20', fetchMock)).rejects.toThrow(/malformed/i);
  });

  it('rejects unreachable hubs without leaking raw errors', async () => {
    const fetchMock = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(fetchHubCa('192.168.1.20', fetchMock)).rejects.toThrow(UserError);
  });
});

describe('CA fingerprint persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('round-trips the last-confirmed fingerprint', async () => {
    store.getItem.mockResolvedValueOnce('AA:BB:CC');
    await expect(loadCaFingerprint()).resolves.toBe('AA:BB:CC');
    expect(store.getItem).toHaveBeenCalledWith('bm.httpsCapture.caFingerprint');

    await saveCaFingerprint('DD:EE:FF');
    expect(store.setItem).toHaveBeenCalledWith('bm.httpsCapture.caFingerprint', 'DD:EE:FF');
  });

  it('clears the stored fingerprint on null', async () => {
    await saveCaFingerprint(null);
    expect(store.removeItem).toHaveBeenCalledWith('bm.httpsCapture.caFingerprint');
    expect(store.setItem).not.toHaveBeenCalled();
  });

  it('degrades quietly when the store is unavailable', async () => {
    store.getItem.mockRejectedValueOnce(new Error('no store'));
    await expect(loadCaFingerprint()).resolves.toBeNull();
    store.setItem.mockRejectedValueOnce(new Error('no store'));
    await expect(saveCaFingerprint('AA')).resolves.toBeUndefined();
  });
});

describe('hub token + port persistence (flag 127/129 pairing material)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('round-trips the data-port token', async () => {
    store.getItem.mockResolvedValueOnce('s3cret-token');
    await expect(loadHubToken()).resolves.toBe('s3cret-token');
    expect(store.getItem).toHaveBeenCalledWith('bm.httpsCapture.hubToken');

    await saveHubToken('another');
    expect(store.setItem).toHaveBeenCalledWith('bm.httpsCapture.hubToken', 'another');
    await saveHubToken(null);
    expect(store.removeItem).toHaveBeenCalledWith('bm.httpsCapture.hubToken');
  });

  it('round-trips the data-port override and rejects garbage', async () => {
    store.getItem.mockResolvedValueOnce('8300');
    await expect(loadHubPort()).resolves.toBe(8300);
    store.getItem.mockResolvedValueOnce('99999');
    await expect(loadHubPort()).resolves.toBeNull();
    store.getItem.mockResolvedValueOnce('notaport');
    await expect(loadHubPort()).resolves.toBeNull();

    await saveHubPort(8300);
    expect(store.setItem).toHaveBeenCalledWith('bm.httpsCapture.hubPort', '8300');
    await saveHubPort(null);
    expect(store.removeItem).toHaveBeenCalledWith('bm.httpsCapture.hubPort');
  });
});

describe('paired CA persistence (flag 129)', () => {
  const PEM =
    '-----BEGIN CERTIFICATE-----\n' +
    'MIIBszCCAVmgAwIBAgIUApKJHkHflzOiKBrju+/XxR7bk8YwCgYIKoZIzj0EAwIw\n' +
    'EDEOMAwGA1UEAwwFdGVzdDAeFw0yNjAxMDEwMDAwMDBaFw0yNzAxMDEwMDAwMDBa\n' +
    'MBAxDjAMBgNVBAMMBXRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASqeFqV\n' +
    'iU1y3Nw+fzqU6rPS6YFi9tyVqgDJ60aL+2Jlq9FsnEUMZ2sxXSqgg7/HHjCw\n' +
    'm9VoL5DsZVBB8MQIo1MwUTAdBgNVHQ4EFgQUYdM5nPImWxkg4Gg3+uS9cjBx\n' +
    'MWUwHwYDVR0jBBgwFoAUYdM5nPImWxkg4Gg3+uS9cjBxMWUwDwYDVR0TAQH/\n' +
    'BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA2+Omc0xCiX1CGxBZ2OPmzMF3\n' +
    'OkFpIGgKfhP7NsM2p2cCIBEqMq4g7Ps6w0Ic66HN1i26CMT0zFoSJGDuAD+x\n' +
    'V4lW\n' +
    '-----END CERTIFICATE-----\n';
  const FP = fingerprintOfPem(PEM)!;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('round-trips the paired PEM + fingerprint', async () => {
    await savePairedCa({ certPem: PEM, sha256Fingerprint: FP });
    expect(store.setItem).toHaveBeenCalledWith('bm.httpsCapture.pairedCaPem', PEM);
    expect(store.setItem).toHaveBeenCalledWith('bm.httpsCapture.pairedCaSha256', FP);

    store.getItem.mockImplementation(async (k: string) =>
      k === 'bm.httpsCapture.pairedCaPem'
        ? PEM
        : k === 'bm.httpsCapture.pairedCaSha256'
          ? FP
          : null,
    );
    const loaded = await loadPairedCa();
    expect(loaded).toEqual({ certPem: PEM, sha256Fingerprint: FP });
  });

  it('re-verifies the stored PEM against the declared fingerprint — drift answers null', async () => {
    store.getItem.mockImplementation(async (k: string) =>
      k === 'bm.httpsCapture.pairedCaPem'
        ? PEM
        : k === 'bm.httpsCapture.pairedCaSha256'
          ? 'AA:BB:CC'
          : null,
    );
    await expect(loadPairedCa()).resolves.toBeNull();
  });

  it('clears both keys on null and degrades quietly on a broken store', async () => {
    await savePairedCa(null);
    expect(store.removeItem).toHaveBeenCalledWith('bm.httpsCapture.pairedCaPem');
    expect(store.removeItem).toHaveBeenCalledWith('bm.httpsCapture.pairedCaSha256');

    store.getItem.mockRejectedValueOnce(new Error('no store'));
    await expect(loadPairedCa()).resolves.toBeNull();
  });
});
