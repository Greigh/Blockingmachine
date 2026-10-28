/**
 * Unit coverage for the on-device DNS responder. The socket and fetch layers
 * are faked — what matters is the wire behavior: sinkhole for blocked A/AAAA,
 * NXDOMAIN for blocked other types, upstream pass-through for clean names,
 * SERVFAIL when the upstream fails, and silence for malformed packets.
 */
import dnsPacket from 'dns-packet';

type MessageHandler = (msg: Buffer, rinfo: { address: string; port: number }) => void;

class MockSocket {
  static last: MockSocket | null = null;
  onMessage: MessageHandler | null = null;
  onError: ((e: Error) => void) | null = null;
  sent: { buf: Buffer; port: number; address: string }[] = [];
  bound: { port: number; address: string } | null = null;
  closed = false;

  constructor() {
    MockSocket.last = this;
  }
  once(ev: string, fn: (e: Error) => void) {
    if (ev === 'error') this.onError = fn;
    return this;
  }
  on(ev: string, fn: MessageHandler) {
    if (ev === 'message') this.onMessage = fn;
    return this;
  }
  bind(port: number, address: string, cb: () => void) {
    this.bound = { port, address };
    cb();
  }
  send(buf: Buffer, _o: number, _l: number, port: number, address: string, cb: () => void) {
    this.sent.push({ buf, port, address });
    cb();
  }
  close() {
    this.closed = true;
  }
}

const mockVerdict = jest.fn<Promise<{ blocked: boolean } | null>, [string]>();
jest.mock('react-native-udp', () => ({
  __esModule: true,
  default: { createSocket: () => new MockSocket() },
}));
jest.mock('../filter/ruleset', () => ({
  evaluateLocal: (name: string) => mockVerdict(name),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const localDns = () => require('../filter/localDns') as typeof import('../filter/localDns');

const queryPacket = (name: string, type: 'A' | 'AAAA' | 'TXT' = 'A') =>
  dnsPacket.encode({
    type: 'query',
    id: 0xbeef,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ name, type, class: 'IN' }],
  });

const RINFO = { address: '192.168.1.50', port: 53531 };

describe('localDns responder', () => {
  beforeEach(() => {
    jest.resetModules();
    MockSocket.last = null;
    mockVerdict.mockReset();
    (globalThis as { fetch?: unknown }).fetch = jest.fn();
  });

  it('rejects an unsafe upstream before binding', async () => {
    const m = localDns();
    await expect(m.startLocalDns({ upstream: 'http://169.254.169.254/latest' })).rejects.toThrow(
      /rejected|unsafe/i,
    );
    expect(MockSocket.last).toBeNull();
  });

  it('sinkholes a blocked A query with 0.0.0.0 and counts it', async () => {
    const m = localDns();
    mockVerdict.mockResolvedValue({ blocked: true });
    await m.startLocalDns();
    const sock = MockSocket.last!;
    sock.onMessage!(queryPacket('ads.example', 'A'), RINFO);
    await new Promise((r) => setImmediate(r));
    const out = dnsPacket.decode(sock.sent[0].buf);
    expect(out.id).toBe(0xbeef);
    expect(out.answers).toEqual([
      expect.objectContaining({ type: 'A', data: '0.0.0.0', name: 'ads.example' }),
    ]);
    expect(m.localDnsStatus().blocked).toBe(1);
  });

  it('sinkholes a blocked AAAA query with ::', async () => {
    const m = localDns();
    mockVerdict.mockResolvedValue({ blocked: true });
    await m.startLocalDns();
    const sock = MockSocket.last!;
    sock.onMessage!(queryPacket('ads.example', 'AAAA'), RINFO);
    await new Promise((r) => setImmediate(r));
    const out = dnsPacket.decode(sock.sent[0].buf);
    expect(out.answers).toEqual([expect.objectContaining({ type: 'AAAA', data: '::' })]);
  });

  it('answers NXDOMAIN for a blocked non-address query', async () => {
    const m = localDns();
    mockVerdict.mockResolvedValue({ blocked: true });
    await m.startLocalDns();
    const sock = MockSocket.last!;
    sock.onMessage!(queryPacket('ads.example', 'TXT'), RINFO);
    await new Promise((r) => setImmediate(r));
    const out = dnsPacket.decode(sock.sent[0].buf);
    expect(out.flags! & 0xf).toBe(3); // NXDOMAIN rcode
    expect(out.answers).toHaveLength(0);
  });

  it('forwards a clean query upstream and relays the answer', async () => {
    const m = localDns();
    mockVerdict.mockResolvedValue({ blocked: false });
    const upstreamAnswer = dnsPacket.encode({
      type: 'response',
      id: 0xbeef,
      flags: dnsPacket.AUTHORITATIVE_ANSWER,
      questions: [{ name: 'ok.example', type: 'A', class: 'IN' }],
      answers: [{ name: 'ok.example', type: 'A', class: 'IN', ttl: 300, data: '1.2.3.4' }],
    });
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => upstreamAnswer.buffer.slice(upstreamAnswer.byteOffset, upstreamAnswer.byteOffset + upstreamAnswer.byteLength),
    });
    await m.startLocalDns();
    const sock = MockSocket.last!;
    sock.onMessage!(queryPacket('ok.example', 'A'), RINFO);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fetch).toHaveBeenCalledWith(
      'https://dns.quad9.net/dns-query',
      expect.objectContaining({ method: 'POST' }),
    );
    const out = dnsPacket.decode(sock.sent[0].buf);
    expect(out.answers).toEqual([expect.objectContaining({ data: '1.2.3.4' })]);
    expect(m.localDnsStatus().forwarded).toBe(1);
  });

  it('answers SERVFAIL when the upstream fails', async () => {
    const m = localDns();
    mockVerdict.mockResolvedValue({ blocked: false });
    (fetch as jest.Mock).mockRejectedValue(new Error('timeout'));
    await m.startLocalDns();
    const sock = MockSocket.last!;
    sock.onMessage!(queryPacket('ok.example', 'A'), RINFO);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const out = dnsPacket.decode(sock.sent[0].buf);
    expect(out.flags! & 0xf).toBe(2); // SERVFAIL
  });

  it('drops a malformed packet without throwing', async () => {
    const m = localDns();
    await m.startLocalDns();
    const sock = MockSocket.last!;
    expect(() => sock.onMessage!(Buffer.from([0xde, 0xad, 0xbe]), RINFO)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(sock.sent).toHaveLength(0);
  });

  it('stop() closes the socket and flips status to not-running', async () => {
    const m = localDns();
    await m.startLocalDns();
    expect(m.localDnsStatus().running).toBe(true);
    m.stopLocalDns();
    expect(MockSocket.last!.closed).toBe(true);
    expect(m.localDnsStatus().running).toBe(false);
  });
});

