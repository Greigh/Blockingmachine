"""Golden benign set — domains the model must NEVER flag.

The eval gate fails if any of these scores at or above the review
threshold. Curated by hand: banks, SSO, CDNs, gov/edu, and major
benign services. These are excluded from training data.
"""

GOLDEN_BENIGN = [
    # banks / finance
    "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com",
    "usbank.com", "capitalone.com", "americanexpress.com", "discover.com",
    "schwab.com", "fidelity.com", "vanguard.com", "paypal.com",
    # SSO / identity
    "login.microsoftonline.com", "accounts.google.com", "login.yahoo.com",
    "appleid.apple.com", "okta.com",
    # CDN / infrastructure
    "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "unpkg.com",
    "ajax.googleapis.com", "code.jquery.com", "fonts.googleapis.com",
    "fonts.gstatic.com", "cloudflare.com", "akamaihd.net", "fastly.net",
    # gov / edu
    "nasa.gov", "whitehouse.gov", "mit.edu", "stanford.edu",
    "harvard.edu", "nih.gov", "cdc.gov", "who.int",
    # big tech / dev
    "github.com", "gitlab.com", "stackoverflow.com", "python.org",
    "npmjs.com", "pypi.org", "docker.com", "mozilla.org",
    "wikipedia.org", "en.wikipedia.org", "apple.com", "microsoft.com",
    "google.com", "amazon.com", "cloud.google.com", "aws.amazon.com",
    # news
    "nytimes.com", "bbc.co.uk", "cnn.com", "theguardian.com", "reuters.com",
    # commerce / work
    "ebay.com", "etsy.com", "shopify.com", "stripe.com", "api.stripe.com",
    "slack.com", "zoom.us", "dropbox.com", "docs.google.com",
    "outlook.office.com",
    # health
    "mayoclinic.org",
]
