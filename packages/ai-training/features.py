"""M1 lexical featurizer — Blockingmachine AI training pipeline.

Pure functions of the domain string. Standard library only.
Deterministic: same domain -> same vector, in any language port.

FEATURE_VERSION = 1. Changing ANY feature definition, the token
lists, or the bigram background sample changes the contract:
bump the version and regenerate fixtures.json + bigram_table.json.
"""
from __future__ import annotations

import ipaddress
import math
from collections import Counter

from bigrams import build_bigram_table
from tokens import COMMON_TLDS, SUSPICIOUS_TLDS, TOKEN_LIST

FEATURE_VERSION = 1

# Fixed order. This order is the contract: position i in the vector
# is FEATURE_NAMES[i], in Python and in the TypeScript port.
FEATURE_NAMES = [
    "len",                  # total domain length
    "label_depth",          # number of dot-separated labels
    "entropy",              # Shannon entropy of the domain string (bits)
    "digit_ratio",          # digits / len
    "hyphen_ratio",         # hyphens / len
    "tld_rarity",           # 0.0 if TLD in COMMON_TLDS else 1.0
    "bigram_anomaly",       # -mean log P(char bigram); larger = weirder
    "punycode",             # 1.0 if any label starts with xn--
    "ip_literal",           # 1.0 if the domain is an IP literal
    "token_hits",           # substring hits against TOKEN_LIST
    "token_density",        # token_hits / label_depth
    "max_label_len",        # longest single label
    "vowel_ratio",          # vowels / alphabetic chars
    "tld_suspicious",       # 1.0 if TLD in SUSPICIOUS_TLDS
    "max_digit_run_ratio",  # longest run of digits / len
]

_VOWELS = set("aeiou")

_bigram_table: dict[str, float] | None = None


def _table() -> dict[str, float]:
    global _bigram_table
    if _bigram_table is None:
        _bigram_table = build_bigram_table()
    return _bigram_table


def _normalize(domain: str) -> str:
    d = domain.strip().lower().rstrip(".")
    if not d:
        raise ValueError("empty domain")
    return d


def featurize(domain: str) -> dict[str, float]:
    """Return {feature_name: value} for one domain."""
    d = _normalize(domain)
    n = len(d)
    labels = d.split(".")
    tld = labels[-1]

    counts = Counter(d)
    entropy = -sum((c / n) * math.log2(c / n) for c in counts.values())

    digits = sum(ch.isdigit() for ch in d)
    alpha = sum(ch.isalpha() for ch in d)
    vowels = sum(ch in _VOWELS for ch in d)

    longest = cur = 0
    for ch in d:
        cur = cur + 1 if ch.isdigit() else 0
        longest = max(longest, cur)

    token_hits = sum(d.count(t) for t in TOKEN_LIST)

    table = _table()
    logps = [table[a + b] for a, b in zip(d, d[1:]) if a + b in table]
    bigram_anomaly = -sum(logps) / len(logps) if logps else 0.0

    try:
        ipaddress.ip_address(d)
        ip_literal = 1.0
    except ValueError:
        ip_literal = 0.0

    return {
        "len": float(n),
        "label_depth": float(len(labels)),
        "entropy": entropy,
        "digit_ratio": digits / n,
        "hyphen_ratio": d.count("-") / n,
        "tld_rarity": 0.0 if tld in COMMON_TLDS else 1.0,
        "bigram_anomaly": bigram_anomaly,
        "punycode": 1.0 if any(lbl.startswith("xn--") for lbl in labels) else 0.0,
        "ip_literal": ip_literal,
        "token_hits": float(token_hits),
        "token_density": token_hits / len(labels),
        "max_label_len": float(max(len(lbl) for lbl in labels)),
        "vowel_ratio": (vowels / alpha) if alpha else 0.0,
        "tld_suspicious": 1.0 if tld in SUSPICIOUS_TLDS else 0.0,
        "max_digit_run_ratio": longest / n,
    }


def featurize_vector(domain: str) -> list[float]:
    """Return the feature vector in FEATURE_NAMES order."""
    f = featurize(domain)
    return [f[name] for name in FEATURE_NAMES]
