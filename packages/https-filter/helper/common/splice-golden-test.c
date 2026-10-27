/*
 * splice-golden-test.c — C-level contract test for the shared helper
 * core (P3 T1). Asserts bm_proxy_v2_format emits the EXACT wire bytes
 * the engine parser (src/proxy/proxyProtocol.ts) is tested against —
 * signature, ver/cmd 0x21, fam 0x11/0x21, big-endian len, the src/dst
 * addr+port field order — for both families, plus the negative paths
 * (family mismatch in _format_ss, undersized buffer, non-INET family).
 * On POSIX it also drives bm_splice over socketpairs: both directions,
 * EOF→half-close propagation, and a clean return once both legs die.
 *
 * The PROXY-v2 contract is now platform-verified on whichever host runs
 * this file — the Windows helper emits the same bytes because it emits
 * through this same code.
 *
 *   POSIX:  cc -std=c11 -Wall -Wextra -Werror -o splice-golden-test \
 *              splice-golden-test.c splice.c && ./splice-golden-test
 *   Win32:  cl /W4 /WX splice-golden-test.c splice.c ws2_32.lib
 *           (format asserts run; the socketpair section is POSIX-only)
 *
 * stdout: "golden: <name> ok" per check and a final "golden: PASS".
 * stderr/exit: 1 + a "golden: FAIL <name>" line on the first failure.
 */

#include "splice.h"

#ifdef _WIN32
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/wait.h>
#endif

static int g_fails = 0;

#define CHECK(name, cond)                                                  \
  do {                                                                     \
    if (cond) {                                                            \
      printf("golden: %s ok\n", (name));                                   \
    } else {                                                               \
      fprintf(stderr, "golden: FAIL %s\n", (name));                        \
      g_fails = 1;                                                         \
    }                                                                      \
  } while (0)

static int bytes_eq(const uint8_t *a, const uint8_t *b, size_t n) {
  return memcmp(a, b, n) == 0;
}

/* ------------------------------------------------------------------ */
/* Golden byte vectors — hand-built from the v2 spec, matching the      */
/* expectedV4/expectedV6 helpers in src/__tests__/helper.test.ts.       */
/* ------------------------------------------------------------------ */

static void test_v4(void) {
  /* src 192.0.2.10:51000 → dst 203.0.113.7:443 */
  uint8_t buf[64];
  bm_ip_addr src = {.v4 = {0}}, dst = {.v4 = {0}};
  memset(buf, 0xaa, sizeof(buf));
  inet_pton(AF_INET, "192.0.2.10", &src.v4);
  inet_pton(AF_INET, "203.0.113.7", &dst.v4);
  int n = bm_proxy_v2_format(buf, sizeof(buf), AF_INET, &src, htons(51000),
                             &dst, htons(443));
  static const uint8_t want[28] = {
      0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
      0x21, 0x11, 0x00, 0x0c, 0xc0, 0x00, 0x02, 0x0a, 0xcb, 0x00, 0x71, 0x07,
      0xc7, 0x38, 0x01, 0xbb};
  CHECK("v4 len", n == 28);
  CHECK("v4 bytes", bytes_eq(buf, want, sizeof(want)));
}

static void test_v6(void) {
  /* src 2001:db8::1:52000 → dst 2001:db8::5:443 */
  uint8_t buf[64];
  bm_ip_addr src = {.v6 = {0}}, dst = {.v6 = {0}};
  memset(buf, 0xaa, sizeof(buf));
  inet_pton(AF_INET6, "2001:db8::1", &src.v6);
  inet_pton(AF_INET6, "2001:db8::5", &dst.v6);
  int n = bm_proxy_v2_format(buf, sizeof(buf), AF_INET6, &src, htons(52000),
                             &dst, htons(443));
  static const uint8_t want[52] = {
      0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
      0x21, 0x21, 0x00, 0x24, 0x20, 0x01, 0x0d, 0xb8, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x20, 0x01, 0x0d, 0xb8,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05,
      0xcb, 0x20, 0x01, 0xbb};
  CHECK("v6 len", n == 52);
  CHECK("v6 bytes", bytes_eq(buf, want, sizeof(want)));
}

