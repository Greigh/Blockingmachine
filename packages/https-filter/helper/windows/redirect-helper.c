/*
 * redirect-helper — the Windows transparent-capture acceptor for the
 * Blockingmachine HTTPS filter (docs/https-filtering-p3-plan.md, P3
 * Task 1). The driverless WFP connect-redirect sibling of the macOS
 * natlook-helper: same accept → origdst → PROXY-v2 → engine-splice
 * contract, built on the SAME shared core (helper/common/splice.c), so
 * the wire bytes are byte-identical by construction.
 *
 * Capture plane (pinned by the plan): filters on
 * FWPM_LAYER_ALE_CONNECT_REDIRECT_V4/V6 for tcp dport {80,443} reference
 * the SYSTEM-provided callout FWPM_CALLOUT_TCP_REDIRECT_CONNECT_LAYER;
 * a FwpmRedirectHandleCreate handle (carried on the filter's rawContext)
 * redirects matched connects to this process's 127.0.0.1:<helperPort>
 * listener. The accepted socket's ORIGINAL destination is recovered via
 * WSAIoctl(SIO_QUERY_WFP_CONNECTION_REDIRECT_CONTEXT) — the direct
 * DIOCNATLOOK analog; SIO_QUERY_WFP_CONNECTION_REDIRECT_RECORDS is
 * queried first so the WFP proxy-chain record on the socket is
 * acknowledged (and logged structurally) before context extraction.
 *
 *   +---------------------------------------------------------------+
 *   | BM_WFP_PATH_STATUS: UNVALIDATED ON REAL WINDOWS               |
 *   | This host (darwin) cannot compile or exercise the WFP legs —  |
 *   | the SDK isn't present. The user-mode surface used below       |
 *   | (FwpmEngineOpen0/FwpmRedirectHandleCreate0/FwpmFilterAdd0/    |
 *   | FwpmGetAppIdFromFileName0 + the two SIO_QUERY_* IOCTLs) is    |
 *   | the pinned design, but the exact handle→listener binding and  |
 *   | the redirect-context output format MUST be verified on the    |
 *   | windows-latest CI leg / a real elevated run before shipping.  |
 *   | Per the plan's fallback rule: if the records/context API      |
 *   | proves environment-fragile the escape is the spec's WinDivert |
 *   | design — NEVER silently substitute it. wfp_configure() fails  |
 *   | closed (no filters installed → zero redirection → the network |
 *   | is untouched) and says so.                                  |
 *   +---------------------------------------------------------------+
 *
 * Fail-open posture (mirrors natlook's philosophy, mechanism differs):
 *   - HELPER death: filters are SESSION-DYNAMIC objects (engine opened
 *     with FWPM_SESSION_FLAG_DYNAMIC); they die with the WFP engine
 *     handle the instant the process exits — no stale redirect, no
 *     blackhole, nothing to flush. SCM's recovery options restart us.
 *   - ENGINE death: the watchdog thread probes 127.0.0.1:enginePort on
 *     the shared cadence; past the consecutive-failure threshold it
 *     closes the engine handle (filters evaporate → fail-open by
 *     construction) and ExitProcess(3)s so SCM restarts us when the
 *     engine is back.
 *   - Clean shutdown additionally calls FwpmFilterDeleteById on every
 *     installed id and closes the engine handle — belt, not suspenders.
 *
 * Egress exemption: the engine's own upstream dials must NEVER be
 * re-captured. Higher-weight FWP_ACTION_PERMIT filters on the same
 * redirect layers keyed on FWPM_CONDITION_ALE_APP_ID exempt the engine
 * and helper binary paths (plus any --exclude-app paths). Where macOS
 * used a dedicated _blockingmachine user, Windows uses app-id — same
 * posture, mechanism differs.
 *
 * Concurrency: no fork on Windows → CreateThread per accepted flow,
 * bounded by the shared bm_live_children counter (BM_MAX_CHILDREN cap:
 * over cap, accept-and-close so a local conn flood can't thread-bomb
 * the daemon — the threads are suspended workers, each owning one
 * splice).
 *
 *   argv: redirect-helper <helperPort> <enginePort>
 *                        [--exclude-app <path>]... [-v]
 *         redirect-helper --selftest <helperPort> <enginePort>
 *
 *   env:  BM_HELPER_TEST_DST=<v4>:<port> | [<v6>]:<port>
 *         TEST-ONLY escape hatch — skips the WFP redirect-record lookup
 *         entirely and fixes the original destination, so the v2-emit +
 *         splice path is exercisable WITHOUT a configured redirector
 *         (this is what --selftest drives). Never set it on the service:
 *         every flow would claim the same fake destination.
 *
 * stderr is structural only — ports, address families, WFP status codes;
 * never payload bytes, never hostnames.
 */

#ifndef _WIN32
#error "redirect-helper.c is a Windows-only source file — build via helper/windows/build.ps1 (cl or clang-cl). On other platforms the file is structural-only: tests assert its contents, never compile it."
#endif

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
/* WFP user-mode management + the redirect IOCTLs require Win8+; we
 * require Win10+ in practice (service installer says so). */
#define _WIN32_WINNT 0x0A00
#endif

