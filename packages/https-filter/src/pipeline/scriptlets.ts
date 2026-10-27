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
 *    `set-constant foo false`.
 *  - `prevent-fetch`/`prevent-xhr` take uBO's propsToMatch surface:
 *    whitespace-separated `key:value` needles test that collated prop
 *    (a bare token is a `url`-contains needle; a key containing chars
 *    outside `$\w -` collapses back to a url needle, matching uBO's
 *    parsePropertiesToMatch quirk) and a `!`-leading pattern negates.
 *    A needle on an absent prop is skipped and at least one needle must
 *    positively match (uBO's matchObjectProperties). The `responseBody`
 *    token maps uBO's generator (`emptyObj`/`emptyArr`/`emptyStr`/
 *    `true`/`length:N[-M]`); `responseType` is honored only to set
 *    `type` on the synthetic response — the trusted JSON flavor that
 *    also drives headers/status is out of scope. XHR matches uBO's
 *    `{method, url}` haystack; fetch collates uBO's init-prop whitelist.
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
 * bails honestly. Function `.toString` spoofing is explicitly out of scope
 * (flagged in the P2 plan).
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

let runtimeCache: string | undefined;

/**
 * The library IIFE — defines `window.__bm_sc(name, args)` non-enumerably and
 * returns. Idempotent: a second injection is a no-op. Every scriptlet body
 * swallows its own exceptions at the dispatcher, so a partial DOM or a page
 * fighting back can never turn our block into a page-visible error.
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
function et(){if(tok!=null){return tok}tok='bm'+Math.random().toString(36).slice(2);try{var oe=w.onerror;w.onerror=function(m){if(typeof m=='string'&&m.indexOf(tok)>-1){return!0}if(typeof oe=='function'){return oe.apply(this,arguments)}return!1}}catch(e){}return tok}
function die(){throw new ReferenceError(et())}
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
if(d&&d.set!==undefined){return}
var h=cur;
try{dp(o,p,{configurable:!0,get:function(){return h},
set:function(x){h=x;if(x!=null&&(typeof x=='object'||typeof x=='function')){walk(x,rest,leaf)}}})}catch(e){}
return}}
function leaf(o,p,g,s){var d=gpd(o,p);if(d&&!d.configurable){return}
var v;try{v=o[p]}catch(e){}
try{dp(o,p,{configurable:!0,get:function(){return g(v)},set:function(x){v=s(x)}})}catch(e){}}
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
function genc(tok){tok=S(tok||'');
if(tok==='emptyObj'){return'{}'}
if(tok==='emptyArr'){return'[]'}
if(tok==='true'){return rtxt(10)}
var mch=/^length:(\\d+)(?:-(\\d+))?$/.exec(tok);
if(mch){var mn=parseInt(mch[1],10)||0,mx=Math.max(parseInt(mch[2],10)||0,mn);
return rtxt(Math.min(mn+(mx-mn)*Math.random(),500000)|0)}
return''}
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
w[nm]=function(){var cb=arguments[0],src=typeof cb=='function'?fns(cb):S(cb),hit=m(src);
if(ng){hit=!hit}
if(hit&&dt(arguments[1])){if(adj){arguments[1]=(Number(arguments[1])||0)*fct}else{arguments[0]=noop}}
return fn.apply(this,arguments)}}
function ab(chk){return function(o,p){leaf(o,p,function(v){if(chk()){die()}return v},function(x){if(chk()){die()}return x})}}
var H={
'set-constant':function(a){var ch=a[0];if(!ch){return}
var sf=a[2];if(sf==='stack'||sf==='stackToMatch'){sf=a[3]}
if(sf&&!mm(sf)(stk())){return}
var v=cv(a[1]);
walk(w,S(ch),function(o,p){var d=gpd(o,p);if(d&&!d.configurable){return}
var ex;try{ex=o[p]}catch(e){ex=undefined}
if(ex!==undefined&&ex!==null&&v!==undefined&&v!==null&&typeof ex!==typeof v){return}
var nv=v,dead=!1;
try{dp(o,p,{configurable:!1,get:function(){return nv},
set:function(x){if(dead||(x!=null&&nv!=null&&typeof x!==typeof nv)){dead=!0;nv=x}}})}catch(e){}})},
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
var rtype='default',rt=S(a[2]||'');
if(/^(basic|cors|default|error|opaque)$/.test(rt)){rtype=rt}
w.fetch=function(){var d=fargs(arguments[0],arguments[1]);
if(hall(ps,d)){
if(typeof Response=='function'){try{var r2=new Response(body,{status:200});
if(rtype!=='default'){try{dp(r2,'type',{value:rtype})}catch(e){}}
return Promise.resolve(r2)}catch(e){}}
return Promise.resolve({ok:!0,status:200,url:d.url||'',headers:{get:function(){return null},forEach:noop},
redirected:!1,type:rtype,bodyUsed:!1,
text:function(){return Promise.resolve(body)},
json:function(){return Promise.resolve().then(function(){return JSON.parse(body)})},
arrayBuffer:function(){return Promise.resolve(new ArrayBuffer(0))},
blob:function(){return Promise.resolve(typeof Blob=='function'?new Blob([body]):{})},
formData:function(){return Promise.resolve(typeof FormData=='function'?new FormData():{})},
clone:function(){return this}})}
return fn.apply(this,arguments)}},
'prevent-xhr':function(a){var X=w.XMLHttpRequest;if(!X||!X.prototype){return}
var ps=pset(a[0]);if(!ps.length&&!a[0]){return}
var body=genc(a[1]);
var op=X.prototype.open,sn=X.prototype.send;
if(!op||!sn){return}
var wm=typeof WeakMap=='function'?new WeakMap():null;
X.prototype.open=function(mtd,url){var dt={u:S(url||''),m:S(mtd||'')};
if(wm){wm.set(this,dt)}else{try{this.__bm_xu=dt.u;this.__bm_xm=dt.m}catch(e){}}
return op.apply(this,arguments)};
X.prototype.send=function(){var dt=wm?wm.get(this):{u:this.__bm_xu||'',m:this.__bm_xm||''};
if(dt&&hall(ps,{url:dt.u,method:dt.m})){var xhr=this;
try{O.defineProperties(xhr,{readyState:{value:4,configurable:!0},status:{value:200,configurable:!0},response:{value:body,configurable:!0},responseText:{value:body,configurable:!0},responseXML:{value:null,configurable:!0}})}catch(e){}
var fire=function(t){try{if(typeof xhr['on'+t]=='function'){xhr['on'+t]()}if(typeof xhr.dispatchEvent=='function'&&typeof Event=='function'){xhr.dispatchEvent(new Event(t))}}catch(e){}};
st(function(){fire('readystatechange');fire('load');fire('loadend')},1);
return}
return sn.apply(this,arguments)}},
'prevent-addEventListener':function(a){var ta=a[0],fa=a[1];
if(!ta&&!fa){return}
var tm;
if(!ta){tm=yes}else if(S(ta)[0]==='/'){tm=mm(ta)}else{tm=function(s){return S(s)===S(ta)}}
var fm=mm(fa);
var wrap=function(o){if(!o||typeof o.addEventListener!=='function'||o.addEventListener.__bm){return}
var orig=o.addEventListener;
var rep=function(t,h){var fs='';
try{fs=typeof h=='function'?fns(h):(h&&typeof h.handleEvent=='function'?fns(h.handleEvent):S(h))}catch(e){}
if(tm(S(t))&&fm(fs)){return}
return orig.apply(this,arguments)};
rep.__bm=1;
try{o.addEventListener=rep}catch(e){}};
var ET=w.EventTarget;
if(ET&&ET.prototype){wrap(ET.prototype)}
if(doc){wrap(doc)}
wrap(w)},
'prevent-window-open':function(a){var fn=w.open;if(!fn){return}
var m=mm(a[0]);
w.open=function(u){if(m(S(u||''))){return null}return fn.apply(this,arguments)}},
'nowebrtc':function(){var rtc=w.RTCPeerConnection?'RTCPeerConnection':(w.webkitRTCPeerConnection?'webkitRTCPeerConnection':'');
if(rtc===''){return}
var pc=function(){this.close=noop;this.createDataChannel=noop;this.createOffer=noop;this.setRemoteDescription=noop};
pc.prototype.toString=function(){return '[object '+rtc+']'};
try{w[rtc]=pc}catch(e){try{dp(w,rtc,{value:pc})}catch(e2){}}},
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
JSON.parse=function(){var o=orig.apply(this,arguments);
try{if(sm&&!sm(stk())){return o}
for(i=0;i<np.length;i++){if(!find(o,np[i])){return o}}
for(i=0;i<pp.length;i++){if(pp[i]===''){continue}find(o,pp[i],!0)}
}catch(e){}
return o}},
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
w.eval=function(src){if(m(S(src||''))){return undefined}return fn.apply(this,arguments)}},
'no-protected-audience':function(){var nav=typeof navigator=='undefined'?null:navigator,NP=typeof Navigator=='function'?Navigator.prototype:nav;
if(!NP){return}
var pv=function(x){return function(){return typeof Promise=='function'?Promise.resolve(x):x}};
var sb={joinAdInterestGroup:pv(),runAdAuction:pv(null),leaveAdInterestGroup:pv(),
clearOriginJoinedAdInterestGroups:pv(),createAuctionNonce:pv(''),updateAdInterestGroups:noop};
for(var k in sb){if(has.call(NP,k)){try{NP[k]=sb[k]}catch(e){}}}}
};
function store(s,a){if(!s){return}
var k=S(a[0]||'');if(!k){return}
var v=S(a[1]||'');
try{if(v==='$remove$'){s.removeItem(k);return}
s.setItem(k,v=='emptyObj'?'{}':v=='emptyArr'?'[]':v=='emptyStr'?'':v)}catch(e){}}
function sc(n,args){var h=has.call(H,n)?H[n]:undefined;if(h===undefined){sc.misses=(sc.misses|0)+1;return}try{h(args||[])}catch(e){}}
dp(sc,'misses',{value:0,writable:!0});
dp(sc,'__bm',{value:1});
dp(w,'__bm_sc',{value:sc,enumerable:!1,configurable:!1,writable:!1});
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
