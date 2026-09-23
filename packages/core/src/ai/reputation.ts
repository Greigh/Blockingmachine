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
  'bond', 'casa', 'lol',
]);

/** Delimited ad-tech tokens. Short or generic words match only on label boundaries. */
export const SUSPICIOUS_AD_TOKENS = [
  'ads', 'adserver', 'adservice', 'adnxs', 'adform', 'adtech',
  'doubleclick', 'googleadservices', 'googlesyndication', 'moatads', 'amazon-adsystem',
  'bidder', 'bidding', 'prebid', 'openrtb', 'adkernel', 'adman', 'yieldlove',
  'smartclip', 'connatix', 'applovin', 'unityads', 'ironsrc', 'vungle', 'mintegral',
  'springserve', 'smaato', 'chartboost', 'liftoff',
  'popunder', 'popcash', 'propeller', 'propellerads', 'outbrain', 'taboola', 'mgid',
  'revcontent', 'criteo', 'pubmatic', 'rubiconproject', 'openx', 'casalemedia', 'smartadserver',
  'adsystem', 'adtrack', 'advert', 'advertising', 'adzerk', 'adblade',
] as const;

/**
 * Tracker tokens. Ambiguous words ('stats', 'counter', 'click', 'branch', 'adjust', 'segment')
 * are excluded as they frequently collide with legitimate sites; dedicated networks
 * are matched via TRACKER_NETWORK_SUFFIXES instead.
 */
export const SUSPICIOUS_TRACKER_TOKENS = [
  'pixel', 'beacon', 'telemetry', 'analytics', 'tracker', 'tracking',
  'conversion', 'attribution', 'affiliate',
  'scorecardresearch', 'quantserve', 'appsflyer', 'mixpanel',
  'amplitude', 'sentry', 'datadoghq', 'hotjar', 'fullstory',
  'mouseflow', 'optimizely', 'newrelic', 'heapanalytics',
  'googleanalytics', 'google-analytics', 'googletagmanager', 'googletagservices',
  'fingerprint', 'fingerprintjs', 'clarity', 'sessioncam', 'decibelinsight',
  'contentsquare', 'inspectlet', 'woopra', 'luckyorange', 'crazyegg',
  'singular', 'kochava', 'iterable', 'braze', 'onesignal', 'matomo', 'posthog',
] as const;

