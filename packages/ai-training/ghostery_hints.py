#!/usr/bin/env python3
"""ghostery_hints.py — fetch Ghostery TrackerDB classifications for a domain
set, cached in ghostery_hints.json. DISPLAY-ONLY evidence for review.py.

License boundary: TrackerDB is CC-BY-NC-SA-4.0 — non-commercial, share-alike
(the repo says business use needs a license from sales@ghostery.com). So this
cache is a LOCAL consult artifact: gitignored, never committed, never merged
into labels.db, never shipped. It informs the human pressing 1/0; the
reviewer_label stays a human verdict.

Semantics boundary: a match means "this host resolves to <category>/<org>
per Ghostery's matching" — NOT "this endpoint tracks you". Ghostery's own
docs say domain matching is deliberately broad (a parent domain in the
pattern's domain list flags every subdomain), so each entry records
match_kind:

  host_filter  — a `||host^`-style network filter covers the queried host
                 (strongest signal: Ghostery asserts blocking traffic to it)
  domain_list  — the host sits under a domain listed on the pattern but no
                 filter covers it specifically (broad org attribution —
                 `weatherkit.apple.com` inherits Apple's iAds entry)
  unlisted     — no match (category null) — ABSENCE IS NOT BENIGN EVIDENCE,
                 it only means Ghostery hasn't catalogued the host
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HINTS_PATH = Path("ghostery_hints.json")
CLI = ["npx", "--yes", "@ghostery/trackerdb"]
TIMEOUT_S = 90
WORKERS = 8

_HOST_FILTER = re.compile(r"^\|\|([a-z0-9.-]+)\^")


def filter_covers(host: str, filters: list[str]) -> bool:
    """Does any `||h^`-style network filter cover `host`?"""
    for f in filters:
        m = _HOST_FILTER.match(f)
        if m:
            fd = m.group(1)
            if host == fd or host.endswith("." + fd):
                return True
    return False


def classify(host: str, payload: dict) -> dict:
    """Reduce a trackerdb CLI response to a hint record."""
    matches = payload.get("matches") or []
    if not matches:
        return {"category": None, "match_kind": "unlisted"}
    best, kind = matches[0], "domain_list"
    for m in matches:
        pat = m.get("pattern") or {}
        if host in (pat.get("domains") or []):
            best, kind = m, "domain_list"  # literal listing — still the pattern's own assertion
            break
        if filter_covers(host, pat.get("filters") or []):
            best, kind = m, "host_filter"
    pat = best.get("pattern") or {}
    cat = best.get("category") or {}
    org = best.get("organization") or {}
    return {
        "category": cat.get("key"),
        "category_name": cat.get("name"),
        "org": org.get("name"),
        "pattern": pat.get("name"),
        "match_kind": kind,
    }


def fetch_one(host: str) -> tuple[str, dict]:
    try:
        proc = subprocess.run(
            CLI + [f"https://{host}"], capture_output=True, text=True, timeout=TIMEOUT_S
        )
        out = proc.stdout.strip()
        # Non-JSON stdout is the CLI's "No matches found" path — honest unlisted.
        rec = classify(host, json.loads(out)) if out.startswith("{") else {
            "category": None, "match_kind": "unlisted",
        }
    except Exception as e:  # npx failure / timeout — record honestly
        rec = {"category": None, "match_kind": "unlisted", "error": str(e)[:120]}
    rec["fetched_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return host, rec


def load_cache() -> dict:
    return json.loads(HINTS_PATH.read_text()) if HINTS_PATH.exists() else {}


def fetch_domains(domains: list[str], cache: dict | None = None) -> dict:
    cache = cache if cache is not None else load_cache()
    # Refetch cached entries that errored (transient npx failures / parser bugs).
    todo = [d for d in domains if d not in cache or cache[d].get("error")]
    print(f"ghostery hints: {len(domains)} domains, {len(todo)} to fetch "
          f"({len(domains) - len(todo)} cached)")
    if not todo:
        return cache
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for host, rec in pool.map(fetch_one, todo):
            cache[host] = rec
            done += 1
            if done % 25 == 0:
                print(f"  …{done}/{len(todo)}")
    HINTS_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True))
    hits = sum(1 for r in cache.values() if r.get("category"))
    print(f"cached {len(cache)} -> {HINTS_PATH} ({hits} catalogued, "
          f"{len(cache) - hits} unlisted)")
    return cache


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--domains", nargs="*", default=[],
                    help="explicit domains; default is the review.py population")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    domains = list(dict.fromkeys(args.domains))
    if not domains:
        # Same population review.py would show — reuse its machinery verbatim.
        sys.path.insert(0, str(Path(__file__).parent))
        import lightgbm as lgb
        from review import build_population
        from train import load_featurizer

        class _A:
            log = str(Path.home() / "Library/Application Support/Blockingmachine/learned-shadow.jsonl")
            log_limit = 200_000
            fps = "test_fps.json"
            fps_limit = 102
            suspect_min = 0.3
            db = "labels.db"
            observations = "observations-2026-09-29.db"
            live_observations = "live_observations.db"
            artifacts = "model_artifacts_v3"
            model = "model_v3_experimental.json"

        a = _A()
        meta = json.loads(Path(a.model).read_text())
        _, _, featurize, _ = load_featurizer(3, a.observations, a.live_observations)
        booster = lgb.Booster(model_file=str(Path(a.artifacts) / "model.txt"))
        rows = build_population(a, featurize, booster,
                                meta.get("thresholds", {}).get("block", 0.92),
                                meta.get("thresholds", {}).get("review", 0.65))
        domains = sorted({r["domain"] for r in rows})

    if args.limit:
        domains = domains[: args.limit]
    fetch_domains(domains)


if __name__ == "__main__":
    main()
