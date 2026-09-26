import { normalizeHostname } from './hostname.js';
import type { DomainDecomposition, DomainLabelEntropy, DgaDetectionResult } from './types.js';

/**
 * Shannon entropy and lexical analysis for DGA and randomized ad tracker detection.
 * @beta
 */

// Bounded LRU caches for high-throughput DNS and query-log stream evaluation
const ENTROPY_CACHE_MAX_SIZE = 4096;
const ENTROPY_CACHE = new Map<string, number>();

const DECOMPOSE_CACHE_MAX_SIZE = 2048;
const DECOMPOSE_CACHE = new Map<string, DomainDecomposition>();

/**
 * Resets the in-memory entropy and domain decomposition caches.
 * Useful for test suites and memory hygiene in long-lived server processes.
 */
export function clearEntropyCache(): void {
  ENTROPY_CACHE.clear();
  DECOMPOSE_CACHE.clear();
}

/**
 * Calculates Shannon entropy for a given string: H(X) = -sum(P(x) * log2(P(x))).
 * High-throughput implementation using ASCII frequency tables and bounded LRU caching.
 */
export function calculateShannonEntropy(str: string): number {
  if (typeof str !== 'string' || str.length === 0) return 0;
  if (str.length === 1) return 0;

  const lower = str.toLowerCase();

  // Cache hit
  const cached = ENTROPY_CACHE.get(lower);
  if (cached !== undefined) {
    ENTROPY_CACHE.delete(lower);
    ENTROPY_CACHE.set(lower, cached);
    return cached;
  }

  const len = lower.length;
  // Fast path for standard ASCII characters without heap object allocation
  const freq = new Uint32Array(128);
  let isAscii = true;
  for (let i = 0; i < len; i++) {
    const code = lower.charCodeAt(i);
    if (code < 128) {
      freq[code]++;
    } else {
      isAscii = false;
      break;
    }
  }

  let entropy = 0;
  if (isAscii) {
    for (let i = 0; i < 128; i++) {
      const count = freq[i];
      if (count > 0) {
        const p = count / len;
        entropy -= p * Math.log2(p);
      }
    }
  } else {
    // Unicode fallback
    const frequencies = new Map<string, number>();
    for (const char of lower) {
      frequencies.set(char, (frequencies.get(char) || 0) + 1);
    }
    const codePointCount = Array.from(lower).length;
    for (const count of frequencies.values()) {
      const p = count / codePointCount;
      entropy -= p * Math.log2(p);
    }
  }

  const result = Math.round(entropy * 1000) / 1000;

  // Only cache domain labels and short tokens (DNS label max is 63 octets)
  if (len <= 64) {
    if (ENTROPY_CACHE.size >= ENTROPY_CACHE_MAX_SIZE) {
      const oldestKey = ENTROPY_CACHE.keys().next().value;
      if (oldestKey !== undefined) {
        ENTROPY_CACHE.delete(oldestKey);
      }
    }
    ENTROPY_CACHE.set(lower, result);
  }

  return result;
}

/**
 * Common operational, infrastructural, and protocol prefixes that should not be evaluated
 * as candidate randomized tracking or DGA labels.
 */
export const BENIGN_STRUCTURAL_PREFIXES = new Set([
  'www', 'mail', 'webmail', 'email', 'smtp', 'imap', 'pop', 'pop3', 'mx',
  'api', 'api-v2', 'apiv2', 'cdn', 'static', 'assets', 'ns1', 'ns2', 'ns3', 'ns4', 'ns',
  'status', 'health', 'ping', 'push', 'courier', 'stream', 'relay', 'gateway', 'proxy',
  'edge', 'media', 'images', 'img', 'video', 'content', 'preview', 'download',
  'auth', 'login', 'signin', 'sso', 'oauth', 'account', 'accounts', 'billing',
  'portal', 'dashboard', 'admin', 'app', 'apps', 'web', 'secure', 'vpn', 'remote',
  'dev', 'stage', 'staging', 'test', 'uat', 'prod', 'production', 'internal',
]);

/**
 * Four-part public suffixes (cloud storage containers, dual-stack endpoints).
 */
export const FOUR_PART_PUBLIC_SUFFIXES = new Set([
  'blob.core.windows.net',
  'file.core.windows.net',
  'table.core.windows.net',
  'queue.core.windows.net',
  's3.dualstack.amazonaws.com',
]);

