export const DEFAULT_FEED_URL = 'http://127.0.0.1:9191/browser.txt';
/** Port the desktop hub and Home Assistant add-on serve on (matches the feed). */
export const DEFAULT_HUB_PORT = 9191;
export const DEFAULT_CHECK_ENDPOINT = 'http://127.0.0.1:9191/v1/check';
export const DEFAULT_SSE_ENDPOINT = 'http://127.0.0.1:9191/v1/events';
export const DEFAULT_HA_URL = 'http://homeassistant.local:8123';
export const STORAGE_KEY_SETTINGS = 'bm_settings';
export const STORAGE_KEY_WHITELIST = 'bm_whitelist';
export const STORAGE_KEY_CUSTOM_RULES = 'bm_custom_rules';
export const STORAGE_KEY_COSMETICS = 'bm_cosmetics';
export const STORAGE_KEY_USER_COSMETICS = 'bm_user_cosmetics';
export const STORAGE_KEY_HA_CONFIG = 'bm_ha_config';
export const STORAGE_KEY_COSMETICS_ENABLED = 'bm_cosmetics_enabled';
export const STORAGE_KEY_SITE_CONTROL = 'bm_site_control';
/** Element Mini-AI user corrections: signature → bias (-1 keep, +1 hide). */
export const STORAGE_KEY_ELEMENT_AI_FEEDBACK = 'bm_element_ai_feedback';
/** Which static DeclarativeNetRequest ruleset tiers the user has enabled. */
export const STORAGE_KEY_STATIC_TIERS = 'bm_static_tiers';
/**
 * When the compiled list was last fetched.
 *
 * Stored because it is a fact about the profile rather than about the service worker that observed
 * it. The rules themselves are read back from the browser (`getDynamicRules`) rather than stored —
 * they are browser state and the browser already holds them — but a timestamp has no browser-side
 * equivalent, and without it the popup reports "never synced" beside a rule count that is plainly
 * not zero.
 */
export const STORAGE_KEY_LAST_SYNC_AT = 'bm_last_sync_at';
/** Per-rule match counts gathered from real browsing, for coverage analysis. */
export const STORAGE_KEY_RULE_HITS = 'bm_rule_hits';
/** Which shipped static tier produced each block, so a tier can be judged on real traffic. */
export const STORAGE_KEY_TIER_HITS = 'bm_tier_hits';
/** Distinct rules tracked before the one-off long tail is dropped. */
export const RULE_HIT_MAX_TRACKED = 5000;
/** Matches to accumulate before writing the counts back to storage. */
export const RULE_HIT_FLUSH_EVERY = 25;

/**
 * DNR priorities. The 1–4 range is used for rules derived from synced
 * blocklists (block/exception × normal/important). Everything the *user* asks
 * for deliberately outranks that range so an explicit decision always wins.
 */
export const PRIORITY_BLOCK = 1;
export const PRIORITY_EXCEPTION = 2;
export const PRIORITY_IMPORTANT_BLOCK = 3;
export const PRIORITY_IMPORTANT_EXCEPTION = 4;
/** A domain the user explicitly allowed. */
export const PRIORITY_USER_ALLOW = 500;
/** A site the user paused — allows the matched frame and everything it requests. */
export const PRIORITY_SITE_PAUSE = 1000;
