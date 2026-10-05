import fetch from 'node-fetch';

/**
 * Encrypted DNS-over-HTTPS (DoH) Forwarder
 * Forwards allowed domain lookups to upstream secure resolvers.
 *
 * Two guards keep a sick upstream from becoming a daemon failure: a per-query timeout so a
 * hung response cannot park a fetch forever, and an in-flight cap so a client retry-storm
 * cannot stack unbounded upstream requests on a dead resolver. `resolvePacket` answers null
 * on failure — the caller encodes SERVFAIL, so the client gets an answer instead of silence.
 */
export class DohForwarder {
  private dohUrl: string;
  private inFlight = 0;
  private static readonly TIMEOUT_MS = 5000;
  static readonly MAX_IN_FLIGHT = 128;

  constructor(dohUrl: string = 'https://dns.quad9.net/dns-query') {
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
        signal: AbortSignal.timeout(DohForwarder.TIMEOUT_MS)
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
