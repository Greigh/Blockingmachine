import http from 'node:http';
import fetch from 'node-fetch';
import { DomainTrie } from './engine/domainTrie.js';
import { DnsServer } from './server/dnsServer.js';
import { DaemonConfig } from './types.js';

const defaultConfig: DaemonConfig = {
  bindHost: '127.0.0.1',
  dnsPort: process.env.DNS_PORT ? parseInt(process.env.DNS_PORT, 10) : 5353, // defaults to 5353 for rootless execution; port 53 with sudo
  controlPort: 9292,
  upstreamDoHUrl: 'https://dns.quad9.net/dns-query',
  sinkholeIpv4: '0.0.0.0',
  sinkholeIpv6: '::',
  feedUrl: process.env.FEED_URL || 'http://127.0.0.1:9191/rules.txt'
};

export async function startDaemon(config: DaemonConfig = defaultConfig) {
  const trie = new DomainTrie();

  // Load initial rules from local feed server
  try {
    console.log(`[Daemon] Fetching filter rules from ${config.feedUrl}...`);
    const res = await fetch(config.feedUrl);
    if (res.ok) {
      const text = await res.text();
      const lines = text.split('\n');
      for (const line of lines) {
        trie.addRule(line);
      }
      console.log(`[Daemon] Successfully ingested ${lines.length} rule lines into memory trie.`);
    } else {
      console.warn(`[Daemon] Feed server returned HTTP ${res.status}. Starting with baseline protection.`);
    }
  } catch (err) {
    console.warn(`[Daemon] Feed server unreachable at ${config.feedUrl}. Daemon active with fallback resolver.`);
  }

  // Add default baseline telemetry blocks
  trie.addRule('||doubleclick.net^');
  trie.addRule('||telemetry.tracker.io^');

  const dnsServer = new DnsServer(trie, config);
  await dnsServer.start();

  // HTTP Control API (127.0.0.1:9292)
  const controlServer = http.createServer((req, res) => {
    if (req.url === '/v1/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'running', port: config.dnsPort, upstream: config.upstreamDoHUrl }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
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
}

// Auto-start if invoked directly
if (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('blockingmachine-daemon.js')) {
  startDaemon().catch((err) => {
    console.error('[Daemon] Fatal startup failure:', err);
    process.exit(1);
  });
}
