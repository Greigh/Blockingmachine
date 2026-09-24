import dgram from 'node:dgram';
import dnsPacket from 'dns-packet';
import { DomainTrie } from '../engine/domainTrie.js';
import { DohForwarder } from './dohForwarder.js';
import { DaemonConfig, DaemonStats, EvaluationResult, QueryTelemetryEntry } from '../types.js';

export class DnsServer {
  private socket: dgram.Socket;
  private trie: DomainTrie;
  private forwarder: DohForwarder;
  private config: DaemonConfig;
  private protectionEnabled = true;
  private totalQueries = 0;
  private blockedQueries = 0;
  private allowedQueries = 0;
  private recentQueries: QueryTelemetryEntry[] = [];
  private readonly maxRecentQueries = 50;
  private startTime = Date.now();

  constructor(trie: DomainTrie, config: DaemonConfig) {
    this.trie = trie;
    this.config = config;
    this.forwarder = new DohForwarder(config.upstreamDoHUrl);
    this.socket = dgram.createSocket('udp4');
  }

  setProtection(enabled: boolean): void {
    this.protectionEnabled = enabled;
  }

  isProtectionEnabled(): boolean {
    return this.protectionEnabled;
  }

  getTrie(): DomainTrie {
    return this.trie;
  }

  getStats(): DaemonStats {
    return {
      totalQueries: this.totalQueries,
      blockedQueries: this.blockedQueries,
      allowedQueries: this.allowedQueries,
      rulesLoaded: this.trie.getRuleCount(),
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      recentQueries: [...this.recentQueries],
    };
  }

  private recordQuery(domain: string, verdict: 'BLOCKED' | 'ALLOWED' | 'EXCEPTION', clientIp?: string, matchingRule?: string) {
    this.totalQueries++;
    if (verdict === 'BLOCKED') {
      this.blockedQueries++;
    } else {
      this.allowedQueries++;
    }

    this.recentQueries.unshift({
      domain,
      verdict,
      timestamp: new Date().toISOString(),
      clientIp,
      matchingRule,
    });

    if (this.recentQueries.length > this.maxRecentQueries) {
      this.recentQueries.pop();
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.on('error', (err) => {
        console.error('[DnsServer] Socket error:', err);
      });

      this.socket.on('message', async (msg, rinfo) => {
        try {
          const decoded = dnsPacket.decode(msg);
          const question = decoded.questions?.[0];

          if (!question || !question.name) return;

          const evaluation: EvaluationResult = this.protectionEnabled
            ? this.trie.evaluate(question.name)
            : { domain: question.name, verdict: 'ALLOWED' };

          this.recordQuery(question.name, evaluation.verdict, rinfo.address, evaluation.matchingRule);

          if (evaluation.verdict === 'BLOCKED') {
            // Sinkhole response (0.0.0.0 for A, :: for AAAA)
            const isAaaa = question.type === 'AAAA';
            const answer = isAaaa
              ? {
                  name: question.name,
                  type: 'AAAA' as const,
                  class: 'IN' as const,
                  ttl: 60,
                  data: this.config.sinkholeIpv6
                }
              : {
                  name: question.name,
                  type: 'A' as const,
                  class: 'IN' as const,
                  ttl: 60,
                  data: this.config.sinkholeIpv4
                };

            const responseBuffer = dnsPacket.encode({
              type: 'response',
              id: decoded.id,
              flags: dnsPacket.AUTHORITATIVE_ANSWER,
              questions: decoded.questions,
              answers: [answer]
            });

            this.socket.send(responseBuffer, rinfo.port, rinfo.address);
          } else {
            // Forward to upstream DoH resolver
            const upstreamAnswer = await this.forwarder.resolvePacket(msg);
            if (upstreamAnswer) {
              this.socket.send(upstreamAnswer, rinfo.port, rinfo.address);
            }
          }
        } catch (err) {
          console.warn('[DnsServer] Packet decode failed:', err);
        }
      });

      this.socket.bind(this.config.dnsPort, this.config.bindHost, () => {
        console.log(`[DnsServer] Listening on ${this.config.bindHost}:${this.config.dnsPort} (UDP)`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.close(() => resolve());
    });
  }
}
