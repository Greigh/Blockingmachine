/*
 * splice.h — platform-agnostic core of the Blockingmachine transparent-
 * capture helper daemons (docs/https-filtering-p3-plan.md, Task 1).
 *
 * Every platform helper shares one contract: accept a redirected TCP
 * flow, recover its ORIGINAL destination (platform-specific), stamp one
 * PROXY-protocol v2 STREAM header (signature, ver/cmd 0x21, AF_INET 0x11
 * / AF_INET6 0x21 — the byte layout the engine parser in
 * src/proxy/proxyProtocol.ts is tested against), then splice the flow
 * onto the engine's data listener, half-close-aware, payload never
 * inspected. This header pins the shared pieces; the platform file owns
 * accept(), the origdst lookup, and its own concurrency model (fork on
 * POSIX, threads on Windows — the cap counter below is shared).
 *
 * The socket abstraction is deliberately minimal — bm_sock_t plus a
 * handful of macros/functions mapping poll(2) vs WSAPoll, close vs
 * closesocket, errno vs WSAGetLastError — just enough for the shared
 * code to stay C11 + libc (ws2_32 on Windows). It is NOT a general
 * sockets portability layer; anything the abstraction doesn't cover
 * lives in the platform file.
 *
 * API surface consumed by the platform helpers (the linux
 * redirect-helper codes against this file — keep signatures stable):
 *
 *   bm_proxy_v2_format / _format_ss / _emit  PROXY-v2 frame emit
 *   bm_ss_addr_port                          sockaddr_storage → addr+port
 *   bm_splice(fd_a, fd_b)                    full-duplex, half-close-aware
 *   bm_connect_tcp(host, port)               bounded engine dial
 *   bm_write_all(fd, buf, n)                 EINTR-safe full write
 *   bm_sock_read / bm_sock_write / bm_sock_close / bm_sock_err
 *   bm_set_nonblocking / bm_listen_on        listener + flag plumbing
 *   bm_children_full / bm_child_spawned /
 *   bm_child_reaped                          connection-cap counter
 *   bm_track_pid / bm_reap_children /
 *   bm_kill_tracked_children                 POSIX child registry
 *   bm_watchdog_init / bm_watchdog_tick /
 *   bm_watchdog_loop                         engine-liveness watchdog
 *   bm_flow_cfg / bm_handle_connection /
 *   bm_origdst_fn                            per-flow lifecycle
 *   bm_parse_test_dst / bm_test_dst_from_env BM_HELPER_TEST_DST seam
 *   bm_logf / bm_vlogf / bm_log_set_tag /
 *   bm_verbose                               structured stderr logging
 *   bm_parse_port / bm_hex_encode / bm_sleep_ms
 */

#ifndef BM_SPLICE_H
#define BM_SPLICE_H

#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
/* WSAPoll + inet_pton floor; the helpers themselves require Win10+. */
#define _WIN32_WINNT 0x0602
#endif
#include <winsock2.h>
#include <ws2ipdef.h>
#include <ws2tcpip.h>

typedef SOCKET bm_sock_t;
#define BM_SOCK_INVALID INVALID_SOCKET
typedef int bm_socklen_t;
typedef int bm_ssize_t;
typedef WSAPOLLFD bm_pollfd_t;

#define bm_sock_close closesocket
#define bm_sock_err() WSAGetLastError()
#define bm_sock_err_set(e) WSASetLastError(e)
#define bm_poll WSAPoll
#define bm_shutdown_w(fd) shutdown((fd), SD_SEND)

#define BM_SOCK_EINTR WSAEINTR

#else /* POSIX */

#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

typedef int bm_sock_t;
#define BM_SOCK_INVALID (-1)
typedef socklen_t bm_socklen_t;
typedef ssize_t bm_ssize_t;
typedef struct pollfd bm_pollfd_t;

#define bm_sock_close close
#define bm_sock_err() errno
#define bm_sock_err_set(e) (errno = (e))
#define bm_poll poll
#define bm_shutdown_w(fd) shutdown((fd), SHUT_WR)