#include <winsock2.h>
#include <ws2ipdef.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <mstcpip.h> /* SIO_QUERY_WFP_CONNECTION_REDIRECT_{RECORDS,CONTEXT} */
/* initguid BEFORE fwpmu.h materialises the FWPM_* GUID constants into
 * this TU (they are DEFINE_GUID, not a lib). */
#include <initguid.h>
#include <fwpmu.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "../common/splice.h"

#define TAG "[redirect]"

/* The service's own listener port convention (matches the installer and
 * the macOS helper's 9295). */
#define BM_DEFAULT_HELPER_PORT 9295u

/* Our WFP provider + filter keys — generated once, fixed forever so
 * uninstall scripts and diagnostics can grep them. */
/* {7B4E61B8-2C2E-4F0A-9E1F-5D8A1E2C3F40} */
static const GUID BM_PROVIDER_KEY = {
    0x7b4e61b8, 0x2c2e, 0x4f0a,
    {0x9e, 0x1f, 0x5d, 0x8a, 0x1e, 0x2c, 0x3f, 0x40}};
/* Filter keys — {…,41..46} siblings of the provider. */
static const GUID BM_FILTER_V4_80 = {0x7b4e61b8, 0x2c2e, 0x4f0a,
                                     {0x9e, 0x1f, 0x5d, 0x8a, 0x1e, 0x2c,
                                      0x3f, 0x41}};
static const GUID BM_FILTER_V4_443 = {0x7b4e61b8, 0x2c2e, 0x4f0a,
                                      {0x9e, 0x1f, 0x5d, 0x8a, 0x1e, 0x2c,
                                       0x3f, 0x42}};
static const GUID BM_FILTER_V6_80 = {0x7b4e61b8, 0x2c2e, 0x4f0a,
                                     {0x9e, 0x1f, 0x5d, 0x8a, 0x1e, 0x2c,
                                      0x3f, 0x43}};
static const GUID BM_FILTER_V6_443 = {0x7b4e61b8, 0x2c2e, 0x4f0a,
                                      {0x9e, 0x1f, 0x5d, 0x8a, 0x1e, 0x2c,
                                       0x3f, 0x44}};

/* Captured remote ports (http/https). */
static const uint16_t BM_CAPTURE_PORTS[2] = {80u, 443u};

/* Filter weights — exclusions sit strictly above redirect rules so a
 * PERMIT on the engine/helper app-ids terminates arbitration before a
 * redirect decision is reached. */
static UINT64 g_weight_exclude = 0x10000ull;
static UINT64 g_weight_redirect = 0x01000ull;

/* WFP runtime state — session handle + the installed filter ids for the
 * clean-shutdown explicit-delete path. */
static HANDLE g_wfp_engine = NULL;
static HANDLE g_redirect_handle = NULL;
static UINT64 g_filter_ids[64];
static size_t g_filter_count = 0;
static uint16_t g_engine_port = 0;

/* ------------------------------------------------------------------ */
/* WFP configuration — the UNVALIDATED leg (see header block).         */
/* Every failure here is CLOSED-ON-NETWORK (no partial filters); the    */
/* only state that can half-apply is session-dynamic, i.e. self-        */
/* cleaning on process exit.                                            */
/* ------------------------------------------------------------------ */

static void wfp_note_filter(UINT64 id) {
  if (g_filter_count < sizeof(g_filter_ids) / sizeof(g_filter_ids[0]))
    g_filter_ids[g_filter_count++] = id;
}

/* One redirect-layer filter: tcp dport==port, the system redirect
 * callout, redirect handle carried on rawContext. */
static DWORD wfp_add_redirect_filter(const GUID *layer_key,
                                     const GUID *filter_key, uint16_t port,
                                     const wchar_t *name) {
  /* FWP_VALUE0 for UINT8/UINT16 carries POINTERS — keep them in statics
   * so the memory outlives the call. */
  static UINT8 proto_tcp = IPPROTO_TCP;
  UINT16 port_net = port; /* condition value is host-order per SDK */
  FWPM_FILTER_CONDITION0 cond[2];
  memset(cond, 0, sizeof(cond));
  cond[0].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
  cond[0].matchType = FWP_MATCH_EQUAL;
  cond[0].conditionValue.type = FWP_UINT8;
  cond[0].conditionValue.uint8 = &proto_tcp;
  cond[1].fieldKey = FWPM_CONDITION_TCP_REMOTE_PORT;
  cond[1].matchType = FWP_MATCH_EQUAL;
  cond[1].conditionValue.type = FWP_UINT16;
  cond[1].conditionValue.uint16 = &port_net;

  FWPM_FILTER0 f;
  memset(&f, 0, sizeof(f));
  f.filterKey = *filter_key;
  f.layerKey = *layer_key;
  f.displayData.name = (wchar_t *)name;
  f.displayData.description =
      (wchar_t *)L"Blockingmachine transparent HTTPS capture (P3)";
  f.action.type = FWP_ACTION_CALLOUT_TERMINATING;
  f.action.calloutKey = FWPM_CALLOUT_TCP_REDIRECT_CONNECT_LAYER;
  /* BM_WFP_PATH_STATUS: the redirect-handle → redirect-target binding
   * used by the system callout is carried on rawContext per the user-
   * mode proxy-chain contract — VALIDATE on real Windows; if the SDK on
   * the target surfaces a different binding field this is the single
   * line to change (documented in docs/https-filtering-p3-plan.md's
   * fallback clause). */
  f.rawContext = (UINT64)(uintptr_t)g_redirect_handle;
  f.weight.type = FWP_UINT64;
  f.weight.uint64 = &g_weight_redirect;
  f.numFilterConditions = 2;
  f.filterCondition = cond;
  f.providerKey = &BM_PROVIDER_KEY;

  UINT64 id = 0;
  DWORD rc = FwpmFilterAdd0(g_wfp_engine, &f, NULL, &id);
  if (rc == ERROR_SUCCESS)
    wfp_note_filter(id);
  return rc;
}

