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
});
