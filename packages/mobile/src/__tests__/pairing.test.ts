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

  it('round-trips through encodePairingPayload', () => {
    const payload = { url: 'http://hub.local:9191', token: 'tok' };
    expect(decodePairingPayload(encodePairingPayload(payload))).toEqual(payload);
  });

  it('drops blank/whitespace tokens on encode', () => {
    expect(encodePairingPayload({ url: 'http://x:1', token: undefined })).toBe(
      '{"v":1,"url":"http://x:1"}',
    );
  });
});
