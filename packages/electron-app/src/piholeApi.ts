/**
 * Pi-hole admin API client, in both flavors the pane advertises.
 *
 * The pane's presets point at `/admin` (the v6 web UI) and its key field accepts "v5 & v6"
 * credentials — but the sync and test paths originally emitted only the v5 shape:
 * `?auth=<key>&action=…` appended to whatever URL was configured. On a v6 Pi-hole those calls
 * hit the admin single-page app, get HTTP 200 HTML, and report "Gravity update triggered" while
 * gravity never runs — the inert-deployment failure this module exists to close.
 *
 * v5 is a GET API on `admin/api.php` (`?auth`, `?action`, `?type`). v6 is a JSON REST API under
 * `/api/`: `POST /api/auth` exchanges the password for a session sid carried in the
 * `X-FTL-SID` header, `POST /api/action/gravity` is the gravity trigger, and
 * `DELETE /api/auth` retires the sid afterwards so every auto-sync does not leak a session.
 *
 * The flavors are told apart by the configured URL, not by probing: a path containing
 * `api.php` is the v5 endpoint the older settings surface presets; anything else is the
 * `/admin` (or bare) URL the Deploy Hub presets produce.
 */

import type { SinkholeFetchInit, SinkholeHttpResult } from './sinkholeFetch';

export type PiholeFetch = (url: string, init: SinkholeFetchInit) => Promise<SinkholeHttpResult>;

export type PiholeApiFlavor = 'v5' | 'v6';

export interface PiholeApiResult {
  ok: boolean;
  flavor: PiholeApiFlavor;
  status?: number;
  /** A line describing what the target answered, for user-facing messages. */
  detail?: string;
}

/**
 * One retry for transport-level failures. Embedded daemons sit behind NAT port proxies and
 * cheap HTTP stacks that occasionally deliver a mangled segment — observed on Pi-hole v6
 * under docker, where a response can arrive with its chunk terminator ahead of the body.
 * Protocol answers (4xx, bad passwords, an SPA where JSON belonged) are returned, not thrown,
 * so a retry only ever re-runs a call the transport corrupted.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err;
    return await fn();
  }
}

/** Which API dialect the configured URL speaks — `api.php` means the v5 endpoint. */
export function piholeApiFlavor(rawUrl: string): PiholeApiFlavor {
  try {
    return new URL(rawUrl).pathname.includes('api.php') ? 'v5' : 'v6';
  } catch {
    return 'v6';
  }
}

/** `http://pi.hole` from `http://pi.hole/admin` — v6 endpoints hang off the origin. */
function piholeApiOrigin(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  return parsed.origin;
}

/**
 * The v5 call both call sites already made — `auth`/`action`/`type` query params on the
 * configured `api.php` URL. Kept verbatim: it is correct *when the URL is the v5 endpoint*.
 */
async function v5Request(
  rawUrl: string,
  apiKey: string | undefined,
  params: Record<string, string>,
  fetchImpl: PiholeFetch,
  init: Pick<SinkholeFetchInit, 'timeoutMs' | 'allowInsecureLocalTls'>,
): Promise<PiholeApiResult> {
  const url = new URL(rawUrl);
  if (apiKey) url.searchParams.set('auth', apiKey.trim());
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetchImpl(url.toString(), init);
  // A v5 URL pointed at a v6 Pi-hole gets 200 + the admin SPA — an HTML body where JSON was
  // asked for is the tell that reports "connected" to a server that understood nothing.
  const body = (await res.text()).trimStart();
  if (res.ok && body.startsWith('<')) {
    return {
      ok: false,
      flavor: 'v5',
      status: res.status,
      detail:
        'answered with the admin web page, not the API — on Pi-hole v6 the endpoint is /admin/api/, not api.php. Point the URL at /admin (no api.php) and keep a v6 password.',
    };
  }
  return { ok: res.ok, flavor: 'v5', status: res.status };
}

interface PiholeSession {
  sid: string;
}

/**
 * `POST /api/auth` — the v6 exchange shared by every authed call. The pane's "app password"
 * is the same field on this endpoint: Pi-hole returns a session whose `validity.app` marks it.
 */
async function v6Session(
  origin: string,
  password: string,
  fetchImpl: PiholeFetch,
  init: Pick<SinkholeFetchInit, 'timeoutMs' | 'allowInsecureLocalTls'>,
): Promise<PiholeSession> {
  const res = await fetchImpl(`${origin}/api/auth`, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.status === 401) {
    throw Object.assign(new Error('Pi-hole rejected the password — use the v6 web password or an app password, not the v5 API token.'), { statusCode: 401 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`Pi-hole /api/auth answered HTTP ${res.status} — is this a v6 Pi-hole?`), { statusCode: res.status });
  }
  const session = (await res.json()) as { session?: { sid?: string; valid?: boolean } };
  if (!session?.session?.valid || !session.session.sid) {
    throw Object.assign(new Error('Pi-hole /api/auth returned no valid session — check the password.'), { statusCode: res.status });
  }
  return { sid: session.session.sid };
}

