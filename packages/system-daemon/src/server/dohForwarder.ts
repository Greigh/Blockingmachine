import fetch from 'node-fetch';
import { isSafeLanEndpointUrl } from '@blockingmachine/core';

/**
 * Encrypted DNS-over-HTTPS (DoH) Forwarder
 * Forwards allowed domain lookups to upstream secure resolvers.
 *
 * Three guards keep a sick or hostile upstream from becoming a daemon failure:
 * a per-query timeout so a hung response cannot park a fetch forever, an
 * in-flight cap so a client retry-storm cannot stack unbounded upstream
 * requests on a dead resolver, and a body bound so a poisoned response cannot
 * grow daemon memory — a DNS wire message can never exceed 64 KiB. Redirects
 * are refused rather than followed: a POST that carries a raw DNS query must
 * not be re-aimed at a resolver the admin never configured.
 * `resolvePacket` answers null on failure — the caller encodes SERVFAIL, so
 * the client gets an answer instead of silence.
 */
export class DohForwarder {
  private dohUrl: string;
  private inFlight = 0;
  private static readonly TIMEOUT_MS = 5000;
  private static readonly MAX_RESPONSE_BYTES = 128 * 1024;
  static readonly MAX_IN_FLIGHT = 128;

  constructor(dohUrl: string = 'https://dns.quad9.net/dns-query') {
    // Loopback and RFC1918 upstreams are legitimate (local DoH proxies like
    // cloudflared or dnscrypt); link-local, metadata and unspecified targets
    // never are. A config that names one is a boot-time error, not a
    // query-time one — refuse to start rather than SERVFAIL every lookup.
    const safety = isSafeLanEndpointUrl(dohUrl);
    if (!safety.isSafe) {
      throw new Error(`Upstream DoH URL rejected by endpoint policy: ${safety.reason}`);
    }
    this.dohUrl = dohUrl;
  }

  /** Number of upstream requests currently open — surfaced for tests and diagnostics. */
  get pendingCount(): number {
    return this.inFlight;
  }

  async resolvePacket(rawDnsPacket: Buffer): Promise<Buffer | null> {
    if (this.inFlight >= DohForwarder.MAX_IN_FLIGHT) {
      console.warn('[DohForwarder] In-flight cap reached — dropping query rather than queueing on a saturated upstream.');
      return null;
    }
    this.inFlight++;
    try {
      const response = await fetch(this.dohUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/dns-message',
          Accept: 'application/dns-message'
        },
        body: rawDnsPacket,
        signal: AbortSignal.timeout(DohForwarder.TIMEOUT_MS),
        // The response cannot legitimately exceed a 64 KiB DNS wire message —
        // node-fetch aborts the body beyond the cap instead of buffering it all.
        size: DohForwarder.MAX_RESPONSE_BYTES,
        // A 3xx would re-aim the DNS query at a resolver the admin never
        // configured; !response.ok turns it into an honest SERVFAIL instead.
        redirect: 'manual'
      });

      if (!response.ok) {
        throw new Error(`Upstream DoH error: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.warn('[DohForwarder] Upstream query failed:', err);
      return null;
    } finally {
      this.inFlight--;
    }
  }
}
