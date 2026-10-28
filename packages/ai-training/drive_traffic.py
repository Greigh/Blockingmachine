"""Drive real DNS traffic through a headless systemDaemon — flag 43 evidence.

The v3 live features (dns_seen, cname_depth, cname_foreign, nxdomain_rate,
ttl_min, latency) only ever learned from one organic daemon observation.
Waiting for the app to accrue coverage takes weeks; this tool accrues the
*same record kind* in minutes by running the real daemon bundle headless
and issuing one real A query per domain through it.

Honesty contract — what this is and is not:
  * Every record is written by the real observationRecorder code path from a
    real upstream resolution: verdict (real feed), cname chain, ttl, latency,
    rcode are network facts, not synthesized values.
  * The *population* is tool-driven, not organic browsing — documented in the
    flag/wiki; it must never be presented as organic traffic.
  * Each domain is queried exactly once so dns_query_count stays an honest 1
    — no fabricated popularity signal.
  * The shadow log is NOT touched: its provenance is the Electron app's
    shadow scorer, which a headless driver cannot truthfully produce.

Usage:
  python drive_traffic.py --queue review_queue.csv --fps test_fps.json --sample 500
  python obs_ingest.py --db live_observations.db --dns <observations file>
"""

import argparse
import json
import os
import random
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from public_names import is_public_name  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent
DEFAULT_DAEMON = REPO / "packages/electron-app/.webpack/main/systemDaemon.cjs"
DEFAULT_OBS = Path.home() / "Library/Application Support/Blockingmachine/dns-observations.jsonl"
# Quad9's DoH endpoint rejected the daemon's wire format in rehearsal
# (HTTP 505 / 400); Cloudflare serves RFC 8484 at this path. Overridable —
# the upstream is a CLI choice, not a behavior change.
DEFAULT_UPSTREAM = "https://cloudflare-dns.com/dns-query"


def dns_query_packet(domain: str, qid: int) -> bytes:
    """Minimal RFC 1035 A-record query — what dig would send."""
    header = struct.pack(">HHHHHH", qid & 0xFFFF, 0x0100, 1, 0, 0, 0)
    qname = b"".join(
        bytes([len(p)]) + p.encode("ascii", "replace") for p in domain.split(".")
    ) + b"\x00"
    return header + qname + struct.pack(">HH", 1, 1)


def build_feed(db_path: Path, out: Path) -> int:
    """Compile the label store's positives into an ABP feed — the same
    AdGuard-derived blocklist semantics the production feed carries."""
    con = sqlite3.connect(db_path)
    doms = [r[0] for r in con.execute("SELECT DISTINCT domain FROM labels WHERE label=1")]
    con.close()
    with open(out, "w") as f:
        for d in sorted(doms):
            f.write(f"||{d}^\n")
    return len(doms)


def collect_domains(args) -> list[str]:
    seen: dict[str, None] = {}

    def add(d: str):
        d = d.strip().lower().rstrip(".")
        if d and is_public_name(d):
            seen.setdefault(d)

    if args.queue:
        import csv
        for rec in csv.DictReader(open(args.queue, newline="")):
            add(rec.get("domain", ""))
    if args.fps and Path(args.fps).exists():
        for rec in json.loads(Path(args.fps).read_text()):
            add(rec["domain"])
    if args.domains:
        for line in Path(args.domains).read_text().splitlines():
            add(line)
    if args.sample or args.all:
        con = sqlite3.connect(args.db)
        pool = [r[0] for r in con.execute("SELECT DISTINCT domain FROM labels")]
        con.close()
        rng = random.Random(42)
        rng.shuffle(pool)
        take = pool if args.all else pool[: args.sample]
        for d in take:
            add(d)
    if args.skip_observed:
        con = sqlite3.connect(args.live_db)
        try:
            observed = {r[0] for r in con.execute("SELECT domain FROM dns_events")}
        except sqlite3.OperationalError:
            observed = set()  # no live store yet — nothing to skip
        con.close()
        before = len(seen)
        for d in observed:
            seen.pop(d, None)
        print(f"skip-observed: {before - len(seen)} already in live store")
    return list(seen)


