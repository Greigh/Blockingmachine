/**
 * Scriptlet library — P2 Task 2 (docs/https-filtering-p2-plan.md).
 *
 * Pure payload generation: `scriptletRuntimeSource()` emits the injectable
 * library IIFE (a non-enumerable `window.__bm_sc(name, args)` dispatcher plus
 * the canonical scriptlet implementations), `scriptletCallSource()` emits the
 * per-invocation call lines, and `renderScriptletBlock()` fuses them into the
 * inner text of the injected `<script>` element. No DOM framework, no deps —
 * the emitted code is deliberately ES5-ish vanilla because it executes inline
 * inside MITM'd pages we don't control.
 *
 * Canonical names come from `CANONICAL_SCRIPTLET_NAMES` in core (Task 1
 * normalizes every uBO/AdGuard alias onto exactly these). `KNOWN_SCRIPTLETS`
 * mirrors that set so callers can count `skippedScriptlets` at build time
 * without executing anything.
 *
 * Semantics aim for uBO parity on the covered subset:
 *  - the shared needle matcher (`mm` below) treats `/re/flags` as a regex
 *    test, and any other arg — including a `/.`-leading one that never closed
 *    its slash — as a literal substring; empty/absent matches everything.
 *    Per the plan's contract line ("leading/trailing `/` → regex, `/.` prefix
 *    → substring, plain → substring") a `/.`-leading arg is NOT a regex
 *    opener; it lands on the substring branch like every other non-`/re/`
 *    arg (uBO's `patternToRegex` does exactly this — an unclosed `/` arg is
 *    an escaped literal).
 *  - `set-constant` traps the leaf of a dotted path so same-type page
 *    writes are absorbed while a type-mismatched write ends the trap
 *    (uBO's `mustAbort`). Intermediates are LAZY like uBO's trapChain: a
 *    missing link gets a configurable accessor that holds the old value
 *    and only descends to trap the rest of the chain when the page
 *    assigns a real object — no eager `{}` to detect (`typeof` stays
 *    'undefined') or for the page to stomp (we run at document-start, so
 *    the real object usually arrives after us). A leaf that already
 *    exists with a type-mismatched value is left untrapped — the
 *    mustAbort init-check: `foo=42` must not be masked by
 *    `set-constant foo false`. Both the mid-chain wrap and the leaf
 *    trap chain a pre-existing own accessor uBO-style (`prevGetter`/
 *    `prevSetter` run before our bookkeeping), so page writes still
 *    reach a setter the page installed before we injected.
 *  - `prevent-fetch`/`prevent-xhr` take uBO's propsToMatch surface:
 *    whitespace-separated `key:value` needles test that collated prop
 *    (a bare token is a `url`-contains needle; a key containing chars
 *    outside `$\w -` collapses back to a url needle, matching uBO's
 *    parsePropertiesToMatch quirk) and a `!`-leading pattern negates.
 *    A needle on an absent prop is skipped and at least one needle must
 *    positively match (uBO's matchObjectProperties). The `responseBody`
 *    token maps uBO's generator (`emptyObj`/`emptyArr`/`emptyStr`/
 *    `true`/`length:N[-M]`/`war:name`/`join:XY…`); `war:` resolves
 *    synchronously from the embedded `W` table since a proxy has no
 *    web_accessible_resources origin to fetch from. `prevent-fetch`'s
 *    `responseType` arg takes uBO's full surface: a JSON object applies
 *    the untrusted whitelist (`ok`/`status:403`/`statusText`/`type`) as
 *    own-prop shadows on the real Response — the `headers` key stays
 *    trusted-only and is ignored — while a plain string validates
 *    against the `type` enum like upstream. A `throttle` vararg pair
 *    delays the resolved promise (uBO's documented
 *    `+js(no-fetch-if,…,throttle,N)` form), and `set-constant` reads
 *    the same `[key value]` varargs for `stack`/`stackToMatch`/`as`
 *    (function/callback/resolved/rejected) plus `throttle` for a
 *    deferred install. XHR matches uBO's `{method, url}` haystack and
 *    switches the synthetic payload on the request's `responseType`
 *    (`json`→`{}`/`'{}'`, `arraybuffer`, `blob`, `document`→DOMParser,
 *    default→generated text) exactly like upstream; `async=false`
 *    (sync) opens apply the props with no event staging (uBO's defer
 *    split). fetch collates uBO's init-prop whitelist.
 *  - abort scriptlets throw `ReferenceError(<token>)`; a single installed
 *    `window.onerror` swallows only token-carrying messages, so the abort is
 *    invisible to the page (uBO's `getExceptionToken`).
 *  - `prevent-setTimeout`/`prevent-setInterval` still call the native timer
 *    but with a no-op callback, so the page gets a real timer id back and
 *    never sees the throw (uBO semantics — "swallowed" here means the
 *    callback, not the call).
 *  - `json-prune` takes uBO's full `(prunePaths, needlePaths, stackNeedle)`
 *    signature: `a[1]` is uBO's required-paths needle (real lists pass
 *    `requestId`/`ad_to_link` there — treating it as a stack needle would
 *    silently no-op them), `a[2]` is the stack needle, `stack`/`stackToMatch`
 *    named varargs also honored.
 *
 * Anti-detection: `__bm_sc` is installed non-enumerable, non-configurable,
 * non-writable and tagged with a non-enumerable `__bm=1` marker; no
 * `console.*` anywhere; unknown names count silently on `__bm_sc.misses`
 * (also non-enumerable) and dispatch goes through an own-property check so
 * `constructor`/`__proto__`-style names can't reach Object slots. A
 * pre-poisoned `__bm_sc` can't disarm the payload: a foreign configurable
 * value is replaced by ours, while a foreign NON-configurable one can't be
 * beaten — that case logs on the foreign value's `misses` counter and
 * bails honestly. The install itself is guarded too: a non-extensible
 * window refuses `defineProperty`, so the wrap degrades to the call lines'
 * `||function(){}` fallback rather than throwing out of the IIFE. Every
 * function installed where a native lived is `.toString`-cloaked uBO-style:
 * a WeakMap (parallel-array fallback for WeakMap-less engines) maps each
 * wrapper to the original it replaced, and `Function.prototype.toString`
 * is itself wrapped to resolve through that map — `fetch.toString()`
 * answers the underlying native's real spelling, functions with no
 * native counterpart (trap accessors, `__bm_sc`, stubbed PA methods)
 * get a synthesized `function name() { [native code] }`, and the hook
 * is registered to itself so `toString.toString()` can't incriminate
 * it. Unregistered functions fall through to the real
 * `Function.prototype.toString` captured at IIFE entry (`f2s`), so page
 * functions keep their honest source.
 *
 * Escaping is the XSS surface: every interpolated arg goes through
 * `emitArg` (JSON.stringify + `</script` → `<\/script`, `<!--` → `\x3C!--`,
 * U+2028/U+2029 → `\u2028`/`\u2029`), so an arg containing
 * `</script><img onerror=…>` can never terminate the script block early.
 * The runtime text itself is ours and contains none of those sequences by
 * construction.
 */

