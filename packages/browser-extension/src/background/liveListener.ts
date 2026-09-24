import { DEFAULT_SSE_ENDPOINT } from '../shared/constants.js';

export type LiveListenerStatus = 'connected' | 'connecting' | 'disconnected';

export interface LiveEventCallbacks {
  onRulesUpdated?: (data?: any) => void;
  onQuarantineAdded?: (data?: any) => void;
  onRemoteControl?: (data: { action: string; [key: string]: any }) => void;
  onStatusChange?: (status: LiveListenerStatus) => void;
}

export class LiveListener {
  private endpoint: string;
  private callbacks: LiveEventCallbacks;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private status: LiveListenerStatus = 'disconnected';
  private reconnectTimeout: any = null;
  private retryDelayMs = 2000;
  private maxRetryDelayMs = 30000;

  constructor(endpoint: string = DEFAULT_SSE_ENDPOINT, callbacks: LiveEventCallbacks = {}) {
    this.endpoint = endpoint;
    this.callbacks = callbacks;
  }

  public getStatus(): LiveListenerStatus {
    return this.status;
  }

  public setEndpoint(endpoint: string): void {
    if (this.endpoint !== endpoint) {
      this.endpoint = endpoint;
      if (this.isRunning) {
        this.restart();
      }
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.updateStatus('disconnected');
  }

  public restart(): void {
    this.stop();
    this.start();
  }

  private updateStatus(newStatus: LiveListenerStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      if (this.callbacks.onStatusChange) {
        this.callbacks.onStatusChange(newStatus);
      }
    }
  }

  private async connect(): Promise<void> {
    if (!this.isRunning) return;

    this.updateStatus('connecting');
    this.abortController = new AbortController();

    try {
      // Prefer fetch stream for MV3 Service Worker compatibility
      const response = await fetch(this.endpoint, {
        signal: this.abortController.signal,
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE stream HTTP ${response.status}`);
      }

      this.updateStatus('connected');
      this.retryDelayMs = 2000; // Reset backoff on successful connection

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (this.isRunning) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const rawEvent of events) {
          this.parseAndDispatch(rawEvent);
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError' && this.isRunning) {
        // Quietly log to avoid log spam when hub is inactive
      }
    } finally {
      if (this.isRunning) {
        this.updateStatus('disconnected');
        this.scheduleReconnect();
      }
    }
  }

  private parseAndDispatch(raw: string): void {
    if (!raw.trim()) return;

    const lines = raw.split('\n');
    let eventType = 'message';
    let dataStr = '';

    for (const line of lines) {
      if (line.startsWith(':')) {
        // SSE comment / heartbeat
        continue;
      }
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
      }
    }

    if (!dataStr) return;

    let parsed: any;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      parsed = dataStr;
    }

    switch (eventType) {
      case 'compile_completed':
      case 'rules_updated':
        console.log(`[Blockingmachine Live] Received event "${eventType}": Triggering rule reload.`);
        if (this.callbacks.onRulesUpdated) {
          this.callbacks.onRulesUpdated(parsed);
        }
        break;

      case 'quarantine_added':
        console.log('[Blockingmachine Live] Quarantine threat alert received:', parsed);
        if (this.callbacks.onQuarantineAdded) {
          this.callbacks.onQuarantineAdded(parsed);
        }
        break;

      case 'remote_control':
        console.log('[Blockingmachine Live] Remote control command received:', parsed);
        if (this.callbacks.onRemoteControl) {
          this.callbacks.onRemoteControl(parsed);
        }
        break;

      case 'connected':
        console.log('[Blockingmachine Live] Connected to live event stream:', parsed);
        break;

      default:
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout || !this.isRunning) return;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.retryDelayMs = Math.min(this.retryDelayMs * 1.5, this.maxRetryDelayMs);
      this.connect();
    }, this.retryDelayMs);
  }
}