/* One exclusion filter: ALE_APP_ID of `path` PERMITs at higher weight —
 * the engine/helper's own connects are never redirected back at us. */
static DWORD wfp_add_appid_exclusion(const GUID *layer_key,
                                     const wchar_t *path,
                                     const wchar_t *name) {
  FWP_BYTE_BLOB *app_id = NULL;
  DWORD rc = FwpmGetAppIdFromFileName0(path, &app_id);
  if (rc != ERROR_SUCCESS || app_id == NULL)
    return rc != ERROR_SUCCESS ? rc : ERROR_FILE_NOT_FOUND;

  FWPM_FILTER_CONDITION0 cond[1];
  memset(cond, 0, sizeof(cond));
  cond[0].fieldKey = FWPM_CONDITION_ALE_APP_ID;
  cond[0].matchType = FWP_MATCH_EQUAL;
  cond[0].conditionValue.type = FWP_BYTE_BLOB_TYPE;
  cond[0].conditionValue.byteBlob = app_id;

  FWPM_FILTER0 f;
  memset(&f, 0, sizeof(f));
  f.layerKey = *layer_key;
  f.displayData.name = (wchar_t *)name;
  f.displayData.description =
      (wchar_t *)L"Blockingmachine egress exemption — this binary's "
                  L"connects are never re-captured";
  f.action.type = FWP_ACTION_PERMIT;
  f.weight.type = FWP_UINT64;
  f.weight.uint64 = &g_weight_exclude;
  f.numFilterConditions = 1;
  f.filterCondition = cond;
  f.providerKey = &BM_PROVIDER_KEY;
  /* Flags not needed for a permit — left default. */

  UINT64 id = 0;
  rc = FwpmFilterAdd0(g_wfp_engine, &f, NULL, &id);
  FwpmFreeMemory0((void **)&app_id);
  if (rc == ERROR_SUCCESS)
    wfp_note_filter(id);
  return rc;
}

/* char* argv path → wchar — MAX_PATH bounds the service's own paths. */
static int to_wide(const char *in, wchar_t *out, size_t cap) {
  int n = MultiByteToWideChar(CP_UTF8, 0, in, -1, out, (int)cap);
  return n > 0 ? 0 : -1;
}

/*
 * Open the WFP session + install all filters. `excl_paths` are the
 * engine/helper binary paths plus any --exclude-app values — each gets a
 * higher-weight PERMIT on BOTH redirect layers. Returns 0 with all
 * filters in place; nonzero means CLOSED-ON-NETWORK (nothing installed).
 */
