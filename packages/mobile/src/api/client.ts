/**
 * Typed client for the /v1 REST surface shared by the Electron hub (:9191) and the
 * Home Assistant add-on. The client sends no `Origin` header — React Native fetch
 * never does — so the feed server's origin guard treats it the same as curl or the
 * HA integration: authorised on a trusted LAN, bearer-gated when `feedToken` is set.
 */

import type {
  CheckResult,
  CompileResult,
  ControlResult,
  ProtectionState,
  ProtectionToggleResult,
  StatusPayload,
  TelemetryPayload,
} from './types';

export type ApiErrorKind =
  | 'unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'server'
  | 'bad_response';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ServerConnection {
  baseUrl: string;
  token?: string;
}

export interface ClientOptions {
  /** Per-request timeout. Default 5000ms — a LAN server answers fast or not at all. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Normalise a user-entered address into a base URL. Bare `host[:port]` gets
 * `http://` — the feed server is plain HTTP on the LAN. Trailing slashes go away so
 * path joins stay single-slashed.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new ApiError('bad_response', 'Empty server address');
  // A non-http(s) scheme must be refused outright — prepending http:// would fold it
  // into the hostname ("ftp://h" → host "ftp") instead of erroring.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new ApiError('bad_response', `Unsupported scheme in ${input}`);
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ApiError('bad_response', `Invalid server address: ${input}`);
  }
  return url.origin;
}

export class BlockingmachineClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(conn: ServerConnection, opts: ClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(conn.baseUrl);
    this.token = conn.token?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get connection(): ServerConnection {
    return { baseUrl: this.baseUrl, token: this.token };
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
    timeoutMs?: number,
  ): Promise<T> {
    const budget = timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';

      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let json: any = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          if (!res.ok) {
            throw new ApiError('server', `HTTP ${res.status}: non-JSON error body`, res.status);
          }
          throw new ApiError('bad_response', `Non-JSON response from ${path}`, res.status);
        }
      }

      if (!res.ok) {
        const message =
          (json && typeof json.error === 'string' && json.error) ||
          `HTTP ${res.status}`;
        if (res.status === 401) throw new ApiError('unauthorized', message, res.status);
        if (res.status === 403) throw new ApiError('forbidden', message, res.status);
        throw new ApiError('server', message, res.status);
      }
      return json as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ApiError('unreachable', `Timed out after ${budget}ms`);
      }
      throw new ApiError('unreachable', message);
    } finally {
      clearTimeout(timer);
    }
  }

  getStatus(): Promise<StatusPayload> {
    return this.request<StatusPayload>('/v1/status');
  }

  getTelemetry(): Promise<TelemetryPayload> {
    return this.request<TelemetryPayload>('/v1/telemetry');
  }

  checkDomain(domain: string): Promise<CheckResult> {
    const clean = domain.trim().toLowerCase();
    return this.request<CheckResult>(`/v1/check?domain=${encodeURIComponent(clean)}`);
  }

  /** Hub serves GET /v1/protection; the add-on does not — callers should fall back
   *  to the protection block inside getStatus(). */
  getProtection(): Promise<ProtectionState> {
    return this.request<ProtectionState>('/v1/protection');
  }

  setProtection(enabled: boolean): Promise<ProtectionToggleResult> {
    return this.request<ProtectionToggleResult>('/v1/protection', {
      method: 'POST',
      body: { enabled },
    });
  }

  compile(): Promise<CompileResult> {
    return this.request<CompileResult>('/v1/compile', { method: 'POST', body: {} });
  }

  getCosmetics(): Promise<ControlResult> {
    return this.request<ControlResult>('/v1/control/cosmetics');
  }

  setCosmetics(enabled: boolean): Promise<ControlResult> {
    return this.request<ControlResult>('/v1/control/cosmetics', {
      method: 'POST',
      body: { enabled },
    });
  }

  reloadBrowsers(): Promise<ControlResult> {
    return this.request<ControlResult>('/v1/control/reload', { method: 'POST', body: {} });
  }

  /** Hub-only: /v1/control/daemon is not implemented by the HA add-on — it has no
   *  daemon of its own. Expect a 404/server error there. The hub awaits the
   *  daemon's control API before answering (up to ~6s on a cold spawn), so this
   *  request carries a wider budget than the default. */
  controlDaemon(action: 'start' | 'stop'): Promise<ControlResult> {
    return this.request<ControlResult>(
      '/v1/control/daemon',
      { method: 'POST', body: { action } },
      15_000,
    );
  }
}
