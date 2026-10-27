/**
 * ClientHello peek (design spec §5.2 — the SNI observe step).
 *
 * A transparent/spliced flow's first bytes decide everything downstream: is
 * this TLS, and if so, to which hostname? This module reads just enough of a
 * fresh socket to answer both, then hands **every consumed byte** back as
 * `head` so the caller can replay them into whichever socket takes the flow
 * over — a blind upstream, or a `TLSSocket` once Task 5 lands termination.
 * Nothing is swallowed: `head` is the complete byte stream observed.
 *
 * The peek is bounded three ways so it can never hang the listener:
 *  - `timeoutMs` — silence or a drip-fed record resolves with whatever arrived;
 *  - `MAX_PEEK_BYTES` — a peer flooding past the largest legal TLS record is
 *    declared done and left for the caller to drop or tunnel;
 *  - the first two bytes alone settle `isTls` for the common garbage case
 *    (a plain-HTTP request never starts `0x16 0x03`).
 *
 * SNI extraction is a byte-level walk of the first handshake record — no
 * `TLSSocket` wrapper, so nothing about the TLS stack consumes state here.
 */

import type net from 'node:net';

export interface ClientHelloPeek {
  /** Every byte read off the socket — replay these before splicing onward. */
  head: Buffer;
  /** The server_name extension, or null when absent/unparseable. */
  sni: string | null;
  /** First bytes look like a TLS handshake record (`0x16 0x03 xx`). */
  isTls: boolean;
}

const HANDSHAKE_CONTENT_TYPE = 0x16;
const TLS_MAJOR_VERSION = 0x03;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXTENSION_SERVER_NAME = 0x0000;
const SERVER_NAME_HOST_NAME = 0x00;

/**
 * TLS records cap at 2^14+2048 by spec; waiting past ~64 KiB means the peer is
 * streaming garbage, not writing a ClientHello — declare the peek done.
 */
const MAX_PEEK_BYTES = 64 * 1024;

/**
 * Whether `buf` holds the complete first handshake *message*. A ClientHello
 * larger than its first record's payload continues in following handshake
 * records — deciding `sni:null` on record 1 alone lets a fragmented hello
 * evade the verdict. Non-handshake records (CCS, alert) interleaved mid-hello
 * are skipped, not counted. Returns false while more bytes may still arrive.
 */
function handshakeComplete(buf: Buffer): boolean {
  if (buf.length < 9) {
    return false;
  }
  const total = 4 + buf.readUIntBE(6, 3); // handshake header + declared body
  let have = 0;
  let p = 0;
  while (have < total) {
    if (p + 5 > buf.length) {
      return false;
    }
    const len = buf.readUInt16BE(p + 3);
    if (buf.length < p + 5 + len) {
      return false; // the next record hasn't fully landed
    }
    if (buf[p] === HANDSHAKE_CONTENT_TYPE) {
      have += len;
    }
    p += 5 + len;
  }
  return true;
}

/**
 * Whether `buf` is decided yet: a single non-handshake first byte, or a
 * complete first record — extended to the complete first *handshake message*
 * when record 1 opens a ClientHello that overflows it — settles the peek;
 * anything shorter keeps waiting (still bounded by MAX_PEEK_BYTES/timeout).
 */
function isPeekComplete(buf: Buffer): boolean {
  if (buf.length === 0) {
    return false;
  }
  if (buf[0] !== HANDSHAKE_CONTENT_TYPE) {
    return true; // cannot be TLS — decided on byte zero
  }
  if (buf.length >= 2 && buf[1] !== TLS_MAJOR_VERSION) {
    return true;
  }
  if (buf.length >= MAX_PEEK_BYTES) {
    return true;
  }
  if (buf.length < 9) {
    return false;
  }
  const recordLength = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLength) {
    return false;
  }
  if (buf[5] === HANDSHAKE_CLIENT_HELLO) {
    return handshakeComplete(buf);
  }
  return true;
}

/**
 * Reassemble the first handshake message across TLS records: record 1's
 * payload, then each following handshake record's payload (non-handshake
 * records skipped). Returns null when record 1 doesn't open a ClientHello;
 * may return a *truncated* message when the buffer ends mid-flight — the
 * walker bounds-checks every read against it.
 */
function reassembleClientHello(buf: Buffer): Buffer | null {
  if (buf.length < 9 || buf[5] !== HANDSHAKE_CLIENT_HELLO) {
    return null;
  }
  const total = 4 + buf.readUIntBE(6, 3);
  const parts: Buffer[] = [];
  let have = 0;
  let p = 0;
  while (have < total && p + 5 <= buf.length) {
    const len = buf.readUInt16BE(p + 3);
    const end = Math.min(buf.length, p + 5 + len);
    if (buf[p] === HANDSHAKE_CONTENT_TYPE) {
      parts.push(buf.subarray(p + 5, end));
      have += end - (p + 5);
    }
    if (end < p + 5 + len) {
      break; // partial tail record — return what's assembled
    }
    p = end;
  }
  return Buffer.concat(parts);
}