static int wfp_configure(uint16_t helper_port, const wchar_t **excl_paths,
                         size_t n_excl) {
  (void)helper_port; /* binding is via the redirect handle, not the port */

  FWPM_SESSION0 session;
  memset(&session, 0, sizeof(session));
  session.displayData.name = (wchar_t *)L"Blockingmachine redirect helper";
  session.displayData.description =
      (wchar_t *)L"Session-scoped connect-redirect capture objects — "
                  L"they die with this process (fail-open)";
  /* THE fail-open mechanism: dynamic objects are scoped to the session —
   * no FwpmTransactionBegin means adds are auto-commit but still die
   * with the engine handle. */
  session.flags = FWPM_SESSION_FLAG_DYNAMIC;

  DWORD rc = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, &session,
                           &g_wfp_engine);
  if (rc != ERROR_SUCCESS) {
    bm_logf("wfp: FwpmEngineOpen failed rc=%lu — needs elevation; no "
            "filters installed (fail-open)",
            (unsigned long)rc);
    return -1;
  }

  FWPM_PROVIDER0 provider;
  memset(&provider, 0, sizeof(provider));
  provider.providerKey = BM_PROVIDER_KEY;
  provider.displayData.name = (wchar_t *)L"Blockingmachine";
  provider.displayData.description =
      (wchar_t *)L"Blockingmachine HTTPS filter capture";
  provider.flags = 0;
  rc = FwpmProviderAdd0(g_wfp_engine, &provider, NULL);
  if (rc != ERROR_SUCCESS && rc != FWP_E_ALREADY_EXISTS) {
    bm_logf("wfp: provider add failed rc=%lu", (unsigned long)rc);
    return -1;
  }

  /* Redirect handle — the identity the system redirect callout uses to
   * find this process's loopback listener. */
  NTSTATUS nrc = FwpmRedirectHandleCreate0(&BM_PROVIDER_KEY,
                                           &g_redirect_handle);
  if (nrc != STATUS_SUCCESS || g_redirect_handle == NULL) {
    bm_logf("wfp: FwpmRedirectHandleCreate failed status=0x%lx — "
            "connect-redirect unavailable on this build; NO filters "
            "installed (fail-open)",
            (unsigned long)nrc);
    return -1;
  }

  /* Exclusions first — a redirect filter must never beat an exemption
   * even transiently. Same posture as the macOS dedicated-user rule. */
  for (size_t i = 0; i < n_excl; i++) {
    if (excl_paths[i] == NULL)
      continue;
    DWORD r4 = wfp_add_appid_exclusion(&FWPM_LAYER_ALE_CONNECT_REDIRECT_V4,
                                       excl_paths[i],
                                       L"Blockingmachine egress exempt v4");
    DWORD r6 = wfp_add_appid_exclusion(&FWPM_LAYER_ALE_CONNECT_REDIRECT_V6,
                                       excl_paths[i],
                                     L"Blockingmachine egress exempt v6");
    if (r4 != ERROR_SUCCESS)
      bm_vlogf("wfp: appid exclusion v4 failed rc=%lu (path slot %zu)",
               (unsigned long)r4, i);
    if (r6 != ERROR_SUCCESS)
      bm_vlogf("wfp: appid exclusion v6 failed rc=%lu (path slot %zu)",
               (unsigned long)r6, i);
  }

  static const struct {
    const GUID *layer;
    const wchar_t *name;
  } legs[2] = {
      {&FWPM_LAYER_ALE_CONNECT_REDIRECT_V4, L"Blockingmachine capture v4"},
      {&FWPM_LAYER_ALE_CONNECT_REDIRECT_V6, L"Blockingmachine capture v6"},
  };
  static const GUID *keys[4] = {&BM_FILTER_V4_80, &BM_FILTER_V4_443,
                                &BM_FILTER_V6_80, &BM_FILTER_V6_443};
  size_t k = 0;
  for (int leg = 0; leg < 2; leg++) {
    for (size_t p = 0; p < 2; p++) {
      DWORD frc = wfp_add_redirect_filter(legs[leg].layer, keys[k],
                                          BM_CAPTURE_PORTS[p],
                                          legs[leg].name);
      k++;
      if (frc != ERROR_SUCCESS) {
        bm_logf("wfp: redirect filter add failed rc=%lu leg=%d port=%u — "
                "capture partially configured; closing engine fails open",
                (unsigned long)frc, leg, (unsigned)BM_CAPTURE_PORTS[p]);
        return -1;
      }
    }
  }
  bm_logf("wfp: %zu filters installed (session-dynamic) — "
          "BM_WFP_PATH_STATUS UNVALIDATED, see source header",
          g_filter_count);
  return 0;
}

/* Clean shutdown: explicit per-filter deletes, then handle + engine
 * close. The session close alone would suffice (dynamic objects) — the
 * deletes exist so partial teardown is observable and ordered. */
static void wfp_teardown(void) {
  for (size_t i = 0; i < g_filter_count; i++)
    FwpmFilterDeleteById0(g_wfp_engine, g_filter_ids[i]);
  g_filter_count = 0;
  if (g_redirect_handle != NULL) {
    FwpmRedirectHandleDestroy0(g_redirect_handle);
    g_redirect_handle = NULL;
  }
  if (g_wfp_engine != NULL) {
    FwpmEngineClose0(g_wfp_engine);
    g_wfp_engine = NULL;
  }
}

/* ------------------------------------------------------------------ */
/* Origdst — WFP redirect context (the DIOCNATLOOK analog)              */
/* ------------------------------------------------------------------ */

/*
 * Recover the original (pre-redirect) destination of an accepted flow:
 * first acknowledge the redirect RECORDS (the WFP proxy-chain tracking —
 * queried and dropped here; a future multi-hop proxy would honour them),
 * then fetch the redirect CONTEXT which for ALE_CONNECT_REDIRECT carries
 * the original destination as a SOCKADDR_STORAGE.
 *
 * BM_WFP_PATH_STATUS: the context ioctl's output shape for the TCP
 * redirect callout is the pinned design (SOCKADDR_STORAGE); validate the
 * buffer contract on real Windows — failure here is an honest close, and
 * bm_handle_connection falls back only to BM_HELPER_TEST_DST.
 */