/**
 * Retire the sid — v6 sessions are capped, so a sync that leaks one per run eventually
 * locks the legitimate admin out. Best-effort: a failed delete is not a sync failure.
 */
async function v6Logout(
  origin: string,
  sid: string,
  fetchImpl: PiholeFetch,
  init: Pick<SinkholeFetchInit, 'timeoutMs' | 'allowInsecureLocalTls'>,
): Promise<void> {
  try {
    await fetchImpl(`${origin}/api/auth`, {
      ...init,
      method: 'DELETE',
      headers: { 'X-FTL-SID': sid },
    });
  } catch {
    /* an expired session cleaning itself up is not a failure */
  }
}

/**
 * The v6 authed-request wrapper — one session per call, always released.
 * `request` receives the origin + sid and performs the real call.
 */
async function v6Request(
  rawUrl: string,
  apiKey: string | undefined,
  fetchImpl: PiholeFetch,
  init: Pick<SinkholeFetchInit, 'timeoutMs' | 'allowInsecureLocalTls'>,
  request: (origin: string, sid: string) => Promise<{ status: number; detail?: string }>,
): Promise<PiholeApiResult> {
  const origin = piholeApiOrigin(rawUrl);
  if (!apiKey?.trim()) {
    return {
      ok: false,
      flavor: 'v6',
      detail: 'Pi-hole v6 needs the web/app password to open a session — the API key field is empty.',
    };
  }
  const { sid } = await v6Session(origin, apiKey.trim(), fetchImpl, init);
  try {
    const out = await request(origin, sid);
    return { ok: out.status >= 200 && out.status < 300, flavor: 'v6', status: out.status, detail: out.detail };
  } finally {
    await v6Logout(origin, sid, fetchImpl, init);
  }
}

/**
 * The connectivity probe the Test button performs.
 * v5: `?type=version` is the classic health check; v6: `GET /api/info/version` carries the
 * same information and proves the session works end to end.
 */
export async function piholeVersionProbe(
  rawUrl: string,
  apiKey: string | undefined,
  fetchImpl: PiholeFetch,
  init: Pick<SinkholeFetchInit, 'timeoutMs' | 'allowInsecureLocalTls'>,
): Promise<PiholeApiResult> {
  if (piholeApiFlavor(rawUrl) === 'v5') {
    return withRetry(() => v5Request(rawUrl, apiKey, { type: 'version' }, fetchImpl, init));
  }
  return withRetry(() =>
    v6Request(rawUrl, apiKey, fetchImpl, init, async (origin, sid) => {
      const res = await fetchImpl(`${origin}/api/info/version`, {
        ...init,
        headers: { 'X-FTL-SID': sid },
      });
      return { status: res.status, detail: res.statusText };
    }),
  );
}

/**
 * The gravity trigger the sync performs.
 * v5: `?action=updategravity` (a GET — the v5 API is all GETs); v6: `POST /api/action/gravity`.
 */
export async function piholeGravityUpdate(
  rawUrl: string,
  apiKey: string | undefined,
  fetchImpl: PiholeFetch,
  init: Pick<SinkholeFetchInit, 'timeoutMs' | 'allowInsecureLocalTls'>,
): Promise<PiholeApiResult> {
  if (piholeApiFlavor(rawUrl) === 'v5') {
    return withRetry(() => v5Request(rawUrl, apiKey, { action: 'updategravity' }, fetchImpl, init));
  }
  return withRetry(() =>
    v6Request(rawUrl, apiKey, fetchImpl, init, async (origin, sid) => {
      // FTL 400s a POST with no Content-Length, and its 200 is a streamed gravity log that runs
      // until the rebuild finishes — headers-only, or a "trigger" would hold the sync open for
      // the whole run. Gravity proceeds server-side either way.
      const res = await fetchImpl(`${origin}/api/action/gravity`, {
        ...init,
        method: 'POST',
        headers: { 'X-FTL-SID': sid, 'Content-Length': '0' },
        respondOnHeaders: true,
      });
      return { status: res.status, detail: res.statusText };
    }),
  );
}

export interface PiholeQueryEntry {
  domain: string;
  client?: string;
  timestamp?: string;
}

export interface PiholeQueryLogResult {
  ok: boolean;
  flavor: PiholeApiFlavor;
  status?: number;
  detail?: string;
  queries: PiholeQueryEntry[];
}

