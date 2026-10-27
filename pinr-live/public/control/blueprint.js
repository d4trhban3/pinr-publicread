"use strict";
// ---------------------------------------------------------------- look-up tables
const KINDS={source:["Free source","--cyan"],reader:["Air reader","--lav"],rule:["Rule / gate","--warn"],ai:["AI","--pink"],
  store:["Evidence","--lime"],api:["Feed server","--vio"],site:["pinr.io","--lime"],outside:["Outside PINR","--mute"]};
// Status: its own colours (never a pin colour) and a sign each, so it reads without colour too.
const STATUS={live:["● live","--st-live"],building:["◐ building","--st-building"],blocked:["✕ blocked","--st-blocked"],notlive:["✕ not live","--st-blocked"],hidden:["◌ hidden","--st-hidden"],planned:["○ planned","--st-planned"]};
// Nine pin types, nine clearly different colours (colour-blind safe, after Paul Tol's sets; a light and a dark version each, in index.html).
const PINS={flow:["flow (runs next)","--ink"],coins:["coins","--pin-coins"],token:["token data","--pin-token"],media:["pictures","--pin-media"],
  trades:["trades / prices","--pin-trades"],social:["social","--pin-social"],evidence:["evidence","--pin-evidence"],ai:["AI reading","--pin-ai"],chart:["chart data","--pin-chart"]};
