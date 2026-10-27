/*
 * redirect-helper — the Linux transparent-capture acceptor for the
 * Blockingmachine HTTPS filter (docs/https-filtering-p3-plan.md, P3
 * Task 2). The netfilter REDIRECT sibling of the macOS natlook-helper:
 * same accept → origdst → PROXY-v2 → engine-splice contract, built on
 * the SAME shared core (helper/common/splice.c) as the macOS helper and
 * the Windows WFP helper, so the wire bytes are byte-identical by
 * construction.
 *
 * Capture plane (pinned by the plan): bm-anchor.sh owns the rules —
 * either an nftables `table ip/ip6 blockingmachine_nat` whose output
 * chain does `tcp dport {80,443} redirect to :<helperPort>` (+ skuid
 * exemption + udp/443 QUIC suppression) or the iptables `-t nat OUTPUT
 * … REDIRECT` twins when nft is unavailable. REDIRECT rewrites the
 * packet's destination to loopback, so the flow arrives on this
 * listener with the ORIGINAL destination recoverable from conntrack:
 * getsockopt(fd, SOL_IP, SO_ORIGINAL_DST) for v4 accepts and
 * getsockopt(fd, SOL_IPV6, IP6T_SO_ORIGINAL_DST) for v6 — the direct
 * DIOCNATLOOK/SIO_QUERY_* analog. TPROXY was deliberately not chosen
 * (route rules + CAP_NET_ADMIN on the socket for zero gain here).
 *
 *   +---------------------------------------------------------------+
 *   | PORTABILITY NOTE — the origdst getsockopt is guarded by       |
 *   | __linux__ so this TU compiles on darwin for the --selftest    |
 *   | path (the splice + PROXY-v2 legs are exercised through        |
 *   | BM_HELPER_TEST_DST with the mechanism stubbed to ENOPROTOOPT; |
 *   | a non-test flow off-Linux fails closed). The constants        |
 *   | themselves are ABI-pinned netfilter values (both 80,          |
 *   | linux/netfilter_ipv4.h + linux/netfilter_ipv6/ip6_tables.h)   |
 *   | and are #ifndef-defined below rather than pulling kernel uapi |
 *   | headers — linux/in.h vs netinet/in.h coexistence is a glibc-  |
 *   | version lottery this file doesn't need to play.             |
 *   +---------------------------------------------------------------+
 *
 * Failure postures — asymmetric by design, mirroring natlook exactly:
 *   - ENGINE death is fail-OPEN: the watchdog (2s bounded probes, 3
 *     strikes, 10s boot grace — the shared bm_watchdog_* plumbing in the
 *     acceptor's poll loop) invokes `bm-anchor.sh flush-only`, which
 *     replays the recorded mechanism to remove exactly our rules —
 *     redirected flows stop arriving, traffic flows direct. A real
 *     flush vetoes same-process re-arm (a flapping engine must not
 *     oscillate rules); a helper restart or installer re-run is what
 *     restores capture.
 *   - HELPER death is fail-CLOSED: REDIRECT points at :<helperPort>
 *     whether or not a listener exists — a hard-killed helper leaves
 *     RSTs on the dead port until systemd Restart=always brings it back
 *     (there is no watchdog for the watcher; the unit is the recovery).
 *   - REBOOT drops the rules: nft/iptables state is per-boot while the
 *     units and the state file persist. The reboot re-arm is the
 *     blockingmachine-capture-rules.service oneshot (ExecStart=
 *     bm-anchor.sh load — the analog of reinstalling the anchor file);
 *     the helper's own startup re-arm is the belt below it — when the
 *     state file marks capture enabled but no rules are loaded, the
 *     first successful engine probe re-runs the installer's own arm
 *     sequence via the bm-anchor.sh installed beside this binary. The
 *     probe gate keeps a helper restart during engine-death from
 *     re-arming a blackhole; the pending arm is consumed by the first
 *     load and vetoed by a real flush — ≤1 rule-load per helper process.
 *
 *   argv:  redirect-helper <helperPort> <enginePort> [-v]
 *          redirect-helper --selftest <helperPort> <enginePort>
 *
 *   env:   BM_HELPER_TEST_DST=<v4>:<port> | [<v6>]:<port>
 *          TEST-ONLY escape hatch — when set, the connection handler
 *          skips the conntrack lookup entirely and uses this fixed
 *          original-destination, so the origdst→PROXY-v2→splice path is
 *          exercisable without netfilter rules, root, or nftables.
 *          Never set it in the installed unit: every flow would then
 *          claim the same fake destination. BM_HELPER_TEST_DST6
 *          likewise fixes the v6 selftest phase.
 *
 * stderr is structural only (accept/fork/origdst/watchdog/close events —
 * ports and address families, never payload bytes, never hostnames).
 */

