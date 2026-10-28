import { decodePairingPayload, encodePairingPayload, PairingError } from '../api/pairing';

describe('decodePairingPayload', () => {
  it('decodes a full payload', () => {
    const raw = JSON.stringify({ v: 1, url: 'http://192.168.1.10:9191', token: 'abc' });
    expect(decodePairingPayload(raw)).toEqual({
      url: 'http://192.168.1.10:9191',
      token: 'abc',
    });
  });

  it('accepts a payload without a token (open LAN server)', () => {
    const raw = JSON.stringify({ v: 1, url: '192.168.1.10:9191' });
    const payload = decodePairingPayload(raw);
    expect(payload.url).toBe('http://192.168.1.10:9191');
    expect(payload.token).toBeUndefined();
  });

  it('rejects non-JSON and wrong-shape payloads', () => {
    expect(() => decodePairingPayload('not json')).toThrow(PairingError);
    expect(() => decodePairingPayload('"just a string"')).toThrow(PairingError);
    expect(() => decodePairingPayload('{"v":2,"url":"http://x"}')).toThrow(PairingError);
    expect(() => decodePairingPayload('{"v":1}')).toThrow(PairingError);
    expect(() => decodePairingPayload('{"v":1,"url":"not a url !!"}')).toThrow();
  });

  it('decodes alternate urls for multi-homed hubs and drops bad entries', () => {
    const raw = JSON.stringify({
      v: 1,
      url: 'http://192.168.1.10:9191',
      urls: ['http://192.168.1.10:9191', '10.8.0.2:9191', 'not a url !!', 42],
    });
    const payload = decodePairingPayload(raw);
    expect(payload.url).toBe('http://192.168.1.10:9191');
    expect(payload.urls).toEqual([
      'http://192.168.1.10:9191',
      'http://10.8.0.2:9191',
    ]);
  });

  it('round-trips through encodePairingPayload', () => {
    const payload = { url: 'http://hub.local:9191', token: 'tok' };
    expect(decodePairingPayload(encodePairingPayload(payload))).toEqual(payload);
  });

  it('drops blank/whitespace tokens on encode', () => {
    expect(encodePairingPayload({ url: 'http://x:1', token: undefined })).toBe(
      '{"v":1,"url":"http://x:1"}',
    );
  });

  it('decodes the flag-127/129 HTTPS fields when the QR carries them', () => {
    const raw = JSON.stringify({
      v: 1,
      url: 'http://192.168.1.10:9191',
      token: 'feed-tok',
      httpsCaPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      httpsCaSha256: 'AA:BB:CC',
      httpsToken: 'data-tok',
      httpsPort: 8300,
    });
    expect(decodePairingPayload(raw)).toEqual({
      url: 'http://192.168.1.10:9191',
      token: 'feed-tok',
      // The PEM is trimmed like every other string field — the trailing
      // newline is wire noise, not certificate material.
      httpsCaPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      httpsCaSha256: 'AA:BB:CC',
      httpsToken: 'data-tok',
      httpsPort: 8300,
    });
  });

  it('drops malformed https fields without failing the scan', () => {
    const raw = JSON.stringify({
      v: 1,
      url: 'http://192.168.1.10:9191',
      httpsCaPem: 42,
      httpsCaSha256: '   ',
      httpsToken: '',
      httpsPort: 'not-a-port',
    });
    const payload = decodePairingPayload(raw);
    expect(payload.httpsCaPem).toBeUndefined();
    expect(payload.httpsCaSha256).toBeUndefined();
    expect(payload.httpsToken).toBeUndefined();
    expect(payload.httpsPort).toBeUndefined();
  });

  it('rejects out-of-range ports but keeps the rest of the payload', () => {
    for (const port of [0, -1, 65536, 1.5]) {
      const payload = decodePairingPayload(
        JSON.stringify({ v: 1, url: 'http://x:1', httpsPort: port }),
      );
      expect(payload.httpsPort).toBeUndefined();
      expect(payload.url).toBe('http://x:1');
    }
  });

  it('round-trips the https fields through encodePairingPayload', () => {
    const payload = {
      url: 'http://hub.local:9191',
      httpsCaPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      httpsCaSha256: 'AA:BB',
      httpsToken: 'tok',
      httpsPort: 9294,
    };
    expect(decodePairingPayload(encodePairingPayload(payload))).toEqual(payload);
  });
});
