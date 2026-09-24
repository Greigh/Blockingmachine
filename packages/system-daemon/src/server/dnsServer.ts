import dgram from 'node:dgram';
import dnsPacket from 'dns-packet';
import { DomainTrie } from '../engine/domainTrie.js';
import { DohForwarder } from './dohForwarder.js';
import { DaemonConfig } from '../types.js';

export class DnsServer {
  private socket: dgram.Socket;
  private trie: DomainTrie;
  private forwarder: DohForwarder;
  private config: DaemonConfig;

  constructor(trie: DomainTrie, config: DaemonConfig) {
    this.trie = trie;
    this.config = config;
    this.forwarder = new DohForwarder(config.upstreamDoHUrl);
    this.socket = dgram.createSocket('udp4');
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.on('error', (err) => {
        console.error('[DnsServer] Socket error:', err);
      });

      this.socket.on('message', async (msg, rinfo) => {
        try {
          const decoded = dnsPacket.decode(msg);
          const question = decoded.questions?.[0];

          if (!question || !question.name) return;

          const evaluation = this.trie.evaluate(question.name);

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
