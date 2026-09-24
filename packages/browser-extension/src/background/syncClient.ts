import { DEFAULT_FEED_URL } from '../shared/constants';

export class SyncClient {
  private feedUrl: string;

  constructor(feedUrl: string = DEFAULT_FEED_URL) {
    this.feedUrl = feedUrl;
  }

  async fetchCompiledRules(): Promise<string[]> {
    try {
      const response = await fetch(this.feedUrl);
      if (!response.ok) {
        throw new Error(`Feed server responded with status: ${response.status}`);
      }
      const text = await response.text();
      return text.split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('!') && !line.startsWith('#'));
    } catch (err) {
      console.warn('[SyncClient] Could not fetch rules from local feed server:', err);
      return [];
    }
  }
}