#define _GNU_SOURCE /* accept4-free plain accept; dprintf, setenv */
#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#endif

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "../common/splice.h"

/* ------------------------------------------------------------------ */
/* Original-destination sockopts — ABI-pinned netfilter constants.     */
/*                                                                     */
/* SO_ORIGINAL_DST (linux/netfilter_ipv4.h) and IP6T_SO_ORIGINAL_DST   */
/* (linux/netfilter_ipv6/ip6_tables.h) are both 80 and have been since  */
/* netfilter's introduction — the getsockopt performs a conntrack       */
/* lookup on the accepted socket and returns the pre-NAT destination    */
/* as a sockaddr_in/sockaddr_in6. SOL_IP/SOL_IPV6 are the glibc/musl   */
/* IPPROTO-level numbers (0/41). We #ifndef-define rather than include  */
/* <linux/netfilter*.h> so this TU never touches the linux/in.h         */
/* coexistence problem, and so a darwin compile (selftest legs) sees   */
/* the same values.                                                    */
/* ------------------------------------------------------------------ */

#ifndef SOL_IP
#define SOL_IP 0
#endif
#ifndef SOL_IPV6
#define SOL_IPV6 41
#endif
#ifndef SO_ORIGINAL_DST
#define SO_ORIGINAL_DST 80 /* netfilter ipv4 conntrack orig-dst */
#endif
#ifndef IP6T_SO_ORIGINAL_DST
#define IP6T_SO_ORIGINAL_DST 80 /* netfilter ipv6 conntrack orig-dst */
#endif

#define TAG "[redirect]"
/* Written by bm-anchor.sh — presence marks capture administratively
 * enabled (the mechanism token ledger lives inside). */
#define STATE_FILE "/etc/blockingmachine-capture-linux.state"
/* The installed shared arm/flush script — the single implementation of
 * the rule mechanics; the helper invokes it for watchdog flushes and
 * startup re-arms so the nft/iptables logic lives in exactly one place. */
#define ANCHOR_SCRIPT "/usr/local/libexec/blockingmachine/bm-anchor.sh"
#define FLUSH_CMD "\"" ANCHOR_SCRIPT "\" flush-only >/dev/null 2>&1"
#define ARM_CMD "\"" ANCHOR_SCRIPT "\" load >/dev/null 2>&1"
/* Empty/absent rules → nonzero — the post-reboot or post-flush state. */
#define ANCHOR_QRY "\"" ANCHOR_SCRIPT "\" status >/dev/null 2>&1"

/* Watchdog cadence/grace/threshold and the engine-dial bound live in
 * splice.h — BM_WATCHDOG_TICK_MS / BM_WATCHDOG_GRACE_S /
 * BM_WATCHDOG_FAILS / BM_CONNECT_TIMEOUT_MS. The engine is always the
 * loopback data listener; only the ports are argv'd. */
#define ENGINE_HOST "127.0.0.1"