/**
 * Three-part public suffixes (regional state governments, health bodies, cloud object stores).
 */
export const THREE_PART_PUBLIC_SUFFIXES = new Set([
  // Australian State & Territory Governments
  'act.gov.au', 'nsw.gov.au', 'nt.gov.au', 'qld.gov.au', 'sa.gov.au', 'tas.gov.au', 'vic.gov.au', 'wa.gov.au',
  // Australian State & Territory Education
  'act.edu.au', 'nsw.edu.au', 'nt.edu.au', 'qld.edu.au', 'sa.edu.au', 'tas.edu.au', 'vic.edu.au', 'wa.edu.au',
  // UK NHS Regional / National bodies
  'scot.nhs.uk', 'wales.nhs.uk',
  // Canadian Provincial Governments
  'gov.ab.ca', 'gov.bc.ca', 'gov.mb.ca', 'gov.nb.ca', 'gov.nl.ca', 'gov.ns.ca',
  'gov.nt.ca', 'gov.nu.ca', 'gov.on.ca', 'gov.pe.ca', 'gov.qc.ca', 'gov.sk.ca', 'gov.yk.ca',
  // Cloud Object Storage & PaaS multi-tenant endpoints
  's3.amazonaws.com', 'cloudapp.azure.com', 'up.railway.app',
  // Japanese Municipalities / Prefectures
  'metro.tokyo.jp', 'pref.aichi.jp', 'pref.akita.jp', 'pref.aomori.jp', 'pref.chiba.jp',
  'pref.ehime.jp', 'pref.fukui.jp', 'pref.fukuoka.jp', 'pref.fukushima.jp', 'pref.gifu.jp',
  'pref.gunma.jp', 'pref.hiroshima.jp', 'pref.hokkaido.jp', 'pref.hyogo.jp', 'pref.ibaraki.jp',
  'pref.ishikawa.jp', 'pref.iwate.jp', 'pref.kagawa.jp', 'pref.kagoshima.jp', 'pref.kanagawa.jp',
  'pref.kochi.jp', 'pref.kumamoto.jp', 'pref.kyoto.jp', 'pref.mie.jp', 'pref.miyagi.jp',
  'pref.miyazaki.jp', 'pref.nagano.jp', 'pref.nagasaki.jp', 'pref.nara.jp', 'pref.niigata.jp',
  'pref.oita.jp', 'pref.okayama.jp', 'pref.okinawa.jp', 'pref.osaka.jp', 'pref.saga.jp',
  'pref.saitama.jp', 'pref.shiga.jp', 'pref.shimane.jp', 'pref.shizuoka.jp', 'pref.tochigi.jp',
  'pref.tokushima.jp', 'pref.tottori.jp', 'pref.toyama.jp', 'pref.wakayama.jp', 'pref.yamagata.jp',
  'pref.yamaguchi.jp', 'pref.yamanashi.jp',
]);

/**
 * Common two-part public suffixes / compound ccTLDs across global jurisdictions.
 */