#define BM_SOCK_EINTR EINTR

#endif

/* sockaddr_*:sin_len exists only on the BSDs — set it where it exists. */
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || \
    defined(__OpenBSD__) || defined(__DragonFly__)
#define BM_SOCKADDR_HAS_LEN 1
#endif

#define BM_SPLICE_BUF_SIZE (64u * 1024u)
#define BM_WATCHDOG_TICK_MS 2000u /* probe cadence */
#define BM_WATCHDOG_GRACE_S 10u   /* boot grace before probing starts */
#define BM_WATCHDOG_FAILS 3u      /* consecutive failures before on_dead */
#define BM_CONNECT_TIMEOUT_MS                                            \
  2000u /* engine dial bound — an unblocked connect can sit ~75 s        \
         * behind a full listen backlog and stall the watchdog */
#define BM_MAX_CHILDREN                                                  \
  256u /* live connection handlers — over cap, accept-and-close so a     \
        * local conn flood can't fork/thread-bomb the daemon */
#define BM_CHILD_TRACK 512u /* shutdown-kill registry size (ring, POSIX) */

/* ------------------------------------------------------------------ */
/* Structured stderr logging — tag-prefixed, one line per event;       */
/* ports/address-families only, never payload bytes or hostnames.      */
/* ------------------------------------------------------------------ */

extern int bm_verbose; /* set by the platform file's -v flag */

/* Default "[helper]" — platform mains call this once (e.g. "[natlook]"). */
void bm_log_set_tag(const char *tag);
void bm_logf(const char *fmt, ...);
void bm_vlogf(const char *fmt, ...); /* emits only when bm_verbose */

/* ------------------------------------------------------------------ */
/* Socket primitives                                                   */
/* ------------------------------------------------------------------ */

bm_ssize_t bm_sock_read(bm_sock_t fd, void *buf, size_t n);
bm_ssize_t bm_sock_write(bm_sock_t fd, const void *buf, size_t n);
int bm_set_nonblocking(bm_sock_t fd, int on); /* fcntl O_NONBLOCK / FIONBIO */

/* Nonblocking-listening socket on `sa` (SO_REUSEADDR on POSIX only —
 * Windows reuses are a hijack surface and are not needed to rebind a
 * listen port). Returns BM_SOCK_INVALID on failure. The platform file
 * may keep its own identical binder (natlook does — pinned by its
 * source-invariant tests).
 *
 * Accepted-socket contract: the listener's nonblocking flag is NOT
 * portable to accepted fds — POSIX clears it, Winsock inherits it. All
 * three acceptors therefore call bm_set_nonblocking(cfd, 0) right after
 * accept(); bm_write_all/bm_splice assume a blocking fd downstream. */
bm_sock_t bm_listen_on(const struct sockaddr *sa, int slen);

/*
 * Bounded connect: a blocking connect() can sit ~75 s behind a full
 * listen backlog before the kernel gives up — long enough to stall the
 * watchdog's probe cadence (and to park a flow handler on a wedged
 * engine). Nonblocking connect + poll(SO_ERROR) caps the wait at
 * BM_CONNECT_TIMEOUT_MS; the fd is returned to BLOCKING mode before
 * handoff because bm_write_all assumes it (a nonblocking write could
 * EAGAIN mid-body). Returns BM_SOCK_INVALID on failure.
 */
bm_sock_t bm_connect_tcp(const char *host, uint16_t port);

int bm_write_all(bm_sock_t fd, const uint8_t *buf, size_t n); /* 0 or -1 */

/*
 * Full-duplex splice. Each direction ends on read-EOF (peer FIN) →
 * shutdown(WR) on the other fd so the peer sees its own EOF; hard
 * errors tear the whole flow down. POLLHUP rides the read path — after
 * HUP, reads drain any buffered bytes then report EOF like a FIN.
 * Blocks until both directions are half-closed or torn down. No payload
 * content is ever inspected or logged.
 */
