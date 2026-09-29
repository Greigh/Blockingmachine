"""Fill cname_depth for observations where system DNS failed.

The sandbox has no working UDP resolver, so this resolves CNAME
chains over DNS-over-HTTPS (Cloudflare) through the normal HTTP
proxy instead. Run after crawl.py:

    .venv/bin/python cname_fill.py --db observations-2026-09-29.db

Only touches rows where cname_depth IS NULL. Safe to re-run.
"""
from __future__ import annotations

import argparse
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor

import requests

DOH = "https://cloudflare-dns.com/dns-query"
HEADERS = {"accept": "application/dns-json"}
TYPE_CNAME = 5


def doh_cname(name: str, session: requests.Session) -> str | None:
    """The single CNAME target of `name`, or None if it has none."""
    r = session.get(DOH, params={"name": name, "type": "CNAME"},
                    headers=HEADERS, timeout=10)
    r.raise_for_status()
    j = r.json()
    if j.get("Status") != 0:
        return None
    for a in j.get("Answer", []):
        if a.get("type") == TYPE_CNAME:
            return str(a["data"]).rstrip(".")
    return None


def cname_depth_doh(domain: str, session: requests.Session, max_hops: int = 5) -> int | None:
    name, depth = domain, 0
    try:
        while depth < max_hops:
            target = doh_cname(name, session)
            if not target:
                break
            name, depth = target, depth + 1
        return depth
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    domains = [r[0] for r in
               con.execute("SELECT domain FROM observations WHERE cname_depth IS NULL")]
    print(f"{len(domains)} domains need cname_depth")
    if not domains:
        return

    session = requests.Session()
    session.headers["User-Agent"] = "BlockingmachineAI-Research/1.0 (DNS-over-HTTPS CNAME fill)"
    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for domain, depth in zip(domains, ex.map(
                lambda d: cname_depth_doh(d, session), domains)):
            con.execute("UPDATE observations SET cname_depth=? WHERE domain=?",
                        (depth, domain))
            done += 1
            if done % 100 == 0:
                con.commit()
                print(f"  {done}/{len(domains)} ({time.time()-t0:.0f}s)")
    con.commit()
    n = con.execute(
        "SELECT COUNT(*) FROM observations WHERE cname_depth IS NOT NULL"
    ).fetchone()[0]
    npos = con.execute(
        "SELECT COUNT(*) FROM observations WHERE cname_depth > 0"
    ).fetchone()[0]
    print(f"done: {n} rows have cname_depth, {npos} with chain > 0")
    con.close()


if __name__ == "__main__":
    main()
