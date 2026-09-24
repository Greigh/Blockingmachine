import { DEFAULT_FEED_URL } from '../shared/constants.js';

export class SyncClient {
  private feedUrl: string;

  constructor(feedUrl: string = DEFAULT_FEED_URL) {
    this.feedUrl = feedUrl;
  }

  async fetchCompiledRules(): Promise<string[]> {
    try {
      // 5-second timeout to prevent service worker execution hanging indefinitely
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(this.feedUrl, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Feed server responded with status: ${response.status}`);
      }

      const text = await response.text();
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('!') && !line.startsWith('#'));
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.warn(`[SyncClient] Timeout connecting to feed server at ${this.feedUrl}`);
      } else {
        console.warn(`[SyncClient] Could not fetch rules from local feed server: ${err?.message || err}`);
      }
      return [];
    }
  }
}