/* ------------------------------------------------------------------ */
/* SO_ORIGINAL_DST — original (pre-REDIRECT) destination               */
/*                                                                     */
/* The nat OUTPUT-chain REDIRECT created a conntrack entry recording    */
/* the flow's original destination; the sockopt looks it up on the      */
/* accepted socket. The listener family selects which lookup to ask     */
/* for — a v4 accept gets SOL_IP, a v6 accept SOL_IPV6. A lookup        */
/* failure (rule torn mid-flow, a non-redirected conn hitting our      */
/* listener, conntrack table full) returns -1 and bm_handle_connection  */
/* closes the flow honestly — fail-closed per conn, same as the mac.   */
/* ------------------------------------------------------------------ */

static int linux_origdst(bm_sock_t connfd, struct sockaddr_storage *out,
                         void *ctx) {
  (void)ctx;
#if defined(__linux__)
  struct sockaddr_storage self;
  socklen_t slen = sizeof(self);
  if (getsockname(connfd, (struct sockaddr *)&self, &slen) != 0)
    return -1;

  memset(out, 0, sizeof(*out));
  if (self.ss_family == AF_INET) {
    struct sockaddr_in *sin = (struct sockaddr_in *)out;
    socklen_t len = sizeof(*sin);
    if (getsockopt(connfd, SOL_IP, SO_ORIGINAL_DST, sin, &len) != 0)
      return -1;
    sin->sin_family = AF_INET;
    return 0;
  }
  if (self.ss_family == AF_INET6) {
    struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)out;
    socklen_t len = sizeof(*sin6);
    if (getsockopt(connfd, SOL_IPV6, IP6T_SO_ORIGINAL_DST, sin6, &len) != 0)
      return -1;
    sin6->sin6_family = AF_INET6;
    return 0;
  }
  errno = EPROTONOSUPPORT;
  return -1;
#else
  /* SO_ORIGINAL_DST is netfilter conntrack state — Linux-only by
   * construction. Off-Linux the file still compiles so --selftest
   * exercises the splice/v2 legs through BM_HELPER_TEST_DST; a real
   * (non-test) flow gets an honest -1 → close, never a guessed dst. */
  (void)connfd;
  (void)out;
  errno = ENOPROTOOPT;
  return -1;
#endif
}

/* ------------------------------------------------------------------ */
/* Watchdog — engine-liveness probe → one-shot rules flush             */
/*                                                                     */
/* The probe itself is shared (bm_watchdog_*); what lives here is the   */
/* Linux-specific half: WHAT "engine dead" means (bm-anchor.sh         */
/* flush-only) and the post-reboot re-arm gate on the alive path.       */
/* ------------------------------------------------------------------ */

static bm_watchdog g_wd;
static int g_rules_flushed = 0;
static int g_rearm_pending = 0; /* armed at startup; consumed/vetoed below */

/* 0 = our capture rules are currently loaded (bm-anchor.sh status
 * decides mechanism-aware — nft table presence, or the recorded
 * iptables -C probe). */
static int rules_are_loaded(void) { return system(ANCHOR_QRY) == 0; }

/* First-live-probe follow-up: consume the one-shot pending arm — at most
 * one rule load per helper process keeps the no-oscillation contract. */
static void on_engine_alive(const bm_watchdog *wd) {
  (void)wd;
  if (g_rearm_pending) {
    g_rearm_pending = 0;
    if (!rules_are_loaded()) {
      int rc = system(ARM_CMD);
      bm_logf("watchdog: state file marks capture enabled — rules re-armed "
              "via bm-anchor.sh (rc=%d)",
              rc);
    }
  }
}

/* Sustained engine death → fail-open: flush the rules once per dead
 * run; when the rules are already absent keep the hysteresis armed so
 * externally reloaded rules still get flushed on the next tick —
 * fail-open is a posture, not a one-time event. */