export type CanonicalScriptlet = { name: string; args: string[] };

/**
 * The canonical name set this library implements — kept in lockstep with
 * `CANONICAL_SCRIPTLET_NAMES` in `@blockingmachine/core` (a test asserts
 * set-equality). Anything the index emits outside this set is skipped at
 * build time and, if it somehow reaches a page, counted via
 * `__bm_sc.misses` as a silent no-op.
 */
export const KNOWN_SCRIPTLETS: ReadonlySet<string> = new Set([
  'set-constant',
  'abort-on-property-read',
  'abort-on-property-write',
  'abort-current-inline-script',
  'abort-on-stack-trace',
  'prevent-setTimeout',
  'prevent-setInterval',
  'adjust-setTimeout',
  'adjust-setInterval',
  'prevent-fetch',
  'prevent-xhr',
  'prevent-addEventListener',
  'prevent-window-open',
  'nowebrtc',
  'json-prune',
  'remove-attr',
  'remove-class',
  'set-local-storage-item',
  'set-session-storage-item',
  'remove-local-storage-item',
  'href-sanitizer',
  'spoof-css',
  'prevent-eval-if',
  'no-protected-audience',
]);

/**
 * Emits one arg as an inert JS string literal. JSON.stringify handles the
 * quote/backslash/escaping work; the post-passes close the three channels an
 * arg could otherwise use to escape its `<script>` context:
 *   - `</script` (case-insensitive) would end the block early → `<\/script`
 *   - `<!--` opens script-data-escaped state (a later `</script>` inside it
 *     would still close) → `\x3C!--`
 *   - U+2028/U+2029 survive JSON.stringify but break ES5-era script-text
 *     parsers → `\u2028`/`\u2029`
 */
function emitArg(arg: string): string {
  return JSON.stringify(String(arg))
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '\\x3C!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The `war:` response-body table — the text-safe payloads uBO ships in
 * `web_accessible_resources` and lets `prevent-fetch`/`prevent-xhr` serve
 * verbatim. A proxy has no WAR origin to fetch from, so the bodies are
 * embedded: the noop VAST/VMAP stubs, `noop.json`, `noop.js` and friends that
 * real lists actually name. `noop-vmap1.0.xml` is aliased to the upstream
 * `noop-vmap1.xml` body because published rules do write the `.0` spelling —
 * upstream's own fetch would 404 there, so serving the body matches intent
 * where uBO would answer ''. Unknown names resolve to '' (uBO's own
 * fetch-failure answer), never an error.
 *
 * Emission detail: the JSON dump rides inside the injected `<script>` text,
 * so `</` in a body (`</VAST>`, `</head>`) is emitted `<\/` — identical
 * once parsed, but the literal `</head` can never collide with the
 * pipeline's head-close splice anchor (and `</script` is structurally
 * impossible to smuggle through).
 */
const WAR_BODIES: Readonly<Record<string, string>> = {
  'noop-vast2.xml': '<VAST version="2.0"></VAST>',
  'noop-vast3.xml': '<VAST version="3.0"></VAST>',
  'noop-vast4.xml': '<VAST version="4.0"></VAST>',
  'noop-vmap1.xml':
    '<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"></vmap:VMAP>',
  'noop-vmap1.0.xml':
    '<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"></vmap:VMAP>',
  'noop.json': '{}',
  'noop.txt': '',
  'noop.js': "(function() {\n    'use strict';\n})();",
  'noop.css': '/* */',
  'noop.html': '<!DOCTYPE html>\n<html>\n    <head><title></title></head>\n    <body></body>\n</html>\n',
  empty: '',
};

