"""M4 observation crawler — Blockingmachine AI training pipeline.

Collects real HTTP/TLS/DNS observations for a sample of labeled
domains and stores them in observations.db. These become the
behavioral + graph features (v2) in features2.py.

Polite by design: 4 concurrent workers, 10s timeouts, identifiable
User-Agent, first 200KB of body only, no JS execution. A domain that
fails to fetch is DATA (fetch_error), not a bug — dead ad servers
are a fact of life in this corpus.

    .venv/bin/python crawl.py --db observations.db --labels labels.db \\
        --per-class 400 --seed 42

Schema (observations):
    domain TEXT PRIMARY KEY, observed_at TEXT,
    https_ok INTEGER, http_status INTEGER, redirect_count INTEGER,
    redirects_cross_tld INTEGER, set_cookie INTEGER, cookie_count INTEGER,
    body_bytes INTEGER, body_kw_hits INTEGER, cert_free_ca INTEGER,
    tls_error TEXT, cname_depth INTEGER, fetch_error TEXT
"""
from __future__ import annotations

import argparse
import random
import socket
import sqlite3
import ssl
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import dns.exception
import dns.resolver
import requests

from tokens import TOKEN_LIST

UA = "BlockingmachineAI-Research/1.0 (academic tracker-pattern research; contact: daniel@greighstudios.com)"
TIMEOUT = 10
BODY_LIMIT = 200_000
BODY_KEYWORDS = TOKEN_LIST + ["fingerprint", "canvas", "webgl", "evercookie"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
  domain TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  https_ok INTEGER,
  http_status INTEGER,
  redirect_count INTEGER,
  redirects_cross_tld INTEGER,
  set_cookie INTEGER,
  cookie_count INTEGER,
  body_bytes INTEGER,
  body_kw_hits INTEGER,
  cert_free_ca INTEGER,
  cname_depth INTEGER,
  fetch_error TEXT
);
"""

_session: requests.Session | None = None


def session() -> requests.Session:
    global _session
    if _session is None:
        s = requests.Session()
        s.headers["User-Agent"] = UA
        _session = s
    return _session


def registrable(host: str) -> str:
    parts = host.lower().split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host.lower()


def blank_obs(domain: str) -> dict:
    return {
        "domain": domain,
        "https_ok": None, "http_status": None, "redirect_count": None,
        "redirects_cross_tld": None, "set_cookie": None, "cookie_count": None,
        "body_bytes": None, "body_kw_hits": None, "cert_free_ca": None,
        "cname_depth": None, "fetch_error": "unobserved",
    }


def fetch_domain(domain: str) -> dict:
    """Probe https then http; return observation dict (NaN-able fields as None)."""
    obs: dict = {
        "domain": domain,
        "https_ok": 0, "http_status": None, "redirect_count": 0,
        "redirects_cross_tld": 0, "set_cookie": 0, "cookie_count": 0,
        "body_bytes": 0, "body_kw_hits": 0, "cert_free_ca": None,
        "fetch_error": None,
    }
    resp = None
    for scheme in ("https", "http"):
        try:
            resp = session().get(
                f"{scheme}://{domain}/", timeout=TIMEOUT,
                allow_redirects=True, stream=True,
            )
            # Drain up to BODY_LIMIT for keyword analysis. raw.read can
            # raise urllib3 errors (e.g. IncompleteRead) that requests
            # does NOT wrap — catch broadly and keep partial bytes.
            try:
                body = resp.raw.read(BODY_LIMIT, decode_content=True) or b""
            except Exception as e:
                body = getattr(e, "partial", b"") or b""
            resp.close()
            break
        except Exception as e:
            obs["fetch_error"] = f"{scheme}:{type(e).__name__}"
            continue
    if resp is None:
        return obs

    obs["fetch_error"] = None
    obs["http_status"] = resp.status_code
    if resp.url.startswith("https://"):
        obs["https_ok"] = 1 if resp.status_code < 400 else 0
    chain = [r.url for r in resp.history] + [resp.url]
    obs["redirect_count"] = len(resp.history)
    base = registrable(urlparse(chain[0]).hostname or domain)
    obs["redirects_cross_tld"] = int(
        any(registrable(urlparse(u).hostname or "") != base for u in chain[1:])
    )
    try:
        cookies = resp.raw.headers.getlist("Set-Cookie")  # type: ignore[union-attr]
    except Exception:
        cookies = []
    obs["cookie_count"] = len(cookies)
    obs["set_cookie"] = int(len(cookies) > 0)
    try:
        text = body.decode("utf-8", errors="ignore").lower()
    except Exception:
        text = ""
    obs["body_bytes"] = len(body)
    obs["body_kw_hits"] = sum(text.count(k) for k in BODY_KEYWORDS)
    return obs


def check_cert(domain: str) -> int | None:
    """1 if the TLS cert comes from a free CA, 0 otherwise, None on failure."""
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((domain, 443), timeout=5) as sock:
            with ctx.wrap_socket(sock, server_hostname=domain) as ssock:
                issuer = str(ssock.getpeercert().get("issuer", "")).lower()
        return int("let's encrypt" in issuer or "zerossl" in issuer)
    except Exception:
        return None


_resolver: dns.resolver.Resolver | None = None


def cname_depth(domain: str, max_hops: int = 5) -> int | None:
    """Length of the CNAME chain; 0 if none; None on resolution failure."""
    global _resolver
    if _resolver is None:
        _resolver = dns.resolver.Resolver()
        _resolver.lifetime = 3
        _resolver.timeout = 3
    name, depth = domain, 0
    try:
        while depth < max_hops:
            try:
                ans = _resolver.resolve(name, "CNAME")
            except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN,
                    dns.resolver.NoNameservers):
                break
            name = str(ans[0].target).rstrip(".")
            depth += 1
        return depth
    except dns.exception.DNSException:
        return None


def observe(domain: str) -> dict:
    """One domain, never throws — a poisoned domain must not kill the crawl."""
    try:
        obs = fetch_domain(domain)
    except Exception as e:
        obs = blank_obs(domain)
        obs["fetch_error"] = f"observe:{type(e).__name__}"
        obs["observed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return obs
    try:
        obs["cert_free_ca"] = check_cert(domain)
    except Exception:
        obs["cert_free_ca"] = None
    try:
        obs["cname_depth"] = cname_depth(domain)
    except Exception:
        obs["cname_depth"] = None
    obs["observed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return obs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="observations.db")
    ap.add_argument("--labels", default="labels.db")
    ap.add_argument("--per-class", type=int, default=400)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--resume", action="store_true",
                    help="skip domains already present in the observations db")
    args = ap.parse_args()

    con = sqlite3.connect(args.labels)
    pos = [r[0] for r in con.execute("SELECT domain FROM labels WHERE label=1")]
    neg = [r[0] for r in con.execute("SELECT domain FROM labels WHERE label=0")]
    con.close()
    rng = random.Random(args.seed)
    sample = rng.sample(pos, min(args.per_class, len(pos))) + \
        rng.sample(neg, min(args.per_class, len(neg)))
    rng.shuffle(sample)
    print(f"crawling {len(sample)} domains with {args.workers} workers...")

    ocon = sqlite3.connect(args.db)
    ocon.executescript(SCHEMA)
    if args.resume:
        seen = {r[0] for r in ocon.execute("SELECT domain FROM observations")}
        sample = [d for d in sample if d not in seen]
        print(f"resume: {len(seen)} already observed, {len(sample)} remaining")
    done = errors = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for obs in ex.map(observe, sample):
            ocon.execute(
                """INSERT INTO observations VALUES
                   (:domain, :observed_at, :https_ok, :http_status,
                    :redirect_count, :redirects_cross_tld, :set_cookie,
                    :cookie_count, :body_bytes, :body_kw_hits,
                    :cert_free_ca, :cname_depth, :fetch_error)
                   ON CONFLICT(domain) DO UPDATE SET
                     observed_at=excluded.observed_at, https_ok=excluded.https_ok,
                     http_status=excluded.http_status,
                     redirect_count=excluded.redirect_count,
                     redirects_cross_tld=excluded.redirects_cross_tld,
                     set_cookie=excluded.set_cookie,
                     cookie_count=excluded.cookie_count,
                     body_bytes=excluded.body_bytes,
                     body_kw_hits=excluded.body_kw_hits,
                     cert_free_ca=excluded.cert_free_ca,
                     cname_depth=excluded.cname_depth,
                     fetch_error=excluded.fetch_error""",
                obs,
            )
            done += 1
            if obs["fetch_error"]:
                errors += 1
            if done % 100 == 0:
                ocon.commit()
                print(f"  {done}/{len(sample)} ({time.time()-t0:.0f}s, {errors} fetch errors)")
    ocon.commit()
    n = ocon.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
    ocon.close()
    print(f"done: {n} observations in {time.time()-t0:.0f}s ({errors} fetch errors)")


if __name__ == "__main__":
    main()
