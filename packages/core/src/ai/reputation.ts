import { normalizeHostname } from './hostname.js';
export { normalizeHostname } from './hostname.js';
import { calculateShannonEntropy, decomposeDomain } from './entropy.js';
import type {
  AntiAdblockDetection,
  CategoryAdjustment,
  InfraClassification,
  InfraKind,
  ReputationFeatures,
  ThreatCategory,
} from './types.js';

/**
 * Registrable-domain and hostname-suffix reputation for the embedded classifier.
 * Suffix groups are the maintenance point: add a parent zone, not one-off hosts.
 * @beta
 */

export const HIGH_ABUSE_TLDS = new Set([
  'top', 'xyz', 'buzz', 'click', 'fit', 'rest', 'tk', 'cf', 'gq', 'ml', 'ga',
  'work', 'cam', 'surf', 'loan', 'racing', 'icu', 'gdn', 'vip', 'monster',
  'country', 'stream', 'date', 'faith', 'review', 'download', 'trade', 'webcam',
  'win', 'men', 'party', 'science', 'cricket', 'accountant', 'mom', 'sbs',
  'cfd', 'skin', 'quest', 'beauty', 'hair', 'makeup', 'cyou', 'best', 'boats',
  'bond', 'casa', 'lol', 'bid',
]);

/** Delimited ad-tech tokens. Short or generic words match only on label boundaries. */
export const SUSPICIOUS_AD_TOKENS = [
  // Core ad-serving tokens
  'ads', 'adserver', 'adservice', 'adnxs', 'adform', 'adtech',
  'doubleclick', 'googleadservices', 'googlesyndication', 'moatads', 'amazon-adsystem',
  // Programmatic / RTB
  'bidder', 'bidding', 'prebid', 'openrtb', 'adkernel', 'adman', 'yieldlove',
  'appnexus', 'indexexchange', 'triplelift', 'sharethrough', 'teads', 'spotx',
  'spotxchange', 'gumgum', 'undertone', 'yieldmo', 'sovrn', 'emxdigital',
  'conversantmedia', 'exponential', 'mediavine', 'monetizemore', 'rocketfuel',
  // Mobile ad SDKs
  'smartclip', 'connatix', 'applovin', 'unityads', 'ironsrc', 'vungle', 'mintegral',
  'adcolony', 'chartboost', 'liftoff', 'inmobi', 'admob', 'adbuddiz', 'tapjoy',
  'fyber', 'digitalturbine', 'flurryads', 'loopme', 'ogury', 'tradplus', 'applovinmax',
  // Pop/push / native
  'popunder', 'popcash', 'propeller', 'propellerads', 'outbrain', 'taboola', 'mgid',
  'revcontent', 'gravity', 'nativo', 'pangle', 'zergnet', 'yahoodsp',
  // Header bidding / SSP / DSP / DMP
  'criteo', 'pubmatic', 'rubiconproject', 'openx', 'casalemedia', 'smartadserver',
  'springserve', 'smaato', 'adsrvr', 'tradedesk', 'thetradedesk', 'mediamath',
  'dataxu', 'dv360', 'amobee', 'beeswax', 'stackadapt', 'choozle', 'basis',
  // Generic ad tokens
  'adsystem', 'adtrack', 'advert', 'advertising', 'adzerk', 'adblade',
  'adroll', 'adsterra', 'adhese', 'adthink', 'adthrive', 'advertserve',
  'adpushup', 'adprime', 'adrecovery', 'adfox', 'adfrontiers', 'adglare',
  'aniview', 'spotscaler', 'brid', 'vidazoo', 'jwplatformads', 'minutemedia',
] as const;

/**
 * Tracker tokens. Ambiguous words ('stats', 'counter', 'click', 'branch', 'adjust', 'segment')
 * are excluded as they frequently collide with legitimate sites; dedicated networks
 * are matched via TRACKER_NETWORK_SUFFIXES instead.
 */
export const SUSPICIOUS_TRACKER_TOKENS = [
  // Core tracking tokens
  'pixel', 'beacon', 'telemetry', 'analytics', 'tracker', 'tracking',
  'conversion', 'attribution', 'affiliate',
  // Major analytics platforms
  'scorecardresearch', 'quantserve', 'appsflyer', 'mixpanel',
  'amplitude', 'sentry', 'datadoghq', 'hotjar', 'fullstory',
  'mouseflow', 'optimizely', 'newrelic', 'heapanalytics',
  'googleanalytics', 'google-analytics', 'googletagmanager', 'googletagservices',
  // Fingerprinting / session recording
  'fingerprint', 'fingerprintjs', 'clarity', 'sessioncam', 'decibelinsight',
  'contentsquare', 'inspectlet', 'woopra', 'luckyorange', 'crazyegg',
  'uxcam', 'smartlook', 'logrocket', 'glassbox', 'quantum-metric', 'quantummetric',
  // Mobile attribution & engagement
  'singular', 'kochava', 'iterable', 'braze', 'onesignal', 'matomo', 'posthog',
  'branch', 'firebaseanalytics', 'flurry', 'localytics', 'swrve', 'leanplum',
  'clevertap', 'customerio', 'pushwoosh', 'airship', 'urbanairship', 'xtremepush',
  // Product analytics & feature flags
  'launchdarkly', 'statsig', 'growthbook', 'flagsmith', 'configcat',
  'pendo', 'gainsight', 'appcues', 'walkme', 'chameleon', 'userflow',
  // APM / error tracking / observability
  'rollbar', 'bugsnag', 'raygun', 'elastic-apm', 'instana', 'dynatrace',
  'sumologic', 'splunk', 'grafanacloud', 'honeycomb', 'opentelemetry',
  // Identity / CIAM telemetry
  'segment', 'rudderstack', 'mparticle', 'lytics', 'tealium', 'ensighten',
  'exponea', 'blueconic', 'bloomreach', 'optimoroute', 'salesforceanalytics',
] as const;

/** One hit on these names is enough to call a host an ad or tracker network. */
export const SPECIFIC_NETWORK_TOKENS = new Set<string>([
  // Ad networks — any match on a label is definitive
  'taboola', 'criteo', 'doubleclick', 'googleadservices', 'googlesyndication',
  'outbrain', 'moatads', 'adnxs', 'rubiconproject', 'pubmatic',
  'amazon-adsystem', 'adform', 'casalemedia', 'smartadserver', 'propellerads',
  'mgid', 'revcontent', 'smartclip', 'connatix', 'yieldlove', 'adkernel',
  'sharethrough', 'triplelift', 'indexexchange', 'gumgum', 'undertone',
  'yieldmo', 'sovrn', 'appnexus', 'adsrvr', 'tradedesk', 'mediamath',
  'applovin', 'ironsrc', 'vungle', 'inmobi', 'adcolony', 'mintegral',
  'chartboost', 'liftoff', 'springserve', 'smaato', 'teads', 'spotx', 'spotxchange',
  'pangle', 'loopme', 'ogury', 'fyber', 'digitalturbine', 'nativo',
  // Tracker networks — any match on a label is definitive
  'scorecardresearch', 'quantserve', 'googleanalytics', 'google-analytics',
  'googletagmanager', 'googletagservices', 'fingerprint', 'fingerprintjs',
  'posthog', 'contentsquare', 'appsflyer', 'mixpanel', 'amplitude', 'hotjar',
  'fullstory', 'mouseflow', 'crazyegg', 'luckyorange', 'inspectlet',
  'sessioncam', 'decibelinsight', 'clarity', 'smartlook', 'logrocket',
  'glassbox', 'quantummetric', 'kochava', 'singular', 'braze', 'pendo',
  'tealium', 'mparticle', 'rudderstack', 'launchdarkly', 'heapanalytics',
]);

const TELEMETRY_NAME_TOKENS = new Set<string>([
  'pixel', 'beacon', 'telemetry', 'analytics', 'tracker', 'tracking',
  'scorecardresearch', 'quantserve', 'googleanalytics', 'google-analytics',
  'googletagmanager', 'googletagservices', 'mixpanel', 'hotjar',
  'fullstory', 'mouseflow', 'optimizely', 'newrelic', 'sentry', 'amplitude',
  'appsflyer',
]);

const AD_INTENT_LABELS = new Set([
  'ads', 'adserver', 'adservice', 'pagead', 'doubleclick', 'banner',
  'popunder', 'preroll', 'sponsor', 'sponsors', 'adtech', 'bidder', 'bidding',
]);

const BENIGN_OPERATIONAL_SUB_LABELS = new Set([
  'status', 'statuspage', 'uptime', 'health', 'healthz',
  'api', 'apis', 'rest', 'graphql', 'grpc', 'rpc', 'webhook', 'webhooks', 'sdk',
  'cdn', 'static', 'assets', 'media', 'photos', 'video', 'videos', 'audio',
  'download', 'downloads', 'swupdate', 'softwareupdate', 'autoupdate', 'firmware', 'driver', 'drivers', 'ota', 'patch',
  'ocsp', 'crl', 'ntp', 'diag', 'diagnostics', 'setup', 'cert', 'certs', 'pki',
  'push', 'courier', 'broker', 'mqtt', 'websocket', 'ws', 'wss', 'socket', 'sockets', 'stream', 'streams',
  'auth', 'sso', 'idp', 'saml', 'oauth', 'identity',
  'relay', 'proxy', 'gateway', 'ingress', 'egress', 'balancer', 'dns', 'resolver',
]);

const STRONG_AD_TOKENS = [
  'doubleclick', 'googleadservices', 'googlesyndication', 'adnxs',
  'criteo', 'taboola', 'outbrain', 'pubmatic', 'rubiconproject', 'moatads',
  'amazon-adsystem', 'adform', 'casalemedia', 'smartadserver', 'propellerads',
  'popunder', 'popcash', '2mdn',
] as const;

const HIGH_PROFILE_BRANDS = [
  'paypal', 'google', 'apple', 'microsoft', 'amazon', 'netflix', 'github',
  'chase', 'bankofamerica', 'wellsfargo', 'citibank', 'capitalone', 'pnc', 'usbank',
  'venmo', 'zelle', 'cashapp', 'coinbase', 'binance', 'kraken', 'metamask', 'ledger',
  'trustwallet', 'facebook', 'instagram', 'dropbox', 'steam', 'twitter', 'discord',
  'roblox', 'fedex', 'usps', 'ups', 'dhl', 'office365', 'outlook', 'onedrive',
  'whatsapp', 'telegram', 'tiktok', 'snapchat', 'linkedin', 'walmart', 'costco', 'target',
  'adobe', 'spotify', 'shopify', 'ebay',
  'stripe', 'square', 'intuit', 'turbotax', 'quickbooks', 'fidelity', 'schwab', 'vanguard',
  'amex', 'barclays', 'hsbc', 'santander', 'uber', 'ubereats', 'lyft', 'airbnb', 'booking', 'expedia',
  'slack', 'zoom', 'atlassian', 'jira', 'notion', 'figma', 'epicgames', 'blizzard',
  'battlenet', 'riotgames', 'nintendo', 'playstation', 'xbox', 'openai', 'chatgpt',
  'anthropic', 'claude', 'cloudflare', 'akamai', 'fastly',
  'robinhood', 'revolut', 'monzo', 'wise', 'klarna', 'affirm', 'sofi', 'etrade',
  'doordash', 'instacart', 'grubhub', 'disney', 'hulu', 'peacock', 'paramount', 'max', 'plex',
  'twitch', 'vimeo', 'canva', 'miro', 'airtable', 'linear', 'docker', 'postman',
  'grafana', 'hashicorp', 'neon', 'planetscale', 'turso', 'vercel', 'netlify', 'fly',
  'railway', 'render', 'supabase', 'deno', 'bun', 'perplexity', 'mistral', 'groq',
  'huggingface', 'cohere', 'midjourney', 'replicate', 'salesforce', 'oracle',
  'meta', 'docusign', 'okta', 'gitlab', 'reddit', 'phantom', 'trezor', 'royalmail',
  'canadapost', 'auspost',
] as const;

/**
 * Authentic dictionary English words or non-conflicting trademarks that contain
 * a high-profile brand substring as a valid root, preventing false combosquatting flags.
 */
export const DICTIONARY_COMPOUND_EXEMPTIONS: ReadonlySet<string> = new Set([
  // Apple false positives
  'snapple', 'pineapple', 'appleton', 'applewood', 'crabapple', 'applesauce', 'applecart',
  'apply', 'ample', 'applet', 'applets',
  // Chase false positives
  'purchaser', 'purchase', 'purchases', 'purchasing', 'paperchase', 'chaser', 'chasers',
  'phase', 'chasten', 'chaste',
  // Steam false positives
  'steamboat', 'steamboatsprings', 'steampipe', 'livesteam', 'slipstream', 'mainstream', 'downstream', 'upstream', 'steamer',
  'steak', 'steamship',
  // Slack false positives
  'slackline', 'slackware', 'slackbridge', 'slackening',
  // Target false positives
  'targeted', 'targeting', 'targetpractice',
  // Zoom false positives
  'zoominfo', 'zoomerang', 'zoomcar',
  // Uber false positives
  'ubergeek', 'uberlandia', 'uberaba',
  // Box false positives
  'dropbox', 'sandbox', 'boxoffice', 'inbox', 'toolbox', 'blackbox', 'mailbox', 'gearbox', 'matchbox', 'outbox', 'textbox',
  // UPS / Push / Delivery false positives
  'startup', 'startups', 'meetup', 'meetups', 'rollup', 'backup', 'backups', 'signups', 'popups', 'upscale', 'upset', 'upstate', 'upstairs', 'upgrade', 'upgrades',
  // DHL / Other 3-letter false positives
  'adelaide', 'radcliffe',
  // Google / Amazon / Stripe / Roblox / Linear / Canva / Unity / Discord
  'goggle', 'goggles', 'amazed', 'amazing', 'strip', 'striped', 'stripes', 'striper',
  'robed', 'robin', 'robot', 'robots', 'robotic', 'robotics',
  'lineage', 'lineup', 'canvass', 'canvassing', 'unity', 'united', 'unit',
  'discordant', 'discordance', 'metal', 'metallic', 'metaphor', 'metabolism', 'oktoberfest',
]);

