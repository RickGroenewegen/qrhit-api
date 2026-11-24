/**
 * The playlist cards ChatGPT shows with a playlist answer (MCP Apps: a
 * `ui://` resource the tool points at). One self-contained HTML document,
 * no script or style from anywhere else; the only thing it loads is the
 * cover images.
 *
 * It reads the tool result two ways, because hosts differ: the MCP Apps
 * bridge (JSON-RPC over postMessage, `ui/notifications/tool-result`) and
 * ChatGPT's own `window.openai.toolOutput`. A card's button opens the page on
 * the site where the customer designs the cards and orders.
 *
 * The URI is a cache key: a change to the HTML that an old tool result would
 * not survive gets a new version in the URI.
 */

export const WIDGET_URI = 'ui://widget/qrsong-playlists-v2.html';
export const WIDGET_MIME = 'text/html;profile=mcp-app';

/** Where the cover images come from; everything else is refused by the CSP. */
const IMAGE_ORIGINS = [
  (process.env['API_URI'] || 'https://api.qrsong.io').replace(/\/+$/, ''),
  // Spotify's playlist covers, for a customer's own playlist.
  'https://i.scdn.co',
  'https://mosaic.scdn.co',
  'https://image-cdn-ak.spotifycdn.com',
  'https://image-cdn-fa.spotifycdn.com',
];

const SITE_ORIGIN = (process.env['FRONTEND_URI'] || 'https://www.qrsong.io').replace(/\/+$/, '');

const STYLE = `
:root{color-scheme:light dark;--bg:transparent;--card:#ffffff;--line:#e7ddd4;--text:#16302f;--muted:#5d6f6e;--brand:#18565e;--brand-text:#ffffff;--tile:#feefe5}
:root[data-theme=dark]{--card:#12292c;--line:#24474b;--text:#f3ece6;--muted:#a9bcbb;--brand:#7fd1c6;--brand-text:#0b2c31;--tile:#0f3a40}
*{box-sizing:border-box}
html,body{margin:0;padding:0;overflow:hidden;background:var(--bg);color:var(--text);font:14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{position:relative;padding:2px 0 6px}
.list{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding:2px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.list::-webkit-scrollbar{display:none}
.card{flex:0 0 188px;scroll-snap-align:start;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.one .card{flex-basis:100%;max-width:420px;flex-direction:row}
.art{aspect-ratio:1/1;width:100%;background:var(--tile);display:block;object-fit:cover}
.one .art{width:132px;flex:0 0 132px}
.tile{display:flex;align-items:center;justify-content:center;color:var(--brand)}
.tile svg{width:44%;height:44%}
.body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;flex:1;min-width:0}
.name{font-weight:650;font-size:14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.7em}
.one .name{min-height:0}
.own{border-style:dashed}
.own .name{min-height:0}
.hint{color:var(--muted);font-size:13px}
.meta{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.price{color:var(--text);font-weight:650}
.go{margin-top:auto;display:flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:8px 10px;border-radius:999px;background:var(--brand);color:var(--brand-text);font-weight:650;font-size:13px;text-decoration:none;text-align:center;border:0;cursor:pointer}
.go:focus-visible,.nav:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.go svg{width:13px;height:13px;flex:0 0 13px}
.nav{position:absolute;top:78px;width:32px;height:32px;border-radius:50%;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.18)}
.nav svg{width:14px;height:14px}
.nav.prev{left:-4px}.nav.next{right:-4px}
@media (hover:hover){.wrap.scrolls .nav{display:flex}.nav[disabled]{display:none!important}}
@media (prefers-reduced-motion:no-preference){.list{scroll-behavior:smooth}}
`;

