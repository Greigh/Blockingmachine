import { DEFAULT_FEED_URL } from '../shared/constants.js';

export interface IngestedRules {
  networkRules: string[];
  cosmeticSelectors: string[];
}

export class SyncClient {
  private feedUrl: string;

  constructor(feedUrl: string = DEFAULT_FEED_URL) {
    this.feedUrl = feedUrl;
  }

  async fetchCompiledRules(): Promise<IngestedRules> {
    const candidateUrls = [
      this.feedUrl,
      'http://127.0.0.1:9191/adguardBrowser.txt',
      'http://127.0.0.1:9191/rules.txt'
    ];

    for (const url of candidateUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          const text = await response.text();
          const lines = text.split('\n').map((line) => line.trim());

          const networkRules: string[] = [];
          const cosmeticSelectors: string[] = [];

          for (const line of lines) {
            if (!line || line.startsWith('!') || line.startsWith('#')) continue;

            // Partition cosmetic element rules away from DNR network rules
            if (line.includes('##')) {
              const parts = line.split('##');
              const selector = parts[1]?.trim();
              if (selector && !selector.includes('{') && !selector.includes('}')) {
                cosmeticSelectors.push(selector);
              }
            } else {
              networkRules.push(line);
            }
          }

          console.log(
            `[SyncClient] Ingested ${networkRules.length} network rules and ${cosmeticSelectors.length} cosmetic selectors from ${url}.`
          );
          return { networkRules, cosmeticSelectors };
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          console.warn(`[SyncClient] Timeout connecting to feed at ${url}`);
        }
      }
    }

    console.warn('[SyncClient] All local feed endpoints unreachable. Operating with fallback baseline.');
    return { networkRules: [], cosmeticSelectors: [] };
  }
}