const PHISH_KEYWORDS =
  /login|verify|verification|verif|security|auth|authenticate|authentication|update|account|support|wallet|token|claim|signin|password|secure|unlock|billing|bill|delivery|parcel|package|reschedule|tracking|track|seed|phrase|validate|validation|portal|helpdesk|alert|banking|statement|overdue|invoice|recover|recovery|airdrop|mint|stake|presale|reward|rewards|vault|kyc|otp|2fa|mfa|credential|credentials|payout|refund|rebate|shipment|customs|redelivery|reship|courier|dispatch|suspend|suspended|suspension|unauthorized|restriction|restricted|action-required|violation|confirm|confirmation|notify|notification|protect|protection|activate|activation|reactivate|appeal|compromised|renew|renewal|expire|expired|expiration|dispute|chargeback|passcode|webmail|cpanel|unusual-activity|suspicious-activity|session-expired|re-verify|reverification|wire|remit|remittance/;

const PSEUDO_TLD_PATTERN = /(?:[-_](?:com|net|org|app|online|site|gov|co|info|io|xyz))(?:[-_]|$)/i;
const PSEUDO_TLD_SUFFIXES = new Set(['com', 'net', 'org', 'app', 'online', 'site', 'gov', 'co', 'info', 'io', 'xyz']);

const BENIGN_ENDPOINT_LABELS = new Set([
  'status', 'statuspage', 'uptime', 'health', 'healthz',
  'api', 'apis', 'v1', 'v2', 'v3', 'rest', 'graphql', 'grpc', 'rpc', 'webhook', 'webhooks', 'feed', 'feeds', 'rss', 'sdk',
  'cdn', 'static', 'assets', 'media', 'img', 'images', 'photos', 'video', 'videos', 'audio', 'content', 'files', 'uploads', 'thumbs', 'thumbnails', 'vod', 'live',
  'update', 'updates', 'download', 'downloads', 'swupdate', 'softwareupdate', 'autoupdate', 'firmware', 'driver', 'drivers', 'ota', 'patch', 'install', 'installer', 'pkg', 'packages', 'repo', 'release', 'releases', 'dist', 'mirror', 'mirrors',
  'ocsp', 'crl', 'ntp', 'time', 'pool', 'diag', 'diagnostics', 'setup', 'cert', 'certs', 'pki', 'ca', 'certmanager', 'acme', 'letsencrypt',
  'mail', 'email', 'webmail', 'smtp', 'imap', 'pop', 'autodiscover', 'exchange',
  'portal', 'login', 'signin', 'auth', 'sso', 'idp', 'saml', 'oauth', 'accounts', 'identity',
  'support', 'help', 'helpdesk', 'service', 'services', 'kb', 'faq', 'docs', 'documentation', 'spec',
  'dev', 'developer', 'developers', 'git', 'gitlab', 'code', 'repo', 'build', 'ci', 'cd', 'artifacts', 'registry',
  'vpn', 'remote', 'connect', 'gateway', 'access', 'secure', 'ingress', 'egress', 'router', 'relay', 'proxy', 'mesh',
  'app', 'apps', 'web', 'dashboard', 'admin', 'console', 'manage', 'intranet', 'office', 'hr', 'payroll',
  'shop', 'store', 'cart', 'checkout', 'pay', 'billing',
  'cloud', 'hub', 'sync', 'storage', 'backup',
  'forum', 'community', 'news', 'blog', 'pub', 'public',
  'search', 'dns', 'ns', 'ns1', 'ns2', 'dot', 'doh', 'resolver',
  'test', 'demo', 'sandbox', 'stage', 'staging', 'preview', 'prod', 'production',
  'ping', 'check', 'captive', 'network', 'connectivitycheck', 'detectportal', 'networkcheck', 'hotspot', 'wifi', 'speedtest', 'stun', 'turn', 'rtmp', 'webrtc',
  'meet', 'conference', 'chat', 'voice', 'talk', 'call',
  // Sockets, Push & Realtime notifications
  'push', 'courier', 'broker', 'mqtt', 'websocket', 'ws', 'wss', 'socket', 'sockets', 'comet', 'longpoll', 'event', 'events', 'notify', 'notification', 'notifications', 'alert', 'alerts', 'pubsub',
  // Media chunking & streaming
  'stream', 'streams', 'chunk', 'chunks', 'segment', 'segments', 'm3u8', 'ts', 'mp4', 'mp3', 'aac', 'hls', 'dash', 'manifest', 'playlist', 'blob', 'bucket', 'object', 'objects', 'attachment', 'attachments',
  // Gaming & RTC
  'lobby', 'matchmaking', 'party', 'gameplay', 'room', 'server', 'servers', 'cluster', 'shard', 'shards', 'realm', 'realms', 'guild', 'channel', 'channels',
  // Developer & CI/CD
  'scm', 'vcs', 'pipeline', 'pipelines', 'runner', 'runners', 'worker', 'workers', 'job', 'jobs', 'builds', 'container', 'containers', 'k8s', 'kube', 'vault', 'consul', 'etcd',
  // Logistics & delivery tracking endpoints
  'tracking', 'track', 'trace', 'package', 'packages', 'shipment', 'shipments', 'parcel', 'parcels', 'delivery', 'deliveries', 'dispatch', 'freight', 'cargo', 'waybill', 'consignment', 'logistics', 'courier', 'transit', 'customs', 'border', 'clearing',
]);

const STRUCTURAL_SLD_WORDS = new Set([
  'customer', 'prod', 'production', 'staging', 'stage', 'dev', 'edge', 'cdn',
  'api', 'status', 'update', 'static', 'assets', 'media', 'origin', 'cache',
  'node', 'region', 'central', 'east', 'west', 'north', 'south', 'internal',
  'service', 'services', 'app', 'apps', 'cloud', 'compute', 'storage', 'blob',
  'queue', 'gateway', 'proxy', 'device', 'devices', 'hub', 'home', 'diag',
  'diagnostics', 'firmware', 'config', 'setup', 'sync', 'backup', 'download',
  'portal', 'admin', 'mail', 'smtp', 'vpn', 'remote', 'img', 'images', 'video',
  'stream', 'push', 'notify', 'mqtt', 'azure', 'amazon', 'google', 'windows',
  'content', 'delivery', 'network', 'routing', 'cluster', 'tenant', 'host',
  'system', 'connect', 'endpoint', 'telemetry', 'relay', 'balancer', 'loadbalancer',
  'distribution', 'traffic', 'pool', 'ingress',
]);


interface SuffixGroup {
  kind: InfraKind;
  reason: (suffix: string) => string;
  suffixes: readonly string[];
}

const AD_NETWORK_SUFFIXES = [
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  '2mdn.net',
  'adnxs.com',
  'adnxs.net',
  'adsrvr.org',
  'amazon-adsystem.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'pubmatic.com',
  'rubiconproject.com',
  'casalemedia.com',
  'openx.net',
  'openx.com',
  'smartadserver.com',
  'moatads.com',
  'adform.net',
  'adform.com',
  'mgid.com',
  'revcontent.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'serving-sys.com',
  'adsafeprotected.com',
  'doubleverify.com',
  'teads.tv',
  'sharethrough.com',
  'contextweb.com',
  'bidswitch.net',
  'rlcdn.com',
  'adservice.google.com',
  'ads.google.com',
  'pagead2.googlesyndication.com',
  'adroll.com',
  'adsterra.com',
  'inmobi.com',
  'ironsrc.com',
  'vungle.com',
  'adcolony.com',
  'spotxchange.com',
  'spotx.tv',
  'mediavine.com',
  'ezoic.com',
  'ezoic.net',
  'sovrn.com',
  'appnexus.com',
  'exoclick.com',
  'undertone.com',
  'conversantmedia.com',
  'exponential.com',
  'media.net',
  'monetizemore.com',
  'yieldmo.com',
  'triplelift.com',
  'triplelift.net',
  'connatix.com',
  'aniview.com',
  'springserve.com',
  'smaato.net',
  'chartboost.com',
  'applovin.com',
  'applovin.com',
  'applovinmax.com',
  'unityads.unity3d.com',
  'unityads.com',
  'liftoff.io',
  'mintegral.com',
  'adkernel.com',
  'yieldlove.com',
  'smartclip.tv',
  'smartclip.net',
  'admob.com',
  // Additional major ad networks
  'sharethrough.com',
  'indexexchange.com',
  'gumgum.com',
  'teads.tv',
  'teads.com',
  'nativo.com',
  'pangle.io',
  'pangleglobal.com',
  'loopme.com',
  'ogury.com',
  'fyber.com',
  'inner-active.com',
  'inneractive.com',
  'digitalturbine.com',
  'tapjoy.com',
  'adbuddiz.com',
  'tradplus.com',
  'emxdigital.com',
  'emxdgt.com',
  'rocketfuel.com',
  'yahoodsp.com',
  'media.yahoo.com',
  'amobee.com',
  'beeswax.io',
  'beeswax.com',
  'stackadapt.com',
  'choozle.com',
  'basis.net',
  'adsrvr.org',
  'thetradedesk.com',
  'mediamath.com',
  'dataxu.com',
  'yieldify.com',
  'zergnet.com',
  'gravity.com',
  'adthrive.com',
  'adpushup.com',
  'adprime.com',
  'adhese.com',
  'adrecovery.com',
  'adfox.ru',
  'adfox.net',
  'vidazoo.com',
  'brid.tv',
  'jwplatform.com',
  'minutemedia.com',
  'adglare.net',
  'glomex.com',
  'dailymotion.com',
  'loopme.me',
  'pubgalaxy.com',
  'sortable.com',
  'adtelligent.com',
  'getadmiral.com',
  'admiraldrm.com',
  'admiralservices.com',
  'admiralcloud.com',
  'carter-carrier.com',
  'whisperingwax.com',
  'chiseledcherry.com',
  'defiantdigital.com',
  'spitefulsoup.com',
  'sylvansteam.com',
  'decklibrary.com',
  'credential.net',
  'incongruousmeasure.com',
  'defiantiron.com',
  'familiarrailway.com',
  'greasyloss.com',
  'fundingchoicesmessages.google.com',
  'fc.yahoo.com',
  'btloader.com',
  'blockthrough.com',
  'blockthrough.net',
  'pagefair.com',
  'pagefair.net',
  'adinplay.com',
  'adinplay.bid',
  'adinplay.eu',
  'fuckadblock.com',
  'blockadblock.com',
  'antiblock.org',
  'snack-media.com',
  'adblockdetector.com',
  'adunblock.com',
  'yavli.com',
  'realsrv.com',
  'antiadblocksystems.com',
  'anti-adblock.herokuapp.com',
  'nitropay.com',
  'snigelweb.com',
  'snigel.com',
] as const;

const TRACKER_NETWORK_SUFFIXES = [
  // Google Analytics & Tag Management
  'google-analytics.com',
  'googleanalytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'analytics.google.com',
  // Panel measurement
  'scorecardresearch.com',
  'quantserve.com',
  // Mobile attribution
  'branch.io',
  'app.link',
  'appsflyer.com',
  'adjust.com',
  'adjust.io',
  'kochava.com',
  'singular.net',
  'tenjin.io',
  'tenjin.com',
  'airbridge.io',
  'rockerbox.com',
  'northbeam.io',
  'triplewhale.com',
  'elevar.com',
  // Product analytics
  'mixpanel.com',
  'amplitude.com',
  'segment.io',
  'segment.com',
  'rudderstack.com',
  'rudderlabs.com',
  'mparticle.com',
  'lytics.com',
  'tealium.com',
  'tiqcdn.com',
  'ensighten.com',
  'exponea.com',
  'bloomreach.com',
  'pendo.io',
  'appcues.com',
  'appcues.net',
  'walkme.com',
  'userpilot.io',
  'userflow.com',
  'chameleon.io',
  'intercom.io',
  // Session recording / heatmaps
  'hotjar.com',
  'fullstory.com',
  'mouseflow.com',
  'inspectlet.com',
  'crazyegg.com',
  'luckyorange.com',
  'woopra.com',
  'sessioncam.com',
  'decibelinsight.net',
  'contentsquare.net',
  'contentsquare.com',
  'smartlook.com',
  'logrocket.com',
  'logrocket.io',
  'glassbox.com',
  'quantum-metric.com',
  'quantummetric.com',
  'uxcam.com',
  'clarity.ms',
  // Error tracking / APM
  'sentry.io',
  'nr-data.net',
  'newrelic.com',
  'rollbar.com',
  'bugsnag.com',
  'raygun.io',
  'raygun.com',
  'instana.com',
  'dynatrace.com',
  'elastic.co',
  'honeycomb.io',
  // A/B testing & feature flags
  'optimizely.com',
  'launchdarkly.com',
  'statsig.com',
  'growthbook.io',
  'flagsmith.com',
  'configcat.com',
  'split.io',
  'kameleoon.com',
  'vwo.com',
  'conductrics.com',
  // CRM / engagement / push
  'braze.com',
  'braze.eu',
  'iterable.com',
  'onesignal.com',
  'pushwoosh.com',
  'airship.com',
  'urbanairship.com',
  'clevertap.com',
  'customerio.com',
  'swrve.com',
  'leanplum.com',
  'localytics.com',
  'xtremepush.com',
  // Identity / audience / DMP
  'demdex.net',
  'omtrdc.net',
  'everesttech.net',
  'bluekai.com',
  'krxd.net',
  'agkn.com',
  'tapad.com',
  'exelator.com',
  'liveramp.com',
  'liveramp.net',
  'adnxs.com',
  'stickyads.tv',
  // Social pixels
  'connect.facebook.net',
  'facebook.net',
  'tr.snapchat.com',
  'sc-static.net',
  'ads.linkedin.com',
  'analytics.tiktok.com',
  'business.tiktok.com',
  // Misc tracking infrastructure
  'trackcmp.net',
  'clicky.com',
  'statcounter.com',
  'flurry.com',
  'heap.io',
  'heapanalytics.com',
  'loggly.com',
  'matomo.cloud',
  'piwik.pro',
  'qualtrics.com',
  'userzoom.com',
  'kissmetrics.io',
  'adlooxtracking.com',
  's-onetag.com',
  'bounceexchange.com',
  'wunderkind.co',
  'yieldify.com',
  'sl-edge.com',
  'dnsdelegation.io',
  'fingerprint.com',
  'fingerprintjs.com',
  'posthog.com',
  'plausible.io',
  // Additional analytics & observability
  'chartbeat.com',
  'chartbeat.net',
  'parsely.com',
  'parse.ly',
  'sailthru.com',
  'klaviyo.com',
  'klaviyomail.com',
  'marketo.com',
  'marketo.net',
  'eloqua.com',
  'hubspot.com',
  'hsforms.com',
  'hubspotlinks.com',
  'pardot.com',
  'actmcdn.com',
  'act-on.com',
  'hubapi.com',
] as const;

