/**
 * On-device DNS responder — the mobile counterpart of the desktop app's managed
 * daemon (`packages/system-daemon`'s DnsServer + DohForwarder, ported to RN):
 * a UDP listener that answers against the synced ruleset — A/AAAA sinkhole to
 * 0.0.0.0/::, other types NXDOMAIN — and forwards clean queries over DoH,
 * SERVFAILing rather than going silent when the upstream fails.
 *
 * Transport is `react-native-udp` (node:dgram can't run inside Hermes); the
 * wire codec is the same `dns-packet` the daemon uses. Foreground only — both
 * platforms suspend sockets when the app backgrounds. iOS owns :5353 via
 * mDNSResponder, so the default port is 15353.
 */

import { Buffer } from 'buffer';
import dgram from 'react-native-udp';
import dnsPacket from 'dns-packet';
import { isSafeLanEndpointUrl } from '@blockingmachine/core/urlSafety';
import { evaluateLocal } from './ruleset';

globalThis.Buffer ??= Buffer;

type UdpSocket = ReturnType<typeof dgram.createSocket>;
interface RemoteInfo {
  address: string;
  port: number;
}

export const LOCAL_DNS_PORT = 15353;
export const LOCAL_DNS_UPSTREAM = 'https://dns.quad9.net/dns-query';
const SINKHOLE_V4 = '0.0.0.0';
const SINKHOLE_V6 = '::';
const UPSTREAM_TIMEOUT_MS = 5000;
const MAX_IN_FLIGHT = 64;
const MAX_RESPONSE_BYTES = 128 * 1024;

export interface LocalDnsStatus {
  running: boolean;
  port: number;
  upstream: string;
  queries: number;
  blocked: number;
  forwarded: number;
  lastError: string | null;
}

let socket: UdpSocket | null = null;
let boundPort = LOCAL_DNS_PORT;
let upstreamUrl = LOCAL_DNS_UPSTREAM;
let inFlight = 0;
let lastError: string | null = null;
const counters = { queries: 0, blocked: 0, forwarded: 0 };
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

/** Re-render hook for the settings card — fires on every counter/state change. */
export function subscribeLocalDns(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function localDnsStatus(): LocalDnsStatus {
  return {
    running: socket !== null,
    port: boundPort,
    upstream: upstreamUrl,
    queries: counters.queries,
    blocked: counters.blocked,
    forwarded: counters.forwarded,
    lastError,
  };
}

function send(buf: Buffer, rinfo: RemoteInfo): void {
  socket?.send(buf, 0, buf.length, rinfo.port, rinfo.address, () => {});
}

/** DoH forward — ported from the daemon's DohForwarder (timeout + in-flight cap + body bound). Returns null on any failure; the caller answers SERVFAIL. */
async function resolveUpstream(raw: Buffer): Promise<Buffer | null> {
  if (inFlight >= MAX_IN_FLIGHT) return null;
  inFlight++;
  try {
    const res = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message' },
      body: new Uint8Array(raw),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESPONSE_BYTES) return null;
    return Buffer.from(bytes);
  } catch {
    return null;
  } finally {
    inFlight--;
  }
}

async function handleQuery(msg: Buffer, rinfo: RemoteInfo): Promise<void> {
  const decoded = dnsPacket.decode(msg);
  const question = decoded.questions?.[0];
  if (!question?.name) return;

  counters.queries++;
  const verdict = await evaluateLocal(question.name);
  if (verdict?.blocked) {
    counters.blocked++;
    // Same shape as the daemon: address records get a sinkhole answer, other
    // types get NXDOMAIN — a type-confused response reads as bogus to some resolvers.
    const isA = question.type === 'A';
    const isAaaa = question.type === 'AAAA';
    const out =
      isA || isAaaa
        ? dnsPacket.encode({
            type: 'response',
            id: decoded.id,
            flags: dnsPacket.AUTHORITATIVE_ANSWER,
            questions: decoded.questions,
            answers: [
              {
                name: question.name,
                type: isA ? 'A' : 'AAAA',
                class: 'IN',
                ttl: 60,
                data: isA ? SINKHOLE_V4 : SINKHOLE_V6,
              },
            ],
          })
        : dnsPacket.encode({
            type: 'response',
            id: decoded.id,
            // dns-packet encodes only `flags` — NXDOMAIN is rcode 3 in the low nibble.
            flags: dnsPacket.AUTHORITATIVE_ANSWER | 3,
            questions: decoded.questions,
            answers: [],
          });
    send(out, rinfo);
    emit();
    return;
  }

  counters.forwarded++;
  emit();
  const answer = await resolveUpstream(msg);
  if (answer) {
    send(answer, rinfo);
    return;
  }
  try {
    send(
      dnsPacket.encode({
        type: 'response',
        id: decoded.id,
        flags: dnsPacket.RECURSION_AVAILABLE | 2, // 2 = SERVFAIL
        questions: decoded.questions,
        answers: [],
      }),
      rinfo,
    );
  } catch {
    // Encoding a malformed inbound packet's echo can itself fail — drop it.
  }
}

export async function startLocalDns(opts?: { port?: number; upstream?: string }): Promise<void> {
  if (socket) return;
  const url = opts?.upstream ?? LOCAL_DNS_UPSTREAM;
  // Same policy the daemon applies to its upstream: a metadata/link-local
  // target is a config error, not a per-query SERVFAIL.
  const safety = isSafeLanEndpointUrl(url);
  if (!safety.isSafe) {
    throw new Error(`Upstream DoH URL rejected: ${safety.reason}`);
  }
  upstreamUrl = url;
  boundPort = opts?.port ?? LOCAL_DNS_PORT;
  lastError = null;

  const s = dgram.createSocket({ type: 'udp4', reusePort: true });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    s.once('error', (e) => {
      if (!settled) {
        settled = true;
        lastError = e instanceof Error ? e.message : String(e);
        emit();
        reject(e);
      }
    });
    s.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
      void handleQuery(msg, rinfo).catch(() => {});
    });
    s.bind(boundPort, '0.0.0.0', () => {
      settled = true;
      resolve();
    });
  });
  socket = s;
  emit();
}

export function stopLocalDns(): void {
  const s = socket;
  socket = null;
  if (s) {
    try {
      s.close();
    } catch {
      // Closing an unbound or already-closed socket is a no-op worth swallowing.
    }
  }
  emit();
}
