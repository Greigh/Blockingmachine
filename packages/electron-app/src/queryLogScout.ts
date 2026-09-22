import { resolveAdguardDirectUrl } from './sinkholeNet';
import {
  classifyDirectStatus,
  isHomeAssistantApiSuccess,
  originOf,
  type IdentityRequest,
  type ProbeResponse,
} from './sinkholeIdentity';

export interface ScoutQuery {
  domain: string;
  client?: string;
  elapsedMs?: number;
  blocked: false;
}

export interface SinkholeUrlFields {
  adguardMode?: 'direct' | 'ha-api' | 'webhook';
  adguardHomeUrl?: string;
  adguardDirectUrl?: string;
  adguardDirectPort?: number;
}

export type QueryLogLoad =
  | {
      ok: true;
      queries: ScoutQuery[];
      rawCount: number;
      unblockedCount: number;
      limit: number;
      baseUrl: string;
    }
  | {
      ok: false;
      message: string;
      details?: string;
    };

const ADGUARD_DIRECT_HINT = 'https://homeassistant.local:8124';

export function emptyUnblockedNotice(limit: number): string {
  return `No unblocked queries in the last ${limit} log entries. Blocked queries are skipped.`;
}

export function adguardDirectUrlNeededMessage(seenUrl?: string): string {
  const seen = seenUrl?.trim() ? ` (${seenUrl.trim()})` : '';
  return `Query log scout needs AdGuard Home's API, not a Home Assistant URL${seen}. Set the AdGuard Direct URL (for example ${ADGUARD_DIRECT_HINT}) and your AdGuard username and password. Home Assistant REST API mode can keep the Home Assistant address for reloads.`;
}

function usableDirectBase(raw: string | undefined, port?: number): string | null {
  if (!raw?.trim()) return null;
  const resolved = resolveAdguardDirectUrl(raw, port);
  if (!resolved.ok) return null;
  return resolved.target.baseUrl;
}

export function separateAdguardUrls(
  previous: SinkholeUrlFields,
  patch: SinkholeUrlFields,
): { adguardDirectUrl?: string } {
  const mode = patch.adguardMode ?? previous.adguardMode ?? 'direct';
  const prevMode = previous.adguardMode ?? 'direct';
  const port = patch.adguardDirectPort ?? previous.adguardDirectPort;

  const explicit = patch.adguardDirectUrl?.trim() || '';
  if (explicit) {
    return { adguardDirectUrl: explicit };
  }

  const leavingDirect = mode !== 'direct' && prevMode === 'direct';
  if (patch.adguardDirectUrl !== undefined && !leavingDirect) {
    return { adguardDirectUrl: '' };
  }

  let directUrl = previous.adguardDirectUrl?.trim() || '';

  if (!directUrl && leavingDirect) {
    const preserved = usableDirectBase(previous.adguardHomeUrl, port);
    if (preserved) directUrl = preserved;
  }

  if (mode === 'direct') {
    const shared = patch.adguardHomeUrl !== undefined ? patch.adguardHomeUrl : previous.adguardHomeUrl;
    const usable = usableDirectBase(shared, port);
    if (usable) directUrl = usable;
  }

  if (directUrl && !usableDirectBase(directUrl, port)) {
    return { adguardDirectUrl: previous.adguardDirectUrl };
  }

  return { adguardDirectUrl: directUrl };
}

export function resolveAdguardScoutBase(
  config: SinkholeUrlFields,
): { ok: true; baseUrl: string; queryLogUrl: (limit: number) => string } | { ok: false; message: string; details: string } {
  const port = config.adguardDirectPort;
  const explicit = config.adguardDirectUrl?.trim() || '';
  const mode = config.adguardMode || 'direct';

  if (explicit) {
    const base = usableDirectBase(explicit, port);
    if (!base) {
      return { ok: false, details: 'ha_url_for_scout', message: adguardDirectUrlNeededMessage(explicit) };
    }
    return { ok: true, baseUrl: base, queryLogUrl: (limit) => `${base}/control/querylog?limit=${limit}` };
  }

  if (mode === 'ha-api') {
    return {
      ok: false,
      details: 'ha_url_for_scout',
      message: adguardDirectUrlNeededMessage(config.adguardHomeUrl),
    };
  }

  const shared = usableDirectBase(config.adguardHomeUrl, port);
  if (shared) {
    return { ok: true, baseUrl: shared, queryLogUrl: (limit) => `${shared}/control/querylog?limit=${limit}` };
  }

  if (config.adguardHomeUrl?.trim()) {
    return { ok: false, details: 'ha_url_for_scout', message: adguardDirectUrlNeededMessage(config.adguardHomeUrl) };
  }

  return {
    ok: false,
    details: 'missing_adguard_direct',
    message: `AdGuard Direct URL is not configured. Set it to your AdGuard Home API address, for example ${ADGUARD_DIRECT_HINT}.`,
  };
}

