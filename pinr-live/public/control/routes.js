// Routes on /control: which source fills which field, and which launchpads are on, as the engine's /api/control/routing says. Edits are staged:
// an Apply bar shows what changes and the server's own before and after, then applies; versions with undo; whatever the server refuses shows its reason. A map wire that
// matches a route is drawn solid with a "live" mark, any other wire stays dashed (drawing only). The pure parts are on window.PinrRoutes so they can be tested.
// Server text goes on the page as text only, never markup.
(function () {
  "use strict";
  const EVERY_MS = 8000;
  /** The operator's map wires that are real routes: "from|out pin|to|in pin" -> the routes it stands for ([field, source]; live while any is in force). */
  const WIRE_ROUTES = {
    "s_jup|picture|a_pic|Jupiter": [["picture", "jupiter"]],
    "s_ipfs|picture|a_pic|metadata file": [["picture", "ipfs"]],
    "s_jup|token data|a_token|Jupiter": [["token_data", "jupiter"]],
    "s_pump|candles|p_chart|Pump.fun candles": [["candles", "pumpfun"]],
    "s_gtc|candles|w_chart|GeckoTerminal": [["candles", "geckoterminal"]],
    "a_trades|trades|p_chart|own ticks": [["candles", "tape"]],
    "s_dex|price, volume|p_tokens|prices": [["price", "dexscreener"], ["volume", "dexscreener"], ["liquidity", "dexscreener"]],
  };
  /**
   * a design decision phase 2 on the map itself: which source a map node stands for, and which route fields a node's input feeds. A wire from such a source into
   * such an input IS a route (when the catalog lets that source fill that field): drawing it stages the source into the field's order, removing it stages it out.
   */
  const SOURCE_OF_NODE = { s_jup: "jupiter", s_ipfs: "ipfs", s_pump: "pumpfun", s_pp: "pumpportal", s_dex: "dexscreener", s_gtc: "geckoterminal", s_gtnew: "geckoterminal", a_trades: "tape", s_ws: "tape" };
  const FIELDS_OF_INPUT = (to, pin) =>
    to === "a_pic" ? ["picture"]
      : to === "a_token" ? ["token_data"]
        : to === "e_x" && pin === "launch links" ? ["links"]
          : to === "p_tokens" && pin === "prices" ? ["price", "volume", "liquidity"]
            : to === "p_chart" || to === "w_chart" ? ["candles"]
              : [];
  /** The routes one map wire ([from, out pin, to, in pin]) stands for: [field, source] pairs the catalog allows; none for a drawing-only wire. */
  function routesOfWire(w, catalog) {
    if (!Array.isArray(w) || !catalog || !catalog.fields) return [];
    const src = SOURCE_OF_NODE[w[0]];
    if (!src) return [];
    return FIELDS_OF_INPUT(w[2], w[3]).filter((f) => catalog.fields[f] && Array.isArray(catalog.fields[f].sources) && catalog.fields[f].sources.includes(src)).map((f) => [f, src]);
  }
  /** Every route the map's wires stand for, as "field|source". */
  function routesOnMap(wires, catalog) {
    const out = new Set();
    for (const w of Array.isArray(wires) ? wires : []) for (const [f, s] of routesOfWire(w, catalog)) out.add(`${f}|${s}`);
    return out;
  }
  /**
   * The operator drew or removed route wires on the map: what that stages. A route drawn adds its source at the end of the field's order; a route removed takes
   * its source out (never the field's last source). Fields the feed or engine does not follow are left alone. Returns the next routing and the edits in words.
   */
  function mapEdits(r, before, after, catalog) {
    let next = r;
    const said = [];
    for (const k of after) {
      if (before.has(k)) continue;
      const [f, s] = k.split("|");
      if (!followedOf(catalog.fields[f]) || (next.routes[f] || []).includes(s)) continue;
      next = addSource(next, f, s, catalog);
      said.push(`${catalog.fields[f].words || f}: ${nameOf(catalog, s)} added (last)`);
    }
    for (const k of before) {
      if (after.has(k)) continue;
      const [f, s] = k.split("|");
      const list = next.routes[f] || [];
      const i = list.indexOf(s);
      if (!followedOf(catalog.fields[f]) || i < 0 || list.length < 2) continue;
      next = removeSource(next, f, i);
      said.push(`${catalog.fields[f].words || f}: ${nameOf(catalog, s)} taken out`);
    }
    return { next, said };
  }
  /** The launchpad switches that sit on a node of the map. */
  const NODE_LAUNCHPADS = { s_pump: ["pumpfun"], s_lists: ["launchlab", "bags", "stonkfun"], s_jup: ["jupiter_recent"] };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const sameOrder = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

  /** Every field's default order and every launchpad's default switch, from the catalog (today's behaviour). */
  function defaultsOf(catalog) {
    const routes = {};
    for (const [f, d] of Object.entries((catalog && catalog.fields) || {})) routes[f] = Array.isArray(d.default) ? d.default.slice() : [];
    const discovery = {};
    for (const [l, d] of Object.entries((catalog && catalog.discovery) || {})) discovery[l] = d.default !== false;
    return { routes, discovery };
  }
  /** What is in force: the applied routing with anything missing filled from the defaults. */
  function effective(routing, catalog) {
    const d = defaultsOf(catalog);
    const r = routing && typeof routing === "object" ? routing : {};
    const routes = { ...d.routes, ...(r.routes && typeof r.routes === "object" ? clone(r.routes) : {}) };
    const discovery = { ...d.discovery, ...(r.discovery && typeof r.discovery === "object" ? clone(r.discovery) : {}) };
    const out = { routes, discovery };
    // The Solana node order and the trade feed (phase 2's engine rest): optional; absent means today's settings order.
    if (r.nodes && typeof r.nodes === "object") out.nodes = clone(r.nodes);
    if (r.trade_feed && typeof r.trade_feed === "object") out.trade_feed = clone(r.trade_feed);
    return out;
  }
  /** The node order shown for each kind of read: the routing's own, else what the engine says is in force (status nodes_effective), else none known. */
  function nodesShown(r, catalog, effectiveNodes) {
    const kinds = (catalog && catalog.nodes && catalog.nodes.kinds) || {};
    const out = {};
    for (const k of Object.keys(kinds)) {
      const own = r.nodes && Array.isArray(r.nodes[k]) ? r.nodes[k] : null;
      const eff = effectiveNodes && Array.isArray(effectiveNodes[k]) ? effectiveNodes[k] : [];
      out[k] = (own || eff).slice();
    }
    return out;
  }
  /** A change to one kind's node list: the routing then carries every kind (the server checks them all), the others as shown. */
  function withNodes(r, kind, list, shown) {
    const o = clone(r);
    o.nodes = { ...clone(shown), ...(o.nodes || {}) };
    o.nodes[kind] = list.slice();
    return o;
  }
  const moveIn = (list, i, dir) => {
    const l = list.slice();
    const j = i + dir;
    if (i < 0 || j < 0 || i >= l.length || j >= l.length) return l;
    [l[i], l[j]] = [l[j], l[i]];
    return l;
  };
  function withTradeFeed(r, nodes, coins) {
    const o = clone(r);
    o.trade_feed = { nodes: nodes.filter(Boolean), coins };
    return o;
  }
  function moveSource(r, field, i, dir) {
    const o = clone(r);
    const list = o.routes[field];
    const j = i + dir;
    if (!Array.isArray(list) || i < 0 || j < 0 || i >= list.length || j >= list.length) return o;
    [list[i], list[j]] = [list[j], list[i]];
    return o;
  }
  function removeSource(r, field, i) {
    const o = clone(r);
    if (Array.isArray(o.routes[field]) && o.routes[field].length > 1) o.routes[field].splice(i, 1); // never the last one: a field needs a source
    return o;
  }
  function addSource(r, field, source, catalog) {
    const o = clone(r);
    const allowed = catalog && catalog.fields && catalog.fields[field] && catalog.fields[field].sources;
    if (!Array.isArray(allowed) || !allowed.includes(source) || (o.routes[field] || []).includes(source)) return o;
    (o.routes[field] = o.routes[field] || []).push(source);
    return o;
  }
  function setLaunchpad(r, name, on) {
    const o = clone(r);
    o.discovery[name] = !!on;
    return o;
  }
  /** What the server would refuse, said before asking: a field with no source or a source it may not use or twice, no launchpad on. */
  function problemsOf(r, catalog) {
    const out = [];
    for (const [f, d] of Object.entries((catalog && catalog.fields) || {})) {
      const list = r.routes && r.routes[f];
      if (!Array.isArray(list) || !list.length) out.push(`${d.words || f} needs at least one source`);
      else {
        if (list.some((s) => !d.sources.includes(s))) out.push(`${d.words || f}: a source it cannot use`);
        if (new Set(list).size !== list.length) out.push(`${d.words || f}: a source twice`);
      }
    }
    const nk = (catalog && catalog.nodes) || null;
    if (r.nodes && nk) {
      for (const [k, kv] of Object.entries(nk.kinds || {})) {
        const list = r.nodes[k];
        if (!Array.isArray(list) || !list.length) out.push(`${kv.words || k} needs at least one node`);
        else {
          if (list.some((n) => !(n in (nk.names || {})))) out.push(`${kv.words || k}: a node it does not know`);
          if (new Set(list).size !== list.length) out.push(`${kv.words || k}: a node twice`);
        }
      }
    }
    const tf = (catalog && catalog.trade_feed) || null;
    if (r.trade_feed && tf) {
      const ns = r.trade_feed.nodes;
      const [lo, hi] = Array.isArray(tf.coins) ? tf.coins : [1, 1000];
      if (!Array.isArray(ns) || ns.length < 1 || ns.length > (tf.max_nodes || 2)) out.push("the trade feed needs its first node (and at most one overflow)");
      else if (new Set(ns).size !== ns.length) out.push("the trade feed's overflow must be another node");
      if (!Number.isInteger(r.trade_feed.coins) || r.trade_feed.coins < lo || r.trade_feed.coins > hi) out.push(`the trade feed watches ${lo} to ${hi} coins`);
    }
    const pads = Object.values(r.discovery || {});
    if (pads.length && !pads.some(Boolean)) out.push("at least one launchpad must stay on");
    return out;
  }
  const nameOf = (catalog, s) => (catalog && catalog.sources && catalog.sources[s]) || s;
  /** The staged changes as words, field by field and launchpad by launchpad. */
  function diffRouting(before, after, catalog, effectiveNodes) {
    const lines = [];
    for (const [f, d] of Object.entries((catalog && catalog.fields) || {})) {
      const a = (before.routes && before.routes[f]) || [];
      const z = (after.routes && after.routes[f]) || [];
      if (!sameOrder(a, z)) lines.push(`${d.words || f}: ${a.join(" → ") || "none"}  becomes  ${z.join(" → ") || "none"}`);
    }
    for (const [k, kv] of Object.entries((catalog && catalog.nodes && catalog.nodes.kinds) || {})) {
      if (!after.nodes) break;
      const nm = (n) => (catalog.nodes.names && catalog.nodes.names[n]) || n;
      const a = (before.nodes && before.nodes[k]) || (effectiveNodes && effectiveNodes[k]) || null;
      const z = after.nodes[k] || [];
      if (!a || !sameOrder(a, z)) lines.push(`${kv.words || k}: ${a ? a.map(nm).join(" → ") : "today's order"}  becomes  ${z.map(nm).join(" → ") || "none"}`);
    }
    if (after.trade_feed && JSON.stringify(after.trade_feed) !== JSON.stringify(before.trade_feed || null)) {
      const tn = (n) => (catalog.trade_feed && catalog.trade_feed.names && catalog.trade_feed.names[n]) || n;
      const tfText = (t) => (t ? `${(t.nodes || []).map(tn).join(", then ") || "no node"} · ${t.coins} coins` : "today's settings");
      lines.push(`the trade feed: ${tfText(before.trade_feed)}  becomes  ${tfText(after.trade_feed)}`);
    }
    for (const [l, d] of Object.entries((catalog && catalog.discovery) || {})) {
      const a = before.discovery ? before.discovery[l] !== false : true;
      const z = after.discovery ? after.discovery[l] !== false : true;
      if (a !== z) lines.push(`${d.words || l}: ${a ? "on" : "off"}  becomes  ${z ? "on" : "off"}`);
    }
    return lines;
  }
  /** the team's W3: the kinds of read whose wired nodes all lost their address, so the engine serves them in today's order. A line in words, or null when none. */
  function fallbackLine(nodesFallback, catalog) {
    if (!Array.isArray(nodesFallback) || !nodesFallback.length) return null;
    const kinds = (catalog && catalog.nodes && catalog.nodes.kinds) || {};
    const words = nodesFallback.map((k) => (kinds[k] && kinds[k].words) || String(k).slice(0, 40));
    return `Not as wired: ${words.join(", ")} ${words.length === 1 ? "is" : "are"} served in today's order, because every node wired for ${words.length === 1 ? "it" : "them"} has lost its address on the server.`;
  }
  /** Is a trade feed wire applied? Then the trade feed's coin count is set here, not on its node (the server refuses the node's setting, 409). */
  const tradeFeedApplied = (routingAnswer) => !!(routingAnswer && routingAnswer.routing && routingAnswer.routing.trade_feed);
  /** Does the server say this field (or launchpad) is followed? the engine's `followed` on the catalog entry; an Air that does not say yet: the engine's are, the feed's are not. */
  const followedOf = (entry) => (entry && typeof entry.followed === "boolean" ? entry.followed : !!entry && entry.owner !== "feed");
  /** What a map wire says now: null when it is not a route (drawing only), else { kind: "live" | "saved" | "off", text }. */
  function wireMark(key, routing, catalog) {
    const pairs = routesOfWire(typeof key === "string" ? key.split("|") : key, catalog);
    if (!pairs.length || !catalog || !catalog.fields) return null;
    const known = pairs.filter(([f]) => catalog.fields[f]);
    if (!known.length) return null;
    if (!known.some(([f]) => followedOf(catalog.fields[f]))) return { kind: "unfollowed", text: "feed not following yet" };
    const inForce = known.filter(([f, s]) => (routing.routes[f] || []).includes(s));
    if (!inForce.length) return { kind: "off", text: "not routed" };
    return inForce.some(([f]) => followedOf(catalog.fields[f])) ? { kind: "live", text: "live" } : { kind: "unfollowed", text: "feed not following yet" };
  }
  /** One of the engine's preview changes as a line of words. */
  function changeLine(c) {
    const side = (v) =>
      Array.isArray(v) ? v.join(" → ")
        : typeof v === "boolean" ? (v ? "on" : "off")
          : v && typeof v === "object" ? `${(v.nodes || []).join(", then ")} · ${v.coins} coins`
            : v === undefined || v === null ? "today's" : String(v);
    const who = c && c.owner === "engine" ? "the engine follows at once" : c && c.owner === "feed" ? "the feed" : "";
    return `${(c && c.words) || (c && (c.field || c.launchpad || c.nodes)) || "a change"}: ${side(c && c.before)}  becomes  ${side(c && c.after)}${who ? ` (${who})` : ""}`;
  }

  window.PinrRoutes = { SOURCE_OF_NODE, FIELDS_OF_INPUT, routesOfWire, routesOnMap, mapEdits, fallbackLine, tradeFeedApplied, nodesShown, withNodes, withTradeFeed, moveIn, WIRE_ROUTES, NODE_LAUNCHPADS, defaultsOf, effective, moveSource, removeSource, addSource, setLaunchpad, problemsOf, diffRouting, followedOf, wireMark, changeLine, sameOrder, nameOf };
  if (typeof document === "undefined") return;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const toastMsg = (m) => { if (typeof toast === "function") toast(m); };
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, j };
  }

  let state = null; // GET /api/control/routing
  let onMap = null; // the routes the map's wires stood for at the last look
  let mapTimer = 0;
  let mapSaid = [];
  window.PinrRoutes.current = () => state; // for the live layer (the trade feed's coins move to Routes once its wire is applied)
  let problem = null;
  let draft = null; // the staged routing, or null
  let preview = null; // the server's last preview of the draft
  let busy = false;
  const catalog = () => (state && state.catalog) || null;
  const applied = () => (state && catalog() ? effective(state.routing, catalog()) : null);
  const working = () => draft || applied();

  async function load() {
    try {
      const r = await api("GET", "/api/control/routing");
      if (!r.ok) throw new Error((r.j && r.j.error) || `the service answered ${r.status}`);
      state = r.j;
      problem = null;
      if (onMap === null && typeof G !== "undefined") onMap = routesOnMap(G.wires, state.catalog);
    } catch (e) { problem = e.message || "no answer"; }
    paintAll();
  }

  const panel = el("section");
  panel.id = "routespanel";
  panel.hidden = true;
  document.body.append(panel);
  const barEl = el("div");
  barEl.id = "routebar";
  barEl.hidden = true;
  document.body.append(barEl);

  const effNodes = () => {
    const st = window.PinrLive && window.PinrLive.current ? window.PinrLive.current() : null;
    return (st && st.engine && st.engine.nodes_effective) || null;
  };
  function stage(next) {
    if (!diffRouting(applied(), next, catalog(), effNodes()).length) mapSaid = [];
    draft = diffRouting(applied(), next, catalog(), effNodes()).length ? next : null;
    preview = null;
    paintAll();
  }

  function paintPanel() {
    panel.replaceChildren();
    const head = el("div", "askhead");
    head.append(el("b", "", "Routes"));
    const close = el("button", "", "close");
    close.onclick = () => (panel.hidden = true);
    head.append(close);
    panel.append(head);
    if (problem) return void panel.append(el("div", "asknote", `Routes unavailable: ${problem}`));
    if (!state || !catalog()) return void panel.append(el("div", "asknote", "Routes: loading…"));
    const w = working();
    panel.append(el("div", "asknote", `Version ${state.version ?? "none yet"}${draft ? " · changes staged, not applied" : ""}. Solid wires marked "live" are real routes; dashed wires are drawing only.`));
    for (const [f, d] of Object.entries(catalog().fields)) {
      const box = el("div", "rtfield");
      box.append(el("b", "", d.words || f));
      const fol = followedOf(d);
      if (!fol) box.classList.add("rtgrey");
      box.append(el("span", "asknote", ` ${fol ? (d.owner === "feed" ? "the feed follows this" : "the engine follows this at once") : "the feed does not follow this yet: it cannot be changed"}`));
      const list = w.routes[f] || [];
      list.forEach((s, i) => {
        const row = el("div", "rtrow");
        row.append(el("span", "", `${i + 1}. ${nameOf(catalog(), s)}`));
        const up = el("button", "", "↑"); up.title = "Try this source earlier"; up.disabled = !fol || i === 0; up.onclick = () => stage(moveSource(w, f, i, -1));
        const dn = el("button", "", "↓"); dn.title = "Try this source later"; dn.disabled = !fol || i === list.length - 1; dn.onclick = () => stage(moveSource(w, f, i, 1));
        const rm = el("button", "", "remove"); rm.disabled = !fol || list.length < 2; rm.title = !fol ? "The feed does not follow this yet" : list.length < 2 ? "A field needs at least one source" : "Stop using this source for this field"; rm.onclick = () => stage(removeSource(w, f, i));
        row.append(up, dn, rm);
        box.append(row);
      });
      const free = d.sources.filter((s) => !list.includes(s));
      if (fol && free.length) {
        const row = el("div", "rtrow");
        const sel = el("select");
        for (const s of free) { const o = el("option", "", nameOf(catalog(), s)); o.value = s; sel.append(o); }
        const add = el("button", "", "add");
        add.onclick = () => stage(addSource(w, f, sel.value, catalog()));
        row.append(sel, add);
        box.append(row);
      }
      panel.append(box);
    }
    const lp = el("div", "rtfield");
    lp.append(el("b", "", "Launchpads"));
    for (const [l, d] of Object.entries(catalog().discovery || {})) lp.append(padRow(l, d, w));
    panel.append(lp);
    const nk = catalog().nodes;
    if (nk && nk.kinds) panel.append(nodesBox(nk, w));
    const tf = catalog().trade_feed;
    if (tf) panel.append(tradeBox(tf, w));
    panel.append(history());
  }
  /** Which Solana node answers each kind of read, top first: shown from the routing, else what the engine says is in force now. */
  function nodesBox(nk, w) {
    const box = el("div", "rtfield");
    box.append(el("b", "", "Solana nodes"));
    const st = window.PinrLive && window.PinrLive.current ? window.PinrLive.current() : null;
    const eff = st && st.engine && st.engine.nodes_effective;
    const fol = followedOf(nk);
    if (!fol) box.classList.add("rtgrey");
    box.append(el("span", "asknote", ` ${nk.words || ""}${w.nodes ? "" : eff ? " (today's order, from the engine)" : " (today's order is not reported yet)"}`));
    const fb = fallbackLine(st && st.engine && st.engine.nodes_fallback, catalog());
    if (fb) box.append(el("div", "gl bad rtfallback", fb));
    const shown = nodesShown(w, catalog(), eff);
    const name = (n) => (nk.names && nk.names[n]) || n;
    for (const [k, kv] of Object.entries(nk.kinds)) {
      const list = shown[k];
      box.append(el("div", "asknote", kv.words || k));
      list.forEach((n, i) => {
        const row = el("div", "rtrow");
        row.append(el("span", "", `${i + 1}. ${name(n)}`));
        const up = el("button", "", "↑"); up.disabled = !fol || i === 0; up.onclick = () => stage(withNodes(w, k, moveIn(list, i, -1), shown));
        const dn = el("button", "", "↓"); dn.disabled = !fol || i === list.length - 1; dn.onclick = () => stage(withNodes(w, k, moveIn(list, i, 1), shown));
        const rm = el("button", "", "remove"); rm.disabled = !fol || list.length < 2; rm.onclick = () => stage(withNodes(w, k, list.filter((_, j) => j !== i), shown));
        row.append(up, dn, rm);
        box.append(row);
      });
      const free = Object.keys(nk.names || {}).filter((n) => !list.includes(n));
      if (fol && free.length) {
        const row = el("div", "rtrow");
        const sel = el("select");
        for (const n of free) { const o = el("option", "", name(n)); o.value = n; sel.append(o); }
        const add = el("button", "", "add");
        add.onclick = () => stage(withNodes(w, k, [...list, sel.value], shown));
        row.append(sel, add);
        box.append(row);
      }
    }
    return box;
  }
  /** The live trade feed's websocket: its first node, the overflow, and how many coins it watches. */
  function tradeBox(tf, w) {
    const box = el("div", "rtfield");
    box.append(el("b", "", "Trade feed"));
    const fol = followedOf(tf);
    if (!fol) box.classList.add("rtgrey");
    box.append(el("span", "asknote", ` ${tf.words || ""}${w.trade_feed ? "" : " (today: as in the server's settings)"}`));
    const cur = w.trade_feed || { nodes: [], coins: null };
    const names = Object.keys(tf.names || {});
    const pick = (label, value, withNone) => {
      const row = el("label", "rtrow");
      row.append(el("span", "", label));
      const sel = el("select");
      if (withNone) { const o = el("option", "", withNone); o.value = ""; sel.append(o); }
      for (const n of names) { const o = el("option", "", tf.names[n]); o.value = n; sel.append(o); }
      sel.value = value || "";
      sel.disabled = !fol;
      row.append(sel);
      box.append(row);
      return sel;
    };
    const first = pick("First node", cur.nodes[0], cur.nodes[0] ? null : "choose");
    const over = pick("Overflow", cur.nodes[1], "none");
    const row = el("label", "rtrow");
    row.append(el("span", "", "Coins watched"));
    const coins = el("input");
    coins.type = "number"; coins.min = String((tf.coins || [1])[0]); coins.max = String((tf.coins || [1, 1000])[1]);
    const ctl = window.PinrLive && window.PinrLive.current && window.PinrLive.current() ? window.PinrLive.current().control : null;
    coins.value = String(cur.coins ?? (ctl && ctl.trades_ws_max_coins) ?? "");
    coins.disabled = !fol;
    row.append(coins);
    box.append(row);
    const set = el("button", "", "stage these");
    set.disabled = !fol;
    set.onclick = () => {
      if (!first.value) return toastMsg("Choose the trade feed's first node");
      stage(withTradeFeed(w, [first.value, over.value].filter((v, i, a) => v && a.indexOf(v) === i), Number(coins.value)));
    };
    box.append(set);
    return box;
  }
  function padRow(l, d, w) {
    const row = el("label", "rtrow");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = w.discovery[l] !== false;
    const fol = followedOf(d);
    cb.disabled = !fol;
    if (!fol) row.classList.add("rtgrey");
    cb.onchange = () => stage(setLaunchpad(w, l, cb.checked));
    row.append(cb, el("span", "", ` ${d.words || l} `), el("span", "asknote", !fol ? "(the feed does not follow this yet)" : d.owner === "feed" ? "(the feed)" : "(the engine)"));
    return row;
  }
  function history() {
    const box = el("div", "rtfield");
    box.append(el("b", "", "Versions"));
    const vs = state && Array.isArray(state.versions) ? state.versions.slice().reverse().slice(0, 12) : [];
    if (!vs.length) box.append(el("div", "asknote", "No versions yet."));
    for (const v of vs) {
      const L = window.PinrGate.versionLine(v);
      const row = el("div", "rtrow");
      row.append(el("span", "", `${L.n === null ? "?" : "v" + L.n} ${L.text}`));
      if (L.n !== null && L.n === (state && state.version)) row.append(el("span", "asknote", "in force"));
      else if (L.n !== null) {
        const u = el("button", "", "undo to this");
        u.onclick = async () => {
          if (!window.confirm(`Go back to version ${L.n}? It is applied as a new version; nothing is lost.`)) return;
          const r = await api("POST", "/api/control/routing/undo", { version: L.n });
          if (r.ok) { draft = null; preview = null; toastMsg("Undone"); load(); } else toastMsg("Not undone: " + ((r.j && r.j.error) || r.status));
        };
        row.append(u);
      }
      box.append(row);
    }
    return box;
  }

  function paintBar() {
    barEl.replaceChildren();
    if (!draft || !state || !catalog()) return void (barEl.hidden = true);
    barEl.hidden = false;
    const lines = diffRouting(applied(), draft, catalog(), effNodes());
    barEl.append(el("b", "", `${lines.length} change${lines.length === 1 ? "" : "s"} staged (not applied)`));
    if (mapSaid.length) barEl.append(el("div", "gl", `From your wires on the map: ${mapSaid.join("; ")}`));
    for (const l of lines) barEl.append(el("div", "gl", l));
    const mine = problemsOf(draft, catalog());
    for (const p of mine) barEl.append(el("div", "gl bad", p));
    if (preview && preview.problems) {
      barEl.append(el("div", "gl bad", "The server refused this:"));
      for (const p of preview.problems) barEl.append(el("div", "gl bad", typeof p === "string" ? p : JSON.stringify(p)));
    } else if (preview) {
      barEl.append(el("div", "gl", `The server says ${preview.changed_count ?? (preview.changes || []).length} change${(preview.changes || []).length === 1 ? "" : "s"} will happen:`));
      for (const c of (preview.changes || []).slice(0, 12)) barEl.append(el("div", "gl", changeLine(c)));
    }
    const row = el("div", "gbtn");
    const pv = el("button", "", "Preview");
    pv.disabled = busy || mine.length > 0;
    pv.onclick = async () => {
      busy = true; paintBar();
      const r = await api("POST", "/api/control/routing/preview", { routing: draft });
      busy = false;
      preview = r.ok ? r.j : { problems: (r.j && (r.j.problems || (r.j.error && [r.j.error]))) || [`the service answered ${r.status}`] };
      paintBar();
    };
    const ap = el("button", "go", "Apply");
    ap.disabled = busy || !preview || !!preview.problems || !preview.preview_id;
    ap.onclick = async () => {
      busy = true; paintBar();
      const r = await api("POST", "/api/control/routing/apply", { preview_id: preview.preview_id });
      busy = false;
      if (r.ok) { draft = null; preview = null; toastMsg("Applied"); load(); } else { preview = { problems: [(r.j && r.j.error) || `the service answered ${r.status}`] }; paintBar(); }
    };
    const dc = el("button", "", "Discard");
    dc.onclick = () => { draft = null; preview = null; paintAll(); };
    row.append(pv, ap, dc);
    barEl.append(row);
  }

  // ---- the wires
  function paintWires() {
    const svg = document.getElementById("wires");
    if (!svg || typeof G === "undefined" || !state || !catalog()) return;
    for (const t of svg.querySelectorAll("text.rtw")) t.remove();
    const routing = applied();
    for (const p of svg.querySelectorAll("path[data-w]")) {
      const w = G.wires[+p.dataset.w];
      if (!w) continue;
      const m = wireMark(w.slice(0, 4).join("|"), routing, catalog());
      // The operator's key: solid = a wire the server follows (a live route, a wire into a gate check, or a score wire while the site shows the PINR Index); dashed = drawing only or a route not in force;
      // faded = a route the feed does not follow yet; dotted and faint = it comes from a blocked, hidden or planned node; thick and glowing = selected.
      const gate = !!(window.PinrGate && window.PinrGate.isGateWire && window.PinrGate.isGateWire(w));
      const B = window.PinrBadges;
      const scoreLive = (w[0] === "e_score" || w[2] === "e_score") && !!(B && B.scoreLive && B.scoreLive());
      const solid = (m && m.kind === "live") || gate || scoreLive;
      const from = typeof nodeById === "function" ? nodeById(w[0]) : null;
      const fromLive = B && B.liveText ? B.liveText(w[0]) : null; // the live badge, where the server reports one, before the status drawn
      const fromOff = fromLive ? fromLive !== "live" : !!(from && ["blocked", "hidden", "planned"].includes(from.status));
      p.classList.toggle("dash", !solid);
      p.classList.toggle("rtgrey", !!m && m.kind === "unfollowed");
      p.classList.toggle("rtlive", !!solid);
      p.classList.toggle("fromoff", fromOff);
      if (m && typeof p.getTotalLength === "function") {
        const pt = p.getPointAtLength(p.getTotalLength() / 2);
        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("class", "rtw " + m.kind);
        t.setAttribute("x", String(pt.x));
        t.setAttribute("y", String(pt.y - 6));
        t.setAttribute("text-anchor", "middle");
        t.textContent = m.text;
        svg.append(t);
      }
    }
  }
  // ---- the switches on a launchpad's node
  /** A route wire selected on the map: what it routes, its place in each field's order, and buttons to move it (staged, then Apply). */
  function paintWirePanel(side) {
    for (const x of side.querySelectorAll("#wireroute")) x.remove();
    if (typeof sel === "undefined" || !sel || sel.type !== "wire" || typeof G === "undefined") return;
    const w = G.wires[sel.id];
    const pairs = routesOfWire(w, catalog());
    if (!pairs.length) return;
    const box = el("div", "lvbox");
    box.id = "wireroute";
    box.append(el("h3", "", "This wire is a route (staged, then Apply)"));
    const wk = working();
    for (const [f, s] of pairs) {
      const d = catalog().fields[f];
      const list = wk.routes[f] || [];
      const i = list.indexOf(s);
      const row = el("div", "lvrow");
      row.append(el("span", "", i < 0 ? `${d.words || f}: ${nameOf(catalog(), s)} is not in the order` : `${d.words || f}: ${nameOf(catalog(), s)} is ${i + 1} of ${list.length}`));
      const fol = followedOf(d);
      if (i >= 0 && fol) {
        const up = el("button", "", "earlier"); up.disabled = i === 0; up.onclick = () => stage(moveSource(wk, f, i, -1));
        const dn = el("button", "", "later"); dn.disabled = i === list.length - 1; dn.onclick = () => stage(moveSource(wk, f, i, 1));
        row.append(up, dn);
      } else if (fol) {
        const add = el("button", "", "add to the order"); add.onclick = () => stage(addSource(wk, f, s, catalog()));
        row.append(add);
      } else row.append(el("span", "lvnote", "not followed yet"));
      box.append(row);
    }
    box.append(el("div", "lvnote", "Removing this wire takes its source out of these orders; drawing one in adds it. Nothing changes on the server until Preview and Apply."));
    side.append(box);
  }
  function paintNodePanel() {
    const side = document.getElementById("panel");
    if (!side || !state || !catalog()) return;
    paintWirePanel(side);
    for (const x of side.querySelectorAll("#nodepads")) x.remove();
    const id = typeof sel !== "undefined" && sel && sel.type === "node" ? sel.id : null;
    const names = id ? NODE_LAUNCHPADS[id] : null;
    if (!names) return;
    const box = el("div", "lvbox");
    box.id = "nodepads";
    box.append(el("h3", "", "Launchpad switches (staged, then Apply)"));
    const w = working();
    for (const l of names) if (catalog().discovery && catalog().discovery[l]) box.append(padRow(l, catalog().discovery[l], w));
    side.append(box);
  }
  function paintAll() {
    paintPanel();
    paintBar();
    paintWires();
    paintNodePanel();
  }

  // ---- the operator's own wire edits on the map stage route changes (a design decision phase 2; the team: what "controlling the blueprint" means)
  function lookAtMap() {
    if (typeof G === "undefined" || !state || !catalog()) return;
    if (typeof drag !== "undefined" && drag) return void (mapTimer = setTimeout(lookAtMap, 300)); // a wire still in the hand
    const now = routesOnMap(G.wires, catalog());
    if (onMap === null) return void (onMap = now); // the first look is the starting point, not an edit
    const { next, said } = mapEdits(working(), onMap, now, catalog());
    onMap = now;
    if (!said.length) return;
    mapSaid = [...mapSaid, ...said].slice(-8);
    stage(next);
    toastMsg(`Staged from the map: ${said.join("; ")}. Preview and Apply to make it live.`);
  }
  const baseSave = window.save;
  if (typeof baseSave === "function") window.save = function () { const r = baseSave.apply(this, arguments); clearTimeout(mapTimer); mapTimer = setTimeout(lookAtMap, 350); return r; };
  const baseDraw = window.drawWires;
  if (typeof baseDraw === "function") window.drawWires = function () { const r = baseDraw.apply(this, arguments); paintWires(); return r; };
  const basePanel = window.renderPanel;
  if (typeof basePanel === "function") window.renderPanel = function () { const r = basePanel.apply(this, arguments); paintNodePanel(); return r; };

  const header = document.querySelector("header");
  if (header) {
    const b = el("button", "", "Routes");
    b.id = "bRoutes";
    b.title = "Which source fills which field, and the launchpad switches";
    b.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) load(); };
    header.insertBefore(b, header.querySelector(".sp") || null);
  }
  load();
  setInterval(() => { if (!draft && !busy) load(); }, EVERY_MS);
})();
