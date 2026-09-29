"""Generate fixtures.json: domains with their expected feature vectors.

These fixtures are the cross-language contract. The TypeScript port
of the featurizer must reproduce these vectors within 1e-9.
Regenerate after ANY feature definition change:

    python make_fixtures.py
"""
from __future__ import annotations

import json
from pathlib import Path

from features import FEATURE_NAMES, FEATURE_VERSION, featurize_vector

# Deliberately varied: benign, trackers, DGA-ish, punycode, IP,
# deep subdomains, hyphen-stuffed. A port that passes all of these
# is a faithful port.
DOMAINS = [
    # benign
    "github.com",
    "en.wikipedia.org",
    "api.stripe.com",
    "mail.google.com",
    "cdn.jsdelivr.net",
    "login.microsoftonline.com",
    "a.b.c.d.e.f.example.com",
    # trackers / adtech
    "pixel.track-analytics.xyz",
    "beacon.adnxs.com",
    "sync.mathtag.com",
    "cm.g.doubleclick.net",
    "track.adform.net",
    "www.google-analytics.com",
    "insights-collector.newrelic.com",
    # suspicious / DGA-ish
    "xkqzjw92mfn4.biz",
    "a1b2c3d4e5f64748.top",
    "free-best-deals-online-click-now.info",
    "tr4ck-p1xel-s3cure-payments-update.net",
    "verylongsubdomainnamewithlotsofcharacters12345.example.com",
    # edge cases
    "xn--pple-43d.com",
    "93.184.216.34",
    "com",
    "x.io",
]


def main() -> None:
    fixtures = [
        {"domain": d, "vector": featurize_vector(d)} for d in DOMAINS
    ]
    out = Path(__file__).resolve().parent / "fixtures.json"
    out.write_text(json.dumps(
        {
            "feature_version": FEATURE_VERSION,
            "feature_names": FEATURE_NAMES,
            "fixtures": fixtures,
        },
        indent=1,
    ))
    print(f"wrote {out} ({len(fixtures)} fixtures)")


if __name__ == "__main__":
    main()