export const COMPOUND_CCTLDS = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'sch.uk', 'police.uk', 'mod.uk', 'nhs.uk',
  // Australia
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au', 'csiro.au',
  // New Zealand
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'edu.nz', 'geek.nz', 'school.nz', 'mil.nz', 'iwi.nz', 'maori.nz',
  // Japan
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
  // South Korea
  'co.kr', 'ne.kr', 'or.kr', 're.kr', 'pe.kr', 'go.kr', 'mil.kr', 'ac.kr', 'hs.kr', 'ms.kr', 'es.kr', 'sc.kr', 'kg.kr', 'seoul.kr', 'busan.kr',
  // Brazil
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'mil.br', 'art.br', 'adv.br', 'med.br', 'mus.br', 'eng.br', 'ind.br', 'inf.br', 'jus.br', 'leg.br', 'mp.br', 'rec.br', 'srv.br', 'tur.br', 'tv.br', 'etc.br',
  // Mexico
  'com.mx', 'org.mx', 'edu.mx', 'gob.mx', 'net.mx',
  // Singapore
  'com.sg', 'org.sg', 'net.sg', 'gov.sg', 'edu.sg', 'per.sg',
  // South Africa
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'edu.za', 'web.za', 'law.za', 'school.za',
  // Turkey
  'com.tr', 'org.tr', 'net.tr', 'gov.tr', 'edu.tr', 'bel.tr', 'pol.tr', 'k12.tr', 'bbs.tr', 'biz.tr', 'info.tr', 'gen.tr', 'tv.tr', 'av.tr', 'dr.tr',
  // Taiwan
  'com.tw', 'org.tw', 'net.tw', 'gov.tw', 'edu.tw', 'idv.tw', 'club.tw', 'ebiz.tw', 'game.tw',
  // Hong Kong
  'com.hk', 'org.hk', 'net.hk', 'gov.hk', 'edu.hk', 'idv.hk',
  // India
  'co.in', 'net.in', 'org.in', 'gov.in', 'nic.in', 'ac.in', 'edu.in', 'res.in', 'gen.in', 'ind.in', 'firm.in', 'mil.in',
  // Canada
  'gc.ca', 'ab.ca', 'bc.ca', 'mb.ca', 'nb.ca', 'nl.ca', 'ns.ca', 'nt.ca', 'nu.ca', 'on.ca', 'pe.ca', 'qc.ca', 'sk.ca', 'yk.ca',
  // China
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
  'ah.cn', 'bj.cn', 'cq.cn', 'fj.cn', 'gd.cn', 'gs.cn', 'gz.cn', 'gx.cn', 'ha.cn', 'hb.cn', 'he.cn',
  'hi.cn', 'hl.cn', 'hn.cn', 'jl.cn', 'js.cn', 'jx.cn', 'ln.cn', 'nm.cn', 'nx.cn', 'qh.cn', 'sc.cn',
  'sd.cn', 'sh.cn', 'sn.cn', 'sx.cn', 'tj.cn', 'xj.cn', 'xz.cn', 'yn.cn', 'zj.cn',
  // Argentina
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'gov.ar', 'edu.ar', 'int.ar', 'mil.ar', 'musica.ar', 'tur.ar',
  // Colombia
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co', 'mil.co', 'nom.co',
  // Philippines
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph', 'ngo.ph', 'mil.ph',
  // Pakistan
  'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk', 'fam.pk', 'biz.pk', 'web.pk',
  // Nigeria
  'com.ng', 'net.ng', 'org.ng', 'gov.ng', 'edu.ng', 'sch.ng', 'mobi.ng', 'mil.ng',
  // Ukraine
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua', 'in.ua', 'dp.ua', 'kiev.ua', 'kyiv.ua', 'lviv.ua', 'odessa.ua', 'kharkiv.ua', 'dnepr.ua',
  // Israel
  'co.il', 'org.il', 'net.il', 'gov.il', 'ac.il', 'muni.il', 'idf.il', 'k12.il',
  // Russia
  'com.ru', 'net.ru', 'org.ru', 'gov.ru', 'edu.ru', 'ac.ru', 'mil.ru', 'msk.ru', 'spb.ru',
  // Spain
  'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es',
  // Poland
  'com.pl', 'net.pl', 'org.pl', 'info.pl', 'biz.pl', 'gov.pl', 'edu.pl', 'mil.pl', 'waw.pl', 'krakow.pl', 'poznan.pl', 'gda.pl', 'wroc.pl',
  // Italy
  'gov.it', 'edu.it',
  // France
  'asso.fr', 'presse.fr', 'tm.fr', 'gouv.fr',
  // Germany
  'gov.de',
  // Greece
  'com.gr', 'edu.gr', 'net.gr', 'org.gr', 'gov.gr',
  // Portugal
  'com.pt', 'edu.pt', 'org.pt', 'gov.pt', 'nome.pt',
  // Malaysia
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my', 'mil.my',
  // Thailand
  'co.th', 'ac.th', 'go.th', 'or.th', 'net.th', 'mi.th', 'in.th',
  // Vietnam
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn', 'int.vn', 'ac.vn', 'biz.vn', 'info.vn', 'name.vn', 'pro.vn', 'health.vn',
  // Indonesia
  'co.id', 'net.id', 'or.id', 'go.id', 'ac.id', 'sch.id', 'mil.id', 'web.id', 'my.id', 'biz.id', 'desa.id',
  // Chile, Peru, Venezuela, Uruguay, Ecuador, Guatemala, Panama, Dominican Republic, Puerto Rico, Costa Rica, Bolivia, Paraguay
  'com.cl', 'gob.cl', 'nom.cl', 'co.cl',
  'com.pe', 'org.pe', 'net.pe', 'gob.pe', 'edu.pe', 'mil.pe', 'nom.pe',
  'com.ve', 'net.ve', 'org.ve', 'gob.ve', 'edu.ve', 'mil.ve', 'co.ve', 'info.ve',
  'com.uy', 'edu.uy', 'gub.uy', 'org.uy', 'net.uy', 'mil.uy',
  'com.ec', 'edu.ec', 'gob.ec', 'org.ec', 'net.ec', 'mil.ec', 'fin.ec', 'med.ec',
  'com.gt', 'gob.gt', 'edu.gt', 'net.gt', 'org.gt', 'ind.gt', 'mil.gt',
  'com.pa', 'gob.pa', 'edu.pa', 'net.pa', 'org.pa', 'sld.pa', 'ac.pa', 'nom.pa',
  'com.do', 'gob.do', 'edu.do', 'org.do', 'net.do', 'sld.do', 'art.do', 'web.do',
  'com.pr', 'org.pr', 'edu.pr', 'gov.pr', 'net.pr', 'isla.pr', 'pro.pr', 'biz.pr', 'info.pr', 'name.pr', 'est.pr', 'prof.pr', 'ac.pr',
  'co.cr', 'go.cr', 'ed.cr', 'fi.cr', 'or.cr', 'sa.cr',
  'com.bo', 'gob.bo', 'edu.bo', 'org.bo', 'net.bo', 'mil.bo', 'tv.bo',
  'com.py', 'gov.py', 'edu.py', 'org.py', 'net.py', 'mil.py',
  // Ireland, Switzerland, Netherlands, Sweden, Norway, Austria
  'gov.ie', 'admin.ch', 'politie.nl', 'overheid.nl',
  'org.se', 'pp.se', 'tm.se', 'brand.se', 'parti.se', 'press.se',
  'kommune.no', 'fylkeskeskommune.no', 'priv.no', 'stat.no', 'dep.no',
  'co.at', 'or.at', 'gv.at', 'ac.at',
  // Middle East & North Africa
  'com.eg', 'gov.eg', 'edu.eg', 'org.eg', 'net.eg',
  'com.sa', 'gov.sa', 'edu.sa', 'org.sa', 'net.sa', 'med.sa', 'pub.sa',
  'co.ae', 'gov.ae', 'ac.ae', 'org.ae', 'net.ae', 'sch.ae', 'mil.ae',
  'com.qa', 'gov.qa', 'edu.qa', 'org.qa', 'net.qa', 'mil.qa',
  'com.kw', 'gov.kw', 'edu.kw', 'org.kw', 'net.kw',
  'com.om', 'gov.om', 'edu.om', 'org.om', 'net.om', 'co.om',
  'com.bh', 'gov.bh', 'edu.bh', 'org.bh', 'net.bh',
  'com.jo', 'gov.jo', 'edu.jo', 'org.jo', 'net.jo',
  'com.lb', 'gov.lb', 'edu.lb', 'org.lb', 'net.lb',
  // Kenya, Tanzania, Uganda, Ghana
  'co.ke', 'go.ke', 'or.ke', 'ac.ke', 'sc.ke', 'me.ke', 'mobi.ke', 'info.ke',
  'co.tz', 'go.tz', 'or.tz', 'ac.tz', 'sc.tz', 'ne.tz', 'mil.tz',
  'co.ug', 'go.ug', 'or.ug', 'ac.ug', 'sc.ug', 'ne.ug',
  'com.gh', 'gov.gh', 'edu.gh', 'org.gh',
  // Bangladesh, Nepal, Sri Lanka
  'com.bd', 'gov.bd', 'edu.bd', 'org.bd', 'net.bd', 'mil.bd', 'ac.bd',
  'com.np', 'gov.np', 'edu.np', 'org.np', 'net.np', 'mil.np',
  'com.lk', 'gov.lk', 'edu.lk', 'org.lk', 'net.lk', 'hotel.lk',
]);

