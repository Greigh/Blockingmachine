export const ADGUARD_ON_HA_API_DETAILS = 'adguard_on_ha_api';
export const HA_ON_DIRECT_DETAILS = 'ha_on_direct';
export const NOT_HOME_ASSISTANT_DETAILS = 'not_home_assistant';

export const ADGUARD_ON_HA_API_MESSAGE =
  'This URL is AdGuard Home, not Home Assistant. Switch to Direct AdGuard and use your AdGuard username and password, or point Home Assistant REST API mode at the Home Assistant URL (often port 8123).';

export const HA_ON_DIRECT_MESSAGE =
  'This URL looks like Home Assistant, not AdGuard Home. Use Direct mode only against AdGuard\'s API port, or switch to Home Assistant REST API mode.';

export interface ProbeResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  body: string;
}

export type IdentityRequest = (url: string) => Promise<ProbeResponse>;

export type HaApiIdentity =
  | { kind: 'home-assistant' }
  | { kind: 'unauthorized' }
  | { kind: 'adguard'; message: string; details: typeof ADGUARD_ON_HA_API_DETAILS; status: number }
  | { kind: 'not-home-assistant'; message: string; details: typeof NOT_HOME_ASSISTANT_DETAILS; status: number };

export type DirectIdentity =
  | { kind: 'adguard' }
  | { kind: 'home-assistant'; message: string; details: typeof HA_ON_DIRECT_DETAILS }
  | { kind: 'other' };

export function isServiceMismatch(details?: string): boolean {
  return details === ADGUARD_ON_HA_API_DETAILS || details === HA_ON_DIRECT_DETAILS;
}

export function parseJsonObject(body: string): Record<string, unknown> | null {
  const trimmed = (body || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function isHomeAssistantApiSuccess(res: ProbeResponse): boolean {
  if (!res.ok) return false;
  const json = parseJsonObject(res.body);
  if (!json || typeof json.message !== 'string') return false;
  return /api running/i.test(json.message);
}

export function isAdGuardStatusBody(res: ProbeResponse): boolean {
  const json = parseJsonObject(res.body);
  if (!json || typeof json.version !== 'string') return false;
  if (!/^v?\d+\.\d+/.test(json.version)) return false;
  return (
    'protection_enabled' in json
    || 'dns_port' in json
    || 'http_port' in json
    || 'running' in json
    || 'dns_addresses' in json
  );
}

export function isAdGuardUiBody(res: ProbeResponse): boolean {
  const body = res.body || '';
  if (!/adguard\s*home/i.test(body)) return false;
  return /<!doctype|<html|<title/i.test(body);
}

export function isHomeAssistantAuthFailure(res: ProbeResponse): boolean {
  if (res.status !== 401 && res.status !== 403) return false;
  if (isAdGuardStatusBody(res)) return false;
  const json = parseJsonObject(res.body);
  return Boolean(json && typeof json.message === 'string');
}

export function looksLikeNotHomeAssistant(res: ProbeResponse): boolean {
  if (isHomeAssistantApiSuccess(res) || isHomeAssistantAuthFailure(res)) return false;
  const json = parseJsonObject(res.body);
  if (!json) return true;
  const message = typeof json.message === 'string' ? json.message : '';
  return !/api running/i.test(message);
}

export function originOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

export async function detectAdGuard(origin: string, request: IdentityRequest): Promise<boolean> {
  try {
    const status = await request(`${origin}/control/status`);
    if (isAdGuardStatusBody(status)) return true;
  } catch {
    // The UI page is an independent signal.
  }
  try {
    const ui = await request(`${origin}/`);
    if (isAdGuardUiBody(ui)) return true;
  } catch {
    return false;
  }
  return false;
}

function notHomeAssistantMessage(res: ProbeResponse): string {
  let shape: string;
  if (!parseJsonObject(res.body) && res.status === 404 && /404 page not found/i.test(res.body || '')) {
    shape = 'plain-text HTTP 404, not Home Assistant JSON';
  } else if (!parseJsonObject(res.body)) {
    shape = `HTTP ${res.status} with a non-JSON body`;
  } else {
    shape = `HTTP ${res.status} JSON without the Home Assistant API signature`;
  }
  return `This URL did not respond like a Home Assistant API (${shape}). Point Home Assistant REST API mode at the Home Assistant URL, often port 8123. If this host is AdGuard Home, switch to Direct AdGuard.`;
}

export async function classifyHaApiResponse(
  api: ProbeResponse,
  pingUrl: string,
  request: IdentityRequest,
): Promise<HaApiIdentity> {
  if (isHomeAssistantApiSuccess(api)) return { kind: 'home-assistant' };
  if (isHomeAssistantAuthFailure(api)) return { kind: 'unauthorized' };

  const adguard = await detectAdGuard(originOf(pingUrl), request);
  if (adguard) {
    return {
      kind: 'adguard',
      message: ADGUARD_ON_HA_API_MESSAGE,
      details: ADGUARD_ON_HA_API_DETAILS,
      status: api.status,
    };
  }
  return {
    kind: 'not-home-assistant',
    message: notHomeAssistantMessage(api),
    details: NOT_HOME_ASSISTANT_DETAILS,
    status: api.status,
  };
}

export async function classifyDirectStatus(
  statusResult: ProbeResponse,
  statusUrl: string,
  request: IdentityRequest,
): Promise<DirectIdentity> {
  if (isAdGuardStatusBody(statusResult)) return { kind: 'adguard' };
  if (statusResult.status === 401) return { kind: 'other' };

  let api: ProbeResponse;
  try {
    api = await request(`${originOf(statusUrl)}/api/`);
  } catch {
    return { kind: 'other' };
  }
  if (isHomeAssistantApiSuccess(api)) {
    return { kind: 'home-assistant', message: HA_ON_DIRECT_MESSAGE, details: HA_ON_DIRECT_DETAILS };
  }
  return { kind: 'other' };
}

export function haApiConnectionResult(
  identity: HaApiIdentity,
  latencyMs: number,
  baseUrl: string,
  httpStatus?: number,
): { success: boolean; statusCode?: number; message: string; details?: string } {
  if (identity.kind === 'home-assistant') {
    const message = baseUrl.includes('nabu.casa')
      ? `Connected to Home Assistant API via Nabu Casa Cloud (${latencyMs}ms, ready for adguard.refresh)`
      : `Connected to Home Assistant API (${latencyMs}ms, ready for adguard.refresh)`;
    return { success: true, statusCode: httpStatus, message };
  }
  if (identity.kind === 'unauthorized') {
    return {
      success: false,
      statusCode: 401,
      message: 'Home Assistant token rejected (HTTP 401 Unauthorized). Verify your Long-Lived Access Token.',
    };
  }
  return {
    success: false,
    statusCode: identity.status,
    message: identity.message,
    details: identity.details,
  };
}

export function haApiSyncBlockReason(
  identity: HaApiIdentity,
): { message: string; details: string } | null {
  if (identity.kind === 'home-assistant') return null;
  if (identity.kind === 'unauthorized') {
    return {
      message: 'Home Assistant token rejected (HTTP 401 Unauthorized). Verify your Long-Lived Access Token.',
      details: 'ha_unauthorized',
    };
  }
  return { message: identity.message, details: identity.details };
}
