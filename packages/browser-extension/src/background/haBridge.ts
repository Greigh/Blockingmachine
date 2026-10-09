import {
  DEFAULT_FEED_URL,
  DEFAULT_HA_URL,
  STORAGE_KEY_HA_CONFIG,
  STORAGE_KEY_COSMETICS_ENABLED,
} from '../shared/constants.js';
import { HomeAssistantConfig } from '../shared/types.js';

export const DEFAULT_HA_CONFIG: HomeAssistantConfig = {
  enabled: false,
  url: DEFAULT_HA_URL,
  token: '',
  feedUrl: DEFAULT_FEED_URL,
  feedToken: '',
  cosmeticsEnabled: true,
  autoSync: true,
};

export class HaBridge {
  private config: HomeAssistantConfig = { ...DEFAULT_HA_CONFIG };

  constructor() {
    this.loadConfig();
  }

  public async loadConfig(): Promise<HomeAssistantConfig> {
    try {
      if (chrome.storage?.local) {
        const stored = await chrome.storage.local.get([STORAGE_KEY_HA_CONFIG, STORAGE_KEY_COSMETICS_ENABLED]);
        if (stored[STORAGE_KEY_HA_CONFIG]) {
          this.config = { ...DEFAULT_HA_CONFIG, ...stored[STORAGE_KEY_HA_CONFIG] };
        }
        if (typeof stored[STORAGE_KEY_COSMETICS_ENABLED] === 'boolean') {
          this.config.cosmeticsEnabled = stored[STORAGE_KEY_COSMETICS_ENABLED];
        }
      }
    } catch (err) {
      console.warn('[HaBridge] Error loading config:', err);
    }
    return this.config;
  }

  public async saveConfig(updated: Partial<HomeAssistantConfig>): Promise<HomeAssistantConfig> {
    this.config = { ...this.config, ...updated };
    try {
      if (chrome.storage?.local) {
        await chrome.storage.local.set({
          [STORAGE_KEY_HA_CONFIG]: this.config,
          [STORAGE_KEY_COSMETICS_ENABLED]: this.config.cosmeticsEnabled,
        });
      }
    } catch (err) {
      console.warn('[HaBridge] Error saving config:', err);
    }
    return this.config;
  }

  public getConfig(): HomeAssistantConfig {
    return { ...this.config };
  }

  /**
   * Pushes aggregated telemetry from the browser extension to the local hub / Home Assistant.
   */
  public async reportTelemetry(report: {
    trackersBlocked: number;
    elementsHidden: number;
    threatsDetected: number;
    trackers?: Array<{ domain: string; count: number }>;
    /**
     * New (host, site) edges since the last push — flag 43's embeddability signal.
     * The hub unions them; re-sends are idempotent.
     */
    fanout?: Array<{ domain: string; firstParties: string[]; hits: number }>;
  }): Promise<boolean> {
    const endpoints: { url: string; bearer?: string }[] = [];

    // 1. Try configured feed server / local hub — the hub's own mutation token, never the
    // HA credential. A hub with `feedToken` set refuses unauthenticated mutations.
    if (this.config.feedUrl) {
      try {
        const u = new URL(this.config.feedUrl);
        endpoints.push({ url: `${u.protocol}//${u.host}/v1/telemetry/browser`, bearer: this.config.feedToken });
      } catch {
        // invalid URL
      }
    }
    // Default local hub fallback
    endpoints.push({ url: 'http://127.0.0.1:9191/v1/telemetry/browser', bearer: this.config.feedToken });

    // 2. If Home Assistant is configured, also report to the HA webhook — HA authenticates
    // webhooks by the secret path, but a bearer passes through harmlessly if one is set.
    if (this.config.enabled && this.config.url) {
      const haBase = this.config.url.replace(/\/+$/, '');
      endpoints.push({ url: `${haBase}/api/webhook/blockingmachine_browser_telemetry`, bearer: this.config.token });
    }

    for (const endpoint of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        // Each endpoint gets the credential that belongs to it — the feed mutation token for
        // /v1/* pushes, the HA long-lived token for the Home Assistant URL. Every candidate is
        // user-configured or localhost, so there is no third party for a credential to leak to.
        if (endpoint.bearer) {
          headers['Authorization'] = `Bearer ${endpoint.bearer}`;
        }

        const resp = await fetch(endpoint.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...report,
            timestamp: new Date().toISOString(),
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (resp.ok) {
          console.log(`[HaBridge] Telemetry reported successfully to ${endpoint.url}`);
          return true;
        }
      } catch {
        // Try next candidate
      }
    }

    return false;
  }

  /**
   * Tests reachability of Home Assistant or local hub endpoint.
   */
  public async testConnection(targetUrl?: string, token?: string, feedToken?: string): Promise<{ ok: boolean; message: string }> {
    const checkUrl = targetUrl || this.config.url;
    const checkToken = token !== undefined ? token : this.config.token;
    const checkFeedToken = feedToken !== undefined ? feedToken : this.config.feedToken;

    // Try /api/ (Home Assistant — its long-lived token) or /v1/status (a hub feed —
    // the feed mutation token). The fallback covers pointing the field at the hub.
    const testCandidates = [
      { url: `${checkUrl.replace(/\/+$/, '')}/api/`, bearer: checkToken },
      { url: `${checkUrl.replace(/\/+$/, '')}/v1/status`, bearer: checkFeedToken || checkToken },
    ];

    let sawAuthFailure = false;
    let lastHttp: { status: number; url: string } | null = null;
    for (const candidate of testCandidates) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const headers: Record<string, string> = {};
        if (candidate.bearer) headers['Authorization'] = `Bearer ${candidate.bearer}`;

        const resp = await fetch(candidate.url, { headers, signal: controller.signal });
        clearTimeout(timeout);

        if (resp.ok) {
          return { ok: true, message: `Connected successfully to ${candidate.url}` };
        }
        if (resp.status === 401 || resp.status === 403) sawAuthFailure = true;
        else lastHttp = { status: resp.status, url: candidate.url };
      } catch {
        clearTimeout(timeout);
        // continue
      }
    }

    if (sawAuthFailure) {
      return { ok: false, message: 'Reached the server but it rejected the request (HTTP 401/403). Paste your Home Assistant Long-Lived Access Token (Profile, then Security, then Long-Lived Access Tokens).' };
    }
    if (lastHttp) {
      return { ok: false, message: `Reached the server but the probe returned HTTP ${lastHttp.status} at ${lastHttp.url}.` };
    }
    return { ok: false, message: 'Could not connect to specified address.' };
  }
}