/** v5 positional status codes meaning "answered, not blocked": 2 forwarded, 3 cache. */
const V5_PERMITTED_STATUSES = new Set(['2', '3']);
/** v6 status names for a query the resolver answered rather than blocked. */
const V6_PERMITTED_STATUSES = new Set(['FORWARDED', 'CACHE', 'RETRY', 'CACHE_STALE']);

function piholeEpochSecondsToIso(value: unknown): string | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : undefined;
}

/**
 * The query-log pull the AI radar scans — both flavors, normalized to one shape.
 * v5: `?getAllQueries=N` returns positional arrays (`[time, type, domain, client, status]`).
 * v6: `GET /api/queries?length=N` under a session returns objects with named fields and
 * wordy status enums; the sid is released in `finally` so a scan cannot leak sessions.
 * The unblocked-only filter matches the call sites' contract: AI radar scans what the
 * resolver answered, not what it already blocked.
 */
export async function fetchPiholeQueryLog(
  rawUrl: string,
  apiKey: string | undefined,
  limit: number,
  fetchImpl: PiholeFetch,
  init: Pick<SinkholeFetchInit, 'timeoutMs' | 'allowInsecureLocalTls'>,
): Promise<PiholeQueryLogResult> {
  const flavor = piholeApiFlavor(rawUrl);

  if (flavor === 'v5') {
    return withRetry(async () => {
      const url = new URL(rawUrl);
      if (apiKey?.trim()) url.searchParams.set('auth', apiKey.trim());
      url.searchParams.set('getAllQueries', String(limit));
      const res = await fetchImpl(url.toString(), init);
      const body = (await res.text()).trimStart();
      if (!res.ok) {
        return { ok: false, flavor, status: res.status, detail: `HTTP ${res.status}`, queries: [] };
      }
      // A v5 URL pointed at v6 gets the admin SPA — HTML where JSON was asked for.
      if (body.startsWith('<')) {
        return {
          ok: false,
          flavor,
          status: res.status,
          detail:
            'answered with the admin web page, not the API — on Pi-hole v6 the endpoint is /admin, not api.php. Point the URL at /admin and keep a v6 password.',
          queries: [],
        };
      }
      let data: unknown[] = [];
      try {
        const json = JSON.parse(body) as { data?: unknown };
        data = Array.isArray(json?.data) ? (json.data as unknown[]) : [];
      } catch {
        return { ok: false, flavor, status: res.status, detail: 'query log body was not valid JSON', queries: [] };
      }
      const queries: PiholeQueryEntry[] = [];
      for (const item of data) {
        if (!Array.isArray(item)) continue;
        const [epoch, , name, client, status] = item;
        if (typeof name === 'string' && name && V5_PERMITTED_STATUSES.has(String(status))) {
          queries.push({
            domain: name,
            client: typeof client === 'string' ? client : undefined,
            timestamp: piholeEpochSecondsToIso(epoch),
          });
        }
      }
      return { ok: true, flavor, status: res.status, queries };
    });
  }

  const origin = piholeApiOrigin(rawUrl);
  if (!apiKey?.trim()) {
    return {
      ok: false,
      flavor,
      detail: 'Pi-hole v6 needs the web/app password to open a session — the API key field is empty.',
      queries: [],
    };
  }
  return withRetry(async () => {
    const { sid } = await v6Session(origin, apiKey.trim(), fetchImpl, init);
    try {
      const url = new URL(`${origin}/api/queries`);
      url.searchParams.set('length', String(limit));
      const res = await fetchImpl(url.toString(), {
        ...init,
        headers: { 'X-FTL-SID': sid },
      });
      if (!res.ok) {
        return { ok: false, flavor, status: res.status, detail: `HTTP ${res.status}`, queries: [] };
      }
      const json = (await res.json()) as { queries?: unknown };
      const rows = Array.isArray(json?.queries) ? (json.queries as unknown[]) : [];
      const queries: PiholeQueryEntry[] = [];
      for (const row of rows) {
        const q = row as { domain?: unknown; client?: unknown; status?: unknown; time?: unknown };
        const domain = typeof q.domain === 'string' ? q.domain : '';
        const statusName = typeof q.status === 'string' ? q.status : '';
        if (!domain || !V6_PERMITTED_STATUSES.has(statusName)) continue;
        const client =
          typeof q.client === 'string'
            ? q.client
            : typeof (q.client as { ip?: unknown })?.ip === 'string'
              ? (q.client as { ip: string }).ip
              : undefined;
        queries.push({ domain, client, timestamp: piholeEpochSecondsToIso(q.time) });
      }
      return { ok: true, flavor, status: res.status, queries };
    } finally {
      await v6Logout(origin, sid, fetchImpl, init);
    }
  });
}