const CLOUD_SUFFIXES = [
  // Microsoft Azure and Microsoft 365 service fabric
  'azure.com', 'azure.net', 'azureedge.net', 'azurefd.net', 'azure-api.net',
  'azurewebsites.net', 'azurecontainer.io', 'azurecr.io', 'azurestaticapps.net',
  'azure-devices.net', 'azure-automation.net', 'cloudapp.net', 'windows.net',
  'windowsazure.com', 'trafficmanager.net', 'msecnd.net', 'service.signalr.net',
  'microsoft.com', 'microsoftonline.com', 'live.com', 'office.com', 'office.net',
  'office365.com', 'sharepoint.com', 'outlook.com', 'skype.com', 'bing.com',
  'msn.com', 'windows.com', 'windowsupdate.com', 'microsoftstore.com',
  'msedge.net', 's-microsoft.com', 'msftconnecttest.com', 'msftncsi.com',
  'visualstudio.com', 'gfx.ms',
  // Amazon Web Services
  'amazonaws.com', 'amazon.com', 'cloudfront.net', 'awsstatic.com',
  'amazontrust.com', 'a2z.com', 'media-amazon.com', 'ssl-images-amazon.com',
  'amazonvideo.com', 'primevideo.com', 'awsglobalaccelerator.com',
  'elasticbeanstalk.com', 'apprunner.com', 'elb.amazonaws.com',
  // Google Cloud and Google service endpoints
  'googleapis.com', 'google.com', 'gstatic.com', 'googleusercontent.com',
  'gvt1.com', 'gvt2.com', 'gvt3.com', '1e100.net', 'appspot.com',
  'googlehosted.com', 'withgoogle.com', 'googlezip.net', 'ggpht.com',
  'gmail.com', 'youtube.com', 'ytimg.com', 'googlevideo.com', 'android.com',
  'chromium.org', 'blogger.com', 'gcr.io', 'pkg.dev', 'cloudfunctions.net',
  'run.app', 'firebaseio.com', 'firebaseapp.com', 'web.app',
  // Oracle Cloud & IBM Cloud
  'oracle.com', 'oraclecloud.com', 'oraclegovcloud.com', 'oraclecorp.com',
  'ibm.com', 'bluemix.net', 'ibmcloud.com',
  // Alibaba & Tencent Cloud
  'aliyun.com', 'alibabacloud.com', 'myqcloud.com', 'tencentcloudapi.com',
  // Cloud VPS & Infrastructure Hosting
  'digitalocean.com', 'digitaloceanspaces.com', 'ondigitalocean.com',
  'linode.com', 'linodeobjects.com', 'members.linode.com',
  'vultr.com', 'vultrobjects.com',
  'hetzner.com', 'hetzner.de', 'your-server.de',
  'ovh.com', 'ovh.net', 'ovhcloud.com',
  'scaleway.com', 'scw.cloud',
  'leaseweb.com', 'hostinger.com', 'bluehost.com', 'godaddy.com', 'namecheap.com',
  // Enterprise cloud / identity / auth
  'docker.com', 'docker.io', 'postman.com', 'auth0.com', 'okta.com',
  'oktacdn.com', 'docusign.net', 'docusign.com', 'elastic.co',
  // Serverless, Modern DB & Storage Cloud
  'supabase.com', 'supabase.co', 'supabase.net', 'supabase.in',
  'backblazeb2.com', 'wasabisys.com', 'r2.cloudflarestorage.com',
  'neon.tech', 'neon.build', 'planetscale.com', 'psdb.cloud', 'turso.io', 'turso.tech', 'upstash.io', 'convex.dev', 'convex.cloud',
  'together.ai', 'groq.com', 'mistral.ai', 'deepseek.com', 'perplexity.ai', 'replicate.com', 'replicate.delivery',
] as const;

const CDN_SUFFIXES = [
  'cloudflare.com', 'cloudflare.net', 'cloudflare-dns.com', 'cdn.cloudflare.net',
  'fastly.net', 'fastlylb.net', 'dualstack.fastly.net', 'prod.fastly.net', 'fastly.com', 'map.fastly.net',
  'akamai.net', 'akamaized.net', 'akamaihd.net', 'akamaiedge.net',
  'edgekey.net', 'edgesuite.net', 'akamai.com', 'akadns.net',
  'akamaitechnologies.com', 'akamaistream.net', 'srip.net', 'tl88.net', 'gslb.akamai.com',
  'akamai-staging.net', 'akamai-edge.net',
  'jsdelivr.net', 'unpkg.com', 'bootstrapcdn.com', 'fontawesome.com', 'jquery.com', 'cdnjs.com',
  'stackpathcdn.com', 'stackpath.com', 'bunny.net', 'b-cdn.net', 'keycdn.com', 'kxcdn.com', 'gcore.com', 'gcorelabs.com', 'gcdn.co',
  'cdn77.com', 'cdn77.org', 'cachefly.net', 'edgio.net', 'limelight.com', 'edgecastcdn.net', 'llnwd.net', 'cdngslb.com',
  'highwinds-cdn.com', 'hwcdn.net', 'incapdns.net', 'impervadns.net',
] as const;

const IOT_SUFFIXES = [
  'meethue.com', 'philips-hue.com', 'philips.com', 'signify.com',
  'nest.com', 'dropcam.com', 'ring.com', 'ecobee.com',
  'wyze.com', 'wyzecam.com', 'tplinkcloud.com', 'tplinkra.com', 'tp-link.com',
  'kasasmart.com', 'tapo.com', 'tuya.com', 'tuyaus.com', 'tuyaeu.com', 'tuyacn.com', 'smartlife.me',
  'smartthings.com', 'smartthingscloud.com', 'samsung.com', 'samsungcloud.com',
  'samsungiotcloud.com', 'samsungcloudplatform.com', 'samsungosp.com', 'samsungqbe.com',
  'lg.com', 'lge.com', 'lgthinq.com', 'lgsmartthinq.com', 'lgtvcommon.com', 'lgappstv.com', 'lgtvsdp.com',
  'sony.com', 'sonynetworkentertainment.com', 'playstation.com', 'playstation.net', 'sie.com',
  'vizio.com', 'viziotv.com', 'roku.com', 'rokutime.com', 'roku.net',
  'sonos.com', 'irobot.com', 'irobotcloud.com', 'arlo.com', 'arlocloud.com',
  'eufylife.com', 'eufy.com', 'anker.com',
  'blinkforhome.com', 'immedia-semi.com', 'august.com', 'yalehome.com', 'schlage.com',
  'honeywell.com', 'resideo.com', 'lutron.com', 'leviton.com', 'control4.com',
  'lifx.co', 'nanoleaf.me', 'govee.com', 'govee-cloud.com', 'meross.com', 'shelly.cloud',
  'aqara.com', 'xiaomi.com', 'mi.com', 'mijia.com', 'mi-img.com',
  'home-assistant.io', 'nabucasa.com', 'nuki.io', 'homey.app', 'threadgroup.org',
  'bosch-smarthome.com', 'home-connect.com', 'myqdevice.com', 'chamberlain.com',
  'simplisafe.com', 'wink.com', 'insteon.com', 'logitech.com', 'myharmony.com',
  'garmin.com', 'fitbit.com', 'withings.com', 'whoop.com', 'strava.com', 'polar.com', 'oura.com', 'ouraring.com',
  'synology.com', 'quickconnect.to', 'synology.me', 'qnap.com', 'myqnapcloud.com',
  'netgear.com', 'routerlogin.net', 'routerlogin.com', 'mynetgear.com', 'mywifiext.net',
  'asus.com', 'router.asus.com', 'repeater.asus.com', 'asuscomm.com',
  'tplinkwifi.net', 'tplinknvr.net', 'tplinkap.net', 'tplinkrepeater.net', 'linksys.com', 'linksyssmartwifi.com',
  'ubnt.com', 'ui.com', 'amplifi.com', 'hp.com', 'hpsmart.com', 'canon.com', 'epson.com', 'brother.com',
  'tailscale.com', 'tailscale.io', 'wireguard.com', 'zerotier.com',
  'mikrotik.com', 'pfsense.org', 'opnsense.org', 'cisco.com', 'meraki.com',
  'tesla.com', 'teslamotors.com', 'chargepoint.com', 'electrifyamerica.com', 'evgo.com',
  'roborock.com', 'ecovacs.com', 'dreame.tech', 'fritz.box', 'pi.hole', 'adguard.local',
] as const;