const KEY="pinr-blueprint-v1";
const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------------------------------------------------------------- the team's map, 2026-10-23 (no weights, caps or thresholds)
function defaultGraph(){
  const N=(id,x,y,title,kind,status,ins,outs,note)=>({id,x,y,title,kind,status,ins,outs,note});
  const C=(id,x,y,w,h,title,color)=>({id,x,y,w,h,title,kind:"comment",color});
  return {nodes:[
  C("z1",-30,-60,300,1640,"1 · Free sources (read only)","--cyan"),
  C("z2",330,-60,320,1000,"2 · Air: find coins, read token data","--lav"),
  C("z3",710,-60,320,1080,"3 · The gate","--warn"),
  C("z4",1090,-60,320,1000,"4 · Social, PINRai, evidence","--pink"),
  C("z5",1470,-60,320,800,"5 · Feed server on the server","--vio"),
  C("z6",1850,-60,320,1100,"6 · pinr.io in the visitor's browser","--lime"),

  N("s_gtnew",0,0,"GeckoTerminal new pools","source","live",[],["coins:new pools"],"Per launchpad: 17 Solana, 5 Base. Live for Pump.fun; every launchpad being added (235)."),
  N("s_lists",0,120,"Launchpads' own lists","source","live",[],["coins:new coins"],"LaunchLab, Bags, Stonk.fun, Clanker, Zora and Virtuals lists are read (switches under Routes). Keyless."),
  N("s_bnb",0,235,"BNB factory events","source","live",[],["coins:new coins"],"Four.meme and Flap coins are found from the chain's own factory events (SQD Portal first, a public node as the fallback)."),
  N("s_pp",0,350,"PumpPortal free stream","source","live",[],["coins:new coins"],"New Pump.fun and LetsBonk coins at creation, free, into the feed server's pool. Trades on it are paid: not used."),
  N("s_pump",0,465,"Pump.fun API","source","live",[],["token:coin record","chart:candles","token:holders"],"Coin records, holders, trades and candles are read when it answers; a refusal is counted and shows on its wires as NOT LIVE with the error."),
  N("s_jup",0,610,"Jupiter Tokens v2","source","live",[],["token:token data","media:picture"],"Picture, dev, launchpad, holders, launch time. 100 coins a call, free."),
  N("s_rpc",0,740,"Solana nodes","source","live",[],["token:chain reads"],"Public node, Helius, Shyft; Mac workers on QuickNode, OrbitFlare, Solana Vibe Station (228)."),
  N("s_ipfs",0,860,"Metadata files (IPFS)","source","live",[],["media:picture"],"The coin's own picture link. Some gateways never answer."),
  N("s_dex",0,970,"DexScreener","source","live",[],["trades:price, volume","token:links"],"Pairs, price, volume, launch links. Free."),
  N("s_ws",0,1100,"Solana public websocket","source","live",[],["trades:live trades"],"Real trades for the ribbon; Chainstack as overflow."),
  N("s_x",0,1215,"X (posts, accounts)","source","live",[],["social:posts"],"Only for coins that pass the gate. At the operator's cap. Its calls are counted here; switching it off stops the X check."),
  N("s_gtc",0,1330,"GeckoTerminal candles","source","live",[],["chart:candles"],"Asked by the visitor's browser directly, one retry after 3 s."),
  N("s_claude",0,1450,"Claude API","outside","building",[],["ai:model"],"The funded key (CLAUDE_DEFAULT_API). PINRai's reads and Ask PINRai spend from it, under the operator's daily cap."),

  N("a_pool",360,0,"Coin pool (discovery)","reader","live",["coins:new pools","coins:launchpad lists","coins:chain events","coins:stream"],["flow:each new coin","coins:coin list"],"Every coin found, on every chain and launchpad (235)."),
  N("a_token",360,200,"Token data reader","reader","live",["flow:run","token:Jupiter","token:chain reads","token:Pump.fun"],["flow:then","token:token data"],"Name, ticker, creator, launch time, launch links."),
  N("a_pic",360,420,"Picture pass","reader","live",["token:token data","media:Jupiter","media:metadata file"],["media:picture"],"Jupiter first, then the coin's own metadata file; Pump.fun skipped while it refuses. Order set under Routes."),
  N("a_trades",360,610,"Trade feed (tape)","reader","live",["trades:live trades","coins:coin list"],["trades:trades"],"One record per real trade."),
  N("a_mac",360,770,"Mac scoring workers","reader","live",["coins:coin list","token:chain reads"],["evidence:chain rows"],"Free capacity on the operator's Mac (228). Scan only."),

  N("g_in",740,0,"Gate · on token data","rule","live",["flow:run","token:token data"],["flow:check"],"Nothing goes to the social scan before this."),
  N("g_vamp",740,150,"Earlier look-alike by another creator?","rule","live",["flow:check"],["flow:yes","flow:no"],"Same name / ticker / picture; compares real launch times."),
  N("g_dup",740,310,"Same creator relaunching?","rule","live",["flow:no"],["flow:yes","flow:no"],""),
  N("g_serial",740,450,"Serial launcher?","rule","live",["flow:no"],["flow:yes","flow:no"],"The line stays private (no thresholds on pages)."),
  N("g_pass",740,610,"Passed","rule","live",["flow:no"],["flow:to social scan","evidence:gate result"],""),
  N("g_held",740,740,"Held","rule","live",["flow:copy","flow:relaunch","flow:serial"],["evidence:gate result"],"Held coins never reach X or PINRai."),
  N("g_copies",740,880,"Only the most active copy shows","rule","live",["evidence:gate result"],["coins:shown copies"],"Most trades and volume in the last 30 minutes (226, 227)."),

  N("e_x",1120,0,"X check (social scan)","reader","live",["flow:run","token:launch links","social:posts"],["flow:then","social:social evidence"],"Who posts about the coin; ○ reported."),
  N("e_ai",1120,190,"PINRai","ai","building",["flow:run","evidence:evidence so far","ai:model"],["ai:reading + receipts"],"Reads developer intent for coins that passed the gate; every read has its receipts. Ask PINRai (header) questions it (245)."),
  N("e_score",1120,380,"PINRscore engine","ai","live",["evidence:evidence","ai:reading"],["evidence:score"],"Shown on the PINR page, Discovery and DeepScan (244)."),
  N("e_build",1120,540,"Evidence builder (evidence/1)","store","live",["token:token data","media:picture","evidence:gate result","social:social","trades:prices","evidence:chain rows","ai:PINRai reading"],["evidence:evidence file"],"From, to, what, value, date, link. ● on chain, ○ reported. Missing stays missing."),
  N("e_store",1120,840,"Evidence store on the server","store","live",["evidence:evidence file"],["evidence:evidence"],"Kept for good, nothing deleted (232)."),

  N("p_tokens",1500,0,"/api/tokens","api","live",["coins:coin list","coins:shown copies","media:picture","trades:prices","evidence:score"],["coins:coin list"],"The coin list every page reads."),
  N("p_evid",1500,200,"/api/evidence","api","live",["evidence:evidence"],["evidence:evidence"],""),
  N("p_chart",1500,330,"/api/chart, /api/candles","api","live",["chart:Pump.fun candles","trades:own ticks","trades:DexScreener"],["chart:candles or line"],"Pump.fun refuses, so the browser asks GeckoTerminal itself."),
  N("p_img",1500,500,"/api/img","api","live",["media:picture"],["media:picture"],"Pass-through for hosts that refuse browsers."),
  N("p_trades",1500,620,"Trade stream","api","live",["trades:trades"],["trades:trades"],""),

  N("w_home",1880,0,"Home and Discover tiles","site","live",["coins:coin list","media:picture"],["flow:open a coin"],""),
  N("w_coin",1880,170,"Coin page (Orbit / health file)","site","live",["flow:open","evidence:evidence","evidence:score shown"],["flow:shows"],"Creator, funders, holders, socials, pool, links."),
  N("w_chart",1880,340,"Lightweight Charts (TradingView)","site","live",["chart:server","chart:GeckoTerminal","trades:DexScreener line"],[],"Candles with volume; a price line when no candles exist yet."),
  N("w_gate",1880,520,"\"At launch\" block","site","building",["evidence:gate result"],[],"Observed words, links to the earlier coin and the creator's other launches (238)."),
  N("w_links",1880,660,"Links out","site","live",["token:links"],[],"DexScreener, GeckoTerminal, Pump.fun, TradingView."),
  N("w_ribbon",1880,780,"Live ribbon","site","live",["trades:trades"],[],"One dot per real trade."),
  N("w_apps",1880,900,"iPhone and Android apps","site","building",["coins:coin list","evidence:evidence"],[],"Active again. Live while an iPhone or Android app asks the feed."),
  ],
  wires:[
  ["s_gtnew","new pools","a_pool","new pools"],["s_lists","new coins","a_pool","launchpad lists"],["s_bnb","new coins","a_pool","chain events"],["s_pp","new coins","a_pool","stream"],
  ["a_pool","each new coin","a_token","run"],["s_jup","token data","a_token","Jupiter"],["s_rpc","chain reads","a_token","chain reads"],["s_pump","coin record","a_token","Pump.fun"],
  ["a_token","token data","a_pic","token data"],["s_jup","picture","a_pic","Jupiter"],["s_ipfs","picture","a_pic","metadata file"],
  ["s_ws","live trades","a_trades","live trades"],["a_pool","coin list","a_trades","coin list"],["a_pool","coin list","a_mac","coin list"],["s_rpc","chain reads","a_mac","chain reads"],
  ["a_token","then","g_in","run"],["a_token","token data","g_in","token data"],["g_in","check","g_vamp","check"],
  ["g_vamp","no","g_dup","no"],["g_vamp","yes","g_held","copy"],["g_dup","yes","g_held","relaunch"],["g_dup","no","g_serial","no"],
  ["g_serial","yes","g_held","serial"],["g_serial","no","g_pass","no"],["g_held","gate result","g_copies","gate result"],
  ["g_pass","to social scan","e_x","run"],["s_dex","links","e_x","launch links"],["s_x","posts","e_x","posts"],
  ["e_x","then","e_ai","run"],["e_build","evidence file","e_ai","evidence so far"],["s_claude","model","e_ai","model"],
  ["e_ai","reading + receipts","e_build","PINRai reading"],["e_ai","reading + receipts","e_score","reading"],
  ["a_token","token data","e_build","token data"],["a_pic","picture","e_build","picture"],["g_pass","gate result","e_build","gate result"],["g_held","gate result","e_build","gate result"],
  ["e_x","social evidence","e_build","social"],["s_dex","price, volume","e_build","prices"],["a_mac","chain rows","e_build","chain rows"],
  ["e_build","evidence file","e_store","evidence file"],
  ["e_build","evidence file","e_score","evidence"],["a_mac","chain rows","e_score","evidence"],["e_score","score","p_tokens","score"],["e_score","score","w_coin","score shown"],
  ["s_pump","holders","a_token","Pump.fun"],
  ["a_pool","coin list","p_tokens","coin list"],["g_copies","shown copies","p_tokens","shown copies"],["a_pic","picture","p_tokens","picture"],["s_dex","price, volume","p_tokens","prices"],
  ["e_store","evidence","p_evid","evidence"],["s_pump","candles","p_chart","Pump.fun candles"],["a_trades","trades","p_chart","own ticks"],["s_dex","price, volume","p_chart","DexScreener"],
  ["a_pic","picture","p_img","picture"],["a_trades","trades","p_trades","trades"],
  ["p_tokens","coin list","w_home","coin list"],["p_img","picture","w_home","picture"],["w_home","open a coin","w_coin","open"],["p_evid","evidence","w_coin","evidence"],
  ["p_chart","candles or line","w_chart","server"],["s_gtc","candles","w_chart","GeckoTerminal"],["s_dex","price, volume","w_chart","DexScreener line"],
  ["p_evid","evidence","w_gate","gate result"],["s_dex","links","w_links","links"],["p_trades","trades","w_ribbon","trades"],
  ["p_tokens","coin list","w_apps","coin list"],["p_evid","evidence","w_apps","evidence"],
  ],rev:MAP_REV};
}
// What the team's map gained after viewers had saved their own. Each step is added
// to a saved map once, by its rev, so a wire the viewer takes out afterwards stays out; nodes he deleted or pins he renamed are left alone.
const MAP_REV=2;
const MAP_ADDS=[{rev:2,pins:[["p_tokens","ins","evidence:score"],["w_coin","ins","evidence:score shown"]],
  wires:[["e_build","evidence file","e_score","evidence"],["a_mac","chain rows","e_score","evidence"],["e_score","score","p_tokens","score"],["e_score","score","w_coin","score shown"],["s_pump","holders","a_token","Pump.fun"]]}];