const SCRIPT = `
(function(){
  var labels={cards:'cards',cta:'Make these cards',ownTitle:'',ownBody:''};
  var list=document.getElementById('list'),wrap=document.getElementById('wrap');
  var prev=document.getElementById('prev'),next=document.getElementById('next');
  var shown='',seq=0,initId=null;
  var NOTE='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 3v10.6A3.5 3.5 0 1 0 11 17V7h6V3z"/></svg>';
  var LINK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.5l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.1-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/></svg>';
  var OUT='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

  function post(m){try{window.parent.postMessage(m,'*')}catch(e){}}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function safeUrl(u){return /^(https:\\/\\/|http:\\/\\/localhost[:\\/])/i.test(String(u||''))?String(u):''}

  function items(d){
    if(!d||typeof d!=='object')return[];
    if(Array.isArray(d.playlists))return d.playlists;
    if(d.found&&d.url)return[{name:d.name,cards:d.cards||d.songs,price:d.price,cover:d.cover,url:d.url}];
    return[];
  }

  function theme(t){if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}

  function size(){
    var h=Math.ceil(document.documentElement.getBoundingClientRect().height);
    post({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width:Math.ceil(document.documentElement.clientWidth),height:h}});
    try{if(window.openai&&window.openai.notifyIntrinsicHeight)window.openai.notifyIntrinsicHeight(h)}catch(e){}
  }

  function arrows(){
    var more=list.scrollWidth-list.clientWidth>4;
    wrap.classList.toggle('scrolls',more);
    prev.disabled=list.scrollLeft<4;
    next.disabled=list.scrollLeft>list.scrollWidth-list.clientWidth-4;
  }

  function open(url){
    try{if(window.openai&&window.openai.openExternal){window.openai.openExternal({href:url});return true}}catch(e){}
    if(initId!==null){post({jsonrpc:'2.0',id:++seq,method:'ui/open-link',params:{url:url}});return true}
    return false;
  }

  function render(data,meta){
    if(meta&&meta.labels){
      if(meta.labels.cards)labels.cards=meta.labels.cards;
      if(meta.labels.cta)labels.cta=meta.labels.cta;
      if(meta.labels.ownTitle)labels.ownTitle=meta.labels.ownTitle;
      if(meta.labels.ownBody)labels.ownBody=meta.labels.ownBody;
    }
    var own=data&&Array.isArray(data.playlists)&&labels.ownTitle?
      '<article class="card own"><div class="art tile">'+LINK+'</div><div class="body"><div class="name">'+esc(labels.ownTitle)+'</div><div class="hint">'+esc(labels.ownBody)+'</div></div></article>':'';
    var rows=items(data).filter(function(p){return p&&p.name&&safeUrl(p.url)});
    var key=JSON.stringify([rows,labels]);
    if(key===shown)return;
    shown=key;
    wrap.hidden=rows.length===0;
    if(rows.length===0)own='';
    list.className='list'+(rows.length===1?' one':'');
    list.innerHTML=rows.map(function(p){
      var cover=safeUrl(p.cover);
      var meta=[];
      if(p.cards)meta.push(esc(p.cards)+' '+esc(labels.cards));
      if(p.price&&p.price.text)meta.push('<span class="price">'+esc(p.price.text)+'</span>');
      return '<article class="card">'+
        (cover?'<img class="art" loading="lazy" alt="" src="'+esc(cover)+'">':'<div class="art tile">'+NOTE+'</div>')+
        '<div class="body"><div class="name">'+esc(p.name)+'</div>'+
        '<div class="meta">'+meta.join(' &middot; ')+'</div>'+
        '<a class="go" target="_blank" rel="noopener noreferrer" href="'+esc(safeUrl(p.url))+'">'+esc(labels.cta)+OUT+'</a></div></article>';
    }).join('')+own;
    Array.prototype.forEach.call(list.querySelectorAll('img.art'),function(img){
      img.addEventListener('error',function(){
        var d=document.createElement('div');d.className='art tile';d.innerHTML=NOTE;img.replaceWith(d);
      });
      img.addEventListener('load',size);
    });
    arrows();size();
  }

  list.addEventListener('click',function(e){
    var a=e.target&&e.target.closest?e.target.closest('a.go'):null;
    if(a&&open(a.href))e.preventDefault();
  });
  list.addEventListener('scroll',arrows,{passive:true});
  prev.addEventListener('click',function(){list.scrollBy({left:-list.clientWidth*.8})});
  next.addEventListener('click',function(){list.scrollBy({left:list.clientWidth*.8})});
  window.addEventListener('resize',function(){arrows();size()});

  function fromOpenai(){
    var o=window.openai;if(!o)return;
    theme(o.theme);
    if(o.toolOutput)render(o.toolOutput,(o.toolResponseMetadata||{}));
  }
  window.addEventListener('openai:set_globals',fromOpenai);

  window.addEventListener('message',function(e){
    if(e.source!==window.parent)return;
    var m=e.data;if(!m||m.jsonrpc!=='2.0')return;
    if(initId!==null&&m.id===initId&&m.result){
      var c=m.result.hostContext||{};theme(c.theme);
      post({jsonrpc:'2.0',method:'ui/notifications/initialized'});
      return;
    }
    if(m.method==='ui/notifications/tool-result'&&m.params){
      render(m.params.structuredContent,m.params._meta||{});
    }else if(m.method==='ui/notifications/host-context-changed'&&m.params){
      theme(m.params.theme);
    }
  });

  if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)theme('dark');
  fromOpenai();
  if(window.parent&&window.parent!==window){
    initId=++seq;
    var who={name:'qrsong-playlists',version:'1.0.0'};
    post({jsonrpc:'2.0',id:initId,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:who,clientInfo:who,appCapabilities:{availableDisplayModes:['inline']},capabilities:{}}});
  }
})();
`;

