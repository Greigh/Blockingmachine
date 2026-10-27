/*
 * splice.c — shared capture-helper core (P3 Task 1). Extracted verbatim
 * from helper/macos/natlook-helper.c: PROXY-v2 emit, the bounded engine
 * dial, the poll-based full-duplex splice with half-close propagation,
 * the children-cap counter + POSIX child registry, the watchdog probe
 * loop shape, the per-flow lifecycle, the BM_HELPER_TEST_DST parse seam
 * and the tag-prefixed stderr logger. The platform file keeps accept()
 * and the origdst lookup — natlook-helper.c (pf DIOCNATLOOK),
 * redirect-helper.c (WFP redirect records), linux redirect-helper.c
 * (SO_ORIGINAL_DST).
 *
 * C11 + libc only; on _WIN32 the socket calls map onto ws2_32 (recv/send,
 * WSAPoll, ioctlsocket, closesocket) and the POSIX child registry compiles
 * out (Windows handlers are threads).
 */

#ifndef _WIN32
/* Feature-test macros — glibc hides the POSIX.1-2008 declarations this
 * TU uses (getaddrinfo/freeaddrinfo, sigaction, kill, nanosleep) behind
 * _POSIX_C_SOURCE, and BSD-flavoured defaults behind _DEFAULT_SOURCE;
 * darwin and musl expose them unconditionally. Pinned before the first
 * libc header so the TU compiles identically on glibc, musl, BSD and
 * darwin — the linux helper build and the golden-test compile both hit
 * this on glibc (found by the linux-capture rehearsal in a bookworm
 * container: implicit-declaration errors without it). */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE 1
#endif
#endif /* !_WIN32 */

#include "splice.h"

#ifdef _WIN32
/* windows.h after winsock2.h (splice.h): InterlockedIncrement, Sleep. */
#include <windows.h>
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/tcp.h>
#endif

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

static const char *g_tag = "[helper]";
int bm_verbose = 0;

void bm_log_set_tag(const char *tag) {
  if (tag != NULL)
    g_tag = tag;
}

void bm_logf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "%s ", g_tag);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
}

void bm_vlogf(const char *fmt, ...) {
  if (!bm_verbose)
    return;
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "%s ", g_tag);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
}

/* ------------------------------------------------------------------ */
/* Socket primitives                                                   */
/* ------------------------------------------------------------------ */

bm_ssize_t bm_sock_read(bm_sock_t fd, void *buf, size_t n) {
#ifdef _WIN32
  return (bm_ssize_t)recv(fd, (char *)buf, (int)n, 0);
#else
  return read(fd, buf, n);
#endif
}

bm_ssize_t bm_sock_write(bm_sock_t fd, const void *buf, size_t n) {
#ifdef _WIN32
  return (bm_ssize_t)send(fd, (const char *)buf, (int)n, 0);
#else
  return write(fd, buf, n);
#endif
}

int bm_set_nonblocking(bm_sock_t fd, int on) {
#ifdef _WIN32
  u_long mode = on ? 1u : 0u;
  return ioctlsocket(fd, FIONBIO, &mode) == 0 ? 0 : -1;
#else
  int fl = fcntl(fd, F_GETFL, 0);
  if (fl < 0)
    return -1;
  return fcntl(fd, F_SETFL, on ? (fl | O_NONBLOCK) : (fl & ~O_NONBLOCK));
#endif
}

bm_sock_t bm_listen_on(const struct sockaddr *sa, int slen) {
  bm_sock_t fd = socket(sa->sa_family, SOCK_STREAM, 0);
  if (fd == BM_SOCK_INVALID)
    return BM_SOCK_INVALID;
#ifndef _WIN32
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
#endif
  /* O_NONBLOCK on the LISTENER: a client that aborts between poll() and
   * accept() must not stall the acceptor inside a blocking accept — the
   * caller drains until EAGAIN/WSAEWOULDBLOCK. Accepted sockets keep
   * blocking semantics (the flag is not inherited). */
  if (bm_set_nonblocking(fd, 1) != 0 || bind(fd, sa, (bm_socklen_t)slen) != 0 ||
      listen(fd, 128) != 0) {
    bm_sock_close(fd);
    return BM_SOCK_INVALID;
  }
  return fd;
}

/* Nonblocking connect in progress? POSIX: EINPROGRESS; Winsock: WSAEWOULDBLOCK
 * (WSAEINPROGRESS is the 16-bit legacy code — accept both for safety). */
