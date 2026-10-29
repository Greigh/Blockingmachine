/*
 * natlook-helper — the macOS transparent-capture acceptor for the
 * Blockingmachine HTTPS filter (design spec §5.8, P1 plan Task 2;
 * refactored onto helper/common/splice.c in P3 Task 1).
 *
 * The pf anchor route-to's local outbound tcp:{80,443} onto lo0 and rdr's
 * them to this listener. For each accepted flow the helper recovers the
 * ORIGINAL (pre-rdr) destination with the DIOCNATLOOK ioctl on /dev/pf,
 * stamps one PROXY-protocol v2 STREAM header (src = the real client, dst =
 * the original destination — the contract src/proxy/proxyProtocol.ts
 * parses), then splices the flow onto the engine's data listener at
 * engineHost:enginePort. One forked child per accepted connection: a
 * stalled splice can never serialize accept.
 *
 * Everything above the platform seam lives in helper/common/splice.c —
 * the v2 emit (bm_proxy_v2_*), the bounded engine dial (bm_connect_tcp,
 * BM_CONNECT_TIMEOUT_MS), the half-close-aware splice (bm_splice), the
 * probe loop shape (bm_watchdog_tick), the cap counter pattern and the
 * BM_HELPER_TEST_DST seam. What stays here is exactly the macOS-only
 * surface: /dev/pf + DIOCNATLOOK, the fork-per-connection acceptor with
 * its SIGCHLD registry, the pf-anchor flush/re-arm callouts via
 * system(), and the --selftest fixture.
 *
 * Fail-open watchdog (spec §7): the parent probes the engine port on a
 * ~2 s tick with a bounded connect; after three consecutive failures it
 * flushes the pf anchor — redirected flows stop arriving, new traffic
 * hits the real network. A 10 s grace window after start keeps a slow
 * engine boot from reading as a failure. The failure postures are
 * deliberately asymmetric (also documented in install-macos-capture.sh):
 * ENGINE death is fail-open (the anchor flush above); HELPER death no
 * longer RSTs flows — the plist declares :9295 under `Sockets.Listeners`,
 * so launchd owns the kernel listeners across process deaths: redirected
 * flows handshake into the accept backlog and the KeepAlive respawn
 * drains them (connect stall, not dead web — flag 102). bind_listener
 * stays for standalone/selftest runs. There is no watchdog for the
 * watcher; KeepAlive is the recovery path.
 *
 * Reboot re-arm: pf's rules AND enable state die at boot while the
 * plists and /etc/blockingmachine-capture.state persist — launchd
 * restarts both daemons over a capture that is administratively on but
 * silently inert. When the state file marks capture enabled but no
 * anchor is loaded, the first successful engine probe re-runs the
 * installer's own arm sequence via the pf-anchor.sh installed beside
 * this binary (a system() callout — the pfctl logic lives in exactly
 * one place). The probe gate keeps a helper restart during engine-death
 * from re-arming a blackhole; the pending arm is consumed by the first
 * load and vetoed by a real flush, so a flapping engine still sees ≤1
 * anchor load per helper process — the no-oscillation contract holds.
 *
 *   argv:  natlook-helper <helperPort> <engineHost> <enginePort> [-v]
 *          natlook-helper --selftest <helperPort> <engineHost> <enginePort>
 *
 *   env:   BM_HELPER_TEST_DST=<v4>:<port> | [<v6>]:<port>
 *          TEST-ONLY escape hatch — when set, the connection handler skips
 *          /dev/pf entirely and uses this fixed original-destination, so
 *          the natlook→PROXY-v2→splice path is exercisable without pf,
 *          root, or a loaded anchor. Never set it in the installed plist:
 *          every flow would then claim the same fake destination.
 *          BM_HELPER_TEST_DST6 likewise fixes the v6 selftest phase.
 *
 *   --selftest runs an in-process fixture: a fake engine listener that
 *   captures the header and echoes payload, the real acceptor loop, and a
 *   loopback client — one phase per address family — and prints
 *   `selftest: af=… dst=… header=<hex>` plus `selftest: client_port=…
 *   payload_bytes=… payload=<match|mismatch>` lines and a final
 *   `selftest: PASS|FAIL`. Used by helper.test.ts.
 *
 * stderr is structural only (accept/fork/natlook/watchdog/close events —
 * ports and address families, never payload bytes, never hostnames).
 */