/** One hit on these names is enough to call a host an ad or tracker network. */
export const SPECIFIC_NETWORK_TOKENS = new Set<string>([
  'taboola', 'criteo', 'doubleclick', 'googleadservices', 'googlesyndication',
  'outbrain', 'moatads', 'adnxs', 'rubiconproject', 'pubmatic',
  'scorecardresearch', 'quantserve', 'googleanalytics', 'google-analytics',
  'googletagmanager', 'googletagservices', 'amazon-adsystem', 'adform',
  'casalemedia', 'smartadserver', 'propellerads', 'mgid', 'revcontent',
  'fingerprint', 'posthog', 'contentsquare', 'smartclip', 'connatix', 'yieldlove', 'adkernel',
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
  'popunder', 'preroll', 'sponsor', 'sponsors', 'adtech',
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
] as const;

const PHISH_KEYWORDS = /login|verify|security|auth|update|account|support|wallet|token|claim|signin|password|secure|unlock|billing|delivery|parcel|package|reschedule|tracking|track|seed|phrase|validate|portal|helpdesk|alert|banking|statement|overdue|invoice|recover|recovery|airdrop|mint|stake|presale|reward|rewards|vault|kyc|otp|2fa|mfa|credential|credentials|payout|refund|rebate|shipment|customs|redelivery|reship|courier|dispatch|suspend|suspended|suspension|unauthorized|restriction|restricted|action-required|violation/;

const PSEUDO_TLD_PATTERN = /(?:[-_](?:com|net|org|app|online|site|gov|co|info|io|xyz))(?:[-_]|$)/i;
const PSEUDO_TLD_SUFFIXES = new Set(['com', 'net', 'org', 'app', 'online', 'site', 'gov', 'co', 'info', 'io', 'xyz']);

const BENIGN_ENDPOINT_LABELS = new Set([
  'status', 'statuspage', 'uptime', 'health', 'healthz',
  'api', 'apis', 'cdn', 'static', 'assets',
  'update', 'updates', 'download', 'downloads', 'swupdate', 'firmware',
  'ocsp', 'crl', 'ntp', 'time', 'diag', 'diagnostics', 'setup',
  'mail', 'email', 'webmail', 'smtp', 'imap', 'pop', 'autodiscover',
  'portal', 'login', 'signin', 'auth', 'sso', 'idp', 'saml', 'oauth', 'accounts',
  'support', 'help', 'helpdesk', 'service', 'services', 'kb', 'faq', 'docs',
  'dev', 'developer', 'developers', 'git', 'gitlab', 'code', 'repo', 'pkg', 'npm',
  'vpn', 'remote', 'connect', 'gateway', 'access', 'secure',
  'app', 'apps', 'web', 'dashboard', 'admin', 'console', 'manage',
  'shop', 'store', 'cart', 'checkout', 'pay', 'billing',
  'cloud', 'hub', 'sync', 'storage', 'backup', 'files', 'media', 'img', 'images',
  'forum', 'community', 'news', 'blog', 'pub', 'public',
  'search', 'dns', 'ns', 'ns1', 'ns2',
  'test', 'demo', 'sandbox', 'stage', 'staging', 'preview', 'prod', 'production',
  'ping', 'check', 'captive', 'network',
  'meet', 'conference', 'chat', 'voice',
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
  'content', 'delivery', 'network',
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
  'connatix.com',
  'aniview.com',
  'springserve.com',
  'smaato.net',
  'chartboost.com',
  'applovin.com',
  'unityads.unity3d.com',
  'unityads.com',
  'liftoff.io',
  'mintegral.com',
  'adkernel.com',
  'yieldlove.com',
  'smartclip.tv',
  'smartclip.net',
  'admob.com',
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
  'google-analytics.com',
  'googleanalytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'analytics.google.com',
  'scorecardresearch.com',
  'quantserve.com',
  'branch.io',
  'app.link',
  'appsflyer.com',
  'adjust.com',
  'adjust.io',
  'mixpanel.com',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'hotjar.com',
  'fullstory.com',
  'mouseflow.com',
  'sentry.io',
  'nr-data.net',
  'newrelic.com',
  'optimizely.com',
  'chartbeat.com',
  'chartbeat.net',
  'demdex.net',
  'omtrdc.net',
  'everesttech.net',
  'bluekai.com',
  'krxd.net',
  'agkn.com',
  'tapad.com',
  'exelator.com',
  'connect.facebook.net',
  'facebook.net',
  'trackcmp.net',
  'crazyegg.com',
  'luckyorange.com',
  'inspectlet.com',
  'woopra.com',
  'clicky.com',
  'statcounter.com',
  'flurry.com',
  'singular.net',
  'kochava.com',
  'braze.com',
  'iterable.com',
  'onesignal.com',
  'heap.io',
  'heapanalytics.com',
  'loggly.com',
  'clarity.ms',
  'contentsquare.net',
  'decibelinsight.net',
  'sessioncam.com',
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
  'amazonvideo.com', 'primevideo.com',
  // Google Cloud and Google service endpoints
  'googleapis.com', 'google.com', 'gstatic.com', 'googleusercontent.com',
  'gvt1.com', 'gvt2.com', 'gvt3.com', '1e100.net', 'appspot.com',
  'googlehosted.com', 'withgoogle.com', 'googlezip.net', 'ggpht.com',
  'gmail.com', 'youtube.com', 'ytimg.com', 'googlevideo.com', 'android.com',
  'chromium.org', 'blogger.com', 'gcr.io', 'pkg.dev', 'cloudfunctions.net',
  'run.app', 'firebaseio.com', 'firebaseapp.com', 'web.app',
  // Enterprise cloud / identity / auth
  'docker.com', 'docker.io', 'postman.com', 'auth0.com', 'okta.com',
  'oktacdn.com', 'docusign.net', 'docusign.com', 'elastic.co',
] as const;

const CDN_SUFFIXES = [
  'cloudflare.com', 'cloudflare.net', 'cloudflare-dns.com',
  'fastly.net', 'fastlylb.net',
  'akamai.net', 'akamaized.net', 'akamaihd.net', 'akamaiedge.net',
  'edgekey.net', 'edgesuite.net', 'akamai.com',
  'jsdelivr.net', 'unpkg.com', 'bootstrapcdn.com', 'fontawesome.com', 'jquery.com',
  'stackpathcdn.com', 'cdnjs.com', 'bunny.net', 'b-cdn.net', 'keycdn.com', 'gcore.com',
] as const;

const IOT_SUFFIXES = [
  'meethue.com', 'philips-hue.com', 'philips.com', 'signify.com',
  'nest.com', 'dropcam.com', 'ring.com', 'ecobee.com',
  'wyze.com', 'wyzecam.com', 'tplinkcloud.com', 'tplinkra.com', 'tp-link.com',
  'kasasmart.com', 'tuya.com', 'tuyaus.com', 'tuyaeu.com', 'tuyacn.com',
  'smartthings.com', 'smartthingscloud.com', 'samsung.com', 'samsungcloud.com',
  'samsungiotcloud.com', 'samsungcloudplatform.com', 'samsungosp.com', 'samsungqbe.com',
  'lg.com', 'lge.com', 'lgthinq.com', 'lgsmartthinq.com', 'lgtvcommon.com', 'lgappstv.com',
  'sony.com', 'sonynetworkentertainment.com', 'playstation.com', 'playstation.net', 'sie.com',
  'vizio.com', 'viziotv.com',
  'sonos.com', 'irobot.com', 'arlo.com', 'arlocloud.com', 'eufylife.com', 'eufy.com',
  'blinkforhome.com', 'immedia-semi.com', 'august.com', 'yalehome.com', 'schlage.com',
  'honeywell.com', 'resideo.com', 'lutron.com', 'leviton.com', 'control4.com',
  'lifx.co', 'nanoleaf.me', 'govee.com', 'meross.com', 'shelly.cloud',
  'aqara.com', 'xiaomi.com', 'mi.com', 'mijia.com',
  'home-assistant.io', 'nabucasa.com', 'nuki.io',
  'bosch-smarthome.com', 'home-connect.com', 'myqdevice.com', 'chamberlain.com',
  'simplisafe.com', 'wink.com', 'insteon.com', 'logitech.com',
  'garmin.com', 'fitbit.com', 'withings.com',
  'synology.com', 'quickconnect.to', 'synology.me', 'qnap.com', 'myqnapcloud.com',
  'netgear.com', 'routerlogin.net', 'mynetgear.com',
  'asus.com', 'router.asus.com', 'asuscomm.com',
  'tplinkwifi.net', 'tplinknvr.net', 'linksys.com', 'linksyssmartwifi.com',
  'ubnt.com', 'ui.com', 'amplifi.com', 'hp.com', 'canon.com', 'epson.com', 'brother.com',
] as const;

const VENDOR_SUFFIXES = [
  'cursor.com', 'cursor.sh',
  'github.com', 'githubassets.com', 'githubusercontent.com',
  'gitlab.com', 'bitbucket.org', 'atlassian.com', 'atlassian.net',
  'slack.com', 'slack-edge.com', 'notion.so', 'notion.site', 'notion.com',
  'linear.app', 'figma.com',
  'dropbox.com', 'dropboxapi.com', 'dropboxusercontent.com',
  'zoom.us', 'zoom.com',
  'adobe.com', 'adobecc.com', 'adobelogin.com',
  'apple.com', 'apple-cloudkit.com', 'apple-dns.net', 'cdn-apple.com',
  'icloud.com', 'mzstatic.com', 'aaplimg.com', 'apple-mapkit.com',
  'mozilla.org', 'mozilla.com', 'mozilla.net', 'firefox.com',
  'spotify.com', 'scdn.co',
  'netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxso.net',
  'discord.com', 'discordapp.com', 'discord.gg', 'discord.media',
  'reddit.com', 'redditstatic.com', 'redd.it',
  'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamcontent.com', 'steamserver.net',
  'epicgames.com', 'unrealengine.com', 'ea.com', 'origin.com', 'electronicarts.com',
  'blizzard.com', 'battle.net', 'battlenet.com', 'ubisoft.com', 'uplay.com',
  'riotgames.com', 'leagueoflegends.com', 'xbox.com', 'xboxlive.com',
  'nintendo.com', 'nintendo.net', 'gog.com', 'rbxcdn.com', 'unity.com', 'unity3d.com',
  'counter-strike.net',
  'wikipedia.org', 'wikimedia.org',
  'openai.com', 'oaistatic.com', 'anthropic.com',
  'paypal.com', 'paypalobjects.com',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com',
  'fidelity.com', 'schwab.com', 'vanguard.com', 'amex.com', 'americanexpress.com', 'discover.com',
  'coinbase.com', 'binance.com',
  'facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com',
  'twitter.com', 'x.com', 'twimg.com',
  'roblox.com',
  'roku.com', 'rokutime.com', 'hulu.com', 'hulustream.com', 'disneyplus.com',
  'disney-plus.net', 'bamgrid.com', 'disney.com', 'max.com', 'hbomax.com', 'hbo.com',
  'peacocktv.com', 'paramountplus.com', 'paramount.com', 'plex.tv', 'plex.direct',
  'twitch.tv', 'ttvnw.net', 'jtvnw.net', 'vimeo.com', 'vimeocdn.com',
  'soundcloud.com', 'sndcdn.com', 'deezer.com', 'tidal.com', 'pandora.com', 'audible.com',
  'bose.com', 'boseconnect.com',
  'npmjs.com', 'npmjs.org', 'yarnpkg.com', 'pypi.org', 'python.org',
  'crates.io', 'rust-lang.org', 'golang.org', 'pkg.go.dev', 'rubygems.org',
  'archlinux.org', 'debian.org', 'ubuntu.com', 'fedoraproject.org', 'centos.org',
  'kernel.org', 'apache.org',
  'stackexchange.com', 'stackoverflow.com', 'superuser.com', 'serverfault.com',
  'askubuntu.com', 'mathoverflow.net', 'grafana.com',
  'asana.com', 'clickup.com', 'monday.com', 'basecamp.com', 'miro.com', 'airtable.com',
  'canva.com', 'grammarly.com', 'hubspot.com', 'salesforce.com', 'force.com',
  'zendesk.com', 'zdassets.com', 'freshdesk.com', 'intercom.io', 'intercomcdn.com',
  'stripe.com', 'stripe.network', 'square.com', 'squareup.com',
  'uber.com', 'lyft.com', 'airbnb.com', 'booking.com', 'expedia.com',
  'mayoclinic.org', 'hopkinsmedicine.org',
  'coursera.org', 'edx.org', 'udemy.com', 'khanacademy.org', 'duolingo.com',
  'britannica.com', 'dictionary.com', 'merriam-webster.com',
  'weather.com', 'accuweather.com', 'flightaware.com', 'flightradar24.com',
  'statuspage.io', 'service-now.com', 'custhelp.com', 'jira.com', 'confluence.cloud',
  'usps.com', 'ups.com', 'fedex.com', 'dhl.com',
] as const;

const PLATFORM_SUFFIXES = [
  'github.io', 'gitlab.io', 'herokuapp.com', 'herokussl.com', 'netlify.app', 'vercel.app',
  'pages.dev', 'workers.dev', 'r2.dev', 'digitalocean.com',
  'digitaloceanspaces.com', 'ondigitalocean.com',
  'statuspage.io', 'service-now.com', 'custhelp.com',
] as const;

const DNS_SUFFIXES = [
  'one.one.one.one', 'dns.google', 'quad9.net',
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

export function normalizeHostname(input: string): string {
  let clean = input.trim().toLowerCase();
  // Strip hosts file prefixes (e.g. "0.0.0.0 domain.com", "127.0.0.1 domain.com", "::1 domain.com")
  clean = clean.replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|\S+@)\s+/, '');
  // Strip ABP / AdGuard rule prefixes and modifiers (e.g. "||domain.com^$third-party" -> "domain.com")
  clean = clean.replace(/^\|\|/, '');
  clean = clean.replace(/\^.*$/, '');
  clean = clean.replace(/\$.*$/, '');
  // Strip wildcards (e.g. "*.domain.com" -> "domain.com")
  clean = clean.replace(/^\*\.?/, '');
  // Strip protocol scheme (http://, https://, etc.)
  clean = clean.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // Strip path, query params, hash fragments
  clean = clean.split('/')[0]?.split('?')[0]?.split('#')[0] ?? clean;
  // Strip port numbers (when not an IPv6 address)
  if (!clean.includes('::') && (clean.match(/:/g) || []).length === 1) {
    clean = clean.split(':')[0] ?? clean;
  }
  // Strip leading and trailing dots
  clean = clean.replace(/^\.+|\.+$/g, '');
  if (clean.endsWith('.')) clean = clean.slice(0, -1);
  return clean;
}

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

  // Country-code institutional second-level domains (.gov.xx, .gouv.xx, .gob.xx, .ac.xx, .edu.xx, .mil.xx)
  if (parts.length >= 3) {
    if (sld === 'gov' || sld === 'gouv' || sld === 'gob' || sld === 'ac' || sld === 'edu' || sld === 'mil') {
      return true;
    }
  }

  // Specific national government zones
  if (clean === 'gc.ca' || clean.endsWith('.gc.ca') || clean.endsWith('.fed.us')) {
    return true;
  }

  return false;
}