const ARROW_LEFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>';
const ARROW_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';

export const WIDGET_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  `<title>QRSong!</title><style>${STYLE}</style></head><body>` +
  '<div class="wrap" id="wrap" hidden>' +
  `<button class="nav prev" id="prev" type="button" aria-label="Previous">${ARROW_LEFT}</button>` +
  '<div class="list" id="list"></div>' +
  `<button class="nav next" id="next" type="button" aria-label="Next">${ARROW_RIGHT}</button>` +
  `</div><script>${SCRIPT}</script></body></html>`;

const WIDGET_DESCRIPTION =
  'Shows each playlist as a card with its cover, the number of cards, the price of the printed cards and a button that opens its page on qrsong.io. ' +
  'After the ready-made playlists a last card says the customer can paste the link of their own playlist. ' +
  'The customer already sees these, so do not list them again: add one or two sentences at most, and say they can also paste their own playlist link.';

/** What the host needs to know to frame the widget. */
function widgetMeta(): Record<string, unknown> {
  return {
    ui: {
      csp: { connectDomains: [], resourceDomains: IMAGE_ORIGINS },
      domain: SITE_ORIGIN,
      prefersBorder: false,
    },
    'openai/widgetCSP': {
      connect_domains: [],
      resource_domains: IMAGE_ORIGINS,
      redirect_domains: [SITE_ORIGIN],
    },
    'openai/widgetDomain': SITE_ORIGIN,
    'openai/widgetPrefersBorder': false,
    'openai/widgetDescription': WIDGET_DESCRIPTION,
  };
}

/** The entry `resources/list` gives. */
export function listWidgetResources(): Record<string, unknown>[] {
  return [
    {
      uri: WIDGET_URI,
      name: 'qrsong-playlists',
      title: 'QRSong! playlists',
      description: 'Playlist cards: cover, number of cards, price and a link to qrsong.io.',
      mimeType: WIDGET_MIME,
      _meta: widgetMeta(),
    },
  ];
}

/** The answer to `resources/read`, null for a URI that is not ours. */
export function readWidgetResource(uri: unknown): Record<string, unknown> | null {
  if (uri !== WIDGET_URI) return null;
  return {
    contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: WIDGET_HTML, _meta: widgetMeta() }],
  };
}

/** On a tool that answers with playlists: which widget shows them. */
export function widgetToolMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: WIDGET_URI, visibility: ['model', 'app'] },
    'openai/outputTemplate': WIDGET_URI,
  };
}
