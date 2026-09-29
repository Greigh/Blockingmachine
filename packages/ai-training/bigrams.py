"""Background character-bigram model for the bigram_anomaly feature.

Built from an embedded sample of benign domains with Laplace
smoothing over the full bigram space. Deterministic: the same
sample always produces the same table, in Python or in the
TypeScript port (export the table with `python bigrams.py`).

Part of FEATURE_VERSION 1: changing BENIGN_SAMPLE changes the
feature. Bump the version and regenerate everything.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-."

BENIGN_SAMPLE = [
    "github.com", "google.com", "youtube.com", "amazon.com",
    "microsoft.com", "apple.com", "wikipedia.org", "netflix.com",
    "stackoverflow.com", "python.org", "mozilla.org", "cloudflare.com",
    "stripe.com", "dropbox.com", "zoom.us", "slack.com",
    "reddit.com", "facebook.com", "instagram.com", "linkedin.com",
    "adobe.com", "salesforce.com", "shopify.com", "spotify.com",
    "airbnb.com", "uber.com", "lyft.com", "doordash.com",
    "nytimes.com", "bbc.co.uk", "cnn.com", "theguardian.com",
    "nasa.gov", "whitehouse.gov", "mit.edu", "stanford.edu",
    "harvard.edu", "arxiv.org", "docker.com", "kubernetes.io",
    "gitlab.com", "npmjs.com", "pypi.org", "crates.io",
    "rubygems.org", "golang.org", "rust-lang.org", "nodejs.org",
    "typescriptlang.org", "react.dev", "vuejs.org", "angular.io",
    "en.wikipedia.org", "docs.python.org", "support.apple.com",
    "cloud.google.com", "aws.amazon.com", "azure.microsoft.com",
]


def build_bigram_table(domains: list[str] = BENIGN_SAMPLE) -> dict[str, float]:
    """Return {bigram: log P(bigram)} with Laplace smoothing."""
    counts: dict[tuple[str, str], int] = {}
    for raw in domains:
        d = raw.strip().lower().rstrip(".")
        for a, b in zip(d, d[1:]):
            if a in ALPHABET and b in ALPHABET:
                counts[(a, b)] = counts.get((a, b), 0) + 1
    vocab = len(ALPHABET) ** 2
    total = sum(counts.values())
    table: dict[str, float] = {}
    for a in ALPHABET:
        for b in ALPHABET:
            c = counts.get((a, b), 0)
            table[a + b] = math.log((c + 1) / (total + vocab))
    return table


if __name__ == "__main__":
    out = Path(__file__).resolve().parent / "bigram_table.json"
    table = build_bigram_table()
    out.write_text(json.dumps(
        {"feature_version": 1, "alphabet": ALPHABET, "log_probs": table},
        indent=1,
    ))
    print(f"wrote {out} ({len(table)} bigrams)")