void bm_splice(bm_sock_t fd_a, bm_sock_t fd_b);

/* ------------------------------------------------------------------ */
/* PROXY protocol v2 emit — byte-exact per HAProxy spec:               */
/*   sig 0d0a0d0a000d0a515549540a | ver/cmd 0x21 | fam 0x11|0x21 | len   */
/*   v4: src4 dst4 sport2 dport2 (len 12) · v6: src16 dst16 (len 36)     */
/*                                                                     */
/* Addresses travel as the in_addr/in6_addr union below; PORTS ARE     */
/* NETWORK BYTE ORDER — the frame copies their two bytes verbatim, so  */
/* callers pass sockaddr.sin_port / pf rdxport / WFP-record ports      */
/* straight through (no ntohs/htons round-trip).                       */
/* ------------------------------------------------------------------ */

typedef union bm_ip_addr {
  struct in_addr v4;
  struct in6_addr v6;
} bm_ip_addr;

/* Extract addr+port (network order) — returns AF_INET/AF_INET6 or -1. */
int bm_ss_addr_port(const struct sockaddr_storage *ss, bm_ip_addr *addr,
                    uint16_t *port_net);

/* Frame into `buf`; returns total bytes written (28 or 52) or -1. */
int bm_proxy_v2_format(uint8_t *buf, size_t cap, int family,
                       const bm_ip_addr *src_addr, uint16_t src_port_net,
                       const bm_ip_addr *dst_addr, uint16_t dst_port_net);

/* sockaddr_storage convenience form of the above (families must match). */
int bm_proxy_v2_format_ss(uint8_t *buf, size_t cap,
                          const struct sockaddr_storage *src,
                          const struct sockaddr_storage *dst);

/* Frame + blocking write_all onto `fd`; returns 0 or -1. */
int bm_proxy_v2_emit(bm_sock_t fd, int family, const bm_ip_addr *src_addr,
                     uint16_t src_port_net, const bm_ip_addr *dst_addr,
                     uint16_t dst_port_net);

/* ------------------------------------------------------------------ */
/* Connection-cap bookkeeping                                          */
/*                                                                     */
/* One shared counter: the platform's spawn path calls bm_child_spawned */
/* after a successful fork/CreateThread and bm_child_reaped when the    */
/* handler dies (SIGCHLD reaper / thread exit). bm_children_full gates   */
/* accept. POSIX files may keep a verbatim copy of this pattern instead  */
/* (natlook-helper does — its ring+reaper text is pinned by the source-  */
/* invariant suite); the POSIX registry below exists for helpers that    */
/* take the shared version.                                              */
/* ------------------------------------------------------------------ */

extern volatile sig_atomic_t bm_live_children;

int bm_children_full(void);   /* bm_live_children >= BM_MAX_CHILDREN */
void bm_child_spawned(void);  /* interlocked/atomic-safe increment */
void bm_child_reaped(void);   /* decrement, floored at 0 */

#ifndef _WIN32
/* POSIX child registry — the ring that lets a shutdown SIGTERM reach
 * live children only: reaped pids are zeroed so a kernel-recycled pid
 * can never catch a stale signal (and slot 0 is skipped — kill(0) would
 * hit our own process group). Call bm_reap_children from the SIGCHLD
 * handler; bm_kill_tracked_children on shutdown. */
void bm_track_pid(pid_t pid);
void bm_reap_children(void);
void bm_kill_tracked_children(void);
#endif

/* ------------------------------------------------------------------ */
/* Watchdog — engine-liveness probe → fail-open by construction        */
/*                                                                     */
/* bm_watchdog_tick is one probe step, designed to be called from the   */
/* acceptor's poll loop (the macOS shape). Grace window, tick-rate      */
/* limiting, consecutive-failure counting and success hysteresis all    */
/* live here; the PLATFORM owns what "engine dead" means via on_dead    */
/* (pf-anchor flush on macOS, session-close+exit on Windows, rule       */
/* flush on Linux) and any on_alive follow-up (post-reboot re-arm).     */
/* ------------------------------------------------------------------ */