/**
 * Detects Microsoft Active Directory, domain controllers, and private corporate LAN infrastructure.
 */
export function isActiveDirectoryOrLocalDomain(domain: string): boolean {
  const clean = normalizeHostname(domain);
  if (!clean) return false;

  // Never match known advertising or tracking networks as Active Directory
  if (matchIndexed(clean, AD_INDEX) || matchIndexed(clean, TRACKER_INDEX)) {
    return false;
  }

  const labels = clean.split('.');

  // Internal LAN / corp TLDs
  const tld = labels[labels.length - 1];
  if (
    tld === 'local' ||
    tld === 'corp' ||
    tld === 'internal' ||
    tld === 'lan' ||
    tld === 'home' ||
    tld === 'priv' ||
    tld === 'intra' ||
    clean.endsWith('.home.arpa')
  ) {
    return true;
  }

  // Active Directory and domain controller prefix/labels:
  // ad.domain.com, dc1.ad.company.com, adfs.school.edu, kdc.corp.org, ldap.company.com
  const firstLabel = labels[0];
  if (
    firstLabel === 'ad' ||
    firstLabel === 'adfs' ||
    firstLabel === 'kdc' ||
    firstLabel === 'ldap' ||
    firstLabel === 'ldaps'
  ) {
    return true;
  }
  // Subdomain labeled .ad. or .dc. (e.g. dc01.ad.example.com)
  if (labels.length >= 3 && (labels[1] === 'ad' || labels[labels.length - 2] === 'ad')) {
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
    clean === 'greasyloss.com' || clean.endsWith('.greasyloss.com')
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

  // 8. Generic Anti-Adblock & FuckAdBlock / BlockAdBlock / Bait systems
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
  'box.com', 'docusign.net', 'docusign.com', 'notion.site',
]);

