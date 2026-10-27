/**
 * Loopback client for the HTTPS filter proxy's `/v1/proxy/*` control API
 * (`packages/https-filter/src/control.ts`), bound to `127.0.0.1:9293` by
 * default.
 *
 * The CLI calls the engine exactly like `daemonManager` does: plain loopback
 * HTTP with no `Origin` header — the API's browser-boundary guard trusts that
 * shape, and every mutation is a JSON POST because the server answers 415 to
 * any other content type (a cross-origin page cannot produce one without a
 * preflight the server refuses). The envelope is the daemon's: reads return
 * bare objects, mutations return `{success:true, …}`, and failures are
 * `{success:false, error}` — or bare `{error}` on the 400/404 guards — so a
 * non-2xx status, a non-JSON body, or a `success:false` payload all surface
 * here as thrown errors rather than as payload-looking data a caller might
 * render as a result.
 *
 * The payload shapes below mirror the route responses by hand rather than
 * importing `@blockingmachine/https-filter`: the CLI is an HTTP client of
 * the engine, not a consumer of it. Keeping the package out of the CLI's
 * dependency graph keeps the CLI installable without dragging in the
 * vendored `node-forge` `file:` dep the engine needs for x509 work — and a
 * control API whose types drift out of the shared package is already caught
 * by the engine's own route tests.
 */

/** The control listener's default port — the engine's `DEFAULT_CONTROL_PORT`. */
export const DEFAULT_PROXY_CONTROL_PORT = 9293;

/** GET `/v1/proxy/status` — the full status document. */
export interface ProxyStatusPayload {
  status: "running" | "paused";
  dataPort: number;
  controlPort: number;
  protectionEnabled: boolean;
  paused: boolean;
  policyDegraded: boolean;
  rulesLoaded: number;
  uptimeSeconds: number;
  corruptLineCount: number;
  stats: {
    flowsTotal: number;
    /** Per-flow blocks only — per-request blocks are `requestsBlocked`. */
    flowsBlocked: number;
    /** Blocks inside terminated keep-alive flows — not a share of flowsTotal. */
    requestsBlocked: number;
    flowsTunneled: number;
    flowsTerminated: number;
    pinsLearned: number;
    rulesSize: number;
    blockRatePercent: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** GET `/v1/proxy/stats` — counters plus the degraded/paused flags. */
export interface ProxyStatsPayload {
  flowsTotal: number;
  flowsBlocked: number;
  /** Per-request blocks inside terminated flows — split from flowsBlocked. */
  requestsBlocked: number;
  flowsTunneled: number;
  flowsTerminated: number;
  pinsLearned: number;
  rulesSize: number;
  paused: boolean;
  corruptLineCount: number;
  policyDegraded: boolean;
  [key: string]: unknown;
}

/** GET `/v1/proxy/ca` and the POST `/v1/proxy/ca/rotate` reply. */
export interface ProxyCaPayload {
  /** The CA's PEM — what `cert export` writes verbatim. */
  certPem: string;
  /** Colon-paired uppercase hex of sha256(DER) — openssl's rendering. */
  sha256Fingerprint: string;
  /** `X509Certificate.validTo` — the CA's notAfter date. */
  notAfter: string;
  [key: string]: unknown;
}

/** One JSONL ledger line — pin, bypass, or removal. */
export interface ProxyPolicyEntry {
  ts: number;
  host: string;
  action: "pin" | "bypass" | "remove";
  reason?: string;
  [key: string]: unknown;
}

/** GET `/v1/proxy/pins` — the learned pin/bypass ledger. */
export interface ProxyPinsPayload {
  pins: ProxyPolicyEntry[];
  corruptLineCount: number;
  [key: string]: unknown;
}

/** POST `/v1/proxy/toggle` reply. */
export interface ProxyTogglePayload {
  success: boolean;
  protectionEnabled: boolean;
  paused: boolean;
  [key: string]: unknown;
}

/** POST `/v1/proxy/reload` reply. */
export interface ProxyReloadPayload {
  success: boolean;
  message: string;
  rulesLoaded: number;
  rulesSize: number;
  [key: string]: unknown;
}

export interface ProxyControlRequestOptions {
  /** Control port override; defaults to {@link DEFAULT_PROXY_CONTROL_PORT}. */
  port?: number;
  method?: "GET" | "POST";
  /** Route path, e.g. `/v1/proxy/status`. */
  path: string;
  /** POST body; `{}` when omitted. The API 415s a missing JSON content type. */
  body?: unknown;
  /** Fetch timeout — the engine is loopback, so a slow answer is a wedged one. */
  timeoutMs?: number;
}

/**
 * One request against the control API.
 *
 * Resolves to the parsed payload on a 2xx whose envelope is not a failure.
 * Throws — with the server's own `error` text when it sent one — on a
 * transport failure, a non-2xx status, a non-JSON body, or a `success:false`
 * envelope, so a command's only job is to print the payload or report the
 * error.
 */
export async function proxyControlRequest<T = Record<string, unknown>>(
  options: ProxyControlRequestOptions,
): Promise<T> {
  const method = options.method ?? "GET";
  const url = `http://127.0.0.1:${options.port ?? DEFAULT_PROXY_CONTROL_PORT}${options.path}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (method === "POST") {
    // A POST without this content type is a 415 regardless of the body — it
    // is the second wall against browser drive-bys, and this client always
    // carries it.
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body ?? {});
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach the proxy control API at ${url} — is the HTTPS filter proxy running? (${detail})`,
    );
  }

  const text = await res.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `Proxy control API ${method} ${options.path} returned a non-JSON response (HTTP ${res.status})`,
    );
  }

  if (!res.ok) {
    const detail =
      payload && typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new Error(
      `Proxy control API ${method} ${options.path} failed (HTTP ${res.status})${detail}`,
    );
  }
  if (payload && payload.success === false) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Proxy control API ${method} ${options.path} reported failure`,
    );
  }
  return payload as T;
}
