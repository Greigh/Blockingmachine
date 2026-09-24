import fetch from 'node-fetch';

/**
 * Encrypted DNS-over-HTTPS (DoH) Forwarder
 * Forwards allowed domain lookups to upstream secure resolvers.
 */
export class DohForwarder {
  private dohUrl: string;

  constructor(dohUrl: string = 'https://dns.quad9.net/dns-query') {
    this.dohUrl = dohUrl;
  }

  async resolvePacket(rawDnsPacket: Buffer): Promise<Buffer | null> {
    try {
      const response = await fetch(this.dohUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/dns-message',
          Accept: 'application/dns-message'
        },
        body: rawDnsPacket
      });

      if (!response.ok) {
        throw new Error(`Upstream DoH error: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.warn('[DohForwarder] Upstream query failed:', err);
      return null;
    }
  }
}