function addNewDefaults(g){
  const from=g.rev||1,has=(id,side,name)=>{const nd=g.nodes.find(x=>x.id===id);return !!nd&&(nd[side]||[]).some(p=>(p.includes(":")?p.slice(p.indexOf(":")+1):p)===name)};let n=0;
  for(const a of MAP_ADDS){if(a.rev<=from)continue;
    for(const [id,side,p] of a.pins){const nd=g.nodes.find(x=>x.id===id);if(nd&&Array.isArray(nd[side])&&!nd[side].includes(p))nd[side].push(p)}
    for(const w of a.wires)if(!g.wires.some(x=>x.slice(0,4).join("|")===w.join("|"))&&has(w[0],"outs",w[1])&&has(w[2],"ins",w[3])){g.wires.push(w.slice());n++}}
  g.rev=Math.max(from,MAP_REV);return n}

// ---------------------------------------------------------------- state
let G, view={x:60,y:80,z:.62}, sel=null; // sel: {type:'node'|'wire', id}
const $=s=>document.querySelector(s), world=$("#world"), svg=$("#wires"), vw=$("#view"), panel=$("#panel");
function load(){try{const s=localStorage.getItem(KEY);if(s){const d=JSON.parse(s);G=d.graph;if(d.view)view=d.view;const n=addNewDefaults(G);if(n){save();setTimeout(()=>toast(`${n} new wire${n>1?"s":""} from the team's map added; your edits kept`),600)}return}}catch(e){}G=defaultGraph()}
let saveT;function save(){clearTimeout(saveT);saveT=setTimeout(()=>{try{localStorage.setItem(KEY,JSON.stringify({graph:G,view}))}catch(e){}},250)}
const pinOf=s=>{const i=s.indexOf(":");return i<0?{t:"coins",n:s}:{t:s.slice(0,i),n:s.slice(i+1)}};
const nodeById=id=>G.nodes.find(n=>n.id===id);
function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("on");setTimeout(()=>t.classList.remove("on"),1600)}

