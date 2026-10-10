import dgram from 'node:dgram';
import dnsPacket from 'dns-packet';
import { DomainTrie } from '../engine/domainTrie.js';
import { DohForwarder } from './dohForwarder.js';
import { ObservationRecorder, summarizeAnswer } from './observationRecorder.js';
import { DaemonConfig, DaemonStats, DnsVerdict, EvaluationResult, QueryTelemetryEntry } from '../types.js';

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
  private recorder: ObservationRecorder | null;

  constructor(trie: DomainTrie, config: DaemonConfig) {
    this.trie = trie;
    this.config = config;
    this.forwarder = new DohForwarder(config.upstreamDoHUrl);
    this.recorder = config.observationsFile ? new ObservationRecorder(config.observationsFile) : null;
    // reuseAddr: the documented rootless port (5353) is also mDNS's, and every
    // multicast responder on the host — including this app's own bonjour-service
    // advertisement — holds *:5353 with reuse set. A plain bind would EADDRINUSE
    // on exactly the machine running the app. Unicast queries still land on the
    // most-specific binding (127.0.0.1 beats the wildcard), and an exact
    // addr:port duplicate still fails when the first socket never opted in.
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
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

  /**
   * Append the upstream side of an answered query to the observation stream — the
   * CNAME chain and response shape are the behavioural fields the plain-HTTP crawl
   * could not measure (ai-training flag 43). Fail-soft throughout: an undeodable
   * answer is still forwarded, and observation failures never block the response path.
   */
  private recordObservation(
    domain: string,
    qtype: string,
    verdict: DnsVerdict,
    upstreamAnswer: Buffer | null,
    queriedAt: number,
  ): void {
    if (!this.recorder) return;
    try {
      const base = {
        domain,
        observed_at: new Date(queriedAt).toISOString(),
        qtype: String(qtype),
        verdict,
        cname_depth: 0,
        latency_ms: Math.max(0, Date.now() - queriedAt),
      };
      if (!upstreamAnswer) {
        this.recorder.observe({ ...base, rcode: null, upstream_ok: false });
        return;
      }
      try {
        this.recorder.observe({ ...base, upstream_ok: true, ...summarizeAnswer(domain, upstreamAnswer) });
      } catch {
        // Upstream answered but the answer doesn't decode for summarizing — the bare
        // observed fact still beats no record.
        this.recorder.observe({ ...base, rcode: null, upstream_ok: true });
      }
    } catch (err) {
      console.warn('[DnsObservations] observe failed:', err);
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;
      this.socket.on('error', (err) => {
        console.error('[DnsServer] Socket error:', err);
        // A bind-time failure (EADDRINUSE) must fail startup — the promise hanging leaves
        // the daemon alive but never answering its control API or a single DNS query.
        if (!started) reject(err);
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
            // A blocked name never reaches upstream — the observation records the query
            // itself (verdict + qtype) so the label store still sees it was requested.
            this.recorder?.observe({
              domain: question.name,
              observed_at: new Date().toISOString(),
              qtype: String(question.type),
              verdict: evaluation.verdict,
              rcode: null,
              upstream_ok: false,
              cname_depth: 0,
            });
            // Sinkhole only the address-record types — answering an A record to an MX/TXT/ANY
            // query is a type-confused response some resolvers treat as bogus. Non-address
            // queries on a blocked name get NXDOMAIN: same outcome, honest shape.
            const isAaaa = question.type === 'AAAA';
            const isA = question.type === 'A';
            // dns-packet encodes only the `flags` field — the response code is its low
            // nibble, so NXDOMAIN/SERVFAIL go in as their IANA numbers, not names.
            const responseBuffer = isAaaa || isA
              ? dnsPacket.encode({
                  type: 'response',
                  id: decoded.id,
                  flags: dnsPacket.AUTHORITATIVE_ANSWER,
                  questions: decoded.questions,
                  answers: [
                    {
                      name: question.name,
                      type: isAaaa ? ('AAAA' as const) : ('A' as const),
                      class: 'IN' as const,
                      ttl: 60,
                      data: isAaaa ? this.config.sinkholeIpv6 : this.config.sinkholeIpv4,
                    },
                  ],
                })
              : dnsPacket.encode({
                  type: 'response',
                  id: decoded.id,
                  flags: dnsPacket.AUTHORITATIVE_ANSWER | 3, // 3 = NXDOMAIN
                  questions: decoded.questions,
                  answers: [],
                });

            this.socket.send(responseBuffer, rinfo.port, rinfo.address);
          } else {
            // Forward to upstream DoH resolver — a failed upstream answers SERVFAIL rather
            // than leaving the client to time out and retry-storm a dead resolver.
            const queriedAt = Date.now();
            const upstreamAnswer = await this.forwarder.resolvePacket(msg);
            if (upstreamAnswer) {
              this.recordObservation(question.name, question.type, evaluation.verdict, upstreamAnswer, queriedAt);
              this.socket.send(upstreamAnswer, rinfo.port, rinfo.address);
            } else {
              this.recordObservation(question.name, question.type, evaluation.verdict, null, queriedAt);
              try {
                const servfail = dnsPacket.encode({
                  type: 'response',
                  id: decoded.id,
                  flags: dnsPacket.RECURSION_AVAILABLE | 2, // 2 = SERVFAIL
                  questions: decoded.questions,
                  answers: [],
                });
                this.socket.send(servfail, rinfo.port, rinfo.address);
              } catch {
                // Response encoding of a malformed inbound packet can itself fail — drop it.
              }
            }
          }
        } catch (err) {
          console.warn('[DnsServer] Packet decode failed:', err);
        }
      });

      this.socket.bind(this.config.dnsPort, this.config.bindHost, () => {
        started = true;
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
