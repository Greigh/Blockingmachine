"""M1 exit gate: do the lexical features separate trackers from benign?

Downloads EasyPrivacy (positives) and the Tranco top-10k (negatives),
featurizes a sample of each, and reports per-feature standardized
mean differences (Cohen's d). stdlib only.

    python separability.py [--pos 5000 --neg 5000]

If downloads fail (offline), falls back to an embedded mini sample
and says so loudly. The fallback is a smoke test, not evidence.
"""
from __future__ import annotations

import argparse
import math
import random
import statistics
import urllib.request
from pathlib import Path

from features import FEATURE_NAMES, featurize_vector

EASYPRIVACY_URL = "https://easylist.to/easylist/easyprivacy.txt"
TRANCO_URL = "https://tranco-list.eu/top-10k.csv"

# Offline fallback: tiny, hand-picked. Smoke test only.
FALLBACK_POS = [
    "pixel.track-analytics.xyz", "beacon.adnxs.com", "sync.mathtag.com",
    "cm.g.doubleclick.net", "track.adform.net", "www.google-analytics.com",
    "xkqzjw92mfn4.biz", "a1b2c3d4e5f64748.top", "ads.adthrive.com",
    "beacon.gu-web.net", "sync.search.spotxchange.com", "match.adsrvr.org",
]
FALLBACK_NEG = [
    "github.com", "google.com", "wikipedia.org", "amazon.com",
    "microsoft.com", "apple.com", "netflix.com", "stackoverflow.com",
    "python.org", "mozilla.org", "cloudflare.com", "stripe.com",
]


def _download(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "blockingmachine-m1/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def easyprivacy_domains(text: str) -> list[str]:
    domains = []
    for line in text.splitlines():
        if line.startswith("||"):
            host = line[2:].split("^")[0].split("/")[0]
            if host and "." in host and "*" not in host:
                domains.append(host.lower())
    return sorted(set(domains))


def tranco_domains(text: str) -> list[str]:
    domains = []
    for line in text.splitlines():
        parts = line.strip().split(",")
        if len(parts) >= 2 and parts[1]:
            domains.append(parts[1].strip().lower())
    return domains


def majestic_domains(text: str, limit: int = 10000) -> list[str]:
    """Majestic Million CSV: header is GlobalRank,TldRank,Domain,..."""
    domains = []
    for i, line in enumerate(text.splitlines()):
        if i == 0:
            continue  # header
        parts = line.split(",")
        if len(parts) >= 3 and parts[2]:
            domains.append(parts[2].strip().lower())
        if len(domains) >= limit:
            break
    return domains


def cohens_d(pos: list[float], neg: list[float]) -> float:
    mp, mn = statistics.fmean(pos), statistics.fmean(neg)
    sp = statistics.pstdev(pos) or 1e-9
    sn = statistics.pstdev(neg) or 1e-9
    pooled = math.sqrt((sp ** 2 + sn ** 2) / 2)
    return (mp - mn) / pooled


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pos", type=int, default=5000)
    ap.add_argument("--neg", type=int, default=5000)
    ap.add_argument("--pos-file", default=None,
                    help="local tracker list file (EasyPrivacy/AdGuard format)")
    ap.add_argument("--neg-file", default=None,
                    help="local benign list file (Majestic Million CSV)")
    args = ap.parse_args()
    rng = random.Random(42)

    if args.pos_file and args.neg_file:
        pos_all = easyprivacy_domains(Path(args.pos_file).read_text(errors="replace"))
        neg_all = majestic_domains(Path(args.neg_file).read_text(errors="replace"))
        print(f"local files: {len(pos_all)} tracker domains, {len(neg_all)} benign domains")
    else:
        try:
            pos_all = easyprivacy_domains(_download(EASYPRIVACY_URL))
            neg_all = tranco_domains(_download(TRANCO_URL))
            print(f"downloaded: {len(pos_all)} tracker domains, {len(neg_all)} benign domains")
        except Exception as e:  # noqa: BLE001 - offline fallback is intentional
            print(f"download failed ({e}); using embedded fallback sample (smoke test only)")
            pos_all, neg_all = FALLBACK_POS, FALLBACK_NEG

    pos = rng.sample(pos_all, min(args.pos, len(pos_all)))
    neg = rng.sample(neg_all, min(args.neg, len(neg_all)))

    pos_vecs = [featurize_vector(d) for d in pos]
    neg_vecs = [featurize_vector(d) for d in neg]

    rows = []
    for i, name in enumerate(FEATURE_NAMES):
        p = [v[i] for v in pos_vecs]
        n = [v[i] for v in neg_vecs]
        rows.append((name, statistics.fmean(p), statistics.fmean(n), cohens_d(p, n)))
    rows.sort(key=lambda r: abs(r[3]), reverse=True)

    print(f"\n{'feature':<22}{'mean(trk)':>10}{'mean(ok)':>10}{'d':>8}")
    for name, mp, mn, d in rows:
        print(f"{name:<22}{mp:>10.3f}{mn:>10.3f}{d:>+8.2f}")

    strong = sum(1 for r in rows if abs(r[3]) > 0.5)
    print(f"\n{strong}/{len(rows)} features with |d| > 0.5")
    if strong >= 5:
        print("GATE: PASS — features separate the classes; proceed to M2 (label store + training).")
    else:
        print("GATE: WEAK — features barely separate the classes; revisit feature definitions before M2.")


if __name__ == "__main__":
    main()