/**
 * Byte-walk one TLS record into an SNI (or the absence of one). Every read is
 * bounds-checked so a torn record — partial capture, timeout mid-flight —
 * degrades to `sni: null` rather than throwing. `isTls` only reports the
 * record-level shape (handshake type `0x16`, major version `0x03`); a record
 * whose handshake message is not a ClientHello is still TLS, just without a
 * name to verdict on.
 */
function parseClientHello(buf: Buffer): { isTls: boolean; sni: string | null } {
  const none = { isTls: false, sni: null };
  if (buf.length < 2 || buf[0] !== HANDSHAKE_CONTENT_TYPE || buf[1] !== TLS_MAJOR_VERSION) {
    return none;
  }
  const tls = { isTls: true, sni: null };
  if (buf.length < 9) {
    return tls;
  }
  // Reassemble across continuation records — a fragmented hello's SNI can
  // live entirely in record 2+; record-1-only parsing silently evades it.
  const hs = reassembleClientHello(buf);
  if (hs === null) {
    return tls;
  }
  const handshakeEnd = Math.min(hs.length, 4 + hs.readUIntBE(1, 3));
  let p = 4;
  const has = (n: number): boolean => p + n <= handshakeEnd;

  // version(2) + random(32), then three length-prefixed fields.
  if (!has(34)) return tls;
  p += 34;
  if (!has(1)) return tls;
  const sessionIdLen = hs[p];
  p += 1;
  if (!has(sessionIdLen)) return tls;
  p += sessionIdLen;
  if (!has(2)) return tls;
  const cipherLen = hs.readUInt16BE(p);
  p += 2;
  if (!has(cipherLen)) return tls;
  p += cipherLen;
  if (!has(1)) return tls;
  const compressionLen = hs[p];
  p += 1;
  if (!has(compressionLen)) return tls;
  p += compressionLen;

  // Extension block: total u16, then type/u16 + len/u16 + data entries.
  if (!has(2)) return tls;
  const extEnd = Math.min(p + 2 + hs.readUInt16BE(p), handshakeEnd);
  p += 2;
  while (p + 4 <= extEnd) {
    const extType = hs.readUInt16BE(p);
    const extLen = hs.readUInt16BE(p + 2);
    const extData = p + 4;
    if (extData + extLen > extEnd) {
      break;
    }
    if (extType === EXTENSION_SERVER_NAME) {
      // server_name_list: u16 total, then entries of type/u8 + len/u16 + name.
      if (extLen < 2) break;
      let q = extData + 2;
      const listEnd = Math.min(extData + 2 + hs.readUInt16BE(extData), extData + extLen);
      while (q + 3 <= listEnd) {
        const nameType = hs[q];
        const nameLen = hs.readUInt16BE(q + 1);
        q += 3;
        if (q + nameLen > listEnd) {
          break;
        }
        if (nameType === SERVER_NAME_HOST_NAME) {
          return { isTls: true, sni: hs.toString('ascii', q, q + nameLen) };
        }
        q += nameLen;
      }
      return tls;
    }
    p = extData + extLen;
  }
  return tls;
}

/**
 * Package-internal collector: like {@link peekClientHello}, but `seed` carries
 * bytes an earlier dispatch stage already consumed, so the returned `head`
 * still covers the whole observed stream and the SNI parse sees byte zero.
 */
export function collectClientHello(
  socket: net.Socket,
  timeoutMs: number,
  seed: Buffer,
): Promise<ClientHelloPeek> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [seed];
    let buffered = seed.length;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', finish);
      socket.off('end', finish);
      socket.off('close', finish);
      const head = Buffer.concat(chunks);
      // Hand the socket back paused: the caller's next stage (a blind-tunnel
      // pipe, or Task 5's TLSSocket wrap — which pushes inside read()) may
      // attach a tick later, and a flowing-mode socket would drop the bytes.
      // finish() also runs on 'close'/'error', where the socket is gone.
      if (!socket.destroyed) {
        socket.pause();
      }
      resolve({ head, ...parseClientHello(head) });
    };

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      buffered += chunk.length;
      if (buffered > MAX_PEEK_BYTES || isPeekComplete(Buffer.concat(chunks))) {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    socket.on('data', onData);
    socket.once('error', finish);
    socket.once('end', finish);
    socket.once('close', finish);
    // Callers hand over a socket they may have paused to avoid dropping bytes
    // between listeners — attaching 'data' alone does not undo an explicit
    // pause(), so resume explicitly.
    socket.resume();
    // The seed alone may already settle it — a pipelined flow delivers its
    // whole ClientHello inside the dispatch buffer.
    if (isPeekComplete(seed)) {
      finish();
    }
  });
}

/**
 * Peek at a fresh connection's first bytes for `timeoutMs` at most. Resolves
 * on decision, timeout, or peer close — never rejects, never hangs; callers
 * inspect `isTls`/`sni`/`head` to pick the flow's path.
 */
export function peekClientHello(
  socket: net.Socket,
  timeoutMs: number,
): Promise<ClientHelloPeek> {
  return collectClientHello(socket, timeoutMs, Buffer.alloc(0));
}