/**
 * Legitimate second-level domains and infrastructure owned by high-profile brands.
 * Subdomains on these ecosystem domains are authentic properties, not impersonation spoofs.
 */
export const BRAND_ECOSYSTEMS: Record<string, readonly string[]> = {
  microsoft: [
    'microsoft.com', 'microsoftonline.com', 'azure.com', 'azurewebsites.net',
    'office.com', 'office365.com', 'sharepoint.com', 'outlook.com', 'live.com',
    'bing.com', 'visualstudio.com', 'msn.com', 'windows.net', 'windows.com',
    'msedge.net', 'xbox.com', 'linkedin.com', 'skype.com', 's-microsoft.com',
    'msftconnecttest.com', 'msftncsi.com', 'gfx.ms',
  ],
  google: [
    'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com',
    'youtube.com', 'gmail.com', 'android.com', '1e100.net', 'appspot.com',
    'withgoogle.com', 'gvt1.com', 'gvt2.com', 'gvt3.com', 'pkg.dev', 'run.app',
    'firebaseio.com', 'firebaseapp.com', 'web.app', 'blogger.com', 'chromium.org',
  ],
  apple: [
    'apple.com', 'icloud.com', 'apple-cloudkit.com', 'apple-dns.net',
    'cdn-apple.com', 'mzstatic.com', 'aaplimg.com', 'apple-mapkit.com', 'apple.news',
  ],
  amazon: [
    'amazon.com', 'amazonaws.com', 'cloudfront.net', 'awsstatic.com',
    'amazontrust.com', 'a2z.com', 'media-amazon.com', 'ssl-images-amazon.com',
    'amazonvideo.com', 'primevideo.com',
  ],
  facebook: [
    'facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com',
    'whatsapp.com', 'messenger.com', 'meta.com',
  ],
  github: [
    'github.com', 'githubassets.com', 'githubusercontent.com', 'github.io',
  ],
  twitter: [
    'twitter.com', 'x.com', 'twimg.com', 't.co',
  ],
  steam: [
    'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamcontent.com', 'steamserver.net',
  ],
  discord: [
    'discord.com', 'discordapp.com', 'discord.gg', 'discord.media',
  ],
  netflix: [
    'netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxso.net',
  ],
  paypal: [
    'paypal.com', 'paypalobjects.com',
  ],
  usps: [
    'usps.com', 'usps.gov',
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
  coinbase: [
    'coinbase.com',
  ],
  binance: [
    'binance.com',
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
};

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
    // 1. Is the domain part of the brand's verified ecosystem?
    const ecosystem = BRAND_ECOSYSTEMS[brand];
    if (ecosystem && ecosystem.some((eco) => clean === eco || clean.endsWith(`.${eco}`))) {
      continue;
    }

    const registrableIsBrand = sld === brand;
    if (registrableIsBrand && !abuseTld && !hasPunycode) continue;
    if (registrableIsBrand && (abuseTld || hasPunycode)) return 1;

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
          if (isMultiTenant || isSafeInfra) {
            // A brand token alone (e.g. apple.statuspage.io or apple.zendesk.com) is the company's legitimate tenant.
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
      if (brand.length >= 4 && label.includes(brand) && label !== brand && PHISH_KEYWORDS.test(label)) {
        return 1;
      }
      // Combosquatting for 3-letter brands (ups, dhl, pnc) anchored at start or end with a phish keyword lure
      if (brand.length === 3 && (label.startsWith(brand) || label.endsWith(brand)) && label !== brand && PHISH_KEYWORDS.test(label)) {
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
  if (scoreBrandSpoof(clean) > 0) return false;

  const labels = clean.split('.').filter(Boolean);
  if (!labels.some((label) => BENIGN_ENDPOINT_LABELS.has(label))) return false;

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

  const decomp = decomposeDomain(normalizeHostname(domain));
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
  if (features.vowelRatio <= 0.1) return true;
  if ((compact.length >= 16 && /^[a-f0-9]+$/i.test(compact)) || (subLabel.length >= 16 && /^[a-f0-9]+$/i.test(subLabel))) return true;

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
      probability: 0.86,
      policyReason: 'Product status, API, CDN, or update endpoint on a readable domain',
    };
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