static void on_engine_dead(const bm_watchdog *wd) {
  if (rules_are_loaded()) {
    if (!g_rules_flushed) {
      /* A real flush also vetoes the startup re-arm — rules must not
       * bounce under a flapping engine. */
      g_rules_flushed = 1;
      g_rearm_pending = 0;
      int rc = system(FLUSH_CMD);
      bm_logf("watchdog: %u consecutive probe failures — flushed capture "
              "rules via bm-anchor.sh (rc=%d)",
              wd->fails, rc);
    }
  } else {
    /* Rules already absent (post-reboot, or our own earlier flush):
     * nothing to flush — and NOT a veto, so a late engine start can
     * still re-arm. */
    if (wd->fails == wd->fail_max)
      bm_logf("watchdog: %u consecutive probe failures — rules already "
              "absent, nothing to flush (fail-open holds)",
              wd->fails);
    g_rules_flushed = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Acceptor — fork-per-connection, shared child registry               */
/* ------------------------------------------------------------------ */

static int g_shutdown = 0;

static void on_sigterm(int sig) {
  (void)sig;
  g_shutdown = 1;
}

static void on_sigchld(int sig) {
  (void)sig;
  /* The shared reaper clears the tracked-pid ring AND decrements the
   * shared cap counter — a reaped pid is zeroed so a kernel-recycled
   * pid can never catch a stale shutdown SIGTERM. */
  bm_reap_children();
}

/* The real acceptor loop — shared by main() and the selftest fixture
 * (watchdog off there: the fixture owns its fake engine's lifecycle).
 * Returns on shutdown or fatal-listen failure. */
static int acceptor_loop(uint16_t helper_port, uint16_t engine_port,
                         int watchdog_enabled) {
  bm_flow_cfg flow;
  memset(&flow, 0, sizeof(flow));
  flow.engine_host = ENGINE_HOST;
  flow.engine_port = engine_port;
  flow.origdst = linux_origdst;
  flow.have_test_dst = bm_test_dst_from_env(&flow.test_dst);
  if (flow.have_test_dst)
    bm_vlogf("test-dst override active af=%d — SO_ORIGINAL_DST will not "
             "be touched",
             flow.test_dst.ss_family);

  struct sockaddr_in sin4;
  memset(&sin4, 0, sizeof(sin4));
  sin4.sin_family = AF_INET;
#ifdef BM_SOCKADDR_HAS_LEN
  sin4.sin_len = sizeof(sin4);
#endif
  sin4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  sin4.sin_port = htons(helper_port);
  bm_sock_t l4 = bm_listen_on((const struct sockaddr *)&sin4, sizeof(sin4));
  if (l4 == BM_SOCK_INVALID) {
    bm_logf("fatal: cannot bind 127.0.0.1:%u errno=%d",
            (unsigned)helper_port, bm_sock_err());
    return 1;
  }

  struct sockaddr_in6 sin6;
  memset(&sin6, 0, sizeof(sin6));
  sin6.sin6_family = AF_INET6;
#ifdef BM_SOCKADDR_HAS_LEN
  sin6.sin6_len = sizeof(sin6);
#endif
  sin6.sin6_addr = in6addr_loopback;
  sin6.sin6_port = htons(helper_port);
  bm_sock_t l6 = bm_listen_on((const struct sockaddr *)&sin6, sizeof(sin6));
  if (l6 == BM_SOCK_INVALID) {
    /* The v6 REDIRECT leg sends [::1] flows at this port whether or not
     * we listen — a warn-only posture would leave v6 clients RST'd while
     * v4 worked: asymmetric breakage. Die so systemd Restart=always
     * retries and the failure surfaces loudly. */
    bm_logf("fatal: cannot bind [::1]:%u errno=%d — v6 capture leg required",
            (unsigned)helper_port, bm_sock_err());
    bm_sock_close(l4);
    return 1;
  }

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_sigchld;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  sigaction(SIGCHLD, &sa, NULL);

  struct sigaction st;
  memset(&st, 0, sizeof(st));
  st.sa_handler = on_sigterm;
  sigemptyset(&st.sa_mask);
  st.sa_flags = 0; /* interrupt poll() so the loop notices g_shutdown */
  sigaction(SIGTERM, &st, NULL);
  sigaction(SIGINT, &st, NULL);
  sigaction(SIGHUP, &st, NULL);

  signal(SIGPIPE, SIG_IGN);

  /* Probe state starts counting from listen-ready — a slow engine boot
   * under the grace window must not read as a failure. */
  bm_watchdog_init(&g_wd, ENGINE_HOST, engine_port);
  g_wd.on_alive = on_engine_alive;
  g_wd.on_dead = on_engine_dead;
  bm_logf("listening on 127.0.0.1:%u + [::1] — engine %s:%u",
          (unsigned)helper_port, ENGINE_HOST, (unsigned)engine_port);

  /* Post-reboot re-arm (see the header block): arm the one-shot pending
   * flag when capture is administratively enabled but no rules are
   * loaded — the next successful engine probe performs the load. Probes
   * keep it pending across a slow engine boot; a real watchdog flush
   * vetoes it. */
  if (watchdog_enabled && access(STATE_FILE, F_OK) == 0 &&
      !rules_are_loaded()) {
    g_rearm_pending = 1;
    bm_logf("state file marks capture enabled but rules are absent — "
            "will re-arm on first live engine probe");
  }

  while (!g_shutdown) {
    bm_pollfd_t pfd[2];
    pfd[0].fd = l4;
    pfd[0].events = POLLIN;
    pfd[0].revents = 0;
    pfd[1].fd = l6;
    pfd[1].events = POLLIN;
    pfd[1].revents = 0;
    int n = bm_poll(pfd, 2, (int)BM_WATCHDOG_TICK_MS);
    if (n < 0) {
      if (bm_sock_err() == BM_SOCK_EINTR) {
        if (watchdog_enabled)
          bm_watchdog_tick(&g_wd);
        continue;
      }
      bm_logf("fatal: poll errno=%d", bm_sock_err());
      break;
    }
    if (n > 0) {
      for (int i = 0; i < 2; i++) {
        if (pfd[i].fd == BM_SOCK_INVALID || !(pfd[i].revents & POLLIN))
          continue;
        /* Nonblocking listeners: drain accepts until EAGAIN — a client
         * aborted between poll and accept must not stall the acceptor. */
        for (;;) {
          bm_sock_t cfd = accept(pfd[i].fd, NULL, NULL);
          if (cfd == BM_SOCK_INVALID) {
            int e = bm_sock_err();
            if (e == EINTR)
              continue;
            if (e == ECONNABORTED)
              continue; /* this pending conn died — more may be queued */
            if (e == EAGAIN)
              break;
            if (e == EMFILE || e == ENFILE) {
              bm_logf("accept: fd exhaustion errno=%d — pausing", e);
              bm_sleep_ms(200);
            } else {
              bm_logf("accept: errno=%d", e);
            }
            break;
          }
          /* Accepted-socket contract: pin BLOCKING before the flow
           * handoff — whether the listener's O_NONBLOCK carries over is
           * platform-defined (Winsock inherits, POSIX doesn't), so the
           * normalize is the contract, not a quirk. */
          if (bm_set_nonblocking(cfd, 0) != 0) {
            bm_sock_close(cfd);
            continue;
          }
          if (bm_children_full()) {
            /* Over cap: still accept (drain the backlog honestly rather
             * than leave clients in SYN limbo) but close immediately. */
            bm_vlogf("accept: child cap %u reached — closing conn",
                     (unsigned)BM_MAX_CHILDREN);
            bm_sock_close(cfd);
            continue;
          }
          /* Track under a blocked SIGCHLD: a child exiting before its
           * slot write would reap with nothing to clear and leave a
           * reusable stale pid for the shutdown-kill. */
          sigset_t chld, prev;
          sigemptyset(&chld);
          sigaddset(&chld, SIGCHLD);
          sigprocmask(SIG_BLOCK, &chld, &prev);
          pid_t pid = fork();
          if (pid == 0) {
            /* child: one connection, then die — a stalled splice can
             * never serialize the acceptor. Restore the signal mask and
             * default dispositions so the parent's shutdown-kill lands. */
            sigprocmask(SIG_SETMASK, &prev, NULL);
            signal(SIGTERM, SIG_DFL);
            signal(SIGINT, SIG_DFL);
            signal(SIGHUP, SIG_DFL);
            bm_sock_close(l4);
            bm_sock_close(l6);
            bm_handle_connection(cfd, &flow);
            _exit(0);
          }
          if (pid > 0) {
            bm_track_pid(pid);
            bm_child_spawned();
          }
          sigprocmask(SIG_SETMASK, &prev, NULL);
          if (pid < 0)
            bm_logf("accept: fork failed errno=%d", errno);
          bm_sock_close(cfd);
        }
      }
    }
    if (watchdog_enabled)
      bm_watchdog_tick(&g_wd);
  }

  /* Best-effort kill of in-flight splices — tracked slots are zeroed on
   * reap, so signalled pids are live children or unreaped zombies (both
   * safe; the shared registry never SIGTERMs a recycled pid or slot 0). */
  bm_kill_tracked_children();
  bm_sock_close(l4);
  bm_sock_close(l6);
  bm_logf("shutdown complete");
  return 0;
}

/* ------------------------------------------------------------------ */
/* --selftest: fake engine + real acceptor + loopback client            */
/*                                                                     */
/* Same fixture contract as natlook-helper's — exercises everything    */
/* except the conntrack lookup itself (the test-dst env seam fixes the  */
/* destination). Runs anywhere this TU compiles; on darwin it is the   */
/* ONLY way the file's legs are exercised (origdst is ENOPROTOOPT       */
/* there — see the portability note).                                  */
/* ------------------------------------------------------------------ */

/*
 * Fake engine (runs in a forked child): report "ready" on outfd once
 * listening (a real connection probe would consume the single accept),
 * accept ONE connection, read the complete v2 header (16 fixed bytes +
 * declared len), report it hex-encoded, echo all remaining bytes until
 * EOF, then close.
 */
static void fake_engine(uint16_t port, int outfd) {
  int lfd = -1;
  {
    char portstr[8];
    snprintf(portstr, sizeof(portstr), "%u", (unsigned)port);
    struct addrinfo hints, *res = NULL, *ai;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE;
    if (getaddrinfo(ENGINE_HOST, portstr, &hints, &res) == 0) {
      for (ai = res; ai != NULL; ai = ai->ai_next) {
        lfd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (lfd < 0)
          continue;
        int one = 1;
        setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        if (bind(lfd, ai->ai_addr, ai->ai_addrlen) == 0 &&
            listen(lfd, 8) == 0)
          break;
        close(lfd);
        lfd = -1;
      }
      freeaddrinfo(res);
    }
  }
  if (lfd < 0) {
    dprintf(outfd, "error=bind\n");
    _exit(3);
  }
  dprintf(outfd, "ready\n");

  int cfd = accept(lfd, NULL, NULL);
  if (cfd < 0)
    _exit(4);

  uint8_t hdr[64];
  size_t got = 0;
  while (got < 16) {
    ssize_t r = read(cfd, hdr + got, 16 - got);
    if (r <= 0)
      _exit(5);
    got += (size_t)r;
  }
  size_t want = 16 + ((size_t)hdr[14] << 8 | hdr[15]);
  if (want > sizeof(hdr))
    _exit(6);
  while (got < want) {
    ssize_t r = read(cfd, hdr + got, want - got);
    if (r <= 0)
      _exit(7);
    got += (size_t)r;
  }
  char hex[129];
  bm_hex_encode(hdr, want, hex);
  dprintf(outfd, "header=%s\n", hex);

  /* Echo until client EOF, then close — exercises both splice directions
   * and the half-close path. */
  uint8_t buf[8192];
  for (;;) {
    ssize_t r = read(cfd, buf, sizeof(buf));
    if (r == 0)
      break;
    if (r < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    if (bm_write_all(cfd, buf, (size_t)r) != 0)
      break;
  }
  close(cfd);
  close(lfd);
  _exit(0);
}

/* One line from the report pipe; "" on EOF/error. */
static void read_line(int fd, char *out, size_t cap) {
  size_t n = 0;
  while (n + 1 < cap) {
    char ch;
    ssize_t r = read(fd, &ch, 1);
    if (r <= 0)
      break;
    if (ch == '\n')
      break;
    out[n++] = ch;
  }
  out[n] = '\0';
}

/*
 * Loopback client (runs in the selftest parent): connect to the helper
 * (retrying past its bind race), stream a deterministic binary pattern,
 * half-close, read the echo until EOF, verify byte-identical. Prints the
 * client source port so the suite can reconstruct the expected v2 header.
 */
static int selftest_client(const struct sockaddr *addr, socklen_t alen,
                           size_t payload_len) {
  int fd = -1;
  for (int i = 0; i < 100; i++) {
    fd = socket(addr->sa_family, SOCK_STREAM, 0);
    if (fd < 0)
      return -1;
    if (connect(fd, addr, alen) == 0)
      break;
    close(fd);
    fd = -1;
    bm_sleep_ms(20);
  }
  if (fd < 0)
    return -1;

  struct sockaddr_storage self;
  socklen_t selflen = sizeof(self);
  if (getsockname(fd, (struct sockaddr *)&self, &selflen) != 0) {
    close(fd);
    return -1;
  }
  uint16_t cport = self.ss_family == AF_INET
                       ? ((struct sockaddr_in *)&self)->sin_port
                       : ((struct sockaddr_in6 *)&self)->sin6_port;

  uint8_t *pat = malloc(payload_len), *echo = malloc(payload_len);
  if (pat == NULL || echo == NULL)
    return -1;
  for (size_t i = 0; i < payload_len; i++)
    pat[i] = (uint8_t)(i * 31u + 7u);
  int ok = 0;
  if (bm_write_all(fd, pat, payload_len) == 0) {
    shutdown(fd, SHUT_WR);
    size_t got = 0;
    while (got < payload_len) {
      ssize_t r = read(fd, echo + got, payload_len - got);
      if (r <= 0)
        break;
      got += (size_t)r;
    }
    ok = (got == payload_len && memcmp(pat, echo, payload_len) == 0);
  }
  close(fd);
  free(pat);
  free(echo);
  printf("selftest: client_port=%u payload_bytes=%zu payload=%s\n",
         (unsigned)ntohs(cport), payload_len, ok ? "match" : "mismatch");
  fflush(stdout);
  return ok ? 0 : -1;
}

static int selftest_phase(int af, uint16_t helper_port, uint16_t engine_port,
                          const char *test_dst) {
  int pipefd[2];
  if (pipe(pipefd) != 0)
    return -1;

  /* Phase-scoped test-dst: set in the parent so the forked acceptor
   * inherits it (have_test_dst short-circuits the sockopt lookup). */
  setenv("BM_HELPER_TEST_DST", test_dst, 1);

  pid_t engine_pid = fork();
  if (engine_pid == 0) {
    close(pipefd[0]);
    fake_engine(engine_port, pipefd[1]);
  }
  pid_t helper_pid = fork();
  if (helper_pid == 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    _exit(acceptor_loop(helper_port, engine_port, 0));
  }
  close(pipefd[1]);

  int ok = 1;
  char line[256];
  read_line(pipefd[0], line, sizeof(line)); /* "ready" or "error=…" */
  if (strcmp(line, "ready") != 0) {
    bm_logf("selftest: fake engine never bound (%s)", line);
    ok = 0;
  }

  if (ok) {
    struct sockaddr_storage dst;
    socklen_t dlen;
    memset(&dst, 0, sizeof(dst));
    if (af == AF_INET) {
      struct sockaddr_in *s = (struct sockaddr_in *)&dst;
      s->sin_family = AF_INET;
#ifdef BM_SOCKADDR_HAS_LEN
      s->sin_len = sizeof(*s);
#endif
      s->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      s->sin_port = htons(helper_port);
      dlen = sizeof(*s);
    } else {
      struct sockaddr_in6 *s = (struct sockaddr_in6 *)&dst;
      s->sin6_family = AF_INET6;
#ifdef BM_SOCKADDR_HAS_LEN
      s->sin6_len = sizeof(*s);
#endif
      s->sin6_addr = in6addr_loopback;
      s->sin6_port = htons(helper_port);
      dlen = sizeof(*s);
    }
    if (selftest_client((const struct sockaddr *)&dst, dlen, 128 * 1024) != 0)
      ok = 0;
  }

  read_line(pipefd[0], line, sizeof(line)); /* "header=<hex>" or "" */
  close(pipefd[0]);
  if (strncmp(line, "header=", 7) == 0) {
    printf("selftest: af=%d dst=%s %s\n", af == AF_INET ? 4 : 6, test_dst,
           line);
  } else {
    ok = 0;
    bm_logf("selftest: engine reported no header");
  }
  fflush(stdout);

  int status = 0;
  waitpid(engine_pid, &status, 0);
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
    ok = 0;

  kill(helper_pid, SIGKILL);
  waitpid(helper_pid, &status, 0);
  unsetenv("BM_HELPER_TEST_DST");
  return ok ? 0 : -1;
}

static int run_selftest(uint16_t helper_port, uint16_t engine_port) {
  const char *dst4 = getenv("BM_HELPER_TEST_DST");
  const char *dst6 = getenv("BM_HELPER_TEST_DST6");
  char d4[96], d6[128];
  snprintf(d4, sizeof(d4), "%s", dst4 != NULL ? dst4 : "203.0.113.7:8443");
  snprintf(d6, sizeof(d6), "%s",
           dst6 != NULL ? dst6 : "[2001:db8::5]:443");

  int rc4 =
      selftest_phase(AF_INET, helper_port, engine_port, d4);
  int rc6 =
      selftest_phase(AF_INET6, helper_port, engine_port, d6);

  printf("selftest: %s\n", (rc4 == 0 && rc6 == 0) ? "PASS" : "FAIL");
  fflush(stdout);
  return (rc4 == 0 && rc6 == 0) ? 0 : 1;
}

/* ------------------------------------------------------------------ */

static void usage(FILE *out) {
  fprintf(out,
          "usage:\n"
          "  redirect-helper <helperPort> <enginePort> [-v]\n"
          "  redirect-helper --selftest <helperPort> <enginePort>\n");
}

int main(int argc, char **argv) {
  bm_log_set_tag(TAG);
  int selftest = 0;
  int argi = 1;
  if (argi < argc && strcmp(argv[argi], "--selftest") == 0) {
    selftest = 1;
    argi++;
  }
  if (argc - argi < 2 || argc - argi > 3) {
    usage(stderr);
    return 2;
  }
  uint16_t helper_port = bm_parse_port(argv[argi]);
  uint16_t engine_port = bm_parse_port(argv[argi + 1]);
  if (argc - argi == 3) {
    if (strcmp(argv[argi + 2], "-v") != 0) {
      usage(stderr);
      return 2;
    }
    bm_verbose = 1;
  }
  if (helper_port == 0 || engine_port == 0) {
    usage(stderr);
    return 2;
  }
  if (selftest)
    return run_selftest(helper_port, engine_port);
  return acceptor_loop(helper_port, engine_port, 1);
}
