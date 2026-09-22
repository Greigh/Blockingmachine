/** AdGuard Home's default direct API / web port. */
export const DEFAULT_ADGUARD_DIRECT_PORT = 3000;

/**
 * Home Assistant frontend ports. These are the HA UI, not AdGuard's API.
 * 8123 is the default. 8124 and 8125 are common remaps when 8123 is taken.
 */
export const HA_FRONTEND_PORTS: ReadonlySet<number> = new Set([8123, 8124, 8125]);

const HA_UI_PATH_PREFIXES = [
  '/lovelace',
  '/auth',
  '/frontend_latest',
  '/frontend_es5',
  '/static',
  '/api',
  '/hassio',
  '/config',
  '/developer-tools',
  '/history',
  '/logbook',
  '/energy',
  '/map',
  '/profile',
  '/local',
];

const CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_FIRST_CERTIFICATE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_SIGNATURE_FAILURE',
]);

export interface SinkholeEndpoint {
  /** scheme://host[:port] with no path */
  display: string;
  host: string;
  port: number | null;
  scheme: 'http' | 'https';
}

export interface AdguardDirectTarget extends SinkholeEndpoint {
  baseUrl: string;
  statusUrl: string;
  refreshUrl: string;
  homeAssistantHost: boolean;
}

export interface HaApiTarget extends SinkholeEndpoint {
  baseUrl: string;
  pingUrl: string;
  refreshUrl: string;
}

export type AdguardDirectResolution =
  | { ok: true; target: AdguardDirectTarget }
  | {
      ok: false;
      code: 'empty' | 'invalid' | 'nabu_casa' | 'ha_frontend';
      message: string;
      details?: string;
      statusCode?: number;
    };

export function normalizeAdguardDirectPort(value: unknown): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_ADGUARD_DIRECT_PORT;
  return n;
}

