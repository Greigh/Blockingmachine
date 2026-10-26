/**
 * HAProxy PROXY-protocol v2 (binary) header parser — design spec §5.2.
 *
 * Every platform capture helper splices redirected TCP flows onto the data
 * listener and tells the engine where each flow was *originally* headed by
 * prepending exactly one v2 header — so the engine needs this one parser and
 * never a `SO_ORIGINAL_DST` getsockopt. The wire shape:
 *
 *   bytes 0–11   signature  \r\n\r\n\x00\r\nQUIT\n
 *   byte 12      ver/cmd    high nibble must be 0x2; low nibble 0x01 = PROXY
 *   byte 13      fam/proto  high nibble family, low nibble transport
 *   bytes 14–15  len        big-endian address-block length
 *   bytes 16+    addresses  INET: src4 dst4 sport2 dport2 (12B)
 *                           INET6: src16 dst16 sport2 dport2 (36B) — TLVs may follow
 *
 * Only `PROXY` commands over TCP (`STREAM`) with INET/INET6 families are
 * routable here: a `LOCAL` frame carries no usable destination (the spec says
 * treat it as a direct connection — this listener only serves redirected
 * flows), and UDP/UNIX frames are not flows this proxy can carry. Anything
 * unrecognized returns null rather than a best-effort guess — a malformed
 * framing header is a helper bug, and an honest close beats a misrouted
 * socket.
 */

/** The 12-byte v2 signature, `\r\n\r\n\x00\r\nQUIT\n`. */
const V2_SIGNATURE = Buffer.from('\r\n\r\n\x00\r\nQUIT\n', 'latin1');
export const PROXY_V2_SIGNATURE_LENGTH = V2_SIGNATURE.length; // 12

/** Signature + ver/cmd + fam + len — the minimum a frame can occupy. */
const V2_FIXED_LENGTH = 16;

const CMD_PROXY = 0x01;
const FAM_INET_STREAM = 0x11;
const FAM_INET6_STREAM = 0x21;
const ADDR_LEN_V4 = 12;
const ADDR_LEN_V6 = 36;

export interface ProxyV2Target {
  dstHost: string;
  dstPort: number;
}

/**
 * How `buf` relates to the v2 signature — used by the dispatch loop to tell
 * "this is a v2 frame" from "this might still become one" from "it never was".
 */
export function matchProxyV2Signature(buf: Buffer): 'match' | 'partial' | 'none' {
  if (buf.length === 0) {
    return 'partial';
  }
  const n = Math.min(buf.length, PROXY_V2_SIGNATURE_LENGTH);
  if (!buf.subarray(0, n).equals(V2_SIGNATURE.subarray(0, n))) {
    return 'none';
  }
  return buf.length >= PROXY_V2_SIGNATURE_LENGTH ? 'match' : 'partial';
}

/**
 * Total bytes the complete v2 frame occupies — signature + fixed fields +
 * declared address length — or null while the fixed 16 bytes haven't arrived.
 */
export function proxyV2FrameLength(buf: Buffer): number | null {
  if (buf.length < V2_FIXED_LENGTH || matchProxyV2Signature(buf) === 'none') {
    return null;
  }
  return V2_FIXED_LENGTH + buf.readUInt16BE(14);
}

/**
 * Parse a complete v2 frame into the flow's original destination. `buf` must
 * hold at least the full frame ({@link proxyV2FrameLength}); trailing bytes —
 * e.g. a ClientHello the helper pipelined behind the header — are the
 * caller's to keep. Returns null on anything malformed or unroutable.
 */
export function parseProxyV2(buf: Buffer): ProxyV2Target | null {
  if (buf.length < V2_FIXED_LENGTH || matchProxyV2Signature(buf) !== 'match') {
    return null;
  }
  if (buf[12] >> 4 !== 0x02) {
    return null; // only version 2 is binary; v1 is a text line this rejects
  }
  if ((buf[12] & 0x0f) !== CMD_PROXY) {
    // LOCAL (0x00) and any future command carry no routable destination.
    return null;
  }
  const addrLen = buf.readUInt16BE(14);
  if (buf.length < V2_FIXED_LENGTH + addrLen) {
    return null;
  }
  const addr = buf.subarray(V2_FIXED_LENGTH, V2_FIXED_LENGTH + addrLen);

  let dstHost: string;
  let dstPort: number;
  if (buf[13] === FAM_INET_STREAM) {
    if (addr.length < ADDR_LEN_V4) {
      return null;
    }
    dstHost = `${addr[4]}.${addr[5]}.${addr[6]}.${addr[7]}`;
    dstPort = addr.readUInt16BE(10);
  } else if (buf[13] === FAM_INET6_STREAM) {
    if (addr.length < ADDR_LEN_V6) {
      return null;
    }
    const groups: string[] = [];
    for (let i = 0; i < 8; i++) {
      groups.push(addr.readUInt16BE(16 + i * 2).toString(16));
    }
    dstHost = groups.join(':');
    dstPort = addr.readUInt16BE(34);
  } else {
    // AF_UNIX, UNSPEC, DGRAM transports — not TCP flows this listener routes.
    return null;
  }
  if (dstPort === 0) {
    return null;
  }
  return { dstHost, dstPort };
}