static int err_connect_inprogress(int e) {
#ifdef _WIN32
  return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS;
#else
  return e == EINPROGRESS;
#endif
}

bm_sock_t bm_connect_tcp(const char *host, uint16_t port) {
  char portstr[8];
  snprintf(portstr, sizeof(portstr), "%u", (unsigned)port);
  struct addrinfo hints, *res = NULL, *ai;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(host, portstr, &hints, &res) != 0)
    return BM_SOCK_INVALID;
  bm_sock_t fd = BM_SOCK_INVALID;
  for (ai = res; ai != NULL; ai = ai->ai_next) {
    fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd == BM_SOCK_INVALID)
      continue;
    if (bm_set_nonblocking(fd, 1) != 0) {
      bm_sock_close(fd);
      fd = BM_SOCK_INVALID;
      continue;
    }
    int ok = 0;
    if (connect(fd, ai->ai_addr, (bm_socklen_t)ai->ai_addrlen) == 0) {
      ok = 1;
    } else if (err_connect_inprogress(bm_sock_err())) {
      bm_pollfd_t pfd;
      pfd.fd = fd;
      pfd.events = POLLOUT;
      pfd.revents = 0;
      int prc;
      do {
        prc = bm_poll(&pfd, 1, (int)BM_CONNECT_TIMEOUT_MS);
      } while (prc < 0 && bm_sock_err() == BM_SOCK_EINTR);
      if (prc > 0) {
        /* SO_ERROR is authoritative — POLLOUT|POLLERR arrive alike. */
        int err = 0;
        bm_socklen_t elen = sizeof(err);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, (char *)&err, &elen) == 0 &&
            err == 0)
          ok = 1;
        else if (err != 0)
          bm_sock_err_set(err); /* keep vlogf's errno honest */
      }
    }
    if (ok && bm_set_nonblocking(fd, 0) == 0)
      break; /* connected, restored to blocking */
    bm_sock_close(fd);
    fd = BM_SOCK_INVALID;
  }
  freeaddrinfo(res);
  return fd;
}

int bm_write_all(bm_sock_t fd, const uint8_t *buf, size_t n) {
  size_t off = 0;
  while (off < n) {
    bm_ssize_t w = bm_sock_write(fd, buf + off, n - off);
    if (w < 0) {
      if (bm_sock_err() == BM_SOCK_EINTR)
        continue;
      return -1;
    }
    off += (size_t)w;
  }
  return 0;
}