static void test_negatives(void) {
  uint8_t buf[64];
  bm_ip_addr a4 = {.v4 = {0}}, a6 = {.v6 = {0}};
  inet_pton(AF_INET, "127.0.0.1", &a4.v4);
  inet_pton(AF_INET6, "::1", &a6.v6);

  /* undersized buffer → -1 */
  CHECK("v4 small cap", bm_proxy_v2_format(buf, 27, AF_INET, &a4, 0, &a4, 0) == -1);
  CHECK("v6 small cap", bm_proxy_v2_format(buf, 51, AF_INET6, &a6, 0, &a6, 0) == -1);
  /* unknown family → -1 */
  CHECK("bad family", bm_proxy_v2_format(buf, sizeof(buf), 99, &a4, 0, &a4, 0) == -1);
  /* family mismatch across src/dst sockaddr_storage → -1 */
  struct sockaddr_storage s4, s6;
  memset(&s4, 0, sizeof(s4));
  memset(&s6, 0, sizeof(s6));
  s4.ss_family = AF_INET;
  s6.ss_family = AF_INET6;
  CHECK("ss family mismatch",
        bm_proxy_v2_format_ss(buf, sizeof(buf), &s4, &s6) == -1);
  /* non-INET ss_family → -1 */
  s6.ss_family = AF_UNIX;
  CHECK("ss non-inet",
        bm_proxy_v2_format_ss(buf, sizeof(buf), &s4, &s6) == -1);
  /* ss extraction on a real v4 sockaddr */
  struct sockaddr_in sin;
  memset(&sin, 0, sizeof(sin));
  sin.sin_family = AF_INET;
  inet_pton(AF_INET, "10.20.30.40", &sin.sin_addr);
  sin.sin_port = htons(8080);
  bm_ip_addr got = {.v4 = {0}};
  uint16_t port = 0;
  struct sockaddr_storage ss;
  memcpy(&ss, &sin, sizeof(sin));
  int fam = bm_ss_addr_port(&ss, &got, &port);
  CHECK("ss extract fam", fam == AF_INET);
  CHECK("ss extract addr", memcmp(&got.v4, &sin.sin_addr, 4) == 0);
  CHECK("ss extract port", port == sin.sin_port);
}

#ifndef _WIN32
/* ------------------------------------------------------------------ */
/* Live bm_splice over socketpairs — both directions + half-close EOF.  */
/*                                                                     */
/*   parent: A ----> B | splice | C ----> D   (A,B and C,D socketpairs) */
/*   write into A lands on D; write into D lands on A.                  */
/*   close A → B reads EOF → splice shutdown(C,WR) → D reads EOF;       */
/*   close D → C reads EOF → child exits 0.                             */
/* ------------------------------------------------------------------ */
static void test_splice_posix(void) {
  int ab[2], cd[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, ab) != 0 ||
      socketpair(AF_UNIX, SOCK_STREAM, 0, cd) != 0) {
    fprintf(stderr, "golden: FAIL socketpair errno=%d\n", errno);
    g_fails = 1;
    return;
  }
  pid_t pid = fork();
  if (pid == 0) {
    close(ab[0]);
    close(cd[1]);
    bm_splice(ab[1], cd[0]); /* returns when both directions die */
    _exit(0);
  }
  close(ab[1]);
  close(cd[0]);
  int A = ab[0], D = cd[1];

  static const char msg[] = "client→engine payload bytes \x00\x01\x02 binary";
  char rbuf[256];
  int ok = 1;

  /* A→D direction */
  if (write(A, msg, sizeof(msg)) != (ssize_t)sizeof(msg))
    ok = 0;
  ssize_t r = read(D, rbuf, sizeof(rbuf));
  if (r != (ssize_t)sizeof(msg) || memcmp(rbuf, msg, sizeof(msg)) != 0)
    ok = 0;
  CHECK("splice a→d bytes", ok);

  /* D→A direction */
  static const char msg2[] = "engine→client reply";
  memset(rbuf, 0, sizeof(rbuf));
  ok = (write(D, msg2, sizeof(msg2)) == (ssize_t)sizeof(msg2));
  r = read(A, rbuf, sizeof(rbuf));
  ok = ok && r == (ssize_t)sizeof(msg2) && memcmp(rbuf, msg2, sizeof(msg2)) == 0;
  CHECK("splice d→a bytes", ok);

  /* Half-close: closing A makes the splice shutdown(C,WR) → EOF on D,
   * while the D→A direction stays alive until D closes. */
  close(A);
  r = read(D, rbuf, sizeof(rbuf));
  CHECK("splice half-close eof", r == 0);

  close(D);
  int status = 0;
  waitpid(pid, &status, 0);
  CHECK("splice child clean exit", WIFEXITED(status) && WEXITSTATUS(status) == 0);
}
#endif /* !_WIN32 */

int main(void) {
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    fprintf(stderr, "golden: FAIL WSAStartup\n");
    return 1;
  }
#endif
  test_v4();
  test_v6();
  test_negatives();
#ifndef _WIN32
  test_splice_posix();
#endif
  printf("golden: %s\n", g_fails ? "FAIL" : "PASS");
  fflush(stdout);
  return g_fails;
}