#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

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
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <launch.h>

#include "../common/splice.h"

/*
 * pfvar.h is private — not in the macOS SDK. Prefer the real header when a
 * build environment has it on the include path; otherwise the vendored,
 * layout-verbatim fragment (see pfvar-fragment.h's provenance note).
 */
#if defined(__has_include)
#if __has_include(<net/pfvar.h>)
#include <net/pfvar.h>
#define BM_HAVE_SYSTEM_PFVAR 1
#endif
#endif
#ifndef BM_HAVE_SYSTEM_PFVAR
#include "pfvar-fragment.h"
#endif

/*
 * ABI guards — DIOCNATLOOK encodes sizeof(pfioc_natlook) in the ioctl
 * number; a layout drift changes the number and every lookup fails
 * ENOTTY. 84 = 4×16 (pf_addr) + 4×4 (pf_state_xport) + 4×1 (tail fields).
 */
_Static_assert(sizeof(struct pfioc_natlook) == 84, "pfioc_natlook layout drifted");
_Static_assert(sizeof(struct pf_addr) == 16, "pf_addr layout drifted");
_Static_assert(sizeof(union pf_state_xport) == 4, "pf_state_xport layout drifted");
_Static_assert(DIOCNATLOOK == 0xc0544417, "DIOCNATLOOK ioctl number drifted");

#define TAG "[natlook]"
#define PF_DEV "/dev/pf"
/* The anchor nests under the com.apple wildcard — the stock ruleset's only
 * attach point (see install-macos-capture.sh). This name must match. */
#define PF_ANCHOR "com.apple/com.blockingmachine"
/* Written by pf-anchor.sh — presence marks capture administratively
 * enabled (the install-time -E posture + token ledger live inside). */
#define STATE_FILE "/etc/blockingmachine-capture.state"
#define FLUSH_CMD "/sbin/pfctl -a " PF_ANCHOR " -F all >/dev/null 2>&1"
/* Empty output → no ruleset loaded under the anchor (post-reboot state). */
#define ANCHOR_QRY "/sbin/pfctl -a " PF_ANCHOR " -s rules 2>/dev/null | /usr/bin/grep -q ."
/* The installed shared arm script — identical sequence to the installer's
 * step 9 (anchor load + conditional -E + state-file bookkeeping). */
#define ARM_CMD "\"/Library/Application Support/Blockingmachine/pf-anchor.sh\" load >/dev/null 2>&1"

/* Watchdog cadence/grace/threshold and the engine-dial bound live in
 * splice.h — BM_WATCHDOG_TICK_MS / BM_WATCHDOG_GRACE_S /
 * BM_WATCHDOG_FAILS / BM_CONNECT_TIMEOUT_MS. The bounded-connect
 * mechanism itself moved to ../common/splice.c's bm_connect_tcp:
 * fcntl(fd, F_SETFL, fl | O_NONBLOCK)-style nonblocking connect +
 * poll(POLLOUT) + getsockopt(fd, SOL_SOCKET, SO_ERROR, …) — a wedged
 * engine can never park the watchdog ~75 s behind a full backlog. */
#define MAX_CHILDREN ((int)BM_MAX_CHILDREN) /* live forked splices —     \
                                        * over cap, accept-and-close so \
                                        * a local conn flood can't      \
                                        * fork-bomb the daemon */
#define CHILD_TRACK ((int)BM_CHILD_TRACK) /* shutdown-kill registry size \
                                           * (ring) */

/* ------------------------------------------------------------------ */
/* sockaddr <-> pf_addr helpers                                        */
/* ------------------------------------------------------------------ */

static void pf_addr_from_sa(struct pf_addr *out, const struct sockaddr *sa) {
  memset(out, 0, sizeof(*out));
  if (sa->sa_family == AF_INET) {
    out->v4addr = ((const struct sockaddr_in *)sa)->sin_addr;
  } else {
    out->v6addr = ((const struct sockaddr_in6 *)sa)->sin6_addr;
  }
}

