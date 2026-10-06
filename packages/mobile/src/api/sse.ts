/**
 * SSE client for /v1/events. React Native's fetch cannot stream, so this parses the
 * wire format itself over `expo/fetch`'s ReadableStream body, with expo/fetch's
 * global `fetch` override — the same request either way, only the body read differs.
 *
 * The parser is a pure state machine (`createSseParser`) so the wire format is
 * unit-testable without any RN runtime: feed it string chunks, it emits parsed
 * events. `subscribeEvents` wraps it with reconnect/backoff for app use.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export interface SseHandlers {
  onEvent: (event: SseEvent) => void;
  /** Fired on transport errors; the subscriber still retries unless stopped. */
  onError?: (error: Error) => void;
  /** Fired once the stream is open (headers received). */
  onOpen?: () => void;
}

export interface SseSubscription {
  stop: () => void;
}

interface ParserState {
  dataLines: string[];
  eventName: string;
  lastId?: string;
}

/**
 * Incremental SSE parser. Feed raw decoded text; it buffers partial lines across
 * chunks and dispatches on blank lines, per the EventSource wire format. Comment
 * lines (`: ping`) are ignored, matching the hub's heartbeat.
 */
export function createSseParser(onEvent: (event: SseEvent) => void): (chunk: string) => void {
  let buffer = '';
  const state: ParserState = { dataLines: [], eventName: 'message' };

  const dispatch = () => {
    if (state.dataLines.length > 0) {
      onEvent({
        event: state.eventName,
        data: state.dataLines.join('\n'),
        id: state.lastId,
      });
    }
    state.dataLines = [];
    state.eventName = 'message';
  };

  const handleLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        state.eventName = value || 'message';
        break;
      case 'data':
        state.dataLines.push(value);
        break;
      case 'id':
        state.lastId = value;
        break;
      case 'retry':
        break; // backoff policy is ours, not the server's
    }
  };

  return (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  };
}

export interface SubscribeOptions {
  /** fetch impl with streaming body support — expo/fetch on device, injectable in tests. */
  fetchImpl?: typeof fetch;
  /** Bearer token when the server has feedToken configured. */
  token?: string;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Long-lived subscription to /v1/events with exponential-backoff reconnect.
 * Auth failures (401/403) are terminal — retrying cannot fix them and the user must
 * intervene (set or fix the token), so they surface through onError and stop the
 * loop instead of hammering the server.
 */
export function subscribeEvents(
  baseUrl: string,
  handlers: SseHandlers,
  opts: SubscribeOptions = {},
): SseSubscription {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 30000;

  let stopped = false;
  let abort: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const connect = async () => {
    if (stopped) return;
    abort = new AbortController();
    const parser = createSseParser(handlers.onEvent);
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      const res = await fetchImpl(`${baseUrl}/v1/events`, {
        headers,
        signal: abort.signal,
      });
      if (res.status === 401 || res.status === 403) {
        stopped = true;
        handlers.onError?.(new Error(`Event stream rejected: HTTP ${res.status}`));
        return;
      }
      const body = (res as { body?: { getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } }).body;
      if (!res.ok || !body?.getReader) {
        throw new Error(`Event stream failed: HTTP ${res.status}`);
      }
      attempt = 0;
      handlers.onOpen?.();

      const reader = body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) parser(decoder.decode(value, { stream: true }));
      }
      throw new Error('Event stream closed');
    } catch (err) {
      if (stopped) return;
      const error = err instanceof Error ? err : new Error(String(err));
      handlers.onError?.(error);
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(() => void connect(), delay);
    }
  };

  void connect();

  return {
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      abort?.abort();
    },
  };
}