// ---------------------------------------------------------------- render
function applyView(){world.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.z})`;
  const g=24*view.z,G2=g*5;vw.style.backgroundSize=`${g}px ${g}px,${g}px ${g}px,${G2}px ${G2}px,${G2}px ${G2}px`;
  vw.style.backgroundPosition=`${view.x}px ${view.y}px`}
function render(){
  world.querySelectorAll(".node,.comment").forEach(e=>e.remove());
  for(const n of G.nodes.filter(n=>n.kind==="comment")) world.insertBefore(commentEl(n),svg);
  for(const n of G.nodes.filter(n=>n.kind!=="comment")) world.appendChild(nodeEl(n));
  drawWires();renderPanel();
}
function commentEl(n){const e=document.createElement("div");e.className="comment"+(isSel("node",n.id)?" sel":"");e.dataset.id=n.id;
  e.style.cssText=`left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;--c:var(${n.color||"--lav"})`;
  e.innerHTML=`<div class="ct"></div><div class="rz"></div>`;e.querySelector(".ct").textContent=n.title;return e}
function nodeEl(n){const k=KINDS[n.kind]||KINDS.reader,s=STATUS[n.status]||STATUS.live;
  const e=document.createElement("div");e.className="node"+(isSel("node",n.id)?" sel":"");e.dataset.id=n.id;
  e.style.cssText=`left:${n.x}px;top:${n.y}px;--k:var(${k[1]});--s:var(${s[1]})`;
  const h=document.createElement("div");h.className="nh";h.innerHTML=`<b></b><span class="st"></span>`;h.querySelector("b").textContent=n.title;h.querySelector(".st").textContent=s[0];h.querySelector(".st").dataset.s=n.status||"live";e.appendChild(h);
  const b=document.createElement("div");b.className="nb";
  for(const side of ["ins","outs"]){const c=document.createElement("div");c.className="col "+(side==="ins"?"in":"out");
    (n[side]||[]).forEach(p=>{const P=pinOf(p),pc=PINS[P.t]||PINS.coins;const r=document.createElement("div");r.className="pin";
      const d=document.createElement("span");d.className="dotp"+(P.t==="flow"?" exec":"")+(connected(n.id,P.n,side)?" on":"");d.style.setProperty("--p",`var(${pc[1]})`);
      d.dataset.node=n.id;d.dataset.pin=P.n;d.dataset.side=side;d.dataset.type=P.t;d.title=pc[0];
      const l=document.createElement("span");l.textContent=P.n;
      side==="ins"?r.append(d,l):r.append(l,d);c.appendChild(r)});b.appendChild(c)}
  e.appendChild(b);
  if(n.note){const t=document.createElement("div");t.className="note";t.textContent=n.note;e.appendChild(t)}
  return e}
const connected=(id,pin,side)=>G.wires.some(w=>side==="outs"?(w[0]===id&&w[1]===pin):(w[2]===id&&w[3]===pin));
const isSel=(t,id)=>sel&&sel.type===t&&sel.id===id;
function pinPos(id,pin,side){const d=world.querySelector(`.dotp[data-node="${CSS.escape(id)}"][data-pin="${CSS.escape(pin)}"][data-side="${side}"]`);
  if(!d)return null;const r=d.getBoundingClientRect(),wr=world.getBoundingClientRect();
  return {x:(r.left+r.width/2-wr.left)/view.z,y:(r.top+r.height/2-wr.top)/view.z,t:d.dataset.type}}
function curve(a,b){const dx=Math.max(60,Math.abs(b.x-a.x)*.5);return `M${a.x},${a.y} C${a.x+dx},${a.y} ${b.x-dx},${b.y} ${b.x},${b.y}`}
function drawWires(temp){
  let h="";G.wires.forEach((w,i)=>{const a=pinPos(w[0],w[1],"outs"),b=pinPos(w[2],w[3],"ins");if(!a||!b)return;
    const from=nodeById(w[0]),dash=from&&["blocked","hidden","planned","notlive"].includes(from.status);
    const col=`var(${(PINS[a.t]||PINS.coins)[1]})`;
    h+=`<path data-w="${i}" class="${isSel("wire",i)?"sel":""} ${dash?"dash":""}" stroke="${col}" d="${curve(a,b)}"/>`});
  if(temp)h+=`<path stroke="var(--sel)" stroke-dasharray="5 5" d="${curve(temp.a,temp.b)}"/>`;
  svg.innerHTML=h;
  svg.querySelectorAll("path[data-w]").forEach(p=>p.addEventListener("pointerdown",ev=>{ev.stopPropagation();sel={type:"wire",id:+p.dataset.w};drawWires();renderPanel()}));
}

// ---------------------------------------------------------------- side panel
function renderPanel(){
  if(!sel){panel.innerHTML=`<h2>PINR data flow</h2>
   <div class="hint">the team's map of how a coin travels through PINR (updated 26 Oct 2026). Yours to edit: it saves in this browser by itself; <b>Save file</b> keeps a copy.</div>
   <div class="hint"><b>Move</b>: drag a node's header or a zone's title (a zone carries its nodes). <b>Pan</b>: drag the grid. <b>Zoom</b>: wheel or + / −.<br>
   <b>Wire</b>: drag from an output dot (right) to an input dot (left). Click a wire to select it; Delete removes it.<br>
   <b>Edit</b>: click a node. Solid wires are live; dashed are drawing only; dotted come from blocked, hidden or planned nodes (the <b>Key</b> has them all).</div>
   <label>Pin types</label><div class="hint">${Object.entries(PINS).map(([k,v])=>`<span style="color:var(${v[1]})">●</span> ${k}: ${v[0]}`).join("<br>")}</div>
   <div class="hint">${G.nodes.filter(n=>n.kind!=="comment").length} nodes · ${G.wires.length} wires</div>`;return}
  if(sel.type==="wire"){const w=G.wires[sel.id];if(!w){sel=null;return renderPanel()}
    panel.innerHTML=`<h2>Wire</h2><div class="hint">${esc(nodeById(w[0])?.title)} · <b>${esc(w[1])}</b><br>→ ${esc(nodeById(w[2])?.title)} · <b>${esc(w[3])}</b></div><button id="pDelW">Delete wire</button>`;
    $("#pDelW").onclick=delSel;return}
  const n=nodeById(sel.id);if(!n){sel=null;return renderPanel()}
  if(n.kind==="comment"){panel.innerHTML=`<h2>Zone</h2><label>Title</label><input id="pT"><label>Colour</label>
    <select id="pC">${["--cyan","--lav","--warn","--pink","--vio","--lime","--bad","--mute"].map(c=>`<option value="${c}">${c.slice(2)}</option>`).join("")}</select>
    <div class="row2"><button id="pDel">Delete zone</button></div><div class="hint">Drag the corner to resize. Moving a zone moves the nodes inside it.</div>`;
    $("#pT").value=n.title;$("#pC").value=n.color||"--lav";
    $("#pT").oninput=e=>{n.title=e.target.value;world.querySelector(`.comment[data-id="${n.id}"] .ct`).textContent=n.title;save()};
    $("#pC").onchange=e=>{n.color=e.target.value;render();save()};$("#pDel").onclick=delSel;return}
  panel.innerHTML=`<h2>Node</h2><label>Title</label><input id="pT">
   <div class="row2"><div><label>Kind</label><select id="pK">${Object.entries(KINDS).map(([k,v])=>`<option value="${k}">${v[0]}</option>`).join("")}</select></div>
   <div><label>Status</label><select id="pS">${Object.entries(STATUS).map(([k,v])=>`<option value="${k}">${v[0]}</option>`).join("")}</select></div></div>
   <label>Notes</label><textarea id="pN"></textarea>
   <label>Inputs (one per line, type:name)</label><textarea id="pI"></textarea>
   <label>Outputs (one per line, type:name)</label><textarea id="pO"></textarea>
   <div class="hint">Types: ${Object.keys(PINS).join(", ")}. "flow" pins are the run order (Unreal's white arrows).</div>
   <div class="row2"><button id="pDup">Duplicate</button><button id="pDel">Delete node</button></div>`;
  $("#pT").value=n.title;$("#pK").value=n.kind;$("#pS").value=n.status;$("#pN").value=n.note||"";$("#pI").value=(n.ins||[]).join("\n");$("#pO").value=(n.outs||[]).join("\n");
  const re=()=>{const el=world.querySelector(`.node[data-id="${n.id}"]`);el.replaceWith(nodeEl(n));drawWires();save()};
  $("#pT").oninput=e=>{n.title=e.target.value;re()};$("#pK").onchange=e=>{n.kind=e.target.value;re()};$("#pS").onchange=e=>{n.status=e.target.value;re()};
  $("#pN").oninput=e=>{n.note=e.target.value;re()};
  const pins=(side,txt)=>{const list=txt.split("\n").map(s=>s.trim()).filter(Boolean);n[side]=list;const names=new Set(list.map(p=>pinOf(p).n));
    G.wires=G.wires.filter(w=>side==="outs"?!(w[0]===n.id&&!names.has(w[1])):!(w[2]===n.id&&!names.has(w[3])));re()};
  $("#pI").onchange=e=>pins("ins",e.target.value);$("#pO").onchange=e=>pins("outs",e.target.value);
  $("#pDel").onclick=delSel;$("#pDup").onclick=()=>{const c=JSON.parse(JSON.stringify(n));c.id=uid();c.x+=40;c.y+=40;c.title+=" (copy)";G.nodes.push(c);sel={type:"node",id:c.id};render();save()};
}
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const uid=()=>"n"+Math.random().toString(36).slice(2,8);
function delSel(){if(!sel)return;
  if(sel.type==="wire")G.wires.splice(sel.id,1);
  else{G.nodes=G.nodes.filter(n=>n.id!==sel.id);G.wires=G.wires.filter(w=>w[0]!==sel.id&&w[2]!==sel.id)}
  sel=null;render();save()}

// ---------------------------------------------------------------- pointer handling
const toWorld=(cx,cy)=>{const r=vw.getBoundingClientRect();return {x:(cx-r.left-view.x)/view.z,y:(cy-r.top-view.y)/view.z}};
let drag=null;
vw.addEventListener("pointerdown",ev=>{
  const pin=ev.target.closest(".dotp"),head=ev.target.closest(".nh"),node=ev.target.closest(".node"),ct=ev.target.closest(".ct"),rz=ev.target.closest(".rz");
  vw.setPointerCapture(ev.pointerId);
  if(pin&&pin.dataset.side==="outs"){drag={kind:"wire",from:pin.dataset,a:pinPos(pin.dataset.node,pin.dataset.pin,"outs")};return}
  if(pin&&pin.dataset.side==="ins"){ // pull an existing wire off an input
    const i=G.wires.findIndex(w=>w[2]===pin.dataset.node&&w[3]===pin.dataset.pin);
    if(i>=0){const w=G.wires.splice(i,1)[0];drag={kind:"wire",from:{node:w[0],pin:w[1]},a:pinPos(w[0],w[1],"outs")};render();save()}return}
  if(rz){const id=rz.parentElement.dataset.id,n=nodeById(id);sel={type:"node",id};drag={kind:"resize",n,sx:ev.clientX,sy:ev.clientY,w:n.w,h:n.h};render();return}
  if(ct){const id=ct.parentElement.dataset.id,n=nodeById(id);sel={type:"node",id};
    const inside=G.nodes.filter(m=>m.kind!=="comment"&&m.x>=n.x&&m.x<=n.x+n.w&&m.y>=n.y&&m.y<=n.y+n.h);
    drag={kind:"move",list:[n,...inside].map(m=>({m,x:m.x,y:m.y})),sx:ev.clientX,sy:ev.clientY};render();return}
  if(head||node){const id=node.dataset.id;sel={type:"node",id};
    if(head)drag={kind:"move",list:[{m:nodeById(id),x:nodeById(id).x,y:nodeById(id).y}],sx:ev.clientX,sy:ev.clientY};
    world.querySelectorAll(".node.sel,.comment.sel").forEach(e=>e.classList.remove("sel"));node.classList.add("sel");drawWires();renderPanel();return}
  sel=null;world.querySelectorAll(".sel").forEach(e=>e.classList.remove("sel"));drawWires();renderPanel();
  drag={kind:"pan",sx:ev.clientX,sy:ev.clientY,x:view.x,y:view.y};vw.classList.add("panning");
});
vw.addEventListener("pointermove",ev=>{if(!drag)return;
  if(drag.kind==="pan"){view.x=drag.x+ev.clientX-drag.sx;view.y=drag.y+ev.clientY-drag.sy;applyView();return}
  if(drag.kind==="move"){const dx=(ev.clientX-drag.sx)/view.z,dy=(ev.clientY-drag.sy)/view.z;
    for(const o of drag.list){o.m.x=Math.round(o.x+dx);o.m.y=Math.round(o.y+dy);const e=world.querySelector(`[data-id="${o.m.id}"]`);if(e){e.style.left=o.m.x+"px";e.style.top=o.m.y+"px"}}
    drawWires();return}
  if(drag.kind==="resize"){drag.n.w=Math.max(160,Math.round(drag.w+(ev.clientX-drag.sx)/view.z));drag.n.h=Math.max(80,Math.round(drag.h+(ev.clientY-drag.sy)/view.z));
    const e=world.querySelector(`.comment[data-id="${drag.n.id}"]`);e.style.width=drag.n.w+"px";e.style.height=drag.n.h+"px";return}
  if(drag.kind==="wire"){drawWires({a:drag.a,b:toWorld(ev.clientX,ev.clientY)})}
});
vw.addEventListener("pointerup",ev=>{if(!drag)return;
  if(drag.kind==="wire"){const t=document.elementFromPoint(ev.clientX,ev.clientY);let p=t&&t.closest(".dotp");
    if(!p||p.dataset.side!=="ins"){let best=22;for(const d of world.querySelectorAll('.dotp[data-side="ins"]')){const r=d.getBoundingClientRect(),
      dist=Math.hypot(r.left+r.width/2-ev.clientX,r.top+r.height/2-ev.clientY);if(dist<best){best=dist;p=d}}}
    if(p&&p.dataset.side==="ins"&&p.dataset.node!==drag.from.node){
      const w=[drag.from.node,drag.from.pin,p.dataset.node,p.dataset.pin];
      if(!G.wires.some(x=>x.join("|")===w.join("|")))G.wires.push(w)}
    render()}
  if(drag.kind!=="pan"||true)save();drag=null;vw.classList.remove("panning")});
vw.addEventListener("wheel",ev=>{ev.preventDefault();zoomAt(ev.clientX,ev.clientY,Math.exp(-ev.deltaY*.0015))},{passive:false});
function zoomAt(cx,cy,f){const r=vw.getBoundingClientRect(),px=cx-r.left,py=cy-r.top,z=Math.min(2,Math.max(.2,view.z*f));
  view.x=px-(px-view.x)*z/view.z;view.y=py-(py-view.y)*z/view.z;view.z=z;applyView();drawWires();save()}
document.addEventListener("keydown",ev=>{if(["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName))return;
  if(ev.key==="Delete"||ev.key==="Backspace"){ev.preventDefault();delSel()}});

// ---------------------------------------------------------------- toolbar
function centre(){const r=vw.getBoundingClientRect();return toWorld(r.left+r.width/2,r.top+r.height/2)}
$("#bAdd").onclick=()=>{const c=centre(),n={id:uid(),x:Math.round(c.x-115),y:Math.round(c.y-40),title:"New node",kind:"reader",status:"planned",ins:["flow:run"],outs:["flow:then"],note:""};
  G.nodes.push(n);sel={type:"node",id:n.id};render();save()};
$("#bAddC").onclick=()=>{const c=centre(),n={id:uid(),x:Math.round(c.x-160),y:Math.round(c.y-120),w:320,h:240,title:"New zone",kind:"comment",color:"--lav"};
  G.nodes.unshift(n);sel={type:"node",id:n.id};render();save()};
function fit(){const xs=G.nodes.flatMap(n=>[n.x,n.x+(n.w||230)]),ys=G.nodes.flatMap(n=>[n.y,n.y+(n.h||160)]);
  const r=vw.getBoundingClientRect(),w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);
  view.z=Math.min(1.2,Math.max(.2,Math.min(r.width/(w+80),r.height/(h+80))));view.x=-Math.min(...xs)*view.z+40;view.y=-Math.min(...ys)*view.z+40;applyView();drawWires();save()}
$("#bFit").onclick=fit;
$("#bZin").onclick=()=>{const r=vw.getBoundingClientRect();zoomAt(r.left+r.width/2,r.top+r.height/2,1.2)};
$("#bZout").onclick=()=>{const r=vw.getBoundingClientRect();zoomAt(r.left+r.width/2,r.top+r.height/2,1/1.2)};
$("#bTheme").onclick=()=>{const d=document.documentElement,cur=d.dataset.theme||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");
  d.dataset.theme=cur==="light"?"dark":"light";try{localStorage.setItem(KEY+"-theme",d.dataset.theme)}catch(e){}};
$("#bExport").onclick=()=>{const b=new Blob([JSON.stringify({graph:G,view},null,1)],{type:"application/json"});const a=document.createElement("a");
  a.href=URL.createObjectURL(b);a.download="pinr-blueprint-"+new Date().toISOString().slice(0,10)+".json";a.click();URL.revokeObjectURL(a.href);toast("Saved to your Downloads")};
$("#bImport").onclick=()=>$("#fImport").click();
$("#fImport").onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const d=JSON.parse(await f.text());if(!d.graph||!Array.isArray(d.graph.nodes))throw 0;
  G=d.graph;if(d.view)view=d.view;const n=addNewDefaults(G);sel=null;applyView();render();save();toast("Opened "+f.name+(n?` (${n} new wire${n>1?"s":""} from the team's map added)`:""))}catch(_){toast("That file is not a PINR blueprint")}e.target.value=""};
$("#bReset").onclick=()=>{if(!confirm("Replace your edits with the team's current map? Save a file first if you want to keep them."))return;G=defaultGraph();sel=null;render();fit();toast("Back to the 23 Oct map")};
$("#legend").innerHTML=Object.values(STATUS).map(s=>`<span><i style="background:var(${s[1]})"></i>${s[0]}</span>`).join("");

// ---------------------------------------------------------------- start
try{const t=localStorage.getItem(KEY+"-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}
load();applyView();render();
let fresh=true;try{fresh=!localStorage.getItem(KEY)}catch(e){}
if(fresh)requestAnimationFrame(fit);