static void sockaddr_from_pf(struct sockaddr_storage *out, sa_family_t af,
                             const struct pf_addr *addr, uint16_t port_net) {
  memset(out, 0, sizeof(*out));
  if (af == AF_INET) {
    struct sockaddr_in *sin = (struct sockaddr_in *)out;
    sin->sin_family = AF_INET;
    sin->sin_len = sizeof(*sin);
    sin->sin_addr = addr->v4addr;
    sin->sin_port = port_net;
  } else {
    struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)out;
    sin6->sin6_family = AF_INET6;
    sin6->sin6_len = sizeof(*sin6);
    sin6->sin6_addr = addr->v6addr;
    sin6->sin6_port = port_net;
  }
}

/* ------------------------------------------------------------------ */
/* DIOCNATLOOK — original (pre-rdr) destination of an accepted flow.    */
/*                                                                     */
/* The route-to+rdr-on-lo0 anchor creates the translated state on the   */
/* INBOUND leg, keyed lan=<rdr target> ext_lan=<client> gwy=<orig dst>. */
/* A PF_OUT lookup searches the lan_ext tree with lan=pnl->daddr and    */
/* ext_lan=pnl->saddr — so daddr is the accepted socket's LOCAL address */
/* (getsockname, the rdr target) and saddr its peer (getpeername, the   */
/* client). rdaddr/rdxport come back holding gwy: the original dst.     */
/* ------------------------------------------------------------------ */

static int natlook_original_dst(int connfd, struct sockaddr_storage *out) {
  struct sockaddr_storage peer, sock;
  socklen_t plen = sizeof(peer), slen = sizeof(sock);
  if (getpeername(connfd, (struct sockaddr *)&peer, &plen) != 0)
    return -1;
  if (getsockname(connfd, (struct sockaddr *)&sock, &slen) != 0)
    return -1;
  if (peer.ss_family != AF_INET && peer.ss_family != AF_INET6) {
    errno = EPROTONOSUPPORT;
    return -1;
  }

  int pffd = open(PF_DEV, O_RDWR | O_CLOEXEC);
  if (pffd < 0)
    return -1;

  struct pfioc_natlook pnl;
  memset(&pnl, 0, sizeof(pnl));
  pnl.direction = PF_OUT;
  pnl.af = peer.ss_family;
  pnl.proto = IPPROTO_TCP;
  pf_addr_from_sa(&pnl.saddr, (const struct sockaddr *)&peer);
  pf_addr_from_sa(&pnl.daddr, (const struct sockaddr *)&sock);
  if (peer.ss_family == AF_INET) {
    pnl.sxport.port = ((const struct sockaddr_in *)&peer)->sin_port;
    pnl.dxport.port = ((const struct sockaddr_in *)&sock)->sin_port;
  } else {
    pnl.sxport.port = ((const struct sockaddr_in6 *)&peer)->sin6_port;
    pnl.dxport.port = ((const struct sockaddr_in6 *)&sock)->sin6_port;
  }

  int rc = ioctl(pffd, DIOCNATLOOK, &pnl);
  int saved = errno;
  close(pffd);
  if (rc != 0) {
    errno = saved;
    return -1;
  }
  sockaddr_from_pf(out, (sa_family_t)pnl.af, &pnl.rdaddr, pnl.rdxport.port);
  return 0;
}

/* bm_origdst_fn adapter — the common flow handler calls through this so
 * the test-dst env seam stays first in line. */
static int natlook_origdst(bm_sock_t connfd, struct sockaddr_storage *out,
                           void *ctx) {
  (void)ctx;
  return natlook_original_dst(connfd, out);
}

/* ------------------------------------------------------------------ */
/* Watchdog — engine-liveness probe → one-shot anchor flush            */
/*                                                                     */
/* The probe itself is shared (bm_watchdog_*); what lives here is the   */
/* macOS-specific half: WHAT "engine dead" means (pfctl anchor flush)   */
/* and the post-reboot re-arm gate on the alive path.                   */
/* ------------------------------------------------------------------ */

static bm_watchdog g_wd;
static int g_anchor_flushed = 0;
static int g_rearm_pending = 0; /* armed at startup; consumed/vetoed below */

/* 0 = a ruleset is currently loaded under our anchor (empty pfctl output
 * means absent — the post-reboot state, or a consumed watchdog flush). */