let runtimeCache: string | undefined;

/**
 * The library IIFE — defines `window.__bm_sc(name, args)` non-enumerably and
 * returns. Idempotent: a second injection is a no-op. Every scriptlet body
 * swallows its own exceptions at the dispatcher, so a partial DOM or a page
 * fighting back can never turn our block into a page-visible error. The
 * `dp(w, '__bm_sc', …)` install itself is guarded for the same reason: a
 * non-extensible/frozen window refuses defineProperty, and the wrap degrades
 * to the call lines' `||function(){}` fallback instead of throwing out of
 * the IIFE.
 */
export function scriptletRuntimeSource(): string {
  if (runtimeCache === undefined) {
    runtimeCache = `(function(){
var w=typeof window=='undefined'?globalThis:window;
var O=Object,dp=O.defineProperty,gpd=O.getOwnPropertyDescriptor,S=String,
doc=typeof document=='undefined'?null:document,
noop=function(){},yes=function(){return!0},never=function(){return!1},
f2s=Function.prototype.toString,has=O.prototype.hasOwnProperty,
st=w.setTimeout||function(f){f()},tok=null;
var pre=gpd(w,'__bm_sc');
if(pre){var pre_v=pre.value;
if(typeof pre_v=='function'&&pre_v.__bm===1){return}
if(!pre.configurable){
try{if(pre_v!=null&&(typeof pre_v=='object'||typeof pre_v=='function')){pre_v.misses=(pre_v.misses|0)+1}}catch(e){}
return}}
function fns(f){try{return f2s.call(f)}catch(e){return''}}
function stk(){try{return S(Error().stack||'')}catch(e){return''}}
function et(){if(tok!=null){return tok}tok='bm'+Math.random().toString(36).slice(2);try{var oe=w.onerror;w.onerror=spoof(function(m){if(typeof m=='string'&&m.indexOf(tok)>-1){return!0}if(typeof oe=='function'){return oe.apply(this,arguments)}return!1},'onerror')}catch(e){}return tok}
function die(){throw new ReferenceError(et())}
var spm=typeof WeakMap=='function'?new WeakMap():null,spf=[],spn=[];
function spoof(f,n){if(typeof f!=='function'||n==null){return f}
if(spm){spm.set(f,n)}else{spf[spf.length]=f;spn[spn.length]=n}
return f}
try{var fpx=spoof(function(){var t=this,n,i;
for(;;){if(spm){n=spm.get(t)}else{n=undefined;for(i=0;i<spf.length;i++){if(spf[i]===t){n=spn[i];break}}}
if(n===undefined){return f2s.call(t)}
if(typeof n=='function'){t=n;continue}
return'function '+n+'() { [native code] }'}},f2s);
try{dp(fpx,'name',{value:'toString'})}catch(e2){}
Function.prototype.toString=fpx}catch(e){}
function mm(p){if(p==null||p===''){return yes}p=S(p);var n=p.length;
if(n>1&&p[0]==='/'){var j=p.lastIndexOf('/');
if(j>0){var f=p.slice(j+1);if(/^[dgimsuvy]*$/.test(f)){try{var r=new RegExp(p.slice(1,j),f);return function(s){return r.test(S(s))}}catch(e){return never}}}
if(p[1]==='.'){var l=p.slice(1);return function(s){return S(s).indexOf(l)>-1}}}
return function(s){return S(s).indexOf(p)>-1}}
function cv(v){v=v==null?'':S(v);
if(v=='undefinedValue'||v=='undefined'){return undefined}
if(v=='nullValue'||v=='null'){return null}
if(v=='true'){return!0}if(v=='false'){return!1}
if(v=='noopFunc'){return noop}if(v=='trueFunc'){return yes}if(v=='falseFunc'){return never}
if(v=='emptyObj'||v=='{}'){return{}}if(v=='emptyArr'||v=='[]'){return[]}
if(v=='emptyStr'||v=="''"||v=='""'){return''}
var c=v[0];
if((c=='{'||c=='[')&&v.length>1){try{return JSON.parse(v)}catch(e){}}
var n=Number(v);if(v!==''&&isFinite(n)){return n}return v}
function rng(s){s=s==null?'':S(s);var ng=s[0]=='!';if(ng){s=s.slice(1)}var mn,mx,M=9007199254740991;
if(s!==''){var i=s.indexOf('-');if(i<0){mn=mx=parseInt(s,10)||0}else{if(i!==0){mn=parseInt(s,10)||0}mx=parseInt(s.slice(i+1),10)||M}}
return function(v){var n=Math.min(Math.max(Number(v)||0,0),M),r;
if(mn==null&&mx==null){r=!0}else if(mn===mx){r=n===mn}else if(mn==null){r=n<=mx}else if(mx==null){r=n>=mn}else{r=n>=mn&&n<=mx}
return ng?!r:r}}
function walk(o,ch,leaf){for(;;){var i=ch.indexOf('.');
if(i<0){leaf(o,ch);return}
var p=ch.slice(0,i),rest=ch.slice(i+1),cur=o[p];
if(cur!=null&&(typeof cur=='object'||typeof cur=='function')){o=cur;ch=rest;continue}
var d=gpd(o,p);
if(d&&!d.configurable){return}
var h=cur,pg,ps;
if(d){pg=d.get;ps=d.set}
try{dp(o,p,{configurable:!0,
get:spoof(function(){if(pg!==undefined){pg.call(o)}return h},'get '+p),
set:spoof(function(x){if(ps!==undefined){ps.call(o,x)}h=x;if(x!=null&&(typeof x=='object'||typeof x=='function')){walk(x,rest,leaf)}},'set '+p)})}catch(e){}
return}}
function leaf(o,p,g,s){var d=gpd(o,p);if(d&&!d.configurable){return}
var pg,ps;if(d){pg=d.get;ps=d.set}
var v;try{v=o[p]}catch(e){}
try{dp(o,p,{configurable:!0,
get:spoof(function(){if(pg!==undefined){pg.call(o)}return g(v)},'get '+p),
set:spoof(function(x){if(ps!==undefined){ps.call(o,x)}v=s(x)},'set '+p)})}catch(e){}}
function isre(s){if(s.length<2||s[0]!=='/'){return!1}var j=s.lastIndexOf('/');return j>0&&/^[dgimsuvy]*$/.test(s.slice(j+1))}
function pset(spec){var t=S(spec||'').split(/\\s+/),o=[],i,c,k,p;
for(i=0;i<t.length;i++){if(!t[i]){continue}
if(t[i]==='*'){o.push({k:'',m:yes});continue}
c=t[i].indexOf(':');k='';p=t[i];
if(c>0){k=t[i].slice(0,c);p=t[i].slice(c+1);
if(/[^$\\w -]/.test(k)){k='';p=t[i]}}
var ng=!1;if(p[0]==='!'){ng=!0;p=p.slice(1)}
var m=mm(p);if(ng){var n0=m;m=function(s){return!n0(s)}}
o.push({k:k,m:m})}
return o}
function hall(ps,o){var any=!1;
for(var i=0;i<ps.length;i++){var p=ps[i],v=p.k===''?o.url:o[p.k];
if(v===undefined){continue}
if(typeof v!=='string'){try{v=JSON.stringify(v)}catch(e){}if(typeof v!=='string'){continue}}
if(!p.m(v)){return!1}
any=!0}
return any}
var FPROPS='body cache credentials duplex headers integrity keepalive method mode priority redirect referrer referrerPolicy url'.split(' ');
function fargs(res,opt){var d={},i;
try{if(res!=null&&typeof res=='object'&&typeof res.url=='string'){
for(i=0;i<FPROPS.length;i++){if(res[FPROPS[i]]!==undefined){d[FPROPS[i]]=res[FPROPS[i]]}}
}else{d.url=S(res)}
if(opt&&typeof opt=='object'){for(i=0;i<FPROPS.length;i++){if(opt[FPROPS[i]]!==undefined){d[FPROPS[i]]=opt[FPROPS[i]]}}}}catch(e){}
return d}
function rtxt(n){var s='',r;while(s.length<n){r=Math.random().toString(36).slice(2);s+=(s?' ':'')+r}return s.slice(0,n)}
var W=${JSON.stringify(WAR_BODIES).replace(/<\//g, '<\\/')};
function genc(tok){tok=S(tok||'');
if(tok==='emptyObj'){return'{}'}
if(tok==='emptyArr'){return'[]'}
if(tok==='emptyStr'){return''}
if(tok==='true'){return rtxt(10)}
var mch=/^length:(\\d+)(?:-(\\d+))?$/.exec(tok);
if(mch){var mn=parseInt(mch[1],10)||0,mx=Math.max(parseInt(mch[2],10)||0,mn);
return rtxt(Math.min(mn+(mx-mn)*Math.random(),500000)|0)}
if(tok.slice(0,4)==='war:'){var wb=W[tok.slice(4)];return wb===undefined?'':wb}
if(tok.slice(0,5)==='join:'&&tok.length>7){var prt=tok.slice(7).split(tok.slice(5,7)),out='',i;
for(i=0;i<prt.length;i++){out+=genc(prt[i])}
return out}
return''}
function pvar(a,off){var o={},i,k,v;
for(i=off;i<a.length;i+=2){k=S(a[i]);v=a[i+1];
if(/^\\d+$/.test(S(v))){v=parseInt(v,10)}
o[k]=v}
return o}
var VRP={ok:[!1,!0],status:[403],statusText:['','Not Found'],type:['basic','cors','default','error','opaque']};
function fac(b,ex,u2){var used=!1,k;
var r3={ok:!0,status:200,statusText:'OK',url:u2||'',redirected:!1,type:'default',
headers:{get:spoof(function(){return null},'get'),forEach:spoof(function(){},'forEach')},
get bodyUsed(){return used},
text:spoof(function(){used=!0;return Promise.resolve(b)},'text'),
json:spoof(function(){used=!0;return Promise.resolve().then(function(){return JSON.parse(b)})},'json'),
arrayBuffer:spoof(function(){used=!0;return Promise.resolve(new ArrayBuffer(0))},'arrayBuffer'),
blob:spoof(function(){used=!0;return Promise.resolve(typeof Blob=='function'?new Blob([b]):{})},'blob'),
formData:spoof(function(){used=!0;return Promise.resolve(typeof FormData=='function'?new FormData():{})},'formData'),
clone:spoof(function(){return fac(b,ex,u2)},'clone')};
if(ex){for(k in ex){if(has.call(ex,k)){r3[k]=ex[k]}}}
return r3}
function obs(fn){if(!doc||typeof w.MutationObserver!=='function'){return}
var busy=!1;
try{var mo=new w.MutationObserver(function(){if(busy){return}busy=!0;
st(function(){busy=!1;try{fn()}catch(e){}},0)});
mo.observe(doc,{attributes:!0,childList:!0,subtree:!0})}catch(e){
try{mo.observe(doc.documentElement,{attributes:!0,childList:!0,subtree:!0})}catch(e2){}}}
function qsa(s){var o=[];if(!doc){return o}try{o=doc.querySelectorAll(s)}catch(e){}return o}
function eq(n){return function(x){return x===n}}
function toks(raw){var t=S(raw).split('|'),ts=[],pl=[],i;
for(i=0;i<t.length;i++){if(!t[i]){continue}
if(isre(t[i])){ts.push(mm(t[i]))}
else{ts.push(eq(t[i]));pl.push(t[i])}}
return{t:ts,p:pl}}
function tw(nm,a,adj){var fn=w[nm];if(!fn){return}
var ndl=a[0],ng=!1;
if(ndl!=null&&S(ndl)[0]=='!'){ng=!0;ndl=S(ndl).slice(1)}
var m=mm(ndl),dt,fct;
if(adj){var dv;
if(!a[1]){dv=1e3}else if(a[1]==='*'){dv=-1}else{dv=parseInt(a[1],10);if(isNaN(dv)){dv=1e3}}
dt=function(d){return dv<0||Number(d)===dv};
var raw=S(a[2]||''),pct=raw[raw.length-1]=='%';
fct=parseFloat(raw);if(isNaN(fct)){fct=0.05}if(pct){fct=fct/100}
fct=Math.min(Math.max(fct,0.02),50);
}else{
if(!a[0]&&!a[1]){return}
dt=rng(a[1])}
w[nm]=spoof(function(){var cb=arguments[0],src=typeof cb=='function'?fns(cb):S(cb),hit=m(src);
if(ng){hit=!hit}
if(hit&&dt(arguments[1])){if(adj){arguments[1]=(Number(arguments[1])||0)*fct}else{arguments[0]=noop}}
return fn.apply(this,arguments)},fn)}
function ab(chk){return function(o,p){leaf(o,p,function(v){if(chk()){die()}return v},function(x){if(chk()){die()}return x})}}
var H={
'set-constant':function(a){var ch=a[0];if(!ch){return}
var xa=pvar(a,2);
var sf=xa.stack!==undefined?xa.stack:xa.stackToMatch;
if(sf!==undefined&&sf!==''&&!mm(sf)(stk())){return}
var run=function(){var v=cv(a[1]);
if(xa.as==='function'){v=(function(x){return function(){return x}})(v)}
else if(xa.as==='callback'){v=(function(x){return function(){return function(){return x}}})(v)}
else if(xa.as==='resolved'&&typeof Promise=='function'){v=Promise.resolve(v)}
else if(xa.as==='rejected'&&typeof Promise=='function'){v=Promise.reject(v)}
var tp=S(ch);tp=tp.slice(tp.lastIndexOf('.')+1);
if(typeof v=='function'){v=spoof(v,tp)}
walk(w,S(ch),function(o,p){var d=gpd(o,p);if(d&&!d.configurable){return}
var ex;try{ex=o[p]}catch(e){ex=undefined}
if(ex!==undefined&&ex!==null&&v!==undefined&&v!==null&&typeof ex!==typeof v){return}
var pg=d?d.get:undefined,ps=d?d.set:undefined,nv=v,dead=!1;
try{dp(o,p,{configurable:!1,
get:spoof(function(){if(pg!==undefined){pg.call(o)}return nv},'get '+p),
set:spoof(function(x){if(ps!==undefined){ps.call(o,x)}
if(dead||(x!=null&&nv!=null&&typeof x!==typeof nv)){dead=!0;nv=x}},'set '+p)})}catch(e){}})};
var th=xa.throttle>0?xa.throttle|0:0;
if(th>0){st(run,th);return}
run()},
'abort-on-property-read':function(a){if(a[0]){walk(w,S(a[0]),function(o,p){leaf(o,p,die,function(x){return x})})}},
'abort-on-property-write':function(a){if(a[0]){walk(w,S(a[0]),function(o,p){leaf(o,p,function(v){return v},die)})}},
'abort-current-inline-script':function(a){if(!a[0]||!doc){return}
var sm=mm(a[1]),cm=a[2]!=null?mm(a[2]):null,me=doc.currentScript;
var chk=function(){var e=doc.currentScript;
if(!e||e===me||(e.nodeName||'').toUpperCase()!=='SCRIPT'){return!1}
if(cm&&!cm(S(e.src||''))){return!1}
return sm(S(e.textContent||''))};
walk(w,S(a[0]),ab(chk))},
'abort-on-stack-trace':function(a){if(!a[0]){return}
var nm=a[1]?mm(a[1]):yes;
walk(w,S(a[0]),ab(function(){return nm(stk())}))},
'prevent-setTimeout':function(a){tw('setTimeout',a)},
'prevent-setInterval':function(a){tw('setInterval',a)},
'adjust-setTimeout':function(a){tw('setTimeout',a,!0)},
'adjust-setInterval':function(a){tw('setInterval',a,!0)},
'prevent-fetch':function(a){var fn=w.fetch;if(!fn){return}
var ps=pset(a[0]);if(!ps.length&&!a[0]){return}
var body=genc(a[1]);
var xa=pvar(a,3),th=xa.throttle>0?xa.throttle|0:0;
var rprops={statusText:'OK'},rt=S(a[2]||'');
if(rt.length>1&&rt[0]==='{'&&rt[rt.length-1]==='}'){try{var jd=JSON.parse(rt),k3,al,vv,i4;
for(k3 in jd){if(!has.call(jd,k3)){continue}
al=VRP[k3];if(al===undefined){continue}
vv=jd[k3];for(i4=0;i4<al.length;i4++){if(al[i4]===vv){rprops[k3]=vv;break}}}}catch(e){}}
else if(rt!==''){for(var i5=0;i5<VRP.type.length;i5++){if(VRP.type[i5]===rt){rprops.type=rt;break}}}
var mkres=function(u2){var r2;
if(typeof Response=='function'){try{r2=new Response(body,{headers:{'content-length':S(body).length}})}catch(e){r2=undefined}}
if(r2===undefined||r2===null){return fac(body,rprops,u2)}
var ds={url:{value:u2}},k4;
for(k4 in rprops){if(has.call(rprops,k4)){ds[k4]={value:rprops[k4]}}}
try{O.defineProperties(r2,ds)}catch(e){}
return r2};
w.fetch=spoof(function(){var d=fargs(arguments[0],arguments[1]);
if(hall(ps,d)){var r2=mkres(d.url||'');
if(th>0&&typeof Promise=='function'){return new Promise(function(res){st(function(){res(r2)},th)})}
return Promise.resolve(r2)}
return fn.apply(this,arguments)},fn)},
'prevent-xhr':function(a){var X=w.XMLHttpRequest;if(!X||!X.prototype){return}
var ps=pset(a[0]);if(!ps.length&&!a[0]){return}
var body=genc(a[1]);
var op=X.prototype.open,sn=X.prototype.send;
if(!op||!sn){return}
var wm=typeof WeakMap=='function'?new WeakMap():null;
X.prototype.open=spoof(function(mtd,url){var dt={u:S(url||''),m:S(mtd||''),df:arguments.length<3||arguments[2]!==!1};
if(wm){wm.set(this,dt)}else{try{this.__bm_xu=dt.u;this.__bm_xm=dt.m;this.__bm_xd=dt.df}catch(e){}}
return op.apply(this,arguments)},op);
X.prototype.send=spoof(function(){var dt=wm?wm.get(this):{u:this.__bm_xu||'',m:this.__bm_xm||'',df:this.__bm_xd};
if(dt&&hall(ps,{url:dt.u,method:dt.m})){var xhr=this;
var rt2='';try{rt2=S(xhr.responseType||'')}catch(e){}
var resp='',rtxt2='',rxml=null;
if(rt2==='arraybuffer'){resp=new ArrayBuffer(0)}
else if(rt2==='blob'){try{resp=new Blob([])}catch(e2){resp=''}}
else if(rt2==='document'){var d2=null;try{if(typeof DOMParser=='function'){d2=new DOMParser().parseFromString('','text/html')}}catch(e3){}resp=d2;rxml=d2}
else if(rt2==='json'){resp={};rtxt2='{}'}
else{resp=body;rtxt2=body}
try{O.defineProperties(xhr,{readyState:{value:4,configurable:!0},status:{value:200,configurable:!0},statusText:{value:'OK',configurable:!0},responseURL:{value:dt.u,configurable:!0},
response:{value:resp,configurable:!0},responseText:{value:rtxt2,configurable:!0},responseXML:{value:rxml,configurable:!0}})}catch(e){}
if(dt.df===!1){return}
var fire=function(t){try{if(typeof xhr['on'+t]=='function'){xhr['on'+t]()}if(typeof xhr.dispatchEvent=='function'&&typeof Event=='function'){xhr.dispatchEvent(new Event(t))}}catch(e){}};
st(function(){fire('readystatechange');fire('load');fire('loadend')},1);
return}
return sn.apply(this,arguments)},sn)},
'prevent-addEventListener':function(a){var ta=a[0],fa=a[1];
if(!ta&&!fa){return}
var tm;
if(!ta){tm=yes}else if(S(ta)[0]==='/'){tm=mm(ta)}else{tm=function(s){return S(s)===S(ta)}}
var fm=mm(fa);
var wrap=function(o){if(!o||typeof o.addEventListener!=='function'||o.addEventListener.__bm){return}
var orig=o.addEventListener;
var rep=spoof(function(t,h){var fs='';
try{fs=typeof h=='function'?fns(h):(h&&typeof h.handleEvent=='function'?fns(h.handleEvent):S(h))}catch(e){}
if(tm(S(t))&&fm(fs)){return}
return orig.apply(this,arguments)},orig);
try{dp(rep,'__bm',{value:1})}catch(e){}
try{o.addEventListener=rep}catch(e){}};
var ET=w.EventTarget;
if(ET&&ET.prototype){wrap(ET.prototype)}
if(doc){wrap(doc)}
wrap(w)},
'prevent-window-open':function(a){var fn=w.open;if(!fn){return}
var m=mm(a[0]);
w.open=spoof(function(u){if(m(S(u||''))){return null}return fn.apply(this,arguments)},fn)},
'nowebrtc':function(){var rtc=w.RTCPeerConnection?'RTCPeerConnection':(w.webkitRTCPeerConnection?'webkitRTCPeerConnection':'');
if(rtc===''){return}
var orc=w[rtc];
var pc=function(){this.close=spoof(function(){},'close');this.createDataChannel=spoof(function(){},'createDataChannel');
this.createOffer=spoof(function(){},'createOffer');this.setRemoteDescription=spoof(function(){},'setRemoteDescription')};
pc.prototype.toString=spoof(function(){return '[object '+rtc+']'},'toString');
try{w[rtc]=spoof(pc,orc)}catch(e){try{dp(w,rtc,{value:spoof(pc,orc)})}catch(e2){}}},
'json-prune':function(a){var pp=S(a[0]||'').split(/ +/),np=a[1]?S(a[1]).split(/ +/):[],i;
var sa=a[2];if(sa==='stack'||sa==='stackToMatch'){sa=a[3]}
var sm=sa?mm(sa):null;
var find=function(root,path,pr){var o=root,ch=path;
for(;;){if(typeof o!=='object'||o===null){return!1}
var i2=ch.indexOf('.');
if(i2<0){if(!pr){return has.call(o,ch)}
var md=!1,k2;
if(ch==='*'){for(k2 in o){if(has.call(o,k2)){delete o[k2];md=!0}}}
else if(has.call(o,ch)){delete o[ch];md=!0}
return md}
var p=ch.slice(0,i2),nx=ch.slice(i2+1),fd=!1,k;
if(p=='[-]'&&Array.isArray(o)){var j=o.length;while(j--){if(find(o[j],nx)){o.splice(j,1);fd=!0}}return fd}
if(p=='{-}'&&o instanceof Object){for(k in o){if(has.call(o,k)&&find(o[k],nx)){delete o[k];fd=!0}}return fd}
if((p=='[]'&&Array.isArray(o))||(p=='{}'&&o instanceof Object)||(p=='*'&&o instanceof Object)){
for(k in o){if(has.call(o,k)&&find(o[k],nx,pr)){fd=!0}}return fd}
if(!has.call(o,p)){return!1}
o=o[p];ch=nx}};
var orig=JSON.parse;
JSON.parse=spoof(function(){var o=orig.apply(this,arguments);
try{if(sm&&!sm(stk())){return o}
for(i=0;i<np.length;i++){if(!find(o,np[i])){return o}}
for(i=0;i<pp.length;i++){if(pp[i]===''){continue}find(o,pp[i],!0)}
}catch(e){}
return o},orig)},
'remove-attr':function(a){if(!a[0]||!doc){return}
var tk=toks(a[0]);if(!tk.t.length){return}
var sel=a[1]?S(a[1]):(tk.p.length===tk.t.length?'['+tk.p.join('],[')+']':'*');
var sw=function(){var els=qsa(sel),i,j,k,rm=[];
for(i=0;i<els.length;i++){var el=els[i];if(!el.attributes){continue}
rm.length=0;
for(j=0;j<el.attributes.length;j++){var an=el.attributes[j].name;
for(k=0;k<tk.t.length;k++){try{if(tk.t[k](an)){rm.push(an);break}}catch(e){}}}
for(j=0;j<rm.length;j++){try{el.removeAttribute(rm[j])}catch(e){}}}};
sw();obs(sw)},
'remove-class':function(a){if(!a[0]||!doc){return}
var tk=toks(a[0]);if(!tk.t.length){return}
var sel=a[1]?S(a[1]):(tk.p.length===tk.t.length?'.'+tk.p.join(',.'):'*');
var sw=function(){var els=qsa(sel),i,j,k,rm=[];
for(i=0;i<els.length;i++){var el=els[i];var cl=el&&el.classList;if(!cl||!cl.length){continue}
rm.length=0;
for(j=0;j<cl.length;j++){var cn=cl[j];
for(k=0;k<tk.t.length;k++){try{if(tk.t[k](cn)){rm.push(cn);break}}catch(e){}}}
for(j=0;j<rm.length;j++){try{cl.remove(rm[j])}catch(e){}}
try{if(!cl.length&&el.removeAttribute){el.removeAttribute('class')}}catch(e){}}};
sw();obs(sw)},
'set-local-storage-item':function(a){var s;try{s=w.localStorage}catch(e){}store(s,a)},
'set-session-storage-item':function(a){var s;try{s=w.sessionStorage}catch(e){}store(s,a)},
'remove-local-storage-item':function(a){var s;try{s=w.localStorage}catch(e){return}
if(!s){return}
var k=S(a[0]||'');
try{if(k==='*'){s.clear();return}
if(isre(k)){var m=mm(k),rm=[],i;
for(i=0;i<s.length;i++){var key=s.key(i);if(key&&m(key)){rm.push(key)}}
for(i=0;i<rm.length;i++){s.removeItem(rm[i])}return}
s.removeItem(k)}catch(e){}},
'href-sanitizer':function(a){if(!doc||!doc.addEventListener){return}
var sel=a[0]||'a[href]',attr='href',names=[],all=!1,i,j;
for(i=1;i<a.length;i++){var v=S(a[i]);
if(v[0]==='['&&v[v.length-1]===']'){attr=v.slice(1,-1);continue}
if(v==='*'){all=!0;continue}
var p2=v.split(/[ ,]+/);for(j=0;j<p2.length;j++){if(p2[j]){names.push(p2[j])}}}
if(!all&&!names.length){names=('utm_source utm_medium utm_campaign utm_term utm_content utm_name fbclid gclid gclsrc dclid wbraid gbraid msclkid yclid mc_eid igshid ref_src spm scm ved _ga _gl hsenc hsmi').split(' ')}
doc.addEventListener('click',function(ev){var el=ev.target;
while(el&&el!==doc){
if(el.nodeType===1&&typeof el.matches=='function'){
var hit=!1;try{hit=el.matches(sel)}catch(e){}
if(hit){var h;try{h=el.getAttribute(attr)}catch(e){}
if(h){try{var u=new(w.URL||URL)(h,doc.location&&S(doc.location.href||''));
if(all){u.search=''}else{for(var i2=0;i2<names.length;i2++){u.searchParams['delete'](names[i2])}}
el.setAttribute(attr,u.href)}catch(e){}}
return}}
el=el.parentNode}},!0)},
'spoof-css':function(a){if(!doc||!a[0]||a[1]==null){return}
var sel=S(a[0]),pr=S(a[1]),v=S(a[2]||'');
var ap=function(){var head=doc.head||doc.documentElement;
if(!head){return!1}
if(v===''){var els=qsa(sel),ok=!1,i;
for(i=0;i<els.length;i++){var el=els[i];
try{if(el.style&&el.style.removeProperty){el.style.removeProperty(pr);ok=!0}else if(el.style){el.style[pr]='';ok=!0}}catch(e){}}
return ok}
if(!doc.createElement){return!1}
var el2;try{el2=doc.createElement('style')}catch(e){return!1}
el2.textContent=sel+'{'+pr+':'+v+' !important}';
try{head.appendChild(el2);return!0}catch(e){return!1}};
var ok=ap();
if(v===''&&ok){obs(ap)}
if(!ok){var tr=0,again=function(){if(ap()||++tr>100){return}st(again,50)};
try{if(doc.addEventListener){doc.addEventListener('DOMContentLoaded',ap)}}catch(e){}
st(again,50)}},
'prevent-eval-if':function(a){var fn=w.eval;if(!fn){return}
var m=mm(a[0]);
w.eval=spoof(function(src){if(m(S(src||''))){return undefined}return fn.apply(this,arguments)},fn)},
'no-protected-audience':function(){var nav=typeof navigator=='undefined'?null:navigator,NP=typeof Navigator=='function'?Navigator.prototype:nav;
if(!NP){return}
var pv=function(x){return function(){return typeof Promise=='function'?Promise.resolve(x):x}};
var sb={joinAdInterestGroup:pv(),runAdAuction:pv(null),leaveAdInterestGroup:pv(),
clearOriginJoinedAdInterestGroups:pv(),createAuctionNonce:pv(''),updateAdInterestGroups:pv()};
for(var k in sb){if(has.call(NP,k)){try{NP[k]=spoof(sb[k],k)}catch(e){}}}}
};
function store(s,a){if(!s){return}
var k=S(a[0]||'');if(!k){return}
var v=S(a[1]||'');
try{if(v==='$remove$'){s.removeItem(k);return}
s.setItem(k,v=='emptyObj'?'{}':v=='emptyArr'?'[]':v=='emptyStr'?'':v)}catch(e){}}
function sc(n,args){var h=has.call(H,n)?H[n]:undefined;if(h===undefined){sc.misses=(sc.misses|0)+1;return}try{h(args||[])}catch(e){}}
dp(sc,'misses',{value:0,writable:!0});
dp(sc,'__bm',{value:1});
spoof(sc,'__bm_sc');
try{dp(w,'__bm_sc',{value:sc,enumerable:!1,configurable:!1,writable:!1})}catch(e){}
})();`
  }
  return runtimeCache;
}

/**
 * Emits one try/catch'd dispatcher call per invocation — a throwing or
 * malformed entry never kills the rest of the payload. Unknown names hit the
 * runtime's miss counter instead of failing.
 */
export function scriptletCallSource(invocations: CanonicalScriptlet[]): string {
  const lines: string[] = [];
  for (const inv of invocations) {
    const args = (inv.args ?? []).map(emitArg).join(',');
    lines.push(`try{(window.__bm_sc||function(){})(${emitArg(inv.name)},[${args}])}catch(_e){}`);
  }
  return lines.join('\n');
}

/**
 * runtime + calls fused into the `<script>` body's inner text. Returns
 * `undefined` when there's nothing to run so the caller can skip the whole
 * `<script>` element rather than shipping a dead IIFE. The emitted text is
 * inner-text context only — never interpolate it into attributes or
 * event-handler contexts.
 */
export function renderScriptletBlock(invocations: CanonicalScriptlet[] | undefined): string | undefined {
  if (invocations === undefined || invocations.length === 0) {
    return undefined;
  }
  return `${scriptletRuntimeSource()}\n${scriptletCallSource(invocations)}\n`;
}
