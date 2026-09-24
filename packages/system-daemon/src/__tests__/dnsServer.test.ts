import { DnsServer } from '../server/dnsServer.js';
import { DomainTrie } from '../engine/domainTrie.js';
import { DaemonConfig } from '../types.js';

describe('DnsServer Telemetry & Protection Controls', () => {
  const config: DaemonConfig = {
    bindHost: '127.0.0.1',
    dnsPort: 5454, // non-standard port for test isolation
    controlPort: 9393,
    upstreamDoHUrl: 'https://dns.quad9.net/dns-query',
    sinkholeIpv4: '0.0.0.0',
    sinkholeIpv6: '::',
    feedUrl: 'http://127.0.0.1:9191/dns.txt',
  };

  test('initializes with protection enabled and empty stats', () => {
    const trie = new DomainTrie();
    trie.addRule('||malicious-tracking.com^');
    const server = new DnsServer(trie, config);

    expect(server.isProtectionEnabled()).toBe(true);
    const stats = server.getStats();
    expect(stats.totalQueries).toBe(0);
    expect(stats.blockedQueries).toBe(0);
    expect(stats.rulesLoaded).toBe(1);
    expect(stats.recentQueries).toEqual([]);
  });

  test('toggles protection on and off', () => {
    const trie = new DomainTrie();
    const server = new DnsServer(trie, config);

    server.setProtection(false);
    expect(server.isProtectionEnabled()).toBe(false);

    server.setProtection(true);
    expect(server.isProtectionEnabled()).toBe(true);
  });
});
