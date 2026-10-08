import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { LiveListener } from '../background/liveListener.js';

describe('LiveListener', () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('initializes with disconnected status', () => {
    const listener = new LiveListener('http://localhost:9191/v1/events');
    expect(listener.getStatus()).toBe('disconnected');
  });

  test('parses SSE stream and triggers callbacks', async () => {
    const mockOnRulesUpdated = jest.fn();
    const mockOnQuarantineAdded = jest.fn();
    const mockOnRemoteControl = jest.fn();

    // Create a mock stream that yields SSE chunks
    const ssePayload = [
      'event: connected\ndata: {"status":"connected"}\n\n',
      'event: compile_completed\ndata: {"ruleCount":12345}\n\n',
      'event: quarantine_added\ndata: {"domain":"malicious-dga.xyz","confidence":0.95}\n\n',
      'event: remote_control\ndata: {"action":"toggle_cosmetics","enabled":false}\n\n',
    ].join('');

    const encoder = new TextEncoder();
    let streamRead = false;

    const mockReadableStream = {
      getReader: () => ({
        read: async () => {
          if (!streamRead) {
            streamRead = true;
            return { value: encoder.encode(ssePayload), done: false };
          }
          return { value: undefined, done: true };
        },
      }),
    };

    globalThis.fetch = (jest.fn() as any).mockResolvedValue({
      ok: true,
      body: mockReadableStream,
    });

    const listener = new LiveListener('http://localhost:9191/v1/events', {
      onRulesUpdated: mockOnRulesUpdated,
      onQuarantineAdded: mockOnQuarantineAdded,
      onRemoteControl: mockOnRemoteControl,
    });

    listener.start();

    // Give microtasks time to execute the stream loop
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockOnRulesUpdated).toHaveBeenCalledWith({ ruleCount: 12345 });
    expect(mockOnQuarantineAdded).toHaveBeenCalledWith({ domain: 'malicious-dga.xyz', confidence: 0.95 });
    expect(mockOnRemoteControl).toHaveBeenCalledWith({ action: 'toggle_cosmetics', enabled: false });

    listener.stop();
    expect(listener.getStatus()).toBe('disconnected');
  });

  test('sends the feed token as a Bearer header when configured', async () => {
    const encoder = new TextEncoder();
    let readOnce = false;
    const stream = {
      getReader: () => ({
        read: async () => {
          if (!readOnce) {
            readOnce = true;
            return { value: encoder.encode('event: connected\ndata: {}\n\n'), done: false };
          }
          return { value: undefined, done: true };
        },
      }),
    };
    const fetchMock = (jest.fn() as any).mockResolvedValue({ ok: true, body: stream });
    globalThis.fetch = fetchMock;

    const listener = new LiveListener('http://localhost:9191/v1/events');
    listener.setSource('http://localhost:9191/v1/events', 'tok-abc');
    listener.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const headers = (fetchMock.mock.calls[0]?.[1] as any)?.headers;
    expect(headers?.Authorization).toBe('Bearer tok-abc');
    listener.stop();
  });

  test('a 401 stops the retry loop instead of hammering a gated server', async () => {
    const fetchMock = (jest.fn() as any).mockResolvedValue({ ok: false, status: 401, body: null });
    globalThis.fetch = fetchMock;

    const listener = new LiveListener('http://localhost:9191/v1/events');
    listener.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(listener.getStatus()).toBe('disconnected');
    // The terminal return means no reconnect was scheduled — one fetch total.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A corrected credential lands through setSource, which revives the loop.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('setSource after an auth death restarts with the new token', async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const openStream = {
      getReader: () => ({
        read: async () => {
          reads += 1;
          if (reads === 1) {
            return { value: encoder.encode('event: connected\ndata: {}\n\n'), done: false };
          }
          return { value: undefined, done: true };
        },
      }),
    };
    const fetchMock = (jest.fn() as any)
      .mockResolvedValueOnce({ ok: false, status: 401, body: null })
      .mockResolvedValue({ ok: true, body: openStream });
    globalThis.fetch = fetchMock;

    const statuses: string[] = [];
    const listener = new LiveListener('http://localhost:9191/v1/events', {
      onStatusChange: (s) => statuses.push(s),
    });
    listener.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    listener.setSource('http://localhost:9191/v1/events', 'fixed-token');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]?.[1] as any)?.headers?.Authorization).toBe('Bearer fixed-token');
    listener.stop();
  });
});