static int wfp_origdst(bm_sock_t connfd, struct sockaddr_storage *out,
                       void *ctx) {
  (void)ctx;
  DWORD out_len = 0;
  uint8_t records[4096]; /* per-thread stack — queried for observability */
  int rrc = WSAIoctl(connfd, SIO_QUERY_WFP_CONNECTION_REDIRECT_RECORDS, NULL,
                     0, records, sizeof(records), &out_len, NULL, NULL);
  bm_vlogf("flow: redirect records rc=%d bytes=%lu", rrc,
           (unsigned long)out_len);

  memset(out, 0, sizeof(*out));
  DWORD ctx_len = 0;
  int crc = WSAIoctl(connfd, SIO_QUERY_WFP_CONNECTION_REDIRECT_CONTEXT, NULL,
                     0, out, sizeof(*out), &ctx_len, NULL, NULL);
  if (crc != 0 || ctx_len == 0)
    return -1;
  if (out->ss_family != AF_INET && out->ss_family != AF_INET6) {
    bm_sock_err_set(WSAEPROTONOSUPPORT);
    return -1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Thread-per-connection worker + acceptor                             */
/* ------------------------------------------------------------------ */

typedef struct conn_work {
  bm_sock_t fd;
  const bm_flow_cfg *cfg;
} conn_work;

static DWORD WINAPI conn_thread(void *arg) {
  conn_work *w = (conn_work *)arg;
  bm_handle_connection(w->fd, w->cfg);
  free(w);
  bm_child_reaped();
  return 0;
}

/* Spawn a worker for an accepted fd; caller keeps owning the accept
 * side. On CreateThread failure the caller closes (bounded threads). */
static int spawn_worker(bm_sock_t cfd, const bm_flow_cfg *cfg) {
  conn_work *w = (conn_work *)malloc(sizeof(*w));
  if (w == NULL)
    return -1;
  w->fd = cfd;
  w->cfg = cfg;
  HANDLE th = CreateThread(NULL, 0, conn_thread, w, 0, NULL);
  if (th == NULL) {
    free(w);
    return -1;
  }
  CloseHandle(th); /* detached — the worker frees its own arg */
  bm_child_spawned();
  return 0;
}

static volatile LONG g_shutdown = 0;

static BOOL WINAPI on_console_ctrl(DWORD evt) {
  if (evt == CTRL_C_EVENT || evt == CTRL_CLOSE_EVENT ||
      evt == CTRL_BREAK_EVENT || evt == CTRL_SHUTDOWN_EVENT) {
    InterlockedExchange(&g_shutdown, 1);
    return TRUE;
  }
  return FALSE;
}

/* SCM service-stop handler — registered only in service mode; mirrors
 * the console path (the installer runs us under SCM). */
static SERVICE_STATUS_HANDLE g_svc_handle = NULL;
static SERVICE_STATUS g_svc_status;
static void WINAPI svc_ctrl(DWORD ctrl) {
  if (ctrl == SERVICE_CONTROL_STOP || ctrl == SERVICE_CONTROL_SHUTDOWN) {
    InterlockedExchange(&g_shutdown, 1);
    g_svc_status.dwCurrentState = SERVICE_STOP_PENDING;
    g_svc_status.dwWin32ExitCode = 0;
    if (g_svc_handle != NULL)
      SetServiceStatus(g_svc_handle, &g_svc_status);
  }
}
static void WINAPI svc_main(DWORD argc, LPWSTR *argv);
/* The service-entry plumbing is exercised only when started via SCM;
 * the .c keeps it minimal — main() below also works standalone for
 * --selftest/manual debugging. */

/*
 * The real acceptor loop — poll both listeners, drain nonblocking
 * accepts, gate on bm_children_full, CreateThread per flow. `max_accepts`
 * >0 bounds the loop (selftest accepts exactly one flow then exits).
 */
static int acceptor_loop(uint16_t helper_port, uint16_t engine_port,
                         const wchar_t **excl_paths, size_t n_excl,
                         int wfp_enabled, int max_accepts) {
  bm_flow_cfg flow;
  memset(&flow, 0, sizeof(flow));
  flow.engine_host = "127.0.0.1";
  flow.engine_port = engine_port;
  flow.origdst = wfp_origdst;
  flow.have_test_dst = bm_test_dst_from_env(&flow.test_dst);
  if (flow.have_test_dst)
    bm_vlogf("test-dst override active af=%d — WFP lookup bypassed",
             flow.test_dst.ss_family);

  struct sockaddr_in sin4;
  memset(&sin4, 0, sizeof(sin4));
  sin4.sin_family = AF_INET;
  sin4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  sin4.sin_port = htons(helper_port);
  bm_sock_t l4 = bm_listen_on((const struct sockaddr *)&sin4, sizeof(sin4));
  if (l4 == BM_SOCK_INVALID) {
    bm_logf("fatal: cannot bind 127.0.0.1:%u err=%d", (unsigned)helper_port,
            bm_sock_err());
    return 1;
  }

  struct sockaddr_in6 sin6;
  memset(&sin6, 0, sizeof(sin6));
  sin6.sin6_family = AF_INET6;
  sin6.sin6_addr = in6addr_loopback;
  sin6.sin6_port = htons(helper_port);
  bm_sock_t l6 = bm_listen_on((const struct sockaddr *)&sin6, sizeof(sin6));
  if (l6 == BM_SOCK_INVALID) {
    /* Same asymmetric-breakage posture as the macOS helper: a v4-only
     * acceptor behind a v6 redirect leg RSTs v6 clients. Die and let
     * SCM recovery retry loudly. */
    bm_logf("fatal: cannot bind [::1]:%u err=%d — v6 capture leg required",
            (unsigned)helper_port, bm_sock_err());
    bm_sock_close(l4);
    return 1;
  }

  if (wfp_enabled && wfp_configure(helper_port, excl_paths, n_excl) != 0) {
    bm_sock_close(l4);
    bm_sock_close(l6);
    return 1;
  }

  bm_logf("listening on 127.0.0.1:%u + [::1] — engine 127.0.0.1:%u%s",
          (unsigned)helper_port, (unsigned)engine_port,
          wfp_enabled ? " (WFP armed)" : " (WFP off: selftest)");

  LONG accepted = 0;
  while (!g_shutdown) {
    if (max_accepts > 0 && accepted >= max_accepts)
      break;
    bm_pollfd_t pfd[2];
    pfd[0].fd = l4;
    pfd[0].events = POLLIN;
    pfd[0].revents = 0;
    pfd[1].fd = l6;
    pfd[1].events = POLLIN;
    pfd[1].revents = 0;
    int n = bm_poll(pfd, 2, (int)BM_WATCHDOG_TICK_MS);
    if (n < 0) {
      if (bm_sock_err() == BM_SOCK_EINTR)
        continue;
      bm_logf("fatal: WSAPoll err=%d", bm_sock_err());
      break;
    }
    if (n > 0) {
      for (int i = 0; i < 2; i++) {
        if (pfd[i].fd == BM_SOCK_INVALID || !(pfd[i].revents & POLLIN))
          continue;
        for (;;) {
          bm_sock_t cfd = accept(pfd[i].fd, NULL, NULL);
          if (cfd == BM_SOCK_INVALID) {
            int e = bm_sock_err();
            if (e == WSAEINTR)
              continue;
            if (e == WSAEWOULDBLOCK)
              break;
            if (e == WSAECONNRESET || e == WSAECONNABORTED)
              continue; /* this pending conn died — more may be queued */
            bm_logf("accept: err=%d", e);
            break;
          }
          if (bm_children_full()) {
            bm_vlogf("accept: child cap %u reached — closing conn",
                     (unsigned)BM_MAX_CHILDREN);
            bm_sock_close(cfd);
            continue;
          }
          if (spawn_worker(cfd, &flow) != 0) {
            bm_logf("accept: CreateThread failed err=%d",
                    (int)GetLastError());
            bm_sock_close(cfd);
          } else {
            InterlockedIncrement(&accepted);
          }
        }
      }
    }
  }

  /* Threads own their fds; no shutdown-kill registry (that is the fork
   * world's problem — SIGTERM has no thread analog). Session-dynamic
   * filters evaporate on wfp_teardown / process death regardless. */
  bm_sock_close(l4);
  bm_sock_close(l6);
  bm_logf("shutdown complete");
  return 0;
}

/* ------------------------------------------------------------------ */
/* Watchdog thread — shared probe loop, Windows dead_cb                 */
/* ------------------------------------------------------------------ */

static void on_engine_dead(const bm_watchdog *wd) {
  (void)wd;
  /* Engine sustained-dead → fail-open by construction: closing the
   * engine handle evaporates every session-dynamic filter at once, then
   * nonzero exit lets SCM recovery restart us beside the engine. */
  bm_logf("watchdog: %u consecutive probe failures — closing WFP session "
          "(filters evaporate) and exiting 3 for SCM restart",
          (unsigned)BM_WATCHDOG_FAILS);
  wfp_teardown();
  ExitProcess(3);
}

static DWORD WINAPI watchdog_thread(void *arg) {
  (void)arg;
  bm_watchdog_loop(g_engine_port, on_engine_dead, 0);
  return 0; /* unreachable */
}

/* ------------------------------------------------------------------ */
/* --selftest: fake engine + real acceptor + loopback client            */
/*                                                                     */
/* Exercises everything except the WFP lookup itself (the test-dst env  */
/* seam fixes the destination). Runs anywhere a Windows build exists —  */
/* the structural honesty counterpart of BM_WFP_PATH_STATUS.            */
/* ------------------------------------------------------------------ */

static char g_report_buf[256]; /* fake-engine hex header lands here */

static DWORD WINAPI fake_engine(void *arg) {
  uint16_t port = (uint16_t)(uintptr_t)arg;
  struct sockaddr_in sin;
  memset(&sin, 0, sizeof(sin));
  sin.sin_family = AF_INET;
  sin.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  sin.sin_port = htons(port);
  bm_sock_t lfd = bm_listen_on((const struct sockaddr *)&sin, sizeof(sin));
  if (lfd == BM_SOCK_INVALID)
    return 3;
  /* The listener is nonblocking (bm_listen_on) — poll for the inbound
   * conn, then accept. listen() is already live, so the caller's client
   * connect- retry loop covers the bind race. */
  bm_pollfd_t p;
  p.fd = lfd;
  p.events = POLLIN;
  p.revents = 0;
  if (bm_poll(&p, 1, 8000) <= 0)
    return 4;
  bm_sock_t cfd = accept(lfd, NULL, NULL);
  if (cfd == BM_SOCK_INVALID)
    return 4;

  uint8_t hdr[64];
  size_t got = 0;
  while (got < 16) {
    bm_ssize_t r = bm_sock_read(cfd, hdr + got, 16 - got);
    if (r <= 0)
      return 5;
    got += (size_t)r;
  }
  size_t want = 16 + ((size_t)hdr[14] << 8 | hdr[15]);
  if (want > sizeof(hdr))
    return 6;
  while (got < want) {
    bm_ssize_t r = bm_sock_read(cfd, hdr + got, want - got);
    if (r <= 0)
      return 7;
    got += (size_t)r;
  }
  char hex[129];
  bm_hex_encode(hdr, want, hex);
  snprintf(g_report_buf, sizeof(g_report_buf), "header=%s", hex);

  uint8_t buf[8192];
  for (;;) {
    bm_ssize_t r = bm_sock_read(cfd, buf, sizeof(buf));
    if (r == 0)
      break;
    if (r < 0) {
      if (bm_sock_err() == BM_SOCK_EINTR)
        continue;
      break;
    }
    if (bm_write_all(cfd, buf, (size_t)r) != 0)
      break;
  }
  bm_sock_close(cfd);
  bm_sock_close(lfd);
  return 0;
}

typedef struct acceptor_args {
  uint16_t helper_port;
  uint16_t engine_port;
  int max_accepts;
  int rc;
} acceptor_args;

static DWORD WINAPI acceptor_thread(void *arg) {
  acceptor_args *a = (acceptor_args *)arg;
  a->rc = acceptor_loop(a->helper_port, a->engine_port, NULL, 0, 0,
                        a->max_accepts);
  return 0;
}

static int selftest_client(uint16_t helper_port, size_t payload_len,
                           uint16_t *client_port_out) {
  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  dst.sin_port = htons(helper_port);

  bm_sock_t fd = BM_SOCK_INVALID;
  for (int i = 0; i < 100; i++) {
    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd == BM_SOCK_INVALID)
      return -1;
    if (connect(fd, (const struct sockaddr *)&dst, sizeof(dst)) == 0)
      break;
    bm_sock_close(fd);
    fd = BM_SOCK_INVALID;
    bm_sleep_ms(20);
  }
  if (fd == BM_SOCK_INVALID)
    return -1;
  /* restore blocking — bm_listen_on marks listeners nonblocking but
   * client sockets we create are blocking already; keep it simple. */
  struct sockaddr_in self;
  int sl = sizeof(self);
  getsockname(fd, (struct sockaddr *)&self, &sl);
  *client_port_out = self.sin_port;

  uint8_t *pat = (uint8_t *)malloc(payload_len);
  uint8_t *echo = (uint8_t *)malloc(payload_len);
  if (pat == NULL || echo == NULL)
    return -1;
  for (size_t i = 0; i < payload_len; i++)
    pat[i] = (uint8_t)(i * 31u + 7u);
  int ok = 0;
  if (bm_write_all(fd, pat, payload_len) == 0) {
    shutdown(fd, SD_SEND);
    size_t got = 0;
    while (got < payload_len) {
      bm_ssize_t r = bm_sock_read(fd, echo + got, payload_len - got);
      if (r <= 0)
        break;
      got += (size_t)r;
    }
    ok = (got == payload_len && memcmp(pat, echo, payload_len) == 0);
  }
  bm_sock_close(fd);
  free(pat);
  free(echo);
  printf("selftest: client_port=%u payload_bytes=%zu payload=%s\n",
         (unsigned)ntohs(*client_port_out), payload_len,
         ok ? "match" : "mismatch");
  fflush(stdout);
  return ok ? 0 : -1;
}

static int run_selftest(uint16_t helper_port, uint16_t engine_port) {
  /* Same fixture contract as the macOS selftest — v4 leg only here (v6
   * is exercised by the same code path; WFP itself is out of scope). */
  _putenv_s("BM_HELPER_TEST_DST", "203.0.113.7:8443");

  HANDLE eng = CreateThread(NULL, 0, fake_engine,
                            (void *)(uintptr_t)engine_port, 0, NULL);
  if (eng == NULL) {
    bm_logf("selftest: fake engine thread failed");
    return 1;
  }

  acceptor_args aa;
  memset(&aa, 0, sizeof(aa));
  aa.helper_port = helper_port;
  aa.engine_port = engine_port;
  aa.max_accepts = 1;
  HANDLE acc = CreateThread(NULL, 0, acceptor_thread, &aa, 0, NULL);
  if (acc == NULL) {
    bm_logf("selftest: acceptor thread failed");
    return 1;
  }

  uint16_t cport = 0;
  int ok = selftest_client(helper_port, 128 * 1024, &cport) == 0;

  WaitForSingleObject(acc, 10000);
  WaitForSingleObject(eng, 5000);
  CloseHandle(acc);
  CloseHandle(eng);

  if (strncmp(g_report_buf, "header=", 7) == 0)
    printf("selftest: af=4 dst=203.0.113.7:8443 %s\n", g_report_buf);
  else
    ok = 0;
  printf("selftest: %s\n", ok ? "PASS" : "FAIL");
  fflush(stdout);
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* Service + standalone entrypoints                                    */
/* ------------------------------------------------------------------ */

static char g_arg_helper_port[8] = {0};
static char g_arg_engine_port[8] = {0};
static const wchar_t *g_excl_paths[32];
static wchar_t g_excl_storage[32][512];
static size_t g_excl_count = 0;

static void WINAPI svc_main(DWORD argc, LPWSTR *argv) {
  (void)argc;
  (void)argv;
  g_svc_handle =
      RegisterServiceCtrlHandlerW(L"BlockingmachineHelper", svc_ctrl);
  if (g_svc_handle == NULL)
    return;
  memset(&g_svc_status, 0, sizeof(g_svc_status));
  g_svc_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  g_svc_status.dwCurrentState = SERVICE_START_PENDING;
  g_svc_status.dwControlsAccepted = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN;
  SetServiceStatus(g_svc_handle, &g_svc_status);

  g_svc_status.dwCurrentState = SERVICE_RUNNING;
  SetServiceStatus(g_svc_handle, &g_svc_status);

  uint16_t hp = bm_parse_port(g_arg_helper_port);
  uint16_t ep = bm_parse_port(g_arg_engine_port);
  if (hp == 0)
    hp = (uint16_t)BM_DEFAULT_HELPER_PORT;
  if (ep == 0)
    ep = 9294; /* engine data listener convention */

  HANDLE wd = CreateThread(NULL, 0, watchdog_thread, NULL, 0, NULL);
  if (wd != NULL)
    CloseHandle(wd);

  acceptor_loop(hp, ep, g_excl_paths, g_excl_count, 1, 0);
  wfp_teardown();

  g_svc_status.dwCurrentState = SERVICE_STOPPED;
  SetServiceStatus(g_svc_handle, &g_svc_status);
}

/*
 * Standalone mode IS the service path too: sc.exe binPath points at this
 * exe with args; when launched by SCM, StartServiceCtrlDispatcher takes
 * over; when launched directly (selftest / manual run) the dispatcher
 * fails ERROR_FAILED_SERVICE_CONTROLLER_CONNECT and we run the acceptor
 * in-process — one binary, two entry postures, identical inner path.
 */
static void usage(FILE *out) {
  fprintf(out,
          "usage:\n"
          "  redirect-helper <helperPort> <enginePort> "
          "[--exclude-app <path>]... [-v]\n"
          "  redirect-helper --selftest <helperPort> <enginePort>\n");
}

int main(int argc, char **argv) {
  bm_log_set_tag(TAG);
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    bm_logf("fatal: WSAStartup failed");
    return 1;
  }

  int selftest = 0;
  int argi = 1;
  if (argi < argc && strcmp(argv[argi], "--selftest") == 0) {
    selftest = 1;
    argi++;
  }
  if (argc - argi < 2) {
    usage(stderr);
    return 2;
  }
  snprintf(g_arg_helper_port, sizeof(g_arg_helper_port), "%s", argv[argi]);
  snprintf(g_arg_engine_port, sizeof(g_arg_engine_port), "%s", argv[argi + 1]);
  uint16_t helper_port = bm_parse_port(g_arg_helper_port);
  uint16_t engine_port = bm_parse_port(g_arg_engine_port);
  argi += 2;
  for (; argi < argc; argi++) {
    if (strcmp(argv[argi], "-v") == 0) {
      bm_verbose = 1;
    } else if (strcmp(argv[argi], "--exclude-app") == 0 && argi + 1 < argc) {
      argi++;
      if (g_excl_count < 32 &&
          to_wide(argv[argi], g_excl_storage[g_excl_count], 512) == 0) {
        g_excl_paths[g_excl_count] = g_excl_storage[g_excl_count];
        g_excl_count++;
      } else {
        bm_logf("warn: --exclude-app path too long/invalid — skipped");
      }
    } else {
      usage(stderr);
      return 2;
    }
  }
  if (helper_port == 0 || engine_port == 0) {
    usage(stderr);
    return 2;
  }
  g_engine_port = engine_port;

  /* Always exempt ourselves; the installer passes the engine's node.exe
   * path via --exclude-app. */
  {
    wchar_t self_path[512];
    DWORD n = GetModuleFileNameW(NULL, self_path, 512);
    if (n > 0 && g_excl_count < 32) {
      wcsncpy(g_excl_storage[g_excl_count], self_path, 511);
      g_excl_paths[g_excl_count] = g_excl_storage[g_excl_count];
      g_excl_count++;
    }
  }

  if (selftest)
    return run_selftest(helper_port, engine_port);

  SetConsoleCtrlHandler(on_console_ctrl, TRUE);

  /* Service path: hand control to SCM; the handler races we accept are
   * the standard ones for a single-service exe. Fallback = standalone. */
  SERVICE_TABLE_ENTRYW tbl[] = {
      {L"BlockingmachineHelper", svc_main}, {NULL, NULL}};
  if (StartServiceCtrlDispatcherW(tbl) == 0) {
    DWORD e = GetLastError();
    if (e != ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
      bm_logf("fatal: StartServiceCtrlDispatcher err=%lu",
              (unsigned long)e);
      return 1;
    }
    /* Standalone debug/console run — same inner path. */
    HANDLE wd = CreateThread(NULL, 0, watchdog_thread, NULL, 0, NULL);
    if (wd != NULL)
      CloseHandle(wd);
    int rc = acceptor_loop(helper_port, engine_port, g_excl_paths,
                           g_excl_count, 1, 0);
    wfp_teardown();
    return rc;
  }
  return 0;
}