export function formatHost(hostname: string): string {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host.includes(':') ? `[${host}]` : host;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map((part) => Number(part));
    if (parts.some((part) => part > 255)) return false;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  if (host.includes(':')) {
    if (host.startsWith('fe80:')) return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    const mapped = host.match(/(?:^|:)ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateOrLocalHost(mapped[1]);
    return false;
  }

  return false;
}

/** True only for HTTPS on a local/private host when the user opted in. */
export function shouldBypassUntrustedTls(url: string, allowInsecureLocalTls: boolean): boolean {
  if (!allowInsecureLocalTls) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && isPrivateOrLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function localTlsBypassNote(rawUrl: string, allowInsecureLocalTls: boolean): string | null {
  if (!allowInsecureLocalTls || !rawUrl?.trim()) return null;
  try {
    const withScheme = ensureScheme(rawUrl.trim());
    const parsed = new URL(withScheme);
    if (parsed.protocol === 'https:' && !isPrivateOrLocalHost(parsed.hostname)) {
      return 'Certificate verification stays on for this host because it is not a local or private address. The toggle only applies to localhost, .local names, and private LAN addresses.';
    }
  } catch {
    return null;
  }
  return null;
}

export function normalizeServiceUrl(raw: string): string {
  let url = raw.trim();
  if (url.toLowerCase().includes('nabu.casa')) {
    if (url.startsWith('http://')) url = url.replace(/^http:\/\//i, 'https://');
    else if (!url.startsWith('https://')) url = `https://${url}`;
  } else if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  return url.replace(/\/$/, '');
}

export function replaceMatchingExplicitPort(rawUrl: string, fromPort: number, toPort: number): string {
  if (!rawUrl || fromPort === toPort) return rawUrl;
  const trimmed = rawUrl.trim();
  const hadScheme = /^https?:\/\//i.test(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(hadScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return rawUrl;
  }
  if (!parsed.port || Number(parsed.port) !== fromPort) return rawUrl;
  parsed.port = String(toPort);
  let out = parsed.toString();
  if (parsed.pathname === '/' && !trimmed.endsWith('/') && out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  if (!hadScheme) out = out.replace(/^https?:\/\//i, '');
  return out;
}

export function directModeWarning(
  rawUrl: string,
  configuredPort?: unknown,
): { code: 'ha_frontend' | 'nabu_casa'; message: string } | null {
  if (!rawUrl?.trim()) return null;
  const resolved = resolveAdguardDirectUrl(rawUrl, configuredPort);
  if (resolved.ok) return null;
  if (resolved.code === 'ha_frontend' || resolved.code === 'nabu_casa') {
    return { code: resolved.code, message: resolved.message };
  }
  return null;
}

export function resolveAdguardDirectUrl(rawUrl: string, configuredPort?: unknown): AdguardDirectResolution {
  const trimmed = rawUrl?.trim() || '';
  if (!trimmed) {
    return { ok: false, code: 'empty', message: 'AdGuard Home URL is not configured.' };
  }

  const apiPort = normalizeAdguardDirectPort(configuredPort);
  if (trimmed.toLowerCase().includes('nabu.casa')) {
    return {
      ok: false,
      code: 'nabu_casa',
      statusCode: 400,
      details: 'nabu_casa_direct_mode',
      message: nabuCasaDirectMessage(apiPort),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(ensureScheme(trimmed));
  } catch {
    return { ok: false, code: 'invalid', message: 'AdGuard Home URL is not valid.' };
  }

  const explicitPort = parsed.port ? Number(parsed.port) : null;
  const pathIsAdguardApi = isAdguardControlPath(parsed.pathname);
  const pathIsHaUi = isClearlyNonAdguardPath(parsed.pathname);
  const portIsHaUi = explicitPort != null && HA_FRONTEND_PORTS.has(explicitPort) && !pathIsAdguardApi;

  if (pathIsHaUi || portIsHaUi) {
    const detectedPort = explicitPort != null && HA_FRONTEND_PORTS.has(explicitPort) ? explicitPort : undefined;
    return {
      ok: false,
      code: 'ha_frontend',
      statusCode: detectedPort ?? 400,
      details: 'ha_frontend',
      message: haFrontendDirectMessage(detectedPort, apiPort, pathIsHaUi),
    };
  }

  const port = explicitPort ?? apiPort;
  const scheme: 'http' | 'https' = parsed.protocol === 'https:' ? 'https' : 'http';
  const host = parsed.hostname;
  const baseUrl = `${scheme}://${formatHost(host)}:${port}`;
  return {
    ok: true,
    target: {
      display: baseUrl,
      baseUrl,
      statusUrl: `${baseUrl}/control/status`,
      refreshUrl: `${baseUrl}/control/filtering/refresh`,
      host,
      port,
      scheme,
      homeAssistantHost: hostLooksLikeHomeAssistant(host),
    },
  };
}

export function resolveHaApiUrl(rawUrl: string): { ok: true; target: HaApiTarget } | { ok: false; message: string } {
  const trimmed = rawUrl?.trim() || '';
  if (!trimmed) return { ok: false, message: 'Home Assistant instance URL is not configured.' };

  let parsed: URL;
  try {
    parsed = new URL(normalizeServiceUrl(trimmed));
  } catch {
    return { ok: false, message: 'Home Assistant URL is not valid.' };
  }

  const scheme: 'http' | 'https' = parsed.protocol === 'https:' ? 'https' : 'http';
  const port = parsed.port ? Number(parsed.port) : null;
  const baseUrl = `${scheme}://${parsed.host}`;
  return {
    ok: true,
    target: {
      display: baseUrl,
      baseUrl,
      pingUrl: `${baseUrl}/api/`,
      refreshUrl: `${baseUrl}/api/services/adguard/refresh`,
      host: parsed.hostname,
      port,
      scheme,
    },
  };
}

export function normalizeWebhookUrl(rawUrl: string): { ok: true; url: string; endpoint: SinkholeEndpoint } | { ok: false; message: string } {
  const trimmed = rawUrl?.trim() || '';
  if (!trimmed) return { ok: false, message: 'Webhook URL is not configured.' };
  let withScheme = trimmed;
  if (withScheme.toLowerCase().includes('nabu.casa')) {
    if (withScheme.startsWith('http://')) withScheme = withScheme.replace(/^http:\/\//i, 'https://');
    else if (!/^https:\/\//i.test(withScheme)) withScheme = `https://${withScheme}`;
  } else if (!/^https?:\/\//i.test(withScheme)) {
    withScheme = `http://${withScheme}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, message: 'Invalid Webhook URL format.' };
  }
  const scheme: 'http' | 'https' = parsed.protocol === 'https:' ? 'https' : 'http';
  return {
    ok: true,
    url: parsed.toString(),
    endpoint: {
      display: `${scheme}://${parsed.host}`,
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : null,
      scheme,
    },
  };
}

export function adguardControlBaseUrl(rawUrl: string | undefined, configuredPort?: unknown): string {
  const port = normalizeAdguardDirectPort(configuredPort);
  const raw = rawUrl?.trim() || '';
  if (!raw) return `http://127.0.0.1:${port}`;
  const resolved = resolveAdguardDirectUrl(raw, port);
  if (resolved.ok) return resolved.target.baseUrl;
  return normalizeServiceUrl(raw);
}

export function describeUrlEndpoint(urlStr: string): SinkholeEndpoint {
  const parsed = new URL(urlStr);
  const scheme: 'http' | 'https' = parsed.protocol === 'https:' ? 'https' : 'http';
  return {
    display: `${scheme}://${parsed.host}`,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : null,
    scheme,
  };
}

export function formatSinkholeError(
  err: unknown,
  endpoint: SinkholeEndpoint,
  options?: { allowInsecureLocalTls?: boolean; haAddonPortHint?: boolean; hintPort?: number | null },
): string {
  const entries = collectErrorEntries(err);
  const where = endpoint.display || endpoint.host;
  const localHttps = endpoint.scheme === 'https' && isPrivateOrLocalHost(endpoint.host);
  let message: string;

  if (isCertProblem(entries)) {
    const reason = certReason(entries);
    if (localHttps && !options?.allowInsecureLocalTls) {
      const httpFallback = endpoint.port
        ? `http://${formatHost(endpoint.host)}:${endpoint.port}`
        : `http://${formatHost(endpoint.host)}`;
      message = `TLS certificate rejected for ${where} (${reason}). This host is local, so you can enable "Allow untrusted TLS certificates (local only)", use ${httpFallback} on your LAN, or install a trusted certificate.`;
    } else if (!localHttps) {
      message = `TLS certificate rejected for ${where} (${reason}). Certificate verification stays on because this host is not local. "Allow untrusted TLS certificates (local only)" only applies to localhost, .local names, and private LAN addresses.`;
    } else {
      message = `TLS certificate rejected for ${where} (${reason}).`;
    }
  } else if (hasCode(entries, ['ENOTFOUND', 'EAI_AGAIN'])) {
    const code = firstCode(entries, ['ENOTFOUND', 'EAI_AGAIN']);
    const mdns = endpoint.host.toLowerCase().endsWith('.local')
      ? ' mDNS .local names sometimes fail from this app; try the device\'s LAN IP address instead.'
      : '';
    message = `Could not resolve ${endpoint.host} (${code}).${mdns}`;
  } else if (hasCode(entries, ['ECONNREFUSED'])) {
    message = `Connection refused at ${where} (ECONNREFUSED). Nothing accepted the connection on that port.`;
  } else if (hasCode(entries, ['EHOSTUNREACH', 'ENETUNREACH'])) {
    message = `Network unreachable for ${where} (${firstCode(entries, ['EHOSTUNREACH', 'ENETUNREACH'])}).`;
  } else if (isTimeout(entries)) {
    message = `Timed out connecting to ${where}.`;
  } else {
    const code = entries.find((entry) => entry.code)?.code;
    const detail = entries
      .map((entry) => entry.message?.trim())
      .find((text) => text && !/^fetch failed$/i.test(text) && text !== 'Failed to fetch');
    const suffix = [code, detail && detail !== code ? detail : ''].filter(Boolean).join(': ');
    message = suffix ? `Cannot connect to ${where} (${suffix}).` : `Cannot connect to ${where}.`;
  }

  if (options?.haAddonPortHint) {
    const hintPort = options.hintPort ?? endpoint.port;
    const portText = hintPort ? `port ${hintPort}` : 'the AdGuard API port';
    message += ` In Home Assistant, go to Settings > Add-ons > AdGuard Home > Configuration, ensure ${portText} is mapped under Network, and restart the add-on.`;
  }
  return message;
}

function ensureScheme(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

function isAdguardControlPath(pathname: string): boolean {
  const path = (pathname || '/').toLowerCase();
  return path === '/control' || path.startsWith('/control/');
}

function isClearlyNonAdguardPath(pathname: string): boolean {
  const path = (pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
  if (path === '/' || isAdguardControlPath(path)) return false;
  return HA_UI_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function hostLooksLikeHomeAssistant(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.includes('homeassistant') || host.includes('home-assistant');
}

function nabuCasaDirectMessage(apiPort: number): string {
  return `Nabu Casa Cloud remote URLs only proxy Home Assistant itself (port 8123), not AdGuard Home direct port ${apiPort}. Switch Mode to "Home Assistant REST API" or "Home Assistant Webhook" to reload AdGuard over Nabu Casa.`;
}

function haFrontendDirectMessage(detectedPort: number | undefined, apiPort: number, pathIsHaUi: boolean): string {
  const what = detectedPort != null
    ? `Port ${detectedPort} is the Home Assistant web interface, not AdGuard Direct.`
    : 'This URL is the Home Assistant web interface, not AdGuard Direct.';
  const pathNote = pathIsHaUi && detectedPort == null
    ? ' The path is not AdGuard\'s API.'
    : '';
  return `${what}${pathNote} Either map and expose AdGuard's API port (${apiPort}) in Add-ons > AdGuard Home > Configuration > Network and use that URL (for example http://homeassistant.local:${apiPort}), or switch to Home Assistant REST API or Webhook mode.`;
}

interface ErrorEntry {
  code?: string;
  message?: string;
  name?: string;
}

function collectErrorEntries(err: unknown): ErrorEntry[] {
  const out: ErrorEntry[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'string') || seen.has(value)) return;
    if (typeof value === 'string') {
      out.push({ message: value });
      return;
    }
    seen.add(value);
    const record = value as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    out.push({
      code: typeof record.code === 'string' ? record.code : undefined,
      message: typeof record.message === 'string' ? record.message : undefined,
      name: typeof record.name === 'string' ? record.name : undefined,
    });
    visit(record.cause);
    if (Array.isArray(record.errors)) {
      for (const inner of record.errors) visit(inner);
    }
  };
  visit(err);
  return out;
}

function isCertProblem(entries: ErrorEntry[]): boolean {
  return entries.some((entry) => {
    const code = entry.code || '';
    if (CERT_CODES.has(code) || code.includes('CERT') || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) {
      return true;
    }
    const message = (entry.message || '').toLowerCase();
    return message.includes('self-signed')
      || message.includes('self signed')
      || message.includes('unable to verify')
      || message.includes('certificate')
      || message.includes('altname');
  });
}

function certReason(entries: ErrorEntry[]): string {
  const code = entries.find((entry) => entry.code && (CERT_CODES.has(entry.code) || entry.code.includes('CERT') || entry.code.includes('TLS')))?.code;
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return 'self-signed certificate';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'certificate name does not match the host';
  if (code === 'CERT_HAS_EXPIRED') return 'certificate expired';
  return code ? code : 'self-signed or untrusted certificate';
}

function hasCode(entries: ErrorEntry[], codes: string[]): boolean {
  return entries.some((entry) => entry.code != null && codes.includes(entry.code))
    || entries.some((entry) => codes.some((code) => (entry.message || '').includes(code)));
}

function firstCode(entries: ErrorEntry[], codes: string[]): string {
  return entries.find((entry) => entry.code && codes.includes(entry.code))?.code
    || codes.find((code) => entries.some((entry) => (entry.message || '').includes(code)))
    || codes[0];
}

function isTimeout(entries: ErrorEntry[]): boolean {
  return entries.some((entry) => {
    const code = entry.code || '';
    const name = entry.name || '';
    const message = (entry.message || '').toLowerCase();
    return code === 'ETIMEDOUT'
      || code === 'UND_ERR_CONNECT_TIMEOUT'
      || code === 'UND_ERR_HEADERS_TIMEOUT'
      || code === 'UND_ERR_BODY_TIMEOUT'
      || name === 'TimeoutError'
      || name === 'AbortError'
      || message.includes('timeout')
      || message.includes('the operation was aborted');
  });
}
