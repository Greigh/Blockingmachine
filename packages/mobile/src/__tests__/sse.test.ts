import { createSseParser, subscribeEvents, type SseEvent } from '../api/sse';

describe('createSseParser', () => {
  const collect = () => {
    const events: SseEvent[] = [];
    const feed = createSseParser((e) => events.push(e));
    return { events, feed };
  };

  it('dispatches a complete event on a blank line', () => {
    const { events, feed } = collect();
    feed('event: compile_completed\ndata: {"rules": 100}\n\n');
    expect(events).toEqual([
      { event: 'compile_completed', data: '{"rules": 100}', id: undefined },
    ]);
  });

  it('joins multi-line data with newlines', () => {
    const { events, feed } = collect();
    feed('data: one\ndata: two\n\n');
    expect(events[0].data).toBe('one\ntwo');
  });

  it('ignores comment heartbeat lines', () => {
    const { events, feed } = collect();
    feed(': ping\n\ndata: x\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('x');
  });

  it('buffers partial lines across chunk boundaries', () => {
    const { events, feed } = collect();
    feed('event: rules_up');
    feed('dated\ndata: par');
    feed('tial\n\n');
    expect(events).toEqual([
      { event: 'rules_updated', data: 'partial', id: undefined },
    ]);
  });

  it('handles CRLF line endings and event defaults to message', () => {
    const { events, feed } = collect();
    feed('data: hi\r\n\r\n');
    expect(events[0]).toEqual({ event: 'message', data: 'hi', id: undefined });
  });

  it('carries the id field through', () => {
    const { events, feed } = collect();
    feed('id: 42\ndata: x\n\n');
    expect(events[0].id).toBe('42');
  });
});

describe('subscribeEvents', () => {
  const streamFrom = (chunks: string[]) => {
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length
              ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
              : { done: true, value: undefined },
        }),
      },
    } as unknown as Response;
  };

  it('parses events from a streamed response', async () => {
    const events: SseEvent[] = [];
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(streamFrom(['event: rules_updated\ndata: {}\n\n']));
    const sub = subscribeEvents('http://hub:9191', {
      onEvent: (e) => events.push(e),
      onError: () => {},
    }, { fetchImpl: fetchImpl as unknown as typeof fetch, baseDelayMs: 5 });

    await new Promise((r) => setTimeout(r, 50));
    sub.stop();
    expect(events).toEqual([{ event: 'rules_updated', data: '{}', id: undefined }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://hub:9191/v1/events',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/event-stream' }) }),
    );
  });

  it('sends the bearer token on the stream request', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(streamFrom([]));
    const sub = subscribeEvents('http://hub:9191', { onEvent: () => {}, onError: () => {} }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: 'sekret',
      baseDelayMs: 5,
    });
    await new Promise((r) => setTimeout(r, 20));
    sub.stop();
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer sekret');
  });

  it('does not retry after a 401', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 401 } as unknown as Response);
    const errors: Error[] = [];
    const sub = subscribeEvents('http://hub:9191', {
      onEvent: () => {},
      onError: (e) => errors.push(e),
    }, { fetchImpl: fetchImpl as unknown as typeof fetch, baseDelayMs: 5 });
    await new Promise((r) => setTimeout(r, 60));
    sub.stop();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(errors[0].message).toContain('401');
  });

  it('retries with backoff after a transport failure', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(streamFrom(['data: ok\n\n']));
    const events: SseEvent[] = [];
    const sub = subscribeEvents('http://hub:9191', {
      onEvent: (e) => events.push(e),
      onError: () => {},
    }, { fetchImpl: fetchImpl as unknown as typeof fetch, baseDelayMs: 5 });
    await new Promise((r) => setTimeout(r, 60));
    sub.stop();
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