def wait_for_listen(proc: subprocess.Popen, log_lines: list[str], timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("daemon exited during startup:\n" + "".join(log_lines[-20:]))
        if any("Listening on" in line for line in log_lines):
            return
        time.sleep(0.1)
    raise RuntimeError("daemon did not bind within timeout:\n" + "".join(log_lines[-20:]))


def drive(domains: list[str], port: int, qps: float, timeout: float) -> tuple[int, int]:
    """One A query per domain at ~qps. Returns (answered, attempted)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(min(timeout, 1.0 / qps if qps > 0 else timeout))
    answered = 0
    for i, d in enumerate(domains):
        try:
            sock.sendto(dns_query_packet(d, i), ("127.0.0.1", port))
            data, _ = sock.recvfrom(4096)
            if data:
                answered += 1
        except socket.timeout:
            pass
        except OSError:
            pass
        if (i + 1) % 200 == 0:
            print(f"  …{i + 1}/{len(domains)} ({answered} answered)", flush=True)
    sock.close()
    return answered, len(domains)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--daemon", default=str(DEFAULT_DAEMON), help="systemDaemon.cjs bundle")
    ap.add_argument("--node", default="node")
    ap.add_argument("--dns-port", type=int, default=15399)
    ap.add_argument("--control-port", type=int, default=19293)
    ap.add_argument("--observations", default=str(DEFAULT_OBS),
                    help="records append here — default is the real dns-observations stream")
    ap.add_argument("--upstream", default=DEFAULT_UPSTREAM)
    ap.add_argument("--feed", default=None, help="ABP feed file; default builds one from --db positives")
    ap.add_argument("--db", default="labels.db")
    ap.add_argument("--live-db", default="live_observations.db",
                    help="for --skip-observed")
    ap.add_argument("--skip-observed", action="store_true",
                    help="drop domains already in the live store — for repeat drives")
    ap.add_argument("--queue", default="review_queue.csv", help="include these domains first")
    ap.add_argument("--fps", default="test_fps.json", help="include candidate FPs")
    ap.add_argument("--sample", type=int, default=500, help="random labeled domains (seed 42)")
    ap.add_argument("--all", action="store_true", help="query the entire labeled pool")
    ap.add_argument("--domains", default=None, help="extra newline-separated domain file")
    ap.add_argument("--qps", type=float, default=10.0)
    ap.add_argument("--timeout", type=float, default=2.0, help="per-query response wait (s)")
    ap.add_argument("--limit", type=int, default=0, help="cap total queries (0 = no cap)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    domains = collect_domains(args)
    if args.limit:
        domains = domains[: args.limit]
    print(f"domains to query: {len(domains)} "
          f"(queue/fps first, deduped, public-name filtered)")
    if args.dry_run:
        for d in domains[:50]:
            print(" ", d)
        print("  …" if len(domains) > 50 else "")
        return

    feed_path = Path(args.feed) if args.feed else None
    tmp = None
    if feed_path is None:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, prefix="bm-drive-feed-")
        n = build_feed(Path(args.db), Path(tmp.name))
        tmp.close()
        feed_path = Path(tmp.name)
        print(f"feed: {n} rules compiled from {args.db} positives -> {feed_path}")

    obs_path = Path(args.observations)
    before = sum(1 for _ in open(obs_path)) if obs_path.exists() else 0

    env = dict(os.environ)
    env.update({
        "DNS_PORT": str(args.dns_port),
        "CONTROL_PORT": str(args.control_port),
        "OBSERVATIONS_FILE": str(obs_path),
        "FEED_FILE": str(feed_path),
        "FEED_URL": "http://127.0.0.1:1/none.txt",  # force the file path — no hub here
        "UPSTREAM_DOH": args.upstream,
    })
    daemon = Path(args.daemon)
    if not daemon.exists():
        sys.exit(f"daemon bundle not found: {daemon} (build electron-app first)")

    proc = subprocess.Popen(
        [args.node, str(daemon)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    log_lines: list[str] = []
    try:
        # Pump stdout in the foreground loop until the bind line lands.
        import threading
        def pump():
            for line in proc.stdout:
                log_lines.append(line)
        t = threading.Thread(target=pump, daemon=True)
        t.start()
        wait_for_listen(proc, log_lines)
        print(f"daemon up on 127.0.0.1:{args.dns_port} — driving {len(domains)} queries @ ~{args.qps}/s")

        answered, attempted = drive(domains, args.dns_port, args.qps, args.timeout)
        print(f"queries: {answered}/{attempted} answered "
              f"(time-outs still get recorded — the daemon logs on receipt)")
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
        if tmp:
            os.unlink(tmp.name)

    time.sleep(0.5)  # let the recorder flush
    after = sum(1 for _ in open(obs_path)) if obs_path.exists() else before
    print(f"observations: {before} -> {after} (+{after - before} records in {obs_path})")
    print("next: .venv/bin/python obs_ingest.py --db live_observations.db "
          f"--dns \"{obs_path}\" --fanout \"$HOME/Library/Application Support/Blockingmachine/browser-fanout.json\"")


if __name__ == "__main__":
    main()