const VENDOR_SUFFIXES = [
  'cursor.com', 'cursor.sh', 'codeium.com',
  'github.com', 'githubassets.com', 'githubusercontent.com', 'ghcr.io',
  'gitlab.com', 'bitbucket.org', 'atlassian.com', 'atlassian.net',
  'slack.com', 'slack-edge.com', 'slack-msgs.com', 'slackb.com', 'slack-core.com',
  'notion.so', 'notion.site', 'notion.com',
  'linear.app', 'figma.com', 'figmacdn.com',
  'dropbox.com', 'dropboxapi.com', 'dropboxusercontent.com', 'dropboxstatic.com',
  'box.com', 'boxcdn.net',
  'zoom.us', 'zoom.com', 'zoomgov.com',
  'adobe.com', 'adobecc.com', 'adobelogin.com', 'typekit.net',
  'apple.com', 'apple-cloudkit.com', 'apple-dns.net', 'cdn-apple.com',
  'icloud.com', 'icloud-content.com', 'mzstatic.com', 'aaplimg.com', 'apple-mapkit.com', 'apple.news',
  'push-apple.com', 'push.apple.com', 'courier-push-apple.com', 'courier-sandbox-push-apple.com',
  'supabase.com', 'supabase.co', 'supabase.net',
  'railway.app', 'render.com', 'fly.io', 'deno.land', 'deno.dev', 'bun.sh',
  'mozilla.org', 'mozilla.com', 'mozilla.net', 'firefox.com',
  'spotify.com', 'scdn.co', 'spotifycdn.com',
  'netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxso.net', 'nflxext.com',
  'discord.com', 'discordapp.com', 'discord.gg', 'discord.media',
  'reddit.com', 'redditstatic.com', 'redd.it',
  'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamcontent.com', 'steamserver.net', 'valvesoftware.com',
  'epicgames.com', 'unrealengine.com', 'epicgames.dev',
  'ea.com', 'origin.com', 'electronicarts.com',
  'blizzard.com', 'battle.net', 'battlenet.com', 'ubisoft.com', 'uplay.com',
  'riotgames.com', 'leagueoflegends.com', 'pvp.net', 'valorant.com',
  'xbox.com', 'xboxlive.com',
  'nintendo.com', 'nintendo.net', 'nintendo.jp', 'gog.com', 'rbxcdn.com', 'unity.com', 'unity3d.com', 'itch.io',
  'counter-strike.net',
  'wikipedia.org', 'wikimedia.org', 'wiktionary.org', 'archive.org', 'arxiv.org',
  'openai.com', 'oaistatic.com', 'chatgpt.com', 'anthropic.com', 'claude.ai',
  'huggingface.co', 'cohere.com', 'mistral.ai', 'groq.com', 'together.ai', 'deepseek.com', 'perplexity.ai', 'replicate.com',
  'paypal.com', 'paypalobjects.com', 'paypal-mmo.com',
  'stripe.com', 'stripe.network', 'stripe.me', 'stripecdn.com',
  'square.com', 'squareup.com', 'cash.app', 'cash.me', 'zellepay.com', 'wise.com', 'revolut.com', 'revolut.me', 'monzo.com', 'monzo.me', 'klarna.com', 'affirm.com', 'sofi.com', 'robinhood.com',
  'intuit.com', 'turbotax.com', 'quickbooks.com', 'creditkarma.com',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'pnc.com', 'usbank.com',
  'fidelity.com', 'schwab.com', 'vanguard.com', 'amex.com', 'americanexpress.com', 'discover.com', 'etrade.com',
  'barclays.co.uk', 'barclays.com', 'hsbc.com', 'hsbc.co.uk', 'santander.co.uk', 'santanderbank.com',
  'td.com', 'rbc.com', 'scotiabank.com', 'bmo.com',
  'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com',
  'facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com',
  'twitter.com', 'x.com', 'twimg.com',
  'roblox.com',
  'roku.com', 'rokutime.com', 'hulu.com', 'hulustream.com', 'disneyplus.com',
  'disney-plus.net', 'bamgrid.com', 'disney.com', 'dssott.com', 'max.com', 'hbomax.com', 'hbo.com',
  'peacocktv.com', 'paramountplus.com', 'paramount.com', 'plex.tv', 'plex.direct', 'crunchyroll.com', 'vrv.co',
  'twitch.tv', 'ttvnw.net', 'jtvnw.net', 'vimeo.com', 'vimeocdn.com',
  'soundcloud.com', 'sndcdn.com', 'deezer.com', 'tidal.com', 'pandora.com', 'audible.com', 'bandcamp.com',
  'bose.com', 'boseconnect.com',
  'npmjs.com', 'npmjs.org', 'yarnpkg.com', 'pypi.org', 'python.org',
  'crates.io', 'rust-lang.org', 'golang.org', 'pkg.go.dev', 'rubygems.org', 'packagist.org', 'nuget.org', 'terraform.io', 'brew.sh',
  'archlinux.org', 'debian.org', 'ubuntu.com', 'canonical.com', 'fedoraproject.org', 'centos.org',
  'alpinelinux.org', 'alpine.org', 'opensuse.org', 'kernel.org', 'freebsd.org', 'almalinux.org', 'rockylinux.org',
  'apache.org', 'maven.org', 'gradle.org', 'eclipse.org', 'linuxfoundation.org',
  'stackexchange.com', 'stackoverflow.com', 'superuser.com', 'serverfault.com',
  'askubuntu.com', 'mathoverflow.net', 'grafana.com', 'grafana.net', 'dev.to', 'hashnode.com', 'medium.com', 'substack.com',
  'developer.mozilla.org', 'mdn.mozillademos.org',
  'asana.com', 'clickup.com', 'monday.com', 'basecamp.com', 'miro.com', 'airtable.com',
  'canva.com', 'loom.com', 'calendly.com', 'grammarly.com', 'hubspot.com', 'salesforce.com', 'force.com',
  'zendesk.com', 'zdassets.com', 'freshdesk.com', 'intercom.io', 'intercomcdn.com', 'workday.com',
  'uber.com', 'ubereats.com', 'lyft.com', 'airbnb.com', 'booking.com', 'bstatic.com', 'expedia.com', 'tripadvisor.com',
  'doordash.com', 'dd.delivery', 'instacart.com', 'grubhub.com',
  'mayoclinic.org', 'hopkinsmedicine.org', 'nih.gov', 'ncbi.nlm.nih.gov', 'cdc.gov', 'who.int',
  'coursera.org', 'edx.org', 'udemy.com', 'khanacademy.org', 'duolingo.com',
  'britannica.com', 'dictionary.com', 'merriam-webster.com',
  'weather.com', 'accuweather.com', 'flightaware.com', 'flightradar24.com',
  'statuspage.io', 'service-now.com', 'custhelp.com', 'jira.com', 'confluence.cloud',
  // Logistics & Global Postal Carriers
  'usps.com', 'usps.gov', 'ups.com', 'fedex.com', 'dhl.com', 'dhl.de',
  'dpd.com', 'dpd.de', 'royalmail.com', 'canadapost.ca', 'auspost.com.au',
  'gls-group.eu', 'evri.com', 'hermesworld.com', 'postnl.nl', 'bpost.be', 'swisspost.ch', 'purolator.com',
] as const;

const PLATFORM_SUFFIXES = [
  'github.io', 'gitlab.io', 'herokuapp.com', 'herokussl.com', 'netlify.app', 'netlify.com', 'vercel.app', 'vercel.dev', 'v0.dev',
  'pages.dev', 'workers.dev', 'r2.dev', 'cloudflarepages.com',
  'digitalocean.com', 'digitaloceanspaces.com', 'ondigitalocean.com',
  'supabase.co', 'supabase.in', 'supabase.net', 'supabase.com',
  'railway.app', 'up.railway.app',
  'onrender.com', 'render.com',
  'fly.dev', 'fly.io',
  'deno.dev', 'deno.land', 'bun.sh',
  'replit.app', 'replit.dev', 'repl.co', 'glitch.me',
  'myshopify.com', 'wordpress.com', 'ghost.io', 'wixsite.com',
  'kinsta.cloud', 'wpengine.com', 'wpenginepowered.com',
  'azurewebsites.net', 'cloudfunctions.net', 'run.app', 'apprunner.com', 'elasticbeanstalk.com',
  'statuspage.io', 'service-now.com', 'custhelp.com',
  'neon.tech', 'neon.build', 'cloud.neon.tech', 'psdb.cloud', 'planetscale.com',
  'turso.io', 'turso.tech', 'upstash.io', 'convex.dev', 'convex.cloud',
  'modal.run', 'modal.com', 'val.town', 'val.run',
] as const;

const DNS_SUFFIXES = [
  'one.one.one.one', 'dns.google', 'quad9.net',
  'dns.adguard.com', 'dns.adguard-dns.com', 'dns.nextdns.io',
  'cleanbrowsing.org', 'dns.umbrella.com', 'opendns.com', 'controld.com',
  'dns.sb', 'dns.mullvad.net',
] as const;

const SUFFIX_GROUPS: readonly SuffixGroup[] = [
  {
    kind: 'cloud',
    reason: (suffix) => `Known cloud platform endpoint (${suffix}); hostname shape is not treated as malware`,
    suffixes: CLOUD_SUFFIXES,
  },
  {
    kind: 'cdn',
    reason: (suffix) => `Known content delivery network (${suffix})`,
    suffixes: CDN_SUFFIXES,
  },
  {
    kind: 'iot',
    reason: (suffix) => `Known device vendor infrastructure (${suffix})`,
    suffixes: IOT_SUFFIXES,
  },
  {
    kind: 'vendor',
    reason: (suffix) => `Known product or vendor service endpoint (${suffix})`,
    suffixes: VENDOR_SUFFIXES,
  },
  {
    kind: 'platform',
    reason: (suffix) => `Known application platform endpoint (${suffix})`,
    suffixes: PLATFORM_SUFFIXES,
  },
  {
    kind: 'dns',
    reason: (suffix) => `Known public DNS or connectivity endpoint (${suffix})`,
    suffixes: DNS_SUFFIXES,
  },
];

function buildSuffixIndex(suffixes: readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const suffix of suffixes) {
    const labels = suffix.split('.');
    const keys = labels.slice(0, -1);
    for (const key of keys) {
      const existing = index.get(key);
      if (existing) {
        if (!existing.includes(suffix)) existing.push(suffix);
      } else {
        index.set(key, [suffix]);
      }
    }
  }
  return index;
}

const AD_INDEX = buildSuffixIndex(AD_NETWORK_SUFFIXES);
const TRACKER_INDEX = buildSuffixIndex(TRACKER_NETWORK_SUFFIXES);
const SAFE_INDEXES = SUFFIX_GROUPS.map((group) => ({
  group,
  index: buildSuffixIndex(group.suffixes),
}));


function matchIndexed(hostname: string, index: Map<string, string[]>): string | undefined {
  const labels = hostname.split('.');
  let best: string | undefined;
  for (const label of labels) {
    const candidates = index.get(label);
    if (!candidates) continue;
    for (const suffix of candidates) {
      if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
        if (!best || suffix.length > best.length) best = suffix;
      }
    }
  }
  return best;
}

/**
 * Detects institutional top-level and second-level domains for government,
 * military, international treaties, and higher education.
 * These zones are strictly managed and do not operate commercial ad/tracker infrastructure.
 */
export function isInstitutionalDomain(domain: string): boolean {
  const clean = normalizeHostname(domain);
  if (!clean) return false;
  const parts = clean.split('.');
  if (parts.length < 2) return false;

  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];

  // Primary institutional TLDs (.gov, .mil, .edu, .int)
  if (tld === 'gov' || tld === 'mil' || tld === 'edu' || tld === 'int') {
    return true;
  }

  // Country-code institutional second-level domains (.gov.xx, .gouv.xx, .gob.xx, .ac.xx, .edu.xx, .mil.xx, .gv.at, etc.)
  if (parts.length >= 3) {
    if (
      sld === 'gov' || sld === 'gouv' || sld === 'gob' || sld === 'ac' ||
      sld === 'edu' || sld === 'mil' || sld === 'gv' || sld === 'overheid' ||
      sld === 'go' || sld === 'govt' || sld === 'nic' || sld === 'fed' ||
      sld === 'admin' || sld === 'police'
    ) {
      return true;
    }
  }

  // Specific national government / treaty zones
  if (
    clean === 'gc.ca' || clean.endsWith('.gc.ca') ||
    clean.endsWith('.fed.us') || clean.endsWith('.state.us') ||
    clean === 'admin.ch' || clean.endsWith('.admin.ch') ||
    clean === 'politie.nl' || clean.endsWith('.politie.nl') ||
    clean === 'overheid.nl' || clean.endsWith('.overheid.nl') ||
    clean === 'bund.de' || clean.endsWith('.bund.de') ||
    clean === 'nhs.uk' || clean.endsWith('.nhs.uk') ||
    clean === 'nhs.scot' || clean.endsWith('.nhs.scot') ||
    clean === 'europa.eu' || clean.endsWith('.europa.eu') ||
    clean === 'un.org' || clean.endsWith('.un.org') ||
    clean === 'who.int' || clean.endsWith('.who.int') ||
    clean === 'nato.int' || clean.endsWith('.nato.int') ||
    clean === 'interpol.int' || clean.endsWith('.interpol.int') ||
    clean === 'parliament.uk' || clean.endsWith('.parliament.uk') ||
    clean === 'judiciary.uk' || clean.endsWith('.judiciary.uk')
  ) {
    return true;
  }

  return false;
}

/**
 * Detects Microsoft Active Directory, domain controllers, private corporate LAN infrastructure,
 * and router/gateway local setup endpoints.
 */
export function isActiveDirectoryOrLocalDomain(domain: string): boolean {
  const clean = normalizeHostname(domain);
  if (!clean) return false;

  // Never match known advertising or tracking networks as Active Directory
  if (matchIndexed(clean, AD_INDEX) || matchIndexed(clean, TRACKER_INDEX)) {
    return false;
  }

  const labels = clean.split('.');

  // Internal LAN / corp / RFC 6761 / RFC 6762 / mDNS / ARPA zones
  const tld = labels[labels.length - 1];
  if (
    tld === 'local' ||
    tld === 'corp' ||
    tld === 'internal' ||
    tld === 'lan' ||
    tld === 'home' ||
    tld === 'priv' ||
    tld === 'privnet' ||
    tld === 'intra' ||
    tld === 'intranet' ||
    tld === 'test' ||
    tld === 'example' ||
    tld === 'invalid' ||
    tld === 'localhost' ||
    tld === 'localdomain' ||
    clean.endsWith('.arpa') ||
    clean.endsWith('.home.arpa')
  ) {
    return true;
  }

  // Router, gateway, and local appliance setup domains
  if (
    clean === 'fritz.box' || clean.endsWith('.fritz.box') ||
    clean === 'myfritz.net' || clean.endsWith('.myfritz.net') ||
    clean === 'routerlogin.net' || clean.endsWith('.routerlogin.net') ||
    clean === 'routerlogin.com' || clean.endsWith('.routerlogin.com') ||
    clean === 'orbilogin.com' || clean.endsWith('.orbilogin.com') ||
    clean === 'tplinkwifi.net' || clean.endsWith('.tplinkwifi.net') ||
    clean === 'tplinknvr.net' || clean.endsWith('.tplinknvr.net') ||
    clean === 'tplinkmodem.net' || clean.endsWith('.tplinkmodem.net') ||
    clean === 'repeater.asus.com' || clean === 'router.asus.com' ||
    clean === 'linksyssmartwifi.com' || clean.endsWith('.linksyssmartwifi.com') ||
    clean === 'mywifiext.net' || clean.endsWith('.mywifiext.net') ||
    clean === 'setup.amplifi.com' || clean === 'amplifi.lan' || clean.endsWith('.amplifi.lan') ||
    clean === 'unifi.local' || clean === 'speedport.ip' || clean.endsWith('.speedport.ip') ||
    clean === 'openwrt.lan' || clean === 'pfsense.local' || clean === 'opnsense.local' ||
    clean === 'pi.hole' || clean === 'adguard.local'
  ) {
    return true;
  }

  // Active Directory and domain controller prefix/labels:
  // dc1.ad.company.com, adfs.school.edu, kdc.corp.org, ldap.company.com
  const firstLabel = labels[0];
  if (
    firstLabel === 'adfs' ||
    firstLabel === 'kdc' ||
    firstLabel === 'ldap' ||
    firstLabel === 'ldaps'
  ) {
    return true;
  }
  // Standalone "ad" is only Active Directory if on an internal/corporate TLD or has 4+ labels (e.g. ad.corp.internal or dc01.ad.example.com)
  if (firstLabel === 'ad' && (labels.length >= 4 || tld === 'local' || tld === 'corp' || tld === 'internal' || tld === 'lan')) {
    return true;
  }
  // Subdomain labeled .ad. with an internal controller prefix (e.g. dc01.ad.example.com)
  if (labels.length >= 3 && labels[1] === 'ad' && (/^dc\d*$/i.test(labels[0]) || labels[0] === 'kdc' || labels[0] === 'ldap')) {
    return true;
  }

  return false;
}


