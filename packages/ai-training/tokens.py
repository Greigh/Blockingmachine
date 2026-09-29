"""Token and TLD lists — Blockingmachine AI training pipeline (M1).

These lists are part of FEATURE_VERSION 1. Changing them changes
feature definitions: bump FEATURE_VERSION in features.py and
regenerate fixtures.json + bigram_table.json.
"""

# Advertising / tracking vocabulary commonly found in tracker domains.
# Matched as case-insensitive substrings against the full domain.
TOKEN_LIST = [
    "track", "pixel", "beacon", "sync", "match", "analytics",
    "impression", "telemetry", "fingerprint", "consent", "auction",
    "bid", "rtb", "dsp", "ssp", "adx", "ads", "advert", "promo",
    "banner", "popunder", "click", "conversion", "retarget",
    "segment", "audience", "visitor", "session", "metric",
    "collect", "ingest", "event", "tag", "container", "sdk",
    "meter", "counter", "log", "stat",
]

# v1 simplification: tld_rarity is binary (common vs not).
# A frequency-weighted version can replace this in v2.
COMMON_TLDS = {
    "com", "org", "net", "edu", "gov", "io", "dev", "app",
    "co", "us", "uk", "de", "fr", "nl", "ca", "au", "jp",
    "info", "biz", "me", "tv",
}

SUSPICIOUS_TLDS = {
    "xyz", "top", "click", "link", "loan", "win",
    "stream", "gdn", "country", "party", "review",
    "cricket", "date", "racing",
}