/**
 * Dynamic DNS, multi-tenant hosting, and serverless application platforms where
 * the sub-label is the autonomous tenant/project SLD.
 */
export const DYNAMIC_DNS_SUFFIXES = new Set([
  'duckdns.org', 'no-ip.org', 'no-ip.biz', 'no-ip.info', 'ngrok-free.app', 'ngrok.app', 'ngrok.io',
  'ddns.net', 'zapto.org', 'bounceme.net', 'hopto.org', 'freeddns.org',
  'dynu.net', 'github.io', 'gitlab.io', 'workers.dev', 'pages.dev', 'r2.dev', 'vercel.app', 'vercel.dev',
  'netlify.app', 'netlify.com', 'web.app', 'firebaseapp.com', 'glitch.me', 'glitch.app',
  'supabase.co', 'supabase.in', 'supabase.net', 'supabase.com',
  'neon.tech', 'planetscale.com', 'turso.io', 'modal.run', 'val.town', 'convex.cloud',
  'railway.app', 'up.railway.app', 'onrender.com', 'render.com', 'koyeb.app', 'northflank.app',
  'fly.dev', 'fly.io', 'deno.dev', 'replit.app', 'replit.dev', 'repl.co',
  'cloudflarepages.com', 'azurewebsites.net', 'cloudfunctions.net', 'run.app',
  'myshopify.com', 'wordpress.com', 'ghost.io', 'wixsite.com', 'kinsta.cloud',
  'herokuapp.com', 'herokussl.com', 'hasura.app', 'deta.app', 'deta.dev',
  'surge.sh', 'now.sh', 'zeit.co', 'vapor.cloud', 'localtunnel.me', 'pagekite.me',
  'serveo.net', 'telebit.io', 'pinggy.link', 'gitpod.io', 'codespaces.com',
  'csb.app', 'stackblitz.io', 'webflow.io', 'framer.app', 'framer.website',
  'carrd.co', 'hashnode.dev', 'notion.site', 'typedream.app',
  's3.amazonaws.com', 'blob.core.windows.net', 'cloudfront.net', 'azureedge.net',
  'cloudapp.azure.com', 'trafficmanager.net', '000webhostapp.com', 'blogspot.com',
]);