/**
 * Detects whether a hostname belongs to anti-adblock detection, ad-recovery circumvention,
 * or modal lock wall infrastructure across multiple vendors (Admiral, Google Funding Choices,
 * BlockThrough/PageFair, AdInPlay, Ezoic, NitroPay, Snigel, and FuckAdBlock/BlockAdBlock).
 *
 * @beta
 */
export function detectAntiAdblock(domain: string): AntiAdblockDetection {
  const clean = normalizeHostname(domain);
  if (!clean) return { detected: false };

  // 1. Admiral Anti-Adblock
  if (
    clean === 'getadmiral.com' || clean.endsWith('.getadmiral.com') ||
    clean === 'admiraldrm.com' || clean.endsWith('.admiraldrm.com') ||
    clean === 'admiralservices.com' || clean.endsWith('.admiralservices.com') ||
    clean === 'admiralcloud.com' || clean.endsWith('.admiralcloud.com') ||
    clean === 'carter-carrier.com' || clean.endsWith('.carter-carrier.com') ||
    clean === 'whisperingwax.com' || clean.endsWith('.whisperingwax.com') ||
    clean === 'chiseledcherry.com' || clean.endsWith('.chiseledcherry.com') ||
    clean === 'defiantdigital.com' || clean.endsWith('.defiantdigital.com') ||
    clean === 'spitefulsoup.com' || clean.endsWith('.spitefulsoup.com') ||
    clean === 'sylvansteam.com' || clean.endsWith('.sylvansteam.com') ||
    clean === 'decklibrary.com' || clean.endsWith('.decklibrary.com') ||
    clean === 'incongruousmeasure.com' || clean.endsWith('.incongruousmeasure.com') ||
    clean === 'defiantiron.com' || clean.endsWith('.defiantiron.com') ||
    clean === 'familiarrailway.com' || clean.endsWith('.familiarrailway.com') ||
    clean === 'greasyloss.com' || clean.endsWith('.greasyloss.com') ||
    clean === 'poisedpancake.com' || clean.endsWith('.poisedpancake.com') ||
    clean === 'boringboundary.com' || clean.endsWith('.boringboundary.com') ||
    clean === 'fabulousfriction.com' || clean.endsWith('.fabulousfriction.com') ||
    clean === 'superficialsubstance.com' || clean.endsWith('.superficialsubstance.com')
  ) {
    return {
      detected: true,
      provider: 'admiral',
      providerName: 'Admiral Anti-Adblock & Paywall Bypass',
      reason: 'Admiral anti-adblock detection and ad-recovery platform',
    };
  }

  // Dynamic compound dictionary domains generated by Admiral (e.g. molecularhouseholdadmiral.com, admiralugly.com)
  const labels = clean.split('.');
  if (labels.length >= 2) {
    const sld = labels[labels.length - 2];
    // Exclude the legitimate UK insurer "admiral.com" or "admiral.co.uk"
    if (sld !== 'admiral' && sld.includes('admiral')) {
      return {
        detected: true,
        provider: 'admiral',
        providerName: 'Admiral Dynamic Anti-Adblock Domain',
        reason: 'Admiral dynamic compound anti-adblock delivery domain',
      };
    }
  }

  // 2. Google Funding Choices / Privacy & Messaging
  if (
    clean === 'fundingchoicesmessages.google.com' ||
    clean.endsWith('.fundingchoicesmessages.google.com') ||
    clean === 'fc.yahoo.com' ||
    clean.endsWith('.fc.yahoo.com')
  ) {
    return {
      detected: true,
      provider: 'google-fc',
      providerName: 'Google Funding Choices Anti-Adblock',
      reason: 'Google Funding Choices anti-adblock detection and modal wall',
    };
  }

  // 3. BlockThrough / PageFair (Ad Recovery / BT Loader)
  if (
    clean === 'btloader.com' || clean.endsWith('.btloader.com') ||
    clean === 'blockthrough.com' || clean.endsWith('.blockthrough.com') ||
    clean === 'blockthrough.net' || clean.endsWith('.blockthrough.net') ||
    clean === 'pagefair.com' || clean.endsWith('.pagefair.com') ||
    clean === 'pagefair.net' || clean.endsWith('.pagefair.net') ||
    clean === 'b-cdn.net' || clean.endsWith('.b-cdn.net')
  ) {
    return {
      detected: true,
      provider: 'blockthrough',
      providerName: 'BlockThrough / PageFair Ad Recovery',
      reason: 'BlockThrough / PageFair anti-adblock circumvention and ad recovery',
    };
  }

  // 4. AdInPlay (Game adblock detector & canvas blocker)
  if (
    clean === 'adinplay.com' || clean.endsWith('.adinplay.com') ||
    clean === 'adinplay.bid' || clean.endsWith('.adinplay.bid') ||
    clean === 'adinplay.eu' || clean.endsWith('.adinplay.eu')
  ) {
    return {
      detected: true,
      provider: 'adinplay',
      providerName: 'AdInPlay Game Anti-Adblock',
      reason: 'AdInPlay game canvas adblock detection and gameplay locker',
    };
  }

  // 5. Ezoic Ad-Recovery / Privacy Gateway
  if (
    clean === 'ezodn.com' || clean.endsWith('.ezodn.com') ||
    clean === 'ezoiccdn.com' || clean.endsWith('.ezoiccdn.com') ||
    (clean.includes('ezoic') && (clean.startsWith('go.') || clean.startsWith('gateway.')))
  ) {
    return {
      detected: true,
      provider: 'ezoic',
      providerName: 'Ezoic Ad Recovery Gateway',
      reason: 'Ezoic ad recovery proxy and anti-adblock privacy gateway',
    };
  }

  // 6. NitroPay Ad Recovery
  if (
    clean === 'nitropay.com' || clean.endsWith('.nitropay.com')
  ) {
    return {
      detected: true,
      provider: 'nitropay',
      providerName: 'NitroPay Ad Recovery',
      reason: 'NitroPay anti-adblock detection and ad recovery platform',
    };
  }

  // 7. Snigel Ad-Recovery / AdConsent
  if (
    clean === 'snigelweb.com' || clean.endsWith('.snigelweb.com') ||
    clean === 'snigel.com' || clean.endsWith('.snigel.com')
  ) {
    return {
      detected: true,
      provider: 'snigel',
      providerName: 'Snigel AdEngine Recovery',
      reason: 'Snigel ad recovery and CMP anti-adblock barrier',
    };
  }

  // 8. Uponit & Instart Logic (Script injection & recovery)
  if (
    clean === 'uponit.com' || clean.endsWith('.uponit.com') ||
    clean === 'instartlogic.com' || clean.endsWith('.instartlogic.com') ||
    clean === 'instart.com' || clean.endsWith('.instart.com')
  ) {
    return {
      detected: true,
      provider: 'generic',
      providerName: 'Ad-Recovery Injection Platform',
      reason: 'Ad-recovery proxy and script injection evasion platform',
    };
  }

  // 9. Sourcepoint CMP & Adblock Barrier
  if (
    clean === 'sp-prod.net' || clean.endsWith('.sp-prod.net') ||
    clean.includes('sourcepoint')
  ) {
    return {
      detected: true,
      provider: 'generic',
      providerName: 'Sourcepoint Anti-Adblock Barrier',
      reason: 'Sourcepoint consent management and adblock modal barrier',
    };
  }

  // 10. Generic Anti-Adblock & FuckAdBlock / BlockAdBlock / Bait systems
  if (
    clean === 'fuckadblock.com' || clean.endsWith('.fuckadblock.com') ||
    clean === 'blockadblock.com' || clean.endsWith('.blockadblock.com') ||
    clean === 'antiblock.org' || clean.endsWith('.antiblock.org') ||
    clean === 'snack-media.com' || clean.endsWith('.snack-media.com') ||
    clean === 'adblockdetector.com' || clean.endsWith('.adblockdetector.com') ||
    clean === 'adunblock.com' || clean.endsWith('.adunblock.com') ||
    clean === 'yavli.com' || clean.endsWith('.yavli.com') ||
    clean === 'antiadblocksystems.com' || clean.endsWith('.antiadblocksystems.com') ||
    clean === 'anti-adblock.herokuapp.com' || clean.endsWith('.anti-adblock.herokuapp.com') ||
    clean.startsWith('antiadblock.') || clean.startsWith('anti-adblock.') ||
    clean.includes('antiadblock') || clean.includes('anti-adblock')
  ) {
    return {
      detected: true,
      provider: 'generic',
      providerName: 'Generic Anti-Adblock Detection Engine',
      reason: 'Generic anti-adblock detection script or bait infrastructure',
    };
  }

  return { detected: false };
}

/**
 * Detects Admiral Anti-Adblock and visitor relationship management circumvention endpoints.
 * Catches both core infrastructure and dynamic dictionary-word domains generated by Admiral.
 * Preserves the legitimate UK insurance provider "admiral.com".
 */
export function isAdmiralAntiAdblock(domain: string): boolean {
  const res = detectAntiAdblock(domain);
  return res.detected && res.provider === 'admiral';
}

export function classifyInfrastructure(domain: string): InfraClassification {
  const clean = normalizeHostname(domain);
  if (!clean) {
    return { safe: false, adNetwork: false, kind: 'none', reason: '' };
  }

  // Anti-Adblock & circumvention detection
  const aab = detectAntiAdblock(clean);
  if (aab.detected) {
    return {
      safe: false,
      adNetwork: true,
      kind: 'ad-network',
      suffix: aab.provider || 'anti-adblock',
      reason: aab.reason || 'Anti-adblock detection and ad-recovery platform',
    };
  }

  const adSuffix = matchIndexed(clean, AD_INDEX);
  if (adSuffix) {
    return {
      safe: false,
      adNetwork: true,
      kind: 'ad-network',
      suffix: adSuffix,
      reason: `Known advertising network (${adSuffix})`,
    };
  }

  const trackerSuffix = matchIndexed(clean, TRACKER_INDEX);
  if (trackerSuffix) {
    return {
      safe: false,
      adNetwork: false,
      kind: 'tracker-network',
      suffix: trackerSuffix,
      reason: `Known tracker or analytics network (${trackerSuffix})`,
    };
  }

  // Institutional government / military / education guard
  if (isInstitutionalDomain(clean)) {
    return {
      safe: true,
      adNetwork: false,
      kind: 'vendor',
      reason: 'Verified institutional government or educational infrastructure',
    };
  }

  // Enterprise Active Directory / internal network guard
  if (isActiveDirectoryOrLocalDomain(clean)) {
    return {
      safe: true,
      adNetwork: false,
      kind: 'vendor',
      reason: 'Active Directory or enterprise infrastructure endpoint',
    };
  }

  let best: { suffix: string; kind: InfraKind; reason: string } | undefined;
  for (const { group, index } of SAFE_INDEXES) {
    const suffix = matchIndexed(clean, index);
    if (!suffix) continue;
    if (!best || suffix.length > best.suffix.length) {
      best = { suffix, kind: group.kind, reason: group.reason(suffix) };
    }
  }

  if (best) {
    return {
      safe: true,
      adNetwork: false,
      kind: best.kind,
      suffix: best.suffix,
      reason: best.reason,
    };
  }

  return { safe: false, adNetwork: false, kind: 'none', reason: '' };
}

/**
 * Token match on label boundaries (dot or hyphen). Long network names also
 * match when concatenated inside a label (`googleanalytics`).
 */
const MAX_TOKEN_REGEX_CACHE = 500;
const tokenRegexCache = new Map<string, RegExp>();

function boundaryRegex(token: string): RegExp {
  const cached = tokenRegexCache.get(token);
  if (cached) return cached;
  if (tokenRegexCache.size >= MAX_TOKEN_REGEX_CACHE) {
    tokenRegexCache.clear();
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const compiled = new RegExp(`(?:^|[.\\-])${escaped}(?:[.\\-]|$)`, 'i');
  tokenRegexCache.set(token, compiled);
  return compiled;
}

export function hostnameHasToken(hostname: string, token: string): boolean {
  const host = normalizeHostname(hostname);
  const needle = token.toLowerCase();
  if (!host || !needle) return false;
  if (boundaryRegex(needle).test(host)) return true;
  if (needle.length >= 11) return host.includes(needle);
  return false;
}

export function hasStrongAdIntent(domain: string): boolean {
  const clean = normalizeHostname(domain);
  if (!clean) return false;
  const labels = clean.split('.');
  for (const label of labels) {
    if (AD_INTENT_LABELS.has(label)) return true;
    for (const part of label.split('-')) {
      if (AD_INTENT_LABELS.has(part)) return true;
    }
  }
  return STRONG_AD_TOKENS.some((token) => hostnameHasToken(clean, token));
}

export function isTelemetryToken(token: string): boolean {
  return TELEMETRY_NAME_TOKENS.has(token.toLowerCase());
}

function computeLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return Math.abs(m - n);
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = new Array<number>(n + 1);
  let currRow = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(prevRow[j] + 1, currRow[j - 1] + 1, prevRow[j - 1] + cost);
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }
  return prevRow[n];
}

