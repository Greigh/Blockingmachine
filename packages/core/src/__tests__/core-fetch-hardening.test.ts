import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import nodeFetch, { Response } from 'node-fetch';
import { Readable } from 'node:stream';
import { isSafePublicWebUrl } from '../utils/urlSafety.js';

// Replace only the network boundary; parsing, streams, headers, and hashing stay real.
const fetchMock = jest.fn<typeof nodeFetch>();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
const { fetchWithConditionalCache } = await import('../fetch.js');

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Public URL lexical checks', () => {
  it.each([
    'http://localhost./list',
    'http://router.local./list',
    'http://router.home.arpa./list',
    'http://[fc12::1]/list',
    'http://[fdff::1]/list',
    'http://[fe90::1]/list',
    'http://[febf::1]/list',
    'http://[ff02::1]/list',
    'http://100.64.0.1/list',
    'http://100.127.255.254/list',
    'http://198.18.0.1/list',
    'http://198.19.255.254/list',
    'http://224.0.0.1/list',
    'http://239.255.255.254/list',
    'http://240.0.0.1/list',
    'http://[::ffff:100.64.0.1]/list',
  ])('rejects non-public target %s', (url) => {
    expect(isSafePublicWebUrl(url).isSafe).toBe(false);
  });

  it.each([
    'https://public.example./list',
    'http://100.63.255.254/list',
    'http://100.128.0.1/list',
    'http://198.17.255.254/list',
    'http://198.20.0.1/list',
    'http://[2001:4860:1234:ffff:7f00:1:2:3]/list',
    'http://[2001:4860::ffff:7f00:1]/list',
    'http://[::ffff:8.8.8.8]/list',
  ])('allows public target %s', (url) => {
    expect(isSafePublicWebUrl(url).isSafe).toBe(true);
  });
});

describe('Bounded remote filter fetching', () => {
  it('accepts case-insensitive HTTP schemes as remote feeds', async () => {
    fetchMock.mockResolvedValueOnce(new Response('||ads.example^'));
    await expect(fetchWithConditionalCache('HTTPS://public.example/list')).resolves.toMatchObject({
      status: 200,
      content: '||ads.example^',
    });
  });

  it('checks the checksum even when the response is empty', async () => {
    fetchMock.mockResolvedValueOnce(new Response(''));
    await expect(fetchWithConditionalCache('https://public.example/list', {
      expectedSha256: '0'.repeat(64),
    })).resolves.toMatchObject({ status: 422, content: null });
  });

  it('preserves cache validators when a 304 omits replacement headers', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(fetchWithConditionalCache('https://public.example/list', {
      etag: '"revision-one"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    })).resolves.toMatchObject({
      status: 304,
      content: null,
      notModified: true,
      etag: '"revision-one"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
  });

  it.each([403, 404, 503])('closes unread bodies for HTTP %i', async (status) => {
    const body = new Readable({ read() {} });
    fetchMock.mockResolvedValueOnce(new Response(body, { status }));
    const result = await fetchWithConditionalCache('https://public.example/list');
    expect(result.status).toBe(status);
    expect(body.destroyed).toBe(true);
  });

  it('closes an advertised oversize body without reading or retrying it', async () => {
    const body = new Readable({ read() {} });
    fetchMock.mockResolvedValueOnce(new Response(body, {
      headers: { 'content-length': String(100 * 1024 * 1024 + 1) },
    }));
    const result = await fetchWithConditionalCache('https://public.example/list');
    expect(result).toMatchObject({ status: 413, content: null });
    expect(body.destroyed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('closes redirect bodies and resolves a relative target', async () => {
    const body = new Readable({ read() {} });
    fetchMock.mockResolvedValueOnce(new Response(body, {
      status: 302,
      headers: { location: '../new-list' },
    })).mockResolvedValueOnce(new Response('||new.example^'));
    const result = await fetchWithConditionalCache('https://public.example/feeds/old-list');
    expect(result.content).toBe('||new.example^');
    expect(fetchMock.mock.calls[1][0]).toBe('https://public.example/new-list');
    expect(body.destroyed).toBe(true);
  });

  it('blocks private redirects before making the next request', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: 'http://[fd12::1]/list' },
    })).mockResolvedValueOnce(new Response('unexpected private content'));
    const result = await fetchWithConditionalCache('https://public.example/list');
    expect(result).toMatchObject({ status: 403, content: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows explicitly authorized private HTTP feeds', async () => {
    fetchMock.mockResolvedValueOnce(new Response('||local.example^'));
    await expect(fetchWithConditionalCache('http://localhost/list', {
      allowPrivateNetworks: true,
    })).resolves.toMatchObject({ status: 200, content: '||local.example^' });
  });

  it('keeps private-network authorization limited to HTTP redirects', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: 'data:text/plain,untrusted-list' },
    })).mockResolvedValueOnce(new Response('untrusted-list'));
    const result = await fetchWithConditionalCache('http://localhost/list', {
      allowPrivateNetworks: true,
    });
    expect(result).toMatchObject({ status: 403, content: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry redirects that have no Location header', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response(null, { status: 302 }));
    const pending = fetchWithConditionalCache('https://public.example/list');
    await jest.runAllTimersAsync();
    expect((await pending).content).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops a redirect loop at the redirect budget without retrying the last hop', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response(null, {
      status: 302,
      headers: { location: '/list' },
    }));
    const pending = fetchWithConditionalCache('https://public.example/list');
    await jest.runAllTimersAsync();
    expect((await pending).content).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(jest.getTimerCount()).toBe(0);
  });
});
