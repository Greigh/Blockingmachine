import http from 'node:http';
import fetch from 'node-fetch';
import { DomainTrie } from './engine/domainTrie.js';
import { DnsServer } from './server/dnsServer.js';
import { DaemonConfig, DaemonStatusResponse } from './types.js';

export const defaultConfig: DaemonConfig = {
  bindHost: '127.0.0.1',
  dnsPort: process.env.DNS_PORT ? parseInt(process.env.DNS_PORT, 10) : 5353, // defaults to 5353 for rootless execution; port 53 with sudo
  controlPort: process.env.CONTROL_PORT ? parseInt(process.env.CONTROL_PORT, 10) : 9292,
  upstreamDoHUrl: process.env.UPSTREAM_DOH || 'https://dns.quad9.net/dns-query',
  sinkholeIpv4: '0.0.0.0',
  sinkholeIpv6: '::',
  feedUrl: process.env.FEED_URL || 'http://127.0.0.1:9191/dns.txt'
};

export async function loadRulesFromFeeds(trie: DomainTrie, config: DaemonConfig): Promise<number> {
  const candidateUrls = [config.feedUrl, 'http://127.0.0.1:9191/adguardDns.txt', 'http://127.0.0.1:9191/rules.txt'];
  let rulesLoaded = false;
  let count = 0;

  for (const url of candidateUrls) {
    if (rulesLoaded) break;
    try {
      console.log(`[Daemon] Fetching filter rules from ${url}...`);
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        const lines = text.split('\n');
        trie.clear();
        for (const line of lines) {
          trie.addRule(line);
        }
        count = trie.getRuleCount();
        console.log(`[Daemon] Successfully ingested ${count} rules into DNS memory trie from ${url}.`);
        rulesLoaded = true;
      }
    } catch {
      // Continue to next candidate
    }
  }

  if (!rulesLoaded) {
    console.warn(`[Daemon] Local hub feeds unreachable. Starting with baseline protection and DoH fallback.`);
    // Add default baseline telemetry blocks
    trie.addRule('||doubleclick.net^');
    trie.addRule('||telemetry.tracker.io^');
    count = trie.getRuleCount();
  }

  return count;
}

export async function startDaemon(config: DaemonConfig = defaultConfig) {
  const trie = new DomainTrie();
  await loadRulesFromFeeds(trie, config);

  const dnsServer = new DnsServer(trie, config);
  await dnsServer.start();

  // HTTP Control API (127.0.0.1:9292)
  const controlServer = http.createServer(async (req, res) => {
    // CORS headers for local control & dashboard access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${config.bindHost}:${config.controlPort}`);
    const pathname = url.pathname;

    if (pathname === '/v1/status' || pathname === '/status') {
      const stats = dnsServer.getStats();
      const payload: DaemonStatusResponse = {
        status: dnsServer.isProtectionEnabled() ? 'running' : 'paused',
        port: config.dnsPort,
        controlPort: config.controlPort,
        upstream: config.upstreamDoHUrl,
        rulesLoaded: stats.rulesLoaded,
        protectionEnabled: dnsServer.isProtectionEnabled(),
        uptimeSeconds: stats.uptimeSeconds,
        stats: {
          totalQueries: stats.totalQueries,
          blockedQueries: stats.blockedQueries,
          allowedQueries: stats.allowedQueries,
          blockRatePercent: stats.totalQueries > 0
            ? Math.round((stats.blockedQueries / stats.totalQueries) * 1000) / 10
            : 0,
        },
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    if (pathname === '/v1/stats' || pathname === '/stats') {
      const stats = dnsServer.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }

    if ((pathname === '/v1/reload' || pathname === '/reload') && req.method === 'POST') {
      console.log('[Daemon] Reload triggered via Control API...');
      const loadedCount = await loadRulesFromFeeds(trie, config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Reloaded ${loadedCount} rules`, rulesLoaded: loadedCount }));
      return;
    }

    if ((pathname === '/v1/toggle' || pathname === '/toggle') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let enable = !dnsServer.isProtectionEnabled();
        try {
          if (body) {
            const parsed = JSON.parse(body);
            if (typeof parsed.enabled === 'boolean') {
              enable = parsed.enabled;
            }
          }
        } catch {
          // ignore JSON parse error, toggle instead
        }

        dnsServer.setProtection(enable);
        console.log(`[Daemon] Protection set to: ${enable ? 'ENABLED' : 'PAUSED'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, protectionEnabled: enable }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  controlServer.listen(config.controlPort, config.bindHost, () => {
    console.log(`[Daemon] Control API listening on http://${config.bindHost}:${config.controlPort}`);
  });

  const shutdown = async () => {
    console.log('\n[Daemon] Gracefully stopping system daemon...');
    await dnsServer.stop();
    controlServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { dnsServer, controlServer, trie };
}

// Auto-start if invoked directly
if (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('blockingmachine-daemon.js')) {
  startDaemon().catch((err) => {
    console.error('[Daemon] Fatal startup failure:', err);
    process.exit(1);
  });
}