function isTypoSquat(token: string, brand: string): boolean {
  if (!token || token === brand) return false;
  if (Math.abs(token.length - brand.length) > 2) return false;
  const dist = computeLevenshtein(token, brand);
  if (dist <= 0 || dist > 2) return false;
  // 1. Character substitution with digits / leetspeak (e.g. g00gle, paypa1, app1e, m1crosoft)
  if (/\d/.test(token) && (dist === 1 || (brand.length >= 5 && dist === 2))) return true;
  // 2. Repeated character insertion typosquat (e.g. appple, gooogle, payyypal, netfflix)
  if (dist === 1 && brand.length >= 5 && /([a-z])\1{2,}/i.test(token)) return true;
  // 3. For longer brands (7+ chars), 1-edit distance rarely collides with standard English words (e.g. twiter, netflx, microsofd, coinbse)
  if (dist === 1 && brand.length >= 7) return true;
  return false;
}

/**
 * Minimal RFC 3492 Punycode decoder (zero external dependencies).
 */
export function decodePunycodeLabel(input: string): string {
  if (!input.toLowerCase().startsWith('xn--')) return input;
  const str = input.slice(4).toLowerCase();
  const base = 36;
  const tmin = 1;
  const tmax = 26;
  const skew = 38;
  const damp = 700;
  const initialBias = 72;
  const initialN = 128;
  const delimiter = '-';

  let n = initialN;
  let i = 0;
  let bias = initialBias;
  const output: number[] = [];

  const delimIndex = str.lastIndexOf(delimiter);
  let pos = 0;
  if (delimIndex > 0) {
    for (let j = 0; j < delimIndex; j++) {
      output.push(str.charCodeAt(j));
    }
    pos = delimIndex + 1;
  }

  const adapt = (delta: number, numpoints: number, firsttime: boolean): number => {
    let d = firsttime ? Math.floor(delta / damp) : Math.floor(delta / 2);
    d += Math.floor(d / numpoints);
    let k = 0;
    while (d > Math.floor(((base - tmin) * tmax) / 2)) {
      d = Math.floor(d / (base - tmin));
      k += base;
    }
    return k + Math.floor(((base - tmin + 1) * d) / (d + skew));
  };

  while (pos < str.length) {
    const oldi = i;
    let w = 1;
    let k = base;
    while (true) {
      if (pos >= str.length) break;
      const code = str.charCodeAt(pos++);
      const digit = code >= 97 && code <= 122 ? code - 97 : code >= 48 && code <= 57 ? code - 22 : base;
      if (digit >= base) break;
      i += digit * w;
      const t = k <= bias ? tmin : k >= bias + tmax ? tmax : k - bias;
      if (digit < t) break;
      w *= base - t;
      k += base;
    }
    bias = adapt(i - oldi, output.length + 1, oldi === 0);
    n += Math.floor(i / (output.length + 1));
    i = i % (output.length + 1);
    output.splice(i, 0, n);
    i++;
  }

  return String.fromCodePoint(...output);
}

const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic lookalikes
  '\u0430': 'a', '\u0410': 'a', // Cyrillic а, А
  '\u0441': 'c', '\u0421': 'c', // Cyrillic с, С
  '\u0434': 'd', // Cyrillic д
  '\u0435': 'e', '\u0415': 'e', // Cyrillic е, Е
  '\u0456': 'i', '\u0406': 'i', // Ukrainian і, І
  '\u0458': 'j', '\u0408': 'j', // Cyrillic ј, Ј
  '\u043a': 'k', '\u041a': 'k', // Cyrillic к, К
  '\u043c': 'm', '\u041c': 'm', // Cyrillic м, М
  '\u043e': 'o', '\u041e': 'o', // Cyrillic о, О
  '\u0440': 'p', '\u0420': 'p', // Cyrillic р, Р
  '\u0455': 's', '\u0405': 's', // Macedonian ѕ, Ѕ
  '\u0442': 't', '\u0422': 't', // Cyrillic т, Т
  '\u0445': 'x', '\u0425': 'x', // Cyrillic х, Х
  '\u0443': 'y', '\u0423': 'y', // Cyrillic у, У
  // Greek lookalikes
  '\u03b1': 'a', '\u0391': 'a', // Greek α, Α
  '\u03b2': 'b', '\u0392': 'b', // Greek β, Β
  '\u03b5': 'e', '\u0395': 'e', // Greek ε, Ε
  '\u03b7': 'n', '\u0397': 'h', // Greek η, Η
  '\u03b9': 'i', '\u0399': 'i', // Greek ι, Ι
  '\u03ba': 'k', '\u039a': 'k', // Greek κ, Κ
  '\u03bd': 'v', '\u039d': 'n', // Greek ν, Ν
  '\u03bf': 'o', '\u039f': 'o', // Greek ο, Ο
  '\u03c1': 'p', '\u03a1': 'p', // Greek ρ, Ρ
  '\u03c4': 't', '\u03a4': 't', // Greek τ, Τ
  '\u03c5': 'u', '\u03a5': 'y', // Greek υ, Υ
  '\u03c7': 'x', '\u03a7': 'x', // Greek χ, Χ
  '\u03c9': 'w', // Greek ω
  // Additional Cyrillic lookalikes
  '\u0432': 'b', '\u0412': 'b', // Cyrillic в, В
  '\u0433': 'r',                // Cyrillic г
  '\u043f': 'n',                // Cyrillic п
  '\u043d': 'h', '\u041d': 'h', // Cyrillic н, Н
  '\u0438': 'u',                // Cyrillic и
  '\u0448': 'w',                // Cyrillic ш
  // Latin accented / diacritic lookalikes
  '\u00e1': 'a', '\u00e0': 'a', '\u00e2': 'a', '\u00e4': 'a', '\u00e3': 'a', '\u00e5': 'a',
  '\u00e9': 'e', '\u00e8': 'e', '\u00ea': 'e', '\u00eb': 'e',
  '\u00ed': 'i', '\u00ec': 'i', '\u00ee': 'i', '\u00ef': 'i', '\u0131': 'i',
  '\u00f3': 'o', '\u00f2': 'o', '\u00f4': 'o', '\u00f6': 'o', '\u00f5': 'o',
  '\u00fa': 'u', '\u00f9': 'u', '\u00fb': 'u', '\u00fc': 'u',
  '\u00f1': 'n',
  '\u00e7': 'c',
  '\u0142': 'l',
};

export function normalizeHomoglyphs(str: string): string {
  return str.split('').map((ch) => HOMOGLYPH_MAP[ch] || ch).join('');
}

/**
 * Multi-tenant enterprise platforms where subdomains routinely match company/tenant names.
 * A tenant subdomain alone is benign unless accompanied by an explicit phishing keyword lure.
 */
export const MULTI_TENANT_PLATFORMS: ReadonlySet<string> = new Set([
  'statuspage.io', 'zendesk.com', 'zdassets.com', 'service-now.com',
  'custhelp.com', 'slack.com', 'okta.com', 'oktacdn.com',
  'atlassian.net', 'jira.com', 'confluence.cloud', 'salesforce.com',
  'force.com', 'github.io', 'gitlab.io', 'hubspot.com',
  'freshdesk.com', 'intercom.io', 'workday.com', 'zoom.us',
  'box.com', 'docusign.net', 'docusign.com', 'notion.site', 'notion.so',
  'supabase.co', 'supabase.in', 'supabase.net', 'supabase.com',
  'railway.app', 'up.railway.app', 'onrender.com', 'render.com',
  'fly.dev', 'fly.io', 'deno.dev', 'deno.land', 'vercel.app', 'vercel.dev',
  'netlify.app', 'netlify.com', 'web.app', 'firebaseapp.com', 'glitch.me',
  'replit.app', 'replit.dev', 'repl.co',
  'cloudflarepages.com', 'pages.dev', 'workers.dev', 'r2.dev',
  'myshopify.com', 'wordpress.com', 'ghost.io', 'wixsite.com',
  'azurewebsites.net', 'cloudfunctions.net', 'run.app', 'apprunner.com',
  'elasticbeanstalk.com', 'kinsta.cloud', 'wpengine.com', 'wpenginepowered.com',
  'neon.tech', 'neon.build', 'cloud.neon.tech', 'psdb.cloud', 'planetscale.com',
  'turso.io', 'turso.tech', 'upstash.io', 'convex.dev', 'convex.cloud',
  'modal.run', 'modal.com', 'val.town', 'val.run', 'gitbook.io', 'readme.io',
  'hashnode.dev', 's3.amazonaws.com', 'blob.core.windows.net', 'storage.googleapis.com',
]);

/**
 * Free/unauthenticated public hosting and serverless platforms where subdomains
 * can be freely registered by anyone, frequently abused for credential harvesting.
 */
export const UNTRUSTED_HOSTING_PLATFORMS: ReadonlySet<string> = new Set([
  'workers.dev', 'pages.dev', 'firebaseapp.com', 'web.app', 'glitch.me',
  'replit.app', 'replit.dev', 'repl.co', 'cloudflarepages.com',
  'netlify.app', 'vercel.app', 'vercel.dev', 'railway.app', 'onrender.com', 'render.com',
  'fly.dev', 'fly.io', 'azurewebsites.net', 'herokuapp.com',
]);

/**
 * Common authoritative CDN/DNS alias routing suffixes where major brands route production traffic.
 */
export const CDN_ROUTING_SUFFIXES: readonly string[] = [
  '.akadns.net',
  '.edgekey.net',
  '.edgesuite.net',
  '.akamaiedge.net',
  '.akamaized.net',
  '.akamai.net',
  '.akamaitechnologies.com',
  '.akamaistream.net',
  '.akamai-staging.net',
  '.gslb.akamai.com',
  '.cloudflare.net',
  '.cdn.cloudflare.net',
  '.trafficmanager.net',
  '.azurefd.net',
  '.azureedge.net',
  '.fastly.net',
  '.fastlylb.net',
  '.map.fastly.net',
  '.awsglobalaccelerator.com',
  '.cloudfront.net',
  '.elb.amazonaws.com',
  '.cdn77.org',
  '.incapdns.net',
  '.impervadns.net',
  '.gcdn.co',
  '.kxcdn.com',
  '.cdngslb.com',
  '.llnwd.net',
  '.hwcdn.net',
] as const;

/**
 * Legitimate second-level domains and infrastructure owned by high-profile brands.
 * Subdomains on these ecosystem domains are authentic properties, not impersonation spoofs.
 */