export function parseAdguardQueryLog(body: string): { queries: ScoutQuery[]; rawCount: number; unblockedCount: number } {
  let json: { data?: unknown } | null = null;
  try {
    json = JSON.parse(body || 'null');
  } catch {
    json = null;
  }
  const data = Array.isArray(json?.data) ? json.data : [];
  const queries: ScoutQuery[] = [];
  for (const item of data) {
    const record = item as { question?: { name?: string }; client?: string; elapsed_ms?: number; filter_id?: number };
    const name = record?.question?.name;
    if (!name) continue;
    const isBlocked = Boolean(record.filter_id && record.filter_id > 0);
    if (!isBlocked) {
      queries.push({
        domain: name,
        client: record.client,
        elapsedMs: record.elapsed_ms,
        blocked: false,
      });
    }
  }
  return { queries, rawCount: data.length, unblockedCount: queries.length };
}

async function explainQueryLogHttpFailure(
  baseUrl: string,
  response: ProbeResponse,
  request: IdentityRequest,
): Promise<{ message: string; details?: string }> {
  const queryLogUrl = `${baseUrl}/control/querylog`;
  try {
    const identity = await classifyDirectStatus(
      { ok: false, status: response.status, body: response.body },
      `${baseUrl}/control/status`,
      request,
    );
    if (identity.kind === 'home-assistant') {
      return { message: adguardDirectUrlNeededMessage(baseUrl), details: 'ha_url_for_scout' };
    }
  } catch {
    // Fall through to the HTTP status.
  }

  try {
    const api = await request(`${originOf(baseUrl)}/api/`);
    if (isHomeAssistantApiSuccess(api)) {
      return { message: adguardDirectUrlNeededMessage(baseUrl), details: 'ha_url_for_scout' };
    }
  } catch {
    // The status line below is enough when the follow-up probe cannot connect.
  }

  if (response.status === 401 || response.status === 403) {
    return {
      message: `AdGuard Home at ${baseUrl} refused the query log (HTTP ${response.status}). Check the AdGuard username and password.`,
      details: 'adguard_auth',
    };
  }

  return {
    message: `Could not fetch the AdGuard query log at ${queryLogUrl} (HTTP ${response.status}). This was not treated as an empty log.`,
    details: 'querylog_http_error',
  };
}

export async function fetchAdguardQueryLog(options: {
  config: SinkholeUrlFields;
  limit: number;
  request: IdentityRequest;
}): Promise<QueryLogLoad> {
  const target = resolveAdguardScoutBase(options.config);
  if (!target.ok) return target;

  const limit = Math.max(1, options.limit || 50);
  let response: ProbeResponse;
  try {
    response = await options.request(target.queryLogUrl(limit));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      details: 'querylog_transport',
      message: `Could not fetch the AdGuard query log at ${target.baseUrl} (${detail}). This was not treated as an empty log.`,
    };
  }

  if (!response.ok || !response.body.trim().startsWith('{')) {
    const explained = await explainQueryLogHttpFailure(target.baseUrl, response, options.request);
    return { ok: false, ...explained };
  }

  let parsed: ReturnType<typeof parseAdguardQueryLog>;
  try {
    parsed = parseAdguardQueryLog(response.body);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      details: 'querylog_parse',
      message: `AdGuard Home at ${target.baseUrl} returned a query log that could not be read (${detail}).`,
    };
  }

  return {
    ok: true,
    queries: parsed.queries,
    rawCount: parsed.rawCount,
    unblockedCount: parsed.unblockedCount,
    limit,
    baseUrl: target.baseUrl,
  };
}
