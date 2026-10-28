"""Python mirror of `isPublicHostname` in packages/core/src/ai/hostname.ts.

The corpus boundary for every offline consumer of runtime streams
(`obs_ingest.py`, `shadow.py`, `tune_thresholds.py`): a name the serving
side refuses to score must not enter the training corpus, the review
queue, or the drift sample either. Keep these rules identical to the TS —
parity drift means the corpus sees names serving never will (that already
happened once: `_airplay._tcp.local` PTR records scored 0.996 block and
landed in learned-shadow.jsonl as fake disagreements).

Mirrors the *result* for bare hostnames — the TS version's URL-stripping
arms (scheme, credentials, path, port) never apply to the qnames and
ledger keys these streams carry, so this checks the label rules directly:
RFC 1123 labels (`[a-z0-9-]`, <=63 chars, no edge hyphens — underscores
fail here, which is what drops `_dmarc.`, `_sip._tls.` and every other
service name), at least one alphabetic character, non-numeric TLD (IPv4
literals fall under that rule, IPv6 can't be dotted), then the suffix list.
"""
from __future__ import annotations

import re

# Keep identical to NON_PUBLIC_SUFFIXES in hostname.ts.
NON_PUBLIC_SUFFIXES = (
    ".local", ".localhost", ".internal", ".invalid", ".example", ".test",
    ".arpa", ".lan", ".home", ".corp", ".localdomain",
)

_LABEL = re.compile(r"[a-z0-9-]+")


def is_public_name(domain: str) -> bool:
    """True when `domain` names a public internet hostname the model serves."""
    if not isinstance(domain, str):
        return False
    d = domain.strip().lower().strip(".")
    if not d or len(d) > 253 or "." not in d or ".." in d:
        return False
    labels = d.split(".")
    for lab in labels:
        if (
            not lab
            or len(lab) > 63
            or not _LABEL.fullmatch(lab)
            or lab.startswith("-")
            or lab.endswith("-")
        ):
            return False
    if not any(c.isalpha() for c in d):
        return False  # RFC 1123: at least one alphabetic character
    if labels[-1].isdigit():
        return False  # numeric TLD — IPv4 literals land here
    return not any(d.endswith(s) for s in NON_PUBLIC_SUFFIXES)