export const BRAND_ECOSYSTEMS: Record<string, readonly string[]> = {
  microsoft: [
    'microsoft.com', 'microsoftonline.com', 'azure.com', 'azurewebsites.net',
    'office.com', 'office365.com', 'sharepoint.com', 'outlook.com', 'live.com',
    'bing.com', 'visualstudio.com', 'msn.com', 'windows.net', 'windows.com',
    'msedge.net', 'xbox.com', 'xboxlive.com', 'linkedin.com', 'skype.com', 's-microsoft.com',
    'msftconnecttest.com', 'msftncsi.com', 'gfx.ms',
  ],
  google: [
    'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com',
    'youtube.com', 'gmail.com', 'android.com', '1e100.net', 'appspot.com',
    'withgoogle.com', 'gvt1.com', 'gvt2.com', 'gvt3.com', 'pkg.dev', 'run.app',
    'firebaseio.com', 'firebaseapp.com', 'web.app', 'blogger.com', 'chromium.org',
  ],
  apple: [
    'apple.com', 'icloud.com', 'icloud-content.com', 'apple-cloudkit.com', 'apple-dns.net',
    'cdn-apple.com', 'mzstatic.com', 'aaplimg.com', 'apple-mapkit.com', 'apple.news',
    'push-apple.com', 'push.apple.com', 'courier-push-apple.com', 'courier-sandbox-push-apple.com',
  ],
  amazon: [
    'amazon.com', 'amazonaws.com', 'cloudfront.net', 'awsstatic.com',
    'amazontrust.com', 'a2z.com', 'media-amazon.com', 'ssl-images-amazon.com',
    'amazonvideo.com', 'primevideo.com', 'awsglobalaccelerator.com',
  ],
  facebook: [
    'facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com',
    'whatsapp.com', 'messenger.com', 'meta.com',
  ],
  github: [
    'github.com', 'githubassets.com', 'githubusercontent.com', 'github.io', 'ghcr.io',
  ],
  twitter: [
    'twitter.com', 'x.com', 'twimg.com', 't.co',
  ],
  steam: [
    'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamcontent.com', 'steamserver.net', 'valvesoftware.com',
  ],
  discord: [
    'discord.com', 'discordapp.com', 'discord.gg', 'discord.media',
  ],
  netflix: [
    'netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxso.net', 'nflxext.com',
  ],
  paypal: [
    'paypal.com', 'paypalobjects.com', 'paypal-mmo.com',
  ],
  usps: [
    'usps.com', 'usps.gov', 'uspspostage.com', 'informeddelivery.com',
  ],
  ups: [
    'ups.com',
  ],
  dhl: [
    'dhl.com', 'dhl.de',
  ],
  fedex: [
    'fedex.com',
  ],
  chase: [
    'chase.com',
  ],
  bankofamerica: [
    'bankofamerica.com', 'bofa.com',
  ],
  wellsfargo: [
    'wellsfargo.com', 'wf.com',
  ],
  citibank: [
    'citi.com', 'citibank.com',
  ],
  capitalone: [
    'capitalone.com',
  ],
  pnc: [
    'pnc.com',
  ],
  usbank: [
    'usbank.com',
  ],
  fidelity: [
    'fidelity.com',
  ],
  schwab: [
    'schwab.com',
  ],
  vanguard: [
    'vanguard.com',
  ],
  amex: [
    'amex.com', 'americanexpress.com',
  ],
  barclays: [
    'barclays.co.uk', 'barclays.com',
  ],
  hsbc: [
    'hsbc.com', 'hsbc.co.uk',
  ],
  santander: [
    'santander.co.uk', 'santanderbank.com', 'santander.com',
  ],
  coinbase: [
    'coinbase.com',
  ],
  binance: [
    'binance.com',
  ],
  kraken: [
    'kraken.com',
  ],
  metamask: [
    'metamask.io',
  ],
  ledger: [
    'ledger.com',
  ],
  trustwallet: [
    'trustwallet.com',
  ],
  venmo: [
    'venmo.com',
  ],
  zelle: [
    'zellepay.com',
  ],
  cashapp: [
    'cash.app', 'cash.me',
  ],
  spotify: [
    'spotify.com', 'scdn.co', 'spotifycdn.com',
  ],
  shopify: [
    'shopify.com', 'myshopify.com', 'shopifycdn.com',
  ],
  adobe: [
    'adobe.com', 'adobe.io', 'typekit.net',
  ],
  ebay: [
    'ebay.com', 'ebaystatic.com', 'ebayimg.com',
  ],
  stripe: [
    'stripe.com', 'stripe.network', 'stripe.me', 'stripecdn.com',
  ],
  square: [
    'square.com', 'squareup.com', 'cash.app',
  ],
  intuit: [
    'intuit.com', 'turbotax.com', 'quickbooks.com', 'mint.com', 'creditkarma.com',
  ],
  turbotax: [
    'turbotax.com', 'intuit.com',
  ],
  quickbooks: [
    'quickbooks.com', 'intuit.com',
  ],
  uber: [
    'uber.com', 'ubereats.com',
  ],
  ubereats: [
    'ubereats.com', 'uber.com',
  ],
  lyft: [
    'lyft.com',
  ],
  airbnb: [
    'airbnb.com', 'a0.muscache.com',
  ],
  booking: [
    'booking.com', 'bstatic.com',
  ],
  expedia: [
    'expedia.com',
  ],
  slack: [
    'slack.com', 'slack-edge.com', 'slack-msgs.com', 'slackb.com',
  ],
  zoom: [
    'zoom.us', 'zoom.com', 'zoomgov.com',
  ],
  atlassian: [
    'atlassian.com', 'atlassian.net', 'jira.com', 'confluence.cloud', 'trello.com', 'bitbucket.org',
  ],
  jira: [
    'jira.com', 'atlassian.net', 'atlassian.com',
  ],
  notion: [
    'notion.so', 'notion.site', 'notion.com',
  ],
  figma: [
    'figma.com', 'figmacdn.com',
  ],
  epicgames: [
    'epicgames.com', 'unrealengine.com', 'epicgames.dev',
  ],
  blizzard: [
    'blizzard.com', 'battle.net', 'battlenet.com',
  ],
  battlenet: [
    'battle.net', 'battlenet.com', 'blizzard.com',
  ],
  riotgames: [
    'riotgames.com', 'leagueoflegends.com', 'pvp.net', 'valorant.com',
  ],
  nintendo: [
    'nintendo.com', 'nintendo.net', 'nintendo.jp',
  ],
  playstation: [
    'playstation.com', 'playstation.net', 'sie.com', 'sony.com',
  ],
  xbox: [
    'xbox.com', 'xboxlive.com', 'microsoft.com',
  ],
  openai: [
    'openai.com', 'oaistatic.com', 'chatgpt.com',
  ],
  chatgpt: [
    'chatgpt.com', 'openai.com', 'oaistatic.com',
  ],
  anthropic: [
    'anthropic.com', 'claude.ai',
  ],
  claude: [
    'claude.ai', 'anthropic.com',
  ],
  cloudflare: [
    'cloudflare.com', 'cloudflare.net', 'cloudflare-dns.com', 'pages.dev', 'workers.dev', 'r2.dev',
  ],
  akamai: [
    'akamai.com', 'akamai.net', 'akamaized.net', 'akamaihd.net', 'akamaiedge.net', 'edgekey.net', 'edgesuite.net', 'akadns.net', 'akamaitechnologies.com', 'akamaistream.net',
  ],
  fastly: [
    'fastly.net', 'fastlylb.net', 'fastly.com',
  ],
  office365: [
    'office.com', 'office365.com', 'microsoft.com', 'sharepoint.com', 'outlook.com',
  ],
  outlook: [
    'outlook.com', 'live.com', 'office.com', 'microsoft.com',
  ],
  onedrive: [
    'onedrive.com', 'live.com', 'office.com', 'microsoft.com',
  ],
  dropbox: [
    'dropbox.com', 'dropboxapi.com', 'dropboxusercontent.com', 'dropboxstatic.com',
  ],
  whatsapp: [
    'whatsapp.com', 'meta.com', 'facebook.com',
  ],
  telegram: [
    'telegram.org', 't.me', 'telegram.me',
  ],
  tiktok: [
    'tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'bytedance.com',
  ],
  snapchat: [
    'snapchat.com', 'snap-dev.net', 'snapads.com',
  ],
  linkedin: [
    'linkedin.com', 'licdn.com',
  ],
  walmart: [
    'walmart.com', 'walmartimages.com',
  ],
  costco: [
    'costco.com',
  ],
  target: [
    'target.com', 'targetimg1.com',
  ],
  roblox: [
    'roblox.com', 'rbxcdn.com',
  ],
  robinhood: [
    'robinhood.com', 'rbnhd.com',
  ],
  revolut: [
    'revolut.com', 'revolut.me',
  ],
  monzo: [
    'monzo.com', 'monzo.me',
  ],
  wise: [
    'wise.com', 'transferwise.com',
  ],
  klarna: [
    'klarna.com', 'klarnacdn.net',
  ],
  affirm: [
    'affirm.com',
  ],
  sofi: [
    'sofi.com',
  ],
  etrade: [
    'etrade.com', 'etrade.net',
  ],
  doordash: [
    'doordash.com', 'dd.delivery',
  ],
  instacart: [
    'instacart.com', 'instacart.ca',
  ],
  grubhub: [
    'grubhub.com',
  ],
  disney: [
    'disney.com', 'disneyplus.com', 'disney-plus.net', 'disney-streaming.com', 'bamgrid.com', 'dssott.com',
  ],
  hulu: [
    'hulu.com', 'hulustream.com',
  ],
  peacock: [
    'peacocktv.com',
  ],
  paramount: [
    'paramount.com', 'paramountplus.com',
  ],
  max: [
    'max.com', 'hbomax.com', 'hbo.com',
  ],
  plex: [
    'plex.tv', 'plex.direct',
  ],
  twitch: [
    'twitch.tv', 'ttvnw.net', 'jtvnw.net',
  ],
  vimeo: [
    'vimeo.com', 'vimeocdn.com',
  ],
  canva: [
    'canva.com', 'canva.me',
  ],
  miro: [
    'miro.com',
  ],
  airtable: [
    'airtable.com', 'airtableblocks.com',
  ],
  linear: [
    'linear.app',
  ],
  docker: [
    'docker.com', 'docker.io',
  ],
  postman: [
    'postman.com', 'postman.co', 'getpostman.com',
  ],
  grafana: [
    'grafana.com', 'grafana.net',
  ],
  hashicorp: [
    'hashicorp.com', 'terraform.io', 'vaultproject.io', 'consul.io',
  ],
  neon: [
    'neon.tech', 'neon.build', 'cloud.neon.tech',
  ],
  planetscale: [
    'planetscale.com', 'psdb.cloud',
  ],
  turso: [
    'turso.io', 'turso.tech',
  ],
  vercel: [
    'vercel.com', 'vercel.app', 'vercel.dev', 'v0.dev',
  ],
  netlify: [
    'netlify.com', 'netlify.app',
  ],
  fly: [
    'fly.io', 'fly.dev',
  ],
  railway: [
    'railway.app', 'up.railway.app',
  ],
  render: [
    'render.com', 'onrender.com',
  ],
  supabase: [
    'supabase.com', 'supabase.co', 'supabase.in', 'supabase.net',
  ],
  deno: [
    'deno.land', 'deno.dev', 'deno.com',
  ],
  bun: [
    'bun.sh',
  ],
  perplexity: [
    'perplexity.ai',
  ],
  mistral: [
    'mistral.ai',
  ],
  salesforce: [
    'salesforce.com', 'force.com', 'salesforceiq.com', 'trailhead.com', 'herokucdn.com',
  ],
  oracle: [
    'oracle.com', 'oraclecloud.com', 'netsuite.com', 'java.com',
  ],
  groq: [
    'groq.com',
  ],
  huggingface: [
    'huggingface.co',
  ],
  cohere: [
    'cohere.com', 'cohere.ai',
  ],
  midjourney: [
    'midjourney.com',
  ],
  replicate: [
    'replicate.com', 'replicate.delivery',
  ],
  instagram: [
    'instagram.com', 'cdninstagram.com', 'facebook.com', 'meta.com',
  ],
  meta: [
    'meta.com', 'facebook.com', 'instagram.com', 'whatsapp.com', 'messenger.com', 'oculus.com', 'threads.net',
  ],
  docusign: [
    'docusign.com', 'docusign.net',
  ],
  okta: [
    'okta.com', 'oktacdn.com',
  ],
  gitlab: [
    'gitlab.com', 'gitlab.io',
  ],
  reddit: [
    'reddit.com', 'redditstatic.com', 'redd.it', 'redditmedia.com',
  ],
  phantom: [
    'phantom.app', 'phantom.com',
  ],
  trezor: [
    'trezor.io',
  ],
  royalmail: [
    'royalmail.com',
  ],
  canadapost: [
    'canadapost.ca', 'canadapost-postescanada.ca',
  ],
  auspost: [
    'auspost.com.au',
  ],
};

/**
 * Checks whether two domains belong to the same verified corporate brand ecosystem
 * (e.g. apple.com and icloud.com, or microsoft.com and live.com).
 * @beta
 */
export function isSameBrandEcosystem(domainA: string, domainB: string): boolean {
  if (!domainA || !domainB) return false;
  const a = domainA.toLowerCase().trim();
  const b = domainB.toLowerCase().trim();
  if (a === b) return true;

  for (const ecosystem of Object.values(BRAND_ECOSYSTEMS)) {
    const aInEco = ecosystem.some((eco) => a === eco || a.endsWith('.' + eco));
    if (!aInEco) continue;
    const bInEco = ecosystem.some((eco) => b === eco || b.endsWith('.' + eco));
    if (bInEco) return true;
  }
  return false;
}

/**
 * Brand impersonation score with Punycode IDN homograph phishing defense.
 * The real brand on a non-abusive TLD is not a spoof (`paypal.com`, `login.github.com`).
 * A brand plus a credential lure on some other zone is (`paypal-login.azurewebsites.net`).
 * Homograph domains (`xn--pple-43d.com` -> `аpple.com`) are flagged immediately.
 * Benign multi-tenant SaaS / status dashboards (e.g. `apple.statuspage.io`) are protected.
 */
