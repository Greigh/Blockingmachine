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
  }): Promise<boolean> {
    const endpoints: string[] = [];

    // 1. Try configured feed server / local hub
    if (this.config.feedUrl) {
      try {
        const u = new URL(this.config.feedUrl);
        endpoints.push(`${u.protocol}//${u.host}/v1/telemetry/browser`);
      } catch {
        // invalid URL
      }
    }
    // Default local hub fallback
    endpoints.push('http://127.0.0.1:9191/v1/telemetry/browser');

    // 2. If Home Assistant is configured, also report to HA webhook
    if (this.config.enabled && this.config.url) {
      const haBase = this.config.url.replace(/\/+$/, '');
      endpoints.push(`${haBase}/api/webhook/blockingmachine_browser_telemetry`);
    }

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (this.config.token && url.includes(this.config.url)) {
          headers['Authorization'] = `Bearer ${this.config.token}`;
        }

        const resp = await fetch(url, {
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
          console.log(`[HaBridge] Telemetry reported successfully to ${url}`);
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
  public async testConnection(targetUrl?: string, token?: string): Promise<{ ok: boolean; message: string }> {
    const checkUrl = targetUrl || this.config.url;
    const checkToken = token !== undefined ? token : this.config.token;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      // Try /api/ discovery or /v1/status
      const testCandidates = [
        `${checkUrl.replace(/\/+$/, '')}/api/`,
        `${checkUrl.replace(/\/+$/, '')}/v1/status`,
      ];

      for (const candidate of testCandidates) {
        try {
          const headers: Record<string, string> = {};
          if (checkToken) headers['Authorization'] = `Bearer ${checkToken}`;

          const resp = await fetch(candidate, { headers, signal: controller.signal });
          clearTimeout(timeout);

          if (resp.ok) {
            return { ok: true, message: `Connected successfully to ${candidate}` };
          }
        } catch {
          // continue
        }
      }
      clearTimeout(timeout);
    } catch (err: any) {
      return { ok: false, message: `Connection failed: ${err?.message || err}` };
    }

    return { ok: false, message: 'Could not connect to specified address.' };
  }
}