typedef struct bm_watchdog bm_watchdog;
typedef void (*bm_watchdog_cb)(const bm_watchdog *wd);

struct bm_watchdog {
  const char *host;   /* probe target — "127.0.0.1" for the engine */
  uint16_t port;
  unsigned tick_ms;   /* cadence (default BM_WATCHDOG_TICK_MS) */
  unsigned grace_s;   /* post-start grace (default BM_WATCHDOG_GRACE_S) */
  unsigned fail_max;  /* dead threshold (default BM_WATCHDOG_FAILS) */
  bm_watchdog_cb on_alive; /* NULL ok — after each successful probe */
  bm_watchdog_cb on_dead;  /* NULL ok — every tick while fails>=fail_max */
  void *ctx;
  /* state — zeroed/seeded by bm_watchdog_init */
  time_t start;
  time_t last_probe;
  unsigned fails;
};

/* Defaults: BM_WATCHDOG_* constants + start=now. Set callbacks/ctx after. */
void bm_watchdog_init(bm_watchdog *wd, const char *host, uint16_t port);
void bm_watchdog_tick(bm_watchdog *wd);

/*
 * Blocking loop for platforms whose watchdog runs on its own thread
 * (Windows): probes 127.0.0.1:probe_port every interval_ms and calls
 * dead_cb on every tick once the failure threshold is crossed. Never
 * returns — dead_cb is expected to terminate the process (the Windows
 * design: close the WFP session then exit nonzero so SCM restarts it).
 */
void bm_watchdog_loop(uint16_t probe_port, bm_watchdog_cb dead_cb,
                      int interval_ms);

/* ------------------------------------------------------------------ */
/* Per-flow lifecycle — identical on every platform except origdst     */
/*                                                                     */
/* Flow: getpeername → test-dst override (env seam) ELSE origdst_cb →   */
/* family check → bm_proxy_v2 header → connect engine → write header →  */
/* bm_splice → close both. cfd is ALWAYS closed here.                   */
/* ------------------------------------------------------------------ */

/* Recover the original (pre-redirect) destination of an accepted flow;
 * 0 and a filled `out` on success. NULL cfg.origdst → only the test
 * seam can produce a destination. */
typedef int (*bm_origdst_fn)(bm_sock_t connfd, struct sockaddr_storage *out,
                             void *ctx);

typedef struct bm_flow_cfg {
  const char *engine_host;
  uint16_t engine_port;
  bm_origdst_fn origdst;
  void *origdst_ctx;
  /* BM_HELPER_TEST_DST=<v4>:<port> | [<v6>]:<port> — TEST-ONLY fixed
   * destination; when present the origdst mechanism is bypassed so the
   * v2-emit+splice path is exercisable without a redirector (never set
   * it on an installed service: every flow would claim the same dst). */
  struct sockaddr_storage test_dst;
  int have_test_dst;
} bm_flow_cfg;

void bm_handle_connection(bm_sock_t cfd, const bm_flow_cfg *cfg);

/* ------------------------------------------------------------------ */
/* Parse / misc helpers                                                */
/* ------------------------------------------------------------------ */

/* "<v4>:<port>" or "[<v6>]:<port>" → sockaddr_storage; 0 or -1. */
int bm_parse_test_dst(const char *text, struct sockaddr_storage *out);

/* bm_parse_test_dst(getenv("BM_HELPER_TEST_DST"), out) == 0 */
int bm_test_dst_from_env(struct sockaddr_storage *out);

uint16_t bm_parse_port(const char *s); /* 0 on malformed/out-of-range */

/* n bytes → 2n lowercase hex chars + NUL; `out` must hold 2n+1. */
void bm_hex_encode(const uint8_t *in, size_t n, char *out);

void bm_sleep_ms(unsigned ms); /* nanosleep / Sleep */

#endif /* BM_SPLICE_H */