export function scoreBrandSpoof(domain: string): number {
  const clean = normalizeHostname(domain);
  if (!clean || !clean.includes('.')) return 0;

  // Institutional government/education or private local domains are never brand spoofs
  if (isInstitutionalDomain(clean) || isActiveDirectoryOrLocalDomain(clean)) {
    return 0;
  }

  // Decode Punycode labels if any
  const decodedParts = clean.split('.').map((part) => {
    if (part.startsWith('xn--')) {
      try {
        return normalizeHomoglyphs(decodePunycodeLabel(part));
      } catch {
        return part;
      }
    }
    return part;
  });
  const decodedClean = decodedParts.join('.');
  const hasPunycode = clean.includes('xn--');

  const decomposition = decomposeDomain(decodedClean);
  const sld = decomposition.sld.toLowerCase();
  const tld = decomposition.tld.toLowerCase();
  const abuseTld = HIGH_ABUSE_TLDS.has(tld);
  const labels = decodedClean.split('.').filter(Boolean);
  const infra = classifyInfrastructure(clean);

  for (const brand of HIGH_PROFILE_BRANDS) {
    // 1. Is the domain part of the brand's verified ecosystem (including CNAME CDN routing)?
    const ecosystem = BRAND_ECOSYSTEMS[brand];
    if (ecosystem) {
      const isEco = ecosystem.some((eco) => {
        if (clean === eco || clean.endsWith(`.${eco}`)) return true;
        // Check CDN DNS alias routing (e.g. 1.courier-push-apple.com.akadns.net)
        for (const cdnSuffix of CDN_ROUTING_SUFFIXES) {
          if (clean.endsWith(cdnSuffix)) {
            const inner = clean.slice(0, -cdnSuffix.length);
            if (inner === eco || inner.endsWith(`.${eco}`)) return true;
          }
        }
        return false;
      });
      if (isEco) continue;
    }

    // Check if the registrable domain or any label is an exempt dictionary compound word (e.g. snapple, pineapple, steamboat, purchaser, paperchase)
    const isDictionaryExempt =
      DICTIONARY_COMPOUND_EXEMPTIONS.has(sld) ||
      labels.some((l) => {
        if (DICTIONARY_COMPOUND_EXEMPTIONS.has(l) && l.includes(brand)) return true;
        const subTokens = l.split(/[-_]/).filter(Boolean);
        return subTokens.some((tok) => DICTIONARY_COMPOUND_EXEMPTIONS.has(tok) && tok.includes(brand));
      });
    if (isDictionaryExempt) {
      continue;
    }

    const isUntrustedPlatform = Array.from(UNTRUSTED_HOSTING_PLATFORMS).some(
      (platform) => tld === platform || clean === platform || clean.endsWith(`.${platform}`)
    );

    const registrableIsBrand = sld === brand;
    if (registrableIsBrand) {
      if (isUntrustedPlatform) {
        return 1;
      }
      if (abuseTld || hasPunycode) {
        return 1;
      }
      continue;
    }

    // Check if domain is a recognized multi-tenant SaaS platform or verified safe infrastructure
    const isMultiTenant = Array.from(MULTI_TENANT_PLATFORMS).some(
      (platform) => clean === platform || clean.endsWith(`.${platform}`)
    );
    const isSafeInfra = infra.safe && !infra.adNetwork && infra.kind !== 'tracker-network';

    // The final label is the TLD (`dns.google`), not an impersonation subdomain.
    for (const label of labels.slice(0, -1)) {
      const tokens = label.split(/[-_]/).filter(Boolean);
      const candidates = tokens.length > 1 ? [label, ...tokens] : [label];
      for (const tok of candidates) {
        if (tok === brand && !registrableIsBrand) {
          const isUntrustedPlatform = Array.from(UNTRUSTED_HOSTING_PLATFORMS).some(
            (platform) => clean === platform || clean.endsWith(`.${platform}`)
          );
          if (isUntrustedPlatform) {
            // Free hosting platform hosting a high-profile brand subdomain (e.g. paypal.workers.dev)
            return 1;
          }
          if (isMultiTenant || isSafeInfra) {
            // A brand token alone on an enterprise SaaS platform (e.g. apple.statuspage.io or apple.zendesk.com) is the company's legitimate tenant.
            // Only trigger if an explicit phishing keyword lure is attached to the label!
            if (PHISH_KEYWORDS.test(label) && label !== brand) {
              return 1;
            }
          } else {
            // On untrusted / arbitrary domains (e.g. apple.evil.com, apple-login.xyz, paypal-com.net)
            if (label === brand || PHISH_KEYWORDS.test(label) || PSEUDO_TLD_PATTERN.test(label)) {
              return 1;
            }
          }
        }
        if (isTypoSquat(tok, brand)) {
          if (isSafeInfra && !PHISH_KEYWORDS.test(label)) {
            continue;
          }
          return 1;
        }
      }
      // Combosquatting for 4+ letter brands (e.g. uspsdelivery, chasealert, robloxrewards)
      // Must be delimited or anchored to avoid matching distinct dictionary words (e.g. snapple, pineapple, steamboat)
      if (brand.length >= 4 && label.includes(brand) && label !== brand) {
        const isAnchoredOrDelimited =
          label.startsWith(brand + '-') ||
          label.endsWith('-' + brand) ||
          label.includes('-' + brand + '-') ||
          label.startsWith(brand) ||
          label.endsWith(brand);
        if (isAnchoredOrDelimited && PHISH_KEYWORDS.test(label) && !isSafeInfra && !isMultiTenant) {
          return 1;
        }
      }
      // Combosquatting for 3-letter brands (ups, dhl, pnc) anchored at start or end with a phish keyword lure
      if (brand.length === 3 && (label.startsWith(brand) || label.endsWith(brand)) && label !== brand && PHISH_KEYWORDS.test(label) && !isSafeInfra && !isMultiTenant) {
        return 1;
      }
      // Combosquatting with pseudo-TLD suffix on untrusted zones (e.g. paypalcom, applecom, netflixapp)
      if (label.startsWith(brand) && label !== brand && !isSafeInfra && !isMultiTenant) {
        const remainder = label.slice(brand.length).replace(/^[-_]+/, '');
        if (PSEUDO_TLD_SUFFIXES.has(remainder)) {
          return 1;
        }
      }
    }
  }
  return 0;
}

export function isBenignServiceEndpoint(domain: string): boolean {
  const clean = normalizeHostname(domain);
  if (!clean || clean.includes('xn--')) return false;
  const infra = classifyInfrastructure(clean);
  if (infra.adNetwork || infra.kind === 'tracker-network') return false;
  if (hasStrongAdIntent(clean)) return false;
  if (SUSPICIOUS_AD_TOKENS.some((tok) => hostnameHasToken(clean, tok))) return false;
  if (scoreBrandSpoof(clean) > 0) return false;

  const labels = clean.split('.').filter(Boolean);
  const matchesLabel = labels.some((label) => {
    if (BENIGN_ENDPOINT_LABELS.has(label)) return true;
    const stripped = label.replace(/\d+$/, '');
    if (stripped && BENIGN_ENDPOINT_LABELS.has(stripped)) return true;
    // Check hyphen-separated tokens against strict operational sub-tokens (e.g. courier-push, stream-cdn, auth-api)
    const subParts = label.split('-');
    if (subParts.length > 1) {
      return subParts.some((part) => {
        if (BENIGN_OPERATIONAL_SUB_LABELS.has(part)) return true;
        const strippedPart = part.replace(/\d+$/, '');
        return Boolean(strippedPart && BENIGN_OPERATIONAL_SUB_LABELS.has(strippedPart));
      });
    }
    return false;
  });
  if (!matchesLabel) return false;

  const decomposition = decomposeDomain(clean);
  if (HIGH_ABUSE_TLDS.has(decomposition.tld)) return false;

  const compact = decomposition.sld.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact.length >= 10) {
    const entropy = calculateShannonEntropy(compact);
    const digits = (compact.match(/\d/g) || []).length / compact.length;
    const vowels = (compact.match(/[aeiou]/g) || []).length / Math.max(1, compact.replace(/\d/g, '').length);
    if (entropy >= 3.3 && digits >= 0.15 && vowels < 0.28) return false;
  }
  return true;
}

function sldLooksStructural(sld: string): boolean {
  const parts = sld.toLowerCase().split(/[-_]/).filter(Boolean);
  return parts.some((part) => STRUCTURAL_SLD_WORDS.has(part));
}

/**
 * Malware requires a second, independent signal.
 * A random-looking cloud label or a readable parent zone is not enough.
 */
export function hasCorroboratedMalwareSignals(domain: string, features: ReputationFeatures): boolean {
  if (features.brandSpoofScore > 0) return true;
  if (features.punycode > 0 && (features.highRiskTld > 0 || features.brandSpoofScore > 0)) return true;

  const infra = classifyInfrastructure(domain);
  if (infra.safe) {
    // Verified safe infrastructure (cloud, platform, cdn, vendor, iot, dns)
    // is never treated as malware without brand impersonation or known malicious IOCs.
    return false;
  }

  if (isInstitutionalDomain(domain) || isActiveDirectoryOrLocalDomain(domain)) {
    return false;
  }

  const clean = normalizeHostname(domain);
  const isMultiTenant = Array.from(MULTI_TENANT_PLATFORMS).some(
    (platform) => clean === platform || clean.endsWith(`.${platform}`)
  );
  if (isMultiTenant && features.highRiskTld <= 0 && features.brandSpoofScore <= 0) {
    // Multi-tenant project subdomains (e.g. lqaitnsphcretimgxxdz.supabase.co, myapp.railway.app, etc.)
    // have high entropy or random hash names by platform design and are not DGA botnet malware.
    return false;
  }

  const decomp = decomposeDomain(clean);
  const sld = decomp.sld.toLowerCase();
  if (!sld || sldLooksStructural(sld)) return false;

  const compact = sld.replace(/[^a-z0-9]/g, '');
  const sldLong = compact.length >= 10;
  const sldDga = sldLong && features.trigramPerplexity >= 0.8 && features.entropySld >= 0.4;

  const subLabel = decomp.subdomains.length > 0 ? decomp.subdomains[0].toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const subDga = subLabel.length >= 10 && features.trigramPerplexity >= 0.8 && ((features.entropySubdomain || 0) >= 0.4 || features.entropySld >= 0.4);

  if (!sldDga && !subDga) return false;

  // Independent corroborating evidence:
  if (features.highRiskTld > 0) return true;
  if (features.consecutiveConsonants >= 0.6) return true;
  if (features.vowelRatio <= 0.1 && sldDga) return true;
  // A hex string on the registrable SLD itself on an untrusted zone is strong DGA evidence.
  // But a hex string on a subdomain of a normal readable SLD (e.g. git commit, asset hash, shard) is common benign infra!
  if (compact.length >= 16 && /^[a-f0-9]+$/i.test(compact)) return true;
  if (subLabel.length >= 16 && /^[a-f0-9]+$/i.test(subLabel) && (features.highRiskTld > 0 || sldDga)) return true;

  return false;
}

/**
 * Maps a raw model winner onto a verdict policy:
 * known networks stay threats, known infrastructure stays clean,
 * and malware requires corroborated evidence.
 */
export function adjustThreatCategory(
  domain: string,
  features: ReputationFeatures,
  category: ThreatCategory,
  probability: number,
  options?: { knownTrackerCname?: boolean; allowlisted?: boolean },
): CategoryAdjustment {
  if (options?.allowlisted) {
    return {
      category: 'Clean',
      probability: 0.99,
      policyReason: 'Verified Essential Infrastructure / Whitelisted (Protected by False Positive Guard)',
    };
  }

  // Deterministic user whitelist feedback override (False Positive guard)
  if (features.userTuneBias !== undefined && features.userTuneBias <= -0.9) {
    return {
      category: 'Clean',
      probability: 0.99,
      policyReason: 'Whitelisted by user feedback (False Positive Override)',
    };
  }

  const infra = classifyInfrastructure(domain);
  const adIntent = hasStrongAdIntent(domain);

  if (features.brandSpoofScore > 0) {
    return {
      category: 'Malware/Phishing',
      probability: Math.max(probability, 0.9),
      policyReason: 'Brand impersonation or typo-squatting credential harvesting pattern detected',
    };
  }

  if (options?.knownTrackerCname) {
    return {
      category: 'CNAME Cloaking',
      probability: Math.max(probability, 0.9),
    };
  }

  if (infra.kind === 'ad-network' || adIntent) {
    return {
      category: 'Advertising',
      probability: Math.max(probability, 0.9),
      policyReason: infra.reason || 'Advertising network token in hostname',
    };
  }

  if (infra.kind === 'tracker-network') {
    return {
      category: 'Telemetry/Analytics',
      probability: Math.max(probability, 0.86),
      policyReason: infra.reason,
    };
  }

  if (infra.safe || features.knownSafeInfra > 0) {
    return {
      category: 'Clean',
      probability: 0.99,
      policyReason: infra.reason || 'Verified essential infrastructure or user allowlist',
    };
  }

  if (isBenignServiceEndpoint(domain)) {
    return {
      category: 'Clean',
      probability: 0.88,
      policyReason: 'Product status, API, CDN, logistics, or update endpoint on a readable domain',
    };
  }

  if (category === 'Clean') {
    const hasAnyThreatSignal =
      features.adKeywordWeight > 0.3 ||
      features.trackerKeywordWeight > 0.3 ||
      features.brandSpoofScore > 0 ||
      features.highRiskTld > 0 ||
      (features.hexScore || 0) > 0 ||
      (features.cnameKnownTracker || 0) > 0 ||
      (features.consecutiveConsonants >= 0.5 && features.trigramPerplexity >= 0.7);

    if (!hasAnyThreatSignal) {
      return {
        category: 'Clean',
        probability: Math.max(probability, 0.88),
        policyReason: 'Standard lexical structure: no ad tokens, tracking beacons, or DGA patterns detected',
      };
    }
  }

  if (category === 'Malware/Phishing' && !hasCorroboratedMalwareSignals(domain, features)) {
    if (features.adKeywordWeight >= 0.9) {
      return { category: 'Advertising', probability: Math.max(probability, 0.8) };
    }
    if (features.adKeywordWeight >= 0.5) {
      return { category: 'Advertising', probability };
    }
    if (features.trackerKeywordWeight >= 0.9) {
      return { category: 'Telemetry/Analytics', probability: Math.max(probability, 0.8) };
    }
    if (features.trackerKeywordWeight >= 0.5) {
      return {
        category: 'Telemetry/Analytics',
        probability: Math.min(probability, 0.62),
        policyReason: 'Weak telemetry token without a known tracking network',
      };
    }

    const sldRandom = features.trigramPerplexity >= 0.85
      && features.entropySld >= 0.45
      && features.sldLength >= 0.28
      && features.highRiskTld <= 0;
    if (sldRandom) {
      return {
        category: 'Unknown',
        probability: 0.42,
        policyReason: 'Unusual lexical shape without corroborating malicious evidence',
      };
    }
    return {
      category: 'Clean',
      probability: 0.74,
      policyReason: 'No ad, tracker, or corroborated malware signals',
    };
  }

  return { category, probability };
}

/** Confidence is already on a 0–100 scale. Clamp so the UI cannot render above 100%. */
export function clampConfidencePercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function formatConfidencePercent(value: number | null | undefined): string {
  return `${clampConfidencePercent(value)}%`;
}

export function verdictBadgeLabel(verdict: string): string {
  switch (verdict) {
    case 'ad_server':
      return 'AD SERVER';
    case 'tracker':
      return 'TRACKER';
    case 'malicious':
      return 'MALWARE';
    case 'suspicious':
      return 'SUSPICIOUS';
    case 'clean':
      return 'CLEAN';
    default:
      return verdict.replace(/_/g, ' ').toUpperCase();
  }
}