function cloneDecomposition(value: DomainDecomposition): DomainDecomposition {
  return {
    ...value,
    subdomains: [...value.subdomains],
    labelEntropies: value.labelEntropies.map((label) => ({ ...label })),
  };
}

/**
 * Decomposes domain into SLD, TLD, subdomains and calculates Shannon entropy for each label.
 * Correctly accounts for 3-part public suffixes, compound ccTLDs (e.g. .co.uk, .com.au)
 * and dynamic DNS / serverless hosting providers.
 * @beta
 */
export function decomposeDomain(domain: string): DomainDecomposition {
  const clean = normalizeHostname(domain);

  if (!clean) {
    return {
      sld: '',
      tld: '',
      subdomains: [],
      labelEntropies: [],
    };
  }

  // Fast cache hit
  const cached = DECOMPOSE_CACHE.get(clean);
  if (cached !== undefined) {
    DECOMPOSE_CACHE.delete(clean);
    DECOMPOSE_CACHE.set(clean, cached);
    return cloneDecomposition(cached);
  }

  const parts = clean.split('.').filter(Boolean);

  // Single label or IPv4 check
  const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean);
  if (parts.length <= 1 || isIpv4) {
    const ent = calculateShannonEntropy(clean);
    const res: DomainDecomposition = {
      sld: clean,
      tld: '',
      subdomains: [],
      labelEntropies: [{ label: clean, entropy: ent, isSuspicious: !isIpv4 && ent >= 3.8 }],
    };
    return res;
  }

  let tld: string;
  let sld: string;
  let subdomains: string[];

  // If the entire domain itself is a public suffix (e.g. 'co.uk', 'nsw.gov.au', or 'blob.core.windows.net')
  if (
    FOUR_PART_PUBLIC_SUFFIXES.has(clean) ||
    THREE_PART_PUBLIC_SUFFIXES.has(clean) ||
    COMPOUND_CCTLDS.has(clean) ||
    DYNAMIC_DNS_SUFFIXES.has(clean)
  ) {
    tld = clean;
    sld = clean;
    subdomains = [];
  } else if (parts.length >= 5) {
    const lastFour = `${parts[parts.length - 4]}.${parts[parts.length - 3]}.${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (FOUR_PART_PUBLIC_SUFFIXES.has(lastFour)) {
      tld = lastFour;
      sld = parts[parts.length - 5];
      subdomains = parts.slice(0, parts.length - 5);
    } else {
      const lastThree = `${parts[parts.length - 3]}.${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      if (THREE_PART_PUBLIC_SUFFIXES.has(lastThree) || DYNAMIC_DNS_SUFFIXES.has(lastThree)) {
        tld = lastThree;
        sld = parts[parts.length - 4];
        subdomains = parts.slice(0, parts.length - 4);
      } else {
        const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
        if (COMPOUND_CCTLDS.has(lastTwo) || DYNAMIC_DNS_SUFFIXES.has(lastTwo)) {
          tld = lastTwo;
          sld = parts[parts.length - 3];
          subdomains = parts.slice(0, parts.length - 3);
        } else {
          tld = parts[parts.length - 1];
          sld = parts[parts.length - 2];
          subdomains = parts.slice(0, parts.length - 2);
        }
      }
    }
  } else if (parts.length >= 4) {
    const lastThree = `${parts[parts.length - 3]}.${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (THREE_PART_PUBLIC_SUFFIXES.has(lastThree) || DYNAMIC_DNS_SUFFIXES.has(lastThree)) {
      tld = lastThree;
      sld = parts[parts.length - 4];
      subdomains = parts.slice(0, parts.length - 4);
    } else {
      const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      if (COMPOUND_CCTLDS.has(lastTwo) || DYNAMIC_DNS_SUFFIXES.has(lastTwo)) {
        tld = lastTwo;
        sld = parts[parts.length - 3];
        subdomains = parts.slice(0, parts.length - 3);
      } else {
        tld = parts[parts.length - 1];
        sld = parts[parts.length - 2];
        subdomains = parts.slice(0, parts.length - 2);
      }
    }
  } else if (parts.length === 3) {
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (COMPOUND_CCTLDS.has(lastTwo) || DYNAMIC_DNS_SUFFIXES.has(lastTwo)) {
      tld = lastTwo;
      sld = parts[parts.length - 3];
      subdomains = [];
    } else {
      tld = parts[parts.length - 1];
      sld = parts[parts.length - 2];
      subdomains = [parts[0]];
    }
  } else {
    // 2 parts
    tld = parts[1];
    sld = parts[0];
    subdomains = [];
  }

  const labelEntropies: DomainLabelEntropy[] = parts.map((label) => {
    const entropy = calculateShannonEntropy(label);
    const isPunycode = label.startsWith('xn--');
    // Flag label if it exhibits abnormally high entropy for its character length
    const isSuspicious = !isPunycode && label.length >= 8 && entropy >= 3.4;
    return { label, entropy, isSuspicious };
  });

  const res: DomainDecomposition = {
    sld,
    tld,
    subdomains,
    labelEntropies,
  };

  // Cache results for common domains (bounded LRU)
  if (clean.length <= 128) {
    if (DECOMPOSE_CACHE.size >= DECOMPOSE_CACHE_MAX_SIZE) {
      const oldestKey = DECOMPOSE_CACHE.keys().next().value;
      if (oldestKey !== undefined) {
        DECOMPOSE_CACHE.delete(oldestKey);
      }
    }
    DECOMPOSE_CACHE.set(clean, cloneDecomposition(res));
  }

  return res;
}

/**
 * Evaluates domain lexical features and Shannon entropy to detect Domain Generation Algorithms (DGA),
 * botnet command-and-control beacons, and randomized tracking subdomains.
 *
 * Implements strict false positive suppression:
 * - Recognizes 'y' as vowel/semi-vowel to protect English/technical words (e.g. crypto, sync, rhythm, python).
 * - Distinguishes between legitimate content-addressed git/blob SHAs on developer platforms vs ad tracker hashes.
 * - Exempts standard 4-digit calendar years from consecutive digit penalties.
 * - Protects Punycode IDN representations from artificial entropy spikes.
 * @beta
 */
export function detectDgaPatterns(domain: string): DgaDetectionResult {
  try {
    if (typeof domain !== 'string' || !domain) {
      return { isLikelyDga: false, score: 0, reasons: [] };
    }

    const cleanDomain = normalizeHostname(domain);
    if (!cleanDomain || !cleanDomain.includes('.')) {
      return { isLikelyDga: false, score: 0, reasons: [] };
    }

    // IP addresses are not DGA algorithmic domains
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanDomain)) {
      return { isLikelyDga: false, score: 0, reasons: [] };
    }

    const decomp = decomposeDomain(cleanDomain);
    const candidateLabels: string[] = [];

    // Filter out common structural prefixes when candidate has subdomains
    if (decomp.sld && !BENIGN_STRUCTURAL_PREFIXES.has(decomp.sld)) {
      candidateLabels.push(decomp.sld);
    }
    for (const sub of decomp.subdomains) {
      if (sub && !BENIGN_STRUCTURAL_PREFIXES.has(sub)) {
        candidateLabels.push(sub);
      }
    }

    if (candidateLabels.length === 0) {
      candidateLabels.push(decomp.sld || cleanDomain.split('.')[0]);
    }

    const isDeveloperOrCdnHost = (decomp.sld && (
      decomp.sld === 'github' ||
      decomp.sld === 'githubusercontent' ||
      decomp.sld === 'gitlab' ||
      decomp.sld === 'bitbucket' ||
      decomp.sld === 'cloudflare' ||
      decomp.sld === 'fastly' ||
      decomp.sld === 'akamai' ||
      decomp.sld === 'aws' ||
      decomp.sld === 'azure'
    )) || (decomp.tld && (
      decomp.tld === 's3.amazonaws.com' ||
      decomp.tld === 'blob.core.windows.net' ||
      decomp.tld === 'azureedge.net' ||
      decomp.tld === 'cloudfront.net' ||
      decomp.tld === 'workers.dev' ||
      decomp.tld === 'pages.dev'
    ));

    let maxScore = 0;
    const reasons: string[] = [];

    for (const label of candidateLabels) {
      let labelScore = 0;
      const labelReasons: string[] = [];
      const unhyphenated = label.replace(/-/g, '');
      const isSld = label === decomp.sld;
      const isPunycode = label.startsWith('xn--');
      const hexCandidate = unhyphenated.replace(/^(?:trk|pixel|beacon|clk|track|node|id|c2|sess|session|client)[-_]?/i, '');
      const isHexHash = /^[a-f0-9]{16,64}$/i.test(hexCandidate);
      const hasTrackingPrefix = /^(?:trk|pixel|beacon|clk|track|node|id|c2|sess|session|client)[-_]/i.test(label);
      const isLegitDevContentHash = !isSld && isDeveloperOrCdnHost && !hasTrackingPrefix && isHexHash;

      if (isLegitDevContentHash) {
        // Legitimate content-addressed git commit SHA or storage chunk on an authenticated developer host.
        // Do not treat as DGA or tracking beacon.
        continue;
      }

      const entropy = calculateShannonEntropy(label);

      // 1. Mathematically calibrated Shannon entropy check (exempting IDN Punycode representations):
      // Theoretical max entropy for length N is log2(N).
      // An 8-character string max entropy is 3.0; 10-char is 3.32; 14-char is 3.80.
      if (!isPunycode) {
        if (label.length >= 14 && entropy >= 3.65) {
          labelScore += 45;
          labelReasons.push(`High Shannon entropy (${entropy}) in label "${label}"`);
        } else if (label.length >= 10 && entropy >= 3.2) {
          labelScore += 35;
          labelReasons.push(`High Shannon entropy (${entropy}) in label "${label}"`);
        } else if (label.length >= 8 && entropy >= 2.85) {
          labelScore += 25;
          labelReasons.push(`Elevated Shannon entropy (${entropy}) in label "${label}"`);
        }

        // Normalized character entropy (ratio of distinct characters to maximum possible)
        if (label.length >= 8) {
          const maxPossibleEntropy = Math.log2(label.length);
          const normEntropy = maxPossibleEntropy > 0 ? entropy / maxPossibleEntropy : 0;
          if (normEntropy >= 0.96) {
            labelScore += 25;
            labelReasons.push(`High normalized character entropy (${Math.round(normEntropy * 100)}%) with zero natural repetition in "${label}"`);
          }
        }
      }

      // 2. High digit ratio & long digit sequence check (e.g. ad1984210.com or s7890-trk)
      const digits = (label.match(/\d/g) || []).length;
      const digitRatio = digits / label.length;

      // Check if 4-digit sequence is an innocuous calendar year (1950 - 2040)
      const consecutiveDigitMatches = label.match(/\d{4,}/g) || [];
      const onlyCalendarYears = consecutiveDigitMatches.length > 0 && consecutiveDigitMatches.every((d) => {
        if (d.length === 4) {
          const yr = parseInt(d, 10);
          return yr >= 1950 && yr <= 2040;
        }
        return false;
      });

      if (label.length >= 6 && digitRatio > 0.4 && !onlyCalendarYears) {
        labelScore += 30;
        labelReasons.push(`High numeric character density (${Math.round(digitRatio * 100)}%) in "${label}"`);
      }
      if (consecutiveDigitMatches.length > 0 && !onlyCalendarYears) {
        labelScore += 20;
        labelReasons.push(`Consecutive numeric sequence in "${label}"`);
      }

      // 3. Hexadecimal hash pattern (e.g. 16-64 char MD5, SHA1, or UUID tracking subdomain)
      if (isHexHash) {
        labelScore += 50;
        labelReasons.push(`Matches hex hash signature characteristic of ephemeral tracking beacons in "${label}"`);
      }

      // 4. Consonant cluster check (e.g., "bcdfghjkl" or "qxzjkw")
      // Treat 'y' as vowel/semi-vowel to eliminate false alarms on words like "crypto", "sync", "rhythm", "python".
      // Common Germanic/English consonant n-grams (tch, ght, sch, str, etc.) are protected.
      const hasNaturalConsonantRoot = /(?:catch|match|pitch|witch|watch|fetch|ditch|hitch|patch|scratch|switch|craft|strength|length|angst|night|sight|bright|flight|light|right|tight|sch|tch|ght|ckstr|kthr|shst|ndst|ltsp|rtsp|ftsm|rdsm|chbr|chsp|chcr)/i.test(label);

      if (/[bcdfghjklmnpqrstvwxz]{6,}/i.test(label) && !hasNaturalConsonantRoot) {
        labelScore += 35;
        labelReasons.push(`Unnatural consonant cluster without vowels in "${label}" (DGA signature)`);
      } else if (/[bcdfghjklmnpqrstvwxz]{5}/i.test(label) && !hasNaturalConsonantRoot) {
        labelScore += 20;
        labelReasons.push(`Elevated consonant cluster density in "${label}"`);
      }

      // 5. Vowel ratio check (including 'y' as vowel/semi-vowel)
      const letters = label.replace(/[^a-z]/g, '');
      if (letters.length >= 8) {
        const vowels = (letters.match(/[aeiouy]/g) || []).length;
        if (vowels / letters.length <= 0.1) {
          labelScore += 30;
          labelReasons.push(`Anomalously low vowel density in "${label}" (DGA signature)`);
        }
      } else if (letters.length >= 6) {
        const vowels = (letters.match(/[aeiouy]/g) || []).length;
        if (vowels === 0) {
          labelScore += 35;
          labelReasons.push(`Zero vowel content in domain label "${label}" (DGA consonant string)`);
        }
      }

      // 6. Excessive hyphenation (e.g. "trk-ad-bidding-bid-dsp-99")
      const hyphenCount = (label.match(/-/g) || []).length;
      if (hyphenCount >= 3 && label.length >= 12) {
        const hasSuspiciousSegment = /(?:^|-)(?:rtb|trk|clk|track|bid|dsp|ad|pixel|beacon|sess|\d{4,})(?:-|$)/i.test(label) || entropy >= 3.0;
        if (hasSuspiciousSegment) {
          labelScore += 20;
          labelReasons.push(`Excessive hyphenation (${hyphenCount} hyphens) in "${label}"`);
        }
      }

      // 7. Alternating letter-digit sequence (Markov/character matrix DGA, e.g. x1y2z3a4b5)
      if (label.length >= 8 && /(?:[a-z]\d){3,}|(?:\d[a-z]){3,}/i.test(label)) {
        labelScore += 30;
        labelReasons.push(`Alternating letter-digit sequence characteristic of Markov DGA generators in "${label}"`);
      }

      // 8. Cyclic character repetition pattern (low-entropy botnet domain, e.g. ababababab)
      if (label.length >= 8 && /^(.{2,4})\1{2,}$/i.test(label)) {
        labelScore += 35;
        labelReasons.push(`Cyclic character repetition pattern characteristic of low-entropy botnet DGA in "${label}"`);
      }

      if (labelScore > maxScore) {
        maxScore = labelScore;
        reasons.length = 0;
        reasons.push(...labelReasons);
      } else if (labelScore === maxScore && labelScore > 0) {
        reasons.push(...labelReasons);
      }
    }

    return {
      isLikelyDga: maxScore >= 50,
      score: Math.min(100, maxScore),
      reasons: Array.from(new Set(reasons)),
    };
  } catch {
    // Fail-safe guarantee against unexpected input failures
    return { isLikelyDga: false, score: 0, reasons: [] };
  }
}
