import { DEFAULT_FEED_URL } from '../shared/constants.js';

export interface IngestedRules {
  networkRules: string[];
  cosmeticSelectors: string[];
  /**
   * The measured hot set, or `null` when the deployment has none.
   *
   * Deliberately nullable and deliberately optional. The hot set is what a client installs *when
   * the full export does not fit the browser's rule budget* — it is a fallback, not a replacement —
   * so `null` is a perfectly good answer and means "prune the full list as before". A deployment
   * that has never run the measurement serves no hot set at all, and that must not be a fault.
   */
  hotRuleLines: string[] | null;
}

/** A feed request that gives up rather than hanging the worker. */
const FEED_TIMEOUT_MS = 5000;

/**
 * Fetches one feed URL, or `null` if it is unreachable, slow, or not `ok`.
 *
 * The timeout is cleared in a `finally` rather than on the success path, because the interesting
 * case is the failing one: a request that rejects never reaches a `clearTimeout` placed after the
 * `await`, so the pending timer survives and keeps a 5-second handle alive in a service worker that
 * has nothing left to do. That is exactly the situation the hot set creates most often, since it is
 * consulted against deployments that are expected not to have one.
 *
 * A 401/403 gets its own log line — "the server wants the feed token" and "the server is down"
 * are very different failures, and both used to collapse into the same silent baseline fallback.
 */
async function fetchFeedText(url: string, token?: string): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      console.warn(`[SyncClient] ${url} rejected the request (HTTP ${response.status}) — the server wants a feed token (Popup → Home Assistant → feed token).`);
      return null;
    }
    if (!response.ok) return null;
    return await response.text();
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn(`[SyncClient] Timeout connecting to feed at ${url}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Filter-list lines, without the comments and blanks the files carry. */
function ingestableLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('!') && !line.startsWith('#'));
}

export class SyncClient {
  private feedUrl: string;
  private feedToken?: string;

  constructor(feedUrl: string = DEFAULT_FEED_URL) {
    this.feedUrl = feedUrl;
  }

  /**
   * Repoint the client at a configured feed (and its token). Called when the HA
   * config changes — the stored feed URL is otherwise dead config.
   */
  public setFeed(feedUrl: string, feedToken?: string): void {
    if (feedUrl.trim()) this.feedUrl = feedUrl.trim();
    this.feedToken = feedToken?.trim() || undefined;
  }

  /**
   * Fetches the measured hot set, or `null` if this deployment has none.
   *
   * Never throws and never rejects. The hot set is a *fallback* for clients whose full export
   * overflows the browser's rule budget; a client that cannot reach it still gets the full list
   * with today's pruning, which is worse but correct. Letting a failed hot-set request fail the
   * whole sync would trade a better list for no list, which is the wrong way round for a resource
   * that is only ever consulted in an emergency.
   *
   * The URLs are the full list's own candidates with the filename swapped, so a deployment whose
   * feed lives somewhere other than the local default is served from wherever it keeps its rules
   * rather than having to configure the hot set separately.
   */
  private async fetchHotRuleLines(candidateUrls: string[]): Promise<string[] | null> {
    const hotUrls = [
      ...candidateUrls.map((url) => {
        try {
          const parsed = new URL(url);
          parsed.pathname = parsed.pathname.replace(/[^/]*$/, 'hotlist.txt');
          return parsed.toString();
        } catch {
          return url;
        }
      }),
      'http://127.0.0.1:9191/hotlist.txt'
    ];

    for (const url of hotUrls) {
      const text = await fetchFeedText(url, this.feedToken);
      if (text === null) continue;

      const lines = ingestableLines(text);
      // An empty body means "no measurement here", not "a measurement that blocked nothing".
      // Treating it as absent is what lets a deployment without a hot set keep working.
      if (lines.length === 0) continue;

      console.log(`[SyncClient] Ingested ${lines.length} measured hot-set rules from ${url}.`);
      return lines;
    }

    return null;
  }

  async fetchCompiledRules(): Promise<IngestedRules> {
    // The fallback filenames must match what the servers actually route — the
    // hub's feedServing allowlist and the add-on's router both speak lowercase
    // 'adguardbrowser.txt'; the mixed-case spelling never matched anything.
    const candidateUrls = [
      this.feedUrl,
      'http://127.0.0.1:9191/adguardbrowser.txt',
      'http://127.0.0.1:9191/browser.txt',
    ];

    // Started here and awaited at the end rather than awaited here, so the hot set costs no
    // latency on top of the sync. It has up to four candidates of its own, each with a 5-second
    // timeout, and a deployment whose host drops packets rather than refusing the connection
    // would otherwise spend twenty seconds discovering it has no measurement before the full list
    // was even requested. `fetchHotRuleLines` never rejects, so awaiting it late is safe and the
    // empty-full-list case still gets whatever hot set the deployment has — "the feed is
    // unreachable" and "we have no full list" are different states, and the second is exactly when
    // a measured subset beats nothing.
    const hotRuleLines = this.fetchHotRuleLines(candidateUrls);

    for (const url of candidateUrls) {
      const text = await fetchFeedText(url, this.feedToken);
      if (text === null) continue;

      const networkRules: string[] = [];
      const cosmeticSelectors: string[] = [];

      for (const line of text.split('\n').map((line) => line.trim())) {
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
      return { networkRules, cosmeticSelectors, hotRuleLines: await hotRuleLines };
    }

    console.warn('[SyncClient] All local feed endpoints unreachable. Operating with fallback baseline.');
    return { networkRules: [], cosmeticSelectors: [], hotRuleLines: await hotRuleLines };
  }
}