static int anchor_is_loaded(void) { return system(ANCHOR_QRY) == 0; }

/* First-live-probe follow-up: consume the one-shot pending arm — at most
 * one anchor load per helper process keeps the no-oscillation contract. */
static void on_engine_alive(const bm_watchdog *wd) {
  (void)wd;
  if (g_rearm_pending) {
    g_rearm_pending = 0;
    if (!anchor_is_loaded()) {
      int rc = system(ARM_CMD);
      bm_logf("watchdog: state file marks capture enabled — anchor re-armed "
              "via pf-anchor.sh (rc=%d)",
              rc);
    }
  }
}

/* Sustained engine death → fail-open: flush the anchor once per dead
 * run; when the anchor is already absent keep the hysteresis armed so an
 * externally reloaded anchor still gets flushed on the next tick —
 * fail-open is a posture, not a one-time event. */
static void on_engine_dead(const bm_watchdog *wd) {
  if (anchor_is_loaded()) {
    if (!g_anchor_flushed) {
      /* A real flush also vetoes the startup re-arm — rules must not
       * bounce under a flapping engine. */
      g_anchor_flushed = 1;
      g_rearm_pending = 0;
      int rc = system(FLUSH_CMD);
      bm_logf("watchdog: %u consecutive probe failures — flushed pf anchor "
              "(rc=%d)",
              wd->fails, rc);
    }
  } else {
    /* Anchor already absent (post-reboot, or our own earlier flush):
     * nothing to flush — and NOT a veto, so a late engine start can
     * still re-arm. */
    if (wd->fails == wd->fail_max)
      bm_logf("watchdog: %u consecutive probe failures — anchor already "
              "absent, nothing to flush (fail-open holds)",
              wd->fails);
    g_anchor_flushed = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Acceptor                                                            */
/* ------------------------------------------------------------------ */

static int g_shutdown = 0;
static volatile sig_atomic_t g_live_children = 0; /* MAX_CHILDREN gate */
static pid_t g_children[CHILD_TRACK];
static size_t g_children_len = 0;
static size_t g_children_next = 0;

static void track_child(pid_t pid) {
  g_children[g_children_next] = pid;
  g_children_next = (g_children_next + 1) % CHILD_TRACK;
  if (g_children_len < CHILD_TRACK)
    g_children_len++;
}

static void on_sigterm(int sig) {
  (void)sig;
  g_shutdown = 1;
}

static void on_sigchld(int sig) {
  (void)sig;
  pid_t p;
  while ((p = waitpid(-1, NULL, WNOHANG)) > 0) {
    /* Clear every slot holding the reaped pid: a reaped pid can be
     * recycled by the kernel to an unrelated process, and the
     * shutdown-kill must never SIGTERM one of those. Slots still holding
     * a pid are live children (or unreaped zombies — they keep their pid
     * and ignore SIGTERM), never recycled ones. */
    for (size_t i = 0; i < g_children_len; i++)
      if (g_children[i] == p)
        g_children[i] = 0;
    if (g_live_children > 0)
      g_live_children--;
  }
}

/* launchd socket activation: when the plist declares `Sockets.Listeners`,
 * launchd — not this process — owns the :9295 listeners, so a hard kill
 * leaves the kernel sockets alive: redirected flows complete the handshake
 * into the accept backlog and the KeepAlive respawn drains them instead of
 * RSTing (helper death degrades to a connect stall, not dead web — flag
 * 102). Returns -1 when not launched with that socket declared (standalone
 * and --selftest runs fall back to bind_listener); on success *v4 gets the
 * AF_INET fd and *v6 the AF_INET6 fd, each normalised to O_NONBLOCK for
 * the drain-until-EAGAIN acceptor contract — activation fds arrive in
 * launchd's mode, which is blocking. */
static int activated_listeners(int *v4, int *v6) {
  int *fds = NULL;
  size_t n = 0;
  if (launch_activate_socket("Listeners", &fds, &n) != 0 || fds == NULL)
    return -1;
  int got4 = -1, got6 = -1;
  for (size_t i = 0; i < n; i++) {
    struct sockaddr_storage ss;
    socklen_t slen = sizeof(ss);
    if (fds[i] < 0 ||
        getsockname(fds[i], (struct sockaddr *)&ss, &slen) != 0) {
      if (fds[i] >= 0)
        close(fds[i]);
      continue;
    }
    if (ss.ss_family == AF_INET && got4 < 0)
      got4 = fds[i];
    else if (ss.ss_family == AF_INET6 && got6 < 0)
      got6 = fds[i];
    else
      close(fds[i]); /* dup or unrecognised — ours to close, launchd keeps its own */
  }
  free(fds);
  if (got4 < 0 || got6 < 0) {
    if (got4 >= 0)
      close(got4);
    if (got6 >= 0)
      close(got6);
    return -1;
  }
  int fl4 = fcntl(got4, F_GETFL, 0);
  int fl6 = fcntl(got6, F_GETFL, 0);
  if (fl4 < 0 || fl6 < 0 ||
      fcntl(got4, F_SETFL, fl4 | O_NONBLOCK) != 0 ||
      fcntl(got6, F_SETFL, fl6 | O_NONBLOCK) != 0) {
    close(got4);
    close(got6);
    return -1;
  }
  *v4 = got4;
  *v6 = got6;
  return 0;
}

static int bind_listener(const struct sockaddr *sa, socklen_t slen) {
  int fd = socket(sa->sa_family, SOCK_STREAM, 0);
  if (fd < 0)
    return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  /* O_NONBLOCK on the LISTENER: a client that aborts between poll() and
   * accept() must not stall the acceptor inside a blocking accept — the
   * drain loop below stops at EAGAIN instead. The ACCEPTED socket is
   * normalized back to blocking right after accept() — inheritance of
   * the flag is platform-defined (POSIX clears it, Winsock doesn't), so
   * the normalize call is the shared contract, not a BSD claim. */
  int fl = fcntl(fd, F_GETFL, 0);
  if (fl < 0 || fcntl(fd, F_SETFL, fl | O_NONBLOCK) != 0 ||
      bind(fd, sa, slen) != 0 || listen(fd, 128) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

/* The real acceptor loop — shared by main() and the selftest fixture
 * (watchdog off there: the fixture owns its fake engine's lifecycle).
 * Returns on shutdown or fatal-listen failure. */
static int acceptor_loop(uint16_t helper_port, const char *engine_host,
                         uint16_t engine_port, int watchdog_enabled) {
  bm_flow_cfg flow;
  memset(&flow, 0, sizeof(flow));
  flow.engine_host = engine_host;
  flow.engine_port = engine_port;
  flow.origdst = natlook_origdst;
  flow.have_test_dst = bm_test_dst_from_env(&flow.test_dst);
  if (flow.have_test_dst)
    bm_vlogf("test-dst override active af=%d — /dev/pf will not be touched",
             flow.test_dst.ss_family);

  struct sockaddr_in sin4;
  memset(&sin4, 0, sizeof(sin4));
  sin4.sin_family = AF_INET;
  sin4.sin_len = sizeof(sin4);
  sin4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  sin4.sin_port = htons(helper_port);
  int l4 = -1, l6 = -1;
  const bool activated = activated_listeners(&l4, &l6) == 0;
  if (!activated) {
    int b4 = bind_listener((const struct sockaddr *)&sin4, sizeof(sin4));
    if (b4 < 0) {
      bm_logf("fatal: cannot bind 127.0.0.1:%u errno=%d", (unsigned)helper_port,
              errno);
      return 1;
    }
    l4 = b4;
  }

  struct sockaddr_in6 sin6;
  memset(&sin6, 0, sizeof(sin6));
  sin6.sin6_family = AF_INET6;
  sin6.sin6_len = sizeof(sin6);
  sin6.sin6_addr = in6addr_loopback;
  sin6.sin6_port = htons(helper_port);
  if (!activated) {
    int b6 = bind_listener((const struct sockaddr *)&sin6, sizeof(sin6));
    if (b6 < 0) {
      /* The anchor's inet6 rdr sends [::1] flows at this port whether or
       * not we listen — a warn-only posture would leave v6 clients RST'd
       * while v4 worked: asymmetric breakage. Die so launchd KeepAlive
       * retries and the failure surfaces loudly. */
      bm_logf("fatal: cannot bind [::1]:%u errno=%d — v6 capture leg required",
              (unsigned)helper_port, errno);
      close(l4);
      return 1;
    }
    l6 = b6;
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
  bm_watchdog_init(&g_wd, engine_host, engine_port);
  g_wd.on_alive = on_engine_alive;
  g_wd.on_dead = on_engine_dead;
  bm_logf("listening on 127.0.0.1:%u + [::1] %s— engine %s:%u",
          (unsigned)helper_port,
          activated ? "(launchd-held sockets) " : "",
          engine_host, (unsigned)engine_port);

  /* Post-reboot re-arm (see the header block): arm the one-shot pending
   * flag when capture is administratively enabled but pf has no rules —
   * the next successful engine probe performs the load. Probes keep it
   * pending across a slow engine boot; a real watchdog flush vetoes it. */
  if (watchdog_enabled && access(STATE_FILE, F_OK) == 0 && !anchor_is_loaded()) {
    g_rearm_pending = 1;
    bm_logf("state file marks capture enabled but anchor is absent — "
            "will re-arm on first live engine probe");
  }

  while (!g_shutdown) {
    struct pollfd pfd[2];
    pfd[0].fd = l4;
    pfd[0].events = POLLIN;
    pfd[0].revents = 0;
    pfd[1].fd = l6;
    pfd[1].events = POLLIN;
    pfd[1].revents = 0;
    int n = poll(pfd, 2, (int)BM_WATCHDOG_TICK_MS);
    if (n < 0) {
      if (errno == EINTR) {
        if (watchdog_enabled)
          bm_watchdog_tick(&g_wd);
        continue;
      }
      bm_logf("fatal: poll errno=%d", errno);
      break;
    }
    if (n > 0) {
      for (int i = 0; i < 2; i++) {
        if (pfd[i].fd < 0 || !(pfd[i].revents & POLLIN))
          continue;
        /* Nonblocking listeners: drain accepts until EAGAIN — a client
         * aborted between poll and accept must not stall the acceptor. */
        for (;;) {
          int cfd = accept(pfd[i].fd, NULL, NULL);
          if (cfd < 0) {
            if (errno == EINTR)
              continue;
            if (errno == ECONNABORTED)
              continue; /* this pending conn died — more may be queued */
            if (errno == EAGAIN)
              break;
            if (errno == EMFILE || errno == ENFILE) {
              bm_logf("accept: fd exhaustion errno=%d — pausing", errno);
              usleep(200000);
            } else {
              bm_logf("accept: errno=%d", errno);
            }
            break;
          }
          /* Accepted-socket contract: pin BLOCKING before the flow
           * handoff — whether the listener's O_NONBLOCK carries over is
           * platform-defined (Winsock inherits, POSIX doesn't), so the
           * normalize is the contract, not a quirk. */
          if (bm_set_nonblocking(cfd, 0) != 0) {
            close(cfd);
            continue;
          }
          if (g_live_children >= MAX_CHILDREN) {
            /* Over cap: still accept (drain the backlog honestly rather
             * than leave clients in SYN limbo) but close immediately. */
            bm_vlogf("accept: child cap %d reached — closing conn",
                     MAX_CHILDREN);
            close(cfd);
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
            close(l4);
            close(l6);
            bm_handle_connection(cfd, &flow);
            _exit(0);
          }
          if (pid > 0) {
            track_child(pid);
            g_live_children++;
          }
          sigprocmask(SIG_SETMASK, &prev, NULL);
          if (pid < 0) {
            bm_logf("accept: fork failed errno=%d", errno);
          }
          close(cfd);
        }
      }
    }
    if (watchdog_enabled)
      bm_watchdog_tick(&g_wd);
  }

  /* Best-effort kill of in-flight splices — slots are zeroed on reap, so
   * signalled pids are live children or unreaped zombies (both safe: a
   * zombie keeps its pid and ignores SIGTERM). Skipping 0 matters —
   * kill(0, SIGTERM) would hit our own process group. */
  for (size_t i = 0; i < g_children_len; i++)
    if (g_children[i] > 0)
      kill(g_children[i], SIGTERM);
  close(l4);
  close(l6);
  bm_logf("shutdown complete");
  return 0;
}

/* ------------------------------------------------------------------ */
/* --selftest: fake engine + real acceptor + loopback client            */
/* ------------------------------------------------------------------ */

/*
 * Fake engine (runs in a forked child): report "ready" on outfd once
 * listening (a real connection probe would consume the single accept),
 * accept ONE connection, read the complete v2 header (16 fixed bytes +
 * declared len), report it hex-encoded, echo all remaining bytes until
 * EOF, then close.
 */
static void fake_engine(const char *host, uint16_t port, int outfd) {
  int lfd = -1;
  {
    char portstr[8];
    snprintf(portstr, sizeof(portstr), "%u", (unsigned)port);
    struct addrinfo hints, *res = NULL, *ai;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE;
    if (getaddrinfo(host, portstr, &hints, &res) == 0) {
      for (ai = res; ai != NULL; ai = ai->ai_next) {
        lfd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (lfd < 0)
          continue;
        int one = 1;
        setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        if (bind(lfd, ai->ai_addr, ai->ai_addrlen) == 0 && listen(lfd, 8) == 0)
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

static int selftest_phase(int af, uint16_t helper_port, const char *engine_host,
                          uint16_t engine_port, const char *test_dst) {
  int pipefd[2];
  if (pipe(pipefd) != 0)
    return -1;

  /* Phase-scoped test-dst: set in the parent so the forked acceptor
   * inherits it (have_test_dst short-circuits /dev/pf). */
  setenv("BM_HELPER_TEST_DST", test_dst, 1);

  pid_t engine_pid = fork();
  if (engine_pid == 0) {
    close(pipefd[0]);
    fake_engine(engine_host, engine_port, pipefd[1]);
  }
  pid_t helper_pid = fork();
  if (helper_pid == 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    _exit(acceptor_loop(helper_port, engine_host, engine_port, 0));
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
      s->sin_len = sizeof(*s);
      s->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      s->sin_port = htons(helper_port);
      dlen = sizeof(*s);
    } else {
      struct sockaddr_in6 *s = (struct sockaddr_in6 *)&dst;
      s->sin6_family = AF_INET6;
      s->sin6_len = sizeof(*s);
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
    printf("selftest: af=%d dst=%s %s\n", af == AF_INET ? 4 : 6, test_dst, line);
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

static int run_selftest(uint16_t helper_port, const char *engine_host,
                        uint16_t engine_port) {
  const char *dst4 = getenv("BM_HELPER_TEST_DST");
  const char *dst6 = getenv("BM_HELPER_TEST_DST6");
  char d4[96], d6[128];
  snprintf(d4, sizeof(d4), "%s", dst4 != NULL ? dst4 : "203.0.113.7:8443");
  snprintf(d6, sizeof(d6), "%s", dst6 != NULL ? dst6 : "[2001:db8::5]:443");

  int rc4 = selftest_phase(AF_INET, helper_port, engine_host, engine_port, d4);
  int rc6 = selftest_phase(AF_INET6, helper_port, engine_host, engine_port, d6);

  printf("selftest: %s\n", (rc4 == 0 && rc6 == 0) ? "PASS" : "FAIL");
  fflush(stdout);
  return (rc4 == 0 && rc6 == 0) ? 0 : 1;
}

/* ------------------------------------------------------------------ */

static void usage(FILE *out) {
  fprintf(out,
          "usage:\n"
          "  natlook-helper <helperPort> <engineHost> <enginePort> [-v]\n"
          "  natlook-helper --selftest <helperPort> <engineHost> <enginePort>\n");
}

int main(int argc, char **argv) {
  bm_log_set_tag(TAG);
  int selftest = 0;
  int argi = 1;
  if (argi < argc && strcmp(argv[argi], "--selftest") == 0) {
    selftest = 1;
    argi++;
  }
  if (argc - argi < 3 || argc - argi > 4) {
    usage(stderr);
    return 2;
  }
  uint16_t helper_port = bm_parse_port(argv[argi]);
  const char *engine_host = argv[argi + 1];
  uint16_t engine_port = bm_parse_port(argv[argi + 2]);
  if (argc - argi == 4) {
    if (strcmp(argv[argi + 3], "-v") != 0) {
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
    return run_selftest(helper_port, engine_host, engine_port);
  return acceptor_loop(helper_port, engine_host, engine_port, 1);
}