void bm_splice(bm_sock_t fd_a, bm_sock_t fd_b) {
  uint8_t buf[BM_SPLICE_BUF_SIZE];
  int dir_open[2] = {1, 1}; /* [0] fd_a→fd_b, [1] fd_b→fd_a */
  bm_sock_t fds[2] = {fd_a, fd_b};

  while (dir_open[0] || dir_open[1]) {
    bm_pollfd_t pfd[2];
    pfd[0].fd = dir_open[0] ? fds[0] : BM_SOCK_INVALID;
    pfd[0].events = POLLIN;
    pfd[0].revents = 0;
    pfd[1].fd = dir_open[1] ? fds[1] : BM_SOCK_INVALID;
    pfd[1].events = POLLIN;
    pfd[1].revents = 0;
    int n = bm_poll(pfd, 2, -1);
    if (n < 0) {
      if (bm_sock_err() == BM_SOCK_EINTR)
        continue;
      break;
    }
    for (int i = 0; i < 2; i++) {
      int other = 1 - i;
      if (!dir_open[i] || pfd[i].fd == BM_SOCK_INVALID)
        continue;
      if (pfd[i].revents & (POLLERR | POLLNVAL)) {
        bm_shutdown_w(fds[other]);
        dir_open[i] = 0;
        continue;
      }
      if (pfd[i].revents & (POLLIN | POLLHUP)) {
        bm_ssize_t r = bm_sock_read(fds[i], buf, sizeof(buf));
        if (r > 0) {
          if (bm_write_all(fds[other], buf, (size_t)r) != 0) {
            /* Peer is gone mid-flow — both directions die together. */
            dir_open[0] = dir_open[1] = 0;
            break;
          }
        } else if (r == 0) {
          bm_shutdown_w(fds[other]);
          dir_open[i] = 0;
        } else if (bm_sock_err() == BM_SOCK_EINTR) {
          continue;
        } else {
          bm_shutdown_w(fds[other]);
          dir_open[i] = 0;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* PROXY protocol v2 emit                                              */
/* ------------------------------------------------------------------ */

int bm_ss_addr_port(const struct sockaddr_storage *ss, bm_ip_addr *addr,
                    uint16_t *port_net) {
  if (ss->ss_family == AF_INET) {
    const struct sockaddr_in *s = (const struct sockaddr_in *)ss;
    addr->v4 = s->sin_addr;
    *port_net = s->sin_port;
    return AF_INET;
  }
  if (ss->ss_family == AF_INET6) {
    const struct sockaddr_in6 *s = (const struct sockaddr_in6 *)ss;
    addr->v6 = s->sin6_addr;
    *port_net = s->sin6_port;
    return AF_INET6;
  }
  return -1;
}

int bm_proxy_v2_format(uint8_t *buf, size_t cap, int family,
                       const bm_ip_addr *src_addr, uint16_t src_port_net,
                       const bm_ip_addr *dst_addr, uint16_t dst_port_net) {
  static const uint8_t sig[12] = {0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d,
                                  0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a};
  uint16_t len;
  size_t total;
  uint8_t fam;
  if (family == AF_INET) {
    fam = 0x11;
    len = 12;
    total = 28;
  } else if (family == AF_INET6) {
    fam = 0x21;
    len = 36;
    total = 52;
  } else {
    return -1;
  }
  if (cap < total)
    return -1;
  buf[13] = fam;
  if (family == AF_INET) {
    memcpy(buf + 16, &src_addr->v4, 4);
    memcpy(buf + 20, &dst_addr->v4, 4);
    memcpy(buf + 24, &src_port_net, 2);
    memcpy(buf + 26, &dst_port_net, 2);
  } else {
    memcpy(buf + 16, &src_addr->v6, 16);
    memcpy(buf + 32, &dst_addr->v6, 16);
    memcpy(buf + 48, &src_port_net, 2);
    memcpy(buf + 50, &dst_port_net, 2);
  }
  memcpy(buf, sig, 12);
  buf[12] = 0x21; /* version 2, PROXY command */
  buf[14] = (uint8_t)(len >> 8);
  buf[15] = (uint8_t)(len & 0xff);
  return (int)total;
}

int bm_proxy_v2_format_ss(uint8_t *buf, size_t cap,
                          const struct sockaddr_storage *src,
                          const struct sockaddr_storage *dst) {
  if (src->ss_family != dst->ss_family)
    return -1;
  bm_ip_addr sa, da;
  uint16_t sp = 0, dp = 0;
  if (bm_ss_addr_port(src, &sa, &sp) < 0)
    return -1;
  if (bm_ss_addr_port(dst, &da, &dp) < 0)
    return -1;
  return bm_proxy_v2_format(buf, cap, (int)src->ss_family, &sa, sp, &da, dp);
}

int bm_proxy_v2_emit(bm_sock_t fd, int family, const bm_ip_addr *src_addr,
                     uint16_t src_port_net, const bm_ip_addr *dst_addr,
                     uint16_t dst_port_net) {
  uint8_t hdr[64];
  int hlen = bm_proxy_v2_format(hdr, sizeof(hdr), family, src_addr,
                                src_port_net, dst_addr, dst_port_net);
  if (hlen < 0)
    return -1;
  return bm_write_all(fd, hdr, (size_t)hlen);
}

/* ------------------------------------------------------------------ */
/* Connection-cap bookkeeping                                          */
/* ------------------------------------------------------------------ */

volatile sig_atomic_t bm_live_children = 0;

int bm_children_full(void) { return bm_live_children >= (sig_atomic_t)BM_MAX_CHILDREN; }

void bm_child_spawned(void) {
#ifdef _WIN32
  InterlockedIncrement((volatile LONG *)&bm_live_children);
#else
  bm_live_children++;
#endif
}

void bm_child_reaped(void) {
#ifdef _WIN32
  InterlockedDecrement((volatile LONG *)&bm_live_children);
#else
  if (bm_live_children > 0)
    bm_live_children--;
#endif
}

#ifndef _WIN32
/* The shutdown-kill registry — see the header block on why slots are
 * zeroed on reap (pid recycling must never catch a stale SIGTERM) and
 * why 0 is skipped (kill(0) hits our own process group). */
static pid_t g_tracked[BM_CHILD_TRACK];
static size_t g_tracked_len = 0;
static size_t g_tracked_next = 0;

void bm_track_pid(pid_t pid) {
  g_tracked[g_tracked_next] = pid;
  g_tracked_next = (g_tracked_next + 1) % BM_CHILD_TRACK;
  if (g_tracked_len < BM_CHILD_TRACK)
    g_tracked_len++;
}

void bm_reap_children(void) {
  pid_t p;
  while ((p = waitpid(-1, NULL, WNOHANG)) > 0) {
    for (size_t i = 0; i < g_tracked_len; i++)
      if (g_tracked[i] == p)
        g_tracked[i] = 0;
    bm_child_reaped();
  }
}

void bm_kill_tracked_children(void) {
  for (size_t i = 0; i < g_tracked_len; i++)
    if (g_tracked[i] > 0)
      kill(g_tracked[i], SIGTERM);
}
#endif

/* ------------------------------------------------------------------ */
/* Watchdog                                                            */
/* ------------------------------------------------------------------ */

void bm_watchdog_init(bm_watchdog *wd, const char *host, uint16_t port) {
  memset(wd, 0, sizeof(*wd));
  wd->host = host;
  wd->port = port;
  wd->tick_ms = BM_WATCHDOG_TICK_MS;
  wd->grace_s = BM_WATCHDOG_GRACE_S;
  wd->fail_max = BM_WATCHDOG_FAILS;
  wd->start = time(NULL);
}

void bm_watchdog_tick(bm_watchdog *wd) {
  time_t now = time(NULL);
  if (now - wd->start < (time_t)wd->grace_s)
    return; /* engine boot grace — a slow start must not read as dead */
  if (now - wd->last_probe < (time_t)(wd->tick_ms / 1000))
    return;
  wd->last_probe = now;

  bm_sock_t fd = bm_connect_tcp(wd->host, wd->port);
  if (fd != BM_SOCK_INVALID) {
    bm_sock_close(fd);
    if (wd->fails > 0)
      bm_vlogf("watchdog: engine reachable again");
    wd->fails = 0;
    if (wd->on_alive != NULL)
      wd->on_alive(wd);
    return;
  }
  wd->fails++;
  bm_vlogf("watchdog: engine probe failed (%u/%u)", wd->fails, wd->fail_max);
  if (wd->fails >= wd->fail_max && wd->on_dead != NULL)
    wd->on_dead(wd);
}

void bm_watchdog_loop(uint16_t probe_port, bm_watchdog_cb dead_cb,
                      int interval_ms) {
  bm_watchdog wd;
  bm_watchdog_init(&wd, "127.0.0.1", probe_port);
  if (interval_ms > 0)
    wd.tick_ms = (unsigned)interval_ms;
  wd.on_dead = dead_cb;
  for (;;) {
    bm_watchdog_tick(&wd);
    bm_sleep_ms(wd.tick_ms);
  }
}

/* ------------------------------------------------------------------ */
/* Per-flow lifecycle                                                  */
/* ------------------------------------------------------------------ */

void bm_handle_connection(bm_sock_t cfd, const bm_flow_cfg *cfg) {
  struct sockaddr_storage peer;
  bm_socklen_t plen = sizeof(peer);
  struct sockaddr_storage orig;
  int have_orig = 0;

  if (getpeername(cfd, (struct sockaddr *)&peer, &plen) != 0) {
    bm_vlogf("flow: getpeername failed errno=%d", bm_sock_err());
    bm_sock_close(cfd);
    return;
  }

  if (cfg->have_test_dst) {
    orig = cfg->test_dst;
    have_orig = 1;
  } else if (cfg->origdst != NULL &&
             cfg->origdst(cfd, &orig, cfg->origdst_ctx) == 0) {
    have_orig = 1;
  }

  if (!have_orig) {
    /* No state to look up (redirect rule torn mid-flow, non-redirected
     * conn, lookup API unavailable) — an honest close beats a guessed
     * destination. */
    bm_vlogf("flow: origdst lookup failed af=%d errno=%d — closing",
             peer.ss_family, bm_sock_err());
    bm_sock_close(cfd);
    return;
  }
  if (orig.ss_family != peer.ss_family) {
    /* PROXY v2 carries one family per frame — a mismatched test-dst. */
    bm_logf("flow: family mismatch client af=%d dst af=%d — closing",
            peer.ss_family, orig.ss_family);
    bm_sock_close(cfd);
    return;
  }

  bm_ip_addr src_addr, dst_addr;
  uint16_t src_port = 0, dst_port = 0;
  if (bm_ss_addr_port(&peer, &src_addr, &src_port) < 0 ||
      bm_ss_addr_port(&orig, &dst_addr, &dst_port) < 0) {
    bm_logf("flow: proxy-v2 emit failed af=%d", peer.ss_family);
    bm_sock_close(cfd);
    return;
  }

  bm_sock_t efd = bm_connect_tcp(cfg->engine_host, cfg->engine_port);
  if (efd == BM_SOCK_INVALID) {
    bm_vlogf("flow: engine connect failed errno=%d — closing", bm_sock_err());
    bm_sock_close(cfd);
    return;
  }
  if (bm_proxy_v2_emit(efd, (int)peer.ss_family, &src_addr, src_port, &dst_addr,
                       dst_port) != 0) {
    bm_vlogf("flow: header write failed errno=%d — closing", bm_sock_err());
    bm_sock_close(efd);
    bm_sock_close(cfd);
    return;
  }
  bm_vlogf("flow: splicing af=%d", peer.ss_family);
  bm_splice(cfd, efd);
  bm_sock_close(efd);
  bm_sock_close(cfd);
  bm_vlogf("flow: closed af=%d", peer.ss_family);
}

/* ------------------------------------------------------------------ */
/* BM_HELPER_TEST_DST — test-only fixed destination.                   */
/* ------------------------------------------------------------------ */

int bm_parse_test_dst(const char *text, struct sockaddr_storage *out) {
  char buf[128];
  const char *host, *port;
  memset(out, 0, sizeof(*out));

  if (text == NULL || text[0] == '\0' || strlen(text) >= sizeof(buf))
    return -1;
  strcpy(buf, text);

  if (buf[0] == '[') {
    /* [<v6>]:<port> */
    char *closeb = strchr(buf, ']');
    if (closeb == NULL || closeb[1] != ':')
      return -1;
    *closeb = '\0';
    host = buf + 1;
    port = closeb + 2;
  } else {
    char *colon = strrchr(buf, ':');
    if (colon == NULL)
      return -1;
    *colon = '\0';
    host = buf;
    port = colon + 1;
  }
  if (host[0] == '\0')
    return -1;

  char *end = NULL;
  unsigned long p = strtoul(port, &end, 10);
  if (end == port || *end != '\0' || p == 0 || p > 65535)
    return -1;

  struct sockaddr_in *sin = (struct sockaddr_in *)out;
  if (inet_pton(AF_INET, host, &sin->sin_addr) == 1) {
    sin->sin_family = AF_INET;
#ifdef BM_SOCKADDR_HAS_LEN
    sin->sin_len = sizeof(*sin);
#endif
    sin->sin_port = htons((uint16_t)p);
    return 0;
  }
  struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)out;
  if (inet_pton(AF_INET6, host, &sin6->sin6_addr) == 1) {
    sin6->sin6_family = AF_INET6;
#ifdef BM_SOCKADDR_HAS_LEN
    sin6->sin6_len = sizeof(*sin6);
#endif
    sin6->sin6_port = htons((uint16_t)p);
    return 0;
  }
  return -1;
}

int bm_test_dst_from_env(struct sockaddr_storage *out) {
  return bm_parse_test_dst(getenv("BM_HELPER_TEST_DST"), out) == 0;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

uint16_t bm_parse_port(const char *s) {
  char *end = NULL;
  unsigned long v = strtoul(s, &end, 10);
  if (end == s || *end != '\0' || v == 0 || v > 65535)
    return 0;
  return (uint16_t)v;
}

void bm_hex_encode(const uint8_t *in, size_t n, char *out) {
  static const char hexdig[] = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[i * 2] = hexdig[in[i] >> 4];
    out[i * 2 + 1] = hexdig[in[i] & 0x0f];
  }
  out[n * 2] = '\0';
}

void bm_sleep_ms(unsigned ms) {
#ifdef _WIN32
  Sleep((DWORD)ms);
#else
  struct timespec ts;
  ts.tv_sec = (time_t)(ms / 1000);
  ts.tv_nsec = (long)(ms % 1000) * 1000000L;
  nanosleep(&ts, NULL);
#endif
}
