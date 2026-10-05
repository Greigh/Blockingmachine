"""Constants for the Blockingmachine integration."""

DOMAIN = "blockingmachine"
DEFAULT_NAME = "Blockingmachine"
DEFAULT_PORT = 9191
DEFAULT_HOST = "127.0.0.1"
DEFAULT_SCAN_INTERVAL = 30

CONF_HOST = "host"
CONF_PORT = "port"
CONF_SCAN_INTERVAL = "scan_interval"
# The optional bearer token both servers accept on their guarded endpoints — the add-on
# gates its whole surface behind `feed_token` when one is configured, and the desktop
# app's `feedToken` gates its mutations, so a hub that asks for a token cannot even be
# validated without a field to put it in.
CONF_TOKEN = "token"

ATTR_TOTAL_RULES = "total_rules"
ATTR_DNS_RULES = "dns_rules"
ATTR_BROWSER_RULES = "browser_rules"
ATTR_QUARANTINE_COUNT = "quarantine_count"
ATTR_LAST_COMPILE = "last_compile"
ATTR_UPTIME = "uptime_seconds"
ATTR_FEED_URL = "feed_url"

SERVICE_COMPILE = "compile"
SERVICE_CHECK_DOMAIN = "check_domain"
